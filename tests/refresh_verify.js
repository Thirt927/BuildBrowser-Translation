// Regression test: the translation must follow the shown build / hovered item.
//
// Panorama gives a Label two ways to get its text:
//   A. the game JS assigns `label.text` directly  -> the scanned text changes
//   B. the label was created with text="#Token" whose localized value contains
//      {s:var}. Writing `.text` destroys the template, so after the first
//      translation the engine's own updates go nowhere and the label keeps the
//      old text (the reported "switching builds keeps the old translation" bug).
//
// The shipped fix (v1.9.x) keeps the labels in place: when a new build/item
// shows up, the mod re-applies the declared #token (which makes the engine
// resolve the fresh {s:var} value) and translates that. If the token does not
// resolve, the previous text is restored (never a raw "#Token" on screen).
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
  "Category for the Rend hero.": "撕裂类英雄的分类。",
  "Category for the Heal hero.": "治疗类英雄的分类。",
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
    IsValid: () => true,
    BIsVisible: () => true,
    GetChildCount: () => p.children.length,
    GetChild: (i) => p.children[i] || null,
    GetParent: () => p._parent,
    _cls: opts.cls || "",
  };
  // Engine reality: Source 2 panels expose a classList (contains), NOT a
  // `.class` string. The v1.9.5 bug hid exactly behind a `.class`-only shim.
  p.classList = {
    contains: (name) => p._cls.split(/\s+/).indexOf(name) >= 0,
  };
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
  "#Citadel_HeroBuilds_CategoryDescription": "{s:category_description}",
  "#Citadel_Item_Build_Annotation": "{s:mod_annotation}",
  "#Citadel_Item_Name": "{s:mod_name}",
  "#Citadel_HeroBuilds_BuildID": "Build # {s:build_id}",
};

// A B-class label: created with text="#Token", fed by SetDialogVariable.
//   * assigning .text = <its own token> re-arms the template and resolves it with
//     the current variable value (what the mod relies on)
//   * assigning any other text destroys the template (the engine's later updates
//     then go nowhere) -- exactly like Panorama
function makeVarPanel(token, value, cls) {
  const varName = (/\{s:([A-Za-z0-9_]+)\}/.exec(LOCALIZE[token] || "") || [])[1];
  const p = makePanel({ cls: cls });
  p._tok = token;
  p._template = LOCALIZE[token] || null;
  p._vars = {};
  if (varName) p._vars[varName] = value;
  p._varName = varName;
  const resolve = () =>
    p._template.replace(/\{s:[A-Za-z0-9_]+\}/, String(p._vars[varName] == null ? "" : p._vars[varName]));
  p._text = p._template ? resolve() : String(value);
  Object.defineProperty(p, "text", {
    get: () => p._text,
    set: (v) => {
      if (v === p._tok) {
        p._template = LOCALIZE[token] || null;
        p._text = p._template ? resolve() : String(v);
        return;
      }
      p._template = null; // destroys the binding
      p._text = String(v);
    },
    configurable: true,
  });
  p.bound = () => !!p._template;
  p.engineSet = (v) => {
    p._vars[varName] = v;
    if (!p._template) return false; // stored, but not displayed
    p._text = resolve();
    return true;
  };
  return p;
}

