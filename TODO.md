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

### resync 游戏内失效 → 换出装后详情/概览冻结(v1.9.6 已修,2026-11-01)

- **现象**:换出装后右侧详情/概览停在旧出装的译文;点「翻译本页」日志连续出现
  `refresh: re-resolved 0 engine label(s)`(实机 console.log 2026-11-01 共 11 次),
  全程无 `resync-ok` / `resync-fail` / `W TM` 行。
- **根因**:v1.9.5 的 resync/token 查找按 `panel.class`(字符串)读 CSS 类,而 Source 2
  面板**没有** `.class` 属性——类在 `panel.classList`(`.contains()` token 列表)上。
  游戏内 `panel.class` 恒 undefined → `roleTokenFor`/`primaryRole`/`tokenFor`(byClass/
  byClassAll)全部落空 → `resyncAll` 处理 0 个标签,identity 跟踪也死;
  描述标签首译后引擎 `{s:var}` 模板即被销毁,永远停在第一条出装的译文。
  离线测试全绿是因为 sim 把 `panel.class` 伪造成了字符串属性。
- **修复**:
  - 新增 `panelHasClass(panel, cls)`:先读 `panel.classList.contains(cls)`(游戏真实
    API),`.class` 字符串只作测试 sim 的回退;`roleTokenFor` / `primaryRole` /
    `tokenFor` / `classOf` / 启动时的 tooltip 判定全部改走它。
  - `resyncLabel` 增加一次性 `localize-probe` 日志(每布局实例一行,不需要
    `-condebug`):打印 `$.Localize(token, panel)` 双参/单参在游戏里真实返回什么,
    下一轮修「引擎重渲染」路径时直接看这行日志定方案。
  - 测试 sim(refresh_verify / fragment_verify / live_channel_simtest /
    ui_button_simtest / scene_verify)改为引擎真形态:只给 `classList.contains`,
    **不再提供 `.class` 字符串**;refresh_verify 增加 "sim parity" 断言,
    谁再引入字符串伪造属性,测试当场变红。
- **验证**:12 个测试全 PASS。需重打包部署 + 重启游戏;换出装后日志应出现
  `resync-ok`(或 `localize-probe`),概览/描述跟随出装;若 `localize-probe`
  两参返回 null/模板,再按日志证据做下一步。

### 类读取真形态是 BHasClass,annotation 参与 resync(v1.9.7,代码完成待游戏验证,2026-11-01)

- **背景**:v1.9.6 部署后实机日志仍 `refresh: re-resolved 0 engine label(s)` x5,
  且 `localize-probe` 一行未出 → `classList.contains` 假设在游戏内同样落空。
  证据(BabelTower 已验证形态 + 本仓库解包脚本):游戏内类读取走引擎绑定
  `panel.BHasClass(name)`(`BabelTower-fork/mod/panorama/scripts/lingua_chat.js:382`,
  `temp_extract/ct_check.js:154`,另有 `BAscendantHasClass` / `SetHasClass`)。
- **修复**:
  - `panelHasClass` 改为三层:`BHasClass`(引擎)→ `classList.contains`(sim)→
    `.class` 字符串(旧 sim);`roleTokenFor` / `primaryRole` / `tokenFor` / `classOf` /
    启动 tooltip 判定全部走它 → B3(概览冻结)根因一次修掉(与 B5b 共用)。
  - refresh_verify 新增行为 Case G(engine-bound 的 CategoryDescription 标签经
    `$.Localize` 刷新)+ SRC/LOCALIZE 分类译文;静态交叉校验(RESYNC_TOKENS 里每个
    `#token` 字面量必须 ∈ 生成物 byClassAll)随 B4 一并落地——防未来任何 typo 的
    token 像「离线 sim 带正确 token 而真机解析不到」那样静默漏过。
- **验证状态**:离线套件全绿(refresh_verify 含 sim parity + Case G)。
- **日志门控(重要)**:v1.9.7 全部新增诊断行(`resync-ok`/`resync-fail`/`localize-probe`/
  `resync-localized`/`resync-defer`/`toolbar-geom`/`toolbar hidden in tooltip context`/
  `click`/`toolbar-place css-fallback`)统一 BBT_DEBUG 门控,默认零输出、无临时日志残留;
  早间要观察日志时,控制台先 `globalThis.BBT_DEBUG = true`(视觉信号——概览/描述跟随
  新出装、工具条隐藏等——不依赖它)。
- **早间 3 分钟步骤 ①**:以 `-condebug` 启动并开 BBT_DEBUG(见上),进出装浏览器换一条出装,
  看日志出 `resync-ok`(成功);失败路径出 `localize-probe`(每个候选一行)/`resync-fail`,
  概览/描述跟随新出装。
  若 `BHasClass` 假设也错,probe 行会直接指出,下一轮只改读类策略不动其他。
- **B4 — 悬停物品注释参与 resync**:`ModifiesLabel` 一个类名声明了两个不同的
  `#token`(`#Citadel_Item_Build_Annotation` / `#Citadel_ItemModifies`,布局按位置二选一),
  是唯一允许「候选列表」的类。`resyncLabel` 按序尝试候选直到 `resolvedText` 通过;
  都失败时**不猜**(错 token 会渲染成另一条注释),退回最近一次文本并记
  `resync-defer`(B4 落实缓存:候选一次性试完即停,复用 `localizeProbed` 门控,不新增
  周期轮询)。
- **早间 3 分钟步骤 ②**(已开 BBT_DEBUG):进出装选择器,悬停物品看「Modifies」描述是否随出装刷新,
  日志出 `resync-localized`(哪个候选命中)或 `resync-defer`(候选清单)。
- **B1 — 点击类打点(永久,`BBT_DEBUG` 门控)**:新增 `clickProbe()`——所有工具栏
  handler(翻译/刷新按钮及菜单项,`onActivate` / `onActivateChild` / `toggleMenu`)触发时
  打 `[BBT] click <名字> on <面板>`,被 `uiGuard` 拦截时打 `…:guard-skip`,菜单打
  `menu->open/close`。默认(`BBT_DEBUG` 未设)零输出,无临时日志残留。
- **早间 3 分钟步骤 ③**:`globalThis.BBT_DEBUG = true` 后点「翻译本页」,应出现
  `[BBT] click translate` 或 `translate:guard-skip`(定位是 handler 没接上还是被守卫拒)。
- **B2 — 下拉/工具栏位置打点(永久,`BBT_DEBUG` 门控)**:工具栏「css-fallback」路径(实测
  尺寸不可得时保留 CSS 定位)加一次性 dump `[BBT] toolbar-place css-fallback
  ctl=WxH root=RW off=... actualx=? actualy=?`(`placeProbeDone` 门控,每实例一行)——
  解释游戏里为什么落不到实测位置;菜单项(`onActivateChild`)与 `toggleMenu`
  同走 `clickProbe`(打 `menu->open/close`)。
- **早间 3 分钟步骤 ④**:点语言下拉,应出现 `[BBT] click menu->open on BBTMenu2`;
  若位置异常,看 `toolbar-place css-fallback` 行的 actualx/actualy 是否全 0。
- **B5 — 详情页/hover 页工具条打点(永久,`BBT_DEBUG` 门控)**:
  - 启动时每个布局一次性打 `[BBT] toolbar-geom vis=? actual=WxH tag=?`(该布局无工具条时
    `toolbar-geom none in this layout`)——回答 B5a(详情页按钮缺失:是根本没有,还是有但被裁/藏)。
  - tooltip 上下文隐藏工具条时打 `[BBT] toolbar hidden in tooltip context (...)`——验证 B5b
    修复生效;隐藏判定改走 `panelHasClass`(B3 的三层读类,旧 `classList`/`.class` 检查
    在游戏内永远落空,工具条会盖在 hover 提示上)。
