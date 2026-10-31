// Offline harness for mod/panorama/scripts/bba_translate.js.
// Recreates the small slice of the Panorama JS API the script uses, feeds it a
// fake build-browser DOM built from the sample share code (1.txt) and checks
// that TM lookups, token skipping and TextEntry protection behave as intended.
//
// Usage: node tests/translate_simtest.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { decode } = require("../tools/build_code.js");

const ROOT = path.join(__dirname, "..");

function makePanel(text, children) {
  const panel = {
    text: text,
    children: children || [],
    IsValid: () => true,
    BIsVisible: () => true,
    GetChildCount: () => panel.children.length,
    GetChild: (i) => panel.children[i],
  };
  return panel;
}

function buildDom(build) {
  const nodes = [];
  nodes.push(makePanel("#Citadel_HeroBuilds_BuildName")); // untouched token
  nodes.push(makePanel(build.name)); // duplicated build name (Chinese suffix)
  nodes.push(makePanel(build.description));
  nodes.push(makePanel(build.description.toUpperCase())); // unknown text
  nodes.push(makePanel("已经翻译好的中文")); // already Chinese
  nodes.push(makePanel("Short English note.")); // glossary fallback candidate
  nodes.push(makePanel(FIXTURE_TEXT)); // known translation memory hit
  const textEntry = makePanel("Copy of a build name");
  textEntry.placeholder = "#Citadel_HeroBuilds_NameLabel";
  nodes.push(textEntry);
  for (const cat of build.details.mod_categories) {
    if (cat.name) nodes.push(makePanel(cat.name));
    if (cat.description) nodes.push(makePanel(cat.description));
    for (const mod of cat.mods) {
      if (mod.annotation) nodes.push(makePanel(mod.annotation));
    }
  }
  return makePanel("CitadelHeroBuildsSelector", nodes);
}

const sandbox = {
  console: console,
  $: {
    GetContextPanel: () => sandbox.__root,
    Schedule: (delay, fn) => sandbox.__queue.push(fn),
    Msg: (msg) => sandbox.__log.push(String(msg)),
  },
};
sandbox.__queue = [];
sandbox.__log = [];
vm.createContext(sandbox);
for (const file of ["bba_glossary.js", "bba_tm.js"]) {
  const p = path.join(ROOT, "mod", "panorama", "scripts", file);
  vm.runInContext(fs.readFileSync(p, "utf8"), sandbox);
}

// Known-answer fixture: inject one entry using the same hash scheme as tools/build_tm.js.
function hash32(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}
function flat(s) {
  return String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+/g, " ").trim();
}
const FIXTURE_TEXT = "Fixture note that only exists in the translation memory.";
const FIXTURE_CN = "只存在于译文库的测试注释。";
// The TM ships in the compact format (BBA_TM_GET). Layer a fixture on top so the
// test does not have to rebuild the 58k-entry data file.
const FIXTURES = Object.create(null);
FIXTURES[hash32(flat(FIXTURE_TEXT), 5381).toString(36) + "-" + hash32(flat(FIXTURE_TEXT), 52711).toString(36)] = FIXTURE_CN;
{
  const baseGet = sandbox.BBA_TM_GET;
  sandbox.BBA_TM_GET = function (k) {
    const v = FIXTURES[k];
    if (v) return v;
    return typeof baseGet === "function" ? baseGet(k) : null;
  };
}

vm.runInContext(fs.readFileSync(path.join(ROOT, "mod", "panorama", "scripts", "bba_translate.js"), "utf8"), sandbox);

const build = decode(fs.readFileSync(path.join(ROOT, "samples", "sample-build-code.txt"), "utf8"));
sandbox.__root = buildDom(build);

// Drain the schedule queue (boot schedules the first tick, the tick schedules the next).
for (let i = 0; i < 6 && sandbox.__queue.length; i += 1) {
  const fn = sandbox.__queue.shift();
  fn();
}

let failures = 0;
function check(name, condition) {
  console.log((condition ? "PASS " : "FAIL ") + name);
  if (!condition) failures += 1;
}

const panels = sandbox.__root.children;
const stats = sandbox.BBT_STATS;
check("script booted", sandbox.__log.some((l) => l.indexOf("[BBT] v") === 0));
check("token untouched", panels[0].text === "#Citadel_HeroBuilds_BuildName");
check("chinese untouched", panels[4].text === "已经翻译好的中文");
check("TextEntry untouched", panels[7].text === "Copy of a build name");
check("unknown text untouched", panels[3].text === build.description.toUpperCase());
check("fixture translation applied", panels[6].text === FIXTURE_CN);
// The sample build name ends with "的副本" (a duplicated build); the lookup
// strips the suffix to find the translation and re-appends the marker so the
// copy stays distinguishable in the list.
{
  const base = flat(build.name).replace(/\s*(的副本|\(Copy\)|\(copy\)|Copy)$/, "");
  const key = hash32(base, 5381).toString(36) + "-" + hash32(base, 52711).toString(36);
  const hit = FIXTURES[key] || sandbox.BBA_TM_GET(key);
  check("copy name translated with marker", !!hit && panels[1].text === hit + " 的副本");
}
check("some texts translated", stats.translated > 0);
check("compact TM published a count", typeof sandbox.BBA_TM_COUNT === "number" && sandbox.BBA_TM_COUNT > 1000);

// Regression: the engine repaints labels with their original English (hover,
// resize, re-selection). The scanner must re-apply the translation instead of
// assuming "we already wrote this panel" (the old WeakMap cache did exactly
// that and left labels stuck in English).
panels[6].text = FIXTURE_TEXT;
panels[2].text = build.description;
for (let i = 0; i < 4 && sandbox.__queue.length; i += 1) sandbox.__queue.shift()();
check("fixture re-applied after engine reset", panels[6].text === FIXTURE_CN);
check("description re-applied after engine reset", /[\u3400-\u9fff]/.test(panels[2].text));

console.log("translated=" + stats.translated + " glossary=" + stats.fallback + " scanned=" + stats.scanned + " miss=" + stats.misses);
console.log("log:", sandbox.__log.slice(0, 3).join(" | "));

if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL CHECKS PASSED");

