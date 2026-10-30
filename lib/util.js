/**
 * Shared helpers for the compaction doctor bundle.
 *
 * Nothing here imports internals of other `@deepseek-ai/*` packages: every
 * observation goes through documented service surface (`ctx.get`,
 * `session.eventAt`, `session.surface`, `ctx.logger`) or through a structural
 * byte measurement of the object that is about to be sent upstream.
 *
 * @module @local/dsh-compaction-doctor/util
 */

export const PREFIX = "[compaction-doctor]";

/** Numeric coercion that never yields NaN. */
export function num(value, fallback = 0) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Structured logger access with a console fallback. */
export function logLine(ctx, level, message) {
  const text = `${PREFIX} ${message}`;
  const logger = ctx?.logger;
  try {
    if (logger && typeof logger[level] === "function") {
      logger[level](text);
      return;
    }
  } catch {
    /* fall through to console */
  }
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  try {
    sink(text);
  } catch {
    /* ignore */
  }
}

export const info = (ctx, message) => logLine(ctx, "info", message);
export const warn = (ctx, message) => logLine(ctx, "warn", message);
export const debug = (ctx, message) => logLine(ctx, "debug", message);

/** Current surface sequence numbers of a session, oldest first. */
export function surfaceSeqs(session) {
  const nodes = session?.surface?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

/** Read one session event defensively. */
export function eventAt(session, seq) {
  try {
    const event = session?.eventAt?.(seq);
    return event === undefined ? undefined : event;
  } catch {
    return undefined;
  }
}

/**
 * Most recent routed target for a session, recovered from durable surface
 * events. `request/context` carries the window the harness resolved; the
 * fallback is the bundle's own configured route.
 */
export function latestRoute(session, fallback) {
  const seqs = surfaceSeqs(session);
  for (let i = seqs.length - 1; i >= 0; i -= 1) {
    const event = eventAt(session, seqs[i]);
    if (event === undefined) continue;
    const data = event.data ?? {};
    if (event.type === "request/context" && typeof data.model === "string") {
      return {
        provider: typeof data.provider === "string" ? data.provider : fallback?.provider,
        model: data.model,
        contextWindow: typeof data.contextWindow === "number" ? data.contextWindow : undefined,
        source: "request/context",
      };
    }
    if (event.type === "model/selection") {
      const provider = data.provider ?? data.route?.provider ?? data.target?.provider;
      const model = data.model ?? data.route?.model ?? data.target?.model;
      if (typeof model === "string") {
        return {
          provider: typeof provider === "string" ? provider : fallback?.provider,
          model,
          source: "model/selection",
        };
      }
    }
  }
  if (typeof fallback?.provider === "string" && typeof fallback?.model === "string") {
    return { ...fallback, source: "config" };
  }
  return undefined;
}

/** UTF-8 byte size of an arbitrary JSON-shaped value. */
export function byteSize(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    return 0;
  }
}

/** Conservative upstream token estimate for an arbitrary JSON-shaped value. */
export function estimateTokens(value, tokensPerByte) {
  const ratio = num(tokensPerByte, 0.34) || 0.34;
  return Math.ceil(byteSize(value) * ratio);
}

/** Deep clone that survives exotic values (keeps unknown getters intact). */
export function shallowClone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice();
  const out = {};
  for (const key of Object.keys(value)) out[key] = value[key];
  return out;
}

/** Best-effort free-form context window carried by a model descriptor. */
export function readContextWindow(descriptor) {
  if (descriptor === null || typeof descriptor !== "object") return undefined;
  const candidates = [
    descriptor.contextWindow,
    descriptor.context_window,
    descriptor.contextLength,
    descriptor.context_length,
    descriptor.maxContextTokens,
    descriptor.max_context_window,
    descriptor.max_input_tokens,
    descriptor.limits?.contextWindow,
    descriptor.limits?.context,
    descriptor.top_provider?.context_length,
  ];
  for (const candidate of candidates) {
    const n = num(candidate, 0);
    if (n > 0) return n;
  }
  return undefined;
}
