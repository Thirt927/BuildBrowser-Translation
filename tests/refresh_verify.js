// Regression test: the translation must follow the shown build / hovered item.
//
// Panorama gives a Label two ways to get its text:
//   A. the game JS assigns `label.text` directly  -> the scanned text changes
//   B. the label was created with text="#Token" whose localized value contains
//      {s:var} and the game drives it with SetDialogVariable. Writing `.text`
//      there destroys the template (the label freezes on the first translation),
//      and writing the variable on a shared root leaks into every descendant
//      that inherits it (all list rows showed the same build name).
//
// The shipped fix (v1.8.0) never touches a B-class label: our layouts declare a
// collapsed BBTSrc label (engine-owned, always current) plus an empty BBTDst
// label the mod fills from the source text on every tick.
//
// Usage: node tests/refresh_verify.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const tmFormat = require("../tools/tm_format.js");

const ROOT = path.join(__dirname, "..");

// ---- tiny translation memory with a handful of distinct entries ----
const SRC = {
  "Build One": "构建一",
  "Build Two": "构建二",
  "Build Three": "构建三",
  "Rend > Heal > Repeat.": "撕裂 > 治疗 > 重复。",
  "Key item for Drifter early game.": "孤猎前期的重要装备。",
  "After you upgrade your Rend once.": "升级一次撕裂之后。",
  "Buy this before the team fight.": "团战前先买这个。",
};
function hash32(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}
const flat = (s) => String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+/g, " ").trim();
const map = {};
for (const [k, v] of Object.entries(SRC)) {
  map[hash32(flat(k), 5381).toString(36) + "-" + hash32(flat(k), 52711).toString(36)] = v;
}
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "bbt-refresh-"));
fs.writeFileSync(path.join(TMP, "bba_tm_fixture.js"), tmFormat.emitScript(map, { generated_at: "test" }));

// ---- panel model ----
function makePanel(opts) {
  const p = {
    children: [],
    _parent: null,
    IsVisible: () => true,
    GetChildCount: () => p.children.length,
    GetChild: (i) => p.children[i] || null,
    GetParent: () => p._parent,
    _cls: opts.cls || "",
  };
  Object.defineProperty(p, "IsValid", { value: () => true });
  // Both the visible label and the 1px probe are rendered in game (a collapsed
  // label never resolves its {s:var} template, which is why the probe exists).
  Object.defineProperty(p, "BIsVisible", { value: () => true });
  Object.defineProperty(p, "class", { get: () => p._cls });
  p._text = opts.text || "";
  Object.defineProperty(p, "text", {
    get: () => p._text,
    set: (v) => { p._text = String(v); },
    configurable: true,
  });
  return p;
}

function attach(parent, ...kids) {
  for (const k of kids) {
    k._parent = parent;
    parent.children.push(k);
  }
  return parent;
}

const LOCALIZE = {
  "#Citadel_HeroBuilds_BuildName": "{s:selected_hero_build_name}",
  "#Citadel_HeroBuilds_BuildDescription": "{s:selected_hero_build_description}",
  "#Citadel_Item_Build_Annotation": "{s:mod_annotation}",
  "#Citadel_HeroBuilds_BuildID": "Build # {s:build_id}",
};

// A B-class label: created with text="#Token", fed by SetDialogVariable on the
// layout root. Assigning .text kills the template, exactly like Panorama.
function makeVarPanel(token, value, cls) {
  const varName = (/\{s:([A-Za-z0-9_]+)\}/.exec(LOCALIZE[token] || "") || [])[1];
  const p = makePanel({ cls: cls });
  p._template = LOCALIZE[token] || null;
  p._vars = {};
  if (varName) p._vars[varName] = value;
  p._text = p._template ? p._template.replace(/\{s:[A-Za-z0-9_]+\}/, String(value)) : String(value);
  Object.defineProperty(p, "text", {
    get: () => p._text,
    set: (v) => {
      p._template = null; // assigning .text kills the binding
      p._text = String(v);
    },
    configurable: true,
  });
  p._varName = varName;
  p.SetDialogVariable = (vn, v) => {
    p._vars[vn] = v;
    if (p._template) p._text = p._template.replace(/\{s:[A-Za-z0-9_]+\}/, String(v));
  };
  p.bound = () => !!p._template;
  return p;
}

// Layout root that owns the dialog variables the game sets (build name, ...).
function makeVarRoot() {
  const root = makePanel({ cls: "LayoutRoot" });
  root._bound = [];
  root.SetDialogVariable = (name, value) => {
    for (const p of root._bound) {
      if (p._varName !== name || !p._template) continue;
      p.SetDialogVariable(name, value);
    }
  };
  root.track = (p) => { root._bound.push(p); return p; };
  return root;
}

