# 本地「手动标记 OP/ED 帧」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 冷番/新番在云端（AniSkip/Anime Skip）没有时间戳时，让用户手动标记 OP/ED 起始帧，脚本靠视觉指纹（aHash）匹配自动跳过，并在同番其它集复用。

**Architecture:** 纯函数层（aHash/hamming/gray8x8/存取/记录/匹配）全部可单测，浏览器层（抓帧 + crossOrigin 注入 + 菜单 + 检测循环）薄薄包一层。检测循环与现有时间戳轮询互斥：云端有段走老路，云端空且本地有指纹才开抽帧循环。

**Tech Stack:** 单文件 ES5 userscript（无构建）+ 零依赖 Node 测试 harness（`test/bilibili-aniskip.test.js`）。指纹 = 8×8 灰度平均哈希（aHash），匹配 = Hamming 距离 + 连续命中。

**规格文档:** `docs/superpowers/specs/2026-10-16-local-op-ed-frame-marking-design.md`

---

## 文件结构

- 修改 `bilibili-aniskip.user.js`：新增「14.1 本地帧指纹」段（纯函数 + 浏览器 glue），在 `runtime` 对象加 3 个字段，`boot()` 里注册菜单，`rerun()` 里挂 `syncFrameMonitor()`，`api_` 导出新纯函数。
- 修改 `test/bilibili-aniskip.test.js`：新增组 47（`47.` 到 `47f.`）覆盖所有纯函数与检测决策。
- 修改 `README.md`：特性清单 + 0.5.0 changelog。
- 版本号：`@version` 0.4.8 → 0.5.0（最后一步做）。

**关键约定（写代码前必读）：**
- 测试里用 `hook(env, 'name')` 拿 `api_.<name>`；缺函数时返回 `null`，用 `if (typeof fn === 'function')` 包住行为断言，保证旧版能报「已导出」失败而不是崩。
- 本地指纹存 GM key `aniskip.localSegs.<bindingKey>`，与 config 无关，**不需要** cfgVersion 迁移。
- 指纹哈希统一为 64 位 `'0'/'1'` 字符串；测试可用短字符串（如 `'0000'`）驱动，hamming 按长度取短。
- 三个常量：`FRAME_SAMPLE_MS = 250`、`FRAME_THRESHOLD = 10`、`FRAME_CONSECUTIVE = 2`。

---

### Task 0: CORS 可行性验证（spike，非 TDD，决策门）

**Files:**
- 无（浏览器 console 手动验证）

- [ ] **Step 1: 在 B 站任意视频页验证 CDN 是否放行 CORS**

在浏览器 F12 console 粘贴运行（会新建一个带 `crossorigin` 的 video 拉同一 CDN 源，验证能不能读像素）：

```js
(function () {
  var v = document.querySelector('video');
  var src = v && (v.currentSrc || v.src);
  if (!src) { console.log('没找到 video/src'); return; }
  var v2 = document.createElement('video');
  v2.crossOrigin = 'anonymous';
  v2.muted = true; v2.src = src;
  v2.addEventListener('loadeddata', function () {
    try {
      var c = document.createElement('canvas'); c.width = 160; c.height = 90;
      var ctx = c.getContext('2d'); ctx.drawImage(v2, 0, 0, c.width, c.height);
      var d = ctx.getImageData(0, 0, c.width, c.height);
      console.log('✅ CDN 放行 CORS，能读像素 R=', d.data[0]);
    } catch (e) { console.log('❌ 即使 crossOrigin 也读不到：', e && e.name, e && e.message); }
  });
  v2.addEventListener('error', function () {
    console.log('❌ crossOrigin 加载失败（CDN 不放行 CORS）→ 认帧方案退回认时间');
  });
})();
```

- [x] **Step 2: 决策门 —— 已通过（2026-10-16）**

  - 实测：直接对当前 `<video>` `drawImage` + `getImageData` 成功（`R=40`），B 站 MediaSource 干净，**认帧可行**。
  - 注：最初「新建 video 拉同一 src」的测法失败（`src` 是 blob URL，MSE 特有），已改用「直接画当前 video」重测通过。

- [x] **Step 3: 结论已记录**

结论已写入设计文档「前提与风险」节。Task 7 因此**删掉 patchVideoCORS**（MSE 下 crossOrigin 与污染无关）。

---

### Task 1: aHash / hamming 纯函数

**Files:**
- Modify: `bilibili-aniskip.user.js`（在 `stopMonitor` 之后新增段）
- Test: `test/bilibili-aniskip.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/bilibili-aniskip.test.js` 末尾（组 46 之后）新增：

