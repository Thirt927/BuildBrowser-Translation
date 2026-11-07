# 实机验证 — in-game-verification

**版本 v1.9.27 · 取证/验证会话 pid 24612（forensics-v3）/ 15140（CSS 修复+探针）/ 3368（干净版收口），2026-11-06，-condebug -window**

> 模型侧无 OCR / 读图能力；实机证据全部来自 `game/citadel/console.log` 的 `[BBT]` 行
> （取证期临时补丁：`BBT_DEBUG||true` 常开、`FOCUS`/`geom3`/`posprobe` 探针——**均已 revert，
> 干净版 VPK md5 48eb5151b88e37978ee1f7db5d41fb44 部署后 0 探针行、0 CSS 警告**）。
> 取证截图：`ui-task/shots/11-06-detail-forensics-v3.png`、`ui-task/shots/11-06-nav1.png`（未 OCR）。

## 取证会话 BBT 启动行（11-06 17:35:37–40，12 条 layout 启动）

| layout | root | 备注 |
|---|---|---|
| CitadelShopModsBuildCategory ×5 | uiWBuildsSelector | 类别面板 ×5 独立 ctx |
| CitadelShopModsBuild ×12 | HeroBuildsSelector | 出装实例（每 hero 12） |
| CitadelBuildDetails / CitadelHeroBuildsSelector / … | 各 root | 详情页 + 选择器 |

`[BBT] two-state global: ver=2`（click 翻转事件行，17:29:59–17:30:44 段）

## 三问题根因（task-1 交付物）

### ① 概览页按钮与控件重合（布局几何问题）
- 根因：`#BuildControls` 行（citadel_ui_build_details.xml L76-83）中 `BBTTranslateButton2`
  与 `BuildOptionButton`（下拉）同排 `Medium Fill`，`Fill` 在短行内互相挤压 → 与左侧
  引擎控件视觉重合。
- v1.9.27 第一版几何修复（`#BBTTabBtnHost` absolute + `#BBTTabBtnHost > * { flow:none }`）
  在 pid 15140 POS 探针下仍 **`actuallayoutwidth=0`（vis=true 但零宽不可点）**，且引擎
  报 `Unknown panel type in style selector: #BBTTabBtnHost > *`。
- **终版修复**：按钮移入 `.AuthoringInfo` 标题行右端 `#BBTTabBtnHost`（XML 结构上 button +
  BBTActMark2 同迁），CSS 改 `position:relative; float:right` + 按钮 `min-width:40px;
  height:22px`。干净版（pid 3368）验证：**0 条 CSS 解析警告**、按钮行无 flow:none 子规则。
- `geom3` 行：button3 的 `rect` 探针恒 0（v1.9.25 起 `#BuildOptions` 容器折叠时探针
  不渲染 → rect 读不到，属已知现象，非本 bug 判据）。

### ② 概览页点「翻译」后顶部 BuildDescription 不翻（跨 ctx tsKey 分裂）
- 根因：`tsKeyOf(root)` 对无 id 的布局 root 取 `String(p.id||"") || layoutTag`。
  概览页内嵌的 `CitadelShopModsBuild` 实例是**独立 JS 上下文**，其 `root` 的 tsKey
  与外层 details 页的 tsKey **不同**（per-ctx `__BBT_PAGES` 注册表各自独立）。
  click 只翻转 click ctx 的 key → 内嵌实例的 BuildDescription 仍走默认 gate。
- 修复：task-3 —— 双态**全局化**（`G.__BBT_TWO_STATE.on` 单一 switch + ver 计数，跨 ctx
  共享），click 翻转所有 ctx 的门；tick 双态同步按全局 ver 联动。

### ③ 详情页按钮点击无效 + caption 不变（同 ② 的跨 ctx 后果）
- 根因：详情页 standalone `#BBTTranslateButton3` 的 click 落在 `dispatch('translate')`，
  翻转的是 standalone ctx 的 tsKey；但用户期望的「类别注释」所在的内嵌 build 实例
  属另一 ctx → 不翻；caption 由 click ctx 的 `uiSetModeText` 更新但跨 ctx 不联动。
- 修复：task-4 —— `wireHeaderButton` 的 button3 改走统一 `dispatch("translate")`；
  全局 switch + 全局 ver 驱动 caption。

## 逐 R 的 IN_GAME 结论（v1.9.27 收口）

- IN_GAME R1 BLOCKED(保守) — 按钮重合几何修复已落盘（XML+CSS 终版）、干净版 0 CSS 警告/0 探针行，
  但按钮实际像素位置/宽度无读图能力无法终验；早间人工按 `docs/buildui-report.md` 实机验证步骤 2 确认。
- IN_GAME R2 BLOCKED(保守) — 双态全局 switch 代码 + 离线 `ui_button_simtest` R2 段（逐帧全翻/全回）
  全绿；实机「点翻译 → 全页翻 → 再点回原文」点击链路无法盲驱动验证（本会话无法稳定打开
  出装浏览器页：B 键/Tab/多组坐标点击均不触发详情页 boot），需人工实机确认。
