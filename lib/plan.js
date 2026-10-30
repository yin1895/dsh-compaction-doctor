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

/** Derive every budget the compaction decision needs. */
export function computeNumbers({
  contextWindow,
  maxOutput,
  headroom,
  thresholdRatio,
  retainRatio,
  retainTokens,
  summaryBudgetRatio,
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
  return { W, O, B, messageBudget, pressureBudget, threshold, retainReal, summaryBudget, thresholdRatio: ratio };
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
 */
export function selectIndexRange(tokens, { retainTokens = 0, capTokens = 0 } = {}) {
  const list = Array.isArray(tokens) ? tokens : [];
  const n = list.length;
  if (n === 0) return null;
  let keepFrom = n;
  if (num(retainTokens, 0) > 0) {
    let tail = 0;
    while (keepFrom > 0 && tail < retainTokens) {
      keepFrom -= 1;
      tail += Math.max(0, num(list[keepFrom], 0));
    }
  } else {
    keepFrom = n - 1;
  }
  if (keepFrom <= 0) return null;
  const cap = num(capTokens, 0);
  let sum = 0;
  let end = -1;
  for (let i = 0; i < keepFrom; i += 1) {
    const value = Math.max(0, num(list[i], 0));
    if (cap > 0 && sum > 0 && sum + value > cap) break;
    sum += value;
    end = i;
  }
  if (end < 0) return null;
  return { startIndex: 0, endIndex: end, keepFrom, shadowTokens: sum };
}

/**
 * Split `items` into `count` contiguous groups of roughly equal `costs`.
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
