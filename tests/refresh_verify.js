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

function boot(root) {
  const queue = [];
  const log = [];
  const sandbox = {
    console: { log() {} },
    $: {
      GetContextPanel: () => root,
      Schedule: (d, fn) => queue.push(fn),
      Msg: (m) => log.push(String(m)),
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

fs.rmSync(TMP, { recursive: true, force: true });
console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL REFRESH CHECKS PASSED");