```js
  /* ==================================================================
   * 47. 本地手动标记 OP/ED 帧：指纹纯函数
   * ================================================================== */
  head('47. 帧指纹：aHash / hamming');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const aHash = hook(env, 'aHash');
    const hamming = hook(env, 'hamming');
    checkTrue('api_.aHash 已导出', typeof aHash === 'function');
    checkTrue('api_.hamming 已导出', typeof hamming === 'function');
    if (typeof aHash === 'function') {
      const gray64 = [];
      for (let i = 0; i < 64; i++) gray64.push(i < 32 ? 0 : 255);
      const h = aHash(gray64);
      check('aHash 输出 64 位', h && h.length, 64);
      check('暗的一半 → 0', h && h.charAt(0), '0');
      check('亮的一半 → 1', h && h.charAt(63), '1');
    }
    if (typeof hamming === 'function') {
      check('hamming 相同 = 0', hamming('0000', '0000'), 0);
      check('hamming 全异 = 4', hamming('0000', '1111'), 4);
      check('hamming 长度不等补差值', hamming('0000', '00'), 2);
    }
  }
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: `✗ api_.aHash 已导出` 与 `✗ api_.hamming 已导出`（其余旧用例仍 501 通过）。

- [ ] **Step 3: 实现**

在 `bilibili-aniskip.user.js` 的 `stopMonitor` 函数（约 2308 行 `}`）之后插入：

```js
  /* ==================================================================
   * 14.1 本地「手动标记 OP/ED 帧」：指纹 / 匹配 / 检测循环
   * ================================================================== */
  var FRAME_SAMPLE_MS = 250;    // 抽帧间隔
  var FRAME_THRESHOLD = 10;     // Hamming 距离阈值（64 位里差 10 位以内算命中）
  var FRAME_CONSECUTIVE = 2;    // 连续命中几次才算「认到」（防单帧误判）

  /* 8×8 灰度（64 个 0-255 亮度值）→ 64 位平均哈希（'0'/'1' 字符串） */
  function aHash(gray) {
    var n = (gray && gray.length) || 0;
    var sum = 0, i;
    for (i = 0; i < n; i++) sum += gray[i];
    var avg = n ? sum / n : 0;
    var out = '';
    for (i = 0; i < n; i++) out += gray[i] >= avg ? '1' : '0';
    return out;
  }

  /* 两个等长（或不同长）位串的 Hamming 距离：不同位个数 + 长度差 */
  function hamming(a, b) {
    a = String(a || ''); b = String(b || '');
    var n = Math.min(a.length, b.length);
    var d = Math.abs(a.length - b.length), i;
    for (i = 0; i < n; i++) if (a.charAt(i) !== b.charAt(i)) d++;
    return d;
  }
```

- [ ] **Step 4: 导出**

在 `api_` 对象（约 3723 行 `getConfig` 之前）加入：

```js
        aHash: aHash, hamming: hamming,
```

- [ ] **Step 5: 运行确认通过**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: 组 47 全 ✓，整体 503 通过 / 0 失败。

- [ ] **Step 6: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: aHash/hamming 帧指纹纯函数"
```

---

### Task 2: gray8x8 降采样

**Files:**
- Modify: `bilibili-aniskip.user.js`
- Test: `test/bilibili-aniskip.test.js`

- [ ] **Step 1: 写失败测试**

组 47 里追加：

```js
  head('47b. 帧指纹：gray8x8 降采样');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const gray8x8 = hook(env, 'gray8x8');
    checkTrue('api_.gray8x8 已导出', typeof gray8x8 === 'function');
    if (typeof gray8x8 === 'function') {
      const black = []; for (let i = 0; i < 4 * 4 * 4; i++) black.push(0);
      const gb = gray8x8({ data: black, width: 4, height: 4 });
      check('输出 64 个亮度', gb && gb.length, 64);
      check('全黑 → 0', gb && gb[0], 0);
      const white = []; for (let i = 0; i < 4 * 4 * 4; i++) white.push(255);
      const gw = gray8x8({ data: white, width: 4, height: 4 });
      check('全白 → 255', gw && gw[0], 255);
    }
  }
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: `✗ api_.gray8x8 已导出`。

- [ ] **Step 3: 实现（加在 `hamming` 之后）**

```js
  /* canvas ImageData → 8×8 灰度亮度数组（长度 64，0-255，Rec.601 权重）。
   * imgData = { data: RGBA 数组, width, height } —— 这样测试里能喂假数据。 */
  function gray8x8(imgData) {
    var w = imgData.width, h = imgData.height, d = imgData.data, out = [];
    var cw = w / 8, ch = h / 8;
    for (var gy = 0; gy < 8; gy++) {
      for (var gx = 0; gx < 8; gx++) {
        var sx = Math.floor(gx * cw), sy = Math.floor(gy * ch);
        var i = (sy * w + sx) * 4;
        var r = d[i] || 0, g = d[i + 1] || 0, b = d[i + 2] || 0;
        out.push(0.299 * r + 0.587 * g + 0.114 * b);
      }
    }
    return out;
  }