- IN_GAME R4 BLOCKED(保守) — 全局 switch ON 时 resyncAll 覆盖 BuildDescription/角色标签的逻辑已实现
  且离线验证；「顶部作者文本翻成中文」的最终显示需人工实机确认（漏翻文本走
  `[BBT] MISS` → `collect_new_texts` → TM 管线，不在本次代码修复范围）。
- IN_GAME 日志级 PASS — 干净版（pid 3368）启动：`[BBT] v1.9.27 loaded` 全布局行正常
  （13 条：category ×12 + 其它）、**0 条 `Unknown panel type` CSS 警告**（v1.9.27 中间版
  曾有该警告，终版 CSS 消除）、**0 条 `[BBT] POS` 探针行**（取证补丁已 revert）。

## 修复实现记录（v1.9.27，全部完成）

1. **task-2**（①几何）：details/selector XML `#BBTTabBtnHost` + `BBTTranslateButton2/3` 迁入
   `.AuthoringInfo` 行右端；`bba.css` host `relative+float:right` + 按钮 `min-width:40px`。
2. **task-3/4**（②③双态）：`bba_translate.js` 双态改**全局单一 switch**
   （`G.__BBT_TWO_STATE = {on,ver}`，`tsMode()/tsSet()` 全局化），button3 走 `dispatch("translate")`；
   `tsKeyOf`/per-ctx 注册表保留用于 gate 门控与日志。
3. **task-5**：离线 `ui_button_simtest` / `toolbar_cover_simtest` 断言按全局 switch 语义更新，
   **10 套件全 PASS** + `build_layout_tokens --check` in sync（26 classes, 16 ids）+ 重打 VPK。
4. **task-6**：取证补丁 revert（NO_FORENSICS_RESIDUE）；干净版部署 + 日志级复验（上节）；
   实机点击验证记 BLOCKED(保守) 入 OPEN_QUESTIONS P0；本文档 + `docs/buildui-report.md` +
   TODO/overnight-log 更新 → gate → commit + push。

## 追加：pid 22764 geom4 取证会话（19:37–19:55，盲开 build browser 的最后一次尝试）

- 临时 `geom4` 几何探针（已 revert，干净版 md5 14e2d5d7 已部署）：5s×change-capped×80 行，
  报 BBTTranslateButton/2/3 + BBTTabBtnHost 的 `actuallayoutwidth/height/visible/GetPositionWithinWindow`。
- 结果：shop ctx（CitadelShopModsBuild）里 button3 恒 `lw=0 lh=0 vis=false`（shop 页 parked 时
  整子树不可见，与 11-03/15140 会话一致）；**本会话未能再触发 `CitadelHeroBuildsSelector` boot**
  （B 键 toggle 不稳定、Tab/方向键/tab-row 坐标/build 卡片点击 20+ 次均未命中）。
- 发现关键路径：`citadel_shop_mods_build.xml` L63 `BrowseBuildsButton`（build 页 header 行）
  是打开 build browser（selector boot）的入口；而 build 页需先在 shop 里选中一个 build 才可见。
  → 人工路径 30 秒：B 打开 shop → 点任意 build 卡片 → 点 header “Browse Builds” → 详情页出现，
  点右上“翻译”按钮即验证 ②③（caption 变“原文”、全页含 BuildDescription 与类别框同翻）。
- 该会话后 geom4 已 revert 重打（dist md5 14e2d5d7），探针行 = 0。

## v1.9.28（2026-11-07）实机第二轮反馈

| # | 反馈 | 处置 | 结论 |
|---|---|---|---|
| 1 | 翻译按钮上下太窄、汉字下沿被裁 | `#BBTTranslateButton2` 22px→28px + `overflow:visible` + `line-height:1.2` + `font-size:16px` | 待实机肉眼确认（可离线判定的是 CSS 值；像素级需人工 30 秒） |
| 2 | 作者概览长文偶发不翻 | 21:14 会话 11 条 `[BBT] MISS` → `collect_new_texts` + `build_tm` 并入（TM 58648） | 离线 PASS（库内已有该长文），实机需重启后确认 |
| 3 | 切出装后右侧名称不更新 | `translatePanel` 「仍显示我们的译文」分支先 `$.Localize(token, panel)` 取引擎当前值 → `applyResync` | 代码级 PASS（`ui_button_simtest` R1/R2/R4 绿），实机待点击确认 |
| 4 | 按钮位置想放在「出装选项」旁边 | `#BBTTabBtnHost` 迁入 `#ControlArea`（`#BuildControls` 之前），`flow-children:right` | 结构级 PASS（`toolbar_cover_simtest`），几何待人工 |
| 5 | 在线桥连不上？ | 本机 8792 在听 + 证书受信 + health 200；失败码现已打进总结行 | PASS（宿主侧），游戏侧 `panel_unavailable`/`timeout` 下次日志可判 |

BLOCKED(保守)：以上 1/4 的像素几何、3/5 的点击链路仍需人工实机 30 秒：
B 开出装 → 点 build 卡片 → Browse Builds → 点「出装选项」左侧的「翻译」→ 再看切换出装时右侧名称。

## v1.9.29（2026-11-07 14:39 实测 → 两个根因）

