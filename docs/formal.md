# 形式化规格：设置页开关（v0.4.1）

本文用状态机 + 不变量 + 证明的方式描述「一个开关」这条链路，取代"多试几次看还崩不崩"。
第 6 节把每条不变量映射到**可执行的穷尽检验**（`test/model/check.mjs`）。

记号：`⊤`=开，`⊥`=关，`∅`=未知，`ℕ`=自然数，`δ`=状态转移函数，`s →* s'`=有限步转移可达。

---

## 1. 抽象层与忠实性声明

**M-1（抽象）**：浏览器半侧的全部行为被抽象为 7 元组

```
s = (E, P, R, V, F, K, T)
```

| 分量 | 域 | 含义 | 从真实代码的哪里读出来 |
|---|---|---|---|
| `E` | `{⊤, ⊥, ∅}` | 页面已知的开关值 | `view.enabled`（`applyState` 的三态归一化） |
| `P` | `{0,1}` | 是否有写在途（busy） | `pending` |
| `R` | `{0,1,2}` | 剩余回读预算 | `MAX_RETRY - attempt` |
| `V` | `{readable, failed}` | 最近一次读是否可用 | `view.failed` |
| `F` | `{0,1}` | 宿主半侧是旧版本（`ok:true` 但 `enabled` 不是布尔） | `view.stale` |
| `K` | 8 个键 | 状态行文案键 | 优先级 `failed > stale > auto.*` |
| `T` | `ℕ` | 虚拟时钟（毫秒） | `Date.now()` 的注入替身 |

**M-2（可观测性）**：`s` 的每个分量都由 `lib/client.js` 渲染出的 DOM（`disabled` 属性、状态行文本、`checked`）唯一决定；检验器只读 DOM 与请求日志，不读内部变量。因此"检验器观察到的状态 = 用户看到的状态"。

**M-3（事件字母表）**：`Σ = { mount_ok(b), mount_stale, mount_fail, click, write_ok, write_fail, write_hang, rb_ok(b), rb_fail, tick(Δ), unmount }`，其中 `b ∈ {⊤,⊥}`。`δ` 完全由真实代码决定（检验器不重写转移，只驱动）。

**M-4（有界穷尽）**：对深度 `D` 内的**所有**事件串 `w ∈ Σ^{≤D}` 求可达状态集，即对状态图做 BFS 并按抽象状态 `s` **去重**（等价事件串折叠为同一结点；这一步把 `|Σ|^D` 压成实际可达状态数）。检查每个可达状态的不变量。这是对抽象 `s` 的穷尽验证；未被建模的部分在第 7 节列出。

---

## 2. 宿主侧模型（代数，非状态机）

**M-5（四层配置格）**：`enabled` 的有效值由四层按序覆盖：

```
defaults  <  engineRow  <  probeRow  <  store
```

- `defaults`：`DOCTOR_DEFAULTS.enabled = false`
- `engineRow` / `probeRow`：`compaction-doctor-engine` / `compaction-doctor` 两行的 `config`
- `store`：`<profile>/compaction-doctor.state.json`（构造函数里 `readSwitchState()` 覆盖 `this.config.enabled`）

**M-6（写路径）**：`PUT /config {enabled: b}`
1. `setEnabled(b)`：先 `this.config.enabled ← b`（内存），再 `writeSwitchState(b)`（`tmp` 写入 + `rename`）
2. 不触碰 profile 补丁，不依赖任何热重载

---

## 3. 不变量

