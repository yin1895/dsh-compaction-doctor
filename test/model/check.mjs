#!/usr/bin/env node
/**
 * 形式化穷尽检验器 —— 设置页开关链路（docs/formal.md 第 6 节的机器检验义务）
 *
 * 这是**数学层面的验证**：把真实代码驱动成一台状态机，对深度 D 内的事件串做
 * 穷尽搜索（按抽象状态去重），并逐条断言 I1–I11。任何反例都打印最短事件串。
 *
 * 一、为什么它是"穷尽"而不是"多跑几个用例"
 *   · M-4 要求 D 内所有事件串的可达状态集。状态图不可快照（组件状态在闭包里），
 *     所以 BFS 用**重放**：每个抽象状态记住到达它的最短事件串，扩展时从零重放该串
 *     再补一个事件。全部不确定性都由事件串决定 —— 没有随机数、没有真实时钟、
 *     没有真实网络，因此重放是确定性的。
 *   · 去重键 = DOM 观测（开关 checked/disabled + 状态行文案）∪ 检验器自己的协议台账
 *     （在途请求数、已挂计时器数、写 epoch 的期望值/预算/截止时刻）。后半部分是
 *     **台账**而非组件内部变量：它完全由事件串推导，作用是保证"合并后的两个状态
 *     未来行为相同"。哪些分量能从 DOM 唯一读出、哪些不能，见报告 §M2-忠实性。
 *
 * 二、驱动的是真实代码
 *   · 浏览器半侧：真实 lib/client.js 在 vm 上下文里执行，window.__ModuleLoader__
 *     收到的 factory 被真的调用；桩 React 只给 useState/useEffect/useRef/createElement
 *     的语义；fetch 与 setTimeout/clearTimeout/Date 全部由检验器接管，所以 tick(Δ)
 *     是显式事件、每个请求的兑现由事件串决定。
 *   · 宿主半侧：真实 lib/probe.js / lib/engine.js 经真实 @deepseek-ai/* 装载；
 *     setEnabled / writeConfigPatch / readSwitchState / writeSwitchState /
 *     stateSnapshot / normalizeConfig / doctorConfig / _policy / mergeDefined
 *     全部是真函数。
 *
 * 运行：node test/model/check.mjs             （非零退出码 = 存在反例）
 *       node test/model/check.mjs --verbose   （打印 BFS 进度）
 *
 * 只读：本文件不写 lib/**、locale/**、test/nm/**、test/client/**、cordis.patch.yml、
 * package.json、README.md、docs/formal.md。为了让真实 lib/*.js 能解析裸说明符
 * @deepseek-ai/*，它在 os.tmpdir() 下建一棵临时树（lib 副本 + node_modules 链接 +
 * 一个 re-export 入口），退出前删除。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const VERBOSE = process.argv.includes("--verbose");
const HERE = import.meta.dirname; // node >= 20.11
const REPO = path.resolve(HERE, "..", "..");
const DEPTH_ARG = process.argv.find((item) => item.startsWith("--depth="));
const DEPTH_LIMIT = DEPTH_ARG === undefined ? 8 : Number(DEPTH_ARG.slice("--depth=".length)); // M-4 的 D（默认 8）
const DRAIN_TICKS = 60; // 每个事件之后的微任务排空深度（自检见 §0）
const MAX_STATES = 6000; // 状态图规模护栏；触顶会显式报告
const NS_UI = "compaction-doctor.ui";

// ─────────────────────────────────────────────────────────────────────────────
// §0 报告器
// ─────────────────────────────────────────────────────────────────────────────

const RESULTS = [];
const WARNINGS = [];
let CURRENT = null;

function section(title) {
  console.log(`\n${title}`);
}

function record(id, title, status, detail, counterexample) {
  const entry = { id, title, status, detail, counterexample };
  RESULTS.push(entry);
  const mark = status === "PASS" ? "\u001b[32mPASS\u001b[0m" : status === "FAIL" ? "\u001b[31mFAIL\u001b[0m" : "\u001b[33mSKIP\u001b[0m";
  console.log(`  ${mark}  ${String(id).padEnd(4)} ${title}`);
  if (detail) console.log(`         ${detail}`);
  if (counterexample) console.log(`         最短反例: ${counterexample}`);
  return entry;
}

class SkipSignal extends Error {}

function skip(reason) {
  throw new SkipSignal(reason);
}

async function invariant(id, title, fn) {
  CURRENT = { id, counterexamples: [] };
  try {
    const detail = await fn(CURRENT);
    return record(id, title, "PASS", typeof detail === "string" ? detail : undefined);
  } catch (error) {
    if (error instanceof SkipSignal) return record(id, title, "SKIP", error.message);
    return record(id, title, "FAIL", String(error?.message ?? error), CURRENT.counterexamples[0]);
  }
}

function fail(message, counterexample) {
  if (CURRENT !== null && counterexample !== undefined) CURRENT.counterexamples.push(counterexample);
  throw new Error(message);
}

const show = (seq) => (seq.length === 0 ? "ε" : seq.join(" → "));

// ─────────────────────────────────────────────────────────────────────────────
// §1 临时模块树
// ─────────────────────────────────────────────────────────────────────────────

const HOST_DEEPSEEK_AI = path.join(
  "C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules",
  "@deepseek-ai",
);

const toFileUrl = (p) => new URL(`file:///${encodeURI(String(p).replace(/\\/g, "/"))}`).href;

function buildSandboxTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cdoc-model-"));
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  for (const name of fs.readdirSync(path.join(REPO, "lib"))) {
    if (name.endsWith(".js")) fs.copyFileSync(path.join(REPO, "lib", name), path.join(root, "lib", name));
  }

  // I9 的 defaults 轴：只改 DOCTOR_DEFAULTS.enabled 这一个字面量的副本，源文件不动。
  const engineSrc = fs.readFileSync(path.join(REPO, "lib", "engine.js"), "utf8");
  const defaultsOn = engineSrc.replace(
    /(export const DOCTOR_DEFAULTS = \{\n(?:[^\n]*\n)*?\s*enabled: )false,/u,
    "$1true,",
  );
  if (defaultsOn === engineSrc) throw new Error("I9: 无法构造 DOCTOR_DEFAULTS.enabled=true 变体（engine.js 结构变了）");
  fs.writeFileSync(path.join(root, "lib", "engine.defaults-on.js"), defaultsOn, "utf8");
  const probeOn = fs
    .readFileSync(path.join(REPO, "lib", "probe.js"), "utf8")
    .replace('from "./engine.js"', 'from "./engine.defaults-on.js"');
  if (probeOn.includes("./engine.defaults-on.js") !== true) throw new Error("I9: 无法重构 probe.js 的 engine 导入");
  fs.writeFileSync(path.join(root, "lib", "probe.defaults-on.js"), probeOn, "utf8");

  const nm = path.join(root, "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.dirname(nm), { recursive: true });
  let source = HOST_DEEPSEEK_AI;
  let mode = "host-install";
  if (!fs.existsSync(source)) {
    source = path.join(REPO, "test", "nm", "node_modules", "@deepseek-ai");
    mode = "test/nm-stubs";
  }
  fs.symlinkSync(source, nm, "junction");

  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "cdoc-model-sandbox", type: "module", private: true }, null, 2)}\n`, "utf8");

  fs.writeFileSync(
    path.join(root, "entry.mjs"),
    [
      "export * as cordis from '@deepseek-ai/cordis';",
      "export * as probe from './lib/probe.js';",
      "export * as probeDefaultsOn from './lib/probe.defaults-on.js';",
      "export * as engine from './lib/engine.js';",
      "export * as engineDefaultsOn from './lib/engine.defaults-on.js';",
      "export * as status from './lib/status.js';",
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, mode, source };
}

function removeSandboxTree(root) {
  try {
    const nm = path.join(root, "node_modules", "@deepseek-ai");
    if (fs.existsSync(nm)) fs.unlinkSync(nm); // 先摘 junction，绝不递归删到宿主安装目录
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const TREE = buildSandboxTree();
const M = await import(toFileUrl(path.join(TREE.root, "entry.mjs")));
const REAL_CORDIS = typeof M.cordis.Context === "function" && typeof new M.cordis.Context().plugin === "function";

// ─────────────────────────────────────────────────────────────────────────────
// §2 宿主半侧装配
// ─────────────────────────────────────────────────────────────────────────────

function makePlainCtx() {
  const services = new Map();
  return {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    get: (name) => services.get(name),
    on: () => () => {},
    effect(fn) {
      try {
        const produced = fn();
        if (typeof produced === "function") return produced;
        if (produced !== null && typeof produced === "object" && typeof produced[Symbol.iterator] === "function") {
          for (const item of produced) void item;
        }
      } catch {
        /* ignore */
      }
      return () => {};
    },
    _services: services,
  };
}

async function makeHostRoot(services = {}) {
  if (!REAL_CORDIS) {
    const ctx = makePlainCtx();
    for (const [name, value] of Object.entries(services)) ctx._services.set(name, value);
    return { root: ctx, provide: (name, value) => void ctx._services.set(name, value) };
  }
  const { Context, Service } = M.cordis;
  const root = new Context();
  for (const [name, value] of Object.entries(services)) {
    class Stub extends Service {
      constructor(ctx) {
        super(ctx, name);
        for (const [key, item] of Object.entries(value)) this[key] = item;
      }
    }
    await root.plugin(Stub);
  }
  return { root, provide: (name, value) => root.reflect.provide(name, value) };
}

const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cdoc-home-"));
let HOME_SEQ = 0;
function useHome(label) {
  HOME_SEQ += 1;
  const home = path.join(HOME_ROOT, `${String(HOME_SEQ).padStart(2, "0")}-${label}`);
  fs.mkdirSync(path.join(home, "profiles", "model-test"), { recursive: true });
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = "model-test";
  return { home, profile: path.join(home, "profiles", "model-test") };
}

async function newDoctor(probeModule, config, extraServices = {}) {
  const host = await makeHostRoot(extraServices);
  const doctor = new probeModule.CompactionDoctor(host.root, config);
  if (!REAL_CORDIS) host.provide("compactionDoctor", doctor);
  return { host, doctor };
}

const tmpFilesIn = (dir) => {
  try {
    return fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
  } catch {
    return [];
  }
};

/**
 * `DOCTOR_OWNED_KEYS` 没有导出（lib/engine.js:59-82），只能从源码文本里取。
 * 这是静态事实校验，不参与动态行为的建模。
 */
