// Regression test: the translation must follow the shown build / hovered item.
//
// Reproduces both update mechanisms Panorama can use for a Label:
//   A. the game JS assigns `label.text` directly  -> the scanned text changes
//   B. the label was created with text="#Token" whose localized value contains
//      {s:var} and the game drives it with SetDialogVariable -> assigning
//      `.text` destroys that template, so the engine's later updates go nowhere
//      and the label keeps the first translation forever (the reported bug).
//      The scanner has to hand the label back to the engine (restore the #token)
//      after it notices a new build, then translate the freshly resolved text.
//
// Usage: node tests/refresh_verify.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const tmFormat = require("../tools/tm_format.js");

const ROOT = path.join(__dirname, "..");

// ---- tiny translation memory with four distinct entries ----
const SRC = {
  "Build One": "构建一",
  "Build Two": "构建二",
  "Rend > Heal > Repeat.": "撕裂 > 治疗 > 重复。",
  "Key item for Drifter early game.": "孤猎前期的重要装备。",
  "After you upgrade your Rend once.": "升级一次撕裂之后。",
  "Buy this before the team fight.": "团战前先买这个。",
  "Build Three": "构建三",
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
// `dialogVar`: name of the dialog variable this label is bound to (case B).
function makePanel(opts) {
  const p = {
    children: [],
    IsValid: () => true,
    BIsVisible: () => true,
    GetChildCount: () => p.children.length,
    GetChild: (i) => p.children[i] || null,
    _cls: opts.cls || "",
  };
  Object.defineProperty(p, "class", { get: () => p._cls });
  p._text = opts.text || "";
  p._token = opts.token || null;
  p._varValue = opts.text || "";
  Object.defineProperty(p, "text", {
    get: () => (p._token ? p._token : p._text),
    set: (v) => {
      // Setting .text always replaces whatever the label had, including a
      // {s:var} template -- exactly like Panorama.
      p._token = null;
      p._text = v;
    },
    configurable: true,
  });
  return p;
}

// Case B label: created with text="#Token". The engine fills it through
// SetDialogVariable (the token's localized value is a {s:var} template).
// Model:
//   _token    the template is still in place (settings .text to another string
//             removes it, after which the engine's updates go nowhere)
//   _varValue the latest value the engine stored in the dialog variable
//   _text     what the label currently displays
// Labels that the engine fills through SetDialogVariable, exactly like Panorama:
//   * text defaults to the token template "{s:name}"
//   * SetDialogVariable("name", v) re-renders it
//   * assigning .text destroys the template (the old buggy path)
const LOCALIZE = {
  "#Citadel_HeroBuilds_BuildName": "{s:build_name}",
  "#Citadel_HeroBuilds_BuildDescription": "{s:build_description}",
  "#Citadel_Item_Build_Annotation": "{s:mod_annotation}",
  "#Citadel_HeroBuilds_BuildID": "Build # {s:build_id}",
};

function makeVarPanel(token, value, cls, varName) {
  const name = varName || (/\{s:([A-Za-z0-9_]+)\}/.exec(LOCALIZE[token] || "") || [])[1];
  const p = makePanel({ cls: cls });
  p._template = LOCALIZE[token] || null; // null = destroyed
  p._tok = token;
  p._vars = {};
  if (name) p._vars[name] = value;
  p._text = name && p._template ? p._template.replace(/\{s:[A-Za-z0-9_]+\}/, String(value)) : String(value);
  Object.defineProperty(p, "text", {
    get: () => p._text,
    set: (v) => {
      if (v === token && p._tok) {
        // restoring the declared token re-arms the template
        p._template = LOCALIZE[token] || null;
        const vn = p._varName;
        p._text = p._template ? p._template.replace(/\{s:[A-Za-z0-9_]+\}/, String(p._vars[vn] == null ? "" : p._vars[vn])) : String(v);
        return;
      }
      p._template = null; // assigning .text kills the binding
      p._text = String(v);
    },
    configurable: true,
  });
  p._varName = name;
  p.SetDialogVariable = (vn, v) => {
    p._vars[vn] = v;
    if (p._template) p._text = p._template.replace(/\{s:[A-Za-z0-9_]+\}/, String(v));
  };
  // engine side: the game picks another build -> new dialog variable value
  p.engineSet = (v) => {
    p._vars[p._varName] = v;
    if (p._template) p._text = p._template.replace(/\{s:[A-Za-z0-9_]+\}/, String(v));
    return !!p._template;
  };
  p.bound = () => !!p._template;
  return p;
}

function makeBoundPanel(token, value, cls) {
  const p = makePanel({ cls: cls });
  p._token = token;
  p._varValue = value;
  p._text = value;
  p._filled = true;
  Object.defineProperty(p, "text", {
    get: () => p._text,
    set: (v) => {
      if (v === token) {
        // Restoring the token: the template (and the binding) is back, and the
        // label resolves to the value the engine stored most recently.
        p._token = token;
        p._text = p._varValue;
        return;
      }
      p._token = null; // template destroyed
      p._text = v;
    },
    configurable: true,
  });
  // SetDialogVariable always stores the value on the panel; it can only be
  // DISPLAYED while the {s:var} template is still there. So an update that
  // arrives after we clobbered .text is invisible at the time, but it is still
  // remembered -- restoring the token makes the label resolve to it.
  p.engineSet = (v) => {
    p._varValue = v;
    if (p._token === null) return false; // stored, but lost visually
    p._text = v;
    return true;
  };
  return p;
}

// A root panel that owns dialog variables, like the layout root in game: setting
// a variable re-renders every bound child whose template uses it.
function makeVarRoot(varToLabel) {
  const root = makePanel({ cls: "LayoutRoot" });
  root.SetDialogVariable = (name, value) => {
    const list = varToLabel[name] || [];
    for (const p of list) {
      if (!p._template) continue; // binding lost: the engine cannot update it
      p._text = p._template.replace(/\{s:[A-Za-z0-9_]+\}/, String(value));
    }
  };
  return root;
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

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " -- " + detail : ""));
  if (!cond) failures += 1;
}