```

- [ ] **Step 4: 导出（在 `api_` 里 aHash 一行后加）**

```js
        gray8x8: gray8x8,
```

- [ ] **Step 5: 运行确认通过**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: 全绿，504 通过 / 0 失败。

- [ ] **Step 6: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: gray8x8 视频帧降采样"
```

---

### Task 3: 指纹存取与校验（localSegsKey / validateLocalSegs / loadLocalSegs / saveLocalSegs）

**Files:**
- Modify: `bilibili-aniskip.user.js`
- Test: `test/bilibili-aniskip.test.js`

- [ ] **Step 1: 写失败测试**

```js
  head('47c. 指纹存取与校验');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const key = hook(env, 'localSegsKey');
    const validate = hook(env, 'validateLocalSegs');
    const load = hook(env, 'loadLocalSegs');
    const save = hook(env, 'saveLocalSegs');
    checkTrue('api_.localSegsKey 已导出', typeof key === 'function');
    checkTrue('api_.validateLocalSegs 已导出', typeof validate === 'function');
    checkTrue('api_.loadLocalSegs 已导出', typeof load === 'function');
    checkTrue('api_.saveLocalSegs 已导出', typeof save === 'function');
    if (typeof key === 'function') {
      check('key 前缀', key('b:BV1'), 'aniskip.localSegs.b:BV1');
    }
    if (typeof validate === 'function') {
      const v = validate({
        ops: [{ hash: 'abc', start: 0, end: 90 }, { hash: '', start: 0, end: 5 }, { hash: 'x', start: 10, end: 10 }],
        eds: [{ hash: 'ed1' }, { bad: 1 }, null]
      });
      check('空 hash op 丢弃，其余保留', v.ops.length, 2);
      check('保留的第一个 op hash', v.ops[0] && v.ops[0].hash, 'abc');
      check('合法 ed 保留、坏 ed 丢弃', v.eds.length, 1);
      check('pending op（end=-1）保留', validate({ ops: [{ hash: 'p', start: 3, end: -1 }], eds: [] }).ops.length, 1);
      check('非对象输入 → 空', validate(null).ops.length, 0);
    }
    if (typeof save === 'function' && typeof load === 'function') {
      save('b:BV1', { ops: [{ hash: 'abc', start: 0, end: 90 }], eds: [{ hash: 'ed1' }] });
      const l = load('b:BV1');
      check('save 后 load 回来 op', l.ops.length, 1);
      check('save 后 load 回来 ed', l.eds.length, 1);
      check('没存过的 key → 空', load('b:NOPE').ops.length, 0);
    }
  }
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: 4 个 `✗ ...已导出`。

- [ ] **Step 3: 实现（加在 `gray8x8` 之后）**

```js
  function localSegsKey(bindingKey) {
    return 'aniskip.localSegs.' + bindingKey;
  }

  /* 清洗本地指纹：坏条目直接丢；op 的 end 允许 < start（表示「还没标结束」）。 */
  function validateLocalSegs(data) {
    var out = { ops: [], eds: [] };
    if (!data || typeof data !== 'object') return out;
    (Array.isArray(data.ops) ? data.ops : []).forEach(function (op) {
      if (!op || typeof op.hash !== 'string' || !op.hash.length) return;
      var start = Number(op.start), end = Number(op.end);
      if (!isFinite(start) || !isFinite(end)) return;
      out.ops.push({ hash: op.hash, start: start, end: end });
    });
    (Array.isArray(data.eds) ? data.eds : []).forEach(function (ed) {
      if (!ed || typeof ed.hash !== 'string' || !ed.hash.length) return;
      out.eds.push({ hash: ed.hash });
    });
    return out;
  }

  function loadLocalSegs(bindingKey) {
    if (!bindingKey) return { ops: [], eds: [] };
    return validateLocalSegs(gmGet(localSegsKey(bindingKey), null));
  }
  function saveLocalSegs(bindingKey, data) {
    if (!bindingKey) return;
    gmSet(localSegsKey(bindingKey), validateLocalSegs(data));
  }
