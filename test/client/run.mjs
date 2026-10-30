/**
 * Offline verification of the browser half (`lib/client.js`) — the one-switch page.
 *
 * No browser and no DSH process are needed. The script loads the bundle exactly the way the
 * web shell does — a classic script calling `window.__ModuleLoader__.load({ id, factory })` —
 * then checks the frozen contracts plus a render + switch-driving smoke test:
 *
 *   static : syntax, no top-level ESM, one registration, package-name id, platform-seed-only
 *            `require`, `settings.section` options, exactly two request paths (state + config),
 *            no configuration-form channel, no interval timer, style-cleanup ownership,
 *            locale key parity, jargon/number-free copy;
 *   render : `apply(ctx)` registers one section; the component renders intro + the single
 *            switch + one status line, contains exactly one interactive control, and survives
 *            a dead transport;
 *   drive  : a fake transport walks the whole page — a mount reads state once, the status line
 *            follows the host key, flipping the switch writes exactly `{"enabled":…}`, the page
 *            re-reads until the hot-reloaded value shows, and a rejected write falls back to
 *            the host's real value instead of breaking the page.
 *
 * Note on the harness: DSH mounts the section when the user selects it and unmounts it when
 * they leave, so `mount()` below is exactly that — a fresh component render plus its effects.
 * Between mounts the harness only re-renders, which is how React behaves with empty deps.
 *
 * Run: node test/client/run.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const results = [];
const check = (name, pass, detail = "") => results.push({ name, pass: Boolean(pass), detail });

const src = fs.readFileSync(path.join(root, "lib/client.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const ROUTE = "/dsh-compaction-doctor";

// ── static contract ──────────────────────────────────────────────────────────
let syntaxError;
try {
  new vm.Script(src, { filename: "client.js" });
} catch (error) {
  syntaxError = error;
}
check("parses as a classic script", syntaxError === undefined, syntaxError?.message ?? "");
check("no top-level import", !/^[ \t]*import[\s{"']/mu.test(src));
check("no top-level export", !/^[ \t]*export[\s{]/mu.test(src));

const SEEDS = new Set([
  "react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis", "zod",
  "@tanstack/react-virtual", "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit",
]);
const strayRequires = [...new Set([...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gu)].map((m) => m[1]))].filter((name) => !SEEDS.has(name));
check("require() only reaches platform seeds", strayRequires.length === 0, strayRequires.join(","));

check("package declares a web client half", pkg.dsh?.client?.platform === "web");
check("exports ./client points at lib/client.js", pkg.exports?.["./client"] === "./lib/client.js");
check("files ships lib", Array.isArray(pkg.files) && pkg.files.includes("lib"));
const iconPath = typeof pkg.icon === "string" ? path.join(root, pkg.icon) : "";
check(
  "icon is a relative in-package file under 256 KiB",
  iconPath !== "" && path.isAbsolute(pkg.icon) === false && fs.existsSync(iconPath) && fs.statSync(iconPath).size <= 256 * 1024,
  pkg.icon,
);

const route = /var\s+ROUTE\s*=\s*['"](\/dsh-compaction-doctor)['"]/u.exec(src);
check("route prefix matches the contract", route?.[1] === ROUTE, String(route?.[1]));

// The page talks over exactly two paths: state (read) and config (write).
const quotedSuffixes = [...new Set([...src.matchAll(/api\(\s*['"]([^'"]+)['"]/gu)].map((m) => m[1]))].sort();
check(
  "request path set is exactly state + config",
  quotedSuffixes.join(",") === "/config,/state",
  quotedSuffixes.join(","),
);
check("no configuration-form channel in the source", /configForms/u.test(src) === false);
check("no interval timer in the source", /setInterval/u.test(src) === false);
check("sends the route guard header", /x-compaction-doctor/iu.test(src));
const fetchSites = [...src.matchAll(/\bfetch\s*\(/gu)].length;
check("exactly one request entry point", fetchSites === 1, `fetch( count=${fetchSites}`);

const pkgConstant = /var\s+PKG\s*=\s*['"]([^'"]+)['"]/u.exec(src);
check("PKG constant equals the package name", pkgConstant?.[1] === pkg.name, String(pkgConstant?.[1]));
check("style cleanup is owned by dataset.plugin = PKG", /dataset\.plugin\s*=\s*PKG\b/u.test(src));
check("style dedupe uses data-plugin-css", /dataset\.pluginCss\s*=\s*CSS_TAG/u.test(src));

const zh = JSON.parse(fs.readFileSync(path.join(root, "locale/zh.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(root, "locale/en.json"), "utf8"));
const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();
check(
  "locale key sets are identical (ctx.locale.register throws otherwise)",
  zhKeys.length === enKeys.length && zhKeys.every((key, index) => key === enKeys[index]),
  `zh=${zhKeys.length} en=${enKeys.length}`,
);
check("the copy stays inside the key budget", zhKeys.length <= 14, `${zhKeys.length} keys`);

const AUTO_KEYS = ["off", "none", "pending", "running", "ok", "found", "fixed", "failed"].map((name) => `auto.${name}`);
const missingAuto = AUTO_KEYS.filter((key) => !zhKeys.includes(key) || !enKeys.includes(key));
check("every host status key has a localised line", missingAuto.length === 0, missingAuto.join(","));
check("the status line keys exist", ["state.loading", "state.unavailable"].every((key) => zhKeys.includes(key)));

// The page must not explain itself with internal vocabulary, and shows no numbers at all.
const BANNED = [
  "阈值", "预算", "保留比", "缩放", "系数", "遮蔽", "命名空间", "指标", "参数", "字段",
  "headroom", "policy", "shadow", "token", "revision", "volatile", "configForms", "meter",
];
const jargon = [];
const digits = [];
const camel = [];
for (const [key, text] of Object.entries({ ...zh, ...en })) {
  const value = String(text);
  const lower = value.toLowerCase();
  for (const word of BANNED) {
    if (lower.includes(word.toLowerCase())) jargon.push(`${key}:${word}`);
  }
  if (/\d/u.test(value)) digits.push(key);
  // {placeholders} are substituted before anything reaches the screen, so they are not copy.
  if (/[a-z]+[A-Z][a-zA-Z]*/u.test(value.replace(/\{\w+\}/gu, ""))) camel.push(key);
}
check("no internal vocabulary in the copy", jargon.length === 0, jargon.join(","));
check("no numbers anywhere in the copy", digits.length === 0, digits.join(","));
check("no field names in the copy", camel.length === 0, camel.join(","));

