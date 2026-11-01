/**
 * Behavioural test harness for `@local/dsh-compaction-doctor`.
 *
 * The bundle is authored against four shipped seams (cordis, dsh-llm,
 * dsh-compaction, dsh-compaction-basic). None of them is installed in this
 * workspace, so `test/nm/node_modules/@deepseek-ai/*` carries stubs with the
 * real signatures, and this runner copies `lib/*.js` next to them so the bare
 * specifiers resolve to the stubs. Every assertion below is derived from a
 * concrete fact recorded in `compact-verdict.md` (header surface sizes,
 * accepted/rejected prompt sizes, the DashScope 400 body, the profile patch
 * indentation) — nothing is asserted from imagination.
 *
 * Run: node test/nm/run.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceLib = path.resolve(here, "..", "..", "lib");
const localLib = path.join(here, "lib");

/**
 * Sandbox the whole run.
 *
 * `profileDir()` and everything built on it (`switchStateFile()`,
 * `candidateProfilePatches()`, the backup writer) resolve through `$DSH_HOME`.
 * Without this, a test that flips the switch — a real, supported operation —
 * writes into whoever happens to be running the suite. Set before the first
 * plugin import and never restored.
 */
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cdoc-nm-home-"));
process.env.DSH_HOME = SANDBOX_HOME;
if (typeof process.env.DSH_PROFILE !== "string" || process.env.DSH_PROFILE.length === 0) process.env.DSH_PROFILE = "desktop";
process.on("exit", () => {
  try {
    fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

fs.rmSync(localLib, { recursive: true, force: true });
fs.mkdirSync(localLib, { recursive: true });
for (const name of fs.readdirSync(sourceLib)) {
  if (name.endsWith(".js")) fs.copyFileSync(path.join(sourceLib, name), path.join(localLib, name));
}

const util = await import("./lib/util.js");
const compactionStub = await import("@deepseek-ai/dsh-compaction");
const plan = await import("./lib/plan.js");
const rescale = await import("./lib/rescale.js");
const overflowMod = await import("./lib/overflow.js");
const engineMod = await import("./lib/engine.js");
const probeMod = await import("./lib/probe.js");
const statusMod = await import("./lib/status.js");
const surfaceMod = await import("./lib/index.js");

// ---------------------------------------------------------------------------
// mini harness
// ---------------------------------------------------------------------------

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// fake harness surface
// ---------------------------------------------------------------------------

function makeLogger() {
  const seen = [];
  return {
    seen,
    info(message) {
      seen.push(["info", message]);
    },
    warn(message) {
      seen.push(["warn", message]);
    },
    debug(message) {
      seen.push(["debug", message]);
    },
    error(message) {
      seen.push(["error", message]);
    },
  };
}

function makeCtx(services = {}) {
  const listeners = new Map();
  const ctx = {
    logger: makeLogger(),
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
      // Drive the generator to completion, ignoring yielded promises: the
      // shipped plugins use it for lifetime bookkeeping only.
      const iterator = generator();
      let step = iterator.next();
      while (step.done !== true) step = iterator.next();
      return () => {};
    },
    async emit(type, event, next = async () => undefined) {
      for (const handler of listeners.get(type) ?? []) {
        const result = await handler(event, next);
        if (result !== undefined && result !== null) return result;
      }
      return undefined;
    },
    /**
     * Emit a non-waterfall event with its real host arity.
     *
     * `session/event` listeners receive `(session, event)` — the authoritative
     * shape used by `dsh-compaction-basic/lib/index.js:856`. A single-parameter
     * harness would silently keep a listener that reads the session object as
     * if it were the event, which is exactly the defect this harness guards.
     */
    async emitEvent(type, ...args) {
      let result;
      for (const handler of listeners.get(type) ?? []) {
        result = await handler(...args);
      }
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

function makeMeter(build) {
  const meter = {
    calls: [],
    measure(session, ...rest) {
      meter.calls.push({ session });
      return build(session, ...rest);
    },
  };
  return meter;
}

function makeSession(events = [], extra = {}) {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    surface: { nodes: events.map((event) => event.seq), replaceGeneration: 0 },
    eventAt(seq) {
      return bySeq.get(seq);
    },
    ...extra,
  };
}

function makeEvent(seq, type, data) {
  return { seq, type, data };
}

/** The surface of a session that has been running: one turn, real usage. */
function conversationEvents({ dialogue = 4, live = undefined } = {}) {
  const events = [
    makeEvent(1, "turn/start", {}),
    makeEvent(2, "request/context", live ?? { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 1048576 }),
  ];
  for (let i = 0; i < dialogue; i += 1) events.push(makeEvent(3 + i, "assistant/message", { usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }));
  return events;
}

function pricedNodes(count, perNode, firstSeq = 1) {
  const nodes = [];
  for (let i = 0; i < count; i += 1) nodes.push({ seq: firstSeq + i, tokens: perNode, heuristicTokens: perNode });
  return nodes;
}

function measurementOf(nodes, totalTokens) {
  return { totalTokens, surfaceTokens: nodes.reduce((sum, node) => sum + node.tokens, 0), nodes };
}

function makeAgent(session, hooks = {}) {
  return {
    session,
    maxTokens: hooks.maxTokens ?? 65536,
    runMaintenance: async (fn) => fn(new AbortController().signal),
  };
}

const fakeLlm = {
  async resolveModelInfo() {
    return { context: { contextWindow: 1048576 }, defaultMaxTokens: 65536 };
  },
  async listModels() {
    return { models: [{ id: "DeepSeek-V4.1-Flash", context_window: 1048576, max_completion_tokens: 131072 }] };
  },
};

// ---------------------------------------------------------------------------
// plan / math
// ---------------------------------------------------------------------------

test("plan: window math for the repaired profile (1 MiB window, 64k reserve, 64k headroom, 0.75 / 0.05)", () => {
  const numbers = plan.computeNumbers({
    contextWindow: 1048576,
    maxOutput: 65536,
    headroom: 65536,
    thresholdRatio: 0.75,
    retainRatio: 0.05,
    summaryBudgetRatio: 0.9,
  });
  assert.equal(numbers.W, 1048576);
  assert.equal(numbers.O, 65536);
  assert.equal(numbers.B, 65536);
  assert.equal(numbers.messageBudget, 983040);
  assert.equal(numbers.pressureBudget, 917504);
  assert.equal(numbers.threshold, 786432, "threshold = floor(min(W*ratio, pressureBudget))");
  assert.equal(numbers.retainReal, 49152, "retain = floor(messageBudget * 0.05)");
  assert.equal(numbers.summaryBudget, 878182, "summaryInput = floor(W*0.9) - reserve");
});

test("plan: the shipped policy reproduces the recorded 7,402-token head, the repaired math does not", () => {
  // hdr 654: 139 nodes / 120,807 priced tokens, shipped head 7,402 tokens.
  const numbers = plan.computeNumbers({
    contextWindow: 1048576,
    maxOutput: 65536,
    headroom: 65536,
    thresholdRatio: 0.75,
    retainRatio: 0.05,
    summaryBudgetRatio: 0.9,
  });
  const priced = pricedNodes(200, 233); // 46,600 priced — the hdr-849 shape
  const flat = priced.map((node) => node.tokens);
  assert.equal(plan.selectIndexRange(flat, { retainTokens: numbers.retainReal }), null, "shipped scale cannot retain 49,152 out of 46,600 priced tokens");
  const meter = measurementOf(priced, 624264);
  const scaled = rescale.rescaleMeasurement(meter);
  const factor = rescale.scaleFactorOf(meter);
  const bounds = plan.classifyMeasurement(meter, factor, numbers);
  assert.equal(bounds.overThreshold, false, "624,264 real tokens stay under the 786,432 threshold");
  const range = plan.selectIndexRange(
    scaled.nodes.map((node) => node.tokens),
    { retainTokens: numbers.retainReal, capTokens: Math.floor(numbers.summaryBudget * 0.85) },
  );
  assert.notEqual(range, null);
  assert.ok(range.shadowTokens > 500000, `expected a ~574k-token head, got ${range.shadowTokens}`);
  assert.equal(range.keepFrom, 200 - Math.ceil(numbers.retainReal / 3121));
});

test("plan: retainTokens 0 keeps exactly the newest node (context-overflow trigger)", () => {
  const range = plan.selectIndexRange([10, 20, 30], { retainTokens: 0 });
  assert.deepEqual(range, { startIndex: 0, endIndex: 1, keepFrom: 2, shadowTokens: 30 });
});

test("plan: a region larger than the cap is trimmed to the cap boundary", () => {
  const range = plan.selectIndexRange([100, 100, 100, 100], { retainTokens: 0, capTokens: 250 });
  assert.deepEqual(range, { startIndex: 0, endIndex: 1, keepFrom: 3, shadowTokens: 200 });
});

test("plan: threshold verdicts flip across the recorded header sizes", () => {
  const numbers = plan.computeNumbers({ contextWindow: 1048576, maxOutput: 65536, headroom: 65536, thresholdRatio: 0.75, retainRatio: 0.05, summaryBudgetRatio: 0.9 });
  const over = plan.classifyMeasurement(measurementOf(pricedNodes(200, 350), 930386), 13.35, numbers);
  const under = plan.classifyMeasurement(measurementOf(pricedNodes(200, 233), 624264), 13.41, numbers);
  assert.equal(over.overThreshold, true, "930,386 >= 786,432");
  assert.equal(under.overThreshold, false, "624,264 < 786,432");
  assert.equal(over.needsChunking, true, "930,386 - 49,152 exceeds the 878,182 summary budget");
});

test("plan: splitByCost keeps every item exactly once, contiguously and in order", () => {
  const items = Array.from({ length: 30 }, (_, i) => i);
  const costs = items.map((i) => 1000 + (i % 3));
  const groups = plan.splitByCost(items, costs, 3);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.flat(), items);
  for (const group of groups) assert.ok(group.length > 0);
});

// ---------------------------------------------------------------------------
// rescale / meter patch
// ---------------------------------------------------------------------------

test("rescale: factor is neutral below the useful threshold and real above it", () => {
  assert.equal(rescale.scaleFactorOf({ totalTokens: 100000, surfaceTokens: 99000 }), 1);
  const factor = rescale.scaleFactorOf({ totalTokens: 624264, surfaceTokens: 46600 });
  assert.ok(factor > 13 && factor < 14, `expected ~13.4, got ${factor}`);
});

test("rescale: rescaled nodes carry the real scale and sum to the metered total", () => {
  const meter = measurementOf(pricedNodes(200, 233), 624264);
  const scaled = rescale.rescaleMeasurement(meter);
  assert.equal(scaled.nodes.length, 200);
  assert.ok(scaled.nodes[0].tokens > 3000 && scaled.nodes[0].tokens < 3200);
  assert.equal(scaled.nodes[0].doctorHeuristicTokens, 233);
  assert.ok(Math.abs(scaled.surfaceTokens - 624264) < 2000, "rescaled surface must land on the metered total");
  assert.equal(scaled.pricedSurfaceTokens, 46600);
  assert.equal(rescale.rescaleMeasurement({ totalTokens: 1000, surfaceTokens: 1000, nodes: pricedNodes(2, 500) }).pricedSurfaceTokens, undefined, "no rescale needed => untouched shot");
});

test("rescale: the meter patch only rescales while a compaction is in flight, and uninstalls cleanly", () => {
  const raw = measurementOf(pricedNodes(200, 233), 624264);
  const meter = makeMeter(() => raw);
  const ctx = makeCtx({ tokenMeter: meter });
  const session = makeSession(conversationEvents());
  const original = meter.measure;
  const state = rescale.installScaledMeter(ctx);
  assert.equal(state.installed, true);
  assert.equal(state.patched, true);
  assert.equal(rescale.meterPatchState(ctx).patched, true);
  assert.equal(meter.measure(session), raw, "outside a compaction the shipped scale is untouched");
  rescale.beginScale(session);
  const inside = meter.measure(session);
  assert.notEqual(inside, raw);
  assert.ok(inside.surfaceTokens > 600000, "inside a compaction the shipped path sees real scale");
  rescale.endScale(session);
  assert.equal(meter.measure(session), raw, "scale leaves with the compaction");
  const again = rescale.installScaledMeter(ctx);
  assert.equal(again.reason, "already patched");
  rescale.uninstallScaledMeter(ctx);
  assert.equal(meter.measure, original, "uninstall restores the original function identity");
});

// ---------------------------------------------------------------------------
// overflow classification
// ---------------------------------------------------------------------------

const DASHSCOPE_400 = {
  code: 400,
  message: "内容太长了，请精简输入或开启新对话",
  metadata: { provider_name: "alibaba-dashscope" },
  param: null,
  type: "invalid_request_error",
};

test("overflow: the real DashScope 400 body classifies as a context overflow", () => {
  const verdict = overflowMod.isContextOverflowFailure(DASHSCOPE_400, "CONTEXT_WINDOW_EXCEEDED");
  assert.ok(typeof verdict === "string" && verdict.startsWith("matched:"), `got ${String(verdict)}`);
  assert.equal(overflowMod.providerAttribution(DASHSCOPE_400), "alibaba-dashscope");
});

test("overflow: branded codes and unrelated failures do not classify", () => {
  assert.equal(overflowMod.isContextOverflowFailure({ code: "CONTEXT_WINDOW_EXCEEDED", message: "boom" }, "CONTEXT_WINDOW_EXCEEDED"), "branded");
  assert.equal(overflowMod.isContextOverflowFailure({ code: 429, message: "rate limit exceeded, retry later" }, "CONTEXT_WINDOW_EXCEEDED"), undefined);
  assert.equal(overflowMod.isContextOverflowFailure({ code: 401, message: "invalid api key" }, "CONTEXT_WINDOW_EXCEEDED"), undefined);
});

test("overflow: a wrapped provider error is found through the cause chain", () => {
  const wrapped = { code: "UPSTREAM_ERROR", message: "request failed", cause: { code: 400, message: "This model's maximum context length is 1048576 tokens" } };
  const text = overflowMod.failureText(wrapped);
  assert.ok(text.includes("maximum context length"), text.slice(0, 120));
  assert.ok(typeof overflowMod.isContextOverflowFailure(wrapped, "CONTEXT_WINDOW_EXCEEDED") === "string");
});

// ---------------------------------------------------------------------------
// probe helpers: config rewrite
// ---------------------------------------------------------------------------

const PROFILE_PATCH = [
  "services:",
  "  - id: llm-pi-ai",
  "    name: '@deepseek-ai/dsh-llm-pi-ai'",
  "    config:",
  "      providers:",
  "        exampleGateway:",
  "          apiKeyEnv: EXAMPLE_GATEWAY_API_KEY",
  "          api: openai-completions",
  "          baseURL: http://127.0.0.1:17890/v1",
  "          models:",
  "            - id: DeepSeek-V4.1-Flash",
  "              name: DeepSeek V4.1 Flash(x2.0)",
  "              contextWindow: 512000",
  "              maxTokens: 384000",
  "              input:",
  "                - text",
  "            - id: spark-x",
  "              name: Spark X",
  "              contextWindow: 1048576",
  "              maxTokens: 65536",
  "",
];

test("probe: rewriteModelWindow repairs the routed model and leaves every sibling row byte-identical", () => {
  const result = probeMod.rewriteModelWindow(PROFILE_PATCH.join("\n"), {
    providerEntryId: "llm-pi-ai",
    provider: "exampleGateway",
    model: "DeepSeek-V4.1-Flash",
    contextWindow: 1048576,
    maxTokens: 65536,
  });
  assert.equal(result.changed, true);
  assert.ok(result.text.includes("              contextWindow: 1048576"));
  assert.ok(result.text.includes("              maxTokens: 65536"));
  assert.ok(result.text.includes("            - id: spark-x\n              name: Spark X\n              contextWindow: 1048576\n              maxTokens: 65536\n"));
  assert.ok(result.text.includes("              input:\n                - text\n"), "later keys of the patched model survive");
  const again = probeMod.rewriteModelWindow(result.text, {
    providerEntryId: "llm-pi-ai",
    provider: "exampleGateway",
    model: "DeepSeek-V4.1-Flash",
    contextWindow: 1048576,
    maxTokens: 65536,
  });
  assert.equal(again.changed, false, "the rewrite must be idempotent");
});

test("probe: rewriteModelWindow refuses a model it cannot find", () => {
  const result = probeMod.rewriteModelWindow(PROFILE_PATCH.join("\n"), {
    providerEntryId: "llm-pi-ai",
    provider: "exampleGateway",
    model: "does-not-exist",
    contextWindow: 1048576,
    maxTokens: 65536,
  });
  assert.equal(result.changed, false);
  assert.equal(result.text, undefined);
});

test("probe: readProviderSetup extracts the transport facts of the routed provider", () => {
  const setup = probeMod.readProviderSetup(PROFILE_PATCH.join("\n"), "exampleGateway");
  assert.equal(setup.baseURL, "http://127.0.0.1:17890/v1");
  assert.equal(setup.apiKeyEnv, "EXAMPLE_GATEWAY_API_KEY");
  assert.equal(setup.api, "openai-completions");
});

test("probe: patchConfigModel updates both array-shaped and map-shaped model tables", () => {
  const arrayShape = { providers: { exampleGateway: { models: [{ id: "DeepSeek-V4.1-Flash", contextWindow: 512000, maxTokens: 384000 }] } } };
  const patched = probeMod.patchConfigModel(arrayShape, "exampleGateway", "DeepSeek-V4.1-Flash", { contextWindow: 1048576, maxTokens: 65536 });
  assert.deepEqual(patched.providers.exampleGateway.models[0], { id: "DeepSeek-V4.1-Flash", contextWindow: 1048576, maxTokens: 65536 });
  assert.equal(arrayShape.providers.exampleGateway.models[0].contextWindow, 512000, "the input object is never mutated");
  const mapShape = { providers: { exampleGateway: { models: { "DeepSeek-V4.1-Flash": { contextWindow: 512000 } } } } };
  const mapPatched = probeMod.patchConfigModel(mapShape, "exampleGateway", "DeepSeek-V4.1-Flash", { contextWindow: 1048576, maxTokens: 65536 });
  assert.equal(mapPatched.providers.exampleGateway.models["DeepSeek-V4.1-Flash"].contextWindow, 1048576);
  assert.throws(() => probeMod.patchConfigModel(arrayShape, "exampleGateway", "nope", { contextWindow: 1, maxTokens: 1 }), /not present/);
});

test("probe: writeProfilePatch backs up, rewrites atomically and verifies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-write-"));
  const file = path.join(dir, "cordis.patch.yml");
  fs.writeFileSync(file, PROFILE_PATCH.join("\n"), "utf8");
  const next = `${PROFILE_PATCH.join("\n")}# touched\n`;
  const written = probeMod.writeProfilePatch(file, PROFILE_PATCH.join("\n"), next);
  assert.equal(written.ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), next);
  assert.ok(written.backup.endsWith(".bak-probe-" + path.basename(file)) || fs.existsSync(written.backup));
  assert.equal(fs.readFileSync(written.backup, "utf8"), PROFILE_PATCH.join("\n"));
  assert.ok(fs.readdirSync(dir).some((name) => name.includes(".bak-")), "a backup file must exist");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// probe helpers: window reconciliation against the recorded traffic
// ---------------------------------------------------------------------------

const OBSERVED = {
  maxAcceptedPrompt: 1036863,
  maxAcceptedSeq: 643,
  windowsSeen: [
    { contextWindow: 1048576, provider: "exampleGateway", model: "DeepSeek-V4.1-Flash" },
    { contextWindow: 512000, provider: "exampleGateway", model: "DeepSeek-V4.1-Flash" },
  ],
  attempts: 5,
  failures: 5,
};

test("probe: the configured 512k window contradicts traffic the provider already accepted", () => {
  const decision = probeMod.reconcileWindow({
    configured: { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 512000, maxOutput: 384000 },
    observed: OBSERVED,
    adapter: { source: "llm.listModels", contextWindow: 1048576, maxOutput: 131072 },
    capMaxTokens: 65536,
  });
  assert.equal(decision.contextWindow, 1048576);
  assert.equal(decision.maxOutput, 65536, "the cap keeps the completion reserve small");
  assert.equal(decision.ceiling, 1036863);
  assert.equal(decision.contradiction, true);
  assert.equal(decision.reserveContradiction, false);
  assert.equal(decision.winner.source, "adapter catalog");
});

test("probe: a repaired profile keeps the window and only reports the unenforced reserve", () => {
  const decision = probeMod.reconcileWindow({
    configured: { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 1048576, maxOutput: 65536 },
    observed: OBSERVED,
    adapter: { source: "llm.listModels", contextWindow: 1048576, maxOutput: 131072 },
    capMaxTokens: 65536,
  });
  assert.equal(decision.contradiction, false);
  assert.equal(decision.reserveContradiction, true, "1,036,863 > 1,048,576 - 65,536 was accepted, so the reserve is not enforced upstream");
  assert.equal(decision.maxOutput, 65536);
});

test("probe: with no catalog and no traffic the configured value is the only candidate", () => {
  const decision = probeMod.reconcileWindow({
    configured: { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 200000, maxOutput: 16384 },
    observed: {},
    capMaxTokens: 65536,
  });
  assert.equal(decision.contextWindow, 200000);
  assert.equal(decision.contradiction, false);
  assert.equal(decision.reserveContradiction, false);
  assert.equal(decision.maxOutput, 16384);
  assert.match(decision.rationale, /configured/);
});

test("probe: readObservedBracket counts a prompt as inputTokens + cacheReadTokens", () => {
  const events = [
    makeEvent(1, "assistant/message", { usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45, cacheReadTokens: 900 } }),
    makeEvent(2, "assistant/message", { usage: { inputTokens: 100, cacheReadTokens: 1036763, outputTokens: 12, totalTokens: 1036875 } }),
    makeEvent(3, "assistant/attempt", { failure: { code: "INVALID_REQUEST" } }),
  ];
  const bracket = probeMod.readObservedBracket(makeSession(events));
  assert.equal(bracket.maxAcceptedPrompt, 1036863);
  assert.equal(bracket.maxAcceptedSeq, 2);
  assert.equal(bracket.failures, 1, "one assistant/attempt carried a failure");
  assert.equal(bracket.attempts, 1);
  assert.equal(bracket.windowsSeen.length, 0);
});

