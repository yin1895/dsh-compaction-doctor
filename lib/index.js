/**
 * `@local/dsh-compaction-doctor` — a compaction backend for DSH that prices
 * context the way the provider does, summarizes regions larger than the
 * summarizer's own window, recognizes untranslated "prompt too long" errors,
 * and discovers the routed model's real context window.
 *
 * Four mount points:
 *
 *  - the **bare package name** → this module. It is a deliberate no-op host
 *    half whose only job is to make the browser half discoverable:
 *    `dsh-client-modules` resolves a Loader row to its package through
 *    `exactPackageSpecifier()` (`dsh-client-modules/lib/index.js:83-89`), which
 *    returns `undefined` for a subpath specifier. A package that declares
 *    `dsh.client` but is only ever mounted through `<name>/probe` is never
 *    registered as a browser module: `/plugins/<name>/client.js` 404s and none
 *    of its UI appears. Every client-half plugin on this machine keeps a
 *    bare-name row for exactly that reason (dsh-pet, @opencode2dsh/dsh-plugin,
 *    dsh-workbuddy-connect, dsh-purge).
 *  - `@local/dsh-compaction-doctor/engine` → the compaction service (replaces
 *    the shipped `compaction-basic` row).
 *  - `@local/dsh-compaction-doctor/probe`  → the `compactionDoctor` service, the
 *    `/compact-doctor` command, and the settings-page transport.
 *  - `@local/dsh-compaction-doctor/client` → the browser half: a
 *    `settings.section` page served by the client module system.
 *
 * @module @local/dsh-compaction-doctor
 */

/** Plugin name for the bare-name row (log/diagnostics only). */
export const name = "@local/dsh-compaction-doctor";

/**
 * Host half of the bare-name row.
 *
 * Intentionally empty: the real work is carried by the `/probe` and `/engine`
 * rows. This row must stay — it is what puts the settings-page bundle into the
 * composed client graph.
 */
export function apply() {}

export {
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
  readSwitchState,
  switchStateFile,
  writeSwitchState,
} from "./probe.js";
export { CompactionDoctor as CompactionDoctorProbe, formatReport, readObservedBracket, reconcileWindow, rewriteModelWindow, candidateProfilePatches, readProviderSetup, writeProfilePatch } from "./probe.js";
export { CompactionDoctorEngine, DOCTOR_DEFAULTS, collectText, withMergedText } from "./engine.js";
export { guardRequest, installStatusRoute, matchRoute, readJsonBody, renderScalar, requiresJsonBody, sendJson, setRowConfigKeys } from "./status.js";
export { DEFAULT_RETAIN_RATIO, DEFAULT_THRESHOLD_RATIO, classifyMeasurement, computeNumbers, selectIndexRange, splitByCost } from "./plan.js";
export { isContextOverflowFailure, failureText, providerAttribution } from "./overflow.js";
export { installScaledMeter, uninstallScaledMeter, meterPatchState, rescaleMeasurement, scaleFactorOf } from "./rescale.js";
export { latestRoute, estimateTokens, surfaceSeqs, readContextWindow } from "./util.js";