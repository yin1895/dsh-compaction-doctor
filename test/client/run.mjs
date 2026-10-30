/**
 * Offline verification of the browser half (`lib/client.js`) — the one-switch page.
 *
 * No browser and no DSH process are needed. The script loads the bundle exactly the way the
 * web shell does — a classic script calling `window.__ModuleLoader__.load({ id, factory })` —
 * then checks the frozen contracts plus a render + switch-driving smoke test.
 *
 * Because the switch is the whole page, the drive section doubles as the regression suite for
 * the three shipped robustness rules:
 *   - the switch is only ever disabled while a write is in flight, or while the host half is
 *     still an older build (then clicking really is pointless);
 *   - a write can never hang: it races a hard timeout, and every outcome ends with one
 *     read-back that clears the busy state;
 *   - read-backs are bounded (at most two retries, 300 ms apart, 3 s in total).
 *
 * Note on the harness: DSH mounts the section when the user selects it and unmounts it when
 * they leave, so `mount()` below is exactly that — a fresh component render plus its effects.
 * Between mounts the harness only re-renders, which is how React behaves with empty deps.
 * Timers and `Date.now` are faked so the waits, the hard timeout and the retry budget are
 * driven deterministically instead of by wall-clock time.
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

// Robustness constants must be the frozen ones, and the retry budget must be time-bounded.
check("write timeout is the frozen hard limit", /WRITE_TIMEOUT_MS\s*=\s*8000\b/u.test(src));
check("read-back budget is time-bounded, not count-only", /SETTLE_TOTAL_MS\s*=\s*3000\b/u.test(src) && /Date\.now\(\)/u.test(src));
check("the wait before a read-back is 300ms", /SETTLE_MS\s*=\s*300\b/u.test(src));

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
check("the status line keys exist", ["state.loading", "state.unavailable", "state.stale"].every((key) => zhKeys.includes(key)));
check("the older-host line is the mandated wording", zh["state.stale"] === "插件刚更新过，重启 DSH 之后这个开关才能用。", zh["state.stale"]);

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
/** Fake timers with real ids, so `clearTimeout` (not just `setTimeout`) is exercised. */
const timerMap = new Map();
let timerSeq = 0;
const clock = { now: Date.now() };

const sandbox = {
  console,
  window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "", setAttribute() {} }),
    head: { appendChild: (tag) => styleTags.push(tag) },
    body: {},
  },
  setTimeout: (fn, ms) => {
    timerSeq += 1;
    timerMap.set(timerSeq, { fn, ms });
    return timerSeq;
  },
  clearTimeout: (id) => {
    timerMap.delete(id);
  },
  fetch: () => Promise.reject(new Error("offline")),
  navigator: {},
  __clock: clock,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext("Date.now = function () { return __clock.now; };", sandbox);
vm.runInContext(src, sandbox, { filename: "client.js" });

