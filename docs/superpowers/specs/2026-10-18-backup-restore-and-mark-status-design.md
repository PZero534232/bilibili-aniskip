# 「数据备份 / 标记状态提示 / 死代码清理」设计

- 日期：2026-10-18
- 状态：待评审
- 范围：`bilibili-aniskip` userscript（`F:\dsh\bilibili-aniskip`），目标版本 0.5.2
- 前置：0.5.1 已删掉「回顾 Recap / 融进正片的 OP·ED」两类片段

## 1. 背景与目标

两件事，一件比一件急：

1. **本地标记是全项目最贵的用户数据** —— 手标的是「某一帧的画面指纹」，丢了无法重建。现在代码里没有任何导出入口（全文件搜 `导出|导入|备份` 零命中），换浏览器、重装、清理站点数据 = 标记全没。
2. **「标了却不跳」没有解释** —— 云端有时间戳时本地标记静默不参与（`shouldUseLocalSegs` 返回 false），工具条却只显示「已标 OP 1 套」，用户只会以为坏了。

目标：**数据不丢** > **消除困惑** > 顺手清死代码。不新增播放行为。

## 2. 现有存储布局（导出范围的事实依据）

| GM 键 | 内容 | 备份 |
| --- | --- | --- |
| `autoDetect` / `jumpOp` / … / `hintThreshold`（13 个 `DEFAULTS` 键） | 设置 | ✅ |
| `_bindings` | 手动绑定 | ✅ |
| `_blacklist` | 历史「不是番剧」记录 | ✅ |
| `aniskip.localSegs.<bindingKey>` | 本地 OP/ED 指纹 | ✅ |
| `_markOn` / `_markPos` / `_pillPos` | 工具条 / 胶囊位置 | ✅（无害） |
| `_cache` | 识别缓存（可重建、体积大） | ❌ |
| `cfgVersion` | 配置迁移标记 | ❌（导入后由现有迁移逻辑处理） |

- 脚本只申请了 `GM_getValue/GM_setValue/GM_deleteValue`，**没有 `GM_listValues`** → `localSegs` 的键从 `_bindings` 的 key 枚举（没绑定的标记本来也用不了）。
- 没有 `GM_setClipboard` / 文件权限 → 交互走 textarea（见 5）。

## 3. 备份文件格式（schema v1）

```json
{
  "app": "bilibili-aniskip",
  "schema": 1,
  "version": "0.5.2",
  "exportedAt": "2026-10-18T23:10:00+08:00",
  "config": { "autoDetect": "off", "jumpOp": true, "skipOffset": 0 },
  "bindings": { "<bindingKey>": { "title": "…" } },
  "blacklist": { "b:BV1xx": { "t": 0, "title": "…" } },
  "localSegs": {
    "<bindingKey>": { "ops": [{ "hash": "0101…", "start": 12, "end": 102, "vid": "BV1xx:1" }], "eds": [] }
  },
  "ui": { "markOn": false, "markPos": null, "pillPos": null }
}
```

清洗规则（导入时执行）：

- `config`：只取 `DEFAULTS` 里认识的键，未知键忽略；数值沿用现有 clamp（`skipOffset`/`skipShift` ∈ [-30,30]、`undoSeconds` ≥ 0、阈值）
- `localSegs` 每项过 `validateLocalSegs`（`hash` 必填、`start`/`end` 必须有限数、`vid` 归一成字符串或 null）
- `bindings` / `blacklist`：只要求是对象；键值原样写回（读取侧本来就会兜底）
- `ui`：可选，缺省不影响功能

## 4. 导入语义（方案 A：整包覆盖，已与用户确认）

1. **先全量校验**，任何一项不合法就整包拒绝 —— 一个字节都不写（绝不出现「写了一半」）
2. 校验通过 → 先把**当前**数据打成快照存 `aniskip.lastBeforeImport`（新增键，**不参与导出**，避免「备份里套备份」）→ 再写回
3. 写回后：`config` 就地更新（复用现有保存逻辑）→ `renderPill()` → `rerun()`
4. 快照存在期间「撤销导入」按钮可见；点击 = 用快照再走一次导入流程，并清掉快照（避免来回套娃）

拒绝原因分档：不是合法 JSON / 不是本脚本备份（缺 `app`·`schema`）/ 备份来自更新版本（`schema > 1`）/ 字段损坏（指出哪一项）。

## 5. 交互（设置面板「数据备份」浮层）

- 设置面板底部加一行：`数据备份` + 按钮「导出 / 导入」
- 浮层内容：说明 + `<textarea>`（等宽、6 行）+ 「复制」「导入」「撤销导入」「关闭」
- 导出：JSON 填进 textarea 并 `select()`；「复制」优先 `navigator.clipboard.writeText`，失败回落提示「已选中，按 Ctrl+C」
- 导入：读 textarea → 校验 → `confirm` 提示会替换全部数据 → 写入
- 不做文件下载 / 上传：textarea 是唯一无需额外权限的通道，也方便手动存记事本
- 复用现有 `mountPanel` / `noFocus`（不抢 B 站快捷键）

## 6. 标记工具条状态行

`refreshMarkBar()` 现在拼的是 `当前：<标题>   已标 OP n 套 / ED m 套<hint>`。末尾追加当前状态：

| 条件 | 追加文案 |
| --- | --- |
| 本地指纹在跑（`runtime.localSegs` 非空） | `· 本地指纹匹配中（错过 OP/ED 画面就不会跳）` |
| 云端有段（`runtime.result.segments` 非空） | `· 云端已有时间戳，本地标记不参与` |
| 识别未完成（`runtime.result && !runtime.result.ok`） | `· 识别未完成，本地标记待命` |
| 其他 | 不加 |

## 7. 死代码清理

- `epLen`：`fetchAniSkip` 写入、`applyFrameHash` 透传，**0 处读取** → 三处全删
- `mixed`：`raw.replace('mixed-','')` + `mixed: /^mixed-/` 解析、段对象透传 → 删；`segmentEnabled` 的 `if (s.mixed) return false;` 保留（防历史数据）
  - 安全性依据：AniSkip 缓存键含 types（`seg:as:<id>:<ep>:<types>`），0.5.1 之前含 `recap`/`mixed-op` 的缓存键现在读不到；Anime Skip 映射已在 0.5.1 把 Mixed/Recap 置 null

## 8. 测试策略

纯逻辑抽成可测函数 `buildBackup()` / `parseBackup(text)` / `applyBackup(obj)`，UI 只做胶水。

- 导出：键齐全（13 配置 + bindings + blacklist + localSegs + ui），`_cache` 不在
- 往返：导出 → 清空 store → 导入 → 各键值与原始一致（含本地标记与 `vid`）
- 拒绝：非法 JSON / 缺 `app` / `schema=2` / localSegs 条目缺 hash / config 值类型错
- 撤销：导入后点撤销 → 回到导入前数据
- 状态行：三分支文案
- 现有 669 条保持全绿

## 9. 版本与文档

- `@version` 0.5.2 + CHANGELOG 条目
- README：设置表加一行「数据备份」；功能列表补「本地标记可导出备份」

## 10. 范围外（YAGNI）

- 导入合并语义（多设备各标一部分）
- 文件下载 / 上传、云同步
- 指纹算法升级（除非有实测误跳 / 漏认案例）
- 缓存迁移 / 清理工具
