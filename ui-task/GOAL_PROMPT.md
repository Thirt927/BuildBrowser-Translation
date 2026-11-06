# /goal-direct 提示词 —— 出装翻译（任务书 = ui-task/RALPH.md）

用法：在 `F:\agents\deadlockfanyi\出装翻译` 的 pi 终端（或 pi-web 会话）执行：

    /goal-direct （把下面引号内的整段文本作为 objective 粘贴）

---

目标：完成「出装浏览器：翻译交互改造」（需求 R1–R5 + 游戏内实机验证 + 收尾推送），任务书全文在 ui-task/RALPH.md 正文（Task 0–6、Rules、Evidence），以它为准。

执行纪律：
- 每步开工先读（按序）：AGENTS.md（引擎 API 坑 §6 / 生成物纪律 §7 / 无本体工作 §9）→ ui-task/references/design-brief.md（R1–R5 需求与验收清单）→ ui-task/RALPH_PROGRESS.md（查重，不重复劳动）→ 与 R2/R4 相关根因：TODO.md §十四 与 根目录 BUG任务书-出装浏览器.md（B1~B5）。
- 按 Task 编号顺序推进，一次一个主题：0 基线+构建演练+Q5 前置 → 1 REA 逆向分类框结构（结论写 ui-task/rea-notes/build-browser-map.md）→ 2 R1 概览页按钮 → 3 R2 详情页按钮修复（先查共用根因；tests/ui_button_simtest.js 加「多分类框每个都翻」回归断言）→ 4 R4 浏览器页默认原文 + 右侧作者注释补翻 → 5 R5 游戏内验证 → 6 收尾（gate + 推送）。
- 验证手段：基线 `node tests/scene_verify.js && node tests/refresh_verify.js && node tools/build_layout_tokens.js --check`；simtest `node tests/translate_simtest.js && node tests/ui_button_simtest.js && node tests/toolbar_cover_simtest.js`。基线红 → 只按 AGENTS.md 声明的管线修复重跑，仍红则标「基线损坏」继续并记 OPEN_QUESTIONS。

游戏内验证（Task 5，已授权无人值守驱动，CLI = F:/agents/universal-modder/bin/um.cmd win ...）：
- 部署：备份 addons\pak13_dir.vpk → pak13_dir.vpk.bak-<yyyymmdd-hhmmss>，再 powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "E:\dealoc-mod\Reduced_CSDK_12" -Deploy（只动本仓库 pak13，绝不碰原生 pak01 与其他 mod）。
- 驱动：um win ps 查状态 → um win launch --steam 1422450 -- -condebug → um win drive --proc ... "size 1920 1080" → 导航 商城→出装浏览器，逐 R 截图（um win shot --scale 0.33 存 ui-task/shots/）+ 读 E:\Steam\steamapps\common\Deadlock\game\citadel\console.log 的 [BBT] 行 → um win kill <pid> 收场。
- 安全纪律：批量输入前 um win idle（人在用 → 停手记 P0）；只 um win kill 精确杀，禁通配 taskkill；菜单坐标记 ui-task/rea-notes/menu-points.md。
- 证据写 ui-task/in-game-verification.md：每个 R 一行 IN_GAME: PASS/FAIL/BLOCKED(原因) + 截图路径 + [BBT] 日志摘录；FAIL → 继续修不算完成；启动不了 → 全 BLOCKED + 原因记 OPEN_QUESTIONS（P0，打 [保守] 标记）。

红线（硬约束）：
- 禁命令：rm -rf、rd /s、del /s、format <盘符>:。
- 受保护文件（不得手改/直接覆盖）：mod/panorama/scripts/bba_tm.js、bba_glossary.js、bba_layout_tokens.js（生成物，只能管线重生成）；tools/cache/**、dist/**、*.pem、*.key。
- 布局改动必须过 build_layout_tokens.js --check；引擎坑（Label 源+探针不回退、不加分期轮询、SetPanelEvent 绑定、hittest 规则、多 JS 上下文守卫）逐条遵守。
- 日志/报告/commit 不得出现真实 API Key / SteamID64。
- 状态措辞：实机未验证只准写「代码完成，待游戏验证」；验证过才写 IN_GAME: PASS；验证不了写 BLOCKED(原因)。
- 拿不准 → OPEN_QUESTIONS.md（P0 不阻塞主线：选不动代码的保守方案继续，条目打 [自批]/[保守] 标记）。
- git push 唯一通路：node ui-task/scripts/completion_gate.js 输出 GATE: PASS（exit 0）并写入 ui-task/PUSH_OK（pre_push_sha）后，且 pre_push_sha == 当前 HEAD，才可 git push；Conventional Commits 逐 R 提交、不夹带；推送记录（SHA 列表 + pre-push SHA）写 overnight-log.md 顶部。

完成条件（全部满足才算完成）：
1. ui-task/scripts/ui_check.js 全绿（含 R2/R4 新增 simtest 断言）。
2. node ui-task/scripts/completion_gate.js 逐项 GATE: PASS（报告/TODO/overnight-log/OPEN_QUESTIONS P0 清空/commits/游戏证据/PUSH_OK 机械核对）。
3. 游戏内证据 in-game-verification.md 每个 R 的 IN_GAME 行齐全（无 FAIL；启动不了则 BLOCKED + OPEN_QUESTIONS [保守]）。
4. ui-task/ 任务文件夹、overnight-log.md 等记录全部 commit，git 工作区干净。
5. 已按 PUSH_OK 通路执行 git push 并记录（gate 未过则明确写「未推送，原因 = gate FAIL 项」）。
