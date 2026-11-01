/**
 * Failure replay + three property suites.
 *
 *   B1  the fixture itself: structure, both recorded errors, the token invariants
 *       and a sanitisation guard (nothing from the operator's machine survived);
 *   B2  replay: the fixture's terminal 400 is fed to the real engine's overflow
 *       classifier, and the recovery must advance the surface;
 *   B3  size (exhaustive): for every chunk plan the engine builds,
 *       `adapterEstimate(chunk) + maxOutput + margin <= window` — the property
 *       that makes `pi-ai detected context overflow` unreachable by construction;
 *   B4  node 0: no replace range may hold the system prompt.
 *
 * The engine under test is `lib/*.js` itself (copied byte-identically next to
 * this file so its bare imports resolve to `test/replay/node_modules`). This
 * suite never rewrites compaction logic and never relaxes an assertion: a
 * counterexample is reported with its input, the expected property, the observed
 * value and the `lib/engine.js:line` that produced it.
 *
 * Run: node test/replay/run.mjs
 */

import fs from "node:fs";
import path from "node:path";

import {
  adapterTokens,
  buildMessages,
  FIXTURE_PATH,
  loadFixture,
  makeAgent,
  makeCtx,
  makeHost,
  makeLlm,
  makeMeasurement,
  makeMeter,
  makeSession,
  PLUGIN_TOKENS_PER_BYTE,
  pricedNodes,
  ROOT,
  SAFETY_MARGIN_TOKENS,
  sandboxHome,
  SUMMARY_INSTRUCTION_TOKENS,
  SYNTHETIC_ROUTE,
  syncLib,
  verifyLibCopy,
} from "./harness.mjs";

// ── engine under test ────────────────────────────────────────────────────────
const hashes = syncLib();
sandboxHome();
const engineMod = await import("./lib/engine.js");
const planMod = await import("./lib/plan.js");
const overflowMod = await import("./lib/overflow.js");

const ENGINE_SOURCE = fs.readFileSync(path.join(ROOT, "lib", "engine.js"), "utf8").split(/\r?\n/);

/** Line numbers of a pattern in the engine under test (never hardcoded). */
function locate(pattern) {
  const found = [];
  ENGINE_SOURCE.forEach((line, index) => {
    if (new RegExp(pattern, "u").test(line)) found.push(`lib/engine.js:${index + 1}`);
  });
  return found.length === 0 ? ["lib/engine.js:<no match>"] : found;
}

const verdicts = [];
const record = (id, name, pass, detail = "", counterexamples = []) => verdicts.push({ id, name, pass: Boolean(pass), detail, counterexamples });

const fixture = loadFixture();

// ══ B1 — the fixture is its own regression test ══════════════════════════════
console.log("══ B1 · fixture ══════════════════════════════════════════════════════════");
const TAIL_SEQS = fixture.tail.map((entry) => entry.seq);
const FIRST_ANCHOR = fixture.entries[0];
const SECOND_ANCHOR = fixture.entries[1];

record(
  "fixture:shape",
  "anchors and a contiguous failure tail",
  FIRST_ANCHOR.seq === 16 &&
    FIRST_ANCHOR.type === "request/context" &&
    SECOND_ANCHOR.seq === 917 &&
    TAIL_SEQS.length === 64 &&
    TAIL_SEQS.every((seq, index) => seq === 1194 + index),
  `entries=${fixture.entries.length} anchors=${FIRST_ANCHOR.seq},${SECOND_ANCHOR.seq} tail=${TAIL_SEQS[0]}..${TAIL_SEQS.at(-1)} (${TAIL_SEQS.length})`,
);

