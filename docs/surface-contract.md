# surface 替换规则 + 摘要准入判定 —— 已安装 DSH 的真实契约

> 读者：要改 `@local/dsh-compaction-doctor` 压缩路径的人。
> 本文只陈述**已安装源码**（`…\resources\app\dsh\node_modules\@deepseek-ai\`）里能读到的事实，每条带 `文件:行号`。
> 我的推理标 **【推理】**；没读到位、不敢下结论的标 **未确证**。**不要拿未确证项当实现依据。**
> 版本：DSH `0.2.1-rc.3`。`lib/index.js`（打包后）与 `lib/types/*.js`（未压缩）内容一致，引用优先给未压缩版。
>
> **⚠️ 本机运行时被 dsh-purge 改写过**（`dsh-base/cordis.patch.yml` 有 `# [dsh-purge]` 注释行，如 `:346`）。本文引用的 `dsh-session`/`dsh-compaction-basic`/`dsh-llm*`/`@earendil-works/pi-ai` 均**未见** purge 改动痕迹，但跨机复核时值得注意。

---

## §0 先看这三条

### 0.1 现场归因有一处必须纠正

任务描述里说「把本插件移出 bundles（官方引擎回来）后，官方引擎**同样**报 `compaction produced no summary text`」。**这句话按字面是不可能的**，因为该字符串在整棵 `@deepseek-ai` 里**只出现一次**，且不在官方包里：

| 字符串 | 唯一出处 | 引擎 |
|---|---|---|
| `compaction produced no summary text` | `D:\dsh-compaction-doctor\lib\engine.js:308` | **本插件** |
| `summarization produced no text summary content` | `dsh-compaction-basic/lib/index.js:328` | **官方** |

两个字符串不同（`compaction`/`summarization`、`no summary text`/`no text summary content`）。所以要么
(a) 那次复现时**本插件的引擎行仍然挂着**（改 `dsh.profile.bundles` 后未重启/未生效），要么 (b) 日志字符串被转述时被归一化了。

**这条必须先确证再动手**，因为它决定「官方引擎是否也有同一故障」这个前提：判据是 `ctx.compaction` 实际挂的是哪个类 —— 打印 `ctx.compaction?.constructor?.name`，或核对生效组合里有没有 `compid=compaction-doctor-engine` 这一行。**未确证。**

### 0.2 三个根因，按第一性排序（详见 §7）

1. **契约不匹配（确证）**：`BasicCompactionEngine.summarize()` 的返回值里没有 `blocks` 键（`dsh-compaction-basic/lib/index.js:329-337`），文本块在 **`summary`**（数组）里；而本插件的 `collectText()` 只认 `output.blocks` / `.text` / `summary`-as-string（`lib/engine.js:639-650`）→ **永远返回 `undefined`** → `texts.length === 0` → `:308` 抛错。**即使每个分块都成功。**
   现场统计反证：`chunkCalls: 14`（`lib/engine.js:297` 只在 `super.summarize` **成功**后自增）而 `chunkedRegions: 0`（`:309`）—— 14 次成功调用、0 次合并，只有「读不出文本」能同时成立。
   并且 `:308` 的 `firstError ?? ...` 说明该字符串**只在零个分块抛异常时**出现（`firstError` 仅在 `:303` 的 catch 里赋值）—— 即**上游 400 并不是这条错误的成因**。
2. **node 0 缺陷（确证）**：本插件的选区从 index 0 起步（`lib/plan.js:125,129` 的 `firstIndex` 默认 `0`；`lib/engine.js:426-429` 未传），而 `_trimToBalancedCuts`（`:572-597`）只按 tool-pairing 前推、**不排除 node 0**。官方对照实现明确排除：`dsh-compaction-basic/lib/index.js:415` `const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;`
3. **预算口径不一致（确证）**：`plan.js:62` 的 `summaryBudget = floor(W*0.9) - O` 是**估算**口径，`plan.js:69` 已经算出了更紧的 `summaryRequestBudget`，但 `lib/engine.js:269` 和 `:422` 用的仍是 `summaryBudget` —— 更强的界算了却没用上。

### 0.3 一个只读判别：两个引擎的失败面完全不同

- 官方引擎**不分块**（§3.2），所以它的失败只会是"单次摘要请求无法被接受/无文本"，**未必**和本插件的分块缺陷同一成因。
- 本插件的分块路径**只在 `groups.length > 1` 时进入**（`lib/engine.js:280-282`），单块时直接 `super.summarize` 且形状正确 —— 所以**该缺陷不会在小区域上暴露**，只在"区域大到一个块装不下"时暴露。这正是现场的情形。

---

## §1 `surfaceOp: "replace"` 的取值约束，以及 node 0 的保护契约

### 1.1 权威实现位置

- **未压缩（可读、引用首选）**：`C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh-session\lib\types\surface.js`
- **打包（运行时真正执行的）**：`…\dsh-session\lib\index.js`
- **浏览器侧镜像**：无（该文件是 browser-safe 子路径导出，`:5-6`）

错误串的两处定义完全一致：

```js
// dsh-session/lib/types/surface.js:388-390
    if (event.type !== 'system/message' || shadowedSeqs.length !== 1) {
        throw new Error('surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node');
    }
```
```js
// dsh-session/lib/index.js:424  （打包副本）
	if (event.type !== "system/message" || shadowedSeqs.length !== 1) throw new Error("surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node");
```

### 1.2 哪些事件能进 surface，取值有哪些

```js
// dsh-session/lib/types/surface.js:13-19
const SURFACE_EVENT_TYPES = new Set([
    'system/message',
    'developer/message',
    'user/message',
    'assistant/message',
    'tool/result',
]);
```

只有这 5 种类型能携带 `surfaceOp`，且**必须携带**：

```js
// dsh-session/lib/types/surface.js:200-228  surfaceOpOf()
    const op = raw.surfaceOp;
    if (op === undefined) {
        throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`);
    }
    if (op === 'append') return op;
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
        throw new Error(`session event "${event.type}" carries an invalid surfaceOp`);
    }
    if (!isReplaceOp(op)) {
        throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`);
    }
```

`replace` 的**形状是封闭的**，多一个键就非法：

```js
// dsh-session/lib/types/surface.js:189-199
function isReplaceOp(value) {
    const op = value;
    return Object.keys(op).length === 3
        && Object.hasOwn(op, 'op')
        && Object.hasOwn(op, 'startSeq')
        && Object.hasOwn(op, 'endSeq')
        && op['op'] === 'replace'
        && isEventSeq(op['startSeq'])
        && isEventSeq(op['endSeq']);
}
```
`isEventSeq` 要求非负安全整数且不是 `-0`（`:180-188`）。

非 surface 类型：若不在已知类型表里且 `ignorable === true` → 静默保留元数据；否则带 `surfaceOp` 或 `sourceEventSeqs` 直接抛错（`:203-213`）。

### 1.3 通过校验的全部硬约束（缺一即抛）

校验发生在 `planSurfaceEvent`（`:393-424`）→ 逐项：

| # | 约束 | 精确错误文案 | 行号 |
|---|---|---|---|
| 1 | `event.seq` 必须与期望值连续 | `session event seq ${event.seq} is not contiguous; expected ${expectedSeq}` | `:394-396` |
| 2 | `startSeq` 与 `endSeq` **都必须 < `event.seq`**（只能引用更早的事件） | `surface replace at seq ${event.seq}: startSeq and endSeq must reference earlier events` | `:301-304` |
| 3 | `startSeq` 必须在**当前 surface** 里 | `surface replace: start seq ${op.startSeq} not found in surface` | `:311-314` |
| 4 | `endSeq` 必须在**当前 surface** 里 | `surface replace: end seq ${op.endSeq} not found in surface` | `:315-318` |
| 5 | `startIdx <= endIdx` | `surface replace: start seq ${op.startSeq} (index ${startIdx}) is after end seq ${op.endSeq} (index ${endIdx})` | `:319-321` |
| 6 | 若带 `sourceEventSeqs`：非空、无重复、**每个元素 < `event.seq`**、且**必须覆盖全部被遮蔽的节点** | `sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}` | `:230-263`，缺项在 `:259-262` |
| 7 | `assistant/message` **不得**携带 `sourceEventSeqs` | `assistant/message embeds its source stream and cannot carry sourceEventSeqs` | `:232-234` |
| 8 | `tool/result` 只能改 `content`，且必须恰好遮蔽 1 个当前节点 | `tool/result surface replacement must rewrite exactly one current node` / `... may change only content` | `:350-375` |
| 9 | **node 0 保护**（见 1.4） | `surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node` | `:382-391` |

`sourceEventSeqs` 的语义是"引用"而非"授权" —— 它让 replay 能重建被替换的输入（`:263`），并**强制**你把它写全。

### 1.4 node 0 保护的**精确**条件

```js
// dsh-session/lib/types/surface.js:376-391
/**
 * Protect the system prompt at surface node 0. A replacement covering node 0
 * while that node is a `system/message` must itself be a `system/message` over
 * exactly that node; later system nodes carry no protection and a compaction
 * range may shadow them.
 */
