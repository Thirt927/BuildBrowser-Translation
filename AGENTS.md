# BuildBrowser Translation（Deadlock 出装浏览器汉化 mod）— 项目速查

本文件供 AI 代理每次会话自动加载。默认语言：中文。
已知问题 / 待办 / 版本复盘**以 `TODO.md` 为准**（内容很长且按轮次记录），本文件只做高频速查，不重复抄。

## 1. 项目一句话

Source 2 **Panorama** 模组（不是 C#/Unity/Lua，不读内存，不挂 MelonLoader）：
覆盖 6 个布局（出装浏览器/详情/商城/分类/两个 tooltip），注入 `bba_translate.js`，
把玩家撰写的英文出装文本查**打包进 VPK 的离线译文库（TM，~5.8 万条）**翻成中文；
查不到走"整句兜底 → 术语表兜底 →（可选）本地 bridge 实时翻译"。装好即用，默认完全离线。

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 游戏内 | Panorama：XML 布局覆盖 + 注入 JS（Source 2 引擎 `$` 全局 API） |
| 工具链 | Node.js **≥ 22.15（内置 zstd 解压，推荐 24；本机是 v24.13.0）** |
| 编译打包 | Reduced CSDK 12 的 `resourcecompiler.exe` + `tools/vpkeditcli.exe`（仅 Windows） |
| 布局反编译 | Source 2 Viewer（S2V）导出/反编译 `*.vxml_c` |
| 数据 | deadlock-api 公开出装 + Bing 免 Key 机翻（`tools/providers/bing.js`） |
| 实时通道（可选） | `<HTML>` 面板 + 受信自签 HTTPS：先探 8792（DeadlockLingua 桥）再探 8793（本仓库 `tools/bridge/bridge.js`），都不通则永久离线 |

## 3. 关键路径（写死，不用再搜）

- 项目根：`F:\agents\deadlockfanyi\出装翻译`
- CSDK12（与 BabelTower-fork 同源）：`E:\dealoc-mod\Reduced_CSDK_12`
- Deadlock 安装（如有本体）：`E:\Steam\steamapps\common\Deadlock`，mod 部署到 `game\citadel\addons\`
- ⚠️ **本项目当前按"无游戏本体"工作**（TODO §11–13）：布局来源 = 原生 pak01 反编译 **或** 第三方 mod VPK 里解出的 Valve 原生副本（`citadel_shop_mods_build_category.xml` 即来自第三方 mod，拿到本体后应重新生成）；术语表冻结在 2026-10-29（`glossary.json` 里）。
- 编译产物：`dist/pak13_dir.vpk`（**pak 编号 13 决定 addons 优先级**，与别的 mod 冲突时改 `-PakName`，别改源码）
- 游戏运行期文件（有本体才存在）：`game/citadel/console.log`（需启动项 `-condebug`）、`game/citadel/gameinfo.gi` 的 SearchPaths 必须含 `Mod citadel` + `Game citadel/addons`（**随游戏更新会被重置**）

## 4. 构建 + 验证（最重要流程）

打包（约十几秒；`-Deploy` 才需要游戏目录）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root "E:\dealoc-mod\Reduced_CSDK_12"
```

1 分钟内确认改动没挂（与 CI 对齐）：

```powershell
node tests\scene_verify.js
node tests\refresh_verify.js
node tools\build_layout_tokens.js --check
```

全量（CI 跑这套，`.github/workflows/tests.yml`，Node 24）：

```
translate_simtest / tools_simtest / scene_verify / refresh_verify / fragment_verify /
live_channel_simtest / tm_table_simtest / ui_button_simtest / vpk_list_simtest /
toolbar_cover_simtest  （全部 `node tests\<名>.js`）
+ `node tools/build_layout_tokens.js --check` + `node tools/tm_export.js --out <tmp>`
```

