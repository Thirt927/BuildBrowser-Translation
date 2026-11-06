# 零接触流水线：ralph 执行 → 独立验收（两阶段，全程无人值守）
#
# 用法：powershell -ExecutionPolicy Bypass -File ui-task/scripts/run_pipeline.ps1
#   阶段1：pi -p 非交互运行 /ralph（非 TUI 下命令会 await 整个循环，循环结束才退出）
#   阶段2：pi -p 独立会话跑验收清单：缺项直接修、重跑机械 gate，直到 GATE: PASS（上限 3 轮）
#
# 若想在阶段2用 pi-goal-x 的独立审计员（换模型复审 + 跨会话持久化），
# 把阶段2 换成：终端 pi 交互会话里 /goal-direct（见 ui-task/ACCEPTANCE_GOAL.txt）
param(
  [switch]$SkipRalph,   # 已跑完 ralph、只想补验收时用
  [switch]$SkipAccept   # 只跑 ralph
)
$root = "F:\agents\deadlockfanyi\出装翻译"
Set-Location $root

if (-not $SkipRalph) {
  Write-Host "[1/2] ralph 执行循环（阻塞至循环结束；监控：另开会话 /ralph-status ./ui-task）..."
  pi -p "/ralph --path ./ui-task"
} else {
  Write-Host "[1/2] 跳过（--SkipRalph）"
}

if (-not $SkipAccept) {
  Write-Host "[2/2] 独立验收会话（全新上下文，机械 gate 为准）..."
  pi -p @"
独立验收会话：项目 $root，任务 ui-task（出装浏览器 默认原文+按钮翻译，RALPH 循环刚结束）。
按 ui-task/RALPH.md 的 Completion 五条逐项核对；任何缺项直接修（同循环纪律：生成物走管线、
不碰原生 pak01/其他 mod、游戏验证按 um win 安全纪律、状态措辞 IN_GAME: PASS/FAIL/BLOCKED(原因)），修完重跑 node ui-task/scripts/completion_gate.js，
直到 GATE: PASS 或 3 轮仍未过（把 FAIL 项逐条写进 ui-task/OPEN_QUESTIONS.md 标 P0 留给人）。
gate 过且 ui-task/PUSH_OK 的 pre_push_sha==HEAD → git push 并把 SHA 列表记入 overnight-log.md 顶部。
最后输出验收单：每个 R 对应 commit、gate 输出全文、ui-task/in-game-verification.md 逐 R IN_GAME 结论（PASS 附截图/日志；BLOCKED 则列剩余人工早间待办，3 分钟粒度）。
"@
} else {
  Write-Host "[2/2] 跳过（--SkipAccept）"
}