function assertSystemHeadRewrite(event, state, startIdx, shadowedSeqs, events, baseSeq) {
    if (startIdx !== 0)
        return;
    const head = events[state.nodes[0] - baseSeq];
    if (head?.type !== 'system/message')
        return;
    if (event.type !== 'system/message' || shadowedSeqs.length !== 1) {
        throw new Error('surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node');
    }
}
```

拆成判定顺序，**必须同时满足三个前提才抛**：
1. `startIdx === 0` —— 替换范围**从第 0 位开始**（不是"包含"第 0 位：`startIdx` 由 `nodes.indexOf(op.startSeq)` 得出，`:311`）。起点在 1 及以后 → **直接返回，完全不受保护**。
2. 当前 `nodes[0]` 对应的事件**类型是 `system/message`** —— 若 node 0 是 `user/message`（例如没有系统提示或已被替换掉）→ 不受保护。
3. 以上都成立时，替换事件自身必须是 `system/message` **且 `shadowedSeqs.length === 1`**。

`shadowedSeqs = state.nodes.slice(startIdx, endIdx + 1)`（`:325`）；长度 1 ⇒ `startIdx === endIdx` ⇒ **`startSeq === endSeq` 且都等于 node 0 的 seq**。

> 原文注释（`:379-380`）：「later system nodes carry no protection and a compaction range **may shadow them**」—— 从 index ≥1 起、把后面的 `system/message` 一起遮蔽是**合法**的。受保护的只有 node 0。

### 1.5 要换掉 node 0，契约要求的**精确调用形状**

```js
// 唯一合法形状。NODE0 = 当前 surface 第 0 位的 seq（= session.surface.nodes[0]，且必须是 system/message）
session.append('system/message', { turn, step, message: newSystemMessage }, {
  surfaceOp: { op: 'replace', startSeq: NODE0, endSeq: NODE0 },   // 恰好 3 个键；startSeq === endSeq === node 0
  sourceEventSeqs: [NODE0],                                        // 必须包含被遮蔽的那个节点；元素必须 < 新事件 seq
});
```

**没有别的 op 能做到这件事**：`surfaceOp` 只有 `'append'` 和 `{op:'replace',startSeq,endSeq}` 两种取值（`:215-227`），没有 `'rewrite'`/`'patch'` 之类。所以「重写 node 0」= 用 `system/message` 做一次**单节点 replace**。

**三种必错写法**（对号入座就能定位现场那条报错）：

| 写法 | 结果 |
|---|---|
| `op:'replace', startSeq: node0, endSeq: nodeK`（K>0），事件是 `user/message` | 抛该错（`startIdx===0` + node0 是 system/message + 事件非 system/message） |
| `op:'replace', startSeq: node0, endSeq: nodeK`（K>0），事件是 `system/message` | 抛该错（`shadowedSeqs.length > 1`） |
| `op:'replace', startSeq: node1, endSeq: nodeK`（K≥1） | **合法**，与 node 0 无关 |

### 1.6 官方引擎怎么绕开（照抄这个）

官方**从构造上就不把 node 0 放进范围**：

```js
// dsh-compaction-basic/lib/index.js:400-415（selectCompactableRange 的文档 + 首行）
/**
 * Resolve the next range starting at the first non-system surface node while
 * retaining a priced recent tail and never splitting an assistant
 * tool-call/result pair. A `system/message` at surface node 0 is never inside
 * the range; without one the range starts at node 0.
 * ...
 */
function selectCompactableRange(session, measurement, retainTokens) {
	...
	const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;
```

而 `systemHead` 只在 node 0 真是 `system/message` 时返回它：

```js
// dsh-compaction-basic/lib/index.js:389-399
/**
 * The `system/message` holding surface node 0, or `undefined` when another
 * message-producing event starts the surface.
 */
function systemHead(session, headSeq) {
	const head = session.eventAt(headSeq);
	return head.type === 'system/message' ? head : void 0;
}
```

实际发出的替换（官方）：

```js
// dsh-compaction-basic/lib/index.js:650-661
	session.append("user/message", checkpointMessage, {
		surfaceOp: {
			op: "replace",
			startSeq: start,
			endSeq: end
		},
		sourceEventSeqs: [
			startEvent.seq,
			summaryEvent.seq,
			...shadowedSeqs
		]
	});
```
注意 `sourceEventSeqs` 既含两个生命周期事件，也含**全部** `shadowedSeqs`（满足约束 6）。

对应地，本插件**缺的就是这一行**：`lib/plan.js:125` 的 `selectIndexRange(tokens, { retainTokens, capTokens, firstIndex = 0 })` 默认从 0 开始，`lib/engine.js:426-429` 没传 `firstIndex`，`_trimToBalancedCuts`（`:572-597`）也不会把它推到 1。修法就是在选完 range 后按 `systemHead` 语义把 `startIndex` 抬到 1（或给 `selectIndexRange` 传 `firstIndex: hasSystemHead ? 1 : 0`）。

---

## §2 `pi-ai detected context overflow` 的准入判定

### 2.1 这条消息由谁产生

唯一出处：

```js
// dsh-llm-pi-ai/lib/index.js:1470-1479
function mapStopReason(message, contextWindow) {
	const piAiOverflow = isContextOverflow(message, contextWindow);
	const harnessOverflow = message.stopReason === "error" && message.errorMessage !== void 0 && isContextWindowExceededError(message.errorMessage);
	if (piAiOverflow || harnessOverflow) return {
		kind: "error",
		failure: {
			message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
			code: CONTEXT_WINDOW_EXCEEDED_CODE
		}
	};
```

**关键**：这串文字是 `message.errorMessage` 为 `undefined` 时的**兜底文案**。它出现 ⇒ 上游**没有**给出可读的 error 文本 ⇒ 判定来自**事后分类**而不是上游拒收。两种情况都会进这个分支：
- `isContextOverflow()` 判真而 `errorMessage` 为空（静默溢出 / length-stop 型）；
- `isContextWindowExceededError(errorMessage)` 判真（那条走的是 `harnessOverflow`，此时 `errorMessage` 非空，会是上游原文）。

`code` 常量：`CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED"`（`dsh-llm/lib/index.js:136`）。

### 2.2 **精确不等式**（三个 case，全部来自 pi-ai 源码）

```js
// @earendil-works/pi-ai/dist/utils/overflow.js:132-163
export function isContextOverflow(message, contextWindow) {
    // Case 1: Check error message patterns
    if (message.stopReason === "error" && message.errorMessage) {
        const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage));
        if (!isNonOverflow) {
            if (OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage))) {
                return true;
            }
            if (message.provider === "cerebras" && CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(message.errorMessage)) {
                return true;
            }
        }
    }
    // Case 2: Silent overflow (z.ai style) - successful but usage exceeds context
    if (contextWindow && message.stopReason === "stop") {
        const inputTokens = message.usage.input + message.usage.cacheRead;
        if (inputTokens > contextWindow) {
            return true;
        }
    }
    // Case 3: Length-stop overflow (Xiaomi MiMo style) ...
    if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
        const inputTokens = message.usage.input + message.usage.cacheRead;
        if (inputTokens >= contextWindow * 0.99) {
            return true;
        }
    }
    return false;
}
```

| Case | 触发条件 | 不等式 | 含 maxOutput？ | 含余量？ |
|---|---|---|---|---|
| 1 关键字 | `stopReason === 'error'` 且 `errorMessage` 非空，且未命中 `NON_OVERFLOW_PATTERNS`，且命中任一 `OVERFLOW_PATTERNS` | 无数字比较，纯正则 | **不含** | 不含 |
| 2 静默溢出 | `contextWindow` 有值 且 `stopReason === 'stop'` | **`usage.input + usage.cacheRead > contextWindow`**（严格大于） | **不含** | **不含** |
| 3 length 截断 | `contextWindow` 有值 且 `stopReason === 'length'` 且 `usage.output === 0` | **`usage.input + usage.cacheRead >= contextWindow * 0.99`** | **不含** | 0.99 因子 |

**结论（这是第 2 问的核心）：pi-ai 的溢出判定是「prompt 侧的 token 数直接与窗口比较」，完全不扣 `max_tokens`、不扣任何余量。**

排除表（Case 1 用）：

```js
// @earendil-works/pi-ai/dist/utils/overflow.js:72-76
const NON_OVERFLOW_PATTERNS = [
    /^(Throttling error|Service unavailable):/i,
    /rate limit/i,
    /too many requests/i,
];
```

**与现场网关直接相关的模式**（`OVERFLOW_PATTERNS`，`:35-61`，共 25 条）：

```js
    /range of input length should be/i, // DashScope / Qwen Token Plan     ← :57
    /prompt too long; exceeded (?:max )?context length/i, // Ollama        ← :56
    /exceeds the model'?s maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,  // :41
```
文件头注释（`:32`）明确写了：
> `- DashScope/Qwen: "Range of input length should be [1, X]" (HTTP 400 invalid_parameter_error)`

所以现场 `provider_name: alibaba-dashscope` 的 400，会被 Case 1 命中 `/range of input length should be/i` → `CONTEXT_WINDOW_EXCEEDED`。（**未确证**现场 400 的确切报文，需从会话文件里取 `errorMessage` 原文比对。）

### 2.3 窗口值的来源链

调用点：

```js
// dsh-llm-pi-ai/lib/index.js:1634
				reason: mapStopReason(event.message, contextWindow),
```
`contextWindow` 由 `toStreamChunks(events, contextWindow, callerSignal, requestedModel)` 传入（`:1537`），实参来自：

```js
// dsh-llm-pi-ai/lib/index.js:1990
				}), model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]();
```
而 `model` 由 `modelInfo()` 组装：

```js
// dsh-llm-pi-ai/lib/index.js:1911-1925
	modelInfo(snapshot, provider, model) {
		const profile = this.profileOf(snapshot, provider);
		const resolvedModel = this.modelOf(snapshot, provider, model);
		const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning);
		const configuredMaxTokens = profile.configuredMaxTokens.get(model);
		return {
			provider,
			id: model,
			...
			context: { contextWindow: resolvedModel.contextWindow },
			...configuredMaxTokens === void 0 ? {} : { defaultMaxTokens: configuredMaxTokens },
```
`resolvedModel.contextWindow` 的三级取值：

```js
// dsh-llm-pi-ai/lib/index.js:693-694
		const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow;
		if (!Number.isInteger(contextWindow) || contextWindow <= 0) invalid(provider, `model "${entry.id}" contextWindow must be a positive integer`);
```
即 **用户配置 > pi-ai 随包 catalog > 路由声明的 defaultContextWindow**。
所以：**它来自配置/模型目录，不是请求头、也不是上游回包。** 现场那个 `428,917` 就是这条链的结果（写在会话的 `request/context` 里）。

### 2.4 它和 token-meter 的口径**不一致**（确证）

- pi-ai 侧用的是**上游回包的 usage**：`usage.input` / `usage.cacheRead`（`overflow.js:148,157`）。
- token-meter 侧用的是**本地估算**：固定文本密度 heuristic，`dsh-token-meter/lib/index.js:15` `/** Fixed text-density estimate used until exact tokenization is needed. */`，逐块走 `estimateStructuralBlock` / `estimateContent` / `estimateMessage`（`:27,39,73`），并有 `priced` 与 `real` 两套数（`plan.js:91-92` 里本插件已经在做 `k` 换算）。

两者是不同来源，会分叉。**这就是现场「分块按估算切，适配器按自己的记账判超窗口」的机制。**

另外还有一条**第三条路径**用于「可恢复的截断」：

```js
// @earendil-works/pi-ai/dist/utils/overflow.js:164-172
export function isRecoverableLength(message, desiredMaxOutput) {
    return message.stopReason === "length" && desiredMaxOutput > 0 && message.usage.output < desiredMaxOutput;
}
```
它比较的是 `usage.output` 与「**未做上下文钳制前的原始** `desiredMaxOutput`」（`:167-168` 注释）。**本机是否有人消费它：未确证**（`dsh-llm`/`dsh-llm-pi-ai` 里未 grep 到调用；可能只在 pi-ai 内部）。

---

## §3 官方引擎（`dsh-compaction-basic`）的压缩行为

### 3.1 `compactIfNeeded` 的两条路径

```js
// dsh-compaction-basic/lib/index.js:914-961
	async compactIfNeeded(agent, trigger, signal) {
		const target = routedTarget(agent.session);
		if (target === void 0) return null;
		const policy = resolveTargetPolicy(this.config, target);
		const meter = this.ctx.tokenMeter;
		let measurement = meter.measure(agent.session);
		switch (trigger) {
			case "context-overflow": break;
			case "pressure": break;
			...
		}
		const prune = this.ctx.get("toolResultPruner");
		if (trigger === "context-overflow") {
			if (prune !== void 0) {
				prune.pruneSession(agent.session);
				measurement = meter.measure(agent.session);
			}
			const range = selectCompactableRange(agent.session, measurement, 0);
			if (range === null) return null;
			return this.compactRegion(range.start, range.end, agent, signal);
		}
		const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
		assertNoActiveCompaction(agent.session, "automatic pressure compaction");
		const targetKey = `${target.provider}/${target.model}`;
		if (info.context === void 0) throw new TargetPressureConfigError(targetKey, `compaction-basic: no context capacity for ${targetKey}; configure contextWindow on that adapter model`);
		const spec = resolveCompactSpec(policy, info.context.contextWindow, reservedCompletionTokens(agent, info.defaultMaxTokens));
		if (measurement.totalTokens < spec.thresholdTokens) return null;
		if (prune !== void 0) {
			prune.pruneSession(agent.session);
			measurement = meter.measure(agent.session);
		}
		if (measurement.totalTokens < spec.thresholdTokens) return null;
		let result = null;
		for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
			const range = selectCompactableRange(agent.session, measurement, spec.retainTokens);
			...
			result = await this.compactRegion(range.start, range.end, agent, signal);
			measurement = meter.measure(agent.session);
			if (measurement.totalTokens < spec.thresholdTokens) return result;
		}
		throw new Error(`compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);
	}
