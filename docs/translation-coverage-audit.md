# 翻译覆盖审计(2026-11-01,v1.9.8)

用户问题:「检查有没有翻译覆盖问题」。这里把审计方法、结论、已经修掉的东西、以及**还没修的结构性缺口**都记下来,方便下次接着做。

## 1. 审计方法

| 手段 | 做什么 |
|---|---|
| TM 完整性脚本(临时只读脚本) | 解析 `mod/panorama/scripts/bba_tm.js` 的 `D` 串,核对条数/重复/排序/占位符/译文长度 |
| 真实出装样本 | `tools/build_code.js` 的 `decode` + `collectTexts` 解 `samples/sample-build-code.txt` 的 46 条可见文本,逐条查 TM |
| 静态覆盖审查 | 6 个覆盖布局逐行核对:`#Token`、硬编码英文、`onmouseover` 工具提示、`placeholder`、`{s:}` 模板 |
| token 表反查 | 对每个 `#Token` 反查 `bba_layout_tokens.js` 是否有条目、候选是否唯一 |
| 写入路径审查 | 找出同一块文本可能被多个入口写入的位置(扫描器 / resync / 本地库 / 工具栏自身) |

## 2. 结论一:翻译记忆数据本身没问题

- `bba_tm.js`:`COUNT = 58500`,实际解析 58500 条,**0 重复、0 缺失、0 排序断点**(二分查找安全)、
  0 条空译文、0 条含 `{s:}`/`#`/`%s` 占位符错译。
- 1371 条译文不含中日韩字符:抽查后确认全部是**刻意保留原文**的专有名词/梗/外语出装
  (如 `HO HOO HOOO!`、`:skull:`、`twitch.tv/...`、葡萄牙语/俄语出装名),不是数据损坏。

## 3. 结论二:真实出装 46/46 条 100% 覆盖

用样本分享码(名称带 `[Lockbuilds.com]` 的副本)解出 46 条可见文本:
name 1 / description 1 / category 7 / category_desc 4 / annotation 33 → **全部命中 TM,漏译 0**。
「副本」后缀、TM 查表、出装码解码这条主链路是通的。

## 4. 结论三:修掉了一处「自伤」(本次提交)

v1.9.8 新增的工具栏去重标记 `BBTActMark2` 文本是 `act:menu@<毫秒>`(无中文),

1. 会被扫描器当成「未翻译的游戏文本」→ 每次点击打一条 `[BBT] MISS`,吃掉 300 条采集预算;
2. bridge 在线时会被当未知文本发出去机翻;
3. 机翻结果经 `tools/collect_new_texts.js → tools/build_tm.js` 进 `bba_tm.js` 后,**下一会话译文会被写回 marker 标签**,`name@<ms>` 戳解析失败 → 去重失效 → 点 ▾ 又变回「开了立刻关」(v1.9.7 症状)。

同批风险:菜单项 `English`、`한국어` 同理会被采集改写,而 `wireMenuItems` 靠文本匹配绑菜单项,文本一改绑定就脱钩。

修法:布局给自有 UI 加 `class="BBTNoTranslate"`(`#BBTBar2`、`#BBTMenu2`、`BBTStatusLabel2`、`BBTActMark2`),
脚本加 `isOwnChrome(panel)` 并在 `scan()` / `translatePanel()` / `noteMiss()` 三处拦截;顺便把悬停提示里
**整条工具栏**(原来只藏了三个按钮)隐藏掉。回归:`tests/own_chrome_simtest.js`(16 checks)。

## 5. 结论四:真正还没覆盖的文本(结构性,非本次修)

### 5.1 引擎 `#Token` 标签:多半是原版英文(最重要)

两类原因叠加:

1. **token 表生成器漏收**:`tools/build_layout_tokens.js` 只匹配 `<(Label|TextButton|Button|Panel)`,
   于是 `CitadelButton`、`SplitLabel`、多 class、无 class 的 `text=` 都进不了表,例如
   `citadel_ui_build_selector.xml:46`(Use Build)、`:79`(Add Tag)、`:122`(Publish);
   `citadel_shop_mods_build.xml:47-51`(Edit Build / Add to Queue / Browse Builds / Compact All / Add Category);
   `tooltips/citadel_tooltip_mod_details.xml:104/108/148/184/186`。多 class 时 `tokenFor` 还会取错候选。
   拿不到 token 的标签:变化检测看不见、resync 不会重解析、引擎读回 `#Token` 时直接 return → **永久不翻**。
