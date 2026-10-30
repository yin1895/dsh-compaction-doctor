# dsh-compaction-doctor

DSH（DeepSeek Harness）**压缩修复 bundle**。它把 shipped 的 `compaction-basic` 换成两条 doctored host 行：一条**探测**上游真实的上下文窗口并写回 profile patch，一条**引擎**修正空闲压缩的尺度错误、中文 400 溢出恢复与手动 `/compact` 的可容纳性。

面向版本：`0.2.1-rc.3`（commit `be72761`，channel `nightly`）。安装级 `@deepseek-ai/*` 拦截使本插件的 `peerDependencies` 直接解析到 harness 自带副本，因此无需本地安装 shipped 包。

---

## 1. 它修的是什么

诊断结论（详见 `D:\cyber_workspace\compact_probe\compact-verdict.md`）：自动压缩从不触发、turn 死于 `400 内容太长了，请精简输入或开启新对话`、手动 `/compact` 报 "could not produce a useful summary"，根因在 harness 侧的**尺度**与**分类**两处，网关（loomy2api）已排除。

| 编号 | 缺陷 | 现象 | 本插件的处置 |
|---|---|---|---|
| D1 | priced-node 尺度对图像不敏感，与真尺度差 `k ≈ 8.6–13.4` 倍 | 阈值判定、retain 选择都在错误的尺子上做 | `engine` 在压缩期间把 meter 结果重标定到真尺度（`scaleMode: meter`），或在 `select` 模式下自己选 head |
| D2 | 自动压缩只影子 4k–7.6k priced token | 影子量远小于阈值超出量，压完仍超阈值 | retain 改按**真尺度**（`messageBudget × retainRatio`）计算，并用 `summaryBudget × selectCapRatio` 封顶 |
| D3 | `contextWindow: 512000` 下手动 `/compact` 崩 | `summary is not smaller than the shadowed content` | 头部影子区按可容纳预算裁剪；摘要过长时自动分片合并 |
| D4 | 中文 DashScope 400（`INVALID_REQUEST` + `内容太长了`）未被归类为溢出 | 没有溢出恢复，turn 直接失败 | `engine` 注册 `agent/request-error` 分类器，命中后压缩 + `{kind:"retry"}` |
| D5 | `image/offload` 从不触发 | 附件字节全部进入 prompt | 由 `probe` 报告 `maxRequestImageBytes` 级别的配置缺口（不自行改写该行） |
| D6 | `maxTokens: 384000` 吃掉 37% 窗口 | 可用 prompt 预算被压缩 | `probe` 按证据回写 `contextWindow` / `maxTokens`（默认 `maxTokens ≤ 65536`） |

---

## 2. 结构

```
dsh-compaction-doctor/
├─ package.json          # dsh.bundle.patch 指向 cordis.patch.yml
├─ cordis.patch.yml      # 两条 insert 行 + 覆盖 compaction-basic 为 disabled
├─ lib/
│  ├─ index.js           # 汇总导出（默认导出 + 命名导出）
│  ├─ probe.js           # 探测服务 + /compact-doctor 命令 + profile 写回
│  ├─ engine.js          # CompactionDoctorEngine extends BasicCompactionEngine
│  ├─ plan.js            # 窗口数学：阈值 / retain / 区间选择 / 分片
│  ├─ rescale.js         # tokenMeter.measure 的尺度补丁（可安装/可卸载）
│  ├─ overflow.js        # 溢出分类（branded code + 中英文文本模式）
│  └─ util.js            # 事件读取、路由推导、字节/token 估算
└─ test/nm/run.mjs       # 自带 node_modules 存根的端到端 harness
```

两条 host 行（`cordis.patch.yml`）：

| 行 id | 模块 | 作用 |
|---|---|---|
| `compaction-doctor` | `@local/dsh-compaction-doctor/probe` | 三层探测上游窗口 → 写回 profile patch；`/compact-doctor` 诊断；被动台账 |
| `compaction-doctor-engine` | `@local/dsh-compaction-doctor/engine` | 修正尺度、自选 head、摘要分片、中文 400 溢出恢复 |

并把 shipped 行 `compaction-basic` 覆盖为 `disabled: true`：两个 `ctx.compaction` 注册者同时存在时 last-wins 不确定。`command-compact`（`/compact`）不需要动，它跟随本叶实际挂载的 compaction 服务。

---

## 3. 安装

**前置**：备份 `C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`。

