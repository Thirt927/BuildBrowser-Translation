---
commands:
  - name: baseline
    run: node tests/scene_verify.js && node tests/refresh_verify.js && node tools/build_layout_tokens.js --check
    timeout: 300
  - name: simtests
    run: node tests/translate_simtest.js && node tests/ui_button_simtest.js && node tests/toolbar_cover_simtest.js
    timeout: 300
  - name: git-log
    run: git log --oneline -10
  - name: gate
    run: node ui-task/scripts/completion_gate.js
    timeout: 300
    acceptance: true
args: []
max_iterations: 30
timeout: 900
reflect_every: 5
completion_promise: BUILD_UI_COMPLETE
completion_gate: required
required_outputs:
  - OPEN_QUESTIONS.md
  - PUSH_OK
stop_on_error: false
guardrails:
  block_commands:
    - "rm\\s+-rf"
    - "rd\\s+/s"
    - "del\\s+/s"
    - "format\\s+[a-z]:"
  protected_files:
    - "mod/panorama/scripts/bba_tm.js"
    - "mod/panorama/scripts/bba_glossary.js"
    - "mod/panorama/scripts/bba_layout_tokens.js"
    - "tools/cache/**"
    - "dist/**"
    - "*.pem"
    - "*.key"
    - "policy:secret-bearing-paths"
---

# 出装浏览器：翻译交互改造循环（默认原文 + 按钮翻译）

## Orientation
你是 Ralph 循环中的自主编码代理，每轮全新上下文。进度靠 git、`ui-task/RALPH_PROGRESS.md`、代码本身。
每轮开工先读（按序）：
1. `AGENTS.md` — 项目铁律（引擎 API 坑 §6、生成物纪律 §7、无本体工作 §9）
2. `ui-task/references/design-brief.md` — 本任务需求（R1–R5）、验收清单、红线
3. `ui-task/RALPH_PROGRESS.md` — 上轮进度（查重，不重复劳动）
4. 与按钮点击/不刷新相关的根因：`TODO.md` §十四 与根目录 `BUG任务书-出装浏览器.md`（B1~B5，很可能与本任务 R2/R4 共用根因，先读再动手）

工作目录 = 项目根 `F:/agents/deadlockfanyi/出装翻译`。

## Evidence
### 基线三条（1 分钟验证）
{{ commands.baseline }}

### 关键离线 simtest
{{ commands.simtests }}

### 近期提交
{{ commands.git-log }}

基线红 → 只按 AGENTS.md 声明的管线（build.ps1 / refresh_tm.ps1 / 重新生成生成物）修复并重跑；仍红则标「基线损坏」，继续不依赖它的任务项，记 `ui-task/OPEN_QUESTIONS.md`。

## Task（每轮一个主题，按编号推进）

0. **首轮**：基线三条 + 构建演练（`powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "E:\dealoc-mod\Reduced_CSDK_12"`，产物 `dist/pak13_dir.vpk` 新生成即可，**不部署到 addons、不启动游戏**）；写初始 `ui-task/OPEN_QUESTIONS.md`；确认 universal-modder 技能可用（`C:\Users\Lenovo\.pi\agent\skills\reverse-engineering` 存在）；Q5 前置检查（`um win ps` 看 Deadlock 状态；**试启动一次** `um win launch --steam 1422450 -- -condebug` 验证可驱动性，看完 `um win kill <pid>`；启动不了 → 按 [保守] 记 BLOCKED，不阻塞主线）。
1. **逆向地基（R3）**：按 `reverse-engineering` 技能 rule-zero（读真实产物，不猜），用 REA MCP 检查游戏原生出装浏览器资源（native VPK / 反编译 vxml_c / 本仓库 `mod/panorama/layout/*.xml` 对应的原生布局）：重点搞清**详情页的「出装分类」长方形框**的结构（哪个布局、哪些 class/token、分类注释挂在哪类 Label、与 `#Citadel_HeroBuilds_*` token 的对应）。结论写 `ui-task/rea-notes/build-browser-map.md`（原始产物留 task 目录，不进 git 仓库）。
2. **R1 概览页按钮**：概览（build overview）的描述默认显示**原文**；工具条/页面上的「翻译」按钮点一下 → 切目标语言译文；再点「原文」切回。复用现有 v1.9.17 displayOrig 门与 `wireToolbar` 机制，最小改动。
3. **R2 详情页按钮修复**：点「翻译」必须真正生效且按钮文案切换「翻译」↔「原文」。先查共用根因（用户实测：只有**最后一个分类框**的注释闪烁——高度疑似 `pageRoot`/标签集合只解析到最后一批生成的分类 Label，或 `resyncAll` 只 re-resolve 了尾部子树）；修复后在 `tests/ui_button_simtest.js` 加回归断言（多分类框场景：每个框的注释都要被翻译，不只最后一个）。
4. **R4 浏览器页默认原文**：左侧出装名列表**禁止自动翻译**（默认原文；用户点「翻译」按钮才切译文）；同时右侧出装概览的**作者注释**要能翻译（目前漏翻：补进 TM 覆盖范围 + 兜底路径，离线库查不到走既有 整句/术语/实时 兜底链）。
5. **R5 游戏内验证（um win 自动驱动，用户已授权无人值守）**：
   - 部署：先备份现有 `addons\pak13_dir.vpk` → `pak13_dir.vpk.bak-<yyyymmdd-hhmmss>`（用户现有惯例，见 addons 里一堆 .bak），再 `powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "E:\dealoc-mod\Reduced_CSDK_12" -Deploy`（只部署本仓库 pak13，**绝不覆盖/删除游戏原生 pak01、其他 mod 的 pak 或 .disabled 文件**）；
   - 驱动：`F:/agents/universal-modder/bin/um.cmd win ...`（CLI 已验证可用）：先 `um win ps` 看 Deadlock 是否已开；启动 `um win launch --steam 1422450 -- -condebug`（appid 1422450 已从 steam://rungameid 与 appmanifest 确认；-condebug 必须带，否则 console.log 无 `[BBT]`）；窗口尺寸用 `um win drive --proc ... "size 1920 1080"`；
   - 导航到 商城→出装浏览器，逐 R 验证（截图 `um win shot --scale 0.33` 入 `ui-task/shots/` + 读 `E:\Steam\steamapps\common\Deadlock\game\citadel\console.log` 的 `[BBT]` 行）：R1 概览页描述默认原文→点「翻译」变译文→点「原文」切回；R2 详情页按钮文案切换 + **每个分类框**注释都被翻译（不只最后一个）；R4 左侧出装名默认原文不自动翻 + 右侧概览作者注释可翻；
   - 安全纪律（技能要求）：每次批量输入前 `um win idle`（用户在用电脑就停手记 P0）；结束 `um win kill <pid>` 精确杀（禁通配 taskkill）并确认游戏退出；会话短、菜单点击坐标量一次记进 `ui-task/rea-notes/menu-points.md`；
   - 证据落 `ui-task/in-game-verification.md`：每个 R 一行 `IN_GAME: PASS/FAIL/BLOCKED(原因)` + 截图路径（`ui-task/shots/`）+ 关键 `[BBT]` 日志摘录。某 R FAIL → 当轮或下轮修（循环不收口）；无法启动游戏（Steam 未登录/反作弊/加载卡死）→ 全部标 `BLOCKED` + 原因记 OPEN_QUESTIONS（P0，[保守] 标记）。
