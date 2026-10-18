# 数据备份 / 状态行提示 / 死代码清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给本地手标数据加导出/导入/撤销能力，说明「标了为什么不跳」，并清掉 `epLen` / `mixed` 死代码，发 0.5.2。

**Architecture:** 数据层做成三个纯函数（`buildBackup` / `parseBackup` / `applyBackup`）+ 一个撤销函数，全部挂到 `api.api_` 给测试用；UI 只做胶水（设置面板加一行 → 浮层 textarea）。导入语义是整包覆盖，先全量深校验再写，导入前自动存快照供撤销。

**Tech Stack:** 单文件 Tampermonkey userscript（ES5，`var`/`function`/字符串拼接，禁止箭头函数与模板字符串）、零依赖自建测试 harness（`node test/bilibili-aniskip.test.js -q`）。

---

## 文件结构

| 文件 | 改动 |
| --- | --- |
| `bilibili-aniskip/bilibili-aniskip.user.js` | 新增「数据备份与恢复」数据层 + 设置面板入口 + 浮层；状态行加提示；删 `epLen`/`mixed` 死代码；`@version` 0.5.2 |
| `bilibili-aniskip/test/bilibili-aniskip.test.js` | 新增 3 节测试（数据层 / UI / 状态行），约 +23 条断言 |
| `bilibili-aniskip/CHANGELOG.md` | 新增 `## 0.5.2` |
| `bilibili-aniskip/README.md` | 功能列表补备份、设置表加一行 |

**约定（每个任务都适用）**

- 工作目录 `F:\dsh`，命令里不要给 node / git 加管道或重定向（沙箱会报 `Access is denied`）。
- 改完必须跑：`node --check bilibili-aniskip\bilibili-aniskip.user.js`，再跑 `node bilibili-aniskip\test\bilibili-aniskip.test.js -q`。
- 提交用：`git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "…"`。
- 基线：0.5.1 是 **669 通过 / 0 失败**。

---

### Task 1: 数据层（buildBackup / parseBackup / applyBackup / undoImport）

**Files:**
- Modify: `bilibili-aniskip/bilibili-aniskip.user.js`（在 `  /* ---- 设置面板 ---- */` 这行**之前**插入新块）
- Modify: `bilibili-aniskip/bilibili-aniskip.user.js`（`api_.` 导出块末尾补 6 个函数，位置见 Step 5）
- Test: `bilibili-aniskip/test/bilibili-aniskip.test.js`（文件末尾汇总输出之前）

- [ ] **Step 1: 先写失败测试**

在测试文件末尾的 `  /* --- 汇总 --- */` 这一行**之前**插入：

