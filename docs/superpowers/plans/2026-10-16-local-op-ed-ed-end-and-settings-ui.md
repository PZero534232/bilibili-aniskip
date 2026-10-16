# 本地标记「ED 结束」+ 标记入口移入设置面板 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ED 也能标「结束」（落点可精确到 ED 结束点），并把 4 个标记动作从油猴菜单移进设置面板。

**Architecture:** 纯函数层（`validateLocalSegs` / `recordEdStart` / `recordEdEnd` / `frameStep`）继续零依赖、可单测；浏览器胶水层（`markEdEnd` 等 handler + `openSettings` 新增一节）不写单测，靠全量回归 + 语法检查 + 人工浏览器验证。ED 数据结构与 OP 对称：`{hash, start, end}`，`end = -1` 表示未标结束。

**Tech Stack:** 单文件 ES5 userscript（无构建）+ 零依赖 Node 测试harness（`node test/bilibili-aniskip.test.js -q`）。

**Spec:** `docs/superpowers/specs/2026-10-16-local-op-ed-ed-end-and-settings-ui-design.md`

---

### Task 1: `validateLocalSegs` 保留 ED 的 start/end（并归一老数据）

**Files:**
- Modify: `bilibili-aniskip.user.js`（`validateLocalSegs`，14.1 节，函数体内注释「清洗本地指纹」那段）
- Test: `test/bilibili-aniskip.test.js`（组 `47c`，约 3130 行）

- [ ] **Step 1: 改测试（先红）**

把组 47c 里 `if (typeof validate === 'function') { ... }` 整块替换成：

```js
    if (typeof validate === 'function') {
      const v = validate({
        ops: [{ hash: 'abc', start: 0, end: 90 }, { hash: '', start: 0, end: 5 }, { hash: 'x', start: 10, end: 10 }],
        eds: [{ hash: 'ed1' }, { bad: 1 }, null]
      });
      check('空 hash op 丢弃，其余保留', v.ops.length, 2);
      check('保留的第一个 op hash', v.ops[0] && v.ops[0].hash, 'abc');
      check('合法 ed 保留、坏 ed 丢弃', v.eds.length, 1);
      check('老 ed（只有 hash）归一为 pending', !!(v.eds[0] && v.eds[0].start === 0 && v.eds[0].end === -1), true);
      check('pending op（end=-1）保留', validate({ ops: [{ hash: 'p', start: 3, end: -1 }], eds: [] }).ops.length, 1);
      check('非对象输入 → 空', validate(null).ops.length, 0);
      const ve = validate({ ops: [], eds: [{ hash: 'e2', start: 1300.5, end: 1400.25 }] });
      check('ed start 保留', ve.eds[0] && ve.eds[0].start, 1300.5);
      check('ed end 保留', ve.eds[0] && ve.eds[0].end, 1400.25);
      check('坏 ed（hash 非串）丢弃', validate({ ops: [], eds: [{ hash: 5 }] }).eds.length, 0);
    }
```

- [ ] **Step 2: 跑一遍确认红**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: 有失败，且包含这 3 条：`老 ed（只有 hash）归一为 pending`、`ed start 保留`、`ed end 保留`（旧的 validate 把 ed 压成 `{hash}`，start/end 丢了）。

- [ ] **Step 3: 改实现**

在 `bilibili-aniskip.user.js` 里把 `validateLocalSegs` 的 eds 分支：

```js
    (Array.isArray(data.eds) ? data.eds : []).forEach(function (ed) {
      if (!ed || typeof ed.hash !== 'string' || !ed.hash.length) return;
      out.eds.push({ hash: ed.hash });
    });
```

换成：

```js
    (Array.isArray(data.eds) ? data.eds : []).forEach(function (ed) {
      if (!ed || typeof ed.hash !== 'string' || !ed.hash.length) return;
      var start = Number(ed.start), end = Number(ed.end);
      // 老数据只有 hash（没有 start/end）→ 归一成「未标结束」，行为落回「跳视频结尾」
      out.eds.push({
        hash: ed.hash,
        start: isFinite(start) ? start : 0,
        end: isFinite(end) ? end : -1
      });
    });
```

同时把函数头上那句注释：

```js
  /* 清洗本地指纹：坏条目直接丢；op 的 end 允许 < start（表示「还没标结束」）。 */
```

