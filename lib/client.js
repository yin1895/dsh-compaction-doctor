/*!
 * @local/dsh-compaction-doctor —— 浏览器半侧（settings.section: compaction）
 *
 * 极简形态：一句介绍 + 一个开关 + 一行状态文字，页面上只有这一个控件。诊断、校正、备份全部
 * 由宿主自动完成：打开后宿主只在「用户正在用的那个模型」上懒检查一次，必要时改配置（改前先
 * 备份）。本页面不轮询、不写日志、不显示指标、不出现任何数字。
 *
 * 开关的三条健壮性底线（v0.4.1，线上事故后加的）：
 *   1. 只有「写请求在途」和「宿主半侧还是旧版本」会让开关不可点，别的一律可点；
 *   2. 写请求有硬超时，写完之后一定做一次回读，绝不把开关永远留在「忙」；
 *   3. 回读有总时限，超了就用宿主给的真值收工（不做无限重试）。
 *
 * 依据 docs/spec-client.md 的浏览器产物契约：§2.1-2.4（经典脚本 / id = 包名 / 种子表 require）、
 * §4（settings.section 注册选项）、§5（视觉规范）、§6.6（页面生命周期三条硬约束）。
 * 手写产物：无构建工具、无 JSX，全部 React.createElement；顶层只调用一次模块加载器的
 * load({id, factory})，既没有 import 也没有 export。
 */
