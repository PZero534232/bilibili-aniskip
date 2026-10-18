/* bilibili-aniskip.user.js 冒烟测试
 * 自建 GM + DOM + 网络桩，重点覆盖：标题清洗 / 集号抽取 / 时长打分 / 区间校验 /
 * 双源合并 / 多分P锚点推算 / 自动识别总开关 / 黑名单 / 手动绑定优先 */
'use strict';
const fs = require('fs');
const path = require('path');
// 同一份文件既能在工作区根目录跑，也能在仓库的 test/ 子目录跑
const SRCS = [
  path.join(__dirname, 'bilibili-aniskip.user.js'),
  path.join(__dirname, '..', 'bilibili-aniskip.user.js')
];
const SRC = fs.readFileSync(SRCS.find(function (p) { return fs.existsSync(p); }), 'utf8');

let pass = 0, fail = 0;
// -q / --quiet：只打失败与汇总（改代码时反复跑用，输出短）
const QUIET = process.argv.indexOf('-q') >= 0 || process.argv.indexOf('--quiet') >= 0;
/* 桩节点是带 _parent 的环状结构，直接 JSON.stringify 会炸；断言里又经常要比较
 * 「querySelector 拿到什么」，所以失败信息统一走这里，顺手把节点印成 <div class="x"> */
function brief(v) {
  if (v && typeof v === 'object' && v._tag) {
    return '<' + v._tag + (v._attrs && v._attrs.class ? ' class="' + v._attrs.class + '"' : '') + '>' +
      String(v.textContent || '').slice(0, 40);
  }
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function check(name, got, want) {
  const g = brief(got), w = brief(want);
  if (g === w) { pass++; if (!QUIET) console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      期望 ' + w + '\n      实际 ' + g); }
}
function checkTrue(name, cond, extra) {
  if (cond) { pass++; if (!QUIET) console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + brief(extra) : '')); }
}
function head(t) { if (!QUIET) console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 52 - t.length))); }

/* 新加的调试钩子做「缺了就报告失败」而不是抛异常 —— 这样把新测试拿去跑旧版本时，
 * 能看到完整的失败清单，而不是第一处就崩掉。 */
const hook = (env, name) => (env.api.api_ && env.api.api_[name]) || (env.api && env.api[name]) || null;
const cacheOf = (env) => { const c = hook(env, '_cache'); return c || {}; };
const cacheGetOf = (env, k, ttl) => { const f = hook(env, '_cacheGet'); return typeof f === 'function' ? f(k, ttl) : null; };
const flushOf = (env) => { const f = hook(env, '_flushCache'); if (typeof f === 'function') f(); };
const callHook = (env, name, ...args) => {
  const f = hook(env, name);
  return typeof f === 'function' ? f(...args) : null;
};

/* ---------------- 假数据 ---------------- */
const VIDEOS = {
  BV_TEST000001: {
    aid: 111, cid: 1001, bvid: 'BV_TEST000001',
    title: '【某某字幕组】葬送的芙莉莲 第01话 [简日字幕] 1080P',
    pubdate: 1699017600, videos: 1, duration: 1440,
    owner: { mid: 90001, name: '搬运君' },
    pages: [{ page: 1, part: '葬送的芙莉莲 第01话', duration: 1440, cid: 1001 }]
  },
  BV_MULTIPABC1: {
    aid: 222, cid: 2001, bvid: 'BV_MULTIPABC1',
    title: '【合集】NANA/娜娜【台配国语】',
    pubdate: 1500000000, videos: 5, duration: 7250,
    owner: { mid: 90002, name: '搬运合集君' },
    pages: [
      { page: 1, part: '01', duration: 1450, cid: 2001 },
      { page: 2, part: '02', duration: 1450, cid: 2002 },
      { page: 3, part: '03', duration: 1450, cid: 2003 },
      { page: 4, part: '04', duration: 1450, cid: 2004 },
      { page: 5, part: '05', duration: 1450, cid: 2005 }
    ]
  },
  BV_NOEPISOD1: {
    aid: 333, cid: 3001, bvid: 'BV_NOEPISOD1',
    title: '今天给大家做个糖醋排骨',
    pubdate: 1700000000, videos: 1, duration: 420,
    owner: { mid: 90003, name: '美食阿宅' },
    pages: [{ page: 1, part: '今天给大家做个糖醋排骨', duration: 420, cid: 3001 }]
  },
  BV_GARBAGE001: {
    aid: 444, cid: 4001, bvid: 'BV_GARBAGE001',
    title: 'ああああ 第03話',
    pubdate: 1700000000, videos: 1, duration: 1500,
    owner: { mid: 90004, name: '无名' },
    pages: [{ page: 1, part: 'ああああ', duration: 1500, cid: 4001 }]
  },
  BV_LONGPL001: {
    aid: 555, cid: 5001, bvid: 'BV_LONGPL001',
    title: '某动画 第01话',
    pubdate: 1700000000, videos: 1, duration: 3120,   // 52 分钟：正片 + 结尾塞别的片段
    owner: { mid: 90005, name: '尾巴君' },
    pages: [{ page: 1, part: '某动画 第01话', duration: 3120, cid: 5001 }]
  },
  // 真实数据（api.bilibili.com/x/web-interface/view，2026-10-15 抓取）
  BV1jfDYBSEKs: {
    aid: 116361653259359, cid: 37304795821, bvid: 'BV1jfDYBSEKs',
    title: '【4K超清】尖帽子的魔法工坊 1-13话全集',
    pubdate: 1775538873, videos: 13, duration: 23849,
    owner: { mid: 3493112693394137, name: '晓月の诗' },
    pages: [
      { page: 1, part: '01', duration: 1799, cid: 37304795821 },
      { page: 2, part: '02', duration: 2164, cid: 37325113978 },
      { page: 3, part: '03', duration: 1799, cid: 37481744795 },
      { page: 4, part: '04', duration: 1799, cid: 37677826503 },
      { page: 5, part: '05', duration: 1799, cid: 37887018454 },
      { page: 6, part: '06', duration: 1799, cid: 38091362022 },
      { page: 7, part: '07', duration: 1799, cid: 38266015006 },
      { page: 8, part: '08', duration: 1799, cid: 38432212345 },
      { page: 9, part: '09', duration: 1799, cid: 38610209764 },
      { page: 10, part: '10', duration: 1799, cid: 38780601174 },
      { page: 11, part: '11', duration: 1799, cid: 38965940068 },
      { page: 12, part: '12', duration: 1850, cid: 39144327028 },
      { page: 13, part: '13', duration: 1845, cid: 39324290005 }
    ],
    // UGC 合集名才是「4月新番」的来源
    season: { id: 7843931, title: '【4月新番】尖帽子的魔法工坊' }
  }
};

// BV_TEST000001 带下划线，不是合法的 BV 号（currentBvid 的正则抽不出来），
// 需要真正跑一遍 rerun / buildContext 的用例用这个合法别名
VIDEOS.BV1TEST00001 = Object.assign({}, VIDEOS.BV_TEST000001, { bvid: 'BV1TEST00001' });

const ANILIST_DB = {
  '葬送的芙莉莲': [{ id: 154587, idMal: 52991, episodes: 28, format: 'TV', startDate: { year: 2023 }, title: { native: '葬送のフリーレン', romaji: 'Sousou no Frieren' }, synonyms: [] }],
  'NANA': [{ id: 787, idMal: 1468, episodes: 47, format: 'TV', startDate: { year: 2006 }, title: { native: 'NANA', romaji: 'NANA' }, synonyms: [] }],
  '今天给大家做个糖醋排骨': [],
  'ああああ': [],
  // 真实条目：尖帽子的魔法工坊（AniList 搜索只认日文/罗马字，中文是 0 条 —— 所以要先过 Bangumi 桥）
  'とんがり帽子のアトリエ': [{ id: 147105, idMal: 51553, episodes: 13, format: 'ONA', startDate: { year: 2026 }, title: { native: 'とんがり帽子のアトリエ', romaji: 'Tongari Boushi no Atelier', english: 'Witch Hat Atelier' }, synonyms: [] }]
};

const ANISKIP_DB = {
  // 真实数据：尖帽子的魔法工坊 MAL 51553（api.aniskip.com，2026-10-15 抓取）
  // 第 1/5/10 话上游确实没有数据 —— 脚本应表现为「这一话不跳」，而不是崩或瞎猜
  // 另外注意每话 OP 起点从 2 秒到 383 秒都有 —— 固定秒数方案在这里必然错
  '51553/2': { found: true, results: [
    { interval: { startTime: 58, endTime: 147 }, skipType: 'op', episodeLength: 1420.076 },
    { interval: { startTime: 1325, endTime: 1415 }, skipType: 'ed', episodeLength: 1420 }
  ] },
  '51553/3': { found: true, results: [
    { interval: { startTime: 110.8, endTime: 198.7 }, skipType: 'op', episodeLength: 1420 }
  ] },
  '51553/5': { found: false, results: [] },
  '51553/9': { found: true, results: [
    { interval: { startTime: 383.487, endTime: 471.709 }, skipType: 'op', episodeLength: 1420 },
    { interval: { startTime: 1325.98, endTime: 1414.03 }, skipType: 'ed', episodeLength: 1420 }
  ] },
  '51553/13': { found: true, results: [
    { interval: { startTime: 2, endTime: 90 }, skipType: 'op', episodeLength: 1415 }
  ] },
  '52991/1': { found: true, results: [
    { interval: { startTime: 2.5, endTime: 92.5 }, skipType: 'op', episodeLength: 1440 },
    { interval: { startTime: 1300, endTime: 1390 }, skipType: 'ed', episodeLength: 1440 }
  ] },
  '52991/3': { found: true, results: [
    { interval: { startTime: 3, endTime: 93 }, skipType: 'op', episodeLength: 1440 }
  ] },
  '1468/3': { found: true, results: [
    { interval: { startTime: 60, endTime: 150 }, skipType: 'op', episodeLength: 1450 }
  ] },
  // 多季连播用例：第二季第 6 话（合集第 20 话）
  '64534/6': { found: true, results: [
    { interval: { startTime: 8, endTime: 98 }, skipType: 'op', episodeLength: 1440 }
  ] },
  // BV1kk7r6iEC4：第 2 季第 1 话（合集第 21 话）
  '54595/1': { found: true, results: [
    { interval: { startTime: 12, endTime: 102 }, skipType: 'op', episodeLength: 1798 }
  ] }
};

/* ---------------- Bangumi / AniList 关系桩数据（多季连播用例） ---------------- */
const BGM_DB = {
  '葬送的芙莉莲': [
    { id: 400602, name: '葬送のフリーレン', name_cn: '葬送的芙莉莲', date: '2023-09-29', eps: 28, platform: 'TV' }
  ],
  // 冰之城墙：引号内原文 / 去季标记 / 只有番名 —— 三种切片都要能命中（实测如此）
  '冰之城墙 正相反的正相反 第一季+第二季': [
    { id: 535669, name: '氷の城壁', name_cn: '冰之城墙', date: '2026-04-02', eps: 14, platform: 'TV' }
  ],
  '冰之城墙 正相反的正相反': [
    { id: 535669, name: '氷の城壁', name_cn: '冰之城墙', date: '2026-04-02', eps: 14, platform: 'TV' }
  ],
  '冰之城墙': [
    { id: 535669, name: '氷の城壁', name_cn: '冰之城墙', date: '2026-04-02', eps: 14, platform: 'TV' }
  ],
  // 简写：正确条目（140001）排在很后面，模仿真实返回顺序
  'Re:0': [
    { id: 169917, name: '機動戦士ガンダムユニコーン RE:0096', name_cn: '机动战士高达独角兽 RE:0096', date: '2016-04-03', eps: 22, platform: 'TV' },
    { id: 90001, name: '009 RE:CYBORG', name_cn: 'RE:人造人009', date: '2012-10-27', eps: 1, platform: '剧场版' },
    { id: 565361, name: 'Re0 IF线', name_cn: '', date: '2025-05-11', eps: 0, platform: 'WEB' },
    { id: 140002, name: 'Re:ゼロから始める異世界生活 2nd season', name_cn: 'Re：从零开始的异世界生活 第二季', date: '2020-07-08', eps: 13, platform: 'TV' },
    { id: 140001, name: 'Re:ゼロから始める異世界生活', name_cn: 'Re：从零开始的异世界生活', date: '2016-04-03', eps: 25, platform: 'TV' }
  ],
  'Re：从零开始的异世界生活': [
    { id: 140001, name: 'Re:ゼロから始める異世界生活', name_cn: 'Re：从零开始的异世界生活', date: '2016-04-03', eps: 25, platform: 'TV' }
  ],
  // 真实案例：两季 32 话（20+12）
  '想要成为影之实力者': [
    { id: 500001, name: '陰の実力者になりたくて！', name_cn: '想要成为影之实力者', date: '2022-10-05', eps: 20, platform: 'TV' }
  ]
};

const BGM_SUBJECT = {
  535669: { name: '氷の城壁', name_cn: '冰之城墙', infobox: [
    { key: '中文名', value: '冰之城墙' },
    { key: '别名', value: [{ v: 'Koori no Jouheki' }, { v: 'The Ramparts of Ice' }] },
    { key: '话数', value: '14' }
  ] },
  400602: { name: '葬送のフリーレン', name_cn: '葬送的芙莉莲', infobox: [
    { key: '别名', value: [{ v: 'Frieren: Beyond Journey\'s End' }, { v: 'Sousou no Frieren' }, { v: '葬送的芙莉蓮' }] }
  ] },
  140001: { name: 'Re:ゼロから始める異世界生活', name_cn: 'Re：从零开始的异世界生活', infobox: [
    { key: '别名', value: 'Re:Zero kara Hajimeru Isekai Seikatsu / rezero / Re0 / Re: Life a Different World from Zero' }
  ] }
};

const AL_MEDIA = {
  // 冰之城墙：S1 14 话，S2 话数未知（现实中新番就是 null）+ 一条干扰关系
  186497: {
    id: 186497, idMal: 60852, episodes: 14, title: { native: '氷の城壁', romaji: 'Koori no Jouheki' },
    startDate: { year: 2026 }, relations: { edges: [
      { relationType: 'CHARACTER', node: { id: 184951, idMal: 60371, episodes: 12, startDate: { year: 2026 }, title: { native: '正反対な君と僕', romaji: 'Seihantai na Kimi to Boku' } } },
      { relationType: 'SEQUEL', node: { id: 213805, idMal: 64534, episodes: null, startDate: { year: 2026 }, title: { native: '氷の城壁 第2期', romaji: 'Koori no Jouheki 2nd Season' } } }
    ] }
  },
  213805: {
    id: 213805, idMal: 64534, episodes: null, title: { native: '氷の城壁 第2期', romaji: 'Koori no Jouheki 2nd Season' },
    startDate: { year: 2026 }, relations: { edges: [
      { relationType: 'PREQUEL', node: { id: 186497, idMal: 60852, episodes: 14, startDate: { year: 2026 }, title: { native: '氷の城壁', romaji: 'Koori no Jouheki' } } }
    ] }
  },
  // 影之实力者：S1 20 话 → S2 12 话 → 剧场版 1 话（干扰项，不该被算进季链映射）
  130298: {
    id: 130298, idMal: 48316, episodes: 20, format: 'TV', title: { native: '陰の実力者になりたくて！', romaji: 'Kage no Jitsuryokusha ni Naritakute!' },
    startDate: { year: 2022 }, relations: { edges: [
      { relationType: 'SEQUEL', node: { id: 161964, idMal: 54595, episodes: 12, format: 'TV', startDate: { year: 2023 }, title: { native: '陰の実力者になりたくて！ 2nd season', romaji: 'Kage no Jitsuryokusha ni Naritakute! 2nd Season' } } }
    ] }
  },
  161964: {
    id: 161964, idMal: 54595, episodes: 12, format: 'TV', title: { native: '陰の実力者になりたくて！ 2nd season', romaji: 'Kage no Jitsuryokusha ni Naritakute! 2nd Season' },
    startDate: { year: 2023 }, relations: { edges: [
      { relationType: 'PREQUEL', node: { id: 130298, idMal: 48316, episodes: 20, format: 'TV', startDate: { year: 2022 }, title: { native: '陰の実力者になりたくて！', romaji: 'Kage no Jitsuryokusha ni Naritakute!' } } },
      { relationType: 'SEQUEL', node: { id: 171952, idMal: 57584, episodes: 1, format: 'MOVIE', startDate: { year: 2027 }, title: { native: '劇場版 陰の実力者になりたくて！ 残響編', romaji: 'Kage no Jitsuryokusha ni Naritakute! Movie' } } }
    ] }
  },
  171952: {
    id: 171952, idMal: 57584, episodes: 1, format: 'MOVIE', title: { native: '劇場版 陰の実力者になりたくて！ 残響編', romaji: 'Kage no Jitsuryokusha ni Naritakute! Movie' },
    startDate: { year: 2027 }, relations: { edges: [
      { relationType: 'PREQUEL', node: { id: 161964, idMal: 54595, episodes: 12, format: 'TV', startDate: { year: 2023 }, title: { native: '陰の実力者になりたくて！ 2nd season', romaji: 'x' } } }
    ] }
  }
};

// 注意：这里刻意不收中文键 —— 真实的 AniList 对中文标题就是搜不到，
// 「葬送的芙莉莲」直接搜是 0 条，这正是要加 Bangumi 桥的原因
const AL_BY_NAME = {
  'NANA': ANILIST_DB['NANA'],
  '葬送のフリーレン': ANILIST_DB['葬送的芙莉莲'],
  '氷の城壁': [{ id: 186497, idMal: 60852, episodes: 14, format: 'TV', startDate: { year: 2026 }, title: { native: '氷の城壁', romaji: 'Koori no Jouheki' }, synonyms: [] }],
  'Re:ゼロから始める異世界生活': [{ id: 21355, idMal: 31240, episodes: 25, format: 'TV', startDate: { year: 2016 }, title: { native: 'Re:ゼロから始める異世界生活', romaji: 'Re:Zero kara Hajimeru Isekai Seikatsu' }, synonyms: ['ReZero', 'Re: Life in a different world from zero'] }],
  '陰の実力者になりたくて！': [{ id: 130298, idMal: 48316, episodes: 20, format: 'TV', startDate: { year: 2022 }, title: { native: '陰の実力者になりたくて！', romaji: 'Kage no Jitsuryokusha ni Naritakute!' }, synonyms: [] }]
};

function makeNet(over) {
  const base = {
    'https://api.bilibili.com/x/web-interface/view': (req) => {
      const bv = /bvid=([^&]+)/.exec(req.url)[1];
      return { code: 0, data: VIDEOS[bv] || null };
    },
    'https://graphql.anilist.co': (req) => {
      const q = JSON.parse(req.data);
      return { data: { Page: { media: ANILIST_DB[q.variables.q] || [] } } };
    },
    'https://api.aniskip.com/v2/skip-times': (req) => {
      const m = /skip-times\/(\d+)\/(\d+)/.exec(req.url);
      return ANISKIP_DB[m[1] + '/' + m[2]] || { found: false, results: [] };
    },
    'https://api.aniskip.com/v2/relation-rules': { found: false, rules: [] },
    'https://api.anime-skip.com/graphql': () => ({ data: { findShowsByExternalId: [] } })
  };
  return Object.assign(base, over || {});
}

/* ---------------- 环境桩 ---------------- */
/* ---------------- 环境桩：可驱动的极简 DOM ----------------
 * 面板走的是「innerHTML 设内容 → querySelector 取节点 → addEventListener」这条路，
 * 老桩每次 querySelector 都返回一个全新的假节点，等于整个面板 UI 测不到 —— 这正是
 * 「测试全绿但面板真的会绑错季」的原因。这里实现脚本真正用到的那一小撮 DOM 语义：
 *   标签/属性/文本 → 树；.class / tag / [attr=v] / 后代选择器；事件注册与派发
 * 不做 Shadow DOM 的隔离（真实浏览器里从 light DOM 查不到影子内容，桩里不做这层），
 * 所有 createElement 出来的节点都记进 CREATED，测试按 class 就能找回来。 */
const CREATED = [];
const VOID_TAGS = { input: 1, br: 1, img: 1, hr: 1, meta: 1, link: 1 };
const HTML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' };
const unesc = (s) => String(s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g,
  (m, k) => (HTML_ENT[k] !== undefined ? HTML_ENT[k] : m));
/* 浏览器在「文本节点」上序列化 innerHTML 时只转义 & < >，引号保持原样 ——
 * escapeHtml() 走的正是 textContent→innerHTML，这里必须一致，否则
 * currentCid() 里 /"cid":(\d+)/ 这种正则会被 `&quot;` 打断。 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parseAttrs(raw) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(String(raw || '')))) {
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    out[m[1].toLowerCase()] = unesc(v);
  }
  return out;
}

function applyAttrs(n, attrs) {
  Object.keys(attrs).forEach((k) => {
    n._attrs[k] = attrs[k];
    if (k === 'class') n._attrs.class = attrs[k];
    else if (k === 'value') n._value = attrs[k];
    else if (k === 'checked') n._checked = true;
    else if (k === 'hidden') n._hidden = true;
    else if (k === 'disabled') n._disabled = true;
    else if (k === 'selected') n._selected = true;
    else if (k.indexOf('data-') === 0) {
      n.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attrs[k];
    }
  });
}

/* 只解析「标签 + 属性 + 纯文本」，够用就行 —— 没有注释、CDATA、自闭合脚本这些花活。
 * 文本也当作子节点存进 _children（_textNode 标记），这样 textContent 的**顺序**和
 * 浏览器一致（「将绑定：<b>名字</b>（11 集）」不会把括号里的字排到名字前面）。 */
function fillHtml(parent, html) {
  parent._children = [];
  parent._text = '';
  const s = String(html === undefined || html === null ? '' : html);
  const re = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  const addText = (t) => { const v = unesc(t); if (v) top().appendChild({ _textNode: true, _text: v, _children: [] }); };
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) addText(s.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[1].toLowerCase();
    if (m[0][1] === '/') {
      for (let i = stack.length - 1; i > 0; i--) { if (stack[i]._tag === tag) { stack.length = i; break; } }
      continue;
    }
    const node = el(tag);
    applyAttrs(node, parseAttrs(m[2]));
    top().appendChild(node);
    if (!VOID_TAGS[tag] && m[3] !== '/') stack.push(node);
  }
  if (last < s.length) addText(s.slice(last));
}