换成：

```js
  /* 清洗本地指纹：坏条目直接丢；op / ed 的 end 允许 < start（表示「还没标结束」）。
   * 老数据只有 hash 的 ed → start 缺省 0、end 缺省 -1。 */
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `0 失败`（通过数 = 原来的 565 + 4 = 569）。

- [ ] **Step 5: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: validateLocalSegs 保留 ED 的 start/end（老数据归一为 pending）"
```

---

### Task 2: `recordEdStart` 加时间 + 新增 `recordEdEnd`

**Files:**
- Modify: `bilibili-aniskip.user.js`（`recordEdStart` / 新增 `recordEdEnd`；`markEdStart` 的调用点；`api_` 导出）
- Test: `test/bilibili-aniskip.test.js`（组 `47d`，约 3164 行）

- [ ] **Step 1: 改测试（先红）**

把组 47d 整块替换成：

```js
  head('47d. 标记记录');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const ropS = hook(env, 'recordOpStart');
    const ropE = hook(env, 'recordOpEnd');
    const redS = hook(env, 'recordEdStart');
    const redE = hook(env, 'recordEdEnd');
    checkTrue('api_.recordOpStart 已导出', typeof ropS === 'function');
    checkTrue('api_.recordOpEnd 已导出', typeof ropE === 'function');
    checkTrue('api_.recordEdStart 已导出', typeof redS === 'function');
    checkTrue('api_.recordEdEnd 已导出', typeof redE === 'function');
    if (typeof ropS === 'function' && typeof ropE === 'function') {
      let s = { ops: [], eds: [] };
      s = ropS(s, 'hashA', 0);
      check('OP 开始：新开一套 pending', s.ops.length, 1);
      check('OP 结束前 end=-1', s.ops[0].end, -1);
      s = ropE(s, 90);
      check('OP 结束：补上 end', s.ops[0].end, 90);
      check('OP 结束：start 保留', s.ops[0].start, 0);
    }
    if (typeof redS === 'function') {
      const s2 = redS({ ops: [], eds: [] }, 'edHash', 1300);
      check('ED 开始：记一套', s2.eds.length, 1);
      check('ED hash 存对', s2.eds[0].hash, 'edHash');
      check('ED 开始时间存对', s2.eds[0].start, 1300);
      check('ED 结束前 end=-1', s2.eds[0].end, -1);
    }
    if (typeof redS === 'function' && typeof redE === 'function') {
      let s3 = redS({ ops: [], eds: [] }, 'edHash', 1300);
      s3 = redE(s3, 1400);
      check('ED 结束：补上 end', s3.eds[0].end, 1400);
      check('ED 结束：start 保留', s3.eds[0].start, 1300);
      check('无 pending ED 时不动', redE({ ops: [], eds: [{ hash: 'x', start: 0, end: 5 }] }, 9).eds[0].end, 5);
      const s4 = redE(redS(redS({ ops: [], eds: [] }, 'a', 1), 'b', 2), 9);
      check('多条 pending：只补最后一条', s4.eds[0].end, -1);
      check('多条 pending：最后一条被补上', s4.eds[1].end, 9);
    }
  }
```

- [ ] **Step 2: 跑一遍确认红**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: 有失败，包含 `api_.recordEdEnd 已导出`（未导出）；且 `ED 开始时间存对` / `ED 结束前 end=-1` 失败（旧 `recordEdStart` 只 push `{hash}`）。`redE` 不存在 → `typeof redE === 'function'` 为假 → 后一块整体跳过，不会崩。

- [ ] **Step 3: 改实现**

把 `recordEdStart`：

```js
  function recordEdStart(segs, hash) {
    var out = validateLocalSegs(segs);
    out.eds.push({ hash: hash });
    return out;
  }
```

换成（并在其下新增 `recordEdEnd`）：

```js
  function recordEdStart(segs, hash, time) {
    var out = validateLocalSegs(segs);
    out.eds.push({ hash: hash, start: time, end: -1 });   // -1 = 还没标结束
    return out;
  }
  function recordEdEnd(segs, time) {
    var out = validateLocalSegs(segs);
    for (var i = out.eds.length - 1; i >= 0; i--) {
      if (out.eds[i].end < 0) { out.eds[i].end = time; break; }
    }
    return out;
  }
```

