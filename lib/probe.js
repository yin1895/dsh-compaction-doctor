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

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";

import { DOCTOR_DEFAULTS } from "./engine.js";
import { computeNumbers, DEFAULT_RETAIN_RATIO, DEFAULT_THRESHOLD_RATIO } from "./plan.js";
import { installStatusRoute, setRowConfigKeys } from "./status.js";
import { byteSize, info, latestRoute, num, readContextWindow, surfaceSeqs, warn } from "./util.js";

export const COMMAND_NAME = "compact-doctor";
export const COMMAND_ID = "@local/dsh-compaction-doctor";
/** Kept in step with `package.json`; surfaced on the settings page. */
export const VERSION = "0.4.1";
/** Prefix route the settings page talks to; see `docs/api-contract.md`. */
export const ROUTE_PREFIX = "/dsh-compaction-doctor";
/** Custom header every request must carry: blocks cross-site simple requests. */
export const ROUTE_GUARD_HEADER = "x-compaction-doctor";
export const BACKUP_TAG = "compaction-doctor";
/** Doctor-owned keys the settings page may write through `PUT /config`. */
export const ENGINE_ROW_KEYS = [
  "auto",
  "thresholdRatio",
  "headroomTokens",
  "retainRatio",
  "retainTokens",
  "maxTokens",
  "compactionRetries",
  "maxOverflowRetries",
];
const MAX_TOKENS_CAP = 131072;
const CEILING_SAFETY = 0.98;
const MAX_BACKUPS = 50;

/** Normalize the row config into a stable object. */
export function normalizeConfig(config = {}) {
  const out = { ...DOCTOR_DEFAULTS, ...(config ?? {}) };
  // The single user-facing switch. Off means the plugin is completely inert:
  // no probing, no writing, and the shipped compaction behavior is untouched.
  out.enabled = out.enabled === true;
  // Not exposed in the UI: whether the lazy pass may correct a value by itself.
  out.autoRepair = out.autoRepair !== false;
  out.writeConfig = out.writeConfig === true;
  out.activeProbe = out.activeProbe === true;
  out.activeProbeConfirm = out.activeProbeConfirm === true;
  // Ignored since v0.4: there is no startup sweep any more. Kept so an older
  // profile patch that still sets it does not become an unknown key.
  out.probeOnStart = false;
  out.tokensPerByte = num(out.tokensPerByte, 0.34) || 0.34;
  out.maxSummaryChunks = Math.max(1, Math.min(num(out.maxSummaryChunks, 8) || 8, 24));
  out.capMaxTokens = Math.max(1024, num(out.capMaxTokens, 65536) || 65536);
  out.providerEntryId = typeof out.providerEntryId === "string" ? out.providerEntryId : "llm-pi-ai";
  out.engineEntryId = typeof out.engineEntryId === "string" ? out.engineEntryId : "compaction-doctor-engine";
  out.apiKeyEnv = typeof out.apiKeyEnv === "string" ? out.apiKeyEnv : "HUAIYUAN_API_KEY";
  out.baseURL = typeof out.baseURL === "string" ? out.baseURL : undefined;
  return out;
}

/**
 * Where the settings switch lives.
 *
 * Deliberately NOT a profile patch row: the doctor's row is inserted by the
 * bundle's own patch, so a profile row with the same id would have to re-assert
 * `name` and would replace the row's WHOLE config (a patch never merges). A
 * plugin-owned file has none of those constraints, takes effect in memory
 * immediately, and cannot be undone by a stale hot reload.
 */
export function switchStateFile() {
  return join(profileDir(), "compaction-doctor.state.json");
}

/** The persisted switch value, or undefined when nothing usable is on disk. */
export function readSwitchState(file = switchStateFile()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    return typeof parsed.enabled === "boolean" ? parsed.enabled : undefined;
  } catch {
    return undefined;
  }
}

/** Atomically persist the switch value. Never throws. */
export function writeSwitchState(enabled, file = switchStateFile()) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ enabled, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: error?.message ?? String(error), file };
  }
}

// ---------------------------------------------------------------------------
// profile files: backups, restore, and the active profile directory
// ---------------------------------------------------------------------------

/** The active profile directory: `$DSH_HOME/profiles/$DSH_PROFILE` (`desktop` by default). */
export function profileDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
  const name = process.env.DSH_PROFILE && process.env.DSH_PROFILE.length > 0 ? process.env.DSH_PROFILE : "desktop";
  return join(home, "profiles", name);
}

/** Whether a path names a `cordis.patch.yml` backup inside `dir` (no traversal). */
export function isBackupInside(dir, file) {
  const target = join(dir, basename(file));
  if (basename(target).startsWith("cordis.patch.yml.bak") === false) return false;
  return existsSync(target);
}