(function () {
  'use strict';

  window.__ModuleLoader__.load({
    // id 必须等于 package.json 的 name（spec-client §2.2）
    id: '@local/dsh-compaction-doctor',
    factory: function (require) {
      var module = { exports: {} };

      // ─── 0. 平台种子模块（spec-client §2.3 白名单；本插件只需要 react）─────────────
      var React = require('react');
      var h = React.createElement;

      // ─── 1. 常量 ─────────────────────────────────────────────────────────────────
      var PKG = '@local/dsh-compaction-doctor'; // 样式回收标记，必须等于包名（§5.5）
      var NS = 'compaction-doctor.ui';          // locale 命名空间
      var ROUTE = '/dsh-compaction-doctor';     // 宿主前缀路由（同源相对路径，不拼主机）
      var CSS_TAG = PKG + '/client.css';        // 样式表去重键
      var GUARD_NAME = 'x-compaction-doctor';   // 每个请求都要带的闸门请求头
      var SETTLE_MS = 300;                      // PUT 之后等这么久再回读（写盘会热重载）
      var MAX_RETRY = 2;                        // 回读最多再重试几次
      var SETTLE_TOTAL_MS = 3000;               // 回读总时限：超过就不再等，直接采用真值
      var WRITE_TIMEOUT_MS = 8000;              // 写请求硬超时：不许把开关永远留在「忙」
      // 宿主给的状态键；只认这些，认不出来就按失败文案说
      var AUTO_KEYS = ['auto.off', 'auto.none', 'auto.pending', 'auto.running', 'auto.ok', 'auto.found', 'auto.fixed', 'auto.failed'];

      // ─── 2. 文案（14 个键，zh 为键集来源，en 严格同键；零黑话、零数字）───────────────
      var zh = {
        nav: '上下文压缩',
        intro: '打开后，DSH 会按你用到的模型自动校正长度设置，不需要你操作。',
        'switch.label': '自动校正长度设置',
        'state.loading': '正在读取设置…',
        'state.unavailable': '暂时读不到设置，退出这一栏再进来看看。',
        'state.stale': '插件刚更新过，重启 DSH 之后这个开关才能用。',
        'auto.off': '未开启。DSH 使用它自己的默认设置。',
        'auto.none': '已开启。开始对话后会按你用的模型自动检查。',
        'auto.pending': '已开启。正在准备检查你当前用的模型…',
        'auto.running': '已开启。正在检查 {model}…',
        'auto.ok': '已开启。{model} 的设置是正确的。',
        'auto.found': '已开启。发现 {model} 的长度设置需要修正…',
        'auto.fixed': '已开启。已自动修正 {model} 的长度设置（改前已备份）。',
        'auto.failed': '已开启，但自动检查失败了。详情见 DSH 日志。',
      };

      var en = {
        nav: 'Context compaction',
        intro: 'When this is on, DSH corrects the length settings for the models you actually use — no action needed from you.',
        'switch.label': 'Correct length settings automatically',
        'state.loading': 'Reading the settings…',
        'state.unavailable': 'The settings could not be read — leave this section and come back in a moment.',
        'state.stale': 'The plugin was just updated — restart DSH before this switch can be used.',
        'auto.off': 'Off. DSH uses its own defaults.',
        'auto.none': 'On. Your model is checked automatically once you start a conversation.',
        'auto.pending': 'On. Getting ready to check the model you are using…',
        'auto.running': 'On. Checking {model}…',
        'auto.ok': 'On. {model} is set correctly.',
        'auto.found': 'On. {model} needs a length correction…',
        'auto.fixed': 'On. {model} was corrected automatically (backed up first).',
        'auto.failed': 'On, but the automatic check failed. See the DSH log for details.',
      };

      // ─── 3. 内联 CSS ────────────────────────────────────────────────────────────
      // 只做间距/字号/开关形状/禁用态；颜色全用官方语义 token，深浅主题都跟随。
      // 注入方式 = style[data-plugin-css=…] 去重 + style[data-plugin=<包名>] 供回收。
      var CSS = [
        '.dsh-cdoc{max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
        '.dsh-cdoc__intro{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
        '.dsh-cdoc__status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
        // 开关：不可见的原生 checkbox 盖在自绘轨道上（键盘可达、语义正确）
        '.dsh-cdoc__switch{position:relative;display:inline-flex;align-items:center;align-self:flex-start}',
        '.dsh-cdoc__input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}',
        '.dsh-cdoc__input:disabled{cursor:default}',
        '.dsh-cdoc__track{position:relative;box-sizing:border-box;width:34px;height:20px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);transition:background .12s ease,border-color .12s ease}',
        '.dsh-cdoc__knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .12s ease,background .12s ease}',
        '.dsh-cdoc__input:checked+.dsh-cdoc__track{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary)}',
        '.dsh-cdoc__input:checked+.dsh-cdoc__track>.dsh-cdoc__knob{transform:translateX(14px);background:var(--dsw-alias-label-primary-foreground)}',
        '.dsh-cdoc__input:focus-visible+.dsh-cdoc__track{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
        '.dsh-cdoc__input:disabled+.dsh-cdoc__track{opacity:.5}',
      ].join('');

      /** 注入本包样式（幂等；data-plugin 必须等于包名，否则插件卸载后样式残留）。 */
      function ensureCss() {
        if (typeof document === 'undefined') return;
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') !== null) return;
        var tag = document.createElement('style');
        tag.dataset.plugin = PKG;
        tag.dataset.pluginCss = CSS_TAG;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }

      // ─── 4. 小工具 ──────────────────────────────────────────────────────────────

      /** 文案插值：把 {name} 换成变量值；缺参数时原样保留。 */
      function fill(text, vars) {
        return String(text).replace(/\{(\w+)\}/g, function (match, key) {
          var value = vars ? vars[key] : undefined;
          return value === undefined ? match : String(value);
        });
      }

      /** 按句切分（中英文句号、问号、叹号；英文句点后跟空格才算断句）。 */
      function sentences(text) {
        var raw = String(text);
        var out = [];
        var buffer = '';
        for (var i = 0; i < raw.length; i += 1) {
          var ch = raw.charAt(i);
          var last = i === raw.length - 1;
          buffer += ch;
          if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?') { out.push(buffer); buffer = ''; }
          else if (ch === '.' && (last || raw.charAt(i + 1) === ' ')) { out.push(buffer); buffer = ''; }
        }
        if (buffer !== '') out.push(buffer);
        return out;
      }

      /** 参数是不是一个能用上的值（宿主拿不准时会填 "?"）。 */
      function usable(value) {
        return typeof value === 'string' && value !== '' && value !== '?';
      }

      /** 本地化 + 插值：含未解析占位符的整句直接丢掉，绝不把空括号或生键名留给用户。 */
      function localize(text, params) {
        var parts = sentences(text);
        var kept = [];
        for (var i = 0; i < parts.length; i += 1) {
          var needed = parts[i].match(/\{(\w+)\}/g) || [];
          var ok = true;
          for (var j = 0; j < needed.length; j += 1) {
            if (!usable(params ? params[needed[j].slice(1, -1)] : undefined)) { ok = false; break; }
          }
          if (ok) kept.push(parts[i]);
        }
        return fill(kept.join(''), params).replace(/\s+$/g, '').replace(/^\s+/g, '');
      }

      /** 把宿主的状态块归一化成 {key, params}；认不出来返回 null ⇒ 状态行说「读不到」。 */
      function readAuto(body) {
        var auto = body !== null && typeof body === 'object' ? body.auto : null;
        if (auto === null || typeof auto !== 'object' || typeof auto.key !== 'string') return null;
        var params = auto.params !== null && typeof auto.params === 'object' ? auto.params : {};
        return { key: auto.key, params: { provider: params.provider, model: params.model } };
      }

      /** 状态行文案：只由宿主给的 auto.key 决定（认不出就按失败文案说）。 */
      function statusText(t, auto) {
        if (auto === null) return t('state.unavailable');
        var key = AUTO_KEYS.indexOf(auto.key) === -1 ? 'auto.failed' : auto.key;
        var text = localize(t(key), auto.params);
        return text === '' ? t('auto.failed') : text;
      }

      /**
       * 唯一的请求入口（源码里只有这一处 fetch）：同源相对路径、每条请求都带闸门请求头、
       * 带 json 的请求自动 application/json，并且永不抛错（网络异常也变成统一的失败形状）。
       */
      function api(path, options) {
        var opts = options || {};
        var headers = { accept: 'application/json' };
        headers[GUARD_NAME] = '1';
        var init = { method: opts.method || 'GET', headers: headers, credentials: 'same-origin' };
        if (opts.json !== undefined) {
          headers['content-type'] = 'application/json';
          init.body = JSON.stringify(opts.json);
        }
        return fetch(ROUTE + path, init).then(function (res) {
          return res.json().catch(function () { return null; }).then(function (body) {
            var ok = res.ok === true && body !== null && typeof body === 'object' && body.ok === true;
            return { ok: ok, status: res.status, body: body };
          });
        }).catch(function (error) {
          return { ok: false, status: 0, body: { ok: false, error: String((error && error.message) || error) } };
        });
      }

      // ─── 5. 栏目组件：介绍 + 一个开关 + 一行状态文字 ──────────────────────────────
      // props：owner 只给 { close }；条目级注入只给 { t }。
      function Section(props) {
        var t = typeof props.t === 'function' ? props.t : function (key) { return key; };
        var useState = React.useState;
        var useEffect = React.useEffect;
        var useRef = React.useRef;

        // enabled：true / false = 宿主的真实开关值；null = 还没读到，或者宿主半侧是旧版本
        // failed ：这次读取本身失败（网络/闸门/宿主没就绪）⇒ 状态行说「读不到」，开关仍可点
        // stale  ：读到了，但响应里没有开关值 ⇒ 宿主半侧还是旧版本，重启 DSH 之后才管用
        var stateHook = useState({ enabled: null, auto: null, failed: false, stale: false });
        var view = stateHook[0];
        var setView = stateHook[1];
        var pendingHook = useState(false); // 写请求在途：这是唯一因「忙」而禁用的时刻
        var pending = pendingHook[0];
        var setPending = pendingHook[1];
        var aliveRef = useRef(true);
        var timersRef = useRef([]);

        ensureCss();

        /** 登记一个定时器（等待与硬超时都走这里，卸载时统一收口）。 */
        function setTimer(fn, ms) {
          var handle = setTimeout(function () {
            timersRef.current = timersRef.current.filter(function (item) { return item !== handle; });
            fn();
          }, ms);
          timersRef.current.push(handle);
          return handle;
        }

        /** 撤掉一个定时器。 */
        function dropTimer(handle) {
          clearTimeout(handle);
          timersRef.current = timersRef.current.filter(function (item) { return item !== handle; });
        }

        /** 清掉所有待执行的定时器。 */
        function clearTimers() {
          for (var i = 0; i < timersRef.current.length; i += 1) clearTimeout(timersRef.current[i]);
          timersRef.current = [];
        }

        // 栏目「切走即卸载」：所有定时器与在途回调都在这里收口
        useEffect(function () {
          aliveRef.current = true;
          return function () { aliveRef.current = false; clearTimers(); };
        }, []);

        /**
         * 与硬超时赛跑：请求挂着不动也必须有个结果，否则开关会永远停在「忙」。
         * 超时也算一次失败结果，调用方照常回读宿主真值。
         */
        function guard(request, ms) {
          return new Promise(function (resolve) {
            var done = false;
            var handle = setTimer(function () {
              if (done) return;
              done = true;
              resolve({ ok: false, status: 0, body: { ok: false, error: 'timeout' }, timedOut: true });
            }, ms);
            request.then(function (value) {
              if (done) return;
              done = true;
              dropTimer(handle);
              resolve(value);
            });
          });
        }

        /** 应用一次 /state 响应，返回开关值（null = 宿主半侧还是旧版本）。 */
        function applyState(body) {
          var enabled = body.enabled === true ? true : body.enabled === false ? false : null;
          setView({ enabled: enabled, auto: readAuto(body), failed: false, stale: enabled === null });
          return enabled;
        }

        /** 读不到（网络/闸门/宿主没就绪）：状态行说「读不到」，开关照样可点。 */
        function applyUnavailable() {
          setView({ enabled: null, auto: null, failed: true, stale: false });
        }

        /** 回读宿主真值：拿到期望值就收工；写成功时才给重试（热重载可能还没生效）。 */
        function readback(expected, retriesLeft, deadline) {
          if (!aliveRef.current) return;
          guard(api('/state', {}), Math.max(SETTLE_MS, deadline - Date.now())).then(function (res) {
            if (!aliveRef.current) return;
            var body = res.ok === true ? res.body : null;
            if (body === null || typeof body !== 'object' || body.unavailable === true) {
              applyUnavailable();
              setPending(false);
              return;
            }
            var enabled = applyState(body);
            if (enabled === expected || retriesLeft <= 0 || Date.now() >= deadline) {
              setPending(false);
              return;
            }
            setTimer(function () { readback(expected, retriesLeft - 1, deadline); }, SETTLE_MS);
          });
        }

        /**
         * 写路径收尾：等 SETTLE_MS 之后回读一次宿主真值，然后解除「忙」。
         * 写成功才允许重试（最多 MAX_RETRY 次）；超时/非 2xx/ok:false 只回读一次就收工。
         */
        function afterWrite(expected, retries) {
          var deadline = Date.now() + SETTLE_TOTAL_MS;
          setTimer(function () { readback(expected, retries, deadline); }, SETTLE_MS);
        }

        // 挂载：只读一次，不轮询
        useEffect(function () {
          api('/state', {}).then(function (res) {
            if (!aliveRef.current) return;
            if (res.ok !== true || res.body === null || typeof res.body !== 'object' || res.body.unavailable === true) {
              applyUnavailable();
              return;
            }
            applyState(res.body);
          });
        }, []);

        /** 切换开关：先乐观切换并置忙，再 PUT；无论成败都在一次回读之后解除「忙」。 */
        function toggle() {
          if (pending === true || view.stale === true) return;
          var next = view.enabled !== true;
          setPending(true);
          setView({ enabled: next, auto: view.auto, failed: view.failed, stale: view.stale });
          guard(api('/config', { method: 'PUT', json: { enabled: next } }), WRITE_TIMEOUT_MS).then(function (res) {
            if (!aliveRef.current) return;
            afterWrite(next, res.ok === true ? MAX_RETRY : 0);
          });
        }

        // 只有两种情况不允许点：写请求在途，以及宿主半侧还是旧版本（点了确实没用）
        var disabled = pending === true || view.stale === true;
        var statusLine = view.failed === true
          ? t('state.unavailable')
          : view.stale === true
            ? t('state.stale')
            : (view.enabled === null && view.auto === null ? t('state.loading') : statusText(t, view.auto));

        return h('div', { className: 'dsh-cdoc', 'data-dsh-compaction-doctor': '1' }, [
          h('p', { key: 'intro', className: 'dsh-cdoc__intro', children: t('intro') }),
          h('label', { key: 'switch', className: 'dsh-cdoc__switch' }, [
            h('input', {
              key: 'input', type: 'checkbox', role: 'switch', className: 'dsh-cdoc__input',
              'aria-label': t('switch.label'), 'aria-checked': view.enabled === true ? 'true' : 'false',
              checked: view.enabled === true, disabled: disabled, onChange: toggle,
            }),
            h('span', { key: 'track', className: 'dsh-cdoc__track', 'aria-hidden': 'true' }, [
              h('span', { key: 'knob', className: 'dsh-cdoc__knob' }),
            ]),
          ]),
          h('p', { key: 'status', className: 'dsh-cdoc__status', role: 'status', children: statusLine }),
        ]);
      }

      // ─── 6. cordis 装配：只有一条注册，硬依赖只有 slots 与 locale ──────────────────
      var inject = ['slots', 'locale'];

      function apply(ctx) {
        ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); },
          'dsh-compaction-doctor: dictionaries');
        var t = ctx.locale.bind(NS);

        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            {
              name: 'settings.section',
              id: 'compaction',
              order: 40,
              // label 必须是 thunk：外壳只在语言变化时重投影
              label: function () { return t('nav'); },
              inject: function () { return { t: t }; },
            },
            Section,
          );
        });
      }

      module.exports = { name: 'compaction-doctor', inject: inject, apply: apply };
      return module.exports;
    },
  });
})();