| 编号 | 陈述 |
|---|---|
| **I1** | 开关不可点 ⇒ `P=1 ∨ F=1`（只有两个原因；`E∈{⊤,⊥}` 且 `P=0` 时必须可点） |
| **I2** | `P=1` 是有界的：从任意状态出发，在 `≤ 8000 + 3000` 毫秒虚拟时间且无新写的情况下必然到达 `P=0` |
| **I3** | 显示一致性：最后一次读成功并报告 `b` 之后，`E=b`，除非此刻正有一次乐观写在途（`P=1`）；**豁免**：读取从未成功过（`V=failed`）时 `E=∅` 不算说谎 |
| **I4** | 收敛性：`write_ok` 之后的回读序列结束时，`E` 等于宿主最后报告的值（页面不可能长期说谎） |
| **I5** | 读有界：一次点击引发的读次数 `≤ 1+R₀`（`R₀≤2`）；若首次回读即一致则 `=1` |
| **I6** | 计时器卫生：静默态（`P=0` 且无在途回读）下已挂载的计时器数 `=0` |
| **I7** | 宿主后置条件：`PUT {enabled:b}` 返回后，任意后续 `GET /state` 都返回 `b`（旧值不可再被读到） |
| **I8** | 存储忠实性：`readSwitchState() ∈ {undefined, ⊤, ⊥}`，且 `undefined` 表示"无意见"，**不得**被当作 `⊥`；写入是原子的（任一单点故障后，存储是旧值或新值，不存在半截 JSON） |
| **I9** | 优先级定理：若 `store` 给出布尔值，则有效值 = `store`（用户的点击是格的唯一极大元） |
| **I10** | 引擎可见性：`enabled ∈ DOCTOR_OWNED_KEYS` ⇒ 开关的变化在同一进程内立即被 `CompactionDoctorEngine.doctorConfig()` 读到（不需要重启） |
| **I11** | 合并是格并：任意层级合并处，**「无意见」不得覆盖**。形式地，`merge(a,b)[k] = b[k]` 当 `b[k] ∈ {undefined, null}` 时必须等于 `a[k]`。对象展开 `{...a,...b}` **不满足**此性质（`{...{a:1},...{a:undefined}}` 得 `a=undefined`），因此每一处合并必须用 `mergeDefined()` |

---

## 4. 证明

**I1**：`disabled` 的定义在 `lib/client.js` 中是 `pending === true || view.stale === true`（结构性：只有这两个析取项）。`E` 不进该表达式 ⇒ 当 `P=0 ∧ F=0` 时 `disabled=false`。∎

**I2**：写入由 `guard(request, WRITE_TIMEOUT_MS=8000)` 包裹，`guard` 在计时器到点时强制兑现结果；兑现路径（成功/失败/超时）统一进入回读，回读本身也被 `guard` 包裹且带 `SETTLE_TOTAL_MS=3000` 的总时限，回读的每个出口都执行 `setPending(false)`。两条时限都只依赖于 `tick`，与网络无关 ⇒ 上界 `8000+3000`。∎

**I3**：`applyState(b)` 是 `E` 的唯一非乐观写入口（除 `click` 的乐观置值），且它只在 `res.ok===true ∧ enabled∈{⊤,⊥}` 时调用。`click` 只把 `E` 置为 `¬E` 并同时置 `P=1`，故例外项恰为 `P=1`。第二条豁免由检验器发现：读从未成功时 `E=∅`（页面显示"读不到"），此时显示的不是任何**宿主报告过的值**，按字面定义会被判为违反，但语义上它是"无信息"而非"错值"。故规格补上该豁免——这是**规格的缺陷**（原命题过强），不是实现的缺陷。∎

**I4**：由 I7，`write_ok` 之后宿主的真实值恒为 `b`；回读要么在 `≤1+R₀` 次内读到 `b`（置 `E=b`），要么耗尽预算后执行最后一次 `applyState`（把宿主的当前真值写入 `E`，而不是保留乐观值）。两条出口都以 `E = 宿主值` 结束。∎

**I5**：`R` 只在 `write_ok` 分支被初始化为 `MAX_RETRY=2`；超时/非 2xx/`ok:false`/网络异常一律 `R₀=0`。每次重试消耗一个 `R`，`R` 单调递减且无环 ⇒ 读次数 `≤ 1+R₀`。首次回读一致时立即返回 ⇒ `=1`。∎

**I6**：所有 `setTimeout` 句柄登记进 `timersRef`，每个兑现路径先 `clearTimeout`；`unmount` 遍历清空。静默态意味着没有在途请求，也就没有对应的未清计时器。∎（由检验器对"静默可达状态"断言 `timers=0`）

**I7**：`writeConfigPatch({enabled:b})` 的第一个动作是 `await this.setEnabled(b)`，其第一步是同步赋值 `this.config.enabled = b`；`stateSnapshot()` 返回 `enabled: this.config.enabled === true`，直接读该字段。若文件写入失败，`setEnabled` 仍返回 `ok:true`（内存已生效），故后置条件与 I/O 结果无关。∎

**I8**：读取用 `JSON.parse` 且 `typeof parsed.enabled === "boolean"` 才返回；任何异常（文件不存在、半截 JSON、权限）都返回 `undefined`。写入用 `writeFileSync(tmp)` + `renameSync(tmp, file)`；`rename` 在同一文件系统上是原子的，读者只可能看到旧 inode 或新 inode。失败路径 `rmSync(tmp)` 清理临时文件 ⇒ 不存在半截文件。`undefined` 与 `⊥` 在类型层面不同（`boolean` vs `undefined`），构造函数用 `typeof stored === "boolean"` 判定，故"无意见"不会变成"关"。∎

