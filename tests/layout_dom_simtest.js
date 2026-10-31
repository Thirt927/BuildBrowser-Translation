// Layout-level harness: rebuilds the real build-browser panel trees from the
// game's decompiled layouts, fills them with the texts the engine would show,
// then runs mod/panorama/scripts/bba_translate.js against them.
//
// Requires the decompiled layouts (not shipped with the repo):
//   Source2Viewer-CLI.exe -i <extracted panorama/layout> -o <out> -d --recursive
// (see README: "游戏更新后的布局刷新")
//
// Usage: node tests/layout_dom_simtest.js --layouts <dir with *.xml>
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { decode } = require("../tools/build_code.js");

const ROOT = path.join(__dirname, "..");
const argIdx = process.argv.indexOf("--layouts");
const LAYOUTS = argIdx > 0 ? path.resolve(process.argv[argIdx + 1]) : "";
if (!LAYOUTS || !fs.existsSync(path.join(LAYOUTS, "citadel_ui_build_selector.xml"))) {
  console.log("SKIP: pass --layouts <dir with citadel_ui_build_selector.xml> (decompile the game layouts first)");
  process.exit(0);
}

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

function toPanel(node) {
  const classes = (node.attrs.class || "").split(/\s+/).filter(Boolean);
  const isText = node.tag === "Label" || node.tag === "TextButton" || node.tag === "ToggleButton";
  const panel = {
    text: isText ? node.attrs.text || "" : undefined,
    children: node.children.map(toPanel),
    attrs: node.attrs,
    classes,
    IsValid: () => true,
    BIsVisible: () => true,
    GetChildCount: function () { return this.children.length; },
    GetChild: function (i) { return this.children[i]; },
  };
  if (node.tag === "TextEntry") {
    panel.text = node.attrs.text || "";
    panel.placeholder = node.attrs.placeholder || "";
  }
  return panel;
}

function walk(panel, fn) {
  fn(panel);
  for (const c of panel.children) walk(c, fn);
}

function loadLayout(name) {
  return toPanel(parseXml(fs.readFileSync(path.join(LAYOUTS, name + ".xml"), "utf8")).children[0]);
}

function inflate(root, id, layoutName) {
  walk(root, (p) => {
    if (p.attrs && p.attrs.id === id && p.children.length === 0) p.children = loadLayout(layoutName).children;
  });
}

const build = decode(fs.readFileSync(path.join(ROOT, "samples", "sample-build-code.txt"), "utf8"));
const cat = build.details.mod_categories[0];
const annotated = build.details.mod_categories.flatMap((c) => c.mods).find((m) => m.annotation);

// 1) build browser: selector -> BuildDetails -> ShopModsBuild -> category
const selector = loadLayout("citadel_ui_build_selector");
inflate(selector, "BuildDetails", "citadel_ui_build_details");
inflate(selector, "ShopModsBuild", "citadel_shop_mods_build");
inflate(selector, "CategoryContainer", "citadel_shop_mods_build_category");
walk(selector, (p) => {
  if (p.attrs && p.attrs.id === "ModsContainer") {
    p.children.push({
      text: annotated.annotation,
      children: [],
      attrs: {},
      classes: ["ModAnnotation"],
      IsValid: () => true,
      BIsVisible: () => true,
      GetChildCount: () => 0,
      GetChild: () => null,
    });
  }
});
walk(selector, (p) => {
  if (typeof p.text !== "string") return;
  if (p.classes.includes("BuildName")) p.text = build.name;
  else if (p.classes.includes("BuildDescription")) p.text = build.description;
  else if (p.classes.includes("SelectedBuildName")) p.text = build.name;
  else if (p.attrs.id === "BuildCategoryName") p.text = cat.name;
  else if (p.classes.includes("CategoryDescription")) p.text = cat.description;
});

// 2) item tooltip: engine writes the annotation into the first .ModifiesLabel
const tooltip = loadLayout("tooltips/citadel_tooltip_mod_details");
let setOnce = false;
walk(tooltip, (p) => {
  if (!setOnce && typeof p.text === "string" && p.classes.includes("ModifiesLabel")) {
    p.text = annotated.annotation;
    setOnce = true;
  }
});

function run(root) {
  const sandbox = { console };
  sandbox.$ = {
    GetContextPanel: () => root,
    Schedule: (d, fn) => (sandbox.__q = sandbox.__q || []).push(fn),
    Msg: () => {},
  };
  vm.createContext(sandbox);
  for (const f of ["bba_glossary.js", "bba_tm.js", "bba_layout_tokens.js", "bba_translate.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "mod", "panorama", "scripts", f), "utf8"), sandbox, { filename: f });
  }
  for (let i = 0; i < 4 && sandbox.__q && sandbox.__q.length; i += 1) sandbox.__q.shift()();
}

const C = /[\u3400-\u9fff]/;
function translatedCounts(root) {
  const counts = {};
  walk(root, (p) => {
    if (typeof p.text !== "string" || p.text.length < 2 || p.text.indexOf("#") === 0) return;
    if (!C.test(p.text)) return;
    const key = p.attrs.id || p.classes[0] || "?";
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

run(selector);
const a = translatedCounts(selector);
run(tooltip);
const b = translatedCounts(tooltip);
console.log("browser:", a);
console.log("tooltip:", b);

const ok = a.BuildName && a.BuildDescription && a.BuildCategoryName && a.CategoryDescription && a.ModAnnotation && b.ModifiesLabel;
console.log(ok ? "ALL CHECKS PASSED" : "CHECKS FAILED");
process.exit(ok ? 0 : 1);
