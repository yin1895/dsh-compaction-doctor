/**
 * Real-scale retention pricing.
 *
 * The shipped meter returns a *hybrid* measurement:
 *
 *   - `totalTokens` is the measured real prompt cost of the whole replay
 *     (the number the provider actually bills and actually rejects), and
 *   - `surfaceTokens` / `nodes[].tokens` are a heuristic per-node pricing of
 *     the conversation surface,
 *
 * and the shipped selection walks `nodes[]` while `retainTokens` was derived
 * from the real window. Whenever the two scales disagree by a factor `k`, the
 * retained tail looks `k` times larger than it is, so the shadowed head is
 * `k` times smaller than intended — the observed "compaction ran but only
 * 4k-7.6k tokens were shadowed" defect.
 *
 * This module restores a single scale by pricing nodes at the *same* scale as
 * `totalTokens`. It patches one method on the live token-meter service and
 * only rescales while a compaction of that specific session is in flight, so
 * UI reads, spill policy and the tool-result pruner keep the shipped numbers.
 *
 * @module @local/dsh-compaction-doctor/rescale
 */

import { num } from "./util.js";

const PATCH_KEY = Symbol.for("@local/dsh-compaction-doctor/scaled-meter");
const MIN_USEFUL_FACTOR = 1.15;
const MAX_FACTOR = 64;

/** Sessions whose measurements must be reported at a single real scale. */
const scalingSessions = new WeakSet();

export function beginScale(session) {
  if (session !== null && typeof session === "object") scalingSessions.add(session);
}

export function endScale(session) {
  if (session !== null && typeof session === "object") scalingSessions.delete(session);
}

export function isScaling(session) {
  return session !== null && typeof session === "object" && scalingSessions.has(session);
}

/** Disagreement between the real prompt cost and the heuristic surface price. */
export function scaleFactorOf(measurement) {
  const total = num(measurement?.totalTokens, 0);
  const surface = num(measurement?.surfaceTokens, 0);
  if (total <= 0 || surface <= 0) return 1;
  const factor = total / surface;
  if (!Number.isFinite(factor) || factor < MIN_USEFUL_FACTOR) return 1;
  return Math.min(factor, MAX_FACTOR);
}

/**
 * Rewrite node pricing so `sum(nodes[].tokens) === totalTokens`, keeping the
 * relative weight of every node and its original heuristic value.
 */
export function rescaleMeasurement(measurement) {
  const factor = scaleFactorOf(measurement);
  if (factor === 1) return measurement;
  const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : [];
  if (nodes.length === 0) return measurement;
  const scaled = nodes.map((node) => {
    const heuristic = num(node?.heuristicTokens ?? node?.tokens, 0);
    return {
      ...node,
      tokens: Math.max(1, Math.round(heuristic * factor)),
      doctorHeuristicTokens: heuristic,
      doctorFactor: factor,
    };
  });
  const priced = scaled.reduce((sum, node) => sum + node.tokens, 0);
  return {
    ...measurement,
    nodes: scaled,
    pricedSurfaceTokens: measurement.surfaceTokens,
    doctorFactor: factor,
    surfaceTokens: priced,
  };
}

/**
 * Install the session-scoped rescale on the live token meter.
 * @returns `{ installed, patched, reason }`; idempotent per service instance.
 */
export function installScaledMeter(ctx) {
  let meter;
  try {
    meter = ctx?.get?.("tokenMeter");
  } catch {
    meter = undefined;
  }
  if (meter === undefined || meter === null || typeof meter.measure !== "function") {
    return { installed: false, patched: false, reason: "token meter service unavailable" };
  }
  if (meter[PATCH_KEY] !== undefined) return { installed: true, patched: false, reason: "already patched" };
  const original = meter.measure;
  const patched = function measure(session, ...rest) {
    const measurement = original.call(this, session, ...rest);
    if (measurement === undefined || measurement === null) return measurement;
    if (!isScaling(session)) return measurement;
    try {
      return rescaleMeasurement(measurement);
    } catch {
      return measurement;
    }
  };
  try {
    Object.defineProperty(meter, PATCH_KEY, {
      value: { original, patched },
      configurable: true,
      enumerable: false,
    });
    meter.measure = patched;
  } catch (error) {
    return { installed: false, patched: false, reason: `patch failed: ${error?.message ?? error}` };
  }
  return { installed: true, patched: true, reason: "ok" };
}

/** Restore the shipped meter method. */
export function uninstallScaledMeter(ctx) {
  let meter;
  try {
    meter = ctx?.get?.("tokenMeter");
  } catch {
    return false;
  }
  const record = meter?.[PATCH_KEY];
  if (record === undefined) return false;
  try {
    meter.measure = record.original;
    delete meter[PATCH_KEY];
    return true;
  } catch {
    return false;
  }
}

/** Diagnostics for the doctor report. */
export function meterPatchState(ctx) {
  let meter;
  try {
    meter = ctx?.get?.("tokenMeter");
  } catch {
    meter = undefined;
  }
  return {
    meterPresent: Boolean(meter),
    measurePresent: typeof meter?.measure === "function",
    patched: meter?.[PATCH_KEY] !== undefined,
  };
}
