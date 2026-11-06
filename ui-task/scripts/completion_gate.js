#!/usr/bin/env node
/**
 * completion_gate.js — 机械验收门（RALPH.md 的 acceptance 命令）
 *
 * 把「逐条核对」从提示词变成退出码：全部通过 → exit 0 并写 ui-task/PUSH_OK（记录 pre-push SHA）；
 * 任何一项失败 → exit 1 并删 PUSH_OK。ralph 完成门会在 <promise> 后重跑本脚本，非 0 退出 = 继续循环。
 *
 * 运行：node ui-task/scripts/completion_gate.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TASK = path.resolve(__dirname, "..");
const ROOT = path.resolve(TASK, "..");
const lines = [];
let fail = 0;

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "pipe" });
  return { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") };
}
function check(name, fn) {
  try {
    fn();
    lines.push("ok   " + name);
  } catch (e) {
    fail += 1;
    lines.push("FAIL " + name + "  " + ((e && e.message) ? e.message : e));
  }
}

// 1) ui_check 全绿（基线三条 + 关键 simtest + 注入脚本语法 + 6 布局引用）
check("ui_check.js 全绿", () => {
  const r = sh("node", [path.join(TASK, "scripts", "ui_check.js")]);
  if (r.code !== 0) throw new Error("ui_check 退出码 " + r.code + "：" + r.out.split("\n").filter(Boolean).slice(-4).join(" | "));
});

// 2) 报告 / TODO / 过夜日志
check("docs/buildui-report.md 含 R1–R5 与游戏验证步骤", () => {
  const p = path.join(ROOT, "docs", "buildui-report.md");
  if (!fs.existsSync(p)) throw new Error("docs/buildui-report.md 不存在");
  const t = fs.readFileSync(p, "utf8");
  for (const r of ["R1", "R2", "R3", "R4", "R5"]) if (!t.includes(r)) throw new Error("缺少 " + r + " 章节");
  if (!/早间待办|游戏验证|实机验证/.test(t)) throw new Error("缺少游戏验证/早间待办步骤");
});

check("TODO.md 追加了本次条目（循环启动后改过）", () => {
  const p = path.join(ROOT, "TODO.md");
  if (!fs.existsSync(p)) throw new Error("TODO.md 不存在");
  const loopStart = fs.statSync(path.join(TASK, "RALPH.md")).mtimeMs;
  if (fs.statSync(p).mtimeMs < loopStart) throw new Error("TODO.md 早于任务初始化，未追加条目");
  const t = fs.readFileSync(p, "utf8");
  if (!/buildui|翻译按钮|默认原文|ui-task/.test(t)) throw new Error("TODO.md 未见相关条目");
});

check("overnight-log.md 有决策记录", () => {
  const p = path.join(ROOT, "overnight-log.md");
  if (!fs.existsSync(p)) throw new Error("overnight-log.md 不存在");
  if (Buffer.byteLength(fs.readFileSync(p, "utf8"), "utf8") < 200) throw new Error("记录过短，疑似空");
});

// 3) OPEN_QUESTIONS 无未处理 P0（未打 [自批]/[保守] 标记的 P0 复选框）
check("OPEN_QUESTIONS.md 无未处理 P0", () => {
  const p = path.join(TASK, "OPEN_QUESTIONS.md");
  if (!fs.existsSync(p)) return;
  const t = fs.readFileSync(p, "utf8");
  const m = t.match(/## P0[\s\S]*?(?=\n## |\n# |$)/);
  if (!m) return;
  const open = m[0].split("\n").filter((l) => /^\s*-\s*\[ \]/.test(l));
  const bad = open.filter((l) => !/\[自批\]|\[保守\]|\[降级\]/.test(l));
  if (bad.length) throw new Error("未处理 P0：" + bad.map((l) => l.trim().slice(0, 60)).join(" / "));
});

// 4) 提交纪律
check("conventional commits ≥3（feat:/fix:/perf:）", () => {
  const r = sh("git", ["log", "--oneline", "-20"]);
  if (r.code !== 0) throw new Error("git log 失败：" + r.err.trim());
  const conv = r.out.split("\n").filter((l) => /^(feat|fix|perf|docs|test)(\(.+\))?:/.test(l)).length;
  if (conv < 3) throw new Error("仅 " + conv + " 个 conventional commit（需 ≥3）");
});

check("git 工作区干净（已跟踪改动为零；敏感未跟踪文件为零）", () => {
  const r = sh("git", ["status", "--porcelain"]);
  if (r.code !== 0) throw new Error("git status 失败：" + r.err.trim());
  const all = r.out.split("\n").filter(Boolean);
  // 已跟踪文件的任何改动 → 失败（交付必须全部 commit）
  const trackedDirty = all.filter((l) => !l.startsWith("??"));
  if (trackedDirty.length) throw new Error("未提交/范围外改动: " + trackedDirty.slice(0, 5).join(" | "));
  // 未跟踪：ui-task/ 与 .pi/ 是任务自有目录，放行；敏感路径一律失败
  const sensitive = /logs\\|logs\/|dist\\|dist\/|tools[\\/]cache|\.vpk$|\.bak$|\.pem$|\.key$|config[\\/]/;
  const badUntracked = all.filter((l) => {
    const f = l.slice(3).trim();
    return !f.startsWith("ui-task") && !f.startsWith(".pi/") && sensitive.test(f);
  });
  if (badUntracked.length) throw new Error("敏感/范围外未跟踪文件: " + badUntracked.join(" | "));
});

// 5) 游戏内验证证据（um win 自动驱动；无法启动游戏时允许 BLOCKED + OPEN_QUESTIONS 已记）
check("ui-task/in-game-verification.md 有逐 R 的 IN_GAME 结论", () => {
  const p = path.join(TASK, "in-game-verification.md");
  if (!fs.existsSync(p)) throw new Error("游戏内验证证据不存在");
  const lines = fs.readFileSync(p, "utf8").split("\n");
  for (const r of ["R1", "R2", "R4"]) {
    const line = lines.find((l) => l.includes("IN_GAME") && l.includes(r));
    if (!line) throw new Error("缺 " + r + " 的 IN_GAME 行");
    if (/FAIL/.test(line)) throw new Error(r + " 游戏内验证未过：" + line.trim().slice(0, 80));
    if (!/PASS|BLOCKED/.test(line)) throw new Error(r + " 的 IN_GAME 行无法识别（需 PASS/BLOCKED）：" + line.trim().slice(0, 80));
  }
});
check("IN_GAME BLOCKED 项已在 OPEN_QUESTIONS 记 [保守]", () => {
  const p = path.join(TASK, "in-game-verification.md");
  if (!fs.existsSync(p)) return;
  const t = fs.readFileSync(p, "utf8");
  if (!t.includes("BLOCKED")) return;
  const oq = fs.readFileSync(path.join(TASK, "OPEN_QUESTIONS.md"), "utf8");
  if (!/游戏|启动|um win|IN_GAME/.test(oq) || !/\[保守\]|\[自批\]/.test(oq)) throw new Error("BLOCKED 未在 OPEN_QUESTIONS.md 记 [保守]/[自批] 标记");
});

// 6) VPK 部署核对（仅提示：gate 只读检查，部署本身由循环完成）
try {
  const dist = path.join(ROOT, "dist", "pak13_dir.vpk");
  const steam = "E:\\Steam\\steamapps\\common\\Deadlock\\game\\citadel\\addons\\pak13_dir.vpk";
  if (fs.existsSync(dist) && fs.existsSync(steam)) {
    const dt = fs.statSync(dist).mtimeMs;
    const st = fs.statSync(steam).mtimeMs;
    if (st >= dt) lines.push("warn Steam 侧 pak13_dir.vpk 早于/等于 dist（可能是旧构建；早间手动核对部署）");
  }
} catch (e) {
  lines.push("warn VPK 部署核对跳过：" + ((e && e.message) ? e.message : e));
}

const head = sh("git", ["rev-parse", "HEAD"]).out.trim();
if (fail === 0) {
  fs.writeFileSync(
    path.join(TASK, "PUSH_OK"),
    "gate PASS\npre_push_sha=" + head + "\nts=" + new Date().toISOString() + "\n"
  );
  lines.push("GATE: PASS（push 允许——PUSH_OK 已写入，pre-push SHA=" + head + "，记入 overnight-log）");
} else {
  fs.rmSync(path.join(TASK, "PUSH_OK"), { force: true });
  lines.push("GATE: FAIL " + fail + " 项（push 禁止——PUSH_OK 已删除）");
}
console.log(lines.join("\n"));
process.exit(fail ? 1 : 0);