// =====================================================================
// Case A: the game assigns .text (list rows, shop categories, ...)
// =====================================================================
{
  const root = makePanel({});
  const nameP = makePanel({ text: "Build One", cls: "BuildName" });
  const descP = makePanel({ text: "Rend > Heal > Repeat.", cls: "BuildDescription" });
  root.children.push(nameP, descP);
  const { sandbox, queue } = boot(root);
  const tick = (n) => { for (let i = 0; i < n; i += 1) { const f = queue.shift(); if (f) f(); } };
  tick(2);
  check("[A] first build translated", nameP.text === "构建一" && descP.text === "撕裂 > 治疗 > 重复。", JSON.stringify([nameP.text, descP.text]));

  nameP.text = "Build Two";
  descP.text = "Key item for Drifter early game.";
  tick(2);
  check("[A] switch to build 2 re-translates", nameP.text === "构建二" && descP.text === "孤猎前期的重要装备。", JSON.stringify([nameP.text, descP.text]));

  // engine repaints the same English (hover / resize)
  descP.text = "Key item for Drifter early game.";
  tick(2);
  check("[A] repaint re-applies", descP.text === "孤猎前期的重要装备。", JSON.stringify(descP.text));

  descP.text = "After you upgrade your Rend once.";
  tick(2);
  check("[A] switch to build 3", descP.text === "升级一次撕裂之后。", JSON.stringify(descP.text));

  // back to an already seen text
  descP.text = "Rend > Heal > Repeat.";
  tick(2);
  check("[A] switch back", descP.text === "撕裂 > 治疗 > 重复。", JSON.stringify(descP.text));
  check("[A] write counter grows", sandbox.BBT_STATS.writes >= 7, String(sandbox.BBT_STATS.writes));
}