```js
  /* --- 43. 数据备份与恢复：导出 / 解析 / 导入（整包覆盖）/ 撤销 --- */
  head('43. 数据备份与恢复');
  {
    const HASH = '0101'.repeat(16);                    // 64 位指纹
    const BIND = { 's:1': { title: '葬送的芙莉莲', at: 1 } };
    const SEGS = { ops: [{ hash: HASH, start: 12, end: 102, vid: 'BV_TEST000001:1' }], eds: [] };
    const makeStore = () => ({
      autoDetect: 'auto', jumpOp: false, jumpEd: true, skipOffset: 3,
      _bindings: JSON.stringify(BIND),
      _blacklist: JSON.stringify({ 'b:BV_GARBAGE001': { t: 1, title: 'x' } }),
      'aniskip.localSegs.s:1': JSON.stringify(SEGS)
    });

    const e = makeEnv({ store: makeStore() });
    const api = e.api.api_;
    const buildBackup = hook(e, 'buildBackup');
    const parseBackup = hook(e, 'parseBackup');
    const applyBackup = hook(e, 'applyBackup');
    const undoImport = hook(e, 'undoImport');

    /* ① 导出内容 */
    const bk = buildBackup();
    check('备份 app 标记', bk.app, 'bilibili-aniskip');
    check('备份 schema', bk.schema, 1);
    checkTrue('备份带导出时间', typeof bk.exportedAt === 'string' && bk.exportedAt.length >= 10);
    check('配置键齐全', Object.keys(bk.config).length, Object.keys(e.api.api_.getConfig()).length);
    checkTrue('导出不含缓存', !('_cache' in bk));
    check('绑定进备份', bk.bindings['s:1'].title, '葬送的芙莉莲');
    check('黑名单进备份', Object.keys(bk.blacklist).length, 1);
    check('本地标记进备份', bk.localSegs['s:1'].ops.length, 1);
    check('本地标记带集号', bk.localSegs['s:1'].ops[0].vid, 'BV_TEST000001:1');

    /* ② 往返：导出 → 空设备导入 → 内容一致 */
    const text = JSON.stringify(bk);
    const e2 = makeEnv({ store: {} });
    const parsed = parseBackup(text);
    checkTrue('解析合法备份', parsed.ok === true, parsed);
    const r2 = applyBackup(parsed.data);
    checkTrue('导入成功', r2.ok === true, r2);
    const bk2 = e2.api.api_.buildBackup();
    check('往返：配置一致', bk2.config.jumpOp, false);
    check('往返：绑定一致', bk2.bindings['s:1'].title, '葬送的芙莉莲');
    check('往返：标记指纹一致', bk2.localSegs['s:1'].ops[0].hash, HASH);
    check('往返：标记时间一致', bk2.localSegs['s:1'].ops[0].start, 12);

    /* ③ 坏备份逐类拒绝，且拒绝时不写任何东西 */
    check('非法 JSON 被拒', parseBackup('{oops').ok, false);
    check('缺 app 被拒', parseBackup('{"schema":1}').ok, false);
    check('schema 太新被拒', parseBackup(JSON.stringify({ app: 'bilibili-aniskip', schema: 2 })).ok, false);
    const noHash = JSON.stringify({ app: 'bilibili-aniskip', schema: 1, localSegs: { 's:1': { ops: [{ start: 1, end: 2 }], eds: [] } } });
    const noHashParsed = parseBackup(noHash);
    checkTrue('标记缺指纹：结构能解析', noHashParsed.ok === true, noHashParsed);
    const noHashApply = applyBackup(noHashParsed.data);
    check('标记缺指纹：导入被拒', noHashApply.ok, false);
    checkTrue('拒绝时给出原因', typeof noHashApply.reason === 'string' && noHashApply.reason.length > 0, noHashApply);

    const e3 = makeEnv({ store: { autoDetect: 'off', _bindings: JSON.stringify(BIND) } });
    const before3 = JSON.stringify(e3.store);
    const badCfg = e3.api.api_.applyBackup({ app: 'bilibili-aniskip', schema: 1, config: { jumpOp: 'yes' } });
    check('配置类型错被拒', badCfg.ok, false);
    check('拒绝后存储一个字节没动', JSON.stringify(e3.store), before3);

    /* ④ 撤销：导入成功会留快照，撤销后回到导入前 */
    const e4 = makeEnv({
      store: { autoDetect: 'off', _bindings: JSON.stringify(BIND), 'aniskip.localSegs.s:1': JSON.stringify(SEGS) }
    });
    const api4 = e4.api.api_;
    const r4 = api4.applyBackup(api4.parseBackup(text).data);
    checkTrue('导入成功（撤销用例）', r4.ok === true, r4);
    check('导入后配置已换', e4.store.autoDetect, 'auto');
    checkTrue('导入前快照已存', typeof e4.store['aniskip.lastBeforeImport'], 'string');
    const snap = JSON.parse(e4.store['aniskip.lastBeforeImport']);
    check('快照里是导入前的配置', snap.config.autoDetect, 'off');
    const undo = api4.undoImport();
    checkTrue('撤销成功', undo.ok === true, undo);
    check('撤销后配置回到导入前', e4.api.api_.getConfig().autoDetect, 'off');
    check('撤销后快照被清掉', e4.store['aniskip.lastBeforeImport'], undefined);
    check('没有快照时撤销给出原因', api4.undoImport().ok, false);
  }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node bilibili-aniskip\test\bilibili-aniskip.test.js -q`
Expected: 失败（`buildBackup is not a function` 一类），此时是「测试先红」的预期状态。

- [ ] **Step 3: 实现数据层**

在 `bilibili-aniskip.user.js` 里 `  /* ---- 设置面板 ---- */` 之前插入：

