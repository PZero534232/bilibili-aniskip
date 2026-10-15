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
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      期望 ' + w + '\n      实际 ' + g); }
}
function checkTrue(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function head(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 52 - t.length))); }

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
function el(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    style: { cssText: '' }, dataset: {}, children: [], _text: '', value: '', checked: false,
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, addEventListener() {}, focus() {}, select() {}, contains: () => true,
    getBoundingClientRect: () => ({ width: 800, height: 450 }),
    querySelector: () => el('div'), querySelectorAll: () => [],
    attachShadow: () => el('shadowroot'),
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    get options() { return [{ textContent: '作用域' }]; }, get selectedIndex() { return 0; }
  };
}

function makeEnv(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store);
  const net = opts.net || makeNet();
  const timers = [];

  global.GM_getValue = (k, d) => (k in store ? store[k] : d);
  global.GM_setValue = (k, v) => { store[k] = v; };
  global.GM_deleteValue = (k) => { delete store[k]; };
  global.GM_registerMenuCommand = () => {};
  global.GM_xmlhttpRequest = (req) => {
    Promise.resolve().then(() => {
      const key = Object.keys(net).find((frag) => req.url.indexOf(frag) === 0);
      if (!key) { req.onerror && req.onerror({ status: 0 }); return; }
      const r = net[key];
      const body = typeof r === 'function' ? r(req) : r;
      req.onload && req.onload({ status: 200, responseText: typeof body === 'string' ? body : JSON.stringify(body) });
    });
  };

  global.document = {
    readyState: 'complete',
    title: '', documentElement: { innerHTML: '', contains: () => true, appendChild() {} },
    createElement: el, body: el('body'), getElementById: () => null,
    querySelectorAll: () => [], addEventListener() {}
  };
  global.window = {};
  global.unsafeWindow = {};
  global.location = opts.location || { pathname: '/video/BV_TEST000001', search: '?p=1' };
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  global.clearInterval = () => {};
  global.setInterval = () => 0;

  eval(SRC);
  return { api: global.unsafeWindow.__biliAniskip, store };
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
    check('recap 280s 保留', validateSegs([S('recap', 10, 280)], 1500).length, 1);
    check('recap 320s 丢弃', validateSegs([S('recap', 10, 320)], 1500).length, 0);
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

    /* ⑥ mixed-op（OP 融进画面）默认不跳 */
    const cfgLZ = e0.api.getConfig();
    check('jumpMixed 默认关', cfgLZ.jumpMixed, false);
    checkTrue('mixed-op/mixed-ed 由独立开关注册', /if \(config\.jumpMixed\) types\.push\('mixed-op'/.test(SRC));
    checkTrue('仅当 jumpOp 时才请求纯 op（不再顺带 mixed-op）', /if \(config\.jumpOp\) types\.push\('op'\);/.test(SRC));
    checkTrue('mixed 段单独受 segmentEnabled 控制', /if \(s\.mixed\) return config\.jumpMixed;/.test(SRC));
    checkTrue('设置面板有「融进正片」开关', /融进正片/.test(SRC) && /class="mixed"/.test(SRC));

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
    check('P5 没有任何可跳区间', (r5.segments || []).filter(s => s.type === 'op' || s.type === 'ed' || s.type === 'recap'), []);
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
    const fresh = Object.assign({}, stale, { chainVer: 3, seasons: [
      { anilistId: 162694, malId: 54714, title: '…第1期', episodes: 12, startAbs: 1, endAbs: 12 },
      { anilistId: 172258, malId: 57616, title: '…第2期', episodes: 12, startAbs: 13, endAbs: 24 },
      { anilistId: 200637, malId: 62811, title: '…第3期', episodes: 12, startAbs: 25, endAbs: 36 }] });
    const eFresh = makeEnv({ store: { autoDetect: 'off', _bindings: JSON.stringify(mkBind(fresh)) }, net: gfNet() });
    const rFresh = await eFresh.api.identify(Object.assign(gfCtx(), { page: 1 }));
    check('新版季链（第 1 话 → 第1期）才被采用', [rFresh.malId, rFresh.episode], [54714, 1]);
  }

  /* --- 汇总 --- */
  console.log('\n' + '='.repeat(60));
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(60));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃：', e); process.exit(1); });
