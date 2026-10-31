// Scenario verification: check the three text surfaces the user cares about
// on the REAL override layouts (mod/panorama/layout/*.xml).
//
//   1. Build browser right-hand description panel (CitadelBuildDetails)
//   2. Item hover tooltip author annotation (citadel_tooltip_mod_details)
//   3. Shop/builds page author-authored section (annotation / description)
//
// Usage: node tests/scene_verify.js
//   (no --layouts flag needed; uses the repo's own override layouts)
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { decode, collectTexts } = require(path.join(__dirname, "..", "tools", "build_code.js"));

const ROOT = path.join(__dirname, "..");
const LAYOUT = path.join(ROOT, "mod", "panorama", "layout");

// ---- minimal XML->panel tree (same technique as layout_dom_simtest) ----

function parseXml(xml) {
  xml = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml[^>]*\?>/g, "");
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<([a-zA-Z0-9_]+)((?:\s+[a-zA-Z0-9_\-]+="[^"]*")*)\s*(\/?)>|<\/[a-zA-Z0-9_]+\s*>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { tag: m[1], attrs: {}, children: [] };
    for (const a of m[2].matchAll(/([a-zA-Z0-9_\-]+)="([^"]*)"/g)) node.attrs[a[1]] = a[2];
    stack[stack.length - 1].children.push(node);
    if (!m[3]) stack.push(node);
  }
  return root;
}

function toPanel(node, depth) {
  depth = depth || 0;
  if (depth > 40) return null; // guard against cycles
  const classes = (node.attrs.class || "").split(/\s+/).filter(Boolean);
  const isText = ["Label", "TextButton", "ToggleButton"].indexOf(node.tag) >= 0;
  const panel = {
    tag: node.tag,
    attrs: node.attrs,
    classes: classes,
    text: isText ? (node.attrs.text || "") : undefined,
    children: [],
    IsValid: () => true,
    BIsVisible: () => true,
    GetChildCount: function () { return this.children.length; },
    GetChild: function (i) { return this.children[i] || null; },
  };
  if (node.tag === "TextEntry") {
    panel.text = node.attrs.text || "";
    panel.placeholder = node.attrs.placeholder || "";
    panel.maxchars = node.attrs.maxchars || "";
  }
  for (const c of node.children) {
    const cp = toPanel(c, depth + 1);
    if (cp) panel.children.push(cp);
  }
  return panel;
}

function loadLayout(name) {
  const xml = fs.readFileSync(path.join(LAYOUT, name + ".xml"), "utf8");
  const tree = parseXml(xml);
  // The override files wrap the game content in <styles>/<scripts>/<snippets>;
  // the real root panel is the first top-level element that is not one of those.
  const game = tree.children.find((c) => ["styles", "scripts", "snippets"].indexOf(c.tag) < 0);
  return toPanel(game || tree);
}

function walk(panel, fn) {
  if (!panel) return;
  fn(panel);
  for (const c of panel.children) walk(c, fn);
}

// ---- run bba_translate.js against a panel tree (like translate_simtest) ----

function runScript(root) {
  const sandbox = { console };
  sandbox.$ = {
    GetContextPanel: () => root,
    Schedule: (d, fn) => (sandbox.__q = sandbox.__q || []).push(fn),
    Msg: () => {},
  };
  vm.createContext(sandbox);
  for (const f of ["bba_glossary.js", "bba_tm.js", "bba_layout_tokens.js", "bba_translate.js"]) {
    vm.runInContext(
      fs.readFileSync(path.join(ROOT, "mod", "panorama", "scripts", f), "utf8"),
      sandbox,
      { filename: f },
    );
  }
  // boot -> first tick -> 3 more ticks (each schedules the next)
  for (let i = 0; i < 4 && sandbox.__q && sandbox.__q.length; i += 1) {
    const fn = sandbox.__q.shift();
    fn();
  }
  return sandbox;
}

// ---- fixture: use the shipped sample build; pick an annotated mod ----

const build = decode(fs.readFileSync(path.join(ROOT, "samples", "sample-build-code.txt"), "utf8"));
const allMods = build.details.mod_categories.flatMap((c) => c.mods || []);
const annotated = allMods.find((m) => m.annotation && m.annotation.length >= 4);
if (!annotated) {
  console.error("sample build has no annotated mod; cannot verify");
  process.exit(2);
}
console.log("sample build:", build.hero_build_id, "| annotated mod:", JSON.stringify(annotated.annotation.slice(0, 60)));

const CJK = /[\u3400-\u9fff]/;
function zhTexts(root, predicate) {
  const out = [];
  walk(root, (p) => {
    if (typeof p.text === "string" && p.text.length >= 2 && p.text[0] !== "#" && CJK.test(p.text)) {
      if (!predicate || predicate(p)) out.push(p.text);
    }
  });
  return out;
}
function anyMatch(root, re, predicate) {
  return zhTexts(root, predicate).some((t) => re.test(t));
}

let failures = 0;
function report(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " -- " + detail : ""));
  if (!ok) failures += 1;
}

