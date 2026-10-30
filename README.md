# @local/dsh-compaction-doctor

给 DSH（DeepSeek Harness）用的**上下文压缩诊断与修复**插件。

v0.2 起它有一个**设置页栏目**：在 DSH「设置 → 上下文压缩」里，用几个按钮就能
诊断真实可用窗口、把正确的能力值写回配置、调压缩引擎参数、看运行状态、必要时回滚。

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
| D6 | v0.1 **把单会话观测到的 `maxAcceptedPrompt` 当成模型能力永久写进 profile** | 配置被静默改写，停用也不回滚 | v0.2 起 `writeConfig` 默认 `false`，只有点「一键修复」才写，且先备份 |

> **⚠️ v0.1 留下的现场**：如果你装过 v0.1，profile 里 `DeepSeek-V4.1-Flash` 的
> `contextWindow` 可能已被改成观测值（本机实测为 `950127`，原值 `512000`），
> `maxTokens` 从 `384000` 改成了 `65536`。原文件备份在
> `<profile>/cordis.patch.yml.bak-compaction-doctor-<epoch>`，设置页「备份」卡里可以直接还原，
> 也可以让「一键修复」重新写一次。

---

## 2. 目录结构

```
D:\dsh-compaction-doctor\
├── package.json              # dsh.bundle.patch + dsh.client.platform=web + exports["./client"]
├── cordis.patch.yml          # 停用 compaction-basic，插入 probe / engine 两行
├── icon.svg                  # 设置页插件图标（插件管理页展示）
├── locale\{zh,en}.json       # 栏目文案（键集必须一一对应，否则 locale 注册会抛错）
├── lib\
│   ├── index.js              # 聚合导出
│   ├── probe.js              # 宿主：诊断/修复/状态能力 + /compact-doctor 命令 + 行 Config(volatile)
│   ├── engine.js             # 宿主：CompactionEngine 替代实现
│   ├── status.js             # 宿主：设置页 HTTP 通道（三道闸 + 端点分发 + YAML 行配置改写）
│   ├── rescale.js            # 宿主：meter 缩放（可重入、冻结、保留原始值）
│   ├── overflow.js           # 宿主：溢出分类
│   ├── plan.js               # 宿主：预算/选择算法
│   ├── util.js               # 宿主：工具
│   └── client.js             # 浏览器半侧：设置页栏目（五张卡，无构建工具）
└── test\
    ├── nm\run.mjs            # 宿主：48 条离线测试（真实签名 + 桩模块）
    └── client\run.mjs        # 浏览器半侧：30 条契约 + 渲染冒烟测试
```

宿主侧挂两行，客户端半侧**不需要任何行**（`dsh.client.platform: "web"` 就是声明，
模块系统据此把 `lib/client.js` 作为 `/plugins/@local/dsh-compaction-doctor/client.js` 提供出去）。

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

1. 设置页左侧应出现新栏目「**上下文压缩**」（排在官方五项之后，图标是齿轮——`settings.section` 契约没有图标位，`navIcon` 对未知 id 兜底成齿轮）。
2. 点「一键诊断」，应看到真实窗口、输出上限、以及与配置是否矛盾的结论。
3. 打开任意会话，命令面板里应有 `/compact-doctor`。
4. 日志应出现 `[compaction-doctor] loaded (...)` 与 `settings page transport registered at /dsh-compaction-doctor`。

---

## 4. 设置页栏目：五张卡