把 `markEdStart` 里的调用（现在少传一个参数，Task 2 必须一起改，否则记录的开始时间永远是 `undefined`）：

```js
    saveLocalSegs(bind._key, recordEdStart(loadLocalSegs(bind._key), hash));
```

改成：

```js
    saveLocalSegs(bind._key, recordEdStart(loadLocalSegs(bind._key), hash, currentTime()));
```

在 `api_` 里把：

```js
        recordOpStart: recordOpStart, recordOpEnd: recordOpEnd, recordEdStart: recordEdStart,
```

改成：

```js
        recordOpStart: recordOpStart, recordOpEnd: recordOpEnd, recordEdStart: recordEdStart,
        recordEdEnd: recordEdEnd,
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `0 失败`（通过数 ≈ 569 + 8 = 577；通过数以实际为准，硬要求是 **0 失败**）。

- [ ] **Step 5: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 新增 recordEdEnd 与带时间的 recordEdStart"
```

---

### Task 3: `frameStep` 的 ED 落点规则

**Files:**
- Modify: `bilibili-aniskip.user.js`（`frameStep`，14.1 节）
- Test: `test/bilibili-aniskip.test.js`（组 `47e`，约 3189 行）

- [ ] **Step 1: 改测试（先红）**

把组 47e 里 ED 那两段（从 `// ED：命中 → 跳到视频结尾` 注释开始到 `check('ED 落点 = 时长', ...)` 为止）：

```js
      // ED：命中 → 跳到视频结尾（用长哈希，让 OP 与 ED 能靠 hamming 区分开）
      const m3 = { target: null, hits: 0 };
      const segsEd = { ops: [{ hash: '0000000000000000', start: 0, end: 90 }], eds: [{ hash: '1111111111111111' }] };
      frameStep(m3, segsEd, '1111111111111111', 1300, 1400);
      const edSeg = frameStep(m3, segsEd, '1111111111111111', 1300, 1400);
      check('认到 ED', !!(edSeg && edSeg.type === 'ed'), true);
      check('ED 落点 = 时长', edSeg && edSeg.end, 1400);
```

替换成：

```js
      // ED 没标结束（pending）→ 落视频时长（用长哈希，让 OP 与 ED 能靠 hamming 区分开）
      const m3 = { target: null, hits: 0 };
      const segsEd = { ops: [{ hash: '0000000000000000', start: 0, end: 90 }], eds: [{ hash: '1111111111111111', start: 1300, end: -1 }] };
      frameStep(m3, segsEd, '1111111111111111', 1300, 1400);
      const edSeg = frameStep(m3, segsEd, '1111111111111111', 1300, 1400);
      check('认到 ED', !!(edSeg && edSeg.type === 'ed'), true);
      check('ED pending → 落视频时长', edSeg && edSeg.end, 1400);
      // ED 标了结束 → 落点 = 检测点 + ED 时长（跨集复用相对时长）
      const m5 = { target: null, hits: 0 };
      const segsEdE = { ops: [], eds: [{ hash: '1111111111111111', start: 1300, end: 1400 }] };
      frameStep(m5, segsEdE, '1111111111111111', 1250, 1500);
      const edSegE = frameStep(m5, segsEdE, '1111111111111111', 1250, 1500);
      check('ED 标了结束 → 认到', !!(edSegE && edSegE.type === 'ed'), true);
      check('ED 落点 = 检测点 + ED 时长', edSegE && edSegE.end, 1350);
```

- [ ] **Step 2: 跑一遍确认红**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `ED 落点 = 检测点 + ED 时长` 失败（旧实现一律落 `duration` = 1500，期望 1350）。

- [ ] **Step 3: 改实现**

在 `frameStep` 里，ED 的候选目标：

```js
        for (i = 0; i < eds.length; i++) {
          if (hamming(hash, eds[i].hash) < FRAME_THRESHOLD) {
            matcher.target = { type: 'ed', hash: eds[i].hash, start: 0, end: 0 };
            matcher.hits = 1; cand = matcher.target; break;
          }
        }
```

换成：

```js
        for (i = 0; i < eds.length; i++) {
          if (hamming(hash, eds[i].hash) < FRAME_THRESHOLD) {
            matcher.target = { type: 'ed', hash: eds[i].hash, start: eds[i].start, end: eds[i].end };
            matcher.hits = 1; cand = matcher.target; break;
          }
        }
```

