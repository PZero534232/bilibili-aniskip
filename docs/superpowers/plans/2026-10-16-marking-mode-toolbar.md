# 标记模式浮动工具条 + 进度条标记 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「本地标记 OP/ED」的入口从设置面板搬到胶囊 `🎯` 按钮 + 播放器左下角的非模态浮动工具条，并在 B 站进度条上叠加已标区间。

**Architecture:** 工具条用**独立的 host + shadow root**（`markHost`），与胶囊/Toast 的 `host` 隔离 —— 这样真全屏时只需把工具条 host 重挂进 `document.fullscreenElement`，不必把胶囊也搬进全屏子树。纯逻辑（删单条、百分比换算、区间换算）抽成纯函数单独单测；DOM/全屏/进度条注入靠人工验证。

**Tech Stack:** 单文件 ES5 Tampermonkey userscript（无构建，`var`/`function`，禁止 `let`/`const`/箭头/模板字符串）+ 零依赖 Node 测试harness（`test/bilibili-aniskip.test.js`，可自由用 ES6）。

**Spec:** `docs/superpowers/specs/2026-10-16-marking-mode-toolbar-design.md`

---

## 文件结构

| 文件 | 职责 | 本次改动 |
| --- | --- | --- |
| `bilibili-aniskip.user.js` | 全部脚本逻辑 | §14.1 加 `removeLocalSeg`；§15 加 `pct`/`progressMarks`/`markHostParent`/`ensureMarkHost`/`renderMark`/`refreshMarkBar`/`seekTo`/`paintOneBar`/`paintProgressMarks`/`markToggle` + `MARK_CSS`/`MARK_ON_KEY`/`MARK_POS_KEY`；改 `renderPill`/`applyScreen`/`afterMark`/`boot`/`bootTimer`/`openSettings`；`api`/`api_` 加钩子 |
| `test/bilibili-aniskip.test.js` | 冒烟测试 | `makeEnv` 支持 `opts.bars`；新增组 `48a`~`48g` |
| `README.md` | 用户文档 | 特性清单 + 0.5.0 changelog 改成「胶囊 🎯 + 工具条」 |
| `docs/superpowers/specs/2026-10-16-local-op-ed-ed-end-and-settings-ui-design.md` | 旧 spec | 顶部加修订说明（该节已被本设计移除） |

**通用约定（每个任务都适用）**

- 所有 `bilibili-aniskip.user.js` 的新增/修改代码必须是 **ES5**：`var` / `function` / 字符串拼接；**禁止** `let` / `const` / 箭头函数 / 模板字符串 / 展开运算符。测试文件不受此限。
- 跑测试：`node test/bilibili-aniskip.test.js -q`（**不要用管道**，沙箱会报 `Access is denied`）。结果行是 `结果：N 通过 / M 失败`，**硬要求 0 失败**。
- 语法检查：`node --check bilibili-aniskip.user.js`。
- 提交身份固定：`git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "..."`。Git 的 LF→CRLF 警告忽略。
- 测试 harness 速查：`makeEnv(opts)` → `{api, store, intervals, cleared, ...}`；`hook(env,'name')` → `env.api.api_[name]`；`env.api._x` → `api` 上的调试钩子；断言 `check(name, got, want)` / `checkTrue(name, cond)` / `head(title)`。
- 桩节点（`el(tag)`）支持：`classList` / `dataset` / `style`（只保证 `style.cssText` 与任意属性赋值）/ `appendChild` / `removeChild` / `remove` / `setAttribute` / `getAttribute` / `addEventListener` / `dispatch` / `click()` / `attachShadow()` / `querySelector(All)`（支持 class、`[data-x=y]`、后代组合）/ `innerHTML`（只解析标签+属性+纯文本）/ `textContent`。
- **桩里 `document.querySelectorAll` 默认返回空**（除 `video`）；进度条用例靠本计划 Task 7 给 `makeEnv` 加的 `opts.bars`。
- 种子绑定：`makeEnv({ store: { autoDetect: 'off', _bindings: JSON.stringify({ 'b:BV_TEST000001': { title: '葬送のフリーレン', episodes: 28, anchorPage: 1 } }) } })`，默认 `location` 就是 `/video/BV_TEST000001?p=1`，`ctxOf('BV_TEST000001', 1)` 造上下文；绑定键（`bind._key`）是 `b:BV_TEST000001`。
- 已存在可直接调用的函数：`currentBinding()` / `loadLocalSegs(key)` / `saveLocalSegs(key,segs)` / `localSegsKey(key)` / `markOpStart|markOpEnd|markEdStart|markEdEnd` / `syncFrameMonitor(r)` / `showToast(t,m)` / `noFocus(node)` / `getVideo()` / `fmtSec(n)` / `runtime.*` / `gmGet(k,d)` / `gmSet(k,v)` / `GM_deleteValue`。

---

### Task 1: `removeLocalSeg` 纯函数（删掉单条标记）

**Files:**
- Modify: `bilibili-aniskip.user.js`（§14.1，紧邻 `recordEdEnd` 之后；以及 `api_` 导出）
- Test: `test/bilibili-aniskip.test.js`（新增组 `48a`，插在 `/* --- 汇总 --- */` 之前）

- [ ] **Step 1: 写失败测试**

在 `test/bilibili-aniskip.test.js` 里找到 `  /* --- 汇总 --- */`，在它**之前**插入：

```js
  head('48a. 删掉单条标记 removeLocalSeg');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const rm = hook(env, 'removeLocalSeg');
    checkTrue('api_.removeLocalSeg 已导出', typeof rm === 'function');
    if (typeof rm === 'function') {
      const src = {
        ops: [{ hash: 'a', start: 0, end: 90 }, { hash: 'b', start: 100, end: 190 }],
        eds: [{ hash: 'c', start: 1300, end: 1400 }]
      };
      const r1 = rm(src, 'ops', 0);
      check('删 ops 第 0 条后剩 1 条', r1.ops.length, 1);
      check('剩下的是原来第 1 条', r1.ops[0].hash, 'b');
      check('入参没被改（返回新对象）', src.ops.length, 2);
      check('eds 不受影响', r1.eds.length, 1);
      check('删 eds 越界不动', rm(src, 'eds', 9).eds.length, 1);
      check('listKey 非法不动', rm(src, 'nope', 0).ops.length, 2);
      check('空值不抛错', rm(null, 'ops', 0).ops.length, 0);
    }
  }
```

- [ ] **Step 2: 跑一遍确认红**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: 有失败，含 `api_.removeLocalSeg 已导出`（未导出）。

- [ ] **Step 3: 实现**

在 `bilibili-aniskip.user.js` 里找到 `recordEdEnd` 的结束：

```js
  function recordEdEnd(segs, time) {
    var out = validateLocalSegs(segs);
    for (var i = out.eds.length - 1; i >= 0; i--) {
      if (out.eds[i].end < 0) { out.eds[i].end = time; break; }
    }
    return out;
  }
```

在它**之后**插入：

```js
  /* 删掉指定的那一条（工具条列表里的 ✕）。listKey = 'ops' | 'eds'。
   * 先过 validateLocalSegs：拿到的永远是干净的副本，不会改到调用方的对象。 */
  function removeLocalSeg(segs, listKey, index) {
    var out = validateLocalSegs(segs);
    var list = out[listKey];
    if (!list || typeof index !== 'number' || index < 0 || index >= list.length) return out;
    list.splice(index, 1);
    return out;
  }
```

再把 `api_` 导出里这一行：

```js
        recordEdEnd: recordEdEnd,
```

改成：

