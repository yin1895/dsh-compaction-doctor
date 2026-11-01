/**
 * Pure compaction math and range selection.
 *
 * The formulas mirror the shipped backend exactly:
 *
 *   messageBudget  = contextWindow - reservedCompletion
 *   pressureBudget = messageBudget - headroom
 *   threshold      = floor(min(contextWindow * thresholdRatio, pressureBudget))
 *   retain(tokens) = retainTokens ?? floor(messageBudget * retainRatio)
 *   summaryBudget  = floor(contextWindow * summaryBudgetRatio) - reservedCompletion
 *
 * Everything is pure so it can be unit-tested without a harness.
 *
 * @module @local/dsh-compaction-doctor/plan
 */

import { num } from "./util.js";

export const DEFAULT_THRESHOLD_RATIO = 0.8;
export const DEFAULT_RETAIN_RATIO = 0.16;

/**
 * Hard safety margin (F1) subtracted from the adapter's window for every
 * summarization request. This is a *constraint*, never a preference: the
 * rejected-prompt incident happened precisely because the outgoing summary
 * request was sized against a heuristic token count instead of the adapter's
 * own yardstick plus a margin it could not trade away.
 */
export const SUMMARY_HARD_MARGIN_TOKENS = 8192;

/**
 * Priced size of the shipped compaction directive that the summarizer appends
 * after the replayed prefix (`dsh-compaction-basic/lib/index.js:243-278`,
 * ~2.6 KB of ASCII ⇒ ~650 tokens at the shipped 4-chars-per-token density,
 * rounded up to 1024 for block framing). Counted into every summary budget so
 * the instruction itself can never be what tips a request over the window.
 */
export const SUMMARY_INSTRUCTION_TOKENS = 1024;

/** Derive every budget the compaction decision needs. */
export function computeNumbers({
  contextWindow,
  maxOutput,
  headroom,
  thresholdRatio,
  retainRatio,
  retainTokens,
  summaryBudgetRatio,
  summaryHardMargin,
  summaryMaxOutput,
} = {}) {
  const W = Math.max(0, Math.floor(num(contextWindow, 0)));
  const O = Math.max(0, Math.floor(num(maxOutput, 0)));
  const B = Math.max(0, Math.floor(num(headroom === undefined || headroom === null ? maxOutput : headroom, 0)));
  const messageBudget = Math.max(0, W - O);
  const pressureBudget = Math.max(0, messageBudget - B);
  const ratio = num(thresholdRatio, DEFAULT_THRESHOLD_RATIO) || DEFAULT_THRESHOLD_RATIO;
  const threshold = Math.floor(Math.min(W * ratio, pressureBudget));
  const retainReal =
    retainTokens === undefined || retainTokens === null
      ? Math.floor(messageBudget * (num(retainRatio, DEFAULT_RETAIN_RATIO) || DEFAULT_RETAIN_RATIO))
      : Math.max(0, Math.floor(num(retainTokens, 0)));
  const summaryBudget = Math.max(0, Math.floor(W * num(summaryBudgetRatio, 0.9) - O));
  // F1: the *outgoing* summarization request must satisfy
  //   adapterEstimate(request) + maxOutput + hardMargin <= adapterWindow
  // so the budget handed to the chunk planner is the smaller of the shipped
  // summary budget and that hard ceiling. The margin is subtracted here, not
  // left to the caller, so no later code path can spend it.
  //
  // The output reservation is the one the *summarization call itself* carries:
  // the shipped summarizer sends the compaction config's `maxTokens` verbatim as
  // the request's output cap (`dsh-compaction-basic/lib/index.js:318`), so a
  // caller that knows that number passes it as `summaryMaxOutput`; otherwise the
  // conversation's own reservation stands in.
  const margin = Math.max(0, Math.floor(num(summaryHardMargin, SUMMARY_HARD_MARGIN_TOKENS)));
  const summaryReserve = Math.max(O, Math.floor(num(summaryMaxOutput, 0)));
  const summaryRequestBudget = Math.max(0, Math.min(summaryBudget, W - summaryReserve - margin));
  return {
    W,
    O,
    B,
    messageBudget,
    pressureBudget,
    threshold,
    retainReal,
    summaryBudget,
    summaryRequestBudget,
    summaryHardMargin: margin,
    summaryReserve,
    thresholdRatio: ratio,
  };
}

/** Verdict for one measurement at a given scale factor. */
export function classifyMeasurement(measurement, factor, numbers) {
  const real = num(measurement?.totalTokens, 0);
  const priced = num(measurement?.surfaceTokens, 0);
  const k = num(factor, 1) || 1;
  const tailReal = numbers.retainReal;
  const headHeuristic = Math.max(0, priced - Math.round(tailReal / k));
  const shadowable = Math.max(0, real - tailReal);
  return {
    realPrompt: real,
    pricedSurface: priced,
    factor: k,
    threshold: numbers.threshold,
    overThreshold: numbers.threshold > 0 && real >= numbers.threshold,
    retainReal: tailReal,
    retainPriced: Math.round(tailReal / k),
    headHeuristic,
    headReal: Math.round(headHeuristic * k),
    shadowableReal: shadowable,
    needsChunking: shadowable > numbers.summaryBudget && numbers.summaryBudget > 0,
    chunks: numbers.summaryBudget > 0 ? Math.max(1, Math.ceil(shadowable / Math.max(1, Math.floor(numbers.summaryBudget * 0.9)))) : 1,
  };
}

