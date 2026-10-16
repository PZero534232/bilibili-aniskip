# 本地标记「ED 结束」+ 标记入口移入设置面板 · 设计

- 日期：2026-10-16
- 状态：待评审
- 范围：`bilibili-aniskip` userscript（`F:\dsh\bilibili-aniskip`）
- 前置：`2026-10-16-local-op-ed-frame-marking-design.md`（本设计是它的增量修订）

## 1. 背景与动机

上一版「本地手动标记 OP/ED 帧」（v0.5.0，未发布）已实现：

- OP：标「开始帧」+「结束时间」→ 认到开始帧后，按 OP 时长从检测点跳到 OP 结束。
- ED：只标「开始帧」→ 认到后**直接跳到视频结尾**。

有两个问题：

1. **ED 落点太粗**：有些番 ED 之后还有预告 / 彩蛋，跳视频结尾会把它们一起切掉。用户要求 ED 也能标「结束」，精确落到 ED 结束点。
2. **入口太臃肿**：标记动作挂在**油猴菜单**里，加上原有的「绑定 / 识别」「番剧跳过设置」，菜单项过多，用户反馈「太臃肿」。改为放进脚本自己的**设置面板**。

## 2. 目标与非目标

### 目标

- 新增「标 ED 结束」动作，ED 落点可精确到 ED 结束点。
- 4 个标记动作全部从油猴菜单移到**设置面板**内；油猴菜单只保留「绑定 / 识别」和「设置」两项。
- 向后兼容：老数据、以及「只标 ED 开始」的用法都还能用（落视频结尾）。

### 非目标（本轮不做）

- 不做键盘快捷键标记。
- 不改 OP 的落点规则。
- 不做云端同步 / 跨设备。
- 不改指纹算法（aHash / 阈值 / 连续命中次数）。

## 3. 核心决策（已与用户确认）

| 决策点 | 结论 |
| --- | --- |
| 标记入口 | **设置面板**新增一节（不放油猴菜单、不放胶囊） |
| ED 结束 | **可选**：标了 → 落点 = 检测点 + (end − start)；没标 → 落视频时长（老行为） |
| ED 数据结构 | 与 OP 对称 `{hash, start, end}`，`end = -1` 表示未标结束 |
| 老数据 | `{hash}` 归一为 `{hash, start: 0, end: -1}`，落回老行为 |
| 版本 | 并入未发布的 **0.5.0**（不另开 0.5.1） |

## 4. 数据模型

GM key 不变：`aniskip.localSegs.<bindingKey>`

```json
{
  "ops": [ { "hash": "0101…", "start": 12.3, "end": 102.0 } ],
  "eds": [ { "hash": "1010…", "start": 1300.2, "end": 1400.5 } ]
}
```

- `ops`：不变。
- `eds`：由 `[{hash}]` 扩为 `[{hash, start, end}]`。
- `end = -1`：pending（未标结束）。
- OP pending（`end <= start`）不参与匹配；ED pending **仍参与**，落视频时长。

## 5. 行为规则

### 5.1 记录（纯函数，`bilibili-aniskip.user.js` 14.1 节）

- `recordOpStart(segs, hash, time)`：不变。
- `recordOpEnd(segs, time)`：不变。
- `recordEdStart(segs, hash, time)`：**签名变更**（加 `time`）→ push `{hash, start: time, end: -1}`。
- `recordEdEnd(segs, time)`：**新增** → 从后往前找第一条 `end < 0` 的 ED，写入 `end = time`；没有 pending ED 则原样返回。
- 无 pending 时点「标 OP 结束 / 标 ED 结束」：无操作，给 toast 提示（避免用户以为标上了）。

### 5.2 校验（`validateLocalSegs`）

- `eds` 与 `ops` 同样保留 `hash / start / end`。
- 缺 `start / end` 的老条目（`{hash}`）：`start` 缺省 `0`、`end` 缺省 `-1`（**归一，而不是丢弃**）。
- `hash` 为空 / 非字符串的条目仍然丢弃。

### 5.3 匹配（`frameStep`）

- 命中 OP：`落点 = currentTime + (end − start)`（不变）。
- 命中 ED：
  - `end > start`（标了结束）→ `落点 = currentTime + (end − start)`
  - 否则（pending）→ `落点 = duration`（视频时长，老行为）
- `FRAME_THRESHOLD = 10`、`FRAME_CONSECUTIVE = 2`、`FRAME_SAMPLE_MS = 250` 全部不变。

### 5.4 本地兜底判定（`shouldUseLocalSegs`）

- 不变：`usableOp（end > start） || eds.length`。
- 含义：只要有一条 pending ED，也算「本地有可用指纹」；此时 ED 落视频时长（老行为）。

### 5.5 标记后即时生效

`runtime.localSegs` 是 `rerun()` 时取的快照。标记 / 清空之后必须重新同步，否则新指纹要等下次 rerun 才生效：

- 每次标记、以及「清空本番标记」之后，调用 `syncFrameMonitor(runtime.result)`。
- 它按既有规则决定「开抽帧 / 停抽帧」，并刷新 `runtime.localSegs`。

## 6. UI 设计（设置面板新增一节）

位置：`openSettings()` 的 `panel.innerHTML` 中，「胶囊位置 / 重置位置」那一行**之后**、`.btns`（清空缓存 / 取消 / 保存）**之前**。