本地另有 `layout_dom_simtest.js`（需 S2V 反编译目录，缺省自动 SKIP）、`perf_probe.js`。
**改了 `mod/` 下任何脚本/布局/样式 → 必须重新打包 VPK 并重启游戏**才生效。

数据刷新（让新出装出中文，一条命令）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\refresh_tm.ps1 -Csdk12Root "E:\dealoc-mod\Reduced_CSDK_12"
# 可加 -Author <SteamID64>（你自己的公开出装） -Recent -Lang English -Build
# 等价于 fetch_builds → build_tm（Bing 机翻+术语保护，累积合并旧库）→ build.ps1
```

## 5. 目录结构与数据流

```
mod/panorama/layout/          6 个覆盖布局（= S2V 反编译原生布局 + 注入的 <scripts>）
  citadel_ui_build_selector / citadel_ui_build_details / citadel_shop_mods_build
  / citadel_shop_mods_build_category / tooltips/citadel_tooltip_build_details
  / tooltips/citadel_tooltip_mod_details
mod/panorama/scripts/
  bba_translate.js            游戏内扫描器（手写，改它的规则前先读 TODO 五/十/十四）
  bba_tm.js                   翻译记忆（**生成物**，~4–5MB，勿手改）
  bba_glossary.js             官方术语表（**生成物**，build_glossary.js 产出）
  bba_layout_tokens.js        布局 class/id → #Token 对照（**生成物**，build_layout_tokens.js 产出）
mod/panorama/styles/bba.css   样式（BBTSrc/BBTProbe/工具条等）
tools/                        离线流水线（fetch_builds / build_tm / build_code / collect_new_texts
                              / tm_table / tm_export / inject_scripts / get_layouts.ps1
                              / find_layouts / vpk_list / bridge/bridge.js）
scripts/                      build.ps1 / refresh_tm.ps1 / gen_bridge_cert.ps1 / 自启 bat/vbs
tests/                        12 个离线套件（全部不需要游戏）
tools/cache/                  gitignore：builds.json / translations.json(断点) / extra_texts.json
                              / live_seen.json / tm_table.jsonl(本地会长大的库)
dist/                         gitignore：pak13_dir.vpk 等产物
```

流水线：`fetch_builds`（deadlock-api 周榜/历史榜/最近 45 天/作者）→ `build_tm`（装备/英雄名先置换占位符 → Bing 机翻 → 还原 → 双哈希累积并入）→ `bba_tm.js` → `build.ps1` → `pak13_dir.vpk` → addons。
游戏内：扫 Label（`#token`/中文/输入框早退）→ 离线库 → 整句兜底（≥55% 才混合）→ 术语兜底（≤160 字符）→ 实时 bridge（可选）；
实时结果落 `live_seen.json` → 下次 `build_tm` 并入，逐步变"开箱即离线"。
游戏内未翻译文本：`-condebug` 下 `console.log` 打印 `[BBT] MISS <key> <原文>` → `collect_new_texts.js` → 自动并入 TM。

## 6. 引擎 API 的坑（踩过的，改前必读对应 TODO 章节）

1. **`$.AsyncWebRequest` 已被引擎移除**——游戏 JS 不能发起 HTTP；唯一游戏内联网通道是
   `<HTML>` 面板，且必须 **HTTPS + 证书链受信**（自签进 `CurrentUser\Root`；引擎**只在启动时**读信任库
   → 改证书后必须完全重启 Steam）。面板在 XML 里声明、1px + `opacity:0.01`（`display:none` 不加载页面）。
2. **Label 文本两个来源**：A. 引擎直接赋值 `label.text`；B. 布局写 `text="#Token"`，token 本地化值
   是 `{s:var}` 模板，引擎用 `SetDialogVariable` 灌值。**对 `.text` 写译文会摧毁模板**，之后
   `SetDialogVariable` 无处落地 → 标签永远停在第一条译文（"换出装不更新"三连根因）。