6. **R6 收尾**：`node ui-task/scripts/completion_gate.js` 逐项跑，FAIL 项当任务处理，直到 `GATE: PASS`（写 `ui-task/PUSH_OK` 并记 pre-push SHA）；`ui-task/PUSH_OK` 存在且其 `pre_push_sha` 与当前 HEAD 一致时才允许 `git push`（Conventional Commits 逐 R 提交、不夹带、不碰其他分支），并把「已推送 + SHA 列表 + pre-push SHA」记进 `overnight-log.md` 顶部。

## Rules
- 引擎坑清单（AGENTS.md §6）逐条遵守：Label 源+探针模型不回退；不加周期性轮询；`SetPanelEvent` 绑定；`hittest` 规则；多 JS 上下文守卫。
- **生成物不手改**（bba_tm.js / bba_glossary.js / bba_layout_tokens.js → 管线重生成）；改了布局必须过 `build_layout_tokens.js --check`。
- 缓存铁律：同局同内容不重复翻译/不重复请求（TM 命中 + live_seen 落盘）。
- **游戏操作安全（um win，用户已授权无人值守）**：输入只进游戏窗口；操作前 `um win idle`（<60s 说明人在用 → 停手记 P0）；只 `um win kill <pid>` 精确杀；只复制 `dist/pak13_dir.vpk` 进 addons，不碰原生 pak01 与其他 mod；结束会话关游戏。
- 日志/报告/commit 不得出现真实 API Key / SteamID64（AGENTS.md §7）。
- 状态措辞纪律：实机未验证的项只准写「代码完成，待游戏验证」；已 um win 验证的写 `IN_GAME: PASS` 并附证据；验证不了才写 `IN_GAME: BLOCKED(原因)`。
- 拿不准 → `ui-task/OPEN_QUESTIONS.md`（P0 不阻塞主线：能选不动代码的保守方案就继续，记「待人工确认」，并在条目上打 `[自批]`/`[保守]` 标记——gate 认这两个标记）。
- **push 唯一通路**：`ui-task/PUSH_OK` 存在 且 其 `pre_push_sha` == 当前 HEAD；其余任何时刻 `git push` 都是违规（guardrail 不再拦 push，靠本规则 + gate 双保险）。

## Completion
仅当 `node ui-task/scripts/completion_gate.js` 输出 **`GATE: PASS`**（exit 0），逐项复查 gate 报告并给出证据，然后才允许输出 `<promise>BUILD_UI_COMPLETE</promise>`：
1. ui_check.js 全绿（含新增的 R2/R4 simtest 断言）
2. `docs/buildui-report.md` + `TODO.md` 条目 + `overnight-log.md` 记录已写（gate 机械核对）
3. `ui-task/OPEN_QUESTIONS.md` 无未处理 P0（P2 可留）
4. 各里程碑已 commit（conventional，工作区干净；`ui-task/` 任务文件夹本身也 commit 进仓库）
5. 游戏内验证证据 `ui-task/in-game-verification.md`：每个 R 的 `IN_GAME:` 行齐全（PASS 附截图+日志摘录；无法启动游戏则 BLOCKED+原因，且已在 OPEN_QUESTIONS 记 [保守]）；有 FAIL → 本项不完成，继续修
6. PUSH_OK 已写入 → 执行 `git push`（SHA 列表 + pre-push SHA 记入 overnight-log 顶部）；gate 未过则明确写「未推送，原因 = gate FAIL 项」

ralph 完成门会在 promise 后重跑 `acceptance: true` 命令（gate）：gate 非 0 退出 = 本项完成无效，循环继续。
