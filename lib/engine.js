/**
 * Compaction engine with three repairs on top of the shipped backend:
 *
 *  1. **Real-scale retention pricing** — while a compaction of a session is in
 *     flight, node pricing is rescaled so that retention and thresholds share
 *     the scale the provider actually bills. Without this the shadowed head is
 *     `k` times smaller than the window implies (the `k ~ 8.6` defect).
 *  2. **Chunked hierarchical summarization** — when the selected region is
 *     larger than the summarizer's own input budget, the region is summarized
 *     in contiguous chunks and the part summaries are merged into one text.
 *     This is what makes a manual `/compact` of a full window work.
 *  3. **Overflow classification for untranslated provider errors** — a 400
 *     that means "prompt too long" in the provider's own language is treated
 *     as a context overflow: compact, then retry once.
 *
 * The class extends the shipped `BasicCompactionEngine` and only overrides
 * documented extension points (`summarize`, `compactIfNeeded`) plus one
 * session-scoped meter patch. Setting `scaleMode: "off"` restores stock
 * behaviour exactly, which makes A/B verification possible.
 *
 * @module @local/dsh-compaction-doctor/engine
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import {
  ManualCompactionError,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from "@deepseek-ai/dsh-compaction";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";

import { classifyMeasurement, computeNumbers, DEFAULT_RETAIN_RATIO, DEFAULT_THRESHOLD_RATIO, selectIndexRange, splitByCost } from "./plan.js";
import { beginScale, endScale, installScaledMeter, meterPatchState, scaleFactorOf, uninstallScaledMeter } from "./rescale.js";
import { isContextOverflowFailure, providerAttribution } from "./overflow.js";
import { estimateTokens, latestRoute, num, readContextWindow, shallowClone, surfaceSeqs, warn } from "./util.js";

const STDERR_WINDOW_RATIO = 0.98;
const CHUNK_TARGET_RATIO = 0.85;
const CHUNK_COUNT_HARD_LIMIT = 24;
const DEFAULT_MAX_TOKENS = 65536;

export const DOCTOR_DEFAULTS = {
  enabled: true,
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
};

/** Doctor settings that the engine row may carry on its own. */
const DOCTOR_OWNED_KEYS = [
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
];

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
    };
    this._installMeter(ctx);
    this._overflowRetries = new WeakMap();
    /** session -> agent, so the `session/event` listener can undo the budget. */
    this._overflowAgents = new WeakMap();
    this._classifierRegistered = false;
    this._registerOverflowClassifier(ctx);
    this._registerRetryReset(ctx);
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
  // overflow classification
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
        warn(
          ctx,
          `classified ${String(failure.code)} as context overflow (${verdict}${providerAttribution(failure) === undefined ? "" : `, ${providerAttribution(failure)}`}) — compacting and retrying`,
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
  // summarization
  // ---------------------------------------------------------------------

  /**
   * Summarize a region, splitting it into contiguous chunks when the region
   * itself would exceed the summarizer's input budget.
   */
  async summarize(input, agent, signal) {
    this.doctorStats.summarizeCalls += 1;
    const doctor = this.doctorConfig();
    const session = agent?.session;
    const route = latestRoute(session, { provider: doctor.provider, model: doctor.model });
    const numbers = await this._numbersFor(agent, route, signal);
    const messages = Array.isArray(input?.messages) ? input.messages : undefined;
    const summaryBudget = numbers.summaryBudget > 0 ? numbers.summaryBudget : 0;
    if (summaryBudget <= 0 || messages === undefined || messages.length <= 1) {
      return super.summarize(input, agent, signal);
    }
    const tokensPerByte = this._tokensPerByte(doctor, route);
    const costs = messages.map((message) => Math.max(1, estimateTokens(message, tokensPerByte)));
    const total = costs.reduce((sum, cost) => sum + cost, 0);
    const chunkTarget = Math.max(1, Math.floor(summaryBudget * CHUNK_TARGET_RATIO));
    if (total <= chunkTarget) return super.summarize(input, agent, signal);

    const maxChunks = Math.max(2, Math.min(num(doctor.maxSummaryChunks, 8) || 8, CHUNK_COUNT_HARD_LIMIT));
    const wanted = Math.min(Math.max(2, Math.ceil(total / chunkTarget)), maxChunks, messages.length);
    const groups = splitByCost(messages, costs, wanted);
    if (groups.length <= 1) return super.summarize(input, agent, signal);

    warn(
      this.ctx,
      `summarizing ${groups.length} chunks (~${total} est. tokens, budget ${summaryBudget}) to fit the summarizer window`,
    );
    const texts = [];
    let template;
    let firstError;
    let usage;
    for (let index = 0; index < groups.length; index += 1) {
      if (signal?.aborted === true) throw firstError ?? new Error("compaction summarization aborted");
      const chunkInput = { ...shallowClone(input), messages: groups[index] };
      try {
        const output = await super.summarize(chunkInput, agent, signal);
        this.doctorStats.chunkCalls += 1;
        if (template === undefined && output !== undefined && output !== null) template = output;
        const text = collectText(output);
        if (text !== undefined && text.length > 0) texts.push(text);
        usage = sumUsage(usage, output?.usage);
      } catch (error) {
        if (firstError === undefined) firstError = error;
        warn(this.ctx, `chunk ${index + 1}/${groups.length} summarization failed: ${error?.message ?? error}`);
        if (index === 0 && error instanceof ManualCompactionError) throw error;
      }
    }
    if (texts.length === 0) throw firstError ?? new Error("compaction produced no summary text");
    this.doctorStats.chunkedRegions += 1;
    const merged = texts.join("\n\n");
    const combined = withMergedText(template, merged);
    if (combined === undefined) {
      warn(this.ctx, "summarizer output shape unknown; returning the first chunk summary unchanged");
      return template ?? super.summarize(input, agent, signal);
    }
    this.doctorStats.merges += 1;
    if (usage !== undefined) combined.usage = usage;
    return combined;
  }

  // ---------------------------------------------------------------------
  // compaction entry points
  // ---------------------------------------------------------------------

  /** Keep retention pricing on one scale for the whole compaction of a session. */
  async compactIfNeeded(agent, trigger, signal) {
    const doctor = this.doctorConfig();
    if (doctor.enabled === false) return null;
    const mode = doctor.scaleMode ?? "meter";
    const session = agent?.session;
    if (mode === "off" || session === undefined) return super.compactIfNeeded(agent, trigger, signal);
    beginScale(session);
    try {
      const result =
        mode === "meter"
          ? await super.compactIfNeeded(agent, trigger, signal)
          : await this._selectCompactIfNeeded(agent, trigger, signal, doctor);
      this._recordResult(result, trigger);
      return result;
    } catch (error) {
      this._recordFailure(error, trigger);
      throw error;
    } finally {
      endScale(session);
    }
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
   * shadowed content" is the failure that made automatic compaction look like
   * it never ran, so it is surfaced as a first-class status metric.
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

  /** Local head selection for `scaleMode: "select"`; stock path on any doubt. */
  async _selectCompactIfNeeded(agent, trigger, signal, doctor) {
    const session = agent.session;
    try {
      const route = latestRoute(session, { provider: doctor.provider, model: doctor.model });
      if (route === undefined) return await super.compactIfNeeded(agent, trigger, signal);
      if (this._hasActiveCompaction(session)) return await super.compactIfNeeded(agent, trigger, signal);
      const numbers = await this._numbersFor(agent, route, signal);
      if (numbers.W <= 0) return await super.compactIfNeeded(agent, trigger, signal);
      const measurement = this.ctx.tokenMeter.measure(session);
      const factor = scaleFactorOf(measurement);
      const verdict = classifyMeasurement(measurement, factor, numbers);
      this.doctorStats.lastScale = factor;
      if (trigger === "pressure" && verdict.overThreshold === false) return null;
      const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : [];
      const tokens = nodes.map((node) => num(node?.tokens, 0) * factor);
      const capTokens = Math.max(1, Math.floor(numbers.summaryBudget * (num(doctor.selectCapRatio, 0.85) || 0.85)));
      // `tokens` is already rescaled to real prompt cost, so every bound passed
      // here must be in real units too — mixing scales is the very defect this
      // engine exists to remove.
      const range = selectIndexRange(tokens, {
        retainTokens: trigger === "context-overflow" ? 0 : numbers.retainReal,
        capTokens,
      });
      if (range === null) return await super.compactIfNeeded(agent, trigger, signal);
      const trimmed = this._trimToBalancedCuts(session, nodes, range);
      if (trimmed === undefined) return await super.compactIfNeeded(agent, trigger, signal);
      this.doctorStats.selectRuns += 1;
      return await this.compactRegion(trimmed.startSeq, trimmed.endSeq, agent, signal);
    } catch (error) {
      warn(this.ctx, `local head selection failed, falling back to the shipped path: ${error?.message ?? error}`);
      try {
        return await super.compactIfNeeded(agent, trigger, signal);
      } catch (nested) {
        warn(this.ctx, `shipped path also failed: ${nested?.message ?? nested}`);
        return null;
      }
    }
  }

  /** Manual compaction; the chunked summarizer above is the repair path. */
  async compactNow(agent, signal, sourceCommandId) {
    const doctor = this.doctorConfig();
    const session = agent?.session;
    if (session === undefined) return super.compactNow(agent, signal, sourceCommandId);
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
    const O = firstPositive(
      num(agent?.maxTokens, 0),
      num(agent?.request?.maxTokens, 0),
      num(info?.defaultMaxTokens, 0),
      num(info?.maxTokens, 0),
      num(doctor.maxTokens, DEFAULT_MAX_TOKENS),
      DEFAULT_MAX_TOKENS,
    );
    return computeNumbers({
      contextWindow: W,
      maxOutput: Math.min(O, Math.max(1, Math.floor(W * 0.5))),
      headroom: this.config?.headroomTokens,
      thresholdRatio: num(this.config?.thresholdRatio, DEFAULT_THRESHOLD_RATIO) || DEFAULT_THRESHOLD_RATIO,
      retainRatio:
        this.config?.retainTokens === undefined
          ? num(this.config?.retainRatio, DEFAULT_RETAIN_RATIO) || DEFAULT_RETAIN_RATIO
          : undefined,
      retainTokens: this.config?.retainTokens,
      summaryBudgetRatio: num(doctor.summaryBudgetRatio, 0.9) || 0.9,
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
      const event = session?.eventAt?.(seqs[index]);
      if (event === undefined) continue;
      if (event.type === "compaction/end") depth += 1;
      else if (event.type === "compaction/start") {
        if (depth === 0) return true;
        depth -= 1;
      }
    }
    return false;
  }

  /** Snap the selected span onto cuts that do not split a tool pair. */
  _trimToBalancedCuts(session, nodes, range) {
    let startIndex = range.startIndex;
    let endIndex = range.endIndex;
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

/** Best-effort text extraction from a summarizer result. */
export function collectText(output) {
  if (output === undefined || output === null) return undefined;
  const blocks = Array.isArray(output.blocks) ? output.blocks : undefined;
  if (blocks !== undefined) {
    const texts = [];
    for (const block of blocks) if (typeof block?.text === "string" && block.text.length > 0) texts.push(block.text);
    if (texts.length > 0) return texts.join("\n");
  }
  if (typeof output.text === "string") return output.text;
  if (typeof output.summary === "string") return output.summary;
  return undefined;
}

/**
 * Replace the first text block of a summarizer result with merged text,
 * preserving every other field and the exact original shape.
 */
export function withMergedText(template, text) {
  if (template === undefined || template === null) return undefined;
  const clone = shallowClone(template);
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
