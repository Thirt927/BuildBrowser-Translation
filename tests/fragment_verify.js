// Fragment-level fallback: a build that is not in the translation memory still
// gets its known sentences translated, so a refreshed build reads mostly
// Chinese instead of all English.
//
// Usage: node tests/fragment_verify.js
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const tmFormat = require("../tools/tm_format.js");

const ROOT = path.join(__dirname, "..");

// The memory only knows these three sentences.
const KNOWN = {
  "Key item for Drifter early game.": "孤猎前期的重要装备。",
  "Lane phase matters a lot.": "对线阶段非常关键。",
  "Rend > Heal > Repeat.": "撕裂 > 治疗 > 重复。",
};
function hash32(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}
const flat = (s) => String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+/g, " ").trim();
const map = {};
for (const [k, v] of Object.entries(KNOWN)) {
  map[hash32(flat(k), 5381).toString(36) + "-" + hash32(flat(k), 52711).toString(36)] = v;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bbt-frag-"));
fs.writeFileSync(path.join(TMP, "tm.js"), tmFormat.emitScript(map, { generated_at: "test" }));

function panel(text) {
  const p = {
    children: [],
    IsValid: () => true,
    BIsVisible: () => true,
    GetChildCount: () => p.children.length,
    GetChild: (i) => p.children[i] || null,
    _cls: "BuildDescription",
  };
  Object.defineProperty(p, "class", { get: () => p._cls });
  p._t = text;
  Object.defineProperty(p, "text", {
    get: () => p._t,
    set: (v) => { p._t = v; },
    configurable: true,
  });
  return p;
}

function boot(root) {
  const queue = [];
  const sandbox = {
    console: { log() {} },
    $: { GetContextPanel: () => root, Schedule: (d, fn) => queue.push(fn), Msg: () => {} },
  };
  vm.createContext(sandbox);
  for (const f of [
    path.join(ROOT, "mod", "panorama", "scripts", "bba_glossary.js"),
    path.join(TMP, "tm.js"),
    path.join(ROOT, "mod", "panorama", "scripts", "bba_layout_tokens.js"),
    path.join(ROOT, "mod", "panorama", "scripts", "bba_translate.js"),
  ]) {
    vm.runInContext(fs.readFileSync(f, "utf8"), sandbox, { filename: path.basename(f) });
  }
  return { sandbox, queue };
}

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " -- " + detail : ""));
  if (!cond) failures += 1;
}

function run(text) {
  const root = panel(undefined);
  const label = panel(text);
  root.children.push(label);
  const { sandbox, queue } = boot(root);
  for (let i = 0; i < 3 && queue.length; i += 1) queue.shift()();
  return { label, stats: sandbox.BBT_STATS };
}

// A brand-new build: unknown overall, but 2 of 3 sentences are familiar.
{
  const text = "Key item for Drifter early game. Buy two more copies later. Lane phase matters a lot.";
  const { label, stats } = run(text);
  check("mixed result is produced", /[\u3400-\u9fff]/.test(label.text), JSON.stringify(label.text));
  check("known sentences translated", label.text.indexOf("孤猎前期的重要装备。") >= 0 && label.text.indexOf("对线阶段非常关键。") >= 0, JSON.stringify(label.text));
  check("unknown sentence kept verbatim", label.text.indexOf("Buy two more copies later.") >= 0, JSON.stringify(label.text));
  check("fragment counter increased", stats.fragments === 1, String(stats.fragments));
}

// Mostly unknown: must stay English (no Chinese soup).
{
  const text = "Zap the enemy carry before the fight starts. Then rotate mid and take the rune control.";
  const { label, stats } = run(text);
  check("low coverage stays English", !/[\u3400-\u9fff]/.test(label.text), JSON.stringify(label.text));
  check("no fragment write on low coverage", stats.fragments === 0, String(stats.fragments));
}

// ">" separators (the "Rend > Heal > Repeat." style notes)
{
  const text = "Rend > Heal > Repeat.";
  const { label } = run(text);
  check("whole-text hit still wins over fragments", label.text === "撕裂 > 治疗 > 重复。", JSON.stringify(label.text));
}

// A wholly unknown long text: untouched.
{
  const text = "Nobody has written this note before, so there is nothing to look up anywhere.";
  const { label } = run(text);
  check("unknown long text untouched", label.text === text, JSON.stringify(label.text));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL FRAGMENT CHECKS PASSED");