const EXPECTED_TYPES = [
  "assistant/message", "tool/call", "tool/result", "step/end",
  "compaction/start", "compaction/summary", "compaction/end", "compaction/start", "compaction/end",
  "step/start", "assistant/message", "tool/call", "job/registered", "job/settled", "tool/result", "step/end",
  "compaction/start", "compaction/summary", "compaction/end", "compaction/start", "compaction/end",
  "step/start", "assistant/message", "tool/call", "tool/result", "step/end",
  "compaction/start", "compaction/summary", "compaction/end", "compaction/start", "compaction/end",
  "step/start", "assistant/message", "tool/call", "job/registered", "job/settled", "tool/result", "step/end",
  "compaction/start", "compaction/summary", "compaction/end", "compaction/start", "compaction/end",
  "step/start", "assistant/message", "tool/call", "tool/call", "tool/result", "tool/result", "step/end",
  "compaction/start", "compaction/summary", "compaction/end", "compaction/start", "compaction/end",
  "step/start", "assistant/attempt",
  "compaction/start", "compaction/summary", "compaction/end", "compaction/start", "compaction/end",
  "step/end", "turn/end",
];
record(
  "fixture:types",
  "entry type sequence is the recorded failure cycle",
  fixture.tail.map((entry) => entry.type).join(",") === EXPECTED_TYPES.join(","),
  `tail types ${fixture.tail.length} / expected ${EXPECTED_TYPES.length}`,
);

const alternating = fixture.watchErrors;
record(
  "fixture:errors",
  "the two recorded errors alternate and no compaction ever succeeded",
  alternating.length === 12 &&
    alternating.every((kind, index) => kind === (index % 2 === 0 ? "node0" : "overflow")) &&
    alternating.includes("ok") === false,
  alternating.join(","),
);
record(
  "fixture:error-texts",
  "both error texts are kept verbatim",
  fixture.node0Error === "surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node" &&
    fixture.overflowError === 'pi-ai detected context overflow for model "DeepSeek-V4.1-Flash"',
  `${fixture.node0Error?.length} + ${fixture.overflowError?.length} chars`,
);
record(
  "fixture:invariants",
  "window / accepted peak / failure scale are the recorded numbers",
  fixture.declaredWindow === 428917 &&
    fixture.acceptedPeak?.inputTokens === 401588 &&
    fixture.failureScale?.totalTokens === 1002590 &&
    fixture.failureScale?.cacheReadTokens === 1000704,
  `window=${fixture.declaredWindow} accepted=${fixture.acceptedPeak?.inputTokens} failure=${fixture.failureScale?.totalTokens}(cache ${fixture.failureScale?.cacheReadTokens})`,
);
record(
  "fixture:terminal",
  "the tail ends on the terminal 400 of the recorded turn",
  fixture.terminal.type === "turn/end" &&
    fixture.terminal.data.reason.kind === "error" &&
    String(fixture.terminalMessage).includes("内容太长了，请精简输入或开启新对话") &&
    String(fixture.terminalMessage).includes("alibaba-dashscope"),
  `${fixture.terminalMessage?.slice(0, 60)}…`,
);

// Sanitisation guard: every string is either a kept verbatim value or pure filler.
const FILLER_ONLY = /^[x\u00a1\u6d4b\u10348]*$/u;
const keptStrings = [];
let fillerStrings = 0;
const walk = (value, keyPath) => {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, keyPath);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) walk(child, `${keyPath}.${key}`);
    return;
  }
  if (typeof value !== "string") return;
  if (FILLER_ONLY.test(value)) {
    fillerStrings += 1;
    return;
  }
  keptStrings.push({ keyPath, value });
};
for (const entry of fixture.entries) walk(entry, entry.type);