2. **TM 里没有 UI 英文行**:58500 条几乎全是出装笔记;抽查 43 个常见 UI 英文词条,
   `Build Options`/`Use Build`/`Add Tag`/`Add Category`/`Compact All`/`Browse Builds`/`Add to Queue`/
   `Build Name`/`Build Description`/`Overview`/`My Builds`/`Public Builds`/`Copy to Clipboard`/
   `Edit Build`/`Enhanced`/`Corrupted`/`Purchased`/`Owned By`/`Modifies`/`View Impact` 全部 miss。
   → **英文游戏客户端下这些引擎标签离线就是原版英文**,只有 bridge 在线时才能实时翻。

### 5.2 placeholder 永不翻译

`citadel_ui_build_selector.xml:84`(搜索框)、`:116`(出装名)、`:118`(说明)是 `placeholder=`;
`isTextEntry()` 分支只记 memo 不写,扫描器也只读 `.text` → 占位符一直是英文。

### 5.3 `onmouseover` 工具提示不在布局树里

`UIShowTextTooltipStyled(#...Token, ...)` 的提示面板由引擎临时生成,扫描器遍历不到:
`citadel_ui_build_details.xml:122/123/125/126/127/128`、
`citadel_ui_build_selector.xml:31/34/43/59`、`citadel_shop_mods_build.xml:45/46/47/48/50`、
`citadel_shop_mods_build_category.xml:26/32`。

### 5.4 其它

- `{s:...}` / `{i:...}` 模板(`tooltips/citadel_tooltip_mod_details.xml`)里的英文来自游戏数据,
  TM 没有整句,只有名词能被 `substituteTerms` 词表兜住。
- `Show mods` / `Hide mods` 的开关在 Valve 自己的布局里,我们没覆盖 → 永远英文。
- `popups/citadel_popup_build_browser` 弹窗标题未覆盖(`docs/layout-inventory.md:17` 已记录)。
- 运行时 `HAS_CJK = /[\u3400-\u9fff]/` 不含 Hangul/假名,而 `tools/build_tm.js` 的 CJK 判定含
  `\uac00-\ud7af` —— **两端不一致**,韩文/日文文案会被当待译文本(本次靠 `BBTNoTranslate` 规避了我们自己的韩文菜单项)。

## 6. 结论五:两条写入路径可能互相覆盖(风险,未修)

- `BuildName` / `BuildDescription` 同时被 `scan()` 的 TM 写和 `resyncLabel → applyResync` 写;
  `tick()` 先 scan 后 resync,而 `applyResync` 是「先把 text 落回英文再翻译」:
  **新文本 TM miss 时就会停在英文,并丢掉上一次的中文**(与「概述不更新」同源)。
- selector 与 details 各 include 一份 `bba_translate.js`,而 selector 的上下文里嵌套了 details,
  `pageRootIn` 会爬到 `CitadelHeroBuildsSelector` → 同一批标签被两个实例各 resync 一遍(预算 40 条被摊薄,双倍写入/闪烁)。
- `collectMisses` 按整页收,`uiApplyResults` 却写回 `$.GetContextPanel()` 所属实例 → bridge 结果可能落到 tooltip 副本。

## 7. 建议的后续修法(按性价比)

1. 扩 `tools/build_layout_tokens.js`:正则加 `CitadelButton|SplitLabel`,读 `placeholder=`,多 class 时优先用 id,候选歧义时保留列表 + resync 逐个试;重新生成 `bba_layout_tokens.js`。
2. 把 UI 英文词条一次性灌进 TM(用 bridge 跑一遍英文客户端截图/布局文本,或手工整理 40~80 条常用 UI 字符串),这样离线也有中文。
3. `applyResync` 改「先查表、命中才改 text」,避免 miss 时把中文打回英文;并让 selector 实例不再 resync 嵌套 details 的子树。
4. `uiApplyResults` 用收集时的 root 写回,而不是 `$.GetContextPanel()`。
5. 统一 CJK 判定(运行时与构建端),把 `HAS_CJK` 扩到 Hangul/假名,或统一只认中文。

## 8. 复测

```powershell
cd repo
node --check mod\panorama\scripts\bba_translate.js
node tests\own_chrome_simtest.js     # 本次新增:自有 UI 不进翻译管线
node tests\wiring_simtest.js         # 工具栏点击链路
Get-ChildItem tests\*.js | ForEach-Object { node $_.FullName }   # 全部套件
```
