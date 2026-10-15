// ==UserScript==
// @name         Bilibili 番剧 OP/ED 跳过（AniSkip / Anime Skip 数据源）
// @namespace    bilibili-aniskip
// @version      0.4.1
// @description  用外部动画时间戳库给 B 站上传的番剧自动跳过 OP/ED。支持中文/罗马字/日文/简写搜番，多季连播合集可自动按分P分段对齐数据库条目（一段可含多个季度）。标题乱码、无番名时可手动绑定整季一次，全季复用。默认不自动识别，普通视频绝不触发。
// @author       PZero534232
// @homepageURL  https://github.com/PZero534232/bilibili-aniskip
// @supportURL   https://github.com/PZero534232/bilibili-aniskip/issues
// @match        *://*.bilibili.com/video/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.aniskip.com
// @connect      api.anime-skip.com
// @connect      graphql.anilist.co
// @connect      api.bgm.tv
// @connect      api.bilibili.com
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/* ==================================================================
 * Bilibili 番剧 OP/ED 跳过
 *
 * 数据源
 *   AniSkip     : https://api.aniskip.com/v2           主键 MAL ID，免认证，显式 start-end 区间
 *   Anime Skip  : https://api.anime-skip.com/graphql   主键 AniList ID，需 X-Client-ID（官方文档公开的共享 ID）
 *   AniList     : https://graphql.anilist.co           免 key，一次查询同时返回 id 与 idMal
 *   Bangumi     : https://api.bgm.tv/v0/search/subjects 中文条目库，做「中文名 → 日文原名」的桥
 *                 （AniList 只认它 synonyms 里恰好有的中文，实测「葬送的芙莉莲」直接搜是 0 条）
 *
 * 设计主线
 *   这两个库按「番剧 ID + 集数」组织数据，与播放站点无关 ——
 *   所以 B 站没有官方时间戳这件事，可以用外部数据补上。
 *   真正的工作量不在调 API，在「认番」。
 *
 * 安全原则（本脚本最重要的一条）
 *   错跳比不跳糟糕得多 —— 不跳只是手动按一下，错跳会把正片跳掉而你不一定察觉。
 *   因此：默认不自动识别；识别不确定时不猜；跳过之后给撤回机会。
 * ================================================================== */
