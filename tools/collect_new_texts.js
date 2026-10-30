// Harvest the in-game "untranslated text" log lines produced by
// mod/panorama/scripts/bba_translate.js and turn them into translation
// candidates for tools/build_tm.js.
//
// In game (with -condebug) every unseen English label is logged as:
//   [BBT] MISS <key> <text>
// This tool scans the console log, dedupes by key and merges the results into
// tools/cache/extra_texts.json. build_tm.js then translates those texts with
// the normal Bing + glossary pipeline and merges them into bba_tm.js.
//
// Usage:
//   node tools/collect_new_texts.js                       (auto-detect console.log)
//   node tools/collect_new_texts.js --log "<file>" --dry   (report only)
"use strict";

const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "cache");
const OUT = path.join(CACHE_DIR, "extra_texts.json");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const GAME_LOG_CANDIDATES = [
  "E:\\Steam\\steamapps\\common\\Deadlock\\game\\citadel\\console.log",
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Deadlock\\game\\citadel\\console.log",
  "D:\\Steam\\steamapps\\common\\Deadlock\\game\\citadel\\console.log",
];

function findLog() {
  const given = arg("--log", "");
  if (given) return given;
  for (const p of GAME_LOG_CANDIDATES) if (fs.existsSync(p)) return p;
  return "";
}

const MISS_RE = /\[BBT\] MISS ([0-9a-z]+-[0-9a-z]+) (.+)$/;

function parseLog(file) {
  const out = new Map();
  const text = fs.readFileSync(file, "utf8");
  // Keep it bounded: console.log can grow to many MB.
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf("[BBT] MISS ");
    if (idx < 0) continue;
    const m = MISS_RE.exec(line.slice(idx));
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (value.length < 4 || value.length > 2000) continue;
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

function loadExisting() {
  if (!fs.existsSync(OUT)) return new Map();
  try {
    const data = JSON.parse(fs.readFileSync(OUT, "utf8"));
    return new Map((data.texts || []).map((t) => [t.key || t, t.text || t]));
  } catch (e) {
    console.warn("could not read existing", OUT + ":", e.message);
    return new Map();
  }
}

function main() {
  const log = findLog();
  if (!log || !fs.existsSync(log)) {
    console.error("console.log not found; pass --log <path> (start the game with -condebug)");
    process.exit(2);
  }
  const fresh = parseLog(log);
  console.log("log:", log);
  console.log("MISS lines:", fresh.size);

  const merged = loadExisting();
  let added = 0;
  for (const [key, text] of fresh) {
    if (merged.has(key)) continue;
    merged.set(key, text);
    added += 1;
  }
  console.log("new candidates:", added, "(total " + merged.size + ")");

  const samples = [...fresh.values()].slice(0, 5);
  for (const s of samples) console.log("  e.g.", JSON.stringify(s.slice(0, 90)));

  if (process.argv.indexOf("--dry") >= 0) {
    console.log("dry run: nothing written");
    return;
  }
  if (!fresh.size && merged.size === 0) {
    console.log("nothing to write");
    return;
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const texts = [...merged].map(([key, text]) => ({ key, text }));
  fs.writeFileSync(
    OUT,
    JSON.stringify({ updated_at: new Date().toISOString(), count: texts.length, texts }, null, 0),
  );
  console.log("wrote", OUT);
  console.log("next: node tools/build_tm.js   (translates the new texts and regenerates bba_tm.js)");
}

main();