// A BBTSrc label (visible, translated in place) plus its 1px BBTProbe copy of
// the same token (never written, always re-resolved by the engine).
function pair(root, token, value, cls) {
  const holder = makePanel({});
  const src = root.track(makeVarPanel(token, value, "BBTSrc " + cls));
  const probe = root.track(makeVarPanel(token, value, "BBTProbe " + cls));
  attach(holder, src, probe);
  return { holder, src, probe };
}

function boot(root) {
  const queue = [];
  const log = [];
  const sandbox = {
    console: { log() {} },
    $: {
      GetContextPanel: () => root,
      Schedule: (d, fn) => queue.push(fn),
      Msg: (m) => log.push(String(m)),
      Localize: (tok) => LOCALIZE[tok] || tok,
    },
  };
  vm.createContext(sandbox);
  const files = [
    path.join(ROOT, "mod", "panorama", "scripts", "bba_glossary.js"),
    path.join(ROOT, "mod", "panorama", "scripts", "bba_layout_tokens.js"),
    path.join(TMP, "bba_tm_fixture.js"),
    path.join(ROOT, "mod", "panorama", "scripts", "bba_translate.js"),
  ];
  for (const f of files) vm.runInContext(fs.readFileSync(f, "utf8"), sandbox, { filename: path.basename(f) });
  return { sandbox, queue, log };
}

function run(queue, n) {
  for (let i = 0; i < n; i += 1) {
    const f = queue.shift();
    if (f) f();
  }
}

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " -- " + detail : ""));
  if (!cond) failures += 1;
}

// =====================================================================
// Case A: the game assigns .text (list rows that are not engine-bound, ...)
// =====================================================================
{
  const root = makePanel({});
  const nameP = makePanel({ text: "Build One", cls: "BuildName" });
  const descP = makePanel({ text: "Rend > Heal > Repeat.", cls: "BuildDescription" });
  attach(root, nameP, descP);
  const { sandbox, queue } = boot(root);
  run(queue, 2);
  check("[A] first build translated", nameP.text === "构建一" && descP.text === "撕裂 > 治疗 > 重复。", JSON.stringify([nameP.text, descP.text]));

  nameP.text = "Build Two";
  descP.text = "Key item for Drifter early game.";
  run(queue, 2);
  check("[A] switch to build 2 re-translates", nameP.text === "构建二" && descP.text === "孤猎前期的重要装备。", JSON.stringify([nameP.text, descP.text]));

  descP.text = "Key item for Drifter early game.";
  run(queue, 2);
  check("[A] repaint re-applies", descP.text === "孤猎前期的重要装备。", JSON.stringify(descP.text));

  descP.text = "Rend > Heal > Repeat.";
  run(queue, 2);
  check("[A] switch back", descP.text === "撕裂 > 治疗 > 重复。", JSON.stringify(descP.text));
  check("[A] write counter grows", sandbox.BBT_STATS.writes >= 4, String(sandbox.BBT_STATS.writes));
}

// =====================================================================
// Case B: details panel -- the visible label follows the 1px probe.
// =====================================================================
{
  const root = makeVarRoot();
  const idP = makeVarPanel("#Citadel_HeroBuilds_BuildID", "BUILD-111", "BuildID");
  const name = pair(root, "#Citadel_HeroBuilds_BuildName", "Build One", "BuildName");
  const desc = pair(root, "#Citadel_HeroBuilds_BuildDescription", "Rend > Heal > Repeat.", "BuildDescription");
  attach(root, idP, name.holder, desc.holder);
  const { sandbox, queue } = boot(root);
  run(queue, 3);
  check("[B] visible label shows the translation", name.src.text === "构建一" && desc.src.text === "撕裂 > 治疗 > 重复。", JSON.stringify([name.src.text, desc.src.text]));
  check("[B] probe keeps the engine's English", name.probe.text === "Build One" && desc.probe.text === "Rend > Heal > Repeat.", JSON.stringify([name.probe.text, desc.probe.text]));
  check("[B] probe keeps its binding", name.probe.bound() && desc.probe.bound());
  check("[B] no dialog-variable writes at all", (sandbox.BBT_STATS.varWrites || 0) === 0, String(sandbox.BBT_STATS.varWrites));

  // the game selects another build: it re-fills the same variables
  root.SetDialogVariable("selected_hero_build_name", "Build Two");
  root.SetDialogVariable("selected_hero_build_description", "Key item for Drifter early game.");
  run(queue, 2);
  check("[B] name follows the new build", name.src.text === "构建二", JSON.stringify(name.src.text));
  check("[B] description follows the new build", desc.src.text === "孤猎前期的重要装备。", JSON.stringify(desc.src.text));
  check("[B] probe still bound after the switch", name.probe.bound() && desc.probe.bound());

  root.SetDialogVariable("selected_hero_build_name", "Build Three");
  root.SetDialogVariable("selected_hero_build_description", "Buy this before the team fight.");
  run(queue, 2);
  check("[B] third build follows", name.src.text === "构建三" && desc.src.text === "团战前先买这个。", JSON.stringify([name.src.text, desc.src.text]));
  check("[B] no rebinds were needed", sandbox.BBT_STATS.rebinds === 0, String(sandbox.BBT_STATS.rebinds));
  check("[B] probe writes counted", (sandbox.BBT_STATS.probes || 0) >= 3, String(sandbox.BBT_STATS.probes));
}

