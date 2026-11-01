/**
 * Rebuild `test/fixtures/overflow-401k.jsonl` from the failed session.
 *
 * The session file is a **multi-frame** zstd stream (one frame per append), so
 * both `zstdDecompressSync` and a streaming reader only ever see the first
 * frame: the frames have to be split on the zstd magic and decoded one by one.
 *
 *   node test/fixtures/build.mjs <session.v4.jsonl.zstd>
 *
 * The builder is deterministic and read-only towards the session: it decodes it,
 * keeps two structural anchors plus the failure tail, replaces every free-text
 * payload with an **equal-length** filler, and writes the fixture. Equal length
 * matters: the replay feeds the fixture into the engine's token estimation, so a
 * fixture whose payloads shrank would change the very numbers under test.
 *
 * Sanitisation rules (the fixture may never carry the operator's own data):
 *   - structural / numeric / identifier keys are kept verbatim;
 *   - every `error` subtree is kept verbatim (the two alternating failures and the
 *     terminal 400 body are the evidence this fixture exists for);
 *   - every other string is replaced by a filler of the same UTF-8 byte length:
 *     ASCII -> `x`, 2-byte -> `\u00a1`, 3-byte -> `\u6d4b`, 4-byte -> `\u10348`.
 *
 * @module test/fixtures/build
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Anchors kept ahead of the tail: the declared window and the accepted-input peak. */
const ANCHORS = [16, 917];
/** Failure tail: the last productive step through `turn/end`. */
const TAIL_FROM = 1194;
const TAIL_TO = 1257;

/**
 * Keys whose value is kept exactly as recorded: structure, identifiers, numbers
 * and the recorded errors. Everything else is payload.
 */
const KEEP_KEYS = new Set([
  "type", "seq", "time", "version",
  "turn", "step", "role", "kind", "code", "name", "status", "cause", "isError", "form",
  "provider", "model", "contextWindow", "maxTokens", "usage", "mediaType",
  "callId", "toolCallId", "rootCallId", "jobId", "compactionId", "owner",
  "surfaceOp", "sourceEventSeqs",
  "shadowedRange", "shadowedSeqs", "shadowedTokenCount",
  "startedAt", "finishedAt", "producerReported",
  // evidence subtrees: the two alternating compaction errors, the finish failure
  // and the terminal 400 body
  "error", "reason", "failure",
]);

/** A filler of exactly the same UTF-8 byte length as `text`. */
function filler(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) out += "x";
    else if (code < 0x800) out += "\u00a1";
    else if (code < 0x10000) out += "\u6d4b";
    else out += "\u10348";
  }
  return out;
}

const stats = { strings: 0, chars: 0, bytes: 0, kept: 0, redactions: new Map() };

/**
 * Shape-based redaction of the two real identifiers the fixture would otherwise
 * carry into a public repository: the failing session's id and the private
 * gateway label in `provider` fields.
 *
 * Nothing here is keyed on a hardcoded literal — a literal would just move the
 * leak into this file. Both rules work on **shape**, and both are
 * length-preserving by construction, which is what keeps the fixture
 * byte-for-byte comparable with the recorded session:
 *
 *  - `session-<uuid>`: the 36 id characters become `x` with the dash positions
 *    kept, so the result is still a 44-character session id — but a shape-based
 *    scanner (the kind that looks for `session-[0-9a-f]{8}-…`) finds **nothing**,
 *    and no reader can mistake it for a real id;
 *  - each distinct `provider` value: replaced by `gw-<i>` padded to the original
 *    length, so no information about the original survives while two providers
 *    stay distinguishable.
 */
const SESSION_ID_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const SYNTHETIC_SESSION_ID_RE = /session-x{8}-x{4}-x{4}-x{4}-x{12}/gu;
const SYNTHETIC_ID_CHAR = "x";
/**
 * Opaque ids from the operator's own session (compaction/call ids). They are
 * UUID-shaped values of no use to any assertion here, so they get the same
 * treatment — but **key-anchored**, so a UUID appearing inside one of the
 * preserved error strings is never touched.
 */
const ID_VALUE_RE = /("(?:compactionId|callId|toolCallId|rootCallId)":")([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(")/gu;