```js
  /* ---- 数据备份与恢复（导出 / 导入 / 撤销） ----
   * 为什么要：本地标记（aniskip.localSegs.*）是手标的画面指纹，丢了没法重建。
   * GM 没给 GM_listValues 权限，所以 localSegs 的键从 _bindings 的 key 反推 ——
   * 没绑定的标记本来也用不上。
   * 导入是整包覆盖：先全量深校验，任何一项不合格就一个字节都不写。 */
  var BACKUP_APP = 'bilibili-aniskip';
  var BACKUP_SCHEMA = 1;
  var BACKUP_SNAPSHOT_KEY = 'aniskip.lastBeforeImport';

  var BACKUP_BOOL_KEYS = ['jumpOp', 'jumpEd', 'showToast', 'useSeasonTitle', 'showIdlePill', 'pillCollapsed', 'autoNext'];
  /* 数值项：[最小, 最大, 是否取整]，沿用设置面板的夹取范围 */
  var BACKUP_NUM_KEYS = {
    skipOffset: [-30, 30, 0], skipShift: [-30, 30, 1],
    undoSeconds: [0, 30, 0], confThreshold: [0, 100, 0], hintThreshold: [0, 100, 0]
  };

  function scriptVersion() {
    try {
      if (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) {
        return String(GM_info.script.version);
      }
    } catch (e) { /* ignore */ }
    return '0';
  }

  function cloneJson(v) {
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
  }

  /* 当前数据 → 备份对象（只读，不改状态） */
  function buildBackup() {
    var cfg = {}, keys = Object.keys(DEFAULTS), i;
    for (i = 0; i < keys.length; i++) cfg[keys[i]] = config[keys[i]];
    var segs = {};
    Object.keys(bindings).forEach(function (bk) {
      var v = validateLocalSegs(gmGet(localSegsKey(bk), null));
      if (v.ops.length || v.eds.length) segs[bk] = v;
    });
    return {
      app: BACKUP_APP,
      schema: BACKUP_SCHEMA,
      version: scriptVersion(),
      exportedAt: new Date().toISOString(),
      config: cfg,
      bindings: cloneJson(bindings) || {},
      blacklist: cloneJson(blacklist) || {},
      localSegs: segs,
      ui: {
        markOn: !!gmGet(MARK_ON_KEY, false),
        markPos: gmGet(MARK_POS_KEY, null) || null,
        pillPos: gmGet(PILL_POS_KEY, null) || null
      }
    };
  }

  /* 解析 + 结构校验（值类型深校验在 applyBackup 里，写之前全部跑完） */
  function parseBackup(text) {
    var raw;
    try { raw = JSON.parse(String(text === undefined || text === null ? '' : text)); } catch (e) {
      return { ok: false, reason: '不是合法 JSON' };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '不是备份对象' };
    if (raw.app !== BACKUP_APP) return { ok: false, reason: '不是本脚本的备份（缺少 app 标记）' };
    var schema = Number(raw.schema);
    if (!isFinite(schema) || schema < 1) return { ok: false, reason: '备份格式版本缺失' };
    if (schema > BACKUP_SCHEMA) return { ok: false, reason: '备份来自更新的版本（schema ' + schema + '），先升级脚本' };
    var checks = [['config', '设置'], ['bindings', '绑定'], ['blacklist', '黑名单'], ['localSegs', '本地标记']];
    for (var i = 0; i < checks.length; i++) {
      var v = raw[checks[i][0]];
      if (v === undefined) continue;
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        return { ok: false, reason: checks[i][1] + '字段（' + checks[i][0] + '）损坏' };
      }
    }
    return { ok: true, data: raw };
  }

  function sanitizeBackupConfig(src) {
    var out = {}, i, k, v;
    if (src === undefined || src === null) return { config: out };
    if (typeof src !== 'object' || Array.isArray(src)) return { reason: '设置字段损坏' };
    if (src.autoDetect !== undefined) {
      if (src.autoDetect !== 'off' && src.autoDetect !== 'ask' && src.autoDetect !== 'auto') {
        return { reason: '设置项 autoDetect 只能是 off / ask / auto' };
      }
      out.autoDetect = src.autoDetect;
    }
    for (i = 0; i < BACKUP_BOOL_KEYS.length; i++) {
      k = BACKUP_BOOL_KEYS[i];
      if (src[k] === undefined) continue;
      if (typeof src[k] !== 'boolean') return { reason: '设置项 ' + k + ' 不是布尔值' };
      out[k] = src[k];
    }
    for (k in BACKUP_NUM_KEYS) {
      if (!BACKUP_NUM_KEYS.hasOwnProperty(k) || src[k] === undefined) continue;
      v = Number(src[k]);
      if (!isFinite(v)) return { reason: '设置项 ' + k + ' 不是数字' };
      var lim = BACKUP_NUM_KEYS[k];
      v = Math.max(lim[0], Math.min(lim[1], v));
      if (lim[2]) v = Math.round(v);
      out[k] = v;
    }
    return { config: out };
  }

  /* 标记深校验：坏一条就整包拒绝（读取侧 validateLocalSegs 是「静默丢弃」，
   * 导入不一样 —— 要么全对，要么一个字节都不写） */
  function sanitizeBackupSegs(data, where) {
    var out = { ops: [], eds: [] }, lists = [['ops', 'OP'], ['eds', 'ED']], li, i;
    if (data === undefined || data === null) return { segs: out };
    if (typeof data !== 'object' || Array.isArray(data)) return { reason: where + ' 不是对象' };
    for (li = 0; li < lists.length; li++) {
      var name = lists[li][0], label = lists[li][1], arr = data[name];
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) return { reason: where + ' 的 ' + label + ' 列表不是数组' };
      for (i = 0; i < arr.length; i++) {
        var it = arr[i], n = i + 1;
        if (!it || typeof it !== 'object' || Array.isArray(it)) return { reason: where + ' 第 ' + n + ' 条 ' + label + ' 不是对象' };
        if (typeof it.hash !== 'string' || it.hash.length < 16) return { reason: where + ' 第 ' + n + ' 条 ' + label + ' 缺少画面指纹' };
        var st = Number(it.start), en = Number(it.end);
        if (!isFinite(st) || !isFinite(en)) return { reason: where + ' 第 ' + n + ' 条 ' + label + ' 的时间不是数字' };
        out[name].push({ hash: it.hash, start: st, end: en, vid: strOrNull(it.vid) });
      }
    }
    return { segs: out };
  }

  /* 整包覆盖：校验 → 留快照 → 写。opts.snapshot === false 时不留快照（撤销用）。 */
  function applyBackup(data, opts) {
    opts = opts || {};
    var cfgRes = sanitizeBackupConfig(data && data.config);
    if (cfgRes.reason) return { ok: false, reason: cfgRes.reason };
    var segs = {}, segKeys = Object.keys((data && data.localSegs) || {}), i;
    for (i = 0; i < segKeys.length; i++) {
      var sr = sanitizeBackupSegs(data.localSegs[segKeys[i]], '本地标记 ' + segKeys[i]);
      if (sr.reason) return { ok: false, reason: sr.reason };
      segs[segKeys[i]] = sr.segs;
    }
    var nb = (data && data.bindings) || {}, nbl = (data && data.blacklist) || {};
    if (typeof nb !== 'object' || Array.isArray(nb)) return { ok: false, reason: '绑定字段损坏' };
    if (typeof nbl !== 'object' || Array.isArray(nbl)) return { ok: false, reason: '黑名单字段损坏' };

    /* ---- 校验全过，开始写 ---- */
    if (opts.snapshot !== false) {
      try { gmSet(BACKUP_SNAPSHOT_KEY, JSON.stringify(buildBackup())); } catch (e) { /* ignore */ }
    }
    Object.keys(cfgRes.config).forEach(function (k) { gmSet(k, cfgRes.config[k]); config[k] = cfgRes.config[k]; });
    var oldKeys = Object.keys(bindings);
    bindings = nb;
    persistBindings();
    for (i = 0; i < oldKeys.length; i++) {
      if (!segs.hasOwnProperty(oldKeys[i])) {
        try { GM_deleteValue(localSegsKey(oldKeys[i])); } catch (e) { /* ignore */ }
      }
    }
    Object.keys(segs).forEach(function (bk) { saveLocalSegs(bk, segs[bk]); });
    blacklist = nbl;
    persistBlacklist();
    if (data && data.ui && typeof data.ui === 'object') {
      try { gmSet(MARK_ON_KEY, !!data.ui.markOn); } catch (e) { /* ignore */ }
      try { gmSet(MARK_POS_KEY, data.ui.markPos || null); } catch (e) { /* ignore */ }
      try { gmSet(PILL_POS_KEY, data.ui.pillPos || null); } catch (e) { /* ignore */ }
    }
    return { ok: true };
  }

  function hasBackupSnapshot() {
    try { return !!gmGet(BACKUP_SNAPSHOT_KEY, null); } catch (e) { return false; }
  }

  function undoImport() {
    var raw = null;
    try { raw = gmGet(BACKUP_SNAPSHOT_KEY, null); } catch (e) { raw = null; }
    if (!raw) return { ok: false, reason: '没有可撤销的导入' };
    var pr = parseBackup(raw);
    if (!pr.ok) return { ok: false, reason: '撤销快照损坏：' + pr.reason };
    var res = applyBackup(pr.data, { snapshot: false });
    if (res.ok) {
      try { GM_deleteValue(BACKUP_SNAPSHOT_KEY); } catch (e) { /* ignore */ }
    }
    return res;
  }
```