```

| | `trigger: "context-overflow"` | `trigger: "pressure"` |
|---|---|---|
| 阈值检查 | **完全跳过** | `measurement.totalTokens < spec.thresholdTokens` → 直接 `null` |
| 保留尾部 | **`retainTokens = 0`**（保留 0 —— 整段都可换） | `spec.retainTokens` |
| prune | 先 prune 再重测（`:927-931`） | **先测→判→prune→再测→再判**（`:941-946`） |
| 重试 | **无重试**，`compactRegion` 一次 | `for attempt = 0..spec.compactionRetries` |
| 失败 | 抛出 | 重试耗尽后抛 `compaction still above threshold after N compaction attempts (…)` |

### 3.2 摘要请求怎么发（合并 Q3 + Q7）

```js
// dsh-compaction-basic/lib/index.js:292-338  summarizeWithLlm（唯一实现）
async function summarizeWithLlm(ctx, config, input, agent, signal) {
	const latest = agent.session.requestHeader()?.config;
	const configured = config.summarizationProvider.length === 0 ? void 0 : {
		provider: config.summarizationProvider,
		model: config.summarizationModel
	};
	const agentTarget = ... : void 0;
	const target = configured ?? latest ?? agentTarget;
	if (target === void 0) throw new Error("no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields");
	const assembler = new BlockAssembler();
	const messages = [...input.messages, deepFreeze({
		role: "user",
		content: [{
			type: "text",
			text: COMPACTION_INSTRUCTION
		}]
	})];
	const options = {
		provider: target.provider,
		model: target.model,
		messages,
		toolHistory: agent.session.toolHistory(),
		...input.tools === void 0 ? {} : { tools: [...input.tools] },
		maxTokens: config.maxTokens,
		sessionId: agent.session.id,
		purpose: "compaction",
		...signal === void 0 ? {} : { signal }
	};
	for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
	const error = finishError(assembler.finish);
	if (error !== void 0) throw error;
	const rawOutput = assembler.blocks();
	const summary = summaryText(rawOutput);
	if (!summary.some((block) => block.text.trim().length > 0)) throw new Error("summarization produced no text summary content");
	return {
		summary,
		rawOutput,
		llmStreamCall: true,
		provider: options.provider,
		model: options.model,
		maxTokens: config.maxTokens,
		...assembler.usage === void 0 ? {} : { usage: assembler.usage }
	};
}
```

参数逐项：

| 参数 | 值 | 说明 |
|---|---|---|
| `provider` / `model` | 显式 `summarizationProvider/Model` → 否则**最近一次路由** → 否则 `agent.options` | `:294-303` |
| `messages` | 重放前缀 + **最后追加一条 user 的 `COMPACTION_INSTRUCTION`** | `:305-311`；前缀由 `buildSummarizationInput` 组装（见下） |
| `tools` | **带上**（`input.tools`） | `:317` |
| `maxTokens` | **`config.maxTokens`** | `:318` |
| **`reasoningEffort`** | **不设置** | 全函数无该字段 → 走路由/`resolveReasoningLevel` 的默认（`dsh-llm-pi-ai/lib/index.js:1953` `resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)`） |
| `purpose` | `"compaction"` | `:320` —— **只有 `dsh-llm-deepseek` 会用它**：`dsh-llm-deepseek/lib/index.js:2233` `...options.purpose === "compaction" ? { "x-deepseek-harness-compact": "1" } : {}`。`dsh-llm-pi-ai` **完全不读 `purpose`**（grep 无命中） |
| stream | **是**，`for await (const chunk of ctx.llm.stream(options))` | `:323` |
| `sessionId` | 会话 id | `:319` |

摘要输入的前缀构造：

```js
// dsh-compaction-basic/lib/index.js:695-704
function buildSummarizationInput(session, shadowedSeqs) {
	const header = session.requestHeader();
	const head = systemHead(session, session.surface.nodes[0]);
	const system = head === void 0 ? null : session.deriveEventMessage(head);
	const regionMessages = shadowedSeqs.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter((message) => message !== null);
	return {
		...header?.tools === void 0 ? {} : { tools: header.tools },
		messages: system === null ? regionMessages : [system, ...regionMessages]
	};
}
```
→ **系统提示会被重放进摘要请求**（为了 KV cache 命中，`:683-690` 注释）。所以摘要请求的 prompt = 「系统提示 + 工具 schema + 被压缩区域的全部消息 + 压缩指令」。

### 3.3 摘要响应的**期望形状**（Q7 核心）

`BlockAssembler.blocks()` 汇总**全部**块（**包含 reasoning**）：

```js
// dsh-llm/lib/index.js:1078-1080
	blocks() {
		return this.assembled().blocks;
	}