/** The synthetic id for a provider at `index`, padded to exactly `length` bytes. */
function syntheticProvider(index, length) {
  const head = `gw-${index}`;
  if (length <= head.length) return head.slice(0, length).padEnd(length, "0");
  return head.padEnd(length, String(index % 10));
}

/** Every distinct `provider` field value in the picked entries. */
function providerValues(entries) {
  const found = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "provider" && typeof child === "string" && child.length > 0) found.add(child);
      walk(child);
    }
  };
  for (const entry of entries) walk(entry);
  return [...found];
}

/** Re-encode every `session-<uuid>` in one serialized line, keeping its length. */
function redactSessionIds(text) {
  return text.replace(SESSION_ID_RE, (hit) => {
    const uuid = hit.slice("session-".length);
    const mapped = [...uuid].map((ch) => (ch === "-" ? "-" : SYNTHETIC_ID_CHAR)).join("");
    if (mapped.length !== uuid.length) throw new Error("session id redaction changed the length");
    stats.redactions.set("session id", (stats.redactions.get("session id") ?? 0) + 1);
    return `session-${mapped}`;
  });
}

/** Apply every redaction rule to one serialized entry. */
function redact(line, providerMap) {
  let out = redactSessionIds(line);
  out = out.replace(ID_VALUE_RE, (hit, head, uuid, tail) => {
    stats.redactions.set("opaque id", (stats.redactions.get("opaque id") ?? 0) + 1);
    return head + uuid.replace(/[^-]/gu, SYNTHETIC_ID_CHAR) + tail;
  });
  for (const [real, synthetic] of providerMap) {
    if (Buffer.byteLength(real, "utf8") !== Buffer.byteLength(synthetic, "utf8")) {
      throw new Error(`provider redaction is not the same byte length for a ${real.length}-char id`);
    }
    const quoted = JSON.stringify(real);
    const parts = out.split(quoted);
    if (parts.length > 1) {
      stats.redactions.set("provider label", (stats.redactions.get("provider label") ?? 0) + parts.length - 1);
      out = parts.join(JSON.stringify(synthetic));
    }
  }
  if (Buffer.byteLength(out, "utf8") !== Buffer.byteLength(line, "utf8")) {
    throw new Error("redaction changed the byte length of an entry");
  }
  return out;
}

/** Sanitise one JSON value, keeping `KEEP_KEYS` subtrees verbatim. */
function clean(value, key, keepSubtree) {
  if (Array.isArray(value)) return value.map((item) => clean(item, key, keepSubtree));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const keep = keepSubtree === true || KEEP_KEYS.has(childKey);
      if (keep) {
        if (typeof childValue === "string") stats.kept += 1;
        out[childKey] = childValue;
      } else {
        out[childKey] = clean(childValue, childKey, false);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    if (keepSubtree === true || KEEP_KEYS.has(key)) {
      stats.kept += 1;
      return value;
    }
    const replaced = filler(value);
    if (Buffer.byteLength(replaced, "utf8") !== Buffer.byteLength(value, "utf8")) {
      throw new Error(`filler changed the byte length of a ${Buffer.byteLength(value, "utf8")}-byte payload`);
    }
    stats.strings += 1;
    stats.chars += [...value].length;
    stats.bytes += Buffer.byteLength(value, "utf8");
    return replaced;
  }
  return value;
}

/** Decode every zstd frame of an append-only session log. */
function decodeAll(buf) {
  const starts = [];
  for (let index = buf.indexOf(ZSTD_MAGIC); index >= 0; index = buf.indexOf(ZSTD_MAGIC, index + 1)) starts.push(index);
  if (starts.length === 0) throw new Error("no zstd frame found");
  const parts = [];
  let cursor = 0;
  while (cursor < starts.length) {
    let advanced = false;
    for (let next = cursor + 1; next <= starts.length; next += 1) {
      const end = next < starts.length ? starts[next] : buf.length;
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(starts[cursor], end)));
        cursor = next;
        advanced = true;
        break;
      } catch {
        /* the frame is longer than this span: try the next boundary */
      }
    }
    if (advanced === false) break;
  }
  return Buffer.concat(parts).toString("utf8").split("\n").filter((line) => line.length > 0);
}