3. **共享根面板上写 dialog variable 会"串味"**：没有自己值的行标签全部继承 → 列表每行显示当前选中名。
   两条路都试过、都失败 → **现行模型（v1.8.1，不要再回退）：源标签 + 1px 探针**：
   `BBTSrc`（可见、引擎驱动、我们翻完写它）/ `BBTProbe`（同 token 副本，1px、**必须正常渲染**，
   任何代码不写它，专用于读引擎最新英文）/ 探针拿不到值时降级显示引擎自己的英文。
4. **`visibility: collapse` 的 Label 不被渲染 → `{s:var}` 不解析 → `.text` 停在原始 `#Token`**。
   所以探针不能折叠，用"可见 + 1px + `opacity:0.01` + `overflow: clip`"。
5. **`onactivate="BBTTranslatePage()"` 全局函数名解析会静默失败**（IIFE + 严格模式）→
   一律 `panel.SetPanelEvent("onactivate", cb)` 直接绑定（`wireToolbar()`，带重试 + null 检查）。
6. **Label 默认吞点击**：按钮内 `<Label>` 加 `hittest="false"`，控件面板 `hittest="true"`。
7. 部分引擎**没有 `globalThis` 且引用未声明标识符直接抛错** → 用 `Function("return this")()` 兜底
   （TM 格式生成器同规则）。
8. **多 JS 上下文**：每个布局一份独立 JS 上下文，`bba_tm.js` 等共享库必须带"每上下文只构建一次"早退守卫
   （`if (globalThis.BBA_TM) return;` 一类）；新增共享脚本遵守同一约定。
9. **addons pak 优先级 = 小编号优先**：别的 mod 用 `pak11` 提供同名布局会**整份**压住我们的 `pak13`
   → "某处永远英文"第一排查是 `node tools\vpk_list.js --addons "<game/citadel/addons>"`。
10. **性能铁律（v1.2 起）**：轮询空闲退避（有变化 150ms → 连续无事翻倍到 1s；布局不可见停摆；
    新面板出现 0.08s 快速 burst ×4）；**跳过不可见子树**；命中 memo 后面板每 tick 只读一次 `.text`。
    别再加周期性轮询/全量重扫（BabelTower 那边同样踩过）。
11. **BTIPC 那套位信道是 BabelTower 仓库的，本仓库没有**——别把两个项目的实现混淆。
12. 游戏大版本更新 → 布局结构变化 → 覆盖文件失效：重跑 S2V 反编译 + `tools/inject_scripts.js`
    重新注入（`tools/get_layouts.ps1` 支持 `-Names "*build*"` 通配符批量），再重打 VPK。
13. **`<HTML>` 面板不能是 `<root>` 的直接子节点**：resourcecompiler 报
    `Found root panel with 'id' attribute, which is not permitted.`（布局里只有它一个顶层带 id 的面板时，
    它就被当成"根面板"）。出装分类帧那份要嵌进 `<CitadelShopModsBuildCategory>` 内部（v1.9.29 修）。
14. **找 `<HTML>` 面板要停在"布局根"，不是 HUD 根**：shop 树有上千面板，从全局根 BFS 的预算会先烧完
    ——`isLayoutRootTag()` 判布局根（`CitadelShopModsBuild` / `...Category` / `CitadelBuildDetails` /
    `CitadelHeroBuildsSelector`），否则就是 14:39 那次 9 个上下文齐刷刷 `panel_unavailable`（v1.9.29）。
15. **诊断代码绝不写进主循环裸奔**：`[BBT] PERF` 初版引用 boot 内局部变量 `layoutTag`，抛
    `ReferenceError: layoutTag is not defined`，异常跳过 `$.Schedule(interval, tick)` → 整个轮询停摆
    （14:39:28 实机）。任何日志行一律 `try/catch` 包裹。

## 7. 代码规范（什么该改、什么不该碰）