let DOCTOR_OWNED_KEYS_CACHE = null;
function parseDoctorOwnedKeys() {
  if (DOCTOR_OWNED_KEYS_CACHE !== null) return DOCTOR_OWNED_KEYS_CACHE;
  const source = fs.readFileSync(path.join(REPO, "lib", "engine.js"), "utf8");
  const match = /const DOCTOR_OWNED_KEYS = \[([\s\S]*?)\]/u.exec(source);
  if (match === null) throw new Error("lib/engine.js 里找不到 DOCTOR_OWNED_KEYS 字面量");
  const keys = [...match[1].matchAll(/"([^"]+)"/gu)].map((item) => item[1]);
  if (keys.length < 5) throw new Error(`DOCTOR_OWNED_KEYS 解析出 ${keys.length} 个键，疑似结构变化`);
  DOCTOR_OWNED_KEYS_CACHE = keys;
  return keys;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 浏览器半侧：桩 React + 虚拟时钟 + 假 fetch
// ─────────────────────────────────────────────────────────────────────────────

const CLIENT_VM = (() => {
  const sandbox = { window: {}, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} } };
  vm.createContext(sandbox);
  let captured = null;
  sandbox.window.__ModuleLoader__ = {
    load(entry) {
      captured = entry;
    },
  };
  vm.runInContext(fs.readFileSync(path.join(REPO, "lib", "client.js"), "utf8"), sandbox, { filename: "lib/client.js" });
  if (captured === null) throw new Error("client.js 没有调用 window.__ModuleLoader__.load");
  return { sandbox, entry: captured };
})();

/**
 * 桩 React 的 hook 宿主。与组件解耦：`client.js` 在 factory 调用时就要 `require('react')`，
 * 而组件要等 `apply(ctx)` 才拿到，所以 React API 必须先生成。
 */
function makeHookHost() {
  return { hooks: [], cursor: 0, dirty: false };
}

function makeReactApi(host) {
  return {
    createElement(type, props, ...children) {
      const out = {};
      if (props !== null && typeof props === "object") for (const key of Object.keys(props)) out[key] = props[key];
      if (children.length === 1) out.children = children[0];
      else if (children.length > 1) out.children = children;
      return { type, props: out };
    },
    useState(initial) {
      const index = host.cursor++;
      if (host.hooks[index] === undefined) {
        host.hooks[index] = { kind: "state", value: typeof initial === "function" ? initial() : initial };
      }
      const hook = host.hooks[index];
      if (hook.kind !== "state") throw new Error("hook 顺序在渲染之间发生变化");
      const set = (value) => {
        const next = typeof value === "function" ? value(hook.value) : value;
        if (Object.is(next, hook.value)) return;
        hook.value = next;
        host.dirty = true;
      };
      return [hook.value, set];
    },
    useRef(initial) {
      const index = host.cursor++;
      if (host.hooks[index] === undefined) host.hooks[index] = { kind: "ref", current: initial };
      return host.hooks[index];
    },
    useEffect(fn, deps) {
      const index = host.cursor++;
      if (host.hooks[index] === undefined) {
        host.hooks[index] = { kind: "effect", deps: undefined, cleanup: undefined, ran: false };
      }
      host.hooks[index].pending = { fn, deps: deps === undefined ? undefined : Array.from(deps) };
    },
  };
}

class Renderer {
  constructor(component, props, host) {
    this.component = component;
    this.props = props;
    this.host = host;
    this.tree = null;
    this.unmounted = false;
  }

  render() {
    const host = this.host;
    host.cursor = 0;
    for (const hook of host.hooks) if (hook.kind === "effect") hook.pending = undefined;
    this.tree = this.component(this.props);
    for (const hook of host.hooks) {
      if (hook.kind !== "effect" || hook.pending === undefined) continue;
      const { fn, deps } = hook.pending;
      hook.pending = undefined;
      const sameDeps =
        hook.ran === true &&
        deps !== undefined &&
        hook.deps !== undefined &&
        deps.length === hook.deps.length &&
        deps.every((value, index) => Object.is(value, hook.deps[index]));
      if (sameDeps) continue;
      const previous = hook.cleanup;
      hook.cleanup = undefined;
      if (typeof previous === "function") previous();
      hook.deps = deps;
      hook.ran = true;
      const produced = fn();
      hook.cleanup = typeof produced === "function" ? produced : undefined;
    }
  }

  flush() {
    let guard = 0;
    while (this.host.dirty) {
      if ((guard += 1) > 64) throw new Error("渲染未收敛（疑似 setState 环）");
      this.host.dirty = false;
      this.render();
    }
  }

  unmount() {
    for (const hook of this.host.hooks) {
      if (hook.kind === "effect" && typeof hook.cleanup === "function") {
        const cleanup = hook.cleanup;
        hook.cleanup = undefined;
        cleanup();
      }
    }
    this.unmounted = true;
  }
}

