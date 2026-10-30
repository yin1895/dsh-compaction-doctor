# @local/dsh-compaction-doctor

给 DSH（DeepSeek Harness）用的**上下文压缩诊断与修复**插件。

v0.2 起它有一个**设置页栏目**：在 DSH「设置 → 上下文压缩」里，用几个按钮就能
诊断真实可用窗口、按你用到的模型自动把正确的能力值写回配置，并在装配缝上修好压缩本身。
设置页只有一个开关，其余全程无感。

宿主侧仍然是那个压缩后端（真实尺度保留定价 + 分块摘要 + 非英文溢出报错识别），
但**所有会改配置的动作都变成显式点击**——不再有"启动就偷偷写配置"。

- 目标宿主：DSH desktop `0.2.1-rc.3`（`resources\app\dsh\node_modules\@deepseek-ai\*`）
- 测试：宿主 `48/48`、浏览器半侧 `30/30`，全部离线可跑（`npm run test:all`）

---

## 1. 它解决什么问题

DSH 的自动压缩 / 手动 `/compact` 在这套部署上曾经完全不工作，根因有六条：

| # | 缺陷 | 后果 | 本插件的处理 |
|---|---|---|---|
| D1 | 保留选择的**单位错位**：`totalTokens` 是真实 prompt 成本，而 `nodes[].tokens` 是启发式定价，两者差 `k≈8.6–13.4` 倍 | 保留尾部被高估 `k` 倍 ⇒ 真正可遮蔽的头部被压成 3.4k–7.4k token | 压缩在飞时把节点重新定价到真实尺度（`lib/rescale.js`） |
| D2 | 自动压缩只遮蔽 4k–7.6k priced token | 越压越没用，越压越触发 | 同上 + 分块摘要 |
| D3 | `contextWindow` 配成 512,000 时手动 `/compact` 必然失败 | 摘要输入本身超窗口 | 分块层次摘要（`lib/engine.js: summarize`） |
| D4 | 上游中文 400（`内容太长了，请精简输入或开启新对话`）没有被识别为上下文超限 | 没有溢出恢复，回合直接失败 | `lib/overflow.js` 分类 + `agent/request-error` 恢复一次 |
| D5 | `maxTokens: 384000` 吃掉 37% 的窗口 | 消息预算被压缩 | 设置页把输出上限夹到 65,536 |
| D6 | v0.1 **把单会话观测到的 `maxAcceptedPrompt` 当成模型能力永久写进 profile** | 配置被静默改写，停用也不回滚 | v0.2 起默认不写；v0.4 起写只发生在「开关已开 + 用户真的用到了那个模型 + 配置与上游事实矛盾」时，写前逐字节备份 |

> **⚠️ v0.1 留下的现场**：如果你装过 v0.1，profile 里 `DeepSeek-V4.1-Flash` 的
> `contextWindow` 可能已被改成观测值（本机实测为 `950127`，原值 `512000`），
> `maxTokens` 从 `384000` 改成了 `65536`。原文件备份在
> `<profile>/cordis.patch.yml.bak-compaction-doctor-<epoch>`，把它复制回 `cordis.patch.yml` 再重启即可还原；
> 或者直接把开关打开，等你真的用到这个模型时它会自己改成上游真实能力值（并再备份一次）。

---

## 2. 目录结构

```
D:\dsh-compaction-doctor\
├── package.json              # dsh.bundle.patch + dsh.client.platform=web + exports["./client"]
├── cordis.patch.yml          # 停用 compaction-basic，插入 discovery / probe / engine 三行
├── icon.svg                  # 设置页插件图标（插件管理页展示）
├── locale\{zh,en}.json       # 栏目文案（键集必须一一对应，否则 locale 注册会抛错）
├── lib\
│   ├── index.js              # 裸包名那一行的宿主半侧（**故意的空实现**，见下）
│   ├── probe.js              # 宿主：诊断/修复/状态能力 + /compact-doctor 命令 + 行 Config(volatile)
│   ├── engine.js             # 宿主：CompactionEngine 替代实现
│   ├── status.js             # 宿主：设置页 HTTP 通道（三道闸 + 端点分发 + YAML 行配置改写）
│   ├── rescale.js            # 宿主：meter 缩放（可重入、冻结、保留原始值）
│   ├── overflow.js           # 宿主：溢出分类
│   ├── plan.js               # 宿主：预算/选择算法
│   ├── util.js               # 宿主：工具
│   └── client.js             # 浏览器半侧：设置页栏目（一个开关 + 状态行，无构建工具）
└── test\
    ├── nm\run.mjs            # 宿主：51 条离线测试（真实签名 + 桩模块）
    └── client\run.mjs        # 浏览器半侧：30 条契约 + 渲染冒烟测试
```