```
（`interruptedBlocks()` 的文档说明了块类型的集合：`:1081-1094`，「open text/reasoning blocks with non-whitespace content」，过滤 `(block?.type === "text" || block?.type === "reasoning") && block.text.trim() !== ""`。）

官方随后**只留 `text`**：

```js
// dsh-compaction-basic/lib/index.js:370-374
/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("compaction summary cannot contain image output", "UNSUPPORTED_CONTENT");
	return blocks.filter((block) => block.type === "text");
}
```

判定条件（`:328`）：

> `if (!summary.some((block) => block.text.trim().length > 0)) throw new Error("summarization produced no text summary content");`

**精确回答任务里的三个子问**：
- 是「没有任何 text 块」**还是**「文本为空/空白」？ → **两者都算失败**。先 `filter(type === 'text')`，再要求**至少一块** `text.trim().length > 0`。所以：没有 text 块 → 失败；只有空白/纯空格的 text 块 → 也失败。
- **reasoning 块算不算？** → **不算**。它在 `:373` 的 `filter` 里被丢弃。**模型只返回 reasoning 块 ⇒ 官方抛 `summarization produced no text summary content`。**
- 官方怎么处理「只返回 reasoning」？ → **丢弃并抛错，不重试、不降级**。唯一的"重试"机会是外层 `summarizeCompaction` 的 recover 循环（§3.4），而默认 recover 返回 `false`（§3.4）。

终止状态映射（决定 `max-tokens` 的落点）：

```js
// dsh-compaction-basic/lib/index.js:357-369
function finishError(finish) {
	switch (finish.kind) {
		case "error":
		case "aborted": return new LlmError(finish.failure.message, finish.failure.code, finish.failure);
		case "max-tokens": {
			const error = /* @__PURE__ */ new Error("summarization truncated at the token cap (incomplete checkpoint)");
			error.code = "MAX_TOKENS";
			return error;
		}
		default: return;
	}
}
```
→ `maxTokens` 用满被截断 ⇒ `MAX_TOKENS` 错误，**不会**走到"无文本"那一步。反过来说：现场看到"无文本"就说明**没被 token 上限截断**。

### 3.4 「摘要输入装不下」时官方怎么退让

**答案：官方自己没有拟合检查、没有分块、没有裁剪。** `summarizeWithLlm` 里没有任何与 `contextWindow` 比较的代码 —— 它把 `buildSummarizationInput` 的整段前缀一次性发给 provider；装不下就是 provider 报错。

唯一的退让机制是一个**留给外部插件的 waterfall**：

```js
// dsh-compaction-basic/lib/index.js:582-595
async function summarizeCompaction(dependencies, prepared, agent, compactionId, sourceCommandId, assertStable, signal) {
	let summaryResult;
	for (;;) {
		signal?.throwIfAborted();
		try {
			summaryResult = await dependencies.summarize(prepared.input, agent, signal);
			break;
		} catch (error) {
			if (signal?.aborted === true) throw error;
			assertStable(dependencies, agent.session, prepared);
			if (!dependencies.recover(error, agent, prepared.shadowedSeqs, signal)) throw error;
			prepared = prepareCompaction(dependencies, agent.session, validateSurfaceRegion(agent.session, prepared.start, prepared.end));
		}
	}
```
```js
// dsh-compaction-basic/lib/index.js:1012-1023
	/** Bind the effective token meter and dynamically dispatched summarizer hook. */
	regionDependencies() {
		return {
			meter: this.ctx.tokenMeter,
			summarize: (input, owner, abort) => this.summarize(input, owner, abort),
			recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall("compaction/summary-error", {
				session: agent.session,
				sourceEventSeqs,
				error,
				...signal === void 0 ? {} : { signal }
			}, () => false)
		};
	}
```

**要点**：
- `recover` 是 `ctx.waterfall("compaction/summary-error", payload, () => false)`。**默认返回 `false` ⇒ 抛原错。** 只有监听者返回真值才 `for(;;)` 重试一轮。
- 重试前会重新 `prepareCompaction`（重读 measurement + 重建 input）。**所以监听者必须先让 surface/预算真的变化**，否则会死循环（`for(;;)` 无次数上限，靠 `recover` 返回值与 `signal` 退出）。
- **这是官方留给插件实现「分块 / 缩小重试 / 换 summarizer」的正规挂点**，比覆盖 `summarize()` 更贴官方语义（`summarize()` 的 doc 也认可覆盖：`:893` 「Override this sole hook for a template or remote summarizer.」）。

**摘要收敛守卫**（成功后仍要过这道闸）：

```js
// dsh-compaction-basic/lib/index.js:596-601
	const checkpointMessage = createUserMessage({
		content: frameSummary(summaryResult.summary),
		source: compactCheckpointSource(compactionId, sourceCommandId)
	});
	const framedSummaryTokenCount = dependencies.meter.estimateMessage(checkpointMessage);
	if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) throw new Error(`summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`);
```
→ **摘要必须比被遮蔽内容更小**，否则整次压缩失败。

### 3.5 `prune` 与 `compaction/prune`

**谁 prune**：`compactIfNeeded` 两条路径都做，条件是 `ctx.get("toolResultPruner") !== undefined`（`:926,942`）。官方行：`dsh-base/cordis.patch.yml:425-426`

```yaml
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

**它做什么**（`dsh-compaction-tool-result-pruner/lib/index.js:125-177`）：

```js
	/**
	* Prune every over-budget tool result from one stable current-surface snapshot.
	* Each replacement preserves the complete event data except for `content`,
	* cites the shadowed node so replay can recover the replacement input, and is
	* immediately preceded by a `compaction/prune` shadow-price event pricing the
	* shadowed node through the injected token meter, so pure consumers can
	* subtract it without per-node state.
	*/
	pruneSession(session) {
		...
			session.append("compaction/prune", {
				shadowedRange: { start: seq, end: seq },
				shadowedSeqs: [seq],
				shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original)
			});
			const replacement = session.append("tool/result", {
				...event.data,
				message
			}, {
				surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
				sourceEventSeqs: [seq]
			});
```
→ **每个超预算的 `tool/result` 单节点替换**（`startSeq === endSeq`，永远不会碰 node 0，因为 `tool/result` 不可能是 node 0 —— node 0 若是 system/message 则受保护、若否也不是 tool/result 的典型位置；即便如此 `startSeq !== 0` 时保护不触发）。因为只换 `content`，所以满足约束 8。

`compaction/prune` 的**语义**：一个"影子定价"事件，紧邻在替换之前，携带 `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount`，**让纯粹的（pure）计量消费者能直接减掉这块成本，而不必维护逐节点状态**（`dsh-tool-cordis/lib/types/api-catalog.js:3339` 同义描述）。它不是 surface 事件（不在 `SURFACE_EVENT_TYPES` 里），但属于已知事件类型（`dsh-session/lib/types/known-event-types.js:32`），并且在 token-meter 的投影里被识别：

```js
// dsh-token-meter/lib/index.js:213
		if (event.type === "compaction/summary" || event.type === "compaction/prune") {
```

`compaction/start` / `compaction/end`（不是 prune）：

```js
// dsh-compaction-basic/lib/index.js:434-440（文档）
/**
* Run the single compaction transaction over one selected positional span.
* Selection and validation are read-only. Idle/log validation and
* `compaction/start` are synchronously adjacent, so the durable opening marker is
* the compaction lock before summarization yields. Every later failure makes
* exactly one `compaction/end` attempt; a failed close deliberately leaves the
* unmatched start detectable.
*/
```
```js
// dsh-compaction-basic/lib/index.js:469 与 :484
	const startEvent = session.append("compaction/start", lifecycle);
	...
		const endEvent = session.append("compaction/end", lifecycle);
```
**失败时**（`:487-507`）会补一个带 `error` 的 `compaction/end`：

```js
			try {
				session.append("compaction/end", {
					...lifecycle,
					error: errorChain(error)
				});
```
→ 现场日志里的 `compaction/end error: "compaction produced no summary text"` 就是这一条，`error` 字段来自 `errorChain(error)`。**`compaction/end` 是压缩事务的收尾事件，不是成功标志** —— 判成功要看有没有 `compaction/summary` + 配对的 replace。

### 3.6 谁触发压缩、失败怎么被吞掉（解释「7 次失败但回合 completed」）

