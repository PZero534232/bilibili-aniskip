# Greasy Fork 600364 站内描述（使用说明）

贴进：https://greasyfork.org/zh-CN/scripts/600364 → 登录 → 「编辑描述」框（Markdown 语法可用）。

限制（help/allowed-markup）：可用 h1-h6 / a / img / ol / ul / li / code / strong / em / table / details 等元素；图片只允许 `src="https://..."`；CSS 只允许 background-color / border / color。所以图床必须用 https 的外链（仓库里的 images/ 是相对路径，不能直接搬，需要换成 GitHub raw 链接或先传图床）。

---

以下为正文（从这里开始复制到 GF 描述框，含分隔线以下、不含本行）：

---

# 项目地址：[GitHub - bilibili-aniskip](https://github.com/PZero534232/bilibili-aniskip)

- 装好后什么都不用做，默认 `off` 档只认你手动绑定的番剧，普通视频（非番剧）上绝不触发
- 跳 OP/ED 用的是 [AniSkip](https://aniskip.com) / [Anime Skip](https://animeskip.com) 的公共时间戳库；识别需要联网查一次，之后有缓存
- 此处只放使用说明，完整文档（含浏览器适配、绑定面板用法、排错）见 [GitHub README](https://github.com/PZero534232/bilibili-aniskip#readme)

---

## 使用

打开番剧播放页，视频右上角会出现一个胶囊（可拖动）：

1. 想自动跳 —— 点胶囊上的 **⚙**，把「自动识别」调成 `auto`
2. 胶囊显示「未识别」—— 点胶囊上的 **绑定**，搜一次番名绑上，全季复用
3. 绑了还是不跳（冷番 / 数据库没收录）—— 点胶囊上的 **🎯**，播到 OP 开头点「标 OP 开始」、结尾点「标 OP 结束」（ED 同理），标完立刻生效

跳错了？跳过的瞬间右下角有「撤回」按钮；更多设置（跳过偏移、整段平移等）都在 ⚙ 面板里。

绑定面板和标记工具条的详细玩法见 [GitHub README](https://github.com/PZero534232/bilibili-aniskip#readme)。

---

## 隐私

- 仅在你打开番剧播放页时联网查询 [AniSkip](https://aniskip.com) / [Anime Skip](https://animeskip.com)（GET 请求，带番剧名和集号，不带任何账号信息）；识别结果本地缓存
- 不收集、不上传任何数据；本地标记和绑定存在油猴的 GM 存储里，只在本机

---

## 反馈

- Bug / 建议：[GitHub Issues](https://github.com/PZero534232/bilibili-aniskip/issues)
- 数据库缺你这部番的时间戳？去 [AniSkip 官网](https://aniskip.com) 提交，或用本脚本的本地标记兜底

---

（正文结束，复制到这里为止）

---

## 贴入步骤

1. 打开 <https://greasyfork.org/zh-CN/scripts/600364>，右上角登录
2. 页面右侧「作者」区找「编辑描述」入口（或直接开 <https://greasyfork.org/zh-CN/scripts/600364/edit>，登录后可见）
3. 把上面分隔线之间的正文粘进「描述」框，保存
4. 保存后刷新脚本页即可看到；GF 只在你发新版本时才重读脚本代码，这个站内描述随时改随时生效
5. 想配图的话：GF 只收 `https` 外链图。仓库里的截图可以传到任意 https 图床（B 站专栏不行，得直链），把 `![](https://…)` 插在对应段落后面；GitHub raw 链接（`https://raw.githubusercontent.com/PZero534232/bilibili-aniskip/main/images/pill.png`）也可以，前提是那些图已 push