```js
        recordEdEnd: recordEdEnd, removeLocalSeg: removeLocalSeg,
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `0 失败`（通过数 ≈ 594；以实际为准，硬要求 **0 失败**）。

- [ ] **Step 5: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 新增 removeLocalSeg 纯函数（工具条单条删除用）"
```

---

### Task 2: `pct` / `progressMarks` 纯函数（进度条百分比换算）

**Files:**
- Modify: `bilibili-aniskip.user.js`（§15 UI 区，紧邻 `renderPill` 之前；以及 `api_` 导出）
- Test: `test/bilibili-aniskip.test.js`（新增组 `48b`）

- [ ] **Step 1: 写失败测试**

在 `  /* --- 汇总 --- */` 之前插入：

```js
  head('48b. 进度条标记换算 pct / progressMarks');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const pctF = hook(env, 'pct');
    const pm = hook(env, 'progressMarks');
    checkTrue('api_.pct 已导出', typeof pctF === 'function');
    checkTrue('api_.progressMarks 已导出', typeof pm === 'function');
    if (typeof pctF === 'function' && typeof pm === 'function') {
      check('pct 一半', pctF(700, 1400), 50);
      check('pct 超出时长夹到 100', pctF(2000, 1400), 100);
      check('pct 负数 → 0', pctF(-5, 1400), 0);
      check('pct 时长非法 → 0', pctF(10, 0), 0);
      const ms = pm({ ops: [{ hash: 'a', start: 10, end: 70 }], eds: [{ hash: 'b', start: 1300, end: -1 }] }, 1400);
      check('两条标记都产出', ms.length, 2);
      check('op 起点百分比', Math.round(ms[0].a * 100) / 100, 0.71);
      check('op 终点百分比', Math.round(ms[0].b * 100) / 100, 5);
      check('ED 未标结束 → 画到片尾', ms[1].b, 100);
      check('pending 的 OP 不画', pm({ ops: [{ hash: 'p', start: 10, end: -1 }], eds: [] }, 1400).length, 0);
      check('时长为 0 → 空数组', pm({ ops: [{ hash: 'a', start: 1, end: 2 }], eds: [] }, 0).length, 0);
    }
  }
```

- [ ] **Step 2: 跑一遍确认红**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: 有失败，含 `api_.pct 已导出`（未导出）。

- [ ] **Step 3: 实现**

在 `bilibili-aniskip.user.js` 里找到 §15 的分隔注释：

```js
  /* ==================================================================
   * 15. UI：状态胶囊 + 绑定面板 + 设置面板 + Toast
   * ================================================================== */
  var host = null, shadow = null, uiRoot = null, toastRoot = null;
```

改成（在 `var host ...` 之后插入两个纯函数）：

```js
  /* ==================================================================
   * 15. UI：状态胶囊 + 标记工具条 + 绑定面板 + 设置面板 + Toast
   * ================================================================== */
  var host = null, shadow = null, uiRoot = null, toastRoot = null;

  /* 秒 → 进度条百分比（0~100）。时长非法时一律 0，绝不除零。 */
  function pct(t, dur) {
    if (!(dur > 0) || !isFinite(t) || t <= 0) return 0;
    var v = t / dur * 100;
    return v > 100 ? 100 : v;
  }

  /* 本地标记 → 进度条上要画的区间 [{type:'op'|'ed', a:起%, b:终%}]。
   * · 未标结束的 OP 不画（它本来就不参与匹配）；
   * · 未标结束的 ED 画到片尾（对应「落视频时长」的语义）。 */
  function progressMarks(segs, dur) {
    var out = [];
    if (!(dur > 0)) return out;
    var ops = (segs && segs.ops) || [], eds = (segs && segs.eds) || [], i;
    for (i = 0; i < ops.length; i++) {
      if (!(ops[i].end > ops[i].start)) continue;
      out.push({ type: 'op', a: pct(ops[i].start, dur), b: pct(ops[i].end, dur) });
    }
    for (i = 0; i < eds.length; i++) {
      var s = eds[i].start;
      var e = (eds[i].end > eds[i].start) ? eds[i].end : dur;
      out.push({ type: 'ed', a: pct(s, dur), b: pct(e, dur) });
    }
    return out;
  }
```

再把 `api_` 导出里 Task 1 改过的那一行：

```js
        recordEdEnd: recordEdEnd, removeLocalSeg: removeLocalSeg,
```

改成：

```js
        recordEdEnd: recordEdEnd, removeLocalSeg: removeLocalSeg,
        pct: pct, progressMarks: progressMarks,
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `0 失败`（通过数 ≈ 605；以实际为准）。

- [ ] **Step 5: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 新增 pct / progressMarks 纯函数（进度条标记换算）"
```

---

### Task 3: 工具条独立 host + 全屏挂载点选择

**Files:**
- Modify: `bilibili-aniskip.user.js`（§15；`runtime` 字面量加字段；`api` 加调试钩子）
- Test: `test/bilibili-aniskip.test.js`（新增组 `48c`）

- [ ] **Step 1: 写失败测试**

在 `  /* --- 汇总 --- */` 之前插入：

```js
  head('48c. 工具条 host：全屏挂载点选择');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const ensure = hook(env, '_ensureMarkHost');
    checkTrue('api._ensureMarkHost 已导出', typeof ensure === 'function');
    const root = typeof ensure === 'function' ? ensure() : null;
    checkTrue('ensure 返回 host 本身（tagName=DIV）', !!root && root.tagName === 'DIV');
    if (root) {
      /* host 必须是「铺满视口」的容器：它 0×0 时 .mkroot 的 100% 会解析成 0，
       * MARK_BAR_CSS 的 bottom:64px 就会把工具条顶到屏幕外 —— 桩没有排版引擎，
       * 只能这样守住几何前提。 */
      const hostCss = String(root.style.cssText || '');
      checkTrue('host 铺满视口（fixed + right/bottom:0）',
        /position:fixed/.test(hostCss) && /right:0/.test(hostCss) && /bottom:0/.test(hostCss));
      checkTrue('host 不挡鼠标（pointer-events:none）', /pointer-events:none/.test(hostCss));
      checkTrue('host 的父节点是 body', root.parentNode === env.body);
      checkTrue('host 有 shadowRoot', !!root.shadowRoot);
      const kids = root.shadowRoot ? root.shadowRoot._children.length : -1;
      checkTrue('shadow 里正好 style + mkroot', kids === 2);
      /* 注意：check() 用 brief() 字符串化比较，两个裸 <div> 都会变成 "<div>" ——
       * 凡是「同一个对象」「没多挂一次」这类断言，必须用 checkTrue 做恒等比较，
       * 否则就是永远通过的空断言。 */
      checkTrue('重复调用返回同一个 host（同一对象）', ensure() === root);
      checkTrue('重复调用不会重建 shadow 内容', (root.shadowRoot ? root.shadowRoot._children.length : -1) === kids);
      checkTrue('重复调用不会重复挂到 body', env.body._children.filter(function (c) { return c === root; }).length === 1);
      /* 桩的 appendChild 不会把节点从旧父节点的 _children 里摘掉（真实 DOM 会），
       * 所以这里断言 parentNode 而不是「旧父节点里没有了」 */
      const fsEl = el('div');
      global.document.fullscreenElement = fsEl;
      ensure();
      checkTrue('真全屏时 host 的父节点换成全屏元素', root.parentNode === fsEl);
      checkTrue('host 出现在全屏元素的子节点里', fsEl._children.indexOf(root) >= 0);
      global.document.fullscreenElement = null;
      ensure();
      checkTrue('退出全屏挂回 body', root.parentNode === env.body);
      const vid = el('video');
      global.document.fullscreenElement = vid;
      ensure();
      checkTrue('全屏元素是 video → 退回 body', root.parentNode === env.body);
      global.document.fullscreenElement = null;
      ensure();
    }
  }
```