// =====================================================================
// Scene 1: build browser right-hand description panel
// The override layout cites CitadelBuildDetails (a separate game layout);
// the shop override carries the id="ShopModsBuild" panel. We verify the
// override contains a text-surface node AND that bba_translate translates
// build.name / build.description when injected into such a node.
// =====================================================================
console.log("\n=== Scene 1: build browser right-hand panel (CitadelBuildDetails) ===");
{
  const selectorXml = fs.readFileSync(path.join(LAYOUT, "citadel_ui_build_selector.xml"), "utf8");
  report("selector layout contains <CitadelBuildDetails>", selectorXml.indexOf("<CitadelBuildDetails") >= 0);
  // The details subtree is instantiated by the engine. If it is inlined into
  // the selector's own tree (snippet-style), the selector's scanner reaches it.
  // The separate game layout citadel_ui_build_details.xml is NOT overridden
  // in this repo - if the engine instantiates it out-of-tree, its labels are
  // never scanned. We verify the translation mechanism on both surfaces here.
  const details = loadLayout("citadel_shop_mods_build");
  const nameHost = { tag: "Label", classes: ["SelectedBuildName"], text: build.name, children: [], IsValid: () => true, BIsVisible: () => true, GetChildCount: () => 0, GetChild: () => null };
  const descLabel = { tag: "Label", classes: ["BuildDescription"], text: build.description, children: [], IsValid: () => true, BIsVisible: () => true, GetChildCount: () => 0, GetChild: () => null };
  let listHost = null, outerHost = null;
  walk(details, (p) => {
    if (!listHost && p.attrs && p.attrs.id === "FavoriteBuildList") listHost = p;
    if (!outerHost && p.attrs && p.attrs.id === "SelectedBuildOuter") outerHost = p;
  });
  if (listHost) listHost.children.push(nameHost);
  if (outerHost) outerHost.children.push(descLabel);
  runScript(details);
  report("details: build name label gets Chinese", CJK.test(nameHost.text), nameHost.text.slice(0, 40));
  report("details: build description label gets Chinese", CJK.test(descLabel.text), descLabel.text.slice(0, 40));
  // Surface honesty check: is the separate details layout shipped in the repo?
  const detailsPath = path.join(LAYOUT, "citadel_ui_build_details.xml");
  if (fs.existsSync(detailsPath)) {
    const body = fs.readFileSync(detailsPath, "utf8");
    report(
      "details layout override carries the BBT scripts",
      body.indexOf("bba_translate") >= 0,
      "generated by tools/inject_scripts.js?",
    );
  } else {
    report(
      "repo overrides citadel_ui_build_details.xml (out-of-tree case)",
      false,
      "missing - decompile it and run tools/inject_scripts.js (or tools/get_layouts.ps1), then rebuild",
    );
  }

  // The separate details layout is what actually owns .BuildName/.BuildDescription.
  // Run the scanner on it directly: this is the surface that used to stay English
  // when switching builds (engine refresh).
  if (fs.existsSync(detailsPath)) {
    const details = loadLayout("citadel_ui_build_details");
    let nameLabel = null, descLabel = null;
    walk(details, (p) => {
      if (!nameLabel && p.classes.includes("BuildName")) nameLabel = p;
      if (!descLabel && p.classes.includes("BuildDescription")) descLabel = p;
    });
    if (!nameLabel || !descLabel) {
      report("details layout has .BuildName/.BuildDescription", false, "structure changed?");
    } else {
      nameLabel.text = build.name;
      descLabel.text = build.description;
      runScript(details);
      report("details: build name translated", CJK.test(nameLabel.text), nameLabel.text.slice(0, 40));
      report("details: build description translated", CJK.test(descLabel.text), descLabel.text.slice(0, 40));
    }
  }
}

// =====================================================================
// Scene 2: item hover tooltip author annotation
// =====================================================================
console.log("\n=== Scene 2: item hover tooltip (citadel_tooltip_mod_details) ===");
{
  const tip = loadLayout("tooltips/citadel_tooltip_mod_details");
  let host = null;
  walk(tip, (p) => { if (!host && p.classes.includes("ModifiesLabel")) host = p; });
  if (!host) {
    report("tooltip has a .ModifiesLabel host", false, "layout structure changed?");
  } else {
    host.text = annotated.annotation;
    runScript(tip);
    report("tooltip annotation translated", CJK.test(host.text), host.text.slice(0, 50));
  }
}

// =====================================================================
// Scene 3: shop/builds page author section
// =====================================================================
console.log("\n=== Scene 3: shop builds page author text ===");
{
  const shop = loadLayout("citadel_shop_mods_build");
  const cat = build.details.mod_categories[0] || { name: "Cat", description: "Desc" };
  // The category / annotation labels are created by the engine at runtime
  // inside the override's containers; emulate them there so the translator's
  // surface scan behaves as in game.
  const nameHost = { tag: "Label", classes: ["CategoryName"], text: cat.name, children: [], IsValid: () => true, BIsVisible: () => true, GetChildCount: () => 0, GetChild: () => null };
  const descHost = { tag: "Label", classes: ["CategoryDescription"], text: cat.description, children: [], IsValid: () => true, BIsVisible: () => true, GetChildCount: () => 0, GetChild: () => null };
  const note = { tag: "Label", classes: ["ModAnnotation"], text: annotated.annotation, children: [], IsValid: () => true, BIsVisible: () => true, GetChildCount: () => 0, GetChild: () => null };
  let container = null;
  walk(shop, (p) => { if (!container && p.attrs && p.attrs.id === "CategoryContainer") container = p; });
  if (!container) {
    report("shop layout has CategoryContainer", false, "override structure changed?");
  } else {
    container.children.push(nameHost, descHost, note);
    runScript(shop);
    report("shop category name translated", CJK.test(nameHost.text), nameHost.text.slice(0, 40));
    report("shop category desc translated", CJK.test(descHost.text), descHost.text.slice(0, 40));
    report("shop item annotation translated", CJK.test(note.text), note.text.slice(0, 50));
  }
}

console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL SCENES VERIFIED");