test("probe: readObservedBracket follows the request/context window", () => {
  const bracket = probeMod.readObservedBracket(makeSession(conversationEvents({ dialogue: 2, live: { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 512000 } })));
  assert.deepEqual(bracket.windowsSeen, [{ contextWindow: 512000, provider: "exampleGateway", model: "DeepSeek-V4.1-Flash" }]);
});

// ---------------------------------------------------------------------------
// engine: summarization
// ---------------------------------------------------------------------------

function engineFixture({ config = {}, services = {}, events = undefined, meter = undefined } = {}) {
  const session = makeSession(events ?? conversationEvents());
  const meterService =
    meter ?? makeMeter(() => measurementOf(pricedNodes(200, 233), 624264));
  const agent = makeAgent(session);
  const engine = new engineMod.CompactionDoctorEngine(
    makeCtx({
      llm: fakeLlm,
      tokenMeter: meterService,
      sessions: { active: () => session },
      ...services,
    }),
    { enabled: true, scaleMode: "meter", ...config },
  );
  return { engine, session, agent, meter: meterService };
}

test("engine: summarize splits an oversized region into contiguous chunks and merges the parts", async () => {
  const { engine, agent } = engineFixture({ config: { summaryBudgetRatio: 0.9, maxSummaryChunks: 8, tokensPerByte: 0.34 } });
  // ~200 KB of messages: far beyond the 878,182-token summary budget at 0.34 tok/byte.
  const messages = [];
  for (let i = 0; i < 30; i += 1) messages.push({ role: "user", content: "x".repeat(200000), marker: i });
  const output = await engine.summarize({ messages, model: "DeepSeek-V4.1-Flash" }, agent, undefined);
  assert.ok(engine.calls.summarize.length >= 2, `expected chunked summarization, got ${engine.calls.summarize.length} call(s)`);
  assert.equal(engine.doctorStats.chunkedRegions, 1);
  assert.equal(engine.doctorStats.chunkCalls, engine.calls.summarize.length);
  const text = engineMod.collectText(output);
  assert.equal(text.split("SUMMARY(").length - 1, engine.calls.summarize.length, "every part summary reaches the merge");
  assert.equal(output.blocks.length, 1, "the merge is a single text block");
  assert.deepEqual(output.usage, {
    inputTokens: 10 * engine.calls.summarize.length,
    outputTokens: 4 * engine.calls.summarize.length,
    totalTokens: 14 * engine.calls.summarize.length,
  });
  assert.equal(engine.calls.summarize.reduce((sum, call) => sum + call.count, 0), messages.length, "no message is lost");
});

test("engine: summarize delegates straight through when the region fits the summarizer budget", async () => {
  const { engine, agent } = engineFixture();
  const output = await engine.summarize({ messages: [{ role: "user", content: "short" }, { role: "user", content: "also short" }] }, agent, undefined);
  assert.equal(engine.calls.summarize.length, 1);
  assert.equal(engine.doctorStats.chunkedRegions, 0);
  assert.equal(engineMod.collectText(output), "SUMMARY(2)");
});

test("engine: a single-message region is never chunked", async () => {
  const { engine, agent } = engineFixture();
  await engine.summarize({ messages: [{ role: "user", content: "x".repeat(400000) }] }, agent, undefined);
  assert.equal(engine.calls.summarize.length, 1);
});

test("engine: withMergedText folds the merged text into the first text block and keeps the rest", () => {
  const merged = engineMod.withMergedText({ blocks: [{ type: "text", text: "a" }, { type: "tool", text: "b" }], usage: { inputTokens: 1 } }, "a\n\nb");
  assert.deepEqual(merged.blocks, [{ type: "text", text: "a\n\nb" }, { type: "tool", text: "b" }]);
  assert.deepEqual(merged.usage, { inputTokens: 1 });
  assert.equal(engineMod.collectText({ text: "plain" }), "plain");
  const summed = engineMod.sumUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }, { inputTokens: 4, outputTokens: 5, totalTokens: 9 });
  assert.deepEqual(summed, { inputTokens: 5, outputTokens: 7, totalTokens: 12 });
});

// ---------------------------------------------------------------------------
// engine: compaction paths
// ---------------------------------------------------------------------------

test("engine: meter mode hands the shipped backend a real-scale surface (the k-defect repair)", async () => {
  const raw = measurementOf(pricedNodes(200, 233), 624264);
  const meter = makeMeter(() => raw);
  const events = conversationEvents();
  const session = makeSession(events);
  const agent = makeAgent(session);
  const engine = new engineMod.CompactionDoctorEngine(makeCtx({ llm: fakeLlm, tokenMeter: meter, sessions: { active: () => session } }), { enabled: true, scaleMode: "meter" });
  const result = await engine.compactIfNeeded(agent, "pressure", undefined);
  assert.equal(engine.calls.compactIfNeeded.length, 1, "meter mode delegates to the shipped backend");
  const seen = engine.calls.compactIfNeeded[0].measurement;
  assert.ok(seen.surfaceTokens > 600000, `shipped backend saw ${seen.surfaceTokens} priced tokens`);
  assert.equal(seen.doctorFactor, rescale.scaleFactorOf(raw));
  assert.equal(result.via, "base");
  assert.equal(meter.measure(session), raw, "the scale patch is released when the compaction finishes");
});

test("engine: a page-edited budget switches to the local selection path", async () => {
  // `this.config` is `deepFreeze`d by the shipped base class at mount, so a
  // settings-page edit cannot mutate it. When the page value differs from the
  // row value the engine must use its own selection path, otherwise the edit is
  // a silent no-op. On a fresh install the two agree and the shipped path runs.
  const ctx = makeCtx({ llm: fakeLlm, tokenMeter: makeMeter(() => measurementOf(pricedNodes(20, 500), 10000)), sessions: {} });
  const engine = new engineMod.CompactionDoctorEngine(ctx, {
    enabled: true,
    scaleMode: "meter",
    thresholdRatio: 0.75,
    retainRatio: 0.05,
  });
  assert.equal(engine.doctorConfig().thresholdRatio, 0.75, "the row value is the doctor default");
  assert.equal(engine._doctorOverridesBudgets({ thresholdRatio: 0.75, retainRatio: 0.05 }), false, "same values: stock path");
  assert.equal(engine._doctorOverridesBudgets({ thresholdRatio: 0.9, retainRatio: 0.05 }), true, "page edit: local path");
  assert.equal(engine._doctorOverridesBudgets({ retainRatio: 0.2 }), true, "either key is enough");
  assert.equal(engine._doctorOverridesBudgets({}), false, "no page values: stock path");
  assert.equal(engine._doctorOverridesBudgets({ thresholdRatio: 0.75 }), false, "undefined row value never diverges");
});

test("engine: select mode shadows a real-scale head and never asks the summarizer for more than the budget", async () => {
  const raw = measurementOf(pricedNodes(200, 233), 930386);
  const meter = makeMeter(() => raw);
  const session = makeSession(conversationEvents());
  const agent = makeAgent(session);
  const engine = new engineMod.CompactionDoctorEngine(makeCtx({ llm: fakeLlm, tokenMeter: meter, sessions: { active: () => session } }), {
    enabled: true,
    scaleMode: "select",
    thresholdRatio: 0.75,
    headroomTokens: 65536,
    retainRatio: 0.05,
    maxTokens: 65536,
  });
  const result = await engine.compactIfNeeded(agent, "pressure", undefined);
  assert.equal(engine.doctorStats.selectRuns, 1);
  assert.equal(engine.calls.compactIfNeeded.length, 0, "the shipped selection must not run when the doctor selected a range");
  assert.equal(engine.calls.compactRegion.length, 1);
  const { start, end } = engine.calls.compactRegion[0];
  assert.equal(start, 1, "the head starts at the first surface node");
  assert.equal(end, 160, "the head stops where the 746,454-token select cap is reached");
  assert.deepEqual(result, { via: "region", start: 1, end: 160 });
});

test("engine: select mode falls back to the shipped path when no cut is tool-pairing balanced", async () => {
  const raw = measurementOf(pricedNodes(20, 5000), 2000000);
  const meter = makeMeter(() => raw);
  const session = makeSession(conversationEvents());
  session.__balance = { before: () => false, after: () => false };
  const agent = makeAgent(session);
  const engine = new engineMod.CompactionDoctorEngine(makeCtx({ llm: fakeLlm, tokenMeter: meter, sessions: { active: () => session } }), {
    enabled: true,
    scaleMode: "select",
    thresholdRatio: 0.75,
    headroomTokens: 65536,
    retainRatio: 0.05,
    maxTokens: 65536,
  });
  const result = await engine.compactIfNeeded(agent, "pressure", undefined);
  assert.equal(engine.doctorStats.selectRuns, 0);
  assert.equal(engine.calls.compactIfNeeded.length, 1, "the shipped path is the fallback");
  assert.equal(result.via, "base");
});

