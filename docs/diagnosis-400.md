# 400「内容太长了」的现场诊断

会话：`<sessions>/--D-AuditAgent--/session-837404b3…/session.v4.jsonl.zstd`（标题「制作Agent项目亮点讲解PPT」）
结论：**不是上游的错，是本插件的压缩路径失败了两次，导致上下文涨到窗口的 2.4 倍。**

## 现场数据（全部来自会话文件本身）

| 事实 | 值 |
|---|---|
| 声明窗口（`request/context`） | 428,917 |
| 会话内**真实被接受**的最大输入 | **401,588** token（seq 917） |
| 失败时 harness 记账的 prompt 规模 | `totalTokens ≈ 1,002,590`（含 `cacheReadTokens ≈ 1,000,704`） |
| 失败前 40 秒内的压缩尝试 | 每对都失败，两种错误交替 |
| 最终失败 | `assistant/attempt` seq 1250 → `turn/end` seq 1257，`400 … 内容太长了，请精简输入或开启新对话`（`provider_name: alibaba-dashscope`） |
| 插件实时统计 | `classifications: 3, classificationRetries: 0, summaryCalls: 503, chunkCalls: 14, chunkedRegions: 0` |

## 两种失败模式

1. **`pi-ai detected context overflow for model "DeepSeek-V4.1-Flash"`**
   —— 摘要请求自己就超窗口。分块尺寸按「估算 token」切，而适配器用自己的记账判定是否超窗口，两者不一致 ⇒ 每个分块都比预期大。
   `chunkedRegions: 0` 说明分块路径**从未成功完成过一次合并**（`chunkCalls: 14` 是半途失败的尝试）。

2. **`surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node`**
   —— 摘要成功产出了，但替换 surface 时把 **node 0（系统提示）** 包进了替换范围，被 harness 拒绝。

两者交替 ⇒ 每次压缩都失败 ⇒ surface 无限增长 ⇒ 最终 400。
`classificationRetries: 0` 与之一致：溢出的重试分支要求 `replaceGeneration` 前进，而压缩从未成功，所以永远不前进。

## 立即缓解

把压缩交回官方实现（可逆）：

```yaml
# profile 的 cordis.patch.yml
- id: compaction-basic
  disabled: false        # 撤掉本插件的停用覆盖
- id: compaction-doctor-engine
  disabled: true         # 停用本插件的引擎行
```

该会话本身已不可由压缩救回（summarizer 的输入本身就超窗口），需开新会话。

## 待修（本插件的两个缺陷）

1. 分块的尺寸必须用**适配器同一口径**的记账（`pi-ai` 的估算），且每个分块留足 `maxOutput` 余量；分块失败要退回更小的块，而不是整次放弃。
2. surface 替换必须从**第一个非系统节点**开始，绝不覆盖 node 0。
3. 压缩彻底失败时应有降级路径：不做摘要的破坏性裁剪（官方引擎的 `prune` 行为），保证 surface 一定会前进，从而让溢出重试能够发生。