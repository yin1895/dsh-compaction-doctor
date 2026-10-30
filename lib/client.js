/*!
 * @local/dsh-compaction-doctor —— 浏览器半侧（settings.section: compaction）
 *
 * 契约依据（不要发明端点或字段名）：
 *  - docs/api-contract.md（冻结 v0.2）：前缀 /dsh-compaction-doctor、7 个端点、三道鉴权闸、
 *    统一失败形状 {ok:false,error}、/state 快照字段。
 *  - docs/spec-client.md：§2.1-2.4 浏览器产物契约（经典脚本 / id = 包名 / require 种子表 /
 *    factory 返回 {name,inject,apply}），§4 settings.section 注册选项（id/order/label thunk/
 *    inject），§5 视觉规范（720px、--dsw-alias-*、实心主按钮排除通用 hover），
 *    §6.1 configForms（getSnapshot/subscribe/set，软依赖），§6.5 命名空间不可用的降级分支，
 *    §6.6 页面生命周期三条硬约束（切走即卸载 / #root 之外 portal / 永不白屏）。
 *
 * 本文件是**手写产物**：无构建工具、无 JSX，全部 React.createElement；顶层只调用一次模块
 * 加载器的 load({id, factory})，既没有 import 也没有 export（经典脚本体，顶层 ESM 语法无处可写）。
 */
