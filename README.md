# BuildBrowser Translation

Deadlock 出装浏览器汉化 mod：把**玩家撰写的英文内容**（出装名、概览、分类描述、装备注释）显示成中文。
纯 Panorama UI 覆盖 + JS，不读内存、不改游戏数据、不装任何注入器。

当前版本 **v1.9.77**（最新可用版，见 [Releases](../../releases/latest)）。
实现细节、踩过的引擎坑、待优化清单见 **[docs/TECH_NOTES.md](docs/TECH_NOTES.md)**。

## 翻译什么、不翻译什么

| 位置 | 内容 |
| --- | --- |
| 出装浏览器列表 | 每条出装的名称（含 `的副本` 后缀） |
| 浏览器右侧详情 | 出装名称、出装描述（作者写的概览长文） |
| 商城出装页 | 分类名称、分类描述、每件装备的注释 |
| 鼠标悬停装备 | 提示里的作者注释 |
| 悬停出装详情图标 | 出装名称 / 描述浮层 |

不动的东西：游戏自己的本地化文本（装备名、UI 文案、`#Token` 标签）、数字与价格、已含中文的文本、
文本输入框。查不到译文的文本保持原文。

标题栏那个出装名是例外：它由引擎自己写入模板（`{s:selected_hero_build_name}`），
我们写 `.text` 会把模板顶掉、引擎之后再也改不进去（表现为"换出装还显示上一份名字"），
所以**它保持英文**、永远正确。详情页里的出装名照常翻译。

## 安装

1. 下载 `pak13_dir.vpk`，放到
   `...\steamapps\common\Deadlock\game\citadel\addons\`
2. 完全退出并重启 Deadlock。

卸载：删掉该文件即可。

两点注意：

- `game/citadel/gameinfo.gi` 的 `SearchPaths` 必须有 `Mod citadel` 和 `Game citadel/addons`
  （游戏更新偶尔会重置它）。参考 [Deadlock Modding Notes](https://deadlockmodding.pages.dev/installing-mods)。
- addons 里所有 `pak##_dir.vpk` **编号小者优先**。本 mod 是 `pak13`，若别的 mod 用更小编号提供
  相同布局，会整份压住本 mod（表现为"某几处永远是英文"）。用 VPKEdit 看谁的编号更小。

## 界面

只有一个按钮，两态切换，文案写的是**下一步要做什么**：

```text
[ 翻译 ]  ← 当前显示原文，点它翻成中文
[ 原文 ]  ← 当前显示译文，点它还原成原文
```

位置两处：

- **出装浏览器**（商城 → 出装）：详情面板右上，`出装选项` 那一行的行首下方。
- **游戏内出装页**（对局中点 B）：页面标题栏右边。

没有工具栏、没有刷新按钮、没有语言下拉菜单（v1.9.16 起移除），也没有"点一下翻一点"的模式：
一次点击翻整页。按钮下方的状态字只在过程期间出现（`正在连接桥…`、`已翻译 N 条`、`翻译失败: busy`），
几秒后自动回到 `翻译 / 原文`。

## 译文从哪来

```text
点击「翻译」
  → 收集当前页面的英文文本（跳过 token / 中文 / 输入框 / 自己的 UI）
  → 本地实时桥（首选）           → 整页批量，0.8–2 秒
  → 离线译文库（可选，默认关）    → 打包在 VPK 里的 5.8 万条 TM，零延迟
  → 整句兜底 / 术语表兜底        → 连不上桥时的降级
```

- **桥优先**：v1.9.29 起离线库默认关闭，启动日志写
  `offline memory: disabled (bridge-first mode)`。桥连上才能真正"整页经桥翻"。
- 想把离线库打开（不装桥也能翻）：游戏内控制台 `BBT_TM = "on"`，重进界面生效；`BBT_TM = "off"` 关回。
- 术语保护：英雄名、装备名、段位名、以及 `lane→线上`、`walker→步行者` 这类通用词，在送桥前替换成
  占位符（`⟦0⟧`），回包后还原，避免机翻把专有名词翻歪。
- 桥连上时日志会写：
  `[BBT] live bridge: connected to bbt-bridge (localhost:8793)`。

## 可选：本地实时桥

桥是一个本机 Node 进程，负责真正的翻译（默认 Bing，免 Key）。

```powershell
# 1) 生成自签证书并装进 CurrentUser\Root（无需管理员；需带 SAN=localhost，否则引擎不认）
powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Trust

# 2) 完全退出 Steam（含托盘）再启动 —— 引擎只在启动时读取信任库
# 3) 启动桥；想要开机自启就跑第二行
node tools\bridge\bridge.js
powershell -ExecutionPolicy Bypass -File scripts\install_bridge_autostart.bat
```

自检：`node tools\bridge\check.js`，输出 `8793 ready` 即可用。

- **已装 BabelTower / DeadlockLingua 的话**：本 mod 先探 8793（自己的桥），不通再探 8792
  （lingua 的桥），直接复用它的 provider / API Key / 词典 / 缓存，不用再装第二张证书。
- 想临时关掉实时通道：控制台 `BBT_LIVE = "off"`；恢复：`BBT_LIVE = "auto"`。都不用重打包。
- 限流与失败：同一时刻只有一条请求在飞（标题回传是单通道），会话内缓存结果，连续 3 次硬失败即放弃本会话。
- 隐私：只发送当前页面上"没有译文"的英文文本，不发账号/战绩。

桥的协议（`document.title` 回传，正文上限 6 KB）：

