# 「标记模式」浮动工具条 + 进度条标记 设计

- 日期：2026-10-16
- 状态：已与用户确认设计，待审阅后转实施计划
- 依赖：`2026-10-16-local-op-ed-frame-marking-design.md`（本地指纹标记本体）、`2026-10-16-local-op-ed-ed-end-and-settings-ui-design.md`（ED 结束 + 面板一节，本设计会**移除**该节）

## 1. 背景与问题

「本地手动标记 OP/ED 帧」上线后，用户实测反馈标记方式不方便，具体 4 条（用户多选确认）：

1. **入口太深** —— 每次都要 点胶囊 → `⚙` → 在设置面板里找按钮。
2. **面板挡住画面** —— 设置面板是全屏遮罩 + 居中弹窗，标记时看不到自己标的是哪一帧。
3. **标错一个只能全部重来** —— 只有「清空本番标记」，不能单独删某一条。
4. **想在进度条上直接看到已标的 OP/ED 位置**。

另有两条已在同轮修复/明确的约束：

- 「连着跳好几次」的 bug 已作为独立 bugfix 处理（抽帧段按指纹去重 + 跳后静默期），**不属于本设计范围**。
- 用户明确**不要**键盘快捷键、不要当前帧缩略图预览、不要逐帧微调按钮 —— 只要「鼠标点浮动按钮」。

## 2. 设计目标与取舍

| 痛点 | 对策 |
| --- | --- |
| 入口太深 | 胶囊上直接加一个 `🎯` 按钮，一键进出「标记模式」，不再经过设置面板 |
| 面板挡画面 | 标记模式用**非模态、贴边的小工具条**取代全屏遮罩弹窗，不覆盖画面中心与控制栏 |
| 不能单独删 | 工具条里列出已标项，行尾 `✕` 单独删；行本身可点，跳到该标记点 |
| 想看进度条 | 在 B 站播放器**自己的进度条**上叠加半透明区间标记（OP 蓝 / ED 橙） |

已确认的总体方案组合：**A（胶囊 🎯 + 非模态贴边工具条）+ X（标记叠加在 B 站进度条上）**。

## 3. 入口与状态

- `renderPill()` 在 `⚙` 之前插入一个 `<span class="act" data-a="mark" title="标记 OP/ED 帧">🎯</span>`。
- 点击 `data-a="mark"` → 切换**标记模式**（`markToggle()`）。
- 标记模式开关状态存 `runtime.markOn`，并持久化到 GM 存储键 `_markOn`（`gmGet`/`gmSet`）—— 刷新页面后仍在标记模式。
- 标记模式下 `🎯` 按钮高亮（加 `on` class，底色区别于其它 `act`）。
- 未绑定番剧时点 `🎯`：**照常进出标记模式**（工具条能打开，好让用户看到「未绑定」提示），但点 4 个标记按钮时走既有 handler 的未绑定 toast 分支（`先绑定 / 识别这个番剧再标`）。
- 胶囊在全屏/网页全屏仍然**完全隐藏**（既有行为，不改）→ 因此**全屏下不能新进标记模式**；但标记模式是跨全屏保持的状态，全屏前进入则全屏后工具条照常显示。

## 4. 工具条（非模态）

- 只在标记模式出现；退出标记模式即整体移除。
- 位置：默认贴**播放器左下角**（`left:16px; bottom:64px`），宽约 300px、深色半透明、`backdrop-filter:blur`，`z-index` 与胶囊同级（`2147483000` 附近）。
- 不覆盖画面中心，不压住 B 站播放器控制栏（因此 `bottom` 留出控制栏高度）。
- 可拖动，位置存 GM 键 `_markPos`（复用胶囊拖拽的实现思路：`mousedown/mousemove/mouseup`，拖动后紧邻的那次 click 不算点击）。
- 样式：沿用现有做法 —— 布局/字号等写进 shadow root 里的 `<style>`（`MARK_CSS`），**关键几何属性（位置、尺寸、层级、背景）另外用 `style.cssText` 内联**，这样页面 CSP 拦掉 `<style>` 时工具条仍然可见可点（与设置面板 `.mksec` 的处理一致）。
- 结构（自上而下）：
  1. 标题行：`标记 OP / ED` + 右上角 `✕`（退出标记模式）。
  2. 按钮行：`标 OP 开始` `标 OP 结束` `标 ED 开始` `标 ED 结束`。
  3. 状态行：`当前：<番名 or bvid>   已标 OP N 套 / ED M 套`；未绑定时显示 `当前：未绑定 —— 先去胶囊点「绑定」`。
  4. 列表：每行 `OP  0:12 → 1:42` + 行尾 `✕`；ED 未标结束时终点显示 `——`；空列表显示 `还没标过`。
  5. 底部：`清空本番标记`。
- 四个标记按钮沿用既有 handler（`markOpStart` / `markOpEnd` / `markEdStart` / `markEdEnd`），**点击后工具条不关闭**，只就地刷新状态行与列表。
- 时间显示格式沿用面板里的 `fmtSec`（一位小数 + `s`，非法值显示 `——`）。