结构：

```
── 本地标记 OP / ED（冷番兜底）──────────────
云端没时间戳的番：暂停到画面，点下面按钮标记。
脚本靠画面指纹自动识别，同番跨集复用。标记即时生效，不用点「保存」。

当前：<番名 第N集 / 未绑定 —— 先去胶囊点「绑定」>
OP   开始 12.3s    结束 102.0s
ED   开始 1300.2s  结束 ——

[标 OP 开始] [标 OP 结束] [标 ED 开始] [标 ED 结束]   [清空本番标记]
```

交互：

- 4 个标记按钮**即时生效**（与现有「清空缓存」「重置位置」同类，不参与 `.save` 的 patch）。
- 点击后**不关闭面板**，就地刷新状态行（显示已记录秒数 / `——`）。
- 未绑定时按钮照常可用，点击 toast「先绑定 / 识别这个番剧再标」（复用现有 handler 行为）。
- 「清空本番标记」：删掉当前 `bindingKey` 的本地记录 → 刷新状态行 → `syncFrameMonitor` → toast。
- 状态行数据来源：`currentBinding()` + `loadLocalSegs(bind._key)`。
- 文案明确「**即时生效，不用点保存**」，与面板其它控件的「保存后生效」区分开。

样式：沿用面板内联样式约定（CSP 安全）—— 新增的节标题 / 状态行用内联 `style.cssText`，**不新增 `<style>` 注入**。

### 6.1 涉及改动的函数

| 函数 | 改动 |
| --- | --- |
| `recordEdStart` | 加 `time` 参数，push `{hash, start, end:-1}` |
| `recordEdEnd` | 新增（纯函数） |
| `validateLocalSegs` | `eds` 保留 `start/end`，老条目归一 |
| `frameStep` | ED 分支：标了结束用相对落点，否则落 `duration` |
| `markEdStart` | 改调 `recordEdStart(segs, hash, currentTime())`；标记后 `syncFrameMonitor` |
| `markEdEnd` | 新增（不抓帧） |
| `markOpStart` / `markOpEnd` | 标记后 `syncFrameMonitor`；无 pending 时给提示 |
| `openSettings()` | 新增一节 + 5 个按钮事件 + 状态刷新闭包 |
| `boot()` | **删掉** 3 条 `GM_registerMenuCommand('⏱ …')` |
| `api_` 导出 | 新增 `recordEdEnd`（供测试直接驱动） |
| `api` 调试钩子 | 新增 `_markEdEnd`（与 `_syncFrameMonitor` 同风格，供浏览器控制台调试） |

## 7. 兼容性

- 老数据 `eds:[{hash}]` → 归一为 pending，行为等于「跳视频结尾」，与升级前一致。
- 油猴菜单删掉标记项后，入口只剩两条：胶囊 `⚙` → 设置面板；油猴菜单「⚙ 番剧跳过设置」→ 设置面板。
- 「隐藏胶囊（普通视频）」开启时，未识别的普通视频没有胶囊，但油猴菜单里的「设置」仍在，入口不丢。

## 8. 测试计划

改 `test/bilibili-aniskip.test.js`：

- **47c（存取与校验）**：ED 保留 `start/end`；老 `{hash}` 归一为 `{hash, start:0, end:-1}`；坏条目仍丢。
- **47d（标记记录）**：`recordEdStart(segs, hash, time)` 新签名；新增 `recordEdEnd` 用例（填最后一条 pending；无 pending 时不变）；`api_.recordEdEnd 已导出`。
- **47e（frameStep）**：ED 标了结束 → `currentTime + (end − start)`；ED pending → `duration`；OP 行为不变。
- **47f（shouldUseLocalSegs）**：保持「只有 ED（pending）也算可用」。
- **47g / 47h**：不变。
- 全量必须 **0 失败**；`node --check bilibili-aniskip.user.js` 干净。

## 9. 风险

- 设置面板是模态（全屏遮罩），标记时看不到画面 —— 缓解：视频是**暂停**的，`captureFrameHash` 读的就是暂停帧，遮罩不影响抓帧；状态行回显秒数让用户能确认标对没有。若将来嫌开关面板麻烦，再加胶囊快捷键或非模态小面板。
- 设置面板里出现「即时生效」的按钮，与「保存后生效」控件风格不一致 —— 缓解：加小标题 + 明确写「即时生效，不用点保存」。
- 标记后立刻 `syncFrameMonitor` 会让「云端有段」的番不启用本地指纹（云端优先）—— 这是既有规则，符合预期。

## 10. 验收标准

1. 设置面板里能看到 4 个标记按钮 + 状态行；未绑定时点按钮有 toast 提示。
2. 标了 ED 开始 + ED 结束 → 下一集认到 ED 开始帧后，跳到「检测点 + ED 时长」，不再跳视频结尾。
3. 只标 ED 开始 → 认到后跳视频结尾（向后兼容）。
4. 老数据（`eds:[{hash}]`）升级后仍可用，行为是跳视频结尾。
5. 油猴菜单里不再有 4 个 `⏱` 标记项，只剩「绑定 / 识别」「设置」。
6. `node test/bilibili-aniskip.test.js -q` → 0 失败；`node --check bilibili-aniskip.user.js` 干净。
