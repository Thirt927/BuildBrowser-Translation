# BuildBrowser Translation - 已知问题与待办

> 2026-10-30 代码审查整理。标记:【已修】= 本次已在仓库中修复并有测试;【待修】= 已确认的问题,尚未改;
> 【新增】= 计划中 / 等待新增的功能。

## 一、已确认的问题

### 布局覆盖(2026-10-30 用户反馈,优先级最高)

0a.【待修·高】**出装浏览器右侧详情"换出装不更新"**:`citadel_ui_build_selector.xml`
   里的 `<CitadelBuildDetails id="BuildDetails"/>` 是游戏**独立布局文件**(推测为
   `citadel_ui_build_details.xml`),本仓库没有它的覆盖 → 右侧文本不在任何扫描树内,
   换出装后新文本永远不被翻译。修复:反编译该布局 + `node tools/inject_scripts.js`
   生成覆盖(工具已加,见下)。需用户从本机游戏反编译后提供 XML。
0b.【待修·高】**装备悬停提示的作者注释不翻译**:翻译机制本身已验证可用
   (`tests/scene_verify.js` 场景 2 PASS:"Rend > Heal > Repeat."→"撕裂 > 治疗 > 重复。"),
   游戏内不生效的原因可能是:① 游戏更新后 `tooltips/citadel_tooltip_mod_details.xml`
   结构/文件路径变了,覆盖失效;② 被编号更大的其它 pak 压住。诊断:启动项加
   `-condebug`,进游戏后在 `console.log` 搜 `[BBT]`(现在会打印加载它的布局 tag,
   如 `[BBT] v1.0.0 loaded (...) in layout: CitadelTooltipModDetails`),确认哪些布局
   真正带了扫描器;再用 VPKEdit 对比各 pak 的同名文件。
0c.【已修】新增 `tools/inject_scripts.js`:对反编译布局一条命令注入 `<scripts>` 引用
   (幂等、可 `--no-tm` 跳过译文库引用),产物自动落入 `mod/panorama/layout/`,
   `build.ps1` 会随编译。

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
16.【待修】**长文本无兜底**:译文库未收录的 >160 字符描述保持全英文(只有 ≤160 的短句
    做术语替换)。这是离线设计的固有限制,改进方向见 §二-4(未翻译收集器)。
17.【待修】**tooltip 布局依赖宿主加载 TM**:`citadel_tooltip_*.xml` 不引 `bba_tm.js`,
    靠宿主(browser/shop)布局把 `BBA_TM` 挂到 globalThis。若玩家从未打开过承载 TM 的
    布局(例如重启后直接进商店),tooltip 里只有术语兜底。可选改进:tooltip 脚本在
    `BBA_TM` 缺失时一次性懒加载 `bba_tm.vjs_c`(代价是一次 ~4MB 脚本解析),或把 TM
    拆"热/冷"两段(常用热门文本随 tooltip 走,全量随 browser 走)。
18.【待修】**没有运行时开关/配置**:译文显示开关、是否保留"的副本"标记、DEBUG 详细
    日志等都要改源码重新打包。`BBT_STATS`/`BBT_VERSION` 已挂 globalThis,可加一条
    控制台命令或迷你设置面板。
19.【待修】**无 CI**:仓库没有任何自动化检查(两个离线测试一条命令就能跑),
    提交的 `bba_tm.js`/`bba_glossary.js` 是生成物,无法保证与 `tools/` 一致。
    建议 GitHub Actions:push 时跑 `node tests/translate_simtest.js` +
    `node tests/tools_simtest.js`,并校验 `bba_tm.js` 可被 `loadExistingTm()` 解析。
20.【待修】**`layout_dom_simtest` 依赖反编译的游戏布局**(仓库不带),新克隆只能 SKIP。
    建议把测试用到的最小布局子树(fixtures)入仓库,或提供一键反编译脚本。
21.【待修】**`bba_tm.js` 4.2MB 直接入库**:可用 Git LFS 或改为 Release 附件,减轻克隆负担。

### 其它

22.【待修】**README/脚本带 BOM**(`﻿#`):`README.md`、`build.ps1`、`refresh_tm.ps1`
    首字节是 U+FEFF。PowerShell 能容忍,但部分工具链会报警。统一去 BOM。
23.【待修】**`vpkeditcli.exe` 是第三方二进制直接入库**,建议记录其来源版本/哈希
    (VPKEdit 的 commit),便于安全审计与更新。
24.【待修】**`fetch_builds.js` 对第三方 API 无版本兜底**:`deadlock-api.com` 接口变动时
    整条流水线失败且报错信息对普通用户不友好。建议在抓取层做字段校验 + 示例输出。

## 二、待解决 / 等待新增功能(按优先级)

1.【新增·高】**未翻译文本收集器**:游戏内把"未知且非中文"的文本(带哈希 key、所在
   布局 id)写入 `console.log`(或用本地文件若引擎允许),配 `tools/collect_new_texts.js`
   把日志转成待译清单 → 进 Bing → 增量并入 TM。让译文库随玩家实际游玩自动增长,
   解决"冷门/新出装仍是英文"的核心痛点。
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