- [ ] **Step 2: 跑一遍确认红**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: 有失败，含 `api._ensureMarkHost 已导出`（未导出）。

- [ ] **Step 3: 实现**

先给 `runtime` 字面量加字段。找到：

```js
    frameMatcher: null,      // { target, hits }：抽帧匹配的连续命中状态
    frameTimer: null,        // 抽帧 interval 句柄
    localSegs: null          // 当前 binding 的本地指纹 { ops, eds }
  };
```

改成：

```js
    frameMatcher: null,      // { target, hits }：抽帧匹配的连续命中状态
    frameTimer: null,        // 抽帧 interval 句柄
    localSegs: null,         // 当前 binding 的本地指纹 { ops, eds }
    markOn: false            // 是否处于「标记模式」（工具条显示中）
  };
```

再在 §15 里找到 Task 2 刚加的 `progressMarks` 的结束，在它**之后**插入：

```js
  /* ---- 标记工具条：独立 host（不与胶囊共用，见 spec §5） ---- */
  var MARK_ON_KEY = '_markOn';
  var MARK_POS_KEY = '_markPos';
  var markHost = null, markShadow = null, markRoot = null;

  var MARK_BAR_CSS = 'position:absolute;left:16px;bottom:64px;width:300px;pointer-events:auto;' +
    'background:rgba(20,22,26,.92);color:#fff;border-radius:12px;padding:10px 12px;' +
    'box-shadow:0 8px 28px rgba(0,0,0,.4);backdrop-filter:blur(6px);' +
    'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;';

  var MARK_CSS = [
    '.mkroot{position:absolute;top:0;left:0;width:100%;height:100%;}',
    '.mkhead{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:8px;}',
    '.mkclose{cursor:pointer;opacity:.75;padding:0 4px;} .mkclose:hover{opacity:1;}',
    '.mkbtns{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;}',
    'button.mkbtn{padding:5px 9px;border-radius:7px;border:1px solid rgba(255,255,255,.22);',
    '  background:rgba(255,255,255,.08);color:#fff;font-size:12px;cursor:pointer;}',
    'button.mkbtn:hover{background:rgba(255,255,255,.18);}',
    'button.mkclr{color:#ff9a9e;border-color:rgba(255,120,120,.35);}',
    '.mkstat{color:rgba(255,255,255,.72);font-size:12px;line-height:1.6;margin-bottom:6px;word-break:break-all;}',
    '.mklist{max-height:132px;overflow:auto;margin-bottom:8px;}',
    '.mkrow{display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;}',
    '.mkrow .mktxt{cursor:pointer;opacity:.9;} .mkrow .mktxt:hover{opacity:1;text-decoration:underline;}',
    '.mkrow .mkdel{cursor:pointer;opacity:.6;padding:0 4px;} .mkrow .mkdel:hover{opacity:1;color:#ff9a9e;}',
    '.mkempty,.mkfoot{color:rgba(255,255,255,.55);font-size:12px;}',
    '.mkfoot{margin-top:2px;}'
  ].join('');

  /* 工具条该挂在谁下面：真全屏时浏览器只渲染全屏子树，挂在 body 上会看不见。
   * 但全屏元素是 <video> 时挂不了子节点，只能退回 body —— 用鸭子类型判断，
   * 不用 instanceof Element（测试桩里没有 Element 构造器）。 */
  function markHostParent() {
    var fe = null;
    try { fe = document.fullscreenElement || null; } catch (e) { fe = null; }
    if (fe && typeof fe.appendChild === 'function' &&
        String(fe.tagName || '').toLowerCase() !== 'video') return fe;
    return document.body || document.documentElement;
  }

  /* 幂等：host 只建一次，之后每次把位置摆对（全屏进出会换父节点）。返回 host。 */
  function ensureMarkHost() {
    if (!markHost) {
      markHost = document.createElement('div');
      markHost.id = 'bili-aniskip-mark-host';
      markHost.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483000;pointer-events:none;';
      markShadow = markHost.attachShadow({ mode: 'open' });
      var st = document.createElement('style');
      st.textContent = MARK_CSS;
      markShadow.appendChild(st);
      markRoot = document.createElement('div');
      markRoot.className = 'mkroot';
      markShadow.appendChild(markRoot);
    }
    var parent = markHostParent();
    if (markHost.parentNode !== parent) parent.appendChild(markHost);
    return markHost;
  }
```

再把 `api` 调试钩子里这一行：

```js
      _markEdEnd: markEdEnd,
```

改成：

```js
      _markEdEnd: markEdEnd,
      _ensureMarkHost: ensureMarkHost,
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `0 失败`（通过数 ≈ 626；以实际为准）。

- [ ] **Step 5: 语法检查**

Run: `node --check bilibili-aniskip.user.js`
Expected: 无输出、exit 0。

- [ ] **Step 6: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 标记工具条独立 host + 全屏挂载点选择"
```

---

### Task 4: 工具条渲染（结构 + 状态行 + 列表）

**Files:**
- Modify: `bilibili-aniskip.user.js`（§15；`api` 加钩子）
- Test: `test/bilibili-aniskip.test.js`（新增组 `48d`）

> 本任务只做「画出来」：4 个标记按钮 + 状态行 + 列表 + 关闭按钮。**按钮的动作在 Task 5 绑定。**

- [ ] **Step 1: 写失败测试**

在 `  /* --- 汇总 --- */` 之前插入：

```js
  head('48d. 工具条渲染：标记模式进出 + 结构');
  {
    const BIND = { title: '葬送のフリーレン', episodes: 28, anchorPage: 1 };
    const env = makeEnv({
      store: { autoDetect: 'off', _bindings: JSON.stringify({ 'b:BV_TEST000001': BIND }) }
    });
    const toggle = env.api._markToggle;
    const save = hook(env, 'saveLocalSegs');
    checkTrue('api._markToggle 已导出', typeof toggle === 'function');
    if (typeof toggle === 'function' && typeof save === 'function') {
      env.api._runtime.ctx = ctxOf('BV_TEST000001', 1);
      save('b:BV_TEST000001', {
        ops: [{ hash: 'aaaa', start: 12, end: 102 }],
        eds: [{ hash: 'bbbb', start: 1300, end: -1 }]
      });
      check('初始不在标记模式', env.api._runtime.markOn, false);
      toggle();
      check('进入标记模式', env.api._runtime.markOn, true);
      const host = env.api._runtime.markHostForTest || null;   // 见 Step 3 说明
      const root = (host && host.shadowRoot) || null;
      const rootOk = !!(root && root.querySelector('.mkbar'));
      checkTrue('工具条已画出', rootOk, true);
      const bar = rootOk ? root.querySelector('.mkbar') : el('div');
      check('4 个标记按钮', (bar.querySelectorAll('.mkbtn') || []).length >= 4, true);
      check('状态行显示套数', /已标 OP 1 套 \/ ED 1 套/.test((rootOk ? root.querySelector('.mkstat') : el('div')).textContent), true);
      check('列表 2 行', (rootOk ? root.querySelectorAll('.mkrow') : []).length, 2);
      check('ED 未标结束显示 ——', /ED.*——/.test((rootOk ? root.querySelector('.mklist') : el('div')).textContent), true);
      toggle();
      check('退出标记模式', env.api._runtime.markOn, false);
      check('退出后工具条清空', rootOk ? root.querySelector('.mkbar') : null, null);
      check('标记模式状态落盘', env.store._markOn, false);
    }
  }
```

- [ ] **Step 2: 跑一遍确认红**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: 有失败，含 `api._markToggle 已导出`（未导出）。

- [ ] **Step 3: 实现**

