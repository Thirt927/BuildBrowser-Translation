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

## 五、"翻译不刷新 / 一直是同一个翻译" —— 2026-10-31 定位与修复

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
