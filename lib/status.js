/**
 * Settings-page transport for the compaction doctor.
 *
 * The browser half is a `settings.section` page. Engine *configuration* travels
 * over the official settings namespace (`ctx.configForms.get('compaction-doctor')`),
 * but runtime **status and actions** have no supported client seam: a namespace
 * field is writable by definition (no per-field read-only), so status must not
 * live there. This module therefore owns one `webServer` prefix route and the
 * JSON plumbing behind it; the doctor service owns the capabilities.
 *
 * `webServer` has no authentication of its own, and the `/api` Host/Origin fence
 * only covers routes registered under the `/api` prefix — so every request here
 * passes its own three gates before any work happens:
 *
 *   1. a custom `x-compaction-doctor` header (a cross-site simple request cannot
 *      set one without triggering a preflight),
 *   2. `Sec-Fetch-Site`, when present, must be `same-origin`,
 *   3. `Origin`, when present, must match the request `Host`.
 *
 * @module @local/dsh-compaction-doctor/status
 */

const MAX_BODY_BYTES = 65536;
const JSON_TYPE = "application/json";

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Evaluate the request gates.
 * @returns the rejection reason, or `undefined` when the request may proceed.
 */
export function guardRequest(req, headerName, prefix) {
  const headers = req?.headers ?? {};
  if (headers[headerName] === undefined) return `missing ${headerName} header`;
  const site = headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin") return `cross-site request (${site})`;
  const origin = headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return "unparseable origin";
    }
    const host = headers.host;
    if (typeof host !== "string" || parsed.host !== host) return `origin ${parsed.host} does not match host ${String(host)}`;
  }
  // Sanity: never serve outside the declared prefix.
  if (prefix !== undefined && typeof req?.url === "string" && req.url.startsWith(prefix) === false) return "outside route prefix";
  return undefined;
}

/** Collect and parse a JSON request body within a byte cap. */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, error: `request body exceeds ${limit} bytes` });
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (error) => finish({ ok: false, error: `request failed: ${error?.message ?? error}` }));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) {
        finish({ ok: true, value: {} });
        return;
      }
      try {
        const value = JSON.parse(text);
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          finish({ ok: false, error: "body must be a JSON object" });
          return;
        }
        finish({ ok: true, value });
      } catch (error) {
        finish({ ok: false, error: `invalid JSON: ${error?.message ?? error}` });
      }
    });
  });
}

/** Send one JSON response. Never throws. */
export function sendJson(res, status, payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (error) {
    status = 500;
    body = JSON.stringify({ ok: false, error: `response encoding failed: ${error?.message ?? error}` });
  }
  try {
    res.statusCode = status;
    res.setHeader("content-type", `${JSON_TYPE}; charset=utf-8`);
    res.setHeader("cache-control", "no-store");
    res.end(body);
  } catch {
    /* the socket is already gone */
  }
}

/**
 * Match one request against the frozen endpoint table
 * (`docs/api-contract.md` §2).
 * @param method - upper-case HTTP method.
 * @param suffix - pathname with the route prefix already stripped.
 * @returns the endpoint name, or `undefined`.
 */
export function matchRoute(method, suffix) {
  const path = suffix === "" ? "/" : suffix;
  if (method === "GET" && path === "/state") return "state";
  if (method === "POST" && path === "/diagnose") return "diagnose";
  if (method === "POST" && path === "/apply") return "apply";
  if (method === "GET" && path === "/config") return "config";
  if (method === "PUT" && path === "/config") return "writeConfig";
  if (method === "GET" && path === "/backups") return "backups";
  if (method === "POST" && path === "/restore") return "restore";
  return undefined;
}

/** Write operations additionally require a JSON content type. */
export function requiresJsonBody(endpoint) {
  return endpoint === "diagnose" || endpoint === "apply" || endpoint === "writeConfig" || endpoint === "restore";
}

/** The one capability surface `status.js` expects from the doctor service. */
export function missingCapabilities(doctor) {
  const names = [
    "stateSnapshot",
    "diagnose",
    "applyFix",
    "readConfigView",
    "writeConfigPatch",
    "listBackups",
    "restoreBackup",
  ];
  return names.filter((name) => typeof doctor?.[name] !== "function");
}

