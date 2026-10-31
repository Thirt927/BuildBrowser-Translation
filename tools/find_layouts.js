// Find which decompiled layout files contain a localization token or text.
//
// Use case: a panel is not being translated and you do not know which layout file
// it lives in. Point this at the folder where Source 2 Viewer exported the
// decompiled layouts and it tells you the file names to feed to
// tools/get_layouts.ps1.
//
// Usage:
//   node tools/find_layouts.js <decompiled dir> --token Citadel_HeroBuilds_BuildDescription
//   node tools/find_layouts.js <decompiled dir> --text  Overview
//   node tools/find_layouts.js <decompiled dir> --token Build --all
"use strict";

const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
  console.error("usage: node tools/find_layouts.js <decompiled dir> --token <name> | --text <word>");
  process.exit(2);
}
const token = String(arg("token", "") || "");
const text = String(arg("text", "") || "");
if (!token && !text) {
  console.error("pass --token <localization token fragment> or --text <literal text>");
  process.exit(2);
}
const needle = (token || text).toLowerCase();

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(xml|vxml)$/i.test(e.name)) out.push(p);
  }
}

const files = [];
walk(root, files);
console.log("scanned " + files.length + " layout files under " + root);

let hits = 0;
for (const f of files) {
  let body;
  try {
    body = fs.readFileSync(f, "utf8");
  } catch (e) {
    continue;
  }
  const idx = body.toLowerCase().indexOf(needle);
  if (idx < 0) continue;
  hits += 1;
  const line = body.slice(0, idx).split(/\r?\n/).length;
  const snippet = body.slice(Math.max(0, idx - 60), idx + 80).replace(/\s+/g, " ");
  console.log("- " + path.relative(root, f) + "  (line " + line + ")");
  console.log("    ..." + snippet + "...");
}

if (!hits) {
  console.log("no match. Try a shorter fragment, or check that the export kept the file names.");
} else {
  const names = [];
  for (const f of files) {
    try {
      if (fs.readFileSync(f, "utf8").toLowerCase().indexOf(needle) >= 0) names.push(path.basename(f, path.extname(f)));
    } catch (e) {}
  }
  console.log("");
  console.log("inject these (one command):");
  console.log('  powershell -ExecutionPolicy Bypass -File tools\\get_layouts.ps1 -S2VDir "' + root + '" -Names "' + names.join(",") + '" -NoTm');
}
