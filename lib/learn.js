/**
 * Hard context-window upper bounds learned from provider rejections (F5).
 *
 * A provider that rejects a prompt of `N` tokens as "too long" has
 * *definitively* proven that its usable window is below `N`. That is the only
 * direction in which an observation may be treated as a capability value:
 * a rejection is a hard upper bound, while an acceptance only proves the
 * prompt fit (the window may be far larger, so an accepted size is never a
 * window).
 *
 * The learned bound is therefore stored as `min(every rejection seen)`, and
 * every budget computation takes `min(declaredWindow, bound)`. Without this the
 * doctor keeps planning against a window the gateway already refused, which is
 * exactly the observed 2.4x-over-the-window prompt.
 *
 * Persistence: a plugin-owned JSON file in the active profile directory
 * (`$DSH_HOME/profiles/$DSH_PROFILE`), written atomically after a **byte-exact
 * backup** of the previous file. The store is intentionally separate from the
 * profile patch: it records an observation, it never rewrites the user's
 * declared configuration.
 *
 * @module @local/dsh-compaction-doctor/learn
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { num } from "./util.js";

/** Plugin-owned bounds file, beside the switch state file. */
export const WINDOW_BOUNDS_FILE_NAME = "compaction-doctor.window-bounds.json";

/** How many byte-exact backups of the bounds file to keep. */
export const MAX_BOUND_BACKUPS = 5;

/** The active profile directory: `$DSH_HOME/profiles/$DSH_PROFILE` (`desktop` by default). */
export function profileDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
  const name = process.env.DSH_PROFILE && process.env.DSH_PROFILE.length > 0 ? process.env.DSH_PROFILE : "desktop";
  return join(home, "profiles", name);
}

/** Where the learned bounds live. */
export function boundsFile(dir = profileDir()) {
  return join(dir, WINDOW_BOUNDS_FILE_NAME);
}

/** Stable store key for one provider/model pair. */
export function boundKey(provider, model) {
  const left = typeof provider === "string" && provider.length > 0 ? provider : "?";
  const right = typeof model === "string" && model.length > 0 ? model : "?";
  return `${left}/${right}`;
}

/**
 * Read the persisted store.
 *
 * A half-written, empty, non-JSON, or wrongly-shaped file reads as an empty
 * store: a corrupt observation must never be mistaken for a real bound, and it
 * must never turn into `0` (which would look like a closed window).
 *
 * @param file - store path; defaults to the active profile's.
 * @returns `{ entries: { [key]: number }, file, readable }`.
 */
export function readWindowBounds(file = boundsFile()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { entries: {}, file, readable: false };
  }
  const entries = {};
  const raw = parsed !== null && typeof parsed === "object" ? parsed.entries : undefined;
  if (raw !== null && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      const tokens = num(value, 0);
      if (tokens > 0) entries[key] = Math.floor(tokens);
    }
  }
  return { entries, file, readable: true };
}

/** Drop all but the newest `MAX_BOUND_BACKUPS` byte-exact backups of `file`. */
function pruneBoundBackups(file, limit = MAX_BOUND_BACKUPS) {
  const dir = dirname(file);
  const prefix = `${basename(file)}.bak-`;
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {
    return;
  }
  if (names.length <= limit) return;
  for (const name of names.sort().slice(0, names.length - limit)) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Persist the store atomically, after a byte-exact backup of the previous file.
 *
 * Never throws: a failed write leaves the in-memory bound in force, which is
 * the whole point of the bound (the process must keep planning correctly even
 * when it cannot persist).
 *
 * @param entries - the complete store to write.
 * @param file - store path.
 * @returns `{ ok, file, backup, bytes }`.
 */
export function writeWindowBounds(entries, file = boundsFile()) {
  const payload = `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }, null, 2)}\n`;
  const bytes = Buffer.byteLength(payload, "utf8");
  let backup;
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const stamp = `${Date.now()}-${process.pid}`;
      backup = `${file}.bak-${stamp}`;
      // Byte-exact copy of the file as it was: the backup is the rollback path,
      // so it must not be a re-serialization of what we just parsed.
      copyFileSync(file, backup);
      pruneBoundBackups(file);
    }
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, payload, "utf8");
      renameSync(tmp, file);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw error;
    }
    return { ok: true, file, backup, bytes };
  } catch (error) {
    return { ok: false, file, backup, bytes, error: error?.message ?? String(error) };
  }
}

/** The learned hard upper bound for one route, or `undefined` when none was learned. */
export function windowBoundFor(entries, provider, model) {
  const value = num(entries?.[boundKey(provider, model)], 0);
  return value > 0 ? value : undefined;
}

/** The window a budget may actually be planned against. */
export function effectiveWindow(declaredWindow, bound) {
  const declared = num(declaredWindow, 0);
  const learned = num(bound, 0);
  if (learned > 0 && declared > 0) return Math.min(declared, learned);
  if (learned > 0) return learned;
  return declared > 0 ? declared : 0;
}

/**
 * Record one rejection as a hard upper bound (F5).
 *
 * @param options.provider - routed provider id.
 * @param options.model - routed model id.
 * @param options.rejectedTokens - measured size of the prompt the provider refused.
 * @param options.declaredWindow - window the plugin was planning against.
 * @param options.file - store path; defaults to the active profile's.
 * @returns the learning record: the bound, the window to use now, and whether it changed.
 */
export function learnRejectedWindow({ provider, model, rejectedTokens, declaredWindow, file = boundsFile() } = {}) {
  const rejected = Math.floor(num(rejectedTokens, 0));
  const declared = Math.floor(num(declaredWindow, 0));
  const key = boundKey(provider, model);
  if (rejected <= 0) {
    return { key, provider, model, learned: false, reason: "no rejected size to learn from", declaredWindow: declared };
  }
  const store = readWindowBounds(file);
  const previous = windowBoundFor(store.entries, provider, model);
  const bound = previous === undefined ? rejected : Math.min(previous, rejected);
  const changed = previous === undefined || bound < previous;
  if (changed) store.entries[key] = bound;
  const persisted = changed ? writeWindowBounds(store.entries, file) : { ok: true, file, backup: undefined };
  return {
    key,
    provider,
    model,
    learned: changed,
    bound,
    previousBound: previous,
    rejectedTokens: rejected,
    declaredWindow: declared,
    effectiveWindow: effectiveWindow(declared, bound),
    file,
    backup: persisted.backup,
    persisted: persisted.ok === true,
  };
}

/** Whether a byte-exact backup of the store exists (test/diagnostics helper). */
export function listBoundBackups(file = boundsFile()) {
  const dir = dirname(file);
  const prefix = `${basename(file)}.bak-`;
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => {
        const full = join(dir, name);
        let bytes = 0;
        try {
          bytes = statSync(full).size;
        } catch {
          /* ignore */
        }
        return { file: full, name, bytes };
      })
      .sort((left, right) => (left.name < right.name ? -1 : 1));
  } catch {
    return [];
  }
}