const PRIVATE_MARKERS = ["C:\\", "D:\\", "/Users/", "Administrator", "auditagent", ".dsh", "cyber_workspace", "sha256:"];
const leaked = PRIVATE_MARKERS.filter((marker) => fixture.text.includes(marker));
// The two identifiers that would point at the operator: the failing session's id
// and the private gateway label. `test/fixtures/build.mjs` substitutes same-length
// synthetic values (an `x`-masked id that no shape-based scanner matches, and
// `gw-<i>` for the label); the fixture may only ever carry those.
const HEX_SESSION_ID_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const SYNTHETIC_SESSION_ID_RE = /session-x{8}-x{4}-x{4}-x{4}-x{12}/gu;
const hexShapedIds = fixture.text.match(HEX_SESSION_ID_RE) ?? [];
const syntheticIds = fixture.text.match(SYNTHETIC_SESSION_ID_RE) ?? [];
const syntheticRoute = /^gw-\d+$/u.test(String(fixture.route.provider)) && fixture.route.provider.length === 8;
record(
  "fixture:sanitised",
  "no machine path, account name, hash or real identifier survived",
  leaked.length === 0 && syntheticRoute && hexShapedIds.length === 0 && syntheticIds.length === 4,
  `${fillerStrings} filler strings, ${keptStrings.length} non-filler strings; route=${fixture.route.provider} (synthetic, ${String(fixture.route.provider).length} chars); session ids: ${hexShapedIds.length} hex-shaped, ${syntheticIds.length} synthetic (${syntheticIds[0]?.length ?? 0} chars)`,
  [
    ...leaked,
    ...(syntheticRoute ? [] : ["the fixture's route label is not the synthetic shape"]),
    ...(hexShapedIds.length === 0 ? [] : [`${hexShapedIds.length} hex-shaped session id(s) survived`]),
    ...(syntheticIds.length === 4 ? [] : [`expected 4 synthetic session ids, found ${syntheticIds.length}`]),
  ],
);

// The only Chinese text left must be the recorded provider message.
const providerText = "内容太长了，请精简输入或开启新对话";
const cjkRuns = [...new Set(fixture.text.match(/[\u3000-\u9fff\uff00-\uffef]+/gu) ?? [])];
const unexpectedCjk = cjkRuns.filter((run) => /^[\u6d4b]+$/u.test(run) === false && providerText.includes(run) === false);
record(
  "fixture:no-payload-text",
  "the only readable Chinese left is the provider's own 400 message",
  unexpectedCjk.length === 0,
  `${cjkRuns.length} CJK runs, ${unexpectedCjk.length} unexpected`,
  unexpectedCjk.slice(0, 5),
);

// ══ B2 — replay the terminal failure through the real classifier ═════════════
console.log("── B2 · replay ───────────────────────────────────────────────────────────");
const SYSTEM_SEQ = 10; // node 0 in the recorded session (`system/message`, seq 10)
/**
 * The recorded surface, rebuilt from the fixture with node 0 at the head:
 * the system prompt, the routing anchor, the accepted-input peak, then the tail.
 */
const replayEvents = [
  { seq: SYSTEM_SEQ, type: "system/message", data: { turn: 1, step: 1, message: { role: "system", content: [] } } },
  ...fixture.entries.map((entry) => ({ seq: entry.seq, type: entry.type, data: entry.data })),
];
const replayAdapterPerByte = PLUGIN_TOKENS_PER_BYTE * 8.6;
const replayHost = makeHost({
  window: fixture.declaredWindow,
  maxOutput: 65536,
  systemSeq: SYSTEM_SEQ,
  adapterTokensPerByte: replayAdapterPerByte,
  node0Message: fixture.node0Error,
  overflowMessage: fixture.overflowError,
});
const replaySession = makeSession(replayEvents, {});
const replayCtx = makeCtx({
  llm: makeLlm(fixture.declaredWindow),
  tokenMeter: makeMeter(() => makeMeasurement(pricedNodes(replaySession.surface.nodes, 20000)), { tokensPerByte: replayAdapterPerByte }),
  sessions: { active: () => replaySession },
});
const replayEngine = new engineMod.CompactionDoctorEngine(replayCtx, {
  enabled: true,
  scaleMode: "select",
  tokensPerByte: PLUGIN_TOKENS_PER_BYTE,
  maxTokens: 65536,
  __replay: replayHost,
});
const replayAgent = makeAgent(replaySession, 65536);
const failure = {
  message: fixture.terminalMessage,
  code: "INVALID_REQUEST",
  metadata: { provider_name: fixture.terminalProvider },
};
const classification = overflowMod.isContextOverflowFailure(failure, "CONTEXT_WINDOW_EXCEEDED");
const outcome = await replayCtx.emit(
  "agent/request-error",
  { agent: replayAgent, turn: 1, step: 147, provider: fixture.route.provider, failure, retryPolicy: {}, signal: undefined },
  async () => undefined,
);
const replayErrors = [];
if (replayHost.log.rejections > 0) replayErrors.push("node0");
if (replayHost.log.overflow > 0) replayErrors.push("overflow");
const replayBase = replayHost.log.summarize[0];
const replayResult =
  `outcome=${JSON.stringify(outcome)} generation=${replaySession.surface.replaceGeneration} commits=${replayHost.log.commits.length} errors=[${replayErrors.join(",")}]` +
  ` baseRequest=${replayBase === undefined ? "none" : `${replayBase.adapter}/${replayBase.budget}`}`;