在 §15 里 `ensureMarkHost` 之后插入：

**⓪ 先做一件前置事：把 `fmtSec` 提到模块作用域。** 它现在定义在 `openSettings()` 内部（缩进 4 空格的 `function fmtSec(n) {...}`，函数体是 `if (!isFinite(n) || n < 0) return '——'; return Math.round(n * 10) / 10 + 's';`）。工具条在模块作用域要用它，所以：

- 在下面的 `seekTo` **之前**，按原样插入同样函数体的模块级 `fmtSec`（缩进 2 空格），前面加注释 `/* 工具条与设置面板共用的秒数显示 */`；
- 删掉 `openSettings()` 里那份局部定义（函数体一字不改）。`openSettings` 里剩下的 `refreshMark()` 等调用会自动解析到模块级那份，行为不变。

然后再插入：

```js
  /* 把秒跳到某个位置（工具条列表点行用）。不改变播放状态。 */
  function seekTo(t) {
    var v = runtime.video || getVideo();
    if (!v || !isFinite(t)) return;
    try { v.currentTime = t; } catch (e) { /* ignore */ }
  }

  /* 标记模式开关：落盘 + 重画工具条 + 重画胶囊（🎯 高亮态）。 */
  function markToggle() {
    runtime.markOn = !runtime.markOn;
    gmSet(MARK_ON_KEY, runtime.markOn);
    renderMark();
    renderPill();
  }

  /* 画工具条。markOn 为假时清空并隐藏（host 保留，全屏进出还要用）。 */
  function renderMark() {
    if (!runtime.markOn) {
      if (markRoot) { markRoot.innerHTML = ''; markRoot.style.display = 'none'; }
      return;
    }
    ensureMarkHost();
    markRoot.style.display = '';
    markRoot.innerHTML = '';
    var bar = document.createElement('div');
    bar.className = 'mkbar';
    bar.style.cssText = MARK_BAR_CSS;
    bar.innerHTML =
      '<div class="mkhead"><span>标记 OP / ED</span><button class="mkclose" title="退出标记模式">✕</button></div>' +
      '<div class="mkbtns">' +
      '<button class="mkbtn" data-mk="op-s">标 OP 开始</button>' +
      '<button class="mkbtn" data-mk="op-e">标 OP 结束</button>' +
      '<button class="mkbtn" data-mk="ed-s">标 ED 开始</button>' +
      '<button class="mkbtn" data-mk="ed-e">标 ED 结束</button>' +
      '</div>' +
      '<div class="mkstat"></div>' +
      '<div class="mklist"></div>' +
      '<div class="mkfoot"><button class="mkbtn mkclr" data-mk="clr">清空本番标记</button></div>';
    var closeBtn = bar.querySelector('.mkclose');
    if (closeBtn) {
      noFocus(closeBtn);
      closeBtn.addEventListener('click', function () {
        runtime.markOn = false;
        gmSet(MARK_ON_KEY, false);
        renderMark();
        renderPill();
      });
    }
    applyMarkPos(bar);
    attachMarkDrag(bar);
    markRoot.appendChild(bar);
    refreshMarkBar();
  }

  /* 状态行 + 列表。只更新这两块，不重建整个工具条。 */
  function refreshMarkBar() {
    if (!markRoot) return;
    var stat = markRoot.querySelector('.mkstat');
    var list = markRoot.querySelector('.mklist');
    if (!stat || !list) return;
    var bind = currentBinding();
    if (!bind) {
      stat.textContent = '当前：未绑定 —— 先去胶囊点「绑定」';
      list.textContent = '';
      return;
    }
    var segs = loadLocalSegs(bind._key);
    var ops = segs.ops || [], eds = segs.eds || [];
    stat.textContent = '当前：' + (bind.title || bind._key) +
      '   已标 OP ' + ops.length + ' 套 / ED ' + eds.length + ' 套';
    list.textContent = '';
    var rows = [], i;
    for (i = 0; i < ops.length; i++) rows.push({ listKey: 'ops', i: i, label: 'OP', s: ops[i].start, e: ops[i].end });
    for (i = 0; i < eds.length; i++) rows.push({ listKey: 'eds', i: i, label: 'ED', s: eds[i].start, e: eds[i].end });
    if (!rows.length) { list.textContent = '还没标过'; return; }
    for (i = 0; i < rows.length; i++) list.appendChild(buildMarkRow(rows[i]));
  }

  /* 一行：`OP  0:12 → 1:42` + 行尾 ✕。点击正文跳过去，点击 ✕ 删这一条。 */
  function buildMarkRow(row) {
    var wrap = document.createElement('div');
    wrap.className = 'mkrow';
    var txt = document.createElement('span');
    txt.className = 'mktxt';
    txt.textContent = row.label + '  ' + fmtSec(row.s) + ' → ' + (row.e > row.s ? fmtSec(row.e) : '——');
    txt.title = '跳到这个标记点';
    noFocus(txt);
    txt.addEventListener('click', function () { seekTo(row.s); });
    var del = document.createElement('span');
    del.className = 'mkdel';
    del.textContent = '✕';
    del.title = '删掉这一条';
    noFocus(del);
    del.addEventListener('click', function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      delLocalSeg(row.listKey, row.i, row.label);
    });
    wrap.appendChild(txt);
    wrap.appendChild(del);
    return wrap;
  }

  /* 删单条：落盘 → 重新同步抽帧（顺带清掉已跳指纹）→ 重画工具条与进度条。 */
  function delLocalSeg(listKey, index, label) {
    var bind = currentBinding();
    if (!bind) return;
    saveLocalSegs(bind._key, removeLocalSeg(loadLocalSegs(bind._key), listKey, index));
    syncFrameMonitor(runtime.result);
    renderMark();
    paintProgressMarks();
    showToast('已删掉这条标记', label + ' 第 ' + (index + 1) + ' 条');
  }
```

**注意**：本任务里 `applyMarkPos` / `attachMarkDrag` / `paintProgressMarks` 还没定义 —— 为了让每一步都能独立跑通，先在 `renderMark` 里**临时注释掉** `applyMarkPos(bar); attachMarkDrag(bar);`，并**临时删掉** `delLocalSeg` 里的 `paintProgressMarks();`，等 Task 6 / Task 7 再打开。也就是本任务先写成：

```js
    // Task 6 打开：applyMarkPos(bar); attachMarkDrag(bar);
    markRoot.appendChild(bar);
```

和

```js
    renderMark();
    // Task 7 打开：paintProgressMarks();
    showToast('已删掉这条标记', label + ' 第 ' + (index + 1) + ' 条');
```

然后在 `api` 调试钩子里，`_ensureMarkHost: ensureMarkHost,` 之后加：

```js
      _markToggle: markToggle, _renderMark: renderMark, _refreshMarkBar: refreshMarkBar,
      _markHost: function () { return markHost; },
```

并在 `api` 的对象里找一个合适的地方放（就在 `_markEdEnd` 附近）。

**关于测试里的 host 拿法**：Step 1 用的是 `env.api._runtime.markHostForTest`，改成用 `env.api._markHost()`。把测试里这两行：

```js
      const host = env.api._runtime.markHostForTest || null;   // 见 Step 3 说明
      const root = (host && host.shadowRoot) || null;
```

改成：

```js
      const host = env.api._markHost ? env.api._markHost() : null;
      const root = (host && host.shadowRoot) || null;
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `0 失败`（通过数 ≈ 621；以实际为准）。

- [ ] **Step 5: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 标记工具条渲染（4 个标记按钮 + 状态行 + 已标列表）"
```

---

### Task 5: 工具条按钮绑定（4 个标记 + 清空）

