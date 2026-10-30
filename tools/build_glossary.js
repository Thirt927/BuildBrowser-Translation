// BuildBrowser Translation - build a EN->CN glossary from the local game files.
// Sources: <Deadlock>/game/citadel/resource/localization/...
// Outputs:
//   tools/glossary.json                      (used by the translation tool)
//   mod/panorama/scripts/bba_glossary.js      (used in-game for term fallback)
//
// Usage: node tools/build_glossary.js [--game-root <Deadlock>/game/citadel]
"use strict";

const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const GAME_ROOT = path.resolve(arg("game-root", ""));
if (!arg("game-root", "") || !fs.existsSync(GAME_ROOT)) {
  console.error(
    "usage: node tools/build_glossary.js --game-root <Deadlock>/game/citadel\n" +
      "example: --game-root \"C:/Program Files (x86)/Steam/steamapps/common/Deadlock/game/citadel\"",
  );
  process.exit(2);
}
const LOC = path.join(GAME_ROOT, "resource", "localization");

function parseTokens(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/"([^"]+)"[ \t]+"((?:[^"\\]|\\.)*)"/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/\\"/g, '"');
  }
  return out;
}

function pairs(englishFile, chineseFile, filter) {
  const en = parseTokens(englishFile);
  const cn = parseTokens(chineseFile);
  const map = {};
  for (const key of Object.keys(en)) {
    if (filter && !filter(key)) continue;
    const e = en[key];
    const c = cn[key];
    if (!e || !c) continue;
    if (e === c) continue; // untranslated placeholder
    map[e] = c;
  }
  return map;
}

function sortObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort((a, b) => a.length - b.length || a.localeCompare(b))) out[k] = obj[k];
  return out;
}

const modDir = path.join(LOC, "citadel_gc_mod_names");
const heroDir = path.join(LOC, "citadel_gc_hero_names");
const mainDir = path.join(LOC, "citadel_main");

const items = pairs(
  path.join(modDir, "citadel_gc_mod_names_english.txt"),
  path.join(modDir, "citadel_gc_mod_names_schinese.txt"),
  (k) => k.indexOf("_search") < 0 && /^(upgrade_|modifier_|citadel_?upgrade_)/.test(k),
);

const heroes = pairs(
  path.join(heroDir, "citadel_gc_hero_names_english.txt"),
  path.join(heroDir, "citadel_gc_hero_names_schinese.txt"),
  (k) => k.indexOf("_search") < 0 && k.indexOf("_sort") < 0 && /^hero_[a-z_]+:n$/.test(k),
);

const ranks = pairs(
  path.join(mainDir, "citadel_main_english.txt"),
  path.join(mainDir, "citadel_main_schinese.txt"),
  (k) => /^Citadel_ranks_rank\d+$/.test(k),
);

// Ability display names live in citadel_heroes_*; keep only keys that are names
// (no descriptions, quips, labels or upgrade texts).
// Accept two shapes:
//   citadel_ability_<name>            e.g. citadel_ability_bull_charge = Shoulder Charge
//   <hero>_<word>_<word...>           e.g. drifter_blood_blast = Rend
const ABILITY_SKIP = /(_desc|_quip|_label|_prefix|_postfix|_header|_on_|_t\d|_postvalue|_search|_sort)$/;
function isAbilityKey(key) {
  if (ABILITY_SKIP.test(key)) return false;
  if (key.indexOf("/") >= 0) return false;
  if (/^citadel_ability_[a-z0-9_]+$/.test(key)) return true;
  return /^[a-z]+_[a-z0-9]+_[a-z0-9_]+$/.test(key);
}
const abilities = pairs(
  path.join(LOC, "citadel_heroes", "citadel_heroes_english.txt"),
  path.join(LOC, "citadel_heroes", "citadel_heroes_schinese.txt"),
  (k) => isAbilityKey(k.replace(/:n$/, "")),
);
// Drop noisy entries: templated text, overlong values, untranslated leftovers,
// and values that are labels instead of names (trailing colon, lowercase starts).
// Internal / test hero rows that ship in the localization files are dropped too.
const INTERNAL_NAMES = /^(test hero|targetdummy|shield guy|generic person)$/i;
for (const en of Object.keys(heroes)) {
  if (INTERNAL_NAMES.test(en.replace(/\s+/g, " "))) delete heroes[en];
}
for (const en of Object.keys(abilities)) {
  const cn = abilities[en];
  if (!cn || cn.indexOf("<") >= 0 || cn.indexOf("{") >= 0 || cn.length > 40 || en.length > 40) {
    delete abilities[en];
    continue;
  }
  if (/[:：]$/.test(cn) || /^[a-z]/.test(cn)) delete abilities[en];
}

const glossary = {
  generated_at: new Date().toISOString(),
  items: sortObject(items),
  heroes: sortObject(heroes),
  ranks: sortObject(ranks),
  abilities: sortObject(abilities),
};

const outJson = path.join(__dirname, "glossary.json");
fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, JSON.stringify(glossary, null, 2));
console.log("glossary.json:", Object.keys(items).length, "items,", Object.keys(heroes).length, "heroes");

// In-game glossary: only proper nouns whose English form is safe to match inside sentences.
const inGame = {
  items: glossary.items,
  heroes: glossary.heroes,
  ranks: glossary.ranks,
};
const jsPath = path.join(__dirname, "..", "mod", "panorama", "scripts", "bba_glossary.js");
fs.mkdirSync(path.dirname(jsPath), { recursive: true });
fs.writeFileSync(
  jsPath,
  "// Generated by tools/build_glossary.js - do not edit by hand.\n" +
    "(function () {\n" +
    "  var G = " +
    JSON.stringify(inGame) +
    ";\n" +
    "  var g = globalThis || this;\n" +
    "  g.BBA_GLOSSARY = G;\n" +
    "})();\n",
);
console.log("bba_glossary.js written");