record(
  "replay:classifier",
  "the recorded 400 is recognised as a context overflow",
  classification !== undefined,
  `verdict=${classification ?? "undefined"}`,
);
record(
  "replay:surface-advances",
  "recovery advances the surface (generation +1)",
  replaySession.surface.replaceGeneration >= 1,
  replayResult,
  replaySession.surface.replaceGeneration >= 1 ? [] : ["expected generation>=1, got " + replaySession.surface.replaceGeneration, ...locate("compactRegion\\(")],
);
record(
  "replay:one-level-succeeds",
  "at least one recovery level commits a replacement",
  replayHost.log.commits.length >= 1,
  `commits=${JSON.stringify(replayHost.log.commits)}`,
  replayHost.log.commits.length >= 1 ? [] : ["expected >=1 commit, got 0", ...locate("_selectCompactIfNeeded|super\\.compactIfNeeded")],
);
record(
  "replay:turn-survives",
  "the turn is not left with the original failure",
  outcome !== undefined && outcome.kind === "retry",
  `outcome=${JSON.stringify(outcome)}`,
  outcome !== undefined && outcome.kind === "retry" ? [] : ["expected {kind:'retry'}, got " + JSON.stringify(outcome), ...locate("replaceGeneration\\) <= generation")],
);
record(
  "replay:no-doomed-request",
  "recovery never issues a request the adapter has to reject",
  replayHost.log.overflow === undefined && replayHost.log.rejections === undefined,
  `adapter rejections=${replayHost.log.overflow ?? 0} surface rejections=${replayHost.log.rejections ?? 0} historicModesReached=[${replayErrors.join(",") || "none"}]`,
  replayHost.log.overflow === undefined && replayHost.log.rejections === undefined
    ? []
    : [
        `expected 0 rejections, got adapter=${replayHost.log.overflow ?? 0} surface=${replayHost.log.rejections ?? 0}`,
        ...locate("summaryRequestBudget"),
        ...locate("_firstCompactableIndex"),
      ],
);

// Teeth: the host model must still bite, or a green suite would be worthless.
// Both recorded errors are re-raised here through the base class, bypassing the
// engine's overrides, on inputs the engine would have produced pre-fix.
const BaseProto = Object.getPrototypeOf(engineMod.CompactionDoctorEngine.prototype);
let teethOverflow;
let teethNode0;
try {
  await BaseProto.summarize.call(replayEngine, { messages: buildMessages(4, 400000) }, replayAgent, undefined);
} catch (error) {
  teethOverflow = error;
}
try {
  await BaseProto._write.call(replayEngine, replaySession, SYSTEM_SEQ, SYSTEM_SEQ + 2, "replace");
} catch (error) {
  teethNode0 = error;
}
record(
  "replay:host-bites",
  "the stubbed host still raises both recorded errors when asked to",
  teethOverflow?.message === fixture.overflowError && teethNode0?.message === fixture.node0Error,
  `overflow="${String(teethOverflow?.message).slice(0, 48)}…" node0="${String(teethNode0?.message).slice(0, 48)}…"`,
  teethOverflow?.message === fixture.overflowError && teethNode0?.message === fixture.node0Error ? [] : ["the host model did not reproduce the fixture's recorded errors"],
);