const timerCount = () => timerMap.size;
const timerDelays = () => [...timerMap.values()].map((entry) => entry.ms);
const advance = (ms) => {
  clock.now += ms;
};

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
  // `real` is the host's truth; `visible` is what a read returns (the host hot-reloads, so a
  // read can lag behind); `stale` counts how many reads still answer with the old value.
  real: false,
  visible: false,
  stale: 0,
  // 'ok' | 'http403' | 'okFalse' | 'hang' | 'network'
  writeMode: "ok",
  // an older host half: /state answers ok, but carries no `enabled` / `auto` fields at all
  legacy: false,
};
const send = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
sandbox.fetch = async (url, init) => {
  requests.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body, kind: "http" });
  const suffix = url.slice(ROUTE.length);
  if (suffix === "/state") {
    if (server.stale > 0) server.stale -= 1;
    else server.visible = server.real;
    if (server.legacy === true) return send(200, { ok: true, version: "0.3.0", unavailable: false });
    return send(200, {
      ok: true,
      enabled: server.visible,
      route: { provider: "huaiyuan", model: "DeepSeek-V4.1-Flash" },
      auto: server.visible === server.real && server.stale === 0 ? server.auto : { key: "auto.off", params: {} },
      version: "0.4.1",
      unavailable: false,
    });
  }
  if (suffix === "/config") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (server.writeMode === "hang") return new Promise(() => {});
    if (server.writeMode === "network") throw new Error("offline");
    if (server.writeMode === "http403") return send(403, { ok: false, error: "forbidden" });
    if (server.writeMode === "okFalse") return send(200, { ok: false, error: "write refused" });
    server.real = body.enabled === true;
    server.auto = server.real ? { key: "auto.pending", params: {} } : { key: "auto.off", params: {} };
    return send(200, { ok: true, config: { enabled: server.real }, hotReload: true });
  }
  return send(404, { ok: false, error: "not found" });
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Fire every armed timer once (the page's waits and its hard timeouts are all fake). */
const fireTimers = () => {
  const due = [...timerMap.entries()];
  timerMap.clear();
  for (const [, entry] of due) entry.fn();
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
const statusLine = (tree) => String(statusOf(tree)?.props.children ?? "");
const stateGets = () => requests.filter((r) => r.kind === "http" && r.url.endsWith("/state") && r.method === "GET");
const writes = () => requests.filter((r) => r.kind === "http" && r.method === "PUT");
/** Bring a phase to rest: run every wait/timeout, let its promises settle, repeat. */
async function settleAll(rounds = 6) {
  for (let round = 0; round < rounds; round += 1) {
    fireTimers();
    await tick();
  }
}

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
check("the switch is clickable from the very first paint", switchOf(mountTree)?.props.disabled === false);
check("the status line starts on the reading line", statusLine(mountTree) === zh["state.loading"], statusLine(mountTree));

// ── drive the page through the fake transport ────────────────────────────────
async function drive() {
  await tick();

  // Phase 1 — a switched-off host, freshly mounted: one read, no polling.
  let tree = mount();
  await tick();
  tree = render();
  check("mount reads the state exactly once", stateGets().length === 1, `gets=${stateGets().length}`);
  check("nothing polls in the background", stateGets().length === 1, `gets=${stateGets().length}`);
  check("a switched-off host shows the off line", statusLine(tree) === zh["auto.off"], statusLine(tree));
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
  check("the status line names the model the host fixed", statusLine(tree).includes("DeepSeek-V4.1-Flash"), statusLine(tree));
  check("the status line says it was backed up", statusLine(tree).includes("已备份"), statusLine(tree));
  check("the switch is on and clickable", switchOf(tree)?.props.checked === true && switchOf(tree)?.props.disabled === false);

  // Phase 3 — the model is unknown: the sentence that would name it must disappear entirely.
  server.auto = { key: "auto.ok", params: {} };
  tree = mount();
  await tick();
  tree = render();
  check("an unknown model drops the whole sentence", statusLine(tree) === "已开启。", statusLine(tree));
  check(
    "no empty bracket or raw key reaches the screen",
    ["{", "}", "（）", "()", "auto.", "undefined"].every((token) => statusLine(tree).includes(token) === false),
    statusLine(tree),
  );

  // Phase 4 — a clean flip: one write, and the read-back converges on the first try.
  server.auto = { key: "auto.pending", params: {} };
  tree = mount();
  await tick();
  tree = render();
  const writesBeforeFlip = writes().length;
  const getsBeforeFlip = stateGets().length;
  switchOf(tree)?.props.onChange?.({});
  await tick();
  check("flipping the switch writes exactly once", writes().length === writesBeforeFlip + 1, `delta=${writes().length - writesBeforeFlip}`);
  check("the write body is exactly the enabled flag", String(writes().at(-1)?.body) === '{"enabled":false}', String(writes().at(-1)?.body));
  check("the switch is disabled while the write is in flight", switchOf(render())?.props.disabled === true);
  check("the wait before the read-back is 300ms", timerDelays().join(",") === "300", timerDelays().join(","));
  check("the page waits before re-reading", stateGets().length === getsBeforeFlip, `delta=${stateGets().length - getsBeforeFlip}`);
  fireTimers();
  await tick();
  check("a converging read-back is not retried", stateGets().length === getsBeforeFlip + 1, `reads=${stateGets().length - getsBeforeFlip}`);
  tree = render();
  check("the switch shows the written value once the host agrees", switchOf(tree)?.props.checked === false && switchOf(tree)?.props.disabled === false);
  check("the status line follows the host verdict", statusLine(tree) === zh["auto.off"], statusLine(tree));
  check("no timer is left behind after a clean write", timerCount() === 0, `timers=${timerCount()}`);

  // Phase 5 — the host still serves the pre-write value (hot reload in progress): retry, bounded.
  server.real = false;
  server.visible = false;
  server.stale = 0;
  server.auto = { key: "auto.off", params: {} };
  tree = mount();
  await tick();
  tree = render();
  server.stale = 2; // from here the host keeps answering with the value from before the write
  const writesBeforeStale = writes().length;
  const getsBeforeStale = stateGets().length;
  switchOf(tree)?.props.onChange?.({});
  await tick();
  let reads = 0;
  for (let round = 0; round < 5; round += 1) {
    fireTimers();
    await tick();
    reads = stateGets().length - getsBeforeStale;
  }
  check("a stale read is retried until the hot reload lands", reads === 3, `reads=${reads}`);
  tree = render();
  check("the switch ends on the host's real value", switchOf(tree)?.props.checked === true, String(switchOf(tree)?.props.checked));
  check("the page writes once per flip, never per retry", writes().length === writesBeforeStale + 1, `delta=${writes().length - writesBeforeStale}`);
  check("the switch is usable again after the retries", switchOf(tree)?.props.disabled === false);
  check("no timer is left behind after the retries", timerCount() === 0, `timers=${timerCount()}`);

  // Phase 6 — the 3s read-back budget: a host that never agrees must not be retried forever.
  server.real = false;
  server.visible = false;
  server.stale = 1;
  const getsBeforeBud = stateGets().length;
  const writesBeforeBud = writes().length;
  tree = render();
  switchOf(tree)?.props.onChange?.({}); // off -> on
  await tick();
  server.stale = 20; // the host will never agree now
  advance(4000); // blow the whole 3s budget before the first read-back even runs
  await settleAll(4);
  const budReads = stateGets().length - getsBeforeBud;
  check("the read-back budget caps a host that never agrees", budReads === 1, `reads=${budReads}`);
  check("the switch is released once the budget is blown", switchOf(render())?.props.disabled === false);
  check("the page still wrote exactly once for that flip", writes().length === writesBeforeBud + 1, `delta=${writes().length - writesBeforeBud}`);
  server.stale = 0;

  // Phase 7 — a rejected write (403) reads the host back once and stays usable.
  server.writeMode = "http403";
  server.real = true;
  server.visible = true;
  server.auto = { key: "auto.pending", params: {} };
  tree = mount();
  await tick();
  tree = render();
  const writesBeforeReject = writes().length;
  const getsBeforeReject = stateGets().length;
  switchOf(tree)?.props.onChange?.({});
  await tick();
  check("the failed write was attempted", String(writes().at(-1)?.body) === '{"enabled":false}', String(writes().at(-1)?.body));
  await settleAll(4);
  check("a rejected write reads the host back exactly once", stateGets().length - getsBeforeReject === 1, `reads=${stateGets().length - getsBeforeReject}`);
  tree = render();
  check("a rejected write leaves the page alive", statusOf(tree) !== undefined);
  check("the busy state is released after a 403", switchOf(tree)?.props.disabled === false);
  check("the switch falls back to the host's real value", switchOf(tree)?.props.checked === true, String(switchOf(tree)?.props.checked));
  check("no raw error text leaks into the page", statusLine(tree) === zh["auto.pending"], statusLine(tree));
  const writesBeforeRetry = writes().length;
  switchOf(tree)?.props.onChange?.({});
  await tick();
  check("the switch works again after a failure", writes().length === writesBeforeRetry + 1, `delta=${writes().length - writesBeforeRetry}`);
  await settleAll(4);

  // Phase 8 — a write that answers 200 but ok:false behaves the same way.
  server.writeMode = "okFalse";
  server.auto = { key: "auto.pending", params: {} };
  tree = mount();
  await tick();
  tree = render();
  const getsBeforeOkFalse = stateGets().length;
  switchOf(tree)?.props.onChange?.({});
  await tick();
  await settleAll(4);
  check("an ok:false write reads the host back exactly once", stateGets().length - getsBeforeOkFalse === 1, `reads=${stateGets().length - getsBeforeOkFalse}`);
  check("the busy state is released after ok:false", switchOf(render())?.props.disabled === false);

  // Phase 9 — a network error on the write behaves the same way.
  server.writeMode = "network";
  tree = mount();
  await tick();
  tree = render();
  const getsBeforeNet = stateGets().length;
  switchOf(tree)?.props.onChange?.({});
  await tick();
  await settleAll(4);
  check("a network error on the write reads the host back exactly once", stateGets().length - getsBeforeNet === 1, `reads=${stateGets().length - getsBeforeNet}`);
  check("the busy state is released after a network error", switchOf(render())?.props.disabled === false);

  // Phase 10 — a write that never resolves: the hard timeout must release the switch.
  server.writeMode = "hang";
  server.real = true;
  server.visible = true;
  server.auto = { key: "auto.pending", params: {} };
  tree = mount();
  await tick();
  tree = render();
  const writesBeforeHang = writes().length;
  const getsBeforeHang = stateGets().length;
  switchOf(tree)?.props.onChange?.({});
  await tick();
  check("the hung write armed the 8s hard timeout", timerDelays().join(",") === "8000", timerDelays().join(","));
  check("the switch is disabled only while that write is in flight", switchOf(render())?.props.disabled === true);
  fireTimers(); // the 8s hard timeout fires
  await tick();
  check("the timeout does not multiply read-backs", stateGets().length - getsBeforeHang <= 1, `reads=${stateGets().length - getsBeforeHang}`);
  await settleAll(4);
  check("a timed-out write reads the host back exactly once", stateGets().length - getsBeforeHang === 1, `reads=${stateGets().length - getsBeforeHang}`);
  tree = render();
  check("a timed-out write releases the switch", switchOf(tree)?.props.disabled === false);
  check("the switch shows the host's real value after a timeout", switchOf(tree)?.props.checked === true, String(switchOf(tree)?.props.checked));
  check("no timer is left behind after a timeout", timerCount() === 0, `timers=${timerCount()}`);
  check("only one write was issued for the flip that timed out", writes().length === writesBeforeHang + 1, `delta=${writes().length - writesBeforeHang}`);

  // Phase 11 — an older host half: ok, but with no switch value at all.
  server.writeMode = "ok";
  server.legacy = true;
  tree = mount();
  await tick();
  tree = render();
  check("an older host half is recognised", statusLine(tree) === zh["state.stale"], statusLine(tree));
  check("the switch is disabled while the host half is old", switchOf(tree)?.props.disabled === true);
  check("the older-host state is not mistaken for an off switch", switchOf(tree)?.props.checked === false);
  server.legacy = false;
  server.auto = { key: "auto.pending", params: {} };
  tree = mount();
  await tick();
  tree = render();
  check("a current host half leaves the switch clickable", switchOf(tree)?.props.disabled === false);
  check("a current host half shows a normal status line", statusLine(tree) === zh["auto.pending"], statusLine(tree));

  // Phase 12 — an unreachable host: readable status, and never a permanently dead switch.
  const workingFetch = sandbox.fetch;
  sandbox.fetch = async () => {
    throw new Error("offline");
  };
  server.writeMode = "ok";
  tree = mount();
  await tick();
  tree = render();
  check("an unreachable host says so", statusLine(tree) === zh["state.unavailable"], statusLine(tree));
  check("an unreachable host does NOT kill the switch", switchOf(tree)?.props.disabled === false);
  const writesAfterOutage = writes().length;
  sandbox.fetch = workingFetch; // the host comes back
  switchOf(tree)?.props.onChange?.({});
  await tick();
  check("the switch still writes after an outage", writes().length === writesAfterOutage + 1, `delta=${writes().length - writesAfterOutage}`);
  await settleAll(4);
  tree = render();
  check(
    "the page recovers once the host answers again",
    switchOf(tree)?.props.disabled === false && statusLine(tree) !== zh["state.unavailable"],
    statusLine(tree),
  );

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
  check(
    "every write body is exactly the enabled flag",
    writes().every((r) => /^\{"enabled":(true|false)\}$/u.test(String(r.body))),
    `${writes().length} writes`,
  );

  // Unmount must clear every timer the page armed.
  for (const off of cleanups) {
    try {
      off();
    } catch {
      /* unmount noise */
    }
  }
  check("unmount clears every armed timer", timerCount() === 0, `timers=${timerCount()}`);
}
await drive();

// ── report ──────────────────────────────────────────────────────────────────
for (const result of results) {
  console.log(`${result.pass ? "ok  " : "FAIL"} ${result.name}${result.detail === "" ? "" : `   [${result.detail}]`}`);
}
const failed = results.filter((result) => result.pass === false);
console.log(`\n${results.length - failed.length}/${results.length} client checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