**Files:**
- Modify: `bilibili-aniskip.user.js`（`renderMark` 内加绑定）
- Test: `test/bilibili-aniskip.test.js`（新增组 `48e`）

- [ ] **Step 1: 写失败测试**

在 `  /* --- 汇总 --- */` 之前插入：

```js
  head('48e. 工具条按钮：标记动作 + 清空');
  {
    const env = makeEnv({
      store: { autoDetect: 'off', _bindings: JSON.stringify({ 'b:BV_TEST000001': { title: 'T', episodes: 28, anchorPage: 1 } }) }
    });
    env.api._runtime.ctx = ctxOf('BV_TEST000001', 1);
    env.api._runtime.video = { currentTime: 77, duration: 1400, paused: true, ended: false,
      play() {}, addEventListener() {} };
    const toggle = env.api._markToggle;
    checkTrue('api._markToggle 已导出', typeof toggle === 'function');
    if (typeof toggle === 'function') {
      toggle();
      const root = env.api._markHost().shadowRoot;
      const opStart = root.querySelector('[data-mk=op-s]');
      const opEnd = root.querySelector('[data-mk=op-e]');
      const clr = root.querySelector('[data-mk=clr]');
      checkTrue('找得到「标 OP 开始」', !!opStart, true);
      // 抓帧失败（桩里没有真 video）→ 走 toast 分支、不写数据，但监听必须已挂上
      opStart.dispatch('click', {});
      check('标 OP 开始 已挂监听', (opStart._listeners.click || []).length > 0, true);
      check('抓不到画面时不写脏数据', JSON.parse(env.store['aniskip.localSegs.b:BV_TEST000001'] || '{"ops":[]}').ops.length, 0);
      // 直接种一条，验证「标 OP 结束」能补上 end 并刷新列表
      const save = hook(env, 'saveLocalSegs');
      save('b:BV_TEST000001', { ops: [{ hash: 'h', start: 10, end: -1 }], eds: [] });
      env.api._renderMark();
      const r2 = env.api._markHost().shadowRoot;
      r2.querySelector('[data-mk=op-e]').dispatch('click', {});
      const after = JSON.parse(env.store['aniskip.localSegs.b:BV_TEST000001'] || '{"ops":[]}');
      check('标 OP 结束 补上 end', after.ops[0].end, 77);
      check('列表即时刷新（显示 77s）', /77s/.test(r2.querySelector('.mklist').textContent), true);
      r2.querySelector('[data-mk=clr]').dispatch('click', {});
      check('清空本番标记', env.store['aniskip.localSegs.b:BV_TEST000001'], undefined);
      check('清空后列表显示「还没标过」', /还没标过/.test(r2.querySelector('.mklist').textContent), true);
      toggle();
    }
  }
```

- [ ] **Step 2: 跑一遍确认红**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: 有失败，含 `标 OP 结束 补上 end`（按钮还没绑动作）。

- [ ] **Step 3: 实现**

在 `renderMark` 里，`bar.innerHTML = ...;` 之后、`var closeBtn = ...` **之前**插入：

```js
    /* 四个标记按钮：直接复用既有 handler（内部已有未绑定/抓帧失败的 toast 分支），
     * 点完不关工具条，就地刷新状态行、列表、进度条。 */
    var mkPairs = [['op-s', markOpStart], ['op-e', markOpEnd], ['ed-s', markEdStart], ['ed-e', markEdEnd]];
    for (var mi = 0; mi < mkPairs.length; mi++) {
      (function (name, fn) {
        var node = bar.querySelector('[data-mk=' + name + ']');
        if (!node) return;
        noFocus(node);
        node.addEventListener('click', function () {
          fn();
          refreshMarkBar();
          // Task 7 打开：paintProgressMarks();
        });
      })(mkPairs[mi][0], mkPairs[mi][1]);
    }
    var clrBtn = bar.querySelector('[data-mk=clr]');
    if (clrBtn) {
      noFocus(clrBtn);
      clrBtn.addEventListener('click', function () {
        var bind = currentBinding();
        if (!bind) { showToast('清空本番标记', '当前没有绑定番剧'); return; }
        try { GM_deleteValue(localSegsKey(bind._key)); } catch (e) { /* ignore */ }
        syncFrameMonitor(runtime.result);
        refreshMarkBar();
        // Task 7 打开：paintProgressMarks();
        showToast('清空本番标记', '已删掉这个番的本地指纹');
      });
    }
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `0 失败`（通过数 ≈ 628；以实际为准）。

- [ ] **Step 5: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 工具条四个标记按钮绑定 + 清空本番标记"
```

---

### Task 6: 胶囊 `🎯` 入口 + 拖动 + 全屏重挂

**Files:**
- Modify: `bilibili-aniskip.user.js`（`renderPill`、`applyScreen`、`afterMark`、`boot`）
- Test: `test/bilibili-aniskip.test.js`（新增组 `48f`）

- [ ] **Step 1: 写失败测试**

在 `  /* --- 汇总 --- */` 之前插入：

```js
  head('48f. 胶囊 🎯 入口');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    env.api._runtime.ctx = ctxOf('BV_TEST000001', 1);
    env.api._runtime.result = { ok: false, reason: 'no-match' };
    env.api._renderPill();
    const pill = byClass('pill');
    checkTrue('胶囊渲染出来了', !!pill, true);
    const act = pill && pill.querySelector('[data-a=mark]');
    checkTrue('胶囊上有 🎯 标记入口', !!act, true);
    if (act) {
      check('🎯 有 click 监听', (act._listeners.click || []).length > 0, true);
      act.dispatch('click', {});
      check('点一下进标记模式', env.api._runtime.markOn, true);
      check('状态落盘', env.store._markOn, true);
      act.dispatch('click', {});
      check('再点一下退出', env.api._runtime.markOn, false);
    }
  }
```

- [ ] **Step 2: 跑一遍确认红**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: 有失败，含 `胶囊上有 🎯 标记入口`（还没加）。

- [ ] **Step 3: 实现**

① 在 `renderPill()` 里找到：

```js
    // 末尾统一挂一个设置入口 —— 胶囊原来只有识别出来才出现，想改设置得去油猴菜单，太绕
    parts.push('<span class="sep"></span><span class="act" data-a="cfg" title="番剧跳过设置">⚙</span>');
```

改成：

```js
    // 标记模式入口：一键进出工具条，不用再钻设置面板（低频但常用的动作）
    parts.push('<span class="sep"></span><span class="act" data-a="mark" title="标记 OP/ED 帧">🎯</span>');
    // 末尾统一挂一个设置入口 —— 胶囊原来只有识别出来才出现，想改设置得去油猴菜单，太绕
    parts.push('<span class="sep"></span><span class="act" data-a="cfg" title="番剧跳过设置">⚙</span>');
```

② 在 `pill.innerHTML = parts.join('');` 之后、`pill.style.cssText = ...` 之前插入 🎯 的高亮（内联，CSP 拦 `<style>` 也有效）：

```js
    var markAct = pill.querySelector('[data-a=mark]');
    if (markAct) {
      markAct.style.cssText = 'padding:0 2px;opacity:1;color:' +
        (runtime.markOn ? '#00d1b6' : 'rgba(255,255,255,.8)') + ';';
    }
```

③ 在 `onAct('cfg', openSettings);` 之后加一行：

```js
    onAct('mark', markToggle);
```

④ `applyScreen()` 改成（全屏进出时把工具条 host 摆对并重画）：

```js
  function applyScreen() {
    var s = detectScreen();
    var changed = s !== runtime.screen;
    runtime.screen = s;
    if (changed) renderPill();
    /* 工具条与胶囊不同：它在全屏下也要显示，所以每次屏幕状态变化都要重挂 + 重画 */
    if (runtime.markOn) renderMark();
  }
```