| 卡 | 做了什么 | 走哪条通道 |
|---|---|---|
| **诊断** | 读持久会话里"上游真正接受过的 prompt"、适配器目录、网关 `/models`，给出真实窗口 + 输出上限 + 是否与配置矛盾 + 建议值 | `POST /diagnose` |
| **修复** | 先给变更预览（`512000 → 1048576`），再点「应用」才写；写入前自动备份，写完提示备份文件名与「已热重载」，并自动重跑一次诊断证明闭环 | `POST /apply`（必须 `confirm:true`） |
| **引擎参数** | 12 个字段：自动压缩 / 启动探测 / 允许写回 / 缩放模式 / 分块数 / 估算系数 / 摘要预算比 / 遮蔽上限比 / 溢出恢复 / 输出夹取 / 阈值比 / 保留比 | 优先官方设置命名空间 `ctx.configForms.get('compaction-doctor')`；不可用时降级 `GET/PUT /config` |
| **状态** | 压力 / 阈值 / 缩放系数 k / 节点数 / 最近一次压缩（触发方式、遮蔽节点数与 token）/ 守卫失败次数；压力超阈值时圆点变黄 | `GET /state`，页面挂载期每 2s 一次，切走即停 |
| **备份** | 列出 profile 下所有 `cordis.patch.yml.bak*`（时间 / 文件名 / 大小），可一键还原（还原前宿主会再备份现场文件） | `GET /backups` · `POST /restore` |

设计约束（都已在实现里落地）：

- 页面**不会白屏**：`configForms` 是软依赖（`ctx.get('configForms')` + undefined 判断），
  任一请求失败只渲染一行本地化红字。
- 栏目是「切走即卸载」的，所以轮询计时器由组件 `useEffect` 拥有，卸载即清。
- 视觉全走 `--dsw-alias-*` 语义 token，根容器 `max-width:720px`，与官方设置页一致。
- 样式表用 `style[data-plugin-css]` 去重 + `data-plugin="<包名>"` 标记，插件卸载时被模块系统回收。

---

## 5. 配置参考

### 5.1 两行的分工

| 行 id | 模块 | 配置属于谁 |
|---|---|---|
| `compaction-doctor` | `.../probe` | **诊断类**字段 + 页面可编辑的 `thresholdRatio` / `retainRatio`，全部在 `Config` 里标了 `.volatile()` ⇒ 这就是那个设置命名空间，页面可直接读写 |
| `compaction-doctor-engine` | `.../engine` | **压缩策略**字段（`auto` / `thresholdRatio` / `headroomTokens` / `retainRatio` / `maxTokens` / `compactionRetries` / `maxOverflowRetries`）。它们被随包基类 `deepFreeze` 进 `this.config`，所以改它只能重写该行 `config` 并靠热重载生效 |

**阈值比 / 保留比的优先级**（这是唯一一个两行都有的键，必须说清）：

1. 页面（probe 行）的值与引擎行的值**相同**（全新安装就是这样）⇒ 随包路径原样运行，行为零变化。
2. 两者**不同** ⇒ 引擎切到自己的选择路径，用页面的数字重新定价与选头（因为 `this.config` 冻结了，改不动它）。
3. 引擎行仍然负责 `auto` / `headroomTokens` / `maxTokens` / `compactionRetries` / `maxOverflowRetries`——
   这些没有页面入口，改动要么用 `PUT /config`，要么直接编辑 profile patch。

诊断类字段的优先级：`DOCTOR_DEFAULTS` < 引擎行 `config` < probe 行 `config`（probe 行话事）。

### 5.2 probe 行字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后引擎的 `compactIfNeeded` 直接返回 `null`（完全惰性） |
| `probeOnStart` | `true` | 启动 1.5s 后跑一次**只读**探测（不写配置） |
| `writeConfig` | **`false`** | 置 `true` 后 `/compact-doctor` 命令也会写回；默认只有设置页的「一键修复」会写 |
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

| 端点 | 作用 |
|---|---|
| `GET /state` | 轮询快照（压力/阈值/缩放/最近压缩/守卫失败） |
| `POST /diagnose` | 一键诊断（只读） |
| `POST /apply` | 一键修复（`confirm:true`，先备份再写） |
| `GET` / `PUT /config` | 引擎参数的降级通道（命名空间不可用时） |
| `GET /backups` · `POST /restore` | 备份列表与还原（`confirm:true`） |

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
2. 删掉 profile `cordis.patch.yml` 里本插件的两行 `insert` 与 `compaction-basic` 的 `disabled: true` 覆盖行（**必须一起删**，否则两个 `ctx.compaction` 注册者谁赢不确定）。
3. 或用备份整体还原：`cordis.patch.yml.bak-compaction-doctor-*`（设置页「备份」卡可一键还原）。
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