// =====================================================================
// Case B: the label is bound to a dialog variable (details panel / tooltip)
// =====================================================================
{
  const root = makePanel({});
  // identity label: build id, updated by the engine on every build switch
  const idToken = "#Citadel_HeroBuilds_BuildID";
  const idP = makeBoundPanel(idToken, "BUILD-111", "BuildID LeftRightFlow");
  const nameToken = "#Citadel_HeroBuilds_BuildName";
  const nameP = makeBoundPanel(nameToken, "Build One", "BuildName");
  const descToken = "#Citadel_HeroBuilds_BuildDescription";
  const descP = makeBoundPanel(descToken, "Rend > Heal > Repeat.", "BuildDescription");
  root.children.push(idP, nameP, descP);
  const { sandbox, queue } = boot(root);
  const tick = (n) => { for (let i = 0; i < n; i += 1) { const f = queue.shift(); if (f) f(); } };
  tick(2);
  check("[B] bound labels translated", nameP.text === "构建一" && descP.text === "撕裂 > 治疗 > 重复。", JSON.stringify([nameP.text, descP.text]));

  // engine switches build: it updates the dialog variables; the two labels we
  // overwrote have lost their template, so those updates are silently lost.
  const okId = idP.engineSet("BUILD-222");
  const okName = nameP.engineSet("Build Two");
  const okDesc = descP.engineSet("Key item for Drifter early game.");
  check("[B] engine update is indeed lost after our write", okId === true && okName === false && okDesc === false, JSON.stringify([okId, okName, okDesc]));

  tick(3); // identity change -> rebind -> read new english -> translate
  tick(3);
  check("[B] name refreshed after rebind", nameP.text === "构建二", JSON.stringify(nameP.text));
  check("[B] description refreshed after rebind", descP.text === "孤猎前期的重要装备。", JSON.stringify(descP.text));
  check("[B] rebind happened", sandbox.BBT_STATS.rebinds >= 2, String(sandbox.BBT_STATS.rebinds));

  // a third build must work the same way
  idP.engineSet("BUILD-333");
  nameP.engineSet("Build One");
  descP.engineSet("After you upgrade your Rend once.");
  tick(3);
  tick(3);
  check("[B] third build refreshed", nameP.text === "构建一" && descP.text === "升级一次撕裂之后。", JSON.stringify([nameP.text, descP.text]));
}

// =====================================================================
// Case C: item hover tooltip. The annotation label is bound to a dialog variable
// ({s:mod_annotation}); the tooltip panel is reused for every hovered item, so the
// annotation must follow each item without the engine losing its binding.
// =====================================================================
{
  const tooltipVars = { mod_name: [], modName: [], mod_annotation: [] };
  const root = makeVarRoot(tooltipVars);
  const modNameP = makeVarPanel("#Citadel_Item_Name", "元灵收割", "ModName", "mod_name");
  const compP = makeVarPanel("#Citadel_Item_Name", "元灵收割", "componentModName", "modName");
  const levelP = makeBoundPanel("+{d:mod_level}", "+2", "ModLevel"); // ticking-ish, must not trigger
  const annP = makeVarPanel("#Citadel_Item_Build_Annotation", "Rend > Heal > Repeat.", "ModifiesLabel", "mod_annotation");
  modNameP._cls = "ModName"; // class drives the identity signal
  tooltipVars.mod_name.push(modNameP);
  tooltipVars.modName.push(compP);
  tooltipVars.mod_annotation.push(annP);
  root.children.push(modNameP, compP, levelP, annP);
  const { sandbox, queue } = boot(root);
  const tick = (n) => { for (let i = 0; i < n; i += 1) { const f = queue.shift(); if (f) f(); } };
  tick(3);
  check("[C] tooltip annotation translated", annP.text === "撕裂 > 治疗 > 重复。", JSON.stringify(annP.text));
  check("[C] annotation keeps its binding", annP.bound(), "the engine can no longer update it");

  // hover a different item: the game re-fills the same variables with new English
  root.SetDialogVariable("mod_name", "乘胜追击");
  root.SetDialogVariable("modName", "乘胜追击");
  levelP.engineSet("+3");
  root.SetDialogVariable("mod_annotation", "Key item for Drifter early game.");
  tick(3);
  check("[C] annotation follows the hovered item", annP.text === "孤猎前期的重要装备。", JSON.stringify(annP.text));
  check("[C] still bound after the hover", annP.bound());

  // and back to the first item
  root.SetDialogVariable("mod_name", "元灵收割");
  root.SetDialogVariable("modName", "元灵收割");
  root.SetDialogVariable("mod_annotation", "Rend > Heal > Repeat.");
  tick(3);
  check("[C] annotation follows back", annP.text === "撕裂 > 治疗 > 重复。", JSON.stringify(annP.text));
}

