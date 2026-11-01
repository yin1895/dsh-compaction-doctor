/**
 * Shared harness for the failure-replay and property suites.
 *
 * Three things this file owns:
 *
 *  1. **Driving the real engine.** `lib/*.js` is copied next to this directory
 *     (byte-identical, asserted by hash) so the shipped bare specifiers resolve
 *     to `test/replay/node_modules/@deepseek-ai/*` — the same seam
 *     `test/nm/run.mjs` uses. Nothing about the engine is reimplemented here.
 *  2. **The recorded host.** `test/replay/node_modules/@deepseek-ai/dsh-compaction-basic`
 *     plays the two parties the failed session recorded: an adapter that measures
 *     the outgoing request with its own accounting, and a surface layer that
 *     refuses to let node 0 (the system prompt) sit inside a replace range.
 *  3. **Reading the fixture.** The failure tail is loaded from
 *     `test/fixtures/overflow-401k.jsonl`; the recorded error texts are taken
 *     *from the fixture*, never retyped, so a replay can only pass while the
 *     engine survives the errors that actually happened.
 *
 * @module test/replay/harness
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const FIXTURE_PATH = path.join(ROOT, "test", "fixtures", "overflow-401k.jsonl");

/** The hard safety margin the size property demands on top of `maxOutput`. */
export const SAFETY_MARGIN_TOKENS = 2048;
/** The plugin's configured estimate, i.e. `doctor.tokensPerByte`'s default. */
export const PLUGIN_TOKENS_PER_BYTE = 0.34;
/**
 * The fixed part of every summary request the host appends itself
 * (`SUMMARY_INSTRUCTION_TOKENS`, `lib/plan.js:38`): counted so the property
 * covers the whole outgoing request, not only the chunk payload.
 */
export const SUMMARY_INSTRUCTION_TOKENS = 1024;

/**
 * Copy `lib/*.js` next to the harness so the engine's bare imports resolve to
 * the stubs, and prove the copy is byte-identical to what ships.
 *
 * `REPLAY_LIB_DIR` points the copy at another `lib/` (e.g. `git show HEAD:lib`
 * of a known-broken revision) — the negative control that shows this suite can
 * still fail. Line numbers in a report always belong to the revision printed in
 * the same report.
 */
export function syncLib() {
  const source = process.env.REPLAY_LIB_DIR ?? path.join(ROOT, "lib");
  const target = path.join(HERE, "lib");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const hashes = new Map();
  for (const name of fs.readdirSync(source)) {
    if (!name.endsWith(".js")) continue;
    const from = path.join(source, name);
    const to = path.join(target, name);
    fs.copyFileSync(from, to);
    hashes.set(name, crypto.createHash("sha256").update(fs.readFileSync(from)).digest("hex"));
  }
  return hashes;
}

/** Verify the copy under test still matches `lib/`. */
export function verifyLibCopy(hashes) {
  const target = path.join(HERE, "lib");
  const drift = [];
  for (const [name, hash] of hashes) {
    const file = path.join(target, name);
    if (!fs.existsSync(file)) {
      drift.push(`${name}: missing`);
      continue;
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (actual !== hash) drift.push(`${name}: hash changed`);
  }
  return drift;
}

/** Sandbox `$DSH_HOME` so nothing in the suite can touch the real profile. */
export function sandboxHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdoc-replay-home-"));
  process.env.DSH_HOME = dir;
  if (typeof process.env.DSH_PROFILE !== "string" || process.env.DSH_PROFILE.length === 0) process.env.DSH_PROFILE = "desktop";
  process.on("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return dir;
}

/** Load the fixture and expose its invariants and recorded evidence. */
export function loadFixture() {
  const text = fs.readFileSync(FIXTURE_PATH, "utf8");
  const entries = text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));
  const context = entries.find((entry) => entry.type === "request/context");
  const ends = entries.filter((entry) => entry.type === "compaction/end");
  const node0Error = ends.map((entry) => entry.data.error).find((error) => typeof error === "string" && error.startsWith("surface replace: node 0"));
  const overflowError = ends.map((entry) => entry.data.error).find((error) => typeof error === "string" && error.startsWith("pi-ai detected context overflow"));
  const terminal = entries.at(-1);
  const acceptedPeak = entries.find((entry) => entry.seq === 917)?.data?.usage;
  const failureScale = entries.find((entry) => entry.seq === 1194)?.data?.usage;
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    entries,
    bySeq,
    tail: entries.filter((entry) => entry.seq >= 1194),
    entryTypes: entries.map((entry) => entry.type),
    watchErrors: ends.map((entry) => (entry.data.error === undefined ? "ok" : entry.data.error === node0Error ? "node0" : entry.data.error === overflowError ? "overflow" : "other")),
    node0Error,
    overflowError,
    terminal,
    terminalMessage: terminal?.data?.reason?.error?.message,
    terminalProvider: "alibaba-dashscope",
    declaredWindow: context?.data?.contextWindow,
    route: { provider: context?.data?.provider, model: context?.data?.model },
    acceptedPeak,
    failureScale,
  };
}