(function () {
  'use strict';

  var LOG = '[bili-aniskip]';

  /* ==================================================================
   * 1. 配置
   * ================================================================== */
  var DEFAULTS = {
    // 自动识别总开关（本脚本的安全阀）
    //   off  = 不做基于标题的自动识别，只显示手动触发按钮。普通视频零请求、零干扰。
    //          注意：手动绑定过的番剧仍然生效 —— 绑过就代表你要它跳。
    //   ask  = 自动识别，命中后显示按钮，由你点着跳
    //   auto = 自动识别，命中且置信度足够时自动跳
    autoDetect: 'off',

    jumpOp: true,          // 跳过片头
    jumpEd: true,          // 跳过片尾
    jumpRecap: false,      // 跳过总集篇回顾（很多人想看，默认关）
    jumpMixed: false,      // 跳过「融进正片画面」的 OP/ED（没独立 OP 段的番，跳过会切正片，默认关）

    undoSeconds: 8,        // 跳过后「撤回」提示停留秒数（0 = 不显示撤回）
    showToast: true,       // 跳转提示

    useSeasonTitle: true,  // 优先用 UGC 合集里 UP 主改过的单集标题
    showIdlePill: true,    // 未识别出番剧时也显示胶囊（默认开：入口常在，随时能绑定 / 改设置）

    confThreshold: 60,     // auto 模式下自动跳的置信度门槛
    hintThreshold: 35      // 低于此值连提示都不给
  };

  function gmGet(k, d) {
    try {
      var v = GM_getValue(k, undefined);
      return v === undefined ? d : v;
    } catch (e) { return d; }
  }
  function gmSet(k, v) {
    try { GM_setValue(k, v); } catch (e) { /* ignore */ }
  }

  var config = {};
  (function loadConfig() {
    /* 一次性配置迁移。
     * v1：showIdlePill 默认 false；v2 起默认 true（用户要求「未识别时也显示胶囊」默认开）。
     * 老安装里存着的 false 既可能是旧默认、也可能是手动关的 —— 但旧默认本来就不显示，
     * 手动再去关一次没有意义，所以这里一律清掉，让新默认生效。 */
    var CFG_VERSION = 2;
    if ((gmGet('cfgVersion', 1) || 1) < CFG_VERSION) {
      try { GM_deleteValue('showIdlePill'); } catch (e) { /* ignore */ }
      gmSet('cfgVersion', CFG_VERSION);
    }
    Object.keys(DEFAULTS).forEach(function (k) { config[k] = gmGet(k, DEFAULTS[k]); });
    config.jumpOp = !!config.jumpOp;
    config.jumpEd = !!config.jumpEd;
    config.jumpRecap = !!config.jumpRecap;
    config.jumpMixed = !!config.jumpMixed;
    config.showToast = !!config.showToast;
    config.useSeasonTitle = !!config.useSeasonTitle;
    config.showIdlePill = !!config.showIdlePill;
  })();

  /* ==================================================================
   * 2. 通用工具
   * ================================================================== */
  function xhr(opts) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: opts.method || 'GET',
          url: opts.url,
          headers: opts.headers || {},
          data: opts.data,
          timeout: opts.timeout || 15000,
          onload: function (r) {
            if (r.status >= 200 && r.status < 300) resolve(r.responseText);
            else reject(new Error('HTTP ' + r.status));
          },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timeout')); }
        });
      } catch (e) { reject(e); }
    });
  }

  function jget(url) {
    return xhr({ url: url }).then(function (t) { return JSON.parse(t); });
  }

  function jpost(url, body, extraHeaders) {
    var h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (extraHeaders) Object.keys(extraHeaders).forEach(function (k) { h[k] = extraHeaders[k]; });
    return xhr({ method: 'POST', url: url, data: JSON.stringify(body), headers: h })
      .then(function (t) { return JSON.parse(t); });
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var m = Math.floor(s / 60), sec = s % 60;
    if (m >= 60) {
      var hh = Math.floor(m / 60);
      return hh + ':' + String(m % 60).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }
    return m + ':' + String(sec).padStart(2, '0');
  }

  var CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g;

  // 相似度：中日跨脚本标题不能只靠二元组 ——
  // 「葬送のフリーレン」vs「葬送的芙莉莲」二元组重合率只有 0.17，会被误判成不同番剧。
  // 所以汉字串额外走「共有汉字 / 较短一方汉字数」这条路径。
  function similarity(a, b) {
    if (!a || !b) return 0;
    a = String(a).toLowerCase().replace(/\s+/g, '');
    b = String(b).toLowerCase().replace(/\s+/g, '');
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 0.82;

    var best = 0;

    // 二元组重合率（适合拉丁文）
    var bg = function (s) {
      var set = {}, n = 0;
      for (var i = 0; i < s.length - 1; i++) { set[s.substr(i, 2)] = 1; n++; }
      return { set: set, n: n };
    };
    var A = bg(a), B = bg(b);
    if (A.n && B.n) {
      var hit = 0;
      Object.keys(A.set).forEach(function (k) { if (B.set[k]) hit++; });
      best = Math.max(best, (2 * hit) / (A.n + B.n));
    }

    // 汉字重合率（适合中日）
    var uniq = function (s) {
      var m = s.match(CJK_RE) || [], set = {};
      m.forEach(function (c) { set[c] = 1; });
      return Object.keys(set);
    };
    var ca = uniq(a), cb = uniq(b);
    if (ca.length >= 2 && cb.length >= 2) {
      var common = 0;
      ca.forEach(function (c) { if (cb.indexOf(c) >= 0) common++; });
      var mn = Math.min(ca.length, cb.length);
      best = Math.max(best, 0.95 * (common / mn));
    }

    return Math.min(1, best);
  }

  /* ==================================================================
   * 2.5 标题解析增强 + 中文名归一化
   *
   * 实测教训（用户给的真实标题）：
   *   【4K超高清】「冰之城墙 正相反的正相反 第一季+第二季」全26话 未删减版 周更
   *   整条标题直接拿去搜 → 搜回来一个完全无关的番；
   *   只取引号内容 → 立刻命中「氷の城壁」。
   *   所以引号内容必须最高优先，其次才轮到整标题清洗。
   * ================================================================== */
  function hasHan(s) { return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(String(s || '')); }

  // 标点/大小写无关的归一化：Re:0 == Re0 == re：0
  // 简化写法几乎都在标点上做文章，归一化之后就能整串相等匹配
  function normKey(s) {
    return String(s || '').toLowerCase()
      .replace(/[\s:：·・,，.。\-—_/／|｜"'“”‘’「」『』〈〉()（）\[\]【】!！?？+＋~～]/g, '');
  }

  // 常见简写 → 正式中文名。只用来「扩展查询」，不直接决定结果，
  // 所以表可以保持很短；命中后仍走正常的匹配打分，不怕偶发写错。
  var SHORT_ALIAS = {
    're0': 'Re：从零开始的异世界生活',
    'rezero': 'Re：从零开始的异世界生活',
    '巨人': '进击的巨人',
    '进巨': '进击的巨人',
    '咒回': '咒术回战',
    '鬼灭': '鬼灭之刃',
    '春物': '我的青春恋爱物语果然有问题',
    '地错': '在地下城寻求邂逅是否搞错了什么',
    '一拳': '一拳超人',
    '史莱姆': '关于我转生变成史莱姆这档事',
    '辉夜': '辉夜大小姐想让我告白',
    '约战': '约会大作战',
    '龙女仆': '小林家的龙女仆',
    'fz': 'Fate/Zero',
    'fsn': 'Fate/stay night',
    'sao': '刀剑神域'
  };

  function aliasExpansions(name) {
    var k = normKey(name), out = [];
    Object.keys(SHORT_ALIAS).forEach(function (key) {
      if (normKey(key) === k) out.push(SHORT_ALIAS[key]);
    });
    return out;
  }

  // 标题里的引号内容。强引号（「」『』《》""）比弱引号（【】[]）可信得多 ——
  // 【】里放的多半是「合集/4K/预告」这类噪声，但偶尔也是番名，所以弱引号也取，只是排在后面。
  var STRONG_QUOTE_RE = /[「『《〈“"']([^」』》〉”"']{2,60})[」』》〉”"']/g;
  var WEAK_QUOTE_RE = /[【\[]([^】\]]{2,60})[】\]]/g;
  var QUOTE_NOISE_RE = /^(合集|全集|完结|连载|连载中|更新中|正版|独家|搬运|预告|先行|PV|OP|ED|中字|双语|无字幕|无修|未删减|无删减|剧场版|第\s*\d+\s*[季期部]|新番|新番连载|新番速递|番剧|新剧|(?:\d{1,4}\s*年)?\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*月|(?:\d{1,4}\s*年)?\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(?:新番|番剧|新剧)(?:连载|速递|更新|放送)?)$/i;
  // 含这些字样的引号内容一律当噪声（【4K超高清】【台配国语】这类）
  // 新番/番剧/番组 是档期分类标签，不是番名 —— 实测 BV1jfDYBSEKs 的合集名
  // 「【4月新番】尖帽子的魔法工坊」里，光秃秃的「4月新番」被当成番名取了
  var QUOTE_NOISE_SUB = /字幕组|字幕|配音|压制|资源|发布|超高清|高清|蓝光|4K|8K|1080[Pi]|720[Pi]|2160[Pi]|国语|日语|粤语|台配/;

  function isQuoteNoise(s) {
    return QUOTE_NOISE_RE.test(s) || QUOTE_NOISE_SUB.test(s);
  }

  function quotedSegments(raw) {
    var out = [], m;
    var push = function (text, tier, re) {
      re.lastIndex = 0;
      while ((m = re.exec(raw)) !== null) {
        var inner = String(m[1] || '').trim();
        if (!inner || inner.length < 2) continue;
        if (isQuoteNoise(inner)) continue;
        out.push({ text: inner, tier: tier });
      }
    };
    push(raw, 'strong', STRONG_QUOTE_RE);
    push(raw, 'weak', WEAK_QUOTE_RE);
    return out;
  }

  // 按分隔符做渐进截断：'A B C' → ['A B C','A B','A']
  // 「冰之城墙 正相反的正相反」→ 能一路截到「冰之城墙」
  var SEG_SPLIT_RE = /[\s+＋/／|｜、,，·・]+/;
  function progressivePrefixes(s, maxSeg) {
    var segs = String(s || '').split(SEG_SPLIT_RE).filter(Boolean);
    if (segs.length < 2) return [];
    var out = [];
    for (var n = Math.min(segs.length, maxSeg || 3); n >= 1; n--) {
      var p = segs.slice(0, n).join(' ').trim();
      if (p.length >= 2) out.push(p);
    }
    return out;
  }

  function stripEpisodeMarks(s) {
    return String(s || '')
      .replace(/第\s*\d{1,3}\s*[话集回話]?/g, ' ')
      .replace(/[Ee][Pp]?\.?\s*\d{1,3}(?!\d)/g, ' ')
      .replace(/[\[【(（]\s*\d{1,3}\s*[\]】)）]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // 去掉「第一季 / 2nd season / 全26话 / 未删减 / 周更」这类标记，
  // 让「冰之城墙 ... 第一季+第二季」能退化成可搜的番名
  var SEASON_NOISE_RE = [
    // 季区间：实测 BV1KspF6iELH「第1-3季」——
    // 原规则只认「第N季」，区间写法会把「-3」留下变成「无职转生 第1-」
    /第\s*[一二两三四五六七八九十\d]+\s*[-~～—至到]\s*[一二两三四五六七八九十\d]+\s*[季期部]/g,
    /[一二两三四五六七八九十\d]+\s*[-~～—至到]\s*[一二两三四五六七八九十\d]+\s*[季期部]/g,
    // 「第三季14」「第3季 05」：季号后直接跟话数
    /第\s*[一二两三四五六七八九十\d]+\s*[季期部]\s*\d{1,3}\s*[话集話]?/g,
    /第\s*[一二两三四五六七八九十\d]+\s*[季期部]/g,
    /[Ss]eason\s*\d{1,2}/g,
    /[Ss]\d{1,2}\s*(?:[\+＋&和与、]\s*[Ss]?\d{1,2})?/g,
    /(?:全|共)\s*\d{1,3}\s*[话集話]/g,
    // 话数区间：「1-13话」。实测 BV1jfDYBSEKs 标题「…尖帽子的魔法工坊 1-13话全集」——
    // 原规则只吃「13话」，「1-」留在原地变成「尖帽子的魔法工坊 1」，搜索时就多带个尾巴
    /[\d一二两三四五六七八九十]+\s*[-~～—–至到]\s*\d{1,3}\s*[话集話]/g,
    /\d{1,3}\s*[话集話]/g,          // 「32话」这类纯话数标记
    /(?:合集|全集|完整版|未删减|无删减|已完结|连载中|周更|日更)/g,
    // 注意：「N季」的可选尾巴不能带「全」，否则会把「全集」的「全」吃掉，
    // 只剩一个孤零零的「集」（实测：「两季32话全集」→「…影之实力者 集」）
    /[一二两三四五六七八九十\d]+\s*季(?:连播|合辑|合集)?/g,
    /(?:剧场版|TV版|BDRip版|先行版)/gi
  ];
  function stripSeasonMarks(s) {
    var t = String(s || '');
    SEASON_NOISE_RE.forEach(function (re) { t = t.replace(re, ' '); });
    return t.replace(/[+＋&、]/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s\-_—–|]+|[\s\-_—–|]+$/g, '').trim();
  }

  // 多季连播信号（决定要不要去推季链）
  var MULTI_SEASON_RES = [
    /第\s*[一二三四五六七八九十\d]+\s*[季期部][\s\S]{0,16}?第\s*[一二三四五六七八九十\d]+\s*[季期部]/,
    /[一二两三四五六七八九十\d]+\s*季\s*(?:连播|合辑|合集|全)/,
    // 「两季32话全集」这种：季数后面紧跟话数
    /[一二两三四五六七八九十\d]+\s*季[\s\S]{0,8}?\d{1,3}\s*[话集話]/,
    /[Ss]eason\s*\d\s*[\+＋&和与、]\s*[Ss]?\d?/i,
    /[Ss]\d\s*[\+＋&]\s*[Ss]\d/i,
    /第\s*[一二三四五六七八九十\d]+\s*[-~～至]\s*[一二三四五六七八九十\d]+\s*[季期部]/
  ];
  // 「全26话」和「32话全集」两种写法都要认
  var TOTAL_EP_RES = [/(?:全|共)\s*(\d{1,3})\s*[话集話]/, /(\d{1,3})\s*[话集話]\s*(?:全集|全季|全)/];

  // 分P标题里的季标记：实测 BV1kk7r6iEC4 的 P21 part='【S2】01'
  // 这是最硬的季边界证据 —— 它就是 UP 主自己分的段
  var PART_SEASON_RES = [
    /第\s*([一二三四五六七八九十\d]+)\s*[季期部]/,
    /[Ss]eason\s*(\d{1,2})/i,
    /[Ss](\d{1,2})(?![\d])/,
    /([一二三四五六七八九十\d]+)\s*[季期部](?![\d])/
  ];
  var CN_NUM = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

  function partSeasonOf(text) {
    var t = String(text || '');
    for (var i = 0; i < PART_SEASON_RES.length; i++) {
      var m = PART_SEASON_RES[i].exec(t);
      if (!m) continue;
      var raw = m[1];
      var n = /^\d+$/.test(raw) ? parseInt(raw, 10) : (CN_NUM[raw] || 0);
      if (n >= 1 && n <= 20) return n;
    }
    return 0;
  }

  /* 用分P标题推出季分组。
   * 标记可能只出现在后几季（前面的 P 只写「01」），此时把首个标记之前的 P 归给上一季。
   * 例：32 个 P，只有 P21 起带【S2】→ 第1季 P1–P20（20话）、第2季 P21–P32（12话） */
  function seasonGroupsFromParts(ctx) {
    var pages = (ctx && ctx.pages) || [];
    if (pages.length < 2) return null;

    var marks = [];
    pages.forEach(function (p) {
      var s = partSeasonOf(p.part);
      if (!s) return;
      if (!marks.length || marks[marks.length - 1].season !== s) marks.push({ page: p.page, season: s });
    });
    if (!marks.length) return null;

    var groups = [];
    var first = marks[0];
    if (first.page > pages[0].page) {
      if (first.season < 2) return null;      // 首个标记是第 1 季却不在开头 → 不敢推
      groups.push({ season: first.season - 1, startPage: pages[0].page, endPage: first.page - 1 });
    }
    marks.forEach(function (m, i) {
      var end = (i + 1 < marks.length) ? marks[i + 1].page - 1 : pages[pages.length - 1].page;
      groups.push({ season: m.season, startPage: m.page, endPage: end });
    });

    groups = groups.filter(function (g) { return g.endPage >= g.startPage; });
    if (groups.length < 2) return null;
    for (var i = 1; i < groups.length; i++) {
      if (groups[i].season !== groups[i - 1].season + 1) return null;      // 季号要连续
      if (groups[i].startPage !== groups[i - 1].endPage + 1) return null;  // 中间不能断层
    }
    groups.forEach(function (g) { g.episodes = g.endPage - g.startPage + 1; });
    return groups;
  }

  /* 分P标题里的「季内话数」：'【S2】01' → 1、'第 3 集' → 3 */
  function partEpisodeOf(text) {
    var t = String(text || '');
    var m = /[Ss]\d{1,2}\s*[】\]）)\-_. ]?\s*(?:第)?\s*(\d{1,3})/.exec(t)
         || /第\s*(\d{1,3})\s*[话集話]/.exec(t)
         || /(\d{1,3})\s*$/.exec(t);
    if (!m) return 0;
    var n = parseInt(m[1], 10);
    return (isFinite(n) && n >= 1 && n <= 500) ? n : 0;
  }

  /* 分P标题带季标记时的「合集内绝对集号」。
   * 实测坑：BV1kk7r6iEC4 的 P21 分P标题是「【S2】01」——
   * 直接抽数字得到 1（季内话数），而季链需要的是合集内的 21。
   * 绝对集号 = 前面各季话数之和 + 季内话数 */
  function absEpisodeFromPart(ctx) {
    var groups = seasonGroupsFromParts(ctx);
    if (!groups) return null;
    var idx = -1;
    for (var i = 0; i < groups.length; i++) {
      if (ctx.page >= groups[i].startPage && ctx.page <= groups[i].endPage) { idx = i; break; }
    }
    if (idx < 0) return null;
    var within = partEpisodeOf(ctx.partTitle);
    if (!within) within = ctx.page - groups[idx].startPage + 1;   // 没写话数就按顺序数
    var before = groups.slice(0, idx).reduce(function (a, g) { return a + g.episodes; }, 0);
    return { absEp: before + within, season: groups[idx].season, within: within, from: 'partSeason' };
  }

  function detectMultiSeason(ctx) {
    var texts = [ctx.mainTitle, ctx.partTitle, ctx.seasonTitle, ctx.seasonEpisodeTitle];
    var multi = false, total = 0, hint = '';
    texts.forEach(function (t) {
      if (!t) return;
      MULTI_SEASON_RES.forEach(function (re) {
        var m = re.exec(t);
        if (m) { multi = true; if (!hint) hint = m[0]; }
      });
      TOTAL_EP_RES.forEach(function (re) {
        var em = re.exec(t);
        if (em) total = Math.max(total, parseInt(em[1], 10) || 0);
      });
    });

    // 分P标题里的季标记是最硬的证据（比标题里的文字更靠谱）
    var partGroups = seasonGroupsFromParts(ctx);
    if (partGroups) {
      multi = true;
      if (!hint) hint = '分P标题里有第 ' + partGroups[1].season + ' 季标记';
    }
    return { multi: multi, totalEps: total, hint: hint, partGroups: partGroups };
  }

  /* ==================================================================
   * 3. 缓存（Anime Skip 有严格限流，缓存是必需项不是优化项）
   * ================================================================== */
  var CACHE_TTL = {
    seg: 7 * 86400000,      // 时间戳 7 天
    bind: 90 * 86400000,    // 手动绑定 90 天（长期有效）
    rel: 30 * 86400000,     // 分季重映射 30 天
    search: 30 * 86400000,  // AniList 搜索 30 天
    miss: 6 * 3600000       // 查不到记 6 小时，避免反复打 API
  };

  var cache = {};
  try { cache = JSON.parse(gmGet('_cache', '{}')) || {}; } catch (e) { cache = {}; }

  function cacheGet(key, ttl) {
    var e = cache[key];
    if (!e) return undefined;
    if (Date.now() - e.t > ttl) { delete cache[key]; return undefined; }
    return e.v;
  }
  function cacheSet(key, val) {
    cache[key] = { t: Date.now(), v: val };
    // 上限保护，避免无限膨胀
    var ks = Object.keys(cache);
    if (ks.length > 400) {
      ks.sort(function (a, b) { return cache[a].t - cache[b].t; });
      for (var i = 0; i < 120; i++) delete cache[ks[i]];
    }
    persistCache();
  }
  var cacheTimer = null;
  function persistCache() {
    if (cacheTimer) clearTimeout(cacheTimer);
    cacheTimer = setTimeout(function () {
      try { gmSet('_cache', JSON.stringify(cache)); } catch (e) { /* ignore */ }
    }, 800);
  }

  // 手动绑定表 & 黑名单
  var bindings = {};
  try { bindings = JSON.parse(gmGet('_bindings', '{}')) || {}; } catch (e) { bindings = {}; }
  var blacklist = {};
  try { blacklist = JSON.parse(gmGet('_blacklist', '{}')) || {}; } catch (e) { blacklist = {}; }

  function persistBindings() { try { gmSet('_bindings', JSON.stringify(bindings)); } catch (e) { /* ignore */ } }
  function persistBlacklist() { try { gmSet('_blacklist', JSON.stringify(blacklist)); } catch (e) { /* ignore */ } }

  /* ==================================================================
   * 4. B 站上下文：BV / cid / 分P / UGC 合集
   * ================================================================== */
  function currentBvid() {
    var m = /(BV[0-9A-Za-z]{10})/.exec(location.pathname) || /bvid=(BV[0-9A-Za-z]{10})/.exec(location.search);
    return m ? m[1] : null;
  }
  function currentPage() {
    var m = /[?&]p=(\d+)/.exec(location.search);
    return m ? parseInt(m[1], 10) : 1;
  }

  // 从页面里拿 cid：先试 __INITIAL_STATE__，失败再试 ?cid=，兜底取播放器 video
  function currentCid() {
    try {
      var m = /"cid":(\d+)/.exec(document.documentElement.innerHTML);
      if (m) return m[1];
    } catch (e) { /* ignore */ }
    var q = /[?&]cid=(\d+)/.exec(location.search);
    return q ? q[1] : null;
  }

  function fetchVideoInfo(bvid) {
    var ckey = 'bili:' + bvid;
    var c = cacheGet(ckey, 6 * 3600000);
    if (c) return Promise.resolve(c);
    return jget('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid))
      .then(function (d) {
        if (d && d.code === 0 && d.data) {
          cacheSet(ckey, d.data);
          return d.data;
        }
        throw new Error((d && d.message) || 'view api failed');
      });
  }

  /* HTML 标题兜底：API 被限流 / 视频失效时至少还能试一下 */
  function fallbackTitleSource(bvid, p, info) {
    var out = {
      bvid: bvid,
      page: p,
      cid: (info && info.cid) || currentCid(),
      owner: { mid: (info && info.owner && info.owner.mid) || null, name: (info && info.owner && info.owner.name) || '' },
      mainTitle: document.title,
      partTitle: '',
      duration: 0,
      videos: (info && info.videos) || 1,
      season: (info && info.ugc_season) || null,
      seasonEpisodeTitle: '',
      seasonId: (info && info.ugc_season && info.ugc_season.id) || null,
      fromCache: true,
      incomplete: !info
    };
    if (info) {
      out.duration = p > 1 ? ((info.pages || [])[p - 1] || {}).duration || info.duration : info.duration;
      out.partTitle = ((info.pages || [])[p - 1] || {}).part || '';
      out.pubdate = info.pubdate;
    }
    return out;
  }

  // 汇总当前视频的全部识别线索
  function buildContext() {
    var bvid = currentBvid();
    if (!bvid) return Promise.reject(new Error('no bvid'));
    var p = currentPage();
    return fetchVideoInfo(bvid).then(function (info) {
      var pages = info.pages || [];
      var cur = pages[p - 1] || {};
      var season = info.ugc_season || null;
      var seasonEpisodeTitle = '';

      // 优先取 UGC 合集里 UP 主改过的单集标题 —— 往往比原始标题干净
      if (season && config.useSeasonTitle) {
        var secs = season.sections || [];
        for (var i = 0; i < secs.length && !seasonEpisodeTitle; i++) {
          var eps = secs[i].episodes || [];
          for (var j = 0; j < eps.length; j++) {
            var e = eps[j];
            if ((e.bvid && e.bvid === bvid) || (String(e.aid) === String(info.aid))) {
              seasonEpisodeTitle = e.title || '';
              break;
            }
          }
        }
      }

      return {
        bvid: bvid,
        aid: info.aid,
        page: p,
        cid: cur.cid || info.cid,
        owner: { mid: info.owner && info.owner.mid, name: info.owner && info.owner.name },
        mainTitle: info.title || '',
        partTitle: cur.part || '',
        duration: cur.duration || info.duration || 0,
        pubdate: info.pubdate || 0,
        videos: info.videos || 1,
        pages: pages.map(function (x) { return { page: x.page, part: x.part, duration: x.duration, cid: x.cid }; }),
        season: season,
        seasonId: season && season.id,
        seasonTitle: season && season.title,
        seasonEpisodeTitle: seasonEpisodeTitle,
        incomplete: false
      };
    }, function (err) {
      return fallbackTitleSource(bvid, p, null);
    });
  }

  /* ==================================================================
   * 5. 标题清洗与集号提取
   * ================================================================== */
  var NOISE_RE = [
    /_哔哩哔哩_bilibili\s*$/i,
    /[_|\-—–\s]*bilibili\s*$/i,
    /\b(1080[Pi]|720[Pi]|2160[Pi]|4[Kk])\b/gi,
    /\b(BDRip|WEBRip|WEB-?DL|BDRemux|HDTV|TVrip|x264|x265|HEVC|AVC|10bit|8bit|Hi10p)\b/gi,
    /\b(MP4|MKV|FLAC|AAC|AC3)\b/gi,
    /\[(简体|繁体|简日|繁日|简繁|繁简|国语|日语|日语中字|中文字幕|字幕|双语|内嵌|外挂)[^\]]*\]/gi,
    /（(简体|繁体|简日|繁日|简繁|繁简|国语|日语|中文字幕|字幕|双语|内嵌|外挂)[^）]*）/gi,
    /\b(简|繁|日|中)(体|文)?(字幕|双语)\b/gi,
    /[简繁]{2}(内嵌|外挂)?(字幕|中字)?/gi,
    /\b(无修|修正|完整版|TV版|剧场版|先行版|BDRIP版|未删减|无删减|删减版)\b/gi,
    // 更新状态标记：「更至第三季14」「更新至 20」「已更 5 话」。
    // 实测漏掉它 →「（更至第三季14）」残留下来，被当成番名候选排到第一位（BV1KspF6iELH）
    /(?:已|更新|更)\s*(?:至|到)\s*第?\s*[一二两三四五六七八九十\d]+\s*[季期部]?\s*\d{0,3}\s*[话集話]?/g,
    /(超高清|超清|蓝光|已完结|连载中|周更|日更)/g,
    // 档期标签：「4月新番」「2026年4月新番」「十月新番」「本季新番」「新番连载」「新番」。
    // 实测 BV1jfDYBSEKs：合集名是「【4月新番】尖帽子的魔法工坊」，而光秃秃的「4月新番」
    // 被 weak 引号策略当成番名候选（53 分）压过真番名「尖帽子的魔法工坊」（41 分），
    // 于是「用标题自动填」填了「4月新番」，搜索自然 0 结果。
    // 顺序：先整串吃掉「…月新番」，再处理单独的「新番」，最后收残留的「4月」
    /(?:本季|当季|最新|这季)?\s*(?:\d{1,4}\s*年)?\s*(?:[一二三四五六七八九十]{1,3}|\d{1,2})\s*月\s*(?:新番|番剧|新剧)(?:连载|速递|更新|放送|连播)?/g,
    /(?:本季|当季|最新|这季)\s*(?:新番|番剧|新剧)(?:连载|速递|更新|放送|连播)?/g,
    // 「新番」本身就当噪声（没有哪部番的名字里带这两个字）；
    // 但「番剧 / 新剧」只在带后缀时才清，避免误伤偶发含这两个字的标题
    /(?:新番(?:连载|速递|更新|放送|连播)?|(?:番剧|新剧)(?:连载|速递|更新|放送))/g,
    /(?:本季|当季|最新|这季)\s*(?:[一二三四五六七八九十]{1,3}|\d{1,2})\s*月/g,
    /【(完结|连载|更新中|合集|全集|正版|独占)[^】]*】/gi
  ];

  function cleanTitle(t) {
    if (!t) return '';
    var s = String(t);
    NOISE_RE.forEach(function (re) { s = s.replace(re, ' '); });
    s = s.replace(/[【\[][^】\]]{0,30}字幕组[^】\]]{0,10}[】\]]/gi, ' ');
    // 噪声被摘掉后会留下空括号（【4K超清】→ 删掉 4K 和 超清 就剩「【】」），一并清掉
    s = s.replace(/[【\[(（]\s*[】\])}）]/g, ' ');
    s = s.replace(/\s{2,}/g, ' ').replace(/^[\s\-_—–|]+|[\s\-_—–|]+$/g, '');
    return s.trim();
  }

  // 番名候选：多策略产出，再按「像不像一个番名」打分排序。
  // 曾经按「强引号 > 整标题 > 弱引号」固定分桶排序，实测会翻车：
  //   BV1KspF6iELH「【无职转生 第1-3季】4K超清未删减完整版（更至第三季14）」
  //   → 整标题清完噪声只剩碎片「（更至 14）」，却排在真正的番名「无职转生」前面，
  //     直接顶掉搜索框预填、并让自动匹配先去搜这个碎片。
  // 所以改成打分：干净、完整、含文字的候选排前面，碎片和残留噪声沉底。
  var CAND_NOISE_RE = /(?:更至|更新至|已更|合集|全集|完整版|未删减|无删减|已完结|连载中|周更|日更|超高清|超清|蓝光|字幕组|字幕|配音|国语|日语|粤语|台配|BDRip|WEBRip|1080|720|2160|4K|8K|HDR|预告|先行|无修|新番)/i;
  var CAND_EDGE_PUNCT_RE = /^[\s（(\[【「『《〈\-_—–|、,，·・+＋&/／]|[\s）)\]}】」』》〉\-_—–|、,，·・+＋&/／]$/;

  function nameScore(text, tier, depth) {
    var s = String(text || '');
    var score = tier === 'strong' ? 60 : (tier === 'weak' ? 42 : 26);

    // 表意文字 / 拉丁字母数量：纯数字、纯符号直接出局
    var ideo = (s.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
    var latin = (s.match(/[A-Za-z]/g) || []).length;
    if (ideo + latin < 2) return -1;
    score += Math.min(ideo, 8) + Math.min(latin, 8);

    if (CAND_NOISE_RE.test(s)) score -= 45;                       // 清洗没剪干净的痕迹
    if (CAND_EDGE_PUNCT_RE.test(s)) score -= 30;                  // 「（更至 14）」「…第1-」这类碎片
    if (/[（）()\[\]【】「」『』]/.test(s)) score -= 15;              // 括号残片
    if (s.length >= 4 && s.length <= 30) score += 8;              // 4~30 字最像番名
    else if (s.length > 40) score -= 12;
    if (depth) score -= depth * 4;                                // 截断出来的前缀，截得越短越靠后
    return score;
  }

  function animeNameCandidates(ctx) {
    var raws = [];
    // 优先级：合集里的单集标题 > 分P标题（信息量最大）> 主标题
    if (ctx.seasonEpisodeTitle) raws.push(ctx.seasonEpisodeTitle);
    if (ctx.videos > 1 && ctx.partTitle) raws.push(ctx.partTitle);
    raws.push(ctx.mainTitle);
    if (ctx.seasonTitle) raws.push(ctx.seasonTitle);

    var pool = {};
    function put(text, score) {
      if (!text || score < 0 || text.length < 2) return;
      var k = normKey(text);
      if (!k) return;
      if (!pool[k] || pool[k].score < score) pool[k] = { text: text, score: score };
    }

    function variants(text, tier) {
      var s = cleanTitle(text);
      s = s.replace(/[【\[][^】\]]*[】\]]/g, ' ').replace(/\s{2,}/g, ' ').trim();
      s = stripEpisodeMarks(s);
      s = stripSeasonMarks(s);
      if (!s || s.length < 2) return;
      put(s, nameScore(s, tier, 0));
      progressivePrefixes(s, 4).forEach(function (p, i) {
        put(p, nameScore(p, tier, i + 1));
      });
    }

    raws.forEach(function (raw) {
      if (!raw) return;
      // ① 引号内容优先：UP 主通常把真正的番名放在「」《》里，
      //    而全角括号外那些「4K超高清 / 未删减 / 周更」全是噪声
      quotedSegments(raw).forEach(function (q) {
        variants(q.text, q.tier === 'strong' ? 'strong' : 'weak');
      });
      // ② 整标题：清洗后与「挖掉强引号段后」各来一份，防止清洗规则误伤或漏掉
      variants(raw, 'plain');
      variants(String(raw).replace(/[「『《〈“"'][^」』》〉”"']*[」』》〉”"']/g, ' '), 'plain');
    });

    var flat = [];
    Object.keys(pool).forEach(function (k) {
      [pool[k].text].concat(aliasExpansions(pool[k].text)).forEach(function (x) {
        if (!x || x.length < 2 || x.length > 45) return;
        flat.push({ text: x, score: pool[k].score });
      });
    });
    flat.sort(function (a, b) { return b.score - a.score; });

    var seen = {}, res = [];
    flat.forEach(function (o) {
      var k = normKey(o.text);
      if (!k || seen[k]) return;
      seen[k] = 1;
      res.push(o.text);
    });
    return res.slice(0, 10);
  }

  var EP_PATTERNS = [
    { re: /第\s*(\d{1,3})\s*(?:话|集|回|話|話)/, conf: 30 },
    { re: /[Ee][Pp]?\s*\.?\s*(\d{1,3})(?!\d)/, conf: 28 },
    { re: /[Ee]pisod\w*\s*\.?\s*(\d{1,3})/i, conf: 28 },
    { re: /^\s*(\d{1,3})\s*[.、．]?\s*$/, conf: 20 },
    { re: /[\[【(（\s](\d{1,3})[\]】)）](?!\s*[PpBb])/, conf: 16 },
    { re: /[^\d](\d{1,3})\s*(?:END|完|end)/, conf: 14 },
    // 标题末尾的裸数字（「第一季21」「梦想成为魔法少女 03」）。
    // 原来给 conf 10 → 总分 11 低于 20，会被「P 序号兜底」覆盖成 1，
    // 于是「第一季21」被当成第 1 话（实测 BV1KspF6iELH）
    { re: /[^\w](\d{1,3})[^\w]*$/, conf: 22 }
  ];

  function extractEpisode(ctx) {
    // 分P合集：优先从当前 P 的标题抽（信息最准），抽不到退回主标题
    var sources = [];
    if (ctx.videos > 1) {
      sources.push({ text: ctx.partTitle || '', conf: 30, tag: 'part' });
      sources.push({ text: ctx.seasonEpisodeTitle || '', conf: 26, tag: 'season' });
    }
    sources.push({ text: ctx.mainTitle || '', conf: 22, tag: 'main' });
    sources.push({ text: ctx.seasonEpisodeTitle || '', conf: 20, tag: 'season' });

    var best = null;
    sources.forEach(function (src) {
      var t = cleanTitle(src.text);
      if (!t) return;
      for (var i = 0; i < EP_PATTERNS.length; i++) {
        var p = EP_PATTERNS[i];
        var m = p.re.exec(t);
        if (!m) continue;
        var n = parseInt(m[1], 10);
        // 0 不算命中（「第二季00」的「00」是第 0 话/特别篇），交给后面的兜底处理
        if (!isFinite(n) || n < 1 || n > 500) continue;
        var score = Math.min(p.conf, src.conf) + (EP_PATTERNS.length - i);
        if (!best || score > best.score) best = { num: n, score: score, from: src.tag, text: t };
        break;
      }
    });

    // 分P合集还有一个可靠办法：用 P 序号本身（前提是 P1 就是第 1 集）
    if (ctx.videos > 1 && (!best || best.score < 20)) {
      best = { num: 1, score: 12, from: 'pageIndex', text: 'P' + ctx.page };
    }
    if (best) best.num = applyTitleOffset(ctx, best.num);
    return best;
  }

  // 分P合集的固有坑：P1 常常是「预告 / PV / 先行」而不是第 1 集
  // titleOffset = 1 表示「P 序号比实际集号大 1」
  function applyTitleOffset(ctx, n) {
    if (ctx.videos <= 1) return n;
    var b = getBinding(ctx);
    var off = b && b.titleOffset;
    if (typeof off === 'number' && off) n = n - off;
    return n;
  }

  /* ------------------------------------------------------------------
   * 集号解析（手动绑定的核心）
   * 「绑一次整季复用」就靠这里：
   *   绑定时记下 anchorPage（当时在第几个 P）与 anchorEp（这一 P 是第几集），
   *   之后访问同 BV 的任意 P 都用  集号 = anchorEp + (当前P - anchorPage)  推算。
   * 跨 BV 的 UGC 合集没法用 P 序号推算，退回标题抽取。
   * ------------------------------------------------------------------ */
  function resolveEpisode(ctx, bind, epGuess) {
    if (bind) {
      // 分P标题自己就写着「第N季第M话」时，用当前 P 的标记算最准。
      // 锚点法在这里会整体偏移 —— 用户在「第二季01」上很可能把集号填成 1（季内话号），
      // 于是整个 BV 的后续 P 全部错位（实测 BV1KspF6iELH 就有这个坑）
      if (epGuess && epGuess.from === 'partSeason') return epGuess;
      if (bind.anchorPage && bind.anchorEp &&
          (bind._scope === 'bvid' || bind._scope === 'cid')) {
        var n = bind.anchorEp + (ctx.page - bind.anchorPage);
        if (n >= 1) return { num: n, from: 'anchor', score: 40 };
      }
      // 跨 BV 合集：退回从标题抽
      if (epGuess) return epGuess;
      return { num: 1, from: 'fallback', score: 8 };
    }
    return epGuess;
  }

  /* ==================================================================
   * 6. 手动绑定 / 黑名单（这两张表让脚本在"标题不可信"时仍然可用）
   * ================================================================== */
  // 作用域：cid（当前P）< bvid（整 BV 所有 P，最常用）< season_id（UGC 合集，跨 BV）
  function bindingKeys(ctx) {
    var ks = [];
    if (ctx.seasonId) ks.push({ scope: 'season', key: 's:' + ctx.seasonId, label: '整个合集（含合集里其他视频）' });
    ks.push({ scope: 'bvid', key: 'b:' + ctx.bvid, label: '这个视频的全部分P（推荐）' });
    if (ctx.cid) ks.push({ scope: 'cid', key: 'c:' + ctx.cid, label: '只在这一 P 生效' });
    return ks;
  }

  function getBinding(ctx) {
    var ks = bindingKeys(ctx);
    for (var i = 0; i < ks.length; i++) {
      var b = bindings[ks[i].key];
      if (b) return Object.assign({ _key: ks[i].key, _scope: ks[i].scope }, b);
    }
    return null;
  }

  function blacklistKeys(ctx) {
    var ks = [];
    if (ctx.seasonId) ks.push('s:' + ctx.seasonId);
    ks.push('b:' + ctx.bvid);
    if (ctx.cid) ks.push('c:' + ctx.cid);
    return ks;
  }

  function isBlacklisted(ctx) {
    return blacklistKeys(ctx).some(function (k) { return !!blacklist[k]; });
  }

  /* ==================================================================
   * 7. 番剧识别：AniList
   * ================================================================== */
  var ANILIST = 'https://graphql.anilist.co';
  var ANILIST_SEARCH_Q =
    'query($q:String){Page(perPage:8){media(search:$q,type:ANIME){id idMal episodes ' +
    'format startDate{year} title{romaji english native} synonyms}}}';

  function anilistSearch(name) {
    var ckey = 'al:' + name;
    var c = cacheGet(ckey, CACHE_TTL.search);
    if (c !== undefined) return Promise.resolve(c);
    return jpost(ANILIST, { query: ANILIST_SEARCH_Q, variables: { q: name } })
      .then(function (d) {
        var media = (d && d.data && d.data.Page && d.data.Page.media) || [];
        cacheSet(ckey, media);
        return media;
      })
      .catch(function () { return []; });
  }

  /* ---- 中文名 → 日文原名的桥：Bangumi ----
   * AniList 的 search 只认「恰好有人在 synonyms 里填过中文」的作品：
   * 实测「葬送的芙莉莲」直接搜 0 条，「我推的孩子」返回错季。
   * Bangumi 是中文条目库，先用中文搜到条目、拿到日文原名，再交给 AniList
   * 换 id + idMal —— 实测 4/4 命中。
   * 注意：Bangumi 必须带 User-Agent，否则 403；GM_xmlhttpRequest 自带浏览器 UA。 */
  var BANGUMI_SEARCH = 'https://api.bgm.tv/v0/search/subjects';
  var BANGUMI_SUBJECT = 'https://api.bgm.tv/v0/subjects/';

  function bgmSearch(kw, limit) {
    var ckey = 'bgm:' + kw + ':' + (limit || 8);
    var c = cacheGet(ckey, CACHE_TTL.search);
    if (c !== undefined) return Promise.resolve(c);
    return jpost(BANGUMI_SEARCH + '?limit=' + (limit || 8), { keyword: kw, filter: { type: [2] } })
      .then(function (d) {
        var list = (d && d.data) || [];
        cacheSet(ckey, list);
        return list;
      })
      .catch(function () { return []; });
  }

  // 条目的别名（英文 / 罗马字 / 繁中 / 简写都在里面，简写的救命稻草）
  function bgmAliases(id) {
    var ckey = 'bgmA:' + id;
    var c = cacheGet(ckey, CACHE_TTL.search);
    if (c !== undefined) return Promise.resolve(c);
    return jget(BANGUMI_SUBJECT + id)
      .then(function (d) {
        var out = [];
        ((d && d.infobox) || []).forEach(function (box) {
          if (String(box.key) !== '别名') return;
          var v = box.value;
          if (Array.isArray(v)) {
            v.forEach(function (x) { out.push(typeof x === 'string' ? x : (x && x.v) || ''); });
          } else if (typeof v === 'string') {
            v.split(/\s*\/\s*/).forEach(function (x) { out.push(x); });
          }
        });
        if (d && d.name_cn) out.push(d.name_cn);
        if (d && d.name) out.push(d.name);
        out = out.filter(function (x) { return x && String(x).trim(); });
        cacheSet(ckey, out);
        return out;
      })
      .catch(function () { return []; });
  }

  function bgmTitleScore(entry, extras, query) {
    var nk = normKey(query);
    var best = 0;
    [entry.name_cn, entry.name].concat(extras || []).filter(Boolean).forEach(function (t) {
      best = Math.max(best, similarity(t, query));
      // 标点无关的整串相等：Re:0 == Re0（别名里就写着 Re0）
      if (nk && normKey(t) === nk) best = 1;
    });
    return best;
  }

  // 在 Bangumi 候选里挑最像的那条；首名不够像（简写/异名）时，
  // 拉前 3 条的别名再做一次排序 —— 「Re:0」就是靠这步落到正确的番上
  function bgmResolve(name) {
    var ckey = 'bgmB:' + name;
    var c = cacheGet(ckey, CACHE_TTL.search);
    if (c !== undefined) return Promise.resolve(c);
    return bgmSearch(name, 8).then(function (list) {
      if (!list.length) { cacheSet(ckey, null); return null; }
      var ranked = list.map(function (e) { return { entry: e, s: bgmTitleScore(e, null, name) }; })
                       .sort(function (a, b) { return b.s - a.s; });

      var settle = function (best) {
        var out = { entry: best.entry, score: best.s };
        cacheSet(ckey, out);
        return out;
      };
      if (ranked[0].s >= 0.9) return settle(ranked[0]);

      // 简写要重排 —— 实测「Re:0」的正确条目排在 Bangumi 结果的第 5 位，
      // 所以这里取前 6 条（不是前 3 条）拉别名，且只取有一定文本重叠的，省请求
      var pool = ranked.slice(0, 6).filter(function (r) { return r.s > 0.05; });
      if (!pool.length) pool = ranked.slice(0, 3);
      return Promise.all(pool.map(function (r) {
        return bgmAliases(r.entry.id).then(function (al) {
          return { entry: r.entry, s: bgmTitleScore(r.entry, al, name) };
        });
      })).then(function (refined) {
        return settle(refined.sort(function (a, b) { return b.s - a.s; })[0]);
      });
    });
  }

  // 一条候选名 → 所有可能的（AniList 条目 + 来路）
  // AniList 直查永远走；含中文时额外走一趟 Bangumi 桥
  function candidateMedia(name) {
    var results = [], jobs = [];
    jobs.push(anilistSearch(name).then(function (list) {
      (list || []).forEach(function (m) { results.push({ media: m, via: 'anilist' }); });
    }));
    if (hasHan(name)) {
      jobs.push(bgmResolve(name).then(function (hit) {
        if (!hit || !hit.entry || hit.score < 0.75) return;
        return anilistSearch(hit.entry.name).then(function (list) {
          (list || []).forEach(function (m) {
            results.push({ media: m, via: 'bangumi', bgm: hit.entry, bgmScore: hit.score });
          });
        });
      }).catch(function () { /* Bangumi 挂了不能影响主流程 */ }));
    }
    return Promise.all(jobs).then(function () { return results; });
  }

  function pickBestMatch(cands, epNum, ctx) {
    return Promise.resolve(cands.reduce(function (chain, name) {
      return chain.then(function (acc) {
        if (acc && acc.score >= 55) return acc;
        return candidateMedia(name).then(function (items) {
          var best = acc;
          (items || []).forEach(function (it) {
            var m = it.media;
            if (!m) return;
            var titles = [m.title && m.title.romaji, m.title && m.title.english, m.title && m.title.native]
              .concat(m.synonyms || []);
            // Bangumi 那条路顺手把中文名/日文原名也纳入比对
            if (it.bgm) titles.push(it.bgm.name_cn, it.bgm.name);
            titles = titles.filter(Boolean);

            var nk = normKey(name);
            var sim = 0;
            titles.forEach(function (t) {
              sim = Math.max(sim, similarity(t, name));
              if (nk && normKey(t) === nk) sim = 1;
            });
            if (sim < 0.5) return;

            var score = sim * 30;
            // 中文名经中文库命中，比 AniList 的「碰巧有中文别名」可信
            if (it.via === 'bangumi') score += 6;

            // 集数上限交叉消歧：搜「我推的孩子」实测返回 2nd Season，靠这步排除。
            // 但「合集分P数多于这一季的话数」时不扣分 —— 那说明本来就是多季连播合集
            // （第 21 个 P 而某季只有 20 话，是跨季而不是认错）
            var eps = m.episodes;
            var looksMulti = detectMultiSeason(ctx).multi || (ctx.videos > 1 && eps && ctx.videos > eps);
            if (epNum && eps && epNum <= eps) score += 12;
            else if (epNum && eps && epNum > eps && !looksMulti) score -= 25;

            // TV / TV 短 形态加分（番剧搬运的原片多数是这个）
            if (m.format === 'TV' || m.format === 'TV_SHORT') score += 6;

            // 年年不符扣分（可选：ctx.duration / 上传年份）
            var y = m.startDate && m.startDate.year;
            if (y && ctx.pubdate) {
              var py = new Date(ctx.pubdate * 1000).getFullYear();
              if (py - y > 6) score -= 8;      // 上传年份比播出晚很多 → 老番重传而已，不一定是别的番
              if (y - py > 1) score -= 20;     // 播出比上传还晚 → 大概率认错
            }
            if (!best || score > best.score) {
              best = {
                anilistId: m.id, malId: m.idMal, title: (m.title && (m.title.native || m.title.romaji)) || name,
                score: score, episodes: eps, format: m.format, year: y,
                via: it.via, bgm: it.bgm || null, matchedName: name,
                // 同一批搜索结果里的其它季（同名作品），季链缺条目时可直接用
                family: (items || []).map(function (x) { return x.media; }).filter(Boolean)
              };
            }
          });
          return best;
        });
      });
    }, Promise.resolve(null)));
  }

  /* ==================================================================
   * 8. relation-rules：绝对集数 → 分季重映射
   * 例：Fairy Tail 第 176 集其实要查 MAL 22043 的第 1 集
   * 公式：newEp = to.start + (ep - from.start)
   * ================================================================== */
  function applyRelationRules(malId, ep) {
    var ckey = 'rel:' + malId;
    var c = cacheGet(ckey, CACHE_TTL.rel);
    function apply(rules) {
      if (!rules || !rules.length) return { malId: malId, ep: ep, mapped: false };
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.from && r.to && ep >= r.from.start && ep <= r.from.end) {
          return { malId: r.to.malId, ep: r.to.start + (ep - r.from.start), mapped: true, note: r.note };
        }
      }
      return { malId: malId, ep: ep, mapped: false };
    }
    if (c !== undefined) return Promise.resolve(apply(c));
    return jget('https://api.aniskip.com/v2/relation-rules/' + encodeURIComponent(malId))
      .then(function (d) { var r = d && d.rules; cacheSet(ckey, r || []); return apply(r); })
      .catch(function () { cacheSet(ckey, []); return { malId: malId, ep: ep, mapped: false }; });
  }

  /* ==================================================================
   * 8.5 多季连播合集：季链推导
   *
   * 「第一季+第二季」装在一个合集里时，B 站的集号是跨季连续的（1~26），
   * 而数据库里第 1、2 季是两个独立条目、各自从第 1 集编号。
   * 所以必须算出「第 N 话属于哪一季的第几话」。
   *
   * 手段：AniList relations 的 SEQUEL / PREQUEL 链 → 得到各季话数 →
   * 累计边界；某季话数未知（新番还没播完常见）时，用标题里的「全N话」反推。
   * 全部信息都会写进绑定里，面板上可见、可手改 —— 因为这属于「猜」，必须让用户能纠正。
   * ================================================================== */
  var ANILIST_REL_Q =
    'query($id:Int){Media(id:$id,type:ANIME){id idMal episodes title{native romaji} startDate{year} ' +
    'relations{edges{relationType node{id idMal episodes startDate{year} title{native romaji}}}}}}';

  function anilistRelations(id) {
    var ckey = 'alrel:' + id;
    var c = cacheGet(ckey, CACHE_TTL.rel);
    if (c !== undefined) return Promise.resolve(c);
    return jpost(ANILIST, { query: ANILIST_REL_Q, variables: { id: id } })
      .then(function (d) {
        var m = (d && d.data && d.data.Media) || null;
        cacheSet(ckey, m);
        return m;
      })
      .catch(function () { return null; });
  }

  function seasonNode(node) {
    if (!node || !node.id) return null;
    return {
      anilistId: node.id,
      malId: node.idMal || null,
      episodes: node.episodes || 0,
      title: (node.title && (node.title.native || node.title.romaji)) || '',
      format: node.format || '',
      year: node.year || (node.startDate && node.startDate.year) || 0
    };
  }

  /* 分P分段 ↔ 数据库条目序列 的对齐。
   * 实测坑（BV1KspF6iELH「无职转生 第1-3季」）：B站分段是
   *   第一季 24 P / 第二季 25 P / 第三季 14 P，
   * 而数据库这边是 5 个条目：Ⅲ 没被连成续集，Ⅰ(11) 第2クール(12) Ⅱ(13) Ⅱ第2クール(12) Ⅲ(14)。
   * 两边不是一对一 —— 按位次硬配（原来的做法）会把第 2 段配到「第2クール」上，
   * 于是第 24 个 P 之后全部错位。但**累计话数**能对上：
   *   第1段 24 ≈ 11+12=23（差的 1 是 OVA）、第2段 25 = 13+12、第3段 14 = 14。
   * 所以按累计话数贪心对齐，容差内才采纳；对不上就标记「未解析」，该段不跳（宁可不跳，不可错跳）。 */
  function alignGroupsToSeasons(groups, seasons) {
    var out = [], si = 0;
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var tol = Math.max(2, Math.round(g.episodes * 0.1));
      var pick = [], sum = 0;
      while (si < seasons.length && (sum < g.episodes - tol || !pick.length)) {
        var s = seasons[si];
        if (!s.episodes) break;                 // 话数未知的条目无法参与累计
        pick.push(s); sum += s.episodes; si++;
      }
      out.push({
        season: g.season, startPage: g.startPage, endPage: g.endPage, total: g.episodes,
        entries: pick, sum: sum, diff: sum - g.episodes,
        ok: !!pick.length && Math.abs(sum - g.episodes) <= tol
      });
    }
    // 尾段：条目还有剩（例如第三季没被连进续集链），补进最后一个没对齐的段
    if (si < seasons.length) {
      var tail = out[out.length - 1];
      var rest = seasons.slice(si).filter(function (s) { return s.episodes; });
      if (tail && rest.length && !tail.ok) {
        rest.forEach(function (s) { tail.entries.push(s); tail.sum += s.episodes; });
        tail.diff = tail.sum - tail.total;
        tail.ok = Math.abs(tail.diff) <= Math.max(2, Math.round(tail.total * 0.1));
      }
    }
    out.forEach(function (grp) {
      var acc = 0;
      grp.entries.forEach(function (e) { e.startWithin = acc + 1; acc += (e.episodes || 0); });
    });
    return out;
  }

  /* 续季关系不一定连得上（实测：無職転生Ⅲ 就没被连成 Ⅱ 的续集），
   * 所以分段对不齐时，再用「同名搜索」把缺的条目补进家族序列。 */
  function extendFamilyBySearch(seasons, groups, baseName, extraMedia, refTitle) {
    if (!groups || groups.length < 2) return Promise.resolve(seasons);
    var probe = alignGroupsToSeasons(groups, seasons);
    if (probe.every(function (g) { return g.ok; })) return Promise.resolve(seasons);  // 已经对得上，不多打一次请求

    // 优先用手上已有的候选列表（搜索面板/自动匹配那批）。
    // 注意不能拿中文名去搜 AniList —— 实测中文搜索命中率很低，
    // 而且容器里 fill 的中文名（如「无职转生」）在 AniList 上是 0 条。
    var src = extraMedia && extraMedia.length
      ? Promise.resolve(extraMedia)
      : (baseName ? anilistSearch(baseName) : Promise.resolve([]));

    // 相似度门禁必须拿「已选中条目的原名」比 —— 拿中文名去比日文标题会全军覆没
    // （实测：用「无职转生」比「無職転生Ⅱ ～異世界行ったら本気だす～」→ 全部被滤掉，
    //   于是第 2、3 段都标成「没对上数据库条目」）
    var ref = refTitle || (extraMedia && extraMedia.length ? '' : baseName);

    return src.then(function (list) {
      var have = {}, latest = 0;
      seasons.forEach(function (s) { have[s.anilistId] = 1; if (s.year > latest) latest = s.year; });
      var extra = [];
      (list || []).forEach(function (m) {
        var sn = seasonNode(m);
        if (!sn || have[sn.anilistId]) return;
        if (sn.format !== 'TV' && sn.format !== 'TV_SHORT' && sn.format !== 'ONA') return;
        if (!sn.episodes) return;
        if (latest && sn.year && sn.year < latest) return;            // 比家族最新的还早 → 多半是无关旧作
        if (ref && similarity(sn.title, ref) < 0.5) return;           // 同名但不同的作品，别混进来
        extra.push(sn);
      });
      extra.sort(function (a, b) { return (a.year || 9999) - (b.year || 9999) || a.anilistId - b.anilistId; });
      return seasons.concat(extra);
    });
  }

  // 组装季链：自身 + 沿 SEQUEL/PREQUEL 展开（最多 3 层，防异常数据无限扩张）
  // 分P标题里带季标记时，以「UP 主自己分的段」为准（更可靠），续季关系只用来取各季 ID
  function buildSeasonChain(anilistId, totalEpsFromTitle, ctx, baseName, extraMedia, refTitle) {
    var ckey = 'chain:' + anilistId + ':' + (totalEpsFromTitle || 0) + ':' + ((ctx && ctx.bvid) || '') + ':' + (baseName || '');
    var c = cacheGet(ckey, CACHE_TTL.rel);
    if (c !== undefined) return Promise.resolve(c);

    return anilistRelations(anilistId).then(function (self) {
      if (!self) return null;
      var byId = {}, seen = {};
      var add = function (node) {
        var s = seasonNode(node);
        if (!s) return;
        if (!byId[s.anilistId]) byId[s.anilistId] = s;
        else if (s.episodes && !byId[s.anilistId].episodes) byId[s.anilistId].episodes = s.episodes;
      };
      add(self);
      seen[self.id] = 1;

      var kidsOf = function (m) {
        return (((m || {}).relations || {}).edges || [])
          .filter(function (e) { return e.relationType === 'SEQUEL' || e.relationType === 'PREQUEL'; })
          .map(function (e) { return e.node; })
          .filter(function (n) { return n && n.id; });
      };

      function expand(nodes, depth) {
        if (depth > 3) return Promise.resolve();
        var todo = nodes.filter(function (n) { return !seen[n.id]; });
        if (!todo.length) return Promise.resolve();
        return Promise.all(todo.map(function (n) {
          seen[n.id] = 1;
          add(n);
          return anilistRelations(n.id).then(function (full) {
            if (full) add(full);
            return expand(kidsOf(full || n), depth + 1);
          });
        })).then(function () {});
      }
      var first = kidsOf(self).filter(function (n) { return !seen[n.id]; });
      first.forEach(function (n) { seen[n.id] = 1; add(n); });

      return expand(first, 1).then(function () {
        var all = Object.keys(byId).map(function (k) { return byId[k]; })
          .sort(function (a, b) { return (a.year || 9999) - (b.year || 9999) || a.anilistId - b.anilistId; });
        // 续季链顺路会带进剧场版 / 音乐之类的条目 —— 它们不是「季」，
        // 留着会让季链多出一季并把边界算错（实测影之实力者会带进 2027 剧场版）
        var onlyTv = all.filter(function (s) { return s.format !== 'MOVIE' && s.format !== 'MUSIC'; });
        var seasons = onlyTv.length >= 2 ? onlyTv : all;

        var groups = seasonGroupsFromParts(ctx);

        // 路径 A：分P标题给了季边界 —— 以「UP 主自己分的段」为准。
        // 每段可能对应数据库里的多个条目（实测：B站「第一季」= 無職転生Ⅰ + 第2クール）
        if (groups && groups.length >= 2) {
          return extendFamilyBySearch(seasons, groups, baseName, extraMedia, refTitle).then(function (family) {
            var aligned = alignGroupsToSeasons(groups, family);
            var accp = 0;
            var segs = aligned.map(function (g) {
              var s = {
                season: g.season, startPage: g.startPage, endPage: g.endPage,
                episodes: g.total, entries: g.entries, entriesSum: g.sum, diff: g.diff, aligned: g.ok,
                // 只对应单个条目时保留扁平字段，老绑定与旧逻辑不受影响
                anilistId: g.entries.length === 1 ? g.entries[0].anilistId : null,
                malId: g.entries.length === 1 ? g.entries[0].malId : null,
                title: g.entries.length
                  ? g.entries.map(function (e) { return e.title; }).join(' + ')
                  : ('第 ' + g.season + ' 段（未对上数据库）'),
                startAbs: accp + 1, endAbs: accp + g.total
              };
              accp += g.total;
              return s;
            });
            var unresolved = segs.filter(function (s) { return !s.aligned; });
            var chainParts = {
              seasons: segs, total: accp,
              partial: unresolved.length > 0,
              mismatch: unresolved.length > 0 || !!(totalEpsFromTitle && accp !== totalEpsFromTitle),
              totalEpsFromTitle: totalEpsFromTitle || 0, source: 'parts',
              groups: segs, unresolved: unresolved.length
            };
            cacheSet(ckey, chainParts);
            return chainParts;
          });
        }

        // 路径 B：只能靠续季关系推 —— 话数缺失时用「全N话」反推
        var unknown = seasons.filter(function (s) { return !s.episodes; });
        if (unknown.length === 1 && totalEpsFromTitle) {
          var known = seasons.reduce(function (a, s) { return a + (s.episodes || 0); }, 0);
          var rest = totalEpsFromTitle - known;
          if (rest > 0 && rest <= 200) unknown[0].episodes = rest;
        }

        var acc = 0;
        seasons.forEach(function (s) {
          s.startAbs = acc + 1;
          s.endAbs = acc + (s.episodes || 0);
          acc += s.episodes || 0;
        });
        var chain = {
          seasons: seasons,
          total: acc,
          partial: seasons.some(function (s) { return !s.episodes; }),
          mismatch: !!(totalEpsFromTitle && acc && acc !== totalEpsFromTitle),
          totalEpsFromTitle: totalEpsFromTitle || 0,
          source: 'relations'
        };
        cacheSet(ckey, chain);
        return chain;
      });
    }).catch(function (e) {
      try { console.warn(LOG, 'season chain failed:', (e && e.message) || e); } catch (x) { /* ignore */ }
      return null;
    });
  }

  // 绝对集号 → (哪一季, 季内第几话)
  function mapBySeasonChain(chain, absEp) {
    if (!chain || !chain.seasons || !chain.seasons.length) return null;
    for (var i = 0; i < chain.seasons.length; i++) {
      var s = chain.seasons[i];
      if (!s.episodes) continue;                  // 话数未知的季不参与映射
      if (absEp < s.startAbs || absEp > s.endAbs) continue;

      // 这一段对应数据库里的多个条目（B站「第一季」= Ⅰ + 第2クール）：
      // 用「段内话号」在条目序列里累加定位
      if (s.entries && s.entries.length) {
        var use = absEp - s.startAbs + 1;
        for (var j = 0; j < s.entries.length; j++) {
          var e = s.entries[j];
          if (!e.episodes || !e.malId) continue;
          if (use >= e.startWithin && use <= e.startWithin + e.episodes - 1) {
            return {
              season: i + 1, seasonCount: chain.seasons.length,
              anilistId: e.anilistId, malId: e.malId, title: e.title,
              ep: use - e.startWithin + 1,
              startAbs: s.startAbs, endAbs: s.endAbs,
              group: { season: s.season, entries: s.entries, startPage: s.startPage, endPage: s.endPage }
            };
          }
        }
        return null;   // 落在段内但超出所有条目（例如段末的 OVA）→ 不跳
      }

      if (!s.anilistId || !s.malId) continue;
      return {
        season: i + 1, seasonCount: chain.seasons.length,
        anilistId: s.anilistId, malId: s.malId, title: s.title,
        ep: absEp - s.startAbs + 1, startAbs: s.startAbs, endAbs: s.endAbs
      };
    }
    return null;
  }

  /* ==================================================================
   * 9. 数据源 A：AniSkip（MAL ID，显式区间）
   * 注意 episodeLength 必传；传 0 = 返回全部版本
   * （视频结尾常被塞别的片段防下架，真实时长不可信，所以一律传 0 后本地去重）
   * ================================================================== */
  function fetchAniSkip(malId, ep) {
    var types = [];
    if (config.jumpOp) types.push('op');
    if (config.jumpEd) types.push('ed');
    if (config.jumpRecap) types.push('recap');
    // mixed-op / mixed-ed =「OP/ED 与正片画面融在一起」，不是独立的 OP 段。
    // 实测无职转生大量集数就是这种（每集 OP 画面都不同 / 干脆没有独立 OP），
    // 跳过这类区间会切掉正片内容，所以独立成开关、默认关。
    if (config.jumpMixed) types.push('mixed-op', 'mixed-ed');
    if (!types.length) return Promise.resolve([]);

    var qs = types.map(function (t) { return 'types[]=' + t; }).join('&');
    var url = 'https://api.aniskip.com/v2/skip-times/' + encodeURIComponent(malId) + '/' +
              encodeURIComponent(ep) + '?' + qs + '&episodeLength=0';
    var ckey = 'seg:as:' + malId + ':' + ep + ':' + types.join(',');
    var c = cacheGet(ckey, CACHE_TTL.seg);
    if (c !== undefined) return Promise.resolve(c);

    return jget(url).then(function (d) {
      var res = (d && d.found && d.results) || [];
      var segs = res.map(function (r) {
        var raw = r.skipType || '';
        return {
          type: raw.replace('mixed-', ''),
          mixed: /^mixed-/.test(raw),
          start: +r.interval.startTime,
          end: +r.interval.endTime,
          source: 'aniskip',
          epLen: r.episodeLength || 0
        };
      });
      cacheSet(ckey, segs);
      return segs;
    }).catch(function () { return []; });
  }

  /* ==================================================================
   * 10. 数据源 B：Anime Skip（AniList ID，GraphQL）
   * 数据形态与 AniSkip 不同：是「分节标记」——
   * 每条 timestamp 标一段的起点，终点 = 下一条的位置，需自己拼区间
   * ================================================================== */
  var ANIMESKIP_CLIENT_ID = 'ZGfO0sMF3eCwLYf8yMSCJjlynwNGRXWE'; // 官方文档公开的共享 ID，有限流
  var ANIMESKIP_Q =
    'query($id:String!){findShowsByExternalId(service:ANILIST,serviceId:$id){name ' +
    'episodes{number timestamps{at type{name}}}}}';

  var AS_TYPE_MAP = {
    'Intro': 'op', 'New Intro': 'op', 'Mixed Intro': 'op',
    'Credits': 'ed', 'New Credits': 'ed', 'Mixed Credits': 'ed',
    'Recap': 'recap', 'Preview': null, 'Canon': null, 'Transition': null,
    'Title Card': null, 'Branding': null, 'Unknown': null
  };

  function fetchAnimeSkip(anilistId, ep) {
    if (!anilistId) return Promise.resolve([]);
    var ckey = 'seg:askp:' + anilistId + ':' + ep;
    var c = cacheGet(ckey, CACHE_TTL.seg);
    if (c !== undefined) return Promise.resolve(c);

    return jpost('https://api.anime-skip.com/graphql',
      { query: ANIMESKIP_Q, variables: { id: String(anilistId) } },
      { 'X-Client-ID': ANIMESKIP_CLIENT_ID })
      .then(function (d) {
        var shows = (d && d.data && d.data.findShowsByExternalId) || [];
        var segs = [];
        shows.forEach(function (show) {
          (show.episodes || []).forEach(function (e) {
            // number 可能是 null（整部剧级记录），parseFloat(null)=NaN 会静默跳过
            if (e.number === null || e.number === undefined) return;
            if (parseFloat(e.number) !== ep) return;
            var ts = (e.timestamps || []).slice().sort(function (a, b) { return a.at - b.at; });
            for (var i = 0; i < ts.length; i++) {
              var mapped = AS_TYPE_MAP[ts[i].type && ts[i].type.name];
              if (!mapped) continue;
              var start = +ts[i].at;
              // 分节标记制：终点 = 下一条的位置。
              // 最后一条没有下家，终点无法确定 —— 宁可丢弃，也不要用一个猜的长度
              // （参考实现里给过 90 秒兜底，但这会凭空造出一个总在通过校验的假区间）
              if (i + 1 >= ts.length) continue;
              var end = +ts[i + 1].at;
              segs.push({ type: mapped, start: start, end: end, source: 'animeskip', epLen: 0 });
            }
          });
        });
        cacheSet(ckey, segs);
        return segs;
      })
      .catch(function () { return []; });
  }

  /* ==================================================================
   * 11. 合并与校验（照搬参考脚本的成熟参数）
   * ================================================================== */
  var LIMITS = { op: [15, 210], ed: [15, 210], recap: [15, 300] };

  function validateSegs(segs, videoDuration) {
    var out = [], seen = {};
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!s || !LIMITS[s.type]) continue;
      var st = +s.start, en = +s.end;
      if (!isFinite(st) || !isFinite(en)) continue;
      if (en <= st) continue;
      var lim = LIMITS[s.type];
      var len = en - st;
      if (len < lim[0] || len > lim[1]) continue;
      if (st < 0 || (videoDuration && st > videoDuration - 3)) continue;

      var key = s.type + ':' + Math.round(st / 3);
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(s);
    }
    // 同类型重叠时，保留更早的
    out.sort(function (a, b) { return a.start - b.start; });
    var final = [];
    for (var j = 0; j < out.length; j++) {
      var conflict = false;
      for (var k = 0; k < final.length; k++) {
        if (final[k].type === out[j].type && !(out[j].end <= final[k].start || out[j].start >= final[k].end)) {
          conflict = true; break;
        }
      }
      if (!conflict) final.push(out[j]);
    }
    return final;
  }

  function mergeSegments(a, b, videoDuration) {
    // AniSkip 优先（显式区间更可靠），Anime Skip 补 AniSkip 没有的类型
    var all = a.slice();
    b.forEach(function (s) {
      var has = all.some(function (x) {
        return x.type === s.type && !(s.end <= x.start || s.start >= x.end);
      });
      if (!has) all.push(s);
    });
    return validateSegs(all, videoDuration);
  }

  function segmentEnabled(s) {
    if (s.mixed) return config.jumpMixed;      // 融进画面的 OP/ED，默认不跳
    if (s.type === 'op') return config.jumpOp;
    if (s.type === 'ed') return config.jumpEd;
    if (s.type === 'recap') return config.jumpRecap;
    return false;
  }

  /* ==================================================================
   * 12. 置信度评分 —— 宁可不跳，不可错跳
   * ================================================================== */
  function durationScore(sec) {
    if (!sec) return 0;
    var m = sec / 60;
    if (m >= 20 && m <= 40) return 20;    // 标准 TV 动画单集
    if (m > 40 && m <= 70) return 10;     // 加长集 / 结尾挂了别的片段（防下架常见）
    return 0;                             // 其余不给分，但也不否决
  }

  function computeConfidence(ctx, match, ep, segs) {
    var score = 0, reasons = [];
    if (ep) { score += Math.min(30, ep.score); reasons.push('集号 ' + ep.num + '（' + ep.from + '）'); }
    else { reasons.push('未识别到集号'); }
    if (match) { score += Math.round(Math.min(30, match.score)); reasons.push('番名匹配 ' + Math.round(match.score)); }
    else { reasons.push('未匹配到番剧'); }
    var ds = durationScore(ctx.duration);
    if (ds) { score += ds; reasons.push('时长 ' + Math.round(ctx.duration / 60) + ' 分钟'); }
    if (segs && segs.length) { score += 20; reasons.push('查到 ' + segs.length + ' 段时间戳'); }
    return { score: Math.max(0, Math.min(100, score)), reasons: reasons };
  }

  /* ==================================================================
   * 13. 主识别流程
   * ================================================================== */
  function fetchSegsFor(malId, anilistId, ep) {
    return applyRelationRules(malId, ep).then(function (rm) {
      return Promise.all([
        fetchAniSkip(rm.malId, rm.ep),
        fetchAnimeSkip(anilistId, rm.ep)
      ]).then(function (r) {
        return { segs: mergeSegments(r[0], r[1], 0), rm: rm };
      });
    });
  }

  /* 集号取自哪里：优先用「分P标题里的季标记」推出的合集内绝对集号，
   * 因为季内话数（【S2】01 → 1）套到季链上是错的，必须是 21 */
  function episodeGuess(ctx) {
    var abs = absEpisodeFromPart(ctx);
    if (abs && abs.absEp) return { num: abs.absEp, score: 28, from: 'partSeason' };
    return extractEpisode(ctx);
  }

  function identify(ctx) {
    var ms = detectMultiSeason(ctx);
    var guess = episodeGuess(ctx);

    // 手动绑定优先 —— 绑过就代表用户明确要它跳，不再走标题猜测
    var bind = getBinding(ctx);
    if (bind) {
      var bindEp = resolveEpisode(ctx, bind, guess);
      var chainMiss = false;

      // 第 1 优先：季链（「第一季+第二季」装在一个合集里的情况）
      if (bind.seasonChain && bind.seasonChain.seasons && bind.seasonChain.seasons.length > 1) {
        var hit = mapBySeasonChain(bind.seasonChain, bindEp.num);
        if (hit && hit.malId) {
          return fetchSegsFor(hit.malId, hit.anilistId, hit.ep).then(function (r) {
            var setTitle = hit.group && hit.group.entries && hit.group.entries.length > 1
              ? hit.group.entries.map(function (e) { return e.title; }).join(' + ')
              : (hit.title || bind.title);
            return {
              ok: true, manual: true, title: setTitle,
              anilistId: hit.anilistId, malId: hit.malId,
              episode: r.rm.ep, segments: r.segs, ep: bindEp, bindingKey: bind._key,
              season: hit, seasonChain: bind.seasonChain, multiSeason: ms,
              confidence: {
                score: 100,
                reasons: ['手动绑定 · 季链定位到第 ' + hit.season + ' 段（' + (hit.title || '') + '）第 ' + hit.ep + ' 话']
              },
              relationMapped: r.rm.mapped
            };
          });
        }
        // 分段模型下落空（段末的 OVA／特别篇、或该段没对上条目）：
        // 明确不跳，不去猜一个 MAL 条目 —— 错跳比不跳糟糕十倍
        if (bind.seasonChain.groups && bind.seasonChain.groups.length) {
          var seg = null;
          for (var si = 0; si < bind.seasonChain.seasons.length; si++) {
            var cs2 = bind.seasonChain.seasons[si];
            if (bindEp.num >= cs2.startAbs && bindEp.num <= cs2.endAbs) { seg = cs2; break; }
          }
          var why2 = (seg && seg.aligned === false)
            ? '第 ' + seg.season + ' 段没能对上数据库条目，这一段不跳'
            : '第 ' + bindEp.num + ' 话超出该段对应的条目（大概是 OVA／特别篇），不跳';
          return Promise.resolve({
            ok: false, reason: 'chain-miss', manual: true, multiSeason: ms,
            seasonChain: bind.seasonChain, ep: bindEp,
            confidence: { score: 0, reasons: [why2] }
          });
        }
        // 越界、或落在话数未知的季上：不硬猜，退化单季并说明
        chainMiss = true;
      }

      return fetchSegsFor(bind.malId, bind.anilistId, bindEp.num).then(function (r) {
        var reasons = ['手动绑定 · 集号来自 ' + bindEp.from];
        if (chainMiss) reasons.push('第 ' + bindEp.num + ' 话没落在季链范围内，按单季处理');
        return {
          ok: true, manual: true, title: bind.title,
          anilistId: bind.anilistId, malId: bind.malId,
          episode: r.rm.ep, segments: r.segs, ep: bindEp, bindingKey: bind._key,
          seasonChain: bind.seasonChain || null, multiSeason: ms, chainMiss: chainMiss,
          confidence: { score: chainMiss ? 55 : 100, reasons: reasons },
          relationMapped: r.rm.mapped
        };
      });
    }

    if (isBlacklisted(ctx)) {
      return Promise.resolve({ ok: false, reason: 'blacklisted', multiSeason: ms });
    }
    // off 模式：没有绑定就不做任何推测，普通视频在这里直接止步
    if (config.autoDetect === 'off') {
      return Promise.resolve({ ok: false, reason: 'autodetect-off', multiSeason: ms });
    }

    var ep = guess;
    if (!ep || !ep.num) {
      return Promise.resolve({ ok: false, reason: 'no-episode', multiSeason: ms, confidence: { score: 0, reasons: ['未识别到集号'] } });
    }

    var cands = animeNameCandidates(ctx);
    if (!cands.length) {
      return Promise.resolve({ ok: false, reason: 'no-name', multiSeason: ms, confidence: { score: 0, reasons: ['标题无可用番名'] } });
    }

    return pickBestMatch(cands, ep.num, ctx).then(function (match) {
      if (!match || !match.malId) {
        return { ok: false, reason: 'no-match', multiSeason: ms, confidence: { score: 0, reasons: ['番名匹配失败'] } };
      }
      if (match.score < 22) {
        return { ok: false, reason: 'low-score', match: match, multiSeason: ms, confidence: { score: 0, reasons: ['番名匹配置信度不足，不敢采纳'] } };
      }
      // 多季连播：先把季链推导出来，再把绝对集号定位到某一季的某一话。
      // 触发条件有两个 ——
      //   ① 标题 / 分P标题里有多季信号（「两季32话全集」、P21 的 part 是【S2】01）
      //   ② 数据驱动：当前 P 序号已经超出这一季的话数
      //      （实测 BV1kk7r6iEC4：在第 21 个 P，而第一季只有 20 话 → 必然跨季）
      var needChain = ms.multi || (ctx.videos > 1 && match.episodes && ctx.page > match.episodes);
      // baseName 传进去：续季链可能断掉（实测無職転生Ⅲ），要靠同名搜索补齐家族序列
      var prep = needChain ? buildSeasonChain(match.anilistId, ms.totalEps, ctx, match.matchedName || match.title, match.family, match.title) : Promise.resolve(null);
      return prep.then(function (chain) {
        var hit = chain ? mapBySeasonChain(chain, ep.num) : null;
        var useMal = (hit && hit.malId) ? hit.malId : match.malId;
        var useAni = hit ? hit.anilistId : match.anilistId;
        var useEp = hit ? hit.ep : ep.num;

        return fetchSegsFor(useMal, useAni, useEp).then(function (r) {
          var conf = computeConfidence(ctx, match, ep, r.segs);
          if (chain) {
            conf.reasons.push(chain.partial ? '季链（有话数未知的季）' : '季链 ' + chain.seasons.length + ' 季 / 共 ' + chain.total + ' 话');
            if (hit) conf.reasons.push('第 ' + ep.num + ' 话 → 第 ' + hit.season + ' 季第 ' + hit.ep + ' 话');
            if (chain.mismatch) { conf.score = Math.max(0, conf.score - 10); conf.reasons.push('季链话数与「全' + chain.totalEpsFromTitle + '话」对不上，已降权'); }
          }
          return {
            ok: true, manual: false, title: (hit && hit.title) || match.title,
            anilistId: useAni, malId: useMal,
            episode: r.rm.ep, segments: r.segs, confidence: conf, match: match, ep: ep,
            season: hit || null, seasonChain: chain || null, multiSeason: ms,
            relationMapped: r.rm.mapped
          };
        });
      });
    });
  }

  /* ==================================================================
   * 14. 播放器监控与跳转
   * ================================================================== */
  function getVideo() {
    var list = document.querySelectorAll('video');
    if (!list.length) return null;
    return list.length === 1 ? list[0] : pickBiggest(list);
  }

  function pickBiggest(list) {
    var best = null, bestArea = 0;
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      var r = v.getBoundingClientRect ? v.getBoundingClientRect() : { width: 0, height: 0 };
      var area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
  }

  var EPSILON = 0.06;          // 跳过片段终点后多一点，避免卡在边界反复触发
  var COOLDOWN_MS = 160;       // 跳转后冷却，防抖
  var POLL_MS = 50;            // 轮询间隔

  var runtime = {
    ctx: null,
    result: null,
    video: null,
    timer: null,
    skipping: false,
    lastSkipAt: 0,
    skipped: {},               // 记录本集已跳过的时间戳类型，避免反复跳
    lastSegKey: ''
  };

  function shouldSkipThisSegment(seg) {
    if (!segmentEnabled(seg)) return false;
    return true;
  }

  function doSeek(video, target) {
    try { video.currentTime = target; return true; }
    catch (e) { return false; }
  }

  function performSkip(video, seg) {
    if (runtime.skipping) return;
    if (Date.now() - runtime.lastSkipAt < COOLDOWN_MS) return;
    if (runtime.skipped[seg.type + ':' + Math.round(seg.start)]) return;

    runtime.skipping = true;
    runtime.lastSkipAt = Date.now();
    runtime.skipped[seg.type + ':' + Math.round(seg.start)] = true;

    var wasPaused = video.paused;
    var target = Math.min(seg.end + EPSILON, (video.duration || seg.end) - 0.05);
    var from = video.currentTime;

    var ok = doSeek(video, target);
    runtime.skipping = false;

    if (ok) {
      if (!wasPaused && video.paused) { try { video.play(); } catch (e) { /* ignore */ } }
      notifySkip(seg, from, video);
    }
  }

  function notifySkip(seg, from, video) {
    var label = seg.type === 'op' ? '片头 OP' : (seg.type === 'ed' ? '片尾 ED' : '回顾 Recap');
    if (config.showToast) {
      showToast('已跳过 ' + label, fmtTime(seg.start) + ' → ' + fmtTime(seg.end), function () {
        // 撤回：这是防错跳的最后一道保险
        try { video.currentTime = Math.max(0, from - 1); } catch (e) { /* ignore */ }
        delete runtime.skipped[seg.type + ':' + Math.round(seg.start)];
      });
    }
  }

  function checkOnce() {
    var video = runtime.video;
    if (!video || !document.body.contains(video)) {
      var nv = getVideo();
      if (nv) { runtime.video = nv; runtime.video.dataset.biliAniskip = '1'; }
      video = nv;
    }
    if (!video) return;
    if (!runtime.result || !runtime.result.ok) return;
    var segs = runtime.result.segments || [];
    if (!segs.length) return;
    if (video.paused || video.ended) return;
    if (!video.duration || !isFinite(video.duration)) return;

    var t = video.currentTime;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!shouldSkipThisSegment(s)) continue;
      if (t >= s.start && t < s.end - 0.2) {
        performSkip(video, s);
        return;
      }
    }
  }

  function startMonitor() {
    stopMonitor();
    runtime.timer = setInterval(checkOnce, POLL_MS);
    var v = runtime.video;
    if (v) {
      ['playing', 'timeupdate', 'seeked'].forEach(function (ev) {
        v.addEventListener(ev, function () { checkOnce(); });
      });
    }
  }
  function stopMonitor() {
    if (runtime.timer) { clearInterval(runtime.timer); runtime.timer = null; }
  }

  /* ==================================================================
   * 15. UI：状态胶囊 + 绑定面板 + 设置面板 + Toast
   * ================================================================== */
  var host = null, shadow = null, uiRoot = null, toastRoot = null;

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'bili-aniskip-host';
    host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483000;pointer-events:none;';
    (document.body || document.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = UI_CSS;
    shadow.appendChild(style);

    uiRoot = document.createElement('div');
    uiRoot.className = 'root';
    shadow.appendChild(uiRoot);

    toastRoot = document.createElement('div');
    toastRoot.className = 'toast-root';
    shadow.appendChild(toastRoot);
  }

  var UI_CSS = [
    '.root{position:fixed;top:64px;right:20px;pointer-events:auto;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.5;}',
    '.pill{display:inline-flex;align-items:center;gap:6px;background:rgba(20,22,26,.86);color:#fff;',
    '  border-radius:18px;padding:6px 12px;box-shadow:0 4px 16px rgba(0,0,0,.3);backdrop-filter:blur(6px);cursor:pointer;user-select:none;}',
    '.pill:hover{background:rgba(30,34,40,.92);}',
    '.pill .dot{width:7px;height:7px;border-radius:50%;background:#00d1b2;flex:0 0 auto;}',
    '.pill .dot.warn{background:#ffb648;} .pill .dot.off{background:#8a9099;} .pill .dot.err{background:#ff5b5b;}',
    '.pill .sep{width:1px;height:12px;background:rgba(255,255,255,.22);}',
    '.pill .act{padding:0 2px;opacity:.8;} .pill .act:hover{opacity:1;}',
    // z-index 必须高于遮罩，否则半透明遮罩会盖在面板上 —— 面板看起来是灰的且点不到
    '.mask{position:fixed;inset:0;background:rgba(0,0,0,.4);pointer-events:auto;z-index:2147483001;}',
    '.panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:600px;max-width:92vw;max-height:88vh;overflow:auto;',
    '  z-index:2147483002;background:#fff;color:#222;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.35);padding:20px 22px;pointer-events:auto;}',
    '.panel h3{margin:0 0 4px;font-size:16px;}',
    '.panel .sub{color:#8a9099;font-size:12px;margin-bottom:10px;}',
    '.row{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;padding:7px 0;border-bottom:1px solid #f0f2f5;}',
    '.row:last-child{border-bottom:0;}',
    '.row .lab{font-weight:600;} .row .tip{color:#8a9099;font-size:12px;margin-top:2px;}',
    // 输入控件在 light DOM（靠 <slot> 投影进来），所以样式选择器要用 ::slotted ——
    // ::slotted 只支持单个复合选择器，不能写后代选择器
    '::slotted(input[type=text]),::slotted(input[type=number]){outline:none;}',
    '::slotted(input[type=text]:focus),::slotted(input[type=number]:focus){border-color:#00a1d6;}',
    '::slotted(select){outline:none;}',
    '::slotted(input[type=checkbox]){width:16px;height:16px;}',
    // 设置面板里的复选框在影子树内（不是 slot 投影），所以要单独给样式：
    // flex:0 0 auto 防止被同行超长的说明文字挤小，cursor 给出手感
    '.panel input[type=checkbox]{width:17px;height:17px;margin:0;flex:0 0 auto;cursor:pointer;accent-color:#00a1d6;}',
    '.chainbox{margin-top:10px;padding:9px 12px;border:1px solid #ffe2b8;background:#fffaf1;border-radius:9px;}',
    '.epmap{margin:6px 0 0;font-size:12px;color:#0077a8;background:#f0fafd;border-radius:7px;padding:6px 10px;line-height:1.5;}',
    '.chainbox .chainrow{padding:3px 0;border-top:1px dashed #f0e2c8;font-size:13px;}',
    '.chainbox .chainrow:first-of-type{border-top:0;}',
    '.chainbox .chainrow .cn{color:#8a9099;font-size:12px;}',
    '.btns{display:flex;gap:10px;justify-content:flex-end;margin-top:16px;}',
    'button{padding:7px 16px;border-radius:8px;border:1px solid #d7dbe0;background:#fff;cursor:pointer;font-size:13px;}',
    'button:hover{background:#f5f7fa;}',
    'button.primary{background:#00a1d6;color:#fff;border-color:#00a1d6;} button.primary:hover{background:#0091c2;}',
    'button.danger{color:#e5484d;border-color:#ffd0d1;}',
    '.cand{max-height:140px;overflow:auto;border:1px solid #eef0f3;border-radius:9px;margin-top:10px;}',
    '.cand-item{padding:8px 11px;border-bottom:1px solid #f4f6f8;cursor:pointer;}',
    '.cand-item:hover{background:#f0fafd;} .cand-item.on{background:#e6f7ff;}',
    '.cand-item .nm{font-weight:600;} .cand-item .meta{color:#8a9099;font-size:12px;}',
    '.hintbox{background:#f7f9fb;border-radius:8px;padding:8px 12px;font-size:12px;color:#5a6472;margin:10px 0;}',
    '.toast-root{position:fixed;bottom:88px;left:50%;transform:translateX(-50%);pointer-events:auto;}',
    '.toast{background:rgba(20,22,26,.9);color:#fff;border-radius:10px;padding:10px 16px;display:flex;align-items:center;gap:14px;',
    '  box-shadow:0 8px 28px rgba(0,0,0,.32);animation:in .18s ease;}',
    '.toast .t{font-weight:600;} .toast .d{opacity:.75;font-size:12px;}',
    '.toast button{background:transparent;border:1px solid rgba(255,255,255,.4);color:#fff;padding:4px 10px;font-size:12px;}',
    '.toast button:hover{background:rgba(255,255,255,.14);}',
    '@keyframes in{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}'
  ].join('');

  var toastTimer = null;
  function showToast(title, desc, onUndo) {
    ensureUI();
    toastRoot.innerHTML = '';
    var el = document.createElement('div');
    el.className = 'toast';
    var left = document.createElement('div');
    left.innerHTML = '<div class="t"></div><div class="d"></div>';
    left.querySelector('.t').textContent = title;
    left.querySelector('.d').textContent = desc || '';
    el.appendChild(left);
    if (onUndo && config.undoSeconds > 0) {
      var btn = document.createElement('button');
      btn.textContent = '撤回';
      btn.addEventListener('click', function () {
        onUndo();
        toastRoot.innerHTML = '';
      });
      el.appendChild(btn);
    }
    toastRoot.appendChild(el);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastRoot.innerHTML = ''; }, (config.undoSeconds || 5) * 1000);
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s === undefined || s === null ? '' : s);
    return d.innerHTML;
  }

  /* ==================================================================
   * 15.1 输入控件：必须待在 light DOM，用 <slot> 投影进影子树
   *
   * 浏览器实测（Edge 无头）：
   *   shadow 里的 input  → 事件路径 INPUT > DIV > shadowRoot > … > Window，
   *                        页面侧看到 e.target = DIV、activeElement = DIV
   *   light DOM 的 input → 页面侧看到的仍是 INPUT 本身
   * B 站「正在输入就不响应快捷键」的判断正是看这两样，被重定向后一律失效 ——
   * 症状就是在搜索框里打 q 触发点赞。
   * 另：只靠 stopPropagation 不够 —— 实测它只拦得住冒泡阶段的监听。
   * ================================================================== */
  var INP_CSS = 'width:180px;padding:6px 9px;border:1px solid #d7dbe0;border-radius:7px;font-size:13px;' +
                'outline:none;box-sizing:border-box;background:#fff;color:#222;font-family:inherit;';
  var SEL_CSS = 'padding:6px 8px;border:1px solid #d7dbe0;border-radius:7px;font-size:13px;' +
                'background:#fff;color:#222;font-family:inherit;';

  function mkSlot(tag, name, cssText) {
    ensureUI();
    var node = document.createElement(tag);
    node.setAttribute('slot', name);
    if (cssText) node.style.cssText = cssText;
    host.appendChild(node);            // ← 加在宿主上就是 light DOM 节点
    return node;
  }
  function dropNodes(list) {
    (list || []).forEach(function (n) { try { n.remove(); } catch (e) { /* ignore */ } });
  }

  /* ---- 面板搜索：AniList 直查 + Bangumi 中文桥，合并去重 ---- */
  function searchByName(q) {
    var ckey = 'ui:' + q;
    var c = cacheGet(ckey, 6 * 3600000);
    if (c !== undefined) return Promise.resolve(c);

    var seen = {}, out = [];
    function addMedia(m, via, bgm) {
      if (!m || !m.id || seen[m.id]) return;
      seen[m.id] = 1;
      out.push({
        id: m.id, idMal: m.idMal, episodes: m.episodes, format: m.format,
        title: m.title || {}, year: (m.startDate && m.startDate.year) || 0,
        via: via, bgm: bgm || null, cn: (bgm && bgm.name_cn) || ''
      });
    }

    var queries = [q].concat(aliasExpansions(q)).slice(0, 2);

    var jobs = [];
    queries.forEach(function (qq) {
      jobs.push(anilistSearch(qq).then(function (list) {
        (list || []).forEach(function (m) { addMedia(m, 'anilist'); });
      }));
      if (hasHan(qq)) {
        jobs.push(bgmResolve(qq).then(function (hit) {
          if (!hit || !hit.entry || hit.score < 0.75) return;
          return anilistSearch(hit.entry.name).then(function (list) {
            (list || []).forEach(function (m) { addMedia(m, 'bangumi', hit.entry); });
          });
        }).catch(function () { /* Bangumi 不可用不影响主流程 */ }));
      }
    });
    return Promise.all(jobs).then(function () {
      // Bangumi 是从中文名精确命中的，排在前面更符合预期
      out.sort(function (a, b) { return (b.via === 'bangumi' ? 1 : 0) - (a.via === 'bangumi' ? 1 : 0); });
      cacheSet(ckey, out);
      return out;
    });
  }

  /* ---- 状态胶囊：所有交互的入口 ---- */
  function renderPill() {
    ensureUI();
    uiRoot.innerHTML = '';
    var pill = document.createElement('div');
    pill.className = 'pill';

    var r = runtime.result;
    var ctx = runtime.ctx;
    var bound = false;
    try { bound = !!(ctx && getBinding(ctx)); } catch (e) { bound = false; }

    var parts = [];
    var fallback = openBindPanel;      // 点胶囊空白处做什么

    if (!ctx) {
      parts.push('<span class="dot off"></span><span>番剧跳过</span>');
      fallback = function () { alert('尚未读取到视频信息'); };
    } else if (!r) {
      parts.push('<span class="dot off"></span><span>番剧跳过 · 未识别</span>');
    } else if (!r.ok) {
      // 自动识别关闭时（默认），普通视频不留任何视觉痕迹 —— 除非用户开了「未识别时也显示胶囊」。
      // 这个视频已经绑过也例外：绑过代表用户明确要它跳，胶囊留着方便随时改。
      var idleOff = r.reason === 'autodetect-off';
      if (idleOff && !config.showIdlePill && !bound) return;
      var why = {
        'autodetect-off': '未识别',
        blacklisted: '已加入「不是番剧」名单',
        'no-episode': '没找到集号', 'no-name': '标题无番名',
        'chain-miss': '这一话不跳（OVA／段没对上条目）'
      }[r.reason] || '识别失败';
      // autodetect-off 是「正常状态」而不是错误 —— 用灰点，别用红点吓人
      parts.push('<span class="dot ' + (idleOff ? 'off' : 'err') + '"></span>' +
        '<span>' + (idleOff ? '番剧跳过 · ' : '') + escapeHtml(why) + '</span>');
      parts.push('<span class="sep"></span><span class="act" data-a="bind">' + (bound ? '改' : '绑定') + '</span>');
    } else {
      var segCount = (r.segments || []).filter(segmentEnabled).length;
      var dotClass = segCount ? '' : 'warn';
      parts.push('<span class="dot ' + dotClass + '"></span>' +
        '<span>' + escapeHtml(r.title) + ' 第' + r.episode + '集</span>' +
        '<span class="sep"></span><span>' + segCount + ' 段</span>' +
        '<span class="sep"></span><span class="act" data-a="bind">改</span>' +
        '<span class="sep"></span><span class="act" data-a="no">不是番剧</span>');
      fallback = showDetails;
    }
    // 末尾统一挂一个设置入口 —— 胶囊原来只有识别出来才出现，想改设置得去油猴菜单，太绕
    parts.push('<span class="sep"></span><span class="act" data-a="cfg" title="番剧跳过设置">⚙</span>');
    pill.innerHTML = parts.join('');

    function onAct(name, fn) {
      var node = pill.querySelector('[data-a=' + name + ']');
      if (!node) return;
      node.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
    }
    onAct('bind', openBindPanel);
    onAct('cfg', openSettings);
    onAct('no', function () {
      setBlacklist(runtime.ctx);
      runtime.result = null;
      renderPill();
      stopMonitor();
      showToast('已标记「不是番剧」', '这个视频／合集以后不会再触发');
    });
    pill.addEventListener('click', function () { fallback(); });

    uiRoot.appendChild(pill);
  }

  function showDetails() {
    var r = runtime.result;
    if (!r || !r.ok) return;
    var segs = (r.segments || []);
    var lines = segs.map(function (s) {
      var label = s.type === 'op' ? 'OP' : (s.type === 'ed' ? 'ED' : 'Recap');
      if (s.mixed) label = '混入正片的 ' + label;
      var mark = segmentEnabled(s) ? '' : ' · 已关闭';
      return label + '  ' + fmtTime(s.start) + ' – ' + fmtTime(s.end) + '  （' + s.source + mark + '）';
    });
    showToast(r.title + ' 第' + r.episode + '集', lines.join('　　') || '本集没有可用时间戳');
  }

  function setBlacklist(ctx) {
    blacklistKeys(ctx).forEach(function (k, i) {
      if (i === 0) blacklist[k] = { t: Date.now(), title: ctx.mainTitle };
    });
    persistBlacklist();
  }

  // 按钮 / 复选框不给焦点：它们一旦被聚焦，按空格、回车就会在触发自身的同时
  // 打到 B 站快捷键（空格＝播放暂停）。mousedown 阻止默认行为即可不抢焦点。
  function noFocus(node) {
    if (!node) return node;
    try { node.setAttribute('tabindex', '-1'); } catch (e) { /* ignore */ }
    node.addEventListener('mousedown', function (e) { e.preventDefault(); });
    return node;
  }
  /* ==================================================================
   * 15.2 复选框为什么不能自己翻转 checked
   *
   * 踩过的坑：曾经给复选框挂 click 监听，preventDefault + 手动 n.checked = !n.checked。
   * 结果「点一下完全没反应」。原因是复选框的激活流程分三步：
   *   1) pre-click activation  ：浏览器先把 checked 取反
   *   2) 派发 click 事件       ：我们的监听跑，preventDefault + 手动再取反 → 回到原值
   *   3) canceled activation   ：事件被取消，浏览器把 checked 还原成事件前的值 → 又是原值
   * 两次取反互相抵消，外加浏览器的还原兜底，最终纹丝不动。
   * 正确做法：只管「不给焦点」，翻转完全交给浏览器原生行为。
   * （Edge 无头实测：不加 click 监听时 mousedown+preventDefault 不影响原生翻转）
   * ================================================================== */
  function noFocusAll(root, sel) {
    var list = [];
    try { list = root.querySelectorAll(sel); } catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) noFocus(list[i]);
  }

  var openPanels = [];   // 当前打开的面板节点（给下面的捕获阶段兜底用）

  /* 面板打开期间，在 window 捕获阶段兜底：
   * 事件只要来自面板、且不是来自某个输入控件，就直接截断 ——
   * 这样即便 B 站用的是捕获阶段监听，也拦得住。
   * 来自输入控件的放行，让 B 站自己的「正在输入」判断生效（此时 target 就是真正的 input）。
   * Esc 必须放行，否则我们自己的关闭逻辑收不到。
   * （window 捕获早于 document 捕获，所以这里是最后一道能抢在前面拦的机会） */
  function panelCaptureGuard(e) {
    if (!openPanels.length) return;
    if (e.key === 'Escape' || e.key === 'Esc') return;
    var path = (e.composedPath && e.composedPath()) || [];
    var inPanel = false, inInput = false;
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (!n || !n.tagName) continue;
      if (openPanels.indexOf(n) >= 0) inPanel = true;
      var tag = String(n.tagName).toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') inInput = true;
    }
    if (inPanel && !inInput) {
      try { e.stopImmediatePropagation(); } catch (err) { /* ignore */ }
    }
  }

  /* ---- 面板挂载：遮罩 / 面板层级、点遮罩关闭、Esc 关闭统一在这里处理 ---- */
  function mountPanel(panel, onClose) {
    ensureUI();
    var mask = document.createElement('div');
    // 关键样式用内联而不依赖 CSS 类 —— 万一页面 CSP 拦了 <style> 注入，
    // 面板至少还能正常显示和点击（CSS 只负责子元素外观，失效了也还能用）
    mask.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.4);pointer-events:auto;z-index:2147483001;';
    panel.style.cssText =
      'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
      'width:600px;max-width:92vw;max-height:88vh;overflow:auto;' +
      'z-index:2147483002;background:#fff;color:#222;border-radius:14px;' +
      'box-shadow:0 18px 60px rgba(0,0,0,.35);padding:18px 22px;pointer-events:auto;';
    var closed = false;
    openPanels.push(panel);
    try { window.addEventListener('keydown', panelCaptureGuard, true); } catch (e) { /* ignore */ }
    function onKey(e) { if (e.key === 'Escape' || e.key === 'Esc') close(); }
    function close() {
      if (closed) return;
      closed = true;
      mask.remove();
      panel.remove();
      var idx = openPanels.indexOf(panel);
      if (idx >= 0) openPanels.splice(idx, 1);
      if (!openPanels.length) {
        try { window.removeEventListener('keydown', panelCaptureGuard, true); } catch (e) { /* ignore */ }
      }
      try { document.removeEventListener('keydown', onKey, true); } catch (e) { /* ignore */ }
      try { onClose && onClose(); } catch (e) { /* ignore */ }
    }
    mask.addEventListener('click', close);
    try { document.addEventListener('keydown', onKey, true); } catch (e) { /* ignore */ }
    // 面板内所有按键都不许传出去：B 站的快捷键监听挂在 document / window 上，
    // 在冒泡阶段截断即可 —— 打字不受影响，因为事件已经先到达输入框本体、
    // 默认行为（插入字符）与 stopPropagation 无关。
    // 注意：B 站若用捕获阶段监听，这里拦不到，那部分靠「输入控件在 light DOM」让它自己的判断生效。
    panel.addEventListener('keydown', function (e) { e.stopPropagation(); });
    shadow.appendChild(mask);   // 先遮罩
    shadow.appendChild(panel);  // 后面板，同层时按 DOM 顺序面板在上
    return close;
  }

  /* ---- 绑定面板：标题不可信时的主力入口 ---- */
  function openBindPanel() {
    ensureUI();
    var ctx = runtime.ctx;
    if (!ctx) { showToast('无法读取视频信息', '请在 B 站播放页使用'); return; }

    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<h3>绑定番剧</h3>' +
      '<div class="sub">标题乱码／没有番名／自动认错时用这里。绑一次，整个合集的每一集都会复用。</div>' +
      '<div class="hintbox">当前标题：<b class="cur-title"></b></div>' +
      '<div class="row"><div><div class="lab">搜索番剧</div><div class="tip">中文名 / 罗马字 / 日文 / 英文都行，Re:0 这类简写也可以</div></div>' +
      '<slot name="q"></slot></div>' +
      '<div class="btns" style="justify-content:flex-start"><button class="search primary">搜索</button>' +
      '<button class="autofill">用标题自动填</button></div>' +
      '<div class="cand"></div>' +
      '<div class="row"><div><div class="lab">当前是第几话</div>' +
      '<div class="tip">填你正在看的这一集在<b>这个合集里</b>的序号。例：合集共 32 话、你在看第 21 个视频，就填 21 —— 多季连播时脚本会自己算出它是第几季第几话。</div></div>' +
      '<slot name="ep"></slot></div>' +
      '<div class="epmap" hidden></div>' +
      '<div class="row"><div><div class="lab">生效范围</div><div class="tip">这条绑定管到哪儿。搬运番多数是「一个视频装多个分P」，所以默认管全部分P就够</div></div>' +
      '<slot name="scope"></slot></div>' +
      '<div class="chainbox" hidden></div>' +
      '<div class="btns"><button class="clear danger">清除绑定</button>' +
      '<button class="cancel">取消</button><button class="save primary" disabled>保存</button></div>';

    // 输入控件一律走 light DOM + slot 投影（见 15.1 的说明）
    var slotted = [];
    var closePanel = mountPanel(panel, function () { dropNodes(slotted); });
    var mk = function (tag, name, css, cls) {
      var n = mkSlot(tag, name, css);
      if (cls) n.className = cls;
      slotted.push(n);
      return n;
    };

    panel.querySelector('.cur-title').textContent = ctx.mainTitle + (ctx.partTitle ? ' / ' + ctx.partTitle : '');

    var selScope = mk('select', 'scope', SEL_CSS, 'scope');
    var keys = bindingKeys(ctx);
    keys.forEach(function (k, i) {
      var o = document.createElement('option');
      o.value = k.key;
      o.textContent = k.label;
      if (i === 0) o.selected = true;
      selScope.appendChild(o);
    });

    var qInput = mk('input', 'q', INP_CSS, 'q');
    qInput.type = 'text';
    qInput.placeholder = '例如：葬送的芙莉莲 / Re:0';

    var epInput = mk('input', 'ep', INP_CSS + 'width:90px;', 'ep');
    epInput.type = 'number'; epInput.min = '1'; epInput.max = '500'; epInput.value = '1';

    var candBox = panel.querySelector('.cand');
    var saveBtn = panel.querySelector('.save');
    var chainBox = panel.querySelector('.chainbox');
    var epMapEl = panel.querySelector('.epmap');

    // 预填：已有绑定 / 上次识别结果 / 从标题抽到的集号
    var exist = getBinding(ctx);
    var epGuess = episodeGuess(ctx);
    if (exist) {
      qInput.value = exist.title || '';
      selScope.value = exist._key;
    } else {
      // 预填也用「提取后的番名」，别把整条噪声标题塞进搜索框
      var preCands = animeNameCandidates(ctx);
      qInput.value = (runtime.result && runtime.result.ok && runtime.result.title) ||
                     (preCands.length ? preCands[0] : '') || cleanTitle(ctx.mainTitle) || '';
    }
    if (epGuess) epInput.value = epGuess.num;

    var picked = exist ? { id: exist.anilistId, idMal: exist.malId, title: exist.title, episodes: exist.episodes } : null;
    var searchResults = [];

    /* ---- 多季连播：季链推导 + 可见可改 ---- */
    var ms = detectMultiSeason(ctx);
    var chainState = { chain: (exist && exist.seasonChain) || null, loading: false };
    var seasonInput = null;

    function renderChain() {
      var chain = chainState.chain;
      if (!chain && !ms.multi) { chainBox.hidden = true; updateEpMap(); return; }
      chainBox.hidden = false;

      if (!chain || !chain.seasons || chain.seasons.length < 2) {
        chainBox.innerHTML =
          '<div class="lab">识别到多季连播</div>' +
          '<div class="tip">线索：「' + escapeHtml(ms.hint || '多季') + '」' + (ms.totalEps ? '，共 ' + ms.totalEps + ' 话' : '') +
          (chainState.loading ? '。正在推算季边界…'
            : '。选中上面某一条番剧后会自动推算季边界；推算不出来也没关系，脚本会退回单季处理。') +
          '</div>';
        updateEpMap();
        return;
      }

      var fromParts = chain.source === 'parts';

      var rows = chain.seasons.map(function (s, i) {
        // 一段可能对应数据库的多个条目（B站「第一季」= Ⅰ + 第2クール）
        var entryTxt = '';
        if (s.entries && s.entries.length) {
          entryTxt = s.entries.map(function (e) {
            return escapeHtml(e.title || ('MAL ' + e.malId)) + '(' + e.episodes + '话)';
          }).join(' + ');
          if (s.entries.length > 1) entryTxt += ' = ' + s.entriesSum + ' 话';
        } else {
          entryTxt = '<span style="color:#d97706">没能对上数据库条目</span>';
        }
        var warn = '';
        if (s.aligned === false) warn = ' <b style="color:#d97706">这一段不会跳</b>';
        else if (s.diff) warn = ' <span class="cn">（比段内 P 数少 ' + Math.abs(s.diff) + ' 话，多半是 OVA／特别篇）</span>';

        return '<div class="chainrow"><b>第 ' + (s.season || (i + 1)) + ' 段</b>' +
               (s.startPage ? ' P' + s.startPage + '–P' + s.endPage : '') +
               ' <span class="cn">' + (s.episodes ? s.episodes + ' 个视频 · 合集第 ' + s.startAbs + '–' + s.endAbs + ' 话' : '话数未知') + '</span>' +
               '<div class="cn">→ ' + entryTxt + warn + '</div></div>';
      }).join('');

      var tip = fromParts
        ? '依据：分P标题里的季标记（UP 主自己分的段）＋ 按累计话数对齐数据库条目。'
        : '依据：AniList 续季关系推导。';
      var unresolved = (chain.seasons || []).filter(function (x) { return x.aligned === false; }).length;
      if (unresolved) {
        tip += '<b style="color:#d97706">有 ' + unresolved + ' 段没能自动对上条目，那几段不会跳 —— 换个关键词重搜、或选另一季的条目再试。</b>';
      } else if (chain.mismatch) {
        tip += '<b style="color:#d97706">与你标题里写的话数对不上，请核对。</b>';
      }

      var editor = fromParts
        ? ''
        : ('<div class="row"><div><div class="lab">每季话数</div><div class="tip">逗号分隔，按季顺序。改完点「应用话数」</div></div>' +
           '<slot name="seasons"></slot></div>' +
           '<div class="btns" style="justify-content:flex-start"><button class="applyEps">应用话数</button></div>');

      chainBox.innerHTML =
        '<div class="lab">多季连播合集 · 季边界</div>' +
        '<div class="tip">' + tip + '</div>' + rows + editor;

      if (!fromParts) {
        if (!seasonInput) {
          seasonInput = mk('input', 'seasons', INP_CSS + 'width:130px;', 'seasons');
          seasonInput.type = 'text';
        }
        seasonInput.value = chain.seasons.map(function (s) { return s.episodes || ''; }).join(',');
        var btn = panel.querySelector('.applyEps');
        noFocus(btn);
        btn.addEventListener('click', applySeasonEps);
      }
      updateEpMap();
    }

    /* 集号到底换算成哪一季第几话 —— 直接把结果写在输入框下面，省得用户猜 */
    function updateEpMap() {
      var val = parseInt(epInput.value, 10);
      var chain = chainState.chain;
      if (!val) { epMapEl.hidden = true; return; }

      if (!chain || !chain.seasons || chain.seasons.length < 2) {
        if (picked && picked.episodes && val > picked.episodes) {
          epMapEl.textContent = '注意：' + picked.title + ' 只有 ' + picked.episodes +
            ' 话，第 ' + val + ' 话可能属于下一季 —— 检查下面的季边界，或搜另一个季的条目。';
          epMapEl.hidden = false;
        } else {
          epMapEl.hidden = true;
        }
        return;
      }

      var hit = mapBySeasonChain(chain, val);
      if (hit) {
        epMapEl.textContent = '合集第 ' + val + ' 话 → 第 ' + hit.season + ' 段 · ' + hit.title +
          ' 第 ' + hit.ep + ' 话';
      } else {
        var seg = null;
        for (var i = 0; i < chain.seasons.length; i++) {
          var cs = chain.seasons[i];
          if (val >= cs.startAbs && val <= cs.endAbs) { seg = cs; break; }
        }
        if (seg && seg.aligned === false) {
          epMapEl.textContent = '第 ' + val + ' 话属于第 ' + seg.season + ' 段，但这一段没能和数据库条目对上 —— 这一话不会跳。';
        } else if (seg) {
          epMapEl.textContent = '第 ' + val + ' 话在第 ' + seg.season + ' 段里，但超出了该段对应的条目（大概是 OVA / 特别篇）—— 这一话不跳。';
        } else {
          epMapEl.textContent = '第 ' + val + ' 话不在季链范围内（季链共 ' + chain.total + ' 话）—— 保存后不会生效，请核对季边界。';
        }
      }
      epMapEl.hidden = false;
    }

    function applySeasonEps() {
      var chain = chainState.chain;
      if (!chain || !seasonInput) return;
      var nums = String(seasonInput.value).split(/[,，\s]+/).filter(Boolean).map(function (x) { return parseInt(x, 10); });
      if (nums.length !== chain.seasons.length || nums.some(function (n) { return !isFinite(n) || n <= 0; })) {
        showToast('每季话数格式不对', '需要 ' + chain.seasons.length + ' 个正整数，例如 14,12');
        return;
      }
      var acc = 0;
      var seasons = chain.seasons.map(function (s, i) {
        var c = Object.assign({}, s);
        c.episodes = nums[i];
        c.startAbs = acc + 1;
        c.endAbs = acc + nums[i];
        acc += nums[i];
        return c;
      });
      chainState.chain = Object.assign({}, chain, {
        seasons: seasons, total: acc, partial: false,
        mismatch: !!(chain.totalEpsFromTitle && acc !== chain.totalEpsFromTitle)
      });
      renderChain();
      showToast('季边界已更新', '合计 ' + acc + ' 话');
    }

    // 选中番剧（或打开面板时已有绑定）后，推一次季链
    function refreshChain() {
      if (!picked || !picked.id) { renderChain(); return; }
      if (chainState.chain && chainState.chain.baseId === picked.id) { renderChain(); return; }
      if (!ms.multi) { renderChain(); return; }
      chainState.loading = true;
      renderChain();
      // ctx 必须传进去 —— 有了分P标题里的季标记，边界才能按 UP 主自己分的段来算
      buildSeasonChain(picked.id, ms.totalEps, ctx, qInput.value.trim() || picked.title, searchResults, picked.title).then(function (chain) {
        chainState.loading = false;
        if (chain) chain.baseId = picked.id;
        chainState.chain = chain;
        renderChain();
      });
    }

    function renderCands() {
      candBox.innerHTML = '';
      if (!searchResults.length) {
        candBox.innerHTML = '<div class="cand-item"><div class="nm" style="color:#8a9099">没有结果，换个关键词试试</div></div>';
        saveBtn.disabled = true;
        return;
      }
      searchResults.forEach(function (m) {
        var item = document.createElement('div');
        item.className = 'cand-item';
        if (picked && picked.id === m.id) item.className += ' on';
        var titles = [m.cn, m.title.romaji, m.title.english, m.title.native].filter(Boolean).join(' / ');
        item.innerHTML = '<div class="nm"></div><div class="meta"></div>';
        item.querySelector('.nm').textContent = titles;
        item.querySelector('.meta').textContent = [
          m.via === 'bangumi' ? '经 Bangumi 中文库命中' : '',
          m.format,
          m.year ? m.year + ' 年' : '',
          m.episodes ? m.episodes + ' 集' : '集数未知',
          'AniList ' + m.id,
          m.idMal ? 'MAL ' + m.idMal : '无 MAL'
        ].filter(Boolean).join(' · ');
        item.addEventListener('click', function () {
          picked = { id: m.id, idMal: m.idMal, title: (m.title.native || m.title.romaji || ''), episodes: m.episodes };
          // MAL 缺失时 AniSkip 查不了，但 Anime Skip 仍可用
          saveBtn.disabled = false;
          chainState.chain = null;      // 换番了，季链重推
          renderCands();
          refreshChain();
        });
        candBox.appendChild(item);
      });
    }

    function runSearch() {
      var q = qInput.value.trim();
      if (!q) return;
      candBox.innerHTML = '<div class="cand-item"><div class="nm" style="color:#8a9099">搜索中…</div></div>';
      saveBtn.disabled = true;
      searchByName(q).then(function (list) {
        searchResults = list || [];
        renderCands();
        if (searchResults.length) {
          var m0 = searchResults[0];
          picked = { id: m0.id, idMal: m0.idMal, title: (m0.title.native || m0.title.romaji || ''), episodes: m0.episodes };
          saveBtn.disabled = false;
          renderCands();
          refreshChain();
        }
      });
    }

    noFocus(panel.querySelector('.search'));
    noFocus(panel.querySelector('.autofill'));
    noFocus(panel.querySelector('.cancel'));
    noFocus(panel.querySelector('.clear'));
    noFocus(saveBtn);
    panel.querySelector('.search').addEventListener('click', runSearch);
    qInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') runSearch(); });
    epInput.addEventListener('input', updateEpMap);
    panel.querySelector('.autofill').addEventListener('click', function () {
      // 自动填也优先用引号里的内容（那才是番名），并把噪声都剪掉
      var cands = animeNameCandidates(ctx);
      qInput.value = (cands.length ? cands[0] : '') || cleanTitle(ctx.seasonEpisodeTitle || ctx.partTitle || ctx.mainTitle) || '';
      runSearch();
    });
    panel.querySelector('.cancel').addEventListener('click', closePanel);
    panel.querySelector('.clear').addEventListener('click', function () {
      var b = getBinding(ctx);
      if (b && b._key) { delete bindings[b._key]; persistBindings(); }
      runtime.result = null;
      closePanel(); renderPill(); showToast('已清除绑定', '刷新后恢复自动识别行为');
    });
    saveBtn.addEventListener('click', function () {
      if (!picked) return;
      bindings[selScope.value] = {
        anilistId: picked.id,
        malId: picked.idMal,
        title: picked.title,
        episodes: picked.episodes,
        // 绑定时记住「此时这一 P 是第几话」，其余 P 的集号由 P 序号 + 差值推算。
        // 所以 P1 是不是预告/PV 会被自动吸收掉 —— 不需要额外的偏移设置
        anchorPage: ctx.page,
        anchorEp: parseInt(epInput.value, 10) || 1,
        // 多季连播合集的季链（含用户手改过的话数），一起存下来
        seasonChain: (chainState.chain && chainState.chain.seasons && chainState.chain.seasons.length > 1)
          ? chainState.chain : null,
        t: Date.now()
      };
      persistBindings();
      runtime.result = null;
      closePanel();
      var chain = bindings[selScope.value].seasonChain;
      showToast('已绑定：' + picked.title,
        chain ? (chain.seasons.length + ' 季 / 共 ' + chain.total + ' 话') 
              : ('作用域：' + (selScope.options[selScope.selectedIndex] || {}).textContent));
      rerun();
    });

    renderCands();
    renderChain();
    if (picked) { saveBtn.disabled = false; refreshChain(); }
    setTimeout(function () { qInput.focus(); qInput.select(); }, 50);
  }

  /* ---- 设置面板 ---- */
  function openSettings() {
    ensureUI();
    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<h3>番剧 OP/ED 跳过 · 设置</h3>' +
      '<div class="sub">默认「不自动识别」—— 除非你手动绑定过，普通视频永远不会被处理。</div>' +
      '<div class="row"><div><div class="lab">自动识别</div>' +
      '<div class="tip">off＝不自动（推荐，最安全）｜ask＝识别后让你点着跳｜auto＝全自动</div></div>' +
      '<slot name="mode"></slot></div>' +
      '<div class="row"><div><div class="lab">跳过 OP</div></div><input type="checkbox" class="op"></div>' +
      '<div class="row"><div><div class="lab">跳过 ED</div></div><input type="checkbox" class="ed"></div>' +
      '<div class="row"><div><div class="lab">跳过回顾 Recap</div><div class="tip">总集篇的回顾片段，很多人想看</div></div><input type="checkbox" class="recap"></div>' +
      '<div class="row"><div><div class="lab">跳过「融进正片」的 OP/ED</div><div class="tip">有些番没有独立 OP 段，OP 是和画面融在一起播的（每集还可能不一样）。跳过这类区间会切掉正片内容，默认关</div></div><input type="checkbox" class="mixed"></div>' +
      '<div class="row"><div><div class="lab">撤回提示秒数</div><div class="tip">跳过后可以点「撤回」回到原位置，0＝不显示</div></div>' +
      '<slot name="undo"></slot></div>' +
      '<div class="row"><div><div class="lab">显示跳转提示</div></div><input type="checkbox" class="toast"></div>' +
      '<div class="row"><div><div class="lab">优先用合集单集标题</div><div class="tip">UP 主在合集里改过的标题往往比原始标题干净</div></div><input type="checkbox" class="seasonT"></div>' +
      '<div class="row"><div><div class="lab">未识别时也显示胶囊</div><div class="tip">关掉则普通视频上完全无痕，入口在油猴菜单</div></div><input type="checkbox" class="idle"></div>' +
      '<div class="btns"><button class="clr">清空缓存</button>' +
      '<button class="cancel">取消</button><button class="save primary">保存</button></div>';

    // 输入控件同样走 light DOM + slot（见 15.1）
    var slotted = [];
    var closePanel = mountPanel(panel, function () { dropNodes(slotted); });
    var modeSel = mkSlot('select', 'mode', SEL_CSS);
    modeSel.className = 'mode';
    slotted.push(modeSel);
    [['off', 'off · 不自动识别'], ['ask', 'ask · 识别后询问'], ['auto', 'auto · 全自动']].forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0]; op.textContent = o[1];
      modeSel.appendChild(op);
    });
    var undoInput = mkSlot('input', 'undo', INP_CSS + 'width:90px;');
    undoInput.className = 'undo';
    undoInput.type = 'number'; undoInput.min = '0'; undoInput.max = '30';
    slotted.push(undoInput);

    // 复选框：只做「不给焦点」（tabindex=-1 + 阻止 mousedown 默认行为），
    // 翻转交给浏览器原生行为 —— 自己翻的实现见 15.2 的踩坑记录
    ['op', 'ed', 'recap', 'mixed', 'toast', 'seasonT', 'idle'].forEach(function (cls) {
      noFocus(panel.querySelector('.' + cls));
    });
    noFocus(panel.querySelector('.clr'));
    noFocus(panel.querySelector('.cancel'));
    noFocus(panel.querySelector('.save'));

    modeSel.value = config.autoDetect;
    panel.querySelector('.op').checked = config.jumpOp;
    panel.querySelector('.ed').checked = config.jumpEd;
    panel.querySelector('.recap').checked = config.jumpRecap;
    panel.querySelector('.mixed').checked = config.jumpMixed;
    undoInput.value = config.undoSeconds;
    panel.querySelector('.toast').checked = config.showToast;
    panel.querySelector('.seasonT').checked = config.useSeasonTitle;
    panel.querySelector('.idle').checked = config.showIdlePill;

    panel.querySelector('.cancel').addEventListener('click', closePanel);
    panel.querySelector('.clr').addEventListener('click', function () {
      cache = {}; persistCache();
      showToast('缓存已清空', '下次识别会重新联网查询');
    });
    panel.querySelector('.save').addEventListener('click', function () {
      var patch = {
        autoDetect: modeSel.value,
        jumpOp: panel.querySelector('.op').checked,
        jumpEd: panel.querySelector('.ed').checked,
        jumpRecap: panel.querySelector('.recap').checked,
        jumpMixed: panel.querySelector('.mixed').checked,
        undoSeconds: Math.max(0, parseInt(undoInput.value, 10) || 0),
        showToast: panel.querySelector('.toast').checked,
        useSeasonTitle: panel.querySelector('.seasonT').checked,
        showIdlePill: panel.querySelector('.idle').checked
      };
      Object.keys(patch).forEach(function (k) { gmSet(k, patch[k]); config[k] = patch[k]; });
      closePanel();
      showToast('设置已保存', '模式：' + config.autoDetect);
      rerun();
    });
  }

  /* ==================================================================
   * 16. 入口
   * ================================================================== */
  function rerun() {
    runtime.result = null;
    runtime.skipped = {};
    stopMonitor();
    buildContext().then(function (ctx) {
      runtime.ctx = ctx;
      renderPill();
      return identify(ctx);
    }).then(function (r) {
      runtime.result = r;
      renderPill();
      if (r && r.ok) {
        runtime.video = getVideo();
        runtime.skipped = {};
        startMonitor();
        if (config.autoDetect !== 'off' || r.manual) {
          showToast('已识别：' + r.title, '第 ' + r.episode + ' 集 · ' + (r.segments || []).filter(segmentEnabled).length + ' 段时间戳');
        }
      }
    }).catch(function (e) {
      console.warn(LOG, 'identify failed', e);
      renderPill();
    });
  }

  // 处于 ask 模式时，识别成功但不自动跳，改为把段信息显示出来供用户查看
  function boot() {
    if (!/\/(video)\//.test(location.pathname)) return;
    ensureUI();
    renderPill();
    setTimeout(rerun, 900);

    // B 站是单页应用：换视频 / 换分P 时重新识别
    var lastKey = '';
    setInterval(function () {
      var key = currentBvid() + ':' + currentPage();
      if (key !== lastKey) {
        lastKey = key;
        rerun();
      }
    }, 1200);

    try { GM_registerMenuCommand('🔍 绑定 / 识别番剧', openBindPanel); } catch (e) { /* ignore */ }
    try { GM_registerMenuCommand('⚙ 番剧跳过设置', openSettings); } catch (e) { /* ignore */ }
  }

  try {
    var api = {
      open: openBindPanel,
      settings: openSettings,
      rerun: rerun,
      getConfig: function () { return Object.assign({}, config); },
      getResult: function () { return runtime.result; },
      getContext: function () { return runtime.ctx; },
      identify: identify,
      resolveEpisode: resolveEpisode,
      getBinding: getBinding,
      blacklistKeys: blacklistKeys,
      bindingKeys: bindingKeys,
      // 调试钩子：便于在控制台排查「为什么没跳」
      _runtime: runtime,
      _checkOnce: checkOnce,
      _startMonitor: startMonitor,
      _stopMonitor: stopMonitor,
      api_: {
        extractEpisode: extractEpisode, animeNameCandidates: animeNameCandidates, cleanTitle: cleanTitle,
        validateSegs: validateSegs, durationScore: durationScore, similarity: similarity,
        // 中文桥 / 标题解析 / 季链：给测试与排查用
        normKey: normKey, hasHan: hasHan, aliasExpansions: aliasExpansions,
        quotedSegments: quotedSegments, progressivePrefixes: progressivePrefixes,
        stripSeasonMarks: stripSeasonMarks, detectMultiSeason: detectMultiSeason,
        seasonGroupsFromParts: seasonGroupsFromParts, partSeasonOf: partSeasonOf,
        partEpisodeOf: partEpisodeOf, absEpisodeFromPart: absEpisodeFromPart,
        episodeGuess: episodeGuess,
        bgmSearch: bgmSearch, bgmAliases: bgmAliases, bgmResolve: bgmResolve,
        candidateMedia: candidateMedia, searchByName: searchByName,
        buildSeasonChain: buildSeasonChain, mapBySeasonChain: mapBySeasonChain,
        alignGroupsToSeasons: alignGroupsToSeasons, nameScore: nameScore
      }
    };
    try {
      (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__biliAniskip = api;
    } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