/**
 * Choose one inclusive index range to shadow out of `tokens` (oldest first).
 *
 * `retainTokens === 0` keeps only the newest node, which is the shipped
 * behaviour for the context-overflow trigger. `capTokens` bounds the shadowed
 * span so the summarizer never receives more than it can accept.
 *
 * `firstIndex` is the surface's first *compactable* position and is what keeps
 * the replacement off surface node 0 (F3). The host rule is
 * `dsh-compaction-basic/lib/index.js:415`
 * (`firstIdx = systemHead(...) === undefined ? 0 : 1`) enforced by
 * `dsh-session/lib/index.js:421-425`: a `system/message` at node 0 may be
 * rewritten only by a `system/message` over exactly that node, so a compaction
 * range that starts there is rejected at commit time — after the summary has
 * already been paid for.
 */
export function selectIndexRange(tokens, { retainTokens = 0, capTokens = 0, firstIndex = 0 } = {}) {
  const list = Array.isArray(tokens) ? tokens : [];
  const n = list.length;
  if (n === 0) return null;
  const first = Math.max(0, Math.min(Math.floor(num(firstIndex, 0)), n - 1));
  let keepFrom = n;
  if (num(retainTokens, 0) > 0) {
    let tail = 0;
    while (keepFrom > first && tail < retainTokens) {
      keepFrom -= 1;
      tail += Math.max(0, num(list[keepFrom], 0));
    }
  } else {
    keepFrom = n - 1;
  }
  if (keepFrom <= first) return null;
  const cap = num(capTokens, 0);
  let sum = 0;
  let end = -1;
  for (let i = first; i < keepFrom; i += 1) {
    const value = Math.max(0, num(list[i], 0));
    if (cap > 0 && sum > 0 && sum + value > cap) break;
    sum += value;
    end = i;
  }
  if (end < 0) return null;
  return { startIndex: first, endIndex: end, keepFrom, shadowTokens: sum };
}

/**
 * Greedily pack `items` into contiguous chunks no larger than `budget` (F2).
 *
 * This is the *constructibility* check: it answers "can this region be
 * summarized at all, within the chunk count the configuration allows?" before a
 * single request is sent. Anything it declares infeasible must never reach the
 * provider, because the failure mode being removed is precisely "send a
 * summary request that cannot be admitted".
 *
 * @param items - ordered units to pack (messages, or the parts of one message).
 * @param options.price - `(item, index) => tokens`, priced with the adapter's own yardstick.
 * @param options.budget - per-chunk token ceiling (already margin-adjusted).
 * @param options.maxChunks - largest chunk count the configuration allows.
 * @returns `{ chunks, costs, total, budget, infeasible, needed }`.
 */
export function packWithinBudget(items, { price, budget, maxChunks = 8 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(num(maxChunks, 8)) || 8);
  const cap = Math.max(1, Math.floor(num(budget, 0)));
  const costs = list.map((item, index) => Math.max(0, num(typeof price === "function" ? price(item, index) : undefined, 0)));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const oversized = costs.findIndex((cost) => cost > cap);
  if (oversized >= 0) {
    return {
      chunks: [],
      costs,
      total,
      budget: cap,
      limit,
      infeasible: `item ${oversized} alone prices at ${costs[oversized]} tokens, above the ${cap}-token summary budget`,
    };
  }
  const chunks = [];
  let current = [];
  let running = 0;
  for (let index = 0; index < list.length; index += 1) {
    const cost = costs[index];
    if (current.length > 0 && running + cost > cap) {
      chunks.push({ items: current, cost: running });
      current = [];
      running = 0;
    }
    current.push(list[index]);
    running += cost;
  }
  if (current.length > 0) chunks.push({ items: current, cost: running });
  if (chunks.length > limit) {
    return {
      chunks: [],
      costs,
      total,
      budget: cap,
      limit,
      needed: chunks.length,
      infeasible: `${chunks.length} chunks are needed but maxSummaryChunks allows ${limit}`,
    };
  }
  return { chunks, costs, total, budget: cap, limit, needed: chunks.length };
}

/** Split `items` into `count` contiguous groups of roughly equal `costs`.
 * Used for hierarchical summarization of an oversized region.
 */
export function splitByCost(items, costs, count) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const groups = Math.max(1, Math.min(Math.floor(num(count, 1)) || 1, list.length));
  if (groups === 1) return [list.slice()];
  const total = costs.reduce((sum, cost) => sum + Math.max(1, num(cost, 1)), 0);
  const target = total / groups;
  const out = [];
  let current = [];
  let running = 0;
  for (let i = 0; i < list.length; i += 1) {
    const cost = Math.max(1, num(costs[i], 1));
    const remainingGroups = groups - out.length;
    const remainingItems = list.length - i;
    if (
      current.length > 0 &&
      remainingGroups > 1 &&
      remainingItems > remainingGroups - 1 &&
      running + cost / 2 > target
    ) {
      out.push(current);
      current = [];
      running = 0;
    }
    current.push(list[i]);
    running += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}