// ══ B3 — size property over an exhaustive grid ═══════════════════════════════console.log("── B3 · chunk-size property ─────────────────────────────────────────────");
const WINDOWS = [428917, 131072, 199999, 1048576];
const OUTPUTS = [4096, 65536, 131072];
const REGION_FACTORS = [0.5, 0.9, 1.0, 1.5, 3, 10];
const ADAPTER_RATIOS = [1, 2, 8.6];
const CHUNK_LIMITS = [8, 24];

const sizeFailures = [];
let sizeCases = 0;
let chunksAsserted = 0;
let assertedAdapterTokens = 0;
let infeasibleCases = 0;
let regionTokensTotal = 0;

for (const window of WINDOWS) {
  for (const maxOutput of OUTPUTS) {
    const budget = window - maxOutput - SAFETY_MARGIN_TOKENS;
    if (budget <= 0) continue;
    for (const factor of REGION_FACTORS) {
      for (const ratio of ADAPTER_RATIOS) {
        for (const maxSummaryChunks of CHUNK_LIMITS) {
          sizeCases += 1;
          const adapterPerByte = PLUGIN_TOKENS_PER_BYTE * ratio;
          const regionAdapter = Math.round(budget * factor);
          const regionBytes = Math.max(512, Math.round(regionAdapter / adapterPerByte));
          const messageCount = Math.min(40, Math.max(4, Math.round(factor * 8)));
          const messages = buildMessages(messageCount, regionBytes);
          const actualRegionAdapter = adapterTokens(messages, adapterPerByte);
          regionTokensTotal += actualRegionAdapter;

          const host = makeHost({
            window,
            maxOutput,
            margin: SAFETY_MARGIN_TOKENS,
            adapterTokensPerByte: adapterPerByte,
            headerTokens: SUMMARY_INSTRUCTION_TOKENS,
            systemSeq: 1,
          });
          const ctx = makeCtx({
            llm: makeLlm(window),
            // The meter prices with the adapter's own accounting: the engine and the
            // window under test then speak one currency, which is exactly what F1 fixes.
            tokenMeter: makeMeter(() => makeMeasurement(pricedNodes([1, 2, 3], 100)), { tokensPerByte: adapterPerByte }),
            sessions: {},
            // Without a resolvable route the engine cannot price a request at all and
            // hands the whole job to the shipped path — so the grid must state one.
            compactionDoctor: {
              config: { provider: SYNTHETIC_ROUTE, model: "DeepSeek-V4.1-Flash", fallbackContextWindow: window },
            },
          });
          const engine = new engineMod.CompactionDoctorEngine(ctx, {
            enabled: true,
            scaleMode: "meter",
            tokensPerByte: PLUGIN_TOKENS_PER_BYTE,
            maxTokens: maxOutput,
            maxSummaryChunks,
            __replay: host,
          });
          const session = makeSession([
            { seq: 1, type: "system/message", data: { message: { role: "system", content: [] } } },
            { seq: 2, type: "request/context", data: { provider: SYNTHETIC_ROUTE, model: "DeepSeek-V4.1-Flash", contextWindow: window } },
          ]);
          const agent = makeAgent(session, maxOutput);

          let threw;
          try {
            await engine.summarize({ messages }, agent, undefined);
          } catch (error) {
            threw = error;
          }

          const requests = host.log.summarize;
          // Physical feasibility at the demanded bound: how many chunks a region
          // *needs* when every chunk also carries the host's own fixed header.
          const perChunkBudget = Math.max(1, budget - SUMMARY_INSTRUCTION_TOKENS);
          const needed = Math.max(1, Math.ceil((actualRegionAdapter + SUMMARY_INSTRUCTION_TOKENS) / perChunkBudget));
          const feasible = needed <= maxSummaryChunks;
          const point = { window, maxOutput, factor, ratio, maxSummaryChunks, needed, feasible, requested: requests.length };
          if (feasible === false) infeasibleCases += 1;

          for (const request of requests) {
            chunksAsserted += 1;
            assertedAdapterTokens += request.adapter;
            if (request.adapter > request.budget) {
              sizeFailures.push({
                ...point,
                kind: "chunk-too-big",
                detail: `chunk adapter=${request.adapter} > budget=${request.budget} (region ${actualRegionAdapter}, ${requests.length} chunks)`,
                where: locate("chunkTarget|wanted ="),
              });
            }
          }
          if (feasible === false && requests.length > 0) {
            sizeFailures.push({
              ...point,
              kind: "doomed-request",
              detail: `region needs ${needed} chunks > maxSummaryChunks=${maxSummaryChunks}, yet ${requests.length} request(s) were issued`,
              where: locate("wanted = Math\\.min"),
            });
          }
          if (threw !== undefined && threw.__overflow === true && requests.every((request) => request.adapter <= request.budget)) {
            sizeFailures.push({ ...point, kind: "unexpected-overflow", detail: String(threw.message).slice(0, 80), where: locate("catch \\(error\\)") });
          }
          if (threw !== undefined && /no summary text/u.test(String(threw.message))) {
            sizeFailures.push({
              ...point,
              kind: "summary-unreadable",
              detail: `chunked path ran (${requests.length} request(s), all within budget) but ended "${String(threw.message).slice(0, 60)}"`,
              where: locate("no summary text"),
            });
          }
        }
      }
    }
  }
}