⑤ `afterMark()` 改成（标记后同步刷新列表）：

```js
  function afterMark() {
    syncFrameMonitor(runtime.result);
    if (runtime.markOn && markRoot) refreshMarkBar();
    // Task 7 打开：paintProgressMarks();
  }
```

⑥ `boot()` 里恢复标记模式。找到：

```js
    ensureUI();
    renderPill();
    setTimeout(rerun, 900);
```

改成：

```js
    ensureUI();
    renderPill();
    runtime.markOn = !!gmGet(MARK_ON_KEY, false);
    if (runtime.markOn) renderMark();
    setTimeout(rerun, 900);
```

⑦ 拖动（放在 `renderMark` 之后）：

```js
  /* 工具条拖动：位置存 GM，刷新页面还在。位移 < 4px 当点击。 */
  var MARK_DRAG_MIN = 4;

  function readMarkPos() {
    var p = gmGet(MARK_POS_KEY, null);
    if (p && typeof p.left === 'number' && typeof p.top === 'number') return p;
    return null;
  }
  function applyMarkPos(bar) {
    var p = readMarkPos();
    if (!p) return;
    bar.style.left = Math.round(p.left) + 'px';
    bar.style.top = Math.round(p.top) + 'px';
    bar.style.bottom = 'auto';
  }
  function attachMarkDrag(bar) {
    var dragging = false, moved = false, startX = 0, startY = 0, startL = 0, startT = 0;
    bar.addEventListener('mousedown', function (e) {
      if (e && e.target && e.target.getAttribute && e.target.getAttribute('data-mk')) return;
      if (e && e.target && e.target.className && String(e.target.className).indexOf('mkrow') >= 0) return;
      var r = bar.getBoundingClientRect ? bar.getBoundingClientRect() : { left: 0, top: 0 };
      dragging = true; moved = false;
      startX = e.clientX || 0; startY = e.clientY || 0;
      startL = r.left; startT = r.top;
      if (e.preventDefault) e.preventDefault();
    });
    function onMove(e) {
      if (!dragging) return;
      var dx = (e.clientX || 0) - startX, dy = (e.clientY || 0) - startY;
      if (!moved && Math.abs(dx) < MARK_DRAG_MIN && Math.abs(dy) < MARK_DRAG_MIN) return;
      moved = true;
      bar.style.left = Math.round(startL + dx) + 'px';
      bar.style.top = Math.round(startT + dy) + 'px';
      bar.style.bottom = 'auto';
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      if (moved) gmSet(MARK_POS_KEY, { left: parseInt(bar.style.left, 10) || 0, top: parseInt(bar.style.top, 10) || 0 });
    }
    try {
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    } catch (e2) { /* ignore */ }
  }
```

⑧ 把 Task 4 里临时注释掉的拖动打开：

```js
    // Task 6 打开：applyMarkPos(bar); attachMarkDrag(bar);
    markRoot.appendChild(bar);
```

改成：

```js
    applyMarkPos(bar);
    attachMarkDrag(bar);
    markRoot.appendChild(bar);
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `0 失败`（通过数 ≈ 634；以实际为准）。

- [ ] **Step 5: 语法检查 + 提交**

Run: `node --check bilibili-aniskip.user.js`
Expected: 无输出、exit 0。

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 胶囊 🎯 标记入口 + 工具条拖动 + 全屏重挂"
```

---

### Task 7: 进度条上叠加标记

**Files:**
- Modify: `bilibili-aniskip.user.js`（新增 `paintOneBar`/`paintProgressMarks`；打开 `renderMark`/`delLocalSeg`/`afterMark`/标记按钮/清空里预留的调用；`bootTimer` tick 加调用）
- Test: `test/bilibili-aniskip.test.js`（`makeEnv` 加 `opts.bars`；新增组 `48g`）

- [ ] **Step 1: 给 harness 加进度条容器支持**

在 `test/bilibili-aniskip.test.js` 的 `makeEnv` 里找到：

```js
    // opts.video：给「真的跑一遍跳过/撤回」的用例准备的假播放器
    querySelectorAll: (sel) => (sel === 'video' && opts.video) ? [opts.video] : [],
```

改成：

```js
    // opts.video：给「真的跑一遍跳过/撤回」的用例准备的假播放器
    // opts.bars：给「进度条标记」用例准备的假进度条容器
    querySelectorAll: (sel) => {
      if (sel === 'video' && opts.video) return [opts.video];
      if (sel === '.bpx-player-progress-wrap') return opts.bars || [];
      return [];
    },
```

- [ ] **Step 2: 写失败测试**

在 `  /* --- 汇总 --- */` 之前插入：

```js
  head('48g. 进度条标记叠加');
  {
    const bar1 = el('div');
    bar1.className = 'bpx-player-progress-wrap';
    const env = makeEnv({
      store: { autoDetect: 'off', _bindings: JSON.stringify({ 'b:BV_TEST000001': { title: 'T', episodes: 28, anchorPage: 1 } }) },
      bars: [bar1]
    });
    env.api._runtime.ctx = ctxOf('BV_TEST000001', 1);
    env.api._runtime.video = { currentTime: 0, duration: 1400, paused: true, ended: false, play() {}, addEventListener() {} };
    const hookFn = hook(env, 'saveLocalSegs');
    const paint = env.api._paintProgressMarks;
    checkTrue('api._paintProgressMarks 已导出', typeof paint === 'function');
    if (typeof paint === 'function' && typeof hookFn === 'function') {
      hookFn('b:BV_TEST000001', { ops: [{ hash: 'a', start: 0, end: 90 }], eds: [] });
      paint();
      const layer = bar1.querySelector('[data-aniskip-marks]');
      check('进度条里插了覆盖层', !!layer, true);
      check('容器被设为 relative（否则绝对定位会跑偏）', bar1.style.position, 'relative');
      check('画了 2 个元素（区间条 + 起点刻度）', layer ? layer._children.length : 0, 2);
      // 内容没变 → 不重复写 DOM
      const before = layer._children.slice();
      paint();
      check('签名没变时不重写 DOM', layer._children[0] === before[0], true);
      // 清掉标记 → 覆盖层被清空
      hookFn('b:BV_TEST000001', { ops: [], eds: [] });
      paint();
      check('没标记时覆盖层清空', layer._children.length, 0);
      // 找不到容器也不能抛错
      env.api._runtime.ctx = null;
      paint();
      checkTrue('没绑定时不抛错', true, true);
    }
  }
```

- [ ] **Step 3: 跑一遍确认红**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: 有失败，含 `api._paintProgressMarks 已导出`（未导出）。

- [ ] **Step 4: 实现**

在 §15 里 `delLocalSeg` 之后插入：

