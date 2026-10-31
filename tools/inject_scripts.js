// BuildBrowser Translation - inject the BBT <scripts> includes into a
// decompiled game layout so the in-game translator covers it too.
//
// Usage:
//   node tools/inject_scripts.js <path to decompiled layout .xml> [--out <target .xml>]
//
//   e.g. decompile a whole panorama/layout tree with Source 2 Viewer, then:
//   node tools/inject_scripts.js layout/citadel_ui_build_details.xml
//
// Without --out the file is written into mod/panorama/layout/ at the same
// relative path (the build script picks up new overrides automatically).
// The game's original structure is kept byte-for-byte; only a <scripts>
// block is inserted right after <styles> (or at the top when absent).
// --no-tm omits the translation-memory include (for short-lived tooltip
// layouts that read BBA_TM from the shared globalThis instead).
"use strict";

const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const input = process.argv[2];
if (!input || !fs.existsSync(input)) {
  console.error("usage: node tools/inject_scripts.js <decompiled .xml> [--out <target .xml>] [--no-tm]");
  process.exit(2);
}

const withTm = process.argv.indexOf("--no-tm") < 0;
let xml = fs.readFileSync(input, "utf8");

// Stripping the existing <scripts> block happens below; re-running this tool
// on a decompiled layout that already carries BBT includes simply refreshes the
// override's structure (game updates), so no early exit here.

// Strip existing <scripts> blocks so re-running stays idempotent.
xml = xml.replace(/\s*<scripts>[\s\S]*?<\/scripts>/g, "");

const includes = [
  '<include src="s2r://panorama/scripts/bba_glossary.vjs_c" />',
  ...(withTm ? ['<include src="s2r://panorama/scripts/bba_tm.vjs_c" />'] : []),
  '<include src="s2r://panorama/scripts/bba_layout_tokens.vjs_c" />',
  '<include src="s2r://panorama/scripts/bba_translate.vjs_c" />',
];
const SCRIPTS_BLOCK =
  "\t<scripts>\n\t\t" + includes.join("\n\t\t") + "\n\t</scripts>\n";

let m;
if ((m = xml.match(/<styles>[\s\S]*?<\/styles>/))) {
  // insert after the styles block
  xml = xml.replace(m[0], m[0] + "\n" + SCRIPTS_BLOCK);
} else if ((m = xml.match(/<(?!styles)([a-zA-Z0-9_]+)[^>]*>/))) {
  // no <styles>: insert after the first top-level element
  xml = xml.replace(m[0], m[0] + "\n" + SCRIPTS_BLOCK);
} else {
  console.error("could not find <styles> or a top-level element to anchor on");
  process.exit(1);
}

const outArg = arg("--out", "");
let out;
if (outArg) {
  out = path.resolve(outArg);
} else {
  // Map the decompiled tree into mod/panorama/layout/, preserving the
  // relative path below "panorama/layout" (or "layout").
  const norm = input.replace(/\\/g, "/");
  const atPano = norm.indexOf("panorama/layout/");
  const atLayout = norm.indexOf("/layout/");
  let rel;
  if (atPano >= 0) rel = norm.slice(atPano + "panorama/layout/".length);
  else if (atLayout >= 0) rel = norm.slice(atLayout + "/layout/".length);
  else rel = path.basename(norm);
  out = path.join(__dirname, "..", "mod", "panorama", "layout", rel);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, xml);
console.log("wrote override ->", out);
console.log("remember: update the required-file list in scripts/build.ps1 if you deploy it");