test("engine: nothing is shadowed while the surface stays under the pressure threshold", async () => {
  const raw = measurementOf(pricedNodes(200, 233), 624264);
  const meter = makeMeter(() => raw);
  const session = makeSession(conversationEvents());
  const engine = new engineMod.CompactionDoctorEngine(makeCtx({ llm: fakeLlm, tokenMeter: meter, sessions: { active: () => session } }), {
    enabled: true,
    scaleMode: "select",
    thresholdRatio: 0.75,
    headroomTokens: 65536,
    retainRatio: 0.05,
    maxTokens: 65536,
  });
  const result = await engine.compactIfNeeded(makeAgent(session), "pressure", undefined);
  assert.equal(result, null);
  assert.equal(engine.calls.compactRegion.length, 0);
  assert.equal(engine.calls.compactIfNeeded.length, 0);
  assert.equal(engine.doctorStats.selectRuns, 0);
});

test("engine: an unclosed compaction marker suppresses further auto compaction", async () => {
  const events = conversationEvents();
  events.push(makeEvent(20, "compaction/start", { trigger: "pressure" }));
  events.push(makeEvent(21, "compaction/summary", {}));
  const { engine, session, agent } = engineFixture({ config: { scaleMode: "select" } , events});
  const active = engine._hasActiveCompaction(session);
  assert.equal(active, true);
  const result = await engine.compactIfNeeded(agent, "pressure", undefined);
  assert.equal(result.via, "base", "the guard path delegates to the shipped backend");
  assert.equal(engine.calls.compactRegion.length, 0);
});

test("engine: the balance trimmer snaps both borders to tool-pairing-safe surface seqs", () => {
  const { engine, session } = engineFixture({ config: { scaleMode: "select" } });
  session.__balance = { before: (seq) => seq === 5, after: (seq) => seq === 12 };
  const nodes = pricedNodes(20, 100, 1).map((node) => ({ seq: node.seq, tokens: node.tokens }));
  const trimmed = engine._trimToBalancedCuts(session, nodes, { startIndex: 0, endIndex: 19 });
  assert.deepEqual(trimmed, { startSeq: 5, endSeq: 12 }, "the trimmer reports surface seqs only");
  session.__balance = { before: (seq) => seq === 1, after: () => false };
  assert.equal(engine._trimToBalancedCuts(session, nodes, { startIndex: 0, endIndex: 19 }), undefined);
});

test("engine: the probe row keeps the last word on doctor-owned settings", () => {
  const raw = measurementOf(pricedNodes(20, 500), 10000);
  const probe = { config: { scaleMode: "meter", tokensPerByte: 0.5 }, resolved: { contextWindow: 999 } };
  const engine = new engineMod.CompactionDoctorEngine(
    makeCtx({ llm: fakeLlm, tokenMeter: makeMeter(() => raw), compactionDoctor: probe }),
    { enabled: true, scaleMode: "select", summaryBudgetRatio: 0.7 },
  );
  const doctor = engine.doctorConfig();
  assert.equal(doctor.scaleMode, "meter", "the probe row overrides the engine row");
  assert.equal(doctor.tokensPerByte, 0.5);
  assert.equal(doctor.summaryBudgetRatio, 0.7, "the engine row supplies keys the probe row leaves unset");
  assert.equal(doctor.maxSummaryChunks, surfaceMod.DOCTOR_DEFAULTS.maxSummaryChunks, "defaults survive both layers");
});

test("engine: manual compaction propagates ManualCompactionError untouched", async () => {
  const raw = measurementOf(pricedNodes(200, 233), 624264);
  const meter = makeMeter(() => raw);
  const session = makeSession(conversationEvents());
  const agent = makeAgent(session);
  const engine = new engineMod.CompactionDoctorEngine(makeCtx({ llm: fakeLlm, tokenMeter: meter, sessions: { active: () => session } }), {
    enabled: true,
    scaleMode: "meter",
    __test: { throwingManual: true },
  });
  await assert.rejects(() => engine.compactNow(agent, undefined, "cmd-1"), (error) => error instanceof compactionStub.ManualCompactionError && error.code === "busy");
  assert.equal(engine.calls.compactNow.length, 1);
  assert.equal(meter.measure(session), raw, "the scale patch is released after a failed manual compaction");
});

test("engine: stop() releases the meter patch", () => {
  const raw = measurementOf(pricedNodes(20, 500), 10000);
  const meter = makeMeter(() => raw);
  const engine = new engineMod.CompactionDoctorEngine(makeCtx({ llm: fakeLlm, tokenMeter: meter }), { enabled: true, scaleMode: "meter" });
  assert.equal(rescale.meterPatchState(engine.ctx).patched, true);
  engine.stop();
  assert.equal(rescale.meterPatchState(engine.ctx).patched, false);
});

// ---------------------------------------------------------------------------
// engine: overflow recovery hook
// ---------------------------------------------------------------------------

test("engine: the real DashScope 400 triggers one compaction and one retry", async () => {
  const raw = measurementOf(pricedNodes(200, 233), 930386);
  const meter = makeMeter(() => raw);
  const session = makeSession(conversationEvents());
  const agent = makeAgent(session);
  const ctx = makeCtx({ llm: fakeLlm, tokenMeter: meter, sessions: { active: () => session } });
  const engine = new engineMod.CompactionDoctorEngine(ctx, { enabled: true, scaleMode: "meter", maxOverflowRetries: 2, __test: { advanceGeneration: true } });
  const result = await ctx.emit("agent/request-error", { agent, failure: DASHSCOPE_400, signal: undefined });
  assert.deepEqual(result, { kind: "retry" });
  assert.equal(engine.calls.compactIfNeeded.length, 1);
  assert.equal(engine.calls.compactIfNeeded[0].trigger, "context-overflow");
  assert.equal(engine.doctorStats.classifications, 1);
  assert.equal(engine.doctorStats.classificationRetries, 1);
});

test("engine: branded overflow codes, aborted signals and exhausted budgets fall through", async () => {
  const raw = measurementOf(pricedNodes(20, 500), 10000);
  const meter = makeMeter(() => raw);
  const session = makeSession(conversationEvents());
  const agent = makeAgent(session);
  const ctx = makeCtx({ llm: fakeLlm, tokenMeter: meter, sessions: { active: () => session } });
  const engine = new engineMod.CompactionDoctorEngine(ctx, { enabled: true, scaleMode: "meter", maxOverflowRetries: 0, __test: { advanceGeneration: true } });
  assert.equal(await ctx.emit("agent/request-error", { agent, failure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "branded" } }), undefined);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await ctx.emit("agent/request-error", { agent, failure: DASHSCOPE_400, signal: aborted.signal }), undefined);
  assert.equal(await ctx.emit("agent/request-error", { agent, failure: { code: 429, message: "rate limited" } }), undefined);
  assert.equal(engine.calls.compactIfNeeded.length, 0);
  const exhausted = new engineMod.CompactionDoctorEngine(makeCtx({ llm: fakeLlm, tokenMeter: meter, sessions: { active: () => session } }), { enabled: true, scaleMode: "meter", maxOverflowRetries: 1, __test: { advanceGeneration: true } });
  const ctxEx = exhausted.ctx;
  assert.deepEqual(await ctxEx.emit("agent/request-error", { agent, failure: DASHSCOPE_400 }), { kind: "retry" });
  assert.equal(await ctxEx.emit("agent/request-error", { agent, failure: DASHSCOPE_400 }), undefined, "the retry budget is spent");
  assert.equal(exhausted._overflowRetries.get(agent), 1);
  // Authoritative host shape: `ctx.on("session/event", (session, event) => …)`.
  await ctxEx.emitEvent("session/event", session, { type: "assistant/message" });
  assert.equal(exhausted._overflowRetries.get(agent), undefined, "a delivered message resets the budget");
  // A single-parameter listener would keep the budget: the session object is not
  // the event, so `event.type` is undefined and the reset never happens.
  exhausted._overflowRetries.set(agent, 1);
  await ctxEx.emitEvent("session/event", { agent, event: { type: "assistant/message" } }, undefined);
  assert.equal(exhausted._overflowRetries.get(agent), 1, "the legacy single-argument payload must not reset the budget");
});

// ---------------------------------------------------------------------------
// probe service end to end
// ---------------------------------------------------------------------------