```

- [ ] **Step 4: 导出**

```js
        localSegsKey: localSegsKey, validateLocalSegs: validateLocalSegs,
        loadLocalSegs: loadLocalSegs, saveLocalSegs: saveLocalSegs,
```

- [ ] **Step 5: 运行确认通过**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: 全绿，512 通过 / 0 失败。

- [ ] **Step 6: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 本地指纹存取与校验"
```

---

### Task 4: 标记记录（recordOpStart / recordOpEnd / recordEdStart）

**Files:**
- Modify: `bilibili-aniskip.user.js`
- Test: `test/bilibili-aniskip.test.js`

- [ ] **Step 1: 写失败测试**

```js
  head('47d. 标记记录');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const ropS = hook(env, 'recordOpStart');
    const ropE = hook(env, 'recordOpEnd');
    const redS = hook(env, 'recordEdStart');
    checkTrue('api_.recordOpStart 已导出', typeof ropS === 'function');
    checkTrue('api_.recordOpEnd 已导出', typeof ropE === 'function');
    checkTrue('api_.recordEdStart 已导出', typeof redS === 'function');
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
      const s2 = redS({ ops: [], eds: [] }, 'edHash');
      check('ED 开始：记一套', s2.eds.length, 1);
      check('ED hash 存对', s2.eds[0].hash, 'edHash');
    }
  }
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: 3 个 `✗ ...已导出`。

- [ ] **Step 3: 实现（加在 `saveLocalSegs` 之后）**

```js
  /* 标记动作都是纯函数：入参是当前指纹集 + 新信息，返回新指纹集（不落盘，落盘由调用方做）。 */
  function recordOpStart(segs, hash, time) {
    var out = validateLocalSegs(segs);
    out.ops.push({ hash: hash, start: time, end: -1 });   // -1 = 还没标结束
    return out;
  }
  function recordOpEnd(segs, time) {
    var out = validateLocalSegs(segs);
    for (var i = out.ops.length - 1; i >= 0; i--) {
      if (out.ops[i].end < 0) { out.ops[i].end = time; break; }
    }
    return out;
  }
  function recordEdStart(segs, hash) {
    var out = validateLocalSegs(segs);
    out.eds.push({ hash: hash });
    return out;
  }
```

- [ ] **Step 4: 导出**

```js
        recordOpStart: recordOpStart, recordOpEnd: recordOpEnd, recordEdStart: recordEdStart,
```

- [ ] **Step 5: 运行确认通过**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: 全绿，519 通过 / 0 失败。

- [ ] **Step 6: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 标记记录纯函数（OP 开始/结束、ED 开始）"
```

---

### Task 5: 帧匹配器 frameStep（连续命中 → 产出跳过段）

**Files:**
- Modify: `bilibili-aniskip.user.js`
- Test: `test/bilibili-aniskip.test.js`

- [ ] **Step 1: 写失败测试**

