/**
 * Compaction doctor probe.
 *
 * Discovers the real capability of the routed upstream, publishes it as the
 * `compactionDoctor` service (so the engine can use it before any config write
 * lands), and — when `writeConfig` is enabled — writes the discovered
 * `contextWindow` / `maxTokens` back into the profile patch so every consumer
 * (threshold math, retention, request routing) sees the same numbers.
 *
 * Everything is observable from the outside: accepted prompts are read from
 * durable session usage, the provider catalog is read from the adapter and/or
 * a single `GET /models`, and the config write is backed by a byte-for-byte
 * backup plus a diff. The active boundary probe (real requests, real cost) is
 * off by default and requires a second opt-in flag.
 *
 * @module @local/dsh-compaction-doctor/probe
 */

import { readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Service } from "@deepseek-ai/cordis";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";

import { DOCTOR_DEFAULTS } from "./engine.js";
import { computeNumbers, DEFAULT_RETAIN_RATIO, DEFAULT_THRESHOLD_RATIO } from "./plan.js";
import { byteSize, info, latestRoute, num, readContextWindow, surfaceSeqs, warn } from "./util.js";

export const COMMAND_NAME = "compact-doctor";
export const COMMAND_ID = "@local/dsh-compaction-doctor";
const MAX_TOKENS_CAP = 131072;
const CEILING_SAFETY = 0.98;

/** Normalize the row config into a stable object. */
export function normalizeConfig(config = {}) {
  const out = { ...DOCTOR_DEFAULTS, ...(config ?? {}) };
  out.enabled = out.enabled !== false;
  out.writeConfig = out.writeConfig === true;
  out.activeProbe = out.activeProbe === true;
  out.activeProbeConfirm = out.activeProbeConfirm === true;
  out.probeOnStart = out.probeOnStart !== false;
  out.tokensPerByte = num(out.tokensPerByte, 0.34) || 0.34;
  out.maxSummaryChunks = Math.max(1, Math.min(num(out.maxSummaryChunks, 8) || 8, 24));
  out.capMaxTokens = Math.max(1024, num(out.capMaxTokens, 65536) || 65536);
  out.providerEntryId = typeof out.providerEntryId === "string" ? out.providerEntryId : "llm-pi-ai";
  out.apiKeyEnv = typeof out.apiKeyEnv === "string" ? out.apiKeyEnv : "HUAIYUAN_API_KEY";
  out.baseURL = typeof out.baseURL === "string" ? out.baseURL : undefined;
  return out;
}

// ---------------------------------------------------------------------------
// observation: what the harness already proved by using the route
// ---------------------------------------------------------------------------

/**
 * Read the empirical prompt bracket out of durable session events.
 *
 * `assistant/message.usage.inputTokens + cacheReadTokens` is the prompt the
 * provider actually accepted. A `request/context` window that is smaller than
 * an accepted prompt is a direct contradiction: the configured window is wrong.
 */
export function readObservedBracket(session) {
  const out = { maxAcceptedPrompt: 0, maxAcceptedSeq: undefined, windowsSeen: [], attempts: 0, failures: 0, model: undefined };
  if (session?.eventAt === undefined) return out;
  const seqs = surfaceSeqs(session);
  const windows = new Map();
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    const data = event.data ?? {};
    if (event.type === "request/context") {
      windows.set(num(data.contextWindow, 0), { provider: data.provider, model: data.model });
      continue;
    }
    if (event.type === "assistant/attempt") {
      out.attempts += 1;
      if (typeof data.model === "string") out.model = data.model;
      if (data.failure !== undefined && data.failure !== null) out.failures += 1;
      continue;
    }
    if (event.type !== "assistant/message") continue;
    const usage = data.usage;
    if (usage === undefined || usage === null) continue;
    const prompt = num(usage.inputTokens, 0) + num(usage.cacheReadTokens, 0);
    if (prompt > out.maxAcceptedPrompt) {
      out.maxAcceptedPrompt = prompt;
      out.maxAcceptedSeq = seq;
    }
  }
  out.windowsSeen = [...windows.entries()].map(([contextWindow, meta]) => ({ contextWindow, ...meta }));
  return out;
}

// ---------------------------------------------------------------------------
// discovery: adapter catalog + gateway catalog
// ---------------------------------------------------------------------------