## 5. 全屏处理（本设计最容易出错的点）

- **网页全屏**（`.bpx-player-container[data-screen="web"]`）：本质是 CSS 铺满、同一文档，`position:fixed` 元素依然可见 → 工具条照常显示，无需特殊处理。
- **真全屏**（浏览器 Fullscreen API）：只渲染全屏子树。工具条 host 若挂在 `document.body` 上会**不可见** → 必须在进入全屏时把 host 重挂到 `document.fullscreenElement` 内部。
- 工具条使用**独立的 host + shadow root**（`markHost`），不与胶囊/Toast 的 `host` 共用 —— 避免为了让工具条进全屏而把胶囊也搬进全屏子树。
- `ensureMarkHost()`：计算目标容器 `document.fullscreenElement || document.body`；若目标不是 `Element`、或是 `<video>` 本身（挂不进去），退化为 `document.body`；若 `markHost.parentNode` 已是目标则不做任何事；否则 `appendChild` 搬过去。
- `applyScreen()`（已由 `body` 的 MutationObserver + `fullscreenchange` 驱动）末尾追加 `ensureMarkHost(); renderMark();` —— 全屏进出都能自动重挂 + 重画。
- 进度条标记同理：`document.querySelectorAll('.bpx-player-progress-wrap')` 会同时命中普通进度条与全屏 shadow 进度条（`.bpx-player-shadow-progress-area` 内那份），所以两种全屏都能标。

## 6. 进度条上的标记

- 目标容器：`document.querySelectorAll('.bpx-player-progress-wrap')`。
- 对每个容器：
  - 若容器计算样式不是 `position:relative/absolute/fixed`，设 `position:relative`（否则绝对定位的子元素会相对更远的祖先定位）。
  - 若没有子节点 `[data-aniskip-marks]`，追加一层 `<div data-aniskip-marks="1">`，`position:absolute;inset:0;pointer-events:none;`。
  - 清空该层后重新填充：
    - 每条标记画一个**区间条**：`left: a%; width: (b-a)%`，半透明底色（OP `#00a1d6`、ED `#ffb648`，`opacity:.55`），`top:0;bottom:0`。
    - 起点再放一个 2px 实心刻度（不透明同色），便于看清起始帧位置。
- 百分比换算：`pct(t, dur) = dur > 0 ? clamp(t / dur * 100, 0, 100) : 0`；`b` 用该条自身的终点；ED 未标结束（`end <= start`）时 `b = 100%`（对应「跳视频结尾」的语义）。
- 刷新时机：
  - `renderMark()` 时；
  - 标记变化后（`afterMark()`）；
  - `duration` 变化或全屏切换（`applyScreen()`）；
  - **兜底轮询**：复用既有的 `runtime.bootTimer`（1200ms）—— 每次 tick 前先算一个签名字符串（`bindingKey + 各条 start/end + duration + 容器数量`），签名没变就**不写 DOM**，避免每秒无谓重排。
- 显示进度条标记**不要求**处于标记模式：只要当前绑定有本地指纹就画。
- **降级**：找不到 `.bpx-player-progress-wrap`、或容器不可写 → 静默跳过，不抛错、不影响标记与跳过功能。

## 7. 单独删 / 改

- 新增纯函数 `removeLocalSeg(segs, listKey, index)`：`listKey` ∈ `{'ops','eds'}`；先把入参过一遍 `validateLocalSegs`，再 `splice(index, 1)`，返回新对象；参数非法时返回未删除的校验结果（不抛错）。
- 导出到 `api_` 供单测。
- 工具条里的 `✕` → `removeLocalSeg(loadLocalSegs(key), listKey, index)` → `saveLocalSegs` → `syncFrameMonitor(runtime.result)`（会顺带 `clearFpSkips()`，让删完的标记立刻重新参与判定）→ 刷新状态行/列表/进度条。
- **不做「编辑某条时间」** —— 等价于删掉重标，YAGNI。
- 行点击 = `video.currentTime = <该条 start>`（跳到标记点，方便确认标得对不对）。不暂停/不播放，只 seek。

## 8. 设置面板那一节的处置

- 移除设置面板里的「本地标记 OP / ED」整节：`.mksec` 的 HTML 块、`.mksec` 相关样式、`fmtSec` / `refreshMark` / 5 个按钮的绑定、以及「清空本番标记」按钮。
- 原因：工具条是其超集（4 个标记按钮 + 列表 + 单删 + 清空），保留两处会变成双份维护，也让用户又回到「面板挡画面」。
- `fmtSec` **保留**（工具条状态行与列表都要用），只删掉设置面板里的那处用法 —— 不要删函数本身。

## 9. 模块与接口边界

新增（都放在 15 节 UI 区域，紧邻 `renderPill`）：