// ── module registration + apply ──────────────────────────────────────────────
const styleTags = [];
const registrations = [];
const timers = [];
const sandbox = {
  console,
  window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "", setAttribute() {} }),
    head: { appendChild: (tag) => styleTags.push(tag) },
    body: {},
  },
  // Deterministic clock: the page waits before re-reading state, so the test drives the wait.
  setTimeout: (fn) => timers.push(fn),
  clearTimeout: () => {},
  fetch: () => Promise.reject(new Error("offline")),
  navigator: {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "client.js" });

check("registers exactly one module", registrations.length === 1, `count=${registrations.length}`);
check("module id equals the package name", registrations[0]?.id === pkg.name, String(registrations[0]?.id));

// Mini React with real hook storage so several renders can be driven in sequence.
const hooks = [];
let cursor = 0;
let pendingEffects = [];
const React = {
  Fragment: "Fragment",
  // Positional children win (React semantics); props.children is kept when there are none.
  createElement: (type, props, ...children) => {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged };
  },
  useState(initial) {
    const index = cursor;
    cursor += 1;
    if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
    const set = (value) => {
      hooks[index] = typeof value === "function" ? value(hooks[index]) : value;
    };
    return [hooks[index], set];
  },
  useReducer: (_reducer, initial) => [initial, () => {}],
  useEffect(fn) {
    cursor += 1;
    pendingEffects.push(fn);
  },
  useLayoutEffect() {
    cursor += 1;
  },
  useRef(value) {
    const index = cursor;
    cursor += 1;
    if (!(index in hooks)) hooks[index] = { current: value };
    return hooks[index];
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  memo: (fn) => fn,
};
const requireStub = (name) => {
  if (name === "react") return React;
  if (name === "react/jsx-runtime") return { jsx: React.createElement, jsxs: React.createElement, Fragment: "Fragment" };
  throw new Error(`unexpected require(${name})`);
};
const plugin = registrations[0]?.factory(requireStub);
check("factory returns a cordis plugin module", typeof plugin?.apply === "function");
check("factory declares a name", typeof plugin?.name === "string", String(plugin?.name));
check(
  "inject stays the two hard dependencies",
  JSON.stringify(plugin?.inject) === JSON.stringify(["slots", "locale"]),
  JSON.stringify(plugin?.inject),
);