(function () {
  'use strict';

  window.__ModuleLoader__.load({
    // id 必须等于 package.json 的 name（spec-client §2.2：注册名只剥结尾 /client）
    id: '@local/dsh-compaction-doctor',
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;

      // -------------------------------------------------------------------
      // 0. 平台种子模块（spec-client §2.3 的白名单；不在这张表里的模块取不到）
      //    本插件只需要 react：图标走导航兜底齿轮（§5.7），不引 primitives。
      // -------------------------------------------------------------------
      var React = require('react');
      var h = React.createElement;

      // -------------------------------------------------------------------
      // 1. 常量
      // -------------------------------------------------------------------
      /** 包名：data-plugin 回收标记必须等于它（spec-client §5.5）。 */
      var PKG = '@local/dsh-compaction-doctor';
      /** locale 命名空间（spec-client §5.6：一次注册该 ns 的全部内置语言）。 */
      var NS = 'compaction-doctor.ui';
      /** 宿主半侧注册的同名前缀路由（api-contract §1：客户端只用同源相对路径）。 */
      var ROUTE = '/dsh-compaction-doctor';
      /** CSS 去重键。 */
      var CSS_TAG = PKG + '/client.css';
      /** 鉴权第一道闸：每个请求都必须带的请求头（api-contract §1）。 */
      var AUTH_HEADER = 'x-compaction-doctor';
      /** 状态卡轮询周期（api-contract §2.1：页面每 2s 一次）。 */
      var POLL_MS = 2000;
      /** 设置命名空间 = profile 行的 id（spec-host §3.8；cordis.patch.yml 的两条行 id）。 */
      var NS_DOCTOR = 'compaction-doctor';
      var NS_ENGINE = 'compaction-doctor-engine';

      // -------------------------------------------------------------------
      // 2. 文案字典（zh 为键集来源，en 严格同键）
      //    注册期缺语言 / 多键 / 少键都会直接抛错（spec-client §5.6），
      //    所以两个对象的键集必须完全相等（提交前用一次性脚本断言）。
      // -------------------------------------------------------------------
      var zh = {
        nav: '上下文压缩',
        title: '上下文压缩',
        intro: '诊断并修复模型上下文窗口配置，查看压缩引擎的参数与运行状态。',

        // 通用
        copy: '复制结论',
        copied: '已复制',
        copyFailed: '复制失败，请手动选择文本复制',
        unknown: '—',
        on: '开',
        off: '关',

        // 卡片标题
        'card.diag': '一键诊断',
        'card.fix': '一键修复',
        'card.engine': '引擎参数',
        'card.state': '运行状态',
        'card.backup': '备份与还原',

        // 诊断卡
        'diag.hint': '读取当前路由、配置声明的窗口与已观测到的最大接受 prompt，给出结论与修复建议。',
        'diag.run': '开始诊断',
        'diag.running': '诊断中…',
        'diag.active': '附带一次真实边界探测',
        'diag.activeNote': '真实探测会向 provider 发请求并消耗额度；默认只用已有会话证据推断。',
        'diag.empty': '尚未诊断。点「开始诊断」后这里显示结论。',
        'diag.summary': '结论',
        'diag.route': '路由',
        'diag.configured': '配置声明',
        'diag.decision': '判定',
        'diag.observed': '观测到的最大接受 prompt',
        'diag.observedNone': '（暂无观测证据）',
        'diag.candidates': '候选来源',
        'diag.rationale': '依据',

        // 修复卡
        'fix.hint': '把「配置声明的能力值」写回模型窗口配置：先备份再写，写前必须二次确认（confirm:true）。',
        'fix.none': '先做一次诊断，本卡由诊断结论中的 proposed 驱动。',
        'fix.noChange': '无需修复：配置已与判定值一致。',
        'fix.preview': '变更预览',
        'fix.apply': '应用修复',
        'fix.applying': '应用中…',
        'fix.confirmNote': '只写配置声明的能力值，绝不把单会话观测值当模型能力写入。',
        'fix.applied': '已应用修复，备份：{backup}',
        'fix.hotReload': '宿主已热重载',
        'fix.verify': '正在自动重跑一次诊断以验证闭环…',
        'fix.field.contextWindow': '上下文窗口',
        'fix.field.maxTokens': '最大输出',
        'fix.unchanged': '（不变）',

        // 引擎参数卡
        'engine.hint': '优先走官方设置命名空间（revision 乐观锁 + 变更推送）；命名空间不可用时降级到 {route}/config。',
        'engine.source': '数据来源',
        'engine.source.forms': '设置命名空间',
        'engine.source.http': '{route}/config（降级）',
        'engine.source.loading': '读取中…',
        'engine.revision': '配置版本 {revision}',
        'engine.readonly': '该配置当前不可写（writable=false），只能查看。',
        'engine.empty': '未读到任何字段：命名空间与 {route}/config 都不可用。',
        'engine.saved': '已写入',
        'engine.saveFailed': '写入被拒绝，已刷新为宿主最新值。',
        'engine.invalid': '数值非法，未提交。',
        'engine.reload': '重新读取',
        'engine.mode.meter': 'meter（真实计费口径）',
        'engine.mode.real': 'real（节点启发式口径）',

        // 12 个字段标签（api-contract §2.4：doctor 拥有的字段集合）
        'field.enabled': '启用诊断',
        'field.probeOnStart': '启动时自动探测',
        'field.writeConfig': '允许写回配置',
        'field.scaleMode': '缩放基准',
        'field.maxSummaryChunks': '分块上限',
        'field.tokensPerByte': '每字节 token 估值',
        'field.summaryBudgetRatio': '摘要预算比',
        'field.selectCapRatio': '选择上限比',
        'field.overflowRecovery': '溢出恢复',
        'field.capMaxTokens': '输出上限夹取',
        'field.thresholdRatio': '压缩阈值比',
        'field.retainRatio': '保留比',

        // 状态卡
        'state.hint': '每 2 秒轮询 {route}/state；离开本栏即停止。',
        'state.waiting': '等待宿主状态…',
        'state.unavailable': '宿主能力未就绪：{message}',
        'state.pressure': '压力',
        'state.threshold': '压缩阈值',
        'state.ratio': '压力/阈值',
        'state.window': '上下文窗口',
        'state.maxOutput': '输出上限',
        'state.scale': '缩放系数',
        'state.scaleMode': '缩放基准',
        'state.nodes': '节点数',
        'state.surface': '节点口径 token',
        'state.retainBudget': '保留预算 token',
        'state.messageBudget': '消息预算 token',
        'state.headroom': '头部预留 token',
        'state.rescaled': '处于压缩缩放窗口内',
        'state.lastCompaction': '最近一次压缩',
        'state.never': '（暂无）',
        'state.trigger.pressure': '压力触发',
        'state.trigger.context-overflow': '上下文溢出',
        'state.trigger.manual': '手动',
        'state.trigger.unknown': '未知触发',
        'state.shadowed': '遮蔽',
        'state.range': '区间',
        'state.guard': '守卫失败',
        'state.guardNone': '无失败记录',
        'state.meter': '缩放补丁',
        'state.meterYes': '已挂载',
        'state.meterNo': '未挂载',
        'state.writeConfig': '写回配置',
        'state.contradiction': '配置矛盾',
        'state.contradictionYes': '是',
        'state.contradictionNo': '否',
        'state.session': '会话',
        'state.counters': '引擎计数（摘要 {summary} · 分块 {chunked} · 合并 {merges}）',

        // 备份卡
        'backup.hint': '只列出 profile 目录下的 {pattern} 系列文件（最多 50 条，按时间倒序）。',
        'backup.loading': '读取备份列表…',
        'backup.empty': '暂无备份文件。',
        'backup.reload': '刷新列表',
        'backup.restore': '还原',
        'backup.confirm': '确认还原',
        'backup.cancel': '取消',
        'backup.confirmHint': '还原会用该备份覆盖当前的 cordis.patch.yml（还原前宿主会再备份一次现场文件）。',
        'backup.done': '已还原：{restored}（还原前备份：{backup}）',
        'backup.restoring': '还原中…',

        // 失败文案（统一走这里，绝不抛错、绝不白屏）
        'err.network': '请求失败：{message}',
        'err.http': '请求失败（HTTP {status}）：{message}',
        'err.forbidden': '请求被拒绝（403）：宿主的同源 / 自定义头闸门未通过。',
        'err.hostNotReady': '宿主能力未就绪：{message}',
        'err.empty': '宿主未返回可用文案',
      };

      var en = {
        nav: 'Context compaction',
        title: 'Context compaction',
        intro: 'Diagnose and repair the model context window configuration, and inspect the compaction engine.',

        copy: 'Copy report',
        copied: 'Copied',
        copyFailed: 'Copy failed — select the text and copy it manually',
        unknown: '—',
        on: 'on',
        off: 'off',

        'card.diag': 'Diagnosis',
        'card.fix': 'Repair',
        'card.engine': 'Engine parameters',
        'card.state': 'Runtime status',
        'card.backup': 'Backups',

        'diag.hint': 'Reads the current route, the configured window and the largest prompt observed so far, then reports conclusions and a repair suggestion.',
        'diag.run': 'Run diagnosis',
        'diag.running': 'Diagnosing…',
        'diag.active': 'Include one live boundary probe',
        'diag.activeNote': 'A live probe sends a provider request and consumes quota; by default only existing session evidence is used.',
        'diag.empty': 'Not diagnosed yet. Press “Run diagnosis” to get conclusions here.',
        'diag.summary': 'Conclusion',
        'diag.route': 'Route',
        'diag.configured': 'Configured',
        'diag.decision': 'Decision',
        'diag.observed': 'Largest accepted prompt observed',
        'diag.observedNone': '(no observation yet)',
        'diag.candidates': 'Candidate sources',
        'diag.rationale': 'Rationale',

        'fix.hint': 'Writes the profile-declared capability values back to the model window config: backup first, then write, and the write requires explicit confirmation (confirm:true).',
        'fix.none': 'Run a diagnosis first — this card is driven by the proposed values it returns.',
        'fix.noChange': 'Nothing to repair: the configuration already matches the decision.',
        'fix.preview': 'Change preview',
        'fix.apply': 'Apply repair',
        'fix.applying': 'Applying…',
        'fix.confirmNote': 'Only configured capability values are written; single-session observations are never treated as model capability.',
        'fix.applied': 'Repair applied. Backup: {backup}',
        'fix.hotReload': 'host hot-reloaded',
        'fix.verify': 'Re-running the diagnosis once to confirm the loop…',
        'fix.field.contextWindow': 'Context window',
        'fix.field.maxTokens': 'Max output',
        'fix.unchanged': '(unchanged)',

        'engine.hint': 'Prefers the official settings namespace (revision lock + change push); falls back to {route}/config when the namespace is unavailable.',
        'engine.source': 'Source',
        'engine.source.forms': 'settings namespace',
        'engine.source.http': '{route}/config (fallback)',
        'engine.source.loading': 'loading…',
        'engine.revision': 'Revision {revision}',
        'engine.readonly': 'This configuration is read-only right now (writable=false); values are displayed only.',
        'engine.empty': 'No field could be read: neither the namespace nor {route}/config is available.',
        'engine.saved': 'Written',
        'engine.saveFailed': 'The write was rejected; values were refreshed from the host.',
        'engine.invalid': 'Invalid number — not submitted.',
        'engine.reload': 'Reload',
        'engine.mode.meter': 'meter (real billing scale)',
        'engine.mode.real': 'real (node heuristic scale)',

        'field.enabled': 'Enable diagnosis',
        'field.probeOnStart': 'Probe on start',
        'field.writeConfig': 'Allow config write-back',
        'field.scaleMode': 'Scale mode',
        'field.maxSummaryChunks': 'Max summary chunks',
        'field.tokensPerByte': 'Tokens per byte',
        'field.summaryBudgetRatio': 'Summary budget ratio',
        'field.selectCapRatio': 'Select cap ratio',
        'field.overflowRecovery': 'Overflow recovery',
        'field.capMaxTokens': 'Max tokens cap',
        'field.thresholdRatio': 'Compaction threshold ratio',
        'field.retainRatio': 'Retain ratio',

        'state.hint': 'Polls {route}/state every 2 seconds; stops when you leave this section.',
        'state.waiting': 'Waiting for host state…',
        'state.unavailable': 'Host capability unavailable: {message}',
        'state.pressure': 'Pressure',
        'state.threshold': 'Compaction threshold',
        'state.ratio': 'Pressure / threshold',
        'state.window': 'Context window',
        'state.maxOutput': 'Max output',
        'state.scale': 'Scale factor',
        'state.scaleMode': 'Scale mode',
        'state.nodes': 'Nodes',
        'state.surface': 'Node-scale tokens',
        'state.retainBudget': 'Retain budget tokens',
        'state.messageBudget': 'Message budget tokens',
        'state.headroom': 'Headroom tokens',
        'state.rescaled': 'inside a compaction scale window',
        'state.lastCompaction': 'Last compaction',
        'state.never': '(none)',
        'state.trigger.pressure': 'pressure',
        'state.trigger.context-overflow': 'context overflow',
        'state.trigger.manual': 'manual',
        'state.trigger.unknown': 'unknown trigger',
        'state.shadowed': 'shadowed',
        'state.range': 'range',
        'state.guard': 'Guard failures',
        'state.guardNone': 'no failures recorded',
        'state.meter': 'Scale patch',
        'state.meterYes': 'installed',
        'state.meterNo': 'not installed',
        'state.writeConfig': 'Config write-back',
        'state.contradiction': 'Config contradiction',
        'state.contradictionYes': 'yes',
        'state.contradictionNo': 'no',
        'state.session': 'Session',
        'state.counters': 'Engine counters (summaries {summary} · chunked {chunked} · merges {merges})',

        'backup.hint': 'Lists only {pattern} files in the profile directory (up to 50, newest first).',
        'backup.loading': 'Loading backups…',
        'backup.empty': 'No backup files yet.',
        'backup.reload': 'Refresh list',
        'backup.restore': 'Restore',
        'backup.confirm': 'Confirm restore',
        'backup.cancel': 'Cancel',
        'backup.confirmHint': 'Restoring overwrites the current cordis.patch.yml with this backup (the host backs the current file up first).',
        'backup.done': 'Restored: {restored} (pre-restore backup: {backup})',
        'backup.restoring': 'Restoring…',

        'err.network': 'Request failed: {message}',
        'err.http': 'Request failed (HTTP {status}): {message}',
        'err.forbidden': 'Request rejected (403): the host same-origin / custom-header gate did not pass.',
        'err.hostNotReady': 'Host capability unavailable: {message}',
        'err.empty': 'the host returned no readable message',
      };

      // -------------------------------------------------------------------
      // 3. 内联 CSS
      //    官方做法 = style[data-plugin-css=…] 去重 + style[data-plugin=<包名>] 供模块系统
      //    在 entry 拆除时回收（spec-client §5.5）。视觉 token 全走 --dsw-alias-*（§5.2）。
      // -------------------------------------------------------------------
      var CSS = [
        // 根容器：官方内容列宽度 = 720px；容器查询而非媒体查询（§5.1/§5.4）
        '.dsh-cdoc{max-width:720px;min-width:0;container-type:inline-size;display:flex;flex-direction:column;gap:12px;',
        'color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
        '.dsh-cdoc__title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
        '.dsh-cdoc__intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',

        // 卡片
        '.dsh-cdoc__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;',
        'border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);',
        'border-radius:var(--dsw-radius-xl,20px);min-width:0}',
        '.dsh-cdoc__cardHead{display:flex;align-items:center;gap:8px;min-height:20px;flex-wrap:wrap}',
        '.dsh-cdoc__cardTitle{font-size:13px;font-weight:500}',
        '.dsh-cdoc__spacer{margin-left:auto}',

        // 行 / 键值 / 说明
        '.dsh-cdoc__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
        '.dsh-cdoc__kv{display:inline-flex;align-items:baseline;gap:4px;min-width:0;font-size:12px;line-height:18px;',
        'color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;word-break:break-word}',
        '.dsh-cdoc__kvLabel{color:var(--dsw-alias-label-tertiary)}',
        '.dsh-cdoc__note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-word}',
        '.dsh-cdoc__note.is-err{color:var(--dsw-alias-state-error-primary)}',
        '.dsh-cdoc__msg{margin-left:4px;font-size:12px;color:var(--dsw-alias-state-success-primary);word-break:break-word}',
        '.dsh-cdoc__msg.is-err{color:var(--dsw-alias-state-error-primary)}',

        // 多行结论（空白保留，可选中复制）
        '.dsh-cdoc__pre{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;',
        'background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);',
        'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;font-size:12px;line-height:18px;',
        'white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;user-select:text}',

        // 按钮（普通 / 实心主按钮 / 危险 / 小号）
        '.dsh-cdoc__btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;',
        'color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 14px;font:inherit;font-size:12px;',
        'line-height:20px;cursor:pointer;white-space:nowrap}',
        // 实心主按钮必须排除在通用 hover 之外：interactive-bg-hover 是半透明白，会顶掉 button-info-fill，
        // 让蓝色按钮一悬停就发白（spec-client §5.3 的关键陷阱）。
        '.dsh-cdoc__btn:hover:not(:disabled):not(.is-primary){background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsh-cdoc__btn:disabled{opacity:.5;cursor:default}',
        '.dsh-cdoc__btn.is-primary{border-color:var(--dsw-alias-button-info-fill);',
        'background:var(--dsw-alias-button-info-fill);color:#fff}',
        '.dsh-cdoc__btn.is-primary:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);',
        'background:var(--dsw-alias-button-info-hover)}',
        '.dsh-cdoc__btn.is-danger{border-color:var(--dsw-alias-state-error-secondary);',
        'color:var(--dsw-alias-state-error-primary)}',
        '.dsh-cdoc__btn.is-sm{padding:2px 10px}',
        '.dsh-cdoc__btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid',
        'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',

        // 开关
        '.dsh-cdoc__toggle{display:inline-flex;align-items:center;gap:6px;min-width:0;cursor:pointer}',
        '.dsh-cdoc__toggle input[type=checkbox]{flex:none;width:16px;height:16px;margin:0;',
        'accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
        '.dsh-cdoc__toggle input[type=checkbox]:disabled{cursor:default}',

        // 输入 / 下拉
        '.dsh-cdoc__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;',
        'border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);',
        'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
        '.dsh-cdoc__inp:focus{border-color:var(--dsw-alias-state-business-primary)}',
        '.dsh-cdoc__inp:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
        '.dsh-cdoc__inp.is-select{cursor:pointer;appearance:auto}',

        // 状态圆点
        '.dsh-cdoc__dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;',
        'background:var(--dsw-alias-state-idle-primary)}',
        '.dsh-cdoc__dot.is-warn{background:var(--dsw-alias-state-warn-primary)}',
        '.dsh-cdoc__dot.is-err{background:var(--dsw-alias-state-error-primary)}',
        '.dsh-cdoc__dot.is-ok{background:var(--dsw-alias-state-success-primary)}',

        // 引擎参数字段栅格
        '.dsh-cdoc__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}',
        '.dsh-cdoc__field{display:flex;flex-direction:column;gap:4px;min-width:0}',
        '.dsh-cdoc__flabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}',

        // 备份列表
        '.dsh-cdoc__list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto}',
        '.dsh-cdoc__item{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;',
        'border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
        '.dsh-cdoc__itemName{flex:1 1 220px;min-width:0;font-size:12px;line-height:18px;user-select:text;',
        'color:var(--dsw-alias-label-secondary);word-break:break-all}',
        '.dsh-cdoc__itemMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);',
        'font-variant-numeric:tabular-nums;white-space:nowrap}',
        // 二次确认那行提示独占一行（列表项是 flex-wrap 容器）
        '.dsh-cdoc__item .dsh-cdoc__note{flex:1 1 100%;margin:2px 0 0}',

        // 容器查询：内容栏变窄时收成单列（不用媒体查询，spec-client §5.4）
        '@container (max-width:520px){.dsh-cdoc__grid{grid-template-columns:minmax(0,1fr)}}',
        '@container (max-width:420px){.dsh-cdoc__itemName{flex-basis:100%}}',
      ].join('');

      /** 注入本包样式表（幂等；data-plugin 必须等于包名，否则热替换后残留）。 */
      function ensureCss() {
        if (typeof document === 'undefined') return;
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') !== null) return;
        var tag = document.createElement('style');
        tag.dataset.plugin = PKG;
        tag.dataset.pluginCss = CSS_TAG;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }

      // -------------------------------------------------------------------
      // 4. 小工具
      // -------------------------------------------------------------------

      /** locale 文案的 {name} 插值；缺参数时原样保留占位符。 */
      function fill(text, vars) {
        return String(text).replace(/\{(\w+)\}/g, function (m, key) {
          var value = vars ? vars[key] : undefined;
          return value === undefined ? m : String(value);
        });
      }

      function isNum(value) {
        return typeof value === 'number' && isFinite(value);
      }

      function isObj(value) {
        return value !== null && typeof value === 'object';
      }

      /** 人类可读的字节数（备份卡用；locale 无关）。 */
      function fmtBytes(value) {
        if (!isNum(value)) return '—';
        if (value < 1024) return String(value) + ' B';
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
        return (value / (1024 * 1024)).toFixed(1) + ' MB';
      }

      /** ISO 时间 → 本地时间字符串；解析不了就原样返回。 */
      function fmtTime(value) {
        if (typeof value !== 'string' || value === '') return '—';
        var ms = Date.parse(value);
        if (!isFinite(ms)) return value;
        try {
          return new Date(ms).toLocaleString();
        } catch (error) {
          return value;
        }
      }

      function pct(part, whole) {
        if (!isNum(part) || !isNum(whole) || whole <= 0) return '—';
        return String(Math.round((part / whole) * 100)) + '%';
      }

      /**
       * 统一请求入口（api-contract §1）：
       *  - 同源相对路径，绝不拼绝对主机；
       *  - 每个请求都带自定义头 x-compaction-doctor: 1（第一道闸）；
       *  - 写操作自动 Content-Type: application/json；
       *  - 永不抛错：网络异常也解析成一个统一的失败形状。
       */
      function api(path, options) {
        var opts = options || {};
        var headers = { accept: 'application/json' };
        headers[AUTH_HEADER] = '1';
        var init = { method: opts.method || 'GET', headers: headers, credentials: 'same-origin' };
        if (opts.json !== undefined) {
          headers['content-type'] = 'application/json';
          init.body = JSON.stringify(opts.json);
        }
        if (opts.signal !== undefined) init.signal = opts.signal;
        return fetch(ROUTE + path, init).then(function (res) {
          return res.json().catch(function () { return null; }).then(function (body) {
            return { ok: res.ok === true && isObj(body) && body.ok === true, status: res.status, body: body };
          });
        }).catch(function (error) {
          return {
            ok: false,
            status: 0,
            body: { ok: false, error: String((error && error.message) || error) },
          };
        });
      }

      /** 把任何失败响应翻成本地化红字（绝不抛错）。 */
      function errorText(t, res) {
        var body = res && res.body;
        if (!res || res.status === 0) {
          return fill(t('err.network'), { message: (isObj(body) && body.error) || 'network error' });
        }
        if (res.status === 403) return t('err.forbidden');
        if (isObj(body) && body.unavailable === true) {
          return fill(t('err.hostNotReady'), { message: body.message || body.error || res.status });
        }
        var message = isObj(body) && (body.error || body.message);
        return fill(t('err.http'), { status: res.status, message: message || t('err.empty') });
      }

      // -------------------------------------------------------------------
      // 5. 引擎参数面（spec-client §6.1 / §6.5 + api-contract §0 / §2.4）
      //
      //    通道优先级：
      //      ① ctx.configForms.get('<行 id>')（软依赖）→ getSnapshot() 读、set(field,value) 写；
      //      ② 命名空间 status:'unavailable' 或 configForms 缺失 → GET /config · PUT /config。
      //    行 id 与字段归属：探针行 compaction-doctor 持有 enabled/probeOnStart/writeConfig/
      //    scaleMode/maxSummaryChunks/tokensPerByte/summaryBudgetRatio/capMaxTokens；
      //    引擎行 compaction-doctor-engine 持有 selectCapRatio/overflowRecovery/
      //    thresholdRatio/retainRatio（见 cordis.patch.yml 与 lib/engine.js:DOCTOR_DEFAULTS）。
      // -------------------------------------------------------------------
      var FIELDS = [
        { key: 'enabled', kind: 'bool', ns: NS_DOCTOR },
        { key: 'probeOnStart', kind: 'bool', ns: NS_DOCTOR },
        { key: 'writeConfig', kind: 'bool', ns: NS_DOCTOR },
        { key: 'scaleMode', kind: 'enum', options: ['meter', 'real'], ns: NS_DOCTOR },
        { key: 'maxSummaryChunks', kind: 'int', min: 1, max: 24, step: 1, ns: NS_DOCTOR },
        { key: 'tokensPerByte', kind: 'num', min: 0, step: 0.01, ns: NS_DOCTOR },
        { key: 'summaryBudgetRatio', kind: 'num', min: 0, max: 1, step: 0.01, ns: NS_DOCTOR },
        { key: 'selectCapRatio', kind: 'num', min: 0, max: 1, step: 0.01, ns: NS_ENGINE },
        { key: 'overflowRecovery', kind: 'bool', ns: NS_ENGINE },
        { key: 'capMaxTokens', kind: 'int', min: 1024, step: 1024, ns: NS_DOCTOR },
        { key: 'thresholdRatio', kind: 'num', min: 0, max: 1, step: 0.01, ns: NS_ENGINE },
        { key: 'retainRatio', kind: 'num', min: 0, max: 1, step: 0.01, ns: NS_ENGINE },
      ];

      /** 数字 / 整数输入的解析；非法返回 undefined（不提交）。 */
      function parseFieldValue(field, text) {
        var raw = String(text === undefined || text === null ? '' : text).trim();
        if (raw === '') return undefined;
        if (field.kind === 'int') {
          var int = Number(raw);
          if (!isFinite(int)) return undefined;
          return Math.round(int);
        }
        if (field.kind === 'num') {
          var num = Number(raw);
          if (!isFinite(num)) return undefined;
          return num;
        }
        return raw;
      }

      /** 一个命名空间快照是否已就绪可用。 */
      function usable(snapshot) {
        return isObj(snapshot) && snapshot.status === 'ready' && isObj(snapshot.value);
      }

      /**
       * 聚合两个命名空间的快照：按 FIELDS 的归属把顶层标量抄出来。
       * 返回 null = 仍在 loading（骨架屏）；ready:false = 全部 unavailable（应降级 HTTP）。
       */
      function mergeSnapshots(controllers) {
        var value = {};
        var writable = true;
        var revision;
        var any = false;
        var pending = false;
        var i;
        for (i = 0; i < controllers.length; i += 1) {
          var snapshot = null;
          try {
            snapshot = controllers[i].form.getSnapshot();
          } catch (error) {
            snapshot = null;
          }
          if (usable(snapshot)) {
            any = true;
            if (snapshot.writable === false) writable = false;
            if (isNum(snapshot.revision)) revision = snapshot.revision;
            var j;
            for (j = 0; j < FIELDS.length; j += 1) {
              var key = FIELDS[j].key;
              if (Object.prototype.hasOwnProperty.call(snapshot.value, key)) value[key] = snapshot.value[key];
            }
          } else if (isObj(snapshot) && snapshot.status === 'loading') {
            pending = true;
          }
        }
        if (any) return { ready: true, value: value, writable: writable, revision: revision };
        if (pending) return null;
        return { ready: false, value: null, writable: false, revision: undefined };
      }

      /**
       * 引擎参数读写面。
       *
       * mode：'loading'（还没读到）| 'forms'（设置命名空间）| 'http'（{route}/config 降级）。
       * write(field, value) 返回 Promise<boolean>：false = 宿主拒绝（官方策略是「被拒绝的写入
       * 刷新最新 Host 值」，本组件只提示、不覆盖用户的其它编辑）。
       */
      function useConfigFace(forms, t) {
        var state = React.useState({ mode: 'loading', value: null, writable: false, error: '', revision: undefined });
        var face = state[0];
        var setFace = state[1];
        var ctrlRef = React.useRef([]);
        var liveRef = React.useRef(true);
        var httpTriedRef = React.useRef(false);

        React.useEffect(function () {
          liveRef.current = true;
          return function () { liveRef.current = false; };
        }, []);

        /** 降级通道：GET /config（只试一次，避免 unavailable 时反复打宿主）。 */
        function loadHttp() {
          if (httpTriedRef.current) return;
          httpTriedRef.current = true;
          api('/config', {}).then(function (res) {
            if (!liveRef.current) return;
            if (res.ok && isObj(res.body) && isObj(res.body.config)) {
              setFace({
                mode: 'http',
                value: res.body.config,
                writable: res.body.writable !== false,
                error: '',
              });
            } else {
              setFace({ mode: 'http', value: null, writable: false, error: errorText(t, res) });
            }
          });
        }

        // 订阅设置命名空间（软依赖：configForms 缺失就直接走降级通道）
        React.useEffect(function () {
          var alive = true;
          var offs = [];
          var controllers = [];
          if (!isObj(forms) || typeof forms.get !== 'function') {
            loadHttp();
            return undefined;
          }
          var sync = function () {
            if (!alive) return;
            var merged = mergeSnapshots(controllers);
            if (merged === null) return; // loading：保持骨架屏
            if (merged.ready === false) { loadHttp(); return; }
            setFace({ mode: 'forms', value: merged.value, writable: merged.writable, error: '', revision: merged.revision });
          };
          var ids = [NS_DOCTOR, NS_ENGINE];
          var i;
          for (i = 0; i < ids.length; i += 1) {
            var form;
            try {
              // get(entryId) 返回共享控制器：消费者**不要** dispose（spec-client §6.1(a)）
              form = forms.get(ids[i]);
            } catch (error) {
              form = undefined;
            }
            if (!isObj(form) || typeof form.getSnapshot !== 'function') continue;
            controllers.push({ ns: ids[i], form: form });
            try {
              var off = form.subscribe(sync);
              if (typeof off === 'function') offs.push(off);
            } catch (error) {
              // 订阅失败不影响读取：下面还会手动 sync 一次
            }
          }
          ctrlRef.current = controllers;
          sync();
          return function () {
            alive = false;
            var k;
            for (k = 0; k < offs.length; k += 1) {
              try { offs[k](); } catch (error) { /* 卸载期忽略 */ }
            }
          };
        }, [forms]);

        /** 当前渲染下的写通道。 */
        function write(field, value) {
          if (face.mode === 'forms' && ctrlRef.current.length > 0) {
            var owner = null;
            var fallback = ctrlRef.current[0];
            var i;
            for (i = 0; i < ctrlRef.current.length; i += 1) {
              if (ctrlRef.current[i].ns === field.ns) owner = ctrlRef.current[i];
            }
            var target = owner || fallback;
            var out;
            try {
              // set(field, value) = mutate([{op:'set', path:[field], value}])，自带 revision 乐观锁
              out = target.form.set(field.key, value);
            } catch (error) {
              return Promise.resolve(false);
            }
            if (out && typeof out.then === 'function') {
              return out.then(function (accepted) { return accepted !== false; }, function () { return false; });
            }
            return Promise.resolve(out !== false);
          }
          if (face.mode === 'http') {
            var body = {};
            body[field.key] = value;
            return api('/config', { method: 'PUT', json: body }).then(function (res) {
              if (res.ok && isObj(res.body) && isObj(res.body.config)) {
                setFace({
                  mode: 'http',
                  value: res.body.config,
                  writable: res.body.writable !== false,
                  error: '',
                });
                return true;
              }
              setFace(function (prev) {
                return { mode: prev.mode, value: prev.value, writable: prev.writable, error: errorText(t, res) };
              });
              return false;
            });
          }
          return Promise.resolve(false);
        }

        /** 重新读取（降级通道重发 GET；命名空间通道靠订阅，这里只重放一次快照）。 */
        function reload() {
          if (face.mode === 'forms') {
            var merged = mergeSnapshots(ctrlRef.current);
            if (merged !== null && merged.ready === true) {
              setFace({ mode: 'forms', value: merged.value, writable: merged.writable, error: '', revision: merged.revision });
            }
            return;
          }
          httpTriedRef.current = false;
          setFace({ mode: 'loading', value: null, writable: false, error: '', revision: undefined });
          loadHttp();
        }

        return {
          mode: face.mode,
          value: face.value,
          writable: face.writable,
          revision: face.revision,
          error: face.error,
          write: write,
          reload: reload,
        };
      }

      // -------------------------------------------------------------------
      // 6. 展示小件
      // -------------------------------------------------------------------

      function card(key, title, extra, children) {
        var head = h('div', { key: 'head', className: 'dsh-cdoc__cardHead' }, [
          h('span', { key: 'title', className: 'dsh-cdoc__cardTitle', children: title }),
        ].concat(extra || []));
        return h('div', { key: key, className: 'dsh-cdoc__card' }, [head].concat(children || []));
      }

      function row(key, children) {
        return h('div', { key: key, className: 'dsh-cdoc__row' }, children);
      }

      function kv(key, label, value) {
        return h('span', { key: key, className: 'dsh-cdoc__kv' }, [
          h('span', { key: 'l', className: 'dsh-cdoc__kvLabel', children: label + '：' }),
          h('span', { key: 'v', children: value }),
        ]);
      }

      function note(key, text, isErr) {
        return h('p', {
          key: key,
          className: 'dsh-cdoc__note' + (isErr ? ' is-err' : ''),
          role: 'status',
          children: text,
        });
      }

      function button(key, label, opts) {
        var o = opts || {};
        var cls = 'dsh-cdoc__btn';
        if (o.primary) cls += ' is-primary';
        if (o.danger) cls += ' is-danger';
        if (o.small) cls += ' is-sm';
        return h('button', {
          key: key,
          type: 'button',
          className: cls,
          disabled: o.disabled === true,
          title: o.title,
          onClick: o.onClick,
          children: label,
        });
      }

      function spinner(key) {
        return h('span', { key: key, className: 'dsh-cdoc__dot', 'aria-hidden': 'true' });
      }

      // -------------------------------------------------------------------
      // 7. 设置页栏目组件（五张卡）
      //
      //    props：owner 只给 { close }（spec-client §4.4）；inject 面给 { t, forms }。
      //    本组件是普通函数（组件类型跨渲染稳定）；所有 hook 无条件调用。
      // -------------------------------------------------------------------
      function CompactionSection(props) {
        var t = typeof props.t === 'function' ? props.t : function (key) { return key; };
        var forms = props.forms;

        // 引擎参数面（configForms 优先，HTTP 降级）
        var face = useConfigFace(forms, t);

        // /state 轮询：phase = loading | ready | unavailable | error
        var hostState = React.useState({ phase: 'loading', snap: null, res: null });
        var host = hostState[0];
        var setHost = hostState[1];

        // /diagnose：phase = idle | running | ready | error
        var diagState = React.useState({ phase: 'idle', data: null, res: null });
        var diag = diagState[0];
        var setDiag = diagState[1];

        // /apply
        var applyState = React.useState({ phase: 'idle', data: null, res: null });
        var applied = applyState[0];
        var setApplied = applyState[1];

        // /backups + /restore
        var backState = React.useState({ phase: 'loading', items: null, res: null, pending: '', note: null });
        var backups = backState[0];
        var setBackups = backState[1];

        // 诊断选项与「复制结论」反馈
        var activeState = React.useState(false);
        var activeProbe = activeState[0];
        var setActiveProbe = activeState[1];
        var copyState = React.useState('');
        var copyFlag = copyState[0];
        var setCopyFlag = copyState[1];

        // 引擎参数的本地草稿（数字输入改了但还没提交）
        var draftState = React.useState({});
        var drafts = draftState[0];
        var setDrafts = draftState[1];
        var engineMsgState = React.useState(null);
        var engineMsg = engineMsgState[0];
        var setEngineMsg = engineMsgState[1];

        // 页面挂载即注入样式（ensureCss 幂等，可重复挂载）
        ensureCss();

        // ---- 硬约束：栏目「切走即卸载」，所以计时器归组件所有，cleanup 里必须收口 ----
        React.useEffect(function () {
          var alive = true;
          var controller = new AbortController();
          var timer = null;
          function poll() {
            api('/state', { signal: controller.signal }).then(function (res) {
              if (!alive) return;
              if (isObj(res.body) && res.body.unavailable === true) {
                // api-contract §2.1：宿主不可用时仍返回 200，页面据此占位并禁用按钮
                setHost({ phase: 'unavailable', snap: res.body, res: null });
                return;
              }
              if (!res.ok) {
                setHost({ phase: 'error', snap: null, res: res });
                return;
              }
              setHost({ phase: 'ready', snap: res.body, res: null });
            });
          }
          poll();
          timer = setInterval(poll, POLL_MS);
          return function () {
            alive = false;
            controller.abort(); // 在途请求作废；之后不会再有新的轮询
            if (timer !== null) clearInterval(timer);
          };
        }, []);

        // 备份列表：挂载时拉一次（还原/应用修复后手动刷新）
        React.useEffect(function () {
          reloadBackups(null);
          return undefined;
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        /** GET /backups。note 为还原成功后的提示（重拉列表时不丢）。 */
        function reloadBackups(noteValue) {
          setBackups(function (prev) {
            return {
              phase: 'loading',
              items: prev && prev.items ? prev.items : null,
              res: null,
              pending: '',
              note: noteValue === undefined ? (prev ? prev.note : null) : noteValue,
            };
          });
          api('/backups', {}).then(function (res) {
            if (res.ok && isObj(res.body) && Array.isArray(res.body.backups)) {
              setBackups(function (prev) {
                return { phase: 'ready', items: res.body.backups, res: null, pending: '', note: prev ? prev.note : null };
              });
            } else {
              setBackups(function (prev) {
                return { phase: 'error', items: null, res: res, pending: '', note: prev ? prev.note : null };
              });
            }
          });
        }

        /** POST /diagnose（body 可带 {"active": true} 请求一次真实边界探测）。 */
        function runDiagnose(withActive) {
          setCopyFlag('');
          setDiag(function (prev) {
            return { phase: 'running', data: prev ? prev.data : null, res: null };
          });
          api('/diagnose', { method: 'POST', json: { active: withActive === true } }).then(function (res) {
            if (res.ok) {
              setDiag({ phase: 'ready', data: res.body, res: null });
            } else {
              setDiag(function (prev) {
                return { phase: 'error', data: prev ? prev.data : null, res: res };
              });
            }
          });
        }

        /** POST /apply（必须带 confirm:true，缺了宿主回 400）。成功后自动重跑一次诊断证明闭环。 */
        function runApply() {
          var proposed = diag.data && diag.data.proposed;
          if (!isObj(proposed)) return;
          setApplied({ phase: 'running', data: null, res: null });
          api('/apply', {
            method: 'POST',
            json: {
              contextWindow: proposed.contextWindow,
              maxTokens: proposed.maxTokens,
              confirm: true,
            },
          }).then(function (res) {
            if (res.ok) {
              setApplied({ phase: 'ready', data: res.body, res: null });
              reloadBackups(undefined); // 新备份进入列表
              runDiagnose(false);       // 自动重跑诊断，证明闭环
            } else {
              setApplied({ phase: 'error', data: null, res: res });
            }
          });
        }

        /** POST /restore（还原前二次确认由 pending 状态承载）。 */
        function runRestore(file) {
          setBackups(function (prev) {
            return {
              phase: 'restoring',
              items: prev ? prev.items : null,
              res: null,
              pending: file,
              note: prev ? prev.note : null,
            };
          });
          api('/restore', { method: 'POST', json: { file: file, confirm: true } }).then(function (res) {
            if (res.ok && isObj(res.body)) {
              reloadBackups({ restored: res.body.restored, backup: res.body.backup });
            } else {
              setBackups(function (prev) {
                return {
                  phase: 'error',
                  items: prev ? prev.items : null,
                  res: res,
                  pending: '',
                  note: prev ? prev.note : null,
                };
              });
            }
          });
        }

        /** 诊断结论的纯文本（复制到剪贴板 / 贴 issue）。 */
        function reportText() {
          var data = diag.data;
          if (!isObj(data)) return '';
          var lines = [];
          if (typeof data.summary === 'string') lines.push(data.summary);
          try {
            if (isObj(data.route)) lines.push('route: ' + JSON.stringify(data.route));
            if (isObj(data.configured)) lines.push('configured: ' + JSON.stringify(data.configured));
            if (isObj(data.decision)) lines.push('decision: ' + JSON.stringify(data.decision));
            if (isObj(data.observed)) lines.push('observed: ' + JSON.stringify(data.observed));
            if (isObj(data.proposed)) lines.push('proposed: ' + JSON.stringify(data.proposed));
          } catch (error) {
            // 循环引用等理论上不会出现：静默忽略 JSON 附件，保留 summary
          }
          return lines.join('\n');
        }

        /** 复制结论：navigator.clipboard 失败时静默降级成一行提示，绝不抛错。 */
        function copyReport() {
          var text = reportText();
          if (text === '') return;
          var done = function () { setCopyFlag('ok'); };
          var failed = function () { setCopyFlag('fail'); };
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard
              && typeof navigator.clipboard.writeText === 'function') {
              var out = navigator.clipboard.writeText(text);
              if (out && typeof out.then === 'function') out.then(done, failed);
              else done();
              return;
            }
          } catch (error) {
            failed();
            return;
          }
          failed();
        }

        /** 提交一个引擎字段（写成功后靠订阅/响应回填，不在前端自己造状态）。 */
        function commitField(field, value) {
          setEngineMsg(null);
          var out = face.write(field, value);
          var settle = function (accepted) {
            setEngineMsg(accepted === false
              ? { key: 'engine.saveFailed', err: true }
              : { key: 'engine.saved', err: false });
          };
          if (out && typeof out.then === 'function') out.then(settle, function () { settle(false); });
          else settle(out);
        }

        /** 数字输入的提交（失焦 / 回车）：先按下限上限夹取，非法则红字提示。 */
        function commitDraft(field) {
          var raw = drafts[field.key];
          if (raw === undefined) return;
          setDrafts(function (prev) {
            var next = Object.assign({}, prev);
            delete next[field.key];
            return next;
          });
          var parsed = parseFieldValue(field, raw);
          if (parsed === undefined) {
            setEngineMsg({ key: 'engine.invalid', err: true });
            return;
          }
          commitField(field, parsed);
        }

        // ---- 派生状态 ----
        var snap = host.phase === 'ready' ? host.snap : null;
        var measurement = snap && snap.measurement;
        var budget = snap && snap.budget;
        var pressure = measurement && measurement.totalTokens;
        var threshold = budget && budget.thresholdTokens;
        // 「宿主能力未就绪」⇒ 禁用全部按钮（api-contract §2.1）
        var hostDown = host.phase === 'unavailable' || host.phase === 'error';
        var busy = diag.phase === 'running' || applied.phase === 'running';
        var proposed = diag.data && diag.data.proposed;

        var children = [];
        children.push(h('h2', { key: 'title', className: 'dsh-cdoc__title', children: t('title') }));
        children.push(h('p', { key: 'intro', className: 'dsh-cdoc__intro', children: t('intro') }));

        // ================= 卡 1：一键诊断 =================
        var diagBody = [];
        diagBody.push(note('hint', t('diag.hint')));
        diagBody.push(row('controls', [
          button('run', diag.phase === 'running' ? t('diag.running') : t('diag.run'), {
            primary: true,
            disabled: busy || hostDown,
            onClick: function () { runDiagnose(activeProbe); },
          }),
          h('label', { key: 'active', className: 'dsh-cdoc__toggle' }, [
            h('input', {
              key: 'cb',
              type: 'checkbox',
              checked: activeProbe,
              disabled: busy || hostDown,
              onChange: function (event) { setActiveProbe(event.target.checked === true); },
            }),
            h('span', { key: 'lb', children: t('diag.active') }),
          ]),
        ]));
        diagBody.push(note('activeNote', t('diag.activeNote')));

        if (diag.phase === 'idle') {
          diagBody.push(note('empty', t('diag.empty')));
        }
        if (diag.phase === 'error') {
          diagBody.push(note('err', errorText(t, diag.res), true));
        }
        if (isObj(diag.data)) {
          var data = diag.data;
          if (typeof data.summary === 'string' && data.summary !== '') {
            diagBody.push(row('summaryLabel', [
              h('span', { key: 'l', className: 'dsh-cdoc__kvLabel', children: t('diag.summary') }),
            ]));
            diagBody.push(h('pre', { key: 'summary', className: 'dsh-cdoc__pre', children: data.summary }));
          }
          var meta = [];
          if (isObj(data.route)) {
            meta.push(kv('route', t('diag.route'),
              String(data.route.provider || '—') + ' / ' + String(data.route.model || '—')));
          }
          if (isObj(data.configured)) {
            meta.push(kv('configured', t('diag.configured'),
              String(data.configured.contextWindow === undefined ? '—' : data.configured.contextWindow)
              + ' / ' + String(data.configured.maxOutput === undefined ? '—' : data.configured.maxOutput)));
          }
          if (isObj(data.decision)) {
            meta.push(kv('decision', t('diag.decision'),
              String(data.decision.contextWindow === undefined ? '—' : data.decision.contextWindow)
              + ' (' + String(data.decision.source || '—') + ')'));
          }
          if (isObj(data.observed) && isNum(data.observed.maxAcceptedPrompt)) {
            meta.push(kv('observed', t('diag.observed'), String(data.observed.maxAcceptedPrompt)));
          } else {
            meta.push(kv('observed', t('diag.observed'), t('diag.observedNone')));
          }
          if (Array.isArray(data.candidates) && data.candidates.length > 0) {
            var sources = [];
            var ci;
            for (ci = 0; ci < data.candidates.length; ci += 1) {
              if (isObj(data.candidates[ci]) && data.candidates[ci].source !== undefined) {
                sources.push(String(data.candidates[ci].source));
              }
            }
            meta.push(kv('candidates', t('diag.candidates'), sources.join(' · ') || '—'));
          }
          diagBody.push(row('meta', meta));
          if (isObj(data.decision) && typeof data.decision.rationale === 'string') {
            diagBody.push(note('rationale', t('diag.rationale') + '：' + data.decision.rationale));
          }
          diagBody.push(row('copy', [
            button('copy', t('copy'), {
              disabled: false,
              onClick: copyReport,
            }),
            copyFlag === 'ok' ? h('span', { key: 'copied', className: 'dsh-cdoc__msg', children: t('copied') }) : null,
            copyFlag === 'fail'
              ? h('span', { key: 'cfail', className: 'dsh-cdoc__msg is-err', children: t('copyFailed') })
              : null,
          ]));
        }
        children.push(card('diag', t('card.diag'), null, diagBody));

        // ================= 卡 2：一键修复（由 proposed 驱动）=================
        var fixBody = [];
        fixBody.push(note('hint', t('fix.hint')));
        if (!isObj(diag.data)) {
          fixBody.push(note('none', t('fix.none')));
        } else if (!isObj(proposed)) {
          fixBody.push(note('noChange', t('fix.noChange')));
        } else {
          var configured = isObj(diag.data.configured) ? diag.data.configured : {};
          var preview = [];
          var diffRow = function (key, label, from, to) {
            var text = String(from === undefined ? '—' : from) + ' → ' + String(to === undefined ? '—' : to);
            if (String(from) === String(to)) text = String(from === undefined ? '—' : from) + ' ' + t('fix.unchanged');
            return kv(key, label, text);
          };
          preview.push(diffRow('cw', t('fix.field.contextWindow'), configured.contextWindow, proposed.contextWindow));
          preview.push(diffRow('mt', t('fix.field.maxTokens'), configured.maxOutput, proposed.maxTokens));
          fixBody.push(row('previewLabel', [
            h('span', { key: 'l', className: 'dsh-cdoc__kvLabel', children: t('fix.preview') }),
          ]));
          fixBody.push(row('preview', preview));
          fixBody.push(note('confirmNote', t('fix.confirmNote')));
          fixBody.push(row('apply', [
            button('apply', applied.phase === 'running' ? t('fix.applying') : t('fix.apply'), {
              primary: true,
              disabled: busy || hostDown,
              onClick: runApply,
            }),
            applied.phase === 'ready'
              ? h('span', { key: 'verify', className: 'dsh-cdoc__msg', children: t('fix.verify') })
              : null,
          ]));
        }
        if (applied.phase === 'error') {
          fixBody.push(note('err', errorText(t, applied.res), true));
        }
        if (applied.phase === 'ready' && isObj(applied.data)) {
          fixBody.push(note('applied', fill(t('fix.applied'), {
            backup: String(applied.data.backup === undefined ? '—' : applied.data.backup),
          }) + (applied.data.hotReload === true ? '（' + t('fix.hotReload') + '）' : '')));
          if (Array.isArray(applied.data.changes) && applied.data.changes.length > 0) {
            var changeLines = [];
            var ai;
            for (ai = 0; ai < applied.data.changes.length; ai += 1) {
              changeLines.push(String(applied.data.changes[ai]));
            }
            fixBody.push(h('div', {
              key: 'changes',
              className: 'dsh-cdoc__pre',
              children: changeLines.join('\n'),
            }));
          }
        }
        children.push(card('fix', t('card.fix'), null, fixBody));

        // ================= 卡 3：引擎参数 =================
        var engineBody = [];
        engineBody.push(note('hint', fill(t('engine.hint'), { route: ROUTE })));
        var sourceText = face.mode === 'forms' ? t('engine.source.forms')
          : face.mode === 'http' ? fill(t('engine.source.http'), { route: ROUTE })
            : t('engine.source.loading');
        engineBody.push(row('source', [
          kv('src', t('engine.source'), sourceText),
          face.mode === 'forms' && isNum(face.revision)
            ? h('span', {
              key: 'rev',
              className: 'dsh-cdoc__kv',
              children: fill(t('engine.revision'), { revision: face.revision }),
            })
            : null,
          button('reload', t('engine.reload'), {
            small: true,
            // 宿主 unavailable 时全部按钮禁用（api-contract §2.1）
            disabled: hostDown || face.mode === 'loading',
            onClick: function () { setEngineMsg(null); face.reload(); },
          }),
          engineMsg !== null
            ? h('span', {
              key: 'msg',
              className: 'dsh-cdoc__msg' + (engineMsg.err ? ' is-err' : ''),
              children: t(engineMsg.key),
            })
            : null,
        ]));
        if (face.error !== '') engineBody.push(note('err', face.error, true));
        if (face.mode !== 'loading' && face.writable === false) {
          engineBody.push(note('readonly', t('engine.readonly')));
        }
        if (face.mode !== 'loading' && face.value === null) {
          engineBody.push(note('empty', fill(t('engine.empty'), { route: ROUTE })));
        }
        if (isObj(face.value)) {
          var fields = [];
          var fi;
          for (fi = 0; fi < FIELDS.length; fi += 1) {
            fields.push(renderField(FIELDS[fi], face.value[FIELDS[fi].key]));
          }
          engineBody.push(h('div', { key: 'grid', className: 'dsh-cdoc__grid' }, fields));
        }
        children.push(card('engine', t('card.engine'), null, engineBody));

        /** 单个字段控件：开关走 checkbox（即时提交），其余走输入框（失焦/回车提交）。 */
        function renderField(field, value) {
          var label = t('field.' + field.key);
          var disabled = hostDown || face.writable === false || face.mode === 'loading';
          var known = value !== undefined && value !== null;
          var control;
          if (field.kind === 'bool') {
            control = h('label', { key: 'c', className: 'dsh-cdoc__toggle' }, [
              h('input', {
                key: 'i',
                type: 'checkbox',
                checked: value === true,
                disabled: disabled || !known,
                onChange: function (event) { commitField(field, event.target.checked === true); },
              }),
              h('span', {
                key: 's',
                children: known ? (value === true ? t('on') : t('off')) : t('unknown'),
              }),
            ]);
          } else if (field.kind === 'enum') {
            var options = [];
            var oi;
            for (oi = 0; oi < field.options.length; oi += 1) {
              var option = field.options[oi];
              options.push(h('option', { key: 'o' + oi, value: option, children: t('engine.mode.' + option) }));
            }
            control = h('select', {
              key: 'c',
              className: 'dsh-cdoc__inp is-select',
              value: known ? String(value) : '',
              disabled: disabled || !known,
              onChange: function (event) { commitField(field, event.target.value); },
            }, options);
          } else {
            var shown = drafts[field.key] !== undefined
              ? drafts[field.key]
              : (known ? String(value) : '');
            control = h('input', {
              key: 'c',
              type: 'number',
              className: 'dsh-cdoc__inp',
              step: field.step === undefined ? 'any' : String(field.step),
              min: field.min === undefined ? undefined : String(field.min),
              max: field.max === undefined ? undefined : String(field.max),
              value: shown,
              placeholder: known ? undefined : t('unknown'),
              disabled: disabled || !known,
              onChange: function (event) {
                var text = event.target.value;
                setDrafts(function (prev) {
                  var next = Object.assign({}, prev);
                  next[field.key] = text;
                  return next;
                });
              },
              onBlur: function () { commitDraft(field); },
              onKeyDown: function (event) {
                if (event.key === 'Enter') commitDraft(field);
              },
            });
          }
          return h('div', { key: field.key, className: 'dsh-cdoc__field' }, [
            h('span', { key: 'l', className: 'dsh-cdoc__flabel', children: label }),
            control,
          ]);
        }

        // ================= 卡 4：运行状态（2s 轮询）=================
        var stateBody = [];
        stateBody.push(note('hint', fill(t('state.hint'), { route: ROUTE })));

        if (host.phase === 'loading') {
          stateBody.push(row('waiting', [spinner('dot'), h('span', {
            key: 'txt', className: 'dsh-cdoc__note', children: t('state.waiting'),
          })]));
        }
        if (host.phase === 'unavailable') {
          var um = isObj(host.snap) ? (host.snap.message || host.snap.error) : '';
          stateBody.push(row('unavailable', [
            h('i', { key: 'dot', className: 'dsh-cdoc__dot is-err', 'aria-hidden': 'true' }),
            h('span', {
              key: 'txt',
              className: 'dsh-cdoc__note is-err',
              role: 'status',
              children: fill(t('state.unavailable'), { message: um || t('err.empty') }),
            }),
          ]));
        }
        if (host.phase === 'error') {
          stateBody.push(row('error', [
            h('i', { key: 'dot', className: 'dsh-cdoc__dot is-err', 'aria-hidden': 'true' }),
            h('span', { key: 'txt', className: 'dsh-cdoc__note is-err', role: 'status', children: errorText(t, host.res) }),
          ]));
        }
        if (isObj(snap)) {
          // 压力 > 阈值 ⇒ 圆点转警告色（--dsw-alias-state-warn-primary）
          var dotClass = 'dsh-cdoc__dot';
          if (isNum(pressure) && isNum(threshold) && pressure > threshold) dotClass += ' is-warn';
          else if (isNum(pressure)) dotClass += ' is-ok';

          var budgetRow = [
            h('i', { key: 'dot', className: dotClass, 'aria-hidden': 'true' }),
            kv('p', t('state.pressure'), isNum(pressure) ? String(pressure) : '—'),
            kv('th', t('state.threshold'), isNum(threshold) ? String(threshold) : '—'),
            kv('r', t('state.ratio'), pct(pressure, threshold)),
          ];
          stateBody.push(row('budget', budgetRow));

          var winRow = [];
          if (isObj(snap.window)) {
            winRow.push(kv('w', t('state.window'),
              String(snap.window.contextWindow === undefined ? '—' : snap.window.contextWindow)
              + '（' + String(snap.window.source || '—') + '）'));
            winRow.push(kv('mo', t('state.maxOutput'),
              String(snap.window.maxOutput === undefined ? '—' : snap.window.maxOutput)));
            winRow.push(kv('c', t('state.contradiction'),
              snap.window.contradiction === true || snap.window.reserveContradiction === true
                ? t('state.contradictionYes') : t('state.contradictionNo')));
          }
          if (isObj(budget)) {
            winRow.push(kv('mb', t('state.messageBudget'),
              String(budget.messageBudget === undefined ? '—' : budget.messageBudget)));
            winRow.push(kv('rt', t('state.retainBudget'),
              String(budget.retainTokens === undefined ? '—' : budget.retainTokens)));
            winRow.push(kv('hr', t('state.headroom'),
              String(budget.headroomTokens === undefined ? '—' : budget.headroomTokens)));
          }
          stateBody.push(row('window', winRow));

          var scaleRow = [];
          if (isObj(snap.measurement)) {
            scaleRow.push(kv('f', t('state.scale'), isNum(snap.measurement.factor) ? String(snap.measurement.factor) : '—'));
            scaleRow.push(kv('n', t('state.nodes'), isNum(snap.measurement.nodes) ? String(snap.measurement.nodes) : '—'));
            scaleRow.push(kv('s', t('state.surface'),
              isNum(snap.measurement.surfaceTokens) ? String(snap.measurement.surfaceTokens) : '—'));
            if (snap.measurement.rescaled === true) scaleRow.push(kv('rs', t('state.rescaled'), t('on')));
          }
          if (isObj(snap.engine)) {
            scaleRow.push(kv('sm', t('state.scaleMode'), String(snap.engine.scaleMode || '—')));
          }
          if (isObj(snap.host)) {
            scaleRow.push(kv('mc', t('state.meter'),
              snap.host.meterPatched === true ? t('state.meterYes') : t('state.meterNo')));
            scaleRow.push(kv('wc', t('state.writeConfig'),
              snap.host.writeConfig === true ? t('on') : t('off')));
          }
          stateBody.push(row('scale', scaleRow));

          if (isObj(snap.engine)) {
            stateBody.push(note('counters', fill(t('state.counters'), {
              summary: String(snap.engine.summaryCalls === undefined ? 0 : snap.engine.summaryCalls),
              chunked: String(snap.engine.chunkedRegions === undefined ? 0 : snap.engine.chunkedRegions),
              merges: String(snap.engine.merges === undefined ? 0 : snap.engine.merges),
            })));
          }

          var last = snap.lastCompaction;
          var lastRow = [kv('l', t('state.lastCompaction'), '')];
          if (isObj(last)) {
            var triggerKey = 'state.trigger.' + String(last.trigger);
            var triggerText = t(triggerKey);
            if (triggerText === triggerKey) triggerText = t('state.trigger.unknown');
            lastRow.push(kv('t', fmtTime(last.at), triggerText));
            lastRow.push(kv('sh', t('state.shadowed'),
              String(last.shadowedTokens === undefined ? '—' : last.shadowedTokens)
              + ' / ' + String(last.shadowedNodes === undefined ? '—' : last.shadowedNodes)));
            lastRow.push(kv('rg', t('state.range'),
              String(last.rangeStart === undefined ? '—' : last.rangeStart)
              + '–' + String(last.rangeEnd === undefined ? '—' : last.rangeEnd)));
          } else {
            lastRow.push(kv('n', t('state.never'), ''));
          }
          stateBody.push(row('last', lastRow));

          if (isObj(snap.guard) && isNum(snap.guard.failures)) {
            stateBody.push(row('guard', [
              kv('g', t('state.guard'), String(snap.guard.failures)),
              typeof snap.guard.lastMessage === 'string' && snap.guard.lastMessage !== ''
                ? h('span', { key: 'gm', className: 'dsh-cdoc__note', children: snap.guard.lastMessage })
                : null,
            ]));
          } else {
            stateBody.push(row('guard', [kv('g', t('state.guard'), t('state.guardNone'))]));
          }

          if (isObj(snap.session) && isObj(snap.session.route)) {
            stateBody.push(row('session', [kv('s', t('state.session'),
              String(snap.session.route.provider || '—') + ' / ' + String(snap.session.route.model || '—'))]));
          }
        }
        var stateExtra = [];
        if (isObj(snap) && typeof snap.version === 'string') {
          stateExtra.push(h('span', {
            key: 'ver',
            className: 'dsh-cdoc__spacer dsh-cdoc__itemMeta',
            children: snap.version,
          }));
        }
        children.push(card('state', t('card.state'), stateExtra, stateBody));

        // ================= 卡 5：备份与还原 =================
        var backBody = [];
        backBody.push(note('hint', fill(t('backup.hint'), { pattern: 'cordis.patch.yml.bak-*' })));
        backBody.push(row('controls', [
          button('reload', t('backup.reload'), {
            small: true,
            disabled: hostDown || backups.phase === 'loading' || backups.phase === 'restoring',
            onClick: function () { reloadBackups(undefined); },
          }),
          backups.phase === 'loading' ? spinner('dot') : null,
          backups.phase === 'loading'
            ? h('span', { key: 'lt', className: 'dsh-cdoc__note', children: t('backup.loading') })
            : null,
          backups.phase === 'restoring'
            ? h('span', { key: 'rt', className: 'dsh-cdoc__msg', children: t('backup.restoring') })
            : null,
        ]));
        if (backups.phase === 'error') backBody.push(note('err', errorText(t, backups.res), true));
        if (backups.note !== null && isObj(backups.note)) {
          backBody.push(note('done', fill(t('backup.done'), {
            restored: String(backups.note.restored === undefined ? '—' : backups.note.restored),
            backup: String(backups.note.backup === undefined ? '—' : backups.note.backup),
          })));
        }
        if (isObj(backups.items) && backups.items.length === 0) {
          backBody.push(note('empty', t('backup.empty')));
        }
        if (Array.isArray(backups.items) && backups.items.length > 0) {
          var items = [];
          var bi;
          for (bi = 0; bi < backups.items.length; bi += 1) {
            var item = isObj(backups.items[bi]) ? backups.items[bi] : {};
            var file = String(item.file === undefined ? '' : item.file);
            var pendingThis = backups.pending === file && file !== '';
            var controls = [];
            if (pendingThis) {
              controls.push(note('ch', t('backup.confirmHint')));
              controls.push(button('yes', t('backup.confirm'), {
                danger: true,
                small: true,
                disabled: hostDown,
                onClick: function (target) {
                  return function () { runRestore(target); };
                }(file),
              }));
              controls.push(button('no', t('backup.cancel'), {
                small: true,
                disabled: hostDown,
                onClick: function () {
                  setBackups(function (prev) {
                    return {
                      phase: prev ? prev.phase : 'ready',
                      items: prev ? prev.items : null,
                      res: prev ? prev.res : null,
                      pending: '',
                      note: prev ? prev.note : null,
                    };
                  });
                },
              }));
            } else {
              controls.push(button('restore', t('backup.restore'), {
                small: true,
                disabled: hostDown || backups.phase === 'restoring',
                title: file,
                onClick: function (target) {
                  return function () {
                    setBackups(function (prev) {
                      return {
                        phase: prev ? prev.phase : 'ready',
                        items: prev ? prev.items : null,
                        res: prev ? prev.res : null,
                        pending: target,
                        note: prev ? prev.note : null,
                      };
                    });
                  };
                }(file),
              }));
            }
            items.push(h('div', { key: 'row' + bi, className: 'dsh-cdoc__item' }, [
              h('span', {
                key: 'name',
                className: 'dsh-cdoc__itemName',
                title: file,
                children: String(item.name === undefined ? file : item.name),
              }),
              h('span', { key: 'meta', className: 'dsh-cdoc__itemMeta', children: fmtTime(item.at) }),
              h('span', { key: 'size', className: 'dsh-cdoc__itemMeta', children: fmtBytes(item.bytes) }),
            ].concat(controls)));
          }
          backBody.push(h('div', { key: 'list', className: 'dsh-cdoc__list' }, items));
        }
        children.push(card('backup', t('card.backup'), null, backBody));

        // 面板在 #root 之外的 portal 里渲染 ⇒ 根容器就是普通 div（spec-client §6.6 第 2 条）
        return h('div', { className: 'dsh-cdoc', 'data-dsh-compaction-doctor': '1' }, children);
      }

      // -------------------------------------------------------------------
      // 8. cordis 装配
      // -------------------------------------------------------------------
      // inject 是「cordis 服务名」，不是包名（spec-client §2.4）。
      // configForms 故意**不**写进 inject：缺 ui-settings 的组合会把整页拖成 pending
      // （§6.6 第 3 条），所以它走 ctx.get() 软依赖。
      var inject = ['slots', 'locale'];

      function apply(ctx) {
        // 字典随 fiber 卸载回收；缺语言 / 键集不一致会在这里直接抛错
        ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); },
          'dsh-compaction-doctor: dictionaries');
        var t = ctx.locale.bind(NS);

        // configForms 软依赖：Prefer ctx.get(name) with an undefined check（§6.6 第 3 条）
        var forms;
        try {
          forms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined;
        } catch (error) {
          forms = undefined;
        }

        // settings.section：新 id 不替换任何官方栏位；order 40 排在官方 5 栏之后（§4.5）
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            {
              name: 'settings.section',
              id: 'compaction',
              order: 40,
              // label 必须是 thunk：外壳只在 locale revision 变化时重投影（§5.6）
              label: function () { return t('nav'); },
              // 条目级 owner props：把 t 与 configForms 面交给组件（§4.2）
              inject: function () { return { t: t, forms: forms }; },
            },
            CompactionSection,
          );
        });
      }

      module.exports = { name: 'compaction-doctor', inject: inject, apply: apply };
      return module.exports;
    },
  });
})();
