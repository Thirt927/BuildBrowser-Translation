// Offline tests for the tools/ pipeline (no network needed):
//   * build_code: zstd + bare-protobuf decode, lossless encode round-trip
//   * build_tm:   cumulative TM merge, term protection, text-key helpers
//
// Usage: node tests/tools_simtest.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const { decode, encode, collectTexts } = require(path.join(ROOT, "tools", "build_code.js"));
const bbtm = require(path.join(ROOT, "tools", "build_tm.js"));
const glossary = require(path.join(ROOT, "tools", "glossary.json"));

let failures = 0;
function check(name, condition, extra) {
  console.log((condition ? "PASS " : "FAIL ") + name + (extra && !condition ? " -- " + extra : ""));
  if (!condition) failures += 1;
}

const sample = fs.readFileSync(path.join(ROOT, "samples", "sample-build-code.txt"), "utf8").trim();
const build = decode(sample);

// --- decode: zstd code and bare protobuf ---
const rawProto = zlib.zstdDecompressSync(Buffer.from(sample, "base64"));
const bare = decode(rawProto.toString("base64"));
check("bare protobuf decodes", bare.hero_build_id === build.hero_build_id, "id=" + bare.hero_build_id);
check("bare protobuf name matches", bare.name === build.name);

// --- encode: lossless round-trip ---
const reencoded = decode(encode(build));
check(
  "round-trip keeps ability_order",
  reencoded.details.ability_order.length === build.details.ability_order.length &&
    build.details.ability_order.length > 0,
  "order=" + build.details.ability_order.length + " -> " + reencoded.details.ability_order.length,
);
check(
  "round-trip keeps ability notes",
  JSON.stringify(reencoded.details.ability_order) === JSON.stringify(build.details.ability_order),
);
check(
  "round-trip keeps categories/annotations",
  JSON.stringify(reencoded.details.mod_categories) === JSON.stringify(build.details.mod_categories),
);
check("round-trip keeps development_build flag", reencoded.development_build === build.development_build);
check("round-trip keeps tags", JSON.stringify(reencoded.tags) === JSON.stringify(build.tags));

// --- TM merge: the shipped bba_tm.js is parseable and looked up by key ---
const existing = bbtm.loadExistingTm();
check("shipped TM parses via loadExistingTm", !!existing, existing ? "" : "parse failed");
if (existing) {
  const count = Object.keys(existing).length;
  check("shipped TM keeps its entries", count > 50000, "count=" + count);
  const text = collectTexts(build).find((t) => !/[\u3400-\u9fff]/.test(t.text) && t.text.length >= 8);
  if (text) {
    const hit = existing[bbtm.textKey(text.text)];
    check("known sample text is in the shipped TM", typeof hit === "string", text.text.slice(0, 40));
  }
}

// --- compact TM format: lossless round-trip + script wiring ---
{
  const tmFormat = require(path.join(ROOT, "tools", "tm_format.js"));
  const sample = {
    "a1-b2": "撕裂 > 治疗 > 重复。",
    "z9-y8": "带\ttab 和\n换行与\\反斜杠的值",
    "m3-n4": "最后一个",
  };
  const data = tmFormat.encode(sample);
  const back = tmFormat.decode(data);
  check("compact encode/decode round-trip", JSON.stringify(back) === JSON.stringify(Object.keys(sample).sort().reduce((o, k) => ((o[k] = sample[k]), o), {})), JSON.stringify(back));
  check("compact escapes tabs/newlines/backslashes", back["z9-y8"] === sample["z9-y8"], JSON.stringify(back["z9-y8"]));

  const script = tmFormat.emitScript(sample, { generated_at: "test" });
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(script, sb, { filename: "tm_emit.js" });
  check("emitted script exposes BBA_TM_GET", typeof sb.BBA_TM_GET === "function");
  check("emitted script lookup works", sb.BBA_TM_GET("a1-b2") === sample["a1-b2"]);
  check("emitted script escapes survive", sb.BBA_TM_GET("z9-y8") === sample["z9-y8"]);
  check("emitted script misses return null", sb.BBA_TM_GET("nope-nope") === null);
  check("emitted count matches", sb.BBA_TM_COUNT === 3, String(sb.BBA_TM_COUNT));
}

// --- term protection ---
const protector = bbtm.buildProtector(glossary);
check("protector has terms", protector.terms.length > 100, "terms=" + protector.terms.length);
const p = bbtm.protect("Good picks for Haze and Venator, bring Spirit Snatch.", protector);
check("terms are masked", p.text.indexOf("\u27e6") >= 0, p.text);
check("heroes were protected", p.used.includes("岚梦") && p.used.includes("诛邪者"), JSON.stringify(p.used));
const restored = bbtm.restore("x\u27e6" + p.used.indexOf("岚梦") + "\u27e7y", p.used);
check("restore puts official name back", restored === "x岚梦y", restored);
check("no term leaks unmasked", protector.terms.every((t) => p.text.indexOf(t.en) < 0 || p.text.indexOf("\u27e6") < 0));

if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