```js
  head('47e. 帧匹配：连续命中 → 产出跳过段');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const frameStep = hook(env, 'frameStep');
    checkTrue('api_.frameStep 已导出', typeof frameStep === 'function');
    if (typeof frameStep === 'function') {
      const segs = { ops: [{ hash: '0000', start: 0, end: 90 }], eds: [{ hash: '1111' }] };
      const H = '0000';
      const m = { target: null, hits: 0 };
      check('第一次命中不跳（未够连续）', frameStep(m, segs, H, 0, 1400), null);
      check('命中计数 1', m.hits, 1);
      const seg = frameStep(m, segs, H, 1, 1400);
      check('连续命中后认到 OP', !!(seg && seg.type === 'op'), true);
      check('OP 落点 = 检测点 + 时长', seg && seg.end, 91);
      check('认到后清空目标', m.target, null);
      // 中途一次不中 → 连续计数归零，重新攒（用长哈希，让 hamming 能 ≥ 阈值）
      const m2 = { target: null, hits: 0 };
      const segsLong = { ops: [{ hash: '0000000000000000', start: 0, end: 90 }], eds: [] };
      frameStep(m2, segsLong, '0000000000000000', 0, 1400);
      frameStep(m2, segsLong, '1111111111111111', 0, 1400);
      check('中间一帧不中 → 目标清空', m2.target, null);
      check('中间一帧不中 → 计数归零', m2.hits, 0);
      // ED：命中 → 跳到视频结尾（长哈希，避免 '1111' 误匹配 OP '0000'）
      const m3 = { target: null, hits: 0 };
      const segsEd = { ops: [{ hash: '0000000000000000', start: 0, end: 90 }], eds: [{ hash: '1111111111111111' }] };
      frameStep(m3, segsEd, '1111111111111111', 1300, 1400);
      const edSeg = frameStep(m3, segsEd, '1111111111111111', 1300, 1400);
      check('认到 ED', !!(edSeg && edSeg.type === 'ed'), true);
      check('ED 落点 = 时长', edSeg && edSeg.end, 1400);
      // pending OP（end<start）不参与匹配
      const segsP = { ops: [{ hash: '0000', start: 0, end: -1 }], eds: [] };
      const m4 = { target: null, hits: 0 };
      check('pending OP 不参与匹配', frameStep(m4, segsP, H, 0, 1400), null);
    }
  }
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: `✗ api_.frameStep 已导出`。

- [ ] **Step 3: 实现（加在 `recordEdStart` 之后）**

```js
  /* 连续命中判定 + 跳过段产出。matcher = { target, hits }，测试直接传对象进来。
   * 命中 OP：落点 = 检测点 + (end - start)（序幕长度不定也能对）。
   * 命中 ED：落点 = 视频时长（跳到底）。 */
  function frameStep(matcher, segs, hash, currentTime, duration) {
    var cand = matcher.target;
    if (cand) {
      if (hamming(hash, cand.hash) < FRAME_THRESHOLD) matcher.hits++;
      else { matcher.target = null; matcher.hits = 0; }
    } else {
      var ops = (segs && segs.ops) || [], eds = (segs && segs.eds) || [], i;
      for (i = 0; i < ops.length; i++) {
        var op = ops[i];
        if (op.end <= op.start) continue;                 // pending，跳过
        if (hamming(hash, op.hash) < FRAME_THRESHOLD) {
          matcher.target = { type: 'op', hash: op.hash, start: op.start, end: op.end };
          matcher.hits = 1; cand = matcher.target; break;
        }
      }
      if (!cand) {
        for (i = 0; i < eds.length; i++) {
          if (hamming(hash, eds[i].hash) < FRAME_THRESHOLD) {
            matcher.target = { type: 'ed', hash: eds[i].hash, start: 0, end: 0 };
            matcher.hits = 1; cand = matcher.target; break;
          }
        }
      }
    }
    if (cand && matcher.hits >= FRAME_CONSECUTIVE) {
      var seg = cand.type === 'op'
        ? { type: 'op', start: currentTime, end: currentTime + (cand.end - cand.start) }
        : { type: 'ed', start: currentTime, end: duration };
      matcher.target = null; matcher.hits = 0;
      return seg;
    }
    return null;
  }
```

- [ ] **Step 4: 导出**

```js
        frameStep: frameStep,
```

- [ ] **Step 5: 运行确认通过**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: 全绿，530 通过 / 0 失败。

- [ ] **Step 6: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 帧匹配器 frameStep（连续命中产出跳过段）"
```

---

### Task 6: 本地兜底启用判定 shouldUseLocalSegs

**Files:**
- Modify: `bilibili-aniskip.user.js`
- Test: `test/bilibili-aniskip.test.js`

- [ ] **Step 1: 写失败测试**

```js
  head('47f. 本地兜底启用判定');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const shouldUse = hook(env, 'shouldUseLocalSegs');
    checkTrue('api_.shouldUseLocalSegs 已导出', typeof shouldUse === 'function');
    if (typeof shouldUse === 'function') {
      const good = { ops: [{ hash: 'h', start: 0, end: 90 }], eds: [] };
      check('无 bindingKey → 不用', shouldUse({ ok: true, segments: [] }, good), false);
      check('云端有段 → 不用', shouldUse({ ok: true, bindingKey: 'b:x', segments: [{ type: 'op' }] }, good), false);
      check('云端空 + 本地有 → 用', shouldUse({ ok: true, bindingKey: 'b:x', segments: [] }, good), true);
      check('本地空 → 不用', shouldUse({ ok: true, bindingKey: 'b:x', segments: [] }, { ops: [], eds: [] }), false);
      check('只有 pending op → 不用', shouldUse({ ok: true, bindingKey: 'b:x', segments: [] }, { ops: [{ hash: 'h', start: 0, end: -1 }], eds: [] }), false);
      check('只有 ED 也够 → 用', shouldUse({ ok: true, bindingKey: 'b:x', segments: [] }, { ops: [], eds: [{ hash: 'e' }] }), true);
    }
  }
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: `✗ api_.shouldUseLocalSegs 已导出`。

- [ ] **Step 3: 实现（加在 `frameStep` 之后）**

```js
  /* 本地指纹什么时候参与：已绑定（有 bindingKey）、云端没给段、本地有可用指纹。 */
  function shouldUseLocalSegs(r, localSegs) {
    if (!r || !r.ok || !r.bindingKey) return false;
    if (r.segments && r.segments.length) return false;
    if (!localSegs) return false;
    var usableOp = (localSegs.ops || []).some(function (o) { return o.end > o.start; });
    return !!(usableOp || (localSegs.eds || []).length);
  }