// =====================================================================
// Case D: a ticking label must NOT make the panel re-translate forever.
// =====================================================================
{
  const root = makePanel({});
  const timeP = makeBoundPanel("#Citadel_HeroBuilds_LastUpdatedTime", "2 hours ago", "LastUpdated");
  const descP = makeBoundPanel("#Citadel_HeroBuilds_BuildDescription", "Rend > Heal > Repeat.", "BuildDescription");
  root.children.push(timeP, descP);
  const { sandbox, queue } = boot(root);
  const tick = (n) => { for (let i = 0; i < n; i += 1) { const f = queue.shift(); if (f) f(); } };
  tick(2);
  const writesAfterFirst = sandbox.BBT_STATS.writes;
  for (let i = 0; i < 10; i += 1) {
    timeP.engineSet("2 hours ago"); // same value; relative time labels repaint anyway
    tick(3);
  }
  check("[D] no runaway rewrites from a ticking label", sandbox.BBT_STATS.writes - writesAfterFirst <= 1, String(sandbox.BBT_STATS.writes - writesAfterFirst));
  check("[D] description still translated", descP.text === "撕裂 > 治疗 > 重复。", JSON.stringify(descP.text));
}

// =====================================================================
// Case E: a label whose class matches the generated token table but which is NOT
// engine-driven (runtime-created). Restoring the token must be undone, and the
// label must end up translated, never showing "#Token".
// =====================================================================
{
  const root = makePanel({});
  const idP = makeBoundPanel("#Citadel_HeroBuilds_BuildID", "BUILD-111", "BuildID");
  // plain label: .text is written by the game JS, it has no dialog-variable
  // binding, but its class is in the layout token table.
  const plain = makePanel({ text: "Rend > Heal > Repeat.", cls: "BuildDescription" });
  root.children.push(idP, plain);
  const { sandbox, queue } = boot(root);
  const tick = (n) => { for (let i = 0; i < n; i += 1) { const f = queue.shift(); if (f) f(); } };
  tick(3);
  check("[E] plain label translated", plain.text === "撕裂 > 治疗 > 重复。", JSON.stringify(plain.text));

  // a new build arrives: the identity label changes, so the scanner "rebinds"
  // every label it had written -- including this plain one.
  idP.engineSet("BUILD-222");
  plain.text = "Key item for Drifter early game.";
  tick(3);
  check("[E] never shows a raw #token", plain.text.indexOf("#") !== 0, JSON.stringify(plain.text));
  tick(4);
  check("[E] ends up translated", plain.text === "孤猎前期的重要装备。", JSON.stringify(plain.text));
}

// =====================================================================
// Case F: the real fix -- an engine-driven label is translated by setting the
// dialog variable on the layout root, so the binding survives and selecting
// another build keeps working (the reported "old translation stays" bug).
// =====================================================================
{
  // Variable names come from VAR_BY_CLASS inside the script (the game's own names).
  const byVar = { selected_hero_build_name: [], selected_hero_build_description: [] };
  const root = makeVarRoot(byVar);
  const idP = makeVarPanel("#Citadel_HeroBuilds_BuildID", "BUILD-111", "BuildID", "build_id");
  const nameP = makeVarPanel("#Citadel_HeroBuilds_BuildName", "Build One", "BuildName", "build_name");
  const descP = makeVarPanel("#Citadel_HeroBuilds_BuildDescription", "Rend > Heal > Repeat.", "BuildDescription", "build_description");
  byVar.selected_hero_build_name.push(nameP);
  byVar.selected_hero_build_description.push(descP);
  root.children.push(idP, nameP, descP);
  const { sandbox, queue } = boot(root);
  const tick = (n) => { for (let i = 0; i < n; i += 1) { const f = queue.shift(); if (f) f(); } };
  tick(6);

  check("[F] description translated", descP.text === "撕裂 > 治疗 > 重复。", JSON.stringify(descP.text));
  check("[F] wrote through the dialog variable", (sandbox.BBT_STATS.varWrites || 0) >= 1, String(sandbox.BBT_STATS.varWrites));
  check("[F] template still bound after translating", descP.bound(), "the engine lost the binding");

  // the game selects another build: it re-fills the same variables
  root.SetDialogVariable("selected_hero_build_description", "Key item for Drifter early game.");
  tick(4);
  check("[F] follows the newly selected build", descP.text === "孤猎前期的重要装备。", JSON.stringify(descP.text));
  check("[F] still bound after the switch", descP.bound());

  root.SetDialogVariable("selected_hero_build_description", "Buy this before the team fight.");
  tick(4);
  check("[F] follows a third build", descP.text === "团战前先买这个。", JSON.stringify(descP.text));
  check("[F] still bound after two switches", descP.bound());
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL REFRESH CHECKS PASSED");