### 2.1 ⚠️ 为什么必须有一行 `name` 是**裸包名**

这是 v0.2.1 修的第二个「看起来没生效」问题，也是整个设置页能不能出现的前提：

`dsh-client-modules` 把一个 Loader 行映射到它的包，用的是
`exactPackageSpecifier()`（`dsh-client-modules\lib\index.js:83-89`）——**带子路径的 specifier 直接返回 `undefined`**：

```js
function exactPackageSpecifier(specifier) {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length === 2 && parts.every(Boolean) ? specifier : void 0;   // ← 子路径 = undefined
  }
  return specifier.length > 0 && !specifier.includes("/") && !specifier.includes(":") ? specifier : void 0;
}
```

于是 `@local/dsh-compaction-doctor/probe` 这类行**永远不会**让这个包被注册成浏览器模块：
`/plugins/<包名>/client.js` 返回 404，设置面板里那一栏根本不出现——宿主侧却一切正常，所以特别容易误判成"没装好"。

本机四个带浏览器半侧的插件全都是裸包名，正好互为佐证：

| 插件 | patch 里的行 name | 浏览器半侧 |
|---|---|---|
| dsh-pet | `dsh-pet` | ✅ |
| `@opencode2dsh/dsh-plugin` | `@opencode2dsh/dsh-plugin` | ✅ |
| dsh-workbuddy-connect | `dsh-workbuddy-connect` | ✅ |
| dsh-purge | `dsh-purge`（另有 `dsh-purge/redteam` 等子路径行） | ✅ |
| **本插件（v0.2.0 及以前）** | 只有 `.../probe`、`.../engine` | ❌ **不出现** |
| **本插件（v0.2.1 起）** | 额外一行 `name: '@local/dsh-compaction-doctor'` | ✅ |

因此 `cordis.patch.yml` 里有第三行 `id: compaction-doctor-client` / `name: '@local/dsh-compaction-doctor'`，
它挂的就是 `lib\index.js`——那个文件**故意不导出 `default`**，只导出 `apply()` 空实现，
免得这个裸包名行把 `compactionDoctor` 服务二次实例化。测试 `bundle: the patch keeps a bare-name row …`
就是钉这条规则的。

---

## 3. 安装（由你执行）

**前提**：先备份 `cordis.patch.yml`。

### 路径 A：GUI 插件页

侧栏 **插件** → 安装 bundle → `target` 填插件目录的绝对路径
（`D:\dsh-compaction-doctor`，或你 clone 下来的位置）。

### 路径 B：手工

1. 在 profile 的 `package.json`（`<home>\profiles\desktop\package.json`）里加依赖：
   ```json
   "dependencies": { "@local/dsh-compaction-doctor": "link:D:\\dsh-compaction-doctor" }
   ```
2. 把 `"@local/dsh-compaction-doctor"` 追加进 `dsh.profile.bundles`。
3. 在 profile 目录跑 `pnpm install`。
4. 重启 DSH。

**为什么重启**：bundle 在启动期装载，运行中的进程无法卸载它。
**但 profile 的 `cordis.patch.yml` 是热重载的**——这也是为什么 v0.2 把"写配置"改成了显式按钮：
一次写入会在你正在用的会话里生效，而不是等你重启。

### 首次验证

**先确认浏览器半侧真的被服务了**（这一步能区分"没装好"和"版本太旧"——v0.2.0 缺裸包名行时，这里会 404）：