test("probe service: registers /compact-doctor and reports the reconciled window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-home-"));
  const profileDir = path.join(dir, "profiles", "desktop");
  fs.mkdirSync(profileDir, { recursive: true });
  const patchFile = path.join(profileDir, "cordis.patch.yml");
  fs.writeFileSync(patchFile, PROFILE_PATCH.join("\n"), "utf8");
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const session = makeSession([
      ...conversationEvents({ dialogue: 2, live: { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 512000 } }),
      makeEvent(50, "assistant/message", { usage: { inputTokens: 100, cacheReadTokens: 1036763, outputTokens: 12, totalTokens: 1036875 } }),
    ]);
    const commands = { registrations: [], register(registration) { commands.registrations.push(registration); return { dispose() {} }; } };
    const ctx = makeCtx({ llm: fakeLlm, sessions: { active: () => session }, commands });
    const doctor = new probeMod.CompactionDoctor(ctx, {
      enabled: true,
      provider: "exampleGateway",
      model: "DeepSeek-V4.1-Flash",
      providerEntryId: "llm-pi-ai",
      writeConfig: true,
      probeOnStart: false,
      baseURL: "http://127.0.0.1:1/v1",
      capMaxTokens: 65536,
      activeProbe: false,
    });
    assert.equal(doctor.commandRegistered, true);
    assert.equal(commands.registrations.length, 1);
    assert.equal(commands.registrations[0].name, "compact-doctor");
    const outcome = await commands.registrations[0].handler({ agent: makeAgent(session), signal: undefined });
    assert.equal(outcome.kind, "success", outcome.text);
    assert.match(outcome.text, /verdict\s+contextWindow=1,048,576/);
    assert.match(outcome.text, /contradiction/);
    assert.equal(doctor.resolved.contextWindow, 1048576);
    assert.equal(doctor.resolved.maxOutput, 65536);
    const after = fs.readFileSync(patchFile, "utf8");
    assert.ok(after.includes("              contextWindow: 1048576"), "the profile patch is repaired");
    assert.ok(after.includes("              maxTokens: 65536"));
    assert.ok(fs.readdirSync(profileDir).some((name) => name.includes(".bak-")), "a backup was written next to the patch");
    const report = doctor.lastReport;
    assert.equal(report.written.ok, true);
    assert.equal(report.written.used, "file");
    const second = await doctor.run({ session, write: true });
    assert.equal(second.written.ok, false, "re-running against the repaired file reports nothing to change");
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("probe service: writeConfig disabled reports the refusal instead of touching the profile", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-home-"));
  const profileDir = path.join(dir, "profiles", "desktop");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), PROFILE_PATCH.join("\n"), "utf8");
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const session = makeSession(conversationEvents({ dialogue: 2, live: { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 512000 } }));
    const doctor = new probeMod.CompactionDoctor(makeCtx({ llm: fakeLlm, sessions: { active: () => session } }), {
      enabled: true,
      provider: "exampleGateway",
      model: "DeepSeek-V4.1-Flash",
      providerEntryId: "llm-pi-ai",
      writeConfig: false,
      probeOnStart: false,
      baseURL: "http://127.0.0.1:1/v1",
    });
    const report = await doctor.run({ session, write: true });
    assert.equal(report.written.ok, false);
    assert.match(report.written.reason, /writeConfig is disabled/);
    assert.equal(fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8"), PROFILE_PATCH.join("\n"));
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("probe service: the config editor is preferred when the harness exposes one", async () => {
  const edits = [];
  const editor = {
    async entries() {
      return [{ id: "llm-pi-ai" }];
    },
    async edit(entry, mutate) {
      edits.push({ entry, next: mutate({ providers: { exampleGateway: { models: [{ id: "DeepSeek-V4.1-Flash", contextWindow: 512000, maxTokens: 384000 }] } } }) });
      return { applied: true };
    },
  };
  const session = makeSession(conversationEvents({ dialogue: 2, live: { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 200000 } }));
  const doctor = new probeMod.CompactionDoctor(makeCtx({ llm: fakeLlm, sessions: { active: () => session }, configEditor: editor }), {
    enabled: true,
    provider: "exampleGateway",
    model: "DeepSeek-V4.1-Flash",
    providerEntryId: "llm-pi-ai",
    writeConfig: true,
    probeOnStart: false,
    baseURL: "http://127.0.0.1:1/v1",
    capMaxTokens: 65536,
  });
  const report = await doctor.run({ session, write: true });
  assert.equal(edits.length, 1);
  assert.equal(report.written.used, "configEditor");
  assert.equal(edits[0].next.providers.exampleGateway.models[0].contextWindow, 1048576);
});

test("probe service: report text renders every decision line", () => {
  const text = probeMod.formatReport({
    at: "2026-10-29T22:00:00.000Z",
    route: { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 512000, source: "request/context" },
    configured: { contextWindow: 512000, maxOutput: 384000 },
    observed: OBSERVED,
    decision: {
      contextWindow: 1048576,
      maxOutput: 65536,
      ceiling: 1036863,
      contradiction: true,
      reserveContradiction: false,
      winner: { source: "adapter catalog" },
      candidates: [
        { source: "configured", contextWindow: 512000 },
        { source: "adapter catalog", contextWindow: 1048576 },
      ],
      rationale: "observed traffic exceeds the configured window",
    },
    adapter: { source: "llm.listModels", contextWindow: 1048576 },
    gateway: undefined,
    active: undefined,
    written: { ok: true, used: "file", file: "cordis.patch.yml", backup: "cordis.patch.yml.bak" },
    engine: { mounted: true },
    numbers: plan.computeNumbers({ contextWindow: 1048576, maxOutput: 65536, headroom: 65536, thresholdRatio: 0.75, retainRatio: 0.05, summaryBudgetRatio: 0.9 }),
  });
  assert.match(text, /1,048,576/);
  assert.match(text, /contradiction/);
  assert.match(text, /adapter\s+llm\.listModels -> 1,048,576/);
  assert.match(text, /candidates\s+configured=512,000, adapter catalog=1,048,576/);
  assert.match(text, /windowsSeen=\[1048576,512000\]/);
  assert.match(text, /attempts\s+5 \(failed 5\)/);
  assert.match(text, /cordis\.patch\.yml/);
});

// ---------------------------------------------------------------------------
// probe: event contracts (regressions for the 0.1.0 turn-killing bug)
// ---------------------------------------------------------------------------

test("probe: the pre-step listener forwards the waterfall instead of vetoing it", async () => {
  // `agent/pre-step` is a **waterfall**: `cordis/lib/index.js:317-325` returns the
  // OUTERMOST listener's value, and a listener that neither returns a decision
  // nor calls `next()` vetoes the rest of the chain, including the built-in
  // `{ kind: "enter" }` fallback. The consumers then read `decision.kind` on
  // `undefined` (dsh-agent/lib/index.js:195 and dsh-agent-loop/lib/index.js:930)
  // and the whole turn dies with
  // "Cannot read properties of undefined (reading 'kind')".
  const session = makeSession(conversationEvents());
  const commands = { registrations: [], register(registration) { commands.registrations.push(registration); return { dispose() {} }; } };
  const ctx = makeCtx({ llm: fakeLlm, sessions: { active: () => session }, commands });
  const doctor = new probeMod.CompactionDoctor(ctx, {
    enabled: true,
    probeOnStart: false,
    writeConfig: false,
    baseURL: "http://127.0.0.1:1/v1",
  });
  assert.equal(doctor._lateHookInstalled, true, "the late command hook is installed");
  const builtin = async () => ({ kind: "enter", messages: [] });
  const decision = await ctx.emit(
    "agent/pre-step",
    { agent: makeAgent(session), signal: undefined, messages: [], turn: 1, step: 1 },
    builtin,
  );
  assert.deepEqual(decision, { kind: "enter", messages: [] }, "the built-in fallback must be reached");
});

test("probe: a row Config with volatile fields is what makes the settings namespace", async () => {
  // `ctx.settings.describe()` only projects a row whose schemastery Config carries
  // at least one `.volatile()` field; without one the row is invisible to the
  // settings page and writes fail with "has no volatile fields".
  const schema = probeMod.CompactionDoctor.Config;
  assert.equal(schema?._type, "object");
  const dict = schema._meta.dict;
  const volatile = Object.entries(dict).filter(([, node]) => node?._meta?.volatile === true).map(([key]) => key);
  for (const key of ["enabled", "writeConfig", "scaleMode", "probeOnStart", "capMaxTokens"]) {
    assert.ok(volatile.includes(key), `${key} is page-editable`);
  }
  assert.equal(dict.writeConfig._meta.default, false, "a discovered window is never written on startup");
  assert.ok(Object.keys(dict).includes("provider"), "the row still accepts the route fallback");
  assert.ok(Object.keys(dict).includes("providerEntryId"), "the row still accepts the provider entry id");
});

// ---------------------------------------------------------------------------
// settings-page transport (lib/status.js): the gates are the only thing standing
// between a zero-auth webServer and cross-site writes
// ---------------------------------------------------------------------------

test("status: the endpoint table matches the frozen contract", () => {
  assert.equal(statusMod.matchRoute("GET", "/state"), "state");
  assert.equal(statusMod.matchRoute("POST", "/diagnose"), "diagnose");
  assert.equal(statusMod.matchRoute("POST", "/apply"), "apply");
  assert.equal(statusMod.matchRoute("GET", "/config"), "config");
  assert.equal(statusMod.matchRoute("PUT", "/config"), "writeConfig");
  assert.equal(statusMod.matchRoute("GET", "/backups"), "backups");
  assert.equal(statusMod.matchRoute("POST", "/restore"), "restore");
  assert.equal(statusMod.matchRoute("GET", ""), undefined, "the bare prefix has no endpoint");
  assert.equal(statusMod.matchRoute("DELETE", "/state"), undefined, "the method is part of the key");
  assert.equal(statusMod.matchRoute("POST", "/state"), undefined, "state is read-only");
  // Write endpoints require a JSON body; reads do not.
  for (const name of ["diagnose", "apply", "writeConfig", "restore"]) assert.equal(statusMod.requiresJsonBody(name), true, name);
  for (const name of ["state", "config", "backups"]) assert.equal(statusMod.requiresJsonBody(name), false, name);
});

test("status: every request gate rejects the request it is supposed to", () => {
  const header = "x-compaction-doctor";
  const prefix = "/dsh-compaction-doctor";
  const base = { url: `${prefix}/state`, headers: { host: "127.0.0.1:18532" } };
  assert.match(statusMod.guardRequest(base, header, prefix), /missing x-compaction-doctor header/u);
  assert.equal(
    statusMod.guardRequest({ ...base, headers: { ...base.headers, [header]: "1", "sec-fetch-site": "same-origin" } }, header, prefix),
    undefined,
    "same-origin with the guard header passes",
  );
  assert.match(
    statusMod.guardRequest({ ...base, headers: { ...base.headers, [header]: "1", "sec-fetch-site": "cross-site" } }, header, prefix),
    /cross-site/u,
  );
  assert.match(
    statusMod.guardRequest({ ...base, headers: { ...base.headers, [header]: "1", origin: "https://evil.example" } }, header, prefix),
    /does not match host/u,
  );
  assert.equal(
    statusMod.guardRequest(
      { ...base, headers: { ...base.headers, [header]: "1", origin: "http://127.0.0.1:18532" } },
      header,
      prefix,
    ),
    undefined,
    "a matching Origin passes",
  );
  assert.match(
    statusMod.guardRequest({ ...base, url: "/api/other", headers: { ...base.headers, [header]: "1" } }, header, prefix),
    /outside route prefix/u,
  );
});

test("status: setRowConfigKeys rewrites one row's config in place and leaves every other byte alone", () => {
  const document = [
    "# leading comment stays",
    "- id: llm-pi-ai",
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    "  config:",
    "    providers:",
    "      exampleGateway:",
    "        apiKeyEnv: EXAMPLE_GATEWAY_API_KEY",
    "",
    "- insert:",
    "    - id: compaction-doctor",
    "      name: '@local/dsh-compaction-doctor/probe'",
    "      config:",
    "        enabled: true",
    "        writeConfig: false",
    "",
    "    - id: compaction-doctor-engine",
    "      name: '@local/dsh-compaction-doctor/engine'",
    "",
  ].join("\n");
  const replaceOnly = statusMod.setRowConfigKeys(document, "compaction-doctor", { writeConfig: true });
  assert.equal(replaceOnly.changed, true);
  assert.match(replaceOnly.text, /^ {8}writeConfig: true$/mu, "the existing key is replaced at its own indent");
  assert.ok(replaceOnly.text.includes("enabled: true"), "sibling keys survive");
  assert.ok(replaceOnly.text.includes("# leading comment stays"), "unrelated lines are byte-identical");
  assert.ok(replaceOnly.text.includes("apiKeyEnv: EXAMPLE_GATEWAY_API_KEY"), "another row's config is untouched");

  const withInsert = statusMod.setRowConfigKeys(replaceOnly.text, "compaction-doctor", { scaleMode: "select" });
  assert.equal(withInsert.changed, true);
  assert.match(withInsert.text, /^ {8}scaleMode: select$/mu, "a missing key is inserted inside the same block");

  const created = statusMod.setRowConfigKeys(document, "compaction-doctor-engine", { auto: false });
  assert.equal(created.changed, true);
  assert.match(created.text, /name: '@local\/dsh-compaction-doctor\/engine'\n {6}config:\n {8}auto: false/u, "a config block is created after name");

  const missing = statusMod.setRowConfigKeys(document, "no-such-row", { auto: false });
  assert.equal(missing.changed, false);
  assert.equal(missing.text, document, "an unknown row is a no-op");
  assert.match(missing.reason, /not found/u);

  const same = statusMod.setRowConfigKeys(document, "compaction-doctor", { writeConfig: false });
  assert.equal(same.changed, false, "writing the same value is a no-op");
  assert.equal(same.text, document);
});

test("status: renderScalar quotes only what YAML needs", () => {
  assert.equal(statusMod.renderScalar(true), "true");
  assert.equal(statusMod.renderScalar(0.05), "0.05");
  assert.equal(statusMod.renderScalar("meter"), "meter");
  assert.equal(statusMod.renderScalar("llm-pi-ai"), "llm-pi-ai");
  assert.equal(statusMod.renderScalar("DeepSeek-V4.1-Flash"), "DeepSeek-V4.1-Flash");
  assert.equal(statusMod.renderScalar("a b"), '"a b"');
  assert.equal(statusMod.renderScalar("a: b"), '"a: b"');
});

test("status: the route installs on webServer and serves a real state request", async () => {
  // The transport is the only thing between the settings page and the host, and
  // nothing else in this suite drives it end to end.
  const registered = [];
  const webServer = { register(route) { registered.push(route); return () => {}; } };
  const session = makeSession(conversationEvents());
  const meter = makeMeter(() => measurementOf(pricedNodes(20, 500), 10000));
  const ctx = makeCtx({ llm: fakeLlm, sessions: { active: () => session }, tokenMeter: meter, webServer });
  const doctor = new probeMod.CompactionDoctor(ctx, {
    enabled: true,
    probeOnStart: false,
    writeConfig: false,
    scaleMode: "meter",
    baseURL: "http://127.0.0.1:1/v1",
  });
  assert.equal(doctor._routeRegistered, true, "the doctor reports a live route");
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, "prefix");
  assert.equal(registered[0].path, "/dsh-compaction-doctor");

  const makeRes = () => ({
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(text) {
      this.body = text;
    },
  });

  const ok = makeRes();
  await registered[0].handler(
    { method: "GET", url: "/dsh-compaction-doctor/state", headers: { "x-compaction-doctor": "1", host: "127.0.0.1:18532" } },
    ok,
  );
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(String(ok.headers["content-type"]), /application\/json/u);
  assert.equal(ok.headers["cache-control"], "no-store");
  const payload = JSON.parse(ok.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.host.route, "/dsh-compaction-doctor");
  assert.equal(payload.session.route.provider, "exampleGateway");
  assert.ok(payload.measurement.nodes > 0, "the status card gets real pricing");
  // No compaction service is mounted in this fixture, and the card must say so
  // instead of inventing a scale mode.
  assert.equal(payload.engine.present, false);
  assert.equal(payload.engine.scaleMode, "unknown");
  assert.equal(payload.engine.meterPatched, false);
  // The settings page renders this and nothing else numeric-by-default.
  assert.equal(typeof payload.plain, "object");
  assert.equal(payload.plain.level, "unknown", "no diagnosis has run yet");
  assert.equal(typeof payload.plain.text, "string");
  assert.ok(Array.isArray(payload.plain.detail));

  const forbidden = makeRes();
  await registered[0].handler({ method: "GET", url: "/dsh-compaction-doctor/state", headers: {} }, forbidden);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(JSON.parse(forbidden.body).ok, false);

  const unknown = makeRes();
  await registered[0].handler(
    { method: "GET", url: "/dsh-compaction-doctor/nope", headers: { "x-compaction-doctor": "1" } },
    unknown,
  );
  assert.equal(unknown.statusCode, 404, "an unknown endpoint is not silently served");

  const wrongType = makeRes();
  await registered[0].handler(
    { method: "POST", url: "/dsh-compaction-doctor/diagnose", headers: { "x-compaction-doctor": "1", "content-type": "text/plain" } },
    wrongType,
  );
  assert.equal(wrongType.statusCode, 415, "writes demand a JSON content type");
});

// ---------------------------------------------------------------------------
// bundle surface
// ---------------------------------------------------------------------------

