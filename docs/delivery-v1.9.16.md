# v1.9.16 交付报告（2026-11-02）

任务书：`F:\agents\pi-1\BUG任务书-v1916.md`（用户 m02581：弃用下拉，单「翻译」按钮点击走桥；
概览页去按钮；换出装刷新审计；MISS 补库；开浏览器卡顿削减；桥自检工具）。
实机证据 = 任务书 §2（console.log 2026-11-01 21:49 / 22:43 两段）。

## 各任务项

### T1 删除下拉 + 三模式，单「翻译」按钮点击走桥
- **根因**：v1.9.15 下拉是静态定位无锚定，实机"凭空出现、只露 2.2 行"（§2.2），用户放弃。
- **diff 摘要**：
  - `citadel_ui_build_details.xml:83-84`：删 `#BBTMenu2` 整块（5 菜单项 + 分隔线）；
    触发器 `#BBTTranslateButton2` 的 `onactivate/onmouseactivate` 改为 `BBTActivate('translate', $.GetContextPanel())`。
  - `bba.css`：删 `#BBTMenu2/.BBTMenuItem/.BBTMenuSelected/.BBTMenuSeparator/.BBTMenuOpen` 规则。
  - `bba_translate.js`：删 `toggleMenu/closeMenu/refreshMenuSelected/MODE_LABELS UI/BBTSetLanguageMode`；
    `dispatch` 删 `menu:toggle/mode:*` 分支；`actionWindow('translate')=600ms`；
    点击 = `translatePage`：离线 TM 先行，剩余 MISS 批量送桥（`uiRequestBatch` 通道），
    **探活改为点击时按需**（boot 只记基线，运行中桥起来首次点击即生效，不用重启游戏）；
    反馈文案 正在连接桥… → 已译 N 条 / 桥未连接(N 条缺) / 无新译文(N 条缺)，1.6s 复位「翻译」。
- **验证**：`wiring_simtest`（[1] 单触发器 + 菜单节点/路由全 absent；[2]/[3] 触发器即刷新入口；
  [5] 无 SetPanelEvent 时 inline 路径仍能发起翻译；[6] `act:translate@` marker 去重、
  BBTMenuOpen 全程未出现）、`toolbar_cover_simtest`（菜单节点不存在 + 单按钮在）、
  `own_chrome_simtest`（菜单项 BBTNoTranslate 断言删除）、`ui_button_simtest`（按需探活 0.5s 回退时机）、
  `live_channel_simtest` 回归。
- **回归**：12 套 + 3 基线全绿。
- **commit**：`72f5f7f`（另两个注释净化 commit `894ddf8` / `f8311cf` 保证 dist 里 `BBTMenu2=0`）。

### T2 概览/分类页不显示触发按钮
- **根因**：概览页详情布局被引擎 `BuildDetails_Overview` 嵌入，引擎"出装选项"按钮压住我们
  的触发器（hittest 被吃），且该页本来就由轮询扫描自动翻译，不需要按钮。
- **diff 摘要**：`bba_translate.js` `wireToolbar` 接线前做 ≤16 层祖先链检查（`nestedInOverview`，
  同 `nestedInDetails` 模式），祖先 tag 含 `CitadelShopModsBuildCategory` 或 `BuildDetails_Overview`
  → 触发器 `visibility:collapse + hittest=false`，并记一行（BBT_DEBUG 门控）
  `[BBT] trigger hidden in overview context (<tag>)`。普通详情页里 `BuildDetails_Overview` 是
  `#BuildControls` 的兄弟节点不会误伤。
- **验证**：`wiring_simtest` / `toolbar_cover_simtest` fake 祖先链断言；实机 = 任务书 §5 第 1 步。
- **回归**：12 套全绿。
- **commit**：`7cdce1c`。

### T4 换出装刷新：resync 候选静态审计
- **结论**：`RESYNC_TOKENS` 五个组（BuildName/BuildDescription/CategoryDescription/ModifiesLabel
  双候选/viewImpactLabel）全部在生成表 `byClassAll` 内，候选 token 与布局表完全一致
  → **无需新增候选**；"换装后停留旧译文"的残留根因 = TM 缺文本 + 桥没开（§2.3/2.4），
  由 T5 + T1 双管齐下；换装仍会经身份标签探针触发有界 `resyncAll(40)` 重扫窗口。
- **验证**：`refresh_verify` 新增 **Case I**（任务书"T4 Case H"，H 已被 v1.9.8 token-repair
  用例占用）：RESYNC_TOKENS 字面量必须逐条命中 `byClassAll` 声明候选。
- **commit**：`91b522f`。

### T5 MISS 收割进 TM
- **验收**：§2.4 榜单前 20 条 key（`mozga0-17nwp56`、`owebiq-1vx6j90`、`y4dxfw-15f3ilq`…）
  全部能在 `bba_tm.js` 查到；TM 58,621 → 58,631；`[Lockbuilds.com]/[tracklock.gg]` 原文保留；
  `tm_table_simtest` + `tools_simtest` 全绿。
