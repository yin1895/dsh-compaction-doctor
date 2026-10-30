/**
 * Overflow classification for provider errors the harness does not read.
 *
 * `@deepseek-ai/dsh-compaction-basic` only reacts to
 * `CONTEXT_WINDOW_EXCEEDED_CODE`. Adapters that do not translate a provider's
 * own phrasing into that brand (the DashScope Chinese 400 is the observed
 * case) leave the failure classified as `INVALID_REQUEST`, so the automatic
 * recovery path never runs. This module widens the *classification*, not the
 * recovery: the engine still performs a normal compaction and a normal retry.
 *
 * @module @local/dsh-compaction-doctor/overflow
 */

/** Provider phrasings that mean "your prompt does not fit my window". */
export const OVERFLOW_PATTERNS = [
  // DashScope / Alibaba Chinese 400s
  /内容太长/,
  /请精简输入/,
  /开启新对话/,
  /(上下文|输入|请求|对话|提示词|内容)[^\n]{0,12}(太长|过长|超出|超过|超限)/,
  /超出[^\n]{0,8}(限制|上限|窗口)/,
  /(最大|最长)[^\n]{0,8}(长度|上下文|token|限制)[^\n]{0,8}(超出|超过)/,
  // English provider phrasings
  /context[_ -]?length[^\n]{0,20}(exceed|too|limit|max)/i,
  /maximum context length/i,
  /context window[^\n]{0,20}(exceed|too|limit|small)/i,
  /(prompt|input|request|message)[^\n]{0,20}(too long|too large|exceeds?)/i,
  /(reduce|shorten|truncate)[^\n]{0,24}(length|input|prompt|messages)/i,
  /too many (input )?tokens/i,
  /number of tokens[^\n]{0,20}(exceed|limit)/i,
  /exceeds? (the )?(model'?s )?(maximum|max)[^\n]{0,20}(tokens|length|context)/i,
  /token[_ ]?limit[_ ]?exceeded/i,
  // Bare code-style markers
  /context_length_exceeded/i,
  /CONTEXT_WINDOW_EXCEEDED/,
];

const CHAIN_LIMIT = 4;
const FIELD_LIMIT = 2048;

const failureFields = ["message", "code", "type", "name", "body", "data", "response", "cause", "details", "param", "metadata"];

/** Flatten the interesting parts of a failure (and its cause chain) into text. */
export function failureText(failure) {
  const parts = [];
  const seen = new Set();
  let current = failure;
  for (let depth = 0; current !== undefined && current !== null && depth < CHAIN_LIMIT; depth += 1) {
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    if (typeof current === "string") {
      parts.push(current.slice(0, FIELD_LIMIT));
      break;
    }
    for (const field of failureFields) {
      let value;
      try {
        value = current[field];
      } catch {
        continue;
      }
      if (value === undefined || value === null || value === current) continue;
      if (field === "cause" || field === "details" || field === "body" || field === "data" || field === "response" || field === "metadata") continue;
      if (typeof value === "string") parts.push(value.slice(0, FIELD_LIMIT));
      else if (typeof value === "number" || typeof value === "boolean") parts.push(String(value));
    }
    current = current.cause;
  }
  for (const field of ["body", "data", "response", "details", "metadata"]) {
    try {
      const value = failure?.[field];
      if (value !== undefined && value !== null) parts.push(JSON.stringify(value).slice(0, FIELD_LIMIT * 4));
    } catch {
      /* ignore unserializable payloads */
    }
  }
  return parts.join("\n");
}

/**
 * Decide whether a failure means "prompt does not fit the upstream window".
 * @returns a short verdict string, or `undefined` when the failure is unrelated.
 */
export function isContextOverflowFailure(failure, contextWindowExceededCode) {
  if (failure === undefined || failure === null) return undefined;
  if (typeof failure.code === "string" && failure.code === contextWindowExceededCode) return "branded";
  const text = failureText(failure);
  if (text.length === 0) return undefined;
  for (const pattern of OVERFLOW_PATTERNS) {
    if (pattern.test(text)) return `matched:${pattern.source.slice(0, 48)}`;
  }
  return undefined;
}

/** Provider attribution for logging, e.g. `alibaba-dashscope`. */
export function providerAttribution(failure) {
  const fields = [failure?.metadata?.provider_name, failure?.provider, failure?.metadata?.provider, failure?.body?.metadata?.provider_name];
  for (const field of fields) if (typeof field === "string" && field.length > 0) return field;
  return undefined;
}
