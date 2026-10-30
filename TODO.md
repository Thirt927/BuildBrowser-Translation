# BuildBrowser Translation - 已知问题与待办

> 2026-10-30 代码审查整理。标记:【已修】= 本次已在仓库中修复并有测试;【待修】= 已确认的问题,尚未改;
> 【新增】= 计划中 / 等待新增的功能。

## 0. 当前行动清单(按顺序,全部完成即收口"右侧详情 + 悬停提示"问题)

1. ☑ **S2V 导出布局**:已导出并随仓库生成覆盖(2026-10-30,游戏版本当日):
   - `citadel_ui_build_details` → `mod/panorama/layout/citadel_ui_build_details.xml`
   - `tooltips/citadel_tooltip_mod_details` → `mod/panorama/layout/tooltips/…`
   - `tooltips/citadel_tooltip_build_details` → 同上(结构已确认与当前版本一致)
2. ☑ **生成覆盖**:用 `tools/inject_scripts.js` 注入;三个布局都**带 TM**(修复 tooltip
   根上下文 `tm=0` 的问题),`bba_tm.js` 增加了"每个 JS 上下文只构建一次"的早退守卫,
   多布局重复 include 不再重复构建 5.8 万条。
3. ☑ **验证 + 重打包**:`node tests\scene_verify.js` 全 PASS(新增右侧详情
   `.BuildName` / `.BuildDescription` 的真实布局断言),已重新打包部署。
4. ☐ **游戏内确认**:进商城/出装浏览器 → 换一条出装,右侧详情与悬停注释出中文。
   若仍不生效,按 README"排查"2/3:检查 addons 里有无**编号更小**的 pak 覆盖同名布局,
   并确认 `gameinfo.gi` 的 SearchPaths 含 `Mod citadel` + `Game citadel/addons`(游戏更新会重置)。
   日志里现在会打印 `in layout: <面板类型>`,可直接确认哪些布局带了扫描器。
5. ☑ **补一次全量刷新**(可选,让译文库覆盖你的个人出装):
   `node tools\fetch_builds.js --ids-only --author "76561199479487287"` 已执行
   (该账号当前没有公开出装,返回 0;流水线本身可用)。
   另已修复 `--author` 只接受 12 位以内数字、会拒绝 SteamID64 的 bug。

## 一、已确认的问题

### 布局覆盖(2026-10-30 用户反馈,优先级最高)

0a.【已修·高】**出装浏览器右侧详情"换出装不更新"**:根因是 `citadel_ui_build_details`
   是独立布局,引擎把它挂在选择器树之外(或刷新时重设文本),扫描器既到不了它、
   旧的 WeakMap 缓存又会在引擎重设原文时跳过重写。修复:
   - 新增 `mod/panorama/layout/citadel_ui_build_details.xml` 覆盖(带脚本 + TM);
   - `bba_translate.js` 改为"与当前显示文本比较",引擎重置为英文后必定重译(附回归测试);
   - `scene_verify.js` 增加对 `.BuildName` / `.BuildDescription` 的真实布局断言。
0b.【已修·高】**装备悬停提示的作者注释不翻译**:根因是 tooltip 布局所在 JS 上下文
   没有译文库(启动日志里出现 `tm=0` 的单例)。修复:tooltip 覆盖也 include
   `bba_tm.vjs_c`,并加早退守卫避免重复构建;`scene_verify` 场景 2 已 PASS。
0c.【已修】新增 `tools/inject_scripts.js` 与 `tools/get_layouts.ps1`:
   对反编译布局一条命令注入 `<scripts>` 引用(幂等、可 `--no-tm` 跳过译文库引用),
   产物自动落入 `mod/panorama/layout/`,`build.ps1` 会随编译。`get_layouts.ps1`
   支持一次处理多个布局(传入 S2V 导出目录 + 布局名列表)。
   ⚠ 注意:未传 `--out` 且路径不含 `layout/` 时,工具会把子目录布局拍平到 layout 根目录
   (本次已用 `--out` 修正 tooltip 路径)。

### 工具链(tools/)

1.【已修】**出装码编码是有损的**:`build_code.js` 的 `encode()` 丢掉 `ability_order`(样本里 16 条
   全丢)和 `development_build`,往返后数据缺失。已改为无损(含 ability_order 子消息编码)。
2.【已修】**裸 protobuf 出装码无法解析**:`decode()` 注释声称"检测 zstd 与裸 protobuf",
   实际遇到非 zstd 魔数直接 throw。现已按魔数自动判别,裸 protobuf 直接解析。
3.【已修】**出装码文件多码时静默错解**:整文件当一个 base64 串解码,多行码会粘在一起。
   CLI 现在按行逐条解析并输出数组。
4.【已修】**译文库会缩水(数据丢失陷阱)**:`build_tm.js` 每次从 `tools/cache/builds.json`
   全量重建 `bba_tm.js`。热门榜掉出排名的老文本、或清掉 `tools/cache` 的机器(该目录被
   .gitignore 排除,新克隆拿不到)会丢掉已有译文。现在生成前解析旧 `bba_tm.js` 并
   **累积合并**旧条目(新增 `loadExistingTm()`,有测试覆盖)。
