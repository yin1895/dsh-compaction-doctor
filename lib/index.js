/**
 * `@local/dsh-compaction-doctor` — a compaction backend for DSH that prices
 * context the way the provider does, summarizes regions larger than the
 * summarizer's own window, recognizes untranslated "prompt too long" errors,
 * and discovers the routed model's real context window.
 *
 * Two mount points, both declared in `cordis.patch.yml`:
 *
 *  - `@local/dsh-compaction-doctor/engine` → the compaction service (replaces
 *    the shipped `compaction-basic` row).
 *  - `@local/dsh-compaction-doctor/probe`  → the `compactionDoctor` service and
 *    the `/compact-doctor` command (optional; the engine runs without it).
 *
 * @module @local/dsh-compaction-doctor
 */

export { CompactionDoctor as default, CompactionDoctor, COMMAND_ID, COMMAND_NAME, normalizeConfig } from "./probe.js";
export { CompactionDoctor as CompactionDoctorProbe, formatReport, readObservedBracket, reconcileWindow, rewriteModelWindow, candidateProfilePatches, readProviderSetup, writeProfilePatch } from "./probe.js";
export { CompactionDoctorEngine, DOCTOR_DEFAULTS, collectText, withMergedText } from "./engine.js";
export { DEFAULT_RETAIN_RATIO, DEFAULT_THRESHOLD_RATIO, classifyMeasurement, computeNumbers, selectIndexRange, splitByCost } from "./plan.js";
export { isContextOverflowFailure, failureText, providerAttribution } from "./overflow.js";
export { installScaledMeter, uninstallScaledMeter, meterPatchState, rescaleMeasurement, scaleFactorOf } from "./rescale.js";
export { latestRoute, estimateTokens, surfaceSeqs, readContextWindow } from "./util.js";