function pickModelEntry(payload, model) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : undefined;
  if (list === undefined) return undefined;
  for (const entry of list) {
    const id = entry?.id ?? entry?.model ?? entry?.name ?? entry?.slug;
    if (typeof id === "string" && id === model) return entry;
  }
  return list.length === 1 ? list[0] : undefined;
}

/** Adapter-side catalog, when the adapter exposes one. */
export async function discoverViaAdapter(ctx, route, providerEntryId, signal) {
  const llm = ctx?.get?.("llm");
  if (llm === undefined || llm === null || route === undefined) return undefined;
  const attempts = [];
  if (typeof llm.listModels === "function") {
    try {
      const payload = await llm.listModels(route.provider, signal);
      const entry = pickModelEntry(payload, route.model);
      const window = readContextWindow(entry);
      if (window !== undefined) return { source: "llm.listModels", contextWindow: window, maxOutput: readMaxOutput(entry), model: route.model };
      attempts.push("listModels: no window in payload");
    } catch (error) {
      attempts.push(`listModels: ${error?.message ?? error}`);
    }
  }
  if (typeof llm.discoverModels === "function") {
    for (const namespace of [providerEntryId, "llm-pi-ai", "llm"]) {
      if (typeof namespace !== "string" || namespace.length === 0) continue;
      try {
        const payload = await llm.discoverModels(namespace, { provider: route.provider, model: route.model }, signal);
        const entry = pickModelEntry(payload, route.model);
        const window = readContextWindow(entry);
        if (window !== undefined) return { source: `llm.discoverModels(${namespace})`, contextWindow: window, maxOutput: readMaxOutput(entry), model: route.model };
        attempts.push(`discoverModels(${namespace}): no window in payload`);
      } catch (error) {
        attempts.push(`discoverModels(${namespace}): ${error?.message ?? error}`);
      }
    }
  }
  return attempts.length === 0 ? undefined : { source: "adapter", attempts };
}

function readMaxOutput(entry) {
  if (entry === null || typeof entry !== "object") return undefined;
  const candidates = [
    entry.maxTokens,
    entry.maxOutputTokens,
    entry.max_tokens,
    entry.max_output_tokens,
    entry.max_completion_tokens,
    entry.top_provider?.max_completion_tokens,
  ];
  for (const candidate of candidates) {
    const value = num(candidate, 0);
    if (value > 0) return value;
  }
  return undefined;
}

/** One `GET {baseURL}/models`, used when the gateway publishes a catalog. */
export async function probeModelsEndpoint({ baseURL, apiKey, model, signal, timeoutMs = 8000 }) {
  if (typeof baseURL !== "string" || baseURL.length === 0) return undefined;
  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signals = [controller.signal];
  if (signal !== undefined && signal !== null) signals.push(signal);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    });
    if (!response.ok) return { source: "GET /models", url, status: response.status, error: `HTTP ${response.status}` };
    const payload = await response.json();
    const entry = pickModelEntry(payload, model);
    const window = readContextWindow(entry);
    const list = Array.isArray(payload?.data) ? payload.data.length : Array.isArray(payload?.models) ? payload.models.length : undefined;
    return { source: "GET /models", url, status: response.status, entries: list, contextWindow: window, maxOutput: readMaxOutput(entry), raw: entry };
  } catch (error) {
    return { source: "GET /models", url, error: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opt-in active boundary probe: two real requests that bracket the ceiling.
 * Costs real tokens on the caller's account, therefore double-gated.
 */
export async function activeBoundaryProbe({ baseURL, apiKey, model, tokensPerByte, seedTokens, signal, maxRequests = 2 }) {
  if (typeof baseURL !== "string" || typeof model !== "string") return undefined;
  const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  const requests = [];
  let low = Math.max(1024, num(seedTokens, 262144));
  let high;
  for (let index = 0; index < maxRequests; index += 1) {
    const target = Math.floor(low);
    const filler = "probe ".repeat(Math.max(1, Math.ceil(target / tokensPerByte / 6)));
    const body = { model, max_tokens: 1, stream: false, messages: [{ role: "user", content: filler }] };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal,
      });
      const text = await response.text();
      requests.push({ target, status: response.status, ok: response.ok, body: text.slice(0, 400) });
      if (response.ok) {
        low = target;
        if (high !== undefined) break;
        low = Math.floor(target * 1.6);
      } else {
        high = target;
        low = Math.floor(target / 2);
      }
    } catch (error) {
      requests.push({ target, error: error?.message ?? String(error) });
      break;
    }
  }
  const accepted = requests.filter((entry) => entry.ok === true).map((entry) => entry.target);
  const rejected = requests.filter((entry) => entry.ok === false && entry.status !== undefined).map((entry) => entry.target);
  return {
    source: "active probe",
    requests,
    maxAccepted: accepted.length > 0 ? Math.max(...accepted) : undefined,
    minRejected: rejected.length > 0 ? Math.min(...rejected) : undefined,
  };
}

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