- **早间 3 分钟步骤 ⑤**:看右侧详情页的 `toolbar-geom` 行与「翻译本页」可点性
  (`click translate`);右键感叹号 hover 页应出 `toolbar hidden in tooltip context` 且无工具条遮挡。

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
6.【已改进】**`build_glossary.js` 依赖本机游戏文件**才能刷新术语表;仓库里冻结的是
   2026-10-29 的 `glossary.json`。`build_tm.js` 现在会打印 `generated_at` 并在超过 45 天时
   警告"术语表过期";README 也写明了刷新命令。仍需本机游戏文件才能重新生成(设计如此)。
7.【已改进】**Bing 免 Key 渠道不稳定**:触发验证码 / 429 后 `build_tm.js` 会重试到 4 次上限
   然后整批放弃(文本留在 pending,不入库)。`translations.json` 是断点缓存,中断后重跑
   会继续;README 已写明该用法。仍建议后续加第二 provider(§二-5)。
8.【已改进】**`tools/cache/` 被 .gitignore 排除**:新克隆第一次生成 TM 需要重抓 + 重译。
   Release 现在附带 `tm-cache-v1.1.0.zip`(builds.json + translations.json,7.3MB),
   解压到 `tools/cache/` 即可增量重建;README 已注明。缓存本体仍不入库(体积考虑)。
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
20.【已缓解】**`layout_dom_simtest` 依赖反编译的游戏布局**(仓库不带),新克隆只能 SKIP;
    但 `scene_verify.js` 已用仓库内提交的覆盖布局验证同一批场景(含右侧详情),
    CI 覆盖不依赖反编译产物。深度 DOM 测试仍可在反编译后本地跑。
21.【待修】**`bba_tm.js` 4.2MB 直接入库**:可用 Git LFS 或改为 Release 附件,减轻克隆负担。

### 其它

22.【已修】**README/脚本带 BOM**(`﻿#`):`README.md`、`build.ps1`、`refresh_tm.ps1`
    首字节是 U+FEFF,已统一去掉。
23.【已改进】**`vpkeditcli.exe` 是第三方二进制直接入库**:README 已记录来源(VPKEdit CLI)
    与 sha256(`DF354E59…5984B582A`),便于审计与替换。
24.【已改进】**`fetch_builds.js` 对第三方 API 无版本兜底**:404 时错误信息会提示
    "deadlock-api changed? see openapi.json",429/5xx 提示"限流或服务错误,稍后重试";
    重试仍覆盖 503/504。

## 二、待解决 / 等待新增功能(按优先级)

1.【已实现·高】**未翻译文本收集器**:游戏内把"未知且非中文"的文本以
   `[BBT] MISS <key> <text>` 写入 `console.log`(每实例去重、上限 300 条);
   `tools/collect_new_texts.js` 读日志 → `tools/cache/extra_texts.json` →
   `build_tm.js` 自动把额外语料一起翻译并累积并入 TM。已接入 README 流程。
2.【已实现·高】**Release 一体化产物**:v1.1.0 发布 `pak13_dir.vpk` +
   `tm-cache-v1.1.0.zip`(builds.json + translations.json 快照),新用户一键安装,
   维护者解压后可直接增量重建译文库,不必重抓/重译。
3.【新增·中】**多语言**:provider 目标语言参数化(`zh-Hans` → `ja`/`ko`/`en`…),
   游戏内按启动语言或手动选择;术语表按语言分目录。
4.【已改进·中】**长文本兜底增强**:>160 字符的未收录文本不做术语替换(避免长句被拆得
   支离破碎),改由未翻译收集器(§二-1)收集后整句机翻补入,质量更好。
5.【新增·中】**第二翻译 provider**(MyMemory / 本地 LLM 脚本等)+ provider 切换参数,
   Bing 全挂时流水线仍可跑。
6.【新增·中】**游戏更新自动检测**:把当前覆盖布局的"结构指纹"(标签/类名集合)写进
   mod,启动时与游戏实际布局比对,不一致就 console 提示"游戏已更新,请反编译刷新布局",
   替代目前"翻译突然失效且无提示"的体验。
7.【新增·低】**设置 UI**:在 browser 布局右上角加一个极小的 BBT 面板(开关、显示
   译文库规模、一键"收集未翻译文本"开关)。
8.【已实现·低】**CI 与质量**:`.github/workflows/tests.yml` 已在 push/PR 时跑三个离线测试
   (Node 24,含 zstd);`bba_tm.js` 仍直接入库(4MB,暂不引入 LFS)。
9.【已实现·低】**build_code.js 增加"出码"功能**:`node tools/build_code.js --json build.json`
   会把(改过文本的)JSON 重新编码成可粘贴的出装码,无损往返。
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

## 四、性能(帧率)排查与修复 —— 2026-10-31

用户反馈"装了 mod 帧率下降"。审查结论:**v1.1.0 完全没有做过性能控制**,而且新加的
"tooltip 各自内嵌译文库"把成本 ×5。已修三处(均有 `node tests/perf_probe.js` 可复测):

1.【已修】**每个面板每 tick 都重算哈希**。旧代码对每个 Label 都做 `flatten()` + 双哈希,
   而游戏 UI 里 85% 以上是中文或 `#token`(注定查不到)。现在:
   - 中文/`#token` 在哈希之前就早退(只有复数副本名 `X 的副本` 仍需查表);
   - 每个面板记 `{上次原文, 写出的译文}`,文本没变就只读一次 `panel.text` 就跳过;
   - 引擎重绘回英文时(值 ≠ 我们写的译文)会重新翻译,不会像旧版 WeakMap 那样卡住英文。
2.【已修】**永久 150ms 全量轮询**。现改为空闲退避:有变化 150ms,连续 6 次无事发生则
   间隔翻倍,最高 1s;出现新面板(换出装、开 tooltip)立刻回到 150ms。
3.【已修】**译文库内存/启动成本 ×5**。58,314 条原本是一个巨大对象字面量
   (实测单上下文 +13.5 MiB、~50ms),而 5 个布局各有一份JS上下文 → ~67 MiB、
   启动多出几百毫秒。新格式(`tools/tm_format.js`)是一条按 key 排序的扁平记录串 +
   `Int32Array` 偏移表 + 二分查找,运行时 API 变成 `BBA_TM_GET(key)`:
   **单上下文 +4.2 MiB / ~17ms,5 个布局合计 ~21 MiB / ~85ms**(旧 ~67 MiB)。
   `build_tm.js` 直接产出新格式,`tools/tm_format.js` 也可把旧文件就地转换(已验证 58314 条全等)。
4.【已修】**每个面板每 tick 读两次 `panel.text`**。scan 读一次、translatePanel 再读一次;
   现在把读到的值传进去,绑定跨越次数减半(游戏内这才是主要成本)。

仍待观察 / 后续:
- 5 个布局各持一份译文库仍是 ~21 MiB。彻底解法是"热/冷拆分"(tooltip 只带
  annotation/name/description 的热库),需要重跑一次流水线才能产出,列入二-3 之外的新项:
  【新增·中】**热/冷译文库拆分**。
- 游戏内实测数据仍缺:启动项加 `-condebug` 后 `console.log` 里 `[BBT] v1.2.0 loaded (...)`、
  以及 `BBT_STATS`(含 `ms` 单 tick 耗时、`interval` 当前轮询间隔)可用控制台读取。

### 四-补:v1.9.7 静态热路径审查 + 计时打点方案(2026-11-01,夜间,实测数字待早间)