**I9**：`normalizeConfig` 先展开 `DOCTOR_DEFAULTS`，再展开行 `config`（后者覆盖前者）；构造函数随后执行 `if (typeof stored === "boolean") this.config.enabled = stored`，即 `store` 是最后一个覆盖者。覆盖关系是函数复合，复合的最后一个定义域内的赋值必胜出 ⇒ 有效值 = `store`。∎

**I10**：`doctorConfig()` 逐层 `layer()` 只复制 `DOCTOR_OWNED_KEYS` 里的键；`"enabled"` 在该数组内（`lib/engine.js`）。`layer(this.config)` 读引擎行，`layer(service?.config)` 读 probe 行的 `this.config`（即带 `store` 覆盖的那个对象）⇒ 开关值进入引擎合并结果。∎

**I11**：由 `mergeDefined()` 的实现直接给出：其循环体显式跳过 `undefined` 与 `null`。原先 `probe.js` 的两处展开（`normalizeConfig`、`_policy`）不满足该性质——`_policy()` 在引擎行省略某个键（例如只在 probe 行声明的 `summaryBudgetRatio`）时会把该键覆盖成 `undefined`，随后 `_numbers()` 读到 `undefined`。这是**实现违背定理**、而非定理有误，故修实现而非改定理。∎

---

## 5. v0.4.0 故障对应的反例（已被修复）

| 现象 | 违反的不变量 | 破坏者 |
|---|---|---|
| 开关自己弹回 | **I7** | 写路径改成"重写 profile 补丁里的行"，而该行由 bundle 插入、profile 文件里不存在 ⇒ 写失败 ⇒ 回读恒得旧值；且补丁生效需要异步热重载。修复后 I7 由"内存先改"直接给出 |
| 重启后开关点不动 | **I1** | 旧宿主的 `/state` 没有 `enabled` ⇒ `E=∅`；v0.4.0 的 `disabled` 含 `E=∅` 这一项。修复后 `disabled` 只剩 `P=1 ∨ F=1`，并把"旧宿主"显式化成 `F`（`state.stale` 文案） |
| 永久忙 | **I2** | v0.4.0 的 PUT 无超时 ⇒ 挂起的 fetch 使 `P=1` 永久保持 ⇒ 违反 I2。修复后加 `guard(8000)` |

---

## 6. 机器检验义务

`test/model/check.mjs` 必须**穷尽**（不是抽样）地检验下列各项，并打印可达状态数与结论：

| 检验 | 方法 | 对应不变量 |
|---|---|---|
| BFS 全事件串（深度 `D=8`，真实 `lib/client.js` + 桩 React + 假 fetch + 虚拟时钟） | 每个可达状态断言 I1/I3/I5/I6 | I1, I3, I5, I6 |
| 从每个可达状态出发、只喂 `tick` 与 `write_ok`/`write_fail`/`write_hang` 的确定性推进 | 断言 I2 的时间上界 | I2 |
| `write_ok → rb_ok(b) → …` 全部序列 | 断言终态 `E=b` | I4 |
| 直接调用真实 `setEnabled` / `writeConfigPatch` / `readSwitchState` / `stateSnapshot` | 断言后置条件；`b` 与 `¬b` 两种意图都穷尽 | I7, I8 |
| 在 3 个系统调用点各注入单次故障（`mkdir`/`write`/`rename`） | 断言存储是旧值或新值、无半截、内存已生效 | I8 |
| 对 `enabled` 穷尽 4 层来源的全部组合（`2^4`）与 `store ∈ {undefined, ⊤, ⊥}` | 断言有效值与 `store` 一致 | I9 |
| 对 `DOCTOR_OWNED_KEYS` 逐键检查开关是否进入合并结果 | 断言 `doctorConfig().enabled` 跟随 probe 行 | I10 |

**检验器必须报告**：可达状态总数、事件串总数、每条不变量的判定、以及任何反例的**最短事件串**（若存在）。

---

## 7. 已知边界（抽象之外，未被检验）