/** Every `cordis.patch.yml*` backup in the profile directory, newest first. */
export function listPatchBackups(dir = profileDir(), limit = MAX_BACKUPS) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (entry.isFile() === false) continue;
    if (entry.name.startsWith("cordis.patch.yml.bak") === false) continue;
    const file = join(dir, entry.name);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const match = /^cordis\.patch\.yml\.bak-(.+?)-(\d{10,})$/u.exec(entry.name);
    found.push({
      file,
      name: entry.name,
      at: new Date(stat.mtimeMs).toISOString(),
      bytes: stat.size,
      tag: match === null ? "unknown" : match[1],
      mine: entry.name.startsWith(`cordis.patch.yml.bak-${BACKUP_TAG}-`),
    });
  }
  found.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
  return found.slice(0, Math.max(1, limit));
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

  /**
   * Row configuration schema.
   *
   * The `.volatile()` marks are what make this row a **settings namespace**:
   * `ctx.settings.describe()` projects exactly the volatile fields, so the
   * browser can read and write them through
   * `ctx.configForms.get('compaction-doctor')` without any registration step.
   * Volatile fields must be fixed-path scalars (never inside a dict or array),
   * which is why every field below is a top-level scalar.
   */
  static Config = z.object({
    enabled: z.boolean().default(false).description("总开关：打开后按当前会话用到的模型自动校正长度设置").volatile(),
    autoRepair: z.boolean().default(true).description("自动修正（关掉就只查不写，不开页面）").volatile(),
    probeOnStart: z.boolean().default(false).description("已废弃（v0.4 起没有启动期扫描），仅为兼容旧 profile patch 保留").volatile(),
    writeConfig: z.boolean().default(false).description("允许 /compact-doctor 命令把结果写回配置（自动模式不走这条）").volatile(),
    activeProbe: z.boolean().default(false).description("允许发起真实请求的边界探测（消耗额度）").volatile(),
    activeProbeConfirm: z.boolean().default(false).description("边界探测的二次确认").volatile(),
    overflowRecovery: z.boolean().default(true).description("把未翻译的溢出报错识别为上下文超限并恢复").volatile(),
    capMaxTokens: z.number().default(65536).min(1024).max(MAX_TOKENS_CAP).description("输出上限（maxTokens）的夹取上限").volatile(),
    scaleMode: z.union([z.const("meter"), z.const("select"), z.const("off")]).default("meter").description("缩放基准：meter（默认）/ select / off（停用修复）").volatile(),
    maxSummaryChunks: z.number().default(8).min(1).max(24).description("分块摘要的最大块数").volatile(),
    tokensPerByte: z.number().default(0.34).min(0.01).description("字节到 token 的估算系数").volatile(),
    summaryBudgetRatio: z.number().default(0.9).min(0.1).max(1).description("摘要输入预算占窗口的比例").volatile(),
    selectCapRatio: z.number().default(0.85).min(0.1).max(1).description("select 模式下遮蔽范围的预算上限比例").volatile(),
    thresholdRatio: z.number().default(0.75).min(0.1).max(1).description("压力阈值占窗口比例（0.75=比随包默认 0.8 更早压缩）").volatile(),
    retainRatio: z.number().default(0.05).min(0).max(1).description("保留尾部占消息预算的比例").volatile(),
    fallbackContextWindow: z.number().min(1024).description("探测不到时的兜底上下文窗口"),
    provider: z.string().description("强制指定 provider（留空=跟随当前路由）"),
    model: z.string().description("强制指定 model（留空=跟随当前路由）"),
    providerEntryId: z.string().default("llm-pi-ai").description("承载该 provider 的 profile 行 id"),
    engineEntryId: z.string().default("compaction-doctor-engine").description("压缩引擎所在的行 id"),
    apiKeyEnv: z.string().default("HUAIYUAN_API_KEY").description("网关密钥的环境变量名"),
    baseURL: z.string().description("网关 baseURL 覆盖"),
    writeWhenBusy: z.boolean().default(false).description("会话忙时也允许写回"),
  });

  constructor(ctx, config = {}) {
    super(ctx, "compactionDoctor");
    this.config = normalizeConfig(config);
    // The switch the user last clicked wins over whatever the row config says:
    // the row's value is only the install-time default.
    const stored = readSwitchState();
    if (typeof stored === "boolean") this.config.enabled = stored;
    this.resolved = undefined;
    this.lastReport = undefined;
    this.lastDiagnose = undefined;
    this.commandRegistered = false;
    this._lateHookInstalled = false;
    this._routeRegistered = false;
    /** Per-(provider, model) lazy-pass state: `Map<routeKey, {at,status,key}>`. */
    this.autoState = new Map();
    this.written = undefined;
    try {
      this._registerCommand();
      this._installLateHook();
      this._registerRoute(ctx);
      // No startup sweep on purpose: nothing is read, priced or written until a
      // turn actually runs on a model. See `ensureRoute()`.
      info(
        ctx,
        `loaded (enabled=${this.config.enabled}, autoRepair=${this.config.autoRepair}, scaleMode=${this.config.scaleMode}, providerEntryId=${this.config.providerEntryId})`,
      );
    } catch (error) {
      warn(ctx, `constructor failed: ${error?.message ?? error}`);
    }
  }

  /**
   * The window the profile currently carries.
   *
   * A session's recorded route only updates on its next request, so right after
   * 「修复」 a fresh diagnosis would otherwise still read the OLD value and report
   * the fix as failed. A verified write is therefore authoritative until the
   * session catches up.
   */
  _configuredFor(route) {
    return {
      provider: route?.provider,
      model: route?.model,
      contextWindow: this.written?.contextWindow ?? route?.contextWindow ?? this.config.fallbackContextWindow,
      maxOutput: this.written?.maxOutput ?? this.config.capMaxTokens,
    };
  }

  /**
   * The lazy per-route pass — the whole point of v0.4.
   *
   * Called for the model the user is actually talking to right now, never for
   * the whole profile: a (provider, model) pair is looked at once per process,
   * and nothing else is ever enumerated. When `autoRepair` is on and the value
   * the profile carries disagrees with what the provider really accepts, the row
   * is corrected in place (byte-for-byte backup first) and reported to the DSH
   * log. The user never has to press anything.
   */
  async ensureRoute(route, { signal, session } = {}) {
    if (this.config.enabled !== true) return { skipped: "disabled" };
    if (typeof route?.model !== "string" || route.model.length === 0) return { skipped: "no route" };
    const key = `${route.provider ?? "?"}\u0000${route.model}`;
    const seen = this.autoState.get(key);
    if (seen !== undefined && seen.status !== "failed") return seen;
    this.autoState.set(key, { at: new Date().toISOString(), status: "running", key });
    const record = (status, patch = {}) => {
      const next = { at: new Date().toISOString(), status, key, ...patch };
      this.autoState.set(key, next);
      this._trimAutoState();
      return next;
    };
    try {
      const report = await this.run({ session, route, signal, write: false });
      this.lastReport = report;
      this.lastDiagnose = this._diagnoseOf(report);
      const view = this._plainView(this.lastDiagnose);
      if (view.level !== "warn") return record("ok", { summary: view });
      if (this.config.autoRepair !== true) return record("found", { summary: view });
      const proposed = this.lastDiagnose?.proposed;
      if (proposed === null || proposed === undefined) return record("found", { summary: view });
      const written = await this._writeBack({
        route: report.route ?? route,
        decision: { contextWindow: proposed.contextWindow, maxOutput: proposed.maxTokens },
      });
      if (written?.ok !== true) {
        warn(this.ctx, `automatic repair failed for ${key}: ${written?.reason ?? "write refused"}`);
        return record("failed", { error: written?.reason ?? "write refused" });
      }
      this.written = {
        contextWindow: proposed.contextWindow,
        maxOutput: proposed.maxTokens,
        backup: written?.backup ?? written?.file,
        at: new Date().toISOString(),
      };
      info(
        this.ctx,
        `automatic repair for ${route.provider}/${route.model}: ${proposed.contextWindow} tokens, output ${proposed.maxTokens} (backup ${this.written.backup ?? "?"})`,
      );
      return record("fixed", { summary: view, backup: this.written.backup, route: { provider: route.provider, model: route.model } });
    } catch (error) {
      warn(this.ctx, `automatic repair threw for ${key}: ${error?.message ?? error}`);
      return record("failed", { error: error?.message ?? String(error) });
    }
  }

  /** Lazy trigger for the session a turn is running in. Never throws, never awaits. */
  _lazyCheck(session) {
    if (this.config.enabled !== true) return;
    try {
      const target = session ?? this._newestSession();
      const route = latestRoute(target, { provider: this.config.provider, model: this.config.model });
      if (route?.model === undefined) return;
      const key = `${route.provider ?? "?"}\u0000${route.model}`;
      if (this.autoState.has(key)) return;
      void this.ensureRoute(route, { session: target }).catch(() => undefined);
    } catch (error) {
      warn(this.ctx, `lazy check skipped: ${error?.message ?? error}`);
    }
  }

  /** At most one entry per route ever seen, capped so a long-running process cannot grow. */
  _trimAutoState() {
    while (this.autoState.size > 32) {
      const oldest = this.autoState.keys().next().value;
      if (oldest === undefined) break;
      this.autoState.delete(oldest);
    }
  }

  /** The lazy verdict for one route, as the settings switch's status line reads it. */
  _autoStatus() {
    if (this.config.enabled !== true) return { key: "auto.off", params: {} };
    let route;
    try {
      route = latestRoute(this._newestSession(), { provider: this.config.provider, model: this.config.model });
    } catch {
      route = undefined;
    }
    if (route?.model === undefined) return { key: "auto.none", params: {} };
    const entry = this.autoState.get(`${route.provider ?? "?"}\u0000${route.model}`);
    const params = { provider: route.provider ?? "?", model: route.model };
    if (entry === undefined) return { key: "auto.pending", params };
    if (entry.status === "running") return { key: "auto.running", params };
    if (entry.status === "ok") return { key: "auto.ok", params };
    if (entry.status === "found") return { key: "auto.found", params };
    if (entry.status === "fixed") return { key: "auto.fixed", params, backup: entry.backup };
    return { key: "auto.failed", params };
  }

  /** Run the probe for one session (or the newest known session). */
  async run({ agent, session, signal, write, active, route: givenRoute } = {}) {
    const target = session ?? agent?.session ?? this._newestSession();
    const route = givenRoute ?? latestRoute(target, { provider: this.config.provider, model: this.config.model });
    const configured = this._configuredFor(route);
    const observed = readObservedBracket(target);
    const setup = this._providerSetup(route?.provider);
    const apiKey = this._apiKey(setup);
    const baseURL = this.config.baseURL ?? setup.baseURL;
    const adapter = await discoverViaAdapter(this.ctx, route, this.config.providerEntryId, signal);
    const gateway = await probeModelsEndpoint({ baseURL, apiKey, model: route?.model, signal });
    let activeResult;
    const wantActive = active === true || (this.config.activeProbe === true && this.config.activeProbeConfirm === true);
    if (wantActive) {
      activeResult = await activeBoundaryProbe({
        baseURL,
        apiKey,
        model: route?.model,
        tokensPerByte: this.config.tokensPerByte,
        seedTokens: Math.max(num(observed.maxAcceptedPrompt, 0), num(configured.contextWindow, 0), 262144),
        signal,
      });
    }
    const decision = reconcileWindow({ configured, observed, adapter, gateway, active: activeResult, capMaxTokens: this.config.capMaxTokens });
    this.resolved = {
      provider: route?.provider,
      model: route?.model,
      contextWindow: decision.contextWindow,
      maxOutput: decision.maxOutput,
      source: decision.winner?.source ?? "configured",
      at: new Date().toISOString(),
    };
    const report = { at: new Date().toISOString(), route, configured, observed, decision, adapter, gateway, active: activeResult, written: undefined };
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
    if (typeof this.ctx.effect === "function") {
      try {
        this.ctx.effect(function* () {
          yield commands.register(registration);
        }, "compaction-doctor command");
        this.commandRegistered = true;
        return true;
      } catch (error) {
        // Never fall back to a direct registration here: `commands.register`
        // throws on a duplicate name, and a second attempt would either
        // double-register (different names) or mask the real failure.
        warn(this.ctx, `command registration via ctx.effect failed: ${error?.message ?? error}`);
        return false;
      }
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

  /**
   * Retry the command registration on the first step that happens after the
   * command service appears.
   *
   * `agent/pre-step` is a **waterfall**: its listeners run outermost-first and a
   * listener that neither calls `next()` nor returns a decision vetoes the rest
   * of the chain, including the built-in `{ kind: "enter" }` fallback. The
   * consumers then read `decision.kind` on `undefined` and the whole turn dies,
   * so this listener must always forward.
   */
  _installLateHook() {
    if (this._lateHookInstalled) return;
    this._lateHookInstalled = true;
    this.ctx.on("agent/pre-step", (payload, next) => {
      try {
        if (this.commandRegistered === false) this._registerCommand();
      } catch (error) {
        warn(this.ctx, `late command registration failed: ${error?.message ?? error}`);
      }
      // Fire-and-forget, once per (provider, model): a turn is about to run, so
      // this is the first moment the model in use is known. Never awaited, never
      // allowed to touch the waterfall's return value.
      try {
        this._lazyCheck(payload?.agent?.session ?? payload?.session);
      } catch (error) {
        warn(this.ctx, `lazy check failed: ${error?.message ?? error}`);
      }
      return next();
    });
  }

  // -------------------------------------------------------------------------
  // settings-page capabilities (HTTP transport lives in ./status.js)
  // -------------------------------------------------------------------------

  _registerRoute(ctx) {
    if (this._routeRegistered) return;
    const result = installStatusRoute(ctx, this, {
      prefix: ROUTE_PREFIX,
      headerName: ROUTE_GUARD_HEADER,
      logger: (message) => warn(ctx, message),
    });
    this._routeRegistered = result.installed === true;
    if (result.installed === true) info(ctx, `settings page transport registered at ${ROUTE_PREFIX}`);
    else warn(ctx, `settings page transport unavailable: ${result.reason}`);
  }

  /** Live engine facts, tolerant of a missing or foreign compaction service. */
  _engineView() {
    let engine;
    try {
      engine = this.ctx.get("compaction");
    } catch {
      engine = undefined;
    }
    const stats = engine?.doctorStats ?? {};
    const meter = typeof engine?.meterState === "function" ? engine.meterState() : undefined;
    return {
      present: engine !== undefined && engine !== null,
      scaleMode: typeof engine?.doctorConfig === "function" ? engine.doctorConfig().scaleMode ?? "meter" : "unknown",
      auto: engine?.config?.auto !== false,
      meterPatched: stats.meterPatched === true || meter?.patched === true,
      summaryCalls: num(stats.summarizeCalls, 0),
      chunkedRegions: num(stats.chunkedRegions, 0),
      chunkCalls: num(stats.chunkCalls, 0),
      merges: num(stats.merges, 0),
      classifications: num(stats.classifications, 0),
      classificationRetries: num(stats.classificationRetries, 0),
      selectRuns: num(stats.selectRuns, 0),
      guardFailures: num(stats.guardFailures, 0),
      lastScale: stats.lastScale,
      lastCompaction: stats.lastCompaction ?? null,
      lastGuardMessage: stats.lastGuardMessage,
      lastFailure: stats.lastFailure,
      notes: Array.isArray(stats.notes) ? stats.notes.slice(0, 8) : [],
    };
  }

  /** One measurement summary for the status card. */
  _measurementView(session) {
    let meter;
    try {
      meter = this.ctx.get("tokenMeter");
    } catch {
      meter = undefined;
    }
    if (meter === undefined || meter === null || typeof meter.measure !== "function" || session === undefined) return undefined;
    try {
      const measurement = meter.measure(session);
      const total = num(measurement?.totalTokens, 0);
      const surface = num(measurement?.surfaceTokens, 0);
      return {
        totalTokens: total,
        surfaceTokens: surface,
        nodes: Array.isArray(measurement?.nodes) ? measurement.nodes.length : 0,
        factor: surface > 0 ? Math.min(total / surface, 64) : 1,
        rescaled: measurement?.doctorFactor !== undefined,
      };
    } catch {
      return undefined;
    }
  }

  /** `GET /state` — the status card's polling snapshot. */
  async stateSnapshot() {
    const at = new Date().toISOString();
    try {
      const session = this._newestSession();
      const route = latestRoute(session, { provider: this.config.provider, model: this.config.model });
      const engine = this._engineView();
      const numbers = this._numbers();
      const policy = this._policy();
      const window = this.resolved;
      return {
        ok: true,
        at,
        version: VERSION,
        host: {
          route: ROUTE_PREFIX,
          writeConfig: this.config.writeConfig === true,
          meterPatched: engine.meterPatched,
          routeRegistered: this._routeRegistered === true,
        },
        session: {
          id: session?.id ?? undefined,
          route: route === undefined ? undefined : { provider: route.provider, model: route.model },
        },
        window:
          window === undefined
            ? undefined
            : {
                contextWindow: window.contextWindow,
                maxOutput: window.maxOutput,
                source: window.source,
                contradiction: this.lastDiagnose?.decision?.contradiction ?? false,
                reserveContradiction: this.lastDiagnose?.decision?.reserveContradiction ?? false,
              },
        budget:
          numbers === undefined
            ? undefined
            : {
                messageBudget: numbers.messageBudget,
                headroomTokens: num(policy.headroomTokens, 65536),
                thresholdTokens: numbers.threshold,
                retainTokens: numbers.retainReal,
                summaryBudget: numbers.summaryBudget,
              },
        measurement: this._measurementView(session),
        engine,
        lastCompaction: engine.lastCompaction,
        guard:
          engine.guardFailures > 0 || engine.lastGuardMessage !== undefined
            ? { failures: engine.guardFailures, lastMessage: engine.lastGuardMessage }
            : null,
        plain: this._plainView(this.lastDiagnose),
        // The switch and its status line: the entire settings page.
        enabled: this.config.enabled === true,
        route:
          route === undefined ? undefined : { provider: route.provider, model: route.model },
        auto: this._autoStatus(),
        unavailable: false,
      };
    } catch (error) {
      return { ok: false, unavailable: true, at, message: error?.message ?? String(error) };
    }
  }

  /**
   * The one plain-language verdict the settings page shows.
   *
   * The page is deliberately dumb: it renders `text`, appends `detail` to a log,
   * and colours a dot by `level`. Every number that reaches this view is a value
   * the user can read in their own `cordis.patch.yml`; no internal vocabulary
   * (scaling, shadowing, budgets, headroom, ratios) ever appears here.
   *
   * Levels: `ok` (nothing to change), `warn` (a value should change),
   * `unknown` (no diagnosis yet).
   */
  _plainView(report) {
    const decision = report?.decision ?? {};
    const configured = report?.configured ?? {};
    const route = report?.route;
    const who = route === undefined ? undefined : `${route.provider} / ${route.model}`;
    if (report == null || configured.contextWindow === undefined) {
      return {
        level: "unknown",
        key: "plain.unknown",
        params: {},
        text: "还没检查过。点「检查」看看压缩设置对不对。",
        detail: who === undefined ? [] : [`当前模型：${who}。`],
      };
    }
    const seenWindow = num(configured.contextWindow, 0);
    const seenOutput = num(configured.maxOutput, 0);
    const wantWindow = Math.floor(num(decision.contextWindow, 0));
    const wantOutput = Math.floor(num(decision.maxOutput, 0));
    const needsWindow = wantWindow > 0 && wantWindow !== seenWindow;
    const needsOutput = wantOutput > 0 && wantOutput !== seenOutput;
    if (!needsWindow && !needsOutput) {
      return {
        level: "ok",
        key: "plain.ok",
        params: { window: String(seenWindow), output: String(seenOutput), provider: route?.provider ?? "", model: route?.model ?? "" },
        text: "没有发现问题，压缩设置是正确的。",
        detail: [
          who === undefined ? "" : `当前模型：${who}。`,
          `现在用的长度：${seenWindow}，输出上限：${seenOutput}。`,
        ].filter((line) => line !== ""),
      };
    }
    const detail = [];
    if (needsWindow && !needsOutput) detail.push(`输出上限 ${seenOutput} 不用改。`);
    if (needsOutput && !needsWindow) detail.push(`长度 ${seenWindow} 不用改。`);
    detail.push("点「修复」会先备份配置文件再改。");
    return {
      level: "warn",
      key: needsWindow ? (needsOutput ? "plain.warnBoth" : "plain.warnWindow") : "plain.warnOutput",
      params: { window: String(seenWindow), output: String(seenOutput), wantWindow: String(wantWindow), wantOutput: String(wantOutput) },
      text: needsWindow
        ? needsOutput
          ? `发现两个设置不对：长度 ${seenWindow} 应该是 ${wantWindow}，输出上限 ${seenOutput} 应该是 ${wantOutput}。`
          : `压缩用的长度设错了：现在是 ${seenWindow}，建议改成 ${wantWindow}。`
        : `输出上限设错了：现在是 ${seenOutput}，建议改成 ${wantOutput}。`,
      detail,
    };
  }

  /** Shape one probe report into the diagnosis object the API and the page share. */
  _diagnoseOf(report) {
    const configured = report?.configured ?? {};
    const decision = report?.decision ?? {};
    const proposed =
      num(decision.contextWindow, 0) > 0 &&
      (num(decision.contextWindow, 0) !== num(configured.contextWindow, 0) || num(decision.maxOutput, 0) !== num(configured.maxOutput, 0))
        ? { contextWindow: Math.floor(num(decision.contextWindow, 0)), maxTokens: Math.floor(num(decision.maxOutput, 0)) }
        : null;
    const view = {
      ok: true,
      at: report?.at ?? new Date().toISOString(),
      summary: report === undefined ? undefined : formatReport(report),
      route: report?.route,
      configured,
      observed: report?.observed,
      decision: {
        contextWindow: decision.contextWindow,
        maxOutput: decision.maxOutput,
        source: decision.winner?.source ?? "configured",
        contradiction: decision.contradiction === true,
        reserveContradiction: decision.reserveContradiction === true,
        rationale: decision.rationale,
      },
      candidates: Array.isArray(decision.candidates) ? decision.candidates : [],
      proposed,
    };
    return { ...view, plain: this._plainView(view) };
  }

  /** `POST /diagnose` — one read-only discovery pass plus a proposal. */
  async diagnose({ active } = {}) {
    const report = await this.run({ write: false, active: active === true });
    const view = this._diagnoseOf(report);
    this.lastDiagnose = view;
    return view;
  }

  /** `POST /apply` — write the proposed window back, with a byte-for-byte backup. */
  async applyFix({ contextWindow, maxTokens, confirm } = {}) {
    if (confirm !== true) return { ok: false, error: "confirmation required: pass confirm:true" };
    const window = Math.floor(num(contextWindow, 0));
    const output = Math.floor(num(maxTokens, 0));
    if (window <= 0 || output <= 0) return { ok: false, error: "contextWindow and maxTokens must be positive integers" };
    if (window > 16_777_216) return { ok: false, error: "contextWindow is implausibly large" };
    const report = this.lastDiagnose ?? (await this.run({ write: false }));
    const route = report?.route;
    if (route === undefined || typeof route.model !== "string") return { ok: false, error: "no routed model to repair; run a diagnosis first" };
    const before = report?.configured ?? {};
    const written = await this._writeBack({ route, decision: { contextWindow: window, maxOutput: output } });
    const changes = [];
    if (num(before.contextWindow, 0) !== window) changes.push(`contextWindow ${num(before.contextWindow, 0)} -> ${window}`);
    if (num(before.maxOutput, 0) !== output) changes.push(`maxTokens ${num(before.maxOutput, 0)} -> ${output}`);
    if (written?.ok !== true) return { ok: false, error: written?.reason ?? "write failed", written };
    this.resolved = { ...(this.resolved ?? {}), contextWindow: window, maxOutput: output, at: new Date().toISOString() };
    // Authoritative for later diagnoses: the session route stays stale until its
    // next request, and the page re-checks immediately after a fix.
    this.written = {
      contextWindow: window,
      maxOutput: output,
      backup: written?.backup ?? written?.file,
      at: new Date().toISOString(),
    };
    return {
      ok: true,
      backup: written.backup,
      changes,
      used: written.used,
      hotReload: true,
      note: "the profile patch reloads in place; running sessions pick the new window up without a restart",
    };
  }

  /** Doctor-owned keys, in the shape the settings page renders. */
  _doctorConfigView() {
    const out = {};
    for (const key of [
      "enabled",
      "probeOnStart",
      "writeConfig",
      "activeProbe",
      "activeProbeConfirm",
      "overflowRecovery",
      "capMaxTokens",
      "scaleMode",
      "maxSummaryChunks",
      "tokensPerByte",
      "summaryBudgetRatio",
      "selectCapRatio",
      "fallbackContextWindow",
      "provider",
      "model",
      "providerEntryId",
      "engineEntryId",
      "apiKeyEnv",
      "baseURL",
      "writeWhenBusy",
    ]) {
      if (this.config?.[key] !== undefined) out[key] = this.config[key];
    }
    return out;
  }

  /** The engine row's own policy keys (consumed by the shipped base class). */
  _engineRowView() {
    let engine;
    try {
      engine = this.ctx.get("compaction");
    } catch {
      engine = undefined;
    }
    const config = engine?.config;
    if (config === null || typeof config !== "object") return {};
    const out = {};
    for (const key of ENGINE_ROW_KEYS) {
      if (config[key] !== undefined) out[key] = config[key];
    }
    return out;
  }

  /** `GET /config` — both halves of the page's configuration card. */
  async readConfigView() {
    return {
      ok: true,
      writable: true,
      source: "live",
      // Merged view: the page renders one flat form, and a field's owning row is
      // decided by the writer, not by the reader.
      config: { ...this._doctorConfigView(), ...this._engineRowView() },
      engineRow: this._engineRowView(),
      doctorRow: this._doctorConfigView(),
    };
  }

  /**
   * `PUT /config` — partial update, one field per press.
   *
   * Doctor keys belong to this row; engine policy keys belong to the engine row
   * (they are `deepFreeze`d into the shipped base class at mount, so they can
   * only change by rewriting that row and letting the patch reload). Every write
   * is backed up first, so no extra confirmation is demanded here — that is
   * reserved for the two destructive actions, `POST /apply` and `POST /restore`.
   */
  /**
   * Flip the switch.
   *
   * Memory first, so `GET /state` and the engine see it on the very next read;
   * the file is how it survives a restart. Writing the file can fail (read-only
   * home, weird ACLs) and that is NOT an error for the caller: the switch still
   * works for this session, and the log says so.
   */
  async setEnabled(value) {
    const next = value === true ? true : value === false ? false : undefined;
    if (next === undefined) return { ok: false, error: "enabled must be a boolean" };
    const written = writeSwitchState(next);
    this.config.enabled = next;
    this.switchedAt = new Date().toISOString();
    if (written.ok === true) {
      info(this.ctx, `switch ${next ? "on" : "off"} (persisted to ${written.file})`);
    } else {
      warn(this.ctx, `switch ${next ? "on" : "off"} for this session only: ${written.error}`);
    }
    return { ok: true, enabled: next, file: written.file, persisted: written.ok === true };
  }

  async writeConfigPatch({ patch } = {}) {
    const source = patch !== null && typeof patch === "object" ? patch : {};
    // The switch is not a profile row value and never becomes one. Its row is
    // inserted by the bundle, so a profile patch cannot override it without
    // re-asserting `name` — and writing config there would replace the row's
    // WHOLE config. It lives in a file this plugin owns, takes effect in memory
    // immediately, and therefore never needs a hot reload to be observed.
    const results = [];
    if (Object.prototype.hasOwnProperty.call(source, "enabled")) {
      const switched = await this.setEnabled(source.enabled);
      if (switched.ok !== true) return switched;
      results.push({ ok: true, route: "switch-file", file: switched.file, changed: ["enabled"] });
    }
    const enginePatch = {};
    const doctorPatch = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === "enabled") continue;
      if (ENGINE_ROW_KEYS.includes(key)) enginePatch[key] = value;
      else doctorPatch[key] = value;
    }
    if (Object.keys(enginePatch).length === 0 && Object.keys(doctorPatch).length === 0) {
      if (results.length === 0) return { ok: false, error: "nothing to write" };
      return {
        ok: true,
        results,
        config: { ...this._doctorConfigView(), ...this._engineRowView() },
      };
    }
    if (Object.keys(doctorPatch).length > 0) results.push(await this._writeRowConfig("compaction-doctor", doctorPatch));
    if (Object.keys(enginePatch).length > 0) results.push(await this._writeRowConfig(this.config.engineEntryId, enginePatch));
    const failed = results.find((result) => result.ok !== true);
    if (failed !== undefined) return { ok: false, error: failed.reason ?? "write failed", results };
    return {
      ok: true,
      results,
      backup: results.map((result) => result.backup).find((value) => value !== undefined),
      config: { ...this._doctorConfigView(), ...this._engineRowView() },
      engineRow: this._engineRowView(),
      hotReload: true,
    };
  }

  /** Rewrite one row's `config` through the editor, else through the file. */
  async _writeRowConfig(entryId, patch) {
    const editor = this._configEditor();
    if (editor !== undefined) {
      try {
        const entries = await editor.entries();
        const entry = Array.isArray(entries) ? entries.find((item) => (item?.id ?? item?.options?.id) === entryId) : undefined;
        if (entry !== undefined && typeof entry === "object") {
          await editor.edit(entry, (current) => ({ ...(current ?? {}), ...patch }));
          return { ok: true, route: "configEditor", entryId, changed: Object.keys(patch) };
        }
        return await this._writeRowConfigToFile(entryId, patch, "entry not exposed by configEditor");
      } catch (error) {
        return this._writeRowConfigToFile(entryId, patch, error?.message ?? String(error));
      }
    }
    return this._writeRowConfigToFile(entryId, patch, "configEditor unavailable");
  }

  async _writeRowConfigToFile(entryId, patch, reason) {
    const candidates = candidateProfilePatches(this.config.providerEntryId);
    const fallback = candidates.length === 0 ? [] : [{ file: join(profileDir(), "cordis.patch.yml") }];
    const files = [...candidates, ...fallback];
    const tried = [];
    for (const candidate of files) {
      let text;
      try {
        text = readFileSync(candidate.file, "utf8");
      } catch {
        tried.push(`${candidate.file}: unreadable`);
        continue;
      }
      const rewritten = setRowConfigKeys(text, entryId, patch);
      if (rewritten.changed === false) {
        tried.push(`${candidate.file}: ${rewritten.reason}`);
        continue;
      }
      const written = writeProfilePatch(candidate.file, text, rewritten.text);
      if (written.ok === true) return { ok: true, route: "file", file: candidate.file, backup: written.backup, changed: Object.keys(patch) };
      tried.push(`${candidate.file}: ${written.reason}`);
    }
    return { ok: false, reason: `${reason}; ${tried.join(" | ")}` };
  }

  /** `GET /backups`. */
  async listBackups() {
    return listPatchBackups(profileDir());
  }

  /** `POST /restore`. */
  async restoreBackup({ file, confirm } = {}) {
    if (confirm !== true) return { ok: false, error: "confirmation required: pass confirm:true" };
    if (typeof file !== "string" || file.length === 0) return { ok: false, error: "file is required" };
    const dir = profileDir();
    if (isBackupInside(dir, file) === false) {
      return { ok: false, error: "only cordis.patch.yml backups inside the active profile can be restored" };
    }
    const source = join(dir, basename(file));
    let restoredText;
    let current;
    try {
      restoredText = readFileSync(source, "utf8");
      current = readFileSync(join(dir, "cordis.patch.yml"), "utf8");
    } catch (error) {
      return { ok: false, error: `read failed: ${error?.message ?? error}` };
    }
    const written = writeProfilePatch(join(dir, "cordis.patch.yml"), current, restoredText, `${BACKUP_TAG}-restore`);
    if (written.ok !== true) return { ok: false, error: written.reason ?? "restore failed" };
    return { ok: true, restored: join(dir, "cordis.patch.yml"), backup: written.backup, hotReload: true };
  }

  async _commandHandler(invocation) {
    try {
      const report = await this.run({
        agent: invocation?.agent,
        signal: invocation?.signal,
        write: this.config.writeConfig === true,
      });
      this.lastDiagnose = report;
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