// =====================================================================
// Case C: item hover tooltip -- the annotation must follow the hovered item.
// =====================================================================
{
  const root = makeVarRoot();
  const modName = root.track(makeVarPanel("#Citadel_Item_Name", "元灵收割", "ModName"));
  const ann = pair(root, "#Citadel_Item_Build_Annotation", "Rend > Heal > Repeat.", "ModifiesLabel");
  attach(root, modName, ann.holder);
  const { sandbox, queue } = boot(root);
  run(queue, 3);
  check("[C] tooltip annotation translated", ann.src.text === "撕裂 > 治疗 > 重复。", JSON.stringify(ann.src.text));
  check("[C] annotation probe keeps its binding", ann.probe.bound(), "the engine can no longer update it");

  root.SetDialogVariable("mod_name", "乘胜追击");
  root.SetDialogVariable("mod_annotation", "Key item for Drifter early game.");
  run(queue, 2);
  check("[C] annotation follows the hovered item", ann.src.text === "孤猎前期的重要装备。", JSON.stringify(ann.src.text));
  check("[C] still bound after the hover", ann.probe.bound());

  root.SetDialogVariable("mod_name", "元灵收割");
  root.SetDialogVariable("mod_annotation", "Rend > Heal > Repeat.");
  run(queue, 2);
  check("[C] annotation follows back", ann.src.text === "撕裂 > 治疗 > 重复。", JSON.stringify(ann.src.text));
  check("[C] no rebind needed", sandbox.BBT_STATS.rebinds === 0, String(sandbox.BBT_STATS.rebinds));
}

// =====================================================================
// Case D: a ticking label must NOT make the panel re-translate forever.
// =====================================================================
{
  const root = makeVarRoot();
  const timeP = root.track(makeVarPanel("#Citadel_HeroBuilds_LastUpdatedTime", "2 hours ago", "LastUpdated"));
  const desc = pair(root, "#Citadel_HeroBuilds_BuildDescription", "Rend > Heal > Repeat.", "BuildDescription");
  attach(root, timeP, desc.holder);
  const { sandbox, queue } = boot(root);
  run(queue, 2);
  const writesAfterFirst = sandbox.BBT_STATS.writes;
  for (let i = 0; i < 10; i += 1) {
    root.SetDialogVariable("build_id", "2 hours ago"); // same value, repaint only
    run(queue, 3);
  }
  check("[D] no runaway rewrites from a ticking label", sandbox.BBT_STATS.writes - writesAfterFirst === 0, String(sandbox.BBT_STATS.writes - writesAfterFirst));
  check("[D] description still translated", desc.src.text === "撕裂 > 治疗 > 重复。", JSON.stringify(desc.src.text));
}

// =====================================================================
// Case E: a plain label whose class is in the generated token table but which is
// NOT engine-driven. It must be translated and never show a raw #Token.
// =====================================================================
{
  const root = makePanel({});
  const idP = makePanel({ text: "BUILD-111", cls: "BuildID" });
  const plain = makePanel({ text: "Rend > Heal > Repeat.", cls: "BuildDescription" });
  attach(root, idP, plain);
  const { sandbox, queue } = boot(root);
  run(queue, 3);
  check("[E] plain label translated", plain.text === "撕裂 > 治疗 > 重复。", JSON.stringify(plain.text));

  idP.text = "BUILD-222";
  plain.text = "Key item for Drifter early game.";
  run(queue, 4);
  check("[E] never shows a raw #token", plain.text.indexOf("#") !== 0, JSON.stringify(plain.text));
  check("[E] ends up translated", plain.text === "孤猎前期的重要装备。", JSON.stringify(plain.text));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL REFRESH CHECKS PASSED");
