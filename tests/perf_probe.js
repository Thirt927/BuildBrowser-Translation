// Perf probe for the in-game translator: TM boot cost + per-tick scan cost.
//
//   node tests/perf_probe.js [panels=1200]
//
// Measures the pure-JS work of mod/panorama/scripts/bba_translate.js on a fake
// panel tree. In-game each panel property read also crosses the JS <-> UI
// binding, so treat these numbers as a lower bound: they show the *relative*
// cost of the optimisations (memo, CJK early-out, idle backoff).
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = path.join(ROOT, "mod", "panorama", "scripts");

function mb(bytes) {
  return (bytes / 1048576).toFixed(1) + " MiB";
}

// ---------- 1. TM boot cost ----------
const tmSrc = fs.readFileSync(path.join(SCRIPTS, "bba_tm.js"), "utf8");
console.log("bba_tm.js: " + (tmSrc.length / 1048576).toFixed(2) + " MiB source");
{
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(tmSrc, sb, { filename: "bba_tm.js" });
  const t1 = process.hrtime.bigint();
  const after = process.memoryUsage().heapUsed;
  console.log(
    "  boot: " + (Number(t1 - t0) / 1e6).toFixed(1) + " ms, +" + mb(after - before) +
      ", entries=" + sb.BBA_TM_COUNT,
  );
  console.log(
    "  x5 layout contexts: +" + mb((after - before) * 5) + " (tooltips carry their own copy)",
  );
}

// ---------- 2. scan cost ----------
const GAME_ZH = [
  "购买物品", "武器", "活力", "精神", "已装备", "升级", "选择英雄", "返回",
  "查看详情", "当前段位", "不朽之星", "秘术师", "你的队伍", "对手",
];
const PLAYER_EN = [
  "Rend > Heal > Repeat.",
  "Buy this first, then go for Spirit Snatch if you are against Haze.",
  "This build was made by analysing the top five EU Spirit Drifter players.",
  "Laning phase matters a lot. Play slow, do not go for kills early.",
  "Late game monster - stack fire rate and never fight alone.",
];
const PLAYER_ZH = [
  "撕裂 > 治疗 > 重复。",
  "这个构建是在分析欧服前五名不朽之星孤猎玩家后整理的。主要专注于射速叠加。",
  "你在对线阶段的表现对孤猎非常重要。所以要慢慢打，不要急于击杀。",
];

// Realistic mix: game UI is mostly Chinese localization + #tokens; player text
// is a minority. That mix is the worst case for hashing-before-CJK.
function makeTree(n) {
  const root = { text: undefined, children: [] };
  for (let i = 0; i < n; i += 1) {
    const r = i % 20;
    let text;
    if (r < 17) text = GAME_ZH[i % GAME_ZH.length];
    else if (r === 17) text = "#Citadel_Some_Token";
    else if (r === 18) text = PLAYER_EN[Math.floor(i / 20) % PLAYER_EN.length];
    else text = PLAYER_ZH[Math.floor(i / 20) % PLAYER_ZH.length];
    root.children.push({ text, children: [] });
  }
  return root;
}

function instrument(tree) {
  let reads = 0;
  const wrap = (p) => {
    const original = p.text;
    p.IsValid = () => true;
    p.BIsVisible = () => true;
    p.GetChildCount = function () { return this.children.length; };
    p.GetChild = function (i) { return this.children[i] || null; };
    p._t = original;
    Object.defineProperty(p, "text", {
      get() { reads += 1; return p._t; },
      set(v) { p._t = v; },
      configurable: true,
    });
    p.children.forEach(wrap);
    return p;
  };
  wrap(tree);
  return () => reads;
}

function boot(tree) {
  const readsOf = instrument(tree);
  const sandbox = { console: { log() {} } };
  const queue = [];
  sandbox.$ = {
    GetContextPanel: () => tree,
    Schedule: (d, fn) => queue.push({ d, fn }),
    Msg: () => {},
  };
  vm.createContext(sandbox);
  for (const f of ["bba_glossary.js", "bba_tm.js", "bba_layout_tokens.js", "bba_translate.js"]) {
    vm.runInContext(fs.readFileSync(path.join(SCRIPTS, f), "utf8"), sandbox, { filename: f });
  }
  return { sandbox, queue, readsOf };
}