| 端点 | 用途 |
| --- | --- |
| `GET /api/v1/health` | 探测（页面标题回 `{"ok":true,"name":"bbt-bridge"}`） |
| `POST /api/v1/translate` | 单条/批量翻译，返回 `{ok, zh}` |
| `GET /api/v1/build?build_id=..&chunk=N` | 按出装 ID 预取整页文本（带来源标记 `n/d/cn<i>/cd<i>/a`），分页避免超出标题上限 |
| `GET /api/v1/tm/overrides?chunk=N` | 本地修正表，分页下发 |

## 已知问题与优化方向

1. **首屏偏慢**：点一次「翻译」要等桥回包。出装越大越慢——预取按 5 条/请求串行，
   40 多条注释要 10–20 秒才全部落库；期间悬停到还没翻的装备，仍要单独等 1–2 秒。
   方向：提高单请求文本数（现在离 6 KB 标题上限还很远）、桥内部并发翻译、把用户可见文本排到队首。
2. **期间再点会 `busy`**：预取链占住了唯一的在飞请求，此时点按钮会看到 `翻译失败: busy`
   或 `translate: skipped, batch already in flight`。方向：交互请求优先、预取可被抢占（部分已实现：
   新点击会丢弃上一轮的队列）。
3. **商城标题栏出装名保持英文**（见上，设计取舍）。根治需要给每个 header 配 1px 同 token 探针，
   见 TECH_NOTES §7。
4. **分类描述按序号配对**：v1.9.77 起用「出装 ID + 分类序号」从预取数据写入，保证跟随当前出装；
   若某份出装的分类顺序与 API 不一致会错位，届时改为按分类标题匹配。
5. 译文来自机器翻译 + 术语保护，个别句子可能生硬。
6. 游戏大版本更新后布局可能变化，需要重新反编译并重打 VPK。
7. 构建链只支持 Windows（resourcecompiler + vpkeditcli.exe）。

## 构建

依赖：Node.js ≥ 22.15（推荐 24）、Reduced CSDK 12、仓库自带的 `tools/vpkeditcli.exe`。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root "<Reduced_CSDK_12>"
# 加 -Deploy 直接复制到默认游戏目录；-GameCitadel <path> 指定别的安装位置
```

产物 `dist/pak13_dir.vpk`。**部署前必须先关游戏**，否则 pak 被占用会抛 `IOException`，
看起来打包成功、实际跑的还是旧包。

## 测试

CI 跑这十套（都不需要游戏）：

```powershell
node tests\translate_simtest.js      node tests\tm_table_simtest.js
node tests\tools_simtest.js          node tests\ui_button_simtest.js
node tests\scene_verify.js           node tests\vpk_list_simtest.js
node tests\refresh_verify.js         node tests\toolbar_cover_simtest.js
node tests\fragment_verify.js        node tests\live_channel_simtest.js
node tools\build_layout_tokens.js --check
```

另有本地专用（CI 不含，部分需要外部目录或游戏）：`tests\perf_probe.js`、
`tests\layout_dom_simtest.js --layouts <反编译目录>`、`tests\wiring_simtest.js`、`tests\own_chrome_simtest.js`。

## 可选：刷新离线译文库

只有想用"纯离线"路线时才需要（桥路线自带在线翻译）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\refresh_tm.ps1 -Csdk12Root "<CSDK>" -Deploy
# 等价于 fetch_builds → build_tm（Bing 机翻 + 术语保护，累积合并旧库）→ build.ps1
```

- 抓取来源：周榜 / 历史榜 / 最近 45 天更新 / 指定作者（`-Author <SteamID64>`）。
- 断点续翻：`tools/cache/translations.json` 记着已翻文本，Bing 限流或中断后重跑会接着来。
- 游戏内新文本收集：加启动项 `-condebug`，`console.log` 会打印 `[BBT] MISS <原文>`；
  `node tools\collect_new_texts.js` 把它并进额外语料，再跑 `refresh_tm.ps1`。

## 目录结构

```text
mod/panorama/layout/     6 个覆盖布局（原生结构 + 注入的 <scripts>）
mod/panorama/scripts/    bba_translate.js（扫描/写回/桥）· bba_tm.js（生成物）
                         bba_glossary.js（生成物）· bba_layout_tokens.js（生成物）
mod/panorama/styles/     bba.css（按钮位置与自有 UI）
tools/                   离线流水线（fetch_builds / build_tm / build_code / tm_table /
                         tm_export / inject_scripts / vpk_list）+ bridge/
scripts/                 build.ps1 · refresh_tm.ps1 · gen_bridge_cert.ps1 · 自启脚本
tests/                   离线测试套件
docs/                    TECH_NOTES.md（引擎事实与经验）等
```

## 排障

- **整片英文**：先看 addons 里有没有更小编号的 pak 压住同名布局；
  再看 `gameinfo.gi` 的 `SearchPaths`；最后看 `console.log` 里有没有 `[BBT] v1.9.77 loaded`。
- **按钮点了没反应**：看 `[BBT] live bridge: connected…` 是否出现；没有则桥/证书问题
  （证书必须带 SAN，且改完要完全重启 Steam）。
- **某个位置不翻**：`[BBT] MISS <原文>` 行会给出原文，用它判断是缺译文还是被跳过。
- **看实时统计**：控制台 `BBT_STATS`（`translated / writes / rebinds / live / ms / interval`）。

## 致谢

布局反编译用 [Source 2 Viewer](https://github.com/ValveResourceFormat/ValveResourceFormat)，
打包用 [VPKEdit](https://github.com/ValveResourceFormat/VPKEdit)，
出装数据来自 [deadlock-api](https://deadlock-api.com/)。
`<HTML>` 面板 + 受信 HTTPS 回传的思路参考了 BabelTower / DeadlockLingua 项目（代码独立实现）。