test("bundle: index.js exposes every documented entry point", () => {
  const expected = [
    "CompactionDoctor",
    "CompactionDoctorEngine",
    "COMMAND_ID",
    "COMMAND_NAME",
    "DOCTOR_DEFAULTS",
    "normalizeConfig",
    "formatReport",
    "readObservedBracket",
    "reconcileWindow",
    "rewriteModelWindow",
    "candidateProfilePatches",
    "readProviderSetup",
    "writeProfilePatch",
    "classifyMeasurement",
    "computeNumbers",
    "selectIndexRange",
    "splitByCost",
    "isContextOverflowFailure",
    "failureText",
    "providerAttribution",
    "installScaledMeter",
    "uninstallScaledMeter",
    "meterPatchState",
    "rescaleMeasurement",
    "scaleFactorOf",
    "latestRoute",
    "estimateTokens",
    "readContextWindow",
    // v0.2 settings-page surface
    "VERSION",
    "ROUTE_PREFIX",
    "ROUTE_GUARD_HEADER",
    "BACKUP_TAG",
    "ENGINE_ROW_KEYS",
    "profileDir",
    "listPatchBackups",
    "isBackupInside",
    "guardRequest",
    "installStatusRoute",
    "matchRoute",
    "readJsonBody",
    "renderScalar",
    "requiresJsonBody",
    "sendJson",
    "setRowConfigKeys",
  ];
  for (const name of expected) {
    const value = surfaceMod[name];
    assert.ok(value !== undefined && value !== null, `index.js does not export ${name}`);
  }
  assert.equal(surfaceMod.DOCTOR_DEFAULTS.scaleMode, "meter");
  assert.equal(surfaceMod.DOCTOR_DEFAULTS.overflowRecovery, true);
  assert.equal(util.estimateTokens("abcd", 0.34), 2);
  assert.equal(util.readContextWindow({ top_provider: { context_length: 12345 } }), 12345);
  assert.equal(util.readContextWindow({ context_window: 4096 }), 4096);
  assert.equal(util.latestRoute(makeSession(conversationEvents()), { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash" }).source, "request/context");
  assert.equal(util.latestRoute(makeSession([]), { provider: "exampleGateway" }), undefined);
});

test("bundle: the patch keeps a bare-name row so the browser half is discovered", () => {
  // `dsh-client-modules/lib/index.js:83-89` resolves a Loader row to its package
  // through `exactPackageSpecifier()`, which returns `undefined` for a SUBPATH
  // specifier. A package mounted only through `<name>/probe` is therefore never
  // registered as a browser module: `/plugins/<name>/client.js` 404s and the
  // settings page silently never appears. This is the regression that made the
  // first release look like it had no UI at all.
  const text = fs.readFileSync(path.resolve(here, "..", "..", "cordis.patch.yml"), "utf8");
  const names = [...text.matchAll(/^\s*name:\s*'([^']+)'/gmu)].map((match) => match[1]);
  assert.ok(names.includes("@local/dsh-compaction-doctor"), `no bare-name row: ${names.join(", ")}`);
  assert.ok(names.includes("@local/dsh-compaction-doctor/probe"), "the probe row is still declared");
  assert.ok(names.includes("@local/dsh-compaction-doctor/engine"), "the engine row is still declared");
  assert.ok(text.includes("compaction-basic"), "the shipped backend is still overridden");
  // The bare-name row mounts `lib/index.js`, which must therefore be a harmless
  // no-op plugin: a `default` export would mount a SECOND probe service.
  assert.equal(surfaceMod.default, undefined, "index.js must not export a plugin as default");
  assert.equal(typeof surfaceMod.apply, "function", "index.js is mountable as a no-op host half");
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8"));
  assert.equal(pkg.dsh?.client?.platform, "web", "the browser half is declared");
  assert.equal(pkg.exports?.["./client"], "./lib/client.js", "the ./client export points at the bundle");
});

test("status: the plain verdict is plain language, and leaks no internal vocabulary", () => {
  // `text` is the plain-language fallback carried by the JSON snapshot; the page
  // itself localizes `key` + `params`. Either way it must stay readable to
  // someone who has never heard of scaling, shadowing, budgets or headroom — and
  // it must never mention a control the page does not have.
  const doctor = new probeMod.CompactionDoctor(makeCtx({}), { enabled: true, writeConfig: false });

  const unknown = doctor._plainView(undefined);
  assert.equal(unknown.level, "unknown");
  assert.match(unknown.text, /打开开关/u, "the unknown sentence points at the switch");
  assert.equal(/按钮|点「|点击/.test(unknown.text), false, "and never at a button that no longer exists");

  const ok = doctor._plainView({
    configured: { contextWindow: 1048576, maxOutput: 65536 },
    decision: { contextWindow: 1048576, maxOutput: 65536 },
    route: { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash" },
  });
  assert.equal(ok.level, "ok");
  assert.match(ok.text, /没有发现问题/u);

  const warn = doctor._plainView({
    configured: { contextWindow: 950127, maxOutput: 384000 },
    decision: { contextWindow: 1048576, maxOutput: 65536 },
    route: { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash" },
  });
  assert.equal(warn.level, "warn");
  assert.match(warn.text, /950127/u, "the current value is quoted");
  assert.match(warn.text, /1048576/u, "the suggested value is quoted");
  assert.ok(warn.detail.length <= 3, `at most three detail lines, got ${warn.detail.length}`);
  const shown = [warn.text, ...warn.detail].join(" ");
  assert.ok(shown.includes("65536"), "the output-cap value is named somewhere");
  assert.ok(
    warn.detail.some((line) => line.includes("备份")),
    "the user is told that fixing backs the file up first",
  );

  const banned =
    /threshold|headroom|budget|shadow|scal|ratio|token|policy|namespace|volatile|configForms|revision|meter|select|maxAccepted|contextWindow|maxOutput|maxTokens/iu;
  for (const view of [unknown, ok, warn]) {
    assert.ok(!banned.test(view.text), `internal vocabulary in the verdict: ${view.text}`);
    for (const line of view.detail) assert.ok(!banned.test(line), `internal vocabulary in a detail line: ${line}`);
  }
});

test("probe: a verified write beats the stale session snapshot", () => {
  // A session's recorded route only refreshes on its next request. The settings
  // page re-checks immediately after 「修复」, so without this rule a successful
  // fix would be reported as still-wrong.
  const doctor = new probeMod.CompactionDoctor(makeCtx({}), {
    enabled: true,
    writeConfig: false,
    fallbackContextWindow: 512000,
    capMaxTokens: 65536,
  });
  const stale = { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 950127 };
  assert.equal(doctor._configuredFor(stale).contextWindow, 950127);
  assert.equal(doctor._configuredFor(stale).maxOutput, 65536);
  assert.equal(doctor._configuredFor(undefined).contextWindow, 512000, "no session yet: the fallback stands");

  doctor.written = { contextWindow: 1048576, maxOutput: 65536, at: new Date().toISOString() };
  assert.equal(doctor._configuredFor(stale).contextWindow, 1048576, "the written value wins");
  // And the verdict that reaches the page is therefore a clean bill of health.
  const verdict = doctor._plainView({
    configured: doctor._configuredFor(stale),
    decision: { contextWindow: 1048576, maxOutput: 65536 },
    route: stale,
  });
  assert.equal(verdict.level, "ok");
});

test("probe: the lazy pass only ever looks at the route in use, exactly once", async () => {
  // The requirement in one test: handle the model + provider of the session the
  // user is actually in, lazily, and never sweep the rest of the profile.
  const doctor = new probeMod.CompactionDoctor(makeCtx({}), {
    enabled: true,
    fallbackContextWindow: 512000,
    capMaxTokens: 65536,
  });
  const asked = [];
  doctor.run = async (options) => {
    asked.push(options.route);
    return {
      at: new Date().toISOString(),
      route: options.route,
      configured: { provider: options.route.provider, model: options.route.model, contextWindow: 950127, maxOutput: 384000 },
      observed: {},
      decision: { contextWindow: 1048576, maxOutput: 65536, winner: { source: "adapter" } },
    };
  };
  const writes = [];
  doctor._writeBack = async (args) => {
    writes.push(args);
    return { ok: true, backup: "cordis.patch.yml.bak-test" };
  };

  const routeA = { provider: "p1", model: "m1" };
  const first = await doctor.ensureRoute(routeA);
  assert.equal(first.status, "fixed");
  assert.equal(asked.length, 1, "exactly one probe pass");
  assert.equal(writes.length, 1, "exactly one write");
  assert.deepEqual(writes[0].decision, { contextWindow: 1048576, maxOutput: 65536 });
  assert.equal(doctor.written.contextWindow, 1048576, "the fix is authoritative for later passes");
  assert.equal(doctor.autoState.get("p1\u0000m1").status, "fixed");

  await doctor.ensureRoute(routeA);
  assert.equal(asked.length, 1, "the same route is never looked at twice");

  const routeB = { provider: "p1", model: "m2" };
  await doctor.ensureRoute(routeB);
  assert.equal(asked.length, 2, "a different model in use is looked at when it appears");
  assert.equal(asked[1].model, "m2", "and only that one");
  assert.equal(asked[1].provider, "p1");

  // An already-correct route writes nothing.
  doctor.run = async (options) => ({
    at: new Date().toISOString(),
    route: options.route,
    configured: { provider: options.route.provider, model: options.route.model, contextWindow: 1048576, maxOutput: 65536 },
    observed: {},
    decision: { contextWindow: 1048576, maxOutput: 65536 },
  });
  const writesBefore = writes.length;
  const clean = await doctor.ensureRoute({ provider: "p1", model: "m3" });
  assert.equal(clean.status, "ok");
  assert.equal(writes.length, writesBefore, "nothing was written for a correct row");
});

test("probe: the switch off means the plugin does nothing at all", async () => {
  const doctor = new probeMod.CompactionDoctor(makeCtx({}), { fallbackContextWindow: 512000 });
  assert.equal(doctor.config.enabled, false, "the single switch defaults to off");
  assert.equal(doctor.config.autoRepair, true, "auto repair is on once the switch is on");
  assert.equal(doctor.config.probeOnStart, false, "the v0.2 startup sweep is gone");

  let ran = 0;
  doctor.run = async () => {
    ran += 1;
    return {};
  };
  assert.deepEqual(await doctor.ensureRoute({ provider: "p", model: "m" }), { skipped: "disabled" });
  doctor._lazyCheck(undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ran, 0, "nothing was probed");
  assert.equal(doctor.autoState.size, 0, "no route was remembered");
  assert.deepEqual(doctor._autoStatus(), { key: "auto.off", params: {} });

  const armed = new probeMod.CompactionDoctor(makeCtx({ sessions: { active: () => undefined } }), { enabled: true });
  assert.deepEqual(armed._autoStatus(), { key: "auto.none", params: {} }, "no session yet");
});

test("engine: the single switch (probe row) actually reaches the engine", async () => {
  // The settings page has exactly one control. If this layering breaks, flipping
  // it would change the probe's behavior while compaction stayed untouched — the
  // switch would look broken.
  const make = (extra) =>
    new engineMod.CompactionDoctorEngine(
      makeCtx({
        llm: fakeLlm,
        tokenMeter: makeMeter(() => measurementOf(pricedNodes(200, 233), 930386)),
        sessions: { active: () => makeSession(conversationEvents()) },
        ...extra,
      }),
      { scaleMode: "meter" },
    );

  const off = make({});
  assert.equal(off.doctorConfig().enabled, false, "off by default");
  // With the switch off the engine row must not disable compaction: every
  // override stands down and the shipped engine runs untouched. The doctor
  // contributes nothing of its own — no custom selection, no chunking, no
  // summary requests (that is what the user's "off" has to mean).
  const shipped = await off.compactIfNeeded(makeAgent(makeSession(conversationEvents())), "pressure", undefined);
  assert.equal(off.calls.compactIfNeeded.length, 1, "the shipped backend is the one consulted while the switch is off");
  assert.equal(shipped.via, "base");
  assert.equal(off.doctorStats.selectRuns, 0, "no doctor selection path runs");
  assert.equal(off.doctorStats.chunkedRegions, 0, "no chunking runs");
  assert.equal(off.doctorStats.summarizeCalls, 0, "and no summary is requested at all");

  // The switch writes `enabled` on the probe row; the engine must pick it up.
  const on = make({ compactionDoctor: { config: { enabled: true } } });
  assert.equal(on.doctorConfig().enabled, true, "the probe row's switch wins");
  await on.compactIfNeeded(makeAgent(makeSession(conversationEvents())), "pressure", undefined);
  assert.equal(on.calls.compactIfNeeded.length, 1, "and the shipped backend is then consulted");
});

test("status: the switch is persisted by the plugin, never through the profile patch", async () => {
  // The row is inserted by the bundle patch, so a profile-patch override would
  // have to re-assert `name` and would replace the row's WHOLE config. The
  // switch therefore lives in a file this plugin owns: it takes effect in memory
  // at once (no hot reload needed) and survives a restart.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cdoc-switch-"));
  const before = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = "desktop";
  try {
    const expected = path.join(home, "profiles", "desktop", "compaction-doctor.state.json");
    assert.equal(probeMod.switchStateFile(), expected);
    assert.equal(probeMod.readSwitchState(), undefined, "nothing on disk yet");

    const session = makeSession(conversationEvents());
    const ctx = makeCtx({
      llm: fakeLlm,
      tokenMeter: makeMeter(() => measurementOf(pricedNodes(20, 500), 10000)),
      sessions: { active: () => session },
    });
    const doctor = new probeMod.CompactionDoctor(ctx, { fallbackContextWindow: 512000 });
    assert.equal(doctor.config.enabled, false);
    assert.equal((await doctor.stateSnapshot()).enabled, false);

    const on = await doctor.setEnabled(true);
    assert.equal(on.ok, true);
    assert.equal(on.persisted, true, "the file was written");
    assert.equal(doctor.config.enabled, true, "and memory changed at once");
    assert.equal((await doctor.stateSnapshot()).enabled, true, "GET /state sees it with no reload");
    assert.equal(probeMod.readSwitchState(), true, "it survives a restart");

    // `PUT /config {"enabled":…}` must take the switch path in one shot — no
    // profile patch, no hot reload. This is exactly what used to snap back.
    const viaApi = await doctor.writeConfigPatch({ patch: { enabled: false } });
    assert.equal(viaApi.ok, true, viaApi.error);
    assert.deepEqual(viaApi.results.map((result) => result.route), ["switch-file"]);
    assert.equal(doctor.config.enabled, false);
    assert.equal((await doctor.stateSnapshot()).enabled, false);

    assert.equal((await doctor.setEnabled("yes")).ok, false, "only booleans are accepted");
    assert.equal(doctor.config.enabled, false, "a bad value changes nothing");

    // A fresh instance prefers the stored switch over the row config.
    const again = new probeMod.CompactionDoctor(ctx, { enabled: true });
    assert.equal(again.config.enabled, false, "the stored switch wins over the row config");
  } finally {
    if (before.home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = before.home;
    if (before.profile === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = before.profile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("probe: every config merge is a lattice join, never a spread", () => {
  // I11 in docs/formal.md. A spread lets an absent key erase a lower layer's
  // value — `{...{k:1}, ...{k:undefined}}` is `{k: undefined}` — so the join
  // property is checked over the whole value domain that matters here instead of
  // on a couple of examples.
  const values = [undefined, null, 1, 0, "x", "", false, true];
  // The join's exact statement: `undefined` and `null` BOTH mean "no opinion" in
  // every layer (matching `layer()` in engine.js), so the result is the LAST
  // source that holds an opinion, and absent when none does.
  const holdsOpinion = (value) => value !== undefined && value !== null;
  for (const lower of values) {
    for (const upper of values) {
      const joined = probeMod.mergeDefined({ k: lower }, { k: upper });
      const opinions = [lower, upper].filter(holdsOpinion);
      const expected = opinions.length === 0 ? undefined : opinions[opinions.length - 1];
      assert.equal(joined.k, expected, `join(${String(lower)}, ${String(upper)})`);
      if (expected === undefined) {
        assert.ok(!Object.prototype.hasOwnProperty.call(joined, "k"), "no opinion leaves no key behind");
      }
    }
  }

  // The concrete shape that used to break: the engine row omits a key that only
  // the probe row declares.
  const merged = probeMod.mergeDefined({ summaryBudgetRatio: 0.9, enabled: true }, { enabled: false, thresholdRatio: 0.75 });
  assert.equal(merged.summaryBudgetRatio, 0.9, "an omitted engine-row key must not erase the probe row's value");
  assert.equal(merged.enabled, false, "but a declared value still wins");

  // The same property at both real merge points.
  const doctor = new probeMod.CompactionDoctor(
    makeCtx({ compaction: { config: { headroomTokens: 65536, summaryBudgetRatio: undefined } } }),
    { fallbackContextWindow: 512000, summaryBudgetRatio: 0.77 },
  );
  assert.equal(doctor._policy().summaryBudgetRatio, 0.77, "_policy() keeps what the engine row omits");
  assert.equal(doctor._policy().headroomTokens, 65536, "and lets the engine row override what it declares");

  const normalized = probeMod.normalizeConfig({ enabled: true, provider: undefined, maxSummaryChunks: null });
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.maxSummaryChunks, 8, "null is 'no opinion', not a value");
});

test("harness: no test can ever touch a real profile", () => {
  // The switch is a real write path, so the suite has to be sandboxed or it
  // writes into the machine that runs it. Asserted, not assumed.
  assert.ok(SANDBOX_HOME.startsWith(os.tmpdir()), "the sandbox lives in the temp directory");
  assert.equal(probeMod.profileDir().startsWith(SANDBOX_HOME), true, "profileDir is sandboxed");
  assert.equal(probeMod.switchStateFile().startsWith(SANDBOX_HOME), true, "the switch file is sandboxed");
  const doctor = new probeMod.CompactionDoctor(makeCtx({}), { fallbackContextWindow: 512000 });
  assert.equal(doctor.config.enabled, false, "and a fresh sandbox starts with the switch off");
});

test("probe: nothing provider-specific is baked in — the row is found by provider", () => {
  const text = PROFILE_PATCH.join("\n");
  const byId = probeMod.rewriteModelWindow(text, { providerEntryId: "llm-pi-ai", provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 1048576, maxTokens: 65536 });
  assert.equal(byId.changed, true, byId.reason);

  // With no configured row id the row is located by the provider block it declares.
  const located = probeMod.rewriteModelWindow(text, { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 1048576, maxTokens: 65536 });
  assert.equal(located.changed, true, located.reason);
  assert.equal(located.text, byId.text, "locating by provider and by row id agree byte for byte");

  // A stale id must not stop the search: the id is a hint, the provider is the fact.
  const wrongId = probeMod.rewriteModelWindow(text, { providerEntryId: "no-such-row", provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 1048576, maxTokens: 65536 });
  assert.equal(wrongId.changed, true, "a hint that misses must not defeat the provider search");
  assert.equal(wrongId.text, byId.text);

  // An unknown provider is reported, never guessed.
  const missing = probeMod.rewriteModelWindow(text, { provider: "no-such-provider", model: "DeepSeek-V4.1-Flash", contextWindow: 1, maxTokens: 1 });
  assert.equal(missing.changed, false);
  assert.match(missing.reason, /no-such-provider/);

  // And no deployment-specific value survives as a default.
  const defaults = probeMod.normalizeConfig({});
  for (const key of ["provider", "model", "providerEntryId", "apiKeyEnv", "baseURL"]) {
    assert.equal(defaults[key], undefined, `${key} must not be baked in`);
  }
  assert.equal(probeMod.normalizeConfig({ providerEntryId: "" }).providerEntryId, undefined, "an empty id means 'locate it for me'");

  // The shipped patch carries the overrides as comments only.
  const shipped = fs.readFileSync(path.resolve(here, "..", "..", "cordis.patch.yml"), "utf8");
  const row = shipped.slice(shipped.indexOf("id: compaction-doctor\n"), shipped.indexOf("id: compaction-doctor-engine"));
  for (const key of ["provider", "model", "providerEntryId", "apiKeyEnv"]) {
    assert.equal(new RegExp(`^\\s*${key}\\s*:`, "m").test(row), false, `the shipped patch must not pin ${key}`);
  }
});

// ---------------------------------------------------------------------------
// F1-F6: the repairs that make compaction unable to fail on a gateway
// ---------------------------------------------------------------------------

const learnMod = await import("./lib/learn.js");
// The same module instance `lib/engine.js` extends, so patching its prototype
// reaches the engine's own `super.summarize(...)` / `super.compactIfNeeded(...)`.
const basicStub = await import("@deepseek-ai/dsh-compaction-basic");
const baseProto = basicStub.BasicCompactionEngine.prototype;

/** Swap methods on the shipped stub for the duration of one test. */
async function withPatched(replacements, fn) {
  const saved = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    saved.set(name, baseProto[name]);
    baseProto[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) baseProto[name] = value;
  }
}

/**
 * The **real** summary result shape (`dsh-compaction-basic/lib/index.js:329-337`):
 * `{ summary: [blocks], rawOutput: [blocks], llmStreamCall, provider, model,
 * maxTokens, usage }`. The stub's own `{blocks}` shape is what let the engine's
 * `collectText` look right while every real chunk came back "empty".
 */
function realSummaryShape(original) {
  return async function patchedSummarize(input, agent, signal) {
    const output = await original.call(this, input, agent, signal);
    const count = Array.isArray(input?.messages) ? input.messages.length : 0;
    const text = `SUMMARY(${count})`;
    return {
      summary: [{ type: "text", text }],
      rawOutput: [{ type: "reasoning", text: "thinking about the region" }, { type: "text", text }],
      llmStreamCall: true,
      provider: "exampleGateway",
      model: "DeepSeek-V4.1-Flash",
      maxTokens: 65536,
      usage: output?.usage,
    };
  };
}

/**
 * A session that enforces the host's real surface rules, so a contract
 * violation fails here the way it fails in production:
 *  - surface-eligible events need a surfaceOp marker (`dsh-session:300-313`);
 *  - a replace must cite every shadowed node (`:316-334`);
 *  - the `system/message` at node 0 may only be rewritten by a
 *    `system/message` over exactly that node (`:421-425`);
 *  - a committed replace is what advances `replaceGeneration` (`:465-470`).
 */
function makeRichSession(events, extra = {}) {
  const log = events.map((event) => ({ ...event }));
  const bySeq = new Map(log.map((event) => [event.seq, event]));
  const surface = { nodes: log.map((event) => event.seq), replaceGeneration: 0 };
  const eligible = new Set(["system/message", "user/message", "assistant/message", "developer/message", "tool/result"]);
  const appends = [];
  const session = {
    log,
    surface,
    appends,
    get seq() {
      return log.length;
    },
    eventAt(seq) {
      return bySeq.get(seq);
    },
    requestHeader() {
      return extra.header ?? { config: { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", maxTokens: 65536 } };
    },
    deriveEventMessage(event) {
      return event?.data?.message ?? event?.data ?? null;
    },
    append(type, data, opts) {
      const seq = log.length;
      const event = {
        type,
        seq,
        time: Date.now(),
        data,
        ...(opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
        ...(opts?.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp }),
      };
      const op = event.surfaceOp;
      if (op === undefined) {
        if (eligible.has(type)) throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`);
        log.push(event);
        bySeq.set(seq, event);
        return event;
      }
      if (op === "append") {
        surface.nodes.push(seq);
      } else {
        if (Object.keys(op).length !== 3) throw new Error(`session event "${type}" carries an invalid replace surfaceOp`);
        if (op.startSeq >= seq || op.endSeq >= seq) throw new Error(`surface replace at seq ${seq}: startSeq and endSeq must reference earlier events`);
        const startIdx = surface.nodes.indexOf(op.startSeq);
        const endIdx = surface.nodes.indexOf(op.endSeq);
        if (startIdx === -1 || endIdx === -1) throw new Error("surface replace: seq not found in surface");
        const shadowed = surface.nodes.slice(startIdx, endIdx + 1);
        const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
        const missing = shadowed.filter((item) => sources.includes(item) === false);
        if (missing.length > 0) throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(", ")}`);
        if (startIdx === 0 && bySeq.get(surface.nodes[0])?.type === "system/message" && (type !== "system/message" || shadowed.length !== 1)) {
          throw new Error("surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node");
        }
        surface.nodes.splice(startIdx, endIdx - startIdx + 1, seq);
        surface.replaceGeneration += 1;
      }
      log.push(event);
      bySeq.set(seq, event);
      appends.push(event);
      return event;
    },
  };
  return session;
}

/** A session with a real system head, a request/context route and N messages. */
function richConversation({ messages = 12, tokenPerNode = 40000 } = {}) {
  const events = [
    makeEvent(0, "system/message", { message: { role: "system", content: [{ type: "text", text: "You are DSH." }] } }),
    makeEvent(1, "request/context", { provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", contextWindow: 428917 }),
  ];
  for (let index = 0; index < messages; index += 1) {
    events.push(makeEvent(2 + index, "assistant/message", { usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }));
  }
  const session = makeRichSession(events);
  const meter = makeMeter(() => {
    const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: tokenPerNode }));
    return measurementOf(nodes, nodes.length * tokenPerNode);
  });
  const engine = new engineMod.CompactionDoctorEngine(
    makeCtx({ llm: fakeLlm, tokenMeter: meter, sessions: { active: () => session } }),
    {
      enabled: true,
      scaleMode: "select",
      maxTokens: 65536,
      thresholdRatio: 0.75,
      retainRatio: 0.05,
      // The configured route survives even after a replacement removes the
      // surface's own `request/context` node.
      provider: "exampleGateway",
      model: "DeepSeek-V4.1-Flash",
    },
  );
  return { session, meter, engine, agent: makeAgent(session) };
}

/**
 * A faithful `compactRegion`: summarize first, then commit the replacement —
 * the order the shipped transaction uses
 * (`dsh-compaction-basic/lib/index.js:477-486`). Without this the stub's
 * `compactRegion` could never show whether the surface actually moved.
 */
async function realCompactRegion(start, end, agent, signal) {
  this.calls.compactRegion.push({ start, end });
  const session = agent.session;
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(start);
  const endIdx = nodes.indexOf(end);
  const shadowed = nodes.slice(startIdx, endIdx + 1);
  const input = { messages: shadowed.map((seq) => session.deriveEventMessage(session.eventAt(seq))) };
  await this.summarize(input, agent, signal);
  session.append(
    "user/message",
    { role: "user", id: `test-checkpoint-${start}`, content: [{ type: "text", text: "checkpoint" }] },
    { surfaceOp: { op: "replace", startSeq: start, endSeq: end }, sourceEventSeqs: shadowed },
  );
  return { via: "region", start, end, shadowedSeqs: shadowed, shadowedTokenCount: shadowed.length };
}

/** Every rung floored: the summary, the shipped path and the region all fail. */
function flooredRungs() {
  return {
    summarize: async () => {
      throw new Error("summarization failed on this gateway");
    },
    compactIfNeeded: async () => {
      throw new Error("the shipped path failed too");
    },
    compactRegion: async () => {
      throw new Error("compactRegion refused");
    },
  };
}

/** An agent on a gateway route, for direct `summarize` calls. */
function engineFixtureAgent() {
  return makeAgent(makeSession(conversationEvents()));
}

// --- §7.3 / the recorded regression: the real summary shape -----------------

/**
 * Every F1-F6 test runs against its own profile directory.
 *
 * F5 persists a learned hard window bound per provider/model (that is the whole
 * point of the repair), so without isolation one test's learned bound would
 * silently become another test's window — which is exactly the kind of hidden
 * cross-talk this suite exists to catch.
 */
function testIsolated(name, fn) {
  test(name, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cdoc-f-"));
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      await fn();
    } finally {
      process.env.DSH_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

testIsolated("shape: collectText and withMergedText read the REAL summarize result shape", () => {
  const real = {
    summary: [{ type: "text", text: "TEXT" }],
    rawOutput: [{ type: "reasoning", text: "REASONING" }, { type: "text", text: "TEXT" }],
    llmStreamCall: true,
    usage: { inputTokens: 1 },
  };
  assert.equal(engineMod.collectText(real), "TEXT", "the text lives in the summary array");
  assert.equal(
    engineMod.collectText({ summary: [{ type: "reasoning", text: "ONLY-REASONING" }] }),
    "ONLY-REASONING",
    "with no text block the model's own reasoning is still usable text",
  );
  assert.equal(
    engineMod.collectText({ summary: [{ type: "text", text: "   " }], rawOutput: [{ type: "text", text: "RAW" }] }),
    "RAW",
    "a blank summary block falls through to rawOutput",
  );
  const merged = engineMod.withMergedText(real, "MERGED");
  assert.ok(Array.isArray(merged.summary), "summary must stay an array: the host spreads it into the checkpoint");
  assert.deepEqual(merged.summary, [{ type: "text", text: "MERGED" }], "the first text block carries the merged text");
  assert.deepEqual(merged.rawOutput, real.rawOutput, "and every other field, rawOutput included, survives untouched");
  assert.equal(merged.usage.inputTokens, 1);
  const two = engineMod.withMergedText(
    { summary: [{ type: "text", text: "first" }, { type: "reasoning", text: "kept" }] },
    "MERGED",
  );
  assert.deepEqual(two.summary, [{ type: "text", text: "MERGED" }, { type: "reasoning", text: "kept" }]);
  assert.equal(engineMod.withMergedText({ nothing: true }, "x"), undefined, "an unknown shape is never guessed");
});

testIsolated("shape: a real-shaped chunked summarize merges its parts (the chunkCalls:14 / chunkedRegions:0 regression)", async () => {
  const { engine, agent } = engineFixture({ config: { maxSummaryChunks: 8 } });
  const messages = [];
  for (let index = 0; index < 30; index += 1) messages.push({ role: "user", content: "x".repeat(200000), marker: index });
  const output = await withPatched({ summarize: realSummaryShape(baseProto.summarize) }, () =>
    engine.summarize({ messages, model: "DeepSeek-V4.1-Flash" }, agent, undefined),
  );
  assert.ok(engine.calls.summarize.length >= 2, `expected chunking, got ${engine.calls.summarize.length} call(s)`);
  assert.equal(engine.doctorStats.chunkedRegions, 1, "the region must count as chunked — zero here is the recorded defect");
  assert.equal(engine.doctorStats.merges, 1, "and merged once");
  const text = engineMod.collectText(output);
  assert.equal(text.split("SUMMARY(").length - 1, engine.calls.summarize.length, "every part reaches the merge");
  assert.ok(Array.isArray(output.summary), "the merged result keeps the host's summary-array contract");
  assert.equal(output.blocks, undefined, "and does not invent a foreign shape");
});

testIsolated("shape: the host's own summary failures are benign, and a textless chunk degrades instead of failing", async () => {
  // The two shapes recorded in the field are classified as benign, so neither is
  // ever reported as a compaction error.
  assert.equal(engineMod.isBenignSummaryFailure(new Error("summarization produced no text summary content")), true);
  assert.equal(engineMod.isBenignSummaryFailure(new Error("summary is not smaller than the shadowed content (14756 estimated framed tokens >= 14756)")), true);
  assert.equal(engineMod.isBenignSummaryFailure(new Error("ECONNRESET")), false);
  assert.equal(engineMod.isBenignSummaryFailure(new engineMod.DoctorSummaryUnavailableError("summary", "x")), true);

  const { session, engine, agent } = richConversation();
  const node = session.surface.nodes[1];
  engine.ctx._services.set("toolResultPruner", {
    pruneSession(target) {
      target.append("tool/result", { message: { role: "tool", content: [{ type: "text", text: "stub" }] } }, {
        surfaceOp: { op: "replace", startSeq: node, endSeq: node },
        sourceEventSeqs: [node],
      });
      return { pruned: [{ originalSeq: node }], charsRemoved: 1000 };
    },
  });
  const before = session.surface.replaceGeneration;
  const result = await withPatched(
    {
      // The host's own failure for a summary that carried no text.
      summarize: async () => {
        throw new Error("summarization produced no text summary content");
      },
      compactIfNeeded: async () => {
        throw new Error("summarization produced no text summary content");
      },
      compactRegion: realCompactRegion,
    },
    () => engine.compactIfNeeded(agent, "context-overflow", undefined),
  );
  assert.equal(result.via, "doctor-prune", "a summary with no text descends to the prune rung");
  assert.ok(session.surface.replaceGeneration > before, "and the surface still moves");
  assert.ok(engine.doctorStats.benignSkips >= 1, "the skip is counted as benign");
  assert.equal(engine.doctorStats.lastBenign.rung, "summary");
  assert.equal(engine.doctorStats.lastFailure, undefined, "and nothing is recorded as a failure");
  assert.equal(engine.doctorStats.lastRungFailure, undefined);
});

// --- F1: the adapter's own yardstick, with a hard margin --------------------

testIsolated("F1: the chunk budget is the adapter-priced request minus maxOutput minus the hard margin", async () => {
  const { engine, agent } = engineFixture();
  const numbers = await engine._numbersFor(agent, engine.routeFor(agent), undefined);
  assert.equal(numbers.W, 1048576);
  assert.equal(numbers.summaryReserve, 65536, "the summary call carries the compaction config's own maxTokens");
  assert.equal(numbers.summaryHardMargin, plan.SUMMARY_HARD_MARGIN_TOKENS);
  assert.equal(
    numbers.summaryRequestBudget,
    Math.min(numbers.summaryBudget, numbers.W - numbers.summaryReserve - numbers.summaryHardMargin),
    "the tighter of the shipped summary budget and the adapter ceiling wins",
  );
  const messages = [];
  for (let index = 0; index < 30; index += 1) messages.push({ role: "user", content: "x".repeat(200000), marker: index });
  await withPatched({ summarize: realSummaryShape(baseProto.summarize) }, () => engine.summarize({ messages }, agent, undefined));
  assert.ok(engine.doctorStats.chunkRecords.length >= 2, "chunks were planned");
  for (const record of engine.doctorStats.chunkRecords) {
    const request = record.promptTokensEstimate + plan.SUMMARY_INSTRUCTION_TOKENS;
    assert.ok(
      request + numbers.summaryReserve + numbers.summaryHardMargin <= numbers.W,
      `chunk ${record.index}: ${request} + ${numbers.summaryReserve} + ${numbers.summaryHardMargin} > ${numbers.W}`,
    );
  }
});

testIsolated("F1: a message larger than one chunk is split rather than sent whole (F2)", async () => {
  const { engine, agent } = engineFixture();
  const messages = [{ role: "user", content: [{ type: "text", text: "y".repeat(4000000) }] }, { role: "user", content: "small" }];
  const output = await withPatched({ summarize: realSummaryShape(baseProto.summarize) }, () =>
    engine.summarize({ messages }, agent, undefined),
  );
  assert.ok(engine.calls.summarize.length >= 2, `the oversized message must be cut, got ${engine.calls.summarize.length}`);
  assert.equal(engine.doctorStats.chunkedRegions, 1);
  assert.equal(engineMod.collectText(output).split("SUMMARY(").length - 1, engine.calls.summarize.length);
});

testIsolated("F2: a region no larger than this route's own summaries sends nothing and descends to prune", async () => {
  const { session, engine, agent } = richConversation({ messages: 12, tokenPerNode: 40000 });
  const node = session.surface.nodes[2];
  const pruner = {
    pruneSession(target) {
      target.append("tool/result", { message: { role: "tool", content: [] } }, {
        surfaceOp: { op: "replace", startSeq: node, endSeq: node },
        sourceEventSeqs: [node],
      });
      return { pruned: [{ originalSeq: node }], charsRemoved: 1 };
    },
  };
  engine.ctx._services.set("toolResultPruner", pruner);
  // Teach the engine this route's real summary size: a 1.2 MB checkpoint is
  // ~300k tokens, exactly the recorded `X >= X` shape where re-summarizing a
  // region of the same size cannot possibly shrink it.
  await withPatched(
    { summarize: async () => ({ summary: [{ type: "text", text: "s".repeat(1200000) }], rawOutput: [], usage: undefined }) },
    () => engine.summarize({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] }, agent, undefined),
  );
  assert.ok(engine.doctorStats.summaryCeiling > 280000, `the route's summary size is known (${engine.doctorStats.summaryCeiling})`);
  const calls = engine.calls.summarize.length;
  const result = await engine.compactIfNeeded(agent, "context-overflow", undefined);
  assert.equal(engine.calls.summarize.length, calls, "a request that cannot shrink the region is never issued");
  assert.notEqual(result, null, "the ladder still makes progress");
  assert.equal(result.via, "doctor-prune");
  assert.ok(session.surface.replaceGeneration > 0);
});

// --- F3: node 0 is never inside a replacement range -------------------------

testIsolated("F3: the replacement never starts at the system-prompt node", async () => {
  const { session, engine, agent } = richConversation();
  const nodes = [...session.surface.nodes];
  // The harness enforces the host rule, so this is the production failure.
  assert.throws(
    () =>
      session.append("user/message", { role: "user", content: [{ type: "text", text: "x" }] }, {
        surfaceOp: { op: "replace", startSeq: nodes[0], endSeq: nodes[1] },
        sourceEventSeqs: [nodes[0], nodes[1]],
      }),
    /node 0 holds the system prompt/,
  );
  const result = await withPatched({ compactRegion: realCompactRegion }, () =>
    engine.compactIfNeeded(agent, "context-overflow", undefined),
  );
  assert.notEqual(result, null);
  const replacement = session.appends.find((event) => event.surfaceOp?.op === "replace");
  assert.ok(replacement !== undefined, "a replacement was committed");
  assert.notEqual(replacement.surfaceOp.startSeq, nodes[0], "node 0 must stay out of the range");
  assert.ok(replacement.surfaceOp.startSeq >= nodes[1], "the range starts at the first non-system node");
  assert.ok(session.surface.replaceGeneration > 0);
});

testIsolated("F3: the hard-trim rung keeps the system head and the newest node", async () => {
  const { session, engine, agent } = richConversation({ messages: 12, tokenPerNode: 200000 });
  const nodes = [...session.surface.nodes];
  const result = await withPatched(flooredRungs(), () => engine.compactIfNeeded(agent, "context-overflow", undefined));
  assert.equal(result.via, "doctor-hard-trim");
  const replacement = session.appends.find((event) => event.surfaceOp?.op === "replace");
  assert.notEqual(replacement.surfaceOp.startSeq, nodes[0], "the system head survives");
  assert.equal(session.surface.nodes[0], nodes[0], "node 0 is still the system prompt");
  assert.equal(session.surface.nodes[session.surface.nodes.length - 1], nodes[nodes.length - 1], "the newest node is kept");
  assert.ok(session.surface.replaceGeneration > 0, "and the surface moved");
});

// --- F4: the ladder ---------------------------------------------------------

testIsolated("F4 rung 2: a failed summarization descends to prune-only and still moves the surface", async () => {
  const { session, engine, agent } = richConversation();
  const node = session.surface.nodes[1];
  engine.ctx._services.set("toolResultPruner", {
    pruneSession(target) {
      target.append("tool/result", { message: { role: "tool", content: [{ type: "text", text: "pruned" }] } }, {
        surfaceOp: { op: "replace", startSeq: node, endSeq: node },
        sourceEventSeqs: [node],
      });
      return { pruned: [{ originalSeq: node }], charsRemoved: 9000 };
    },
  });
  const generation = session.surface.replaceGeneration;
  const result = await withPatched(
    { ...flooredRungs(), compactRegion: realCompactRegion },
    () => engine.compactIfNeeded(agent, "context-overflow", undefined),
  );
  assert.equal(result.via, "doctor-prune");
  assert.equal(engine.doctorStats.ladder.runs, 1);
  assert.equal(engine.doctorStats.ladder.descended, 1);
  assert.equal(engine.doctorStats.ladder.prune, 1);
  assert.ok(session.surface.replaceGeneration > generation, "rung 2 must advance replaceGeneration");
});

testIsolated("F4 rung 3: with no prunable node the ladder hard-trims far below the window", async () => {
  const { session, engine, agent } = richConversation({ messages: 14, tokenPerNode: 40000 });
  const result = await withPatched(flooredRungs(), () => engine.compactIfNeeded(agent, "context-overflow", undefined));
  assert.equal(result.via, "doctor-hard-trim");
  assert.equal(engine.doctorStats.ladder.hardTrim, 1);
  assert.ok(session.surface.replaceGeneration > 0);
  const kept = session.surface.nodes.length;
  assert.ok(kept >= 2 && kept < 16, `the trim kept ${kept} of 16 nodes`);
  const numbers = await engine._numbersFor(agent, engine.routeFor(agent), undefined);
  const keptTokens = (kept - 1) * 40000;
  assert.ok(
    keptTokens <= numbers.W * engineMod.DOCTOR_DEFAULTS.hardTrimRatio + 40000,
    `the hard trim must land far below the window (${keptTokens} of ${numbers.W})`,
  );
});

testIsolated("F4 exhaustion: the rungs are counted and named, and the provider's own failure stands", async () => {
  const loud = richConversation();
  // A session that refuses every replacement (no append at all) leaves the
  // ladder with nothing to do: that is the only shape where it yields.
  loud.session.append = () => {
    throw new Error("the session refused the replacement");
  };
  await withPatched(flooredRungs(), async () => {
    const result = await loud.engine.compactIfNeeded(loud.agent, "context-overflow", undefined);
    // The accepted weak form: a named error of ours must NOT replace the
    // provider's own failure (`dsh-llm-retry` and friends read `failure.code`).
    assert.equal(result, null, "the exhausted ladder yields so the original failure survives");
    assert.equal(loud.engine.doctorStats.rungFailures, 1);
    const failure = loud.engine.doctorStats.lastRungFailure;
    assert.equal(failure.trigger, "context-overflow");
    assert.deepEqual(
      failure.rungs.map((entry) => entry.split(":")[0]),
      ["summary", "prune", "hard-trim"],
      "every rung is named",
    );
    assert.equal(failure.outcomes.length, 3, "with its outcome");
    assert.match(failure.message, /compaction-doctor/);
    assert.ok(
      loud.engine.ctx.logger.seen.some(([level, line]) => level === "warn" && /rung ladder exhausted/.test(line) && /summary:/.test(line)),
      "and one warn names the rungs, in the log channel",
    );
  });

  const quiet = richConversation();
  quiet.session.append = () => {
    throw new Error("the session refused the replacement");
  };
  await withPatched(flooredRungs(), async () => {
    const result = await quiet.engine.compactIfNeeded(quiet.agent, "pressure", undefined);
    assert.equal(result, null, "a pressure failure never propagates either (doc §8.13)");
    assert.equal(quiet.engine.doctorStats.rungFailures, 1, "it is counted just the same");
    assert.equal(quiet.engine.doctorStats.lastRungFailure.trigger, "pressure");
  });
});

testIsolated("F4 last resort: an overflow trims even when our own measure says we are already small", async () => {
  // The adapter refused this exact prompt, so our own estimate is under-counting.
  // Doing nothing here is the one outcome that guarantees a dead turn, so the
  // last rung still has to drop something.
  const { session, engine, agent } = richConversation({ messages: 6, tokenPerNode: 1 });
  const nodes = [...session.surface.nodes];
  const result = await withPatched(flooredRungs(), () => engine.compactIfNeeded(agent, "context-overflow", undefined));
  assert.equal(result.via, "doctor-hard-trim", "a refused prompt must never end in a noop");
  assert.ok(session.surface.replaceGeneration > 0, "ADVANCE");
  assert.notEqual(result.shadowedRange.start, nodes[0], "node 0 still stays out of the range");
  assert.ok(result.shadowedSeqs.length >= 1, "something was actually dropped");
  assert.ok(
    session.surface.nodes[session.surface.nodes.length - 1] === nodes[nodes.length - 1],
    "and the newest node is still there",
  );

  // A `pressure` trigger with nothing over target stays a noop, as it should.
  const quiet = richConversation({ messages: 6, tokenPerNode: 1 });
  const outcome = await withPatched(flooredRungs(), () => quiet.engine.compactIfNeeded(quiet.agent, "pressure", undefined));
  assert.equal(outcome, null, "pressure with an empty budget is the shipped engine's own 'nothing to do'");
  assert.equal(quiet.session.surface.replaceGeneration, 0, "and it leaves the surface alone");
});

testIsolated("F4: whenever a reducer exists, the ladder always commits a replacement", async () => {
  // The property the ladder exists for: "the summary is unavailable" may never
  // end in `<noop>`. With a host that accepts a replacement, some rung must
  // always hand back a committed reduce, for every surface shape that is
  // genuinely over the hard-trim target.
  const shapes = [
    { messages: 4, tokenPerNode: 400000 },
    { messages: 10, tokenPerNode: 40000 },
    { messages: 12, tokenPerNode: 200000 },
    { messages: 30, tokenPerNode: 40000 },
    { messages: 2, tokenPerNode: 500000 },
  ];
  for (const shape of shapes) {
    const { session, engine, agent } = richConversation(shape);
    const before = session.surface.replaceGeneration;
    const result = await withPatched(flooredRungs(), () => engine.compactIfNeeded(agent, "context-overflow", undefined));
    assert.equal(result.via, "doctor-hard-trim", `shape ${JSON.stringify(shape)} must hard-trim`);
    assert.ok(session.surface.replaceGeneration > before, `shape ${JSON.stringify(shape)} must ADVANCE`);
    assert.equal(engine.doctorStats.ladder.hardTrim, 1);
  }

  // And with a prunable node the second rung commits first, without a summary.
  const pruned = richConversation({ messages: 8, tokenPerNode: 120000 });
  const node = pruned.session.surface.nodes[1];
  pruned.engine.ctx._services.set("toolResultPruner", {
    pruneSession(target) {
      target.append("tool/result", { message: { role: "tool", content: [] } }, {
        surfaceOp: { op: "replace", startSeq: node, endSeq: node },
        sourceEventSeqs: [node],
      });
      return { pruned: [{ originalSeq: node }], charsRemoved: 500 };
    },
  });
  const result = await withPatched(flooredRungs(), () =>
    pruned.engine.compactIfNeeded(pruned.agent, "context-overflow", undefined),
  );
  assert.equal(result.via, "doctor-prune");
  assert.ok(pruned.session.surface.replaceGeneration > 0, "rung 2 is the cheaper path and it also advances");
  assert.equal(pruned.engine.calls.summarize.length, 0, "and it needs no model call at all");
});

testIsolated("F4: a benign outcome advances the surface and records no error", async () => {
  const { session, engine, agent } = richConversation({ messages: 10, tokenPerNode: 60000 });
  const before = engine.doctorStats.benignSkips;
  const result = await withPatched(
    {
      // Exactly the recorded benign shape: a summary comes back, but it is not
      // smaller than the span it shadows.
      summarize: async () => ({ summary: [{ type: "text", text: "z".repeat(4000) }], rawOutput: [], usage: undefined }),
      compactRegion: realCompactRegion,
    },
    () => engine.compactIfNeeded(agent, "context-overflow", undefined),
  );
  assert.notEqual(result, null, "the ladder still makes progress");
  assert.ok(session.surface.replaceGeneration > 0);
  assert.ok(engine.doctorStats.benignSkips >= before, "benign skips are counted in their own counter");
  assert.equal(engine.doctorStats.lastFailure, undefined, "a benign outcome is never recorded as a failure");
  assert.equal(engine.doctorStats.guardFailures, 0, "and never as a shrink-guard failure");
});

testIsolated("F4: the host's own summary-recovery hook is observed and never livelocked", async () => {
  const { engine } = richConversation();
  assert.equal(engine.doctorStats.summaryErrorEvents, 0);
  const verdict = await engine.ctx.emitEvent("compaction/summary-error", { error: new Error("boom"), session: {} });
  assert.equal(verdict, false, "declining keeps the host's unbounded for(;;) loop from spinning");
  assert.equal(engine.doctorStats.summaryErrorEvents, 1);
});

testIsolated("F4: every chunk attempt is attributed (doc §8.14)", async () => {
  const { engine, agent } = engineFixture();
  const messages = [];
  for (let index = 0; index < 30; index += 1) messages.push({ role: "user", content: "x".repeat(200000), marker: index });
  await withPatched({ summarize: realSummaryShape(baseProto.summarize) }, () => engine.summarize({ messages }, agent, undefined));
  const record = engine.doctorStats.chunkRecords[0];
  assert.equal(record.index, 0);
  assert.equal(record.groups, engine.calls.summarize.length);
  assert.equal(record.textBlocks, 1, "the real shape carries one text block per chunk");
  assert.equal(record.reasoningBlocks, 1);
  assert.ok(record.promptTokensEstimate > 0);
});

// --- F5: an overflow teaches a hard window upper bound ----------------------

testIsolated("F5: the rejected size is written back as a hard upper bound, with a byte-exact backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdoc-bounds-"));
  const file = path.join(dir, "compaction-doctor.window-bounds.json");
  const first = learnMod.learnRejectedWindow({ provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", rejectedTokens: 401588, declaredWindow: 1048576, file });
  assert.equal(first.learned, true);
  assert.equal(first.bound, 401588, "the write-back value is the rejected upper bound, exactly");
  assert.equal(first.effectiveWindow, 401588, "and the window may never exceed it again");
  assert.equal(first.backup, undefined, "the first write has nothing to back up");
  const before = fs.readFileSync(file, "utf8");
  const larger = learnMod.learnRejectedWindow({ provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", rejectedTokens: 900000, declaredWindow: 1048576, file });
  assert.equal(larger.learned, false, "a larger rejection never raises the bound");
  assert.equal(larger.bound, 401588);
  assert.equal(learnMod.listBoundBackups(file).length, 0, "and an unchanged bound rewrites nothing");
  const smaller = learnMod.learnRejectedWindow({ provider: "exampleGateway", model: "DeepSeek-V4.1-Flash", rejectedTokens: 300000, declaredWindow: 1048576, file });
  assert.equal(smaller.bound, 300000, "a smaller rejection lowers it");
  const backups = learnMod.listBoundBackups(file);
  assert.equal(backups.length, 1, "the rewrite backed the previous file up first");
  assert.equal(fs.readFileSync(backups[0].file, "utf8"), before, "and that backup is byte-exact");
  assert.equal(learnMod.readWindowBounds(file).entries["exampleGateway/DeepSeek-V4.1-Flash"], 300000);
  fs.writeFileSync(file, "{ this is not json", "utf8");
  assert.deepEqual(learnMod.readWindowBounds(file).entries, {}, "a corrupt store never reads as a bound of zero");
  fs.rmSync(dir, { recursive: true, force: true });
});

testIsolated("F5: a classified overflow records the bound and the engine plans against it", async () => {
  const session = makeSession(conversationEvents());
  const meter = makeMeter(() => measurementOf(pricedNodes(200, 233), 700000));
  const agent = makeAgent(session);
  const ctx = makeCtx({ llm: fakeLlm, tokenMeter: meter, sessions: { active: () => session } });
  const engine = new engineMod.CompactionDoctorEngine(ctx, { enabled: true, scaleMode: "meter", __test: { advanceGeneration: true } });
  await ctx.emit("agent/request-error", { agent, failure: DASHSCOPE_400, signal: undefined });
  assert.equal(engine.doctorStats.windowLearning.rejectedTokens, 700000);
  assert.equal(engine.doctorStats.windowLearning.bound, 700000);
  assert.equal(engine.doctorStats.windowBound, 700000);
  assert.equal(learnMod.readWindowBounds().entries["exampleGateway/DeepSeek-V4.1-Flash"], 700000, "and it is persisted");
  const numbers = await engine._numbersFor(agent, engine.routeFor(agent), undefined);
  assert.equal(numbers.W, 700000, "the declared 1 MiB window is capped by what the provider refused");
});

// --- F6: the gateway gets the repairs, the official route gets nothing ------

testIsolated("F6: `declared` decides — a declared gateway is repaired, an official route is left alone", async () => {
  const llmWithDirectory = (declared) => ({
    ...fakeLlm,
    listConfigurableProviders() {
      return [{ provider: "exampleGateway", displayName: "exampleGateway", settingsNs: "llm-pi-ai", settingsPath: ["providers", "exampleGateway"], declared }];
    },
  });
  const build = (llm) => {
    const session = makeSession(conversationEvents());
    const engine = new engineMod.CompactionDoctorEngine(
      makeCtx({ llm, tokenMeter: makeMeter(() => measurementOf(pricedNodes(200, 233), 930386)), sessions: { active: () => session } }),
      { enabled: true, scaleMode: "select" },
    );
    return { engine, agent: makeAgent(session) };
  };
  const messages = [];
  for (let index = 0; index < 30; index += 1) messages.push({ role: "user", content: "x".repeat(200000) });

  const gateway = build(llmWithDirectory(true));
  assert.equal(gateway.engine.inertReason(gateway.agent), undefined, "declared: true is a third-party gateway");
  await withPatched({ summarize: realSummaryShape(baseProto.summarize) }, () => gateway.engine.summarize({ messages }, gateway.agent, undefined));
  assert.equal(gateway.engine.doctorStats.chunkedRegions, 1, "a declared provider gets the full repair");

  const official = build(llmWithDirectory(false));
  assert.match(official.engine.inertReason(official.agent), /official route/, "declared: false means the shipped catalog owns the route");
  const output = await withPatched({ summarize: realSummaryShape(baseProto.summarize) }, () =>
    official.engine.summarize({ messages }, official.agent, undefined),
  );
  assert.equal(official.engine.doctorStats.chunkedRegions, 0, "and nothing is chunked for it");
  assert.equal(official.engine.calls.summarize.length, 1, "the region goes out exactly as the shipped engine would send it");
  assert.equal(official.engine.calls.summarize[0].count, 30);
  assert.deepEqual(output.summary, [{ type: "text", text: "SUMMARY(30)" }]);
});

testIsolated("F6: the switch off and scaleMode off leave every override inert, including summarize", async () => {
  const messages = [];
  for (let index = 0; index < 30; index += 1) messages.push({ role: "user", content: "x".repeat(200000) });
  for (const config of [{ enabled: false, scaleMode: "meter" }, { enabled: true, scaleMode: "off" }]) {
    const session = makeSession(conversationEvents());
    const engine = new engineMod.CompactionDoctorEngine(
      makeCtx({ llm: fakeLlm, tokenMeter: makeMeter(() => measurementOf(pricedNodes(200, 233), 930386)), sessions: { active: () => session } }),
      config,
    );
    const agent = makeAgent(session);
    assert.ok(typeof engine.inertReason(agent) === "string", `${JSON.stringify(config)} must stand the engine down`);
    const output = await withPatched({ summarize: realSummaryShape(baseProto.summarize) }, () => engine.summarize({ messages }, agent, undefined));
    assert.equal(engine.doctorStats.chunkedRegions, 0, "no chunking happens while the engine is inert");
    assert.equal(engine.calls.summarize.length, 1, "the summary goes out exactly once, as the host built it");
    assert.deepEqual(output.summary, [{ type: "text", text: "SUMMARY(30)" }]);
    const compacted = await engine.compactIfNeeded(agent, "context-overflow", undefined);
    assert.equal(compacted.via, "base", "and compactIfNeeded is the shipped one");
    assert.equal(engine.doctorStats.selectRuns, 0);
    assert.equal(engine.doctorStats.ladder.runs, 0, "no ladder runs at all");
  }
});

// ---------------------------------------------------------------------------
// task-15: the host half must mount on the real host
// ---------------------------------------------------------------------------

/**
 * A context with cordis's real `get` semantics: `ctx.get(name)` **throws** for a
 * service that is not mounted (`cordis/lib/index.js:763` `get(name, strict = true)`),
 * `inject(names, cb)` runs the callback when those services appear, and `effect`
 * drives generators.
 */
function makeHostCtx({ services = {}, provide = [], strict = true } = {}) {
  const listeners = new Map();
  const injections = [];
  const ctx = {
    logger: makeLogger(),
    _services: new Map(Object.entries(services)),
    get(name) {
      if (ctx._services.has(name)) return ctx._services.get(name);
      if (strict) throw new Error(`cannot get property "${name}" without it being provided`);
      return undefined;
    },
    provide(name, value) {
      ctx._services.set(name, value);
      for (const injection of [...injections]) {
        if (injection.names.every((required) => ctx._services.has(required))) {
          injections.splice(injections.indexOf(injection), 1);
          injection.callback(ctx);
        }
      }
    },
    on(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
      return () => {};
    },
    effect(generator) {
      const iterator = generator();
      let step = iterator.next();
      while (step.done !== true) step = iterator.next();
      return () => {};
    },
    async emitEvent(type, ...args) {
      let result;
      for (const handler of listeners.get(type) ?? []) result = await handler(...args);
      return result;
    },
    __injections: injections,
  };
  for (const injection of provide) injections.push(injection);
  return ctx;
}

/** A web server stub that records what it was asked to serve. */
function makeWebServer(routes) {
  return {
    register(route) {
      routes.push({ kind: route.kind, path: route.path, handler: route.handler });
      return () => {};
    },
  };
}

/** The doctor capabilities the transport requires. */
function makeDoctorStub() {
  return {
    stateSnapshot: async () => ({ ok: true, version: "test" }),
    diagnose: async () => ({}),
    applyFix: async () => ({ ok: true }),
    readConfigView: async () => ({}),
    writeConfigPatch: async () => ({ ok: true }),
    listBackups: async () => [],
    restoreBackup: async () => ({ ok: true }),
  };
}

testIsolated("task-15: the settings route survives a web server that mounts AFTER us (the live 404)", async () => {
  const routes = [];
  const ctx = makeHostCtx({});
  ctx.inject = (names, callback) => {
    ctx.__injections.push({ names: [...names], callback });
  };
  const doctor = makeDoctorStub();
  // 1. No web server yet: the route is deferred, not abandoned.
  const first = statusMod.installStatusRoute(ctx, doctor, { prefix: "/dsh-compaction-doctor", headerName: "x-compaction-doctor" });
  assert.equal(first.installed, false);
  assert.equal(first.deferred, true, "a missing web server must defer, never silently give up");
  assert.equal(routes.length, 0);
  assert.equal(ctx.__injections.length, 1, "exactly one deferred registration was armed");

  // 2. The web server row finishes importing and provides the service.
  ctx.provide("webServer", makeWebServer(routes));
  assert.equal(routes.length, 1, "the route registers the moment the service appears");
  assert.equal(routes[0].kind, "prefix");
  assert.equal(routes[0].path, "/dsh-compaction-doctor");

  // 3. And it then answers the settings page's own request.
  const answered = [];
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { answered.push({ status: this.statusCode, body }); },
  };
  await routes[0].handler({ method: "GET", url: "/dsh-compaction-doctor/state", headers: { "x-compaction-doctor": "1" } }, res);
  assert.equal(answered[0].status, 200, "the deferred route serves GET /state");
  assert.match(answered[0].body, /"ok":true/);

  // 4. The probe's own entry point must not arm a second registration: on this
  //    host a duplicate prefix route throws inside the web server.
  const lateRoutes = [];
  const lateCtx = makeHostCtx({});
  lateCtx.inject = (names, callback) => {
    lateCtx.__injections.push({ names: [...names], callback });
  };
  const lateDoctor = new probeMod.CompactionDoctor(lateCtx, { enabled: true });
  assert.equal(lateRoutes.length, 0);
  lateDoctor._registerRoute(lateCtx);
  lateDoctor._registerRoute(lateCtx);
  assert.equal(lateCtx.__injections.length, 1, "repeat calls are settled, never double-armed");
  lateCtx.provide("webServer", makeWebServer(lateRoutes));
  assert.equal(lateRoutes.length, 1, "and the deferred registration fires exactly once");
});

testIsolated("task-15: a host missing the APIs we touch still mounts the plugin (no throw, no silent death)", async () => {
  const routes = [];
  // A hostile context: strict `get` that throws for everything unknown, no
  // `inject`, no `effect`, no host services at all.
  const bare = {
    logger: makeLogger(),
    get(name) { throw new Error(`cannot get property "${name}" without it being provided`); },
  };
  const result = statusMod.installStatusRoute(bare, makeDoctorStub(), { prefix: "/p", headerName: "h" });
  assert.equal(result.installed, false);
  assert.equal(result.deferred, undefined, "a host with no ctx.inject cannot defer; it reports instead");
  assert.match(result.reason, /no ctx\.inject|unavailable/);
  assert.equal(routes.length, 0);

  // The probe row itself: every host service it reaches for is absent.
  const doctorService = new probeMod.CompactionDoctor(makeHostCtx({}), { enabled: true });
  assert.ok(doctorService !== undefined, "the doctor service still constructs");
  const snapshot = await doctorService.stateSnapshot({ signal: undefined });
  assert.equal(snapshot.ok, true, "and still answers the settings page");

  // The engine row: no tokenMeter, no llm, no sessions.
  const engine = new engineMod.CompactionDoctorEngine(makeHostCtx({}), { enabled: true });
  assert.ok(engine !== undefined, "the engine service still constructs");
  assert.equal(engine.diagnostics().engine, "compaction-doctor", "and still reports diagnostics");
  assert.ok(
    engine.doctorStats.notes.some((note) => /meter/i.test(note)),
    `the missing meter is recorded, not thrown: ${JSON.stringify(engine.doctorStats.notes)}`,
  );
});

/**
 * The load-time rule this plugin must never violate, reimplemented from
 * `dsh-session-format-v3-to-v4/lib/index.js:731-738` (`span()`): a
 * `compaction/summary` / `compaction/prune` record may not shadow the protected
 * system head — not in `shadowedSeqs`, not as a `shadowedRange` endpoint. The
 * validator has no exemption for a failed transaction, so one such record makes
 * the whole session unloadable.
 */
function assertLogLoadable(events, protectedHead) {
  for (const event of events) {
    if (event.type !== "compaction/summary" && event.type !== "compaction/prune") continue;
    const seqs = Array.isArray(event.data?.shadowedSeqs) ? event.data.shadowedSeqs : [];
    const range = event.data?.shadowedRange ?? {};
    if (seqs.includes(protectedHead) || range.start === protectedHead || range.end === protectedHead) {
      throw new Error(`SessionFormatError: compaction cannot shadow the protected system head (record ${event.seq})`);
    }
  }
  return true;
}

/** The host's own commit order (`dsh-compaction-basic:628-661`): record, then replace. */
async function commitLikeHost(start, end, agent) {
  const session = agent.session;
  const nodes = session.surface.nodes;
  const shadowed = nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1);
  session.append("compaction/summary", { shadowedRange: { start, end }, shadowedSeqs: shadowed, summary: [{ type: "text", text: "s" }] });
  session.append("user/message", { role: "user", content: [{ type: "text", text: "checkpoint" }] }, {
    surfaceOp: { op: "replace", startSeq: start, endSeq: end },
    sourceEventSeqs: shadowed,
  });
  return { via: "region", start, end };
}

testIsolated("task-15: compactRegion is the single gate — a head-addressed range is shifted, not committed", async () => {
  const { session, engine, agent } = richConversation();
  const head = session.surface.nodes[0];
  const next = session.surface.nodes[1];
  assert.equal(session.eventAt(head).type, "system/message", "the harness really has a protected head");

  // A caller that gets the range wrong — the shape a future rung could produce.
  const result = await withPatched({ compactRegion: commitLikeHost }, () =>
    engine.compactRegion(head, session.surface.nodes[4], agent, undefined),
  );
  assert.equal(result.start, next, "the range was moved off the head before the host saw it");
  assert.equal(engine.doctorStats.headShifts, 1);
  assert.equal(engine.doctorStats.lastHeadShift.head, head);
  assert.equal(engine.doctorStats.lastHeadShift.to, next);
  assert.ok(session.surface.replaceGeneration > 0, "and the compaction still committed");
  assert.ok(
    engine.ctx.logger.seen.some(([level, line]) => level === "warn" && /protected system head/.test(line)),
    "the correction is narrated",
  );
  const record = session.log.find((event) => event.type === "compaction/summary");
  assert.ok(!record.data.shadowedSeqs.includes(head), "the written record never names the head");
  assert.equal(assertLogLoadable(session.log, head), true, "so the log still loads");
});

testIsolated("task-15: every rung passes the same gate, and a failed commit leaves a loadable log", async () => {
  // 1. The validator has teeth: the exact shape the real incident produced is rejected.
  const { session: victim } = richConversation();
  const head = victim.surface.nodes[0];
  const poisoned = [{ seq: 0, type: "compaction/summary", data: { shadowedRange: { start: head, end: head + 2 }, shadowedSeqs: [head, head + 1, head + 2] } }];
  assert.throws(() => assertLogLoadable(poisoned, head), /cannot shadow the protected system head/);

  // 2. Through the ladder, the gate is in the path, so the record cannot name the head.
  const ladder = richConversation();
  const outcome = await withPatched(
    { compactRegion: commitLikeHost, summarize: async () => ({ summary: [{ type: "text", text: "s" }], rawOutput: [], usage: undefined }) },
    () => ladder.engine.compactIfNeeded(ladder.agent, "context-overflow", undefined),
  );
  assert.notEqual(outcome, null, "the ladder still commits");
  const record = ladder.session.log.find((event) => event.type === "compaction/summary");
  assert.ok(record !== undefined, "the host's own record was written");
  assert.ok(!record.data.shadowedSeqs.includes(ladder.session.surface.nodes[0]));
  assert.equal(assertLogLoadable(ladder.session.log, ladder.session.surface.nodes[0]), true);

  // 3. The half-written shape — record written, replacement refused afterwards —
  //    still leaves a log the host's loader accepts, because the range handed over
  //    can no longer cover the head.
  const failing = richConversation();
  const headSeq = failing.session.surface.nodes[0];
  await assert.rejects(
    () =>
      withPatched(
        {
          compactRegion: async (start, end, target) => {
            const nodes = target.session.surface.nodes;
            const shadowed = nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1);
            target.session.append("compaction/summary", { shadowedRange: { start, end }, shadowedSeqs: shadowed });
            throw new Error("surface replace refused after the record was written");
          },
        },
        // The caller asks for a head-covering range; the gate corrects it first.
        () => failing.engine.compactRegion(headSeq, failing.session.surface.nodes[3], failing.agent, undefined),
      ),
    /refused after the record was written/,
  );
  assert.ok(failing.session.log.some((event) => event.type === "compaction/summary"), "the record really was written");
  assert.equal(
    assertLogLoadable(failing.session.log, headSeq),
    true,
    "and the half-written log is still loadable — it never shadowed the head",
  );
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`FAIL ${name}\n     ${error?.stack?.split("\n").slice(0, 4).join("\n     ") ?? error}\n`);
  }
}
process.stdout.write(`\n${passed}/${tests.length} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