function selectorCompounds(sel) {
  const out = [];
  let cur = '', depth = 0;
  for (const ch of String(sel).trim()) {
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function matchesCompound(n, comp) {
  if (!n || !n._tag) return false;    // 文本伪节点不参与选择器匹配
  const re = /\[([^\]]+)\]|\.([A-Za-z0-9_-]+)|([A-Za-z][A-Za-z0-9-]*)/g;
  let m;
  const cls = String(n._attrs.class || '').split(/\s+/).filter(Boolean);
  while ((m = re.exec(comp))) {
    if (m[1]) {
      const eq = m[1].indexOf('=');
      const key = (eq < 0 ? m[1] : m[1].slice(0, eq)).trim().toLowerCase();
      const want = eq < 0 ? null : m[1].slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      let have;
      if (key.indexOf('data-') === 0) {
        have = n.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
      } else have = n._attrs[key];
      if (want === null) { if (have === undefined) return false; }
      else if (String(have === undefined ? '' : have) !== want) return false;
    } else if (m[2]) {
      if (cls.indexOf(m[2]) < 0) return false;
    } else if (m[3]) {
      if (n._tag !== m[3].toLowerCase()) return false;
    }
  }
  return true;
}

function el(tag) {
  const n = {
    tagName: String(tag || 'div').toUpperCase(),
    _tag: String(tag || 'div').toLowerCase(),
    _attrs: {}, _children: [], _listeners: {}, _parent: null,
    _text: '', _value: undefined, _checked: false, _hidden: false, _disabled: false,
    _removed: false, _selected: false,
    style: { cssText: '' }, dataset: {}, shadowRoot: null,
    get className() { return this._attrs.class || ''; },
    set className(v) { this._attrs.class = String(v); },
    get id() { return this._attrs.id || ''; },
    set id(v) { this._attrs.id = String(v); },
    get parentNode() { return this._parent; },
    /* 浏览器里没显式赋过值的 <select>，value 会反映当前选中项 —— 桩必须一致，
     * 否则 selScope.value 是空串，绑定会被存到一个不存在的 key 上 */
    get value() {
      if (this._value !== undefined) return this._value;
      if (this._tag === 'select') {
        const o = this.options[this.selectedIndex];
        return o ? o.value : '';
      }
      return '';
    },
    set value(v) { this._value = String(v); },
    get checked() { return !!this._checked; },
    set checked(v) { this._checked = !!v; },
    get hidden() { return !!this._hidden; },
    set hidden(v) { this._hidden = !!v; },
    get disabled() { return !!this._disabled; },
    set disabled(v) { this._disabled = !!v; },
    get children() { return this._children; },
    get options() { return this._tag === 'select' ? this._children.filter((c) => c._tag === 'option') : []; },
    get selectedIndex() {
      const os = this.options;
      const i = os.findIndex((o) => o._selected);
      return i >= 0 ? i : (os.length ? 0 : -1);
    },
    classList: {
      add(c) { const l = String(n._attrs.class || '').split(/\s+/).filter(Boolean); if (l.indexOf(c) < 0) l.push(c); n._attrs.class = l.join(' '); },
      remove(c) { n._attrs.class = String(n._attrs.class || '').split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains(c) { return String(n._attrs.class || '').split(/\s+/).indexOf(c) >= 0; },
      toggle(c, on) { const has = this.contains(c); if (on === undefined ? !has : on) this.add(c); else this.remove(c); }
    },
    appendChild(c) { c._parent = this; c._removed = false; this._children.push(c); return c; },
    removeChild(c) {
      const i = this._children.indexOf(c);
      if (i >= 0) { this._children.splice(i, 1); c._parent = null; }
      return c;
    },
    remove() {
      if (this._parent) this._parent.removeChild(this);
      this._removed = true;
    },
    setAttribute(k, v) { applyAttrs(this, { [String(k).toLowerCase()]: String(v) }); },
    getAttribute(k) { return this._attrs[String(k).toLowerCase()]; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) {
      const l = this._listeners[ev] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    /* 测试驱动用：把注册的监听真正叫起来（返回事件对象，方便断言 preventDefault 之类） */
    dispatch(ev, props) {
      const e = Object.assign({
        type: ev, target: this, currentTarget: this,
        preventDefault() { e.defaultPrevented = true; }, stopPropagation() { e.propagationStopped = true; },
        stopImmediatePropagation() { e.propagationStopped = true; e.immediateStopped = true; }
      }, props || {});
      (this._listeners[ev] || []).slice().forEach((fn) => fn.call(this, e));
      return e;
    },
    focus() {}, select() {}, blur() {}, click() { this.dispatch('click', {}); },
    contains: () => true,
    getBoundingClientRect: () => ({ width: 800, height: 450, left: 0, top: 0 }),
    attachShadow() { const r = el('shadowroot'); this.shadowRoot = r; r._host = this; return r; },
    querySelectorAll(sel) {
      const comps = selectorCompounds(sel);
      if (!comps.length) return [];
      const lastComp = comps[comps.length - 1];
      const out = [];
      /* 后代选择器：先按最后一个复合选择器收候选，再要求祖先链依次匹配前面的 */
      const collect = (node) => {
        node._children.forEach((c) => {
          if (matchesCompound(c, lastComp)) {
            let need = comps.length - 2, anc = c._parent;
            while (need >= 0 && anc) {
              if (matchesCompound(anc, comps[need])) need--;
              anc = anc._parent;
            }
            if (need < 0) out.push(c);
          }
          collect(c);
        });
      };
      collect(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    set innerHTML(v) { this._htmlRaw = String(v === undefined || v === null ? '' : v); fillHtml(this, this._htmlRaw); },
    get innerHTML() {
      if (!this._children.length) return esc(this._text);
      return this._children.map((c) => {
        if (c._textNode) return esc(c._text);
        const cls = c._attrs.class ? ' class="' + c._attrs.class + '"' : '';
        if (VOID_TAGS[c._tag]) return '<' + c._tag + cls + '>';
        return '<' + c._tag + cls + '>' + c.innerHTML + '</' + c._tag + '>';
      }).join('');
    },
    set textContent(v) { this._children = []; this._text = String(v === undefined || v === null ? '' : v); },
    get textContent() {
      return this._text + this._children.map((c) => (c._textNode ? c._text : c.textContent)).join('');
    }
  };
  CREATED.push(n);
  return n;
}

/* 按 class 找回节点（桩里 shadow 内容不隔离，所以直接全局找最近创建的那个） */
function byClass(cls, nth) {
  const hit = CREATED.filter((n) => String(n._attrs.class || '').split(/\s+/).indexOf(cls) >= 0);
  if (nth === undefined) return hit[hit.length - 1] || null;
  return hit[nth] || null;
}

/* 界面上「应该有」的节点：拿不到就给个空壳，让断言自己报失败。
 * 新用例拿去跑旧版本时，能看到完整失败清单而不是在第一处崩掉。 */
function orNode(n, tag) { return n || el(tag || 'div'); }

/* 面板入口：旧版本没有这两个调试钩子 → 报告失败并返回空壳面板 */
function openPanelVia(env, kind) {
  const fn = hook(env, kind === 'bind' ? '_openBindPanel' : '_openSettings');
  checkTrue('调试入口 _open' + (kind === 'bind' ? 'BindPanel' : 'Settings') + ' 能用', typeof fn === 'function');
  if (typeof fn !== 'function') return el('div');
  fn();
  return orNode(byClass('panel'));
}

function makeEnv(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store);
  const net = opts.net || makeNet();
  const timers = [];
  const intervals = [];                 // 记录注册过哪些轮询（查「重复注册」用）
  const cleared = [];                   // 记录清理掉了哪些句柄

  global.GM_getValue = (k, d) => (k in store ? store[k] : d);
  global.GM_setValue = (k, v) => { store[k] = v; };
  global.GM_deleteValue = (k) => { delete store[k]; };
  global.GM_registerMenuCommand = () => {};
  global.GM_xmlhttpRequest = (req) => {
    Promise.resolve().then(() => {
      // 注入网络故障：netFail(req) → 'timeout' | 'error' | { status, responseText }
      if (opts.netFail) {
        const err = opts.netFail(req);
        if (err === 'timeout') { if (req.ontimeout) req.ontimeout(); return; }
        if (err === 'error') { if (req.onerror) req.onerror({ status: 0 }); return; }
        if (err && err.status) { if (req.onload) req.onload({ status: err.status, responseText: err.responseText || '' }); return; }
      }
      const key = Object.keys(net).find((frag) => req.url.indexOf(frag) === 0);
      if (!key) { req.onerror && req.onerror({ status: 0 }); return; }
      const r = net[key];
      const body = typeof r === 'function' ? r(req) : r;
      req.onload && req.onload({ status: 200, responseText: typeof body === 'string' ? body : JSON.stringify(body) });
    });
  };

  CREATED.length = 0;                   // 每个 env 一套全新的 DOM 树，别串味

  const body = el('body');
  global.document = {
    readyState: 'complete',
    title: '', documentElement: el('html'),
    createElement: el, body, getElementById: () => null,
    // opts.video：给「真的跑一遍跳过/撤回」的用例准备的假播放器
    // opts.bars：给「进度条标记」用例准备的假进度条容器
    querySelectorAll: (sel) => {
      if (sel === 'video' && opts.video) return [opts.video];
      if (sel === '.bpx-player-progress-wrap') return opts.bars || [];
      return [];
    },
    querySelector: (sel) => body.querySelector(sel),
    addEventListener: () => {}, removeEventListener: () => {}
  };
  const win = {
    _listeners: {},
    innerWidth: opts.innerWidth || 1280, innerHeight: opts.innerHeight || 800,
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) {
      const l = this._listeners[ev] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatch(ev, props) {
      const e = Object.assign({
        type: ev, target: this,
        preventDefault() { e.defaultPrevented = true; }, stopPropagation() { e.propagationStopped = true; }
      }, props || {});
      (this._listeners[ev] || []).slice().forEach((fn) => fn.call(this, e));
      return e;
    }
  };
  global.window = win;
  global.unsafeWindow = {};
  global.location = opts.location || { pathname: '/video/BV_TEST000001', search: '?p=1' };
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  global.clearInterval = (id) => { cleared.push(id); };
  global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  global.alert = () => {};      // 浏览器全局；老版本某些兜底路径会调，桩一下免得崩溃
  global.confirm = () => true;
  global.prompt = () => null;

  eval(SRC);
  return { api: global.unsafeWindow.__biliAniskip, store, intervals, cleared, win, body, doc: global.document };
}

function ctxOf(bvid, page) {
  const v = VIDEOS[bvid];
  const p = v.pages[(page || 1) - 1];
  return {
    bvid: bvid, aid: v.aid, cid: p.cid, page: page || 1,
    owner: v.owner, mainTitle: v.title, partTitle: p.part,
    duration: p.duration, pubdate: v.pubdate, videos: v.videos,
    pages: v.pages, season: null, seasonId: null,
    seasonTitle: null, seasonEpisodeTitle: '', incomplete: false
  };
}

/* ================================================================== */
(async function main() {
  /* --- 1. 标题清洗 --- */
  head('1. 标题清洗');
  {
    const e = makeEnv();
    const { cleanTitle, animeNameCandidates } = e.api.api_;
    const t1 = cleanTitle('【某某字幕组】葬送的芙莉莲 第01话 [简日字幕] 1080P_哔哩哔哩_bilibili');
    checkTrue('去掉字幕组/分辨率/_哔哩哔哩后缀',
      !/字幕组|1080P|bilibili/i.test(t1), t1);
    const t2 = cleanTitle('[字幕组] xxx - 05 [BDRip x264 简繁]');
    checkTrue('去掉 BDRip/x264/简繁', !/BDRip|x264|简繁/.test(t2), t2);
    // 清洗不再作为用户开关暴露（2026-10-15 用户要求去掉），始终按规则清洗
    checkTrue('清洗开关已移除（设置里不再暴露）', !/titleClean/.test(SRC) || !/class="clean"/.test(SRC));

    const cands = animeNameCandidates({
      mainTitle: '【某某字幕组】葬送的芙莉莲 第01话 [简日] 1080P_哔哩哔哩_bilibili',
      partTitle: '', videos: 1, seasonEpisodeTitle: '', seasonTitle: ''
    });
    checkTrue('候选番名含「葬送的芙莉莲」', cands.indexOf('葬送的芙莉莲') >= 0, cands);
  }

  /* --- 2. 集号抽取 --- */
  head('2. 集号抽取');
  {
    const e = makeEnv();
    const { extractEpisode } = e.api.api_;
    const mk = (main, part, videos) => ({
      mainTitle: main, partTitle: part || '', videos: videos || 1,
      seasonEpisodeTitle: '', seasonTitle: '', cid: 1, bvid: 'BV_X', seasonId: null, page: 1
    });
    check('第01话', extractEpisode(mk('XXX 第01话')).num, 1);
    check('第 12 集（带空格）', extractEpisode(mk('XXX 第 12 集')).num, 12);
    check('EP07', extractEpisode(mk('XXX EP07 中字')).num, 7);
    check('ep.25', extractEpisode(mk('XXX ep.25')).num, 25);
    check('[07] 括号', extractEpisode(mk('XXX [07]')).num, 7);
    check('多分P part="03"', extractEpisode(mk('【合集】NANA', '03', 50)).num, 3);
    check('第03話（日文体）', extractEpisode(mk('ああああ 第03話')).num, 3);
    const noise = extractEpisode(mk('今天给大家做个糖醋排骨'));
    checkTrue('普通标题不产生高置信集号', noise === null || noise.score < 20, noise);
  }

  /* --- 3. 时长打分 --- */
  head('3. 时长打分（放宽至 20~40 分钟）');
  {
    const { durationScore } = makeEnv().api.api_;
    check('20 分钟（下界）', durationScore(20 * 60), 20);
    check('24 分钟（标准TV）', durationScore(24 * 60), 20);
    check('40 分钟（上界）', durationScore(40 * 60), 20);
    check('50 分钟（加长集/结尾挂别的视频）', durationScore(50 * 60), 10);
    check('52 分钟（防下架尾巴）', durationScore(52 * 60), 10);
    check('70 分钟', durationScore(70 * 60), 10);
    check('12 分钟（太短）', durationScore(12 * 60), 0);
    check('3 小时（太长）', durationScore(180 * 60), 0);
  }

  /* --- 4. 区间校验 --- */
  head('4. 区间校验');
  {
    const { validateSegs } = makeEnv().api.api_;
    const S = (t, s, en) => ({ type: t, start: s, end: en, source: 'x' });
    check('正常 OP 保留', validateSegs([S('op', 10, 100)], 1500).length, 1);
    check('太短 10s 丢弃', validateSegs([S('op', 10, 20)], 1500).length, 0);
    check('OP 太长 300s 丢弃', validateSegs([S('op', 10, 310)], 1500).length, 0);
    check('recap 段一律丢弃（回顾不再跳）', validateSegs([S('recap', 10, 280)], 1500).length, 0);
    check('end<=start 丢弃', validateSegs([S('op', 100, 50)], 1500).length, 0);
    check('起点超出视频时长丢弃', validateSegs([S('op', 1400, 1500)], 1000).length, 0);
    check('近似重复去重', validateSegs([S('op', 10, 100), S('op', 11, 101)], 1500).length, 1);
    check('OP+ED 都保留', validateSegs([S('op', 10, 100), S('ed', 1300, 1390)], 1500).length, 2);
    check('未知类型丢弃', validateSegs([S('preview', 10, 100)], 1500).length, 0);
  }

  /* --- 5. 双源合并 --- */
  head('5. 双源合并（AniSkip 优先）');
  {
    const S = (t, s, en, src) => ({ type: t, start: s, end: en, source: src });
    const net = makeNet({
      'https://api.anime-skip.com/graphql': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables.id === '154587') {
          return { data: { findShowsByExternalId: [{
            name: 'Sousou no Frieren',
            episodes: [{
              number: 1,
              timestamps: [
                { at: 3.0, type: { name: 'Intro' } },
                { at: 93.0, type: { name: 'Canon' } },
                { at: 1298, type: { name: 'Credits' } },
                { at: 1392, type: { name: 'Preview' } }
              ]
            }] }] } };
        }
        return { data: { findShowsByExternalId: [] } };
      }
    });
    // 关闭 AniSkip 数据，单独验证 Anime Skip 的分节转区间
    const netOnlyAS = makeNet({
      'https://api.aniskip.com/v2/skip-times': { found: false, results: [] },
      'https://api.anime-skip.com/graphql': (req) => ({ data: { findShowsByExternalId: [{
        name: 'x', episodes: [{
          number: 1, timestamps: [
            { at: 3.0, type: { name: 'Intro' } },
            { at: 93.0, type: { name: 'Canon' } },
            { at: 1298, type: { name: 'Credits' } },
            { at: 1392, type: { name: 'Preview' } }
          ]
        }] }] } })
    });
    const e = makeEnv({ store: { autoDetect: 'auto' }, net: netOnlyAS });
    const r = await e.api.identify({
      bvid: 'BV_TEST000001', cid: 1001, page: 1, videos: 1, duration: 1440,
      pubdate: 1699017600, owner: { mid: 90001 }, mainTitle: '葬送的芙莉莲 第01话',
      partTitle: '', seasonId: null, seasonEpisodeTitle: '', seasonTitle: ''
    });
    checkTrue('Anime Skip 可用时识别成功', r.ok, r);
    const op = (r.segments || []).find(s => s.type === 'op');
    const ed = (r.segments || []).find(s => s.type === 'ed');
    checkTrue('Intro→Canon 拼出 OP 区间 3–93', op && Math.round(op.end - op.start) === 90, op);
    checkTrue('Credits→Preview 拼出 ED 区间', ed && ed.start === 1298 && ed.end === 1392, ed);

    // 最后一条没有下家 → 必须丢弃，不造假区间
    const netTrail = makeNet({
      'https://api.aniskip.com/v2/skip-times': { found: false, results: [] },
      'https://api.anime-skip.com/graphql': () => ({ data: { findShowsByExternalId: [{
        name: 'x', episodes: [{ number: 1, timestamps: [{ at: 1298, type: { name: 'Credits' } }] }] }] } })
    });
    const e2 = makeEnv({ store: { autoDetect: 'auto' }, net: netTrail });
    const r2 = await e2.api.identify({
      bvid: 'BV_TEST000001', cid: 1001, page: 1, videos: 1, duration: 1440,
      pubdate: 1699017600, owner: { mid: 90001 }, mainTitle: '葬送的芙莉莲 第01话',
      partTitle: '', seasonId: null, seasonEpisodeTitle: '', seasonTitle: ''
    });
    const ed2 = (r2.segments || []).find(s => s.type === 'ed');
    checkTrue('孤立末尾标记被丢弃（不造假区间）', !ed2, r2.segments);

    // number: null 的整剧级记录不能被采纳（parseFloat(null)=NaN 陷阱）
    const netNull = makeNet({
      'https://api.aniskip.com/v2/skip-times': { found: false, results: [] },
      'https://api.anime-skip.com/graphql': () => ({ data: { findShowsByExternalId: [{
        name: 'x', episodes: [{ number: null, timestamps: [
          { at: 5, type: { name: 'Intro' } }, { at: 95, type: { name: 'Canon' } }
        ] }] }] } })
    });
    const e3 = makeEnv({ store: { autoDetect: 'auto' }, net: netNull });
    const r3 = await e3.api.identify({
      bvid: 'BV_TEST000001', cid: 1001, page: 1, videos: 1, duration: 1440,
      pubdate: 1699017600, owner: { mid: 90001 }, mainTitle: '葬送的芙莉莲 第01话',
      partTitle: '', seasonId: null, seasonEpisodeTitle: '', seasonTitle: ''
    });
    checkTrue('跳过 number:null 的整剧级记录', !(r3.segments || []).some(s => s.source === 'animeskip'), r3.segments);
  }

  /* --- 6. 多分P锚点推算 --- */
  head('6. 多分P锚点推算（绑一次全季复用）');
  {
    const { resolveEpisode } = makeEnv().api;
    const ctx = (p) => ({ page: p, videos: 50, bvid: 'BV_MULTIPABC1', cid: 2000 + p });
    const bind = { anchorPage: 3, anchorEp: 3, _scope: 'bvid', malId: 1468, anilistId: 787 };
    check('绑 P3=第3集 → 访问 P1 = 第1集', resolveEpisode(ctx(1), bind).num, 1);
    check('访问 P3 = 第3集', resolveEpisode(ctx(3), bind).num, 3);
    check('访问 P7 = 第7集', resolveEpisode(ctx(7), bind).num, 7);
    check('P1是预告 → P1 推算 <=0 时退回',
      resolveEpisode(ctx(1), { anchorPage: 5, anchorEp: 4, _scope: 'bvid' }).from, 'fallback');
    checkTrue('season 作用域不用 P 序号推算',
      resolveEpisode(ctx(9), { anchorPage: 1, anchorEp: 1, _scope: 'season' }, null).from === 'fallback');
    check('season 作用域退回标题抽取集号',
      resolveEpisode(ctx(9), { _scope: 'season' }, { num: 12, from: 'part' }).num, 12);
  }

  /* --- 7. 自动识别总开关 --- */
  head('7. 自动识别总开关（普通视频绝不触发）');
  {
    const ordinary = ctxOf('BV_NOEPISOD1', 1);
    const offEnv = makeEnv({ store: { autoDetect: 'off' } });
    const rOff = await offEnv.api.identify(ordinary);
    check('off 模式不识别', rOff.ok === false && rOff.reason === 'autodetect-off', true);

    const autoEnv = makeEnv({ store: { autoDetect: 'auto' } });
    const rAuto = await autoEnv.api.identify(ordinary);
    checkTrue('auto 模式下普通视频仍未命中（无番名）', rAuto.ok === false, rAuto.reason);

    // 标题确实像番剧且 search 有数据 -> 应命中
    const animeCtx = ctxOf('BV_TEST000001', 1);
    const rHit = await makeEnv({ store: { autoDetect: 'auto' } }).api.identify(animeCtx);
    checkTrue('auto 模式下番剧视频命中', rHit.ok, rHit.reason || rHit.confidence);
    check('识别到 MAL ID', rHit.malId, 52991);
    check('识别到 AniList ID', rHit.anilistId, 154587);
    check('命中 OP+ED 两段', rHit.segments.length, 2);
  }

  /* --- 8. 手动绑定优先 + off 模式仍然生效 --- */
  head('8. 手动绑定优先（标题乱码也能用）');
  {
    const binding = {
      'b:BV_GARBAGE001': { anilistId: 154587, malId: 52991, title: '葬送のフリーレン', episodes: 28, anchorPage: 1, anchorEp: 3, titleOffset: 0 }
    };
    const e = makeEnv({ store: { autoDetect: 'off', _bindings: JSON.stringify(binding) } });
    const r = await e.api.identify(ctxOf('BV_GARBAGE001', 1));
    checkTrue('off 模式下手动绑定仍然生效', r.ok && r.manual, r.reason);
    check('绑定时指定的集号被采用', r.episode, 3);
    checkTrue('拿到绑定番剧的 OP', (r.segments || []).some(s => s.type === 'op'), r.segments);
    check('置信度满分', r.confidence.score, 100);
  }

  /* --- 9. 黑名单 --- */
  head('9. 黑名单（刹车机制）');
  {
    const e = makeEnv({
      store: { autoDetect: 'auto', _blacklist: JSON.stringify({ 'b:BV_TEST000001': { t: Date.now() } }) }
    });
    const r = await e.api.identify(ctxOf('BV_TEST000001', 1));
    check('黑名单命中后被拒绝', r.ok === false && r.reason === 'blacklisted', true);
    checkTrue('黑名单键包含 bvid 粒度',
      e.api.blacklistKeys(ctxOf('BV_TEST000001', 1)).indexOf('b:BV_TEST000001') >= 0);
  }

  /* --- 10. 绑定作用域顺序（bvid 优先于 season） --- */
  head('10. 绑定作用域优先级');
  {
    const e = makeEnv();
    const ctx = { bvid: 'BV_A', cid: 999, page: 1, seasonId: 12345, videos: 10 };
    const keys = e.api.bindingKeys(ctx).map(k => k.scope);
    check('作用域按 season → bvid → cid 排列', keys[0], 'season');
    checkTrue('同时存在 bvid 粒度', keys.indexOf('bvid') >= 0);
    checkTrue('同时存在 cid 粒度', keys.indexOf('cid') >= 0);
  }

  /* --- 11. 长视频（结尾塞别的片段）不应被时长否决 --- */
  head('11. 52 分钟视频（结尾挂其他片段）仍参与识别');
  {
    const { durationScore } = makeEnv().api.api_;
    check('52 分钟拿到部分时长分', durationScore(3120), 10);
    const ctx = ctxOf('BV_LONGPL001', 1);
    ctx.mainTitle = '葬送的芙莉莲 第01话';
    const r = await makeEnv({ store: { autoDetect: 'auto' } }).api.identify(ctx);
    checkTrue('长视频未被时长否掉，仍拿到时间戳', r.ok && (r.segments || []).length === 2, r.reason || r.confidence);
  }

  /* --- 12. 跳转行为 --- */
  head('12. 跳转与防抖');
  {
    function makeVideo(t, dur, paused) {
      const v = {
        tagName: 'VIDEO', paused: !!paused, ended: false, readyState: 4,
        duration: dur, _ct: t, dataset: {},
        getBoundingClientRect: () => ({ width: 800, height: 450 }),
        addEventListener() {}, play() {}
      };
      Object.defineProperty(v, 'currentTime', {
        get() { return this._ct; }, set(x) { this._ct = x; }
      });
      return v;
    }

    const e = makeEnv({ store: { autoDetect: 'auto' } });
    const rt = e.api._runtime;
    const seg = { type: 'op', start: 2.5, end: 92.5, source: 'aniskip' };

    // 12.1 落在 OP 区间内 → 跳到终点之后（+0.06 epsilon）
    let v1 = makeVideo(50, 1440, false);
    document.querySelectorAll = (sel) => (sel === 'video' ? [v1] : []);
    rt.result = { ok: true, manual: true, title: 'x', episode: 1, segments: [seg] };
    rt.video = v1; rt.skipped = {}; rt.skipping = false; rt.lastSkipAt = 0;
    e.api._checkOnce();
    checkTrue('落在 OP 内 → 跳到 92.56（end+0.06）', Math.abs(v1.currentTime - 92.56) < 0.001, v1.currentTime);

    // 12.2 同一段不会被重复跳（用户手动拖回来也不再跳）
    v1._ct = 50;
    e.api._checkOnce();
    checkTrue('同一段不重复跳（手动拖回也不再跳）', v1.currentTime === 50, v1.currentTime);

    // 12.3 区间外不动
    let v2 = makeVideo(400, 1440, false);
    document.querySelectorAll = (sel) => (sel === 'video' ? [v2] : []);
    rt.video = v2; rt.skipped = {}; rt.lastSkipAt = 0; rt.result = { ok: true, segments: [seg] };
    e.api._checkOnce();
    check('区间外不跳', v2.currentTime, 400);

    // 12.4 暂停时不跳（避免用户暂停看OP时被强制跳走）
    let v3 = makeVideo(50, 1440, true);
    document.querySelectorAll = (sel) => (sel === 'video' ? [v3] : []);
    rt.video = v3; rt.skipped = {}; rt.lastSkipAt = 0;
    e.api._checkOnce();
    check('暂停时不跳', v3.currentTime, 50);

    // 12.5 关闭 OP 开关后不跳
    const eNoOp = makeEnv({ store: { autoDetect: 'auto', jumpOp: false } });
    const rt2 = eNoOp.api._runtime;
    let v4 = makeVideo(50, 1440, false);
    document.querySelectorAll = (sel) => (sel === 'video' ? [v4] : []);
    rt2.video = v4; rt2.skipped = {}; rt2.lastSkipAt = 0;
    rt2.result = { ok: true, segments: [seg] };
    eNoOp.api._checkOnce();
    check('关闭 OP 开关后不跳', v4.currentTime, 50);

    // 12.6 多种策略video.duration 未知（直播/未加载）时不跳
    let v5 = makeVideo(50, NaN, false);
    document.querySelectorAll = (sel) => (sel === 'video' ? [v5] : []);
    rt.video = v5; rt.skipped = {}; rt.lastSkipAt = 0;
    e.api._checkOnce();
    check('时长未知时不跳', v5.currentTime, 50);
  }

  /* --- 13. 防认错季（用户名义用例） --- */
  head('13. 防认错季 / 防越界集号');
  {
    const e = makeEnv({ store: { autoDetect: 'auto' } });
    // 「我推的孩子」在 AniList 里排第一的是 2nd Season（13 集）。
    // 标题写第 99 集 → 明显越界，必须扣分不敢采纳
    const r = await e.api.identify({
      bvid: 'BV_X', cid: 1, page: 1, videos: 1, duration: 1440, pubdate: 1700000000,
      owner: { mid: 1 }, mainTitle: '我推的孩子 第99集', partTitle: '',
      seasonId: null, seasonEpisodeTitle: '', seasonTitle: ''
    });
    checkTrue('越界集号被拒绝（不敢采信）', r.ok === false, r.reason || r.confidence);
  }

  /* --- 14. UI 层级回归（曾因遮罩压住面板导致"灰色点不到"） --- */
  head('14. UI 层级回归');
  {
    const panelZ = /'z-index:(\d+);background:#fff/.exec(SRC);
    const maskZ = /background:rgba\(0,0,0,\.4\);pointer-events:auto;z-index:(\d+)/.exec(SRC);
    checkTrue('面板 z-index 高于遮罩',
      panelZ && maskZ && (+panelZ[1] > +maskZ[1]),
      { panelZ: panelZ && panelZ[1], maskZ: maskZ && maskZ[1] });
    checkTrue('遮罩点击即关闭', /mask\.addEventListener\('click', close\)/.test(SRC));
    checkTrue('支持 Esc 关闭面板', /e\.key === 'Escape'/.test(SRC));
    checkTrue('面板关键样式用内联（防 CSP 拦 CSS 注入）', /panel\.style\.cssText/.test(SRC));
  }

  /* --- 15. 标题解析：引号优先 + 渐进截断（用户给的真实标题） --- */
  head('15. 标题解析（引号优先）');
  {
    const e = makeEnv();
    const { animeNameCandidates, quotedSegments, progressivePrefixes, stripSeasonMarks } = e.api.api_;
    const TITLE = '【4K超高清】「冰之城墙 正相反的正相反 第一季+第二季」全26话 未删减版 周更';
    const ctx = { mainTitle: TITLE, partTitle: '', videos: 1, seasonEpisodeTitle: '', seasonTitle: '' };

    const q = quotedSegments(TITLE);
    check('强引号内容被提取', q.length && q[0].text, '冰之城墙 正相反的正相反 第一季+第二季');
    check('【4K超高清】这类弱引号噪声被过滤', q.filter(x => x.tier === 'weak').length, 0);
    check('渐进截断', progressivePrefixes('冰之城墙 正相反的正相反', 3), ['冰之城墙 正相反的正相反', '冰之城墙']);
    check('季标记被剪掉', stripSeasonMarks('冰之城墙 正相反的正相反 第一季+第二季'), '冰之城墙 正相反的正相反');

    const cands = animeNameCandidates(ctx);
    check('首要候选就是引号内容', cands[0], '冰之城墙 正相反的正相反');
    checkTrue('能退化到「冰之城墙」', cands.indexOf('冰之城墙') >= 0, cands);
    checkTrue('没有把整条噪声标题当候选', cands.indexOf('4K超高清') < 0 && cands.indexOf('未删减版 周更') < 0, cands);
    checkTrue('「全26话」不残留在候选里', cands.every(c => !/全\s*26/.test(c)), cands);

    // 引号外还有【】噪声、且番名在【】里时仍要能取到
    const c2 = animeNameCandidates({
      mainTitle: '【合集】NANA/娜娜【台配国语】', partTitle: '', videos: 1,
      seasonEpisodeTitle: '', seasonTitle: ''
    });
    checkTrue('【合集】NANA 能取到 NANA', c2.some(x => /NANA/.test(x)), c2);
  }

  /* --- 16. 中文桥（Bangumi） --- */
  head('16. 中文名 → 日文原名 → AniList');
  {
    const net = makeNet({
      'https://api.bgm.tv/v0/search/subjects': (req) => {
        const kw = JSON.parse(req.data).keyword;
        return { data: BGM_DB[kw] || [] };
      },
      'https://graphql.anilist.co': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables && q.variables.id !== undefined) return { data: { Media: AL_MEDIA[q.variables.id] || null } };
        return { data: { Page: { media: AL_BY_NAME[q.variables.q] || [] } } };
      }
    });
    const e = makeEnv({ net });
    const { bgmResolve, searchByName, hasHan, normKey } = e.api.api_;

    check('hasHan 识别中文', [hasHan('葬送的芙莉莲'), hasHan('Frieren'), hasHan('Re:0')], [true, false, false]);
    check('normKey 抹平标点', normKey('Re:0'), normKey('Re0'));

    const hit = await bgmResolve('葬送的芙莉莲');
    check('Bangumi 命中', hit && hit.entry.id, 400602);
    check('Bangumi 给出日文原名', hit && hit.entry.name, '葬送のフリーレン');

    const list = await searchByName('葬送的芙莉莲');
    checkTrue('面板搜索经中文桥拿到 AniList 条目', list.some(m => m.id === 154587), list.map(m => m.id));
    checkTrue('候选里带上中文名', list.some(m => m.cn === '葬送的芙莉莲'), list.map(m => m.cn));

    // AniList 直搜中文是 0 条（这就是要加桥的原因），桥补上了
    check('AniList 直搜中文为 0（异常但真实）', AL_BY_NAME['葬送的芙莉莲'] || [], []);
  }

  /* --- 17. 简写与别名重排 --- */
  head('17. 简写（Re:0）与别名重排');
  {
    const e = makeEnv({ net: makeNet({
      'https://api.bgm.tv/v0/search/subjects': (req) => ({ data: BGM_DB[JSON.parse(req.data).keyword] || [] }),
      'https://api.bgm.tv/v0/subjects/': (req) => {
        const id = /subjects\/(\d+)/.exec(req.url)[1];
        return BGM_SUBJECT[id] || {};
      }
    }) });
    const { bgmResolve, aliasExpansions } = e.api.api_;

    // Re:0 直接搜出来第一条是高达，正确的 Re:Zero 在更后面 —— 靠别名重排纠正
    const hit = await bgmResolve('Re:0');
    check('简写经别名重排落到正确的番', hit && hit.entry.id, 140001);
    check('归一化后整串相等得满分', hit && hit.score, 1);

    // 内置简写表只用来扩展查询
    check('Re:0 有内置扩展', aliasExpansions('Re:0'), ['Re：从零开始的异世界生活']);
    check('无扩展时返回空', aliasExpansions('葬送的芙莉莲'), []);
  }

  /* --- 18. 多季连播：季链推导与定位 --- */
  head('18. 多季连播合集');
  {
    const net = () => makeNet({
      'https://api.bgm.tv/v0/search/subjects': (req) => ({ data: BGM_DB[JSON.parse(req.data).keyword] || [] }),
      'https://graphql.anilist.co': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables && q.variables.id !== undefined) return { data: { Media: AL_MEDIA[q.variables.id] || null } };
        return { data: { Page: { media: AL_BY_NAME[q.variables.q] || [] } } };
      },
      'https://api.aniskip.com/v2/skip-times': (req) => {
        const m = /skip-times\/(\d+)\/(\d+)/.exec(req.url);
        return ANISKIP_DB[m[1] + '/' + m[2]] || { found: false, results: [] };
      }
    });

    const e = makeEnv({ net: net() });
    const { detectMultiSeason, buildSeasonChain, mapBySeasonChain } = e.api.api_;
    const TITLE = '【4K超高清】「冰之城墙 正相反的正相反 第一季+第二季」全26话 未删减版 周更';

    const ms = detectMultiSeason({ mainTitle: TITLE, partTitle: '', seasonTitle: '', seasonEpisodeTitle: '' });
    check('识别为多季连播', ms.multi, true);
    check('从「全26话」取到总话数', ms.totalEps, 26);
    check('单季标题不误判', detectMultiSeason({ mainTitle: '葬送的芙莉莲 第01话', partTitle: '', seasonTitle: '', seasonEpisodeTitle: '' }).multi, false);

    // S1 14 话，S2 话数未知 → 用「全26话」反推 12
    const chain = await buildSeasonChain(186497, 26);
    check('季链季数', chain.seasons.length, 2);
    check('第一季话数', chain.seasons[0].episodes, 14);
    check('第二季话数由总话数反推', chain.seasons[1].episodes, 12);
    check('第一季区间', [chain.seasons[0].startAbs, chain.seasons[0].endAbs], [1, 14]);
    check('第二季区间', [chain.seasons[1].startAbs, chain.seasons[1].endAbs], [15, 26]);
    check('合计与标题一致，不标记 mismatch', [chain.total, chain.mismatch], [26, false]);

    check('第 20 话 → 第 2 季第 6 话',
      (h => [h.season, h.ep, h.malId])(mapBySeasonChain(chain, 20)), [2, 6, 64534]);
    check('第 3 话 → 第 1 季第 3 话',
      (h => [h.season, h.ep])(mapBySeasonChain(chain, 3)), [1, 3]);
    check('超范围返回 null', mapBySeasonChain(chain, 99), null);

    // 端到端：多季合集的第 20 个 P 要落到第二季第 6 话，并取到第二季的时间戳
    const e2 = makeEnv({ net: net(), store: { autoDetect: 'auto' } });
    const ctx = {
      bvid: 'BV_MULTISEAS', aid: 999, cid: 2099, page: 20,
      owner: { mid: 1 }, mainTitle: TITLE, partTitle: '第20话', duration: 1440,
      pubdate: 1770000000, videos: 26, pages: [], season: null, seasonId: null,
      seasonTitle: null, seasonEpisodeTitle: '', incomplete: false
    };
    const r = await e2.api.identify(ctx);
    checkTrue('识别成功', r.ok, r.reason);
    check('已换算到第二季', r.season && r.season.season, 2);
    check('季内集号', r.episode, 6);
    check('拿到第二季第 6 话的时间戳', (r.segments || []).length, 1);
  }

  /* --- 19. 键盘冲突回归（Shadow DOM 重定向 + B 站快捷键） --- */
  head('19. 键盘冲突回归');
  {
    checkTrue('输入控件经 <slot> 放 light DOM', /function mkSlot\(/.test(SRC) && /host\.appendChild\(node\)/.test(SRC));
    checkTrue('面板内 keydown 冒泡阶段截断', /panel\.addEventListener\('keydown', function \(e\) \{ e\.stopPropagation\(\); \}\)/.test(SRC));
    checkTrue('按钮/复选框不抢焦点', /function noFocus\(/.test(SRC) && /tabindex/.test(SRC) && /mousedown/.test(SRC));
    checkTrue('输入控件样式走 ::slotted（它们在影子树外）', /::slotted\(input\[type=text\]\)/.test(SRC));
    checkTrue('不再有 <input> 直接写在面板 innerHTML 里', !/innerHTML[\s\S]{0,80}<input type="text"/.test(SRC));
  }

  /* --- 20. 用户实测案例 BV1kk7r6iEC4：两季32话装在 32 个分P 里 --- */
  head('20. 真实案例：两季 32 话（分P标题带【S2】标记）');
  {
    // 分P结构照抄真实数据：P1–P20 part='01'…'20'，P21 part='【S2】01' …
    const pages = [];
    for (let i = 1; i <= 20; i++) pages.push({ page: i, part: String(i).padStart(2, '0'), duration: 1798, cid: 1000 + i });
    for (let i = 21; i <= 32; i++) pages.push({ page: i, part: '【S2】' + String(i - 20).padStart(2, '0'), duration: 1798, cid: 1000 + i });

    const TITLE = '【4K超清】想要成为影之实力者 两季32话全集';
    const mkCtx = (page) => ({
      bvid: 'BV1kk7r6iEC4', aid: 999, cid: 1000 + page, page: page,
      owner: { mid: 1, name: '晓月の诗' }, mainTitle: TITLE,
      partTitle: pages[page - 1].part, duration: 1798, pubdate: 1780632043,
      videos: 32, pages: pages, season: null, seasonId: null,
      seasonTitle: null, seasonEpisodeTitle: '', incomplete: false
    });

    const net = () => makeNet({
      'https://api.bgm.tv/v0/search/subjects': (req) => {
        const kw = JSON.parse(req.data).keyword;
        const hit = Object.keys(BGM_DB).find(k => kw.indexOf(k) >= 0 || k.indexOf(kw) >= 0);
        return { data: hit ? BGM_DB[hit] : [] };
      },
      'https://graphql.anilist.co': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables && q.variables.id !== undefined) return { data: { Media: AL_MEDIA[q.variables.id] || null } };
        return { data: { Page: { media: AL_BY_NAME[q.variables.q] || [] } } };
      },
      'https://api.aniskip.com/v2/skip-times': (req) => {
        const m = /skip-times\/(\d+)\/(\d+)/.exec(req.url);
        return ANISKIP_DB[m[1] + '/' + m[2]] || { found: false, results: [] };
      }
    });

    const e = makeEnv({ net: net() });
    const { detectMultiSeason, seasonGroupsFromParts, partSeasonOf, partEpisodeOf, absEpisodeFromPart, episodeGuess, buildSeasonChain, mapBySeasonChain } = e.api.api_;

    check('分P标题【S2】01 识别为第 2 季', partSeasonOf('【S2】01'), 2);
    check('分P标题【S2】01 的季内话数是 1', partEpisodeOf('【S2】01'), 1);

    const g = seasonGroupsFromParts(mkCtx(21));
    check('季分组数量', g.length, 2);
    check('第 1 季 = P1–P20（20 话）', [g[0].season, g[0].startPage, g[0].endPage, g[0].episodes], [1, 1, 20, 20]);
    check('第 2 季 = P21–P32（12 话）', [g[1].season, g[1].startPage, g[1].endPage, g[1].episodes], [2, 21, 32, 12]);

    const ms = detectMultiSeason(mkCtx(21));
    check('标题「两季32话全集」被判为多季', ms.multi, true);
    check('从「32话全集」取到总话数（全在数字后面也要认）', ms.totalEps, 32);
    // 剪完必须干净：不能留下孤零零的「集」或「话」
    // 注意：这里只能用已有的 e —— 每次 makeEnv() 都会重新执行脚本并换掉全局 GM 网络桩，
    // 在用例中途新建环境会让先前那个环境的网络请求全部失效
    check('季/话数标记被剪干净', e.api.api_.stripSeasonMarks('想要成为影之实力者 两季32话全集'), '想要成为影之实力者');
    check('候选首选就是干净的番名', e.api.api_.animeNameCandidates(mkCtx(21))[0], '想要成为影之实力者');

    check('P21 → 合集内第 21 话（不是季内的 1）',
      (a => [a.absEp, a.season, a.within])(absEpisodeFromPart(mkCtx(21))), [21, 2, 1]);
    check('P5 → 第 5 话', absEpisodeFromPart(mkCtx(5)).absEp, 5);
    check('episodeGuess 走分P季标记这条路', episodeGuess(mkCtx(21)).from, 'partSeason');
    check('episodeGuess 给出 21', episodeGuess(mkCtx(21)).num, 21);

    const chain = await buildSeasonChain(130298, 32, mkCtx(21));
    check('季链来源是分P标题', chain.source, 'parts');
    check('季链话数（以实际分P为准）', chain.seasons.map(s => s.episodes), [20, 12]);
    check('季链 MAL ID 从续季关系补齐', chain.seasons.map(s => s.malId), [48316, 54595]);
    check('季链区间', chain.seasons.map(s => [s.startAbs, s.endAbs]), [[1, 20], [21, 32]]);
    check('第 21 话落在第 2 季第 1 话',
      (h => [h.season, h.ep, h.malId])(mapBySeasonChain(chain, 21)), [2, 1, 54595]);

    // 端到端：在 P21 上自动识别，应取第 2 季第 1 话的时间戳
    const e2 = makeEnv({ net: net(), store: { autoDetect: 'auto' } });
    const r = await e2.api.identify(mkCtx(21));
    checkTrue('自动识别成功', r.ok, r.reason || r.confidence);
    check('换算到第 2 季', r.season && r.season.season, 2);
    check('季内集号 1', r.episode, 1);
    check('取到时间戳', (r.segments || []).length, 1);

    // 反例：单季合集（无季标记）不该被判成多季
    const single = await e2.api.identify({
      ...mkCtx(5), bvid: 'BV_SINGLE', mainTitle: '葬送的芙莉莲 第05话',
      partTitle: '05', videos: 5, pages: pages.slice(0, 5)
    });
    checkTrue('单季合集未触发季链', !single.season, single.season);

    /* 兜底触发：标题与分P都没有季线索，但「P序号 > 单季话数」时也要认出跨季 */
    head('20b. 无标题线索时靠「P序号超出单季话数」触发');
    {
      const flatPages = [];
      for (let i = 1; i <= 32; i++) flatPages.push({ page: i, part: String(i).padStart(2, '0'), duration: 1798, cid: 2000 + i });
      const e3 = makeEnv({ net: net(), store: { autoDetect: 'auto' } });
      const ctx = {
        bvid: 'BV_FLAT32', aid: 888, cid: 2021, page: 21,
        owner: { mid: 1 }, mainTitle: '想要成为影之实力者 第21集',
        partTitle: '21', duration: 1798, pubdate: 1780632043,
        videos: 32, pages: flatPages, season: null, seasonId: null,
        seasonTitle: null, seasonEpisodeTitle: '', incomplete: false
      };
      const ms3 = e3.api.api_.detectMultiSeason(ctx);
      check('分P无季标记时不误判为多季', ms3.multi, false);
      const r3 = await e3.api.identify(ctx);
      checkTrue('但第 21 个 P 仍被算出属于第 2 季', r3.ok && r3.season && r3.season.season === 2, r3.reason || (r3.season && r3.season.season));
      check('并拿到第 2 季第 1 话的时间戳', (r3.segments || []).length, 1);
    }
  }

  /* --- 21. 面板表述回归（用户要求：删掉 P1 偏移、说清集号） --- */
  head('21. 面板表述');
  {
    checkTrue('「P1 是预告」已删除', !/P1 是预告/.test(SRC) && !/class="off"/.test(SRC));
    checkTrue('集号标注为「当前是第几话」', /当前是第几话/.test(SRC));
    checkTrue('集号有实时换算提示', /function updateEpMap/.test(SRC) && /合集第 ' \+ val \+ ' 话 → 第/.test(SRC));
    checkTrue('作用域改叫「生效范围」', /生效范围/.test(SRC));
    checkTrue('清洗开关已从设置面板移除', !/清洗标题噪声/.test(SRC));
  }

  /* --- 22. 真实案例：无职转生 第1-3季（63 P）标题清洗 + 分段对齐 + mixed-op --- */
  head('22. 真实案例：无职转生 第1-3季（BV1KspF6iELH）');
  {
    const TITLE_LZ = '【无职转生 第1-3季】4K超清未删减完整版（更至第三季14）';
    // 63 个分P：第一季 24（含 OVA）／第二季 25（含第00话）／第三季 14
    const pagesLZ = [];
    for (let i = 1; i <= 23; i++) pagesLZ.push({ page: i, part: '第一季' + String(i).padStart(2, '0'), duration: 1950, cid: 4000 + i });
    pagesLZ.push({ page: 24, part: '第一季OVA', duration: 1945, cid: 4024 });
    for (let i = 0; i <= 24; i++) pagesLZ.push({ page: 25 + i, part: '第二季' + String(i).padStart(2, '0'), duration: 1950, cid: 4100 + i });
    for (let i = 1; i <= 14; i++) pagesLZ.push({ page: 49 + i, part: '第三季' + String(i).padStart(2, '0'), duration: 1948, cid: 4200 + i });

    const lzCtx = (page) => ({
      bvid: 'BV1KspF6iELH', aid: 777, cid: 4000 + page, page: page,
      owner: { mid: 2, name: '后宫补番' }, mainTitle: TITLE_LZ,
      partTitle: pagesLZ[page - 1].part, duration: pagesLZ[page - 1].duration,
      pubdate: 1791598437, videos: 63, pages: pagesLZ, season: null, seasonId: null,
      seasonTitle: null, seasonEpisodeTitle: '', incomplete: false
    });

    /* ① 标题清洗：原来整条标题清完只剩碎片「（更至 14）」，却排在真正番名前面 */
    const e0 = makeEnv();
    const P0 = e0.api.api_;
    check('整条标题不再残留「更至第三季14」', P0.cleanTitle(TITLE_LZ), '【无职转生 第1-3季】 未删减完整版');
    check('候选首选是干净番名（不再是「（更至 14）」）', P0.animeNameCandidates(lzCtx(21))[0], '无职转生');
    check('候选里没有「更至」碎片', P0.animeNameCandidates(lzCtx(21)).filter(x => /更至|更新至/.test(x)), []);
    check('「第1-3季」区间标记被剪干净', P0.stripSeasonMarks('无职转生 第1-3季'), '无职转生');
    check('「第三季14」也被剪掉', P0.stripSeasonMarks('想要成为影之实力者 第三季14'), '想要成为影之实力者');

    /* ② 集号：分P标题「第一季21」原来会被「P序号兜底」覆盖成 1 */
    check('「第一季21」抽到 21', P0.extractEpisode(lzCtx(21)).num, 21);
    check('「第一季12」抽到 12', P0.extractEpisode(lzCtx(12)).num, 12);
    check('「第二季01」抽到 1', P0.extractEpisode(lzCtx(26)).num, 1);

    /* ③ 分段检测：B站自己分的三段 */
    const g3 = P0.seasonGroupsFromParts(lzCtx(1));
    check('三段：24 / 25 / 14',
      g3.map(x => [x.season, x.startPage, x.endPage, x.episodes]), [[1, 1, 24, 24], [2, 25, 49, 25], [3, 50, 63, 14]]);
    check('P21 的合集内话号 = 21', (a => [a.absEp, a.season, a.within])(P0.absEpisodeFromPart(lzCtx(21))), [21, 1, 21]);

    /* ④ 分段 ↔ 数据库条目对齐：一段可能 = 多个条目 */
    const S = (id, mal, eps, title, year) => ({ anilistId: id, malId: mal, episodes: eps, title, year, format: 'TV', startWithin: 0 });
    const FAMILY = [
      S(108465, 39535, 11, '無職転生 ～異世界行ったら本気だす～', 2021),
      S(127720, 45576, 12, '無職転生 ～異世界行ったら本気だす～ 第2クール', 2021),
      S(146065, 51179, 13, '無職転生Ⅱ ～異世界行ったら本気だす～', 2023),
      S(166873, 55888, 12, '無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール', 2024),
      S(178789, 59193, 14, '無職転生Ⅲ ～異世界行ったら本気だす～', 2026)
    ];
    const al = P0.alignGroupsToSeasons(g3, FAMILY.map(x => Object.assign({}, x)));
    check('第1段 = Ⅰ + 第2クール', al[0].entries.map(x => x.malId), [39535, 45576]);
    check('第2段 = Ⅱ + Ⅱ第2クール', al[1].entries.map(x => x.malId), [51179, 55888]);
    check('第3段 = Ⅲ', al[2].entries.map(x => x.malId), [59193]);
    check('三段全部对齐', al.every(x => x.ok), true);
    check('OVA 造成的 1 话差异被记下来', al[0].diff, -1);

    const alShort = P0.alignGroupsToSeasons(g3, FAMILY.slice(0, 4).map(x => Object.assign({}, x)));
    check('家族序列缺第三季时，前两段仍对齐', alShort.slice(0, 2).every(x => x.ok), true);
    check('缺条目那段标记为未对齐（宁可不跳）', alShort[2].ok, false);

    /* ⑤ 分段链 → 每个 P 定位到哪个条目哪一话 */
    const chainLZ = {
      seasons: al.map(x => ({
        season: x.season, startPage: x.startPage, endPage: x.endPage,
        episodes: x.total, entries: x.entries, entriesSum: x.sum, diff: x.diff, aligned: true,
        title: x.entries.map(e => e.title).join(' + '), startAbs: 0, endAbs: 0
      })),
      total: 63, source: 'parts', mismatch: false, partial: false
    };
    let accLZ = 0;
    chainLZ.seasons.forEach(s => { s.startAbs = accLZ + 1; s.endAbs = accLZ + s.episodes; accLZ += s.episodes; });

    const hitOf = (page) => {
      const a = P0.absEpisodeFromPart(lzCtx(page));
      const h = a ? P0.mapBySeasonChain(chainLZ, a.absEp) : null;
      return h ? [h.malId, h.ep] : null;
    };
    check('P1（第一季01）→ Ⅰ 第1话', hitOf(1), [39535, 1]);
    check('P12（第一季12）→ 第2クール 第1话', hitOf(12), [45576, 1]);
    check('P23（第一季23）→ 第2クール 第12话', hitOf(23), [45576, 12]);
    check('P24（第一季OVA）→ 超出条目，不跳', hitOf(24), null);
    check('P26（第二季01）→ Ⅱ 第1话', hitOf(26), [51179, 1]);
    check('P39（第二季14）→ Ⅱ第2クール 第1话', hitOf(39), [55888, 1]);
    check('P50（第三季01）→ Ⅲ 第1话', hitOf(50), [59193, 1]);
    check('P63（第三季14）→ Ⅲ 第14话', hitOf(63), [59193, 14]);

    /* ⑥ 回顾 / 融进正片的 OP/ED 不再跳（两个开关已从设置里删掉） */
    const cfgLZ = e0.api.getConfig();
    checkTrue('jumpMixed / jumpRecap 已从配置里删掉',
      cfgLZ.jumpMixed === undefined && cfgLZ.jumpRecap === undefined,
      [cfgLZ.jumpMixed, cfgLZ.jumpRecap]);
    checkTrue('只请求 op / ed（不再请求 recap / mixed-*）',
      !/types\.push\('recap'\)/.test(SRC) && !/types\.push\('mixed-op'/.test(SRC));
    checkTrue('mixed 段一律不跳', /if \(s\.mixed\) return false;/.test(SRC));
    checkTrue('设置面板里没有这两个开关',
      !/class="recap"/.test(SRC) && !/class="mixed"/.test(SRC) && !/跳过回顾/.test(SRC));

    /* ⑦ 胶囊：设置入口 + 绑过的视频在关闭自动识别时仍可见 */
    checkTrue('胶囊带设置入口', /data-a="cfg"/.test(SRC) && /onAct\('cfg', openSettings\)/.test(SRC));
    checkTrue('绑过的视频在 off 模式下也保留胶囊', /bound\) return;/.test(SRC));

    /* ⑧ 全链路：续季链断掉时靠同名搜索补齐（無職転生Ⅲ 没被连成 Ⅱ 的续集） */
    const AL_LZ = {
      108465: { id: 108465, idMal: 39535, episodes: 11, format: 'TV', startDate: { year: 2021 },
        title: { native: '無職転生 ～異世界行ったら本気だす～' },
        relations: { edges: [{ relationType: 'SEQUEL', node: { id: 127720, idMal: 45576, episodes: 12, format: 'TV', startDate: { year: 2021 }, title: { native: '無職転生 ～異世界行ったら本気だす～ 第2クール' } } }] } },
      127720: { id: 127720, idMal: 45576, episodes: 12, format: 'TV', startDate: { year: 2021 },
        title: { native: '無職転生 ～異世界行ったら本気だす～ 第2クール' },
        relations: { edges: [
          { relationType: 'PREQUEL', node: { id: 108465, idMal: 39535, episodes: 11, format: 'TV', startDate: { year: 2021 }, title: { native: '無職転生 ～異世界行ったら本気だす～' } } },
          { relationType: 'SEQUEL', node: { id: 146065, idMal: 51179, episodes: 13, format: 'TV', startDate: { year: 2023 }, title: { native: '無職転生Ⅱ ～異世界行ったら本気だす～' } } }
        ] } },
      146065: { id: 146065, idMal: 51179, episodes: 13, format: 'TV', startDate: { year: 2023 },
        title: { native: '無職転生Ⅱ ～異世界行ったら本気だす～' },
        relations: { edges: [
          { relationType: 'PREQUEL', node: { id: 127720, idMal: 45576, episodes: 12, format: 'TV', startDate: { year: 2021 }, title: { native: '無職転生 ～異世界行ったら本気だす～ 第2クール' } } },
          { relationType: 'SEQUEL', node: { id: 166873, idMal: 55888, episodes: 12, format: 'TV', startDate: { year: 2024 }, title: { native: '無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール' } } }
        ] } },
      166873: { id: 166873, idMal: 55888, episodes: 12, format: 'TV', startDate: { year: 2024 },
        title: { native: '無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール' },
        relations: { edges: [{ relationType: 'PREQUEL', node: { id: 146065, idMal: 51179, episodes: 13, format: 'TV', startDate: { year: 2023 }, title: { native: '無職転生Ⅱ ～異世界行ったら本気だす～' } } }] } },
      // 第三季：数据库里没被连成续集，只能靠同名搜索补进来
      178789: { id: 178789, idMal: 59193, episodes: 14, format: 'TV', startDate: { year: 2026 },
        title: { native: '無職転生Ⅲ ～異世界行ったら本気だす～' }, relations: { edges: [] } }
    };
    const AL_LZ_LIST = [AL_LZ[108465], AL_LZ[127720], AL_LZ[146065], AL_LZ[166873], AL_LZ[178789]];
    const netLZ = () => makeNet({
      'https://graphql.anilist.co': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables && q.variables.id !== undefined) return { data: { Media: AL_LZ[q.variables.id] || null } };
        if (q.variables && q.variables.q === '無職転生 ～異世界行ったら本気だす～') return { data: { Page: { media: AL_LZ_LIST } } };
        return { data: { Page: { media: [] } } };
      },
      'https://api.aniskip.com/v2/skip-times': (req) => {
        const m = /skip-times\/(\d+)\/(\d+)/.exec(req.url);
        const key = m[1] + '/' + m[2];
        const DB = {
          '39535/1': 70, '45576/1': 79.7, '45576/10': 45.7, '45576/12': 66,
          '51179/1': 144, '55888/1': 30, '59193/1': 25, '59193/14': 26
        };
        if (key in DB) {
          return { found: true, results: [{ interval: { startTime: DB[key], endTime: DB[key] + 90 }, skipType: 'op', episodeLength: 1950 }] };
        }
        return { found: false, results: [] };
      }
    });

    const e2 = makeEnv({ net: netLZ() });
    const chain = await e2.api.api_.buildSeasonChain(108465, 63, lzCtx(26), '無職転生 ～異世界行ったら本気だす～');
    check('季链来源＝分P分段', chain.source, 'parts');
    check('季链三段话数取自实际分P', chain.seasons.map(s => s.episodes), [24, 25, 14]);
    check('第1段把 Ⅰ+第2クール 都纳进来了', chain.seasons[0].entries.map(x => x.malId), [39535, 45576]);
    check('同名搜索补齐了没连上续集的第三季', chain.seasons[2].entries.map(x => x.malId), [59193]);
    check('没有未对齐的段', chain.unresolved, 0);

    // 手动绑定整 BV（P26 = 第二季01）后逐 P 验证定位
    const bindLZ = {};
    bindLZ['b:BV1KspF6iELH'] = {
      anilistId: 108465, malId: 39535, title: '無職転生 ～異世界行ったら本気だす～',
      episodes: 11, anchorPage: 26, anchorEp: 25, _scope: 'bvid', t: 1, seasonChain: chain
    };
    const e3 = makeEnv({ net: netLZ(), store: { _bindings: JSON.stringify(bindLZ) } });
    const cases = [[1, 39535, 1], [12, 45576, 1], [23, 45576, 12], [26, 51179, 1], [39, 55888, 1], [50, 59193, 1], [63, 59193, 14]];
    for (const [pg, wantMal, wantEp] of cases) {
      const r = await e3.api.identify(lzCtx(pg));
      checkTrue('P' + pg + ' 识别成功并取到时间戳', r.ok && (r.segments || []).length > 0, r.reason || r.confidence);
      check('P' + pg + ' → MAL ' + wantMal + ' 第' + wantEp + '话', [r.malId, r.episode], [wantMal, wantEp]);
    }
    // OVA：明确不跳，而不是猜一个条目去跳
    const rOva = await e3.api.identify(lzCtx(24));
    checkTrue('P24（OVA）明确不跳', !rOva.ok && rOva.reason === 'chain-miss', rOva.reason);
  }

  /* --- 23. 真实案例：尖帽子的魔法工坊（BV1jfDYBSEKs） ---
   * 用户实测：「用标题自动填」填出来的番名是「4月新番」，实际应是「尖帽子的魔法工坊」。
   * 真实接口数据（api.bilibili.com/x/web-interface/view）：
   *   title            = 【4K超清】尖帽子的魔法工坊 1-13话全集
   *   pages[0].part    = 01
   *   ugc_season.title = 【4月新番】尖帽子的魔法工坊     ← 罪魁祸首
   * 原因：weak 引号策略把【】里的内容当候选，「4月新番」不含任何噪声关键词，
   * 拿 42(weak) + 3(表意文字) + 8(长度 4~30) = 53 分，压过真番名的 41 分。 */
  head('23. 真实案例：尖帽子的魔法工坊（BV1jfDYBSEKs）');
  {
    const MAIN_G = '【4K超清】尖帽子的魔法工坊 1-13话全集';
    const SEASON_TITLE_G = '【4月新番】尖帽子的魔法工坊';
    const gCtx = (page) => ({
      bvid: 'BV1jfDYBSEKs', aid: 116361653259359, cid: 37304795821 + page, page: page,
      owner: { mid: 3493112693394137, name: '晓月の诗' }, mainTitle: MAIN_G,
      partTitle: String(page).padStart(2, '0'), duration: 1799, pubdate: 1775538873,
      videos: 13,
      pages: Array.from({ length: 13 }, (_, i) => ({ page: i + 1, part: String(i + 1).padStart(2, '0'), duration: 1799, cid: 37304795821 + i })),
      season: { id: 7843931, title: SEASON_TITLE_G }, seasonId: 7843931,
      seasonTitle: SEASON_TITLE_G, seasonEpisodeTitle: MAIN_G, incomplete: false
    });

    const P = makeEnv().api.api_;
    const cands = P.animeNameCandidates(gCtx(1));

    check('档期标签「4月新番」被认成噪声', P.quotedSegments(SEASON_TITLE_G).map(x => x.text), []);
    check('候选里没有「4月新番」', cands.filter(x => /新番/.test(x)), []);
    check('首选是干净的番名', cands[0], '尖帽子的魔法工坊');
    // 「【4月新番】」→ 撕掉档期标签后只剩空括号「【 】」，被空括号清理规则一并吃掉
    check('清洗合集名（残留空括号也被清掉）', P.cleanTitle(SEASON_TITLE_G), '尖帽子的魔法工坊');
    check('由主标题推出的候选也干净', P.animeNameCandidates({
      mainTitle: MAIN_G, partTitle: '01', seasonTitle: null, seasonEpisodeTitle: '', videos: 13, page: 1
    })[0], '尖帽子的魔法工坊');

    // 话数区间「1-13话」不能再留个孤零零的「1」在尾巴上
    check('「1-13话全集」整段剪掉', P.stripSeasonMarks('尖帽子的魔法工坊 1-13话全集'), '尖帽子的魔法工坊');
    check('「全26话」仍然认', P.stripSeasonMarks('想要成为影之实力者 两季32话全集'), '想要成为影之实力者');
    check('「第1-3季」区间不受影响', P.stripSeasonMarks('无职转生 第1-3季'), '无职转生');

    // 反例：不要因为加了「新番」噪声就误伤正常番名
    check('番名里的常见字不受影响 ①', P.animeNameCandidates({
      mainTitle: '「葬送的芙莉莲」第01话', partTitle: '第01话', seasonTitle: null, seasonEpisodeTitle: '', videos: 1, page: 1
    })[0], '葬送的芙莉莲');
    check('番名里的常见字不受影响 ②', P.cleanTitle('转生史莱姆日记 番外篇 第01话'), '转生史莱姆日记 番外篇 第01话');
  }

  /* --- 24. 端到端：尖帽子的魔法工坊真的能跳（BV1jfDYBSEKs，真实上游数据） ---
   * 上一组只验了「番名抽对了」。这一组走完整链路：
   *   标题 → 候选 → Bangumi 桥 → AniList(id/idMal) → AniSkip/Anime Skip → 校验 → 可跳区间
   * 所有外部响应都是 2026-10-15 从真实接口抓下来的。 */
  head('24. 端到端：尖帽子的魔法工坊（BV1jfDYBSEKs）');
  {
    const BGM_WHA = [{ id: 377130, name: 'とんがり帽子のアトリエ', name_cn: '尖帽子的魔法工房', date: '2026-04-06', eps: 13, platform: 'TV' }];
    const AL_WHA = { id: 147105, idMal: 51553, episodes: 13, format: 'ONA', startDate: { year: 2026 }, title: { native: 'とんがり帽子のアトリエ', romaji: 'Tongari Boushi no Atelier', english: 'Witch Hat Atelier' }, relations: { edges: [] } };

    const net = makeNet({
      'https://api.bgm.tv/v0/search/subjects': (req) => {
        const kw = JSON.parse(req.data).keyword;
        return { data: /尖帽子的魔法工[坊房]|とんがり帽子/.test(kw) ? BGM_WHA : [] };
      },
      'https://api.bgm.tv/v0/subjects/': { name: 'とんがり帽子のアトリエ', name_cn: '尖帽子的魔法工房', infobox: [] },
      'https://graphql.anilist.co': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables && q.variables.id !== undefined) {
          return { data: { Media: String(q.variables.id) === '147105' ? AL_WHA : null } };
        }
        return { data: { Page: { media: ANILIST_DB[q.variables.q] || [] } } };
      },
      // Anime Skip 只有第 9 话有（真实数据）
      'https://api.anime-skip.com/graphql': () => ({ data: { findShowsByExternalId: [{
        name: 'Witch Hat Atelier',
        episodes: [{ number: '9', timestamps: [
          { at: 0, type: { name: 'Canon' } }, { at: 382, type: { name: 'Intro' } },
          { at: 472, type: { name: 'Canon' } }, { at: 1325, type: { name: 'Credits' } },
          { at: 1415, type: { name: 'Preview' } }
        ] }]
      }] } })
    });

    const e = makeEnv({ store: { autoDetect: 'auto' }, net });
    const v = VIDEOS.BV1jfDYBSEKs;
    const gctx = (page) => {
      const p = v.pages[page - 1];
      return {
        bvid: v.bvid, aid: v.aid, cid: p.cid, page: page, owner: v.owner,
        mainTitle: v.title, partTitle: p.part, duration: p.duration,
        pubdate: v.pubdate, videos: v.videos, pages: v.pages,
        season: v.season, seasonId: v.season.id,
        seasonTitle: v.season.title, seasonEpisodeTitle: v.title, incomplete: false
      };
    };

    // 第 2 话：AniSkip 有 op + ed
    const r2 = await e.api.identify(gctx(2));
    checkTrue('P2 识别成功', r2.ok, r2.reason || r2.confidence);
    check('P2 → MAL 51553 第 2 话', [r2.malId, r2.episode], [51553, 2]);
    check('P2 拿到 op 区间 58→147', (r2.segments || []).filter(s => s.type === 'op').map(s => [s.start, s.end]), [[58, 147]]);
    check('P2 拿到 ed 区间', (r2.segments || []).filter(s => s.type === 'ed').map(s => [s.start, s.end]), [[1325, 1415]]);

    // 第 9 话：两个源都有数据，合并后不重复
    const r9 = await e.api.identify(gctx(9));
    checkTrue('P9 识别成功', r9.ok, r9.reason || r9.confidence);
    check('P9 只有一段 op（两源合并去重）', (r9.segments || []).filter(s => s.type === 'op').length, 1);
    checkTrue('P9 的 op 起点取自 AniSkip（优先源）',
      (r9.segments || []).some(s => s.type === 'op' && Math.abs(s.start - 383.487) < 1),
      (r9.segments || []).map(s => s.type + ':' + s.start));

    // 第 13 话：OP 从第 2 秒开始
    const r13 = await e.api.identify(gctx(13));
    checkTrue('P13 识别成功', r13.ok, r13.reason || r13.confidence);
    check('P13 → 第 13 话', r13.episode, 13);

    // 第 5 话：上游没有这一话的数据 → 识别成功但 0 段。
    // 这是有意设计：胶囊显示「尖帽子的魔法工坊 第5集 · 0 段」+ 橙点，
    // 比一个失败态更有用（用户能看出「认出来了，只是这集没数据」），且不会跳任何东西。
    const r5 = await e.api.identify(gctx(5));
    checkTrue('P5 上游无数据 → 0 段（不是失败态）', r5.ok && (r5.segments || []).length === 0, [r5.ok, r5.reason, (r5.segments || []).length]);
    check('P5 没有任何可跳区间', (r5.segments || []).filter(s => s.type === 'op' || s.type === 'ed'), []);
  }

  /* --- 25. 真实案例：单季投稿被误判成多季连播（BV1LUTt6fE6K） ---
   * 用户实测：这部稿件「只发了一季」（第 3 季，12 话），
   *   ① 却弹出了「多季连播 · 季边界」面板
   *   ② 在候选里选了第 3 期，面板却算成第 2 期
   * 真实数据（api.bilibili.com + graphql.anilist.co，2026-10-15 抓取）：
   *   title            = 4K超清【超超超超超喜欢你的100个女朋友 第三季】全12话
   *   ugc_season.title = 七月新番（41 个视频的杂合合集）
   *   第1期 162694/MAL 54714（2023，12话）→ 第2期 172258/MAL 57616（2025，12话）→ 第3期 200637/MAL 62811（2026，12话）
   * 两个独立缺陷：
   *   ① `N季…N话` 那条多季信号正则没排除「第」——「第三季】全12话」= 第 3 季共 12 话，是单季
   *   ② buildSeasonChain 里 expand 前先把 first 标进 seen → expand 认为都处理过直接返回，
   *      祖父辈永远收不进来 → 从第 3 期出发只有「第 2 期 + 第 3 期」→ 绝对集号错位 12 话 */
  head('25. 真实案例：单季投稿被误判成多季连播（BV1LUTt6fE6K）');
  {
    // 真实关系图（注意：AniList 的关系查询不返回 format，所以桩里也不该有 —— 桩要反映现实）
    const GF = {
      162694: { id: 162694, idMal: 54714, episodes: 12, startDate: { year: 2023 }, title: { native: '君のことが大大大大大好きな100人の彼女', romaji: 'Kimi no Koto ga Dai Dai Dai Dai Daisuki na 100-nin no Kanojo' },
        relations: { edges: [{ relationType: 'SEQUEL', node: { id: 172258, idMal: 57616, episodes: 12, startDate: { year: 2025 }, title: { native: '君のことが大大大大大好きな100人の彼女 第2期' } } }] } },
      172258: { id: 172258, idMal: 57616, episodes: 12, startDate: { year: 2025 }, title: { native: '君のことが大大大大大好きな100人の彼女 第2期', romaji: 'Kimi no Koto ga Dai Dai Dai Dai Daisuki na 100-nin no Kanojo 2nd Season' },
        relations: { edges: [
          { relationType: 'ADAPTATION', node: { id: 114416, idMal: 123681, episodes: null, startDate: { year: 2019 }, title: { native: '君のことが大大大大大好きな100人の彼女' } } },
          { relationType: 'PREQUEL', node: { id: 162694, idMal: 54714, episodes: 12, startDate: { year: 2023 }, title: { native: '君のことが大大大大大好きな100人の彼女' } } },
          { relationType: 'SEQUEL', node: { id: 200637, idMal: 62811, episodes: 12, startDate: { year: 2026 }, title: { native: '君のことが大大大大大好きな100人の彼女 第3期' } } }] } },
      200637: { id: 200637, idMal: 62811, episodes: 12, startDate: { year: 2026 }, title: { native: '君のことが大大大大大好きな100人の彼女 第3期', romaji: 'Kimi no Koto ga Dai Dai Dai Dai Daisuki na 100-nin no Kanojo 3rd Season' },
        relations: { edges: [
          { relationType: 'ADAPTATION', node: { id: 114416, idMal: 123681, episodes: null, startDate: { year: 2019 }, title: { native: '君のことが大大大大大好きな100人の彼女' } } },
          { relationType: 'PREQUEL', node: { id: 172258, idMal: 57616, episodes: 12, startDate: { year: 2025 }, title: { native: '君のことが大大大大大好きな100人の彼女 第2期' } } }] } }
    };
    const gfNet = () => makeNet({
      'https://graphql.anilist.co': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables && q.variables.id !== undefined) return { data: { Media: GF[q.variables.id] || null } };
        return { data: { Page: { media: [] } } };
      }
    });

    // 稿件：只发第 3 季，12 个分P，分P标题是纯数字（没有季标记）
    const gfCtx = (opts) => ({
      bvid: 'BV1LUTt6fE6K', aid: 116000000000001, cid: 9001, page: 1,
      owner: { mid: 1, name: '搬运' },
      mainTitle: (opts && opts.title) || '4K超清【超超超超超喜欢你的100个女朋友 第三季】全12话',
      partTitle: '1', duration: 2038, pubdate: 1783095936, videos: 12,
      pages: Array.from({ length: 12 }, (_, i) => ({ page: i + 1, part: String(i + 1), duration: 2038, cid: 9001 + i })),
      season: { id: 9044767, title: '七月新番' }, seasonId: 9044767,
      // 真实数据：这个 BV 在「七月新番」合集里的单集标题就叫「全12话」
      seasonTitle: '七月新番', seasonEpisodeTitle: '全12话', incomplete: false
    });

    const P = makeEnv({ net: gfNet() }).api.api_;

    /* ① 单季投稿不能被当成多季连播 */
    const ms1 = P.detectMultiSeason(gfCtx());
    check('单季投稿 multi=false（「第三季】全12话」是第 3 季共 12 话）', ms1.multi, false);
    check('「全12话」仍被读成总话数', ms1.totalEps, 12);
    check('标题里的季序号收集到 [3]', P.titleSeasonOrdinals(gfCtx()), [3]);

    /* 反例：真正的多季信号仍然要认出来 */
    const multiTitle = '【超超超超超喜欢你的100个女朋友 第二季+第三季】全24话';
    const ms2 = P.detectMultiSeason(gfCtx({ title: multiTitle }));
    check('「第二季+第三季」仍判为多季', ms2.multi, true);
    check('多季序号 [2,3]', P.titleSeasonOrdinals(gfCtx({ title: multiTitle })), [2, 3]);
    check('「两季32话全集」这类季数词仍是多季',
      P.detectMultiSeason(gfCtx({ title: '想要成为影之实力者 两季32话全集' })).multi, true);
    check('「第1-3季」区间仍是多季',
      P.detectMultiSeason(gfCtx({ title: '【无职转生 第1-3季】4K超清未删减完整版' })).multi, true);

    /* ② 季链必须把祖父辈收全（expand 不再被自己的 seen 挡住） */
    const chainAll = await P.buildSeasonChain(200637, 36, gfCtx(), 'x', [], '君のことが大大大大大好きな100人の彼女 第3期');
    check('从第 3 期出发能沿 PREQUEL 一路收全三季',
      chainAll.seasons.map(s => s.malId), [54714, 57616, 62811]);
    check('三季共 36 话', chainAll.total, 36);
    check('第 1 话 → 第1期第1话', (h => [h.malId, h.ep])(P.mapBySeasonChain(chainAll, 1)), [54714, 1]);
    check('第 25 话 → 第3期第1话', (h => [h.malId, h.ep])(P.mapBySeasonChain(chainAll, 25)), [62811, 1]);
    check('第 13 话 → 第2期第1话', (h => [h.malId, h.ep])(P.mapBySeasonChain(chainAll, 13)), [57616, 1]);

    /* ③ 部分季合集：标题点名了哪几季，绝对集号就从哪一季起算 */
    const chain23 = await P.buildSeasonChain(200637, 24, gfCtx({ title: multiTitle }), 'x', [], 'x');
    check('只投了第二季+第三季时，季链只含这两季',
      chain23.seasons.map(s => s.malId), [57616, 62811]);
    check('合集第 1 话 → 第2期第1话（不是第1期）', (h => [h.malId, h.ep])(P.mapBySeasonChain(chain23, 1)), [57616, 1]);
    check('合集第 13 话 → 第3期第1话', (h => [h.malId, h.ep])(P.mapBySeasonChain(chain23, 13)), [62811, 1]);

    /* ④ 端到端：绑第 3 期 + 第 1 话 → 必须取第 3 期的时间戳 */
    const mkBind = (chain) => ({
      's:9044767': {
        anilistId: 200637, malId: 62811, title: '君のことが大大大大大好きな100人の彼女 第3期',
        episodes: 12, anchorPage: 1, anchorEp: 1, seasonChain: chain, t: Date.now()
      }
    });
    const eNew = makeEnv({ store: { autoDetect: 'off', _bindings: JSON.stringify(mkBind(null)) }, net: gfNet() });
    const rNew = await eNew.api.identify(gfCtx());
    check('新绑定（无季链）→ MAL 62811 第 1 话', [rNew.malId, rNew.episode], [62811, 1]);

    // 旧版本算出来的季链（没有 chainVer）必须被忽略，退回单季绑定，而不是继续用错的那条
    const stale = { seasons: [{ anilistId: 172258, malId: 57616, title: '…第2期', episodes: 12, startAbs: 1, endAbs: 12 },
                              { anilistId: 200637, malId: 62811, title: '…第3期', episodes: 12, startAbs: 13, endAbs: 24 }],
                    total: 24, source: 'relations' };
    const eOld = makeEnv({ store: { autoDetect: 'off', _bindings: JSON.stringify(mkBind(stale)) }, net: gfNet() });
    const rOld = await eOld.api.identify(gfCtx());
    check('旧版季链被忽略 → 仍取第 3 期', [rOld.malId, rOld.episode], [62811, 1]);

    // 新版本算出来的季链（chainVer 匹配）才允许覆盖
    const fresh = Object.assign({}, stale, { chainVer: P.CHAIN_VERSION, seasons: [
      { anilistId: 162694, malId: 54714, title: '…第1期', episodes: 12, startAbs: 1, endAbs: 12 },
      { anilistId: 172258, malId: 57616, title: '…第2期', episodes: 12, startAbs: 13, endAbs: 24 },
      { anilistId: 200637, malId: 62811, title: '…第3期', episodes: 12, startAbs: 25, endAbs: 36 }] });
    const eFresh = makeEnv({ store: { autoDetect: 'off', _bindings: JSON.stringify(mkBind(fresh)) }, net: gfNet() });
    const rFresh = await eFresh.api.identify(Object.assign(gfCtx(), { page: 1 }));
    check('新版季链（第 1 话 → 第1期）才被采用', [rFresh.malId, rFresh.episode], [54714, 1]);
  }

  /* --- 26. 真实案例：多季合集的季边界（BV1YEaE6REdF，Re:Zero 第三季+第四季） ---
   * 用户实测：这个稿件的 36 个分P其实是「第三季1–16 + 第四季1–19 + 1分钟花絮」，
   *   ① 候选里选「3rd season」，面板却说「合集第 2 话 → 第一季第 2 话」
   *   ② 选「4th season」，又说「→ 第二季第 2 话」
   * 真实数据（api.bilibili.com + graphql.anilist.co，2026-10-15 抓取）：
   *   title = 【你死不过我你信吗 全四季】4K超清未删减完整版（标题写"全四季"，实际只投了第三、四季）
   *   分P    = 第三季1–16（P1–P16）、第四季1–19（P17–P35）、P36 =「1分钟」99 秒
   *   条目    = S1 21355/MAL 31240(25) → S2上 108632/MAL 39587(13) → S2下 119661/MAL 42203(12)
   *             → S3 163134/MAL 54857(16) → S4 189046/MAL 61316(19)
   * 四个缺陷（前两个叠加才让「按季号起锚」彻底失效）：
   *   ① entryOrdinal 只认 media.title.native（对象），而季链里的 title 是**字符串**
   *      → 静默拿到 undefined → 一律退回按位次猜
   *   ② AniList 标题写的是「3rd season」——序号在 season **前面**，原来匹配不上
   *   ③ expand 卡死 3 跳：从第 4 季往回够不到第 1 季 → 家族少一季 → 整体错位
   *   ④ 未对齐的分段（aligned:false）只要 entries 非空就照跳 → 取到错误季的时间戳 */
  head('26. 真实案例：多季合集季边界（BV1YEaE6REdF · Re:Zero）');
  {
    const nd = (id, idMal, eps, year, name) => ({ id, idMal, episodes: eps, startDate: { year }, title: { native: name, romaji: name } });
    const eg = (t, n) => ({ relationType: t, node: n });
    const NATIVE = {
      s1: 'Re:ゼロから始める異世界生活', s2a: 'Re:ゼロから始める異世界生活 2nd Season',
      s2b: 'Re:ゼロから始める異世界生活 2nd Season Part 2', s3: 'Re:ゼロから始める異世界生活 3rd season',
      s4: 'Re:ゼロから始める異世界生活 4th season'
    };
    // 关系查询不返回 format —— 桩里也不该有（桩要反映现实）
    const RZ = {
      21355: Object.assign(nd(21355, 31240, 25, 2016, NATIVE.s1), { relations: { edges: [
        eg('SIDE_STORY', nd(100049, 36286, 2, 2018, 'Re:ゼロから始める異世界生活 OVAs')),
        eg('SEQUEL', nd(108632, 39587, 13, 2020, NATIVE.s2a))] } }),
      108632: Object.assign(nd(108632, 39587, 13, 2020, NATIVE.s2a), { relations: { edges: [
        eg('PREQUEL', nd(21355, 31240, 25, 2016, NATIVE.s1)),
        eg('SEQUEL', nd(119661, 42203, 12, 2021, NATIVE.s2b))] } }),
      119661: Object.assign(nd(119661, 42203, 12, 2021, NATIVE.s2b), { relations: { edges: [
        eg('PREQUEL', nd(108632, 39587, 13, 2020, NATIVE.s2a)),
        eg('SEQUEL', nd(163134, 54857, 16, 2024, NATIVE.s3))] } }),
      163134: Object.assign(nd(163134, 54857, 16, 2024, NATIVE.s3), { relations: { edges: [
        eg('PREQUEL', nd(119661, 42203, 12, 2021, NATIVE.s2b)),
        eg('SPIN_OFF', nd(182417, 60012, 16, 2024, 'Re:ゼロから始める休憩時間(ブレイクタイム) 3rd Season')),
        eg('SEQUEL', nd(189046, 61316, 19, 2026, NATIVE.s4))] } }),
      189046: Object.assign(nd(189046, 61316, 19, 2026, NATIVE.s4), { relations: { edges: [
        eg('PREQUEL', nd(163134, 54857, 16, 2024, NATIVE.s3)),
        eg('SPIN_OFF', nd(210687, 63830, 19, 2026, 'Re:ゼロから始める休憩時間(ブレイクタイム) 4th Season'))] } })
    };

    // 真实分P（part / duration）
    const P26 = [
      ['第三季1', 7258], ['第三季2', 1824], ['第三季3', 1836], ['第三季4', 1836], ['第三季5', 1836], ['第三季6', 1836],
      ['第三季7', 2186], ['第三季8', 1836], ['第三季9', 1836], ['第三季10', 1836], ['第三季11', 1836], ['第三季12', 2106],
      ['第三季13', 1836], ['第三季14', 1836], ['第三季15', 1836], ['第三季16', 1856],
      ['第四季1', 1853], ['第四季2', 1853], ['第四季3', 1853], ['第四季4', 1853], ['第四季5', 1853], ['第四季6', 1853],
      ['第四季7', 1852], ['第四季8', 1873], ['第四季9', 1852], ['第四季10', 1853], ['第四季11', 1902], ['第四季12', 1852],
      ['第四季13', 2172], ['第四季14', 1852], ['第四季15', 1853], ['第四季16', 2032], ['第四季17', 1853], ['第四季18', 1803],
      ['第四季19', 3334], ['1分钟', 99]
    ];
    const RZ_PAGES = P26.map(([part, duration], i) => ({ page: i + 1, part, duration, cid: 7100 + i }));

    const r26Ctx = (page) => {
      const p = RZ_PAGES[page - 1];
      return {
        bvid: 'BV1YEaE6REdF', aid: 117000000000001, cid: p.cid, page,
        owner: { mid: 1, name: '修复40K放映厅' },
        mainTitle: '【你死不过我你信吗 全四季】4K超清未删减完整版',
        partTitle: p.part, duration: p.duration, pubdate: 1783095936, videos: 36,
        pages: RZ_PAGES, seasonId: 0, seasonTitle: '', seasonEpisodeTitle: '', incomplete: false
      };
    };

    // 真实时间戳（2026-10-15 抓取）：S3 有，S4 还没有（2026 新番）
    const ANISKIP_RZ = {
      '54857/1': { found: true, results: [
        { interval: { startTime: 157.449, endTime: 246.745 }, skipType: 'op', episodeLength: 1769.9 },
        { interval: { startTime: 1307.97, endTime: 1420 }, skipType: 'ed', episodeLength: 1420.0533 }] },
      '54857/2': { found: true, results: [
        { interval: { startTime: 98.647, endTime: 188.647 }, skipType: 'op', episodeLength: 1420.002 }] }
    };
    const net26 = makeNet({
      'https://graphql.anilist.co': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables && q.variables.id !== undefined) return { data: { Media: RZ[q.variables.id] || null } };
        return { data: { Page: { media: [] } } };
      },
      'https://api.aniskip.com/v2/skip-times': (req) => {
        const m = /skip-times\/(\d+)\/(\d+)/.exec(req.url);
        return ANISKIP_RZ[m[1] + '/' + m[2]] || { found: false, results: [] };
      }
    });

    const P = makeEnv({ net: net26 }).api.api_;

    /* ① 分段：两个季，末尾的「1分钟」花絮不算进段里 */
    const gs = P.seasonGroupsFromParts(r26Ctx(2));
    check('分段 = 第三季(16) + 第四季(19)',
      gs && gs.map(g => [g.season, g.episodes]), [[3, 16], [4, 19]]);
    check('末尾 99 秒的「1分钟」被剔掉', gs && gs[1].endPage, 35);
    checkTrue('「1分钟」被判定为花絮尾巴', P.isJunkTailPart({ part: '1分钟', duration: 99 }));
    check('真正的短篇标记不会被误判', P.isJunkTailPart({ part: '第三季1', duration: 200 }), false);

    const v2 = r26Ctx(2);
    check('P2 的合集内绝对集号 = 2（分P自己写着第三季2）',
      (h => [h.absEp, h.season])(P.absEpisodeFromPart(v2)), [2, 3]);

    /* ② entryOrdinal 两种形状都要认（季链里的 title 是字符串） */
    const strSea = (name) => ({ anilistId: 0, title: name, episodes: 12 });
    check('「3rd season」序号在 season 前面也要认', P.entryOrdinal(strSea(NATIVE.s3), 99), 3);
    check('「4th season」→ 4', P.entryOrdinal(strSea(NATIVE.s4), 99), 4);
    check('「2nd Season Part 2」→ 2', P.entryOrdinal(strSea(NATIVE.s2b), 99), 2);
    check('第 1 季无标记 → 用兜底序号', P.entryOrdinal(strSea(NATIVE.s1), 1), 1);
    check('AniList 原始 media（title 是对象）仍然认',
      P.entryOrdinal({ title: { native: '… 3rd season', romaji: '' } }, 99), 3);

    /* ③ 季链：分P写着第几季 —— 不论锚点选第 3 季还是第 4 季，分段都要对 */
    for (const [label, anchor] of [['选第 3 期', 163134], ['选第 4 期', 189046]]) {
      const chain = await P.buildSeasonChain(anchor, 0, r26Ctx(2), 'Re:Zero', [], NATIVE.s3);
      check(label + '：第 1 段 = 第三季、第 2 段 = 第四季，两段都对上了',
        chain.seasons.map(s => [s.season, s.malId, s.aligned]), [[3, 54857, true], [4, 61316, true]]);
      check(label + '：没有对不上的段', chain.mismatch, false);

      const map = (n) => P.mapBySeasonChain(chain, n);
      check(label + '：合集第 1 话 → 第三季第 1 话', (h => [h.malId, h.ep])(map(1)), [54857, 1]);
      check(label + '：合集第 2 话 → 第三季第 2 话', (h => [h.malId, h.ep])(map(2)), [54857, 2]);
      check(label + '：合集第 16 话 → 第三季第 16 话', (h => [h.malId, h.ep])(map(16)), [54857, 16]);
      check(label + '：合集第 17 话 → 第四季第 1 话', (h => [h.malId, h.ep])(map(17)), [61316, 1]);
      check(label + '：合集第 35 话 → 第四季第 19 话', (h => [h.malId, h.ep])(map(35)), [61316, 19]);
      check(label + '：合集第 36 话（花絮）不跳', map(36), null);
    }

    /* ③-b 分P没有季标记时只能靠续季关系推 —— 这一路才直接考验「家族收全」。
     * 从第 4 季往回要 4 跳才够得到第 1 季，原来 expand 卡死 3 跳就少一季。 */
    const flatCtx = () => {
      const pages = Array.from({ length: 66 }, (_, i) => ({ page: i + 1, part: String(i + 1), duration: 1450, cid: 8100 + i }));
      return Object.assign(r26Ctx(1), {
        bvid: 'BVFLAT000001', aid: 117000000000002, pages, videos: 66,
        page: 1, cid: 8100, partTitle: '1', duration: 1450
      });
    };
    for (const [label, anchor] of [['选第 3 期', 163134], ['选第 4 期', 189046]]) {
      const ch = await P.buildSeasonChain(anchor, 0, flatCtx(), 'Re:Zero', [], NATIVE.s3);
      check(label + '（分P无季标记）：沿续季关系收全 5 个条目',
        ch.seasons.map(s => s.malId), [31240, 39587, 42203, 54857, 61316]);
      check(label + '（分P无季标记）：第 1 话 → 第 1 季第 1 话',
        (h => [h.malId, h.ep])(P.mapBySeasonChain(ch, 1)), [31240, 1]);
      check(label + '（分P无季标记）：第 51 话 → 第 3 季第 1 话',
        (h => [h.malId, h.ep])(P.mapBySeasonChain(ch, 51)), [54857, 1]);
      check(label + '（分P无季标记）：第 67 话 → 第 4 季第 1 话',
        (h => [h.malId, h.ep])(P.mapBySeasonChain(ch, 67)), [61316, 1]);
    }

    /* ④ 端到端：绑第三季 + P2 → 必须取第三季的时间戳 */
    const chain26 = await P.buildSeasonChain(163134, 0, r26Ctx(2), 'Re:Zero', [], NATIVE.s3);
    const bind26 = {
      'b:BV1YEaE6REdF': {
        anilistId: 163134, malId: 54857, title: NATIVE.s3, episodes: 16,
        anchorPage: 1, anchorEp: 1, seasonChain: chain26, t: Date.now()
      }
    };
    const e26 = makeEnv({ store: { autoDetect: 'off', _bindings: JSON.stringify(bind26) }, net: net26 });
    const r2 = await e26.api.identify(r26Ctx(2));
    checkTrue('P2 识别成功', r2.ok, r2.reason || r2.confidence);
    check('P2 → MAL 54857 第 2 话（不是第一季的 31240）', [r2.malId, r2.episode], [54857, 2]);
    check('P2 拿到第三季的 op 98.647→188.647',
      (r2.segments || []).filter(s => s.type === 'op').map(s => [s.start, s.end]), [[98.647, 188.647]]);

    // P17（第四季第 1 话）：上游还没有数据 → 认出来了但 0 段，不能瞎跳
    const r17 = await e26.api.identify(r26Ctx(17));
    check('P17 → MAL 61316 第 1 话（第四季）', [r17.malId, r17.episode], [61316, 1]);
    check('P17 上游无数据 → 0 段', (r17.segments || []).length, 0);

    // P36 是 99 秒的花絮：即使集号被抽成 1，取到的 op(157s) 也超出视频长度 → 一段都不跳
    const r36 = await e26.api.identify(r26Ctx(36));
    check('P36（99 秒花絮）不跳任何东西', (r36.segments || []).length, 0);

    /* ⑤ 反例：没对上数据库条目的段，一律不跳（不能因为 entries 非空就照用） */
    const badChain = {
      chainVer: P.CHAIN_VERSION, source: 'parts', total: 20, mismatch: true,
      seasons: [{ season: 3, startPage: 1, endPage: 20, episodes: 20, startAbs: 1, endAbs: 20, aligned: false,
        entries: [{ anilistId: 21355, malId: 31240, title: NATIVE.s1, episodes: 25, startWithin: 1 }] }]
    };
    check('未对齐的段：mapBySeasonChain 直接返回 null',
      await P.mapBySeasonChain(badChain, 2), null);
  }

  /* --- 27. 跳过偏移 + 撤回（v0.4.4） ---
   * 用户报的三件事：
   *   ① 点了「撤回」，过一会儿还是会被自动跳过
   *   ② 想要一个「在原来跳过的基础上加减秒数」的设置（上游按原片标的时间戳，B站这版常差一两秒）
   *   ③ 撤回提示默认停留 8 秒太长
   * ①的根因：撤回回调里 `delete runtime.skipped[key]`。轮询是 50ms 一次，
   *   而撤回又把播放头送回区间内部 → 下一轮立刻重新跳过，等于没撤。
   *   （当年为了绕开这个自激，撤回位置还特意写成 `from - 1`。） */
  head('27. 跳过偏移与撤回（v0.4.4）');
  {
    const mkVideo = (o) => Object.assign({
      currentTime: 0, duration: 1500, paused: false, ended: false,
      play() { this.paused = false; },
      addEventListener() {}, getBoundingClientRect: () => ({ width: 800, height: 450 })
    }, o);
    const OP = { type: 'op', start: 100, end: 190 };
    const ED = { type: 'ed', start: 880, end: 960 };

    /* ① 跳过偏移 */
    const targetWith = (off, video, seg) =>
      makeEnv({ store: { skipOffset: off } }).api.api_.skipTarget(video || mkVideo(), seg || OP);
    check('偏移 0（默认）→ 落在官方终点 +ε', targetWith(0), 190.06);
    check('+3 → 多跳 3 秒（把 OP 后的黑屏一起跳掉）', targetWith(3), 193.06);
    check('-5 → 少跳 5 秒（留住 OP 尾巴）', targetWith(-5), 185.06);
    // 短片段 + 大负偏移：下限锁在「起跳点 +1 秒」，绝不倒回片段内部
    check('-30（已被配置夹住）用在 15 秒的短片段上 → 锁在起点 +1 秒',
      targetWith(-30, mkVideo(), { type: 'op', start: 100, end: 115 }), 101);
    check('-100 会被配置夹成 -30（不会出现离谱的负跳跃）', targetWith(-100), 160.06);
    check('+30 但视频只剩 200 秒 → 锁在片尾前', targetWith(30, mkVideo({ duration: 200 })), 199.95);

    const cfgWith = (store) => makeEnv({ store }).api.api_.getConfig();
    check('偏移上限 30 秒（手滑输错也不失控）', cfgWith({ skipOffset: 999 }).skipOffset, 30);
    check('偏移下限 -30 秒', cfgWith({ skipOffset: -999 }).skipOffset, -30);
    check('偏移填了非数字 → 回落到 0', cfgWith({ skipOffset: 'abc' }).skipOffset, 0);

    /* ② 撤回之后不能再被自动跳过 */
    const v1 = mkVideo({ currentTime: 120 });
    const e1 = makeEnv({ store: { autoDetect: 'auto', skipOffset: 0 }, video: v1 });
    const rt1 = e1.api._runtime;
    rt1.result = { ok: true, segments: [OP, ED] };
    rt1.video = v1;
    e1.api._checkOnce();
    check('播放头在 OP 区间里 → 自动跳到终点', Math.round(v1.currentTime * 100) / 100, 190.06);
    checkTrue('「已跳过」标记已写下', rt1.skipped['op:100'] === true);
    checkTrue('撤回回调挂到了 runtime.undo 上', typeof rt1.undo === 'function');

    rt1.undo();
    check('撤回后回到原位置（原样回去，不再 -1 秒）', v1.currentTime, 120);
    checkTrue('撤回**不清除**「已跳过」标记（防重跳的关键）', rt1.skipped['op:100'] === true);

    rt1.lastSkipAt = 0;                       // 排除 160ms 冷却期的干扰，只让「已跳过」标记来挡
    for (let i = 0; i < 6; i++) e1.api._checkOnce();
    check('撤回后连续轮询都不再跳过', v1.currentTime, 120);

    /* 撤回只作用于那一段，别的段落照常跳 */
    const v2 = mkVideo({ currentTime: 900 });
    const e2 = makeEnv({ store: { autoDetect: 'auto' }, video: v2 });
    const rt2 = e2.api._runtime;
    rt2.result = { ok: true, segments: [OP, ED] };
    rt2.video = v2;
    e2.api._checkOnce();
    check('ED 区间里 → 跳到 ED 终点', Math.round(v2.currentTime * 100) / 100, 960.06);
    rt2.undo();
    check('撤回 ED 后回到 900', v2.currentTime, 900);
    v2.currentTime = 120; rt2.lastSkipAt = 0;
    e2.api._checkOnce();
    check('撤回 ED 不影响 OP 段（照样跳）', Math.round(v2.currentTime * 100) / 100, 190.06);

    /* ③ 配置默认值与迁移 */
    const fresh = makeEnv().api.api_.getConfig();
    check('新装默认：撤回提示 4 秒', fresh.undoSeconds, 4);
    check('新装默认：偏移 0', fresh.skipOffset, 0);
    check('老配置（cfgVersion 2 + 存着 8 秒）→ 迁移成 4 秒',
      cfgWith({ cfgVersion: 2, undoSeconds: 8 }).undoSeconds, 4);
    check('迁移不动用户改过的其它项',
      cfgWith({ cfgVersion: 2, undoSeconds: 8, skipOffset: -2, jumpEd: false }).skipOffset, -2);
    check('迁移不动 jumpEd',
      cfgWith({ cfgVersion: 2, undoSeconds: 8, skipOffset: -2, jumpEd: false }).jumpEd, false);
    check('已经是新版（cfgVersion 4）的配置原样保留',
      cfgWith({ cfgVersion: 4, undoSeconds: 12 }).undoSeconds, 12);
    check('「不显示撤回」（0 秒）也能存住',
      cfgWith({ cfgVersion: 4, undoSeconds: 0 }).undoSeconds, 0);
    check('v0.4.8 之前点过「⇥」存下的 autoNext=开 → 迁移回默认关',
      cfgWith({ cfgVersion: 3, autoNext: true }).autoNext, false);
    check('v0.4.7（无 autoNext 概念）升级 → autoNext 默认关',
      cfgWith({ cfgVersion: 3 }).autoNext, false);
  }

  /* --- 28. 网络失败 / 缓存策略（v0.4.5） ---
   * 老实现把所有网络错误都 catch 成 []（= 「这一集上游没有时间戳」），于是：
   *   · 用户看到「0 段」却不知道是网络挂了还是真没数据；
   *   · 失败/空结果被按 7 天、30 天缓存，上游补了数据也长时间不生效。
   * 现在要求：失败可区分、失败不缓存、空结果按短 TTL 缓存。 */
  head('28. 网络失败 / 缓存策略（v0.4.5）');
  {
    /* ① 两个时间戳源都挂了 → 明确报网络失败，而不是「0 段」 */
    const e1 = makeEnv({ store: { autoDetect: 'auto' } });
    const orig1 = global.GM_xmlhttpRequest;
    global.GM_xmlhttpRequest = (req) => {
      if (/api\.aniskip\.com|api\.anime-skip\.com/.test(req.url)) { req.onerror && req.onerror({ status: 0 }); return; }
      orig1(req);
    };
    const r1 = await e1.api.identify(ctxOf('BV_TEST000001', 1));
    check('两个源都失败 → net-error（不是「0 段」成功）', [r1.ok, r1.reason], [false, 'net-error']);
    checkTrue('失败的结果不写进时间戳缓存',
      !Object.keys(cacheOf(e1)).some(k => /^seg:/.test(k)), Object.keys(cacheOf(e1)));

    /* ② 上游明确回答「这一集没有」→ 仍然是成功 + 0 段（不能把老行为改坏） */
    const e2 = makeEnv({
      store: { autoDetect: 'auto' },
      net: makeNet({ 'https://api.aniskip.com/v2/skip-times': { found: false, results: [] } })
    });
    const r2 = await e2.api.identify(ctxOf('BV_TEST000001', 1));
    checkTrue('上游明确无数据 → ok + 0 段', r2.ok === true && (r2.segments || []).length === 0, r2.reason);

    /* ③ 番名搜索接口挂了 → net-error，而不是「番名匹配失败」 */
    const e3 = makeEnv({ store: { autoDetect: 'auto' } });
    const orig3 = global.GM_xmlhttpRequest;
    global.GM_xmlhttpRequest = (req) => {
      if (/graphql\.anilist\.co/.test(req.url)) { req.onerror && req.onerror({ status: 0 }); return; }
      orig3(req);
    };
    const r3 = await e3.api.identify(ctxOf('BV_TEST000001', 1));
    check('番名搜索失败 → net-error', [r3.ok, r3.reason], [false, 'net-error']);

    /* ④ 负缓存：明确的「没有」按 6 小时过期，正经结果仍按 7 天 */
    const segKeys = Object.keys(cacheOf(e2)).filter(k => /^seg:as:/.test(k));
    checkTrue('「上游无此集」记为负缓存', segKeys.length > 0 && segKeys.every(k => cacheOf(e2)[k].neg === 1), segKeys);
    const key = segKeys[0];
    const posKey = Object.keys(cacheOf(e2)).find(k => /^al:/.test(k));
    if (key && posKey) {
      cacheOf(e2)[key].t = Date.now() - 7 * 3600000;      // 假装 7 小时前查过
      check('负缓存 6 小时就过期', cacheGetOf(e2, key, 7 * 86400000), undefined);
      cacheOf(e2)[posKey].t = Date.now() - 7 * 3600000;
      check('负缓存的短 TTL 不牵连正经结果（搜索缓存仍有效）',
        Array.isArray(cacheGetOf(e2, posKey, 30 * 86400000)), true);
    } else {
      check('负缓存 6 小时就过期', null, undefined);
      check('负缓存的短 TTL 不牵连正经结果（搜索缓存仍有效）', null, true);
    }

    /* ⑤ 分季规则：网络失败不许缓存 30 天；404（上游明确没有）才允许缓存 */
    const e4 = makeEnv({ store: { autoDetect: 'auto' } });
    const orig4 = global.GM_xmlhttpRequest;
    global.GM_xmlhttpRequest = (req) => {
      if (/relation-rules/.test(req.url)) { req.onerror && req.onerror({ status: 0 }); return; }
      orig4(req);
    };
    await callHook(e4, 'applyRelationRules', 52991, 1);
    checkTrue('网络失败不缓存分季规则',
      !Object.keys(cacheOf(e4)).some(k => /^rel:/.test(k)), Object.keys(cacheOf(e4)));

    const e5 = makeEnv({ store: { autoDetect: 'auto' } });
    const orig5 = global.GM_xmlhttpRequest;
    global.GM_xmlhttpRequest = (req) => {
      if (/relation-rules/.test(req.url)) { req.onload && req.onload({ status: 404, responseText: '' }); return; }
      orig5(req);
    };
    await callHook(e5, 'applyRelationRules', 52991, 1);
    checkTrue('404 才允许缓存「这部番没有分季规则」',
      Object.keys(cacheOf(e5)).some(k => /^rel:/.test(k)), Object.keys(cacheOf(e5)));

    /* ⑥ 缓存只存用得上的字段（整份 view JSON 会把 GM 存储撑爆） */
    const big = {
      code: 0, data: {
        aid: 1, cid: 2, title: 't', pubdate: 0, videos: 1, duration: 1440,
        owner: { mid: 7, name: 'up', avatar: 'A'.repeat(4000) },
        pages: [{ page: 1, part: 'p1', duration: 1440, cid: 2, dimension: { width: 1920, height: 1080 } }],
        desc: 'D'.repeat(4000),
        ugc_season: { id: 9, title: '合集', cover: 'C'.repeat(4000), sections: [{ episodes: [{ bvid: 'BV_A', aid: 1, title: 'ep', cid: 999, arc: { junk: 1 } }] }] },
        junk: 'J'.repeat(4000)
      }
    };
    const e6 = makeEnv({ net: makeNet({ 'https://api.bilibili.com/x/web-interface/view': big }) });
    const info = (await callHook(e6, 'fetchVideoInfo', 'BV_CLEAN00001')) || {};
    checkTrue('丢掉无用字段（desc / junk / 头像 / 封面）',
      info.desc === undefined && info.junk === undefined &&
      (info.owner || {}).avatar === undefined && (info.ugc_season || {}).cover === undefined,
      Object.keys(info));
    const pg = (info.pages || [])[0] || {};
    check('保留 pages 里要用的字段', [pg.page, pg.part, pg.duration], [1, 'p1', 1440]);
    const ep0 = (((info.ugc_season || {}).sections || [])[0] || {}).episodes || [];
    check('保留合集单集标题（做标题线索用）', (ep0[0] || {}).title, 'ep');

    /* ⑦ 防抖窗口内关页不丢写 */
    const e7 = makeEnv({ store: { autoDetect: 'auto' } });
    await e7.api.identify(ctxOf('BV_TEST000001', 1));
    flushOf(e7);
    checkTrue('flushCache 立刻落盘', typeof e7.store._cache === 'string' && e7.store._cache.length > 2, e7.store._cache);
    checkTrue('落盘的缓存里确实有时间戳',
      /seg:as:52991:1/.test(e7.store._cache || ''), e7.store._cache);
  }

  /* --- 28b. 季链展开的并发上限 ---
   * 一家子可能有 24 个条目，原来一次性并发 24 个 AniList 请求（限流 90/min），
   * 冷启动时容易被 429。改成批次并发。 */
  head('28b. 季链展开的并发上限（防 AniList 限流）');
  {
    const FAN = {};
    const leaf = (id) => ({
      id: id, idMal: 900 + id, episodes: 12, format: 'TV', title: { native: 'S' + id },
      startDate: { year: 2020 }, relations: { edges: [] }
    });
    const kids = [2, 3, 4, 5, 6, 7, 8, 9];
    FAN[1] = {
      id: 1, idMal: 900, episodes: 12, format: 'TV', title: { native: 'ROOT' }, startDate: { year: 2020 },
      relations: { edges: kids.map(k => ({ relationType: 'SEQUEL', node: leaf(k) })) }
    };
    kids.forEach(k => { FAN[k] = leaf(k); });

    const e = makeEnv();
    const orig = global.GM_xmlhttpRequest;
    let inFlight = 0, maxInFlight = 0;
    const held = [];
    global.GM_xmlhttpRequest = (req) => {
      if (req.url.indexOf('https://graphql.anilist.co') === 0) {
        const q = JSON.parse(req.data);
        if (/Media\(id/.test(q.query)) {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          held.push({ req, id: q.variables.id });
          return;
        }
      }
      orig(req);
    };

    const ctxNoParts = {
      bvid: 'BV_FAN0000001', videos: 1, page: 1, pages: [{ page: 1, part: '01', duration: 1440 }],
      mainTitle: 'x', partTitle: '01', seasonId: null, seasonEpisodeTitle: '', seasonTitle: ''
    };
    const p = e.api.api_.buildSeasonChain(1, 0, ctxNoParts, 'x', null, 'x');
    const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    await tick();

    let guard = 0;
    while (held.length && guard++ < 60) {
      const h = held.shift();
      inFlight--;
      h.req.onload({ status: 200, responseText: JSON.stringify({ data: { Media: FAN[h.id] } }) });
      await tick();
    }
    const chain = await p;
    checkTrue('关系查询并发不超过 4', maxInFlight <= 4, maxInFlight);
    checkTrue('确实并发了（不是退化成串行）', maxInFlight > 1, maxInFlight);
    checkTrue('家族仍然收全（8 个子条目）', chain && chain.seasons.length === 9, chain && chain.seasons.length);
  }

  /* --- 29. 模式与置信度门槛（v0.4.5） ---
   * README 一直这么写，代码却从来没实现：
   *   ask  = 识别出来让你自己点着跳（原本和 auto 一模一样，直接跳）
   *   auto = 命中**且置信度足够**才跳（confThreshold / hintThreshold 是死配置，从没被读过）
   * 这里把三条语义钉死。 */
  head('29. 模式与置信度门槛（v0.4.5）');
  {
    const okR = (score, manual) => ({ ok: true, manual: !!manual, confidence: { score: score } });

    /* ① 纯策略函数 */
    const f = (store, r) => callHook(makeEnv({ store }), 'shouldAutoSkip', r);
    check('off：不自动跳', f({ autoDetect: 'off' }, okR(99)), false);
    check('off：手动绑定照跳（绑过＝用户要它跳）', f({ autoDetect: 'off' }, okR(0, true)), true);
    check('ask：识别出来也不自动跳', f({ autoDetect: 'ask' }, okR(99)), false);
    check('auto：置信度不够（50 < 60）不跳', f({ autoDetect: 'auto' }, okR(50)), false);
    check('auto：置信度够（70 ≥ 60）才跳', f({ autoDetect: 'auto' }, okR(70)), true);
    check('auto：门槛可调（confThreshold 90 → 80 分不跳）', f({ autoDetect: 'auto', confThreshold: 90 }, okR(80)), false);
    check('没识别成功 → 永不自动跳', f({ autoDetect: 'auto' }, { ok: false }), false);

    /* ② 提示门槛 hintThreshold */
    const g = (store, r) => callHook(makeEnv({ store }), 'shouldShowIdentifyToast', r);
    check('置信度低于提示门槛 → 连提示都不给', g({ autoDetect: 'auto' }, okR(20)), false);
    check('置信度够 → 提示', g({ autoDetect: 'auto' }, okR(80)), true);
    check('off 模式下的手动绑定 → 仍然提示', g({ autoDetect: 'off' }, okR(80, true)), true);
    check('关掉「显示跳转提示」→ 不提示', g({ autoDetect: 'auto', showToast: false }, okR(80)), false);

    /* ③ rerun 真实接线：ask 不能启动轮询 */
    const loc = { pathname: '/video/BV1TEST00001', search: '?p=1' };
    const askEnv = makeEnv({ store: { autoDetect: 'ask' }, location: loc });
    await askEnv.api.rerun();
    const rtA = askEnv.api._runtime;
    checkTrue('ask：识别成功', !!(rtA.result && rtA.result.ok), rtA.result && rtA.result.reason);
    check('ask：不自动跳', rtA.allowAutoSkip, false);
    checkTrue('ask：不启动轮询', !rtA.timer, rtA.timer);

    const autoEnv = makeEnv({ store: { autoDetect: 'auto' }, location: loc });
    await autoEnv.api.rerun();
    const rtB = autoEnv.api._runtime;
    check('auto + 高置信度：允许自动跳', rtB.allowAutoSkip, true);
    checkTrue('auto：启动轮询', !!rtB.timer, rtB.timer);

    const lowEnv = makeEnv({ store: { autoDetect: 'auto', confThreshold: 100 }, location: loc });
    await lowEnv.api.rerun();
    check('auto 但没过门槛：不自动跳', lowEnv.api._runtime.allowAutoSkip, false);
    checkTrue('auto 但没过门槛：不启动轮询', !lowEnv.api._runtime.timer);
  }

  /* --- 30. 黑名单语义 / 死代码（v0.4.5） --- */
  head('30. 黑名单语义 / 死代码（v0.4.5）');
  {
    /* ① 拉黑要优先于绑定：绑定是「这是某番」，拉黑是「这视频不是番」——
     * 后者是用户更晚、更明确的一次表态，不能被绑定压过去。 */
    const binding = {
      'b:BV_TEST000001': { anilistId: 154587, malId: 52991, title: '葬送のフリーレン', episodes: 28, anchorPage: 1, anchorEp: 3 }
    };
    const e1 = makeEnv({
      store: {
        autoDetect: 'off',
        _bindings: JSON.stringify(binding),
        _blacklist: JSON.stringify({ 'b:BV_TEST000001': { t: Date.now() } })
      }
    });
    const r1 = await e1.api.identify(ctxOf('BV_TEST000001', 1));
    check('拉黑优先于绑定', [r1.ok, r1.reason], [false, 'blacklisted']);

    /* ② 拉黑粒度固定：老实现只写「黑名单键的第一个」（有 seasonId 时是 s:，
     * 没有时是 b:），同一个按钮在不同稿件上写进不同的表。 */
    const e2 = makeEnv();
    callHook(e2, 'setBlacklist', { bvid: 'BV_X000000001', cid: 5, seasonId: 999, mainTitle: 't' });
    check('「不是番剧」固定按 BV 粒度落表', Object.keys(JSON.parse(e2.store._blacklist || '{}')), ['b:BV_X000000001']);

    /* ③ 死代码清理 */
    checkTrue('titleOffset 死代码已删（没有写入方却一直在读）', !/titleOffset/.test(SRC));
    checkTrue('noFocusAll / lastSegKey 死代码已删', !/noFocusAll|lastSegKey/.test(SRC));
    checkTrue('集号正则里没有重复的「話」', !/話\|話/.test(SRC));

    /* ④ 关系查询必须带 format —— 否则 seasonNode 读到的 format 永远是空，
     * 续集链带进来的剧场版／音乐条目过滤不掉（测试桩里塞了 format，所以一直是假绿） */
    checkTrue('AniList 关系查询带 format',
      /relations\{edges\{relationType node\{[^}]*format/.test(SRC));
    checkTrue('季链过滤里确实用了 format',
      /s\.format !== 'MOVIE' && s\.format !== 'MUSIC'/.test(SRC));

    /* ⑤ 胶囊文案补齐（原来 no-match / low-score 会掉进「识别失败」的红点） */
    checkTrue('胶囊文案补齐 no-match', /'no-match':/.test(SRC));
    checkTrue('胶囊文案补齐 low-score', /'low-score':/.test(SRC));
    checkTrue('胶囊文案补齐 net-error', /'net-error':/.test(SRC));
  }

  /* --- 31. ask 手动跳过 / 监听器 / 切集竞态（v0.4.5） --- */
  head('31. ask 手动跳过 / 监听器 / 切集竞态（v0.4.5）');
  {
    const mkVideo = (t, dur) => {
      const v = {
        tagName: 'VIDEO', paused: false, ended: false, readyState: 4, duration: dur, dataset: {}, _ct: t,
        getBoundingClientRect: () => ({ width: 800, height: 450 }),
        play() {}, addEventListener() {}, removeEventListener() {}
      };
      Object.defineProperty(v, 'currentTime', { get() { return this._ct; }, set(x) { this._ct = x; } });
      return v;
    };
    const LOC = { pathname: '/video/BV1TEST00001', search: '?p=1' };

    /* ① ask 模式：点「跳过」才跳 */
    const v1 = mkVideo(50, 1440);
    const e1 = makeEnv({ store: { autoDetect: 'ask' }, location: LOC, video: v1 });
    const rt1 = e1.api._runtime;
    await e1.api.rerun();
    check('ask：识别到 OP + ED 两段', (rt1.result.segments || []).length, 2);
    checkTrue('ask：用户点「跳过」→ 真的跳', e1.api._skipNow(), true);
    check('ask：落到 OP 终点 +ε', Math.round(v1.currentTime * 100) / 100, 92.56);
    check('ask：同一段不会重复跳', e1.api._skipNow(), false);
    v1._ct = 1350;
    checkTrue('ask：播放头在 ED 里 → 点跳过跳 ED', e1.api._skipNow(), true);
    check('ask：落到 ED 终点 +ε', Math.round(v1.currentTime * 100) / 100, 1390.06);

    /* ② 监听器不能越挂越多（切 P 会反复 startMonitor） */
    const added = [], removed = [];
    const v2 = {
      tagName: 'VIDEO', paused: false, ended: false, duration: 1440, dataset: {}, currentTime: 0,
      getBoundingClientRect: () => ({ width: 800, height: 450 }),
      addEventListener: (ev) => { added.push(ev); },
      removeEventListener: (ev) => { removed.push(ev); }
    };
    const e2 = makeEnv({ video: v2 });
    const rt2 = e2.api._runtime;
    rt2.video = v2;
    e2.api._startMonitor();
    check('startMonitor 挂 3 个事件监听', added.length, 3);
    e2.api._stopMonitor();
    check('stopMonitor 把监听全摘掉', removed.length, 3);
    checkTrue('stopMonitor 清空监听句柄', rt2.videoListeners === null);
    e2.api._startMonitor();
    e2.api._startMonitor();
    check('重复 startMonitor 不会叠加监听', added.length - removed.length, 3);

    /* ③ boot 只注册一条 SPA 定位轮询 */
    const e3 = makeEnv();
    check('boot 注册 1.2s 定位轮询', e3.intervals.filter(i => i.ms === 1200).length, 1);
    e3.api._boot();
    e3.api._boot();
    check('重复 boot 不再叠加轮询', e3.intervals.filter(i => i.ms === 1200).length, 1);

    /* ④ 切集竞态：先发的慢链回来得晚，不许覆盖新视频的上下文/结果 */
    const binding = {
      'b:BV1GARBAGE01': { anilistId: 154587, malId: 52991, title: '葬送のフリーレン', episodes: 28, anchorPage: 1, anchorEp: 1 }
    };
    const e4 = makeEnv({
      store: { autoDetect: 'auto', _bindings: JSON.stringify(binding) },
      location: LOC
    });
    const rt4 = e4.api._runtime;
    const orig4 = global.GM_xmlhttpRequest;
    const held = [];
    let release = false;
    global.GM_xmlhttpRequest = (req) => {
      if (!release && req.url.indexOf('https://graphql.anilist.co') === 0) { held.push(req); return; }
      orig4(req);
    };
    const tick = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

    const p1 = e4.api.rerun();                 // 第一个视频：识别要打 AniList，被我们扣住
    await tick();
    global.location = { pathname: '/video/BV1GARBAGE01', search: '?p=1' };   // 用户切走了
    const p2 = e4.api.rerun();                 // 第二个视频：走手动绑定，不需要 AniList
    await tick();
    await p2;
    check('新视频的结果已就位', [rt4.ctx.bvid, rt4.result.manual], ['BV1GARBAGE01', true]);

    release = true;                            // 现在才放行第一个视频那条慢链
    held.forEach((req) => req.onload({
      status: 200,
      responseText: JSON.stringify({ data: { Page: { media: ANILIST_DB['葬送的芙莉莲'] } } })
    }));
    await p1;
    check('迟到的旧识别结果不覆盖新上下文', rt4.ctx.bvid, 'BV1GARBAGE01');
    check('迟到的旧结果不改变新视频的结果', rt4.result.manual, true);
  }

  /* --- 32. CSP 兜底 / 落盘时机（v0.4.5） --- */
  head('32. CSP 兜底 / 落盘时机（v0.4.5）');
  {
    checkTrue('胶囊关键样式内联（CSP 拦掉 <style> 也还能看）', /pill\.style\.cssText\s*=/.test(SRC));
    checkTrue('胶囊圆点/分隔线也补了内联兜底', /dots\[di\]\.style\.cssText/.test(SRC));
    checkTrue('关页前立刻落盘（pagehide）', /addEventListener\('pagehide', flushCache\)/.test(SRC));
    checkTrue('切到后台标签页时落盘', /visibilitychange/.test(SRC));
    checkTrue('ask 模式胶囊上有「跳过」入口', /data-a="go">跳过/.test(SRC));
  }

  /* --- 33. 文档一致性（v0.4.5） ---
   * 这一版有一半的 bug 是「README 说的和代码做的不一样」。
   * 把几条最容易再次漂移的钉在测试里。 */
  head('33. 文档一致性（v0.4.5）');
  {
    const SRC_PATH = SRCS.find((p) => fs.existsSync(p));
    const readDoc = (names) => names
      .map((r) => path.join(path.dirname(SRC_PATH), r))
      .map((p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null))
      .find((x) => x) || '';
    const README = readDoc(['README.md', path.join('..', 'README.md')]);
    const CHANGELOG = readDoc(['CHANGELOG.md', path.join('..', 'CHANGELOG.md')]);

    /* 版本号跟更新日志必须对得上 —— 写死成某个版本的话每次发版都要改测试，
     * 而且很容易「升了脚本忘了写日志」（或反过来）。0.5.0 起更新日志搬到 CHANGELOG.md。 */
    const ver = (/@version\s+([0-9]+\.[0-9]+\.[0-9]+)/.exec(SRC) || [])[1];
    checkTrue('脚本版本号与 CHANGELOG 更新日志一致（' + ver + '）',
      !!ver && new RegExp('##\\s*' + ver.replace(/\./g, '\\.')).test(CHANGELOG));
    checkTrue('CHANGELOG 有 0.4.5 更新日志', /##\s*0\.4\.5/.test(CHANGELOG));
    checkTrue('CHANGELOG 有 0.4.6 更新日志', /##\s*0\.4\.6/.test(CHANGELOG));
    checkTrue('README 的「撤回提示秒数」默认值是 4（不再是 8）',
      /\|\s*撤回提示秒数\s*\|\s*`4`\s*\|/.test(README));
    checkTrue('README 设置表补上了「跳过偏移」', /跳过偏移/.test(README));
    checkTrue('README 不再写死用例数', !/19[0-9]\s*项用例/.test(README));
    checkTrue('README 写清了 ask = 点了才跳', /`ask`[\s\S]{0,200}点了才跳/.test(README));
    checkTrue('README 写清了 auto 的置信度门槛', /置信度 ≥ 60/.test(README));
    checkTrue('README 提到了网络失败态', /网络不通|数据源限流/.test(README));
  }

  /* --- 34. 绑定面板：多季合集不许存成「没季链的单季绑定」（v0.4.6） ---
   * 用户实测 BV1KspF6iELH（无职转生 第1-3季）：
   *   「明明选定第一季并绑定，却绑定到了第二季」
   * 季链算法本身是对的（第 22 组把 P1→Ⅰ 钉死了），问题全在面板：
   *   ① 搜索回来会无条件把 picked 换成 searchResults[0] —— 用户点过的行被悄悄换掉；
   *   ② 季链是异步算的，点完就保存时 chain 还是 null → 绑定存成「单季」，
   *      识别时不再走季链，直接拿 picked 那条的集号去查 → 得到第二季的时间戳；
   *   ③ 面板上看不出「到底会绑定哪一条」：三段季边界跟你选了哪季无关，
   *      所以选择被换掉时用户完全没有察觉的途径。
   * 老桩每次 querySelector 都返回新节点，这块一直测不到 —— 这组用例把面板拉进覆盖。 */
  head('34. 绑定面板：多季合集必须存成「带季链的绑定」（v0.4.6）');
  {
    const TITLE_LZ = '【无职转生 第1-3季】4K超清未删减完整版（更至第三季14）';
    const pagesLZ = [];
    for (let i = 1; i <= 23; i++) pagesLZ.push({ page: i, part: '第一季' + String(i).padStart(2, '0'), duration: 1950, cid: 4000 + i });
    pagesLZ.push({ page: 24, part: '第一季OVA', duration: 1945, cid: 4024 });
    for (let i = 0; i <= 24; i++) pagesLZ.push({ page: 25 + i, part: '第二季' + String(i).padStart(2, '0'), duration: 1950, cid: 4100 + i });
    for (let i = 1; i <= 14; i++) pagesLZ.push({ page: 49 + i, part: '第三季' + String(i).padStart(2, '0'), duration: 1948, cid: 4200 + i });
    VIDEOS.BV1KspF6iELH = {
      bvid: 'BV1KspF6iELH', aid: 777, cid: 4001, title: TITLE_LZ, pubdate: 1791598437,
      videos: 63, duration: 1950, owner: { mid: 2, name: '后宫补番' }, pages: pagesLZ, ugc_season: null
    };
    const lzCtxOf = (page) => ({
      bvid: 'BV1KspF6iELH', aid: 777, cid: 4000 + page, page: page,
      owner: { mid: 2, name: '后宫补番' }, mainTitle: TITLE_LZ,
      partTitle: pagesLZ[page - 1].part, duration: pagesLZ[page - 1].duration,
      pubdate: 1791598437, videos: 63, pages: pagesLZ, season: null, seasonId: null,
      seasonTitle: null, seasonEpisodeTitle: '', incomplete: false
    });

    /* 搜索结果刻意把「第二季」排在第一条 —— 真机上 AniList 就是这么排的，
     * 所以「自动选第一条」会直接踩到用户的雷 */
    const lzMedia = (id, mal, eps, native, year) => ({
      id, idMal: mal, episodes: eps, format: 'TV', startDate: { year }, synonyms: [],
      title: { native, romaji: native }
    });
    const LZ_II = lzMedia(146065, 51179, 13, '無職転生Ⅱ ～異世界行ったら本気だす～', 2023);
    const LZ_I = lzMedia(108465, 39535, 11, '無職転生 ～異世界行ったら本気だす～', 2021);
    const LZ_I2 = lzMedia(127720, 45576, 12, '無職転生 ～異世界行ったら本気だす～ 第2クール', 2021);
    const LZ_II2 = lzMedia(166873, 55888, 12, '無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール', 2024);
    const LZ_III = lzMedia(178789, 59193, 14, '無職転生Ⅲ ～異世界行ったら本気だす～', 2026);
    const rel = (node, edges) => Object.assign({}, node, {
      relations: { edges: (edges || []).map((n) => ({ relationType: 'SEQUEL', node: n })) }
    });
    const relNode = (m) => ({ id: m.id, idMal: m.idMal, episodes: m.episodes, format: 'TV', startDate: m.startDate, title: m.title });
    const LZ_REL = {
      108465: rel(relNode(LZ_I), [relNode(LZ_I2)]),
      127720: rel(relNode(LZ_I2), [relNode(LZ_II)]),
      146065: rel(relNode(LZ_II), [relNode(LZ_II2)]),
      166873: rel(relNode(LZ_II2), []),
      178789: rel(relNode(LZ_III), [])
    };
    const netLZ = () => makeNet({
      'https://graphql.anilist.co': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables && q.variables.id !== undefined) return { data: { Media: LZ_REL[q.variables.id] || null } };
        if (q.variables && q.variables.q === '無職転生 ～異世界行ったら本気だす～') {
          return { data: { Page: { media: [LZ_II, LZ_I, LZ_I2, LZ_II2, LZ_III] } } };
        }
        return { data: { Page: { media: [] } } };
      },
      'https://api.aniskip.com/v2/skip-times': (req) => {
        const m = /skip-times\/(\d+)\/(\d+)/.exec(req.url);
        if (/^(39535|45576|51179|55888|59193)\//.test(m[1] + '/' + m[2])) {
          return { found: true, results: [{ interval: { startTime: 70, endTime: 160 }, skipType: 'op', episodeLength: 1950 }] };
        }
        return { found: false, results: [] };
      }
    });

    const tick = async (n) => { for (let i = 0; i < (n || 80); i++) await Promise.resolve(); };
    const env = makeEnv({
      store: { autoDetect: 'off' }, net: netLZ(),
      location: { pathname: '/video/BV1KspF6iELH', search: '?p=1' }
    });
    await env.api.rerun();
    const panel = openPanelVia(env, 'bind');

    orNode(byClass('q'), 'input').value = '無職転生 ～異世界行ったら本気だす～';
    orNode(panel.querySelector('.search'), 'button').dispatch('click');
    await tick();
    const rows = panel.querySelectorAll('.cand-item');
    const rowOf = (id) => rows.find((r) => r.textContent.indexOf('AniList ' + id) >= 0);
    checkTrue('候选里能查到无职转生（5 条）', rows.length >= 5, rows.length);
    checkTrue('候选里有第一季', !!rowOf(108465));

    /* ① 点「第一季」——用户明确的那一次点击 */
    orNode(rowOf(108465)).dispatch('click');
    check('季链没算完时不许保存（否则存成单季绑定 → 拿错季的时间戳）',
      orNode(panel.querySelector('.save'), 'button').disabled, true);
    const willBind = panel.querySelector('.willbind');
    checkTrue('面板写明「将绑定哪一条」',
      ((willBind && willBind.textContent) || '').indexOf('無職転生 ～異世界行ったら本気だす～') >= 0 &&
      ((willBind && willBind.textContent) || '').indexOf('無職転生Ⅱ') < 0, (willBind && willBind.textContent) || '(没有 .willbind)');

    /* ② 季链算完 → 保存可用，并且季边界要标出「你选的那条落在这一段」 */
    await tick();
    check('季链算完后保存可用', orNode(panel.querySelector('.save'), 'button').disabled, false);
    checkTrue('季边界里标出「你选的是这一段」', !!panel.querySelector('.chainrow.on'),
      panel.querySelectorAll('.chainrow').length + ' 行');

    /* ③ 用户再点一次「搜索」（很多人会这样确认一下）——不许把选择换掉 */
    orNode(panel.querySelector('.search'), 'button').dispatch('click');
    await tick();
    orNode(panel.querySelector('.save'), 'button').dispatch('click');
    const savedAll = JSON.parse(env.store._bindings || '{}');
    const savedBind = savedAll[Object.keys(savedAll)[0]] || {};
    check('再搜一次也不会把用户选的季换掉', savedBind.malId, 39535);
    checkTrue('存下来的绑定带着三段季链',
      !!(savedBind.seasonChain && savedBind.seasonChain.seasons && savedBind.seasonChain.seasons.length === 3),
      savedBind.seasonChain && savedBind.seasonChain.seasons && savedBind.seasonChain.seasons.length);

    /* ④ 端到端：绑完之后，第一季的 P 用第一季的时间戳，第二季的 P 用第二季的 */
    const rP1 = await env.api.identify(lzCtxOf(1));
    check('绑定后 P1 → Ⅰ 第1话（不是第二季）', [rP1.malId, rP1.episode], [39535, 1]);
    const rP26 = await env.api.identify(lzCtxOf(26));
    check('同一合集 P26 → Ⅱ 第1话', [rP26.malId, rP26.episode], [51179, 1]);

    /* ⑤ 只为当前条目算出来的季链才可以复用（否则等于给 Ⅰ 套 Ⅱ 的季链） */
    const usable = env.api.api_.chainUsableFor;
    check('别的条目算出来的季链不能被当前选择复用',
      typeof usable === 'function' ? usable({ builtFor: 146065, seasons: [1, 2] }, 108465) : 'no-fn', false);
    check('为当前条目算出来的季链可用',
      typeof usable === 'function' ? usable({ builtFor: 108465, seasons: [1, 2] }, 108465) : 'no-fn', true);

    /* ⑥ 纯函数：搜索回来该选谁 */
    const pickAfter = env.api.api_.pickAfterSearch;
    check('用户点过第二季时，搜索回来不许换成第一条',
      typeof pickAfter === 'function'
        ? (pickAfter([LZ_II, LZ_I], 108465) || {}).id : 'no-fn', 108465);
    check('没点过任何候选（没有 current）时，用户点过的 id 不在结果里 → 退回第一条',
      typeof pickAfter === 'function'
        ? (pickAfter([LZ_II, LZ_I], 999999) || {}).id : 'no-fn', 146065);
    /* 0.4.7：Bangumi 桥可能把中文名解析成「另一季」的日文名，那次搜索的结果里
     * 根本没有用户选的那条（实测「無職転生Ⅱ …」只回 2 条，没有Ⅰ）。
     * 老规则「不在结果里就退回第一条」＝把用户明确选的第一季换成第二季。 */
    check('用户明确选过的那条不在新结果里 → 保留他的选择，不退回首条',
      typeof pickAfter === 'function'
        ? (pickAfter([LZ_II, LZ_II2], 108465, { id: 108465, malId: 39535, title: '無職転生 ～異世界行ったら本気だす～' }) || {}).id
        : 'no-fn', 108465);
    check('新结果为空时也不清掉用户的选择',
      typeof pickAfter === 'function'
        ? (pickAfter([], 108465, { id: 108465 }) || {}).id : 'no-fn', 108465);
  }

  /* --- 35. 「不是番剧」：标记入口彻底删掉，只留「取消」（v0.4.7） ---
   * 用户实测的三条抱怨之三：「不是番剧按钮太突兀了，删掉吧，在胶囊界面加个取消就好了」。
   * 老实现的问题：① 一个「拉黑」动作摆在日常胶囊上，误触概率高、价值低；
   *              ② 只写 b:{bvid}，而读取侧命中 s:/c:/b: 任意一个就算拉黑 ——
   *                 老版本写在 s:/c: 上的记录没有任何入口能取消，用户点了「取消」还是不跳。
   * 0.4.7 的定案：标记入口（胶囊上的按钮、面板里的开关）全部删掉，
   * 只在「已经标记过的视频」的胶囊上留一个「取消」，把历史记录清干净。 */
  head('35. 「不是番剧」：标记入口删掉 · 只留胶囊上的「取消」（v0.4.7）');
  {
    const LOC = { pathname: '/video/BV1TEST00001', search: '?p=1' };
    const e1 = makeEnv({ store: { autoDetect: 'auto' }, location: LOC });
    await e1.api.rerun();
    const pill = byClass('pill');
    checkTrue('识别成功后胶囊上有「改」', !!pill.querySelector('[data-a=bind]'));
    check('胶囊上不再有「不是番剧」按钮', pill.querySelector('[data-a=no]'), null);
    check('胶囊文案里也没有「不是番剧」', /不是番剧/.test(pill.textContent), false);
    check('没被标记时胶囊上没有「取消」', pill.querySelector('[data-a=unbl]'), null);

    const panel = openPanelVia(e1, 'bind');
    check('面板里也不再有任何「不是番剧」标记入口', panel.querySelector('.noanime'), null);
    check('面板里没有「不是番剧」字样', /不是番剧/.test(panel.innerHTML), false);
    check('面板里也没有 .noanime 这类开关节点', panel.querySelectorAll('.noanime').length, 0);

    /* 拉黑只剩 API 一条路（历史数据的读取侧仍然认 s:/b:/c:），
     * 但界面上必须给一个「取消」的出口 */
    e1.api.setBlacklist(e1.api._runtime.ctx);
    await e1.api.rerun();
    const pillB = byClass('pill') || el('div');
    checkTrue('胶囊切成「已标记不是番剧」', /已标记/.test(pillB.textContent), pillB.textContent);
    const unbl = pillB.querySelector('[data-a=unbl]') || el('span');
    checkTrue('胶囊上给「取消」入口', !!pillB.querySelector('[data-a=unbl]'));
    check('「取消」两个字就够（不再写「取消标记」）', (pillB.querySelector('[data-a=unbl]') || { textContent: '' }).textContent, '取消');
    unbl.dispatch('click');
    check('点「取消」→ 黑名单清空', Object.keys(JSON.parse(e1.store._blacklist || '{}')).length, 0);

    /* 读取侧是「命中 s: / b: / c: 任意一个键就算拉黑」，而历史版本写过不同的键。
     * 取消时三把键都要清 —— 老实现只删 b:，用户「取消了还是不跳」。
     * 这里按 BV1TEST00001 真实的两把键造数据（无合集 → 没有 s:），
     * 再单独核对有合集时键的形态里确实带 s:。 */
    const legacy = makeEnv({
      store: {
        autoDetect: 'auto',
        _blacklist: JSON.stringify({ 'c:1001': { t: 1 }, 'b:BV1TEST00001': { t: 1 } })
      },
      location: LOC
    });
    await legacy.api.rerun();
    check('有合集时黑名单键的形态（s:/b:/c:）',
      legacy.api.blacklistKeys({ bvid: 'BVX', seasonId: 9, cid: 8 }), ['s:9', 'b:BVX', 'c:8']);
    checkTrue('历史标记仍在读取侧生效（老记录还能拦住跳转）', /已标记/.test((byClass('pill') || el('div')).textContent));
    (byClass('pill') || el('div')).querySelector('[data-a=unbl]').dispatch('click');
    check('取消时把 c:/b: 两把键一起清掉', Object.keys(JSON.parse(legacy.store._blacklist || '{}')), []);
  }

  /* --- 36. 胶囊可以拖到任意位置（v0.4.6）---
   * 用户实测的三条抱怨之二：「胶囊界面不可移动」——
   * 原来 .root 是 position:fixed; top:64px; right:20px，写死的，
   * B站自己的右上角控件、弹幕开关都可能跟它打架。 */
  head('36. 胶囊可拖动 · 位置记住 · 可重置（v0.4.6）');
  {
    const LOC = { pathname: '/video/BV1TEST00001', search: '?p=1' };
    const mkVideoEl = (t, dur) => {
      const v = el('video');
      v.currentTime = t;
      v.duration = dur;
      v.paused = false;
      v.seeking = false;
      v.readyState = 4;
      v.addEventListener = () => {};
      return v;
    };
    const e = makeEnv({ store: { autoDetect: 'ask' }, location: LOC, video: mkVideoEl(50, 1440) });
    await e.api.rerun();
    // GM 存的值可能是对象也可能是字符串（真机上 GM_setValue 自己序列化）
    const pillPosOf = (env) => {
      const v = env.store._pillPos;
      if (!v) return {};
      return typeof v === 'string' ? (JSON.parse(v) || {}) : v;
    };
    const root = byClass('root');
    const pill = byClass('pill');
    const drag = (from, to) => {
      pill.dispatch('pointerdown', { clientX: from[0], clientY: from[1], pointerId: 1, button: 0 });
      e.win.dispatch('pointermove', { clientX: to[0], clientY: to[1], pointerId: 1 });
      e.win.dispatch('pointerup', { clientX: to[0], clientY: to[1], pointerId: 1 });
    };

    checkTrue('胶囊接了 pointerdown', typeof pill.dispatch === 'function');
    // 抖动 2px：不算拖动，也不写盘
    drag([300, 100], [302, 101]);
    check('位移小于阈值 → 不写位置', e.store._pillPos, undefined);
    check('位移小于阈值 → 不算拖动', e.api._runtime.pillDragged, false);

    // 真拖动
    drag([300, 100], [420, 260]);
    const pos = pillPosOf(e);
    checkTrue('拖动后位置落盘（left/top 都是数字）',
      typeof pos.left === 'number' && typeof pos.top === 'number', e.store._pillPos);
    checkTrue('拖动后写了内联位置（CSP 拦样式也生效）', /left:/.test(root.style.cssText), root.style.cssText);
    checkTrue('位置在视口内', pos.left >= 0 && pos.top >= 0 && pos.left <= 1280 && pos.top <= 800, pos);

    // 拖到屏幕外 → 夹回视口
    drag([420, 260], [9999, 9999]);
    const pos2 = pillPosOf(e);
    checkTrue('拖出视口会被夹回来', pos2.left <= 1280 && pos2.top <= 800 && pos2.left >= 0 && pos2.top >= 0, pos2);

    /* 拖完手上那一下 click 不能当作点击，否则「拖一下胶囊」会顺手触发跳过。
     * 注意：GM_* 全局是「最后一次 makeEnv 装的」，所以下面要用当前这个 env 验证。 */
    const v2 = mkVideoEl(50, 1440);
    const e2 = makeEnv({ store: { autoDetect: 'ask' }, location: LOC, video: v2 });
    await e2.api.rerun();
    const pill2 = byClass('pill');
    pill2.dispatch('pointerdown', { clientX: 300, clientY: 100, pointerId: 1, button: 0 });
    e2.win.dispatch('pointermove', { clientX: 430, clientY: 200, pointerId: 1 });
    e2.win.dispatch('pointerup', { clientX: 430, clientY: 200, pointerId: 1 });
    pill2.dispatch('click', {});
    check('拖完那一下不算点击（不会误跳）', v2.currentTime, 50);
    pill2.dispatch('click', {});
    checkTrue('正常点击仍然跳（按钮没被拖拽功能吃掉）', v2.currentTime > 50, v2.currentTime);

    // 设置面板里能重置（在 e2 上做：它是最后一个 env，GM_* 全局归它）
    const sp = openPanelVia(e2, 'settings');
    const resetBtn = sp.querySelector('.resetpos') || el('button');
    checkTrue('设置面板有「重置胶囊位置」', !!sp.querySelector('.resetpos'));
    check('重置前位置还在', typeof pillPosOf(e2).left, 'number');
    resetBtn.dispatch('click');
    check('重置后位置记录被清掉', e2.store._pillPos, undefined);
  }

  /* --- 37. 旧版本存下的「没有季链的绑定」：禁止错季跳 + 后台自动补链（v0.4.7） ---
   * 用户第二次报「绑定错误仍未修复」，并且确认自己跑的就是 0.4.6。
   * 关键事实：0.4.5 时期写进 GM 的坏绑定，升级脚本本身不会改写它。
   * 一条「第二季、没有季链」的绑定在多季合集里会被当单季处理 ——
   * P1（第一季第1话）直接去查 MAL 51179 第 1 话，于是第一季用的是第二季的 OP。 */
  head('37. 旧绑定没有季链：拒绝错季跳 + 后台自动补链（v0.4.7）');
  {
    const tick = async (n) => { for (let i = 0; i < (n || 80); i++) await Promise.resolve(); };
    const T37 = '【无职转生 第1-3季】4K超清未删减完整版（更至第三季14）';
    const P37 = [];
    for (let i = 1; i <= 23; i++) P37.push({ page: i, part: '第一季' + String(i).padStart(2, '0'), duration: 1950, cid: 4000 + i });
    P37.push({ page: 24, part: '第一季OVA', duration: 1945, cid: 4024 });
    for (let i = 0; i <= 24; i++) P37.push({ page: 25 + i, part: '第二季' + String(i).padStart(2, '0'), duration: 1950, cid: 4100 + i });
    for (let i = 1; i <= 14; i++) P37.push({ page: 49 + i, part: '第三季' + String(i).padStart(2, '0'), duration: 1948, cid: 4200 + i });
    const ctx37 = (page) => ({
      bvid: 'BV1KspF6iELH', aid: 777, cid: 4000 + page, page: page,
      owner: { mid: 2, name: '后宫补番' }, mainTitle: T37,
      partTitle: P37[page - 1].part, duration: P37[page - 1].duration,
      pubdate: 1791598437, videos: 63, pages: P37, season: null, seasonId: null,
      seasonTitle: null, seasonEpisodeTitle: '', incomplete: false
    });
    const LOC37 = { pathname: '/video/BV1KspF6iELH', search: '?p=1' };
    const mk = (id, mal, eps, native, year) => ({
      id, idMal: mal, episodes: eps, format: 'TV', startDate: { year }, synonyms: [],
      title: { native, romaji: native }
    });
    const LZ_I = mk(108465, 39535, 11, '無職転生 ～異世界行ったら本気だす～', 2021);
    const LZ_I2 = mk(127720, 45576, 12, '無職転生 ～異世界行ったら本気だす～ 第2クール', 2021);
    const LZ_II = mk(146065, 51179, 13, '無職転生Ⅱ ～異世界行ったら本気だす～', 2023);
    const LZ_II2 = mk(166873, 55888, 12, '無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール', 2024);
    const LZ_III = mk(178789, 59193, 14, '無職転生Ⅲ ～異世界行ったら本気だす～', 2026);
    const FAM = [LZ_I, LZ_I2, LZ_III, LZ_II, LZ_II2];
    // 真实关系的形状：178789(Ⅲ) 的 PREQUEL 是 166873(Ⅱ第2クール)，反向也连得上
    const node = (m) => ({ id: m.id, idMal: m.idMal, episodes: m.episodes, format: 'TV', startDate: m.startDate, title: m.title });
    const edge = (type, m) => ({ relationType: type, node: node(m) });
    const withRel = (m, edges) => Object.assign({}, node(m), { relations: { edges: edges } });
    const REL37 = {
      108465: withRel(LZ_I, [edge('SEQUEL', LZ_I2)]),
      127720: withRel(LZ_I2, [edge('PREQUEL', LZ_I), edge('SEQUEL', LZ_II)]),
      146065: withRel(LZ_II, [edge('PREQUEL', LZ_I2), edge('SEQUEL', LZ_II2)]),
      166873: withRel(LZ_II2, [edge('PREQUEL', LZ_II), edge('SEQUEL', LZ_III)]),
      178789: withRel(LZ_III, [edge('PREQUEL', LZ_II2)])
    };
    const net37 = () => makeNet({
      'https://graphql.anilist.co': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables && q.variables.id !== undefined) return { data: { Media: REL37[q.variables.id] || null } };
        return { data: { Page: { media: FAM } } };
      },
      'https://api.aniskip.com/v2/skip-times': (req) => {
        const m = /skip-times\/(\d+)\/(\d+)/.exec(req.url);
        return /^(39535|45576|51179|55888|59193)\//.test(m[1] + '/' + m[2])
          ? { found: true, results: [{ interval: { startTime: 70, endTime: 160 }, skipType: 'op', episodeLength: 1950 }] }
          : { found: false, results: [] };
      }
    });
    /* 0.4.5 存下的坏绑定：第二季、没有季链 */
    const stale = makeEnv({
      store: {
        autoDetect: 'off',
        _bindings: JSON.stringify({
          'b:BV1KspF6iELH': {
            anilistId: 146065, malId: 51179, title: '無職転生Ⅱ ～異世界行ったら本気だす～',
            episodes: 13, anchorPage: 1, anchorEp: 1, seasonChain: null, t: 1
          }
        })
      },
      net: net37(), location: LOC37
    });
    await stale.api.rerun();

    const r1 = await stale.api.identify(ctx37(1));
    checkTrue('第一季的分P不许用第二季的时间戳跳', !r1.ok,
      JSON.stringify([r1.malId, r1.episode, r1.reason, r1.title]));
    check('不跳的理由是「绑定的季和这个分P对不上」', r1.reason, 'season-mismatch');

    await tick(200);
    const r2 = await stale.api.identify(ctx37(1));
    check('后台补算季链之后：P1 → Ⅰ 第1话', [r2.malId, r2.episode], [39535, 1]);
    const r26 = await stale.api.identify(ctx37(26));
    check('同一合集 P26 → Ⅱ 第1话', [r26.malId, r26.episode], [51179, 1]);
    const r50 = await stale.api.identify(ctx37(50));
    check('第三季 P50 → Ⅲ 第1话', [r50.malId, r50.episode], [59193, 1]);
    const savedStale = JSON.parse(stale.store._bindings || '{}')['b:BV1KspF6iELH'] || {};
    checkTrue('补算出来的季链写回了 GM 存储（下次开页面就正常）',
      !!(savedStale.seasonChain && savedStale.seasonChain.seasons && savedStale.seasonChain.seasons.length === 3),
      savedStale.seasonChain && savedStale.seasonChain.seasons && savedStale.seasonChain.seasons.length);

    /* 季链是「按分P标题的季标记 + 累计话数」对齐的，跟拿哪一条当锚点无关 ——
     * 这正是自动补链能救回一条「绑错的旧绑定」的原因。 */
    const chainFromII = await stale.api.api_.buildSeasonChain(
      146065, 63, ctx37(1), '無職転生Ⅱ ～異世界行ったら本気だす～', null, '無職転生Ⅱ ～異世界行ったら本気だす～');
    const hitII = chainFromII ? stale.api.api_.mapBySeasonChain(chainFromII, 1) : null;
    check('拿第二季当锚点算出来的季链，P1 照样落在 Ⅰ',
      hitII ? [hitII.malId, hitII.ep] : 'no-chain', [39535, 1]);

    /* 绑定第一季、正在看第一季 —— 没有季链也必须照常跳（不能误伤） */
    const fine = makeEnv({
      store: {
        autoDetect: 'off',
        _bindings: JSON.stringify({
          'b:BV1KspF6iELH': {
            anilistId: 108465, malId: 39535, title: '無職転生 ～異世界行ったら本気だす～',
            episodes: 11, anchorPage: 1, anchorEp: 1, seasonChain: null, t: 1
          }
        })
      },
      net: net37(), location: LOC37
    });
    await fine.api.rerun();
    const rOk = await fine.api.identify(ctx37(1));
    check('绑定第一季、正在看第一季第1话 → 照常跳（不许误判成错季）', [rOk.malId, rOk.episode], [39535, 1]);

    /* 纯函数：条目标题里的季序号 */
    const tsn = stale.api.api_.titleSeasonNo;
    check('条目标题季号：Ⅲ → 3',
      typeof tsn === 'function' ? tsn('無職転生Ⅲ ～異世界行ったら本気だす～') : 'no-fn', 3);
    check('条目标题季号：Ⅱ → 2',
      typeof tsn === 'function' ? tsn('無職転生Ⅱ ～異世界行ったら本気だす～') : 'no-fn', 2);
    check('条目标题季号：第2クール → 2',
      typeof tsn === 'function' ? tsn('無職転生 ～異世界行ったら本気だす～ 第2クール') : 'no-fn', 2);
    check('条目标题季号：第一季没有标记 → 0（认不出就不判，宁可不跳也不错跳）',
      typeof tsn === 'function' ? tsn('無職転生 ～異世界行ったら本気だす～') : 'no-fn', 0);
  }

  /* --- 38. 搜索列表：别让 Bangumi 桥的条目领跑，也别让第三季藏在滚动条下面（v0.4.7） ---
   * 用户第二条抱怨：「用无职转生搜索，搜不到第三季」。
   * 实测（2026-10 真实响应）：
   *   · AniList 直查「无职转生」只回 3 条 —— Ⅰ / Ⅱ第2クール / Ⅱ，**没有Ⅲ**；
   *   · 而「無職転生 ～異世界行ったら本気だす～」（Ⅰ 的标题）回 7 条，含Ⅲ；
   *   · 「無職転生Ⅱ ～…～」只回 2 条（Ⅱ 和 Ⅱ第2クール），Ⅰ 都不在里面。
   * 老实现把 via:'bangumi' 的条目整体排到最前，于是：
   *   ① 中文名经桥解析成Ⅰ时，桥带回来的 Ⅰ第2クール/Ⅲ… 反而排在直查第一条前面，
   *      「默认选中第一条」就选中了别的季；② 候选框 max-height:140px，
   *      Ⅲ 这类第 5 条以后的行要滚动才看得到 —— 用户直接认为「搜不到」。 */
  head('38. 搜索列表：直查在前 · 季族补全 · 候选条数提示（v0.4.7）');
  {
    const tick = async (n) => { for (let i = 0; i < (n || 80); i++) await Promise.resolve(); };
    const T38 = '【无职转生 第1-3季】4K超清未删减完整版（更至第三季14）';
    const P38 = [];
    for (let i = 1; i <= 23; i++) P38.push({ page: i, part: '第一季' + String(i).padStart(2, '0'), duration: 1950, cid: 5000 + i });
    P38.push({ page: 24, part: '第一季OVA', duration: 1945, cid: 5024 });
    for (let i = 0; i <= 24; i++) P38.push({ page: 25 + i, part: '第二季' + String(i).padStart(2, '0'), duration: 1950, cid: 5100 + i });
    for (let i = 1; i <= 14; i++) P38.push({ page: 49 + i, part: '第三季' + String(i).padStart(2, '0'), duration: 1948, cid: 5200 + i });
    const ctx38 = (page) => ({
      bvid: 'BV1KspF6iELH', aid: 778, cid: 5000 + page, page: page,
      owner: { mid: 2, name: '后宫补番' }, mainTitle: T38,
      partTitle: P38[page - 1].part, duration: P38[page - 1].duration,
      pubdate: 1791598437, videos: 63, pages: P38, season: null, seasonId: null,
      seasonTitle: null, seasonEpisodeTitle: '', incomplete: false
    });
    const mk = (id, mal, eps, native, year) => ({
      id, idMal: mal, episodes: eps, format: 'TV', startDate: { year }, synonyms: [],
      title: { native, romaji: native }
    });
    const LZ_I = mk(108465, 39535, 11, '無職転生 ～異世界行ったら本気だす～', 2021);
    const LZ_I2 = mk(127720, 45576, 12, '無職転生 ～異世界行ったら本気だす～ 第2クール', 2021);
    const LZ_II = mk(146065, 51179, 13, '無職転生Ⅱ ～異世界行ったら本気だす～', 2023);
    const LZ_II2 = mk(166873, 55888, 12, '無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール', 2024);
    const LZ_III = mk(178789, 59193, 14, '無職転生Ⅲ ～異世界行ったら本気だす～', 2026);
    const node = (m) => ({ id: m.id, idMal: m.idMal, episodes: m.episodes, format: 'TV', startDate: m.startDate, title: m.title });
    const edge = (type, m) => ({ relationType: type, node: node(m) });
    const withRel = (m, edges) => Object.assign({}, node(m), { relations: { edges: edges } });
    const REL38 = {
      108465: withRel(LZ_I, [edge('SEQUEL', LZ_I2)]),
      127720: withRel(LZ_I2, [edge('PREQUEL', LZ_I), edge('SEQUEL', LZ_II)]),
      146065: withRel(LZ_II, [edge('PREQUEL', LZ_I2), edge('SEQUEL', LZ_II2)]),
      166873: withRel(LZ_II2, [edge('PREQUEL', LZ_II), edge('SEQUEL', LZ_III)]),
      178789: withRel(LZ_III, [edge('PREQUEL', LZ_II2)])
    };
    /* AniList 对几个关键词的真实响应（顺序都是实测的原始顺序）。
     * 第二个关键词跟第一个不同是刻意的：脚本的搜索结果带 6 小时缓存，
     * 换一个没搜过的词才不会吃到上一个 env 的缓存。 */
    const AL_BY_Q = {
      '无职转生': [LZ_I, LZ_II2, LZ_II],
      '无职转生 第一季': [LZ_I, LZ_II2, LZ_II],
      '無職転生 ～異世界行ったら本気だす～': [LZ_I, LZ_I2, LZ_III, LZ_II, LZ_II2],
      '無職転生Ⅱ ～異世界行ったら本気だす～': [LZ_II, LZ_II2]
    };
    const BGM38 = {
      '无职转生': [{ id: 289094, name: '無職転生 ～異世界行ったら本気だす～', name_cn: '无职转生', date: '2021-01-11', eps: 11, platform: 'TV' }]
    };
    const net38 = (bridgeUp) => makeNet({
      'https://api.bgm.tv/v0/search/subjects': (req) => ({
        data: bridgeUp ? (BGM38[JSON.parse(req.data).keyword] || []) : []
      }),
      'https://graphql.anilist.co': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables && q.variables.id !== undefined) return { data: { Media: REL38[q.variables.id] || null } };
        return { data: { Page: { media: AL_BY_Q[q.variables.q] || [] } } };
      },
      'https://api.aniskip.com/v2/skip-times': (req) => {
        const m = /skip-times\/(\d+)\/(\d+)/.exec(req.url);
        return /^(39535|45576|51179|55888|59193)\//.test(m[1] + '/' + m[2])
          ? { found: true, results: [{ interval: { startTime: 70, endTime: 160 }, skipType: 'op', episodeLength: 1950 }] }
          : { found: false, results: [] };
      }
    });
    const LOC38 = { pathname: '/video/BV1KspF6iELH', search: '?p=1' };
    const openAndSearch = async (bridgeUp, q) => {
      const env = makeEnv({ store: { autoDetect: 'off' }, net: net38(bridgeUp), location: LOC38 });
      await env.api.rerun();
      const panel = openPanelVia(env, 'bind');
      const input = orNode(byClass('q'), 'input');
      input.value = q;
      orNode(panel.querySelector('.search'), 'button').dispatch('click');
      return { env, panel, input };
    };
    const rowsOf = (panel) => panel.querySelectorAll('.cand-item');
    const hasRow = (rows, mal) => rows.some((r) => r.textContent.indexOf('MAL ' + mal) >= 0);

    /* ① 桥活着、而且解析到了正确的第一季：直查结果必须领跑 */
    const up = await openAndSearch(true, '无职转生');
    await tick(60);
    const rowsUp = rowsOf(up.panel);
    checkTrue('候选第一条是用户搜的那个词的直查第一条（Ⅰ）',
      !!rowsUp[0] && rowsUp[0].textContent.indexOf('AniList 108465') >= 0,
      rowsUp.map((r) => (r.querySelector('.meta') || { textContent: '' }).textContent).join(' | ').slice(0, 160));
    checkTrue('桥带回来的条目仍然在（只是不领跑）', hasRow(rowsUp, 45576), rowsUp.length);
    const hint = up.panel.querySelector('.candhint');
    checkTrue('候选框给出「共几条」的提示（140px 的滚动框不提示就等于藏起来）',
      !!(hint && /共\s*\d+\s*条/.test(hint.textContent)), (hint && hint.textContent) || '(没有 .candhint)');
    await tick(200);
    orNode(up.panel.querySelector('.save'), 'button').dispatch('click');
    const savedUp = JSON.parse(up.env.store._bindings || '{}');
    const bindUp = savedUp[Object.keys(savedUp)[0]] || {};
    check('不点候选直接保存 → 绑的是第一季（不是被桥领跑的别的季）', bindUp.malId, 39535);

    /* ② 桥挂了（真机上 api.bgm.tv 常常拿不到）：直查只有 3 条、没有Ⅲ，
     *    季链算完必须把「同系列」的条目补进候选 —— 这才是「搜不到第三季」的解药 */
    const down = await openAndSearch(false, '无职转生 第一季');
    await tick(60);
    /* 0.4.7 起 searchByName 直接把结果放进 6 小时缓存；面板里的「季族补全」如果
     * 直接 push 同一个数组，缓存就被污染了（实测发现过一次：第二次搜索返回的列表里
     * 混进了 via:'chain' 的条目）。0.4.8 起搜索本身就用 via:'family' 补全同系列。 */
    const rawDown = await down.env.api.api_.searchByName('无职转生 第一季');
    checkTrue('搜索一回来就有第三季（family 补全，不依赖季链）',
      rawDown.some((m) => m.id === 178789 && m.via === 'family'), rawDown.map((m) => [m.id, m.via]));
    checkTrue('缓存里没有 via:"chain" 的条目（面板季族补全绝不污染缓存）',
      rawDown.every((m) => m.via !== 'chain'), rawDown.map((m) => m.via));
    await tick(240);
    const rowsAfter = rowsOf(down.panel);
    checkTrue('候选列表里也补上了第三季（Ⅲ）', hasRow(rowsAfter, 59193),
      rowsAfter.map((r) => (r.querySelector('.meta') || { textContent: '' }).textContent).join(' | ').slice(0, 200));
    checkTrue('第三季标着「同系列」来路（自动补全）',
      rowsAfter.some((r) => r.textContent.indexOf('MAL 59193') >= 0 && /同系列/.test(r.textContent)),
      rowsAfter.length + ' 条');
    checkTrue('候选里也补上了第一季第2クール', hasRow(rowsAfter, 45576), rowsAfter.length);
  }

  /* ==================================================================
   * 39. 起始跳过偏移：整段平移（UP 主在开头多加了片段）
   *
   * 需求原话：「缺乏起始跳过偏移功能（针对上传 up 主开头多加片段的情况）」。
   * 数据库的时间戳是按原片标的，UP 主在开头插了 N 秒，这一版里 OP/ED 整段
   * 都偏后 N 秒 —— 只挪落点（老的 skipOffset）治不了「起跳太早」。
   * ================================================================== */
  head('39. 起始跳过偏移：整段平移');
  {
    const OP = { type: 'op', start: 100, end: 190 };
    /* 拿不到 api 就返回空壳：对着旧版本跑时能看到完整失败清单，而不是崩在第一行 */
    const shiftWith = (shift, seg) => {
      const env = makeEnv({ store: { skipShift: shift } });
      const fn = env.api.api_.shiftSeg;
      if (typeof fn !== 'function') return {};
      return fn(seg || OP);
    };
    checkTrue('api_.shiftSeg 已导出（调试/测试入口）',
      typeof makeEnv().api.api_.shiftSeg === 'function');

    const s15 = shiftWith(15);
    check('平移 +15：起点 +15', s15.start, 115);
    check('平移 +15：落点 +15', s15.end, 205);
    check('平移 0（默认）→ 原样返回，不做无谓拷贝', shiftWith(0) === OP, true);
    check('-120 会被配置夹成 -30', shiftWith(-120).start, 70);
    const neg = shiftWith(-30, { type: 'op', start: 10, end: 40 });
    check('负平移越过片头 → 起点夹到 0', neg.start, 0);
    check('负平移越过片头 → 落点保住片段长度', neg.end, 10);

    const mkVideo = (o) => Object.assign({
      currentTime: 0, duration: 1500, paused: false, ended: false,
      play() { this.paused = false; },
      addEventListener() {}, getBoundingClientRect: () => ({ width: 800, height: 450 })
    }, o);

    /* 端到端：数据库说 OP 是 100–190，这一版实际晚了 20 秒（真实区间 120–210） */
    const v = mkVideo({ currentTime: 105 });   // 旧实现眼里「已经进了 OP」
    const e = makeEnv({ store: { autoDetect: 'auto', skipShift: 20 }, video: v });
    e.api._runtime.result = { ok: true, segments: [OP] };
    e.api._runtime.video = v;
    e.api._checkOnce();
    check('平移之后 105 秒不跳（旧实现这里就跳了）', v.currentTime, 105);
    v.currentTime = 125;
    e.api._checkOnce();
    check('进入平移后的区间才跳，落点 210+ε', Math.round(v.currentTime * 100) / 100, 210.06);

    const v2 = mkVideo({ currentTime: 130 });
    const e2 = makeEnv({ store: { autoDetect: 'auto', skipShift: 20 }, video: v2 });
    e2.api._runtime.result = { ok: true, segments: [OP] };
    e2.api._runtime.video = v2;
    e2.api._checkOnce();
    const toast = byClass('toast');
    checkTrue('跳过提示写明「整体 +20s」', !!toast && /整体 \+20s/.test(toast.textContent),
      (toast && toast.textContent) || '(没有 toast)');

    check('新装默认：整段平移 0 秒', makeEnv().api.api_.getConfig().skipShift, 0);
  }

  /* ==================================================================
   * 40. 胶囊可收起（收起后只剩一颗状态色圆点）
   * ================================================================== */
  head('40. 胶囊可收起');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    env.api._runtime.ctx = { bvid: 'BV1TEST00001' };
    env.api._runtime.result = { ok: false, reason: 'autodetect-off' };
    const render = env.api._renderPill;
    checkTrue('调试入口 _renderPill 能用', typeof render === 'function');
    if (typeof render === 'function') render();

    const pill = byClass('pill');
    checkTrue('展开态：有「收起」按钮', !!(pill && pill.querySelector('[data-a=collapse]')));
    orNode(pill && pill.querySelector('[data-a=collapse]'), 'span').click();

    const mini = byClass('pill');
    checkTrue('收起后是 mini 胶囊（只剩圆点）', !!(mini && /mini/.test(mini.className)));
    check('收起后不再显示「绑定/改/⚙」等文字', mini && /绑定|改|⚙/.test(mini.textContent), false);
    check('收起状态写进 GM 配置', env.store.pillCollapsed, true);

    orNode(mini, 'div').click();
    const back = byClass('pill');
    checkTrue('点圆点展开', !!(back && !/mini/.test(back.className)));
    check('展开写回 GM（收起被清掉）', env.store.pillCollapsed, false);
  }

  /* ==================================================================
   * 41. 网页全屏：胶囊整个隐藏（连圆点都不留），退出后恢复 —— 自带行为，不是开关
   * ================================================================== */
  head('41. 网页全屏不挡视频');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    env.api._runtime.ctx = { bvid: 'BV1TEST00001' };
    env.api._runtime.result = { ok: false, reason: 'autodetect-off' };
    const apply = env.api._applyScreen;
    checkTrue('调试入口 _applyScreen 能用', typeof apply === 'function');
    const applyFn = (typeof apply === 'function') ? apply : (() => {});
    const detectFn = env.api.api_.detectScreen;
    checkTrue('api_.detectScreen 已导出', typeof detectFn === 'function');
    const detect = (typeof detectFn === 'function') ? detectFn : (() => 'normal');

    // 先渲染出一个胶囊，拿到它的挂载点（uiRoot），好断言「全屏时这里不再有胶囊」
    if (typeof env.api._renderPill === 'function') env.api._renderPill();
    const pill0 = byClass('pill');
    const root = (pill0 && pill0.parentNode) || el('div');
    checkTrue('初始（普通模式）有胶囊', !!(root && root.querySelector('.pill')));

    const player = el('div'); player.className = 'bpx-player-container';
    env.body.appendChild(player);
    check('默认是普通模式', detect(), 'normal');
    player.setAttribute('data-screen', 'web');
    check('detectScreen 认出网页全屏', detect(), 'web');

    applyFn();
    checkTrue('网页全屏下胶囊整个隐藏（连圆点都不留）', !(root.querySelector('.pill')));
    check('全屏隐藏不写进用户偏好', env.store.pillCollapsed, undefined);

    player.setAttribute('data-screen', 'normal');
    applyFn();
    checkTrue('退出全屏胶囊恢复显示', !!(root.querySelector('.pill')));
  }

  /* ==================================================================
   * 42. 自动切下一集（默认关；ED 跳完就切；开关在设置面板里）
   * ================================================================== */
  head('42. 自动切下一集');
  {
    const mkNext = (env) => {
      const b = el('button'); b.className = 'bpx-player-ctrl-next';
      b.disabled = false; b.clicked = 0;
      b.addEventListener('click', () => { b.clicked++; });
      env.body.appendChild(b);
      return b;
    };
    const mkVideo = (o) => Object.assign({
      currentTime: 95, duration: 120, paused: false, ended: false,
      play() { this.paused = false; },
      addEventListener() {}, getBoundingClientRect: () => ({ width: 800, height: 450 })
    }, o);
    const ED = { type: 'ed', start: 90, end: 100 };

    /* ① 默认关：ED 跳完不切 */
    const off = makeEnv({ store: { autoDetect: 'off' } });
    const b1 = mkNext(off);
    off.api._runtime.video = mkVideo();
    off.api._runtime.result = { ok: true, segments: [ED] };
    off.api._skipNow();
    check('默认关：ED 跳完不切下一集', b1.clicked, 0);

    /* ② 开启后：ED 跳完切一次（播放器自带的下一集按钮） */
    const on = makeEnv({ store: { autoDetect: 'off', autoNext: true, cfgVersion: 4 } });
    const b2 = mkNext(on);
    on.api._runtime.video = mkVideo();
    on.api._runtime.result = { ok: true, segments: [ED] };
    on.api._skipNow();
    check('开启后：ED 跳完切一次', b2.clicked, 1);

    /* ③ 不是 ED（比如 OP）不切 */
    const onOp = makeEnv({ store: { autoDetect: 'off', autoNext: true, cfgVersion: 4 } });
    const bOp = mkNext(onOp);
    onOp.api._runtime.video = mkVideo({ currentTime: 10 });
    onOp.api._runtime.result = { ok: true, segments: [{ type: 'op', start: 5, end: 40 }] };
    onOp.api._skipNow();
    check('OP 跳完不切下一集', bOp.clicked, 0);

    /* ④ 没有下一集按钮 → 多分P退化成改 ?p= */
    const loc3 = { pathname: '/video/BV1TEST00001', search: '?p=1', href: 'https://www.bilibili.com/video/BV1TEST00001?p=1' };
    const mp = makeEnv({ store: { autoNext: true, cfgVersion: 4 }, location: loc3 });
    mp.api._runtime.video = mkVideo();
    mp.api._runtime.ctx = { bvid: 'BV1TEST00001', page: 1, pages: [1, 2, 3] };
    mp.api._runtime.result = { ok: true, segments: [ED] };
    mp.api._skipNow();
    check('多分P：切到 ?p=2', /p=2/.test(loc3.href), true);

    /* ⑤ 同一集只切一次（goNextEpisode 自己的去重） */
    const g = makeEnv({});
    const b3 = mkNext(g);
    const goNext = g.api.api_.goNextEpisode;
    checkTrue('api_.goNextEpisode 已导出', typeof goNext === 'function');
    const gnext = (typeof goNext === 'function') ? goNext : (() => false);
    check('第一次切成功', gnext(), true);
    check('第二次被挡住', gnext(), false);
    check('按钮只被点了 1 次', b3.clicked, 1);

    /* ⑥ 开关进了设置面板（不再摆胶囊上）：勾上保存 → autoNext 开 */
    const s = makeEnv({ store: { autoDetect: 'off' }, location: { pathname: '/video/BV1jfDYBSEKs', search: '?p=1' } });
    const sp = openPanelVia(s, 'settings');
    const anBox = sp.querySelector('.autonext');
    checkTrue('设置面板有「自动切下一集」开关', !!anBox);
    check('默认关：开关未勾选', anBox && anBox.checked, false);
    orNode(anBox, 'input').checked = true;
    orNode(sp.querySelector('.save'), 'button').dispatch('click');
    check('勾上保存 → autoNext 开', s.store.autoNext, true);

    check('新装默认：autoNext 关', makeEnv().api.api_.getConfig().autoNext, false);
  }

  /* ==================================================================
   * 44. 中文名直查只有 3 条时，搜索一回来就有第三季（不依赖季链）
   *     另外：请求全失败时不得把「没结果」写进缓存。
   * ================================================================== */
  head('44. 中文名搜索立刻补全同系列（第三季）');
  {
    const mk = (id, mal, eps, native, year) => ({
      id, idMal: mal, episodes: eps, format: 'TV', startDate: { year }, synonyms: [],
      title: { native, romaji: native }
    });
    const I = mk(108465, 39535, 11, '無職転生 ～異世界行ったら本気だす～', 2021);
    const I2 = mk(127720, 45576, 12, '無職転生 ～異世界行ったら本気だす～ 第2クール', 2021);
    const II = mk(146065, 51179, 13, '無職転生Ⅱ ～異世界行ったら本気だす～', 2023);
    const II2 = mk(166873, 55888, 12, '無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール', 2024);
    const III = mk(178789, 59193, 14, '無職転生Ⅲ ～異世界行ったら本気だす～', 2026);
    const node = (m) => ({ id: m.id, idMal: m.idMal, episodes: m.episodes, format: 'TV', startDate: m.startDate, title: m.title });
    const edge = (t, m) => ({ relationType: t, node: node(m) });
    const REL = {
      108465: Object.assign({}, node(I), { relations: { edges: [edge('SEQUEL', I2)] } }),
      166873: Object.assign({}, node(II2), { relations: { edges: [edge('PREQUEL', II), edge('SEQUEL', III)] } })
    };
    const net = makeNet({
      'https://graphql.anilist.co': (req) => {
        const q = JSON.parse(req.data);
        if (q.variables && q.variables.id !== undefined) return { data: { Media: REL[q.variables.id] || null } };
        return { data: { Page: { media: q.variables.q === '无职转生' ? [I, II2, II] : [] } } };
      }
    });

    const env = makeEnv({ net });
    const list = await env.api.api_.searchByName('无职转生');
    checkTrue('搜索一回来就有第三季（Ⅲ）', list.some((m) => m.id === 178789), list.map((m) => m.id));
    const third = list.find((m) => m.id === 178789);
    check('第三季标着「同系列」来路', third && third.via, 'family');
    check('第一季第2クール也被补上', list.some((m) => m.id === 127720), true);
    check('直查的条目仍然在前（Ⅰ 领跑）', list[0] && list[0].id, 108465);

    /* 全失败 → 不得缓存「没结果」 */
    const dead = makeEnv({ net: makeNet({}), netFail: () => 'error' });
    await dead.api.api_.searchByName('无职转生');
    dead.api._flushCache();
    const cached = JSON.parse(dead.store._cache || '{}');
    check('请求全失败不写缓存（下次会重新请求）', 'ui:无职转生' in cached, false);
  }

  /* ==================================================================
   * 45. 失败原因可辨（限流 / 超时 / 网络不通），不再笼统一句「稍后重试」
   * ================================================================== */
  head('45. 网络失败原因可见');
  {
    const lbl = (kinds) => {
      const env = makeEnv({ store: { autoDetect: 'off' } });
      env.api._runtime.ctx = { bvid: 'BV1TEST00001' };
      env.api._runtime.result = { ok: false, reason: 'net-error' };
      env.api._runtime.netFail = { kinds: kinds, sources: [], at: 1 };
      if (typeof env.api._renderPill === 'function') env.api._renderPill();
      return (byClass('pill') || { textContent: '' }).textContent;
    };
    checkTrue('限流(429) → 胶囊写「限流」', /限流/.test(lbl({ 'http-429': 1 })), lbl({ 'http-429': 1 }));
    checkTrue('超时 → 胶囊写「超时」', /超时/.test(lbl({ timeout: 1 })), lbl({ timeout: 1 }));
    checkTrue('网络不通 → 胶囊写「网络不通」', /网络不通/.test(lbl({ network: 1 })), lbl({ network: 1 }));

    /* 端到端：AniList 被限流(429)，原因要带着 source 记进 runtime.netFail */
    const env = makeEnv({
      net: makeNet({}),
      netFail: (req) => (req.url.indexOf('graphql.anilist.co') >= 0 ? { status: 429 } : 'error')
    });
    await env.api.api_.searchByName('无职转生');
    const nf = env.api._runtime.netFail;
    checkTrue('429 记进 runtime.netFail.kinds', !!(nf && nf.kinds && nf.kinds['http-429']),
      JSON.stringify(nf && nf.kinds));
    checkTrue('失败来源记进 sources（anilist）', !!(nf && nf.sources && nf.sources.indexOf('anilist') >= 0),
      JSON.stringify(nf && nf.sources));
  }

  /* ==================================================================
   * 46. 「未识别时也显示胶囊」改成设置里的「隐藏胶囊（普通视频）」
   * ================================================================== */
  head('46. 隐藏胶囊（普通视频）');
  {
    /* ① 默认（显示胶囊）：设置里的「隐藏胶囊」未勾选 */
    const env = makeEnv({ store: { autoDetect: 'off' }, location: { pathname: '/video/BV1jfDYBSEKs', search: '?p=1' } });
    const sp = openPanelVia(env, 'settings');
    const hideBox = sp.querySelector('.hide');
    checkTrue('设置面板有「隐藏胶囊」开关', !!hideBox);
    check('默认不隐藏：开关未勾选', hideBox && hideBox.checked, false);

    /* ② 勾上保存 → showIdlePill 关（普通视频不再渲染胶囊） */
    orNode(hideBox, 'input').checked = true;
    orNode(sp.querySelector('.save'), 'button').dispatch('click');
    check('勾上保存 → showIdlePill 关', env.store.showIdlePill, false);

    /* ③ 再次打开设置：开关反映「已隐藏」；取消勾选保存 → 恢复显示 */
    const sp2 = openPanelVia(env, 'settings');
    const hideBox2 = sp2.querySelector('.hide');
    check('再打开：开关反映已隐藏（勾选）', hideBox2 && hideBox2.checked, true);
    orNode(hideBox2, 'input').checked = false;
    orNode(sp2.querySelector('.save'), 'button').dispatch('click');
    check('取消勾选保存 → showIdlePill 开', env.store.showIdlePill, true);

    check('新装默认：不隐藏（showIdlePill 开）', makeEnv().api.api_.getConfig().showIdlePill, true);

    /* ④ 收起成圆点后，「隐藏胶囊」照样把普通视频的圆点也藏掉 */
    const c = makeEnv({ store: { autoDetect: 'off', showIdlePill: false, pillCollapsed: true, cfgVersion: 4 } });
    // 先渲染一个「识别成功」的圆点拿到挂载点（识别成功不受「隐藏胶囊」影响，圆点该显示）
    c.api._runtime.ctx = { bvid: 'BV1TEST00001' };
    c.api._runtime.result = { ok: true, title: '无职转生', episode: 1, autoSkip: false, segments: [{ type: 'op', start: 5, end: 40 }] };
    if (typeof c.api._renderPill === 'function') c.api._renderPill();
    const mini0 = byClass('pill');
    const root = (mini0 && mini0.parentNode) || el('div');
    checkTrue('识别成功 + 收起 → 显示 mini 圆点', !!(root.querySelector('.pill')));
    // 切到普通视频（autodetect-off）再渲染 → 圆点也被藏掉
    c.api._runtime.result = { ok: false, reason: 'autodetect-off' };
    if (typeof c.api._renderPill === 'function') c.api._renderPill();
    checkTrue('普通视频 + 隐藏胶囊 + 收起 → 连圆点都不显示', !(root.querySelector('.pill')));
  }

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
      check('老 ed（只有 hash）归一为 pending', !!(v.eds[0] && v.eds[0].start === 0 && v.eds[0].end === -1), true);
      check('pending op（end=-1）保留', validate({ ops: [{ hash: 'p', start: 3, end: -1 }], eds: [] }).ops.length, 1);
      check('非对象输入 → 空', validate(null).ops.length, 0);
      const ve = validate({ ops: [], eds: [{ hash: 'e2', start: 1300.5, end: 1400.25 }] });
      check('ed start 保留', ve.eds[0] && ve.eds[0].start, 1300.5);
      check('ed end 保留', ve.eds[0] && ve.eds[0].end, 1400.25);
      check('坏 ed（hash 非串）丢弃', validate({ ops: [], eds: [{ hash: 5 }] }).eds.length, 0);
    }
    if (typeof save === 'function' && typeof load === 'function') {
      save('b:BV1', { ops: [{ hash: 'abc', start: 0, end: 90 }], eds: [{ hash: 'ed1' }] });
      const l = load('b:BV1');
      check('save 后 load 回来 op', l.ops.length, 1);
      check('save 后 load 回来 ed', l.eds.length, 1);
      check('没存过的 key → 空', load('b:NOPE').ops.length, 0);
    }
  }

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
      // pending OP（end<start）不参与匹配
      const segsP = { ops: [{ hash: '0000', start: 0, end: -1 }], eds: [] };
      const m4 = { target: null, hits: 0 };
      frameStep(m4, segsP, H, 0, 1400);
      check('pending OP 不参与匹配 → 无目标', m4.target, null);
      check('pending OP 不参与匹配 → 不计数', m4.hits, 0);
    }
  }

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
      check('网络失败但已绑定 + 本地有 → 用', shouldUse({ ok: false, netFailed: true, bindingKey: 'b:x' }, good), true);
      check('网络失败但无绑定 → 不用', shouldUse({ ok: false, netFailed: true, segments: [] }, good), false);
    }
  }

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

  head('47h. 检测循环：syncFrameMonitor 启停');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    const sync = env.api._syncFrameMonitor;
    const save = hook(env, 'saveLocalSegs');
    checkTrue('api._syncFrameMonitor 已导出', typeof sync === 'function');
    if (typeof sync === 'function' && typeof save === 'function') {
      save('b:x', { ops: [{ hash: 'h', start: 0, end: 90 }], eds: [] });
      const before = env.intervals.length;
      sync({ ok: true, bindingKey: 'b:x', segments: [] });
      check('云端空 + 本地有 → 开抽帧', env.intervals.length, before + 1);
      check('抽帧间隔 250ms', env.intervals[env.intervals.length - 1].ms, 250);
      check('localSegs 已挂', !!(env.api._runtime.localSegs && env.api._runtime.localSegs.ops.length), true);
      const timerId = env.api._runtime.frameTimer;
      sync({ ok: true, bindingKey: 'b:x', segments: [{ type: 'op' }] });
      check('云端有段 → 停抽帧', env.cleared.indexOf(timerId) !== -1, true);
      check('localSegs 清空', env.api._runtime.localSegs, null);
    }
  }

  head('47i. 抽帧路径：防连跳（同一指纹只跳一次）');
  {
    const Z = new Array(65).join('0');          // 64 位全 0：标记帧
    const O = new Array(65).join('1');          // 与 Z 距离 64 → 一定不命中
    const Z2 = new Array(64).join('0') + '1';   // 与 Z 距离 1 → 同一帧也算命中
    const realNow = Date.now;

    /* 驱动抽帧：时钟每次取样 +250ms（= FRAME_SAMPLE_MS）。
     * 只有 currentTime ∈ [5, windowEnd] 的画面像标记帧，其余帧完全不像。
     * 关键点：抽帧周期 250ms > 冷却 160ms，所以冷却挡不住连跳。 */
    const setup = (opts) => {
      const env = makeEnv({ store: Object.assign({ autoDetect: 'off' }, opts.store || {}) });
      const apply = hook(env, 'applyFrameHash');
      const rt = env.api._runtime;
      let now = 1000000;
      Date.now = () => (now += 250);
      const v = { currentTime: 5, duration: 1400, paused: false, ended: false,
        play() { this.paused = false; }, addEventListener() {} };
      rt.video = v; rt.result = { ok: true, segments: [] };
      rt.frameMatcher = { target: null, hits: 0 };
      rt.lastSkipAt = 0; rt.skipped = {};
      rt.localSegs = { ops: [{ hash: opts.hash || Z, start: 0, end: opts.opDur }], eds: [] };
      const feed = (n, windowEnd) => {
        const seen = [];
        for (let i = 0; i < n; i++) {
          const similar = v.currentTime >= 5 && v.currentTime <= windowEnd;
          apply(similar ? Z : O, v);
          seen.push(v.currentTime);
        }
        return seen;
      };
      return {
        env, rt, v, apply, feed, bump: (ms) => { now += ms; },
        jumps: (seen) => seen.filter((t, i) => i && t !== seen[i - 1]).length
      };
    };

    // 1) 相对时长只有 1 秒（标歪了）：修之前会连跳 5 次
    {
      const s = setup({ opDur: 1 });
      const seen = s.feed(16, 10);
      check('短标记不再连跳：只跳 1 次', s.jumps(seen), 1);
      check('短标记落点 = 检测点 + 1s', Math.round(seen[1] * 100) / 100, 6.06);
      Date.now = realNow;
    }

    // 2) 相对时长 20 秒 + 跳过偏移 -30（落点被 floor 推回「起点 + 1 秒」）：修之前连跳 6 次
    {
      const s = setup({ opDur: 20, store: { skipOffset: -30 } });
      const seen = s.feed(16, 10);
      check('负偏移不再连跳：只跳 1 次', s.jumps(seen), 1);
      Date.now = realNow;
    }

    // 3) 去重键必须按「指纹」而不是「检测时刻」：隔一分钟同样的画面再出现也不跳
    {
      const s = setup({ opDur: 1 });
      const seen = s.feed(2, 10);
      check('第一次认到就跳走', Math.round(seen[1] * 100) / 100, 6.06);
      s.bump(60000);                       // 静默窗口早过了，只剩「指纹去重」在挡
      s.feed(2, 10);
      check('同一指纹再次出现不再跳', Math.round(s.v.currentTime * 100) / 100, 6.06);
      Date.now = realNow;
    }

    // 4) 静默窗口：刚跳完 3 秒内，连另一个没跳过的指纹也不认
    {
      const s = setup({ opDur: 1 });
      s.feed(2, 10);                       // 先跳一次
      s.rt.localSegs = { ops: [{ hash: Z2, start: 0, end: 90 }], eds: [] };
      const held = Math.round(s.v.currentTime * 100) / 100;
      s.feed(2, 10);                       // 500ms 后：静默窗口内 → 不跳
      check('静默窗口内不认新指纹', Math.round(s.v.currentTime * 100) / 100, held);
      s.bump(4000);                        // 窗口过去
      s.feed(2, 10);
      check('静默窗口过后才认', s.v.currentTime > held, true);
      Date.now = realNow;
    }

    // 5) 标记重新加载 → 指纹去重清掉（改完标记不用重开视频）
    {
      const s = setup({ opDur: 1 });
      const save = hook(s.env, 'saveLocalSegs');
      save('b:x', { ops: [{ hash: Z, start: 0, end: 1 }], eds: [] });
      s.feed(2, 10);
      const first = s.v.currentTime;
      s.env.api._syncFrameMonitor({ ok: true, bindingKey: 'b:x', segments: [] });
      s.bump(4000);
      s.feed(2, 10);
      check('标记重新加载后指纹可以再跳', s.v.currentTime > first, true);
      Date.now = realNow;
    }
  }

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
      // 原型链键（'constructor' 等）不能被当成数组列表用
      // 注意：这里必须把调用本身包进 try —— 否则抛出的 TypeError 会直接崩掉整个测试进程，
      // 而不是被 checkTrue 报成一条失败。
      let threwProto = false;
      let protoOut = null;
      try { protoOut = rm(src, 'constructor', 0); } catch (e) { threwProto = true; }
      checkTrue('原型链键不抛错', !threwProto, true);
      check('原型链键不动数据', protoOut === null ? -1 : protoOut.ops.length, 2);
      // 索引必须是整数：NaN / 小数以前会悄悄删掉第 0 条
      check('NaN 索引不动数据', rm(src, 'ops', NaN).ops.length, 2);
      check('小数索引不动数据', rm(src, 'ops', 0.5).ops.length, 2);
      check('字符串索引不动数据', rm(src, 'ops', '0').ops.length, 2);
    }
  }

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

  head('48d. 工具条渲染：标记模式进出 + 结构');
  {
    const BIND = { title: '葬送のフリーレン', episodes: 28, anchorPage: 1 };
    const env = makeEnv({
      store: { autoDetect: 'off', _bindings: JSON.stringify({ 'b:BV_TEST000001': BIND }) }
    });
    const toggle = env.api._markToggle;
    const save = hook(env, 'saveLocalSegs');
    checkTrue('api._markToggle 已导出', typeof toggle === 'function');
    checkTrue('api_.saveLocalSegs 已导出', typeof save === 'function');
    if (typeof toggle === 'function' && typeof save === 'function') {
      env.api._runtime.ctx = ctxOf('BV_TEST000001', 1);
      save('b:BV_TEST000001', {
        ops: [{ hash: 'aaaa', start: 12, end: 102 }],
        eds: [{ hash: 'bbbb', start: 1300, end: -1 }]
      });
      check('初始不在标记模式', env.api._runtime.markOn, false);
      toggle();
      check('进入标记模式', env.api._runtime.markOn, true);
      const host = env.api._markHost ? env.api._markHost() : null;
      const root = (host && host.shadowRoot) || null;
      const rootOk = !!(root && root.querySelector('.mkbar'));
      checkTrue('工具条已画出', rootOk, true);
      const bar = rootOk ? root.querySelector('.mkbar') : el('div');
      check('标记按钮至少 4 个（含清空是 5 个）', bar.querySelectorAll('.mkbtn').length >= 4, true);
      checkTrue('有「清空本番标记」按钮', !!bar.querySelector('[data-mk=clr]'));
      check('状态行显示套数', /已标 OP 1 套 \/ ED 1 套/.test((rootOk ? root.querySelector('.mkstat') : el('div')).textContent), true);
      check('列表 2 行', rootOk ? root.querySelectorAll('.mkrow').length : -1, 2);
      check('ED 未标结束显示 ——', /ED.*——/.test((rootOk ? root.querySelector('.mklist') : el('div')).textContent), true);
      toggle();
      check('退出标记模式', env.api._runtime.markOn, false);
      checkTrue('退出后工具条清空', !(rootOk ? root.querySelector('.mkbar') : null));
      check('标记模式状态落盘', env.store._markOn, false);
    }
  }

  head('48d2. 工具条点 ✕ 删单条（含过期节点防护）');
  {
    const env = makeEnv({
      store: { autoDetect: 'off', _bindings: JSON.stringify({ 'b:BV_TEST000001': { title: 'T', episodes: 28, anchorPage: 1 } }) }
    });
    env.api._runtime.ctx = ctxOf('BV_TEST000001', 1);
    const save = hook(env, 'saveLocalSegs');
    const toastN = () => CREATED.filter((n) => String(n._attrs.class || '').split(/\s+/).indexOf('toast') >= 0).length;
    /* 存的值可能是对象也可能是字符串（真机上 GM_setValue 自己序列化，harness 里是裸对象） */
    const opsOf = () => {
      const v = env.store['aniskip.localSegs.b:BV_TEST000001'];
      const segs = !v ? {} : (typeof v === 'string' ? JSON.parse(v) : v);
      return segs.ops || [];
    };
    const toggle = env.api._markToggle;
    checkTrue('api._markToggle 已导出', typeof toggle === 'function');
    checkTrue('api_.saveLocalSegs 已导出', typeof save === 'function');
    if (typeof toggle === 'function' && typeof save === 'function') {
      save('b:BV_TEST000001', {
        ops: [{ hash: 'h1', start: 10, end: 90 }, { hash: 'h2', start: 100, end: 190 }],
        eds: []
      });
      toggle();
      const root = env.api._markHost().shadowRoot;
      const rows = root.querySelectorAll('.mkrow');
      check('两行标记', rows.length, 2);
      const staleDel = rows[0].querySelector('.mkdel');
      const t0 = toastN();
      staleDel.click();
      check('点 ✕ 删掉一条', opsOf().length, 1);
      check('删掉的是第一行那条', opsOf()[0].hash, 'h2');
      check('列表就地刷新为 1 行', root.querySelectorAll('.mkrow').length, 1);
      checkTrue('正常删除会提示', toastN() > t0);
      /* 列表已重画，这个 ✕ 节点已经过期：索引仍指向第 0 条，但那里的标记已经换成 h2。
       * 必须什么都不做 —— 既不误删别的标记，也不假报「已删掉」。 */
      const t1 = toastN();
      staleDel.click();
      check('过期 ✕ 不误删别的标记', opsOf().length, 1);
      check('过期 ✕ 不误报成功', toastN(), t1);
      toggle();
    }
  }

  head('48e. 工具条按钮：标记动作 + 清空');
  {
    const env = makeEnv({
      store: { autoDetect: 'off', _bindings: JSON.stringify({ 'b:BV_TEST000001': { title: 'T', episodes: 28, anchorPage: 1 } }) }
    });
    env.api._runtime.ctx = ctxOf('BV_TEST000001', 1);
    env.api._runtime.video = { currentTime: 77, duration: 1400, paused: true, ended: false,
      play() {}, addEventListener() {} };
    /* harness 的 GM_setValue 存裸对象，真机由油猴自己序列化 —— 两种都要能读 */
    const segsOf = () => {
      const v = env.store['aniskip.localSegs.b:BV_TEST000001'];
      return !v ? {} : (typeof v === 'string' ? JSON.parse(v) : v);
    };
    const opsOf = () => segsOf().ops || [];
    const toggle = env.api._markToggle;
    checkTrue('api._markToggle 已导出', typeof toggle === 'function');
    if (typeof toggle === 'function') {
      toggle();
      const root = env.api._markHost().shadowRoot;
      const opStart = root.querySelector('[data-mk=op-s]');
      const clr = root.querySelector('[data-mk=clr]');
      checkTrue('找得到「标 OP 开始」', !!opStart);
      checkTrue('找得到「清空本番标记」', !!clr);
      opStart.dispatch('click', {});
      checkTrue('标 OP 开始 已挂监听', (opStart._listeners.click || []).length > 0);
      check('抓不到画面时不写脏数据', opsOf().length, 0);
      const save = hook(env, 'saveLocalSegs');
      save('b:BV_TEST000001', { ops: [{ hash: 'h', start: 10, end: -1 }], eds: [] });
      env.api._renderMark();
      const r2 = env.api._markHost().shadowRoot;
      r2.querySelector('[data-mk=op-e]').dispatch('click', {});
      const after = opsOf();
      check('标 OP 结束 补上 end', after.length ? after[0].end : -1, 77);
      check('列表即时刷新（显示 77s）', /77s/.test(r2.querySelector('.mklist').textContent), true);
      r2.querySelector('[data-mk=clr]').dispatch('click', {});
      check('清空本番标记', env.store['aniskip.localSegs.b:BV_TEST000001'], undefined);
      check('清空后列表显示「还没标过」', /还没标过/.test(r2.querySelector('.mklist').textContent), true);
      toggle();
    }
  }

  head('48f. 胶囊 🎯 入口');
  {
    const env = makeEnv({ store: { autoDetect: 'off' } });
    env.api._runtime.ctx = ctxOf('BV_TEST000001', 1);
    env.api._runtime.result = { ok: false, reason: 'no-match' };
    env.api._renderPill();
    const pill = byClass('pill');
    checkTrue('胶囊渲染出来了', !!pill);
    const act = pill && pill.querySelector('[data-a=mark]');
    checkTrue('胶囊上有 🎯 标记入口', !!act);
    if (act) {
      checkTrue('🎯 有 click 监听', (act._listeners.click || []).length > 0);
      act.dispatch('click', {});
      check('点一下进标记模式', env.api._runtime.markOn, true);
      check('状态落盘', env.store._markOn, true);
      act.dispatch('click', {});
      check('再点一下退出', env.api._runtime.markOn, false);
      check('退出后状态也落盘', env.store._markOn, false);
    }
  }

  head('48h. 全屏重挂 + 工具条拖动');
  {
    const env = makeEnv({
      store: { autoDetect: 'off', _bindings: JSON.stringify({ 'b:BV_TEST000001': { title: 'T', episodes: 28, anchorPage: 1 } }) }
    });
    env.api._runtime.ctx = ctxOf('BV_TEST000001', 1);
    const toggle = env.api._markToggle;
    const applyScreen = env.api._applyScreen;
    checkTrue('api._applyScreen 已导出', typeof applyScreen === 'function');
    if (typeof toggle === 'function' && typeof applyScreen === 'function') {
      toggle();
      const host = env.api._markHost();
      checkTrue('工具条已画出', !!(host && host.shadowRoot.querySelector('.mkbar')));
      /* 真全屏只渲染全屏子树：挂在 body 上的 host 必须重新挂进全屏元素 */
      const fullEl = el('div');
      env.doc.fullscreenElement = fullEl;
      applyScreen();
      checkTrue('全屏时 host 重新挂进全屏元素', host.parentNode === fullEl);
      env.doc.fullscreenElement = null;
      applyScreen();
      checkTrue('退出全屏后不再挂在全屏元素里', host.parentNode !== fullEl);
      /* 拖动：位移到 4px 才算拖，松手才落盘 */
      const bar = host.shadowRoot.querySelector('.mkbar');
      bar.getBoundingClientRect = () => ({ left: 100, top: 200, width: 300, height: 180 });
      bar.dispatch('mousedown', { clientX: 110, clientY: 210 });
      env.win.dispatch('mousemove', { clientX: 111, clientY: 211 });
      check('位移 <4px 不算拖动（没写样式）', bar.style.left || '未写', '未写');
      check('位移 <4px 不算拖动（不落盘）', env.store._markPos, undefined);
      env.win.dispatch('mousemove', { clientX: 160, clientY: 250 });
      check('拖动中 left = 起点 + 位移', Math.round(parseInt(bar.style.left, 10)), 150);
      check('拖动中 top = 起点 + 位移', Math.round(parseInt(bar.style.top, 10)), 240);
      env.win.dispatch('mouseup', {});
      check('松手后位置落盘', env.store._markPos && env.store._markPos.left, 150);
      /* 换集 / 识别完成后胶囊重画 —— 工具条状态行必须跟着刷新，不能停在「未绑定」 */
      const save = hook(env, 'saveLocalSegs');
      save('b:BV_TEST000001', { ops: [{ hash: 'x', start: 5, end: 50 }], eds: [] });
      env.api._renderPill();
      check('识别后状态行跟着刷新',
        /已标 OP 1 套 \/ ED 0 套/.test(host.shadowRoot.querySelector('.mkstat').textContent), true);
      toggle();
    }
  }

  head('48i. 标记带集号（工具条写明标于哪一集）');
  {
    const env = makeEnv({
      store: { autoDetect: 'off', _bindings: JSON.stringify({ 'b:BV1jfDYBSEKs': { title: 'T', episodes: 13, anchorPage: 1 } }) },
      location: { pathname: '/video/BV1jfDYBSEKs', search: '?p=1' }
    });
    env.api._runtime.ctx = ctxOf('BV1jfDYBSEKs', 1);
    env.api._runtime.video = { currentTime: 0, duration: 1400, paused: true, ended: false, play() {}, addEventListener() {} };

    /* 集号格式：locKeyOf() = BV + 第几个 P */
    const lk = hook(env, 'locKeyOf');
    checkTrue('集号 = BV:第几P', typeof lk === 'function' && lk() === 'BV1jfDYBSEKs:1',
      typeof lk === 'function' ? lk() : 'locKeyOf 没导出');

    /* 标记时把集号写进去；标结束不能把它冲掉 */
    const ros = hook(env, 'recordOpStart'), roe = hook(env, 'recordOpEnd'), res = hook(env, 'recordEdStart');
    const o1 = ros({ ops: [], eds: [] }, 'h1', 12, 'BV1jfDYBSEKs:1');
    check('OP 开始记下集号', o1.ops[0].vid, 'BV1jfDYBSEKs:1');
    check('标 OP 结束时集号还在', roe(o1, 90).ops[0].vid, 'BV1jfDYBSEKs:1');
    check('ED 开始也记下集号', res({ ops: [], eds: [] }, 'h2', 1300, 'BV1jfDYBSEKs:1').eds[0].vid, 'BV1jfDYBSEKs:1');
    /* 清洗：老数据没有 vid 归一成 null；脏值也归一成 null；正常的原样留 */
    const vls = hook(env, 'validateLocalSegs');
    check('老数据没有 vid → null', vls({ ops: [{ hash: 'a', start: 1, end: 2 }], eds: [] }).ops[0].vid, null);
    check('非字符串 vid → null', vls({ ops: [{ hash: 'a', start: 1, end: 2, vid: 7 }], eds: [] }).ops[0].vid, null);
    check('正常 vid 原样保留', vls({ ops: [{ hash: 'a', start: 1, end: 2, vid: 'BV1jfDYBSEKs:3' }], eds: [] }).ops[0].vid, 'BV1jfDYBSEKs:3');

    /* 工具条文案：站在第 2P 看第 1P 标的标记，要写清「标记标于别集，本集按指纹复用」 */
    const save = hook(env, 'saveLocalSegs');
    save('b:BV1jfDYBSEKs', { ops: [{ hash: 'a', start: 0, end: 90, vid: 'BV1jfDYBSEKs:1' }], eds: [] });
    global.location = { pathname: '/video/BV1jfDYBSEKs', search: '?p=2' };
    env.api._markToggle();
    env.api._refreshMarkBar();
    const statEl = env.api._markHost().shadowRoot.querySelector('.mkroot').querySelector('.mkstat');
    checkTrue('工具条写明标记标于哪一集', /标于/.test(statEl.textContent), statEl.textContent);
    checkTrue('工具条写明本集按指纹复用', /按指纹复用/.test(statEl.textContent), statEl.textContent);
    env.api._markToggle();
  }

  /* --- 汇总 --- */
  console.log('\n' + '='.repeat(60));
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(60));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃：', e); process.exit(1); });
