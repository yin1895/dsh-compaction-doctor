/**
 * Compaction engine with the repairs the shipped backend needs on non-official
 * (gateway) providers:
 *
 *  1. **Real-scale retention pricing** — while a compaction of a session is in
 *     flight, node pricing is rescaled so that retention and thresholds share
 *     the scale the provider actually bills. Without this the shadowed head is
 *     `k` times smaller than the window implies (the `k ~ 8.6` defect).
 *  2. **Chunked hierarchical summarization with an adapter-priced budget (F1,
 *     F2)** — the region is summarized in contiguous chunks, and every chunk is
 *     sized with the *adapter's own* estimator against
 *     `adapterWindow - maxOutput - hardMargin`, measured on the request that is
 *     about to be sent. A region that cannot be admitted within
 *     `maxSummaryChunks` never reaches the provider: it descends the ladder
 *     instead of sending a request that is already known to fail.
 *  3. **Overflow classification for untranslated provider errors** plus the
 *     learned hard window upper bound (F5) — a 400 that means "prompt too long"
 *     in the provider's own language is treated as a context overflow, and the
 *     refused size is recorded as an upper bound the window can never be planned
 *     against again (a rejection is a hard bound; an acceptance is not).
 *  4. **A guaranteed-progress ladder (F4)** — summary+replace, then prune-only,
 *     then a hard trim far below the window. Every rung must move the surface;
 *     a benign outcome is a *skip*, never an error, and only an exhausted ladder
 *     raises, naming this plugin and the rung that failed.
 *  5. **Never touch surface node 0 (F3)** — the system prompt is rewritten only
 *     by the host's own `system/message` path, so no replacement range this
 *     engine builds may start there.
 *  6. **Official providers are left completely alone (F6)** — on a
 *     `deepseek-official` / `deepseek-account` route (or a `deepseek.com`
 *     endpoint) every override stands down, including `summarize`.
 *
 * The class extends the shipped `BasicCompactionEngine` and only overrides
 * documented extension points (`summarize`, `compactIfNeeded`) plus one
 * session-scoped meter patch. Setting `scaleMode: "off"` restores stock
 * behaviour exactly, which makes A/B verification possible.
 *
 * @module @local/dsh-compaction-doctor/engine
 */

import { randomUUID } from "node:crypto";

import { CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import {
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from "@deepseek-ai/dsh-compaction";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";

import { effectiveWindow, learnRejectedWindow, readWindowBounds, windowBoundFor } from "./learn.js";
import {
  classifyMeasurement,
  computeNumbers,
  DEFAULT_RETAIN_RATIO,
  DEFAULT_THRESHOLD_RATIO,
  packWithinBudget,
  selectIndexRange,
  splitByCost,
  SUMMARY_HARD_MARGIN_TOKENS,
  SUMMARY_INSTRUCTION_TOKENS,
} from "./plan.js";
import { beginScale, endScale, installScaledMeter, meterPatchState, scaleFactorOf, uninstallScaledMeter } from "./rescale.js";
import { isContextOverflowFailure, providerAttribution } from "./overflow.js";
import {
  estimateMessageTokens,
  estimateToolsTokens,
  eventAt,
  isOfficialProvider,
  latestRoute,
  num,
  readContextWindow,
  shallowClone,
  surfaceSeqs,
  warn,
} from "./util.js";

const STDERR_WINDOW_RATIO = 0.98;
const CHUNK_COUNT_HARD_LIMIT = 24;
const DEFAULT_MAX_TOKENS = 65536;
/** Fraction of the usable window a hard trim (rung 3) lands on: far below it. */
const HARD_TRIM_TARGET_RATIO = 0.5;
/** Slack left when splitting one oversized message into parts. */
const SPLIT_CHAR_SLACK = 0.75;
/** Floor for the observed summary-size ceiling, so a fresh route never skips. */
const SUMMARY_CEILING_FLOOR = 2048;

export const DOCTOR_DEFAULTS = {
  // Off by default: the settings page has exactly one switch, and until it is
  // flipped the plugin must be completely inert (stock DSH behavior).
  enabled: false,
  provider: undefined,
  model: undefined,
  scaleMode: "meter",
  maxSummaryChunks: 8,
  tokensPerByte: 0.34,
  summaryBudgetRatio: 0.9,
  selectCapRatio: 0.85,
  overflowRecovery: true,
  maxTokens: DEFAULT_MAX_TOKENS,
  fallbackContextWindow: undefined,
  // F6: route ids that must be left entirely to the shipped engine.
  officialProviders: undefined,
  // F1: the hard margin subtracted from the adapter window for a summary request.
  summaryHardMargin: SUMMARY_HARD_MARGIN_TOKENS,
  // F4 rung 3: the fraction of the window a hard trim lands on.
  hardTrimRatio: HARD_TRIM_TARGET_RATIO,
};

/** Doctor settings that the engine row may carry on its own. */
const DOCTOR_OWNED_KEYS = [
  // The single user-facing switch, and the auto-repair flag behind it. These
  // MUST be layered: the settings page writes `enabled` on the PROBE row, and
  // without this the engine would keep reading the default and the switch would
  // only affect the probe.
  "enabled",
  "autoRepair",
  "provider",
  "model",
  "scaleMode",
  "maxSummaryChunks",
  "tokensPerByte",
  "summaryBudgetRatio",
  "selectCapRatio",
  "overflowRecovery",
  "maxTokens",
  "fallbackContextWindow",
  "officialProviders",
  "summaryHardMargin",
  "hardTrimRatio",
  // Budget keys the settings page may override. They also live in the engine
  // row; when the doctor value differs from the frozen row value the engine
  // switches to its own selection path so the page edit actually takes effect
  // without a reboot.
  "thresholdRatio",
  "retainRatio",
];

/** Marker returned by the rung-1 selection when it deliberately declines. */
const SKIP = Symbol("compaction-doctor/skip");

/**
 * Host failures that are *benign*: nothing was refused and nothing is broken,
 * the summarizer simply produced a checkpoint that is not useful.
 *
 * `summarization produced no text summary content`
 * (`dsh-compaction-basic/lib/index.js:328`) and
 * `summary is not smaller than the shadowed content (X >= X)` (`:600-601`) are
 * the two shapes recorded ~60 times each in the field; both mean "this region
 * cannot be summarized", which the ladder answers with the prune rung — never
 * with a reported compaction error.
 */
const BENIGN_SUMMARY_ERRORS = [
  /produced no text summary content/i,
  /no usable text/i,
  /not smaller than the shadowed content/i,
  /summary is not smaller/i,
];

/** Whether one failure means "the summary was not useful" rather than "it broke". */
export function isBenignSummaryFailure(error) {
  if (error === undefined || error === null) return false;
  if (error.benign === true) return true;
  const message = `${error.message ?? error}`;
  return BENIGN_SUMMARY_ERRORS.some((pattern) => pattern.test(message));
}

/**
 * A rung-1 failure that is *benign*: nothing was refused, the summary simply
 * could not be turned into a usable, smaller checkpoint. This must never reach
 * the caller — the ladder descends instead, because "the summary was not useful"
 * is not a compaction failure a turn should die for.
 */
export class DoctorSummaryUnavailableError extends Error {
  constructor(rung, reason, options = {}) {
    super(`compaction-doctor: rung ${rung} declined — ${reason}`);
    this.name = "DoctorSummaryUnavailableError";
    this.plugin = "@local/dsh-compaction-doctor";
    this.rung = rung;
    this.reason = reason;
    this.benign = true;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Raised only when every rung of the ladder failed. The message names this
 * plugin and the rung that exhausted the ladder, so a surviving failure in a
 * log is unambiguous.
 */
export class CompactionDoctorExhaustedError extends Error {
  constructor(attempts, options = {}) {
    const detail = attempts
      .map((attempt) => `${attempt.rung}: ${attempt.outcome}${attempt.reason === undefined ? "" : ` (${attempt.reason})`}`)
      .join("; ");
    super(`compaction-doctor: every compaction rung failed on this provider — ${detail}`);
    this.name = "CompactionDoctorExhaustedError";
    this.plugin = "@local/dsh-compaction-doctor";
    this.attempts = attempts;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export class CompactionDoctorEngine extends BasicCompactionEngine {
  constructor(ctx, config = {}) {
    super(ctx, config);
    this.doctorStats = {
      summarizeCalls: 0,
      chunkedRegions: 0,
      chunkCalls: 0,
      merges: 0,
      classifications: 0,
      classificationRetries: 0,
      selectRuns: 0,
      meterInstalled: false,
      meterPatched: false,
      lastScale: undefined,
      lastCompaction: undefined,
      guardFailures: 0,
      lastGuardMessage: undefined,
      notes: [],
      // F4: how each rung behaved, and the benign outcomes that are never errors.
      ladder: { runs: 0, descended: 0, summary: 0, prune: 0, hardTrim: 0 },
      benignSkips: 0,
      lastBenign: undefined,
      rungFailures: 0,
      lastRungFailure: undefined,
      // F6: why an override stood down (last reason observed).
      inert: undefined,
      // F5: the learned hard window upper bound.
      windowLearning: undefined,
      windowBound: undefined,
      // Largest framed summary observed for the routed model.
      summaryCeiling: undefined,
      // Last summary's convergence reading (framed vs shadowed region price).
      lastSummary: undefined,
      // Doc §8.14: per-chunk attribution, so the next incident is not reverse
      // engineered from a counter.
      chunkRecords: [],
      summaryErrorEvents: 0,
    };
    this._installMeter(ctx);
    this._overflowRetries = new WeakMap();
    /** session -> agent, so the `session/event` listener can undo the budget. */
    this._overflowAgents = new WeakMap();
    this._classifierRegistered = false;
    this._boundsLoaded = false;
    this._bounds = {};
    this._windowBoundKey = undefined;
    /** route key -> largest framed summary observed (the shrink pre-flight). */
    this._summaryCeilings = new Map();
    this._registerOverflowClassifier(ctx);
    this._registerRetryReset(ctx);
    this._registerSummaryErrorProbe(ctx);
  }

  /**
   * Observe the host's own summary-failure recovery hook (doc §5.4, §3.4).
   *
   * `compactSurfaceRegion` asks `compaction/summary-error` whether anything can
   * recover a failed summarization; the default `() => false` rethrows, and a
   * truthy answer makes the host re-run the whole summarization in an unbounded
   * `for(;;)` loop that only re-prepares the same input
   * (`dsh-compaction-basic/lib/index.js:582-598`). This engine recovers *itself*
   * through the ladder in `compactIfNeeded`, so it deliberately declines the
   * host's retry and only records the event: answering truthy from here is how a
   * plugin turns one failure into a livelock.
   */
  _registerSummaryErrorProbe(ctx) {
    this.ctx.on("compaction/summary-error", (payload) => {
      try {
        this.doctorStats.summaryErrorEvents += 1;
        this.doctorStats.notes.push(
          `summary-error hook: ${payload?.error?.message ?? payload?.error ?? "unknown"} (recovery declined — the ladder owns it)`,
        );
      } catch {
        /* never break the host's recovery path */
      }
      return false;
    });
  }

  /**
   * Install the scaled meter as a real effect.
   *
   * The teardown has to be owned by the plugin fiber: this fork has no
   * `Service.prototype.stop()` hook, so a plain `stop()` method would never run
   * and the `tokenMeter.measure` patch would survive an unload or hot reload.
   */
  _installMeter(ctx) {
    const record = (installed) => {
      this.doctorStats.meterInstalled = installed.installed;
      this.doctorStats.meterPatched = installed.patched;
      if (installed.installed === false) this.doctorStats.notes.push(`meter not patched: ${installed.reason}`);
    };
    const release = () => {
      try {
        uninstallScaledMeter(ctx);
        this.doctorStats.meterPatched = false;
      } catch {
        /* teardown must never throw */
      }
    };
    if (typeof ctx.effect === "function") {
      try {
        // Generator form: both the host and the offline harness drive it, and the
        // yielded disposer is owned by the plugin fiber.
        ctx.effect(function* () {
          record(installScaledMeter(ctx));
          yield release;
        }, "compaction-doctor: scaled meter");
        return;
      } catch (error) {
        warn(ctx, `meter effect registration failed: ${error?.message ?? error}`);
      }
    }
    this.doctorStats.notes.push("ctx.effect unavailable: the meter patch has no fiber-owned teardown");
    record(installScaledMeter(ctx));
  }

  /**
   * Doctor-owned configuration. Precedence: defaults < this engine's own row
   * config < the probe row's config. The engine row may therefore carry the
   * doctor settings on its own (the probe row stays authoritative when mounted).
   */
  doctorConfig() {
    let service;
    try {
      service = this.ctx.get("compactionDoctor");
    } catch {
      service = undefined;
    }
    const merged = { ...DOCTOR_DEFAULTS };
    const layer = (source) => {
      if (source === undefined || source === null || typeof source !== "object") return;
      for (const key of DOCTOR_OWNED_KEYS) {
        const value = source[key];
        if (value !== undefined && value !== null) merged[key] = value;
      }
    };
    layer(this.config);
    layer(service?.config);
    return merged;
  }

  /** Probed capability published by the probe row, when available. */
  probedCapability() {
    try {
      return this.ctx.get("compactionDoctor")?.resolved;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------
  // F6: stand down on the official engine's own routes
  // ---------------------------------------------------------------------

  /** The routed target this session is actually using, when it can be recovered. */
  routeFor(agent, doctor = this.doctorConfig()) {
    return latestRoute(agent?.session, { provider: doctor.provider, model: doctor.model });
  }

  /**
   * The configurable-provider directory's `declared` flag (doc §6.1).
   *
   * `dsh-llm-pi-ai/lib/index.js:2850` sets `declared: installed === undefined`,
   * so `true` means "hand-declared route with no entry in pi-ai's shipped
   * catalog" — a third-party gateway — and `false` means the shipped catalog
   * describes it. This is the only field that tracks catalog drift, so it is
   * preferred over any id list this plugin could keep.
   */
  _providerDeclared(route) {
    const llm = this.ctx?.llm;
    if (route === undefined || typeof route.provider !== "string") return undefined;
    if (typeof llm?.listConfigurableProviders !== "function") return undefined;
    let entries;
    try {
      entries = llm.listConfigurableProviders();
    } catch {
      return undefined;
    }
    if (!Array.isArray(entries)) return undefined;
    const entry = entries.find((item) => item?.provider === route.provider);
    return typeof entry?.declared === "boolean" ? entry.declared : undefined;
  }

  /**
   * Why this engine must not intercept anything for one route.
   *
   * Three independent reasons, all of which mean "the shipped engine is the
   * right engine here": the switch is off, every repair is disabled, or the
   * route is an official DeepSeek endpoint (F6). The gate covers *every*
   * override — including `summarize`, because the host's own `compactIfNeeded`
   * dynamically dispatches `this.summarize(...)`
   * (`dsh-compaction-basic/lib/index.js:1016`), so a leftover `summarize`
   * override keeps running expensive, unasked-for work even with the switch off.
   *
   * @returns a reason string, or `undefined` when the repairs apply.
   */
  inertReason(agent, doctor = this.doctorConfig()) {
    if (doctor.enabled === false) return "the switch is off";
    if ((doctor.scaleMode ?? "meter") === "off") return "scaleMode is off";
    const route = this.routeFor(agent, doctor);
    const declared = this._providerDeclared(route);
    if (isOfficialProvider(route, { declared, officialProviders: doctor.officialProviders })) {
      return `official route ${route?.provider ?? "?"}/${route?.model ?? "?"} is the shipped engine's own`;
    }
    return undefined;
  }

  /** Record (and, once per change, note) why an override stood down. */
  _standDown(reason) {
    if (this.doctorStats.inert !== reason) {
      this.doctorStats.inert = reason;
      this.doctorStats.notes.push(`stood down: ${reason}`);
    }
    return undefined;
  }

  // ---------------------------------------------------------------------
  // overflow classification (F5: learn the hard bound from the rejection)
  // ---------------------------------------------------------------------

  /** Treat provider-language "prompt too long" 400s as context overflow. */
  _registerOverflowClassifier(ctx) {
    if (this._classifierRegistered) return;
    this._classifierRegistered = true;
    ctx.on("agent/request-error", async (event, next) => {
      try {
        const agent = event?.agent;
        const failure = event?.failure ?? event?.error;
        const signal = event?.signal;
        const doctor = this.doctorConfig();
        if (doctor.overflowRecovery === false) return next();
        if (agent?.session === undefined || failure === undefined || failure === null) return next();
        if (signal?.aborted === true) return next();
        const route = this.routeFor(agent, doctor);
        const inert = this.inertReason(agent, doctor);
        if (inert !== undefined) {
          this._standDown(inert);
          return next();
        }
        if (failure.code === CONTEXT_WINDOW_EXCEEDED_CODE) return next();
        const verdict = isContextOverflowFailure(failure, CONTEXT_WINDOW_EXCEEDED_CODE);
        if (verdict === undefined) return next();
        const maxRetries = Math.max(0, num(this.config?.maxOverflowRetries, 2));
        const used = num(this._overflowRetries.get(agent), 0);
        if (used >= maxRetries) return next();
        const session = agent.session;
        if (session !== null && typeof session === "object") this._overflowAgents.set(session, agent);
        const generation = num(session?.surface?.replaceGeneration, 0);
        this.doctorStats.classifications += 1;
        // F5: the refused prompt is a *hard upper bound* on the usable window.
        const learning = this._learnRejectedWindow(route, session, doctor);
        warn(
          ctx,
          `classified ${String(failure.code)} as context overflow (${verdict}${providerAttribution(failure) === undefined ? "" : `, ${providerAttribution(failure)}`})` +
            (learning === undefined ? "" : ` — learned window upper bound ${learning.bound} tokens`) +
            " — compacting and retrying",
        );
        try {
          await this.compactIfNeeded(agent, "context-overflow", signal);
        } catch (error) {
          warn(ctx, `overflow recovery compaction failed: ${error?.message ?? error}`);
        }
        if (signal?.aborted === true) return next();
        if (num(session?.surface?.replaceGeneration, 0) <= generation) return next();
        this._overflowRetries.set(agent, used + 1);
        this.doctorStats.classificationRetries += 1;
        return { kind: "retry" };
      } catch (error) {
        warn(ctx, `overflow classifier failed: ${error?.message ?? error}`);
        // Never call `next()` a second time: the waterfall's `next` shifts one
        // listener off the chain per call, so a catch that re-enters it both
        // swallows downstream failures and skips a listener. Surface the error.
        throw error;
      }
    });
  }

  /**
   * Clear the retry budget for an agent as soon as one of its messages lands.
   *
   * `session/event` is a plain (non-waterfall) event whose listeners receive
   * `(session, event)` — a single-parameter signature silently observes the
   * session object instead of the event, so the budget would never reset.
   */
  _registerRetryReset(ctx) {
    ctx.on("session/event", (session, event) => {
      try {
        if (event?.type !== "assistant/message") return;
        const agent = this._overflowAgents.get(session);
        if (agent !== undefined) this._overflowRetries.delete(agent);
      } catch {
        /* never break session bookkeeping */
      }
    });
  }

  // ---------------------------------------------------------------------
  // F5: hard window upper bounds
  // ---------------------------------------------------------------------

  /** Load the persisted bounds once; writes refresh this map. */
  _boundsStore() {
    if (this._boundsLoaded === false) {
      this._boundsLoaded = true;
      try {
        this._bounds = readWindowBounds().entries;
      } catch {
        this._bounds = {};
      }
    }
    return this._bounds;
  }

  /** The learned hard upper bound for one route, or `undefined`. */
  windowBound(route) {
    const store = this._boundsStore();
    return windowBoundFor(store, route?.provider, route?.model);
  }

  /**
   * Record one rejection as a hard upper bound (F5).
   *
   * The rejected size is measured with the same meter the shipped engine bills
   * with, so `totalTokens` at failure time *is* the size the provider refused.
   */
  _learnRejectedWindow(route, session, doctor) {
    if (route === undefined || typeof route.model !== "string") return undefined;
    let rejected = 0;
    try {
      rejected = Math.floor(num(this._meter()?.measure?.(session)?.totalTokens, 0));
    } catch {
      rejected = 0;
    }
    if (rejected <= 0) return undefined;
    const declared = this._declaredWindow(route, doctor);
    let record;
    try {
      record = learnRejectedWindow({
        provider: route.provider,
        model: route.model,
        rejectedTokens: rejected,
        declaredWindow: declared,
      });
    } catch (error) {
      this.doctorStats.notes.push(`window learning failed: ${error?.message ?? error}`);
      return undefined;
    }
    this._boundsLoaded = true;
    this._bounds[record.key] = record.bound;
    this.doctorStats.windowLearning = record;
    this.doctorStats.windowBound = record.bound;
    return record;
  }

  /** The window the plugin was planning against, before any learned bound. */
  _declaredWindow(route, doctor) {
    const probed = this.probedCapability();
    for (const candidate of [probed?.contextWindow, route?.contextWindow, doctor?.fallbackContextWindow, this.config?.contextWindow]) {
      const value = num(candidate, 0);
      if (value > 0) return value;
    }
    return 0;
  }

  // ---------------------------------------------------------------------
  // summarization (F1 + F2 + the real summary shape)
  // ---------------------------------------------------------------------

  /**
   * Summarize a region through the adapter-priced chunk plan.
   *
   * Every chunk request is sized with the adapter's own estimator against
   * `adapterWindow - maxOutput - hardMargin`, and the directive the host appends
   * to each request is priced into every chunk. A plan that cannot be admitted
   * within `maxSummaryChunks` raises `DoctorSummaryUnavailableError`, which the
   * ladder treats as a benign skip — a request that is known to fail is never
   * sent.
   */
  async summarize(input, agent, signal) {
    this.doctorStats.summarizeCalls += 1;
    const doctor = this.doctorConfig();
    const session = agent?.session;
    const route = this.routeFor(agent, doctor);
    // F6: with the switch off (or a disabled repair mode, or an official route)
    // this override must not run at all — the host calls `this.summarize(...)`
    // from its own compaction path, so a leftover override would keep issuing
    // summary requests the user never asked for.
    const inert = this.inertReason(agent, doctor);
    if (inert !== undefined) {
      this._standDown(inert);
      return super.summarize(input, agent, signal);
    }
    const messages = Array.isArray(input?.messages) ? input.messages : undefined;
    const numbers = await this._numbersFor(agent, route, signal);
    const budget = Math.max(0, Math.floor(num(numbers.summaryRequestBudget, 0)));
    if (budget <= 0 || messages === undefined || messages.length <= 1) {
      return this._recordSummary(route, await super.summarize(input, agent, signal));
    }

    const meter = this._meter();
    const priceMessage = (message) => estimateMessageTokens(meter, message);
    // The fixed part of every chunk request: the header's tool schemas plus the
    // compaction directive the host appends after the replayed prefix.
    const fixed = estimateToolsTokens(input?.tools) + SUMMARY_INSTRUCTION_TOKENS;
    const maxChunks = Math.max(2, Math.min(num(doctor.maxSummaryChunks, 8) || 8, CHUNK_COUNT_HARD_LIMIT));
    const perChunk = Math.max(0, budget - fixed);
    const total = messages.reduce((sum, message) => sum + priceMessage(message), 0);
    if (total + fixed <= budget) {
      // The whole request already fits: one call, no chunk plan needed.
      return this._recordSummary(route, await super.summarize(input, agent, signal));
    }
    if (perChunk <= 0) {
      throw new DoctorSummaryUnavailableError("summary", `the header alone (${fixed} tokens) leaves no room inside a ${budget}-token request`);
    }

    const split = splitOversizedMessages(messages, perChunk, priceMessage);
    if (split.infeasible !== undefined) throw new DoctorSummaryUnavailableError("summary", split.infeasible);
    const plan = this._chunkPlan(split.parts, priceMessage, perChunk, maxChunks);
    if (plan.infeasible !== undefined) throw new DoctorSummaryUnavailableError("summary", plan.infeasible);
    if (plan.groups.length <= 1) {
      return this._recordSummary(route, await super.summarize(input, agent, signal));
    }

    warn(
      this.ctx,
      `summarizing ${plan.groups.length} chunks (~${plan.total} adapter-priced tokens, per-chunk budget ${perChunk} of ${budget}) to fit the summarizer window`,
    );
    const collected = await this._summarizeGroups(input, plan.groups, agent, signal, priceMessage);
    if (collected.texts.length === 0) {
      // The calls returned, but nothing usable came back. This is a *benign*
      // outcome: the ladder descends, it does not report a compaction failure.
      // The underlying cause still travels on `cause` (doc §8.7).
      throw new DoctorSummaryUnavailableError(
        "summary",
        collected.firstError === undefined
          ? `no usable text in ${plan.groups.length} chunk summaries`
          : `every chunk summary failed (first: ${collected.firstError?.message ?? collected.firstError})`,
        { cause: collected.firstError },
      );
    }
    const merged = collected.texts.join("\n\n");
    const combined = withMergedText(collected.template, merged);
    if (combined === undefined) {
      // Unknown summary shape: fall back to the host's own single-shot result
      // rather than inventing one, and let the shrink guard judge it.
      warn(this.ctx, "summarizer output shape unknown; re-running one plain summarization");
      return this._recordSummary(route, await super.summarize(input, agent, signal));
    }
    // Doc §8.12: apply the *host's own* convergence test before handing the
    // summary over — `estimateMessage` is the same function the shipped guard
    // uses (`dsh-compaction-basic/lib/index.js:600-601`), so a summary that
    // cannot shrink the region is declined here as a benign skip instead of
    // surfacing as an unexplained host failure later.
    const regionPriced = regionPriceOf(messages, priceMessage);
    const framed = estimateMessageTokens(this._meter(), { role: "user", content: [{ type: "text", text: merged }] });
    this.doctorStats.lastSummary = { framed, regionPriced, groups: plan.groups.length, texts: collected.texts.length };
    if (framed >= regionPriced) {
      throw new DoctorSummaryUnavailableError(
        "summary",
        `the merged summary (${framed} framed tokens) is not smaller than the region it shadows (${regionPriced} tokens)`,
      );
    }
    this.doctorStats.chunkedRegions += 1;
    this.doctorStats.merges += 1;
    if (collected.usage !== undefined) combined.usage = collected.usage;
    this._recordSummary(route, combined);
    return combined;
  }

  /**
   * Run the chunk plan, degrading before giving up on any one chunk (doc §8.7):
   * a failing chunk first loses the tool schemas (the same replayed prompt
   * carries every tool schema — `dsh-compaction-basic:317,701` — which is a
   * systematic under-estimate of the summary request), then is split in half and
   * retried. Only when a chunk cannot be summarized in any of those shapes does
   * the region fail, and the first real error is carried out on `cause`.
   */
  async _summarizeGroups(input, groups, agent, signal, priceMessage) {
    const texts = [];
    let template;
    let usage;
    let firstError;
    for (let index = 0; index < groups.length; index += 1) {
      if (signal?.aborted === true) throw firstError ?? new Error("compaction summarization aborted");
      const record = {
        index,
        groups: groups.length,
        errorCode: undefined,
        textBlocks: 0,
        reasoningBlocks: 0,
        promptTokensEstimate: groups[index].reduce((sum, message) => sum + priceMessage(message), 0),
        degraded: undefined,
      };
      try {
        const produced = await this._runChunk(input, groups[index], agent, signal, record, { dropTools: false, depth: 0 });
        if (template === undefined && produced.template !== undefined) template = produced.template;
        if (produced.text.length > 0) texts.push(produced.text);
        usage = sumUsage(usage, produced.usage);
      } catch (error) {
        if (firstError === undefined) firstError = error;
        warn(this.ctx, `chunk ${index + 1}/${groups.length} summarization failed: ${error?.message ?? error}`);
        if (firstError === error && error instanceof ManualCompactionError) throw error;
      }
      this._rememberChunk(record);
    }
    return { texts, template, usage, firstError };
  }

  /** One chunk attempt with its one-step degradation ladder. */
  async _runChunk(input, items, agent, signal, record, attempt) {
    const chunkInput = { ...shallowClone(input), messages: items };
    if (attempt.dropTools === true) delete chunkInput.tools;
    try {
      const output = await super.summarize(chunkInput, agent, signal);
      this.doctorStats.chunkCalls += 1;
      const blocks = Array.isArray(output?.rawOutput)
        ? output.rawOutput
        : Array.isArray(output?.summary)
          ? output.summary
          : Array.isArray(output?.blocks)
            ? output.blocks
            : [];
      record.textBlocks += blocks.filter((block) => block?.type === "text").length;
      record.reasoningBlocks += blocks.filter((block) => block?.type === "reasoning").length;
      const text = collectText(output);
      if (text === undefined || text.length === 0) {
        const error = new Error("this chunk summary carried no usable text");
        error.code = "NO_SUMMARY_TEXT";
        throw error;
      }
      return { text, usage: output?.usage, template: output };
    } catch (error) {
      if (error instanceof ManualCompactionError) throw error;
      record.errorCode = error?.code ?? error?.name ?? "ERROR";
      if (attempt.dropTools === false) {
        record.degraded = "without tools";
        return this._runChunk(input, items, agent, signal, record, { dropTools: true, depth: attempt.depth });
      }
      if (items.length > 1 && attempt.depth < 1) {
        record.degraded = "split in half";
        const half = Math.ceil(items.length / 2);
        const left = await this._runChunk(input, items.slice(0, half), agent, signal, record, { dropTools: true, depth: attempt.depth + 1 });
        const right = await this._runChunk(input, items.slice(half), agent, signal, record, { dropTools: true, depth: attempt.depth + 1 });
        return {
          text: [left.text, right.text].join("\n\n"),
          usage: sumUsage(left.usage, right.usage),
          template: left.template ?? right.template,
        };
      }
      throw error;
    }
  }

  /** Bounded per-chunk attribution (doc §8.14). */
  _rememberChunk(record) {
    try {
      this.doctorStats.chunkRecords.push(record);
      if (this.doctorStats.chunkRecords.length > 64) this.doctorStats.chunkRecords.splice(0, this.doctorStats.chunkRecords.length - 64);
    } catch {
      /* diagnostics must never break a summary */
    }
  }

  /**
   * Choose contiguous chunk groups for one region (F2).
   *
   * A balanced contiguous split is preferred (better summaries, one request per
   * group); any group that still does not fit falls back to greedy packing,
   * which is what guarantees the budget.
   */
  _chunkPlan(parts, price, perChunk, maxChunks) {
    const costs = parts.map((part, index) => Math.max(0, price(part, index)));
    const total = costs.reduce((sum, cost) => sum + cost, 0);
    const needed = Math.max(2, Math.ceil(total / Math.max(1, perChunk)));
    if (needed <= maxChunks) {
      const groups = splitByCost(parts, costs, Math.min(needed, maxChunks));
      const fits = groups.every((group) =>
        group.reduce((sum, part) => {
          const index = parts.indexOf(part);
          return sum + Math.max(0, costs[index] ?? price(part));
        }, 0) <= perChunk,
      );
      if (fits) return { groups, total, needed };
    }
    const packed = packWithinBudget(parts, { price, budget: perChunk, maxChunks });
    if (packed.infeasible !== undefined) return { groups: [], costs, total, infeasible: packed.infeasible };
    return { groups: packed.chunks.map((chunk) => chunk.items), total, needed: packed.chunks.length };
  }

  /** Remember how large this route's summaries come out (shrink pre-flight). */
  _recordSummary(route, output) {
    try {
      const text = collectText(output);
      if (typeof text === "string" && text.length > 0 && route !== undefined) {
        const framed = estimateMessageTokens(this._meter(), { role: "user", content: [{ type: "text", text }] });
        const key = `${route.provider}/${route.model}`;
        const previous = num(this._summaryCeilings.get(key), 0);
        if (framed > previous) {
          this._summaryCeilings.set(key, framed);
          this.doctorStats.summaryCeiling = framed;
        }
      }
    } catch {
      /* a diagnostic must never break a summary call */
    }
    return output;
  }

  /** Largest framed summary observed for a route (floor: never guess low). */
  _summaryCeiling(route) {
    const observed = num(this._summaryCeilings.get(`${route?.provider}/${route?.model}`), 0);
    return observed > 0 ? observed : SUMMARY_CEILING_FLOOR;
  }

  // ---------------------------------------------------------------------
  // compaction entry points: the guaranteed-progress ladder (F4)
  // ---------------------------------------------------------------------

  async compactIfNeeded(agent, trigger, signal) {
    const doctor = this.doctorConfig();
    const session = agent?.session;
    if (session === undefined) return super.compactIfNeeded(agent, trigger, signal);
    const inert = this.inertReason(agent, doctor);
    if (inert !== undefined) {
      this._standDown(inert);
      return super.compactIfNeeded(agent, trigger, signal);
    }
    beginScale(session);
    try {
      const result = await this._ladder(agent, trigger, signal, doctor);
      if (result !== null && result !== undefined) this._recordResult(result, trigger);
      return result;
    } catch (error) {
      this._recordFailure(error, trigger);
      throw error;
    } finally {
      endScale(session);
    }
  }

  /**
   * Rung 1 → rung 2 → rung 3, with exactly two permitted exits per rung: the
   * surface moved, or the rung declined *benignly*. Nothing benign is reported
   * as an error, and no rung leaves the caller without progress unless the whole
   * ladder is exhausted.
   */
  async _ladder(agent, trigger, signal, doctor) {
    const session = agent.session;
    this.doctorStats.ladder.runs += 1;
    const generation = num(session?.surface?.replaceGeneration, 0);
    const attempts = [];

    const summary = await this._rungSummary(agent, trigger, signal, doctor, generation);
    attempts.push(summary);
    if (summary.outcome === "committed") {
      this.doctorStats.ladder.summary += 1;
      return summary.result;
    }
    if (summary.outcome === "idle") {
      // Nothing to compact at all (the surface is under every threshold): this
      // is the shipped engine's own "nothing to do", not a failure.
      return null;
    }
    this.doctorStats.ladder.descended += 1;

    const prune = this._rungPrune(agent, signal, generation);
    attempts.push(prune);
    if (prune.outcome === "committed") {
      this.doctorStats.ladder.prune += 1;
      return prune.result;
    }
    if (prune.outcome === "aborted") return null;

    const trim = await this._rungHardTrim(agent, signal, doctor, generation, trigger);
    attempts.push(trim);
    if (trim.outcome === "committed") {
      this.doctorStats.ladder.hardTrim += 1;
      return trim.result;
    }
    if (trim.outcome === "aborted") return null;

    this.doctorStats.rungFailures += 1;
    const rungs = attempts.map((attempt) => `${attempt.rung}:${attempt.outcome}`);
    const error = new CompactionDoctorExhaustedError(attempts, { cause: trim.error ?? prune.error ?? summary.error });
    // Doc §8.13 + the accepted weak form: the provider's own failure must stay
    // the failure. Replacing a classified `400` with an error of ours would
    // corrupt upstream classification (`dsh-llm-retry` and friends read
    // `failure.code`) and hide the actionable cause; so the exhausted ladder is
    // *reported* — named per rung, in stats and in one warn — and then yields, so
    // the caller's own error path (the classifier's `next()`, or the shipped
    // `agent/pre-step` catch) sees exactly what the provider said.
    this.doctorStats.lastRungFailure = {
      at: new Date().toISOString(),
      trigger,
      rungs,
      outcomes: attempts.map((attempt) => attempt.outcome),
      message: error.message,
    };
    warn(this.ctx, `rung ladder exhausted (${rungs.join(", ")}) — no reducer could move the surface; the original failure stands`);
    return null;
  }

  /**
   * Rung 1: chunked summary + replacement — the shipped path, or the doctor's
   * own real-scale selection when the settings page changed a budget.
   */
  async _rungSummary(agent, trigger, signal, doctor, generation) {
    const session = agent.session;
    const mode = doctor.scaleMode ?? "meter";
    const route = this.routeFor(agent, doctor);
    try {
      if (mode === "meter" && this._doctorOverridesBudgets(doctor) === false) {
        const result = await super.compactIfNeeded(agent, trigger, signal);
        return this._rungOutcome(session, generation, result, trigger, "summary");
      }
      const selected = await this._selectCompactIfNeeded(agent, trigger, signal, doctor, route);
      if (selected !== null && selected !== undefined && selected[SKIP] !== undefined) {
        this._benign("summary", selected[SKIP]);
        return { rung: "summary", outcome: "skipped", benign: true, reason: selected[SKIP] };
      }
      return this._rungOutcome(session, generation, selected, trigger, "summary");
    } catch (error) {
      const benign = isBenignSummaryFailure(error);
      const reason = error?.reason ?? error?.message ?? String(error);
      if (benign) {
        this._benign("summary", reason);
      } else {
        this.doctorStats.lastRungFailure = { at: new Date().toISOString(), rung: "summary", message: reason };
        warn(this.ctx, `rung 1 (summary+replace) failed: ${reason} — descending`);
      }
      return { rung: "summary", outcome: "failed", benign, reason, error };
    }
  }

  /**
   * Map one rung's raw result onto the ladder vocabulary.
   *
   * A non-null result *is* the contract-equivalent "the surface was replaced"
   * judgement: the shipped transaction returns a result only after the
   * replacement event committed (`dsh-compaction-basic/lib/index.js:482-486`)
   * and throws on every failure path (`:487-521`). The generation advance is
   * still observed and reported, but a host that does not publish it cannot make
   * this rung look failed.
   */
  _rungOutcome(session, generation, result, trigger, rung) {
    if (result === null || result === undefined) {
      return trigger === "context-overflow"
        ? { rung, outcome: "failed", benign: true, reason: "no compactable region while the window is full" }
        : { rung, outcome: "idle" };
    }
    return { rung, outcome: "committed", result, advanced: num(session?.surface?.replaceGeneration, 0) > generation };
  }

  /** Rung 2: prune only, no summarization — the shipped prune, called directly. */
  _rungPrune(agent, signal, generation) {
    const session = agent.session;
    if (signal?.aborted === true) return { rung: "prune", outcome: "aborted" };
    let pruner;
    try {
      pruner = this.ctx.get("toolResultPruner");
    } catch {
      pruner = undefined;
    }
    if (pruner === undefined || typeof pruner.pruneSession !== "function") {
      return { rung: "prune", outcome: "unavailable", reason: "no toolResultPruner service is mounted" };
    }
    const before = this._totalTokens(session);
    try {
      const report = pruner.pruneSession(session);
      const pruned = Array.isArray(report?.pruned) ? report.pruned : [];
      const advanced = num(session?.surface?.replaceGeneration, 0) > generation;
      if (pruned.length === 0 && advanced === false) {
        return { rung: "prune", outcome: "noop", reason: "nothing prunable on this surface" };
      }
      const after = this._totalTokens(session);
      const seqs = pruned.map((entry) => num(entry?.originalSeq, 0)).filter((seq) => seq > 0);
      return {
        rung: "prune",
        outcome: "committed",
        advanced,
        result: {
          via: "doctor-prune",
          trigger: "prune-only",
          shadowedSeqs: seqs,
          shadowedRange: { start: seqs[0] ?? 0, end: seqs[seqs.length - 1] ?? 0 },
          shadowedTokenCount: Math.max(0, before - after),
          pruned: pruned.length,
          charsRemoved: num(report?.charsRemoved, 0),
        },
      };
    } catch (error) {
      this.doctorStats.lastRungFailure = { at: new Date().toISOString(), rung: "prune", message: error?.message ?? String(error) };
      warn(this.ctx, `rung 2 (prune only) failed: ${error?.message ?? error} — descending`);
      return { rung: "prune", outcome: "failed", reason: error?.message ?? String(error), error };
    }
  }

  /**
   * Rung 3: a hard trim that lands far below the window, with no summarization
   * at all. This is the rung that guarantees progress: it needs no model call,
   * never includes surface node 0, and always leaves the newest node in place.
   */
  async _rungHardTrim(agent, signal, doctor, generation, trigger) {
    const session = agent.session;
    if (signal?.aborted === true) return { rung: "hard-trim", outcome: "aborted" };
    if (typeof session?.append !== "function") {
      return { rung: "hard-trim", outcome: "unavailable", reason: "session.append is unavailable" };
    }
    try {
      const route = this.routeFor(agent, doctor);
      const numbers = await this._numbersFor(agent, route, signal);
      const measurement = this._measure(session);
      const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : [];
      if (nodes.length === 0) return { rung: "hard-trim", outcome: "noop", reason: "the surface is empty" };
      // F3: never node 0 when it holds the system prompt.
      const firstIndex = this._firstCompactableIndex(session);
      const ratio = num(doctor.hardTrimRatio, HARD_TRIM_TARGET_RATIO) || HARD_TRIM_TARGET_RATIO;
      const target = Math.max(1, Math.floor(numbers.W * ratio));
      let keepFrom = nodes.length;
      let tail = 0;
      while (keepFrom > firstIndex && tail < target) {
        keepFrom -= 1;
        tail += num(nodes[keepFrom]?.tokens, 0);
      }
      if (keepFrom <= firstIndex) {
        // Measured as "already below the hard-trim target" — but on an overflow
        // trigger the provider has *already refused this exact prompt*, so our
        // own measure is under-counting (it is an estimate; the adapter's
        // admission is the ground truth). Doing nothing is the one outcome that
        // guarantees a dead turn, so the last rung drops the oldest half of the
        // droppable nodes anyway: never node 0, always keeping the newest node.
        const droppable = nodes.length - 1 - firstIndex;
        if (trigger !== "context-overflow" || droppable < 1) {
          return { rung: "hard-trim", outcome: "noop", reason: "the whole surface is already below the hard-trim target" };
        }
        keepFrom = firstIndex + Math.max(1, Math.ceil(droppable / 2));
      }
      let trimmed = this._trimToBalancedCuts(session, nodes, { startIndex: firstIndex, endIndex: keepFrom - 1 }, firstIndex);
      if (trimmed === undefined && trigger === "context-overflow" && firstIndex <= nodes.length - 2) {
        // Last resort on an overflow trigger: no tool-pairing-balanced cut exists
        // at any width, and the alternative is a dead turn. Drop everything but
        // the newest node (and never node 0), and say so in the result.
        trimmed = {
          startSeq: num(nodes[firstIndex]?.seq, -1),
          endSeq: num(nodes[nodes.length - 2]?.seq, -1),
          balanced: false,
        };
      }
      if (trimmed === undefined || trimmed.startSeq < 0 || trimmed.endSeq < 0) {
        return { rung: "hard-trim", outcome: "noop", reason: "no tool-pairing-balanced cut exists for a hard trim" };
      }
      const shadowedSeqs = [];
      for (let index = firstIndex; index < nodes.length; index += 1) {
        const seq = num(nodes[index]?.seq, -1);
        if (seq < trimmed.startSeq) continue;
        if (seq > trimmed.endSeq) break;
        shadowedSeqs.push(seq);
      }
      if (shadowedSeqs.length === 0) {
        return { rung: "hard-trim", outcome: "noop", reason: "no non-system node is available to drop" };
      }
      const before = this._totalTokens(session);
      session.append(
        "user/message",
        hardTrimMessage(shadowedSeqs.length, num(measurement?.totalTokens, 0)),
        {
          surfaceOp: { op: "replace", startSeq: shadowedSeqs[0], endSeq: shadowedSeqs[shadowedSeqs.length - 1] },
          sourceEventSeqs: shadowedSeqs,
        },
      );
      const advanced = num(session?.surface?.replaceGeneration, 0) > generation;
      if (advanced === false && session?.surface?.replaceGeneration !== undefined) {
        return { rung: "hard-trim", outcome: "failed", reason: "the hard trim was reported without moving the surface" };
      }
      const after = this._totalTokens(session);
      return {
        rung: "hard-trim",
        outcome: "committed",
        advanced,
        result: {
          via: "doctor-hard-trim",
          trigger: "hard-trim",
          shadowedSeqs,
          shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1] },
          shadowedTokenCount: Math.max(0, before - after),
          targetTokens: target,
          toolPairingBalanced: trimmed.balanced !== false,
        },
      };
    } catch (error) {
      this.doctorStats.lastRungFailure = { at: new Date().toISOString(), rung: "hard-trim", message: error?.message ?? String(error) };
      warn(this.ctx, `rung 3 (hard trim) failed: ${error?.message ?? error}`);
      return { rung: "hard-trim", outcome: "failed", reason: error?.message ?? String(error), error };
    }
  }

  /** Manual compaction; the chunked summarizer above is the repair path. */
  async compactNow(agent, signal, sourceCommandId) {
    const doctor = this.doctorConfig();
    const session = agent?.session;
    if (session === undefined) return super.compactNow(agent, signal, sourceCommandId);
    const inert = this.inertReason(agent, doctor);
    if (inert !== undefined) {
      this._standDown(inert);
      return super.compactNow(agent, signal, sourceCommandId);
    }
    beginScale(session);
    try {
      const result = await super.compactNow(agent, signal, sourceCommandId);
      this._recordResult(result, "manual");
      return result;
    } catch (error) {
      this._recordFailure(error, "manual");
      if (error instanceof ManualCompactionError) {
        warn(
          this.ctx,
          `manual compaction ended as "${error.code}": ${error.message ?? ""}` +
            (doctor.scaleMode === "off" ? " (scaleMode is off — every repair is disabled)" : ""),
        );
      }
      throw error;
    } finally {
      endScale(session);
    }
  }

  /**
   * Fallback teardown. This fork has no `Service.prototype.stop()` hook, so the
   * authoritative teardown is the disposer registered by `_installMeter`; this
   * stays as a belt-and-braces entry point for hosts that do call it.
   */
  stop() {
    try {
      uninstallScaledMeter(this.ctx);
      this.doctorStats.meterPatched = false;
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  _meter() {
    try {
      return this.ctx?.get?.("tokenMeter");
    } catch {
      return undefined;
    }
  }

  /** The meter's current measurement, or a neutral stand-in. */
  _measure(session) {
    const measurement = this._meter()?.measure?.(session);
    return measurement !== undefined && measurement !== null ? measurement : { totalTokens: 0, surfaceTokens: 0, nodes: [] };
  }

  /** Real prompt cost of one session, or 0 when the meter is unavailable. */
  _totalTokens(session) {
    return Math.max(0, Math.floor(num(this._measure(session).totalTokens, 0)));
  }

  /**
   * The first surface index a replacement may start at (F3).
   *
   * `dsh-session/lib/index.js:421-425` protects the `system/message` at node 0: a
   * replacement covering it must itself be a `system/message` over exactly that
   * one node. A compaction range is a `user/message`, so it can never start
   * there; `dsh-compaction-basic/lib/index.js:415` is the shipped rule
   * (`firstIdx = systemHead(...) === undefined ? 0 : 1`).
   */
  _firstCompactableIndex(session) {
    const nodes = surfaceSeqs(session);
    const headSeq = nodes[0];
    if (headSeq === undefined) return 0;
    const head = eventAt(session, headSeq);
    return head?.type === "system/message" ? 1 : 0;
  }

  /**
   * Whether the settings page (probe row) sets a budget key to a value the
   * frozen engine row does not already have.
   *
   * `this.config` is `deepFreeze`d by the shipped base class at mount, so a page
   * edit cannot mutate it. When the two disagree the engine takes its own
   * selection path (which prices and selects with the doctor's numbers) instead
   * of handing the stale frozen policy to the shipped code. When they agree — the
   * default on a fresh install — the shipped path runs unchanged.
   */
  _doctorOverridesBudgets(doctor) {
    const row = this.config ?? {};
    const differs = (key) => {
      const mine = doctor?.[key];
      if (mine === undefined || mine === null) return false;
      const theirs = row[key];
      if (theirs === undefined || theirs === null) return true;
      return num(mine, Number.NaN) !== num(theirs, Number.NaN);
    };
    return differs("thresholdRatio") || differs("retainRatio");
  }

  /** Record one benign skip: the ladder descends, nothing is reported as failed. */
  _benign(rung, reason) {
    this.doctorStats.benignSkips += 1;
    this.doctorStats.lastBenign = { at: new Date().toISOString(), rung, reason };
  }

  _tokensPerByte(doctor, route) {
    const table = doctor.tokensPerByteByModel;
    if (table !== undefined && table !== null && route !== undefined) {
      const key = `${route.provider}/${route.model}`;
      const value = num(table[key] ?? table[route.model], 0);
      if (value > 0) return value;
    }
    return num(doctor.tokensPerByte, 0.34) || 0.34;
  }

  async _numbersFor(agent, route, signal) {
    const doctor = this.doctorConfig();
    const info = await this._resolveInfo(route, signal);
    const probed = this.probedCapability();
    const W = firstPositive(
      probed?.contextWindow,
      route?.contextWindow,
      readContextWindow(info),
      num(info?.context, 0),
      doctor.fallbackContextWindow,
      num(this.config?.contextWindow, 0),
    );
    // Doc §8.10: the output reservation is the effective request envelope's own
    // cap (`requestHeader().config.maxTokens`), then the adapter default.
    let headerMaxTokens = 0;
    try {
      headerMaxTokens = num(agent?.session?.requestHeader?.()?.config?.maxTokens, 0);
    } catch {
      headerMaxTokens = 0;
    }
    const O = firstPositive(
      headerMaxTokens,
      num(agent?.maxTokens, 0),
      num(agent?.request?.maxTokens, 0),
      num(info?.defaultMaxTokens, 0),
      num(info?.maxTokens, 0),
      num(doctor.maxTokens, DEFAULT_MAX_TOKENS),
      DEFAULT_MAX_TOKENS,
    );
    // The summarization call carries the *compaction* config's `maxTokens`
    // verbatim (`dsh-compaction-basic/lib/index.js:318`), which is a different
    // envelope from the conversation's, so its own reservation is counted into
    // the summary budget separately (F1).
    const summaryMaxOutput = Math.max(O, num(this.config?.maxTokens, 0), num(doctor.maxTokens, 0));
    // F5: a window the provider has already refused may never be planned
    // against again.
    const bound = this.windowBound(route);
    const usable = effectiveWindow(W, bound) || W;
    return computeNumbers({
      contextWindow: usable,
      maxOutput: Math.min(O, Math.max(1, Math.floor(usable * 0.5))),
      headroom: this.config?.headroomTokens,
      // The settings page owns these two: a page edit must win over the value
      // frozen into the engine row at mount.
      thresholdRatio:
        num(doctor.thresholdRatio, num(this.config?.thresholdRatio, DEFAULT_THRESHOLD_RATIO)) || DEFAULT_THRESHOLD_RATIO,
      retainRatio:
        this.config?.retainTokens === undefined
          ? num(doctor.retainRatio, num(this.config?.retainRatio, DEFAULT_RETAIN_RATIO)) || DEFAULT_RETAIN_RATIO
          : undefined,
      retainTokens: this.config?.retainTokens,
      summaryBudgetRatio: num(doctor.summaryBudgetRatio, 0.9) || 0.9,
      summaryHardMargin: num(doctor.summaryHardMargin, SUMMARY_HARD_MARGIN_TOKENS),
      summaryMaxOutput,
    });
  }

  async _resolveInfo(route, signal) {
    if (route === undefined || typeof route.model !== "string") return undefined;
    const llm = this.ctx.llm;
    if (typeof llm?.resolveModelInfo !== "function") return undefined;
    try {
      return await llm.resolveModelInfo(route.provider, route.model, signal);
    } catch {
      try {
        return await llm.resolveModelInfo(route);
      } catch {
        return undefined;
      }
    }
  }

  /** The largest probed window may be a hair optimistic; keep a little slack. */
  _usableWindow(window) {
    return Math.floor(num(window, 0) * STDERR_WINDOW_RATIO);
  }

  _hasActiveCompaction(session) {
    const seqs = surfaceSeqs(session);
    let depth = 0;
    for (let index = seqs.length - 1; index >= 0; index -= 1) {
      const event = eventAt(session, seqs[index]);
      if (event === undefined) continue;
      if (event.type === "compaction/end") depth += 1;
      else if (event.type === "compaction/start") {
        if (depth === 0) return true;
        depth -= 1;
      }
    }
    return false;
  }

  /** Remember the last committed reduction for the settings-page status card. */
  _recordResult(result, trigger) {
    if (result === null || result === undefined) return;
    const seqs = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs : [];
    const range = result.shadowedRange;
    try {
      this.doctorStats.lastCompaction = {
        at: new Date().toISOString(),
        trigger,
        shadowedNodes: seqs.length,
        shadowedTokens: num(result.shadowedTokenCount, 0),
        ...(range === undefined ? {} : { rangeStart: num(range.start, 0), rangeEnd: num(range.end, 0) }),
      };
    } catch {
      /* diagnostics must never break a committed compaction */
    }
  }

  /**
   * Account for the shipped shrink guard: "summary is not smaller than the
   * shadowed content" is the failure that made automatic compaction look like it
   * never ran, so it is surfaced as a first-class status metric.
   */
  _recordFailure(error, trigger) {
    try {
      const message = error?.message ?? String(error);
      if (/not smaller than the shadowed content/u.test(message)) {
        this.doctorStats.guardFailures += 1;
        this.doctorStats.lastGuardMessage = message;
      }
      this.doctorStats.lastFailure = { at: new Date().toISOString(), trigger, message };
    } catch {
      /* ignore */
    }
  }

  /**
   * Local head selection for the doctor's own pricing; stock path on any doubt.
   *
   * Returns either the host's compaction result or a `{[SKIP]: reason}` marker:
   * the pre-flight refusals (F2/F4 — a summary that cannot be admitted, or a
   * region no larger than this route's own summaries) never reach the provider
   * and never become errors.
   */
  async _selectCompactIfNeeded(agent, trigger, signal, doctor, route) {
    const session = agent.session;
    try {
      if (route === undefined) route = this.routeFor(agent, doctor);
      if (route === undefined) return await super.compactIfNeeded(agent, trigger, signal);
      if (this._hasActiveCompaction(session)) return await super.compactIfNeeded(agent, trigger, signal);
      const numbers = await this._numbersFor(agent, route, signal);
      if (numbers.W <= 0) return await super.compactIfNeeded(agent, trigger, signal);
      const measurement = this._measure(session);
      const factor = scaleFactorOf(measurement);
      const verdict = classifyMeasurement(measurement, factor, numbers);
      this.doctorStats.lastScale = factor;
      if (trigger === "pressure" && verdict.overThreshold === false) return null;
      const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : [];
      const tokens = nodes.map((node) => num(node?.tokens, 0) * factor);
      // Doc §8.2: the selection cap must use the *summary request* budget, not
      // the looser shipped summary budget — the tighter bound is what keeps the
      // replacement region summarizable at all.
      const capTokens = Math.max(1, Math.floor(numbers.summaryRequestBudget * (num(doctor.selectCapRatio, 0.85) || 0.85)));
      // `tokens` is already rescaled to real prompt cost, so every bound passed
      // here must be in real units too — mixing scales is the very defect this
      // engine exists to remove. F3: the selection may never start at surface
      // node 0 when it holds the system prompt.
      const firstIndex = this._firstCompactableIndex(session);
      const range = selectIndexRange(tokens, {
        firstIndex,
        retainTokens: trigger === "context-overflow" ? 0 : numbers.retainReal,
        capTokens,
      });
      if (range === null) return await super.compactIfNeeded(agent, trigger, signal);
      const trimmed = this._trimToBalancedCuts(session, nodes, range, firstIndex);
      if (trimmed === undefined) return await super.compactIfNeeded(agent, trigger, signal);
      const regionTokens = tokens.slice(range.startIndex, range.endIndex + 1).reduce((sum, value) => sum + value, 0);
      const skip = this._summaryPreflight(regionTokens, numbers, doctor, route, trigger);
      if (skip !== undefined) return { [SKIP]: skip };
      this.doctorStats.selectRuns += 1;
      return await this.compactRegion(trimmed.startSeq, trimmed.endSeq, agent, signal);
    } catch (error) {
      if (error instanceof DoctorSummaryUnavailableError) throw error;
      warn(this.ctx, `local head selection failed, falling back to the shipped path: ${error?.message ?? error}`);
      try {
        return await super.compactIfNeeded(agent, trigger, signal);
      } catch (nested) {
        // Both selection paths are broken. Report it as a *decline* so the
        // ladder counts a benign skip and still tries to make progress, instead
        // of returning a silent `null` that looks like "nothing to do".
        warn(this.ctx, `shipped path also failed: ${nested?.message ?? nested}`);
        return { [SKIP]: `neither selection path could run (${nested?.message ?? nested})` };
      }
    }
  }

  /**
   * Refuse a rung-1 attempt that cannot succeed, *before* the host opens a
   * compaction transaction (so nothing is written and nothing is reported).
   *
   * Two constructibility facts are checked: the region must be summarizable
   * within `maxSummaryChunks` (F2), and it must be larger than this route's own
   * observed summary size — the shipped shrink guard rejects a checkpoint that
   * is not smaller than what it shadows
   * (`dsh-compaction-basic/lib/index.js:600-601`), and that rejection is the
   * most common failure in the recorded sessions (with the two numbers exactly
   * equal: a region that is already one checkpoint being re-summarized).
   */
  _summaryPreflight(regionTokens, numbers, doctor, route, trigger) {
    const budget = Math.max(0, Math.floor(num(numbers.summaryRequestBudget, 0)));
    const maxChunks = Math.max(2, Math.min(num(doctor.maxSummaryChunks, 8) || 8, CHUNK_COUNT_HARD_LIMIT));
    const region = Math.max(0, Math.floor(num(regionTokens, 0)));
    if (budget <= 0) return "no summarization budget is left inside this window";
    if (region > budget * maxChunks) {
      return `the region prices at ${region} tokens, beyond ${maxChunks} chunk(s) of ${budget}`;
    }
    if (trigger === "context-overflow" || trigger === "pressure") {
      const observed = this._summaryCeiling(route);
      if (region <= observed) {
        return `the region (${region} tokens) is no larger than this route's observed summary size (${observed})`;
      }
    }
    return undefined;
  }

  /** Snap the selected span onto cuts that do not split a tool pair. */
  _trimToBalancedCuts(session, nodes, range, firstIndex = 0) {
    let startIndex = Math.max(num(range?.startIndex, 0), num(firstIndex, 0));
    let endIndex = num(range?.endIndex, -1);
    const balancedBefore = (seq) => {
      try {
        return toolPairingBalancedBefore(session, seq) === true;
      } catch {
        return false;
      }
    };
    const balancedAfter = (seq) => {
      try {
        return toolPairingBalancedAfter(session, seq) === true;
      } catch {
        return false;
      }
    };
    while (endIndex >= startIndex && !balancedAfter(nodes[endIndex]?.seq)) endIndex -= 1;
    while (startIndex <= endIndex && !balancedBefore(nodes[startIndex]?.seq)) startIndex += 1;
    if (startIndex > endIndex) return undefined;
    const start = nodes[startIndex]?.seq;
    const end = nodes[endIndex]?.seq;
    if (typeof start !== "number" || typeof end !== "number") return undefined;
    if (end < start) return undefined;
    return { startSeq: start, endSeq: end };
  }

  /** Report the live state of the scaled-meter patch (status card + `/compact-doctor`). */
  meterState() {
    return meterPatchState(this.ctx);
  }

  /** Diagnostics for `/compact-doctor`. */
  diagnostics() {
    const doctor = this.doctorConfig();
    return {
      engine: "compaction-doctor",
      scaleMode: doctor.scaleMode ?? "meter",
      config: {
        thresholdRatio: this.config?.thresholdRatio,
        headroomTokens: this.config?.headroomTokens,
        retainRatio: this.config?.retainRatio,
        retainTokens: this.config?.retainTokens,
        maxTokens: this.config?.maxTokens,
        compactionRetries: this.config?.compactionRetries,
        maxOverflowRetries: this.config?.maxOverflowRetries,
        auto: this.config?.auto,
      },
      probed: this.probedCapability(),
      stats: { ...this.doctorStats },
    };
  }
}

// -------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------

function firstPositive(...candidates) {
  for (const candidate of candidates) {
    const value = num(candidate, 0);
    if (value > 0) return value;
  }
  return 0;
}

/**
 * Price the region a summarization covers.
 *
 * `buildSummarizationInput` puts the surface's `system/message` at index 0 and
 * the region's own messages after it
 * (`dsh-compaction-basic/lib/index.js:695-704`), so subtracting the system
 * prompt's price from the replayed prefix is the same quantity the shipped
 * shrink guard calls `shadowedRouteTokenCount`.
 */
export function regionPriceOf(messages, price) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const cost = Math.max(0, price(messages[index], index));
    if (index === 0 && messages[index]?.role === "system") continue;
    total += cost;
  }
  return total;
}

/** Only non-blank text-bearing blocks count as summary text. */
function textBlocksOf(value) {
  if (typeof value === "string") return value.trim().length > 0 ? [value] : [];
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const block of value) if (typeof block?.text === "string" && block.text.trim().length > 0) out.push(block.text);
  return out;
}

/**
 * Best-effort text extraction from a summarizer result.
 *
 * The shipped `BasicCompactionEngine.summarize` answers with
 * `{ summary: [blocks], rawOutput: [blocks], llmStreamCall, provider, model,
 * maxTokens, usage }` (`dsh-compaction-basic/lib/index.js:329-337`) — the
 * primary text lives in the `summary` *array*. Reading only a
 * `blocks`/`text`/string-`summary` shape (what the offline stub returns) made
 * every real chunk look empty, which is what produced the recorded
 * `chunkCalls: 14 / chunkedRegions: 0` and the "no summary text" error.
 */
export function collectText(output) {
  if (output === undefined || output === null) return undefined;
  const summary = textBlocksOf(output.summary);
  if (summary.length > 0) return summary.join("\n");
  // Last resort: the raw model output, which also carries reasoning blocks. It
  // is the model's own account of the region and is still usable as a
  // checkpoint when no text block survived.
  const raw = textBlocksOf(output.rawOutput);
  if (raw.length > 0) return raw.join("\n");
  const blocks = textBlocksOf(output.blocks);
  if (blocks.length > 0) return blocks.join("\n");
  if (typeof output.text === "string" && output.text.length > 0) return output.text;
  if (typeof output.summary === "string" && output.summary.length > 0) return output.summary;
  return undefined;
}

/** Fold `text` into the first text-bearing block of a summary shape. */
function replaceFirstText(container, text) {
  if (typeof container === "string") return text;
  if (!Array.isArray(container)) return undefined;
  let replaced = false;
  return container.map((block) => {
    if (replaced || typeof block?.text !== "string") return block;
    replaced = true;
    return { ...shallowClone(block), text };
  });
}

/**
 * Replace the merged text inside a summarizer result, preserving every other
 * field and the exact original shape.
 *
 * For the real shape this must keep `summary` an **array of blocks**: the host
 * spreads it into the framed checkpoint message
 * (`dsh-compaction-basic/lib/index.js:344-356`), so a plain string there would be
 * spread character by character.
 */
export function withMergedText(template, text) {
  if (template === undefined || template === null) return undefined;
  const clone = shallowClone(template);
  if (Array.isArray(template.summary) || typeof template.summary === "string") {
    const merged = replaceFirstText(template.summary, text);
    clone.summary = merged ?? [{ type: "text", text }, ...(Array.isArray(template.summary) ? template.summary : [])];
    return clone;
  }
  const blocks = Array.isArray(template.blocks) ? template.blocks : undefined;
  if (blocks !== undefined) {
    let replaced = false;
    clone.blocks = blocks.map((block) => {
      if (replaced || typeof block?.text !== "string") return block;
      replaced = true;
      return { ...shallowClone(block), text };
    });
    if (replaced === false) clone.blocks = [...blocks, { type: "text", text }];
    return clone;
  }
  if (typeof template.text === "string") {
    clone.text = text;
    return clone;
  }
  if (typeof template.summary === "string") {
    clone.summary = text;
    return clone;
  }
  return undefined;
}

/**
 * Split any message whose own price exceeds one chunk's budget (F2).
 *
 * F2 requires that a single oversized message can be cut, because the recorded
 * failure mode is one region that cannot be admitted at all. Only text-bearing
 * blocks are cut; a block that cannot be divided (an image reference) makes the
 * plan infeasible instead, which the ladder turns into a benign skip.
 *
 * @returns `{ parts, infeasible }`.
 */
export function splitOversizedMessages(messages, perChunk, price) {
  const parts = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const cost = price(message);
    if (cost <= perChunk) {
      parts.push(message);
      continue;
    }
    const content = Array.isArray(message?.content) ? message.content : undefined;
    if (content === undefined) return { parts, infeasible: `message ${index} is not splittable (no content blocks)` };
    const dividable = content.filter((block) => block?.type === "text" || block?.type === "reasoning");
    if (dividable.length === 0) {
      return { parts, infeasible: `message ${index} prices at ${cost} tokens and holds no dividable text` };
    }
    const charsPerPart = Math.max(1, Math.floor(perChunk * 4 * SPLIT_CHAR_SLACK));
    const pieces = [];
    let current = [];
    let currentChars = 0;
    let split = false;
    const flush = () => {
      if (current.length > 0) pieces.push(current);
      current = [];
      currentChars = 0;
    };
    for (const block of content) {
      if (typeof block?.text !== "string") {
        // A block without text cannot be divided; keep it with the part being
        // built so a tool call stays behind its own text.
        current.push(block);
        continue;
      }
      const value = block.text;
      let offset = 0;
      while (offset < value.length) {
        const room = charsPerPart - currentChars;
        if (room <= 0) {
          flush();
          continue;
        }
        const slice = value.slice(offset, offset + room);
        if (slice.length < value.length - offset) split = true;
        current.push({ ...shallowClone(block), text: slice });
        currentChars += slice.length;
        offset += slice.length;
        if (offset < value.length) flush();
      }
    }
    flush();
    if (pieces.length === 0) return { parts, infeasible: `message ${index} prices at ${cost} tokens and produced no parts` };
    for (const piece of pieces) parts.push({ ...shallowClone(message), content: piece, ...(split ? { doctorSplit: true } : {}) });
  }
  return { parts };
}

/** The replacement message a hard trim commits: honest about what it dropped. */
function hardTrimMessage(shadowedCount, tokens) {
  return {
    role: "user",
    id: `compaction-doctor-hard-trim-${randomUUID()}`,
    content: [
      {
        type: "text",
        text:
          "[compaction-doctor] The oldest part of this conversation was dropped without summarization " +
          `(${shadowedCount} message(s), ~${tokens} estimated tokens) because summarization could not reduce it on this provider. ` +
          "Continue the task from the messages that follow.",
      },
    ],
    source: compactCheckpointSource(`compaction-doctor-hard-trim-${randomUUID()}`),
  };
}

/** Additive usage merge across chunk calls. */
export function sumUsage(accumulated, usage) {
  if (usage === undefined || usage === null || typeof usage !== "object") return accumulated;
  if (accumulated === undefined) {
    const clone = shallowClone(usage);
    return clone;
  }
  for (const key of Object.keys(usage)) {
    const value = num(usage[key], NaN);
    if (Number.isFinite(value) && Number.isFinite(num(accumulated[key], NaN))) accumulated[key] = num(accumulated[key], 0) + value;
  }
  return accumulated;
}

export { CompactionDoctorEngine as default };