**静态结论(读码,未改任何热路径代码)**:
- v1.9.7 相对 v1.9.6 **不新增任何 per-tick 成本**:`panelHasClass` 多出的
  `BHasClass` 尝试只在事件路径触发——`roleTokenFor`(仅 `resyncAll(40)` 在
  identity/content 变化时跑,40 标签 × 5 类 = 每刷新 ≤200 次 C++ 调用)、
  `tokenFor`(一次性:`tokenOf` WeakMap 缓存 + memo `known` 门控,每面板实例只跑一次
  26 类探测)、启动判定、probe(一次性 + debugOn 门控)。空闲 tick 不碰类探测。
- 现状每 tick 主要成本(既有,未动):`scan` 预算 6000,每面板 =
  `IsValid`(C++) + `memo.has`(WeakMap) + `.text` 读(C++) + `GetChild`/
  `panelVisible`→`BIsVisible`(C++);空闲退避 150ms→×2 封顶 1s;布局不可见时 parked
  0.5s 只走 `GetContextPanel` + 一次 `panelVisible`,不树走。
- 「不用时零开销」的精确表述:关闭商店/浏览器后每个布局 JS 上下文仍每 0.5s 做一次
  `GetContextPanel`+`panelVisible`(6 上下文 ≈ 12 次 C++ 调用/s,亚毫秒级,无 DOM 走),
  严格说非 0 但可忽略;实测以早间数字定论。

**早间计时打点方案(不改码,只用现有 `BBT_STATS`)**:
1. `-condebug` 启动,进商城/出装浏览器,等 10s 空闲 → 控制台读 `BBT_STATS`:
   记录 `ms`(单 tick 墙钟)与 `interval`(应≈1s)。
2. 连续换 3 条出装 + 逐个悬停 3 件物品 → 读 `ms`/`scanned`/`skipped`:
   burst 期(0.08s×4)的 `ms` 峰值 vs 空闲期 `ms` 基线,差值即使用期成本。
3. `scanned` 对比 VPK 移除重启后的同场景:mod 不在场时没有 `[BBT]` 行,用
   游戏自带表现(同场景、同操作序列)对比帧率感知 + 记录 `scanned` 峰值
   (预期 ≤6000/tick,预算封顶)。
4. 判定阈值:空闲 tick `ms` < 2ms 且使用期 burst tick `ms` < 10ms → 达标;
   超标则先查 `scanned`(是否预算爆 6000)与 `skipped`(隐藏子树门控是否生效)。

## 五、“翻译不刷新 / 一直是同一个翻译” —— 2026-10-31 定位与修复

**症状**:换一条出装后,右侧详情(或悬停装备提示)仍显示上一条出装的译文,永远不更新。

**两种更新机制**(Panorama 里 Label 的文本可以来自两个地方):
- A. 游戏 JS 直接赋值 `label.text = 英文`。这种情况旧版就是对的:文本变了就会重查重写。
- B. 布局里写 `text="#Token"`,而该 token 的本地化值是 `{s:var}` 模板,游戏用
  `SetDialogVariable` 灌值。**我们的 `panel.text = 译文` 会把模板整个冲掉**,此后
  `SetDialogVariable` 仍有值但无处渲染 → 标签永远停在第一次写入的译文上。
  本仓库的覆盖布局里正是这种写法:
  `.BuildName` → `#Citadel_HeroBuilds_BuildName`、
  `.BuildDescription` → `#Citadel_HeroBuilds_BuildDescription`、
  `.ModifiesLabel` → `#Citadel_Item_Build_Annotation`(悬停里的作者注释)。

**修复**:
1.【已修】`tools/build_layout_tokens.js` 从覆盖布局生成 `bba_layout_tokens.js`
   (class/id → 声明的 `text`),5 个布局都 include 它。`--check` 模式供 CI/测试校验同步。
2.【已修】`bba_translate.js` 新增"回绑"逻辑:监控**不翻译**的身份标签
   (`.BuildID` / `.Version` / `.LastUpdated` / `.ModName`);一旦发现它们变化(说明换了出装/装备),
   把所有"仍显示我们上次译文"的标签恢复成它的 `#Token` → 引擎存的变量值立刻重新解析出
   新英文 → 下一 tick 正常翻译。只对"确实是引擎驱动"的标签动手,不会影响 A 类标签。
3.【已修】新增 `tests/refresh_verify.js`:7 个 A 类场景 + 6 个 B 类场景(含"引擎更新被吞掉"
   的建模),旧逻辑在 B 类全挂,新逻辑全过。
4.【已修】调试开关:`BBT_DEBUG` 不再是编译期常量,控制台 `BBT_DEBUG = true` 即可看到每次写入
   (`[BBT] W TM .BuildDescription "英文" => "中文" tok=#Token`)与 `[BBT] rebind N label(s)`;
   `BBT_STATS` 里新增 `writes` / `rebinds` 计数。

**若游戏内仍不刷新**,用 `-condebug` 后看三条信号即可定位:
- 切换出装时**完全没有** `[BBT] W ...` → 引擎没往我们能读的地方写(布局结构变了);
- 有 `[BBT] W ...` 但 `rebinds` 不涨 → 身份标签没被识别(把该布局里 build id/版本标签的
  class 加进 `IDENTITY_TOKEN` 或补进 layout tokens 表);
- 有 `rebind` 但文本仍是旧译文 → 该布局的 token 与变量名不匹配(`build_layout_tokens.js` 重新生成)。

### 五-补:悬停提示(装备 tooltip)的同一问题

用户反馈"悬停只翻了物品名,作者写的出装描述不更新"——与右侧详情同因:
`tooltips/citadel_tooltip_mod_details.xml` 里
`<Label class="ModifiesLabel" text="#Citadel_Item_Build_Annotation" />` 是变量绑定标签;
物品名是 `{s:mod_name}`(游戏本地化,本来就是中文,所以"只翻了物品名")。
tooltip 面板会被反复复用,所以第一次写入译文后,后续每次悬停引擎的
`SetDialogVariable` 都被吞掉 → 作者注释永远停在第一条。

修复(已在 v1.2.1 之上补齐,`tests/refresh_verify.js` 场景 C 覆盖):
- tooltip 里的 `.ModName` / `.componentModName`(`{s:mod_name}` 等)作为身份信号:
  它们随悬停物品变化 → 触发回绑 → 作者注释重新解析出新英文 → 再翻译。
- 若某个布局**一个身份标签都没有**,退化为"任何未翻译标签的文本变化"也算信号
  (`contentChanged`),但排除会自己走的标签(`TICKING_TOKEN`:
  `_Time`/`LastUpdated`/`Timer`/`Cooldown`/`Level` 等),并加 3 tick 冷却,
  防止面板每 tick 反复重译(场景 D 验证:相对时间标签跳动不会引发重写风暴)。
- 已知小瑕疵:`.ModifiesLabel` 这个 class 在 tooltip 里被复用两次
  (`#Citadel_Item_Build_Annotation` 与 `#Citadel_ItemModifies`),生成的对照表按
  "文档顺序第一个"取值;第二个标签我们基本不会写(不在译文库里),影响可忽略。
  若将来出问题,给布局加 `id` 后用 byId 精确匹配即可。

### 五-补二:悬停延迟与"整页预翻译"的取舍(2026-10-31)

用户提出:"每次悬停才翻译是不是太慢?能不能点开一条出装时就把整页物品注释都翻好?"

结论与做法:
1. **"每次悬停翻译"其实不是翻译,是查表**:一次 `flatten` + 双 32 位哈希 + 48 万字符记录串上的
   二分查找,实测 60 个面板的 tooltip 一次处理 **~0.1 ms** 纯 JS;真正的翻译(Bing)是离线一次性
   做的。所以重复悬停的代价可以忽略。
2. **页面上"看得见"的注释本来就是打开页面就整批翻好的**:出装详情页会把分类名/描述和每件装备的
   annotation 直接渲染在 DOM 里(`CitadelShopModsBuild` 区域),扫描器在页面打开的第一轮就处理完
   (`scene_verify` 场景 3 覆盖)。**tooltip 内容只有在悬停时才被创建/填充**,不存在"提前翻译"的对象。