```

- [ ] **Step 4: 导出**

```js
        shouldUseLocalSegs: shouldUseLocalSegs,
```

- [ ] **Step 5: 运行确认通过**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: 全绿，536 通过 / 0 失败。

- [ ] **Step 6: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 本地兜底启用判定 shouldUseLocalSegs"
```

---

### Task 7: 帧抓取（浏览器 glue）

**Files:**
- Modify: `bilibili-aniskip.user.js`

> 本任务没有单测（依赖真实 canvas）。已实测 B 站 MediaSource 干净、能直接读像素（见 Task 0），**无需任何 crossOrigin 注入**。

- [ ] **Step 1: 实现 `captureFrameHash`（加在 `shouldUseLocalSegs` 之后）**

```js
  var frameCanvas = null;
  /* 抓当前帧 → 8×8 灰度 → aHash。失败（读不到像素 / 没有画面）返回 null。 */
  function captureFrameHash() {
    var video = runtime.video || getVideo();
    if (!video || !video.videoWidth) return null;
    try {
      if (!frameCanvas) frameCanvas = document.createElement('canvas');
      var c = frameCanvas;
      c.width = 160; c.height = 90;
      var ctx = c.getContext('2d');
      ctx.drawImage(video, 0, 0, c.width, c.height);
      var img = ctx.getImageData(0, 0, c.width, c.height);
      return aHash(gray8x8(img));
    } catch (e) { return null; }
  }
```

- [ ] **Step 2: 手动验证（浏览器）**

  1. 装脚本，打开 B 站视频，F12 控制台执行：`(window.__biliAniskip && window.__biliAniskip.api_ && window.__biliAniskip.api_.aHash) ? '有导出' : '没导出'` → 应为「有导出」。
  2. 控制台执行 Task 0 的直接读像素 snippet，确认仍能读到（不再 SecurityError）。

- [ ] **Step 3: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 帧抓取 captureFrameHash"
```

---

### Task 8: 检测循环集成（runtime 字段 / applyFrameHash / frameTick / 启停 / syncFrameMonitor / rerun 钩子）

**Files:**
- Modify: `bilibili-aniskip.user.js`
- Test: `test/bilibili-aniskip.test.js`

- [ ] **Step 1: 写失败测试（applyFrameHash 端到端跳过）**

组 47 里追加：

```js
  head('47g. 检测循环：applyFrameHash 认到就跳');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const applyFrameHash = hook(env, 'applyFrameHash');
    checkTrue('api_.applyFrameHash 已导出', typeof applyFrameHash === 'function');
    if (typeof applyFrameHash === 'function') {
      const mkVideo = () => ({ currentTime: 5, duration: 1400, paused: false, ended: false,
        play() { this.paused = false; }, addEventListener() {} });
      const v = mkVideo();
      env.api._runtime.video = v;
      env.api._runtime.result = { ok: true, segments: [] };
      env.api._runtime.frameMatcher = { target: null, hits: 0 };
      env.api._runtime.localSegs = { ops: [{ hash: '0000', start: 0, end: 90 }], eds: [] };
      applyFrameHash('0000', v);          // 第 1 次：只攒连续计数，不跳
      check('第一次命中不跳', Math.round(v.currentTime), 5);
      applyFrameHash('0000', v);          // 第 2 次：认到，跳到 5+90
      check('认到 OP 后跳走', Math.round(v.currentTime), 95);
    }
  }
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: `✗ api_.applyFrameHash 已导出`。

- [ ] **Step 3: 给 `runtime` 加字段**

在 `runtime` 对象（约 2139 行 `pillDragged: false` 之后、`};` 之前）加：

```js
    pillDragged: false,
    frameMatcher: null,      // { target, hits }：抽帧匹配的连续命中状态
    frameTimer: null,        // 抽帧 interval 句柄
    localSegs: null          // 当前 binding 的本地指纹 { ops, eds }
```

- [ ] **Step 4: 实现检测循环（加在 `captureFrameHash` 之后）**