const sections = [];
const ctx = {
  effect(callback) {
    if (typeof callback !== "function") return () => {};
    const produced = callback();
    if (produced !== null && typeof produced === "object" && typeof produced.next === "function") {
      let step = produced.next();
      while (step.done !== true) step = produced.next();
    }
    return () => {};
  },
  on: () => () => {},
  get: () => undefined, // no optional client services in this deployment
  locale: {
    register: () => () => {},
    // A real translator: rendered text is the shipped zh copy, so assertions can compare
    // against locale/zh.json instead of a placeholder prefix.
    bind: () => (key) => (key in zh ? zh[key] : key),
    getSnapshot: () => ({ revision: 1 }),
    subscribe: () => () => {},
  },
  slots: {
    inject(key, callback) {
      check("injects into settings.section", key === "settings.section", String(key));
      const produced = callback();
      if (produced !== null && typeof produced === "object" && typeof produced.next === "function") {
        let step = produced.next();
        while (step.done !== true) step = produced.next();
      }
      return () => {};
    },
    register: (options, component) => {
      sections.push({ options, component });
      return () => {};
    },
  },
};

let applyError;
try {
  plugin.apply(ctx);
} catch (error) {
  applyError = error;
}
check("apply() runs without throwing", applyError === undefined, applyError?.message ?? "");
check("registers exactly one settings section", sections.length === 1, `count=${sections.length}`);
const options = sections[0]?.options ?? {};
check("section id is 'compaction'", options.id === "compaction", String(options.id));
check("section order is 40", options.order === 40, String(options.order));
check("section label resolves to a string", typeof options.label === "function" && typeof options.label() === "string", String(options.label?.()));
const injected = options.inject?.() ?? {};
check(
  "the entry injects only the translator",
  JSON.stringify(Object.keys(injected)) === JSON.stringify(["t"]),
  Object.keys(injected).join(","),
);

// ── fake transport ───────────────────────────────────────────────────────────
const requests = [];
const cleanups = [];
const server = {
  auto: { key: "auto.off", params: {} },
  // After a write the host hot-reloads; `stale` keeps serving the pre-write value for that
  // many reads so the page's retry loop can be observed.
  real: false,
  visible: false,
  stale: 0,
  rejectWrite: false,
};
const send = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
sandbox.fetch = async (url, init) => {
  requests.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body, kind: "http" });
  const suffix = url.slice(ROUTE.length);
  if (suffix === "/state") {
    if (server.stale > 0) server.stale -= 1;
    else server.visible = server.real;
    return send(200, {
      ok: true,
      enabled: server.visible,
      route: { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash" },
      auto: server.visible === server.real && server.stale === 0 ? server.auto : { key: "auto.off", params: {} },
      version: "0.4.0",
      unavailable: false,
    });
  }
  if (suffix === "/config") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (server.rejectWrite === true) return send(400, { ok: false, error: "write rejected" });
    server.real = body.enabled === true;
    server.auto = server.real ? { key: "auto.pending", params: {} } : { key: "auto.off", params: {} };
    return send(200, { ok: true, config: { enabled: server.real }, hotReload: true });
  }
  return send(404, { ok: false, error: "not found" });
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const fireTimers = () => {
  const due = timers.splice(0, timers.length);
  for (const fn of due) fn();
};
function render() {
  cursor = 0;
  pendingEffects = [];
  return sections[0].component({ close: () => {}, ...options.inject() });
}
/** A mount: fresh render + its effects (the shell mounts the section when it is selected). */
function mount() {
  const tree = render();
  const queued = pendingEffects.slice();
  pendingEffects = [];
  for (const fn of queued) {
    const off = fn();
    if (typeof off === "function") cleanups.push(off);
  }
  return tree;
}
function flatten(node, out = [], depth = 0) {
  if (node === null || node === undefined || depth > 80) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out, depth + 1);
    return out;
  }
  if (typeof node !== "object") return out;
  out.push(node);
  flatten(node.props?.children, out, depth + 1);
  return out;
}
const nodesOf = (tree, type) => flatten(tree).filter((node) => node.type === type);
const controls = (tree) => flatten(tree).filter((node) => node.type === "input" || node.type === "button");
const statusOf = (tree) => flatten(tree).find((node) => node.props?.role === "status");
const switchOf = (tree) => flatten(tree).find((node) => node.props?.role === "switch");
const stateGets = () => requests.filter((r) => r.kind === "http" && r.url.endsWith("/state") && r.method === "GET");
const writes = () => requests.filter((r) => r.kind === "http" && r.method === "PUT");