```powershell
# 端口看 DSH 正在用的那个
curl.exe -s -o NUL -w "%{http_code}`n" "http://127.0.0.1:52616/plugins/@local/dsh-compaction-doctor/client.js?rev=0"
```

- `404` ⇒ 客户端半侧没进组合图：确认安装的是 **v0.2.1 或更新**（`node_modules\@local\dsh-compaction-doctor\package.json` 的 `version`），且 `cordis.patch.yml` 里有 `id: compaction-doctor-client` 那一行，然后重启。
- `200`（或无论如何不是 404）⇒ 再往下看：

1. 设置页左侧应出现新栏目「**上下文压缩**」（排在官方五项之后，图标是齿轮——`settings.section` 契约没有图标位，`navIcon` 对未知 id 兜底成齿轮）。
2. 打开它，把那个**开关**打到开。状态行会从「未开启…」变成「已开启。开始对话后会按你用的模型自动检查。」。
3. 回聊天窗随便发一条消息（让某个模型真的被用到），再回到设置页——状态行会变成「已自动修正 … 的长度设置（改前已备份）」或「… 的设置是正确的」。
4. 打开任意会话，命令面板里应有 `/compact-doctor`（手动诊断的逃生口，平时用不到）。
5. DSH 日志里应出现 `[compaction-doctor] loaded (...)`、`settings page transport registered at /dsh-compaction-doctor`，以及需要修正时的 `automatic repair for <provider>/<model>: ... (backup ...)`。

---

## 4. 设置页栏目：只有一个开关

页面刻意做到极小，全部内容就是这三行：

```
上下文压缩

打开后，DSH 会按你用到的模型自动校正上下文长度设置，不需要你操作。