落点那段：

```js
      var seg = cand.type === 'op'
        ? { type: 'op', start: currentTime, end: currentTime + (cand.end - cand.start) }
        : { type: 'ed', start: currentTime, end: duration };
```

换成：

```js
      // OP 一定要有 end；ED 的 end 可选 —— 没标结束时落视频时长（老行为）
      var seg = cand.type === 'op'
        ? { type: 'op', start: currentTime, end: currentTime + (cand.end - cand.start) }
        : { type: 'ed', start: currentTime,
            end: (cand.end > cand.start) ? currentTime + (cand.end - cand.start) : duration };
```

同时把函数头上那句注释：

```js
  /* 连续命中判定 + 跳过段产出。matcher = { target, hits }，测试直接传对象进来。
   * 命中 OP：落点 = 检测点 + (end - start)（序幕长度不定也能对）。
   * 命中 ED：落点 = 视频时长（跳到底）。 */
```

换成：

```js
  /* 连续命中判定 + 跳过段产出。matcher = { target, hits }，测试直接传对象进来。
   * 命中 OP：落点 = 检测点 + (end - start)（序幕长度不定也能对）。
   * 命中 ED：标了结束就同上；没标结束（end < start）落视频时长。 */
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `0 失败`（通过数 ≈ 577 + 2 = 579，因为一条断言被拆成两条）。

- [ ] **Step 5: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: ED 标了结束则按 ED 时长落点，未标落视频时长"
```

---

### Task 4: 标记 handler（`markEdEnd`）+ 标记后即时生效

**Files:**
- Modify: `bilibili-aniskip.user.js`（14.1 节尾部：`markOpStart` / `markOpEnd` / `markEdStart` / 新增 `markEdEnd`；`api` 调试钩子）

无单测（浏览器胶水）。验证 = 全量回归 + 语法检查。

- [ ] **Step 1: 改实现**

把 14.1 节尾部的三个 handler：

```js
  function markOpStart() {
    var bind = currentBinding();
    if (!bind) { showToast('标 OP 开始', '先绑定 / 识别这个番剧再标'); return; }
    var hash = captureFrameHash();
    if (!hash) { showToast('标 OP 开始', '抓不到画面（可能 CORS 没通）'); return; }
    saveLocalSegs(bind._key, recordOpStart(loadLocalSegs(bind._key), hash, currentTime()));
    showToast('标 OP 开始', '已记录 · ' + Math.round(currentTime()) + 's（再标一次 OP 结束）');
  }
  function markOpEnd() {
    var bind = currentBinding();
    if (!bind) { showToast('标 OP 结束', '先绑定 / 识别这个番剧再标'); return; }
    saveLocalSegs(bind._key, recordOpEnd(loadLocalSegs(bind._key), currentTime()));
    showToast('标 OP 结束', '已记录 · ' + Math.round(currentTime()) + 's');
  }
  function markEdStart() {
    var bind = currentBinding();
    if (!bind) { showToast('标 ED 开始', '先绑定 / 识别这个番剧再标'); return; }
    var hash = captureFrameHash();
    if (!hash) { showToast('标 ED 开始', '抓不到画面（可能 CORS 没通）'); return; }
    saveLocalSegs(bind._key, recordEdStart(loadLocalSegs(bind._key), hash, currentTime()));
    showToast('标 ED 开始', '已记录 · ' + Math.round(currentTime()) + 's');
  }
```

整体替换成：

