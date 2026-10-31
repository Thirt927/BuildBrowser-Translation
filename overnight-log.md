# 夜间任务日志 — BUG任务书-出装浏览器(2026-11-01)

模式:挂机 + 自我审批 + 推送。任务书:`F:\agents\pi-1\BUG任务书-出装浏览器.md`。
红线全程遵守:未手改生成物、未复制 VPK 到 Steam、未启动游戏、未删测试、无范围外顺手修复、凭证未回显。
所有「代码完成」项状态为**代码完成,待游戏验证**(早间步骤见 TODO.md v1.9.7 节)。

## 终态(历史重写后,gate 全绿 → 已推 origin/main)

**历史重写说明(审计否决 ③ 后执行)**:任务书 §7 门槛「一个 bug 一个 Conventional Commit」。
初版历史里 B3+B4 合一个 commit(`46c7686`)、B1/B2/B5 合一个 commit(`08a40b1`),
提交信息用 `v1.9.7:` 里程碑风格,不满足门槛;同时 `46c7686` 里混入一处
`#Citaled_…` token 拼写错误,由后续 `74033e3` 修复。经备份 tag `backup-before-rewrite`(= 旧终态
`ff7259c`)后,在 `rewrite-branch` 上自 `f4833e6`(v1.9.6)重建:每个 bug 独立 Conventional
Commit,typos 从历史上**消除**(不再引入后修复,改为预防性静态校验),日志重写至终态。
旧 SHA `46c7686` / `08a40b1` / `74033e3` / `ff7259c` 已被重写取代(仅存于备份 tag 链上)。

| Bug | Commit | 内容 | 状态 |
|---|---|---|---|
| B3 换出装概述不刷新 | `43774aa` | `fix(resync)`:panelHasClass 三层(BHasClass 引擎→classList→.class 字符串);VERSION 1.9.7;refresh_verify 行为 Case G(引擎绑定 CategoryDescription 经 `$.Localize` 刷新) | 代码完成,待游戏验证 |
| B4 悬停物品注释不刷新 | `e356120` | `fix(resync)`:RESYNC_TOKENS 加 ModifiesLabel 候选 token;resyncLabel 多候选遍历 + resync-localized/resync-defer(歧义角色不猜 token);refresh_verify 静态交叉校验(RESYNC_TOKENS 每个 `#token` 字面量必须 ∈ 生成物 byClassAll,预防未来拼写错误) | 代码完成,待游戏验证 |
| B1 翻译按钮点不动 | `1f741c6` | `fix(toolbar)`:`clickProbe` + `onActivate`(translate/refresh 按钮)打点 | 代码完成,待游戏验证 |
| B2 下拉栏点不动 | `02b996b` | `fix(toolbar)`:`placeToolbar` css-fallback 一次性 dump + `onActivateChild`(菜单项)/`toggleMenu`(menu->open/close)打点 | 代码完成,待游戏验证 |
| B5 详情页缺按钮/hover 页点不中 | `8b16120` | `fix(toolbar)`:boot `toolbar-geom` 一次性 dump + `toolbar hidden in tooltip context` 行;tooltip 隐藏判定改走 panelHasClass(B5b 随公共根因修复) | 代码完成,待游戏验证 |
| P1 帧率 | `12240e3` | `docs(perf)`:仅文档——静态热路径审查 + BBT_STATS 四步计时打点方案(实测数字→早间 TODO「四-补」) | 方案完成,实测待早间 |
| (前置 v1.9.6) | `f4833e6` | classList.contains 读类 —— 游戏证据表明在真引擎上假设仍错,被 v1.9.7 的 BHasClass 三层取代 | 已被取代 |
| B3' 诊断门控统一 | `2e6f286` | `fix(resync)`:`resync-fail`(未门控重复行)/`localize-probe`(debug 关也输出)统一改走 `debugOn()`——B3 回归检查声称「probe 一次性门控」,这两行与之不符,已消除;TODO 早间步骤 ①② 补 `globalThis.BBT_DEBUG = true` 前置 | 代码完成,待游戏验证 |
| (本日志,推送前终态) | 本 commit | 重写 overnight-log 至终态;推送后 SHA 于 `origin/main` | 已记录 |

**终态验证(推送前)**:基线三条(`scene_verify` ALL SCENES VERIFIED / `refresh_verify`
ALL REFRESH CHECKS PASSED / `build_layout_tokens --check` in sync,26 classes 16 ids)+
10 离线套件全 PASS(translate/tools/scene/refresh/fragment/live_channel/tm_table/ui_button/
vpk_list/toolbar_cover;layout_dom_simtest 需 S2V 目录,默认 SKIP 非 FAIL)+
`git status` 已跟踪区干净 + 生成物零改动 + 无临时日志残留 +
`dist/pak13_dir.vpk` 已按 v1.9.7 终态重打(二进制校验含 `1.9.7`、含 ModifiesLabel 候选、
全仓 0 处 `Citaled`)。**未复制进 Steam addons(红线;早间步骤:复制 + 重启 Steam)。** dist 在 `2e6f286` 后再次重打(2026-11-01 05:13,4,225,943 B)并二进制复校通过(见复审 ④)。