3. **真正被抱怨的应该是延迟**,已优化:
   - 回绑 + 读新英文 + 翻译**在同一个 tick 内完成**(不再多等一轮轮询),测试断言"same tick";
   - 出现新面板(刚打开的 tooltip、刚渲染的页面)后进入 **0.08s 快速轮询 burst(4 次)**,
     之后回落到 0.15s,空闲再退避到 1s;
   - 检测到换出装/换物品时立即把轮询从退避状态拉回快档。
   即:悬停后最多 ~80–150ms 出中文,无英文闪烁、无二次刷新。
4. 若将来真要"预翻译",前提是能拿到出装数据(每件装备的 annotation 文本)。当前纯 UI 方案读不到
   数据层,只能读到已渲染的 DOM;`/v1/builds` 里虽然有数据,但游戏内不能直接发 HTTP 请 求
   (见下方"实时通道"一节的 HTML 面板方案)。可选的离线近似做法:把"出装 ID → 每件装备 annotation"写进译文库附带的
   索引,打开页面时按当前出装 ID 预热——需要额外解析 build id 标签,收益有限(查表本来就只有 0.1ms),
   列入"可选"。

### 五-补三:翻译在什么时机发生、会不会掉帧(2026-10-31 复盘)

**离线 vs 在线,界线很清楚**
- **离线(打包前,PC 上跑一次)**:`fetch_builds.js` 抓各英雄热门出装 → `build_tm.js` 提取所有
  玩家文本 → Bing 机翻 + 官方术语保护 → 生成 `bba_tm.js` 打进 VPK。**全部英雄共用一个译文库**
  (当前 58,314 条),所以游戏里换英雄/换出装**不会触发任何翻译**,只是查表。
- **在线(游戏内)**:只有"规范化 + 哈希 + 二分查找 + 写回"四个动作,单次约 1µs 级;
  60 面板的 tooltip 整棵树一遍 ≈ 0.1ms。

**本轮为"别掉帧"新增的两条**(都不改变功能):
1.【已修】**跳过不可见子树**:折叠分类、未打开页签、滚出视野的内容都不读。
   合成测试:60 可见 + 2000 隐藏面板 → 每 tick 只读 61 个面板(`stats.skipped` 会累计跳过的子树数)。
2.【已修】**布局整体不可见就停摆**:商城关着 / 不在出装浏览器时,扫描间隔退到 **2s**
   (`stats.hidden` 计数),重新可见后立刻恢复。也就是说**对局中(商城关着)这个 mod 基本不花 CPU**。

**"只用看当前选中的出装"**——已经天然满足:
- 页面里只有被渲染出来的内容才会被扫到;选中某条出装后,别的出装只有列表里的**名字**(短文本,
  一次查表 + memo 命中后每 tick 只读一次);
- 其它英雄的出装列表、折叠的装备区都在不可见子树里,直接跳过;
- 详情/悬停这类"作者描述"只在它可见时才翻译。

### 五-补四:数据新鲜度("出装更新了要重打包吗?")

**结论:数据源和游戏是同一份,但译文库是快照,新文本必须重新生成 + 重打 VPK。**
已做三件事把"必须重打包"的频率压到最低:

1.【已修】**抓取补齐"最近更新"维度**:`fetch_builds.js` 新增 `--recent`(sort_by=updated_at,
   默认最近 45 天,`min_unix_timestamp` 过滤)和 `--lang`(默认 English)。
   之前只抓 weekly/all-time 收藏榜,新出装没有收藏数 → 永远抓不到,这是"新出装全英文"的
   结构性原因。`refresh_tm.ps1` 已透传 `-Recent/-Author/-Lang`。
   (API 侧已实测:`sort_by=updated_at&build_language=English` 能返回当天更新的出装。)
2.【已修】**游戏内整句兜底**:新出装若整段没收录,按句/分隔符切开逐句查表,
   覆盖率 ≥55% 时输出"中文 + 保留英文"的混合结果(`tests/fragment_verify.js`,4 组场景)。
   这样即使不重打包,常见句式也能立刻变中文,而不是整段英文。
3.【已修】**刷新流程一键化**:`scripts/refresh_tm.ps1 -Author <SteamID> -Build -Csdk12Root <CSDK>`
   = 抓数据 + 翻新文本 + 重打 VPK;译文库累积合并,重跑不丢历史。

仍存在、需要接受的限制:
- 【已修正】"游戏内不能联网"是错的:`.AsyncWebRequest` 没了,但 `<HTML>` 面板的浏览器仍可访问
  网络(需要 HTTPS + 被信任的本机证书)。已实现**可选实时通道**(`tools/bridge/bridge.js` +
  `scripts/gen_bridge_cert.ps1` + 隐藏 `<HTML id="BBTBridgePanel">`),覆盖译文库之外的新文本;
  未安装时自动退回纯离线。
- 覆盖范围取决于抓取配额与榜单:deadlock-api 限流 IP 200 req/min;按每英雄 4 个任务算,
  全英雄一轮约 100~130 个请求,属于安全范围。
- 中文出装(`build_language=ChineseSimplified`)本身不需要翻译,默认不抓;若想覆盖
  中→中(仅为了排版)无意义,故不处理。

### 六、实时通道(2026-10-31,推翻"游戏内不能联网"的旧结论)

先前文档里写的"Panorama 删了 `AsyncWebRequest` 所以不可能实时翻译"是**错的**。
参考用户自己的 BabelTower(DeadlockLingua)实现:`<HTML>` 面板里的 WebKit 仍能联网,
只要页面是 HTTPS 且证书链通过校验(自签 + 装进 `CurrentUser\Root`)。

已实现(全部离线可测):
1.【已加】`scripts/gen_bridge_cert.ps1`:CN=BBT-localhost,SAN 含 `DNS:localhost` +
   `IP:127.0.0.1` + `IP:::1`,EKU=serverAuth;`-Trust` 用 certutil 装入 CurrentUser\Root,
   `-Untrust` 移除;改完必须**完全重启 Steam**。
2.【已加】`tools/bridge/bridge.js`:127.0.0.1:8793 上做 TLS 终结,只暴露
   `/bridge`(返回页面)、`/api/v1/health`、`/api/v1/translate`;翻译复用现有免 Key Bing
   provider;带 LRU 缓存;其他路径一律 404(不是通用代理);证书缺失时以退出码 3 提示怎么办。
3.【已加】`mod/panorama/layout/*.xml`:两个长生命周期布局里声明隐藏
   `<HTML id="BBTBridgePanel">`(必须在 XML 里声明,运行时 CreatePanel 拿不到真 HTML 面板),
   样式 1px + opacity 0.01(不能 display:none,否则页面不加载)。
4.【已加】`bba_translate.js`:启动 1.2s 后探活;`live` 通道单请求串行,结果回写
   `document.title`;会话内缓存;连续 3 次硬失败关闭本会话;优先级
   **离线库 → 整句兜底 → 实时 → 术语替换**;离线阶段只做了术语替换的文本会在连上后自动重翻
   (`liveUpgradeWeakWrites`,用 memo 里的原文,不用被术语替换过的混合串)。
5.【已加】`tests/live_channel_simtest.js`:11 项断言,覆盖"桥可用时翻译新文本""桥死了不刷屏"
   "离线命中不发请求""同文本走会话缓存"。

待办:
- 【新增·低】bridge 做成托盘/静默启动(现在需要手动 `node tools\bridge\bridge.js`);
  可参考 BabelTower 的 `StartBridgeSilent.vbs` + `install-autostart.bat`。
- 【新增·低】实时结果落盘(`tools/cache/live_seen.json`)→ 下次 `build_tm.js` 直接并入译文库,
  让"玩家实际看到的文本"逐步沉淀成离线数据。