[ ●———]  已开启。已自动修正 DeepSeek-V4.1-Flash 的长度设置（改前已备份）。
```

- **一句介绍**：说明这个开关会做什么。
- **一个开关**：整个页面唯一的控件，绑 `enabled`。关 = 插件完全不工作（不探测、不写配置、压缩行为与官方一致）；开 = 自动模式。
- **一行状态**：宿主给的 `auto.key` 在浏览器侧本地化，可能的取值就是下表的 8 种；**界面上一个数字、一个字段名、一个术语都没有**。

| `auto.key` | 状态行 |
|---|---|
| `auto.off` | 未开启。DSH 使用它自己的默认设置。 |
| `auto.none` | 已开启。开始对话后会按你用的模型自动检查。 |
| `auto.pending` | 已开启。正在准备检查你当前用的模型… |
| `auto.running` | 已开启。正在检查 {model}… |
| `auto.ok` | 已开启。{model} 的设置是正确的。 |
| `auto.found` | 已开启。发现 {model} 的长度设置需要修正… |
| `auto.fixed` | 已开启。已自动修正 {model} 的长度设置（改前已备份）。 |
| `auto.failed` | 已开启，但自动检查失败了。详情见 DSH 日志。 |

页面只碰两个端点：`GET /state`（读开关与状态）/ `PUT /config`（写开关，body 只有 `{"enabled":true|false}`）。
挂载时只读一次，**没有轮询、没有常驻计时器**；失败不白屏，开关回落到真实值。

### 4.1 自动化到底做了什么（「全程无感」的规则）

这是 v0.4 的核心，规则只有三条：

1. **懒**：不在启动时做任何事。`enabled` 为真时，第一次真的要用某个模型（`agent/pre-step`）才去查它，一个进程内每个 `(provider, model)` 只查一次。
2. **只碰正在用的那一个**：只看当前会话正在使用的模型与它的提供商。其余已配置的提供商与模型**永远不会**被读、被定价、被改写——`discoverViaAdapter()` 只查 `route.provider` / `route.model`，`rewriteModelWindow()` 只改那一个模型行。
3. **自动修正，先备份**：只有当「配置里的长度」与「上游真正接受过的 prompt」矛盾时才写，写前对 `cordis.patch.yml` 做逐字节备份，写完把 `contextWindow`/`maxTokens` 记进 `this.written`（否则紧接着的复查会读到旧值而误报失败），并写一行 DSH 日志。

开关通过 `DOCTOR_OWNED_KEYS` 一并进入引擎的配置分层，
所以它确实能同时管到「探测」和「压缩引擎」——回归测试 `engine: the single switch (probe row) actually reaches the engine` 钉死了这条。

`autoRepair`（默认 `true`，不在页面上）是自动修正的总闸：置 `false` 就只查不写。
`writeConfig` 只管 `/compact-doctor` 这条命令路径，与自动模式无关。

### 4.2 开关存在哪里（以及为什么不是 profile 补丁）

**`<profile>/compaction-doctor.state.json`**，插件自己的文件。不写 profile 补丁，原因有三条：

1. doctor 那行是 **bundle 补丁插进来的**，profile 文件里根本没有这一行；要在 profile 里覆盖它，必须重写一条相同 `id` 的行，而 **`name` 是断言**（名字不匹配整行会被跳过）。
2. 补丁按行**整体替换 `config`**（从不深合并），只写 `{"enabled":true}` 会把 `provider` / `entryId` / 各种上限一起抹掉。
3. 写 profile 补丁要等**热重载**才生效，而热重载是异步的 —— 页面刚写完立刻回读就会读到旧值，表现成「开关自己弹回去」（v0.4.0 就是这个故障）。

改成插件自己的文件之后：`setEnabled()` **先改内存**（`GET /state` 与引擎下一次读取立刻看到新值），再落盘（下次启动恢复）。落盘失败不影响本次会话，只在日志里记一句。
所以现在 `PUT /config {"enabled":…}` 一次请求就闭环，页面不需要等热重载，也不该重试。

> **⚠️ 改完文件必须重启 DSH。** 宿主半侧（`lib/probe.js` / `lib/engine.js` / `lib/status.js`）只在 **DSH 启动时** `import` 一次；
> 「热重载」只对 **profile 补丁**生效，不会重新 `import` 插件代码。所以覆盖完文件后只刷新页面，会出现「新版页面 + 旧版宿主」的错配
> （表现为开关点了没用、或状态行说读不到设置）。v0.4.1 的页面会把这个状态直接说出来：`插件刚更新过，重启 DSH 之后这个开关才能用。`

### 4.3 视觉与生命周期约束

- 页面**不会白屏**：读不到 → 开关禁用 + 状态行说明原因；写失败或超时 → 一次回读后开关恢复可点。
- 开关**只允许在写请求在途时**短暂禁用，绝不允许出现永久点不动的开关。
- 不硬编码背景/文字色（深浅主题都不会糊）；开关用官方语义 token。
- 样式表用 `style[data-plugin-css]` 去重 + `data-plugin="<包名>"` 标记，插件卸载时被模块系统回收。
- 本地化：状态行文案全在 `locale/{zh,en}.json`，宿主只给 `key + params`，所以英文界面下不会冒出中文句子。

---

## 5. 配置参考

### 5.1 两行的分工

| 行 id | 模块 | 配置属于谁 |
|---|---|---|
| `compaction-doctor-client` | `.../index.js` | 空实现。**只为了让浏览器半侧被发现**（见 §2.1），没有任何配置 |
| `compaction-doctor` | `.../probe` | **开关 + 诊断类**字段。`enabled`（页面那个开关）/ `autoRepair` / `thresholdRatio` / `retainRatio` 都在 `Config` 里标了 `.volatile()`；除开关外都只能靠改 profile patch 调 |
| `compaction-doctor-engine` | `.../engine` | **压缩策略**字段（`auto` / `thresholdRatio` / `headroomTokens` / `retainRatio` / `maxTokens` / `compactionRetries` / `maxOverflowRetries`）。它们被随包基类 `deepFreeze` 进 `this.config`，所以改它只能重写该行 `config` 并靠热重载生效 |

**阈值比 / 保留比的优先级**（这是唯一一个两行都有的键，必须说清）：

1. probe 行的值与引擎行的值**相同**（全新安装就是这样）⇒ 随包路径原样运行，行为零变化。
2. 两者**不同** ⇒ 引擎切到自己的选择路径，用 probe 行的数字重新定价与选头（因为 `this.config` 冻结了，改不动它）。
3. 引擎行仍然负责 `auto` / `headroomTokens` / `maxTokens` / `compactionRetries` / `maxOverflowRetries`——
   这些没有页面入口，改动只能直接编辑 profile patch。

诊断类字段的优先级：`DOCTOR_DEFAULTS` < 引擎行 `config` < probe 行 `config`（probe 行话事）。

### 5.2 probe 行字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | **`false`** | **设置页那个唯一的开关**。关 = 完全惰性（不探测、不写、`compactIfNeeded` 直接返回 `null`）；开 = 自动模式 |
| `autoRepair` | `true` | 自动模式的总闸。置 `false` 则只查不写（不开页面的排查档位） |
| `probeOnStart` | 忽略 | v0.4 起不再有启动期扫描（写了也无效），保留只为兼容旧 profile patch |
| `writeConfig` | **`false`** | 只管 `/compact-doctor` 命令路径；自动模式由 `enabled` + `autoRepair` 决定，与它无关 |
| `overflowRecovery` | `true` | 关掉后不再把中文 400 当上下文超限 |
| `scaleMode` | `meter` | `meter`（默认，走随包路径但把节点重定价）/ `select`（本地选头 + 配对裁剪）/ `off`（完全停用修复，用于 A/B） |
| `capMaxTokens` | `65536` | 输出上限的夹取上限 |
| `maxSummaryChunks` | `8` | 分块摘要最大块数（硬上限 24） |
| `tokensPerByte` | `0.34` | 字节→token 估算系数 |
| `summaryBudgetRatio` | `0.9` | 摘要输入预算占窗口比例 |
| `selectCapRatio` | `0.85` | `select` 模式遮蔽范围上限比例 |
| `provider` / `model` | — | 兜底路由（有 `request/context` 时以实时路由为准） |
| `providerEntryId` | `llm-pi-ai` | 承载该 provider 的 profile 行 id |
| `engineEntryId` | `compaction-doctor-engine` | 引擎行 id |
| `activeProbe` / `activeProbeConfirm` | `false` | 真实边界探测（**消耗额度**），两个都得开 |

### 5.3 引擎行字段

`auto: true` · `thresholdRatio: 0.75`（随包默认 0.8，这里刻意压低）· `headroomTokens: 65536` ·
`retainRatio: 0.05` · `maxTokens: 65536` · `compactionRetries: 2` · `maxOverflowRetries: 2`

---

## 6. 设置页与宿主的接口

页面不是靠"猜"读宿主的，中间有一条**冻结的契约**（实现见 `lib/status.js`）：

| 端点 | 作用 | 谁在用 |
|---|---|---|
| `GET /state` | 快照：开关值 + 状态行所需的 `auto.key` + 诊断明细 | **设置页每次挂载读一次** |
| `PUT /config` | 写开关（body 只有 `{"enabled":true\|false}`） | **设置页的开关** |
| `POST /diagnose` | 手动诊断（只读） | `/compact-doctor` 命令、排查用 |
| `POST /apply` | 手动写回（`confirm:true`，先备份再写） | 手动路径，自动模式不走它 |
| `GET /backups` · `POST /restore` | 备份列表与还原（`confirm:true`） | 手动路径 |

**鉴权**：`webServer` 本身零鉴权，`/api` 的信任栅栏也不覆盖自定义前缀路由，所以每个请求都要过三道闸：
① 必带自定义头 `x-compaction-doctor: 1`（跨站简单请求伪造不出来，会触发预检）；
② 若有 `Sec-Fetch-Site` 必须是 `same-origin`；③ 若有 `Origin` 必须与 `Host` 同源。
写操作另要求 `Content-Type: application/json`。

---

## 7. v0.2 修掉的崩溃（重要）

v0.1 装进 profile 后，**任意会话的下一个回合都会直接失败**：

```
Cannot read properties of undefined (reading 'kind')
```

根因不是压缩算法，是**事件契约违规**：

- `agent/pre-step` 是 **waterfall**。`cordis/lib/index.js:317-325` 返回的是**最外层监听器的返回值**，
  官方文档原话：*"a listener that does not call `next()` vetoes the rest of the chain, including the built-in behavior"*。
- v0.1 在 `lib/probe.js` 里注册了一个零形参、恒返回 `undefined` 的 `agent/pre-step` 监听器
  （用来兜底注册命令），于是整条链被截断，`agent/pre-step` 返回 `undefined`。
- 消费者随后读 `decision.kind`（`dsh-agent/lib/index.js:195`，备选抛出点
  `dsh-agent-loop/lib/index.js:930`），回合当场崩。

v0.2 改成 `(payload, next) => { …; return next(); }`，并补了回归测试
（`test/nm/run.mjs`：`probe: the pre-step listener forwards the waterfall instead of vetoing it`）。

同一轮还修掉：

| 位置 | 缺陷 | 修法 |
|---|---|---|
| `engine.js` `session/event` 监听器 | 只收一个形参，而宿主是 `(session, event)` ⇒ 监听器静默失效，溢出重试预算永不清零（进程内永久失效） | 改双参 + `_overflowAgents` 反查 agent |
| `engine.js` 分类器 `catch` | 二次调用 `next()`（`next` 不幂等，每次消耗一格链）⇒ 吞掉下游异常、跳过监听器 | 改为 `throw error` |
| `engine.js` `stop()` | 这个 fork **没有** `Service.prototype.stop()`，猴补丁永不还原，热重载后仍生效 | 改用 `ctx.effect` 生成器注册 install/uninstall |
| `probe.js` 命令注册 | `ctx.effect` 失败后兜底直接注册 ⇒ 同名命令可能注册两次 | 失败即返回 `false`，不再兜底 |
| `rescale.js` | `beginScale/endScale` 用 WeakSet 不可重入；返回对象不再 `deepFreeze` | 改计数式 + 冻结 + 保留 `doctorOriginal` |
| `cordis.patch.yml` | `writeConfig: true` + `probeOnStart: true` ⇒ 启动即改写 profile | `writeConfig: false` |
| `probe.js` | 探测优先级曾把观测值当能力值 | 只写"配置声明的能力值"（适配器/网关目录），观测值仅用于判定矛盾 |

---

## 8. 测试

```powershell
cd D:\dsh-compaction-doctor
node test\nm\run.mjs          # 宿主：48 条，全绿
node test\client\run.mjs      # 浏览器半侧：30 条，全绿
# 或
npm run test:all
```

宿主测试覆盖：预算算法、选择与配对裁剪、分块摘要、meter 缩放、溢出分类、`/compact-doctor`
报告、writeConfig 开关、configEditor 优先路径、**事件契约回归**（pre-step 必须转发 waterfall、
`session/event` 必须是双参、行 Config 必须有 volatile 字段）、以及设置页传输层
（端点表、三道闸、YAML 行配置改写的替换/插入/新建三种情形）。

浏览器测试覆盖：经典脚本可解析、无顶层 ESM、只有一次 `__ModuleLoader__.load`、`id` 等于包名、
`require` 只用平台种子、`settings.section` 的 id/order/label、六个端点全部被引用且无越界路径、
样式回收标记、locale 键集一一对应，外加**渲染冒烟测试**（降级上下文下渲染 43 个节点不抛错）。

---

## 9. 回滚

1. 从 `dsh.profile.bundles` 移除 `@local/dsh-compaction-doctor`，删掉 profile `package.json` 里的依赖，`pnpm install`。
2. 删掉 profile `cordis.patch.yml` 里本插件的**三行** `insert` 与 `compaction-basic` 的 `disabled: true` 覆盖行（**必须一起删**，否则两个 `ctx.compaction` 注册者谁赢不确定）。
3. 或用备份整体还原：`cordis.patch.yml.bak-compaction-doctor-*`（把最新那份复制回 `cordis.patch.yml` 再重启；自动修正每次都会生成一份）。
4. 重启 DSH。

---

## 10. 已知限制

- **栏目图标是齿轮**：`settings.section` 的注册选项只有 `id`/`order`/`label`，导航图标由外壳按 id 白名单决定，未知 id 兜底成齿轮。要换图标得走 DOM 补丁（参考 `dsh-pet`），本插件故意不做。
- **引擎行参数需要一次热重载**：`thresholdRatio` 这些被基类 `deepFreeze` 在挂载时，改它们在页面上点一次即可，但生效靠 profile patch 重载（不是纯内存热更）。
- **不写 `modelPolicies`**：按模型分路由的策略没做界面，需要时手写引擎行 `config.modelPolicies`。
- **`scaleMode: "select"` 是备用路径**：任何一步拿不准都会回落到随包路径，宁可什么都不做也不猜。
- **真实边界探测消耗额度**：`activeProbe` 默认关闭，两个开关都开才会发真实请求。
- **观测值不是能力值**：`readObservedBracket` 只用来判定"配置是否与流量矛盾"，绝不写回。
- 本机运行时被 `dsh-purge` 改写过（`dsh-settings` / `dsh-app-boot` / `dsh-base`），本插件只依赖上游稳定接口，不依赖被改写的那部分。

---

## 11. 兼容

`dsh.compatibility.dshReleases: { "0.2.1-rc.3": "compatible" }` —— 注意这个字段**运行时并不读**，
真正的门控是 `engines.dsh` 与 `@deepseek-ai/dsh-*` 的 peer 约束。
本插件对随 dsh 发布的包只声明 `peerDependenciesMeta.optional`，靠安装目录的模块解析共享同一份实例
（所以 `super()`、`instanceof`、`Service` 品牌都成立），不在 profile 里重复安装它们。