function boot(root) {
  const queue = [];
  const log = [];
  // $.Localize(token, panel) resolves {s:var} with the panel's dialog variables,
  // which is how the mod reads the value for the build that is on screen.
  const localize = (tok, panel) => {
    const t = LOCALIZE[tok];
    if (!t) return tok;
    const m = /\{s:([A-Za-z0-9_]+)\}/.exec(t);
    if (!m) return t;
    const vars = panel && panel._vars;
    if (!vars || vars[m[1]] === undefined) return t;
    return t.replace(/\{s:[A-Za-z0-9_]+\}/, String(vars[m[1]]));
  };
  const sandbox = {
    console: { log() {} },
    $: {
      GetContextPanel: () => root,
      Schedule: (d, fn) => queue.push(fn),
      Msg: (m) => log.push(String(m)),
      Localize: localize,
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

// Engine-parity guard: the sim must not offer a `.class` string, otherwise a
// reader that only understands `.class` would pass the tests and still be
// dead in the game (the v1.9.5 "refresh: re-resolved 0" bug).
check(
  "sim parity: panels expose classList.contains, no `.class` string",
  (() => { const p = makePanel({}); return !("class" in p) && typeof p.classList.contains === "function"; })(),
);

// =====================================================================
// Static cross-check: every #token literal hardcoded in RESYNC_TOKENS must
// exist in the generated token table (source of truth). A misspelled or
// unknown #token would silently fail resync in game while every sim stays
// green, because the mocks all carry the *correct* token.
// =====================================================================
{
  const translateSrc = fs.readFileSync(
    path.join(ROOT, "mod", "panorama", "scripts", "bba_translate.js"),
    "utf8",
  );
  const block = translateSrc.slice(
    translateSrc.indexOf("var RESYNC_TOKENS"),
    translateSrc.indexOf("function roleTokenFor"),
  );
  const literals = Array.from(new Set(block.match(/#[A-Za-z_][A-Za-z0-9_]*/g) || []));
  const ctx = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "mod", "panorama", "scripts", "bba_layout_tokens.js"), "utf8"),
    ctx,
    { filename: "bba_layout_tokens.js" },
  );
  const allTokens = Object.values(ctx.BBA_LAYOUT_TOKENS.byClassAll).flat();
  check(
    "resync token literals all exist in the generated token table",
    literals.length >= 5 && literals.every((t) => allTokens.indexOf(t) >= 0),
    literals.join(" "),
  );
}

// =====================================================================
// Case A: the game assigns .text itself (labels that are not token-bound)
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

  descP.text = "Rend > Heal > Repeat.";
  run(queue, 2);
  check("[A] switch back", descP.text === "撕裂 > 治疗 > 重复。", JSON.stringify(descP.text));
  check("[A] write counter grows", sandbox.BBT_STATS.writes >= 4, String(sandbox.BBT_STATS.writes));
}

// =====================================================================
// Case B: details panel -- engine-bound name/description + a build-id label.
// The build id changing is what tells us "another build is shown".
// =====================================================================
{
  const root = makePanel({});
  const idP = makeVarPanel("#Citadel_HeroBuilds_BuildID", "BUILD-111", "BuildID");
  const nameP = makeVarPanel("#Citadel_HeroBuilds_BuildName", "Build One", "BuildName");
  const descP = makeVarPanel("#Citadel_HeroBuilds_BuildDescription", "Rend > Heal > Repeat.", "BuildDescription");
  attach(root, idP, nameP, descP);
  const { sandbox, queue } = boot(root);
  run(queue, 4);
  check("[B] name translated", nameP.text === "构建一", JSON.stringify(nameP.text));
  check("[B] description translated", descP.text === "撕裂 > 治疗 > 重复。", JSON.stringify(descP.text));

  // the game selects another build: it re-fills the dialog variables, but our
  // write already destroyed both templates, so nothing shows up by itself
  idP.engineSet("BUILD-222");
  const okName = nameP.engineSet("Build Two");
  const okDesc = descP.engineSet("Key item for Drifter early game.");
  check("[B] engine update is lost while the template is destroyed", okName === false && okDesc === false);

  run(queue, 6); // identity change -> re-apply token -> translate the fresh value
  check("[B] name refreshed", nameP.text === "构建二", JSON.stringify(nameP.text));
  check("[B] description refreshed", descP.text === "孤猎前期的重要装备。", JSON.stringify(descP.text));
  check("[B] resync happened", (sandbox.BBT_STATS.resyncOk || 0) >= 2, String(sandbox.BBT_STATS.resyncOk));

  // a third build must work the same way
  idP.engineSet("BUILD-333");
  nameP.engineSet("Build Three");
  descP.engineSet("Buy this before the team fight.");
  run(queue, 6);
  check("[B] third build refreshed", nameP.text === "构建三" && descP.text === "团战前先买这个。", JSON.stringify([nameP.text, descP.text]));
}

// =====================================================================
// Case C: item hover tooltip. The tooltip layout is rebuilt for every hover, so
// the annotation label is a new panel each time (nothing to re-resolve).
// =====================================================================
{
  const root = makePanel({});
  const modNameP = makeVarPanel("#Citadel_Item_Name", "元灵收割", "ModName");
  const annP = makeVarPanel("#Citadel_Item_Build_Annotation", "Rend > Heal > Repeat.", "ModifiesLabel");
  attach(root, modNameP, annP);
  const { sandbox, queue } = boot(root);
  run(queue, 3);
  check("[C] tooltip annotation translated", annP.text === "撕裂 > 治疗 > 重复。", JSON.stringify(annP.text));

  // hover another item: the tooltip is re-created with the new item's text
  modNameP.text = "乘胜追击";
  root.children.length = 0;
  const modNameP2 = makeVarPanel("#Citadel_Item_Name", "乘胜追击", "ModName");
  const annP2 = makeVarPanel("#Citadel_Item_Build_Annotation", "Key item for Drifter early game.", "ModifiesLabel");
  attach(root, modNameP2, annP2);
  run(queue, 4);
  check("[C] annotation follows the hovered item", annP2.text === "孤猎前期的重要装备。", JSON.stringify(annP2.text));
}

// =====================================================================
// Case D: a ticking label must NOT make the panel re-translate forever.
// =====================================================================
{
  const root = makePanel({});
  const timeP = makeVarPanel("#Citadel_HeroBuilds_LastUpdatedTime", "2 hours ago", "LastUpdated");
  const descP = makeVarPanel("#Citadel_HeroBuilds_BuildDescription", "Rend > Heal > Repeat.", "BuildDescription");
  attach(root, timeP, descP);
  const { sandbox, queue } = boot(root);
  run(queue, 2);
  const writesAfterFirst = sandbox.BBT_STATS.writes;
  for (let i = 0; i < 10; i += 1) {
    timeP.engineSet("2 hours ago"); // same value, repaint only
    run(queue, 3);
  }
  check("[D] no runaway rewrites from a ticking label", sandbox.BBT_STATS.writes - writesAfterFirst <= 2, String(sandbox.BBT_STATS.writes - writesAfterFirst));
  check("[D] description still translated", descP.text === "撕裂 > 治疗 > 重复。", JSON.stringify(descP.text));
}

// =====================================================================
// Case E: a label whose token cannot be resolved must keep its text, never a
// raw "#Token".
// =====================================================================
{
  const root = makePanel({});
  const idP = makeVarPanel("#Citadel_HeroBuilds_BuildID", "BUILD-111", "BuildID");
  // token-bound, but this "engine" never fills it: .text = token stays literal
  const stuck = makePanel({ cls: "BuildDescription" });
  stuck._tok = "#Citadel_HeroBuilds_BuildDescription";
  stuck._text = "Rend > Heal > Repeat.";
  attach(root, idP, stuck);
  const { sandbox, queue } = boot(root);
  run(queue, 3);
  check("[E] translated first", stuck.text === "撕裂 > 治疗 > 重复。", JSON.stringify(stuck.text));

  idP.engineSet("BUILD-222");
  run(queue, 6);
  check("[E] never shows a raw #token", stuck.text.indexOf("#") !== 0, JSON.stringify(stuck.text));
  check("[E] keeps its translation when the token does not resolve", stuck.text === "撕裂 > 治疗 > 重复。", JSON.stringify(stuck.text));
  check("[E] failure counted", (sandbox.BBT_STATS.resyncFail || 0) >= 1, String(sandbox.BBT_STATS.resyncFail));
}

// =====================================================================
// Case F: the reported "refresh only fixes the header title, the overview keeps
// the old translation". The description label is engine-bound, but assigning its
// #token back does NOT make the engine re-render it (the header name does). The
// current value is still available through $.Localize(token, panel), so a
// refresh must translate that instead of re-translating the previous English.
// =====================================================================
{
  const root = makePanel({});
  const idP = makeVarPanel("#Citadel_HeroBuilds_BuildID", "BUILD-111", "BuildID");
  const nameP = makeVarPanel("#Citadel_HeroBuilds_BuildName", "Build One", "BuildName");
  const descP = makePanel({ cls: "BuildDescription" });
  descP._tok = "#Citadel_HeroBuilds_BuildDescription";
  descP._vars = { selected_hero_build_description: "Rend > Heal > Repeat." };
  // assigning the token destroys the template and the engine never repaints it
  // (that is what the description label does in game)
  Object.defineProperty(descP, "text", {
    get: () => descP._text,
    set: (v) => { descP._template = null; descP._text = String(v); },
    configurable: true,
  });
  descP._text = "Rend > Heal > Repeat.";
  attach(root, idP, nameP, descP);
  const { sandbox, queue } = boot(root);
  run(queue, 4);
  check("[F] description translated", descP.text === "撕裂 > 治疗 > 重复。", JSON.stringify(descP.text));

  // another build is selected: the engine refills the dialog variables, but this
  // label cannot be re-rendered from its token
  idP.engineSet("BUILD-222");
  nameP.engineSet("Build Two");
  descP._vars.selected_hero_build_description = "Key item for Drifter early game.";
  run(queue, 6);
  check("[F] header name refreshed", nameP.text === "构建二", JSON.stringify(nameP.text));
  check("[F] overview refreshed", descP.text === "孤猎前期的重要装备。", JSON.stringify(descP.text));

  // the refresh button path must do the same for a label left on an old value
  descP._text = "撕裂 > 治疗 > 重复。"; // simulate a label stuck on the old translation
  descP._vars.selected_hero_build_description = "Buy this before the team fight.";
  sandbox.BBTRefreshPage();
  run(queue, 6);
  check("[F] refresh button updates the overview", descP.text === "团战前先买这个。", JSON.stringify(descP.text));
}

// =====================================================================
// Case G: category description (B3). The category layout's overview label
// is engine-bound and cannot re-render from its token, so a refresh must
// translate the fresh value that $.Localize yields for the role's declared
// token. If RESYNC_TOKENS carries a wrong/typo'd token, the refresh falls
// back and the label stays on the previous build's translation.
// =====================================================================
{
  const root = makePanel({});
  const idP = makeVarPanel("#Citadel_HeroBuilds_BuildID", "BUILD-111", "BuildID");
  const catP = makePanel({ cls: "CategoryDescription" });
  catP._tok = "#Citadel_HeroBuilds_CategoryDescription";
  catP._vars = { category_description: "Category for the Rend hero." };
  // assigning any text destroys the binding and the engine never repaints
  Object.defineProperty(catP, "text", {
    get: () => catP._text,
    set: (v) => { catP._template = null; catP._text = String(v); },
    configurable: true,
  });
  catP._text = "Category for the Rend hero.";
  attach(root, idP, catP);
  const { sandbox, queue } = boot(root);
  run(queue, 4);
  check("[G] category description translated", catP.text === "撕裂类英雄的分类。", JSON.stringify(catP.text));

  // another build/category is shown: the engine refills the dialog variables,
  // but this label cannot re-render from its token
  idP.engineSet("BUILD-222");
  catP._vars.category_description = "Category for the Heal hero.";
  run(queue, 6);
  check("[G] category description refreshed", catP.text === "治疗类英雄的分类。", JSON.stringify(catP.text));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL REFRESH CHECKS PASSED");