```js
  /* 把标记画到一个进度条容器上。找不到父容器/写不进 DOM 都静默放弃。
   * 用 dataset 上的签名避免每秒无谓重排；换容器（全屏）时新容器没有签名 → 会重画。 */
  function paintOneBar(bar, marks, sig) {
    try {
      var layer = bar.querySelector('[data-aniskip-marks]');
      if (!layer) {
        var pos = '';
        try {
          var cs = window.getComputedStyle ? window.getComputedStyle(bar) : null;
          pos = (cs && cs.position) || '';
        } catch (e0) { pos = ''; }
        if (pos !== 'relative' && pos !== 'absolute' && pos !== 'fixed') bar.style.position = 'relative';
        layer = document.createElement('div');
        layer.setAttribute('data-aniskip-marks', '1');
        layer.style.cssText = 'position:absolute;top:0;bottom:0;left:0;right:0;pointer-events:none;overflow:hidden;';
        bar.appendChild(layer);
      }
      if (bar.dataset.aniskipSig === sig) return;
      bar.dataset.aniskipSig = sig;
      layer.innerHTML = '';
      for (var i = 0; i < marks.length; i++) {
        var m = marks[i];
        var color = m.type === 'op' ? '#00a1d6' : '#ffb648';
        var span = document.createElement('span');
        span.style.cssText = 'position:absolute;top:0;bottom:0;left:' + m.a + '%;width:' +
          Math.max(0, m.b - m.a) + '%;background:' + color + ';opacity:.55;border-radius:2px;';
        layer.appendChild(span);
        var tick = document.createElement('span');
        tick.style.cssText = 'position:absolute;top:0;bottom:0;left:' + m.a + '%;width:2px;background:' + color + ';';
        layer.appendChild(tick);
      }
    } catch (e) { /* 进度条 DOM 变了就放弃这一条，不影响别的功能 */ }
  }

  /* 在所有能找到的进度条容器上刷新标记。不需要处于标记模式。 */
  function paintProgressMarks() {
    var bars = [];
    try { bars = document.querySelectorAll('.bpx-player-progress-wrap'); } catch (e) { bars = []; }
    if (!bars || !bars.length) return;
    var bind = currentBinding();
    var segs = bind ? loadLocalSegs(bind._key) : null;
    var v = runtime.video || getVideo();
    var dur = (v && v.duration) || 0;
    var marks = progressMarks(segs, dur);
    var sig = '';
    for (var i = 0; i < marks.length; i++) sig += marks[i].type + ':' + marks[i].a + '-' + marks[i].b + ';';
    for (var j = 0; j < bars.length; j++) paintOneBar(bars[j], marks, sig);
  }
```

再把之前预留的调用打开：

| 位置 | 从 | 改成 |
| --- | --- | --- |
| `renderMark` 末尾 | `refreshMarkBar();` | `refreshMarkBar();`<br>`paintProgressMarks();` |
| `delLocalSeg` | `renderMark();`<br>`// Task 7 打开：paintProgressMarks();` | `renderMark();`<br>`paintProgressMarks();` |
| 四个标记按钮的监听 | `refreshMarkBar();`<br>`// Task 7 打开：paintProgressMarks();` | `refreshMarkBar();`<br>`paintProgressMarks();` |
| 清空按钮的监听 | `refreshMarkBar();`<br>`// Task 7 打开：paintProgressMarks();` | `refreshMarkBar();`<br>`paintProgressMarks();` |
| `afterMark` | `if (runtime.markOn && markRoot) refreshMarkBar();`<br>`// Task 7 打开：paintProgressMarks();` | `if (runtime.markOn && markRoot) refreshMarkBar();`<br>`paintProgressMarks();` |

`bootTimer` 的 tick 也要加。找到：

```js
    runtime.bootTimer = setInterval(function () {
      var key = currentBvid() + ':' + currentPage();
      if (key !== runtime.lastLocKey) {
        runtime.lastLocKey = key;
        rerun();
      }
    }, 1200);
```

改成：

```js
    runtime.bootTimer = setInterval(function () {
      var key = currentBvid() + ':' + currentPage();
      if (key !== runtime.lastLocKey) {
        runtime.lastLocKey = key;
        rerun();
      }
      /* 兜底：B 站会重排控制栏（换清晰度/进出全屏），进度条节点会换成新的，
       * 新的没有签名 → 这里会把它补画上。签名没变时不写 DOM。 */
      paintProgressMarks();
    }, 1200);
```

再在 `api` 调试钩子里加：

```js
      _paintProgressMarks: paintProgressMarks,
```

- [ ] **Step 5: 跑测试确认绿**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `0 失败`（通过数 ≈ 642；以实际为准）。

- [ ] **Step 6: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 进度条上叠加本地标记（OP 蓝 / ED 橙）"
```

---

### Task 8: 移除设置面板那一节 + README + 旧 spec 修订注

**Files:**
- Modify: `bilibili-aniskip.user.js`（`openSettings`）
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-16-local-op-ed-ed-end-and-settings-ui-design.md`

- [ ] **Step 1: 删掉设置面板里的标记一节（HTML）**

在 `openSettings()` 里找到这一整块（从 `'<div class="mksec">' +` 到 `'</div></div>' +`，位于「重置位置」行与「清空缓存」行之间），**整块删除**：

```js
      '<div class="mksec">' +
      '<div class="mkhead">本地标记 OP / ED（冷番兜底）</div>' +
      '<div class="mktip">云端没时间戳的番：暂停到画面，点下面按钮标记。脚本靠画面指纹自动识别，同番跨集复用。标记即时生效，不用点「保存」。</div>' +
      '<div class="mkstat"><div class="mknow">—</div><div class="mkop">—</div><div class="mked">—</div></div>' +
      '<div class="btns" style="justify-content:flex-start">' +
      '<button class="mk-op-s">标 OP 开始</button>' +
      '<button class="mk-op-e">标 OP 结束</button>' +
      '<button class="mk-ed-s">标 ED 开始</button>' +
      '<button class="mk-ed-e">标 ED 结束</button>' +
      '<button class="mk-clr danger">清空本番标记</button>' +
      '</div></div>' +
```

- [ ] **Step 2: 删掉对应的 JS**

在同一函数里找到 `/* ---- 本地标记一节：按钮即时生效（不参与「保存」），状态行就地刷新 ---- */` 开始、到 `refreshMark();` 为止的整段（含 `refreshMark` / 样式内联 / 4 个按钮绑定 / `mkClrBtn` / 收尾的 `refreshMark();`），**整段删除**。

注意：`fmtSec` 已在 Task 4 提到模块作用域（`openSettings` 里那份局部定义那时就删掉了），所以这里**不用也不能**再动它 —— 删完这段后 `openSettings` 里不应再有 `fmtSec` 的定义。

- [ ] **Step 3: 跑回归确认没删坏**

Run: `node --check bilibili-aniskip.user.js`
Expected: 无输出、exit 0。

Run: `node test/bilibili-aniskip.test.js -q`
Expected: `0 失败`（通过数不变，≈642）。

- [ ] **Step 4: README 更新**

① 特性清单里这一条：

```
- 🎞 **本地手动标记 OP/ED 帧（冷番兜底）** —— 在设置面板里标 OP/ED 的开始与结束帧，脚本认开始帧自动跳过，同番跨集复用
```

改成：

```
- 🎞 **本地手动标记 OP/ED 帧（冷番兜底）** —— 点胶囊上的 🎯 打开浮动工具条，边看画面边标 OP/ED 的起止帧，进度条上直接显示已标区间；脚本认开始帧自动跳过，同番跨集复用
```

② 0.5.0 changelog 里这一条：

```
- 新增「手动标记 OP/ED 帧」：冷番 / 新番云端无时间戳时，在**设置面板 → 本地标记**里点「标 OP 开始 / 标 OP 结束 / 标 ED 开始 / 标 ED 结束」，脚本靠视觉指纹（aHash）自动识别跳过，同番跨集复用。
```

改成：

```
- 新增「手动标记 OP/ED 帧」：冷番 / 新番云端无时间戳时，点胶囊上的 🎯 打开**非模态浮动工具条**（不遮画面），点「标 OP 开始 / 标 OP 结束 / 标 ED 开始 / 标 ED 结束」；已标项列在工具条里可单条删除，并叠加显示在播放器进度条上。脚本靠视觉指纹（aHash）自动识别跳过，同番跨集复用。
```

- [ ] **Step 5: 旧 spec 加修订注**

在 `docs/superpowers/specs/2026-10-16-local-op-ed-ed-end-and-settings-ui-design.md` 的 `- 日期：` 行**之前**插入：