- [ ] **Step 4: 导出到 `api.api_`**

在 `api_.` 对象里、`        frameStep: frameStep,` 这一行**之后**插入：

```js
        // 数据备份：导出 / 解析 / 导入 / 撤销
        buildBackup: buildBackup, parseBackup: parseBackup, applyBackup: applyBackup,
        undoImport: undoImport, hasBackupSnapshot: hasBackupSnapshot,
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --check bilibili-aniskip\bilibili-aniskip.user.js`
Expected: 退出码 0（无输出）

Run: `node bilibili-aniskip\test\bilibili-aniskip.test.js -q`
Expected: `结果：700 通过 / 0 失败`（669 + 本节 31 条；条数若有出入以「0 失败」为准）

- [ ] **Step 6: 提交**

```powershell
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 数据备份数据层（导出/解析/整包导入/撤销）"
```

---

### Task 2: 设置面板入口 + 备份浮层（导出 / 导入 / 撤销 / 复制）

**Files:**
- Modify: `bilibili-aniskip/bilibili-aniskip.user.js`（设置面板：加一行 + 接线；新增 `openBackupPanel` / `copyText`）
- Test: `bilibili-aniskip/test/bilibili-aniskip.test.js`（新增第 44 节）

- [ ] **Step 1: 先写失败测试**