**`agent/pre-step`（step 边界，`trigger: "pressure"`）**：

```js
// dsh-compaction-basic/lib/index.js:834-852
	_registerAutomaticCompaction() {
		const { ctx } = this;
		const logResult = (result, trigger) => {
			ctx.logger.info(`compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`);
		};
		ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			if (!signal.aborted) try {
				const result = await this.compactIfNeeded(agent, "pressure", signal);
				if (result !== null) logResult(result, "step pressure");
			} catch (error) {
				if (error instanceof TargetPressureConfigError) {
					if (this.warnedPressureConfigTargets.has(error.targetKey)) return next();
					this.warnedPressureConfigTargets.add(error.targetKey);
				}
				const message = error instanceof Error ? error.message : String(error);
				ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`);
			}
			return next();
		});
```

**压力路径把所有错误吞掉**（`:848-850`：`step compaction failed: …; continuing the turn`），然后 `return next()`。
→ **这完全解释现场**：连续多次 `compaction/end error:` 之后 `turn/end {"kind":"completed"}`。**回合完成不代表压缩成功。**
→ 同时说明：`TargetPressureConfigError` 每个 target 只完整警告一次（`:844-847`），之后静默 `next()` —— 若配置导致压力预算为负，现象会非常安静。

`TargetPressureConfigError` 的产生条件就在 `resolveCompactSpec`：

```js
// dsh-compaction-basic/lib/index.js:124-134
function resolveCompactSpec(policy, contextWindow, reservedCompletionTokens) {
	const targetKey = `${policy.target.provider}/${policy.target.model}`;
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`);
	if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: reservedCompletionTokens (${reservedCompletionTokens}) must be a non-negative integer`);
	const messageBudgetTokens = contextWindow - reservedCompletionTokens;
	if (messageBudgetTokens <= 0) throw new TargetPressureConfigError(targetKey, `compaction-basic: ${targetKey} reserves ${reservedCompletionTokens} completion tokens of its ${contextWindow}-token context window, leaving no message budget; configure the adapter model's contextWindow above the effective request maxTokens`);
	const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens;
	if (pressureBudgetTokens <= 0) throw new TargetPressureConfigError(targetKey, `compaction-basic: ${targetKey} reserves ${reservedCompletionTokens} completion tokens and ${policy.headroomTokens} headroom tokens of its ${contextWindow}-token context window, leaving no pressure budget; reduce the effective request maxTokens or compaction headroomTokens, or configure a larger adapter model contextWindow`);
	const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));
	const retainTokens = policy.retainTokens === void 0 ? Math.floor(messageBudgetTokens * policy.retainRatio) : policy.retainTokens;
	if (retainTokens >= thresholdTokens) throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: ${policy.target.provider}/${policy.target.model} retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`);
```
`reservedCompletionTokens` 的来源：

```js
// dsh-compaction-basic/lib/index.js:751-759
/**
* Output tokens the routed request reserves, which the provider charges to the
* same window as the prompt. The effective envelope's own cap wins; otherwise
* the adapter's per-request default, which the adapter materializes when that
* envelope omits one. No declared cap means no reservation.
*/
function reservedCompletionTokens(agent, defaultMaxTokens) {
	return agent.session.requestHeader()?.config.maxTokens ?? defaultMaxTokens ?? 0;
}
```

**压力路径的精确不等式（汇总）**：
```
O   = session.requestHeader().config.maxTokens  ??  info.defaultMaxTokens  ??  0
B   = thresholdRatio  ? floor(min(W * thresholdRatio, (W - O) - H))  : ...
W   = info.context.contextWindow
H   = policy.headroomTokens
压缩 ⇔  measurement.totalTokens >= floor(min(W * thresholdRatio, (W - O) - H))
```
**回答「含不含 maxOutput、余量」**：**含**。官方把 `maxTokens`（= 输出预留 **O**）和 `headroomTokens`（**H**）都从窗口里扣掉，再与 `thresholdRatio` 取小。**这与 pi-ai 的准入不等式（`input + cacheRead > W`，什么都不扣）是完全不同的两条线 —— 这就是分叉的根源。**

内置默认值（`dsh-base/cordis.patch.yml:351-352` 的 `compaction-basic` 行**没有 config 块**，所以全走默认）：

```js
// dsh-compaction-basic/lib/index.js:14-17
/** Default request-pressure fraction for every routed model. */
const DEFAULT_THRESHOLD_RATIO = .8;
/** Default verbatim-tail fraction for every routed model. */
const DEFAULT_RETAIN_RATIO = .16;
```
```js
// dsh-compaction-basic/lib/index.js:63-67 与 :79-85
	const headroomTokens = config.headroomTokens ?? 65536;
	const maxTokens = config.maxTokens ?? headroomTokens;
	...
		summarizationProvider: config.summarizationProvider ?? "",
		summarizationModel: config.summarizationModel ?? "",
		maxTokens,
		compactionRetries: config.compactionRetries ?? 1,
		maxOverflowRetries: config.maxOverflowRetries ?? 1,
		modelPolicies,
		auto: config.auto ?? true
```

| 键 | 官方默认 |
|---|---|
| `thresholdRatio` | `0.8` |
| `retainRatio` | `0.16` |
| `headroomTokens` | `65536` |
| `maxTokens`（**也是摘要请求的输出上限**） | `65536`（= `headroomTokens`） |
| `compactionRetries` | `1` |
| `maxOverflowRetries` | `1` |
| `auto` | `true` |

**注意 `maxTokens` 默认 65536 会被原样发给摘要请求**（`:318`）。本插件的 `cordis.patch.yml:82` 也是 `maxTokens: 65536`。

---

## §4 `replaceGeneration`

### 4.1 唯一的自增点

```js
// dsh-session/lib/types/surface.js:430-454
/** Commit one previously validated surface transition. */
function applySurfacePlan(state, plan) {
    if (plan?.kind === 'append') {
        state.nodes.push(plan.seq);
    }
    else if (plan?.kind === 'replace') {
        state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq);
        state.replaceGeneration += 1;
        state.contentGeneration += 1;
    }
    else if (plan?.kind === 'project') {
```
打包副本同一处：`dsh-session/lib/index.js:469`。初值 `0`（`surface.js:180`）。
对外只读暴露：`SurfaceManager.replaceGeneration` getter（`surface.js:510-515`），等价于 `lib/index.js:541-545`。
类型声明：`export interface SessionSurface { readonly nodes: readonly SessionSeq[]; readonly replaceGeneration: number; readonly contentGeneration: number; }`（`dsh-tool-cordis/lib/types/api-catalog.js:7404`）。

### 4.2 它是不是「surface 真的换掉了」的**唯一**判据

**是「发生过任意一次 replace」的判据，但不是「摘要落地」的判据。** 三点：

1. **任何** `kind === 'replace'` 都 +1 —— 包括 **`tool-result-pruner` 的单节点替换**（`dsh-compaction-tool-result-pruner/lib/index.js:167-177`，`surfaceOp: {op:'replace', startSeq: seq, endSeq: seq}`）。所以 `replaceGeneration` 前进**可能只是 prune**，与摘要无关。
2. `kind === 'project'` 只 +`contentGeneration`，不动 `replaceGeneration`（`surface.js:440-445`）—— 投影型变更不算。
3. 它**不校验** replace 是否满足摘要收敛守卫（§3.4 的 `summary is not smaller…`）。那个守卫失败时 `replaceGeneration` **不会**前进（因为 replace 根本没执行）。

### 4.3 谁在用它，以及溢出重试的**精确条件**

```js
// dsh-compaction-basic/lib/index.js:861-887
		ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
			if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
			this.overflowAgents.set(agent.session, agent);
			const target = routedTarget(agent.session);
			if (target === void 0) return next();
			const policy = resolveTargetPolicy(this.config, target);
			const retries = this.overflowRetries.get(agent) ?? 0;
			if (retries >= policy.maxOverflowRetries) return next();
			const generation = agent.session.surface.replaceGeneration;
			let result;
			try {
				result = await this.compactIfNeeded(agent, "context-overflow", signal);
			} catch (recoveryError) {
				const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
				if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
					ctx.logger.warn(`context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`);
					this.overflowRetries.set(agent, retries + 1);
					return { kind: "retry" };
				}
				ctx.logger.warn(`context-overflow compaction failed: ${message}; ${signal.aborted ? "cancellation prevents retry" : "preserving the original request error"}`);
				return next();
			}
			if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
			if (result !== null) logResult(result, "context overflow recovery");
			this.overflowRetries.set(agent, retries + 1);
			return { kind: "retry" };
		});
```

**判据（两处，都是 `> generation`）**：
- 成功分支（`:883`）：`signal.aborted || replaceGeneration <= generation` → `next()`（**放弃重试，保留原始错误**）。
- 失败分支（`:875`）：`!signal.aborted && replaceGeneration > generation` → `{kind:'retry'}`；否则 `next()`。