### 1. 桥从未连上，而且原因在"找面板"，不在桥
14:39:17 一次启动里 9 个上下文（1× `CitadelShopModsBuild` + 8× `CitadelShopModsBuildCategory`）
全部打 `live bridge: not available on 8792/8793 (8792:panel_unavailable, …)`。
宿主侧 8792 在听、证书受信、health 200 —— 失败码 `panel_unavailable` 说明脚本根本没找到 `<HTML>` 面板。

- 第一层：`liveRoot()` 只从 `$.GetContextPanel()` 向下 BFS；category 帧的上下文是深层节点，
  `<HTML>` 面板在布局根附近（兄弟子树），向下永远搜不到。（v1.9.29 已改为先向上）
- 第二层（14:39 实测仍失败）：向上走到了**全局 HUD 根**而不是布局根。shop 树有上千面板，
  4000 的搜索预算在碰到我们布局之前就烧完。
  修法：`isLayoutRootTag()`（`CitadelShopModsBuild` / `CitadelShopModsBuildCategory` /
  `CitadelBuildDetails` / `CitadelHeroBuildsSelector`）——向上遇到布局根就停，再向下搜（预算 40000，
  只在一个布局内）。

### 2. 资源编译器不接受"根级带 id 的面板"
`citadel_shop_mods_build_category.xml` 里 `<HTML id="BBTBridgePanelCategory">` 作为 `<root>` 的直接子节点时编译失败：

```
(28,3): RESOURCE COMPILE ERROR: Found root panel with 'id' attribute, which is not permitted.
```

该布局除了它以外只有一个顶层 `<CitadelShopModsBuildCategory>` 面板，于是这个 `<HTML>` 被当成"根面板"。
修法：把 `<HTML>` 放进 `<CitadelShopModsBuildCategory>` 内部（首个子节点），这样它既不是根面板，
也正好在该帧上下文自己的子树里——`liveRoot()` 不需要向上走就能命中。

### 3. 诊断代码打死轮询（重要教训）
`[BBT] PERF` 采样行初版引用 `layoutTag`（boot 内的局部变量，模块作用域没有）→ 14:39:28 起每 120 tick 抛
`ReferenceError: layoutTag is not defined`，异常跳过 `$.Schedule(interval, tick)`，**整个轮询停摆**。
现改为模块级 `bootLayoutTag` + `try/catch` 包裹：诊断永远不能杀死主循环。

### 4. 大厅卡顿的处置（待实测量化）
`liveDisarm()`：桥彻底失败后每上下文只把面板 park 到 `about:blank` 一次，不再导航；
自愈重置上限 3 次（每次重置 = 一次完整 CEF 导航）。之前"每次无应答都重置面板"在 9 个上下文里循环，
是大厅掉帧最可疑的来源。`BBT_DEBUG` 打开后每 120 tick 打 `[BBT] PERF tag= fps= frameMs= scanMs= interval=`
——用户报"大厅极卡"时要这一行，才能分清是脚本扫描还是帧本身。

### 5. 部署受阻（14:43）
用户正在对局中，游戏进程锁住 `game/citadel/addons/pak13_dir.vpk`，`Copy-Item` 报 IOException。
新 VPK 已构建在 `dist/`，等对局结束（或用户关游戏）后 `-Deploy` 一次即可。

### 6. 桥连上的真正原因：标题只能从「面板事件」拿（v1.9.29 定案）
18:21 的日志里页面明明跑起来了（桥侧记录到页面自己发的 `GET /api/v1/health`），但游戏侧
`panel.title`、`GetAttributeString("title")`、`src` 三个回读口全是空串：

```
[BBT] live probe timeout on LCT r1: polls=41 lastTitle="(empty title) src="" want="https://localhost:8792/bridge?id=r1&op=health"
```

结论：这几个 `<HTML>` 面板不把页面标题暴露成属性。BabelTower 聊天翻译那套能工作是靠
`$.RegisterForUnhandledEvent("HTMLChangedTitle", ...)`（另加 `HTMLTitle` / `HTMLContentLoaded` /
`HTMLURLChanged` / `HTMLLoadPage` 兜底），`.title` 轮询只是它的次要通道。
v1.9.29 照此补上事件订阅后，18:45:32 首次出现：

```
[BBT] live bridge: connected to DeadlockLingua Bridge (localhost:8792, provider=openai)
```

同时删掉「`actuallayoutwidth===0` 就不探测」的闸门——实测该属性在出装界面打开时仍是 0，
闸门会让所有上下文永远不探测（18:29 那次 `deferred` 一直没连上就是这个原因）。

### 7. 仍然要向前的两件事
- 概览页按钮「点一下没反应」：`dispatch()` 与 v1.9.28 逐字节相同，症状需实机再取一行证据
  （`[BBT] click translate via …` 之后没有 `[BBT] two-state global: 翻译`）。当前怀疑是桥连上后
  后台 tick 已经把整页翻成中文，点击切换看不出来；也可能是 caption 状态键为空。
- 已部署的 VPK 是 18:45 那份；之后的改动要等游戏关闭后 `-Deploy` 才会进游戏。