// ── render smoke test (dead transport) ───────────────────────────────────────
// The very first paint happens before the read settles, so it must already be a usable page;
// the transport below is deliberately dead to prove the page cannot white-screen on a bad host.
const liveFetch = sandbox.fetch;
sandbox.fetch = () => Promise.reject(new Error("offline"));
let mountTree;
let renderError;
try {
  mountTree = mount();
  render();
} catch (error) {
  renderError = error;
}
sandbox.fetch = liveFetch;
check("renders from empty state without throwing", renderError === undefined, renderError?.message ?? "");

const mountTags = new Set(flatten(mountTree).map((node) => (typeof node.type === "string" ? node.type : "component")));
check("the tree is non-trivial (no blank page)", flatten(mountTree).length >= 6, `nodes=${flatten(mountTree).length}`);
check(
  "renders the intro, the switch and the status line",
  ["p", "label", "input", "span"].every((tag) => mountTags.has(tag)),
  [...mountTags].join(","),
);
check("renders the intro sentence", flatten(mountTree).some((node) => node.props?.children === zh.intro));
check("the page has exactly one interactive control", controls(mountTree).length === 1, String(controls(mountTree).length));
check("the control is the switch and there are no buttons", switchOf(mountTree) !== undefined && nodesOf(mountTree, "button").length === 0);
check("the switch starts disabled while nothing is known", switchOf(mountTree)?.props.disabled === true);
check(
  "the status line starts on the reading line",
  statusOf(mountTree)?.props.children === zh["state.loading"],
  String(statusOf(mountTree)?.props.children),
);