## 阶段0 基线自检(只读+跑测试)

- node v24.13.0(≥22.15 ✓)。CSDK12 路径 `E:\dealoc-mod\Reduced_CSDK_12` 存在 ✓。
- 基线三条:scene_verify PASS / refresh_verify PASS / build_layout_tokens `--check` in sync ✓。
- 完整 `scripts\build.ps1` 成功 → `dist/pak13_dir.vpk` 4.2MB ✓(基线时点产物)。
- 全量 11 套件(除 layout_dom_simtest,需 S2V 目录默认 SKIP)全绿。
- 差异记录:`.pi/`、根 `AGENTS.md` 为未跟踪本地文件,非任务书结构清单内,未动。

## 阶段1 病根报告(交叉分析结论)

**游戏日志证据(v1.9.6 部署后 console.log,03:09–03:10)**:
`refresh: re-resolved 0 engine label(s)` ×5;`live bridge: not available on 8792/8793` ×12;
50 条 `[BBT] MISS`;**0 条 `localize-probe`**(resyncLabel 一个都没走到 →
`roleTokenFor`/`tokenFor` 的类判定在游戏里全部落空,v1.9.6 的 `classList.contains` 假设也错)。
布局实例:Category×38 / Details×3 / Selector×2 / ShopModsBuild×4。

**共用根因(一次修多个 bug)**:游戏内面板既无 `.class` 字符串、也无 DOM 式 `classList`,
真实形态是引擎绑定 **`panel.BHasClass(name)`**(证据:BabelTower-fork `lingua_chat.js:382/384`
等 13 处已在游戏里验证;本仓库 `temp_extract/ct_check.js:154`;`.pi/.../AGENTS.md` 的
`$.` 29 成员探针里也确认 `BHasClass`/`BAscendantHasClass`/`SetHasClass`)。
→ B3(概览冻结)、B5b(hover 页工具条不隐藏)、以及 tokenFor 全部类键查找死,同源。

| Bug | 假设根因 | 置信度 |
|---|---|---|
| B1 翻译按钮点不动 | 点击未落到 handler 或工具条被几何遮挡;无法离线判 → BBT_DEBUG 打点 + 早间验证 | 中(待日志) |
| B2 下拉栏点不动 | actualx/actualwidth 不可用 → 菜单停在 CSS 回退位置被覆盖;`toolbar-place css-fallback` 打点给证据 | 中(待日志) |
| B3 概述不刷新 | 读类 API 错(BHasClass)→ resync 0 标签;描述模板首译即销毁 → 冻结 | 高 |
| B4 悬停注释不刷新 | `ModifiesLabel` 是歧义类(一个类名两个 `#token`)从未进 resync + 类判定错 | 高 |
| B5a 详情页缺按钮 | 离线不可判 → `toolbar-geom` 打点 + 早间验证 | 中(待日志) |
| B5b hover 页工具条不隐藏 | tooltip 隐藏判定用错类 API → 同源 B3 | 高 |
| P1 帧率 | 见阶段3静态结论 | 高(静态) |

修复顺序:公共根因(BHasClass,覆盖 B3/B5b/tokenFor)→ B4(注释 resync)→ B1/B2/B5a(打点+早间)→ P1(文档)。

## 阶段2 逐项证据(一个 bug 一个 commit)

**B3(`43774aa`)**
- 根因行号:`bba_translate.js` `panelHasClass`(v1.9.6 只查 classList/.class;改后三层 BHasClass→classList→.class)。
- diff 摘要:panelHasClass 三层;VERSION 1.9.7;refresh_verify 行为 Case G(引擎绑定 CategoryDescription 标签 BuildID 身份切换后经 `$.Localize` 刷新到分类描述新译文)+ SRC/LOCALIZE 分类译文。
- 验证方式:refresh_verify 全 PASS(含 Case G);BHasClass 形态与 BabelTower 游戏实证一致。
- 回归检查:无 SetDialogVariable 写回;生成物零改动;probe 一次性门控,无临时日志残留。

**B4(`e356120`)**
- 根因行号:`RESYNC_TOKENS`(无 ModifiesLabel)+ `resyncLabel`(单 token)。
- diff 摘要:RESYNC_TOKENS 第 5 项 `["ModifiesLabel", ["#Citadel_Item_Build_Annotation","#Citadel_ItemModifies"]]`;resyncLabel `cands` 遍历、`usedTok`、`resync-localized`/`resync-defer`(歧义角色不猜 token,恢复最近文本);refresh_verify 静态交叉校验(RESYNC_TOKENS 每个 `#token` 字面量必须 ∈ 生成物 byClassAll——预防未来拼写错误静默漏过)。
- 验证方式:refresh_verify + scene_verify + build_layout_tokens --check 全绿;静态校验断言 RESYNC_TOKENS 5 类 token 全在表内。
- 回归检查:候选一次性试完即停,复用 `localizeProbed` 门控,不新增周期轮询(B4 缓存要求落实)。