/**
 * Register the prefix route.
 *
 * @param ctx - host context owning the `webServer` service.
 * @param doctor - the doctor service exposing the capability surface above.
 * @param options - `{ prefix, headerName, logger }`.
 * @returns `{ installed, reason }`; the route is torn down with the plugin fiber.
 */
export function installStatusRoute(ctx, doctor, options = {}) {
  const prefix = options.prefix;
  const headerName = options.headerName;
  const log = options.logger ?? (() => {});
  let webserver;
  try {
    webserver = ctx.get("webServer");
  } catch {
    webserver = undefined;
  }
  if (webserver === undefined || webserver === null || typeof webserver.register !== "function") {
    return { installed: false, reason: "webServer service unavailable; /compact-doctor still works" };
  }
  const missing = missingCapabilities(doctor);
  if (missing.length > 0) return { installed: false, reason: `doctor is missing: ${missing.join(", ")}` };

  const handler = async (req, res) => {
    const rejected = guardRequest(req, headerName, prefix);
    if (rejected !== undefined) {
      log(`rejected ${req?.method ?? "?"} ${req?.url ?? "?"}: ${rejected}`);
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    let suffix;
    try {
      suffix = new URL(req.url ?? "/", "http://localhost").pathname.slice(prefix.length);
    } catch {
      sendJson(res, 400, { ok: false, error: "bad request target" });
      return;
    }
    const endpoint = matchRoute(String(req.method ?? "GET").toUpperCase(), suffix);
    if (endpoint === undefined) {
      sendJson(res, 404, { ok: false, error: `unknown endpoint ${suffix}` });
      return;
    }
    let body = {};
    if (requiresJsonBody(endpoint)) {
      const type = String(req.headers["content-type"] ?? "");
      if (type.startsWith(JSON_TYPE) === false) {
        sendJson(res, 415, { ok: false, error: "content-type must be application/json" });
        return;
      }
      const read = await readJsonBody(req);
      if (read.ok === false) {
        sendJson(res, 400, { ok: false, error: read.error });
        return;
      }
      body = read.value;
    }
    try {
      switch (endpoint) {
        case "state": {
          sendJson(res, 200, await doctor.stateSnapshot({ signal: undefined }));
          return;
        }
        case "diagnose": {
          sendJson(res, 200, await doctor.diagnose({ active: body.active === true }));
          return;
        }
        case "apply": {
          const result = await doctor.applyFix({
            contextWindow: body.contextWindow,
            maxTokens: body.maxTokens,
            confirm: body.confirm === true,
          });
          sendJson(res, result.ok === true ? 200 : 400, result);
          return;
        }
        case "config": {
          sendJson(res, 200, await doctor.readConfigView());
          return;
        }
        case "writeConfig": {
          const result = await doctor.writeConfigPatch({ patch: body.patch ?? body, confirm: body.confirm === true });
          sendJson(res, result.ok === true ? 200 : 400, result);
          return;
        }
        case "backups": {
          sendJson(res, 200, { ok: true, backups: await doctor.listBackups() });
          return;
        }
        case "restore": {
          const result = await doctor.restoreBackup({ file: body.file, confirm: body.confirm === true });
          sendJson(res, result.ok === true ? 200 : 400, result);
          return;
        }
        default: {
          sendJson(res, 404, { ok: false, error: `unknown endpoint ${endpoint}` });
        }
      }
    } catch (error) {
      log(`${endpoint} failed: ${error?.message ?? error}`);
      sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  };

  try {
    ctx.effect(() => webserver.register({ kind: "prefix", path: prefix, handler }), "compaction-doctor route");
  } catch (error) {
    return { installed: false, reason: `route registration failed: ${error?.message ?? error}` };
  }
  return { installed: true, reason: "ok" };
}

/**
 * Text-level editor for one row's `config:` block.
 *
 * `configEditor.edit()` is the supported path and preserves comments and `!!js`
 * expressions; this is the fallback for deployments where that service is
 * absent. It only handles top-level scalar keys, which is all this plugin needs,
 * and it leaves every other line byte-identical.
 *
 * @param text - the whole `cordis.patch.yml` document.
 * @param rowId - the row whose config block is edited.
 * @param patch - flat `{ key: value }` updates.
 * @returns `{ text, changed, reason }`.
 */
export function setRowConfigKeys(text, rowId, patch) {
  const keys = Object.entries(patch ?? {}).filter(([, value]) => value !== undefined);
  if (typeof text !== "string" || keys.length === 0) return { text, changed: false, reason: "nothing to write" };
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const idPattern = new RegExp(`^(\\s*)-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`, "u");
  let rowIndex = -1;
  let rowIndent = 0;
  for (const [index, line] of lines.entries()) {
    const match = idPattern.exec(line);
    if (match !== null) {
      rowIndex = index;
      rowIndent = match[1].length;
      break;
    }
  }
  if (rowIndex < 0) return { text, changed: false, reason: `row ${rowId} not found` };
  const keyIndent = rowIndent + 2;
  const keyIndentText = " ".repeat(keyIndent);
  const valueIndentText = " ".repeat(keyIndent + 2);

  let blockEnd = rowIndex + 1;
  for (; blockEnd < lines.length; blockEnd += 1) {
    const line = lines[blockEnd];
    if (line.trim() === "") continue;
    if (line.length - line.trimStart().length < keyIndent) break;
  }

  const configPattern = new RegExp(`^\\s{${keyIndent}}config:\\s*$`, "u");
  let configIndex = -1;
  for (let index = rowIndex + 1; index < blockEnd; index += 1) {
    if (configPattern.test(lines[index])) {
      configIndex = index;
      break;
    }
  }

  const rendered = (key, value) => `${valueIndentText}${key}: ${renderScalar(value)}`;
  const changed = [];

  if (configIndex < 0) {
    // No config block yet: insert one after the row's `name:` line.
    const namePattern = new RegExp(`^\\s{${keyIndent}}name:\\s*\\S`, "u");
    let insertAt = rowIndex + 1;
    for (let index = rowIndex + 1; index < blockEnd; index += 1) {
      if (namePattern.test(lines[index])) {
        insertAt = index + 1;
        break;
      }
    }
    lines.splice(insertAt, 0, `${keyIndentText}config:`, ...keys.map(([key, value]) => rendered(key, value)));
    return { text: lines.join(newline), changed: true, reason: `created config for ${rowId}: ${keys.map(([key]) => key).join(", ")}` };
  }

  let blockStop = configIndex + 1;
  for (; blockStop < blockEnd; blockStop += 1) {
    const line = lines[blockStop];
    if (line.trim() === "") continue;
    if (line.length - line.trimStart().length <= keyIndent) break;
  }
  const flatPattern = (key) => new RegExp(`^(\\s*)${escapeRegExp(key)}:\\s`, "u");
  const insertions = [];
  for (const [key, value] of keys) {
    let found = -1;
    for (let index = configIndex + 1; index < blockStop; index += 1) {
      if (flatPattern(key).test(lines[index])) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      insertions.push(rendered(key, value));
      changed.push(key);
      continue;
    }
    const next = lines[found].replace(/^(\s*)([A-Za-z0-9_.$-]+):\s.*$/u, (_all, indent, name) => `${indent}${name}: ${renderScalar(value)}`);
    if (next !== lines[found]) {
      lines[found] = next;
      changed.push(key);
    }
  }
  if (insertions.length > 0) lines.splice(blockStop, 0, ...insertions);
  if (changed.length === 0) return { text, changed: false, reason: `row ${rowId}: values already match` };
  return { text: lines.join(newline), changed: true, reason: `${rowId}: ${changed.join(", ")}` };
}

/** Render one YAML scalar for the text fallback. */
export function renderScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === null) return "null";
  const text = String(value);
  if (/^[A-Za-z0-9_./@-]+$/u.test(text)) return text;
  return JSON.stringify(text);
}
