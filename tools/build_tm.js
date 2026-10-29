// BuildBrowser Translation - build the in-game translation memory (bba_tm.js).
//
// Pipeline:
//   1. read tools/cache/builds.json (tools/fetch_builds.js) + optional --seed share codes
//   2. collect every user-authored text (name / description / category / annotation)
//   3. protect proper nouns (items, heroes, ranks, abilities) with placeholders
//   4. translate with the free Bing endpoint (batched, resumable cache)
//   5. write mod/panorama/scripts/bba_tm.js  (normalized-text hash -> Chinese)
//
// Usage:
//   node tools/build_tm.js [--seed 1.txt] [--limit 0] [--dry]
"use strict";

const fs = require("fs");
const path = require("path");
const bing = require("./providers/bing.js");
const { decode, collectTexts } = require("./build_code.js");

const CACHE_DIR = path.join(__dirname, "cache");
const BUILD_CACHE = path.join(CACHE_DIR, "builds.json");
const TRANS_CACHE = path.join(CACHE_DIR, "translations.json");
const GLOSSARY_FILE = path.join(__dirname, "glossary.json");
const OUT_JS = path.join(__dirname, "..", "mod", "panorama", "scripts", "bba_tm.js");

const CONCURRENCY = Number(arg("concurrency", 8));
const BATCH_CHARS = Number(arg("batch", 900));
const SEP = "\n@@@\n";

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- shared text helpers (must stay in sync with mod/panorama/scripts/bba_translate.js) ----

