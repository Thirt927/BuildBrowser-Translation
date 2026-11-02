# 出装浏览器逻辑图(build-browser-logic)

> 阶段 1 产物。本文件**不改代码**,只用 REA + 反编译 + 实机日志 建立 ground truth。
> 证据分级: **[observed]** = 直接看到(反编译源码 / 实机 console.log / REA 证据);
> **[inferred]** = 由 observed 推出的合理机制; **[unknown]** = 需实机验证。
> REA 证据 ID:`ev_cb3c3cfe84adbbd11ac49ab8801644590c0456d8edcfc613a8461e17675f76a0`(bba_translate.js,REA 6.7.0)。

## 1. 引擎侧结论(先说最重要的,推翻"游戏里有 UI JS"的假设)

**[observed] 游戏**不**为出装浏览器编译打包任何 UI JS。**
- `citadel/pak01_dir.vpk`(8.4MB,158644 文件)里 `panorama/scripts/` 只有 6 个 `.vts_c`,反编译后是 `async.js` + 5 个 `post_game/*.js`。`grep -riE "ShopModsBuild|HeroBuilds|CategoryDescription|SelectBuild"` 对这 6 个文件 **0 命中** —— 它们全是赛后页/异步脚本,与出装浏览器无关。
- 330 个 `citadel/pak01_0XX.vpk` chunk 全扫,`-e vjs_c` 0 命中、`-e vts_c` 0 命中;`pak01_000..023` 全是 `models/heroes_wip` 的 vtex。
- `core/pak01_dir.vpk`(1450 文件)里 0 个 `.js/.vjs_c/.vts_c`,0 个 build/shop 资源。

**[observed] 9 个原生出装浏览器布局(反编译自 `citadel/pak01_dir.vpk`)**:
`citadel_ui_build_selector / citadel_ui_build_details / citadel_shop_mods_build /
citadel_shop_mods_build_category / citadel_hud_hero_builds / citadel_shop_mods_list /
citadel_shop_mods_tier / citadel_ui_build_tag / tooltips/citadel_tooltip_build_details`
**没有一个带 `<scripts>` 块**。它们全部依赖:
- **引擎 C++ 全局回调**:`CitadelHudHeroBuilds*`、`CitadelBuildBrowser*`、`UIShowTextTooltip`、`CitadelCopySelectedBuildIDToClipboard` 等(在 XML 的 `onactivate`/`onmouseactivate` 里裸调用)。这些函数在 `citadel.exe` 里注册,**不在任何 JS 资源里**。
- **本地化 token**:`text="#Citadel_HeroBuilds_..."`(BuildName / BuildDescription / CategoryName / CategoryDescription / BuildID / Version / LastUpdatedTime 等)。引擎启动时按语言表解析;值变化(换 build)靠 **dialog variable**(`SetDialogVariable`,由 C++ 写)。

**[observed] 关键面板层级(反编译 `citadel_ui_build_details.xml`)**:
```
CitadelBuildDetails
 └─ #BuildInfo
    └─ #BuildDetails_Overview            ← "概览页"(概述在这)
       ├─ <Label class="BuildDescription" text="#Citadel_HeroBuilds_BuildDescription"/>   ← 概述文本
       ├─ <CitadelShopModsBuild id="ShopModsBuild"/>    ← 内嵌一套独立 build 面板
       │   └─ #CategoryContainer ─ ModCategory0..N (CitadelShopModsBuildCategory)
       │        每个: #BuildCategoryName(.CategoryName) + .CategoryDescription + #ModsContainer
       └─ #AbilityOrder
```
`citadel_shop_mods_build.xml` 内还有 `<snippet name="FavoriteBuildEntry">`(含 `FavoriteBuildEntryLabel SelectedBuildName` + 3×`CitadelBuildTag`)和 `#FavoriteBuildList` / `#ClipboardToast`。

**结论:换 build / 填 label 的逻辑在 C++ 引擎里,REA-JS 无法直接看到。要"完全搞明白引擎内部"得逆向 `citadel.exe`(超出本次范围)。** 我们 mod 的 bug 全部在 `bba_translate.js` 与它对引擎机制的**反应方式**上 —— 这才是 REA + 反编译 + 日志 能精确建立 ground truth 的对象。

## 2. 我们 mod 的结构(REA 语义图,110 个命名函数)