**这是"数次压缩失败后回合以 400 结束"的精确机理**：`compactIfNeeded` 抛错 **且** 这期间没有任何 replace 落地（含 prune）⇒ `replaceGeneration` 不前进 ⇒ `next()` ⇒ 原始 `CONTEXT_WINDOW_EXCEEDED` 一路走到回合结束。
**也正是本插件必须在"摘要彻底失败"时保留一条"破坏性裁剪"降级路径的原因**（哪怕只 prune，也能让 generation 前进）。`compaction/end` 带 error 的收尾事件**不**使 generation 前进。

`RequestErrorAction` 的合法取值只有两个：

```js
// dsh-tool-cordis/lib/types/api-catalog.js:6703-6704
        name: 'RequestErrorAction',
        declaration: 'export type RequestErrorAction = {\n    kind: \'retry\';\n} | undefined;',
```

`overflowRetries` 的重置点：`agent/status === 'idle'`（`:853-855`）与 `assistant/message` 落地（`:856-860`）。

### 4.4 另一类消费者（缓存失效键，不是成功标志）

```js
// dsh-compaction/lib/index.js:46-52（打包副本；同一处的可读版见 lib/types/tool-pairing.js:44-50）
/** Return balance state synchronized with the current session surface. */
function balanceCache(session) {
	const surface = session.surface;
	const seqs = surface.nodes;
	const generation = surface.replaceGeneration;
	const cached = balanceCacheBySession.get(session);
	if (cached === void 0 || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
```
（同源副本 `dsh-compaction/lib/types/tool-pairing.js:44-50`。）→ 用来判缓存是否可复用。**再次印证它只是"surface 变过"的版本号。**

---

## §5 插件能拿到的公开接口

### 5.1 窗口 / 模型信息 —— **能拿到**

```js
// dsh-tool-cordis/lib/types/api-catalog.js:1437
                signature: 'async resolveModelInfo( provider: string, model: string, signal?: AbortSignal, ): Promise<LlmResolvedModelInfo>',
```
返回类型：

```js
// dsh-tool-cordis/lib/types/api-catalog.js:5904
        declaration: 'export interface LlmResolvedModelInfo extends LlmModelInfo {\n    context?: LlmModelContext;\n    defaultMaxTokens?: number;\n    reasoning?: LlmModelReasoningInfo;\n    systemPromptUpdate?: SystemPromptUpdate;\n    toolUpdate?: ToolUpdate;\n}',
// :5876
        declaration: 'export interface LlmModelContext {\n    contextWindow: number;\n}',
// :5884
        declaration: 'export interface LlmModelInfo {\n    provider: string;\n    id: string;\n    name: string;\n    description?: string;\n    inputModalities?: readonly ModelModality[];\n}',
```
调用方式（本插件已在用）：`ctx.llm.resolveModelInfo(route.provider, route.model, signal)`（`lib/engine.js:541`），并会退回单参形式 `ctx.llm.resolveModelInfo(route)`（`:544`）。
→ **`info.context.contextWindow` 与 `info.defaultMaxTokens` 就是官方做预算用的那两个数**（`dsh-compaction-basic:936-940`）。**照官方口径就够了，不要另建一套。**

其它同源接口：`listProviders()`（`:1370`）、`listConfigurableProviders()`（`:1382`）、`listModels(provider)`、`resolveCallConfig(config, signal)`、`prepareCall(...)`（`:5908` 的类声明）。

### 5.2 token 计量 —— **能拿到**

```js
// dsh-tool-cordis/lib/types/api-catalog.js:3302
                signature: 'measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement',
// :3308
                signature: 'estimateMessage(message: Message): number',
```
服务名 `tokenMeter`（`api-catalog.js:3297`）。
→ `measure(session)` 返回同时含 `totalTokens`（真实口径）与 `surfaceTokens`（priced 口径）以及逐节点 `nodes[]`（`lib/plan.js:86-105` 的 `classifyMeasurement` 正是照这个消费的）。
→ `estimateMessage(message)` 是官方做"摘要是否更小"判定的同一个函数（`dsh-compaction-basic:600`）。**本插件应当用它做帧后估算，与官方同尺。**

### 5.3 拦截每一次模型调用 —— **能拿到（读）**

```js
// dsh-tool-cordis/lib/types/api-catalog.js:4300-4305
        name: 'llm/stream',
        mode: 'waterfall',
        signature: '\'llm/stream\'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>',
        summary: 'Waterfall around every streaming model call (retry, replay, routing).',
        description: 'Waterfall around every streaming model call (retry, replay, routing). Bound to the LlmRuntime; call `next()` to reach the resolved adapter\'s stream, or yield your own chunks to short-circuit.',
        parameters: [{ name: 'options', description: 'the full request. A LOOP-built request carries the process-local {@link markAgentLoopRequest} identity and arrives deep-frozen (mutation throws): its content is a pure function of the session log (the reconstructability Agent Note), so listeners read it, never rewrite it. Hand-built calls do not carry that marker; callers own their request inputs and must keep them unchanged until the stream settles.' }],
```
发出点：`dsh-llm/lib/index.js:2397` `return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));`
现成监听先例：`dsh-session-title/lib/index.js:262-268`、`dsh-session-checkpoint-policy/lib/index.js:61-65`。

**这就是 Q7「有没有公开接口能读到这次摘要调用实际返回了什么」的答案** —— 在 `llm/stream` 上按 `options.purpose === 'compaction'` 过滤，包一层 async iterable 记录每个 chunk：

```js
// 形状示意（不是照抄官方文件）
ctx.on('llm/stream', (options, next) => {
  if (options.purpose !== 'compaction') return next();
  const inner = next();
  return (async function* () {
    for await (const chunk of inner) { record(chunk); yield chunk; }
  })();
});
```
注意：`next()` 返回的是 **AsyncIterable**，不是 Promise，所以要返回一个异步生成器包装 —— **不要 `await next()`**，直接 `for await (const chunk of next())`。摘要调用由 `dsh-compaction-basic` 手工构造，**不带** loop marker（按上面 description 的定义），但 "callers own their request inputs and must keep them unchanged until the stream settles" —— **记录可以，改写请求不要**。

### 5.4 压缩失败恢复挂点 —— **能拿到**

```js
// dsh-compaction-basic/lib/index.js:1017-1022
			recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall("compaction/summary-error", {
				session: agent.session,
				sourceEventSeqs,
				error,
				...signal === void 0 ? {} : { signal }
			}, () => false)
```
→ 监听 `compaction/summary-error`，返回真值即让官方 `for(;;)` 再试一轮（§3.4）。

### 5.5 覆盖摘要 hook —— **官方认可**

```js
// dsh-compaction-basic/lib/index.js:889-903
	/**
	* Summarize the replayed conversation region through a direct one-shot
	* `ctx.llm.stream()` call whose prefix reuses the conversation's own system
	* prompt, tools, and messages so the provider's KV cache is not invalidated.
	* Override this sole hook for a template or remote summarizer.
	...
	*/
	async summarize(input, agent, signal) {
		const target = conversationTarget(agent);
		const config = target === void 0 ? this.config : resolveTargetPolicy(this.config, target);
		return summarizeWithLlm(this.ctx, config, input, agent, signal);
	}
```
→ **覆盖合法，但返回值形状是契约的一部分（`{summary, rawOutput, …}`，§7.3）。** 覆盖者必须产出同形状。

### 5.6 **拿不到**的（必须自己重建或改成用上面的口径）

| 想要的 | 状态 |
|---|---|
| 适配器内部的 token 估算函数（"适配器自己的记账"） | **未确证**存在这样的公开接口。pi-ai 的 `contextWindow` 是目录值，`usage` 是回包值，没有对外暴露的 estimate 函数 |
| 上游回包里 reasoning 块的数量 / 内容，**在失败之后** | 官方路径**拿不到**：`summarizeWithLlm` 成功才返回 `rawOutput`（`:329-337`），抛错时什么都不返回。唯一办法是 §5.3 的 `llm/stream` 自记，或在 `compaction/summary-error` 的 payload 里带上自己的记录 |
| 本次摘要调用精确消耗的 prompt token（未经上游回包） | 无公开接口；`usage` 只在成功返回值里（`:336`） |
| `provider` 是否"官方端点" | 见 §6 —— 没有布尔字段，靠 `declared` 判 |

---

## §6 「官方端点 vs 第三方网关」的可判定字段

### 6.1 唯一权威字段：`LlmConfigurableProvider.declared`

```js
// dsh-llm-pi-ai/lib/index.js:2830-2858
/**
 * The configurable-provider directory: every installed catalog route, plus
 * every route the current profiles declare. A hand-declared route has no
 * catalog entry, so without this union it would have no settings address and
 * configuration surfaces could neither show nor edit it. A catalog route also
 * carries its catalog endpoint and native authentication, which a settings
 * editor shows while the profile leaves the endpoint or the credential
 * reference unset.
 * @param profiles - the currently resolved provider profiles.
 * @returns the directory entries in catalog order, declared routes last.
 */
function directoryEntries(profiles, settingsNs) {
	const entries = /* @__PURE__ */ new Map();
	const declare = (provider, displayName, error) => {
		const installed = catalogProvider(provider);
		entries.set(provider, {
			provider,
			displayName,
			settingsNs,
			settingsPath: ["providers", provider],
			declared: installed === void 0,
			...installed === void 0 ? {} : providerDefaultsOf(installed),
			...error === void 0 ? {} : { error }
		});
	};
	for (const provider of catalogProviderIds()) declare(provider, provider);
	for (const [provider, profile] of profiles) declare(provider, profile.displayName, profile.catalogError);
	return [...entries.values()];
}
```

