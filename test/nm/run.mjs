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
    makeEvent(2, "request/context", live ?? { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash", contextWindow: 1048576 }),
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
  "        huaiyuan:",
  "          apiKeyEnv: HUAIYUAN_API_KEY",
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
    provider: "huaiyuan",
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
    provider: "huaiyuan",
    model: "DeepSeek-V4.1-Flash",
    contextWindow: 1048576,
    maxTokens: 65536,
  });
  assert.equal(again.changed, false, "the rewrite must be idempotent");
});

test("probe: rewriteModelWindow refuses a model it cannot find", () => {
  const result = probeMod.rewriteModelWindow(PROFILE_PATCH.join("\n"), {
    providerEntryId: "llm-pi-ai",
    provider: "huaiyuan",
    model: "does-not-exist",
    contextWindow: 1048576,
    maxTokens: 65536,
  });
  assert.equal(result.changed, false);
  assert.equal(result.text, undefined);
});

test("probe: readProviderSetup extracts the transport facts of the routed provider", () => {
  const setup = probeMod.readProviderSetup(PROFILE_PATCH.join("\n"), "huaiyuan");
  assert.equal(setup.baseURL, "http://127.0.0.1:17890/v1");
  assert.equal(setup.apiKeyEnv, "HUAIYUAN_API_KEY");
  assert.equal(setup.api, "openai-completions");
});

test("probe: patchConfigModel updates both array-shaped and map-shaped model tables", () => {
  const arrayShape = { providers: { huaiyuan: { models: [{ id: "DeepSeek-V4.1-Flash", contextWindow: 512000, maxTokens: 384000 }] } } };
  const patched = probeMod.patchConfigModel(arrayShape, "huaiyuan", "DeepSeek-V4.1-Flash", { contextWindow: 1048576, maxTokens: 65536 });
  assert.deepEqual(patched.providers.huaiyuan.models[0], { id: "DeepSeek-V4.1-Flash", contextWindow: 1048576, maxTokens: 65536 });
  assert.equal(arrayShape.providers.huaiyuan.models[0].contextWindow, 512000, "the input object is never mutated");
  const mapShape = { providers: { huaiyuan: { models: { "DeepSeek-V4.1-Flash": { contextWindow: 512000 } } } } };
  const mapPatched = probeMod.patchConfigModel(mapShape, "huaiyuan", "DeepSeek-V4.1-Flash", { contextWindow: 1048576, maxTokens: 65536 });
  assert.equal(mapPatched.providers.huaiyuan.models["DeepSeek-V4.1-Flash"].contextWindow, 1048576);
  assert.throws(() => probeMod.patchConfigModel(arrayShape, "huaiyuan", "nope", { contextWindow: 1, maxTokens: 1 }), /not present/);
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
    { contextWindow: 1048576, provider: "huaiyuan", model: "DeepSeek-V4.1-Flash" },
    { contextWindow: 512000, provider: "huaiyuan", model: "DeepSeek-V4.1-Flash" },
  ],
  attempts: 5,
  failures: 5,
};

test("probe: the configured 512k window contradicts traffic the provider already accepted", () => {
  const decision = probeMod.reconcileWindow({
    configured: { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash", contextWindow: 512000, maxOutput: 384000 },
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
    configured: { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash", contextWindow: 1048576, maxOutput: 65536 },
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
    configured: { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash", contextWindow: 200000, maxOutput: 16384 },
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
  const bracket = probeMod.readObservedBracket(makeSession(conversationEvents({ dialogue: 2, live: { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash", contextWindow: 512000 } })));
  assert.deepEqual(bracket.windowsSeen, [{ contextWindow: 512000, provider: "huaiyuan", model: "DeepSeek-V4.1-Flash" }]);
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
    { enabled: true, scaleMode: "off", ...config },
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
      ...conversationEvents({ dialogue: 2, live: { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash", contextWindow: 512000 } }),
      makeEvent(50, "assistant/message", { usage: { inputTokens: 100, cacheReadTokens: 1036763, outputTokens: 12, totalTokens: 1036875 } }),
    ]);
    const commands = { registrations: [], register(registration) { commands.registrations.push(registration); return { dispose() {} }; } };
    const ctx = makeCtx({ llm: fakeLlm, sessions: { active: () => session }, commands });
    const doctor = new probeMod.CompactionDoctor(ctx, {
      enabled: true,
      provider: "huaiyuan",
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
    const session = makeSession(conversationEvents({ dialogue: 2, live: { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash", contextWindow: 512000 } }));
    const doctor = new probeMod.CompactionDoctor(makeCtx({ llm: fakeLlm, sessions: { active: () => session } }), {
      enabled: true,
      provider: "huaiyuan",
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
      edits.push({ entry, next: mutate({ providers: { huaiyuan: { models: [{ id: "DeepSeek-V4.1-Flash", contextWindow: 512000, maxTokens: 384000 }] } } }) });
      return { applied: true };
    },
  };
  const session = makeSession(conversationEvents({ dialogue: 2, live: { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash", contextWindow: 200000 } }));
  const doctor = new probeMod.CompactionDoctor(makeCtx({ llm: fakeLlm, sessions: { active: () => session }, configEditor: editor }), {
    enabled: true,
    provider: "huaiyuan",
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
  assert.equal(edits[0].next.providers.huaiyuan.models[0].contextWindow, 1048576);
});

test("probe service: report text renders every decision line", () => {
  const text = probeMod.formatReport({
    at: "2026-10-29T22:00:00.000Z",
    route: { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash", contextWindow: 512000, source: "request/context" },
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
    "      huaiyuan:",
    "        apiKeyEnv: HUAIYUAN_API_KEY",
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
  assert.ok(replaceOnly.text.includes("apiKeyEnv: HUAIYUAN_API_KEY"), "another row's config is untouched");

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
  assert.equal(util.latestRoute(makeSession(conversationEvents()), { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash" }).source, "request/context");
  assert.equal(util.latestRoute(makeSession([]), { provider: "huaiyuan" }), undefined);
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
