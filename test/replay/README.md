# `test/replay` —— 把历史失败重放一遍，并断言它「构造上不可达」

```powershell
node test/replay/run.mjs        # 19 条性质；全绿 exit 0，任何一条不成立 exit 1
```

这套件回答两件事：

1. **那次失败能被重放吗？** —— 用 `test/fixtures/overflow-401k.jsonl`（见 `test/fixtures/README.md`）
   的终结 400 去打真实引擎的溢出分类器，恢复路径必须让 surface 前进。
2. **`pi-ai detected context overflow` 在构造上还可能出现吗？** —— 对引擎会发出的每一次摘要请求，
   断言 `适配器口径估算(chunk) + maxOutput + margin ≤ 窗口`；装不下的区域必须**一次请求都不发**就降级。

## 1. 目录

```
test/replay/
  run.mjs                断言与报告（19 条性质）
  harness.mjs            缝：把 lib/*.js 逐字节拷到 ./lib/，桩服务，量具，夹具读取
  node_modules/@deepseek-ai/   桩：dsh-llm / dsh-compaction / dsh-compaction-basic
  lib/                   运行时拷贝（每次运行重新生成，与仓库 lib/ 的 sha256 一致才继续）
```

`lib/` 是拷贝而不是符号链接，理由和 `test/nm/run.mjs` 一样：仓库根部没有 `node_modules`，
只有把 `lib/*.js` 放到 `node_modules` 的兄弟目录，引擎里的裸导入才会解析到本目录的桩。

## 2. 桩就是「宿主」，每条规则都不是我编的

`@deepseek-ai/dsh-compaction-basic` 的桩扮演失败现场里出现过的两方，**只扮演这两方**：

| 桩的行为 | 依据（读过的源码） |
|---|---|
| 摘要请求按**适配器自己的口径**计价，装不下就抛 `pi-ai detected context overflow for model "…"` | 现场错误原文（夹具逐字保留） |
| 摘要器返回 `{ summary, rawOutput, llmStreamCall, provider, model, maxTokens, usage }`——**没有 `blocks` 键** | `dsh-compaction-basic/lib/index.js:329-337` |
| 替换范围覆盖 node 0 时抛 `surface replace: node 0 holds the system prompt …`；唯一例外是 `system/message` 且只覆盖该一个节点 | `dsh-session/lib/types/surface.js:388-390`；`docs/surface-contract.md` §1.1 |
| 官方选区起点排除 node 0 | `dsh-compaction-basic/lib/index.js:415` |

`tokenMeter` 桩同时给出 `measure(session)` 与 `estimateMessage(message)`，后者用**同一套适配器口径**——
引擎和窗口说同一种货币，这是 F1 的实质，缺了它测的就不是适配器的窗口（早期版本正因此误报过 466 条）。

**桩是有牙齿的**：`replay:host-bites` 每次运行都直接驱动桩，确认它仍会为超窗请求抛出夹具里那句溢出错误、
仍会为覆盖 node 0 的替换抛出那句 node-0 错误。桩哑了，这条会先红。

## 3. 19 条性质

| 组 | 性质 |
|---|---|
| `fixture:*` × 8 | 结构 / 类型序列 / 两种错误交替且无一次成功 / 错误原文 / 窗口·峰值·失败量级 / 终结 400 / 无机器路径 / 除提供方 400 外无可读中文 |
| `replay:*` × 6 | 分类器认出 400；surface 前进；至少一级提交；回合不以原始失败结束（`{kind:"retry"}`）；**恢复期间没有任何请求被适配器或 surface 拒绝**；桩有牙齿 |
| `size:*` × 3 | 每个分块 `适配器估算 + maxOutput + 2048 ≤ 窗口`；装不下的区域 0 请求降级；分块路径读得懂摘要器真实返回形状 |
| `node0:*` × 2 | 没有任何替换范围覆盖 node 0；覆盖 node 0 只按契约允许的方式尝试 |

网格：**B3 396 例**（4 窗口 × 3 `maxOutput` × 6 区域规模 × 3 适配器口径倍率 × 2 `maxSummaryChunks`），
**B4 36 例**（3 窗口 × 2 触发 × 3 节点数 × 2 进入路径）。当前引擎下 B3 实际断言 **1172 次请求 / 3.3 亿适配器 token**。

## 4. 纪律

- **不改 `lib/`，不为通过而放宽断言**。发现不成立就报反例：输入、期望、实测、`lib/engine.js:行号`。
- 行号在运行时从被测源码里现找（`locate()`），**不写死**；报告里同时打印 `lib/engine.js` 的 sha256，
  一串行号只属于那一个 revision。
- 引擎在被别人改的时候也能跑：`syncLib()` 先拷贝再校验 sha256，报告末尾显示 `drift`。

## 5. 负向对照（证明这套件会红）

用 git 里的**修复前**引擎跑同一套件。**要钉住修复前的那个 commit**：`HEAD` 现在已经包含修复，
拿它当对照只会得到 19/19。`137065b` 是修复前最后一个提交（`lib/engine.js` 695 行）：

```powershell
git archive 137065b lib | tar -x --strip-components=1 -C "$env:TEMP\cdoc-prefix-lib"
$env:REPLAY_LIB_DIR = "$env:TEMP\cdoc-prefix-lib"; node test/replay/run.mjs
```

| revision | 结果 | 红的是哪些 |
|---|---|---|
| `137065b`（修复前） | **10/19** | `replay:surface-advances` `replay:one-level-succeeds` `replay:turn-survives` `replay:no-doomed-request` `size:property`(466) `size:degrades`(33) `size:summary-contract`(88) `node0:ranges`(34) `node0:contract-path`(34) |
| 当前工作树（修复后） | **19/19** | — |

修复前那次重放的实测一行，就是历史本身：

```
outcome=undefined generation=0 commits=0 errors=[node0,overflow] baseRequest=407044/361333
```

（两种记录在案的错误都出现、surface 没前进、回合以原始失败结束，且那个摘要请求本身就超窗。）

## 6. 待办

- `test/replay/lib/` 是每次运行重新生成的拷贝，应当像 `test/nm/lib/` 一样进 `.gitignore`
  （`.gitignore` 在本次改动范围之外，留给 lead 一行解决）。