function normalizeText(input) {
  return String(input == null ? "" : input)
    .replace(/\uFEFF/g, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function flattenText(input) {
  return normalizeText(input).replace(/\s+/g, " ");
}

function hash32(input, seed) {
  let h = seed >>> 0;
  const s = String(input);
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 33 + s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function textKey(input) {
  const flat = flattenText(input);
  return hash32(flat, 5381).toString(36) + "-" + hash32(flat, 52711).toString(36);
}

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/;
// Duplicated builds carry a localized "(copy)" suffix; the in-game lookup strips it
// before hashing, so the translation memory stores the base text only.
const COPY_SUFFIX = /\s*(的副本|\(Copy\)|\(copy\)|Copy)$/;

function hasCJK(text) {
  return CJK.test(text);
}

// Localization tokens (#Token), class names and bare URLs are not user text:
// the game already renders them in Chinese, and translating them corrupts the UI.
function isTokenOrNoise(text) {
  if (/^#/.test(text)) return true;
  if (/^https?:\/\//i.test(text)) return true;
  if (/^(upgrade|citadel|modifier|hero|ability|item)_[a-z0-9_]+$/i.test(text)) return true;
  return false;
}

// ---- glossary / placeholder protection ----

function loadGlossary() {
  if (!fs.existsSync(GLOSSARY_FILE)) throw new Error("run tools/build_glossary.js first");
  const g = JSON.parse(fs.readFileSync(GLOSSARY_FILE, "utf8"));
  return { items: g.items || {}, heroes: g.heroes || {}, ranks: g.ranks || {}, abilities: g.abilities || {} };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build one regex that matches any protected term, longest first, case-insensitive but
// restricted to whole words. Only terms that are safe to see inside a sentence are used.
function buildProtector(glossary) {
  const terms = [];
  const add = (map, kind, minLen, caseSensitive) => {
    for (const en of Object.keys(map)) {
      if (en.length < minLen) continue;
      if (/\s{2,}/.test(en)) continue;
      if (en.length > 48) continue;
      terms.push({ en, cn: map[en], kind, caseSensitive: !!caseSensitive });
    }
  };
  add(glossary.items, "item", 4, false);
  // Ability names are deliberately NOT protected: several of them are ordinary English
  // words ("Move", "Jump", "Heart"), and forcing their official name into a sentence
  // produces worse text than letting the translator pick a natural wording.
  add(glossary.heroes, "hero", 3, true);
  add(glossary.ranks, "rank", 5, true);
  terms.sort((a, b) => b.en.length - a.en.length);

  const pattern = terms.map((t) => escapeRegex(t.en)).join("|");
  if (!pattern) return { terms, regex: null };
  // Case sensitivity is approximated: match case-insensitively, then verify the hero/ability
  // term appears with a capital letter (it always does in build descriptions).
  const regex = new RegExp("(?<![A-Za-z0-9])(" + pattern + ")(?![A-Za-z0-9])", "gi");
  return { terms, regex };
}

function protect(text, protector) {
  const used = [];
  const out = text.replace(protector.regex, (match) => {
    const source = match.trim();
    let found = null;
    for (const t of protector.terms) {
      if (t.en.length !== source.length) continue;
      if (t.en.toLowerCase() === source.toLowerCase()) {
        found = t;
        break;
      }
    }
    if (!found) return match;
    if (found.caseSensitive) {
      const first = source.charAt(0);
      if (first !== first.toUpperCase() || first === first.toLowerCase()) return match;
    }
    const index = used.length;
    used.push(found.cn);
    return "\u27e6" + index + "\u27e7";
  });
  return { text: out, used };
}

function restore(text, used) {
  let out = text;
  for (let i = 0; i < used.length; i += 1) {
    const token = "\u27e6" + i + "\u27e7";
    out = out.split(token).join(used[i]);
    // Bing sometimes respells the brackets or adds spaces inside them.
    out = out.split("\u27e6 " + i + " \u27e7").join(used[i]);
    out = out.split("[" + i + "]").join(used[i]);
    out = out.split("[[" + i + "]]").join(used[i]);
  }
  // Chinese text does not need spaces between CJK characters that Bing inserts around terms.
  out = out.replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2");
  out = out.replace(/\s+([，。！？、；：）】」])/g, "$1");
  out = out.replace(/([（【「])\s+/g, "$1");
  return out.trim();
}

// ---- translation driver ----

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(TRANS_CACHE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(TRANS_CACHE, JSON.stringify(cache));
}

async function translateOne(text, protector, cache) {
  const key = textKey(text);
  if (cache[key]) return cache[key];
  const { text: masked, used } = protect(text, protector);
  let result = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const r = await bing.translate(masked, {
        sourceLanguage: "auto",
        targetLanguage: "zh-Hans",
        timeoutMs: 30000,
      });
      if (r.translation && r.translation.trim()) {
        result = restore(r.translation, used);
        break;
      }
    } catch (e) {
      lastError = e;
      if (/验证码|captcha|429|频繁/i.test(e.message)) await sleep(4000 * attempt);
      else await sleep(1200 * attempt);
    }
  }
  if (result === null) throw new Error("translate failed: " + (lastError ? lastError.message : "empty"));
  cache[key] = result;
  return result;
}

async function translateBatch(texts, protector, cache) {
  const missing = texts.filter((t) => !cache[textKey(t)]);
  if (!missing.length) return;
  if (missing.length === 1) {
    await translateOne(missing[0], protector, cache);
    return;
  }
  const maskedList = [];
  const usedList = [];
  let joined = "";
  for (const t of missing) {
    const p = protect(t, protector);
    maskedList.push(p.text);
    usedList.push(p.used);
    joined += (joined ? SEP : "") + p.text;
  }
  try {
    const r = await bing.translate(joined, { sourceLanguage: "auto", targetLanguage: "zh-Hans", timeoutMs: 40000 });
    const parts = r.translation.split(/\n?@@@\n?/);
    if (parts.length !== maskedList.length) throw new Error("segment mismatch " + parts.length + "/" + maskedList.length);
    parts.forEach((part, i) => {
      const key = textKey(missing[i]);
      cache[key] = restore(part, usedList[i]);
    });
  } catch (e) {
    if (missing.length <= 2) {
      for (const t of missing) await translateOne(t, protector, cache);
      return;
    }
    const mid = Math.floor(missing.length / 2);
    await translateBatch(missing.slice(0, mid), protector, cache);
    await translateBatch(missing.slice(mid), protector, cache);
  }
}

async function pool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = items[index++];
      try {
        await worker(current);
      } catch (e) {
        console.warn("worker error:", e.message);
      }
    }
  });
  await Promise.all(runners);
}

