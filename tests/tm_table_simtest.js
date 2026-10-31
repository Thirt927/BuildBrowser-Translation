// Growing-translation-table tests: dedup, masking, bounded growth, eviction,
// persistence. Pure offline.
//
// Usage: node tests/tm_table_simtest.js
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const T = require("../tools/tm_table.js");

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " -- " + detail : ""));
  if (!cond) failures += 1;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bbt-tm-"));
}

// ---------------------------------------------------------------- masking
{
  const m = T.maskNumbers("Deal +20% damage for 3.5 seconds");
  check("mask hides numbers", m.text.indexOf("20") < 0 && m.text.indexOf("3.5") < 0, m.text);
  check("mask keeps the count", m.nums.length === 2, JSON.stringify(m.nums));
  const filled = T.fillNumbers("造成 \u00ABn\u00BB% 伤害,持续 \u00ABn\u00BB 秒", "Deal +20% damage for 3.5 seconds");
  check("fill puts numbers back", filled === "造成 20% 伤害,持续 3.5 秒", filled);
}

// ---------------------------------------------------------------- simhash
{
  const a = T.simhash("Buy two more copies of this item before the team fight starts.");
  const b = T.simhash("Buy two more copies of this item before the team fight begins.");
  const c = T.simhash("Completely unrelated sentence about lane pressure and runes.");
  check("similar sentences are close", T.hammingHex(a, b) <= 8, String(T.hammingHex(a, b)));
  check("unrelated sentences are far", T.hammingHex(a, c) > 12, String(T.hammingHex(a, c)));
  check("simhash is stable", T.simhash("x y z") === T.simhash("x y z"));
}

// ---------------------------------------------------------------- exact dedup
{
  const dir = tmpDir();
  const t = new T.TranslationTable({ dir });
  t.load();
  const src = "Key item for Drifter early game.";
  const tr = "孤猎前期的重要装备。";
  check("first add inserts", t.add(src, tr, {}).added === 1);
  check("same text does not insert again", t.add(src, tr, {}).added === 0);
  check("exact lookup works", t.lookup(src).translation === tr);
  check("whitespace/case differences hit the same row", t.lookup("  key item for  DRIFTER early game. ").translation === tr);
  check("still one entry", t.summary().entries === 1, String(t.summary().entries));
}

// ---------------------------------------------------------------- template folding
{
  const dir = tmpDir();
  const t = new T.TranslationTable({ dir });
  t.load();
  t.add("Deal +20% damage for 3 seconds.", "造成 20% 伤害,持续 3 秒。", { explicit: true });
  const before = t.summary().entries;
  const r = t.add("Deal +35% damage for 6 seconds.", "造成 35% 伤害,持续 6 秒。", { explicit: true });
  check("different numbers fold into the template", r.folded === 1 && t.summary().entries === before, JSON.stringify(r));
  const hit = t.lookup("Deal +55% damage for 9 seconds.");
  check("template hit fills the numbers", hit && hit.translation === "造成 55% 伤害,持续 9 秒。", JSON.stringify(hit));
}

// ---------------------------------------------------------------- near-duplicate phrasing
{
  const dir = tmpDir();
  const t = new T.TranslationTable({ dir });
  t.load();
  const tr = "团战前先买这个。";
  t.add("Buy this item before the team fight starts.", tr, { explicit: true });
  const before = t.summary().entries;
  const r = t.add("Buy this item before the team fight begins.", tr, { explicit: true });
  check("similar phrasing with the same meaning folds", r.folded === 1, JSON.stringify(r));
  check("table did not grow", t.summary().entries === before, String(t.summary().entries));
  check("alias count is capped by policy", t.summary().aliases <= 8, String(t.summary().aliases));
}

// ---------------------------------------------------------------- admission throttle
{
  const dir = tmpDir();
  const t = new T.TranslationTable({ dir });
  t.load();
  const long = "A".repeat(200) + " unique long note that appears exactly once ever.";
  const r = t.add(long, "一条只出现一次的长笔记。", { uses: 1 });
  check("one-off long text is throttled", r.added === 0 && r.rejected === "throttled", JSON.stringify(r));
  const r2 = t.add(long, "一条只出现一次的长笔记。", { uses: 2 });
  check("second sighting is admitted", r2.added === 1, JSON.stringify(r2));
  const short = "Short note.";
  check("short text is admitted immediately", t.add(short, "短笔记。", {}).added === 1);
  const explicit = "A".repeat(200) + " but the user clicked translate.";
  check("button click bypasses the throttle", t.add(explicit, "用户点击翻译。", { explicit: true }).added === 1);
}

// ---------------------------------------------------------------- bounded growth
{
  const dir = tmpDir();
  const t = new T.TranslationTable({ dir, policy: { maxEntries: 50, maxBytes: 1 << 20 } });
  t.load();
  // Genuinely different sentences (no shared template), so the table has to grow
  // until the entry cap forces eviction.
  const vocab = ["lane", "rune", "gank", "push", "ward", "tower", "jungle", "tempo", "burst", "peel"];
  const made = [];
  for (let i = 0; i < 200; i += 1) {
    // Distinct WORD combinations (numbers would be masked away and fold together).
    const a = vocab[i % vocab.length];
    const b = vocab[Math.floor(i / vocab.length) % vocab.length];
    const c = vocab[Math.floor(i / (vocab.length * vocab.length)) % vocab.length];
    const text = "Advice about " + a + " then " + b + " while watching " + c + " and the objective timers.";
    made.push(text);
    t.add(text, "关于 " + a + b + c + " 的建议。", { explicit: true });
  }
  const s1 = t.summary();
  check("entry cap is enforced", s1.entries <= 60, String(s1.entries));
  check("evictions were reported", s1.stats.evicted > 0, String(s1.stats.evicted));
  check("most recent text survives eviction", !!t.lookup(made[made.length - 1]) || !!t.lookup(made[made.length - 2]), "newest was evicted");
}

// ---------------------------------------------------------------- persistence
{
  const dir = tmpDir();
  const t1 = new T.TranslationTable({ dir });
  t1.load();
  t1.add("Persisted note.", "持久化笔记。", { explicit: true });
  t1.add("Deal +10% damage.", "造成 10% 伤害。", { explicit: true });
  t1.flush();

  const t2 = new T.TranslationTable({ dir });
  const loaded = t2.load();
  check("rows reload from disk", loaded >= 2, String(loaded));
  check("reloaded exact lookup", t2.lookup("Persisted note.").translation === "持久化笔记。");
  check("reloaded template lookup", t2.lookup("Deal +40% damage.").translation === "造成 40% 伤害。");
  check("indexes rebuilt (no duplicate growth)", t2.add("Persisted note.", "持久化笔记。", {}).added === 0);
}

// ---------------------------------------------------------------- bad placeholders are not templated
{
  const dir = tmpDir();
  const t = new T.TranslationTable({ dir });
  t.load();
  t.add("Deal 3 hits.", "造成三下。", { explicit: true }); // translation lost the number
  const row = [...t.records.values()][0];
  check("mismatched placeholder count disables templating", !row.t && !row.sh, JSON.stringify({ t: row.t, sh: row.sh }));
  check("exact lookup still works", t.lookup("Deal 3 hits.").translation === "造成三下。");
}

console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL TM TABLE CHECKS PASSED");