在上一步第 43 节之后、汇总输出之前插入：

```js
  /* --- 44. 设置面板「数据备份」入口 + 浮层 --- */
  head('44. 数据备份面板');
  {
    const HASH = '0101'.repeat(16);
    const e = makeEnv({
      store: {
        autoDetect: 'off',
        _bindings: JSON.stringify({ 's:1': { title: '芙莉莲', at: 1 } }),
        'aniskip.localSegs.s:1': JSON.stringify({ ops: [{ hash: HASH, start: 5, end: 95, vid: 'BV_TEST000001:1' }], eds: [] })
      },
      location: LOC, video: mkVideoEl(10, 1440)
    });
    const sp = openPanelVia(e, 'settings');
    checkTrue('设置面板有「数据备份」按钮', !!sp.querySelector('.backup'));
    sp.querySelector('.backup').dispatch('click');
    const bp = orNode(byClass('panel'));
    const box = bp.querySelector('.bktext');
    const tip = bp.querySelector('.bktip');
    checkTrue('浮层有文本框', !!box);
    checkTrue('浮层有导入按钮', !!bp.querySelector('.bkimport'));

    box.value = '不是 json';
    bp.querySelector('.bkimport').dispatch('click');
    checkTrue('非法内容导入 → 提示失败', /失败/.test(tip.textContent), tip.textContent);

    bp.querySelector('.bkfill').dispatch('click');
    checkTrue('导出到框里 → 是 JSON', box.value.indexOf('"app": "bilibili-aniskip"') >= 0, box.value.slice(0, 40));
    checkTrue('导出提示说明条数', /绑定 1 条/.test(tip.textContent), tip.textContent);

    const text = box.value;
    box.value = text;
    bp.querySelector('.bkimport').dispatch('click');
    checkTrue('合法备份导入成功', /成功/.test(tip.textContent), tip.textContent);
    checkTrue('导入写了快照（可撤销）', typeof e.store['aniskip.lastBeforeImport'], 'string');
  }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node bilibili-aniskip\test\bilibili-aniskip.test.js -q`
Expected: 第 44 节失败（`.backup` 拿不到）。

- [ ] **Step 3: 设置面板加入口**

在 `openSettings()` 的 `panel.innerHTML` 拼接里，`'<div class="btns"><button class="clr">清空缓存</button>' +` 这一行**之前**插入两行：