/** A cordis-shaped context: services, event listeners, waterfall emit. */
export function makeCtx(services = {}) {
  const listeners = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    _services: new Map(),
    get(name) {
      return ctx._services.get(name);
    },
    on(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(generator) {
      const iterator = generator();
      let step = iterator.next();
      while (step.done !== true) step = iterator.next();
      return () => {};
    },
    /** Waterfall emit: the first non-null listener result wins, like the host. */
    async emit(type, event, next = async () => undefined) {
      for (const handler of listeners.get(type) ?? []) {
        const result = await handler(event, next);
        if (result !== undefined && result !== null) return result;
      }
      return undefined;
    },
    async emitEvent(type, ...args) {
      let result;
      for (const handler of listeners.get(type) ?? []) result = await handler(...args);
      return result;
    },
  };
  for (const [name, value] of Object.entries(services)) {
    if (value === undefined) continue;
    ctx[name] = value;
    ctx._services.set(name, value);
  }
  return ctx;
}

/** A session whose surface is a list of seqs, with `eventAt` over the entries. */
export function makeSession(events, extra = {}) {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id: "session-replay",
    surface: { nodes: events.map((event) => event.seq), replaceGeneration: 0 },
    eventAt(seq) {
      return bySeq.get(seq);
    },
    __balance: { before: () => true, after: () => true },
    ...extra,
  };
}

/** The host model the stubbed backend reads (`config.__replay`). */
export function makeHost(overrides = {}) {
  const host = {
    window: 428917,
    maxOutput: 65536,
    margin: SAFETY_MARGIN_TOKENS,
    adapterTokensPerByte: PLUGIN_TOKENS_PER_BYTE,
    headerTokens: 0,
    systemSeq: undefined,
    overflowMessage: "pi-ai detected context overflow for model \"DeepSeek-V4.1-Flash\"",
    node0Message: "surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node",
    summaryChars: 64,
    log: { summarize: [], compactIfNeeded: [], compactRegion: [], compactNow: [], commits: [] },
    ...overrides,
  };
  // One implementation of the adapter's accounting, shared by the stub host and
  // the token meter, so "the adapter's estimate" is the same function everywhere.
  host.adapterTokens ??= (messages) => adapterTokens(messages, host.adapterTokensPerByte);
  return host;
}

/**
 * The adapter's own accounting for one message — the same one the meter exposes
 * as `estimateMessage` (`dsh-token-meter` prices the request message by message).
 */
export function adapterMessageTokens(message, tokensPerByte) {
  const bytes = Buffer.byteLength(JSON.stringify(message ?? null), "utf8");
  return Math.ceil(bytes * tokensPerByte);
}

/** The adapter's own accounting for one outgoing request payload. */
export function adapterTokens(messages, tokensPerByte) {
  if (Array.isArray(messages) === false) return adapterMessageTokens(messages, tokensPerByte);
  return messages.reduce((total, message) => total + adapterMessageTokens(message, tokensPerByte), 0);
}

/** Build `count` messages whose JSON payload is about `bytes` bytes in total. */
export function buildMessages(count, bytes, role = "user") {
  const per = Math.max(8, Math.floor(bytes / count));
  return Array.from({ length: count }, (_, index) => ({
    role,
    content: [{ type: "text", text: `${index}`.padEnd(per, "x") }],
  }));
}

/** A `maxTokens`-carrying agent over a session. */
export function makeAgent(session, maxTokens) {
  return { session, maxTokens, request: { maxTokens } };
}

/** Minimal `llm` service: the adapter descriptor the engine asks for. */
export function makeLlm(contextWindow) {
  return {
    async resolveModelInfo() {
      return { context: { contextWindow } };
    },
  };
}

/**
 * Minimal `tokenMeter` service: the surface measurement, plus the official
 * `estimateMessage` face the engine prices summary requests with
 * (`lib/util.js:229` prefers `meter.estimateMessage` over its local heuristic).
 * Passing the adapter's own accounting here is what makes the size property a
 * statement about the adapter's window rather than about the plugin's estimate.
 */
export function makeMeter(build, options = {}) {
  const tokensPerByte = options.tokensPerByte ?? PLUGIN_TOKENS_PER_BYTE;
  const meter = {
    calls: [],
    estimateCalls: [],
    measure(session, ...rest) {
      meter.calls.push({ session });
      return build(session, ...rest);
    },
    estimateMessage(message) {
      meter.estimateCalls.push({ message });
      return adapterMessageTokens(message, tokensPerByte);
    },
  };
  return meter;
}

/** Measurement shape the engine consumes: `nodes: [{seq, tokens}]`. */
export function pricedNodes(seqs, perNode) {
  return seqs.map((seq, index) => ({ seq, tokens: typeof perNode === "function" ? perNode(seq, index) : perNode }));
}

export function makeMeasurement(nodes) {
  const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0);
  return { nodes, surfaceTokens, totalTokens: surfaceTokens, pricedSurfaceTokens: surfaceTokens };
}
