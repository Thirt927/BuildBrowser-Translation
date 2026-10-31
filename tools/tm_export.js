// BuildBrowser Translation - export the local table as an installable pack.
//
// Only public data goes in: these rows are translations of build text that came
// from the deadlock-api (public builds) or from what the game itself displayed.
//
// Usage:
//   node tools/tm_export.js                       # all local rows -> dist/tm_pack_<date>.json
//   node tools/tm_export.js --since 2026-10-01    # only rows touched after that date
//   node tools/tm_export.js --lg zh-Hans          # one language
//   node tools/tm_export.js --out my_pack.json
//
// The pack is a plain JSON document:
//   { schema, generatedAt, count, languages: {..}, rows: [ {lg,text,translation,source,uses} ] }
// Drop packs into tools/packs/ and `node tools/build_tm.js` merges them into the
// shipped memory, so maintainers can ship community contributions without asking
// anyone to run a bridge.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { TranslationTable, DEFAULT_LANG } = require("./tm_table.js");

const ROOT = path.join(__dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const distDir = path.join(ROOT, "dist");
const stamp = new Date().toISOString().slice(0, 10);
const outFile = String(arg("out", path.join(distDir, "tm_pack_" + stamp + ".json")));
const lg = arg("lg", "");
const sinceArg = arg("since", "");
const includePipeline = !!arg("include-pipeline", false);

let since = 0;
if (sinceArg) {
  const t = Date.parse(String(sinceArg) + "T00:00:00Z");
  since = Number.isNaN(t) ? Number(sinceArg) || 0 : t;
}

const table = new TranslationTable({ dir: path.join(ROOT, "tools", "cache") });
const loaded = table.load();
const rows = table.exportRows({ since, lg, includePipeline });
const languages = {};
for (const r of rows) languages[r.lg] = (languages[r.lg] || 0) + 1;

const pack = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  count: rows.length,
  languages,
  filters: { since: since || null, lg: lg || null, includePipeline },
  rows,
};
const body = JSON.stringify(pack, null, 1);
const sha = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, body);
console.log(
  "exported " + rows.length + " rows (" + loaded + " in the local table) -> " +
    path.relative(ROOT, outFile) + "  sha256:" + sha,
);
console.log("languages:", JSON.stringify(languages));
if (!rows.length) console.log("nothing to export yet: play a bit with the bridge running");