1. 真实 React 调度（并发渲染、批处理）未被建模；抽象假设"一次事件一次提交"。
2. 浏览器与宿主之间的真实网络、闸门（`x-compaction-doctor` 头、`Sec-Fetch-Site`）只在假 fetch 层建模为"成功/失败"。
3. `profileDir()` 依赖环境变量；检验器在临时 `$DSH_HOME` 下运行真实函数，但不断言真实 profile 的权限语义。
4. `renameSync` 的原子性以同一文件系统为前提（`profileDir()` 内），跨设备 `rename` 未建模。
5. 深度 `D` 是有限的（`D=8`）；`D` 之外的串未被穷尽。这是本规格的最强边界条件。

---

## 8. 机器检验结果（`test/model/check.mjs`）

在 v0.4.1 + I11 修复的代码上运行（Lead 独立复跑确认，非队友自报）：

```
可达状态 618 / 转移边 4811 / 截断边 2565 / 重放事件串 31237 / 深度上界 8
合计 15 条：PASS 15，FAIL 0，SKIP 0      exit 0

同一检验器 --depth=24：可达状态 1969 / 截断边 988 / 15 条仍全 PASS / exit 0
（--depth=40 因重放缓存 OOM，属检验器自身资源上限）
```

**Chrome 边界**：`D=8` **未饱和**——2565 条被截断的边里 1107 条通往新的抽象状态，所以「深度 8 内穷尽」成立，但更深仍会产生新状态。上表给出的 `D=24` 是负向证据：多探索 3 倍深度后不变量仍无违反。真正的完备性需要状态图封闭（无截断边），当前未达到。

| 检验 | 判定 | 关键计数 |
|---|---|---|
| I1 无死开关 | PASS | 可点状态 145 个，实点 145 次全部发出 PUT；`disabled ≡ (P ∨ F)` 在 405 个挂载态成立；首帧可点且点击发 PUT |
| I2 忙有界 | PASS | 211 个 `P=1` 状态；最坏解除 11000ms（上界紧）；探索 26287 个时间-事件结点 |
| I3 显示一致性 | PASS（补豁免后） | 405 个挂载态错值 0；写途豁免 88、无值豁免 87 |
| I4 收敛 | PASS | 静默态 42 个全部不说谎；对手永远不同意时 2 轮后 `E=宿主最后报告值` |
| I5 读有界 | PASS | 单 epoch 最大回读 1（上界 3）；首次一致即收工；写失败路径恰好 1 次回读 |
| I6 计时器卫生 | PASS | 静默态 52 个、卸载态 213 个，计时器均 0 |
| I7 宿主后置条件 | PASS | `b=⊤`/`b=⊥` 各 snapshot×3 + 重载 + 磁盘一致 |
| I8 存储忠实性 | PASS | 垃圾文档 14 组 ⇒ 全部 `undefined`；`mkdir`/`write` 注入：`ok=true, persisted=false`，内存生效、无残留 tmp |
| I9 优先级定理 | PASS | 48 组穷尽：file 为布尔时 store 必胜 32 组；file 缺失时 probe 行生效 16 组；引擎行携带 `enabled` 被 schema 拒绝 48 组 |
| I10 引擎可见性 | PASS | probe 行两态 + 同进程翻转，4 次读取全部跟随（无需重启） |
| I11a 格并代数律 | PASS | 二元 64 组 + 三元 512 组 + 幂等/单位元 12 组 |
| I11b/c/d 三处真实合并点 | PASS | 下层存活 34 + 36 + 28 组；有意见逐键一致 84 组 |
| I11e 全仓展开式合并审计 | PASS | **性质型**：运行期从当前源码现取 23 个站点（零写死行号）；来源 ≥2 的展开**运行期断言键集不相交**，解析不出操作数则 SKIP。结果 22 PASS / 1 SKIP / 0 FAIL |

**检验器带来的两处修正**（都不是"多试几个用例"能得到的）：

1. **规格缺陷**：I3 原命题过强——"读从未成功 ⇒ 显示无值"按字面算违反，最短轨迹
   `mount_ok_on → click → write_ok → tick_3000`。已补豁免。
2. **实现缺陷**：`lib/probe.js:1445` 的 `editor.edit` 回调用展开合并，`patch` 里显式 `undefined` 会把行里已有键抹掉
   （`writeConfigPatch({patch:{summaryBudgetRatio: undefined}})` 可达）。HTTP/JSON 表达不了 `undefined`，
   故只有进程内调用者可达，但它违背 I11，已改用 `mergeDefined()`。

**未注入的项**：只读目录故障（本机 Windows ACL 不因 `chmod` 拒绝写入）——按规格第 7 节标注为平台限制，非遗漏。