- **commit**：`77251d9`。

### T6 卡顿：burst 分块削减 + MISS 日志去噪（只削不加）
- **diff 摘要**：
  1. `SCAN_BUDGET` 6000 → 2000/tick，`scanCarry` 持久断点（预算截断的 tick 从断点续扫，
     不再丢 6000 个未访面板下 tick 重头来）；burst×4 保留但每块封顶。
  2. `G.__BBT_MISS_LOGGED`（globalThis）会话级去重：同一 key 全 12 个上下文只记首条 MISS，
     消除 §2.4 的 ×17 刷日志（同时减 I/O）。
  3. 全 memo 树快退：某 root 一次干净 walk（carry 耗尽、0 写入、0 新面板、0 跳过）后打
     `stableRoots` 快照（身份标签文本 + 子节点数），后续 tick 只探针不走树；换出装/新面板
     自动失效重扫。`BBT_STATS.stableSkips` 可观测。
- **红线**：无新增周期性全量重扫；`BBT_STATS.interval` 语义不变。
- **验证**：`scene_verify` / `toolbar_cover_simtest` 全绿；burst <10ms 由早间 `BBT_STATS.ms`
  实测确认（§5 第 5 步）。
- **commit**：`19d88f6`。

### T3 桥连通：检查器
- **交付**：`node tools/bridge/check.js`（只读）：TCP 探 8792（DeadlockLingua 桥）/8793（本仓库桥）
  + `certutil -store -user Root` 检查受信证书，打印 `8792 ready` / `8793 ready`；
  两者都 down 时给出下一步（起 `tools/bridge/bridge.js`；证书缺失 → 导入后**完全重启 Steam**，
  引擎只在启动时读信任库）。本次运行：`8792 ready`（BabelTower 桥在跑，`CN=BabelTower-localhost`
  已在 CurrentUser\Root）。
- **commit**：`29221f1`（README 桥一节同步加了自检一行）。

## 回归 + 构建 + 部署

- 12 套离线测试全 PASS（translate/tools/scene/refresh/fragment/live_channel/tm_table/
  ui_button/vpk_list/toolbar_cover/wiring/own_chrome），3 基线（scene_verify / refresh_verify /
  `build_layout_tokens --check`）+ `tm_export` 全绿。
- dist 二进制抽检（`dist/pak13_dir.vpk`）：`1.9.16`=8 ✓、`BBTMenu2`=0 ✓、`menu:toggle`=0 ✓、
  `trigger hidden in overview context`=1 ✓、`__BBT_MISS_LOGGED`=2、`正在连接桥`=1、`桥未连接`=2 ✓。
- **dist**：`4,261,843` 字节，mtime 2026-11-02 17:35。
- **部署**：`E:\Steam\steamapps\common\Deadlock\game\citadel\addons\pak13_dir.vpk`
  （v1.9.16 首次部署，addons 里此前无 pak13，故无 .bak；`cmp` 校验一致）。

## git log（origin/main，2026-11-02）

```
f8311cf chore(toolbar): reword v1.9.15 dropdown mentions in xml/css comments
894ddf8 chore(toolbar): drop last BBTMenu2 literal from explanatory comments
29221f1 feat(bridge): read-only morning bridge health check (T3, v1.9.16)
19d88f6 perf(scan): chunk the tree walk, dedupe MISS logging, fast-exit stable trees (T6, v1.9.16)
91b522f test(resync): static RESYNC_TOKENS audit vs layout token table (T4, v1.9.16)
7cdce1c fix(toolbar): hide the 翻译 trigger on overview/category surfaces (T2, v1.9.16)
72f5f7f refactor(toolbar): drop the dropdown, single 翻译 button click goes to bridge batch (T1, v1.9.16)
77251d9 feat(tm): harvest in-game MISS lines into TM (T5, v1.9.16)
```

## 待游戏验证（早间清单 = 任务书 §5）

0. `node tools/bridge/check.js` → 8792/8793 ready（本次 8792 ready ✓，桥在跑）。
1. 重启游戏（`-condebug`，`globalThis.BBT_DEBUG = true`）→ 概览/分类页无我们的按钮、
   不压"出装选项"（看 `[BBT] trigger hidden in overview context`）。
2. 浏览器详情页：单个「翻译」按钮（无下拉箭头），点开不再"凭空 2.2 行"。
3. 点「翻译」：桥通 → 依次 翻译中… → 已译 N 条；物品短句注释出中文。
4. 换新出装（Drifter 类）：名称/描述/注释 1 个 burst 内刷新（看 `resync-*` 行）。
5. 点"浏览出装"不再顿（记 `BBT_STATS.ms` / `stableSkips`）。
6. §2.4 榜单文本开箱即中文（T5，不依赖桥）。
以上 1–6 若仍复现 → 待游戏验证（代码侧已完成）。