**`declared: installed === void 0`（`:2850`）⇒**
- **`declared === true`：该 provider id 在 pi-ai 随包 catalog 里**没有**对应条目 = 手写声明的路由 = **第三方网关**。**
- **`declared === false`：pi-ai 的随包 catalog 描述了这个 id = 随包/官方路由。**

读法：`ctx.llm.listConfigurableProviders()`（`api-catalog.js:1382`）→ 找 `entry.provider === <你的 gateway 名>` → 看 `entry.declared`。

条目类型：

```js
// dsh-tool-cordis/lib/types/api-catalog.js:5856
        declaration: 'export interface LlmConfigurableProvider {\n    provider: string;\n    displayName: string;\n    settingsNs: string;\n    settingsPath: readonly string[];\n    declared?: boolean;\n    defaultBaseURL?: string;\n    baseURLEnv?: readonly string[];\n    nativeAuth?: LlmNativeAuth;\n    error?: string;\n}',
// :5892
        declaration: 'export interface LlmNativeAuth {\n    env: readonly string[];\n    oauth: boolean;\n}',
```

### 6.2 辅助字段（可判定但更弱）

`providerDefaultsOf` 决定 `defaultBaseURL` / `nativeAuth` 是否出现：

```js
// dsh-llm-pi-ai/lib/index.js:2795-2812
/** Installed provider defaults for configuration surfaces. */
/**
* Return generated display metadata without executing authentication.
* @param provider - Installed catalog provider, possibly from a newer consumer dependency.
* @returns Known metadata, or only a fixed public endpoint for an unrecorded provider.
*/
function providerDefaultsOf(provider) {
	const data = PROVIDER_DATA[provider.id];
	if (data === void 0) return provider.baseUrl && !provider.baseUrl.includes("{") ? { defaultBaseURL: provider.baseUrl } : {};
	const { env, ...endpoint } = data;
	return {
		...endpoint,
		nativeAuth: {
			env,
			oauth: provider.auth.oauth !== void 0
		}
	};
}
```
→ 有 `nativeAuth` ⇒ catalog 里记了原生环境变量认证（更强的一手路由信号）；只有 `defaultBaseURL` ⇒ 只有固定端点。
`defaultBaseURL` **可能不含占位符**才会出现（`:2803` 检查 `!provider.baseUrl.includes("{")`）—— 含 `{}` 的模板端点不会输出。

### 6.3 用户**实际配的** baseURL 在哪读

三级解析：

```js
// dsh-llm-pi-ai/lib/index.js:691-692
		const baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl;
		if (baseUrl === void 0) invalid(provider, `model "${entry.id}" needs a baseURL; the installed catalog does not describe this route`);
```
（`providerBaseUrl = catalogProvider(provider)?.baseUrl`，`:659`。）

**生效值不在 `resolveModelInfo` 的返回值里**（`modelInfo` `:1916-1925` 只回 `context`/`defaultMaxTokens`/`reasoning`/`id`/`name`/`inputModalities`）。
但目录条目给了地址：`settingsNs` + `settingsPath: ["providers", provider]`（`:2848-2849`）。`settingsNs` 的来源：

```js
// dsh-llm-pi-ai/lib/index.js:2864
	const settingsNs = ctx.fiber.entry?.options.id ?? NS;      // NS = "llm-pi-ai"，:2817
```
→ 通过 settings 服务读该命名空间下 `providers.<provider>.baseURL`，即得用户覆盖值。

### 6.4 **没有**的东西（避免找错的字段）

```js
// dsh-tool-cordis/lib/types/api-catalog.js:5896
        declaration: 'export interface LlmProviderInfo {\n    id: string;\n    name: string;\n}',
```
`listProviders()` 只给 `{id, name}` —— **没有** `isOfficial` / `kind` / `tier` 之类的标志。**不要指望它。**
`LlmCallConfig` 也只有 `{provider, model}` + `LlmCallControls`（`:5844`）。
→ **判定用 `declared`（§6.1），别自己维护一份"官方 provider id 白名单"** —— 那份名单会随 catalog 漂移。

---

## §7 `compaction produced no summary text` 的完整解剖

### 7.1 出处与归属（务必先分清楚）

| 字符串 | 出处（唯一） | 条件 |
|---|---|---|
| `compaction produced no summary text` | `D:\dsh-compaction-doctor\lib\engine.js:308` | `texts.length === 0` **且 `firstError === undefined`** |
| `summarization produced no text summary content` | `dsh-compaction-basic/lib/index.js:328` | `summary.some(b => b.text.trim().length > 0)` 为假 |

```js
// D:\dsh-compaction-doctor\lib\engine.js:288-318
    const texts = [];
    let template;
    let firstError;
    let usage;
    for (let index = 0; index < groups.length; index += 1) {
      if (signal?.aborted === true) throw firstError ?? new Error("compaction summarization aborted");
      const chunkInput = { ...shallowClone(input), messages: groups[index] };
      try {
        const output = await super.summarize(chunkInput, agent, signal);
        this.doctorStats.chunkCalls += 1;
        if (template === undefined && output !== undefined && output !== null) template = output;
        const text = collectText(output);
        if (text !== undefined && text.length > 0) texts.push(text);
        usage = sumUsage(usage, output?.usage);
      } catch (error) {
        if (firstError === undefined) firstError = error;
        warn(this.ctx, `chunk ${index + 1}/${groups.length} summarization failed: ${error?.message ?? error}`);
        if (index === 0 && error instanceof ManualCompactionError) throw error;
      }
    }
    if (texts.length === 0) throw firstError ?? new Error("compaction produced no summary text");
```

**逻辑推论【已确证】：**
1. `firstError` **只在 catch 里**赋值。所以抛出 `compaction produced no summary text` 这个字面量 ⇔ **零个分块抛过异常**。
2. 因此：**这不是上游 400 导致的**。上游拒收会走 `catch`，于是错误文案会是 provider 的原文（`firstError`）。
3. 于是只剩一种解释：**每个分块的 `super.summarize` 都成功返回了，但 `collectText(output)` 对每个返回值都返回 `undefined`。**

### 7.2 判定条件对照（回答子问）

| | 官方 `summaryText`（`:371-374`） | 本插件 `collectText`（`:639-650`） |
|---|---|---|
| 取哪个字段 | 调用方传入 `rawOutput`（数组） | `output.blocks` → 否则 `output.text` → 否则 `output.summary` |
| 是否按类型过滤 | **是**：`block.type === "text"` | **否**：只要求 `typeof block?.text === "string" && length > 0` |
| 空/空白判定 | `block.text.trim().length > 0` | `block.text.length > 0`（**不 trim**） |
| reasoning 块 | **丢弃** | 若走到 `blocks` 分支则会**收下**（不看 `type`） |
| "没有任何块" | 抛 `summarization produced no text summary content` | 返回 `undefined` |

→ 语义**两处都不一致**：官方严格（trim + 只 text），本插件宽松（不 trim、不看 type） —— 但因为**取错字段**，宽松也用不上。

### 7.3 期望形状的权威定义（本插件读错了的地方）

```js
// dsh-compaction-basic/lib/index.js:326-337
	const rawOutput = assembler.blocks();
	const summary = summaryText(rawOutput);
	if (!summary.some((block) => block.text.trim().length > 0)) throw new Error("summarization produced no text summary content");
	return {
		summary,
		rawOutput,
		llmStreamCall: true,
		provider: options.provider,
		model: options.model,
		maxTokens: config.maxTokens,
		...assembler.usage === void 0 ? {} : { usage: assembler.usage }
	};
```

| 键 | 类型 | 含义 |
|---|---|---|
| **`summary`** | `Array<{type:'text', text:string}>` | **只含 text 块**（`summaryText` 过滤后），非空且至少一块 `trim()` 后非空 |
| **`rawOutput`** | `Array<Block>` | `assembler.blocks()` 全量（含 reasoning / tool-call） |
| `llmStreamCall` | `true` | 走了 `ctx.llm.stream` 路径（`commitCompactionBody` 用它决定是否记 `rawOutput`，`:630-633`） |
| `provider` / `model` | `string` | 实际使用的目标 |
| `maxTokens` | `number` | = `config.maxTokens` |
| `usage` | 可选 `TokenUsage` | 有才出现 |
| **`blocks`** | **不存在** | **本插件 `collectText` 找的就是它** |
| `text` | **不存在** | |
| `summary` **不是** string | **是数组** | `collectText:648` 的 `typeof output.summary === "string"` 恒假 |