```js
  /* 给定一帧的哈希 + video，走「匹配 → 跳」。从 frameTick 拆出来，方便测试驱动。 */
  function applyFrameHash(hash, video) {
    if (!runtime.localSegs) return;
    var seg = frameStep(runtime.frameMatcher, runtime.localSegs, hash, video.currentTime, video.duration);
    if (seg) performSkip(video, seg);
  }

  function frameTick() {
    var video = runtime.video || getVideo();
    if (!video || video.paused || video.ended || !video.duration) return;
    var hash = captureFrameHash();
    if (!hash) return;
    applyFrameHash(hash, video);
  }

  function startFrameMonitor() {
    if (runtime.frameTimer) return;
    runtime.frameMatcher = { target: null, hits: 0 };
    runtime.video = runtime.video || getVideo();
    runtime.frameTimer = setInterval(frameTick, FRAME_SAMPLE_MS);
  }
  function stopFrameMonitor() {
    if (runtime.frameTimer) { clearInterval(runtime.frameTimer); runtime.frameTimer = null; }
    runtime.frameMatcher = { target: null, hits: 0 };
  }

  /* rerun 识别完后调用：云端有段 → 停掉抽帧；云端空且本地有指纹 → 开抽帧。 */
  function syncFrameMonitor(r) {
    var key = r && r.bindingKey;
    var segs = key ? loadLocalSegs(key) : null;
    if (shouldUseLocalSegs(r, segs)) {
      runtime.localSegs = segs;
      startFrameMonitor();
    } else {
      runtime.localSegs = null;
      stopFrameMonitor();
    }
  }
```

- [ ] **Step 5: 在 `rerun()` 挂两个钩子**

  1. 在 `rerun()` 顶部 `stopMonitor();`（约 3593 行）之后加一行：

```js
    stopFrameMonitor();
```

  2. 在 `rerun()` 里 `if (r.ok && r.autoSkip) { ... startMonitor(); }` 块之后（约 3609 行 `}` 之后）加一行：

```js
      syncFrameMonitor(r);
```

- [ ] **Step 6: 导出 `applyFrameHash`（调试/测试）**

在 `api_` 里加：

```js
        applyFrameHash: applyFrameHash,
```

在 `api` 对象（调试钩子区，约 3694 行 `_applyScreen` 之后）加：

```js
      _syncFrameMonitor: syncFrameMonitor,
```

- [ ] **Step 7: 运行确认通过**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: 全绿，537 通过 / 0 失败。

- [ ] **Step 8: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 本地帧指纹检测循环（抽帧→匹配→跳过）"
```

---

### Task 9: 油猴菜单动作（标 OP 开始 / 标 OP 结束 / 标 ED 开始）

**Files:**
- Modify: `bilibili-aniskip.user.js`

> 本任务 handler 里调 `captureFrameHash`（浏览器）——记录/落盘逻辑已由 Task 3/4 的纯函数覆盖，这里只做薄封装，手动验证。

- [ ] **Step 1: 实现三个 handler（加在 `syncFrameMonitor` 之后）**

```js
  function currentBinding() {
    var ctx = runtime.ctx;
    return ctx && getBinding(ctx);
  }
  function currentTime() {
    var v = runtime.video || getVideo();
    return v ? v.currentTime : 0;
  }

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
    saveLocalSegs(bind._key, recordEdStart(loadLocalSegs(bind._key), hash));
    showToast('标 ED 开始', '已记录 · ' + Math.round(currentTime()) + 's');
  }
```

- [ ] **Step 2: 注册菜单**

在 `boot()`（约 3652 行 `GM_registerMenuCommand('⚙ ...')` 之后）加：

```js
    try { GM_registerMenuCommand('⏱ 标 OP 开始', markOpStart); } catch (e) { /* ignore */ }
    try { GM_registerMenuCommand('⏱ 标 OP 结束', markOpEnd); } catch (e) { /* ignore */ }
    try { GM_registerMenuCommand('⏱ 标 ED 开始', markEdStart); } catch (e) { /* ignore */ }
```

- [ ] **Step 3: 运行全量确认没破坏旧行为**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: 537 通过 / 0 失败（菜单注册在测试里是 no-op，不应影响任何断言）。

- [ ] **Step 4: 手动验证（浏览器）**

  1. 手动绑定一个冷番（AniSkip 无数据）。
  2. 拖到 OP 开始帧暂停 → 油猴菜单「标 OP 开始」→ 见 toast。
  3. 拖到 OP 结束帧 → 「标 OP 结束」→ toast。
  4. 拖到 ED 开始帧 → 「标 ED 开始」→ toast。
  5. 控制台 `GM_getValue('aniskip.localSegs.<你的bindingKey>')` 应能打印出 `{ ops:[{hash,start,end}], eds:[{hash}] }`。
  6. 重播该集开头：OP 开始帧被认出后应自动跳到 OP 结束；ED 开始帧被认出后应跳到结尾。

- [ ] **Step 5: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 油猴菜单标记动作（OP 开始/结束、ED 开始）"
```

