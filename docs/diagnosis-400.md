# 一次「内容太长了」400 的现场诊断（已定位，已全部修复）

**结论：不是上游的错。** 本插件的压缩路径上一共有六个缺陷。其中两个在失效现场里直接交替出现——
替换范围覆盖了系统提示节点、分块尺寸与适配器的记账口径分叉；另四个让这些失败无法被退让吸收：
摘要返回形状读错、更紧的预算算了没接线、压缩失败后不前进、把观测值当成能力值。叠加起来让上下文
涨到声明窗口的 **2.4 倍**，回合最终以上游的 400 结束。六个缺陷都已定位并修复，每一个都有守护它的测试（§4）。
当时的现场会话文件保留在工作区之外，本文所有数字都从该文件逐条读出。

> 为让对外文档不含具体厂商、模型与会话标题，错误原文里的模型与 provider 身份用占位符写出。

---

## 1. 现场数据

| 事实 | 值 |
|---|---|
| 声明窗口（`request/context`） | 428,917 |
| 会话内**真实被接受**的最大输入 | **401,588** token（seq 917） |
| 失败时 harness 记账的 prompt 规模 | `totalTokens ≈ 1,002,590`（含 `cacheReadTokens ≈ 1,000,704`） |
| 整场压缩结局（81 次 `compaction/start`，逐条统计 `compaction/end`） | **45 次**被拒：替换范围覆盖了 node 0；**19 次**被拒：摘要请求自身超窗；**17 次**成功 |
| 最后一次成功压缩 | seq 937 |
| 最后一次成功之后 | **41 次压缩尝试，0 次成功**（22 次是 node 0、19 次是超窗），持续约 29 分钟、321 条事件，直到回合结束 |
| 最终失败 | `assistant/attempt`（seq 1250）→ `turn/end`（seq 1257）：`400 … 内容太长了，请精简输入或开启新对话` |
| 插件实时统计 | `classifications: 3, classificationRetries: 0, summaryCalls: 503, chunkCalls: 14, chunkedRegions: 0` |

「45 / 19 / 17」的定义是逐条比对 `compaction/end` 的 `error` 字段：命中 node 0 规则的 45 次、
命中适配器超窗的 19 次、没有 `error` 的 17 次（45 + 19 + 17 = 81）。**17 次成功全部在 seq 937 之前**；
之后压缩一次都没有成功过。

---

## 2. 当时交替出现的两种失败

1. **`pi-ai detected context overflow for model "<model>"`**
   摘要请求**自己**就超窗口。分块尺寸按「估算 token」切，而适配器用自己的记账判定是否超窗，
   两者口径不一致 ⇒ 每个分块都比预期大。
   `chunkedRegions: 0` 说明分块路径**从未成功合并过一次**（`chunkCalls: 14` 是半途失败的尝试）。

2. **`surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node`**
   摘要成功产出了，但替换 surface 时把 **node 0（系统提示）** 包进了替换范围，被宿主拒绝。

两者交替 ⇒ 每次压缩都失败 ⇒ surface 无限增长 ⇒ 最终 400。
`classificationRetries: 0` 与之一致：溢出的重试分支要求替换代（`replaceGeneration`）前移，
而压缩从未成功，所以永远不前进 —— 于是「分类器认出了超限」这件事一次都没能转化成恢复。

---

## 3. 为什么「压缩失败」会变成「回合死亡」

每一环单独看都合理：分类是对的、压缩确实失败了、没有前进就不该重试。合起来却是一条死链：

```
压缩失败 ⇒ surface 不前移 ⇒ 溢出恢复的重试分支不满足条件 ⇒ 不重试
        ⇒ 上下文继续膨胀 ⇒ 上游 400 ⇒ 回合结束
```

斩断它的办法只有一个：让**每一次压缩尝试都必须前移**，而不是"失败就退出"。

---

## 4. 六个缺陷 → 修复位置 → 守护它的测试

行号取自当前工作树（`lib/engine.js` 1711 行、`lib/plan.js` 255 行）；测试名比行号更稳，复核时以测试名为准。