```js
      '<div class="row"><div><div class="lab">数据备份</div>' +
      '<div class="tip">导出绑定 / 本地标记 / 设置，换浏览器或重装后导回来。本地标记是手标的画面指纹，丢了没法重建</div></div>' +
      '<button class="backup">导出 / 导入</button></div>' +
```

在 `    panel.querySelector('.save').addEventListener('click', function () {` 这一行**之前**插入接线（`closePanel` 是当前函数里的变量）：

```js
    var backupBtn = panel.querySelector('.backup');
    noFocus(backupBtn);
    backupBtn.addEventListener('click', function () {
      closePanel();
      openBackupPanel();
    });
```

- [ ] **Step 4: 实现浮层**

紧跟在 `openSettings` 函数结束之后插入：

```js
  /* 数据备份浮层：导出到框里 / 从框里导入 / 撤销导入。
   * 不走文件下载上传、也不依赖剪贴板权限 —— textarea 是唯一到哪都能用的通道。 */
  function copyText(text) {
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          showToast('已复制', '备份内容已进剪贴板，粘到记事本保存');
        }, function () {
          showToast('复制失败', '框里已全选，直接按 Ctrl+C 也行');
        });
        return;
      }
    } catch (e) { /* ignore */ }
    showToast('请手动复制', '框里已全选，按 Ctrl+C 即可');
  }

  function openBackupPanel() {
    ensureUI();
    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<h3>数据备份</h3>' +
      '<div class="sub">导出＝把绑定 / 本地标记 / 设置存成一段文本，粘到记事本或网盘即可。' +
      '导入＝用备份整包替换当前数据（导入前会自动留一份快照，可以撤销）。</div>' +
      '<textarea class="bktext" spellcheck="false" style="width:100%;height:150px;box-sizing:border-box;' +
      'font:12px/1.6 Consolas,Menlo,monospace;padding:8px;border:1px solid #ddd;border-radius:8px;"></textarea>' +
      '<div class="btns" style="justify-content:flex-start">' +
      '<button class="bkfill primary">导出到框里</button>' +
      '<button class="bkcopy">复制</button>' +
      '<button class="bkimport">从框里导入</button>' +
      '<button class="bkundo">撤销导入</button></div>' +
      '<div class="sub bktip"></div>';
    var close = mountPanel(panel);
    var box = panel.querySelector('.bktext');
    var tip = panel.querySelector('.bktip');
    var undoBtn = panel.querySelector('.bkundo');
    undoBtn.style.display = hasBackupSnapshot() ? '' : 'none';
    ['.bkfill', '.bkcopy', '.bkimport', '.bkundo'].forEach(function (sel) {
      noFocus(panel.querySelector(sel));
    });
    function say(t) { tip.textContent = t; }
    panel.querySelector('.bkfill').addEventListener('click', function () {
      var bk = buildBackup();
      box.value = JSON.stringify(bk, null, 2);
      try { box.focus(); box.select(); } catch (e) { /* ignore */ }
      say('已生成：绑定 ' + Object.keys(bk.bindings).length + ' 条、本地标记 ' +
        Object.keys(bk.localSegs).length + ' 套（已全选，Ctrl+C 复制）');
    });
    panel.querySelector('.bkcopy').addEventListener('click', function () {
      if (!box.value) { say('先点「导出到框里」生成内容'); return; }
      copyText(box.value);
    });
    panel.querySelector('.bkimport').addEventListener('click', function () {
      var pr = parseBackup(box.value);
      if (!pr.ok) { say('导入失败：' + pr.reason); return; }
      if (!confirm('导入会用备份替换当前全部数据（设置 / 绑定 / 本地标记 / 历史黑名单），确定吗？')) return;
      var res = applyBackup(pr.data);
      if (!res.ok) { say('导入失败：' + res.reason); return; }
      say('导入成功。正在刷新…');
      try { renderPill(); } catch (e2) { /* ignore */ }
      try { rerun(); } catch (e3) { /* ignore */ }
      try { close(); } catch (e4) { /* ignore */ }
      showToast('数据已导入', '绑定 / 本地标记 / 设置已按备份恢复（可撤销一次）');
    });
    undoBtn.addEventListener('click', function () {
      var res = undoImport();
      if (!res.ok) { say('撤销失败：' + res.reason); return; }
      try { renderPill(); } catch (e2) { /* ignore */ }
      try { rerun(); } catch (e3) { /* ignore */ }
      try { close(); } catch (e4) { /* ignore */ }
      showToast('已撤销导入', '回到导入前的数据');
    });
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --check bilibili-aniskip\bilibili-aniskip.user.js`
Expected: 退出码 0

