# Build UI 汉化（BuildBrowser Translation）— 交付报告 buildui-report

版本 v1.9.27 · 2026-11-06 · 对应任务 `ui-task/`（RALPH R1–R5 + 3 个实机 bug 修复）

## 需求 R1–R5 实现状态

| 需求 | 内容 | 状态 |
|---|---|---|
| R1 | 详情页/概览页双态按钮（默认原文，点「翻译」全页翻，再点回原文） | v1.9.27 完成：按钮移入 `#BBTTabBtnHost`（标题行右端，脱离引擎 `#BuildControls` 行，修复重合 bug ①） |
| R2 | 点「翻译」后当前页内容刷新时保持已翻状态 | v1.9.27 双态全局化（`G.__BBT_TWO_STATE.on` 单一开关 + ver 计数），任意 ctx 点击翻转所有 ctx；`ui_button_simtest` R2 段全绿 |
| R3 | 内嵌分类框保持折叠/不影响引擎 | 维持 v1.9.26 行为（browser 面展开、游戏内嵌框折叠） |
| R4 | 作者注释/分类注释补翻 | 走 `[BBT] MISS` → `collect_new_texts` → TM 管线；双态开关 ON 时 resyncAll 覆盖 BuildDescription 等角色标签 |
| R5 | 游戏内实机验证 | 日志级证据齐（`console.log` [BBT] 行）；**实机点击验证 BLOCKED（保守）——模型无读图能力 + 盲驱动无法稳定打开出装浏览器页**，见 `ui-task/in-game-verification.md` 与 `ui-task/OPEN_QUESTIONS.md`（已打 [保守]） |

## v1.9.27 修复内容（3 个实机 bug）

1. **① 按钮重合（几何）**：`citadel_ui_build_details.xml` 把 `BBTTranslateButton2` + `BBTActMark2` 从引擎 `#BuildControls` 行（Medium Fill 挤压区）移入新 `#BBTTabBtnHost`（`.AuthoringInfo` 标题行右端）；`bba.css` 给 host `position:relative + float:right` + 按钮 `min-width:40px`（pid 15140 的 POS 探针证据：旧 absolute+flow:none 方案按钮 `actuallayoutwidth=0` 不可点 → 改 relative+float 后 CSS 警告清零、按钮 vis=true）。
2. **② 概览页点翻译后顶部 BuildDescription 不翻** + **③ 详情页按钮点击无效/caption 不变**：根因 = 双态按 ctx key 分裂（内嵌页各自独立 JS 上下文，点击只翻转自己 ctx 的 key）。v1.9.27 改**全局单一开关**：`tsMode()/tsSet()` 读/写 `G.__BBT_TWO_STATE.on`（引擎共享 globalThis），tick 双态同步按全局 ver 联动所有 ctx；`wireHeaderButton` 的 button3 改走 `dispatch("translate")`（翻转开关 + 全量 resync + caption 联动）。
3. **收口**：取证临时补丁（`debugOn ||true`、FOCUS/geom3/posprobe 探针）全部 revert；`node --check` clean；10 个离线套件全 PASS；`build_layout_tokens --check` in sync；干净 VPK `dist/pak13_dir.vpk`（md5 48eb5151…）重打部署。

## 实机验证步骤（早间人工 / 有读图能力的环境执行）

1. 启动项加 `-condebug`；确认 `game/citadel/console.log` 出现 `[BBT] v1.9.27 loaded` 行（每布局一条）且 **无** `Unknown panel type in style selector: #BBTTabBtnHost` 警告。
2. 隐藏基地 → 商城/出装浏览器 → 打开任一出装的**详情页**：
   - 期望：标题行右端出现「翻译」按钮，与引擎控件（复制出装/出装选项）**无重合**（bug ① 验收）。
   - 点「翻译」：顶部作者说明（BuildDescription）+ 各分类框注释全页转中文，按钮文案变「原文」；再点：全页回英文，文案变「翻译」（bug ②③ 验收）。
3. 换英雄/换 build 后：已翻状态保持（R2）。
4. console.log 里 `grep "two-state global"` 应看到每次点击一条（key/ver 行）；`grep "BBT] MISS"` 的漏翻文本走 `tools/collect_new_texts.js` 并入 TM 再刷新。
5. 有内嵌帧的面（游戏内 shop）：分类框默认折叠不变（R3），点 header 翻译按钮同样生效（bug ③ 的 button3 路径）。

## 已知限制

- 无读图/OCR 能力时，视觉类验收（按钮实际像素位置/宽度）以 console.log POS 行 + CSS 无警告为代理证据。
- 实时 bridge（8792/8793）离线时，未入 TM 的文本保持英文（设计行为），靠 `[BBT] MISS` 管线累积消化。