`mod/panorama/scripts/bba_translate.js`(v1.9.24,2919 行,每布局上下文各跑一份 IIFE)。关键函数(行号 = REA 证据):

| 行 | 函数 | 职责 |
|---|---|---|
| 312 | `uiPanelIn(root,[ids])` | 在 root 子树找控件 |
| 356 | `layoutRoot` / 371 `rootOf` | 上溯到 `CitadelShopModsBuild` 等已知根 |
| 481 | `pageRoot(scope)` | 点按钮那行的"页根"(双态/翻译范围) |
| 516 | `collectMisses(160, page, counts)` | 收集整页未译英文文本(逆序 DFS,**v1.9.23 修过"只有最后一张卡"**)|
| 568 | `uiRequestBatch(texts,cb)` | 桥批量(UI_BATCH=8 + 字符闸 `LIVE_BATCH_CHARS`)|
| 641 | `uiApplyResults(res)` | 把桥返回写回当前可见 label |
| 732/742/754 | `registerBridgePanel`/`liveRegistryPanel`/`livePanel` | **跨上下文桥面板注册表**(v1.9.24)|
| 787 | `liveSend(req,timeout,cb,target,path)` | 走 `document.title` 信道发请求 |
| 842 | `livePoll` / 906 `liveProbeTargets` / 947 `liveProbe` | 桥探活(先 8792 DeadlockLingua 再 8793)|
| 1107 | `liveTranslate(panel,raw)` | **扫描器自动在线翻译**(仅 `live.state==="on"`)|
| 1429 | `roleTokenFor(panel)` | class → `#token`(RESYNC_TOKENS,ModifiesLabel 双候选)|
| 1454 | `translationFor(raw)` | 单次算出最终译文(TM→frag→term),避免两步重绘 |
| 1466 | `applyResync(p,raw)` | **单写**:命中写译文 / 未命中写引擎原文,**绝不写 token** |
| 1501 | `freezeResync` / 1505 `isResyncFrozen` | 4s 冻结,防刷新循环在 原文↔译文 间交替 |
| 1515 | `resyncLabel(p)` | `$.Localize(tok,p)` 取引擎最新值 → applyResync;取不到→freeze 不写 token |
| 1581 | `resyncAll(limit,origin)` | 从页根 DFS,primary(BuildName/Desc)优先,预算 3000 |
| 1869 | `repairToken(p,tok)` | label 卡在 `#token` 时 `$.Localize` 自愈,每 token 1.5s(`TOKEN_REREAD_MS`)|
| 1924 | `scan(root)` | 主扫描(T6 分块 `SCAN_BUDGET=2000/tick` + `scanCarry` + `stableRoots` 快退)|
| 1724 | `translatePanel(p,preRead)` | 单面板翻译决策(orig 门 / #token 分支 / memo / CJK 早退 / lookup / frag / live / term)|
| 2280 | `wireToolbar(root)` | 绑 `BBTTranslateButton2`(双态)+ `nestedInOverview` 隐藏 |
| 2344 | `nestedInDetails` / 2364 `nestedInOverview` | 祖先链判 内嵌/概览(≤16 步)|
| 2381 | `wireHeaderButton(scope)` | 游戏内头排 `BBTTranslateButton3` → `translatePage(rootOf)` |
| 2423 | `resetMemos(root)` | 把所有 k:1 写回原文、清 memo(双态"原文")|
| 2459 | `refreshPage(root)` | `resyncAll(80)` 重新解析引擎 label(双态"翻译"前置)|
| 2482 | `offlineTranslateFallback` | 无桥时的离线兜底 + 反馈文案 |
| 2507 | `translatePage(root)` | 主按钮逻辑:collectMisses→桥活走 `uiRequestBatch`,否则 reprobe/离线 |
| 2690 | `dispatch(action,origin)` | `BBTActivate` 入口;`"translate"` 双态 toggle |
| 2799 | `boot()` | 启动:加载 TM/术语、探桥、`wireToolbar` 重试 ×12 |

## 3. 六个必答问题(逐条 + 证据)

**Q1 哪几个 JS 资源驱动 selector/details/shop_mods/category?每个布局独立 JS 上下文吗?**
- **[observed]** 游戏侧**没有**驱动这些面板的 JS —— 全是 C++ 全局回调 + `#token`(§1)。
- **[observed]** 我们 mod 侧:每个被覆盖布局的 `<scripts>` 各跑一份 `bba_translate.js` IIFE = **每个布局实例一个独立 JS 上下文**(各自 `memo`/`displayOrig`/`live`/`missLedger` 闭包,但 `G.__BBT_MISS_LOGGED`/`G.__BBT_WIRED_SKIP_LOGGED` 等挂 `globalThis` 跨上下文共享)。
- 详情页第 2 个 `CitadelShopModsBuild`(内嵌 `#ShopModsBuild`)与游戏内英雄商店页的 `CitadelShopModsBuild` 是**两个不同面板实例**,各由所属布局上下文扫描。

**Q2 换 build 时 CategoryName/CategoryDescription/ModifiesLabel 怎么填充?**
- **[observed]** 布局 XML 里是 `text="#Citadel_HeroBuilds_CategoryName"` 等(§1 反编译)。
- **[inferred]** 引擎按语言表解析 `#token`;换 build 时 C++ 通过 `SetDialogVariable` 更新底层值,引擎**重解析**已渲染 label。我们写 `.text` 会**摧毁 `{s:var}` 模板落地路径**(AGENTS §6.2/6.3)—— 所以现行模型 = 源标签写译文 + 1px 探针读引擎最新英文(`resyncLabel` 的 `$.Localize(tok,panel)` 双参)。
- ModifiesLabel(物品注释)候选 token = `#Citadel_Item_Build_Annotation` 或 `#Citadel_ItemModifies`(RESYNC_TOKENS 双候选,§2 L1429)。

**Q3 8 个 ModCategory 各有几个 JS 上下文?为何 3/4/5 出现两个 root?**
- **[observed]** 实机 scan-summary:同一批 `ModCategory3/4/5` 先后以 `root=ShopModsBuild`(23:14:27)和 `root=ShopModsSelectedBuild`(23:14:32)各扫一遍,数值相同(443/452/540)。
- **[inferred]** 这不是"同一面板被扫两次",而是**两套独立 `CitadelShopModsBuild` 实例**:①游戏内英雄商店页的;②详情页内嵌的 `#ShopModsBuild`。两实例显示同一 build 数据 → 数值相同,root 标签不同。`CitadelShopModsBuildCategory` 本身**不**带我们注入的 `<scripts>`(它是被 parent 实例化的子面板,继承 parent 上下文),所以 8 个 ModCategory 由**所属 build 实例的上下文**扫描,不是各自独立上下文。
  - 待实机确认:详情页那个内嵌实例的上下文 tag 到底是 `ShopModsSelectedBuild` 还是别的。**[unknown]**

**Q4 "只有最后一个类别译"的确切机制?**
- **[observed + inferred]** 两个候选根因(需实机定夺):
  1. **在线批量路径**:`translatePage→collectMisses(160)` 按 160 文本上限收集,v1.9.23 已修过"最后一张卡先收集"的逆序 bug;若上限仍被某一张大卡占满,前面的类别/物品注释会被截断 → "只有最后一类有译文"。**[inferred,需 BBT_DEBUG 看 `translate: ... wrote=... miss=...` 行]**
  2. **扫描器 memo 路径**:memo 是**每上下文**的;若某类别只被 A 上下文写过、B 上下文又把它当"未见过"重扫,或反向,会出现"只有一个留中文"。**[inferred,需看 scan-summary 的 wrote 分布]**
- 用户看到的"只有最后类别的类别注释翻译了" 更可能是 ①(在线批上限/截断),因为**类别注释**(CategoryDescription)走 resync/在线,而 scan-summary 里各 category `wrote` 都不为 0(1/2=9/7,3/4/5=5/5/6,6/7=6/2)。**[unknown:精确定责需早间日志]**

**Q5 闪烁的精确触发链?**
- **[observed]** 历史根因(v1.9.9,AGENTS §6.4):**把 `#token` 写进 `label.text`** → 引擎只重解析 XML 属性里的 token、不重解析 JS 赋值的 → 渲染出字面 `#Citadel_...` → 下个 tick 又被当英文翻 → 中英/token 交替 = 闪烁。
- **[observed]** 现行防御:`applyResync`/`repairToken` 都**不写 token**(命中写译文/未命中写引擎原文,单写);`freezeResync` 4s 防刷新循环重试;`stableRoots` 快退只读 identity label。
- **[unknown]** 用户仍报"闪烁" → 需确认是:换 build 时 `resyncAll` 先写引擎原文、下一 tick 才写译文(两步重绘),还是 `displayOrig`/memo 与引擎重解析打架。**需 BBT_DEBUG 的 `W resync`/`W TM` 时间戳序列**。

**Q6 概览概述挂哪个 panel?为何不走桥在线翻译?**
- **[observed]** 概述 = `#BuildDetails_Overview > .BuildDescription`(text=`#Citadel_HeroBuilds_BuildDescription`),即"概览页"(§1 层级图)。
- **[observed]** 概览页的 trigger 被 `nestedInOverview` **隐藏**(`wireToolbar` L2291:`visibility:collapse` + `hittest=false`,`[BBT] trigger hidden in overview context`);v1.9.20 的匹配串含 `HeroBuildSelector`/`HeroBuildsSelector`/`BuildDetails_Overview`。所以**概览页没有点"翻译"的入口** → `translatePage/collectMisses` 不在这页跑 → 在线批翻译不触发。
- **[observed]** 唯一自动在线路径 = 扫描器 `translatePanel→liveTranslate`(§2 L1107),但**仅当 `live.state==="on"`**。若该上下文桥探活失败/`BBT_LIVE="off"`/`liveSend` 硬失败被 `liveMarkFailure` 切 off,则概述保持英文。
- **[inferred]** "有的没在线翻译" = 部分 build 的概述在**桥活时**被 `liveTranslate` 译了、**桥断/该上下文 off 时**没译。**[unknown:需 BBT_LIVE_STATE() 逐上下文看 `state`/`pending`/`hardFails`]**

## 4. 阶段 2 落点(基于上图,供改 bug 参考)

- **T1 只有最后类别译** → 查 `collectMisses(160)` 截断 + scan-summary 各 category wrote;若是在线批上限,**按 DOM 顺序均匀分配预算**或"类别注释优先"(resync primary 已优先,在线批也应按类别头优先)。
- **T2 闪烁** → 确认是 resync 两步重绘;若是,把 `resyncAll` 的 原文→译文 合并成单写(`applyResync` 已是单写,检查调用时序)。
- **T3 概览在线** → 概览页 trigger 被隐藏,**要么**放开该页一个"翻译"入口(不再无条件 collapse),**要么**让扫描器在 `live.state==="on"` 时对概览概述主动 `liveTranslate`(现逻辑已具备,需确认桥在该上下文活)。
- **T4 双态按钮** → `dispatch("translate")` L2697 已有 toggle(原文↔翻译),以它为基础**扩展到所有类别 + 物品注释**(覆盖 `CategoryDescription` + `ModifiesLabel`),避免 v1.9.18 回归(busy 卡死 / 物品注释不译)。
- **T5 优化** → `G.__BBT_MISS_LOGGED` 经 `realGlobal()`(`globalThis` 优先,无 globalThis 的引擎退回 `Function("return this")()`)——**跨上下文共享不保证**(部分引擎 globalThis 缺失 → 每上下文一份 → 去重跨上下文失效;实机 23:14 同 key MISS 连发两次即此)。不改机制,记录在案;清 4 个带 BOM 的布局 XML;不加轮询。

## 5. 证据账本(文件 → 行 / REA ID)

- 原生布局(反编译,存 `temp_extract/game_js/build_layouts/`):`citadel_shop_mods_build_category.xml`(`#BuildCategoryName`/`.CategoryDescription`,无 scripts)、`citadel_ui_build_details.xml`(`#BuildDetails_Overview` 层级 + 内嵌 `#ShopModsBuild`)、`citadel_shop_mods_build.xml`(无 scripts,`#CategoryContainer` + 全局回调)。
- 原生 JS(反编译 `temp_extract/game_js/native_vts/`):`async.js` + 5×`post_game/*.js`,**0 处** build 浏览器引用。
- REA 语义图:`rea_bba_translate.json`(14MB,`temp_extract/`);函数图 `rea_fns.txt`(110 函数);证据 ID `ev_cb3c3cfe…`。
- 实机日志:`E:\Steam\steamapps\common\Deadlock\game\citadel\console.log`(2026-11-02 23:14,v1.9.24,scan-summary / MISS / click 行)。
- 我们代码:`mod/panorama/scripts/bba_translate.js`(v1.9.24,§2 行号)。

## 7. 阶段 2 实现记录(v1.9.25,2026-11-03)

基于本逻辑图,在 `mod/panorama/scripts/bba_translate.js`(v1.9.24→v1.9.25)落 Phase 2:

- **T4 双态按钮 + 默认原文(核心)**: 新增 `manualMode` WeakMap(每上下文)。`boot()` 里对 **浏览器详情页**(`layoutTag === "CitadelBuildDetails"` 且非 hover tooltip)武装 `manualMode` + `displayOrig`(默认原文),按钮休息态置"翻译"。`tick()` 的换 build 分支按 `manualMode` 分流: **手动页**——"原文"态(=默认)停摆不写(根除换 build 闪烁)、"翻译"态 `resyncAll(40)` 保鲜; **非手动页**(列表/游戏内独立 build 页)保留旧自动 `displayOrig.delete + resyncAll(40)`。`dispatch("translate")` toggle 对 `origin/page/root` 三个句柄 set/delete `displayOrig`(扫描器门控键 = 上下文 panel)。
- **T1 全覆盖(修"只有最后一个类别")**: 点"翻译"时 `refreshPage` 的 `resyncAll` 上限 80→**400**、`translatePage` 的 `collectMisses` 上限 160→**800**,一次点覆盖**所有类别头 + 类别注释 + 各类别物品注释**(collectMisses v1.9.23 已改 DOM 序,不再截断到末卡)。
- **T2 闪烁**: 详情页默认原文 + 手动页"原文"态停摆(零写)→ 换 build 不再 原文↔译文 交替;"翻译"态已知文本 `applyResync` 单写,仅未知文本 原文→译文 两写(可接受)。
- **T3 概览在线**: 被 T4 吸收——详情页(含 `#BuildDetails_Overview` 概述 `.BuildDescription`)点"翻译"时 `collectMisses` 收入概述文本,桥活走 `uiRequestBatch`(桥侧落 `live_seen.json`),不活走 `offlineTranslateFallback`。概览页 trigger 仍被 `nestedInOverview` 隐藏(引擎"出装选项"占位),改由**详情页顶部 BBTTranslateButton2** 作为唯一手动入口(符合"加一个手动双态按钮")。
- **T5 清理**: 清 4 个布局 XML 的 BOM(`citadel_ui_build_selector.xml`/`citadel_shop_mods_build.xml`/`citadel_shop_mods_build_category.xml`/`tooltips/citadel_tooltip_mod_details.xml`),另 2 个本无 BOM。跨上下文 MISS 去重见上(不保证 globalThis)。
- **范围边界**: 游戏内**独立** build 页(`citadel_shop_mods_build.xml` 上下文,`BBTTranslateButton3` 单向"翻译")保持自动,未改;浏览器详情页**内嵌**的 `<CitadelShopModsBuild>` 是原生 panel(非独立上下文),归详情页上下文门控,已覆盖。

验证: 全量离线套件通过(scene/refresh/translate/tools/fragment/live_channel/tm_table/ui_button/vpk_list/toolbar_cover + `build_layout_tokens --check` + `tm_export`);`node --check` 语法通过;重打包 `dist/pak13_dir.vpk`(4,271,361 B)并部署到 `game/citadel/addons/`(备份 `pak13_dir.vpk.bak-20261103-003333`)。**实机验收由用户重启游戏后按 §6 清单执行。**

## 6. 实机待确认清单(早间,`-condebug` + `BBT_DEBUG=true` + `BBT_LIVE_STATE()`)

1. 详情页内嵌 build 实例的上下文 tag(确认 Q3 的 `ShopModsSelectedBuild`)。
2. 点"翻译"后 `translate: scanned= wrote= already= miss=`(定 Q4 是在线批截断还是扫描 memo);确认**所有**类别的 CategoryDescription + 各类别 ModifiesLabel 都出译文(不止最后一个)。
3. `W resync`/`W TM` 时间戳序列(定 Q5 闪烁是两步重绘还是 memo 打架)。
4. 各上下文 `BBT_LIVE_STATE()` 的 `state`/`hardFails`/`pending`(定 Q6 桥在概览上下文是否活)。