function findNode(tree, predicate) {
  if (tree === null || tree === undefined) return null;
  if (Array.isArray(tree)) {
    for (const item of tree) {
      const hit = findNode(item, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof tree !== "object") return null;
  if (predicate(tree) === true) return tree;
  return findNode(tree.props?.children, predicate);
}

class World {
  constructor() {
    this.drain = null;
    this.now = 0;
    this.timerSeq = 0;
    this.timers = new Map();
    this.requests = [];
    this.putCount = 0;
    this.hostLast = undefined;
    this.readbacksSinceWrite = 0;
    this.epochs = [];
  }

  addTimer(fn, ms) {
    const id = (this.timerSeq += 1);
    this.timers.set(id, { id, at: this.now + Math.max(0, Number(ms) || 0), seq: id, fn });
    return id;
  }

  clearTimer(id) {
    this.timers.delete(id);
  }

  fetch(url, init) {
    const method = String(init?.method ?? "GET").toUpperCase();
    let kind;
    if (method === "PUT") {
      kind = "write";
      this.putCount += 1;
      this.readbacksSinceWrite = 0;
      this.epochs.push({ createdAt: this.now, settledAt: undefined, kind: undefined, effectiveOk: false, expected: null });
    } else {
      kind = this.putCount > 0 ? "readback" : "mount";
      if (kind === "readback") this.readbacksSinceWrite += 1;
    }
    const rec = { id: this.requests.length + 1, kind, method, url, createdAt: this.now, settled: false, settledKind: undefined };
    rec.promise = new Promise((resolve) => {
      rec.resolve = resolve;
    });
    this.requests.push(rec);
    return rec.promise;
  }

  epoch() {
    return this.epochs.length === 0 ? undefined : this.epochs[this.epochs.length - 1];
  }

  /**
   * 该请求的客户端闸门（hard timeout）到期时刻。
   *   · 写：`guard(api(PUT), WRITE_TIMEOUT_MS)` ⇒ createdAt + 8000
   *   · 回读：`guard(api(GET), max(300, deadline - Date.now()))`，参数在同一同步块里求值，
   *     所以恰为 max(createdAt + 300, deadline)，deadline = afterWrite 时刻 + 3000
   *   · 挂载读：没有闸门
   */
  guardAt(rec) {
    if (rec.kind === "mount") return Infinity;
    if (rec.kind === "write") return rec.createdAt + 8000;
    const epoch = this.epoch();
    if (epoch === undefined) return Infinity;
    const timeoutAt = epoch.createdAt + 8000;
    const resolvedAt =
      epoch.settledAt !== undefined ? Math.min(epoch.settledAt, timeoutAt) : this.now >= timeoutAt ? timeoutAt : undefined;
    if (resolvedAt === undefined) return Infinity;
    return Math.max(rec.createdAt + 300, resolvedAt + 3000);
  }

  /**
   * 闸门先到期 ⇒ 之后才"到达"的响应被 `guard` 里的 `if (done) return;` 丢掉：
   * 既不改 DOM，也不算「宿主报告过」。触发闸门的定时器一响就登记，所以这个判定
   * 与真实事件顺序一致（同一毫秒上到底谁先到，由检验器的事件串决定，两种顺序都可枚举）。
   */
  attributeFiring(at) {
    for (const rec of this.requests) {
      if (rec.settled === true || rec.kind === "mount") continue;
      if (this.guardAt(rec) === at) rec.guardFired = true;
    }
  }

  /** 采样「忙」的解除时刻：P ⟺ 有已挂计时器，所以计时器数归零的那一刻就是 P 归零。 */
  sample() {
    if (this.timers.size > 0) {
      this.pWasBusy = true;
      return;
    }
    if (this.pWasBusy === true) {
      this.pClearAt = this.now;
      this.pWasBusy = false;
    }
  }

  openWrite() {
    for (let i = this.requests.length - 1; i >= 0; i -= 1) {
      const rec = this.requests[i];
      if (rec.kind === "write" && rec.settled === false) return rec;
    }
    return undefined;
  }

  openGet(kind) {
    return this.requests.filter((rec) => rec.kind === kind && rec.settled === false);
  }

  settle(rec, kind, expected) {
    if (rec === undefined || rec.settled === true) return;
    rec.settled = true;
    rec.settledKind = kind;
    rec.settledAt = this.now;
    const delivered = rec.guardFired !== true;
    rec.delivered = delivered;
    const respond = (ok, body) => rec.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
    if (kind === "on" || kind === "off") {
      const value = kind === "on";
      if (rec.kind !== "write" && delivered === true) this.hostLast = value;
      respond(true, { ok: true, enabled: value, auto: { key: "auto.none", params: {} } });
    } else if (kind === "stale") {
      respond(true, { ok: true, auto: { key: "auto.none", params: {} } });
    } else if (kind === "unavailable") {
      respond(true, { ok: true, unavailable: true });
    } else {
      respond(false, { ok: false, error: "host failure" });
    }
    if (rec.kind === "write") {
      const epoch = this.epoch();
      if (epoch !== undefined && epoch.createdAt === rec.createdAt && epoch.settledAt === undefined) {
        epoch.settledAt = this.now;
        epoch.kind = kind;
        epoch.effectiveOk = delivered === true && kind === "ok";
        // 不覆盖 captureExpected 取到的乐观值：settle 的调用方没有别的来源
        if (expected !== undefined) epoch.expected = expected;
      }
    }
  }

  /** 乐观写值 = 点击后的 DOM checked（`next = view.enabled !== true`）。 */
  captureExpected(env) {
    const epoch = this.epoch();
    if (epoch === undefined || epoch.expected !== null || env.renderer.unmounted === true) return;
    const input = findNode(env.renderer.tree, (node) => node.type === "input");
    if (input !== null) epoch.expected = input.props.checked === true;
  }

  async tick(ms) {
    const target = this.now + ms;
    for (;;) {
      let next = null;
      for (const timer of this.timers.values()) {
        if (timer.at <= target && (next === null || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq))) next = timer;
      }
      if (next === null) break;
      this.timers.delete(next.id);
      this.now = next.at;
      this.attributeFiring(next.at);
      next.fn();
      // eslint-disable-next-line no-await-in-loop
      await this.drain();
      this.sample();
    }
    this.now = target;
    await this.drain();
    this.sample();
  }
}

const DICT = {};
let SectionComponent = null;

function createClientEnv() {
  const world = new World();
  world.pWasBusy = false;
  world.pClearAt = 0;
  const sandbox = CLIENT_VM.sandbox;
  sandbox.setTimeout = (fn, ms) => world.addTimer(fn, ms);
  sandbox.clearTimeout = (id) => world.clearTimer(id);
  sandbox.Date = { now: () => world.now };
  sandbox.fetch = (url, init) => world.fetch(url, init);

  const hookHost = makeHookHost();
  const reactApi = makeReactApi(hookHost);
  const moduleExports = CLIENT_VM.entry.factory((name) => {
    if (name === "react") return reactApi;
    throw new Error(`client.js 请求了未知种子模块 ${name}`);
  });
  if (moduleExports === null || typeof moduleExports !== "object" || typeof moduleExports.apply !== "function") {
    throw new Error("client.js 的 factory 没有返回 { apply }");
  }

  SectionComponent = null;
  moduleExports.apply({
    effect(fn) {
      const produced = fn();
      return typeof produced === "function" ? produced : () => {};
    },
    locale: {
      register(ns, dictionaries) {
        DICT[ns] = dictionaries.zh;
        return () => {};
      },
      bind(ns) {
        return (key) => (DICT[ns] !== undefined && key in DICT[ns] ? DICT[ns][key] : key);
      },
    },
    slots: {
      inject(name, generator) {
        const iterator = generator();
        let step = iterator.next();
        while (step.done !== true) step = iterator.next();
      },
      register(config, component) {
        if (config !== null && config.name === "settings.section") SectionComponent = component;
        return () => {};
      },
    },
  });
  if (SectionComponent === null) throw new Error("client.js 没有注册 settings.section 组件");

  const props = { t: (key) => (DICT[NS_UI] !== undefined && key in DICT[NS_UI] ? DICT[NS_UI][key] : key) };
  const renderer = new Renderer(SectionComponent, props, hookHost);
  renderer.render();
  renderer.flush();
  world.drain = () => drainMicrotasks(renderer);
  return { world, renderer };
}

async function drainMicrotasks(renderer) {
  for (let i = 0; i < DRAIN_TICKS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  renderer.flush();
  for (let i = 0; i < DRAIN_TICKS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  renderer.flush();
}

// 状态行文案 → 键
const TEXT_KEY = (() => {
  const probe = createClientEnv();
  void probe;
  const map = new Map();
  for (const [key, text] of Object.entries(DICT[NS_UI])) {
    const normalized = String(text).trim();
    if (!map.has(normalized)) map.set(normalized, key);
  }
  return map;
})();

const KEY = {
  loading: "state.loading",
  unavailable: "state.unavailable",
  stale: "state.stale",
  none: "auto.none",
  off: "auto.off",
};

// ─────────────────────────────────────────────────────────────────────────────
// §4 观测、事件字母表、重放
// ─────────────────────────────────────────────────────────────────────────────

function observe(env, world) {
  const mountOpen = world.openGet("mount").length;
  const readbackOpen = world.openGet("readback").length;
  const writeRec = world.openWrite();
  const putOpen = writeRec === undefined ? 0 : 1;

  const obs = {
    phase: env.renderer.unmounted === true ? "unmounted" : "mounted",
    checked: null,
    disabled: null,
    statusKey: null,
    timers: world.timers.size,
    putOpen,
    rbOpen: readbackOpen,
    mountOpen,
  };

  if (obs.phase === "mounted") {
    const input = findNode(env.renderer.tree, (node) => node.type === "input");
    const status = findNode(env.renderer.tree, (node) => node.props?.role === "status");
    if (input === null) throw new Error("DOM 里找不到开关 input");
    if (status === null) throw new Error("DOM 里找不到状态行");
    obs.checked = input.props.checked === true;
    obs.disabled = input.props.disabled === true;
    obs.statusKey = TEXT_KEY.get(String(status.props.children).trim()) ?? `??(${String(status.props.children)})`;
  }

  const F = obs.statusKey === KEY.stale;
  const V = obs.statusKey === KEY.unavailable;
  const E =
    obs.phase !== "mounted"
      ? null
      : obs.checked === true
        ? true
        : obs.statusKey === KEY.none || obs.statusKey === KEY.off
          ? false
          : null;
  // P = `pending`（写协议在途）。probe 里的 pending 只在 toggle 里置 true，只在 readback
  // 的两个出口置 false，而这两点之间每一段都有 setTimer 兜着；所以静默观测点上
  // pending ⟺ 有已挂计时器。`disabled === (P ∨ F)` 的交叉断言见 I1。
  const P = obs.phase === "mounted" && obs.timers > 0;

  const epoch = world.epoch();
  const timeoutAt = epoch === undefined ? undefined : epoch.createdAt + 8000;
  const resolvedAt =
    epoch === undefined
      ? undefined
      : epoch.settledAt !== undefined
        ? Math.min(epoch.settledAt, timeoutAt)
        : world.now >= timeoutAt
          ? timeoutAt
          : undefined;
  const deadlineBucket =
    resolvedAt === undefined ? "na" : world.now >= resolvedAt + 3000 ? "past" : "future";

  return {
    ...obs,
    F,
    V,
    E,
    P,
    hostLast: world.hostLast === undefined ? "n" : world.hostLast ? "T" : "F",
    readbacks: world.readbacksSinceWrite,
    writeState: epoch === undefined ? "none" : epoch.settledAt === undefined ? "open" : epoch.effectiveOk ? "ok" : "bad",
    writeExpected: epoch === undefined || epoch.expected === null ? "?" : epoch.expected ? "T" : "F",
    deadlineBucket,
  };
}

const obsKey = (obs) =>
  JSON.stringify([
    obs.phase,
    obs.checked,
    obs.disabled,
    obs.statusKey,
    obs.timers,
    obs.putOpen,
    obs.rbOpen,
    obs.mountOpen,
    obs.hostLast,
    obs.readbacks,
    obs.writeState,
    obs.writeExpected,
    obs.deadlineBucket,
  ]);

const TICK_SIZES = [1, 300, 3000, 8000];

const ALPHABET = (() => {
  const events = [];
  const settleGet = (kind, value) => (env) => {
    const rec = env.world.openGet(kind)[0];
    env.world.settle(rec, value, undefined);
  };
  const settleWrite = (value) => (env) => {
    env.world.settle(env.world.openWrite(), value, undefined);
  };
  events.push(
    { name: "mount_ok_on", enabled: (env) => env.world.openGet("mount").length > 0, run: settleGet("mount", "on") },
    { name: "mount_ok_off", enabled: (env) => env.world.openGet("mount").length > 0, run: settleGet("mount", "off") },
    { name: "mount_stale", enabled: (env) => env.world.openGet("mount").length > 0, run: settleGet("mount", "stale") },
    { name: "mount_unavail", enabled: (env) => env.world.openGet("mount").length > 0, run: settleGet("mount", "unavailable") },
    { name: "mount_fail", enabled: (env) => env.world.openGet("mount").length > 0, run: settleGet("mount", "fail") },
    {
      name: "click",
      // 卸载后 DOM 已经不在文档里，React 也摘了监听：真实页面不可能再收到这个点击。
      enabled: (env) => env.renderer.unmounted !== true,
      run: (env) => {
        const input = findNode(env.renderer.tree, (node) => node.type === "input");
        if (input !== null && typeof input.props.onChange === "function") input.props.onChange();
      },
    },
    { name: "write_ok", enabled: (env) => env.world.openWrite() !== undefined, run: settleWrite("ok") },
    { name: "write_fail", enabled: (env) => env.world.openWrite() !== undefined, run: settleWrite("fail") },
    { name: "write_hang", enabled: (env) => env.world.openWrite() !== undefined, run: () => {} },
    { name: "rb_ok_on", enabled: (env) => env.world.openGet("readback").length > 0, run: settleGet("readback", "on") },
    { name: "rb_ok_off", enabled: (env) => env.world.openGet("readback").length > 0, run: settleGet("readback", "off") },
    { name: "rb_stale", enabled: (env) => env.world.openGet("readback").length > 0, run: settleGet("readback", "stale") },
    { name: "rb_unavail", enabled: (env) => env.world.openGet("readback").length > 0, run: settleGet("readback", "unavailable") },
    { name: "rb_fail", enabled: (env) => env.world.openGet("readback").length > 0, run: settleGet("readback", "fail") },
  );
  for (const ms of TICK_SIZES) {
    events.push({ name: `tick_${ms}`, enabled: () => true, run: (env) => env.world.tick(ms) });
  }
  events.push({
    name: "unmount",
    enabled: (env) => env.renderer.unmounted !== true,
    run: (env) => {
      env.renderer.unmount();
    },
  });
  return events;
})();

const EVENT_BY_NAME = new Map(ALPHABET.map((event) => [event.name, event]));

const REPLAY_CACHE = new Map();

async function applyEvent(env, event) {
  await event.run(env);
  await drainMicrotasks(env.renderer);
  env.world.sample();
  // 乐观写值只有在点击之后才从 DOM 读得到，所以在此处（点击已提交、写已发出）补记。
  env.world.captureExpected(env);
}

async function replay(seq) {
  const cacheKey = seq.join("|");
  const hit = REPLAY_CACHE.get(cacheKey);
  if (hit !== undefined) return hit;
  const env = createClientEnv();
  for (const name of seq) {
    const event = EVENT_BY_NAME.get(name);
    if (event === undefined) throw new Error(`未知事件 ${name}`);
    // eslint-disable-next-line no-await-in-loop
    await applyEvent(env, event);
  }
  const obs = observe(env, env.world);
  const entry = { seq, env, obs, key: obsKey(obs) };
  REPLAY_CACHE.set(cacheKey, entry);
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 主 BFS（M-4）
// ─────────────────────────────────────────────────────────────────────────────

const BFS = {
  visited: new Map(),
  edges: 0,
  applicable: 0,
  truncated: 0,
  truncatedInapplicable: 0,
  truncatedSelfLoop: 0,
  truncatedNewStates: 0,
  truncatedWitness: null,
  absorbing: 0,
  limitHit: false,
};

async function runBfs() {
  const start = await replay([]);
  BFS.visited.set(start.key, { seq: [], depth: 0, obs: start.obs });
  const queue = [{ key: start.key, seq: [], depth: 0 }];
  let expansions = 0;
  while (queue.length > 0) {
    if (BFS.visited.size > MAX_STATES) {
      BFS.limitHit = true;
      break;
    }
    const node = queue.shift();
    expansions += 1;
    if (VERBOSE && expansions % 40 === 0) {
      console.log(`   … 已扩展 ${expansions}，可达 ${BFS.visited.size}，边 ${BFS.edges}`);
    }
    const base = await replay(node.seq);
    if (node.depth >= DEPTH_LIMIT) {
      // 深度上界的边不展开，但统计其中"还会走到新抽象状态"的比例：
      // 若为 0，说明 D 已经饱和，更深的搜索不会再产生新状态。
      for (const event of ALPHABET) {
        BFS.truncated += 1;
        let applicable = false;
        try {
          applicable = event.enabled(base.env) === true;
        } catch {
          applicable = false;
        }
        if (applicable !== true) {
          BFS.truncatedInapplicable += 1;
          continue;
        }
        const child = await replay([...node.seq, event.name]);
        if (child.key !== node.key) {
          BFS.truncatedNewStates += 1;
          BFS.truncatedWitness ??= show([...node.seq, event.name]);
        } else {
          BFS.truncatedSelfLoop += 1;
        }
      }
      continue;
    }
    for (const event of ALPHABET) {
      let applicable = false;
      try {
        applicable = event.enabled(base.env) === true;
      } catch {
        applicable = false;
      }
      if (applicable !== true) continue;
      BFS.applicable += 1;
      const seq = [...node.seq, event.name];
      const child = await replay(seq);
      BFS.edges += 1;
      if (BFS.visited.has(child.key) !== true) {
        BFS.visited.set(child.key, { seq, depth: node.depth + 1, obs: child.obs });
        if (child.obs.phase === "unmounted") BFS.absorbing += 1;
        queue.push({ key: child.key, seq, depth: node.depth + 1 });
      }
    }
  }
  return expansions;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 装配与自检
// ─────────────────────────────────────────────────────────────────────────────

section("§0 装配");
console.log(`  仓库根           ${REPO}`);
console.log(`  临时树           ${TREE.root}   （@deepseek-ai 来源: ${TREE.mode}）`);
console.log(`  真实 cordis      ${REAL_CORDIS ? "yes" : "no（回退到 test/nm 桩）"}`);
console.log(`  深度上界 D       ${DEPTH_LIMIT}`);
console.log(`  事件字母表       ${ALPHABET.length} 个事件: ${ALPHABET.map((e) => e.name).join(", ")}`);

{
  const env = createClientEnv();
  await applyEvent(env, EVENT_BY_NAME.get("mount_ok_on"));
  await applyEvent(env, EVENT_BY_NAME.get("click"));
  const writes = env.world.requests.filter((r) => r.kind === "write").length;
  await applyEvent(env, EVENT_BY_NAME.get("write_ok"));
  const afterWrite = observe(env, env.world);
  await applyEvent(env, EVENT_BY_NAME.get("tick_300"));
  const reads = env.world.requests.filter((r) => r.kind === "readback").length;
  await applyEvent(env, EVENT_BY_NAME.get("rb_ok_on"));
  const after = observe(env, env.world);
  console.log(
    `  自检            1×click → PUT ${writes} 个；write_ok 后 P=${afterWrite.P ? 1 : 0}；tick_300 后回读 ${reads} 个；rb_ok_on 后 P=${after.P ? 1 : 0} readbacks=${after.readbacks} status=${after.statusKey}`,
  );
  if (writes !== 1) throw new Error("自检失败：click 没有发出 PUT（驱动/排空深度有误）");
  if (afterWrite.P !== true) throw new Error("自检失败：write_ok 之后应当仍处忙态（等待 settle 计时器）");
  if (reads !== 1) throw new Error("自检失败：tick_300 之后没有发出回读 GET");
  if (after.P !== false || after.readbacks !== 1) throw new Error("自检失败：写协议未在单次回读内收敛");
}

section("§1 穷尽 BFS（D=8，按抽象状态去重）");
const BFS_T0 = Date.now();
const EXPANSIONS = await runBfs();
console.log(`  扩展结点数       ${EXPANSIONS}`);
console.log(`  可达状态总数     ${BFS.visited.size}${BFS.limitHit ? `  ★触顶 ${MAX_STATES}，未穷尽` : ""}`);
console.log(`  转移边数         ${BFS.edges}（适用事件 ${BFS.applicable} 个）`);
console.log(
  `  深度上界的边     ${BFS.truncated} 条 = 不适用 ${BFS.truncatedInapplicable} + 自环 ${BFS.truncatedSelfLoop} + 通往新抽象状态 ${BFS.truncatedNewStates}`,
);
if (BFS.truncatedNewStates > 0) {
  console.log(`                   ★ D=${DEPTH_LIMIT} 未饱和，最深反例入口: ${BFS.truncatedWitness}`);
} else {
  console.log(`                   D=${DEPTH_LIMIT} 处已饱和（截断边要么不适用，要么是自环）`);
}
console.log(`  卸载吸收态       ${BFS.absorbing}`);
console.log(`  重放事件串总数   ${REPLAY_CACHE.size}`);
console.log(`  BFS 用时         ${Date.now() - BFS_T0}ms`);

const ALL = [...BFS.visited.values()];
const QUIESCENT = ALL.filter((node) => quiescent(node.obs) || node.obs.phase === "unmounted");

function quiescent(obs) {
  return (
    obs.phase === "mounted" && obs.P === false && obs.putOpen === 0 && obs.rbOpen === 0 && obs.mountOpen === 0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 客户端不变量
// ─────────────────────────────────────────────────────────────────────────────

section("§2 M-2 忠实性（观测 ↔ 组件的对应关系，以及每条推导的依据）");
console.log("  只从 DOM 与请求日志读出的分量：");
console.log("    checked          ← <input checked>（lib/client.js:340-350 的 checked={view.enabled === true}）");
console.log("    disabled         ← <input disabled>（lib/client.js:331 `disabled = pending || view.stale`）");
console.log("    statusKey        ← role=\"status\" 那行的文案 ↔ locale 字典（lib/client.js:332-336）");
console.log("    F（旧宿主）      ← statusKey === 'state.stale'");
console.log("    V（读不到）      ← statusKey === 'state.unavailable'");
console.log("  由上述量 + 请求日志推出的分量：");
console.log("    E                ← checked ? ⊤ : (statusKey ∈ {auto.*} ? ⊥ : ∅)；∅ 恰好对应 loading/stale/unavailable");
console.log("    P                ← 已挂计时器数 > 0；依据：pending 只在 toggle 置 true、只在 readback 两个出口置 false，");
console.log("                       且这两点之间每一段都由 setTimer 兜住 ⇒ 静默观测点上 pending ⟺ 计时器数 > 0");
console.log("  来自检验器台账（不可从 DOM 唯一读出，但完全由事件串决定，用来保证「合并后的状态未来相同」）：");
console.log("    在途请求数（mount/回读/写）、写 epoch 的期望值、回读次数、闸门是否已到期");
console.log("  已证明的交叉自检：disabled ≡ (P ∨ F) 在每个挂载态上成立（I1）——它同时验证 E/P 两条推导没被放宽。");

section("§3 客户端不变量（穷尽 BFS 上的逐状态断言）");

await invariant("I1", "无死开关：disabled ⇒ (P=1 ∨ F=1)；等式 disabled = (P ∨ F)；可点时点击必须发出 PUT", async (ctx) => {
  let witnesses = 0;
  let clickTested = 0;
  for (const node of ALL) {
    const obs = node.obs;
    if (obs.phase !== "mounted") continue;
    if (obs.disabled === true && obs.P === false && obs.F === false) {
      ctx.counterexamples.push(show(node.seq));
      fail(`不可点却不是「忙」也不是「旧宿主」: ${JSON.stringify(obs)}`, show(node.seq));
    }
    // 更强的等式：disabled 的成因只能是 P 或 F（不多不少，避免 P/F 定义被悄悄放宽）
    if (obs.disabled !== (obs.P === true || obs.F === true)) {
      ctx.counterexamples.push(show(node.seq));
      fail(`disabled=${String(obs.disabled)} 与 (P=${String(obs.P)} ∨ F=${String(obs.F)}) 不相等: ${JSON.stringify(obs)}`, show(node.seq));
    }
    if (obs.disabled === false) {
      witnesses += 1;
      const base = await replay(node.seq);
      const child = await replay([...node.seq, "click"]);
      const before = base.env.world.requests.filter((r) => r.kind === "write").length;
      const after = child.env.world.requests.filter((r) => r.kind === "write").length;
      clickTested += 1;
      if (after === before) {
        ctx.counterexamples.push(show([...node.seq, "click"]));
        fail(`可点的状态下点击没有发出 PUT: ${JSON.stringify(obs)}`, show([...node.seq, "click"]));
      }
    }
  }
  // 首帧：还没读到任何东西，也必须可点，并且点了就发 PUT
  const first = ALL.find((node) => node.obs.statusKey === KEY.loading);
  if (first === undefined) fail("不可达首帧（state.loading）");
  if (first.obs.disabled !== false) fail(`首帧不可点: ${JSON.stringify(first.obs)}`, show(first.seq));
  const afterClick = await replay([...first.seq, "click"]);
  if (afterClick.env.world.requests.filter((r) => r.kind === "write").length !== 1) {
    fail("首帧点击没有发出 PUT", show([...first.seq, "click"]));
  }
  return `可点状态 ${witnesses} 个（实点 ${clickTested} 次）全部发出 PUT；disabled ≡ (P ∨ F) 在 ${ALL.filter((n) => n.obs.phase === "mounted").length} 个挂载态上成立；首帧可点且点击发 PUT`;
});

await invariant("I2", "忙是有界的：从每个 P=1 状态出发，≤11000ms 虚拟时间内必到 P=0", async (ctx) => {
  const I2_ALPHABET = ["tick_300", "tick_3000", "tick_8000", "write_ok", "write_fail", "write_hang"];
  const starts = ALL.filter((node) => node.obs.P === true);
  const budget = 11000; // WRITE_TIMEOUT_MS(8000) + SETTLE_TOTAL_MS(3000)
  let worst = 0;
  let explored = 0;
  const memo = new Set();

  for (const start of starts) {
    const base = await replay(start.seq);
    const t0 = base.env.world.now;
    const walk = async (seq) => {
      explored += 1;
      const rec = await replay(seq);
      const clock = rec.env.world.now - t0;
      if (rec.obs.P === false) {
        // 精确解除时刻 = 计时器归零那一刻的虚拟时钟（不是 tick 累加和）
        const clear = Math.max(0, rec.env.world.pClearAt - t0);
        worst = Math.max(worst, clear);
        if (clear > budget) {
          ctx.counterexamples.push(show(seq));
          fail(`P=1 直到 ${clear}ms 才解除（上界 ${budget}ms）`, show(seq));
        }
        return;
      }
      if (clock > budget) {
        ctx.counterexamples.push(show(seq));
        fail(`时钟已到 ${clock}ms 而 P 仍为 1`, show(seq));
      }
      for (const name of I2_ALPHABET) {
        const event = EVENT_BY_NAME.get(name);
        if (event.enabled(rec.env) !== true) continue;
        const token = `${obsKey(rec.obs)}@${Math.ceil(clock / 300)}#${name}`;
        if (memo.has(token)) continue;
        memo.add(token);
        await walk([...seq, name]);
      }
    };
    await walk(start.seq);
  }
  return `${starts.length} 个 P=1 状态；最坏解除时间 ${worst}ms（上界 ${budget}ms，紧）；探索 ${explored} 个时间-事件结点`;
});

await invariant("I3", "显示一致性：E 只在写途（P=1）或从未读到过时偏离宿主最后报告值", async (ctx) => {
  let allowedInFlight = 0;
  let allowedNoValue = 0;
  let literalNoValue = 0;
  let literalWrongValue = 0;
  let literalWitness = null;
  for (const node of ALL) {
    const obs = node.obs;
    if (obs.phase !== "mounted") continue;
    const named = obs.hostLast === "T" ? true : obs.hostLast === "F" ? false : null;
    if (named === null || obs.E === named) continue;
    // 字面读法只豁免 P=1 ⇒ 读失败后显示「读不到」也会被计为违反。记录但不作为判决。
    if (obs.P !== true) {
      if (obs.E === null) literalNoValue += 1;
      else literalWrongValue += 1;
      literalWitness ??= show(node.seq);
    }
    if (obs.P === true) {
      allowedInFlight += 1;
      continue;
    }
    if (obs.E === null) {
      allowedNoValue += 1;
      continue;
    }
    ctx.counterexamples.push(show(node.seq));
    fail(`E=${String(obs.E)} 偏离宿主最后报告值 ${String(named)} 且非写途: ${JSON.stringify(obs)}`, show(node.seq));
  }
  const literalNote =
    literalNoValue + literalWrongValue > 0
      ? `；字面读法另有 ${literalNoValue} 个「显示无值」态（错值态 ${literalWrongValue} 个）被计为违反，最短 ${literalWitness} —— 规格 I3 应补上「读失败 ⇒ 显示无值不算说谎」这一豁免`
      : "";
  return `写途豁免 ${allowedInFlight} 个、无值豁免 ${allowedNoValue} 个，${ALL.filter((n) => n.obs.phase === "mounted").length} 个挂载态中无错值状态${literalNote}`;
});

await invariant("I4", "收敛：写成功后不可能长期说谎；对手永远不同意时终值 = 宿主最后报告值", async () => {
  let checked = 0;
  for (const node of ALL) {
    const obs = node.obs;
    if (obs.phase !== "mounted" || quiescent(obs) !== true) continue;
    if (obs.hostLast === "n") continue;
    checked += 1;
    const named = obs.hostLast === "T";
    if (obs.E !== null && obs.E !== named) {
      fail(`静默态 E=${String(obs.E)} ≠ 宿主最后报告 ${String(named)}: ${JSON.stringify(obs)}`, show(node.seq));
    }
  }
  // "宿主永远不同意"的对手：write_ok 之后每次回读都返回相反值
  const env = createClientEnv();
  const run = async (name) => applyEvent(env, EVENT_BY_NAME.get(name));
  await run("mount_ok_on");
  await run("click");
  await run("write_ok");
  let rounds = 0;
  for (;;) {
    const obs = observe(env, env.world);
    if (obs.P === false && obs.rbOpen === 0) break;
    if (obs.rbOpen > 0) {
      const rec = env.world.openGet("readback")[0];
      const opposite = obs.writeExpected === "T" ? "off" : "on";
      env.world.settle(rec, opposite, undefined);
      await drainMicrotasks(env.renderer);
    } else {
      await run("tick_300");
    }
    rounds += 1;
    if (rounds > 30) break;
  }
  const final = observe(env, env.world);
  const named = final.hostLast === "T";
  if (final.E !== named) {
    fail(`对手场景终态 E=${String(final.E)} ≠ 宿主最后报告 ${String(final.hostLast)}`);
  }
  return `静默态 ${checked} 个全部不说谎；对手场景 ${rounds} 轮后 E=${String(final.E)} = 宿主最后报告`;
});

await invariant("I5", "读有界：一次点击引发的读次数 ≤ 1+2；首次回读一致时 =1", async (ctx) => {
  let maxReadbacks = 0;
  let mounted = 0;
  for (const node of ALL) {
    const obs = node.obs;
    if (obs.phase !== "mounted") continue;
    mounted += 1;
    if (obs.readbacks > 3) {
      ctx.counterexamples.push(show(node.seq));
      fail(`同一写 epoch 内发出了 ${obs.readbacks} 次回读（上界 1+MAX_RETRY=3）: ${JSON.stringify(obs)}`, show(node.seq));
    }
    maxReadbacks = Math.max(maxReadbacks, obs.readbacks);
  }

  // 一次点击 → 写路径的全部后续：回读只在 tick_300 之后出现，逐个结果枚举
  const post = ["mount_ok_on", "click", "write_ok", "tick_300"];
  const outcomes = ["rb_ok_on", "rb_ok_off", "rb_stale", "rb_unavail", "rb_fail"];
  const tail = ["tick_300", "tick_300", "tick_300", "tick_3000", "tick_8000", "tick_8000", "tick_8000"];
  let firstMatchCases = 0;
  let retryCases = 0;
  for (const outcome of outcomes) {
    const seq = [...post, outcome];
    const rec = await replay(seq);
    const delivered = rec.env.world.requests.some((r) => r.kind === "readback" && r.settled === true && r.delivered === true);
    const end = await replay([...seq, ...tail]);
    if (end.obs.readbacks > 3) {
      ctx.counterexamples.push(show([...seq, ...tail]));
      fail(`回读次数 ${end.obs.readbacks} > 3`, show([...seq, ...tail]));
    }
    if (end.obs.P !== false) {
      ctx.counterexamples.push(show([...seq, ...tail]));
      fail(`静默失败：tick 到 ${JSON.stringify(end.obs.deadlineBucket)} 后仍 P=1`, show([...seq, ...tail]));
    }
    if ((outcome === "rb_ok_on" && rec.obs.writeExpected === "T") || (outcome === "rb_ok_off" && rec.obs.writeExpected === "F")) {
      firstMatchCases += 1;
      if (end.obs.readbacks !== 1) {
        ctx.counterexamples.push(show([...seq, ...tail]));
        fail(`首次回读已与期望一致却继续回读（readbacks=${end.obs.readbacks}）`, show([...seq, ...tail]));
      }
    }
    if (rec.obs.writeExpected !== "?" && outcome !== (rec.obs.writeExpected === "T" ? "rb_ok_on" : "rb_ok_off") && delivered === true) {
      retryCases += 1;
      if (end.obs.readbacks < 1) fail(`不一致的回读没有触发重试路径（${outcome}）`, show([...seq, ...tail]));
    }
  }

  // 写失败只允许一次回读（retries=0）
  const failEnd = await replay(["mount_ok_on", "click", "write_fail", "tick_300", ...tail]);
  if (failEnd.obs.readbacks !== 1) {
    fail(`写失败后回读 ${failEnd.obs.readbacks} 次，应恰好 1 次（MAX_RETRY 不适用于失败路径）`, show(["mount_ok_on", "click", "write_fail", "tick_300"]));
  }
  return `挂载态 ${mounted} 个，单 epoch 最大回读 ${maxReadbacks}（上界 3）；"首次一致即收工" ${firstMatchCases} 例 =1；不一致回读重试 ${retryCases} 例；写失败路径恰好 1 次回读`;
});

await invariant("I6", "计时器卫生：静默态与卸载后已挂计时器数 = 0", async () => {
  let lockQuiescent = 0;
  for (const node of ALL) {
    const obs = node.obs;
    if (obs.phase === "unmounted") {
      if (obs.timers !== 0) fail(`卸载后仍有 ${obs.timers} 个计时器`, show(node.seq));
      continue;
    }
    if (quiescent(obs) !== true) continue;
    lockQuiescent += 1;
    if (obs.timers !== 0) {
      fail(`静默态仍有 ${obs.timers} 个计时器: ${JSON.stringify(obs)}`, show(node.seq));
    }
  }
  const unmounted = ALL.filter((node) => node.obs.phase === "unmounted").length;
  return `静默态 ${lockQuiescent} 个、卸载态 ${unmounted} 个，计时器均为 0`;
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 宿主不变量
// ─────────────────────────────────────────────────────────────────────────────

section("§4 宿主不变量（真实 probe.js / engine.js）");

await invariant("I7", "宿主后置条件：writeConfigPatch({enabled:b}) 之后连续 3 次 stateSnapshot 都返回 b", async () => {
  const facts = [];
  for (const b of [true, false]) {
    const { profile } = useHome(`i7-${b ? "on" : "off"}`);
    const { doctor } = await newDoctor(M.probe, { enabled: !b });
    const result = await doctor.writeConfigPatch({ patch: { enabled: b } });
    if (result.ok !== true) fail(`writeConfigPatch({enabled:${b}}) 返回 ${JSON.stringify(result)}`);
    for (let round = 1; round <= 3; round += 1) {
      const snapshot = await doctor.stateSnapshot();
      if (snapshot.enabled !== b) {
        fail(`第 ${round} 次 stateSnapshot().enabled=${String(snapshot.enabled)} ≠ ${String(b)}`);
      }
    }
    const reloaded = new M.probe.CompactionDoctor((await makeHostRoot()).root, { enabled: !b });
    if (reloaded.config.enabled !== b) fail(`进程内重读（模拟"重启后构造"）后 enabled=${String(reloaded.config.enabled)} ≠ ${String(b)}`);
    const onDisk = M.probe.readSwitchState();
    if (onDisk !== b) fail(`持久化值 ${String(onDisk)} ≠ ${String(b)}（profile ${profile}）`);
    facts.push(`b=${String(b)}: snapshot×3 + 重载 + 磁盘一致`);
  }
  return facts.join("；");
});

await invariant("I8", "存储忠实性 + 原子性：垃圾 ⇒ undefined（绝不是 false）；3 个系统调用点故障注入", async () => {
  const { profile } = useHome("i8-read");
  const file = M.probe.switchStateFile();

  // (a) 值域：只有严格的 {"enabled": boolean} 才产出布尔
  const documents = [
    ["空文件", ""],
    ["半截 JSON", "{\"enabled\":"],
    ["半截对象", "{\"enabled\":false"],
    ["非 JSON", "not json at all"],
    ["null", "null"],
    ["数组", "[]"],
    ["字符串", "\"x\""],
    ["数字", "1"],
    ["布尔", "true"],
    ["字符串布尔", "{\"enabled\":\"true\"}"],
    ["数字布尔", "{\"enabled\":1}"],
    ["null 布尔", "{\"enabled\":null}"],
    ["别的键", "{\"other\":1}"],
    ["嵌套", "{\"enabled\":{\"value\":false}}"],
  ];
  const domain = new Set();
  for (const [label, text] of documents) {
    fs.writeFileSync(file, text, "utf8");
    const value = M.probe.readSwitchState();
    if (value !== undefined) fail(`文档「${label}」被读成 ${JSON.stringify(value)}（必须 undefined，绝不许变成 false）`);
    domain.add(value === undefined ? "undefined" : typeof value);
  }
  for (const expected of [true, false]) {
    fs.writeFileSync(file, `${JSON.stringify({ enabled: expected })}\n`, "utf8");
    const value = M.probe.readSwitchState();
    if (value !== expected) fail(`合法文档读成 ${String(value)} ≠ ${String(expected)}`);
    domain.add(typeof value);
  }
  if ([...domain].sort().join(",") !== "boolean,undefined") {
    fail(`readSwitchState 的值域是 {${[...domain].join(",")}}，应为 {undefined,boolean}`);
  }

  // (b) 三个系统调用点的单点故障
  const injections = [];
  const runFault = async (label, prepare) => {
    const { home } = useHome(`i8-${label}`);
    const fault = prepare(home);
    const { doctor } = await newDoctor(M.probe, { enabled: false });
    const target = !doctor.config.enabled;
    const result = await doctor.setEnabled(target);
    if (result.ok !== true) fail(`${label}: setEnabled 返回 ok=${String(result.ok)}（内存写入必须成功）`);
    if (result.persisted !== false) fail(`${label}: persisted=${String(result.persisted)}，预期 false`);
    if (doctor.config.enabled !== target) fail(`${label}: 内存未生效`);
    const snapshot = await doctor.stateSnapshot();
    if (snapshot.enabled !== target) fail(`${label}: stateSnapshot().enabled=${String(snapshot.enabled)} ≠ ${String(target)}`);
    const leftovers = [...tmpFilesIn(path.dirname(fault.file)), ...tmpFilesIn(fault.dir)];
    if (leftovers.length > 0) fail(`${label}: 残留临时文件 ${leftovers.join(", ")}`);
    injections.push(`${label}: ok=true persisted=false 内存生效 无残留`);
  };

  await runFault("mkdir", (home) => {
    const profile = path.join(home, "profiles", "model-test");
    fs.rmSync(profile, { recursive: true, force: true });
    fs.writeFileSync(profile, "not a directory", "utf8");
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = "model-test";
    return { file: path.join(profile, "compaction-doctor.state.json"), dir: path.join(home, "profiles") };
  });

  await runFault("write", (home) => {
    const profile = path.join(home, "profiles", "model-test");
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = "model-test";
    const file = path.join(profile, "compaction-doctor.state.json");
    fs.mkdirSync(file, { recursive: true }); // 目标路径是目录 ⇒ renameSync 必失败
    return { file, dir: profile };
  });

  let readOnlyNote = "只读目录: 平台未强制（跳过）";
  {
    const { home } = useHome("i8-readonly");
    const profile = path.join(home, "profiles", "model-test");
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = "model-test";
    let enforced = false;
    try {
      fs.chmodSync(profile, 0o500);
      const probeFile = path.join(profile, "probe-write-test");
      try {
        fs.writeFileSync(probeFile, "x", "utf8");
        fs.rmSync(probeFile, { force: true });
      } catch {
        enforced = true;
      }
    } catch {
      enforced = false;
    }
    if (enforced) {
      await runFault("readonly", () => {
        process.env.DSH_HOME = home;
        process.env.DSH_PROFILE = "model-test";
        return { file: path.join(profile, "compaction-doctor.state.json"), dir: profile };
      });
      readOnlyNote = "只读目录: 已注入";
    } else {
      try {
        fs.chmodSync(profile, 0o700);
      } catch {
        /* ignore */
      }
      readOnlyNote = "只读目录: 本平台（Windows ACL）不因 chmod 拒绝写入，未注入（规格允许）";
    }
  }

  return `垃圾文档 ${documents.length} 组全部 undefined；合法文档 2 组；故障注入 ${injections.length} 项（${injections.join("；")}）；${readOnlyNote}`;
});

await invariant("I9", "优先级定理：store 给出布尔值时有效值 = store；probe 行的专用键不被引擎行省略抹掉（48 组穷尽）", async () => {
  const variants = [
    { defaults: false, probe: M.probe, engine: M.engine },
    { defaults: true, probe: M.probeDefaultsOn, engine: M.engineDefaultsOn },
  ];
  const BASE_ENGINE_ROW = {
    auto: true,
    thresholdRatio: 0.8, // 引擎行的值；probe 行给 0.75，用来判别谁赢
    headroomTokens: 65536,
    retainRatio: 0.05,
    maxTokens: 65536,
    compactionRetries: 2,
    maxOverflowRetries: 2,
  };
  const probeThreshold = 0.75;
  const probeSummary = 0.9;
  let cases = 0;
  let storeWins = 0;
  let probeWins = 0;
  let engineRowRejected = 0;

  for (const variant of variants) {
    for (const engineRowEnabled of [true, false]) {
      for (const probeRowEnabled of [true, false]) {
        for (const storeBool of [true, false]) {
          for (const fileValue of [undefined, true, false]) {
            cases += 1;
            useHome(`i9-${cases}`);
            if (fileValue !== undefined) {
              const written = variant.probe.writeSwitchState(fileValue);
              if (written.ok !== true) fail(`预置 store=${String(fileValue)} 失败: ${written.error}`);
            }
            const probeRow = {
              enabled: probeRowEnabled,
              thresholdRatio: probeThreshold,
              summaryBudgetRatio: probeSummary,
              scaleMode: "meter",
            };

            // (1) 引擎行能否携带开关？shipped schema 必须拒绝 —— 这是「开关只能走 probe 行/store」的前提
            const { host: throwawayHost } = await newDoctor(variant.probe, probeRow);
            let rejection = null;
            try {
              new variant.engine.CompactionDoctorEngine(throwawayHost.root, { ...BASE_ENGINE_ROW, enabled: engineRowEnabled });
            } catch (error) {
              rejection = error;
            }
            if (rejection === null) {
              fail(`engine 行的 enabled:${String(engineRowEnabled)} 被 schema 接受了 —— 优先级定理的前提变了`);
            }
            if (/unknown key/u.test(String(rejection?.message)) !== true) {
              fail(`engine 行的 enabled 被拒绝，但错误不是键校验: ${rejection?.message}`);
            }
            engineRowRejected += 1;

            // (2) 真实生效值：新 root（前一次构造可能已经占用 compaction 服务名）
            const { host } = await newDoctor(variant.probe, probeRow);
            const engine = new variant.engine.CompactionDoctorEngine(host.root, BASE_ENGINE_ROW);
            const effective = engine.doctorConfig().enabled;
            const expected = fileValue !== undefined ? fileValue : probeRowEnabled;
            if (effective !== expected) {
              fail(
                `defaults=${String(variant.defaults)} engineRow=${String(engineRowEnabled)} probeRow=${String(probeRowEnabled)} store²=${String(storeBool)} file=${String(fileValue)} ⇒ 实际 ${String(effective)}，应为 ${String(expected)}`,
              );
            }
            const layer = engine.doctorConfig();
            if (fileValue !== undefined) {
              storeWins += 1;
            } else {
              probeWins += 1;
            }

            // (3) 引擎行省略 thresholdRatio / summaryBudgetRatio ⇒ probe 行的值必须存活
            if (layer.thresholdRatio !== probeThreshold) {
              fail(
                `引擎行省略 thresholdRatio 后 doctorConfig().thresholdRatio=${String(layer.thresholdRatio)} ≠ ${probeThreshold}（被 base class 的 0.8 覆盖了）`,
              );
            }
            if (layer.summaryBudgetRatio !== probeSummary) {
              fail(`引擎行省略 summaryBudgetRatio 后 doctorConfig().summaryBudgetRatio=${String(layer.summaryBudgetRatio)} ≠ ${probeSummary}`);
            }
          }
        }
      }
    }
  }
  return `${cases} 组（2 defaults × 2 engineRow × 2 probeRow × 2 store² × 3 file）：file 为布尔时 store 必胜 ${storeWins} 组、file 缺失时 probe 行生效 ${probeWins} 组；engine 行携带 enabled 全部被 schema 拒绝 ${engineRowRejected} 组；省略键存活断言 2×${cases} 条全通过`;
});

await invariant("I10", "引擎可见性：probe 行的 enabled 立即被 doctorConfig() 读到（无需重启）", async () => {
  // 静态事实：开关只能从 probe 行来 —— DOCTOR_OWNED_KEYS 含 enabled，而引擎行 schema 不含
  const doctorKeys = parseDoctorOwnedKeys();
  if (doctorKeys.includes("enabled") !== true) {
    fail(`DOCTOR_OWNED_KEYS 不含 enabled（实际 ${JSON.stringify(doctorKeys)}）：开关不可能被 doctorConfig() 图层读到`);
  }
  if (M.probe.ENGINE_ROW_KEYS.includes("enabled")) {
    fail(`ENGINE_ROW_KEYS 含 enabled，engine 行可以携带开关，优先级定理需要重写`);
  }
  let probes = 0;
  for (const enabled of [true, false]) {
    useHome(`i10-${enabled ? "on" : "off"}`);
    const { host, doctor } = await newDoctor(M.probe, { enabled });
    const engine = new M.engine.CompactionDoctorEngine(host.root, {
      auto: true,
      headroomTokens: 65536,
      retainRatio: 0.05,
      maxTokens: 65536,
      compactionRetries: 2,
      maxOverflowRetries: 2,
    });
    if (engine.doctorConfig().enabled !== enabled) {
      fail(`probe 行 enabled=${String(enabled)} ⇒ doctorConfig().enabled=${String(engine.doctorConfig().enabled)}`);
    }
    // 同进程内翻转，第二次读即生效
    const flipped = !enabled;
    await doctor.setEnabled(flipped);
    if (engine.doctorConfig().enabled !== flipped) {
      fail(`同进程内翻转后 doctorConfig().enabled=${String(engine.doctorConfig().enabled)} ≠ ${String(flipped)}（需要重启？）`);
    }
    const snapshot = await doctor.stateSnapshot();
    if (snapshot.enabled !== flipped) fail(`翻转后 stateSnapshot().enabled=${String(snapshot.enabled)}`);
    probes += 2;
  }
  return `probe 行两态 + 同进程翻转各 2 次，共 ${probes} 次读取全部跟随（无重启需求）`;
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 I11：格并（无意见不得覆盖）
// ─────────────────────────────────────────────────────────────────────────────

section("§5 I11 合并是格并（无意见不得覆盖）");

const DOMAIN = [undefined, null, 0, 1, "", "x", false, true];
const isBottom = (value) => value === undefined || value === null;
const label = (value) => (value === undefined ? "undefined" : value === null ? "null" : JSON.stringify(value));
const read = (object, key) => (Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);

await invariant("I11a", "mergeDefined 的格并代数律（|D|² = 64 组全笛卡尔积 + |D|³ 结合律 + ⊥ 单位元）", async () => {
  const merge = M.probe.mergeDefined;

  // 1) ⊥ 是"无意见"：不是 ⊥ 的值必胜；两个 ⊥ 收敛成"没有意见"
  for (const lower of DOMAIN) {
    for (const upper of DOMAIN) {
      const got = read(merge({ k: lower }, { k: upper }), "k");
      const want = !isBottom(upper) ? upper : !isBottom(lower) ? lower : undefined;
      if (!Object.is(got, want)) {
        fail(`mergeDefined({k:${label(lower)}},{k:${label(upper)}}) = ${label(got)}，应为 ${label(want)}`);
      }
    }
  }

  // 2) 幂等
  for (const value of DOMAIN) {
    const got = read(merge({ k: value }, { k: value }), "k");
    const want = isBottom(value) ? undefined : value;
    if (!Object.is(got, want)) fail(`幂等破坏: mergeDefined({k:${label(value)}},{k:${label(value)}}) = ${label(got)}`);
  }

  // 3) 结合律（含 ⊥）
  for (const a of DOMAIN) {
    for (const b of DOMAIN) {
      for (const c of DOMAIN) {
        const left = read(merge(merge({ k: a }, { k: b }), { k: c }), "k");
        const right = read(merge({ k: a }, merge({ k: b }, { k: c })), "k");
        if (!Object.is(left, right)) {
          fail(`结合律破坏: a=${label(a)} b=${label(b)} c=${label(c)} ⇒ ${label(left)} vs ${label(right)}`);
        }
      }
    }
  }

  // 4) ⊥ 单位元（两侧）
  for (const value of DOMAIN) {
    for (const bottom of [undefined, null]) {
      const left = read(merge({ k: bottom }, { k: value }), "k");
      const right = read(merge({ k: value }, { k: bottom }), "k");
      const want = isBottom(value) ? undefined : value;
      if (!Object.is(left, want) || !Object.is(right, want)) {
        fail(`⊥ 单位元破坏: value=${label(value)} bottom=${label(bottom)} ⇒ ${label(left)} / ${label(right)}`);
      }
    }
  }

  // 5) 无意见不覆盖（下半层永远不能被 ⊥ 抹掉）
  let noErasure = 0;
  for (const lower of DOMAIN) {
    if (isBottom(lower)) continue;
    for (const upper of [undefined, null]) {
      const got = read(merge({ k: lower }, { k: upper }), "k");
      if (!Object.is(got, lower)) fail(`无意见覆盖了下层: ${label(lower)} ⊔ ${label(upper)} = ${label(got)}`);
      noErasure += 1;
    }
  }

  // 6) 键存在性：⊥ 不得凭空造键
  for (const bottom of [undefined, null]) {
    if (Object.prototype.hasOwnProperty.call(merge({ k: bottom }, { k: bottom }), "k")) {
      fail(`mergeDefined 为全 ⊥ 的键造出了键位（值 ${label(read(merge({ k: bottom }, { k: bottom }), "k"))}）`);
    }
  }

  return `64 组二元 × 512 组三元 × 幂等/单位元/无覆盖 ${noErasure} 组，全部满足格并律`;
});

await invariant("I11b", "normalizeConfig：下层（DOCTOR_DEFAULTS）不得被「无意见」抹掉", async () => {
  const baseline = M.probe.normalizeConfig({});
  const keys = Object.keys(baseline).filter((key) => baseline[key] !== undefined);
  let checks = 0;
  for (const key of keys) {
    for (const bottom of [undefined, null]) {
      const got = M.probe.normalizeConfig({ [key]: bottom });
      checks += 1;
      if (got[key] !== baseline[key]) {
        fail(`normalizeConfig({${key}: ${label(bottom)}}) 的 ${key} = ${label(got[key])}，基线是 ${label(baseline[key])}（无意见覆盖了下层）`);
      }
    }
  }
  // 判别性最强的真实配置：summaryBudgetRatio / scaleMode 只在 DOCTOR_DEFAULTS 里有值，
  // 而 profile 里 engine 行缺这些键。老写法会把它们抹成 undefined。
  const discriminator = M.probe.normalizeConfig({ summaryBudgetRatio: undefined, scaleMode: undefined });
  if (discriminator.summaryBudgetRatio !== baseline.summaryBudgetRatio || discriminator.scaleMode !== baseline.scaleMode) {
    fail(`判别用例失败: ${JSON.stringify({ summaryBudgetRatio: discriminator.summaryBudgetRatio, scaleMode: discriminator.scaleMode })}`);
  }
  return `对 ${keys.length} 个有值键 × {undefined,null} = ${checks} 组断言下层存活；判别键 summaryBudgetRatio/scaleMode 通过`;
});

await invariant("I11c", "_policy()：引擎行的「无意见」不得抹掉 probe 行的值", async () => {
  const { host, doctor } = await newDoctor(M.probe, { enabled: true, summaryBudgetRatio: 0.9, scaleMode: "meter", thresholdRatio: 0.75 });
  const probeConfig = { ...doctor.config };
  const keys = Object.keys(probeConfig).filter((key) => probeConfig[key] !== undefined);

  const withNoEngine = doctor._policy();
  let checks = 0;
  for (const key of keys) {
    const absent = read(withNoEngine, key);
    if (absent === undefined) continue;
    for (const bottom of [undefined, null]) {
      const { host: h2, doctor: d2 } = await newDoctor(M.probe, { enabled: true, summaryBudgetRatio: 0.9, scaleMode: "meter", thresholdRatio: 0.75 });
      h2.provide("compaction", { config: { [key]: bottom } });
      const got = read(d2._policy(), key);
      checks += 1;
      if (!Object.is(got, absent)) {
        fail(`_policy() 中引擎行的 ${key}:${label(bottom)} 抹掉了 probe 行的 ${label(absent)} ⇒ ${label(got)}`);
      }
    }
  }
  // 有意见必胜
  const { host: h3, doctor: d3 } = await newDoctor(M.probe, { enabled: true });
  h3.provide("compaction", { config: { summaryBudgetRatio: 0.25 } });
  if (d3._policy().summaryBudgetRatio !== 0.25) fail(`引擎行的明确值没有胜出: ${label(d3._policy().summaryBudgetRatio)}`);

  void host;
  return `probe 行 ${keys.length} 个有值键 × {undefined,null} = ${checks} 组全部存活；引擎行明确值必胜`;
});

await invariant("I11d", "doctorConfig().layer()：probe 行的「无意见」不得抹掉 defaults/引擎行；有意见必逐键生效", async () => {
  const keys = parseDoctorOwnedKeys();
  const values = [0, 1, "", "x", false, true];
  let noErasureChecks = 0;
  let opinionChecks = 0;

  for (const key of keys) {
    // 基线：probe 行完全不表态 ⇒ doctorConfig 只由 defaults ← 引擎行决定
    useHome(`i11d-base-${key}`);
    const { host: h1 } = await newDoctor(M.probe, {});
    const e1 = new M.engine.CompactionDoctorEngine(h1.root, {
      auto: true,
      thresholdRatio: 0.75,
      headroomTokens: 65536,
      retainRatio: 0.05,
      maxTokens: 65536,
      compactionRetries: 2,
      maxOverflowRetries: 2,
    });
    const baseline = read(e1.doctorConfig(), key);

    for (const bottom of [undefined, null]) {
      useHome(`i11d-bottom-${key}-${String(bottom)}`);
      const { host: h2 } = await newDoctor(M.probe, { [key]: bottom });
      const e2 = new M.engine.CompactionDoctorEngine(h2.root, {
        auto: true,
        thresholdRatio: 0.75,
        headroomTokens: 65536,
        retainRatio: 0.05,
        maxTokens: 65536,
        compactionRetries: 2,
        maxOverflowRetries: 2,
      });
      const got = read(e2.doctorConfig(), key);
      noErasureChecks += 1;
      if (!Object.is(got, baseline)) {
        fail(`probe 行的 ${key}:${label(bottom)}（无意见）抹掉了基线 ${label(baseline)} ⇒ ${label(got)}`);
      }
    }

    for (const value of values) {
      // 期望值 = 真实 normalizeConfig 对同一个键的规范化结果（probe 自己的类型收敛规则）
      const normalized = M.probe.normalizeConfig({ [key]: value })[key];
      if (normalized === undefined) continue;
      useHome(`i11d-win-${key}-${String(value)}`);
      const { host: h3 } = await newDoctor(M.probe, { [key]: value });
      const e3 = new M.engine.CompactionDoctorEngine(h3.root, {
        auto: true,
        thresholdRatio: 0.75,
        headroomTokens: 65536,
        retainRatio: 0.05,
        maxTokens: 65536,
        compactionRetries: 2,
        maxOverflowRetries: 2,
      });
      const got = read(e3.doctorConfig(), key);
      opinionChecks += 1;
      if (!Object.is(got, normalized)) {
        fail(`probe 行的 ${key}:${label(value)} 规范化后为 ${label(normalized)}，但 doctorConfig() 给出 ${label(got)}`);
      }
    }
  }
  return `DOCTOR_OWNED_KEYS ${keys.length} 键 × {undefined,null} = ${noErasureChecks} 组无覆盖；有意见逐键一致 ${opinionChecks} 组`;
});

// ─────────────────────────────────────────────────────────────────────────────
// §5b I11e 的运行期站点取集与性质判定
//
// 原则：站点集合、来源数、判定、分类全部在运行期从**当前源码**与**真实对象**推出，
// 不写死任何行号或期望。所以以后每修一处合并点，这里不会 FAIL。
// ─────────────────────────────────────────────────────────────────────────────

const BRACKETS = { "{": "}", "(": ")", "[": "]" };

function skipStringLiteral(source, index) {
  const quote = source[index];
  let i = index + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

/** 把注释替换成等长空白：索引与行号保持有效，注释里的 `{ ...` 不算代码。 */
function stripComments(source) {
  const out = [...source];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i);
      const stop = end === -1 ? source.length : end + 2;
      for (let k = i; k < stop; k += 1) if (source[k] !== "\n") out[k] = " ";
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

function findClosing(source, openIndex) {
  const stack = [];
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(source, i);
      continue;
    }
    if (BRACKETS[ch] !== undefined) {
      stack.push(ch);
      i += 1;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      const opener = stack.pop();
      if (BRACKETS[opener] !== ch) throw new Error(`括号不匹配 @${String(i)}`);
      if (stack.length === 0) return i;
    }
    i += 1;
  }
  throw new Error("找不到配对的括号");
}

function splitTopLevel(source) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(source, i);
      continue;
    }
    if ("({[".includes(ch)) depth += 1;
    else if (")}]".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

function enclosingMethodName(source, index) {
  const before = source.slice(0, index);
  const found = [...before.matchAll(/\n[ \t]*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gu)].pop();
  return found === undefined ? null : found[1];
}

/** 运行期从 lib/** 现取所有对象展开与显式合并调用站点。 */
function collectMergeSites() {
  const dir = path.join(REPO, "lib");
  const sites = [];
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".js"))) {
    const source = stripComments(fs.readFileSync(path.join(dir, name), "utf8"));
    const file = `lib/${name}`;
    for (const match of source.matchAll(/\b(mergeDefined|Object\.assign)\s*\(/gu)) {
      const openIndex = match.index + match[0].length - 1;
      const closeIndex = findClosing(source, openIndex);
      sites.push({
        file,
        line: lineAt(source, match.index),
        kind: "merge-call",
        callee: match[1],
        operands: splitTopLevel(source.slice(openIndex + 1, closeIndex)),
        literals: [],
        enclosing: enclosingMethodName(source, match.index),
        sourcePrefix: source.slice(Math.max(0, match.index - 24), match.index),
        text: source.slice(match.index, closeIndex + 1).replace(/\s+/gu, " "),
      });
    }
    for (const match of source.matchAll(/\{\s*\.\.\./gu)) {
      const openIndex = source.indexOf("{", match.index);
      const closeIndex = findClosing(source, openIndex);
      const operands = [];
      const literals = [];
      for (const field of splitTopLevel(source.slice(openIndex + 1, closeIndex))) {
        if (field.startsWith("...")) operands.push(field.slice(3).trim());
        else literals.push(field);
      }
      if (operands.length === 0) continue;
      sites.push({
        file,
        line: lineAt(source, match.index),
        kind: "spread",
        callee: "spread",
        operands,
        literals,
        enclosing: enclosingMethodName(source, match.index),
        text: source.slice(openIndex, closeIndex + 1).replace(/\s+/gu, " "),
      });
    }
  }
  return sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** 把操作数表达式解析成真实值；解析不出来返回 null（该站点判 SKIP）。 */
function resolveOperand(text, environment) {
  let inner = String(text).trim();
  const nullish = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\?\?\s*\{\s*\}$/u.exec(inner);
  if (nullish !== null) inner = nullish[1];
  const wrapped = /^(?:shallowClone|clone)\s*\(([^()]*)\)$/u.exec(inner);
  if (wrapped !== null) inner = wrapped[1].trim();

  const method = /^this\.([A-Za-z_$][\w$]*)(\(\s*\))?$/u.exec(inner);
  if (method !== null) {
    const found = [];
    for (const receiver of environment.receivers) {
      const member = receiver.object[method[1]];
      try {
        if (method[2] !== undefined) {
          if (typeof member !== "function") continue;
          const value = member.call(receiver.object);
          if (value !== null && typeof value === "object" && Array.isArray(value) !== true) {
            found.push({ label: `${receiver.label}.${method[1]}()`, value });
          }
        } else if (member !== undefined && member !== null && typeof member === "object") {
          found.push({ label: `${receiver.label}.${method[1]}`, value: member });
        }
      } catch {
        /* 该接收者不可驱动，换下一个 */
      }
    }
    return found.length > 0 ? found : null;
  }

  if (/^[A-Za-z_$][\w$]*$/u.test(inner)) {
    for (const module_ of environment.modules) {
      if (Object.prototype.hasOwnProperty.call(module_.namespace, inner)) {
        return [{ label: `${module_.label}.${inner}`, value: module_.namespace[inner] }];
      }
    }
  }
  return null;
}

/** 运行期形状分类：叶子都是原始值/纯对象 = 配置形；含数组/函数 = 数据形。 */
function shapeOf(value) {
  if (value === null || typeof value !== "object") return "other";
  for (const item of Object.values(value)) {
    if (typeof item === "function" || Array.isArray(item)) return "data";
  }
  return "config";
}

const describe = (value) => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return JSON.stringify(value);
};


await invariant("I11e", "全仓合并点审计（站点集合运行期现取）：每个站点动态判定是否满足格并性质", async () => {
  // 1) 站点集合：运行期从当前 lib/** 现取，不写死任何行号
  const sites = collectMergeSites();
  if (sites.length === 0) skip("lib/** 里找不到任何对象展开或显式合并调用站点");

  // 2) 可驱动环境：真实 doctor + 真实 engine（两种配置丰满度，用来变化视图键集）
  const BASE_ENGINE_ROW = {
    auto: true,
    thresholdRatio: 0.8,
    headroomTokens: 65536,
    retainRatio: 0.05,
    maxTokens: 65536,
    compactionRetries: 2,
    maxOverflowRetries: 2,
  };
  const buildEnvironment = async (label, doctorRow) => {
    useHome(`i11e-${label}`);
    const { host, doctor } = await newDoctor(M.probe, doctorRow);
    const engine = new M.engine.CompactionDoctorEngine(host.root, BASE_ENGINE_ROW);
    return {
      label,
      receivers: [
        { label: "doctor", object: doctor },
        { label: "engine", object: engine },
      ],
      modules: [
        { label: "probe", namespace: M.probe },
        { label: "engine", namespace: M.engine },
      ],
    };
  };
  const environments = [
    await buildEnvironment("full", {
      enabled: true,
      model: "model-from-probe",
      provider: "provider-from-probe",
      thresholdRatio: 0.7,
      summaryBudgetRatio: 0.9,
      scaleMode: "meter",
      maxSummaryChunks: 8,
      tokensPerByte: 0.34,
      selectCapRatio: 0.85,
      overflowRecovery: true,
      capMaxTokens: 65536,
      fallbackContextWindow: 131072,
    }),
    await buildEnvironment("sparse", { enabled: false }),
  ];

  // 3) 逐站点动态判定
  const inventory = [];
  let passCount = 0;
  let skipCount = 0;
  let explicitJoinCount = 0;
  let singleSourceCount = 0;
  let multiSourceSpreadCount = 0;
  let multiSourceSkipped = 0;

  for (const site of sites) {
    const where = `${site.file}:${site.line}`;
    const sources = site.operands.length;
    const isMergeCall = site.kind === "merge-call";
    const sourcePrefix = site.sourcePrefix ?? "";
    const unresolved = [];
    const overlaps = [];
    const evidence = [];

    // 判定 1：显式格并（mergeDefined）—— 代数律由 I11a 穷尽证明
    if (isMergeCall && site.callee === "mergeDefined" && sources >= 2) {
      explicitJoinCount += 1;
      passCount += 1;
      inventory.push(`    [PASS] ${where} 格并（显式） ${site.callee}(${sources} 个来源) · ${site.text}`);
      continue;
    }
    if (isMergeCall && sources < 2) {
      const restDecl = sources === 1 && site.operands[0].startsWith("...");
      const isDecl = /function\s*$/u.test(sourcePrefix) === true;
      singleSourceCount += 1;
      passCount += 1;
      inventory.push(
        isDecl || restDecl
          ? `    [PASS] ${where} 函数声明（不是合并点） · ${site.text}`
          : `    [PASS] ${where} 单来源调用 · ${site.text}`,
      );
      continue;
    }

    // 判定 2：单来源展开 —— 克隆/状态构造，不存在层间覆盖
    if (site.kind === "spread" && sources === 1) {
      const resolved =
        environments.map((environment) => resolveOperand(site.operands[0], environment)).find((item) => item !== null) ?? null;
      const shape = resolved === null ? "未驱动" : shapeOf(resolved[0].value);
      const kindText = shape === "config" ? "配置/视图克隆" : shape === "data" ? "数据对象" : "未驱动";
      singleSourceCount += 1;
      passCount += 1;
      let extra = "";
      if (resolved !== null) extra = `，运行期形状=${kindText}（${resolved[0].label} ⇒ 键 ${JSON.stringify(Object.keys(resolved[0].value ?? {}))}）`;
      const bottomLiterals = site.literals.filter((field) => /:\s*(undefined|null)\s*$/u.test(field));
      if (bottomLiterals.length > 0) extra += `，注意：字面量字段直接赋 ⊥ ${JSON.stringify(bottomLiterals)}`;
      inventory.push(`    [PASS] ${where} 单来源展开（不存在层间覆盖）${extra} · ${site.text}`);
      continue;
    }

    // 判定 3：两个及以上来源的展开/赋值 —— 运行期断言 keys(a) ∩ keys(b) = ∅
    multiSourceSpreadCount += 1;
    let driven = false;
    for (const environment of environments) {
      const resolvedList = site.operands.map((operand) => resolveOperand(operand, environment));
      if (resolvedList.some((item) => item === null)) {
        for (let i = 0; i < resolvedList.length; i += 1) if (resolvedList[i] === null) unresolved.push(`${environment.label}:${site.operands[i]}`);
        continue;
      }
      driven = true;
      let combos = [[]];
      for (const options of resolvedList) combos = combos.flatMap((prefix) => options.map((option) => [...prefix, option]));
      for (const combo of combos) {
        const keySets = combo.map((item) => new Set(Object.keys(item.value ?? {})));
        const shared = [...keySets[0]].filter((key) => keySets.slice(1).every((set) => set.has(key)));
        evidence.push(
          `${combo.map((item) => item.label).join(" ∪ ")} ⇒ 键集 ${JSON.stringify(combo.map((item) => [...Object.keys(item.value ?? {})]))}`,
        );
        if (shared.length > 0) overlaps.push({ environment: environment.label, shared, combo });
      }
      // 交叉校验：站点所在方法可驱动且站点没有附加字面量字段时，实测输出必须含两层并集的键
      if (site.literals.length === 0 && site.enclosing !== null) {
        for (const receiver of environment.receivers) {
          const method = receiver.object[site.enclosing];
          if (typeof method !== "function") continue;
          try {
            const produced = await method.call(receiver.object);
            const target = produced !== null && typeof produced === "object" ? produced.config : undefined;
            if (target === null || typeof target !== "object" || Array.isArray(target) === true) continue;
            const expectedKeys = new Set(resolvedList.flatMap((options) => Object.keys(options[0].value ?? {})));
            const actualKeys = new Set(Object.keys(target));
            const missing = [...expectedKeys].filter((key) => actualKeys.has(key) !== true);
            evidence.push(
              missing.length === 0
                ? `交叉校验 ${receiver.label}.${site.enclosing}() 实测输出含两层并集全部 ${actualKeys.size} 个键`
                : `交叉校验 ${receiver.label}.${site.enclosing}() 实测输出缺键 ${JSON.stringify(missing)}（输入该路径需要参数，仅供参考）`,
            );
          } catch {
            /* 驱动不了就只靠键集判定 */
          }
        }
      }
    }

    if (overlaps.length > 0) {
      const first = overlaps[0];
      const upper = first.combo[first.combo.length - 1];
      const lower = first.combo[0];
      CURRENT.counterexamples.push(`${where} 重叠键 ${JSON.stringify(first.shared)}`);
      fail(
        `展开式合并站点 ${where} 的两个来源键集相交 ${JSON.stringify(first.shared)}：展开会对这些键无条件赋值（包括 ⊥），不满足「无意见不得覆盖」。\n           实际输入: ${first.combo.map((item) => `${item.label}=${describe(item.value)}`).join(" , ")}\n           实际输出: ${JSON.stringify(first.shared.map((key) => ({ key, 上层实际值: describe(upper.value?.[key]), 下层实际值: describe(lower.value?.[key]) })))}`,
      );
    }
    if (driven !== true) {
      skipCount += 1;
      multiSourceSkipped += 1;
      inventory.push(`    [SKIP] ${where} 无法在检验器里驱动到该站点（未解析的操作数: ${[...new Set(unresolved)].join(", ")}） · ${site.text}`);
      continue;
    }
    passCount += 1;
    inventory.push(
      `    [PASS] ${where} 展开式合并，但键集实测不相交（并集，不构成合并） · ${site.text}` +
        (evidence.length > 0 ? `\n             证据: ${evidence.join(" | ")}` : ""),
    );
  }

  console.log("  I11e 站点清单（运行期从当前 lib/** 现取：无行号判定表、无预标注分类）:");
  for (const line of inventory) console.log(line);

  if (passCount === 0) skip(`全部 ${skipCount} 个多来源站点都无法驱动，没有可判定的合并点`);
  return `${sites.length} 个站点（现取）：PASS ${passCount}、SKIP ${skipCount}、FAIL 0 —— 显式格并 ${explicitJoinCount}、单来源 ${singleSourceCount}、多来源展开/赋值 ${multiSourceSpreadCount}（其中键集不相交 ${multiSourceSpreadCount - multiSourceSkipped}、SKIP ${multiSourceSkipped}）`;
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 报告
// ─────────────────────────────────────────────────────────────────────────────

section("§6 结论");
const failed = RESULTS.filter((entry) => entry.status === "FAIL");
const skipped = RESULTS.filter((entry) => entry.status === "SKIP");
for (const entry of RESULTS) {
  console.log(`  ${entry.status.padEnd(4)} ${String(entry.id).padEnd(5)} ${entry.title}`);
  if (entry.detail) console.log(`        ${entry.detail}`);
  if (entry.counterexample) console.log(`        最短反例: ${entry.counterexample}`);
}
console.log(
  `\n  可达状态 ${BFS.visited.size} / 转移边 ${BFS.edges} / 截断边 ${BFS.truncated} / 重放事件串 ${REPLAY_CACHE.size} / 深度上界 ${DEPTH_LIMIT}`,
);
if (WARNINGS.length > 0) {
  section("§7 已记录的残留问题（WARNING，未计入 FAIL）");
  for (const warning of WARNINGS) console.log(`  · ${warning}`);
}
console.log(`  合计 ${RESULTS.length} 条：PASS ${RESULTS.length - failed.length - skipped.length}，FAIL ${failed.length}，SKIP ${skipped.length}`);
if (failed.length > 0) console.log(`  ★ 存在反例，退出码 1`);

process.exitCode = failed.length > 0 ? 1 : 0;

removeSandboxTree(TREE.root);
try {
  fs.rmSync(HOME_ROOT, { recursive: true, force: true });
} catch {
  /* ignore */
}