Run: `node bilibili-aniskip\test\bilibili-aniskip.test.js -q`
Expected: `结果：708 通过 / 0 失败`（700 + 本节 8 条）

- [ ] **Step 6: 提交**

```powershell
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 设置面板加「数据备份」—— 导出 / 导入 / 撤销"
```

---

### Task 3: 标记工具条状态行（说清本地指纹在不在用）

**Files:**
- Modify: `bilibili-aniskip/bilibili-aniskip.user.js`（`refreshMarkBar` 附近）
- Test: `bilibili-aniskip/test/bilibili-aniskip.test.js`（新增第 45 节）

- [ ] **Step 1: 先写失败测试**

在上一步之后插入：

```js
  /* --- 45. 标记工具条状态行：本地标记到底参不参与 --- */
  head('45. 标记状态提示');
  {
    const e = makeEnv();
    const hint = hook(e, 'markBarStatusHint');
    const rt = e.api._runtime;
    check('未识别时状态行不加料', hint(), '');
    rt.result = { ok: true, segments: [{ type: 'op', start: 30, end: 120 }] };
    check('云端有段 → 说明本地标记不参与', hint(), ' · 云端已有时间戳，本地标记不参与');
    rt.result = { ok: false, reason: 'upstream', segments: [] };
    check('识别未完成 → 本地标记待命', hint(), ' · 识别未完成，本地标记待命');
    rt.localSegs = { ops: [{ hash: '01'.repeat(32), start: 5, end: 95, vid: null }], eds: [] };
    check('本地指纹在跑 → 提示错过画面就不跳', hint(), ' · 本地指纹匹配中（错过 OP/ED 画面就不会跳）');
  }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node bilibili-aniskip\test\bilibili-aniskip.test.js -q`
Expected: 第 45 节失败（`hint()` 不是函数）。

- [ ] **Step 3: 实现**

在 `function refreshMarkBar()` 之前插入：

```js
  /* 工具条状态行补一句「本地标记此刻到底参不参与」——「标了却不跳」多半是这个原因。 */
  function markBarStatusHint() {
    if (runtime.localSegs) return ' · 本地指纹匹配中（错过 OP/ED 画面就不会跳）';
    var r = runtime.result;
    if (r && r.ok && ((r.segments || []).length)) return ' · 云端已有时间戳，本地标记不参与';
    if (r && !r.ok) return ' · 识别未完成，本地标记待命';
    return '';
  }
```

把 `refreshMarkBar()` 里的这行：

```js
    stat.textContent = '当前：' + (bind.title || bind._key) +
      '   已标 OP ' + ops.length + ' 套 / ED ' + eds.length + ' 套' + hint;
```

改成：

```js
    stat.textContent = '当前：' + (bind.title || bind._key) +
      '   已标 OP ' + ops.length + ' 套 / ED ' + eds.length + ' 套' + hint + markBarStatusHint();
```

在 `api.api_` 里补导出（放在 `        hasBackupSnapshot: hasBackupSnapshot,` 这一行**之后**）：

```js
        markBarStatusHint: markBarStatusHint,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --check bilibili-aniskip\bilibili-aniskip.user.js`
Run: `node bilibili-aniskip\test\bilibili-aniskip.test.js -q`
Expected: `结果：712 通过 / 0 失败`（708 + 本节 4 条）

- [ ] **Step 5: 提交**

```powershell
git -C F:\dsh\bilibili-aniskip add bilibili-aniskip.user.js test/bilibili-aniskip.test.js
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "feat: 标记工具条说明本地指纹是否在参与（消除了「标了不跳」的困惑）"
```

---

### Task 4: 死代码清理 + 版本号 / CHANGELOG / README

**Files:**
- Modify: `bilibili-aniskip/bilibili-aniskip.user.js`
- Modify: `bilibili-aniskip/CHANGELOG.md`
- Modify: `bilibili-aniskip/README.md`

- [ ] **Step 1: 删 `epLen` 死字段（3 处）**

① `fetchAniSkip` 里出段对象的那一行，删掉 `epLen: r.episodeLength || 0`（注意删完行尾逗号要收好）：

```js
            // 改前
              source: 'aniskip', epLen: r.episodeLength || 0
            // 改后
              source: 'aniskip'
```