---

### Task 10: 全量回归 + README + 版本号 0.5.0

**Files:**
- Modify: `README.md`
- Modify: `bilibili-aniskip.user.js`（`@version`）

- [ ] **Step 1: 跑全量回归**

Run: `node test/bilibili-aniskip.test.js -q`
Expected: **537 通过 / 0 失败**（如数量不同以实际为准，但必须 0 失败）。

- [ ] **Step 2: 语法检查**

Run: `node --check bilibili-aniskip.user.js`
Expected: 无输出、exit 0。

- [ ] **Step 3: 更新 README**

  1. 特性清单加一条：`本地手动标记 OP/ED 帧（冷番兜底）：认 OP/ED 开始帧自动跳过，同番跨集复用`。
  2. 新增 `## 0.5.0` changelog，内容（7 条要点）：

```
- 新增「手动标记 OP/ED 帧」：冷番 / 新番云端无时间戳时，油猴菜单「标 OP 开始 / 标 OP 结束 / 标 ED 开始」标记，脚本靠视觉指纹（aHash）自动识别跳过，同番跨集复用。
- 指纹匹配：8×8 灰度平均哈希 + Hamming 距离（≤10/64）+ 连续 ≥2 次命中防误判；每 0.25s 抽一帧。
- 本地兜底：云端（AniSkip/Anime Skip）有时间戳优先用云端，没有才用本地指纹；手动绑定的番在网络失败时也会用本地指纹兜底。
- 换 OP/ED：重新标记即追加新指纹，旧的自动区分。
- 读帧无需注入 crossorigin：B 站用 MSE 播放，MediaSource 是 CORS 干净的，直接 drawImage + getImageData 即可读像素。
- 新增测试组 47（指纹 / 存取 / 记录 / 匹配 / 兜底判定 / 检测循环 / 端到端跳过）。
- 版本 0.5.0。
```

- [ ] **Step 4: 更新版本号**

`bilibili-aniskip.user.js` 顶部 `// @version` 从 `0.4.8` 改为 `0.5.0`。

- [ ] **Step 5: 提交**

```bash
git -C F:\dsh\bilibili-aniskip add README.md bilibili-aniskip.user.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "0.5.0: 本地手动标记 OP/ED 帧（冷番兜底）"
```

- [ ] **Step 6: clean-room RED 对照（验证新测试真在测新行为）**

```bash
$repo='F:\dsh\bilibili-aniskip'; $red='F:\dsh\_red'; $tar='F:\dsh\_red.tar'
if (Test-Path $red) { Remove-Item $red -Recurse -Force }
if (Test-Path $tar) { Remove-Item $tar -Force }
New-Item -ItemType Directory -Path $red | Out-Null
git -C $repo archive --format=tar -o $tar f50b3ac
tar -xf $tar -C $red
Remove-Item $tar -Force
Copy-Item "$repo\test\bilibili-aniskip.test.js" "$red\test\bilibili-aniskip.test.js" -Force
node "$red\test\bilibili-aniskip.test.js" -q
Remove-Item $red -Recurse -Force
```

Expected: 组 47 的 37 个新断言全部失败（旧版没有这些导出），旧 501 条仍通过 —— 证明新测试测的是新代码。

---

## Self-Review 结果

- **Spec 覆盖**：设计文档 9 节全部有对应任务（交互=Task 9、指纹算法=Task 1/2/5、存储=Task 3/4、检测集成=Task 8、测试=各 Task、范围外不做）。CORS 前提 = Task 0 决策门 + Task 7 注入。
- **占位符扫描**：无 TBD/TODO；所有代码步骤都有完整代码；无「类似 Task N」引用（每处代码都完整重复）。
- **类型一致性**：哈希统一 64 位 `'0'/'1'` 字符串；`localSegs` 形状统一 `{ ops:[{hash,start,end}], eds:[{hash}] }`（`end` 允许 `< start` 表示 pending）；`matcher` 形状统一 `{ target, hits }`；`frameStep`/`applyFrameHash`/`shouldUseLocalSegs` 签名在测试与实现中一致。
- **注意**：Task 10 Step 1 的期望数字（537）由 Task 1-8 逐任务累加得出，实际以跑完为准，但必须 0 失败。