/** Combine every observation into one window decision. */
export function reconcileWindow({ configured, observed, adapter, gateway, active, capMaxTokens }) {
  const candidates = [];
  const push = (source, value, note) => {
    const window = num(value, 0);
    if (window > 0) candidates.push({ source, contextWindow: window, note });
  };
  push("configured", configured?.contextWindow, "profile value");
  if (active !== undefined) {
    push("active probe", active.maxAccepted, "largest accepted synthetic prompt");
    if (num(active.minRejected, 0) > 0) push("active probe", Math.floor(active.minRejected * CEILING_SAFETY), "below the smallest rejected prompt");
  }
  if (num(observed?.maxAcceptedPrompt, 0) > 0) push("observed usage", observed.maxAcceptedPrompt, `accepted prompt at surface seq ${observed.maxAcceptedSeq ?? "?"}`);
  push("adapter catalog", adapter?.contextWindow, adapter?.source);
  push("gateway catalog", gateway?.contextWindow, gateway?.source);
  const fromTraffic = num(observed?.maxAcceptedPrompt, 0);
  const configuredWindow = num(configured?.contextWindow, 0);
  const configuredOutput = num(configured?.maxOutput, 0);
  // Hard evidence: traffic the provider already accepted cannot fit the
  // configured window at all, so the configured window is simply wrong.
  const contradiction = fromTraffic > 0 && configuredWindow > 0 && fromTraffic > configuredWindow;
  // Soft evidence: the window fits, but the completion reserve is not enforced
  // upstream — useful, yet not proof that the window itself is mistyped.
  const reserveContradiction =
    contradiction === false && fromTraffic > 0 && configuredWindow > 0 && fromTraffic > configuredWindow - configuredOutput;
  const ceiling = fromTraffic > 0 ? Math.max(fromTraffic, configuredWindow) : configuredWindow;
  const chosen = Math.max(...candidates.map((candidate) => candidate.contextWindow), 0);
  const winner = candidates.find((candidate) => candidate.contextWindow === chosen);
  const contextWindow = chosen > 0 ? chosen : configuredWindow;
  // The completion reserve is only a safety heuristic. A deliberate, smaller
  // configured reserve is preserved unless the traffic proves the whole row is
  // mistyped — using 25% of the window there would silently steal prompt budget.
  const cap = Math.min(Math.max(1024, num(capMaxTokens, 65536) || 65536), MAX_TOKENS_CAP);
  const heuristicReserve = Math.min(cap, Math.max(1024, Math.floor(contextWindow * 0.25)));
  const declaredReserve = Math.max(1024, configuredOutput);
  const maxOutput =
    contradiction === false && configuredOutput > 0 ? Math.min(declaredReserve, cap) : heuristicReserve;
  return {
    contextWindow,
    maxOutput,
    candidates,
    winner,
    ceiling,
    contradiction,
    reserveContradiction,
    configuredWindow,
    observedMaxAccepted: fromTraffic,
    rationale: contradiction
      ? `accepted traffic (${fromTraffic} tokens) already exceeds the configured window (${configuredWindow}) — the configured window is wrong`
      : reserveContradiction
        ? `window ${configuredWindow} fits the accepted traffic (${fromTraffic} tokens), but the completion reserve of ${configuredOutput} is not enforced upstream`
        : winner === undefined
          ? "no candidate exceeded the configured window"
          : `${winner.source}: ${winner.contextWindow} tokens (${winner.note ?? "no note"})`,
  };
}

// ---------------------------------------------------------------------------
// profile patch read/write
// ---------------------------------------------------------------------------

/** Locate candidate `<profile>/cordis.patch.yml` files for a provider entry. */
export function candidateProfilePatches(providerEntryId) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
  const root = join(home, "profiles");
  const found = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory() === false) continue;
    const file = join(root, entry.name, "cordis.patch.yml");
    if (existsSync(file) === false) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    found.push({ file, profile: entry.name, text, mentionsProvider: text.includes(`id: ${providerEntryId}`) || text.includes(`id: "${providerEntryId}"`) });
  }
  return found;
}

