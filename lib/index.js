/**
 * `@local/dsh-compaction-doctor` — a compaction backend for DSH that prices
 * context the way the provider does, summarizes regions larger than the
 * summarizer's own window, recognizes untranslated "prompt too long" errors,
 * and discovers the routed model's real context window.
 *
 * Three mount points, all declared in `cordis.patch.yml` except the last:
 *
 *  - `@local/dsh-compaction-doctor/engine` → the compaction service (replaces
 *    the shipped `compaction-basic` row).
 *  - `@local/dsh-compaction-doctor/probe`  → the `compactionDoctor` service, the
 *    `/compact-doctor` command, and the settings-page transport (optional; the
 *    engine runs without it).
 *  - `@local/dsh-compaction-doctor/client` → the browser half: a
 *    `settings.section` page served by the client module system (no row of its
 *    own; `dsh.client.platform: "web"` in `package.json` is the declaration).
 *
 * @module @local/dsh-compaction-doctor
 */

export {
  CompactionDoctor as default,
  CompactionDoctor,
  BACKUP_TAG,
  COMMAND_ID,
  COMMAND_NAME,
  ENGINE_ROW_KEYS,
  ROUTE_GUARD_HEADER,
  ROUTE_PREFIX,
  VERSION,
  isBackupInside,
  listPatchBackups,
  normalizeConfig,
  profileDir,
} from "./probe.js";
export { CompactionDoctor as CompactionDoctorProbe, formatReport, readObservedBracket, reconcileWindow, rewriteModelWindow, candidateProfilePatches, readProviderSetup, writeProfilePatch } from "./probe.js";
export { CompactionDoctorEngine, DOCTOR_DEFAULTS, collectText, withMergedText } from "./engine.js";
export { guardRequest, installStatusRoute, matchRoute, readJsonBody, renderScalar, requiresJsonBody, sendJson, setRowConfigKeys } from "./status.js";
export { DEFAULT_RETAIN_RATIO, DEFAULT_THRESHOLD_RATIO, classifyMeasurement, computeNumbers, selectIndexRange, splitByCost } from "./plan.js";
export { isContextOverflowFailure, failureText, providerAttribution } from "./overflow.js";
export { installScaledMeter, uninstallScaledMeter, meterPatchState, rescaleMeasurement, scaleFactorOf } from "./rescale.js";
export { latestRoute, estimateTokens, surfaceSeqs, readContextWindow } from "./util.js";