- **生成物不手改**：`bba_tm.js` / `bba_glossary.js` / `bba_layout_tokens.js` → 改生成器
  （`build_tm.js` / `build_glossary.js` / `build_layout_tokens.js`）后重新生成；
  改了布局必须跑 `build_layout_tokens.js --check` 保持对照表同步。
- **布局 XML 不手写**：从 S2V 反编译产物注入（`tools/inject_scripts.js`，幂等、`--no-tm` 可跳过译文库引用）；
  新增布局要同步加进 `scripts/build.ps1` 的 `$required` 清单（否则 VPK 校验漏资产）。
- **TM 是累积的**：`build_tm.js` 永远合并旧条目 + `tools/packs/*.json` 增量包 + `live_seen.json`，
  任何改动不得破坏"重跑不丢历史"（`tools_simtest` 有断言）。
- **工具 flag 语义已统一**：`arg("--x")` 双前缀是旧 bug（TODO §九-7），新增 CLI 参数用 `arg("x")`；
  裸 flag 恒为 true。
- **本地库容量闸（`tools/tm_table.js`）**：五道闸（准入/别名折叠≤8/译文去重/预算淘汰 15 万条 32MB/
  占位符校验）+ SimHash 阈值按句长自适应（`distanceFor`）——改匹配逻辑必须过 `tm_table_simtest`。
- 游戏内日志统一 `[BBT]` 前缀写 console.log；`BBT_STATS` / `BBT_DEBUG` / `BBT_LIVE` 挂 globalThis，
  游戏内可运行时改（`BBT_LIVE="off"` 关实时通道，不用重打包）。
- **提交前**（对齐 BabelTower 的纪律）：跑全量离线测试 + `build_layout_tokens.js --check`；
  不得提交 `tools/cache/`、`dist/*.vpk`、`config/certs/`、`logs/`、任何 API Key / SteamID 原文
  （`fetch_builds --author` 的 SteamID 出现在 README 示例里是占位符，别把真实 64 位 ID 写进文档）。
- 行尾 CRLF；文件不要带 BOM（TODO §一-22 修过一次，PowerShell 5.1 脚本尤其注意）。

## 8. 与 BabelTower-fork 的关系

`F:\agents\deadlockfanyi\BabelTower-fork`（DeadlockLingua 聊天翻译 mod）是经验来源，不共享代码：
- 本仓库实时通道**优先复用它的桥**（8792，证书也是它那份——已装 DeadlockLingua 就什么都不用做）；
- 引擎坑清单（HTML 面板证书链、`AsyncWebRequest` 移除等）见它根的 `AGENTS.md`；
- 但两边**协议、脚本、构建互不相干**，别往本仓库合它的代码。

## 9. 经验教训（改代码时注意）

- `bba_translate.js` 的写入路径改过三轮（`.text` → `SetDialogVariable` → 源+探针，v1.8.1 定型）。
  **不要再加回任何 `SetDialogVariable` 写入路径**（TODO §十四：含 k:2 校验状态机已全部删除）。
- "翻译不刷新 / 一直覆盖"类 bug 先查：探针是否失效、身份标签（`.BuildID` 等）是否还在 token 表里、
  addons 里有没有更小 pak 压住同名布局、`gameinfo.gi` 是否被更新重置。
- 实机信号（有本体时，`-condebug` 后看 `console.log` 的 `[BBT]`）：启动行
  `[BBT] vX.Y.Z loaded (tm=..., glossary=1) in layout: <面板>`、`[BBT] toolbar wired: N control(s)`、
  `[BBT] MISS <key> <原文>`；`BBT_STATS`（`translated / writes / rebinds / live / ms / interval`）可直接读。
- **无本体也能推进的范围**（TODO §十一）：`tools/vpk_list.js` 解析第三方 mod VPK、S2V 反编译布局、
  数据流水线、全部离线测试、重打包。实机验证（换出装刷新/工具栏/帧率）必须有游戏。