function main() {
  const sessionPath = process.argv[2];
  if (sessionPath === undefined) {
    console.error("usage: node test/fixtures/build.mjs <session.v4.jsonl.zstd>");
    process.exitCode = 2;
    return;
  }
  const buf = fs.readFileSync(sessionPath);
  const frames = [];
  for (let index = buf.indexOf(ZSTD_MAGIC); index >= 0; index = buf.indexOf(ZSTD_MAGIC, index + 1)) frames.push(index);

  const entries = decodeAll(buf).map((line) => JSON.parse(line));
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));

  const picked = [];
  for (const seq of ANCHORS) {
    const entry = bySeq.get(seq);
    if (entry === undefined) throw new Error(`anchor seq ${seq} missing from the session`);
    picked.push(entry);
  }
  const tail = entries.filter((entry) => entry.seq >= TAIL_FROM && entry.seq <= TAIL_TO);
  if (tail.length !== TAIL_TO - TAIL_FROM + 1) throw new Error(`tail is not contiguous: ${tail.length} entries`);
  picked.push(...tail);

  const providerMap = new Map(providerValues(picked).map((value, index) => [value, syntheticProvider(index, value.length)]));

  const cleaned = picked.map((entry) => {
    const kept = { type: entry.type, seq: entry.seq, time: entry.time, data: clean(entry.data, "data", false) };
    if (entry.surfaceOp !== undefined) kept.surfaceOp = entry.surfaceOp;
    if (entry.sourceEventSeqs !== undefined) kept.sourceEventSeqs = entry.sourceEventSeqs;
    return JSON.stringify(kept);
  });
  // How many session ids actually survived sanitisation as kept strings: exactly
  // those must come back out as synthetic ones.
  const keptIds = cleaned.join("\n").match(SESSION_ID_RE) ?? [];
  const lines = cleaned.map((line) => redact(line, providerMap));

  const out = path.join(HERE, "overflow-401k.jsonl");
  fs.writeFileSync(out, `${lines.join("\n")}\n`, "utf8");

  // Self-check: no real identifier may survive, no hex-shaped session id may
  // remain, and the byte count must not move.
  const written = fs.readFileSync(out, "utf8");
  const realIds = new Set(picked.map((entry) => JSON.stringify(entry)).join("\n").match(SESSION_ID_RE) ?? []);
  const survivors = [...new Set([...realIds, ...providerMap.keys()])].filter((value) => written.includes(value));
  if (survivors.length > 0) throw new Error(`real identifier(s) survived: ${survivors.length}`);
  const hexShaped = (written.match(SESSION_ID_RE) ?? []).length;
  if (hexShaped > 0) throw new Error(`a hex-shaped session id survived (${hexShaped})`);
  const syntheticIds = written.match(SYNTHETIC_SESSION_ID_RE) ?? [];
  if (syntheticIds.length !== keptIds.length) {
    throw new Error(`expected ${keptIds.length} synthetic session ids, found ${syntheticIds.length}`);
  }
  const sanitizedBytes = Buffer.byteLength(written, "utf8");
  const originalBytes = picked.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0);
  console.log(`session        : ${path.basename(path.dirname(sessionPath))}/${path.basename(sessionPath)}`);
  console.log(`zstd frames    : ${frames.length}`);
  console.log(`entries decoded: ${entries.length}`);
  console.log(`fixture        : ${lines.length} entries (anchors ${ANCHORS.join(",")} + tail ${TAIL_FROM}..${TAIL_TO})`);
  console.log(`payload filled : ${stats.strings} strings / ${stats.chars} chars / ${stats.bytes} bytes`);
  console.log(`kept strings   : ${stats.kept}`);
  console.log(`redacted       : ${[...stats.redactions].map(([what, hits]) => `${what} ${hits}x`).join(", ") || "none"}`);
  console.log(`synthetic ids  : ${[...providerMap.values()].join(", ")} + ${syntheticIds.length} synthetic session id(s) (same length as the originals)`);
  console.log(`self-check     : ${survivors.length === 0 ? "no real identifier survives" : `${survivors.length} survivor(s)`}; hex-shaped session ids in the output: ${(written.match(SESSION_ID_RE) ?? []).length}`);
  console.log(`size           : ${originalBytes} -> ${sanitizedBytes} bytes of JSON`);
  console.log(`written        : ${out}`);
}

main();