```js
  /* 标记后立刻重新同步抽帧：runtime.localSegs 是 rerun 时的快照，
   * 不刷新的话新指纹要等下次 rerun 才生效。 */
  function afterMark() {
    syncFrameMonitor(runtime.result);
  }
  function hasPendingOp(segs) {
    return (segs.ops || []).some(function (o) { return o.end < 0; });
  }
  function hasPendingEd(segs) {
    return (segs.eds || []).some(function (e) { return e.end < 0; });
  }

  function markOpStart() {
    var bind = currentBinding();
    if (!bind) { showToast('标 OP 开始', '先绑定 / 识别这个番剧再标'); return; }
    var hash = captureFrameHash();
    if (!hash) { showToast('标 OP 开始', '抓不到画面（可能 CORS 没通）'); return; }
    saveLocalSegs(bind._key, recordOpStart(loadLocalSegs(bind._key), hash, currentTime()));
    afterMark();
    showToast('标 OP 开始', '已记录 · ' + Math.round(currentTime()) + 's（再标一次 OP 结束）');
  }
  function markOpEnd() {
    var bind = currentBinding();
    if (!bind) { showToast('标 OP 结束', '先绑定 / 识别这个番剧再标'); return; }
    var cur = loadLocalSegs(bind._key);
    if (!hasPendingOp(cur)) { showToast('标 OP 结束', '没有待结束的 OP —— 先标「OP 开始」'); return; }
    saveLocalSegs(bind._key, recordOpEnd(cur, currentTime()));
    afterMark();
    showToast('标 OP 结束', '已记录 · ' + Math.round(currentTime()) + 's');
  }
  function markEdStart() {
    var bind = currentBinding();
    if (!bind) { showToast('标 ED 开始', '先绑定 / 识别这个番剧再标'); return; }
    var hash = captureFrameHash();
    if (!hash) { showToast('标 ED 开始', '抓不到画面（可能 CORS 没通）'); return; }
    saveLocalSegs(bind._key, recordEdStart(loadLocalSegs(bind._key), hash, currentTime()));
    afterMark();
    showToast('标 ED 开始', '已记录 · ' + Math.round(currentTime()) + 's（再标一次 ED 结束）');
  }
  function markEdEnd() {
    var bind = currentBinding();
    if (!bind) { showToast('标 ED 结束', '先绑定 / 识别这个番剧再标'); return; }
    var cur = loadLocalSegs(bind._key);
    if (!hasPendingEd(cur)) { showToast('标 ED 结束', '没有待结束的 ED —— 先标「ED 开始」'); return; }
    saveLocalSegs(bind._key, recordEdEnd(cur, currentTime()));
    afterMark();
    showToast('标 ED 结束', '已记录 · ' + Math.round(currentTime()) + 's');
  }
```

在 `api` 的调试钩子里，把：

```js
      _syncFrameMonitor: syncFrameMonitor,
```

改成：

```js
      _syncFrameMonitor: syncFrameMonitor,
      _markEdEnd: markEdEnd,
```

- [ ] **Step 2: 语法检查**

Run: `node --check bilibili-aniskip.user.js`

Expected: 无输出、exit 0。

- [ ] **Step 3: 跑全量回归**

Run: `node test/bilibili-aniskip.test.js -q`

Expected: `0 失败`（通过数仍 ≈ 579 —— handler 不在单测里）。

- [ ] **Step 4: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: markEdEnd + 标记后即时同步抽帧 + 无 pending 提示"
```

---

### Task 5: 设置面板新增「本地标记 OP / ED」一节

**Files:**
- Modify: `bilibili-aniskip.user.js`（`openSettings`，15 节）

无单测（浏览器 UI）。验证 = 语法检查 + 全量回归 + 人工浏览器验证。

- [ ] **Step 1: 在 `panel.innerHTML` 里插入一节**

找到「胶囊位置 / 重置位置」那一行（`'<button class="resetpos">重置位置</button></div>' +`）与紧跟其后的 `'<div class="btns"><button class="clr">清空缓存</button>' +`，在两者**之间**插入：

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

- [ ] **Step 2: 加样式 + 绑定事件 + 状态刷新**

找到：

```js
    var resetPosBtn = panel.querySelector('.resetpos');
    noFocus(resetPosBtn);