**对照本插件的读取：**
```js
// D:\dsh-compaction-doctor\lib\engine.js:638-650
/** Best-effort text extraction from a summarizer result. */
export function collectText(output) {
  if (output === undefined || output === null) return undefined;
  const blocks = Array.isArray(output.blocks) ? output.blocks : undefined;   // ← 官方无 blocks 键 ⇒ undefined
  if (blocks !== undefined) { ... }
  if (typeof output.text === "string") return output.text;                   // ← 无 text 键
  if (typeof output.summary === "string") return output.summary;             // ← summary 是数组 ⇒ 恒假
  return undefined;                                                          // ← 永远到这里
}
```
→ **`collectText` 对官方返回值恒为 `undefined`**。

同样的问题在合并函数里：
```js
// D:\dsh-compaction-doctor\lib\engine.js:656-679
export function withMergedText(template, text) {
  ...
  const blocks = Array.isArray(template.blocks) ? template.blocks : undefined;   // ← undefined
  if (blocks !== undefined) { ... }
  if (typeof template.text === "string") { ... }                                 // ← 无
  if (typeof template.summary === "string") { ... }                              // ← 数组 ⇒ 恒假
  return undefined;                                                              // ← :312-314 走"形状未知"
}
```
→ 即使 `collectText` 被修好，`withMergedText` 也返回 `undefined`，于是 `:312-314` 打「summarizer output shape unknown; returning the first chunk summary unchanged」，**只有第 1 块进入摘要、其余块静默丢失**。

**现场统计的交叉验证**：`chunkCalls: 14`（`:297`，只在成功之后自增）而 `chunkedRegions: 0`（`:309`，在 `:308` 之后）。
14 次成功调用 / 0 次合并 ⇒ 每次都因 `texts.length === 0` 在 `:308` 抛出 ⇒ **与"取错字段"完全一致**。

### 7.4 摘要请求参数（是否带 reasoningEffort / maxOutput / stream / tools）

见 §3.2 的表。要点复述：
- **`reasoningEffort`：不带。** 由 pi-ai 的 `resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)` 决定（`dsh-llm-pi-ai/lib/index.js:1953`）。所以摘要请求的思考档位 = 该 provider profile 的默认档 —— 若默认档偏高，思考可能吃掉大量输出预算。
- **`maxOutput`：就是 `maxTokens`，官方默认 `65536`**（`dsh-compaction-basic:64`），本插件 `cordis.patch.yml:82` 也是 `65536`。**这是"摘要请求被拒/超窗口"的头号可疑参数**：它是输出预留，不是输入预算；一个 65536 的 `max_tokens` 在 Qwen/DashScope 类端点上常被直接判非法，或与 prompt 相加后超窗口。
- **stream：是**（`for await (const chunk of ctx.llm.stream(options))`，`:323`）。
- **tools：带**（`:317`，来自 `input.tools`）。所以摘要请求的 prompt 还含**全部工具 schema**（`buildSummarizationInput:701`）—— 这又加了一笔不可忽视的输入成本。
- `purpose: "compaction"` 在 pi-ai 路由上**不生效**（§3.2）。

### 7.5 谁发出、谁来收尾

- 抛出：本插件 `lib/engine.js:308`。
- 收尾事件：`dsh-compaction-basic:495-498` 的 `session.append("compaction/end", {...lifecycle, error: errorChain(error)})`。日志形如 `compaction/end error: "<message>"`。
- 若是 `pressure` 触发：`compaction-basic:843-851` 吞掉错误（`step compaction failed: …; continuing the turn`）⇒ **回合仍 `completed`** —— 与现场一致。
- 若是 `context-overflow` 触发：`compaction-basic:873-886` 依 `replaceGeneration` 决定是否重试，否则 `next()` ⇒ 原始 400 上浮。

### 7.6 「模型只返回 reasoning 块」会怎样

| 引擎 | 行为 |
|---|---|
| 官方 | `summaryText`（`:373`）滤掉 reasoning ⇒ `summary` 为空 ⇒ 抛 `summarization produced no text summary content`（`:328`）。**丢弃，不重试、不降级**（除非有 `compaction/summary-error` 监听者救了它，§3.4） |
| 本插件 | 走 `super.summarize` 时官方**已经**抛错了；per-chunk 的 `catch` 记下 `firstError` 并 `warn`（`engine.js:302-304`），最后 `throw firstError`（`:308`）⇒ 上浮的是官方那条文案，**不是** `compaction produced no summary text` |

→ **所以"官方引擎也报 `compaction produced no summary text`"在代码上不成立**（§0.1）。

### 7.7 归因与降级需要的接口

| 想知道 | 手段 |
|---|---|
| 这次摘要调用**实际返回了什么**（成功时） | 覆盖 `summarize()` 时自己读返回值的 `rawOutput`（`:331`） |
| **失败时**上有什么（最重要） | `llm/stream` waterfall 自记 chunk（§5.3）；或 `compaction/summary-error` 的 payload（含 `error` / `shadowedSeqs` / `session`） |
| 每个分块的失败原因 | `engine.js:304` 已有 `warn`，但只在日志里。若要给状态页用，需自己存进 `doctorStats`（**目前没有**） |
| 上游 usage / 是否被 token 上限截断 | `finishError`（`compaction-basic:357-369`）：`MAX_TOKENS` 错误 vs `LlmError`（含 provider code）已经区分开了；透传 `error.code` 即可 |
| provider 是官方还是网关 | §6 的 `declared` |

---

## §8 本插件的引擎**必须**怎么做（≤15 行）

1. `collectText` / `withMergedText` 改读 **`output.summary`（数组）或 `output.rawOutput`（数组）**，按 `block.type === 'text'` 过滤后再 `text.trim().length > 0`；**永不**依赖 `output.blocks` / `output.text` / `summary`-as-string。
2. 分块前用 `plan.js:69` 的 **`summaryRequestBudget`**（不是 `summaryBudget`）；把 `lib/engine.js:269` 与 `:422` 改过来，并给 `_numbersFor` 传 `summaryHardMargin`。
3. 选区必须**排除 node 0**：`selectIndexRange(..., { firstIndex: systemHead(session, nodes[0]) ? 1 : 0 })`，并在 `_trimToBalancedCuts` 里兜底 `startIndex = Math.max(startIndex, hasSystemHead ? 1 : 0)`。
4. 候选分块必须在发请求**前**用「适配器口径」自检可达性（`resolvedModel.contextWindow - maxTokens - margin`），不可达就缩小分块或换 summarizer，**绝不让注定被拒的请求出网**。
5. 摘要请求的 `maxTokens` **不要沿用 65536**：取 `min(config.maxTokens, resolvedModel.maxTokens ?? ∞)`，并对被拒的调用做一次降档重试（65536 → 16384 → 8192）。
6. 摘要调用**显式带 `reasoningEffort: 'off'`**（若该模型支持），避免思考吃掉全部输出预算导致 `MAX_TOKENS` 或只剩 reasoning 块。
7. 分块失败要**退让**（更小的块 / 更低的 maxTokens / 去掉 `tools`），而不是整次放弃；`firstError` 必须上浮，不要用兜底文案把它盖成"无文本"。
8. 保留一条**不依赖摘要**的降级路径：至少做 `tool/result` 级 prune（照 `dsh-compaction-tool-result-pruner` 的 `op:'replace', startSeq===endSeq` 形状），**保证每次尝试都让 `surface.replaceGeneration` 前进**，否则 `agent/request-error` 永远不会 `{kind:'retry'}`，400 必然上浮。
9. `context-overflow` 触发时对齐官方：prune → 重测 → `retainTokens = 0`，且**不要**套用压力路径的阈值判断。
10. 预算口径统一到官方那条线：`O = requestHeader().config.maxTokens ?? info.defaultMaxTokens ?? 0`，`H = headroomTokens`，`threshold = floor(min(W*ratio, (W-O)-H))`；本插件自算的 `W*0.9` 只能作为**更紧**的上界，不能作为唯一口径。
11. 替换事件永远满足：`surfaceOp` **恰好 3 个键**、`startSeq < event.seq`、`endSeq < event.seq`、两个 seq 都在**当前** `session.surface.nodes` 里、`startSeq !== endSeq` 时 `sourceEventSeqs` **写全**全部 `shadowedSeqs`（外加 `compaction/start`、`compaction/summary`）。
12. 用 `ctx.tokenMeter.estimateMessage(checkpointMessage)` 自查「摘要是否真的更小」（官方 `:600-601` 的判据），别只信估算出来的 shadowed 计数。
13. 只要 `trigger === 'pressure'`，失败**不要**上抛（官方会吞，上抛只会把 step 打断）；只要 `trigger === 'context-overflow'`，失败必须让调用方知道，因为那是回合能否继续的唯一机会。
14. `doctorStats` 增记：每个分块的 `{index, groups, errorCode, textBlocks, reasoningBlocks, promptTokensEstimate}`，让下一次现场能直接归因（现在 `chunkCalls: 14` 这类数字只能反推）。
15. 改完必须用同一网关复现一次三分类：① 区域能装下 → 单块直通；② 区域需分块且每块可达 → 合并成功且 `chunkedRegions +1`；③ 某块不可达 → 降档并**让 generation 前进**。