三条路径任选：

1. **GUI**：侧栏 **插件** 页 → 安装 bundle，`target` 填 `D:\dsh-compaction-doctor`（绝对路径，读取其 `package.json`）。
2. **服务直调**：`plugin_manager` 服务 `action: install_bundle`。（本 profile 的 `tool-plugin-manager` 行是 `disabled: true`，模型侧工具不可用，需 GUI 或服务直调。）
3. **手动**：
   ```jsonc
   // C:\Users\Administrator\.dsh\profiles\desktop\package.json
   "dependencies": { "@local/dsh-compaction-doctor": "link:D:\\dsh-compaction-doctor" },
   "dsh": { "profile": { "bundles": [ /* …既有项…, "@local/dsh-compaction-doctor" ] } }
   ```
   `bundles` 追加到**末尾**（patch 优先级最高），然后在该目录执行 `pnpm install`（`nodeLinker: hoisted`），重启 DSH。

**验证**：
- 日志出现 `[compaction-doctor] loaded (enabled=true, writeConfig=…, scaleMode=…, providerEntryId=…)`；
- 新会话执行 `/compact-doctor`，应打印 `verdict contextWindow=<探测值>`；
- 插件页确认只有一条 enabled 的 compaction 提供者。

> bundle 在启动期加载；**进程运行中无法卸载**，装/卸都要重启（本版本该路径无 HMR）。

---

## 4. 配置参考

字段分布在**两行**上，优先级：`DOCTOR_DEFAULTS` < **engine 行自己的 config** < **probe 行 config**（probe 行设置了的键胜出）。

`probe` 行：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后仍挂载但不探测、不注册命令 |
| `provider` / `model` | — | 目标路由；留空则取会话最后一条 `request/context` / `model/selection` |
| `providerEntryId` | — | 走 `llm.listModels` 适配器时的 provider 入口 id（如 `llm-pi-ai`） |
| `probeOnStart` | `true` | 启动后 1.5s 跑一次探测（`unref`，不阻塞） |
| `writeConfig` | `true` | 允许写回 profile patch；`false` 时只在报告里给出手工改动片段 |
| `capMaxTokens` | `65536` | 回写 `maxTokens` 的上限（D6） |
| `activeProbe` / `activeProbeConfirm` | `false` / `false` | 主动边界探测（会消耗真实额度，需双重确认） |
| `tokensPerByte` | `0.34` | 字节→token 估算；chunk 带回 `usage` 时自动校准 |
| `scaleMode` | `meter` | `meter` = 压缩期间重标定 meter；`select` = 自己选 head 区间 |
| `maxSummaryChunks` | `8` | 摘要分片上限（硬上限 24） |
| `summaryBudgetRatio` | `0.9` | 摘要输入预算 = `W × ratio − reserve` |
| `selectRetainRatio` / `selectCapRatio` | `0.05` / `0.85` | `select` 模式的保留尾与影子区封顶 |
| `writeWhenBusy` | `false` | 有活跃压缩/turn 时是否仍写配置 |

`engine` 行：`auto`、`thresholdRatio`（默认覆盖为 `0.75`）、`headroomTokens`、`retainRatio`（`0.05`）、`retainTokens`、`maxTokens`、`fallbackContextWindow`、`compactionRetries`、`maxOverflowRetries`、`overflowRecovery`，以及上面标为 doctor-owned 的键（`scaleMode` / `maxSummaryChunks` / `tokensPerByte` / `summaryBudgetRatio` / `selectCapRatio` / `provider` / `model` / `fallbackContextWindow` / `maxTokens`）——**engine 行可以单独承担这些设置**，无需依赖 probe 行。

> 陷阱：`scaleMode` 等键若只写在 engine 行，早期版本会被忽略（引擎只读 probe 行的 config）。现已按上表分层合并，两条行任一都能生效；probe 行设置过的键始终胜出。

---

## 5. `/compact-doctor` 报告解读

真实输出（截断）：

```
compaction-doctor
  route        huaiyuan/DeepSeek-V4.1-Flash (request/context)
  configured   contextWindow=512,000 maxTokens=384,000
  observed     maxAcceptedPrompt=1,036,863 windowsSeen=[1048576,512000]
  attempts     5 (failed 5)
  adapter      llm.listModels -> 1,048,576
  candidates   configured=512,000, observed usage=1,036,863, adapter catalog=1,048,576
  verdict      contextWindow=1,048,576 maxTokens=65,536 (adapter catalog: 1048576 tokens)
  contradiction the configured window cannot fit traffic the provider already accepted
  write        ok via file
  backup       cordis.patch.yml.bak-compaction-doctor-1761750105123
  budgets      threshold=786,432 retain=49,152 messageBudget=983,040 summaryBudget=878,182
  engine       scaleMode=meter meterPatched=true summarize=0 chunked=0 classified=0 retries=0
```