- 【新增·中】批量请求:当前一次一条(单 document.title 通道);可按"一屏内所有未知文本"
  打包成数组(接口已支持 `text: []`),把 N 个 RTT 压成 1 个。

### 六-补:证书复用 + 静默自启 + 实时结果落盘(2026-10-31,已完成)

1.【已做】**优先复用 BabelTower 的通道**:`bba_translate.js` 启动后先探
   `https://localhost:8792`(DeadlockLingua 的桥),探通就直接用它翻译——**不需要第二张证书、
   也不需要第二个进程**;不通再探自己的 8793,仍不通则永久离线。请求体用 BabelTower 的
   `{operation,text,targetLanguage}` 形状(我们自己的 bridge 页也兼容这个形状),标题前缀
   同时认 `LCT<id>` 与 `BBT<id>`,响应兼容 `{translation}` 与 `{translations:[..]}` 两种。
2.【已做】**证书自动发现**:`tools/bridge/bridge.js` 依次尝试
   `--pfx` → `config/certs/bbt.pfx` → `BBT_CERT_PFX` → 同级目录/`%LOCALAPPDATA%` 下的
   `DeadlockLingua|BabelTower/config/certs/bridge.pfx`,找到哪个用哪个并打印路径。
   `scripts/gen_bridge_cert.ps1` 在发现"已有受信任的 BabelTower-localhost 证书"时直接跳过生成。
3.【已做】**静默自启**:`scripts/start_bridge_silent.vbs`(无窗口,日志写 `logs/bridge.log`)
   + `scripts/install_bridge_autostart.bat` / `remove_bridge_autostart.bat`
   (HKCU\...\Run,无需管理员)。
4.【已做】**实时结果落盘**:bridge 把每条翻译写入 `tools/cache/live_seen.json`,并同步进
   `tools/cache/translations.json` 缓存;`build_tm.js` 新增 `loadLiveSeen()`,把这些
   "玩家实际看到过的文本"直接并入译文库(不重复机翻)。退出/Ctrl+C 时会 flush。