const byKind = sizeFailures.reduce((map, item) => {
  map[item.kind] = (map[item.kind] ?? 0) + 1;
  return map;
}, {});
record(
  "size:property",
  "every chunk the engine sends satisfies adapter + maxOutput + margin <= window",
  (byKind["chunk-too-big"] ?? 0) === 0,
  `grid=${sizeCases} cases, ${chunksAsserted} chunk requests asserted, violations=${byKind["chunk-too-big"] ?? 0} (all kinds: ${JSON.stringify(byKind)})`,
  sizeFailures.filter((item) => item.kind === "chunk-too-big").slice(0, 6).map((item) => JSON.stringify(item)),
);
record(
  "size:degrades",
  "an unfittable region degrades instead of sending a doomed request",
  (byKind["doomed-request"] ?? 0) === 0,
  `infeasible cases=${infeasibleCases}, doomed=${byKind["doomed-request"] ?? 0}`,
  sizeFailures.filter((item) => item.kind === "doomed-request").slice(0, 6).map((item) => JSON.stringify(item)),
);
// The chunked path must be able to read what the summarizer actually answers.
// `dsh-compaction-basic/lib/index.js:329-337` returns the text under `summary`;
// a caller reading only `blocks` gets nothing, and the whole region is thrown
// away even though every chunk succeeded (docs/surface-contract.md §0.2.1).
const summaryUnreadable = sizeFailures.filter((item) => item.kind === "summary-unreadable");
record(
  "size:summary-contract",
  "the chunked path reads the summarizer's own return shape",
  summaryUnreadable.length === 0,
  `chunked cases that ended without text: ${summaryUnreadable.length}${summaryUnreadable.length === 0 ? "" : ` (e.g. ${summaryUnreadable[0].detail})`}`,
  summaryUnreadable.slice(0, 4).map((item) => JSON.stringify(item)),
);

