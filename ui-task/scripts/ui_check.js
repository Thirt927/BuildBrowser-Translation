#!/usr/bin/env node
/**
 * ui_check.js — 出装浏览器翻译交互改造（ui-task/RALPH.md）验收检查
 *
 * 离线可跑（不需要游戏）。路径相对本文件解析，无 cwd 依赖。
 * 运行：node ui-task/scripts/ui_check.js
 *
 * 检查项：
 *  1. 注入脚本语法（bba_translate.js 等 3 个脚本 new Function 通过）
 *  2. 基线三条（scene_verify / refresh_verify / build_layout_tokens --check）
 *  3. 关键 simtest（translate / ui_button / toolbar_cover）
 *  4. 布局 XML 仍引用注入脚本（6 个布局的 <scripts> 未被丢）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", ".."); // ui-task/scripts → 项目根
let fail = 0;

function ok(name, fn) {
  try {
    fn();
    process.stdout.write("  ok   " + name + "\n");
  } catch (e) {
    fail += 1;
    process.stdout.write("  FAIL " + name + "  " + ((e && e.message) ? e.message : e) + "\n");
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "pipe", shell: process.platform === "win32" });
  if (r.status !== 0) {
    throw new Error(cmd + " " + args.join(" ") + " 退出码 " + r.status + "：" + String(r.stderr || r.stdout).split("\n").slice(-3).join(" | ").trim());
  }
  return String(r.stdout);
}

// 1. 脚本语法
ok("注入脚本语法（bba_translate/tm/glossary）", () => {
  for (const f of ["bba_translate.js", "bba_tm.js", "bba_glossary.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "mod/panorama/scripts/" + f), "utf8");
    new Function(src); // 仅语法
  }
});

// 2. 基线三条
ok("基线: scene_verify", () => run("node", ["tests/scene_verify.js"]));
ok("基线: refresh_verify", () => run("node", ["tests/refresh_verify.js"]));
ok("基线: build_layout_tokens --check", () => run("node", ["tools/build_layout_tokens.js", "--check"]));

// 3. 关键 simtest（R2/R4 的新断言由循环补进 ui_button_simtest / translate_simtest）
ok("simtest: translate", () => run("node", ["tests/translate_simtest.js"]));
ok("simtest: ui_button", () => run("node", ["tests/ui_button_simtest.js"]));
ok("simtest: toolbar_cover", () => run("node", ["tests/toolbar_cover_simtest.js"]));

// 4. 布局 XML 引用注入脚本
ok("6 个布局均引用 bba_translate", () => {
  const layoutDir = path.join(ROOT, "mod/panorama/layout");
  const files = [
    "citadel_shop_mods_build.xml",
    "citadel_shop_mods_build_category.xml",
    "citadel_ui_build_details.xml",
    "citadel_ui_build_selector.xml",
    "tooltips/citadel_tooltip_mod_details.xml",
    "tooltips/citadel_tooltip_build_details.xml",
  ];
  const missing = [];
  for (const f of files) {
    const xml = fs.readFileSync(path.join(layoutDir, f), "utf8");
    if (!xml.includes("bba_translate") && !xml.includes("bba_tm")) missing.push(f);
  }
  if (missing.length) throw new Error("未引用注入脚本: " + missing.join(", "));
});

process.stdout.write(fail ? "ui_check: FAIL " + fail + " 项\n" : "ui_check: 全绿\n");
process.exit(fail ? 1 : 0);