/** Extract a provider block's transport settings from the patch text. */
export function readProviderSetup(text, provider) {
  const lines = text.split(/\r?\n/);
  const start = findLine(lines, (line) => new RegExp(`^\\s*${escapeRegExp(provider)}\\s*:\\s*$`).test(line));
  if (start < 0) return {};
  const indent = indentOf(lines[start]);
  const block = collectBlock(lines, start + 1, indent);
  const read = (key) => {
    for (const line of block) {
      const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`).exec(line);
      if (match !== null) return match[1].replace(/^["']|["']$/g, "");
    }
    return undefined;
  };
  return { baseURL: read("baseURL"), apiKeyEnv: read("apiKeyEnv"), api: read("api") };
}

/**
 * Rewrite `contextWindow` / `maxTokens` for one model inside one provider
 * entry, preserving every other byte of the file (including comments and
 * unrelated rows). Returns `{ text, changed, reason }`.
 */
export function rewriteModelWindow(text, { providerEntryId, provider, model, contextWindow, maxTokens }) {
  const lines = text.split("\n");
  const rowIndex = findLine(lines, (line) => new RegExp(`^\\s*-\\s*id\\s*:\\s*["']?${escapeRegExp(providerEntryId)}["']?\\s*$`).test(line.replace(/\r$/, "")));
  if (rowIndex < 0) return { text, changed: false, reason: `provider entry ${providerEntryId} not found` };
  const rowIndent = indentOf(lines[rowIndex]);
  const rowEnd = endOfBlock(lines, rowIndex + 1, rowIndent);
  if (typeof provider === "string" && provider.length > 0) {
    const providerIndex = findLine(lines, (line) => new RegExp(`^\\s*${escapeRegExp(provider)}\\s*:\\s*$`).test(line.replace(/\r$/, "")), rowIndex + 1, rowEnd);
    if (providerIndex < 0) return { text, changed: false, reason: `provider ${provider} not found in entry ${providerEntryId}` };
    const providerEnd = endOfBlock(lines, providerIndex + 1, indentOf(lines[providerIndex]));
    const result = rewriteModelEntry(lines, providerIndex + 1, providerEnd, model, contextWindow, maxTokens);
    return result.changed ? { ...result, text: lines.join("\n") } : result;
  }
  const result = rewriteModelEntry(lines, rowIndex + 1, rowEnd, model, contextWindow, maxTokens);
  return result.changed ? { ...result, text: lines.join("\n") } : result;
}

function rewriteModelEntry(lines, from, to, model, contextWindow, maxTokens) {
  const entryIndex = findLine(
    lines,
    (line) => new RegExp(`^\\s*-\\s*id\\s*:\\s*["']?${escapeRegExp(model)}["']?\\s*$`).test(line.replace(/\r$/, "")),
    from,
    to,
  );
  if (entryIndex < 0) return { changed: false, reason: `model ${model} not found` };
  const entryEnd = endOfBlock(lines, entryIndex + 1, indentOf(lines[entryIndex]) - 2);
  const notes = [];
  let changed = false;
  const apply = (key, value) => {
    if (value === undefined || value === null) return;
    const index = findLine(lines, (line) => new RegExp(`^\\s*${key}\\s*:`).test(line), entryIndex + 1, entryEnd);
    if (index >= 0) {
      const current = lines[index].replace(/\r$/, "").replace(/^(\s*)[^:]+:\s*(.*)$/, "$2").trim();
      if (current === String(value)) {
        notes.push(`${key} already ${value}`);
        return;
      }
      lines[index] = lines[index].replace(new RegExp(`^(\\s*)${key}\\s*:.*$`), `$1${key}: ${value}`);
      notes.push(`${key} ${current} -> ${value}`);
      changed = true;
      return;
    }
    const sibling = findLine(lines, (line) => new RegExp(`^\\s*[A-Za-z_][\\w.-]*\\s*:`).test(line), entryIndex + 1, entryEnd);
    const pad = sibling >= 0 ? " ".repeat(indentOf(lines[sibling])) : " ".repeat(indentOf(lines[entryIndex]) + 2);
    lines.splice(entryIndex + 1, 0, `${pad}${key}: ${value}`);
    notes.push(`${key} inserted as ${value}`);
    changed = true;
  };
  apply("contextWindow", contextWindow);
  apply("maxTokens", maxTokens);
  return { changed, reason: notes.join("; ") };
}

function indentOf(line) {
  const match = /^(\s*)/.exec(line ?? "");
  return match === null ? 0 : match[1].length;
}

function endOfBlock(lines, from, indent) {
  let index = from;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (indentOf(line) <= indent) break;
    index += 1;
  }
  return index;
}

function collectBlock(lines, from, indent) {
  return lines.slice(from, endOfBlock(lines, from, indent));
}

function findLine(lines, predicate, from = 0, to = lines.length) {
  for (let index = from; index < to; index += 1) if (predicate(lines[index])) return index;
  return -1;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Back up, rewrite, verify. Never leaves a partially written file. */
export function writeProfilePatch(file, text, nextText, tag = "compaction-doctor") {
  const backup = `${file}.bak-${tag}-${Date.now()}`;
  try {
    writeFileSync(backup, text, "utf8");
  } catch (error) {
    return { ok: false, reason: `backup failed: ${error?.message ?? error}` };
  }
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, nextText, "utf8");
    renameSync(temporary, file);
  } catch (error) {
    return { ok: false, reason: `atomic write failed: ${error?.message ?? error}`, backup };
  }
  let verify;
  try {
    verify = readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, reason: `verify read failed: ${error?.message ?? error}`, backup };
  }
  if (verify !== nextText) return { ok: false, reason: "verification mismatch after write", backup };
  return { ok: true, backup, bytes: byteSize(verify), mtime: statSync(file).mtimeMs };
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class CompactionDoctor extends Service {
  static inject = ["llm", "sessions"];

  constructor(ctx, config = {}) {
    super(ctx, "compactionDoctor");
    this.config = normalizeConfig(config);
    this.resolved = undefined;
    this.lastReport = undefined;
    this.commandRegistered = false;
    this._lateHookInstalled = false;
    try {
      this._registerCommand();
      this._installLateHook();
      if (this.config.probeOnStart === true) this._probeSoon();
      info(
        ctx,
        `loaded (enabled=${this.config.enabled}, writeConfig=${this.config.writeConfig}, scaleMode=${this.config.scaleMode}, providerEntryId=${this.config.providerEntryId})`,
      );
    } catch (error) {
      warn(ctx, `constructor failed: ${error?.message ?? error}`);
    }
  }

  /** Run the probe for one session (or the newest known session). */
  async run({ agent, session, signal, write } = {}) {
    const target = session ?? agent?.session ?? this._newestSession();
    const route = latestRoute(target, { provider: this.config.provider, model: this.config.model });
    const configured = {
      provider: route?.provider,
      model: route?.model,
      contextWindow: route?.contextWindow ?? this.config.fallbackContextWindow,
      maxOutput: this.config.capMaxTokens,
    };
    const observed = readObservedBracket(target);
    const setup = this._providerSetup(route?.provider);
    const apiKey = this._apiKey(setup);
    const baseURL = this.config.baseURL ?? setup.baseURL;
    const adapter = await discoverViaAdapter(this.ctx, route, this.config.providerEntryId, signal);
    const gateway = await probeModelsEndpoint({ baseURL, apiKey, model: route?.model, signal });
    let active;
    if (this.config.activeProbe === true && this.config.activeProbeConfirm === true) {
      active = await activeBoundaryProbe({
        baseURL,
        apiKey,
        model: route?.model,
        tokensPerByte: this.config.tokensPerByte,
        seedTokens: Math.max(num(observed.maxAcceptedPrompt, 0), num(configured.contextWindow, 0), 262144),
        signal,
      });
    }
    const decision = reconcileWindow({ configured, observed, adapter, gateway, active, capMaxTokens: this.config.capMaxTokens });
    this.resolved = {
      provider: route?.provider,
      model: route?.model,
      contextWindow: decision.contextWindow,
      maxOutput: decision.maxOutput,
      source: decision.winner?.source ?? "configured",
      at: new Date().toISOString(),
    };
    const report = { at: new Date().toISOString(), route, configured, observed, decision, adapter, gateway, active, written: undefined };
    if (write === true && this.config.writeConfig === true && route?.model) {
      report.written = await this._writeBack({ route, decision });
    } else if (write === true) {
      report.written = { ok: false, reason: "writeConfig is disabled in the bundle config" };
    }
    report.engine = this._engineDiagnostics();
    report.numbers = this._numbers();
    this.lastReport = report;
    return report;
  }

  _newestSession() {
    try {
      const sessions = this.ctx.get("sessions");
      const active = sessions?.active?.();
      if (active !== undefined && active !== null) return active;
      const listed = sessions?.list?.();
      if (Array.isArray(listed) && listed.length > 0) return listed[listed.length - 1]?.session ?? listed[listed.length - 1];
    } catch {
      /* ignore */
    }
    return undefined;
  }

  _engineDiagnostics() {
    try {
      const compaction = this.ctx.get("compaction");
      if (typeof compaction?.diagnostics === "function") return compaction.diagnostics();
      return { mounted: compaction !== undefined && compaction !== null, diagnostics: "unavailable" };
    } catch {
      return { mounted: false };
    }
  }

  /** Effective compaction policy: the live engine's row config wins. */
  _policy() {
    let engine;
    try {
      engine = this.ctx.get("compaction");
    } catch {
      engine = undefined;
    }
    const engineConfig = engine?.config;
    const merged = { ...this.config, ...(engineConfig !== null && typeof engineConfig === "object" ? engineConfig : {}) };
    return merged;
  }

  _numbers() {
    const route = latestRoute(this._newestSession(), { provider: this.config.provider, model: this.config.model });
    const policy = this._policy();
    const window = this.resolved?.contextWindow ?? route?.contextWindow ?? policy.fallbackContextWindow;
    if (num(window, 0) <= 0) return undefined;
    const numbers = computeNumbers({
      contextWindow: window,
      maxOutput: this.resolved?.maxOutput ?? num(policy.maxTokens, 65536),
      headroom: policy.headroomTokens,
      thresholdRatio: num(policy.thresholdRatio, DEFAULT_THRESHOLD_RATIO) || DEFAULT_THRESHOLD_RATIO,
      retainRatio: policy.retainTokens === undefined ? num(policy.retainRatio, DEFAULT_RETAIN_RATIO) || DEFAULT_RETAIN_RATIO : undefined,
      retainTokens: policy.retainTokens,
      summaryBudgetRatio: policy.summaryBudgetRatio,
    });
    return { ...numbers, source: this.resolved?.source, at: this.resolved?.at };
  }

  _providerSetup(provider) {
    if (typeof provider !== "string") return {};
    const candidates = candidateProfilePatches(this.config.providerEntryId).filter((candidate) => candidate.mentionsProvider);
    for (const candidate of candidates) {
      const setup = readProviderSetup(candidate.text, provider);
      if (setup.baseURL !== undefined || setup.apiKeyEnv !== undefined) return { ...setup, file: candidate.file };
    }
    return {};
  }

  _apiKey(setup) {
    const names = [this.config.apiKeyEnv, setup?.apiKeyEnv].filter((name) => typeof name === "string" && name.length > 0);
    for (const name of names) {
      const value = process.env[name];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  }

  async _writeBack({ route, decision }) {
    const contextWindow = Math.floor(decision.contextWindow);
    const maxTokens = Math.floor(decision.maxOutput);
    const attempt = { providerEntryId: this.config.providerEntryId, provider: route.provider, model: route.model, contextWindow, maxTokens, routes: [] };
    const editor = this._configEditor();
    if (editor !== undefined) {
      try {
        const entries = await editor.entries();
        const entry = Array.isArray(entries) ? entries.find((item) => (item?.id ?? item?.options?.id) === this.config.providerEntryId) : undefined;
        if (entry === undefined) {
          attempt.routes.push({ route: "configEditor", ok: false, reason: `entry ${this.config.providerEntryId} not exposed` });
        } else {
          const result = await editor.edit(entry, (current) => patchConfigModel(current, route.provider, route.model, { contextWindow, maxTokens }));
          attempt.routes.push({ route: "configEditor", ok: true, result: summarizeEditResult(result) });
          return { ...attempt, ok: true, used: "configEditor" };
        }
      } catch (error) {
        attempt.routes.push({ route: "configEditor", ok: false, reason: error?.message ?? String(error) });
      }
    } else {
      attempt.routes.push({ route: "configEditor", ok: false, reason: "service unavailable" });
    }
    for (const candidate of candidateProfilePatches(this.config.providerEntryId)) {
      if (candidate.mentionsProvider === false) {
        attempt.routes.push({ route: "file", file: candidate.file, ok: false, reason: "entry not present" });
        continue;
      }
      const rewritten = rewriteModelWindow(candidate.text, {
        providerEntryId: this.config.providerEntryId,
        provider: route.provider,
        model: route.model,
        contextWindow,
        maxTokens,
      });
      if (rewritten.changed === false) {
        attempt.routes.push({ route: "file", file: candidate.file, ok: false, reason: rewritten.reason });
        continue;
      }
      const written = writeProfilePatch(candidate.file, candidate.text, rewritten.text);
      attempt.routes.push({ route: "file", file: candidate.file, ok: written.ok, reason: written.reason ?? rewritten.reason, backup: written.backup });
      if (written.ok) return { ...attempt, ok: true, used: "file", ...written, changes: rewritten.reason };
    }
    return { ...attempt, ok: false, used: undefined, snippet: snippetFor(this.config.providerEntryId, route, contextWindow, maxTokens) };
  }

  _configEditor() {
    try {
      const editor = this.ctx.get("configEditor");
      if (editor !== undefined && editor !== null && typeof editor.edit === "function") return editor;
    } catch {
      /* ignore */
    }
    return undefined;
  }

  _registerCommand() {
    if (this.commandRegistered) return true;
    let commands;
    try {
      commands = this.ctx.get("commands");
    } catch {
      commands = undefined;
    }
    if (commands === undefined || commands === null || typeof commands.register !== "function") return false;
    const registration = {
      definitionId: CommandDefinitionId(COMMAND_ID),
      name: COMMAND_NAME,
      description: "Report and repair the routed context window and compaction budgets",
      handler: (invocation) => this._commandHandler(invocation),
    };
    try {
      this.ctx.effect(function* () {
        yield () => {
          /* command lifetime is owned by the context */
        };
        yield commands.register(registration);
      }, "compaction-doctor command");
      this.commandRegistered = true;
      return true;
    } catch {
      /* fall back to a direct registration */
    }
    try {
      commands.register(registration);
      this.commandRegistered = true;
      return true;
    } catch (error) {
      warn(this.ctx, `command registration failed: ${error?.message ?? error}`);
      return false;
    }
  }

  _installLateHook() {
    if (this._lateHookInstalled) return;
    this._lateHookInstalled = true;
    this.ctx.on("agent/pre-step", () => {
      if (this.commandRegistered === false) this._registerCommand();
    });
  }

  _probeSoon() {
    const timer = setTimeout(() => {
      this.run({ write: false }).catch((error) => warn(this.ctx, `startup probe failed: ${error?.message ?? error}`));
    }, 1500);
    if (typeof timer?.unref === "function") timer.unref();
  }

  async _commandHandler(invocation) {
    try {
      const report = await this.run({ agent: invocation?.agent, signal: invocation?.signal, write: true });
      return { kind: "success", text: formatReport(report) };
    } catch (error) {
      return { kind: "error", text: `compaction-doctor: ${error?.message ?? String(error)}` };
    }
  }
}

// ---------------------------------------------------------------------------
// config-editor path helpers
// ---------------------------------------------------------------------------

/** Pure: return a copy of the whole config with one model's window replaced. */
export function patchConfigModel(current, provider, model, { contextWindow, maxTokens }) {
  const clone = deepClone(current);
  const providerConfig = clone?.providers?.[provider];
  if (providerConfig === undefined) throw new Error(`provider ${provider} is not present in this configuration`);
  const models = providerConfig.models;
  if (Array.isArray(models)) {
    const entry = models.find((item) => (item?.id ?? item?.model) === model);
    if (entry === undefined) throw new Error(`model ${model} is not present in provider ${provider}`);
    entry.contextWindow = contextWindow;
    entry.maxTokens = maxTokens;
    return clone;
  }
  if (models !== null && typeof models === "object") {
    if (models[model] === undefined) throw new Error(`model ${model} is not present in provider ${provider}`);
    const entry = typeof models[model] === "object" ? models[model] : (models[model] = {});
    entry.contextWindow = contextWindow;
    entry.maxTokens = maxTokens;
    return clone;
  }
  throw new Error(`provider ${provider} has no model table`);
}

function deepClone(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 24) return value;
  if (Array.isArray(value)) return value.map((item) => deepClone(item, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) out[key] = deepClone(value[key], depth + 1);
  return out;
}

function summarizeEditResult(result) {
  if (result === undefined || result === null) return undefined;
  if (typeof result !== "object") return String(result);
  const keys = Object.keys(result).slice(0, 6);
  return keys.length === 0 ? "ok" : keys.join(",");
}

function snippetFor(providerEntryId, route, contextWindow, maxTokens) {
  return [
    `# ${providerEntryId} -> providers.${route?.provider}.models[${route?.model}]`,
    `contextWindow: ${contextWindow}`,
    `maxTokens: ${maxTokens}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const nf = new Intl.NumberFormat("en-US");
const fmt = (value) => (Number.isFinite(num(value, NaN)) ? nf.format(num(value, 0)) : String(value));

/** Human-readable report for the `/compact-doctor` command. */
export function formatReport(report) {
  const lines = [];
  lines.push("compaction-doctor");
  lines.push(`  route        ${report.route?.provider ?? "?"}/${report.route?.model ?? "?"} (${report.route?.source ?? "unknown"})`);
  lines.push(`  configured   contextWindow=${fmt(report.configured?.contextWindow)} maxTokens=${fmt(report.configured?.maxOutput)}`);
  const observed = report.observed ?? {};
  lines.push(`  observed     maxAcceptedPrompt=${fmt(observed.maxAcceptedPrompt)} windowsSeen=${JSON.stringify((observed.windowsSeen ?? []).map((w) => w.contextWindow))}`);
  lines.push(`  attempts     ${fmt(observed.attempts)} (failed ${fmt(observed.failures)})`);
  if (report.adapter !== undefined) lines.push(`  adapter      ${report.adapter.source}${report.adapter.contextWindow === undefined ? ` (${(report.adapter.attempts ?? []).join(" | ")})` : ` -> ${fmt(report.adapter.contextWindow)}`}`);
  if (report.gateway !== undefined) lines.push(`  gateway      ${report.gateway.source} ${report.gateway.error ?? `-> ${fmt(report.gateway.contextWindow)} entries=${report.gateway.entries ?? "?"}`}`);
  if (report.active !== undefined) lines.push(`  activeProbe  accepted=${fmt(report.active.maxAccepted)} rejected=${fmt(report.active.minRejected)}`);
  const decision = report.decision ?? {};
  lines.push(`  candidates   ${(decision.candidates ?? []).map((candidate) => `${candidate.source}=${fmt(candidate.contextWindow)}`).join(", ") || "none"}`);
  lines.push(`  verdict      contextWindow=${fmt(decision.contextWindow)} maxTokens=${fmt(decision.maxOutput)} (${decision.rationale ?? "?"})`);
  if (decision.contradiction === true) lines.push("  contradiction the configured window cannot fit traffic the provider already accepted");
  else if (decision.reserveContradiction === true) lines.push("  reserve      the window fits, but the completion reserve is not enforced upstream");
  if (report.written !== undefined) {
    const written = report.written;
    lines.push(`  write        ${written.ok === true ? `ok via ${written.used}` : `not applied (${written.reason ?? "unknown"})`}`);
    if (written.backup !== undefined) lines.push(`  backup       ${written.backup}`);
    if (written.changes !== undefined) lines.push(`  changes      ${written.changes}`);
    if (written.ok !== true && written.snippet !== undefined) lines.push(`  manual       ${written.snippet.replace(/\n/g, " | ")}`);
    for (const route of written.routes ?? []) {
      if (route.ok === false) lines.push(`  tried        ${route.route}${route.file === undefined ? "" : ` ${route.file}`}: ${route.reason}`);
    }
  }
  const numbers = report.numbers;
  if (numbers !== undefined) {
    lines.push(`  budgets      threshold=${fmt(numbers.threshold)} retain=${fmt(numbers.retainReal)} messageBudget=${fmt(numbers.messageBudget)} summaryBudget=${fmt(numbers.summaryBudget)}`);
  }
  const stats = report.engine?.stats;
  if (stats !== undefined) {
    lines.push(
      `  engine       scaleMode=${report.engine.scaleMode} meterPatched=${stats.meterPatched} summarize=${fmt(stats.summarizeCalls)} chunked=${fmt(stats.chunkedRegions)} classified=${fmt(stats.classifications)} retries=${fmt(stats.classificationRetries)}`,
    );
    if (num(stats.lastScale, 1) !== 1) lines.push(`  scale        k=${num(stats.lastScale, 1).toFixed(3)}`);
    for (const note of stats.notes ?? []) lines.push(`  note         ${note}`);
  }
  return lines.join("\n");
}

export { CompactionDoctor as default };
