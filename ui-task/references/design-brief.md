# Design Brief — 出装浏览器：默认原文 + 按钮翻译 交互改造

> 依据：用户 2026-11-03 需求描述 + 项目 `BUG任务书-出装浏览器.md`（B1~B5）+ `TODO.md` §十四。
> 动手前必读 `AGENTS.md` §6（引擎 API 坑）与 `TODO.md` 相关章节。

## 需求清单（用户原话映射）

| 编号 | 需求 | 现状 |
|---|---|---|
| R1 | **概览页**：描述默认显示**原文**，加「翻译」按钮，点一下翻成目标语言（再点「原文」切回） | 概览描述未翻译（离线 TM 没覆盖到），也没有按钮 |
| R2 | **详情页**：翻译按钮 UI 已和游戏风格一致，但**功能没实现**：①点击不切换按钮文案「翻译」↔「原文」；②翻译效果不生效（用户实测：只有**最后一个分类框**的注释闪烁了一下） | v1.9.17 有 displayOrig 门与 `wireToolbar`，但详情页路径失效；高度疑似标签集合只解析到最后一批生成的分类 Label，或 `resyncAll` 只重解析了尾部子树（对照 TODO §十四 resync 根因） |
| R3 | **逆向地基**：详情页用「出装分类」长方形框做分类——用 **REA MCP** 逆向游戏原生出装浏览器布局，搞清分类框的结构（布局、class/token、注释挂在哪些 Label） | 仓库里是 S2V 反编译 + 注入的覆盖布局；原生结构对照见 `tools/get_layouts.ps1` 产物与 `docs/`；结论落 `ui-task/rea-notes/build-browser-map.md` |
| R4 | **出装浏览器页**：左侧出装名称**不要自动翻译**——默认原文，点「翻译」按钮才翻；同时右侧出装概览的**作者注释**要能翻译（目前漏翻） | 左侧名单是自动翻译的（扫描器命中 `BuildName`）；右侧概览作者注释不在 TM 覆盖内 |
| R5 | 交付：离线全绿 + VPK 重打 + 报告 + 早间待办（游戏验证步骤）+ 逐 R commit；推送门槛满足才 push | — |

## 用户已知晓且认可的部分（不要动）

- 分类注释、物品注释、概览注释的**离线翻译**（TM 流水线产物，「离线做的」= 预期行为，保留）。
- 术语表 / 装备名替换机制（`build_glossary.js`、占位符流水线）。

## 设计约束

- 按钮视觉沿用现有工具条风格（游戏原生 `TextButton` 观感，见 `wireToolbar` 注释 v1.9.x）——用户明确说「详情页翻译按钮的 UI 设计跟游戏相符」，**UI 不再改，只修功能**。
- 「默认原文」是产品决策：扫描器对 `BuildName` 类身份/名称标签加 `displayOrig` 默认门（R4），译文只在用户点按钮后可见。
- 译文来源不变：离线 TM → 整句兜底 → 术语兜底 →（可选）实时 bridge；作者注释漏翻 = 把对应 key 纳入 `collect_new_texts` / TM 准入（走管线，不手改 `bba_tm.js`）。
- 按钮文案三态（翻译/原文/中英对照）机制已存在（v1.9.17），修 R2 时复用，不要新发明。
- 性能铁律（AGENTS.md §6.10）：不新增周期性轮询；本任务纯交互改动，热路径零新增。
- **游戏内验证自动化（用户 2026-11-03 授权）**：用 universal-modder `game-automation` 技能的 `um win` 驱动（启动 `-condebug`、窗口化、点击/按键、截图、读 `console.log` 的 `[BBT]`）；安全纪律：操作前 `um win idle`、`um win kill <pid>` 精确杀、只复制 `dist/pak13_dir.vpk` 进 addons（不碰原生 pak01/其他 mod）、会话短；证据落 `ui-task/in-game-verification.md`（逐 R `IN_GAME: PASS/FAIL/BLOCKED` + `ui-task/shots/` 截图 + 日志摘录）。

## 验收（对应 RALPH.md Completion）

1. `ui-task/scripts/ui_check.js` 全绿（含循环补进 `ui_button_simtest` 的断言：多分类框场景每框注释都被翻译；浏览器页默认原文不自动翻）
2. `docs/buildui-report.md`：每个 R 的根因（文件:行）/ diff 摘要 / 验证方式 / 回归检查（B1~B5 症状是否受影响，逐项）
3. `TODO.md` 追加 + `overnight-log.md` 记录（挂机模式 §6 格式）
4. VPK 重打成功（`dist/pak13_dir.vpk` 新时间戳）；**不**复制到 Steam、**不**启动游戏
5. **游戏内验证（um win 自动驱动）**：`ui-task/in-game-verification.md` 逐 R `IN_GAME: PASS`（截图 + `[BBT]` 日志）；无法启动游戏 → `BLOCKED(原因)` + `OPEN_QUESTIONS.md` 记 [保守]，剩余人工步骤才攒进「早间待办」（3 分钟粒度）

## 根因线索（起点，需自己证实）

- R2「只有最后一个分类框闪烁」：详情页分类框是**动态生成**的 Label 集合；`translatePage(root)` 的 `rootOf(panel)`/`pageRoot` 若只拿到最后一批节点，或 `resyncAll` 的 token 解析漏了早先生成的框 → 检查 `bba_translate.js` 的 `scanCtx.root` 绑定（v1.9.17 displayOrig 门处）与 `wireToolbar` 两条启动路径（§2161 注释：两条路径都可能启动工具条动作）。
- R4：`bba_translate.js:1310` 附近的角色类集合含 `BuildName`；默认自动翻就是扫描器无门控命中它 → 加默认原文门（键名自定，挂 `globalThis.BBT_*` 可运行时改）。
- B5「右上角感叹号 hover 展开页面的翻译按钮点不中」：与 R2 很可能同根（`hittest` 遮挡，AGENTS.md §6.6）——修 R2 时一并查。