// ══ B4 — node 0 property over an exhaustive grid ═════════════════════════════
console.log("── B4 · node 0 property ─────────────────────────────────────────────────");
const NODE0_WINDOWS = [428917, 199999, 1048576];
const NODE0_TRIGGERS = ["context-overflow", "pressure"];
const NODE0_NODES = [4, 9, 17];
const NODE0_ROUTES = ["select", "override"];
const node0Attempts = [];
let node0Cases = 0;
let node0CasesWithRange = 0;
const node0Failures = [];

for (const window of NODE0_WINDOWS) {
  for (const trigger of NODE0_TRIGGERS) {
    for (const nodeCount of NODE0_NODES) {
      for (const route of NODE0_ROUTES) {
        node0Cases += 1;
        const seqs = Array.from({ length: nodeCount }, (_, index) => 100 + index);
        const systemSeq = seqs[0];
        // Sized past the threshold for every window, so the pressure trigger really selects.
        const perNode = Math.max(30000, Math.floor(window * 0.2));
        const nodes = pricedNodes(seqs, (seq, index) => (index === 0 ? 4000 : perNode));
        const host = makeHost({ window, maxOutput: 65536, systemSeq });
        const ctx = makeCtx({
          llm: makeLlm(window),
          tokenMeter: makeMeter(() => makeMeasurement(nodes), { tokensPerByte: PLUGIN_TOKENS_PER_BYTE }),
          sessions: {},
          // Node 0 is the system prompt and the routing target: both come from the
          // probe row, never from a synthesized surface event, so the surface's head
          // really is the `system/message` the contract protects.
          compactionDoctor: {
            config: {
              provider: SYNTHETIC_ROUTE,
              model: "DeepSeek-V4.1-Flash",
              fallbackContextWindow: window,
              ...(route === "override" ? { thresholdRatio: 0.5 } : {}),
            },
          },
        });
        const config = {
          enabled: true,
          maxTokens: 65536,
          __replay: host,
          ...(route === "select" ? { scaleMode: "select" } : { scaleMode: "meter", thresholdRatio: 0.8 }),
        };
        const engine = new engineMod.CompactionDoctorEngine(ctx, config);
        const session = makeSession(
          seqs.map((seq, index) => ({
            seq,
            type: index === 0 ? "system/message" : "assistant/message",
            data: index === 0 ? { turn: 1, step: 1, message: { role: "system", content: [] } } : { usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
          })),
        );
        const agent = makeAgent(session, 65536);
        try {
          await engine.compactIfNeeded(agent, trigger, undefined);
        } catch {
          /* the engine's own outcome is asserted by B2; here only the ranges matter */
        }
        if (host.log.compactRegion.length > 0) node0CasesWithRange += 1;
        for (const attempt of host.log.compactRegion) {
          node0Attempts.push({ ...attempt, systemSeq });
          if (attempt.start <= systemSeq && systemSeq <= attempt.end) {
            node0Failures.push({
              window,
              trigger,
              nodeCount,
              route,
              range: `[${attempt.start},${attempt.end}]`,
              systemSeq,
              kind: "range-covers-node0",
              where: [...locate("selectIndexRange\\("), ...locate("compactRegion\\(")],
            });
          }
        }
        for (const commit of host.log.commits) {
          if (commit.start <= systemSeq && systemSeq <= commit.end) {
            node0Failures.push({ window, trigger, nodeCount, route, range: `[${commit.start},${commit.end}]`, systemSeq, kind: "commit-covers-node0", where: locate("compactRegion\\(") });
          }
        }
      }
    }
  }
}

record(
  "node0:ranges",
  "no replacement range covers node 0 (the system prompt)",
  node0Failures.length === 0,
  `grid=${node0Cases} cases (${node0CasesWithRange} selected a range), ${node0Attempts.length} ranges attempted, violations=${node0Failures.length}`,
  node0Failures.slice(0, 6).map((item) => JSON.stringify(item)),
);

// The contract path: quoted from the contract doc and from the installed source.
const CONTRACT_PATH = path.join(ROOT, "docs", "surface-contract.md");
const INSTALLED_SURFACE = "C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh-session\\lib\\types\\surface.js";
let contractCites = [];
let contractNote = "docs/surface-contract.md 尚未产出（task-9 未完成）—— 本条断言的契约引用待定稿";
if (fs.existsSync(CONTRACT_PATH)) {
  const lines = fs.readFileSync(CONTRACT_PATH, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/node\s*0|system\/message/.test(line)) contractCites.push(`docs/surface-contract.md:${index + 1}`);
  });
  contractNote = contractCites.length > 0 ? `契约 ${contractCites.slice(0, 2).join(" ")}` : "契约文档存在但没有 node 0 相关条款";
}
if (fs.existsSync(INSTALLED_SURFACE)) {
  const lines = fs.readFileSync(INSTALLED_SURFACE, "utf8").split(/\r?\n/);
  const at = lines.findIndex((line) => line.includes("node 0 holds the system prompt"));
  if (at >= 0) contractNote += `；已安装实现 dsh-session/lib/types/surface.js:${at + 1}（system/message 且 shadowedSeqs.length===1 才放行）`;
}
const covering = node0Attempts.filter((attempt) => attempt.start <= attempt.systemSeq && attempt.systemSeq <= attempt.end);
const contractShaped = covering.filter((attempt) => attempt.op === "system/message");
record(
  "node0:contract-path",
  "a range covering node 0 is only ever attempted the way the contract allows",
  contractShaped.length === covering.length,
  `${contractNote}; covering attempts=${covering.length}, contract-shaped=${contractShaped.length}, grid cases selecting a range=${node0CasesWithRange}`,
  covering
    .filter((attempt) => attempt.op !== "system/message")
    .slice(0, 4)
    .map((attempt) => JSON.stringify({ range: `[${attempt.start},${attempt.end}]`, op: attempt.op, expectedOp: "system/message over exactly one node", where: locate("compactRegion\\(") })),
);

