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

/**
 * Best-effort free-form context window carried by a model descriptor.
 *
 * The shapes that matter in practice:
 *  - `@deepseek-ai/dsh-llm-pi-ai` answers `resolveModelInfo` with
 *    `{ context: { contextWindow } }` (`dsh-llm-pi-ai/lib/index.js:1921`), so the
 *    nested `context` object is the adapter's own authoritative number and must
 *    be read before any outer heuristic field.
 *  - the official adapter answers with a flat descriptor.
 */
export function readContextWindow(descriptor) {
  if (descriptor === null || typeof descriptor !== "object") return undefined;
  const candidates = [
    descriptor.context?.contextWindow,
    descriptor.context?.context_window,
    descriptor.context?.contextLength,
    descriptor.context?.context_length,
    descriptor.context?.maxInputTokens,
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

// ---------------------------------------------------------------------------
// the adapter's own token yardstick (F1)
// ---------------------------------------------------------------------------

/**
 * The shipped heuristic density shared by the meter service and the pure
 * breakdown projection (`dsh-token-meter/lib/index.js:16-18`).
 */
const CHARS_PER_TOKEN = 4;
/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4;

/** Structural price of one block (`dsh-token-meter/lib/index.js:27-33`). */
function pricedStructuralBlock(block) {
  if (block !== null && typeof block === "object" && block.type === "image") {
    const { offloaded: _offloaded, ...reference } = block;
    return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN);
  }
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
}

/** Price content blocks (`dsh-token-meter/lib/index.js:39-52`). */
function pricedContent(blocks) {
  if (typeof blocks === "string") return Math.ceil(blocks.length / CHARS_PER_TOKEN);
  if (!Array.isArray(blocks)) return 0;
  let tokens = 0;
  for (const block of blocks) {
    switch (block?.type) {
      case "text":
      case "reasoning":
        tokens += Math.ceil(String(block.text ?? "").length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
        break;
      case "tool-call":
        tokens +=
          Math.ceil(String(block.name ?? "").length / CHARS_PER_TOKEN) +
          Math.ceil(String(block.arguments ?? "").length / CHARS_PER_TOKEN) +
          BLOCK_OVERHEAD;
        break;
      default:
        tokens += pricedStructuralBlock(block);
    }
  }
  return tokens;
}

/** Price one model-visible message (`dsh-token-meter/lib/index.js:61-76`). */
export function estimateMessageHeuristic(message) {
  if (message === null || typeof message !== "object") return 0;
  if (message.role === "system") {
    const content = message.content;
    if (Array.isArray(content) && content.length === 0) return 0;
    if (typeof content === "string") return content.length === 0 ? 0 : Math.ceil(content.length / CHARS_PER_TOKEN) + 4;
    let characters = 0;
    for (const block of Array.isArray(content) ? content : []) {
      characters += block?.type === "text" ? String(block.text ?? "").length : JSON.stringify(block).length;
    }
    return Math.ceil(characters / CHARS_PER_TOKEN) + 4;
  }
  return pricedContent(message.content) + 4;
}

/**
 * Price one message the way the *adapter* will.
 *
 * The live `tokenMeter` exposes the shipped instance face of the same heuristic
 * (`dsh-token-meter/lib/index.js:777-785`), so it is preferred whenever it is
 * mounted; the local copy exists because a compaction budget must never depend
 * on a service being present in order to stay inside the window.
 */
export function estimateMessageTokens(meter, message) {
  if (typeof meter?.estimateMessage === "function") {
    try {
      const value = num(meter.estimateMessage(message), -1);
      if (value >= 0) return Math.floor(value);
    } catch {
      /* fall through to the shipped formula */
    }
  }
  return estimateMessageHeuristic(message);
}

/**
 * Price a request's tool schemas: the canonical envelope's only priced field
 * (`dsh-token-meter/lib/index.js:83-86`).
 */
export function estimateToolsTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}

// ---------------------------------------------------------------------------
// official vs third-party routes (F6)
// ---------------------------------------------------------------------------

/**
 * Provider route ids the shipped official DeepSeek adapter serves.
 *
 * `dsh-base/cordis.patch.yml:91-94` routes the default agent at
 * `provider: deepseek-official`; `dsh-llm-deepseek-api-key/lib/index.js:47`
 * pins the same id for the api-key variant, and
 * `dsh-client-ui-settings-models/lib/client.js:1461` shows that route's
 * `settingsNs` is `llm-deepseek`. `deepseek-account` is the account-backed
 * sibling route of the same official adapter. Every other provider id is
 * reached through a gateway (`@deepseek-ai/dsh-llm-pi-ai`), which is where the
 * repairs must apply.
 */
export const OFFICIAL_PROVIDER_IDS = ["deepseek-official", "deepseek-account"];

/** Hostname of a URL, or undefined when it is not a parseable absolute URL. */
export function hostOf(url) {
  if (typeof url !== "string" || url.length === 0) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The official DeepSeek public endpoint root (`dsh-llm-deepseek/lib/index.js:347,441`). */
const OFFICIAL_HOST_SUFFIX = "deepseek.com";

/**
 * Whether one routed target is an official DeepSeek endpoint.
 *
 * F6: on an official route the shipped engine is the better engine — it is the
 * one whose policy the deployment was tuned for — so every doctor override must
 * stand down completely.
 *
 * Decision order (authoritative first, `docs/surface-contract.md` §6.1-§6.2):
 *  1. `declared` from `ctx.llm.listConfigurableProviders()` — the one
 *     authoritative field. `declared === true` means the provider id has **no**
 *     entry in pi-ai's shipped catalog, i.e. it is a hand-declared third-party
 *     gateway (`dsh-llm-pi-ai/lib/index.js:2850`), so the repairs apply;
 *     `declared === false` means the shipped catalog describes the route.
 *  2. An explicit `officialProviders` override (settings page / tests).
 *  3. Last resort when no directory entry exists for the route at all (a route
 *     served by another adapter): the official adapter's own route ids and the
 *     `deepseek.com` endpoint host. A route this cannot classify is treated as a
 *     gateway, because every repair is safe there and the official engine needs
 *     none of them.
 *
 * @param route - `{ provider, model, baseURL? }` as recovered from the surface.
 * @param options.declared - the directory's `declared` flag, when available.
 * @param options.officialProviders - explicit override set.
 * @param options.baseURL - a declared endpoint to classify when the id is inconclusive.
 */
export function isOfficialProvider(route, options = {}) {
  if (typeof options.declared === "boolean") return options.declared === false;
  const declared = Array.isArray(options.officialProviders) && options.officialProviders.length > 0 ? options.officialProviders : OFFICIAL_PROVIDER_IDS;
  const id = typeof route?.provider === "string" ? route.provider : undefined;
  if (id !== undefined && declared.includes(id)) return true;
  const host = hostOf(options.baseURL ?? route?.baseURL);
  if (host !== undefined && (host === OFFICIAL_HOST_SUFFIX || host.endsWith(`.${OFFICIAL_HOST_SUFFIX}`))) return true;
  return false;
}