// ── drive the page through the fake transport ────────────────────────────────
async function drive() {
  await tick();

  // Phase 1 — a switched-off host, freshly mounted: one read, no polling.
  let tree = mount();
  await tick();
  tree = render();
  check("mount reads the state exactly once", stateGets().length === 1, `gets=${stateGets().length}`);
  check("nothing polls in the background", stateGets().length === 1, `gets=${stateGets().length}`);
  check("a switched-off host shows the off line", statusOf(tree)?.props.children === zh["auto.off"], String(statusOf(tree)?.props.children));
  check("the switch follows the host value", switchOf(tree)?.props.checked === false && switchOf(tree)?.props.disabled === false);
  check("the switch carries its accessible state", switchOf(tree)?.props["aria-checked"] === "false", String(switchOf(tree)?.props["aria-checked"]));

  // Phase 2 — a host that is on and has just fixed the model in use.
  server.real = true;
  server.visible = true;
  server.auto = {
    key: "auto.fixed",
    params: { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash" },
    backup: "cordis.patch.yml.bak-compaction-doctor-1",
  };
  tree = mount();
  await tick();
  tree = render();
  const fixedLine = String(statusOf(tree)?.props.children);
  check("the status line names the model the host fixed", fixedLine.includes("DeepSeek-V4.1-Flash"), fixedLine);
  check("the status line says it was backed up", fixedLine.includes("已备份"), fixedLine);
  check("the switch is on", switchOf(tree)?.props.checked === true && switchOf(tree)?.props["aria-checked"] === "true");

  // Phase 3 — the model is unknown: the sentence that would name it must disappear entirely.
  server.auto = { key: "auto.ok", params: {} };
  tree = mount();
  await tick();
  tree = render();
  const bareModel = String(statusOf(tree)?.props.children);
  check("an unknown model drops the whole sentence", bareModel === "已开启。", bareModel);
  check(
    "no empty bracket or raw key reaches the screen",
    ["{", "}", "（）", "()", "auto.", "undefined"].every((token) => bareModel.includes(token) === false),
    bareModel,
  );

  // Phase 4 — flipping the switch off: exactly one write, exact body, re-read after the wait.
  server.auto = { key: "auto.pending", params: {} };
  tree = mount();
  await tick();
  tree = render();
  const writesBefore = writes().length;
  const getsBefore = stateGets().length;
  switchOf(tree)?.props.onChange?.({});
  await tick();
  const offWrite = writes().at(-1);
  check("flipping the switch writes exactly once", writes().length === writesBefore + 1, `delta=${writes().length - writesBefore}`);
  check("the write body is exactly the enabled flag", String(offWrite?.body) === '{"enabled":false}', String(offWrite?.body));
  check("the switch is disabled while the write is in flight", switchOf(render())?.props.disabled === true);
  check("the page waits before re-reading", stateGets().length === getsBefore, `delta=${stateGets().length - getsBefore}`);
  fireTimers();
  await tick();
  check("the page re-reads after the wait", stateGets().length === getsBefore + 1, `delta=${stateGets().length - getsBefore}`);
  tree = render();
  check("the switch shows the written value once the host agrees", switchOf(tree)?.props.checked === false && switchOf(tree)?.props.disabled === false);
  check("the status line follows the host verdict", String(statusOf(tree)?.props.children) === zh["auto.off"], String(statusOf(tree)?.props.children));

  // Phase 5 — the host still serves the pre-write value (hot reload in progress): retry.
  server.real = false;
  server.visible = false;
  server.stale = 0;
  server.auto = { key: "auto.off", params: {} };
  tree = mount();
  await tick();
  tree = render();
  server.stale = 2; // from here the host keeps answering with the value from before the write
  const writesBeforeStale = writes().length;
  switchOf(tree)?.props.onChange?.({});
  await tick();
  let reads = 0;
  for (let round = 0; round < 4; round += 1) {
    const before = stateGets().length;
    fireTimers();
    await tick();
    reads += stateGets().length - before;
  }
  check("a stale read is retried until the hot reload lands", reads === 3, `reads=${reads}`);
  tree = render();
  check("the switch ends on the host's real value", switchOf(tree)?.props.checked === true, String(switchOf(tree)?.props.checked));
  check("the page writes once per flip, never per retry", writes().length === writesBeforeStale + 1, `delta=${writes().length - writesBeforeStale}`);
  check("the switch is usable again after the retries", switchOf(tree)?.props.disabled === false);

  // Phase 6 — a rejected write must not break the page: the switch falls back to the real value.
  server.rejectWrite = true;
  server.real = true;
  server.visible = true;
  server.stale = 0;
  server.auto = { key: "auto.pending", params: {} };
  tree = mount();
  await tick();
  tree = render();
  const writesBeforeReject = writes().length;
  switchOf(tree)?.props.onChange?.({});
  await tick();
  const rejected = writes().at(-1);
  check("the failed write was attempted", String(rejected?.body) === '{"enabled":false}', String(rejected?.body));
  for (let round = 0; round < 4; round += 1) {
    fireTimers();
    await tick();
  }
  tree = render();
  check("a rejected write leaves the page alive", statusOf(tree) !== undefined);
  check("the switch falls back to the host's real value", switchOf(tree)?.props.checked === true, String(switchOf(tree)?.props.checked));
  check("the switch is usable again after the failure", switchOf(tree)?.props.disabled === false);
  check("the page does not write again after a failure", writes().length === writesBeforeReject + 1, `delta=${writes().length - writesBeforeReject}`);
  const afterFailure = String(statusOf(tree)?.props.children);
  check(
    "no raw error text leaks into the page",
    afterFailure !== "" && ["error", "Error", "rejected", "fail"].every((token) => afterFailure.includes(token) === false),
    afterFailure,
  );

  // Phase 7 — a dead host: the switch is disabled and the status line says so.
  const workingFetch = sandbox.fetch;
  sandbox.fetch = async () => {
    throw new Error("offline");
  };
  server.rejectWrite = false;
  tree = mount();
  await tick();
  tree = render();
  check("an unreachable host disables the switch", switchOf(tree)?.props.disabled === true, String(switchOf(tree)?.props.disabled));
  check(
    "an unreachable host keeps a readable status line",
    String(statusOf(tree)?.props.children) === zh["state.unavailable"],
    String(statusOf(tree)?.props.children),
  );
  sandbox.fetch = workingFetch;

  // Transport shape over the whole run.
  const http = requests.filter((r) => r.kind === "http");
  check("every request carries the guard header", http.every((r) => r.headers["x-compaction-doctor"] === "1"), `${http.length} requests`);
  check(
    "every write is JSON and every read is body-less",
    writes().every((r) => r.headers["content-type"] === "application/json")
      && http.filter((r) => r.method === "GET").every((r) => r.body === undefined),
    `${writes().length} writes`,
  );
  const paths = [...new Set(http.map((r) => `${r.method} ${r.url.replace(ROUTE, "")}`))].sort();
  check("only the two frozen paths were used", paths.join(" | ") === "GET /state | PUT /config", paths.join(" | "));

  for (const off of cleanups) {
    try {
      off();
    } catch {
      /* unmount noise */
    }
  }
}
await drive();

// ── report ──────────────────────────────────────────────────────────────────
for (const result of results) {
  console.log(`${result.pass ? "ok  " : "FAIL"} ${result.name}${result.detail === "" ? "" : `   [${result.detail}]`}`);
}
const failed = results.filter((result) => result.pass === false);
console.log(`\n${results.length - failed.length}/${results.length} client checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
