# `overflow-401k.jsonl` —— 那次失败的会话，可重放地留在这里

这是 **`2026-11-01` 那次长会话被 400 打死** 的现场证据切片：一个真实会话的前缀 + 崩溃尾巴，
脱敏后逐字保留结构、数字和两处错误文本。它存在的理由是：让「历史上那次失败」不再是一段叙述，
而是一份可以被测试直接喂给引擎、并且能被断言的输入。

配套的断言在 `test/replay/run.mjs`（`fixture:*` 与 `replay:*`）。改动本文件前先读 `test/replay/README.md`。

---

## 1. 它是怎么来的

```powershell
# 源：一个只追加的会话日志。注意它是 **多帧 zstd**（一次 append 一帧），
# 同步/流式解码器只能看到第 1 帧。
node test/fixtures/build.mjs "…\sessions\--D-…--\session-837404b3-…\session.v4.jsonl.zstd"
```

`build.mjs` 是确定性的，只读源文件：解码全部分帧 → 取两个结构锚点 + 崩溃尾巴 → 逐字节等长脱敏 → 写出本文件。

| 量 | 值 |
|---|---|
| 源日志 | 631 个 zstd 帧 → 1260 条 JSONL 记录 |
| 本文件 | **66 条**（2 个锚点 + 尾巴 `1194..1257` 共 64 条），134,156 字节 |
| 脱敏 | 1694 条纯填充串 + 474 条原样保留串 |

**逐字节等长**很重要：`test/replay` 会把本文件喂给引擎做 token 估算，负载一旦缩水，
被验证的正是那些数字本身就会变。填充规则按 UTF-8 字节数一一对应：
ASCII→`x`、2 字节→`¡`、3 字节→`测`、4 字节→`𐍈`。构建时会校验每条串的字节数不变，不一致直接报错。

## 2. 保留了哪些不变量（`fixture:*` 会逐条断言）

| 证据 | 位置 | 值 |
|---|---|---|
| 声明窗口 / 路由 | seq 16 `request/context` | `huaiyuan` / `DeepSeek-V4.1-Flash` / **428917** |
| 被接受的输入峰值 | seq 917 `assistant/message` | `inputTokens` **401588** |
| 失败量级 | seq 1194 | `totalTokens` **1002590**（`cacheReadTokens` **1000704**） |
| 交替的两种失败 | 6 对 `compaction/end` | 见下 |
| 回合终结 | seq 1257 `turn/end` | `400 … 内容太长了，请精简输入或开启新对话 … alibaba-dashscope`（`INVALID_REQUEST`） |

失败尾巴的类型序列（64 条，逐条断言）：

```
assistant/message tool/call tool/result step/end
compaction/start compaction/summary compaction/end      ← node 0 错误（摘要成功、替换被拒）
compaction/start compaction/end                          ← pi-ai 溢出（摘要请求本身被拒）
step/start … （重复 6 轮）
step/start assistant/attempt → … → step/end turn/end
```

两处错误文本**逐字保留**，`test/replay` 里桩实现抛出的就是它们本身（不是重新打一遍的字面量）：

```
surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node
pi-ai detected context overflow for model "DeepSeek-V4.1-Flash"
```

6 对里 **没有一次成功的 `compaction/end`** —— 这正是「压缩看起来根本没跑」的机器可读形式。

## 3. 丢掉了什么

- 所有自由文本负载（提示词、模型输出、工具参数/结果、摘要正文、路径、附件名）→ 等长填充；
- 机器标识：无 `C:\`、`D:\`、`/Users/`、`Administrator`、`auditagent`、`.dsh`、附件哈希。
  `fixture:sanitised` 会在每次运行时扫一遍，出现即失败；
- 非上述两处错误串之外的中文一律不存在（`fixture:no-payload-text`）。

原样保留的只有：结构键、标识符（`callId`/`toolCallId`/`jobId`/`compactionId`/`owner`…）、
全部数字与布尔、`surfaceOp`/`sourceEventSeqs`、以及 **`error`/`reason`/`failure` 子树**。

## 4. 边界（别把它当成比实际更强的证据）

- 它是**一次**失败的切片，不是全部会话；`seq 917` 与 `seq 1194..1257` 之间的 277 条被有意省略。
- 尾巴里 `seq 1194..1257` 是**连续**的，锚点 `16`/`917` 不是连续的：读取时按 `seq` 处理，别按行号。
- 脱敏后的负载是填充字符，**不含任何语义**；在这里只能断言结构与数字，不能断言文本内容。
- 重放时 `request/context`（seq 16）被当作 surface 的一个节点放在 index 1，只为让路由可解。
  真实 surface 只包含 `system|developer|user|assistant|tool-result` 事件（见 `docs/surface-contract.md` §1.2）——
  这不影响被验证的性质：契约保护的是 **surface node 0**，而重放里 node 0 是 `system/message`。