function runTicks(ctx, ticks) {
  const times = [];
  for (let i = 0; i < ticks; i += 1) {
    const next = ctx.queue.shift();
    if (!next) break;
    const t0 = process.hrtime.bigint();
    next.fn();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  return times;
}

// ---------- 3. hidden-subtree skipping ----------
// Big pages keep lots of collapsed/off-screen content instantiated. Those
// subtrees cannot show text, so the scanner skips them wholesale.
function makeMixedTree(visible, hiddenSections, perSection) {
  const root = { text: undefined, children: [] };
  for (let i = 0; i < visible; i += 1) {
    root.children.push({ text: PLAYER_EN[i % PLAYER_EN.length], children: [] });
  }
  for (let s = 0; s < hiddenSections; s += 1) {
    const sec = { text: undefined, hidden: true, children: [] };
    for (let j = 0; j < perSection; j += 1) sec.children.push({ text: PLAYER_EN[j % PLAYER_EN.length], hidden: true, children: [] });
    root.children.push(sec);
  }
  return root;
}
function instrumentHidden(tree) {
  let reads = 0;
  const wrap = (p) => {
    if (p.hidden) {
      p.IsValid = () => true;
      p.BIsVisible = () => false;
      p.GetChildCount = function () { return this.children.length; };
      p.GetChild = function (i) { return this.children[i] || null; };
      p.children.forEach(wrap);
      return p;
    }
    const original = p.text;
    p.IsValid = () => true;
    p.BIsVisible = () => true;
    p.GetChildCount = function () { return this.children.length; };
    p.GetChild = function (i) { return this.children[i] || null; };
    p._t = original;
    Object.defineProperty(p, "text", {
      get() { reads += 1; return p._t; },
      set(v) { p._t = v; },
      configurable: true,
    });
    p.children.forEach(wrap);
    return p;
  };
  wrap(tree);
  return () => reads;
}
{
  const tree = makeMixedTree(60, 200, 10); // 60 visible + 200 hidden sections x10
  const readsOf = instrumentHidden(tree);
  const sandbox = { console: { log() {} } };
  const queue = [];
  sandbox.$ = {
    GetContextPanel: () => tree,
    Schedule: (d, fn) => queue.push({ d, fn }),
    Msg: () => {},
  };
  vm.createContext(sandbox);
  for (const f of ["bba_glossary.js", "bba_tm.js", "bba_layout_tokens.js", "bba_translate.js"]) {
    vm.runInContext(fs.readFileSync(path.join(SCRIPTS, f), "utf8"), sandbox, { filename: f });
  }
  queue.shift().fn();
  const before = readsOf();
  for (let i = 0; i < 10; i += 1) { const n = queue.shift(); if (n) n.fn(); }
  const reads = (readsOf() - before) / 10;
  console.log("\nhidden subtrees: 60 visible + 2000 hidden panels");
  console.log("  .text reads per tick: " + reads.toFixed(0) + " (invisible: 1 BIsVisible() call each, no reads)");
  console.log("  panels skipped so far: " + sandbox.BBT_STATS.skipped);
}

const N = Number(process.argv[2] || 1200);
const ctx = boot(makeTree(N));
// first scheduled callback is the boot hand-off (schedules tick), then ticks
ctx.queue.shift().fn();
const times = runTicks(ctx, 30);
const first = times[0];
const steady = times.slice(8);
const avgSteady = steady.reduce((a, b) => a + b, 0) / (steady.length || 1);
const st = ctx.sandbox.BBT_STATS;

console.log("\nscan (" + N + " panels):");
console.log("  first pass (all panels fresh): " + first.toFixed(2) + " ms");
console.log(
  "  steady state (memo hot):       " + avgSteady.toFixed(3) + " ms/tick  " +
    "-> " + st.interval.toFixed(2) + "s poll interval",
);
console.log(
  "  panel .text reads per tick:    " + (ctx.readsOf() / (times.length + 1)).toFixed(0) +
    " (binding crossings dominate in-game)",
);
console.log(
  "  translated=" + st.translated + " fallback=" + st.fallback +
    " misses=" + st.misses + " scanned=" + st.scanned,
);