// ══ report ═══════════════════════════════════════════════════════════════════
console.log("\n══ results ══════════════════════════════════════════════════════════════");
for (const verdict of verdicts) {
  console.log(`${verdict.pass ? "ok  " : "FAIL"} ${verdict.id.padEnd(32)} ${verdict.name}`);
  if (verdict.detail !== "") console.log(`       · ${verdict.detail}`);
  for (const example of verdict.counterexamples) console.log(`       ! ${example}`);
}

const drift = verifyLibCopy(hashes);
console.log(`\nengine revision  : lib/engine.js sha256 ${(hashes.get("engine.js") ?? "").slice(0, 16)}… (every line number above belongs to this revision)`);
console.log(`engine under test: lib/*.js copied byte-identical (drift: ${drift.length === 0 ? "none" : drift.join(",")})`);
console.log(`fixture          : ${path.relative(ROOT, FIXTURE_PATH)} — ${fixture.entries.length} entries, ${fixture.bytes} bytes`);
console.log(`grid size        : B3 ${sizeCases} cases (${WINDOWS.length} windows x ${OUTPUTS.length} outputs x ${REGION_FACTORS.length} region sizes x ${ADAPTER_RATIOS.length} adapter scales x ${CHUNK_LIMITS.length} chunk limits), B4 ${node0Cases} cases`);
console.log(`chunks asserted  : ${chunksAsserted} chunk requests, ${assertedAdapterTokens} adapter tokens actually sent by the engine`);
console.log(`replay           : ${replayResult}`);

const failed = verdicts.filter((verdict) => verdict.pass === false);
console.log(`\n${verdicts.length - failed.length}/${verdicts.length} properties hold`);
if (failed.length > 0) {
  console.log(`counterexamples : ${failed.map((verdict) => verdict.id).join(", ")}`);
  console.log("next            : 引擎侧修复在 task-10（F1..F6）；本套件不改 lib、不放宽断言。");
}
process.exitCode = failed.length === 0 ? 0 : 1;