```
> 修订（2026-10-16）：本设计里「标记入口放在设置面板」那一节已被 `2026-10-16-marking-mode-toolbar-design.md` 取代（改为胶囊 🎯 + 浮动工具条）。ED 结束标记的部分仍然有效。
```

- [ ] **Step 6: 确认版本号**

打开 `bilibili-aniskip.user.js` 第 4 行，确认仍是 `// @version      0.5.0`（并入未发布的 0.5.0，不改）。

- [ ] **Step 7: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js README.md docs/superpowers/specs/2026-10-16-local-op-ed-ed-end-and-settings-ui-design.md
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "refactor: 移除设置面板里的标记一节（已由工具条取代）+ README 更新"
```

---

## 人工验证清单（浏览器，只有用户能做）

装最新脚本、刷新页面后逐条过：

1. 已绑定番剧 → 胶囊上出现 `🎯`；点一下变亮、工具条出现在**播放器左下角**，画面中心和控制栏都没被挡住。
2. 拖工具条到别处 → 松手后再刷新页面，位置还在。
3. 暂停到 OP 开始帧 → 点「标 OP 开始」→ 有 toast、状态行套数 +1、列表多一行 `OP  x.xs → ——`，**工具条不关闭**。
4. 拖到 OP 结束帧 → 点「标 OP 结束」→ 该行变成 `OP  x.xs → y.ys`。
5. 同法标 ED 开始 / ED 结束。
6. **进度条上出现蓝色（OP）和橙色（ED）区间**，位置与实际标记点吻合。
7. 点列表某一行 → 播放头跳到该标记点。
8. 点某行的 `✕` → 只少这一条，进度条上的对应标记同步消失。
9. 点「清空本番标记」→ 列表显示「还没标过」，进度条标记清空。
10. 点 `🎯` 退出标记模式 → 工具条消失；刷新页面后仍是退出态（状态有落盘）。
11. **网页全屏**下工具条可见、进度条标记也在；**真全屏**下同样可见（host 已重挂进全屏元素）；退出全屏恢复正常。
12. 未绑定番剧点标记按钮 → toast 提示，不写脏数据。
13. 打开设置面板 → **不再有**「本地标记 OP / ED」一节，其余设置项（跳过偏移、自动切下一集、清空缓存、重置位置等）都在且可用。

---

## 自查记录（写计划时已核对）

- **spec 覆盖**：spec §3→Task 6；§4→Task 4；§5→Task 3+Task 6；§6→Task 2+Task 7；§7→Task 1+Task 5；§8→Task 8；§9 接口表里的 8 个名字分别落在 Task 1/2/3/4/5/7；§11 的五组单测对应 48a/48b/48c/48d+48e/48g；§12 的 10 条验收映射到人工清单 1–13。
- **占位符扫描**：无 TBD/TODO；每个改代码的步骤都给了完整代码与锚点。
- **命名一致性**：`removeLocalSeg(segs, listKey, index)` / `pct(t, dur)` / `progressMarks(segs, dur)` / `ensureMarkHost()` / `markHostParent()` / `renderMark()` / `refreshMarkBar()` / `buildMarkRow(row)` / `delLocalSeg(listKey, index, label)` / `seekTo(t)` / `paintOneBar(bar, marks, sig)` / `paintProgressMarks()` / `markToggle()` / `applyMarkPos(bar)` / `attachMarkDrag(bar)` / `MARK_ON_KEY='_markOn'` / `MARK_POS_KEY='_markPos'` —— 全计划与 spec 一致。
- **已知取舍**：Task 4/5/6 里对 `applyMarkPos`/`attachMarkDrag`/`paintProgressMarks` 的调用用注释分步打开，是为让每个任务都能独立跑绿；Task 6 与 Task 7 分别明确写出「把注释打开」的替换动作。

---

## 附录：实施期对计划的修正（**与正文冲突时以本附录为准**）

计划正文写于实施之前。下面这些点在实施/审查中被证明有问题并已修正：

### A1. `ensureMarkHost` 的 host 必须铺满视口（Task 3）
`width:0;height:0` 会让 `.mkroot` 的 `width/height:100%` 解析成 0，`MARK_BAR_CSS` 的 `bottom:64px` 于是把工具条顶到屏幕外（只有拖过一次、存下 `_markPos` 之后才看得见）。已改为：

```js
      markHost.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483000;pointer-events:none;';
```

### A2. 48c 的断言必须用恒等比较（Task 3）
`check()` 走 `brief()` 字符串化，两个裸 `<div>` 都是 `"<div>"` —— 凡是「同一个对象」「没多挂一次」这类断言必须用 `checkTrue`，否则永远通过。48c 已定型为 **14** 条断言，并加了两条 host 几何断言（`position:fixed` + `right:0`/`bottom:0`、`pointer-events:none`）。

### A3. `fmtSec` 必须先提到模块作用域（Task 4 前面）
它原先定义在 `openSettings()` 内部，工具条在模块作用域调用会 ReferenceError。Task 4 已把模块级副本插在 `seekTo` 之前、并删掉 `openSettings` 里那份局部定义（函数体一字未改）。

### A4. 删单条要按指纹核对目标，并且只局部刷新列表（Task 4）
`delLocalSeg` 定型为（**替换**正文 Task 4 里的同名函数）：

```js
  /* 删单条：落盘 → 重新同步抽帧（顺带清掉已跳指纹）→ 就地刷新列表与进度条。
   * 用指纹核对目标：列表可能已经重画过，光靠 index 会删到别的标记上。
   * 对不上就什么都不做 —— 不误删，也不假报成功。
   * 只用 refreshMarkBar 局部刷新，不整树重建，免得列表滚动位置被顶回顶部。 */
  function delLocalSeg(listKey, index, row) {
    var bind = currentBinding();
    if (!bind) return;
    var segs = loadLocalSegs(bind._key);
    var list = segs[listKey] || [];
    var cur = list[index];
    if (!cur) return;
    if (row && row.hash && cur.hash !== row.hash) return;
    if (row && isFinite(row.s) && cur.start !== row.s) return;
    saveLocalSegs(bind._key, removeLocalSeg(segs, listKey, index));
    syncFrameMonitor(runtime.result);
    refreshMarkBar();
    // Task 7 打开：paintProgressMarks();
    showToast('已删掉这条标记', (row && row.label ? row.label : '') + ' 第 ' + (index + 1) + ' 条');
  }
```

配套：`refreshMarkBar` 的 `rows.push` 要带上 `hash: ops[i].hash` / `hash: eds[i].hash`；`buildMarkRow` 里改成 `delLocalSeg(row.listKey, row.i, row);`。

### A5. 测试读 GM 存储要兼容「裸对象」（Task 4 起）
harness 的 `GM_setValue` 直接把对象塞进 `store`（真机由油猴自己序列化），所以 `JSON.parse(env.store['aniskip.localSegs.xxx'])` 会因 `"[object Object]"` 直接崩掉整个用例文件。统一用：

```js
    const segsOf = () => {
      const v = env.store['aniskip.localSegs.b:BV_TEST000001'];
      return !v ? {} : (typeof v === 'string' ? JSON.parse(v) : v);
    };
```

正文 Task 5 的 `48e` 里三处 `JSON.parse(env.store[...])` 都按这个改（其余不变），并且 `opsOf()[0].end` 要写成 `opsOf().length ? opsOf()[0].end : -1`，免得未实现时抛异常把整个用例文件带崩。

### A6. 断言条数（以实际为准）
600（Task 1b 后）→ Task 2 +12 = 612 → Task 3/3b/3c 合计 +14 = 626 → Task 4 +11 = 637 → Task 4b +11 = 648。后续照此累加，**硬要求始终是 0 失败**。