- `configured` 来自 profile patch / 会话 `request/context`；`observed` 来自会话事件里**已被上游接受**的 `inputTokens + cacheReadTokens`。
- `contradiction` = 已接受的 prompt 竟超过配置窗口 ⇒ 配置窗口写错；`reserve` = 窗口对但 completion 预留没被上游执行（软证据）。
- `candidates` 是全部证据源（profile / 主动探测 / 观测流量 / 适配器目录 / 网关目录），`verdict` 取最大值。
- `write` 失败时给出 `manual` 片段与 `tried` 过的路径（`configEditor` 优先，其次直接改 profile 文件，原子写 + 备份 + 回读校验）。

---

## 6. 验收（A1–A6）

| 编号 | 判据 | 检查方式 |
|---|---|---|
| A1 | 真尺度 prompt ≥ 阈值时 `agent/pre-step` 必触发压缩；`compaction/start` 与 `compaction/end(error=null)` 成对 | 扫 `session.jsonl` |
| A2 | 手动 `/compact` 返回 `command/done{kind:"ok"}`，`shadowedTokenCount ≥ 50000` | 会话事件 |
| A3 | 不再出现 `INVALID_REQUEST` + `内容太长了` | 扫 `assistant/attempt.failure` |
| A4 | 每次压缩打印 `k` / `realPrompt` / `threshold` / `retain`；`k` 稳定在 8–10 | `compaction/start` 扩展字段 + 日志 |
| A5 | `cordis.patch.yml` 中 `DeepSeek-V4.1-Flash.contextWindow` = 探测值 `1048576`，`maxTokens ≤ 65536` | 读配置 |
| A6 | 重载/重启后配置不回退；不再出现「31 次尝试、14 次守卫失败」 | 24h 观察 |

---

## 7. 测试

```powershell
& "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" D:\dsh-compaction-doctor\test\nm\run.mjs
```

`test/nm/run.mjs` 自带 `node_modules/@deepseek-ai/*` 存根（`cordis` / `dsh-llm` / `dsh-compaction` / `dsh-compaction-basic` / `dsh-commands`），运行前自动把 `lib/*.js` 复制到 `test/nm/lib/` 再动态导入，因此不会触碰真实 profile（写回测试把 `DSH_HOME` 指向临时目录）。

当前：**42/42 passed**。覆盖窗口数学、尺度补丁的安装/卸载、溢出分类（含 cause 链）、profile 重写与原子写、探测报告渲染、`select`/`meter` 两条选择路径、工具对平衡裁剪、以及两条 host 行的配置分层。

---

## 8. 回滚

1. 删掉 `cordis.patch.yml` 里本插件的两条 `insert` 行与 `compaction-basic` 的 `disabled` 覆盖行（或 GUI 插件页卸载），从 profile `package.json` 的 `bundles` 移除本 bundle。
2. `pnpm install` 还原 `pnpm-lock.yaml`，重启 DSH。
3. 若只想退配置：从 `cordis.patch.yml.bak-compaction-doctor-<ts>` 恢复 `contextWindow` / `maxTokens`。

---

## 9. 已知限制

- 阈值数学**不读** profile 里的 `modelPolicies`，只按路由模型 + 全局策略计算；如需 per-model 阈值，请显式写 `thresholdRatio` / `retainRatio` / `retainTokens`。
- `select` 模式在无法取得工具对平衡切割点时会回退到 shipped 路径（日志 `local head selection failed, falling back to the shipped path`）；这是有意的保守行为，`meter` 模式（默认）没有这个分支。
- 启动期加载的 bundle 无法在进程内移除；`pnpm` 在某些锁定状态下会报 `ERR_PNPM_TARBALL_URL_MISMATCH`，重装即可。
- 主动边界探测（`activeProbe`）会消耗真实额度，默认关闭，且需 `activeProbeConfirm: true` 双重确认。
- 适配器/网关目录仅是**参考值**；`cordis.patch.yml` 才是唯一权威。
