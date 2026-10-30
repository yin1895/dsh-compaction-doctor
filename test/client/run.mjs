/**
 * Offline verification of the browser half (`lib/client.js`).
 *
 * No browser and no DSH process are needed. The script loads the bundle exactly
 * the way the web shell does — a classic script calling
 * `window.__ModuleLoader__.load({ id, factory })` — and then checks the hard
 * contracts from `docs/spec-client.md` plus a render smoke test:
 *
 *   static : syntax, no top-level ESM, one registration, package-name id,
 *            platform-seed-only `require`, `settings.section` options, contract
 *            endpoints, style-cleanup ownership, locale key parity;
 *   render : `apply(ctx)` registers one section, and the component renders a
 *            non-trivial tree from empty state with a degraded context
 *            (no `configForms`, failing `fetch`) instead of throwing.
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

const FROZEN = ["/state", "/diagnose", "/apply", "/config", "/backups", "/restore"];
const route = /var\s+ROUTE\s*=\s*['"](\/dsh-compaction-doctor)['"]/u.exec(src);
check("route prefix matches the contract", route?.[1] === "/dsh-compaction-doctor", String(route?.[1]));
const missingEndpoints = FROZEN.filter((suffix) => new RegExp(`['"\`]${suffix.replace("/", "\\/")}['"\`]`, "u").test(src) === false);
check("all six frozen endpoints are referenced", missingEndpoints.length === 0, missingEndpoints.join(","));
const quotedPaths = [...new Set([...src.matchAll(/['"`](\/[a-z-]+\/[a-z-]*)['"`]/gu)].map((m) => m[1]))];
const strayPaths = quotedPaths.filter((value) => value !== "/dsh-compaction-doctor" && !FROZEN.includes(value.slice("/dsh-compaction-doctor".length)));
check("no request path outside the contract", strayPaths.length === 0, strayPaths.join(","));
check("sends the route guard header", /x-compaction-doctor/iu.test(src));

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

// ── module registration + apply ──────────────────────────────────────────────
const styleTags = [];
const registrations = [];
const sandbox = {
  console,
  window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "", setAttribute() {} }),
    head: { appendChild: (tag) => styleTags.push(tag) },
    body: {},
  },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: () => Promise.reject(new Error("offline")),
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "client.js" });

check("registers exactly one module", registrations.length === 1, `count=${registrations.length}`);
check("module id equals the package name", registrations[0]?.id === pkg.name, String(registrations[0]?.id));

const React = {
  Fragment: "Fragment",
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useReducer: (_reducer, initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value }),
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
  get: () => undefined, // no configForms / remote: the degraded deployment
  locale: {
    register: () => () => {},
    bind: () => (key) => `t:${key}`,
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

// ── render smoke test ────────────────────────────────────────────────────────
const injected = options.inject?.() ?? {};
let tree;
let renderError;
try {
  tree = sections[0].component({ close: () => {}, ...injected });
} catch (error) {
  renderError = error;
}
check("renders from empty state without throwing", renderError === undefined, renderError?.message ?? "");

function walk(node, visit, depth = 0) {
  if (node === null || node === undefined || depth > 80) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  visit(node);
  walk(node.props?.children, visit, depth + 1);
}
let nodes = 0;
const tags = new Set();
walk(tree, (node) => {
  nodes += 1;
  tags.add(typeof node.type === "string" ? node.type : "component");
});
check("the tree is non-trivial (no white page)", nodes > 20, `nodes=${nodes}`);
check("renders buttons", tags.has("button"), [...tags].join(","));
check("renders inputs", tags.has("input"), [...tags].join(","));

// ── report ──────────────────────────────────────────────────────────────────
for (const result of results) {
  console.log(`${result.pass ? "ok  " : "FAIL"} ${result.name}${result.detail === "" ? "" : `   [${result.detail}]`}`);
}
const failed = results.filter((result) => result.pass === false);
console.log(`\n${results.length - failed.length}/${results.length} client checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;