| 名称 | 职责 | 依赖 |
| --- | --- | --- |
| `markToggle()` | 切换标记模式、持久化、重画 | `runtime.markOn`、`gmSet`、`renderMark` |
| `ensureMarkHost()` | 计算目标容器并把独立 host 挂对位置 | `document.fullscreenElement` |
| `renderMark()` | 建/清/填工具条 DOM，绑定事件 | mark handlers、`loadLocalSegs`、`removeLocalSeg` |
| `refreshMarkBar()` | 只更新状态行 + 列表（不重建整个工具条） | `loadLocalSegs` |
| `paintProgressMarks()` | 把标记画到所有进度条容器上 | `progressMarks`、`loadLocalSegs` |
| `progressMarks(segs, dur)` | 纯函数：算出 `[{type,a,b}]` 百分比数组 | 无 |
| `pct(t, dur)` | 纯函数：秒 → 0~100 百分比 | 无 |
| `removeLocalSeg(segs, listKey, index)` | 纯函数：删掉指定一条 | `validateLocalSegs` |

改动：

- `renderPill()`：加 `🎯` 按钮 + `mark` 动作分发。
- `applyScreen()`：追加 `ensureMarkHost(); renderMark();`。
- `afterMark()`：追加刷新列表 + `paintProgressMarks()`。
- `boot()` 的 `bootTimer` tick：追加签名判断 + `paintProgressMarks()`。
- `openSettings()`：删掉第 7 节所述那一节。

不改：标记数据结构（`{ops:[{hash,start,end}], eds:[{hash,start,end}]}`）、`validateLocalSegs`、`frameStep`、`shouldUseLocalSegs`、`performSkip` 的抽帧去重与静默期、云端识别与跳过主流程。

## 10. 错误处理与降级

| 情况 | 行为 |
| --- | --- |
| 未绑定番剧 | 工具条可用，状态行显示未绑定；4 个按钮走既有 toast 分支 |
| 找不到进度条容器 | 静默不画进度条标记，其余功能正常 |
| `document.fullscreenElement` 是 `<video>` | 退化为挂在 `document.body`（工具条在全屏下不可见，但不抛错） |
| 拖拽过程中鼠标移出窗口 | `mouseup` 兜底结束拖拽，位置照常落盘 |
| 标记被外部清空（换集/清缓存） | 列表与进度条标记下一次刷新时自然变空 |

## 11. 测试策略

**可单测（扩充 `test/bilibili-aniskip.test.js`，新增组 48）：**

1. `removeLocalSeg`：删 ops 第 0 条、删 eds 最后一条、index 越界不动、`listKey` 非法不动、返回的是新对象（不改入参）。
2. `pct`：`0`、一半、超过 `duration` 被夹到 100、`dur<=0` → 0、负数 → 0。
3. `progressMarks`：把 `{ops:[{start:10,end:70}], eds:[{start:1300,end:-1}]}` + `dur=1400` 换成百分比数组并核对数值；ED pending 的 `b` 为 100。
4. `ensureMarkHost` 的容器选择：无 `fullscreenElement` → `document.body`；有 → 那个元素；`fullscreenElement` 是 video 桩 → 退回 body；重复调用只挂一次（用假 DOM 桩断言 `parentNode`）。
5. 工具条渲染冒烟：进标记模式后 shadow root 内能查到 4 个标记按钮 + 列表行数 = 已标套数。

**只能人工验（写进计划的验证清单）：**

- 工具条不挡画面中心与控制栏、拖动、位置记住。
- 网页全屏 / 真全屏下工具条可见；退出全屏恢复；真全屏下进度条标记也出现。
- 进度条上 OP 蓝 / ED 橙 的位置与实际标记点吻合。
- 点列表行能跳到该标记点；`✕` 只删一条；`清空本番标记` 清空全部。

## 12. 验收标准

1. 胶囊上出现 `🎯`，点击进/出标记模式，按钮有高亮态；刷新页面后状态保持。
2. 标记模式下工具条出现在播放器左下角，**不覆盖画面中心**，可拖动且位置被记住。
3. 4 个标记按钮即时生效，点完工具条不关闭，状态行与列表就地更新。
4. 列表列出已标项；点行跳到该标记点；行尾 `✕` 只删这一条且立即影响抽帧判定。
5. `清空本番标记` 清空本番全部标记。
6. 进度条上出现 OP 蓝 / ED 橙 区间标记；找不到容器时静默，不影响任何其它功能。
7. 网页全屏下工具条可见；真全屏下工具条可见（host 已重挂）；退出全屏恢复正常。
8. 设置面板里不再有「本地标记 OP / ED」一节。
9. `node test/bilibili-aniskip.test.js -q` → **0 失败**；`node --check bilibili-aniskip.user.js` 干净。
10. 未绑定番剧点标记按钮 → toast 提示，不写脏数据。

## 13. 明确不做（YAGNI）

- 不做键盘快捷键、当前帧缩略图预览、逐帧微调按钮（用户明确不要）。
- 不做标记时间的手工编辑（删掉重标即可）。
- 不在进度条上显示云端段（只显示本地标记）。
- 不把工具条做成可自定义主题/透明度/尺寸。
- 不改标记数据结构、aHash/匹配算法、跳过与撤回逻辑。