```

在它**之后**插入：

```js
    /* ---- 本地标记一节：按钮即时生效（不参与「保存」），状态行就地刷新 ---- */
    var mkSec = panel.querySelector('.mksec');
    var mkKnow = panel.querySelector('.mknow');
    var mkOpEl = panel.querySelector('.mkop');
    var mkEdEl = panel.querySelector('.mked');
    // 关键样式内联：页面 CSP 拦掉 <style> 时这节也还看得见
    mkSec.style.cssText = 'border-top:1px solid #eceff3;margin-top:14px;padding-top:2px;';
    panel.querySelector('.mkhead').style.cssText = 'margin:10px 0 4px;font-weight:600;font-size:13.5px;color:#222;';
    panel.querySelector('.mktip').style.cssText = 'margin:0 0 8px;color:#6b7280;font-size:12.5px;line-height:1.6;';
    panel.querySelector('.mkstat').style.cssText = 'margin:0 0 8px;padding:8px 10px;border-radius:8px;' +
      'background:#f4f7fb;color:#2b3a4a;font-size:12.5px;line-height:1.7;';

    function fmtSec(n) {
      if (!isFinite(n) || n < 0) return '——';
      return Math.round(n * 10) / 10 + 's';
    }
    function refreshMark() {
      var bind = currentBinding();
      if (!bind) {
        mkKnow.textContent = '当前：未绑定 —— 先去胶囊点「绑定」';
        mkOpEl.textContent = 'OP   开始 ——   结束 ——';
        mkEdEl.textContent = 'ED   开始 ——   结束 ——';
        return;
      }
      var segs = loadLocalSegs(bind._key);
      var ops = segs.ops || [], eds = segs.eds || [];
      var op = ops.length ? ops[ops.length - 1] : null;
      var ed = eds.length ? eds[eds.length - 1] : null;
      mkKnow.textContent = '当前：' + (bind.title || bind._key) +
        '   已标 OP ' + ops.length + ' 套 / ED ' + eds.length + ' 套';
      mkOpEl.textContent = 'OP   开始 ' + (op ? fmtSec(op.start) : '——') +
        '   结束 ' + (op && op.end > op.start ? fmtSec(op.end) : '——');
      mkEdEl.textContent = 'ED   开始 ' + (ed ? fmtSec(ed.start) : '——') +
        '   结束 ' + (ed && ed.end > ed.start ? fmtSec(ed.end) : '——');
    }
    [['mk-op-s', markOpStart], ['mk-op-e', markOpEnd], ['mk-ed-s', markEdStart], ['mk-ed-e', markEdEnd]]
      .forEach(function (pair) {
        var btn = panel.querySelector('.' + pair[0]);
        noFocus(btn);
        btn.addEventListener('click', function () { pair[1](); refreshMark(); });
      });
    var mkClrBtn = panel.querySelector('.mk-clr');
    noFocus(mkClrBtn);
    mkClrBtn.addEventListener('click', function () {
      var bind = currentBinding();
      if (!bind) { showToast('清空本番标记', '当前没有绑定番剧'); return; }
      try { GM_deleteValue(localSegsKey(bind._key)); } catch (e) { /* ignore */ }
      syncFrameMonitor(runtime.result);
      refreshMark();
      showToast('清空本番标记', '已删掉这个番的本地指纹');
    });
    refreshMark();
```

- [ ] **Step 3: 语法检查 + 全量回归**

Run: `node --check bilibili-aniskip.user.js`
Expected: 无输出、exit 0。

Run: `node test/bilibili-aniskip.test.js -q`
Expected: `0 失败`（通过数仍 ≈ 579）。

- [ ] **Step 4: 人工浏览器验证（只有用户能做）**

1. 装最新脚本，打开一个已绑定的冷番视频。
2. 胶囊上点 `⚙` → 设置面板底部出现「本地标记 OP / ED」一节，状态行显示「当前：<番名> 已标 OP 0 套 / ED 0 套」。
3. 拖到 OP 开始帧暂停 → 点「标 OP 开始」→ toast + 状态行 `OP 开始 x.xs`；面板**不关闭**。
4. 拖到 OP 结束帧 → 点「标 OP 结束」→ 状态行 `结束 y.ys`。
5. 同法标 ED 开始 / ED 结束。
6. 点到未绑定视频时，状态行显示「当前：未绑定 —— 先去胶囊点「绑定」」，点按钮出 toast 提示。
7. 点「清空本番标记」→ 状态行恢复 `——`。

- [ ] **Step 5: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 设置面板新增「本地标记 OP/ED」一节"
```

---

### Task 6: 删油猴菜单标记项 + README + 回归

**Files:**
- Modify: `bilibili-aniskip.user.js`（`boot()` 里 3 条菜单注册）
- Modify: `README.md`（特性清单第 31 行、0.5.0 changelog 第 184/186 行附近）
- Modify: `docs/superpowers/specs/2026-10-16-local-op-ed-frame-marking-design.md`（顶部加一行修订说明）