**B1(`1f741c6`)**
- diff 摘要:新增 `clickProbe`(debugOn 门控):`onActivate`(translate/refresh 按钮)触发打 `[BBT] click <name> on <tag>`,`uiGuard` 拦截打 `…:guard-skip`。默认零输出。
- 验证方式:ui_button_simtest PASS(打点默认关,不影响 sim)。早间步骤 3。
- 回归检查:无临时日志残留;未改点击几何。

**B2(`02b996b`)**
- diff 摘要:`placeToolbar` 落入 css-fallback 时一次性 dump `[BBT] toolbar-place css-fallback ctl=WxH root=RW off=… actualx=? actualy=?`(`placeProbeDone` 门控);`onActivateChild`(菜单项)/`toggleMenu` 走 clickProbe(`menu->open/close`)。
- 验证方式:ui_button_simtest + scene_verify PASS。早间步骤 4。
- 回归检查:一次性门控,默认零输出。

**B5(`8b16120`)**
- diff 摘要:boot 一次性 `[BBT] toolbar-geom vis=? actual=WxH tag=?`(无工具条时 `toolbar-geom none in this layout`);tooltip 上下文隐藏时打 `[BBT] toolbar hidden in tooltip context (…)`;BuildDetailsTooltip 隐藏判定改走 panelHasClass(B5b 修复)。
- 验证方式:scene_verify + toolbar_cover_simtest PASS。早间步骤 5。
- 回归检查:B5b 属公共根因修复;打点一次性门控。

**P1(`12240e3`)**
- 静态结论:v1.9.7 相对 v1.9.6 **零新增 per-tick 成本**(BHasClass 只在事件路径:resyncAll(40) 每刷新 ≤200 次 C++ 调用、tokenFor 每面板一次性 26 类探测、一次性 probe);现热成本=scan 6000 预算 + 空闲退避 150ms→1s + parked 0.5s(不树走)。
- 计时打点方案:BBT_STATS `ms/interval/scanned/skipped` 四步,阈值 空闲 <2ms / burst <10ms(写进 TODO「四-补」)。

## 遗留问题(早间)

1. 复制 `dist/pak13_dir.vpk` 到 `E:\Steam\steamapps\common\Deadlock\game\citadel\addons\` + 重启 Steam(引擎只在启动时读信任库)。
2. `-condebug` 启动,按 TODO v1.9.7 节 5 步验证:重点看 `resync-ok`/`localize-probe`(B3)、`resync-localized`/`resync-defer`(B4)、`toolbar-geom`/`click`/`css-fallback`(B1/B2/B5a)、`toolbar hidden in tooltip context`(B5b)、`BBT_STATS` 四步计时(P1)。
3. 若 `localize-probe` 显示两参也拿不到值 → 按日志证据定「引擎重渲染」路径方案(下一轮,勿盲改)。
4. 8792/8793 桥不可用为常态(离线模式),非故障。

## 复审修复 ①②(审计否决后自查,已并入重写)

- ① dist VPK 陈旧:推送时 dist 是 v1.9.6 基线产物 → 已重打(本轮按 v1.9.7 终态重打,见上)。
- ② B3 拼写错误(`#Citaled_…`,原 `bba_translate.js:1131`):旧历史由 `74033e3` 修复;
  重写历史**直接消除**(B4 的 RESYNC_TOKENS 保持正确 token,静态交叉校验作预防断言),
  VERSION 终态为 1.9.7(不再是 1.9.7.1),dist 按 1.9.7 重打并二进制校验(0 处 `Citaled`)。
- ③ 提交粒度:初版 B3+B4 / B1+B2+B5 各合一个、非 conventional → 本次重写为 5 个独立 Conventional
  Commit + P1 docs + 本日志,备份 tag `backup-before-rewrite` 保留旧历史可回退。
- ④ 诊断门控不一致(第 4 次审计否决后自查):`resync-fail` 是未门控的重复行、`localize-probe`
  在 debug 关闭时也会输出,与 B3 回归检查「probe 一次性门控,无临时日志残留」矛盾 → `2e6f286`
  统一走 `debugOn()`(v1.9.7 全部 [BBT] 诊断行默认零输出);TODO 早间步骤 ①② 增加 BBT_DEBUG
  前置说明。dist 于 2e6f286 后重打(05:13,4,225,943 B),二进制复校:1.9.7=1、1.9.7.1=0、
  Citaled=0、Citadel_ItemModifies=2、Citadel_Item_Build_Annotation=2、BHasClass=5、
  panelHasClass=10、resync-defer=1、resync-localized=1、toolbar-geom=2、clickProbe=6(全中)。