function chunkItems(items, budget) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const len = item.length + SEP.length;
    if (current.length && chars + len > budget) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

// ---- main ----

async function main() {
  const seeds = [];
  const seedArg = arg("seed", null);
  if (seedArg && seedArg !== true) {
    for (const file of String(seedArg).split(",")) {
      const p = path.isAbsolute(file) ? file : path.join(__dirname, "..", file);
      if (fs.existsSync(p)) seeds.push(decode(fs.readFileSync(p, "utf8")));
    }
  }

  const data = fs.existsSync(BUILD_CACHE) ? JSON.parse(fs.readFileSync(BUILD_CACHE, "utf8")) : { builds: [] };
  const allBuilds = data.builds.map((row) => row.hero_build || row).concat(seeds);
  const limit = Number(arg("limit", 0));
  const builds = limit > 0 ? allBuilds.slice(0, limit) : allBuilds;
  console.log("builds:", builds.length, "(+seeds " + seeds.length + ")");

  const texts = new Map(); // key -> { text, kinds:Set, count }
  for (const build of builds) {
    for (const entry of collectTexts(build)) {
      const text = normalizeText(entry.text).replace(COPY_SUFFIX, "").trim();
      if (!text || text.length < 2) continue;
      if (hasCJK(text)) continue;
      if (!/[A-Za-z]/.test(text)) continue;
      if (isTokenOrNoise(text)) continue;
      const key = textKey(text);
      if (!texts.has(key)) texts.set(key, { text, kinds: new Set(), count: 0 });
      const item = texts.get(key);
      item.kinds.add(entry.kind);
      item.count += 1;
    }
  }
  console.log("unique texts:", texts.size);

  if (arg("dry", false)) {
    const list = [...texts.values()];
    console.log(list.slice(0, 10).map((i) => i.text.slice(0, 80)));
    return;
  }

  const glossary = loadGlossary();
  const protector = buildProtector(glossary);
  console.log("protected terms:", protector.terms.length);

  const cache = loadCache();
  const pending = [...texts.values()].filter((i) => !cache[textKey(i.text)]);
  console.log("cached:", texts.size - pending.length, "pending:", pending.length);

  const short = pending.filter((i) => i.text.length <= BATCH_CHARS).map((i) => i.text);
  const long = pending.filter((i) => i.text.length > BATCH_CHARS).map((i) => i.text);
  const batches = chunkItems(short, BATCH_CHARS);
  console.log("batches:", batches.length, "long texts:", long.length);

  let done = 0;
  const totalBatches = batches.length + long.length;
  const tick = setInterval(() => {
    saveCache(cache);
  }, 15000);

  await pool(batches, CONCURRENCY, async (batch) => {
    await translateBatch(batch, protector, cache);
    done += 1;
    if (done % 20 === 0) console.log("progress:", done + "/" + totalBatches, "cached", Object.keys(cache).length);
  });
  await pool(long, CONCURRENCY, async (text) => {
    await translateOne(text, protector, cache);
    done += 1;
  });

  clearInterval(tick);
  saveCache(cache);

  // Assemble the in-game map. Lookup is always done on the flattened text, so the
  // canonical key is the same as the flat one.
  const entries = new Map();
  let missing = 0;
  for (const item of texts.values()) {
    const key = textKey(item.text);
    const tr = cache[key];
    if (!tr) {
      missing += 1;
      continue;
    }
    entries.set(key, tr);
  }
  console.log("entries:", entries.size, "missing:", missing);

  const body = "// Generated by tools/build_tm.js - do not edit by hand.\n" +
    "// " + entries.size + " texts, " + new Date().toISOString() + "\n" +
    "(function () {\n  var T = {" +
    [...entries].map(([k, v]) => JSON.stringify(k) + ":" + JSON.stringify(v)).join(",") +
    "};\n  var g = globalThis || this;\n  g.BBA_TM = T;\n})();\n";
  fs.mkdirSync(path.dirname(OUT_JS), { recursive: true });
  fs.writeFileSync(OUT_JS, body);
  console.log("bba_tm.js:", (fs.statSync(OUT_JS).size / (1024 * 1024)).toFixed(2), "MB");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