- [ ] **Step 1: 删掉油猴菜单里的 3 条标记项**

在 `boot()` 里删掉这 3 行（保留 `🔍 绑定 / 识别番剧` 和 `⚙ 番剧跳过设置`）：

```js
    try { GM_registerMenuCommand('⏱ 标 OP 开始', markOpStart); } catch (e) { /* ignore */ }
    try { GM_registerMenuCommand('⏱ 标 OP 结束', markOpEnd); } catch (e) { /* ignore */ }
    try { GM_registerMenuCommand('⏱ 标 ED 开始', markEdStart); } catch (e) { /* ignore */ }
```

- [ ] **Step 2: 改 README 特性清单**

把第 31 行：

```
- 🎞 **本地手动标记 OP/ED 帧（冷番兜底）** —— 认 OP/ED 开始帧自动跳过，同番跨集复用
```

改成：

```
- 🎞 **本地手动标记 OP/ED 帧（冷番兜底）** —— 在设置面板里标 OP/ED 的开始与结束帧，脚本认开始帧自动跳过，同番跨集复用
```

- [ ] **Step 3: 改 README 的 0.5.0 changelog**

把这一条：

```
- 新增「手动标记 OP/ED 帧」：冷番 / 新番云端无时间戳时，油猴菜单「标 OP 开始 / 标 OP 结束 / 标 ED 开始」标记，脚本靠视觉指纹（aHash）自动识别跳过，同番跨集复用。
```

改成：

```
- 新增「手动标记 OP/ED 帧」：冷番 / 新番云端无时间戳时，在**设置面板 → 本地标记**里点「标 OP 开始 / 标 OP 结束 / 标 ED 开始 / 标 ED 结束」，脚本靠视觉指纹（aHash）自动识别跳过，同番跨集复用。
```

并在「本地兜底」那条**之后**插入一条：

```
- OP 落点 = 检测点 + OP 时长；ED 标了结束同理，没标结束则落到视频结尾。
```

- [ ] **Step 4: 老 spec 加修订说明**

在 `docs/superpowers/specs/2026-10-16-local-op-ed-frame-marking-design.md` 的标题行下方（`- 日期：…` 之前）插入：

```
> 修订（2026-10-16）：ED 结束标记与标记入口位置已改，见 `2026-10-16-local-op-ed-ed-end-and-settings-ui-design.md`。
```

- [ ] **Step 5: 语法检查 + 全量回归**

Run: `node --check bilibili-aniskip.user.js`
Expected: 无输出、exit 0。

Run: `node test/bilibili-aniskip.test.js -q`
Expected: `0 失败`（通过数 ≈ 579，以实际为准）。

- [ ] **Step 6: 确认版本号**

打开 `bilibili-aniskip.user.js` 第 4 行，确认是 `// @version      0.5.0`（本设计并入未发布的 0.5.0，无需改版本号）。

- [ ] **Step 7: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js README.md docs/superpowers/specs/2026-10-16-local-op-ed-frame-marking-design.md
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 标记入口移入设置面板（删油猴菜单标记项）+ README 0.5.0 更新"
```

---

## Self-Review

- **Spec 覆盖**：§4 数据模型 → Task 1/2；§5.1 记录 → Task 2；§5.2 校验 → Task 1；§5.3 匹配 → Task 3；§5.4 兜底判定不变（无需任务）；§5.5 即时生效 → Task 4；§6 UI → Task 5；§6.1 表内 `markEdEnd`/`openSettings`/`boot()` 删菜单/`api_` 导出/`api` 调试钩子 → Task 2/4/5/6；§7 兼容性 → Task 1（老数据归一）+ Task 6（入口仍可达）；§8 测试 → Task 1/2/3；§10 验收标准 → Task 5（1）+ Task 3（2、3）+ Task 1（4）+ Task 6（5）+ 各任务（6）。
- **占位符扫描**：无 TBD/TODO；每个改代码的步骤都给了完整代码与精确锚点。
- **类型一致性**：`eds` 统一 `{hash, start, end}`；`recordEdStart(segs, hash, time)` 与 `markEdStart` 调用点一致；`recordEdEnd(segs, time)` 与 `markEdEnd` 一致；`end = -1` 全程表示 pending；`afterMark()` 只在 Task 4 定义并使用。