5.【已修】**`--ids-only` 开关与参数顺序耦合**:`fetch_builds.js` 的 `arg()` 在 flag 后面没有
   值时返回 fallback(false),`--ids "..." --ids-only` 这种顺序下开关失效。已与 build_tm
   的语义统一(裸 flag 恒为 true)。
6.【待修】**`build_glossary.js` 依赖本机游戏文件**才能刷新术语表;仓库里冻结的是
   2026-10-29 的 `glossary.json`。游戏更新后若只跑 fetch + build_tm(不带 -GameCitadel),
   新增英雄/装备/段位不会进入术语保护,机翻可能把新名字翻错。建议:发布时随附一份
   可用的 `glossary.json` 并在 README 里注明"术语表过期"的检测方式(如统计未命中保护次数)。
7.【待修】**Bing 免 Key 渠道不稳定**:触发验证码 / 429 后 `build_tm.js` 会重试到 4 次上限
   然后整批放弃(文本留在 pending,不入库)。没有第二个 provider 兜底,也没有"从断点
   继续"的入口脚本说明(实际可重跑,但 README 未说明 `translations.json` 断点缓存的作用)。
8.【待修】**`tools/cache/` 被 .gitignore 排除**:新克隆用户第一次生成 TM 需要
   (a) 跑约 5000+ 次 API 抓取,(b) 对 5.8 万条文本全部重新走 Bing —— 重且不稳定。
   建议发布 Release 附件(`builds.json` + `translations.json` + `bba_tm.js`)供直接拉取,
   或把 `translations.json` 入库(纯文本缓存,体积约 1-2MB)。
9.【待修】**构建链路只支持 Windows**:`resourcecompiler.exe`(CSDK)、`vpkeditcli.exe`
   都是 Windows 二进制。建议:文档说明 Linux 可用 CSDK 的 Linux 版 resourcecompiler +
   VPKEdit 的 jar 版(`java -jar vpkeditcli.jar`),并在 build.ps1 之外提供 build.sh。
10.【已修】**build.ps1 旧文件残留**:`content\citadel_addons\bbt` 阶段目录只覆盖不删除,
    mod 里删掉的文件会残留进 VPK。现在先清 `panorama` 再拷贝。
11.【已修】**VPK 名硬编码**:`$PakName` 写死 `pak13_dir.vpk`,与别的 mod 冲突时要改源码。
    已加 `-PakName` 参数。
12.【已修】**术语表混入内部/测试名**:`glossary.json` 里有 `Test Hero`/`TargetDummy`/
    `Shield Guy`/`Generic Person` 等本地化文件里的占位条目。生成器已过滤,提交数据已清理。

### 游戏内脚本(bba_translate.js)

13.【已修】**已翻译面板每 150ms 被重写一次**:命中 TM 后每个 tick 都 `panel.text = hit`,
    白白触发属性 setter。已加 WeakMap 记忆,只有引擎重置过文本才重写(顺带修正:
    引擎更新原文时会重新翻译)。
14.【已修】**副本名丢失"的副本"标记**:lookup 剥离副本后缀命中译文后,显示的是纯译文,
    列表里副本与原件无法区分。现在 `wasCopy` 命中会在译文后补回" 的副本"(有测试)。
15.【已修】**TextEntry 判定过窄**:`isTextEntry` 只认 `maxchars` 为 number;引擎若把
    属性值暴露为 string("50"),输入框会被当成普通 Label 改写。现在 number/string 都认。
16.【已改进】**长文本无兜底**:译文库未收录的 >160 字符描述仍保持英文(只有 ≤160 的短句
    做术语替换)。现在由**未翻译收集器**(§二-1)把游戏内实际出现的未知文本写进
    `console.log`,离线补译后重新打包;跑一轮游戏即可覆盖当天的冷门/新出装。
17.【已修】**tooltip 布局依赖宿主加载 TM**:`citadel_tooltip_*.xml` 现在也 include
    `bba_tm.vjs_c`(启动日志中的 `tm=0` 单例即此问题的证据)。为避免多实例重复构建,
    `bba_tm.js` 生成时带 `if (globalThis.BBA_TM) return;` 早退守卫。
18.【待修】**没有运行时开关/配置**:译文显示开关、是否保留"的副本"标记、DEBUG 详细
    日志等都要改源码重新打包。`BBT_STATS`/`BBT_VERSION` 已挂 globalThis,可加一条
    控制台命令或迷你设置面板。
19.【已修】**无 CI**:新增 `.github/workflows/tests.yml`,push / PR 时跑
    `translate_simtest`、`tools_simtest`、`scene_verify`(不依赖 `tools/cache`,新克隆可直接跑)。
20.【待修】**`layout_dom_simtest` 依赖反编译的游戏布局**(仓库不带),新克隆只能 SKIP。
    建议把测试用到的最小布局子树(fixtures)入仓库,或提供一键反编译脚本。
21.【待修】**`bba_tm.js` 4.2MB 直接入库**:可用 Git LFS 或改为 Release 附件,减轻克隆负担。