| 缺陷 | 修复位置 | 守护它的测试 |
|---|---|---|
| 替换范围覆盖 node 0（整场 45 次，首要杀手） | `lib/engine.js:1177` `_firstCompactableIndex()`；`lib/engine.js:1441` `_trimToBalancedCuts(…, firstIndex)` | `test/replay` 的 `node0:ranges` / `node0:contract-path`（36 例里 34 例真的选中范围，**0 例覆盖 node 0**）；`test/nm` 的 `F3: the replacement never starts at the system-prompt node`、`F3: the hard-trim rung keeps the system head and the newest node` |
| 摘要返回形状读错 ⇒ 自己抛「没有可用文本」 | `lib/engine.js:1547` `collectText`、`lib/engine.js:1584` `withMergedText` | `test/nm` 的 `shape: collectText and withMergedText read the REAL summarize result shape`；`test/replay` 的 `size:summary-contract` |
| 更紧的预算算了却没接线 | `lib/plan.js:76-77`（`summaryRequestBudget`）+ `lib/engine.js:1223` `_numbersFor`、`lib/engine.js:1423` `_summaryPreflight` | `test/nm` 的 `F1: the chunk budget is the adapter-priced request minus maxOutput minus the hard margin`、`F2: a region no larger than this route's own summaries sends nothing and descends to prune` |
| 分块尺寸与适配器口径分叉（整场 19 次超窗） | `lib/engine.js:583` `summarize`、`lib/engine.js:775` `_chunkPlan()` | `test/replay` 的 `size:property`（B3 网格 396 例、1172 次请求全部满足不等式）、`size:degrades`（33 例装不下的输入**一发未发**就降级） |
| 压缩失败不前进 ⇒ 溢出重试永不触发 ⇒ 回合死亡 | `lib/engine.js:851` `_ladder()`（三级）、`lib/engine.js:1007` `_rungHardTrim` | `test/nm` 的 `F4 rung 2`、`F4 rung 3`、`F4 exhaustion`、`F4: whenever a reducer exists, the ladder always commits a replacement`；`test/model` 的 I12a / I12b / I12c |
| 把观测值当能力值 | `lib/engine.js:519` `windowBound()`、`lib/engine.js:530` `_learnRejectedWindow()`、`lib/learn.js` | `test/nm` 的 `F5: the rejected size is written back as a hard upper bound, with a byte-exact backup`、`F5: a classified overflow records the bound and the engine plans against it` |

---

## 5. 为什么这个 400 不会再出现

**三级退让，且每一级都必须让 surface 前移**：

| 级 | 做什么 | 依赖模型？ |
|---|---|---|
| 1 | 分块摘要 + 替换（分块按适配器口径定价，预留输出上限与硬余量） | 是 |
| 2 | 只裁剪、不摘要：丢掉最旧的非系统节点（等价官方 `prune`） | 否，纯宿主操作 |
| 3 | 硬裁剪到远低于窗口的目标 | 否，纯宿主操作 |

- **只有第 1 级需要模型。** 模型不可用、被网关拒、摘要没有价值，都不再意味着这个回合完了：
  第 2/3 级只需要宿主接受一次替换，surface 就会前移。`test/model` 的 I12c 在 64 个边界注入组合里
  实测到 16 个组合**在第 2 级成功提交**、`classificationRetries` 随后 +1 —— 这正是历史现场缺的那一步。
- **「没前进」不可能被记成「已处理」。** 重试计数只在替换代真的前移时才 +1（生成代闸门），
  所以 `classifications: 3, classificationRetries: 0` 这种形状只可能出现在"三级全部失败"的情况，
  不会再悄悄吞掉一次超限。
- **三级全部失败时**：放行上游的**原始失败**（回合错误保持上游原样），同时在统计
  （`rungFailures` / `lastRungFailure`）与日志里**逐级点名**是哪一级、什么原因。
  当前绑定的是这种**弱形式**（Lead 决定）：不覆盖 `failure.code`，因为覆盖会污染上游的分类、
  掩盖真正的成因。把点名错误当作回合终结错误的**强形式当前未采纳**，
  `docs/formal.md` §9.7 把它列为可选目标，并给出两种强度的实测差异。

---

## 6. 当时的缓解方式（可逆）

把压缩交回官方实现：

```yaml
# profile 的 cordis.patch.yml
- id: compaction-basic
  disabled: false        # 撤掉本插件的停用覆盖
- id: compaction-doctor-engine
  disabled: true         # 停用本插件的引擎行
```

当时那个会话本身已无法由压缩救回（摘要器的输入本身就超窗），需要开新会话。

---

## 7. 怎么自己复核

```bash
node test/nm/run.mjs          # 宿主半侧
node test/client/run.mjs      # 浏览器半侧
node test/model/check.mjs     # 形式化穷尽检验器（含 I12）
node test/replay/run.mjs      # 失效现场回放 + 尺寸/node 0 性质
```

`test/replay` 带的是**这次失效现场本身**（脱敏后的 fixture），并附一条负向对照：
把修复前的引擎指给它，只有 **10/19** 条性质成立，红的正是 §4 里这几条
（回放不前进、`size:property` 466 例、`size:degrades` 33 例、`size:summary-contract` 88 例、
`node0:ranges` 34 例）。修复后的引擎 19/19。