② `fetchAnimeSkip` 里：

```js
          // 改前
          segs.push({ type: mapped, start: start, end: end, source: 'animeskip', epLen: 0 });
          // 改后
          segs.push({ type: mapped, start: start, end: end, source: 'animeskip' });
```

③ `applyFrameHash` 里的段对象：

```js
        // 改前
        type: seg.type, mixed: seg.mixed, start: a, end: b,
        source: seg.source, epLen: seg.epLen, shift: s
        // 改后
        type: seg.type, start: a, end: b,
        source: seg.source, shift: s
```

- [ ] **Step 2: 删 `mixed` 解析与透传**

`fetchAniSkip` 里出段对象处：

```js
          // 改前
            type: raw.replace('mixed-', ''),
            mixed: /^mixed-/.test(raw),
          // 改后
            type: raw,
```

（`segmentEnabled` 里那行 `if (s.mixed) return false;` **保留** —— 防历史数据。）

- [ ] **Step 3: 确认没有残留**

Run: `Select-String -Path F:\dsh\bilibili-aniskip\bilibili-aniskip.user.js -Pattern 'epLen'`
Expected: 无输出（0 命中）

Run: `Select-String -Path F:\dsh\bilibili-aniskip\bilibili-aniskip.user.js -Pattern 'mixed'`
Expected: 只剩类型映射里的 `'Mixed Intro': null`、注释、以及 `if (s.mixed) return false;` 这一行

- [ ] **Step 4: 版本号 + CHANGELOG + README**

1. `// @version      0.5.1` → `// @version      0.5.2`
2. `CHANGELOG.md` 的 `## 0.5.1` 之前插入：

```markdown
## 0.5.2

- **数据备份**：设置面板新增「数据备份」——把设置、手动绑定、本地标记（手标的画面指纹）导出成一段 JSON 文本，换浏览器 / 重装 / 清理站点数据后原样导回来。导入是整包覆盖，先全量校验（坏备份一个字节都不写），导入前自动留快照，可点「撤销导入」回到导入前。
- **标记工具条说明本地标记到底在不在用**：本地指纹匹配中 / 云端已有时间戳不参与 / 识别未完成待命，三种状态直接写在状态行 —— 以前「标了却不跳」只能靠猜。
- 清理死代码：`epLen`（从没被读过）、`mixed` 解析与透传（0.5.1 起不会再产生这类段）。

```

3. `README.md` 功能列表那行：

```markdown
// 改前
- **本地手动标记（冷番兜底）**：数据库里没有的番，点胶囊上的 🎯 边看边标 OP/ED 的起止帧，脚本认画面指纹自动跳，同番每集复用
// 改后
- **本地手动标记（冷番兜底）**：数据库里没有的番，点胶囊上的 🎯 边看边标 OP/ED 的起止帧，脚本认画面指纹自动跳，同番每集复用；标记可导出备份
```

4. `README.md` 设置表：在「隐藏胶囊（普通视频）」那一行之后插入：

```markdown
| 数据备份                  | —         | 导出 / 导入设置、手动绑定和本地标记；换浏览器或重装后导回来                                                       |
```

- [ ] **Step 5: 跑全量测试**

Run: `node --check bilibili-aniskip\bilibili-aniskip.user.js`
Run: `node bilibili-aniskip\test\bilibili-aniskip.test.js -q`
Expected: 0 失败（含版本号与 CHANGELOG 一致性检查）

- [ ] **Step 6: 提交 + 收尾**

```powershell
git -C F:\dsh\bilibili-aniskip add -A
git -C F:\dsh\bilibili-aniskip -c user.name="PZero534232" -c user.email="140600242+PZero534232@users.noreply.github.com" commit -m "chore: 0.5.2 —— 死代码清理 + CHANGELOG / README 同步"
git -C F:\dsh\bilibili-aniskip status --porcelain
```

Expected: `status` 无输出（干净）。

---

## 验证清单（全部任务完成后）

1. `node --check` → 0
2. `node test/bilibili-aniskip.test.js -q` → 0 失败
3. `git status --porcelain` → 空
4. 手工冒烟（浏览器，可选）：设置 → 数据备份 → 导出到框里（能看到 JSON）→ 全删 → 粘贴 → 导入 → 标记还在
5. 交付 `git -C F:\dsh\bilibili-aniskip push origin main`，GF 发 0.5.2