### 其它

22.【已修】**README/脚本带 BOM**(`﻿#`):`README.md`、`build.ps1`、`refresh_tm.ps1`
    首字节是 U+FEFF,已统一去掉。
23.【待修】**`vpkeditcli.exe` 是第三方二进制直接入库**,建议记录其来源版本/哈希
    (VPKEdit 的 commit),便于安全审计与更新。
24.【待修】**`fetch_builds.js` 对第三方 API 无版本兜底**:`deadlock-api.com` 接口变动时
    整条流水线失败且报错信息对普通用户不友好。建议在抓取层做字段校验 + 示例输出。

## 二、待解决 / 等待新增功能(按优先级)

1.【已实现·高】**未翻译文本收集器**:游戏内把"未知且非中文"的文本以
   `[BBT] MISS <key> <text>` 写入 `console.log`(每实例去重、上限 300 条);
   `tools/collect_new_texts.js` 读日志 → `tools/cache/extra_texts.json` →
   `build_tm.js` 自动把额外语料一起翻译并累积并入 TM。已接入 README 流程。
2.【新增·高】**Release 一体化产物**:发布 `dist/pak13_dir.vpk` + `tools/cache` 快照 +
   生成物,新用户一键安装,老用户直接更新,避免重跑 Bing。
3.【新增·中】**多语言**:provider 目标语言参数化(`zh-Hans` → `ja`/`ko`/`en`…),
   游戏内按启动语言或手动选择;术语表按语言分目录。
4.【新增·中】**长文本兜底增强**:对 >160 字符的未收录文本,至少把其中出现的官方
   术语(英雄/装备/段位/技能名)逐处替换(目前术语兜底只对 ≤160 短句生效);
   技能名(abilities,445 条)可评估纳入兜底(需先过滤普通词,见 glossary.json)。
5.【新增·中】**第二翻译 provider**(MyMemory / 本地 LLM 脚本等)+ provider 切换参数,
   Bing 全挂时流水线仍可跑。
6.【新增·中】**游戏更新自动检测**:把当前覆盖布局的"结构指纹"(标签/类名集合)写进
   mod,启动时与游戏实际布局比对,不一致就 console 提示"游戏已更新,请反编译刷新布局",
   替代目前"翻译突然失效且无提示"的体验。
7.【新增·低】**设置 UI**:在 browser 布局右上角加一个极小的 BBT 面板(开关、显示
   译文库规模、一键"收集未翻译文本"开关)。
8.【新增·低】**CI 与质量**:GitHub Actions(测试 + 生成物一致性校验)、`bba_tm.js`
   走 LFS 或 Release、测试 fixtures 入仓(§一-19/20/21)。
9.【新增·低】**build_code.js 增加"出码"功能**:从 JSON(可改文本)生成可粘贴出装码,
   方便本地修改注释后再分享(现在 encode 已无损,只差一个 CLI 入口)。
10.【新增·低】**多语言副本后缀**:按游戏语言决定补" 的副本"还是 "(Copy)"
    (目前写死中文)。

## 三、外部资源调研(2026-10-30,deadlock-api / Deadlock Modding Notes)

- **deadlock-api OpenAPI**(`/openapi.json`,132 个端点)对本项目的可用项:
  - `GET /v1/builds/by-author/{account_id}`——【已接入】`fetch_builds.js --author <SteamID64>`,
    作者自己的公开出装保证进译文库(它们通常不在热门榜上)。
  - `GET /v1/patches`(RSS,最新 pub_date 2026-10-15)——【待做】"游戏更新检测"信号源:
    刷新流水线时拉一次 patches,把最新 patch 日期写进 `builds.json` 元数据;比上次新就提示
    "游戏更新过,布局/术语表可能需要刷新"(与二-6 合并实现)。
  - `/v1/builds` 列表行自带完整 `hero_build` 文本,现有抓取不需要补细节请求。
  - 资产端点(items/heroes/ranks)**只有英文侧**,不能替代本地游戏文件生成术语表,
    但可用来检测"游戏加了新英雄/装备而 glossary.json 未刷新"(一-6 的改进路线)。
  - 限流:IP 200req/min、Key 400req/min;503/504 带 Retry-After——`fetch_builds.js`
    的重试已覆盖,无需改。
- **Deadlock Modding Notes**(deadlockmodding.pages.dev):
  - `installing-mods`:mods 放 `game/citadel/addons/`,需 `gameinfo.gi` 的 SearchPaths 含
    `Mod citadel` + `Game citadel/addons`(该文件随游戏更新可能被重置);
    **`pak##_dir.vpk` 小编号优先**(01–99)——已写进 README,也是"部分位置不翻译"的头号嫌疑。
  - `csdk12-packing`:CSDK12 官方打包工具 CS2/Multichunk Workshop Manager,单 VPK 2GB 上限
    (Multichunk 拆块)。我们 vpkeditcli 路线不受影响(TM 才 4MB)。
  - `asset-structure`:全资产类型/编译器对照,扩展 mod 时用。
  - CSDK12 的 addon 目录结构与 build.ps1 交叉验证一致。