5.【已做】测试:`tests/live_channel_simtest.js` 扩到 14 项(优先 8792、回落 8793、
   两种响应形状、缓存、桥死不掉）,其余 5 个测试全绿。
6.【已做】修一个连带 bug:离线"查不到"也会被 memo 记住,导致桥连上后那些面板永不重试;
   现在桥可用时会把 miss 记忆清掉重新扫。

### 六-补二:与 DeadlockLingua 桥的关系(与"复用它的设置")

- **是**它的桥、**是**它的设置。请求体不带 `provider`,lingua 侧 `runTranslate` 走
  `payload.provider || cfg.provider`,于是服务商、API Key、回退链、词典、缓存、目标语言默认值
  全部沿用它的配置;我们只显式指定 `targetLanguage=zh-Hans`(本 mod 只有中文库)。
- 连接后 `[BBT] live bridge: connected to <name> (localhost:8792, provider=<id>)` 会打印实际服务商,
  `BBT_STATS.liveProvider` 可读;`BBT_LIVE = "off"` 可运行时关闭(不改包)。
- 【待观察】如果 lingua 配的是付费 provider(OpenAI/DeepL),实时通道会消耗那份额度;
  文档已提示,后续可考虑"只在免 Key provider 下默认开启"(需要 lingua 在 health 里给出
  是否付费的信息,已在 health 里返回 `provider`,可以据此判断)。

## 七、自动扩充翻译库 + 工具条按钮(2026-10-31,v1.5.0)

### 已完成

1.【已加】`tools/tm_table.js` — 本地"会长大的"翻译库:
   - 三级键:exact(规范化双哈希)→ template(数字掩码 `«n»`,查表回填)→ shingle(64 位 SimHash,
     16 位分桶,汉明距离 ≤3 视为同句式);
   - 五道容量闸:准入节流(≥2 次/短句/按钮显式)、别名折叠(每条最多 8 个)、译文去重、
     预算淘汰(15 万条 / 32MB,按用量×新鲜度×长度打分,批量淘汰 5%)、占位符校验(数字个数不符
     则禁用模板/近似匹配);
   - append-only 日志(`add`/`alias`/`upd`/`del`),命中计数只在内存累计、压缩时落盘,
     所以文件增长跟着内容而非访问量;原子写(temp+rename);`flush()` 在退出时压缩。
   - 29 项离线测试(`tests/tm_table_simtest.js`):掩码往返、SimHash 距离、精确去重、模板折叠、
     近似折叠、准入节流、条目上限触发淘汰、重启后索引重建、占位符不一致禁用模板。
2.【已加】bridge 三个接口:`/api/v1/tm/stats`、`/api/v1/tm/lookup`(纯查表)、
   `/api/v1/tm/translate`(查表 + 翻缺失 + 写库)。页面支持 `?p=` 白名单选择端点,
   且拒绝任意路径(不能当通用代理)。
3.【已加】界面工具条(`citadel_ui_build_selector.xml` 头部右侧):
   `翻译本页` 按钮 + `▾` 下拉(显示中文 / 显示原文 / 中英对照 / 把新译文存入本地库 / 查看统计)。
   语言模式存进 `$.PersistentStorage`,重启保留;切换时先把界面还原成原文再按新模式重绘。
4.【已加】批量策略:本仓库 bridge 一次 8 条打包成 1 个往返;DeadlockLingua 的桥只收单条,
   自动退化为逐条(并把剩余文本重新排队)。
5.【已加】`tests/ui_button_simtest.js`(16 项):按钮发起请求、批量 vs 逐条、
   三种语言模式、模式持久化、下拉开关、无桥时按钮提示。
6.【已加】CI 跑全部 8 个测试 + `build_layout_tokens.js --check`。

### 还没做 / 需要你决定的

- 【待定】**本地库要不要反向"发布"**:现在本地库只在本机长大。若要给别人,可能做法是
  `node tools/tm_export.js` 导出增量包(只含 `live` 来源的新条目),下次 Release 附上;
  需要注意隐私(出装作者原文会进入导出包,但本来就是公开数据)。
- 【待定】**语言切换的目标语言**:目前只有 zh-Hans(译文库只有中文)。若要多语言,
  本地库需要按 `lg` 字段分表(namespace),否则同一文本的中/日译文会互相覆盖。
- 【待定】**SimHash 阈值**:默认 3(64 位)。实测 8 个字的短句容易误合并,后续可按长度自适应
  (短句严格,长句放宽)。
- 【待定】**别名上限 8** 是猜的;可以用"同一模板下变体分布的 95 分位"自适应。
- 【待定】**按钮节流**:连点会排队(现在 busy 标志挡住重入),但大批量页面(几十条未翻译)
  会分成多个往返;可加进度条而不是单一"翻译中…N"。
- 【待定】**本地库与离线库的优先级**:目前离线库优先(打包的译文更"官方")。如果你更想
  让"你点过按钮的译文"覆盖离线库,需要加 `source:button` 的覆盖规则。

## 八、多语言 · 增量包 · 覆盖优先级(2026-10-31,v1.6.0,按你的决定实现)

你的五个决定都已落地:

1.【已做】**增量包导出**(公开数据):`tools/tm_export.js` 导出 bridge 产生的译文
   (`source: auto/live/button`),流水线来源默认不导出;包内带 `schema/generatedAt/count/languages/sha` 信息。
   `tools/packs/*.json` 会被 `build_tm.js` 自动合并(`loadPacks()`),贡献者不用起 bridge 也能贡献译文。
   注意:包只用于**公开数据**(deadlock-api 出装文本 / 游戏内实际显示文本)。
2.【已做】**多语言**:本地库按 `lg` 分表(reocrd key = `lg|hash`),模板/近似索引也带语言前缀,
   同一句话可以同时有简体/繁體/日/韩/英译文互不覆盖;菜单加"目标语言"选择,存 `$.PersistentStorage`。
   打包的离线库仍是简体中文单语;其它语言由本地库 + 实时通道提供。
3.【已做】**SimHash 阈值自适应**:按 token 数分档 —— ≤6 → 2,≤14 → 3,≤30 → 4,>30 → 5
   (`distanceFor()`)。短句("gg"/"push mid")不会误合并,长句允许一词之差。
4.【已做】**别名上限自适应**:`4 + floor(使用次数/10)`,夹在 [4,16](`aliasCapFor()`);
   常用模板允许更多变体,冷门模板保持紧凑。
5.【已做】**本地库优先于离线库**:桥连上后拉取 `/api/v1/tm/overrides` ——
   只返回"本地库与 VPK 译文不同"的条目(避免整库传输),mod 用它们覆盖离线库;
   另外**自动存库**:游戏里出现、本地库没有的文本,桥翻完立即入库(`source: auto`),
   不需要点按钮;按钮只用于"立刻补齐整页"。

顺带修的两个真 bug:
- `liveSend` 允许并发发送时会互相**覆盖** `live.pending`,导致前一个请求的回包被丢弃
  (表现为"桥连上了但界面还是英文");现在同一时刻只允许一个请求,`busy` 时排队/延后重试。
- memo 记为"查不到"的面板,在缓存/覆盖后来后**不会再试**;现在会先检查会话缓存与覆盖表,
  桥在线且没问过就重新发起。

测试:新增 12 项(tm_table: 语言共存/不跨语言折叠/自适应阈值/导出过滤;ui_button: 覆盖生效/
未被覆盖仍走桥/语言持久化)。CI 现在跑 8 个套件 + 导出工具冒烟。

已知限制(仍需你决定):
- 多语言的**质量**依赖 bridge 的 provider;离线库只有中文,所以选日文时未连桥会显示英文原文。
- 增量包不合并"别名"结构(`exportRows` 只导出 `text/translation`),导入后别名需要重新学习。
- 覆盖表最多 500 条(`overridesFor` 有上限),超过时优先最早的条目;若你的本地库修正很多,
  建议定期用 `tm_export.js` 把它们并进离线库,再打一次包。

## 九、Bug 复查(2026-10-31,v1.6.1)

本轮把整条链路从头读了一遍,修掉 10 个真问题(全部有测试或已实测):

| # | 问题 | 影响 | 修法 |
|---|---|---|---|
| 1 | `splitFragments` **丢弃分隔符**(`>`、`|`、空格) | 整句兜底会把 "Rend > Heal > Repeat." 变成 "RendHealRepeat." | 分隔符保留在分段里,拼回后与原文等长;新增 3 条断言 |
| 2 | 实时/术语兜底的写入**忽略显示模式** | "中英对照"模式下只有离线命中会对照,实时/术语结果只显示译文 | 所有写入统一走 `present()` |
| 3 | `bridge.offlineMemory()` **跨语言缓存互相覆盖** | 先请求 ja 会让 zh-Hans 的离线库变成空表 → 覆盖表把整库当"冲突" | 只缓存 zh-Hans 一份,其它语言直接返回空表 |
| 4 | 自动存库也走 `explicit:true` | 一次性长句全部入库,绕过准入节流 → 库线性膨胀 | 桥的自动路径改 `explicit:false`,按钮/接口仍为显式 |
| 5 | `live_seen.json` **无上限** | 长期游玩会无限增长 | 上限 2 万行,超出丢最旧(内容已在表格里) |
| 6 | 同一模板但**译文不同**被折叠丢弃 | "Deal +20% damage" 与 "Deal +20% armor" 只留一个译文 | 仅同义才折叠,否则新建条目(模板索引指向最新) |
| 7 | 两处 `arg("--log"/"--out")` **双重前缀** | `collect_new_texts.js --log`、`inject_scripts.js --out` 一直无效 | 改为 `arg("log")`/`arg("out")`,并统一所有工具的 flag 语义 |
| 8 | 详情布局与选择器布局**同一 id** `BBTBridgePanel` | 详情被嵌进选择器时同一棵树里有两个同名 id,引擎按 id 查找会错乱 | 详情布局改 `BBTBridgePanelDetails`,脚本同时认两个 id |
| 9 | 回绑**误判运行时创建的 Label** | 若某 Label 的 class 恰好在 token 表里但不是引擎驱动,回绑会写入 `#Token` 并停留 | 新增 `rebindCheck()`:写入 token 后下一帧仍未解析 → 判定非引擎驱动,还原文本并加入黑名单 |
| 10 | 覆盖表**只在连接时拉一次** | 之后新增的修正永远不会覆盖离线库 | 桥在每次响应里回传表格条数;条数变化时自动重拉(并比较内容,无变化不重置 memo) |

顺带:
- `PARKED_INTERVAL` 2s → 0.5s(hover tooltip 首次出现不再最多等 2 秒)。
- 批量请求按**字符总量**(2500)分块,不再只按条数,避免长文本把 `document.title` 撑爆。
- `LIVE_TEXT_MAX` 400 → 700(长描述也能实时翻)。
- 「把新译文存入本地库」改为调用 `/api/v1/tm/remember`(纯写库、**不联网**),并能在对照模式下正确截取译文部分。
- 新增结构检查:`scene_verify` 现在校验 5 个覆盖布局的标签配平与 **id 唯一性**。
- 工具条按钮/菜单在文件里首次出现前不会崩(所有 handler 都做 null 检查)。

## 十、用户反馈修复(2026-10-31,v1.7.0)

用户反馈四条:**概述里的描述没翻译 / 翻译按钮无效 / 无法下拉 / 点进出装后翻译一直覆盖**。
定位到两个根因 + 一个覆盖缺口:

### 根因 1:写 `.text` 会摧毁 `{s:var}` 模板(→"一直覆盖")

之前靠"回绑"补救:把 `#Token` 写回去让引擎重新解析。一旦某标签的 class 有**两个候选 token**
(例如 `ModifiesLabel` 同时被 `#Citadel_Item_Build_Annotation` 与 `#Citadel_ItemModifies` 使用),
回绑会写错 token → 标签卡在 `#Token` → 扫描又把 token 当"内容变化" → 再次回绑 → **死循环**,
表现就是"翻译一直覆盖,没法正常翻译"。

修法(彻底,不再依赖回绑):
- 用 `$.Localize(token)` 取出本地化模板,解析出 `{s:varName}`,再用
  **`panel.SetDialogVariable(varName, 译文)`** 写入。模板保留、绑定保留,换出装/换装备时引擎
  照旧更新,我们下一帧翻译新英文即可。写入后**回读校验**,不生效才退回写 `.text`。
- `tools/build_layout_tokens.js` 现在同时产出 `byClass`(唯一声明)和 `byClassAll`(全部候选);
  歧义 class 不再用于回绑(只用于挑 dialog variable),运行时还能用 `$.Localize` 的值比对候选。
- 回绑退化为"极少数标签"的安全网(仅 id/唯一 class/亲见过的 token),并加 `rebindCheck()`
  自愈:写完 token 下一帧仍未解析 → 判定非引擎驱动 → 还原并拉黑。

### 根因 2:按钮/下拉依赖全局函数名解析(→"按钮无效/无法下拉")

`onactivate="BBTTranslatePage()"` 需要引擎在布局的全局作用域里找到该函数,IIFE 包装 + 严格模式
下很容易失效且**静默**。修法:
- 启动后用 **`panel.SetPanelEvent("onactivate", 回调)`** 直接绑定(`wireToolbar()`,带重试),
  不依赖名字解析;XML 里的 `onactivate` 保留为后备,`uiGuard()` 防重复触发。
- 所有按钮内 `<Label>` 加 `hittest="false"`,控件面板加 `hittest="true"`(Label 吞点击会
  导致 onactivate 不触发)。
- 首次绑定成功会打印 `[BBT] toolbar wired: N control(s)`,便于你自己确认。
- `globalThis` 兼容:某些引擎没有 `globalThis` 且**引用未声明标识符会抛错**,改用
  `Function("return this")()` 兜底(tm_format.js / layout_tokens 生成器同步修)。

### 覆盖缺口:概述页是另一个布局文件

"概述"里的描述不在已覆盖的 5 个布局里,大概率是独立布局(如 `citadel_ui_build_details_*`)。
`tools/get_layouts.ps1` 现在支持**通配符**,一条命令覆盖一整类:

```powershell
powershell -ExecutionPolicy Bypass -File tools\get_layouts.ps1 -S2VDir "<S2V导出目录>" -Names "*build*" -NoTm
```

然后把新生成的覆盖布局名加进 `scripts/build.ps1` 的 `$required` 列表(或直接让我加)。

### 测试
- `refresh_verify` 新增 Case F(真实 `SetDialogVariable` 行为):译文写入后**模板仍绑定**、
  连换两次出装都能跟着变、`rebinds === 0`;Case C 改为真实绑定,验证悬停复用面板。
- `scene_verify` 新增布局配平 + id 唯一性检查。

## 十一、通过 mod 逆向发现(2026-10-31,无游戏本体也能推进的部分)

在 GameBanana 上扫描 Deadlock 的 UI/翻译类 mod(Game ID 20948),用自研的 VPK 解析器
(`tools/vpk_list.js`) + Source2Viewer-CLI 20.1(Linux 版,`DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`
即可在 WSL 运行)得出结论:

1.【已确认】**还有一个布局没被覆盖**:`panorama/layout/citadel_shop_mods_build_category.vxml_c`。
   它的结构里明确有 `CategoryName` / `CategoryDescription` 两个标签(本地化 token
   `#Citadel_HeroBuilds_CategoryName` / `#Citadel_HeroBuilds_CategoryDescription`),
   正是"概述/分类说明"区域。结论:**这是"概述里的描述没翻译"的直接原因之一**。
   需要反编译这一份布局后注入脚本(与我们已有 5 个一样处理)。
2.【已确认】翻译类 mod(如 *Traditional Chinese Full Translation*)只发
   `resource/localization/citadel_*/citadel_*_english.txt`(键 + 译文),**不含布局**;
   Babel Tower 只发 `panorama/layout/chat.vxml_c`、`hudchat.vxml_c`。
   所以"不装游戏、靠 mod 拿布局"只能拿到**被某个 mod 改过的**那一份,拿不到原生布局。
3.【已做】新增 `tools/vpk_list.js`:列 VPK 内容 + **扫描 addons 冲突**(同文件多 pak 时谁赢),
   这是"某处永远英文"的第一排查手段(其它 mod 用更小编号压住我们)。
4.【已做】`tests/vpk_list_simtest.js`:内存构造 VPK 后回读,验证解析与 pak 编号优先级。
5.【待办】拿到 `game/citadel/pak01_dir.vpk`(约 150MB,DepotDownloader `-filelist` 只取这一个文件,
   或找有游戏的人直接发这个文件)后,可以一次性枚举所有布局 + 真实本地化,把覆盖率补全。

## 十二、【已修】概述/分类描述不翻译 —— 补上第 6 个布局(2026-10-31)

用户提示"有些 mod 里带着 pak01"之后,我顺着 mod 的 VPK 内容找,确认了缺口并**当场补上**:

- 缺失布局:`panorama/layout/citadel_shop_mods_build_category`(分类名 +
  `#Citadel_HeroBuilds_CategoryDescription` 作者写的分类说明 = 概述区的文字);
- 来源:我从 GameBanana 上一个公开 mod(*Shop Category Overflow Fix*)发布的 VPK 里解出该布局,
  **删掉它自己的 `shop_overflow_fix.vcss_c` 引用**后剩下的就是 Valve 原生布局(它只是 Valve
  文件的副本 + 一行自己的样式),然后注入 BBT 的 `<scripts>`;
- 已有:加入 `mod/panorama/layout/`、`scripts/build.ps1` 必需清单、`bba_layout_tokens.js`
  (新增 `CategoryName` / `CategoryDescription` → `#Citadel_HeroBuilds_Category*`)、
  `tests/scene_verify.js` 新增场景 4(分类名 + 分类描述必须出中文)。
- 局限:这份 XML 来自第三方 mod 的副本,可能落后于最新补丁;拿到游戏本体后应改用
  `tools/get_layouts.ps1` 从原生 pak 重新生成一次(原件注释里也写明了)。

另外:再往上爬 GameBanana 时被 403 限流,批量扫描不可行 —— 所以"靠 mod 找布局"只能逐个来,
**最可靠的仍然是拿到 `game/citadel/pak01_dir.vpk` 一次枚举**。

## 十三、布局清单(靠 mod 逆向,2026-10-31)

详见 [`docs/layout-inventory.md`](docs/layout-inventory.md)。要点:

- 出装相关界面共 **7 个布局**,已覆盖 **6 个**(v1.7.5 补上 `citadel_shop_mods_build_category`);
- 剩余 **`popups/citadel_popup_build_browser`**(HUD/商店弹出的出装浏览器弹窗):它内部就是
  `<CitadelHeroBuildsSelector>`,所以列表/详情仍由我们已覆盖的布局负责 —— 只有弹窗自己的
  `#Citadel_BuildBrowser_Title` 等少量文字是英文。补它需要原生布局(现有样本被 mod 重写过,不能直接用)。
- 其余界面(`citadel_hud_active_player_stats`、`hud_data_feed`、`profile_card` …)与本 mod 无关。
- 关键限制重申:**mod 只带它改过的文件**,完整枚举只能来自 `game/citadel/pak01_dir.vpk`。

## 十四、"换出装译文不变 / 所有出装同一个名字" —— v1.8.0 根治

用户反馈(游戏内实测):①列表里所有出装变成同一个名字,反复点"我的出装"描述会变;
②每条出装的"概览"都是同一段译文;③左上角按钮与下拉都无效;④希望"翻译本页"放到详情区
(红色方块处),样式与商店的"快速购买/出装浏览器"一致;⑤不同出装的装备描述不跟着变。

### 根因

1. **在共享根面板上写 dialog variable 会"串味"**:`SetDialogVariable("selected_hero_build_name")`
   写在选择器根上,所有没有自己值的行标签都继承了它 → 列表里每行都显示当前选中出装的名字;
   写在详情根上则被引擎覆盖,描述/分类说明仍然冻结。两条路都不可行。
2. **写 `.text` 会摧毁 `{s:var}` 模板**:模板没了,引擎后续 `SetDialogVariable` 无处落地,
   标签永远停第一次译文 → "每条出装都是同一段译文"。
3. **工具栏位置**:`.BBTControls` 之前的 `position` 只是偏移量,面板仍在 header 的流里,
   于是压在"我的出装/公开"页签上;下拉用 `.BBTMenu.BBTMenuOpen` 复合选择器控制可见性,
   在游戏里不生效(点击后样式没变)。
4. 残留的 `addons\pak13_disadsadr.vpk`(旧版副本)可能以更小编号遮蔽同名布局。

### 修法(v1.8.0)

- **源标签 + 镜像标签**:覆盖布局里所有引擎驱动的文本标签拆成两个
  ——`BBTSrc`(保持原样、`visibility: collapse`,永远由引擎更新)和 `BBTDst`(mod 专属、空)。
  脚本每个 tick 读 `BBTSrc.text` 翻好后写进 `BBTDst`,源标签从不被写坏,换出装/换装备一定跟着变。
  覆盖范围:出装名/出装描述、分类名/分类说明、悬停里的作者注释、列表行名、商店页顶部的出装名。
- **彻底删除 `SetDialogVariable` 写入路径**(含 k:2 校验状态机、varWrites、varTracked),
  不再有任何跨标签泄漏。
- **工具栏**:从选择器 header 移到详情页头部、紧挨"出装选项",用游戏自带的
  `TextButton class="Medium Fill"`(与"快速购买/出装浏览器"同款);下拉改为脚本直接写
  `style.visibility`(不再依赖 CSS 级联),位置改为详情根下的 `align: right top`。
  详情布局同时被用作悬停提示(`citadel_tooltip_build_details`),那里会自动隐藏工具栏。
- `BBTTranslatePage` 等按钮动作改为从按钮自身向上找 `CitadelHeroBuildsSelector` 作为作用域,
  避免"最后 boot 的 tooltip 实例"把整页翻译缩小成只翻 tooltip。
- 测试:`refresh_verify` 重写为源+镜像模型(B/C/D 覆盖换出装、悬停换物品、时间标签抖动);
  `toolbar_cover_simtest` 改为断言"详情里有原生工具栏、选择器里没有第二个"。

### 十四-补:v1.8.1 —— 折叠的源标签不会解析模板(列表名字全空)

v1.8.0 把源标签设成 `visibility: collapse`,实测**列表里所有出装名、出装标题、概述描述、
分类名/说明全部变空**。原因:Panorama 只在**渲染**时解析 `{s:var}`,折叠的 Label 从不渲染,
`.text` 一直停在原始 `#Token`;脚本把"未解析的 token"当成"没内容",于是镜像标签保持空。

修正:源标签不再折叠,改成 **可见标签 + 1px 探针**:
- `BBTSrc` = 可见的那一个,由我们翻译(写 `.text`,模板被覆盖无所谓);
- `BBTProbe` = 同 token 的副本,`width/height: 1px; opacity: 0.01; overflow: clip;`,
  **正常渲染**所以引擎每次换出装都会在这里刷新出最新英文,任何代码都不写它;
- 脚本每 tick 读探针 → 翻好写进可见标签;探针拿不到可解析文本时,可见标签保留引擎自己的英文
  (降级可见,不会再出现空白)。
- 顺带去掉 `bba.css` 里无效的 `hittest: false`(控制台那条 `Invalid property name: hittest` 警告)。

另:排查时发现 `addons` 里有多份重复/过期归档,会与我们抢同名布局/脚本,已禁用:
`pak14_dir.vpk`(本 mod 旧版)、`pak22_dir.vpk`(与 pak11 哈希完全相同的 DeadlockLingua 副本)、
`local-…_pak13_dir.vpk`(Mod 管理器自动导入的 v1.7.3 副本)。

### 十四-补二:悬停/列表恢复正常,但"概览"仍是英文 —— 补译文库(v1.8.1b)

日志验证:v1.8.1 下两条不同出装的描述**都被读到并产生了不同的 MISS**
(`…curated after …` 与 `…Top Drifter build generated by …`),说明探针确实跟着换出装;
只是**译文库里没有这两段长描述**,于是按设计退回英文。

两个原因:

1.【已修·工具】**收集器产出的 `extra_texts.json` 从来没被用上**。收集器写的是
   `{key, text}` 对象,`build_tm.js` 却把数组元素当字符串传给 `addText()`,
   于是 186 条全部变成同一个 `"[object Object]"`(译文 `[对象对象]`,还占了一条库记录)。
   现在 `build_tm.js` 读 `t.text`(兼容旧版纯字符串),并清掉了那条垃圾键。
   重跑结果:译文库 58,314 → **58,500** 条,Lockbuilds 的两段描述已入库。
2.【已改进】**长文本兜底阈值**:>200 字符的文本(每天变化的生成式描述)把整句兜底覆盖率
   从 55% 降到 35%,让"一部分中文"先出来,而不是整段英文。
3.【新增】**诊断日志**:探针源文本发生变化时打印
   `[BBT] probe-follow .<Class> "<旧前30字>" -> "<新前30字>"`,用 `-condebug` 即可确认
   "换出装时标签到底有没有跟着换"。

后续:凡是游戏里出现过、译文库没有的文本都会打 `[BBT] MISS`,定期跑
`node tools\collect_new_texts.js && node tools\build_tm.js` 再重打包即可把它们补进库。

### 十四-补三:v1.9.0 —— "概览还是第一段译文" + 手动"刷新"按钮

**实测证据**:v1.8.2 跑完后抓日志,整个会话 `probe-follow` 计数 = 0,而列表里已经
换了好几条出装 → 说明**引擎从不更新我们额外加的那个 1px 副本**:它只更新它自己
认的那个标签(即布局里声明 `text="#Token"` 的那一个)。所以 1px 探针方案对
"常驻"的详情面板无效(对每次重建的列表行/悬停提示仍然有效)。

**改法(v1.9.0)**:回到"源标签 + 镜像",但源标签**不折叠、不隐藏**,而是压成 0×0:
- `.BBTSrc { width/height/max-*: 0; opacity: 0.01; overflow: clip; }`
  —— 它仍然是**渲染中**的面板(折叠的标签完全解析不出模板,这是 v1.8.0 的教训),
  但视觉上不占位置;
- 引擎继续把最新英文写进它(它带着 token),`BBTDst` 显示译文、由我们写;
- 每次换出装,`[BBT] follow .<Class> "旧前30字" -> "新前30字"` 会打印出来,便于确认。

**新增手动"刷新"按钮**(详情页头部,`翻译本页` 右边):
- `G.BBTRefreshPage()`:清空整页 memo(重新翻译一遍),并打印
  `[BBT] refresh: N engine label(s) .BuildDescription="…" | …`,直接告诉你
  源标签当前读到的是什么(能读到英文 = 源标签正常;读到 `#Token`/空 = 源标签没解析)。

### 十四-补四:v1.9.1 —— 0×0 也不行,改成"原地翻译 + 换出装时重新解析 token"

**实测**:v1.9.0(源标签 0×0 + 镜像)上线后,**列表名字与概览又全空了**。
结论:**折叠(visibility: collapse)和 0 尺寸都会让 Label 完全不解析 `{s:var}` 模板**
——只要标签不真正参与排版,引擎就不给它算文本。所以"源标签必须正常显示"是硬约束。

**最终方案(v1.9.1)**:不再做任何"隐藏源标签 + 镜像"的花活,标签就放原位、
原地翻译;换出装(或点"刷新")时把 **显式 token 重新赋给标签**:
```js
label.text = "#Citadel_HeroBuilds_BuildDescription";  // 引擎重新解析 → 新英文
```
0.2s 后回读:
- 读到的不是 `#...` → `[BBT] resync-ok <token> -> "新英文…"`,清掉 memo 再翻译;
- 仍是 `#...`/空 → 还原旧文本(屏幕上永远不会停在 `#Token`),打
  `[BBT] resync-fail <token> raw=… lz=… lz2=…`
  (`lz`/`lz2` 是 `$.Localize(token)` 与 `$.Localize(token, panel)` 的返回值,
  留作下一步"直接取文本"方案的依据)。

覆盖:`BuildName` / `BuildDescription` / `CategoryName` / `CategoryDescription`
(类名与 token 的对应写死在 `RESYNC_TOKENS`,避免历史上"class 有两个 token"踩过的坑;
`ModifiesLabel` 不参与,因为 tooltip 里它对应两个不同 token,而 tooltip 本身每次悬停都会重建)。

测试:`refresh_verify` 改为"原地翻译 + token 重新解析"模型,新增 Case E(解析失败时保留旧文本、
绝不显示 `#Token`)。





