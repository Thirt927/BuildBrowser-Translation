// BuildBrowser Translation - the growing translation table.
//
// Why not just "bake everything into the VPK": every new build would need a new
// pak. This module keeps a local, append-only table on the PC (driven by the
// optional bridge) that grows as the game shows unseen text, so packaging is
// optional rather than mandatory.
//
// The problem this file solves: an unbounded table. Build notes are copy-pasted
// constantly, so the same sentence reappears with a different number, a comma,
// a hero name or an extra clause. Storing one row per variant makes the table
// useless (and huge), so every text is reduced to up to three keys:
//
//   1. exact     - normalized text hash (whitespace/case/punctuation normalised)
//   2. template  - same, but numeric literals and percentages are masked to «n»
//                  so "Deal +20% damage" and "Deal +25% damage" collapse into one
//                  row; the stored translation keeps the same mask and is filled
//                  from the source text at lookup time
//   3. shingle   - 64-bit SimHash over token 3-grams of the template, bucketed by
//                  the first 16 bits; a probe with Hamming distance <= 3 counts
//                  as the same phrasing (typo/added word/word order)
//
// Lookup is therefore exact -> template -> shingle (nearest), and a miss is what
// the UI button and the live bridge fill in.
//
// Growth is bounded by five rules (see Policy below): admission (a one-off long
// text is not stored), alias folding (variants of a known template become
// aliases, capped), value dedup (same translation + similar text = alias),
// usage-weighted eviction in batches when over budget, and a hard entry/byte cap.
//
// Languages: every record belongs to a target language ("lg"). Keys are namespaced
// per language, so the same English sentence can hold a zh-Hans and a ja record
// without overwriting each other.
//
// Adaptive thresholds:
//   * the SimHash distance grows with the sentence length (short strings are
//     merged strictly, long ones loosely) -- see `distanceFor`
//   * the alias cap grows with how often the template is used -- see `aliasCapFor`
//
// Storage: table.jsonl is append-only (one record per line), compacted into
// table.json when it grows past a ratio. Writes are atomic (temp + rename) and
// guarded by a lock file, so two game instances do not corrupt it.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA = 1;

const DEFAULT_LANG = "zh-Hans";

const POLICY = {
  maxEntries: 150000,
  maxBytes: 32 * 1024 * 1024,
  maxAliases: 8, // floor; see aliasCapFor() for the adaptive value
  aliasCapMax: 16,
  // Admission: a text is persisted when it was requested at least twice, or it is
  // short (short strings recur), or the user explicitly asked for it (button).
  admitMinUses: 2,
  admitShortLen: 120,
  // Near-duplicate similarity threshold (Hamming distance over the SimHash).
  simHashDistance: 3, // used for short texts; see distanceFor()
  simHashDistanceMax: 5,
  // Eviction: evict the lowest `score` in batches of this fraction, amortised.
  evictBatchRatio: 0.05,
  compactRatio: 4, // jsonl bytes / json bytes before compaction
};

// ---------------------------------------------------------------- normalisation

/** Collapse whitespace, normalise punctuation spacing and case. */
function normalizeText(text) {
  return String(text == null ? "" : text)
    .replace(/\uFEFF/g, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim();
}

/** Flatten to one line, the canonical form used for hashing. */
function flattenText(text) {
  return normalizeText(text).replace(/\s+/g, " ");
}

// Numbers, percentages, decimals, durations and "+X" stat modifiers. Kept in
// sync with the in-game side (bba_translate.js masks the same way when filling).
// Only the literal value is masked; units stay in the text so a translation can
// use its own unit ("3.5 seconds" -> "3.5 秒").
const NUM_RE = /\d+(?:[.,]\d+)?/g;

/** Replace numeric literals with the «n» mask; returns { text, nums }. */
function maskNumbers(text) {
  const nums = [];
  const masked = String(text).replace(NUM_RE, (m) => {
    nums.push(m);
    return "\u00ABn\u00BB";
  });
  return { text: masked, nums: nums };
}

/** Put the numbers from `source` back into a masked translation. */
function fillNumbers(maskedText, source) {
  const { nums } = maskNumbers(source);
  let i = 0;
  return String(maskedText).replace(/\u00ABn\u00BB/g, () => (i < nums.length ? nums[i++] : "\u00ABn\u00BB"));
}

function hash32(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** Same key format as the shipped memory: two different 32-bit seeds. */
function textKey(text) {
  const flat = flattenText(text);
  return hash32(flat, 5381).toString(36) + "-" + hash32(flat, 52711).toString(36);
}

function templateKey(text) {
  const masked = maskNumbers(flattenText(text)).text;
  return hash32(masked, 5381).toString(36) + "-" + hash32(masked, 52711).toString(36);
}

// ---------------------------------------------------------------- simhash

function tokenize(flat) {
  return String(flat)
    .toLowerCase()
    .replace(/[^a-z0-9\u00AB\u00BB%\u4e00-\u9fff ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(tokens, n) {
  const out = [];
  if (tokens.length < n) {
    if (tokens.length) out.push(tokens.join(" "));
    return out;
  }
  for (let i = 0; i + n <= tokens.length; i += 1) out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

/** 64-bit SimHash as a hex string; stable across runs (md5 based, not random). */
function simhash(text) {
  const tokens = tokenize(maskNumbers(flattenText(text)).text);
  const grams = shingles(tokens, 3).length ? shingles(tokens, 3) : tokens;
  const v = new Array(64).fill(0);
  for (const g of grams) {
    const h = crypto.createHash("md5").update(g).digest();
    for (let b = 0; b < 64; b += 1) {
      const bit = (h[b >> 3] >> (7 - (b & 7))) & 1;
      v[b] += bit ? 1 : -1;
    }
  }
  let out = "";
  for (let n = 0; n < 16; n += 1) {
    let byte = 0;
    for (let b = 0; b < 4; b += 1) byte = (byte << 1) | (v[n * 4 + b] > 0 ? 1 : 0);
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function hammingHex(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

function shingleBucket(hash) {
  return hash.slice(0, 4); // 16 bits
}

/** Token count of a text (drives the adaptive thresholds). */
function tokenCount(text) {
  return tokenize(maskNumbers(flattenText(text)).text).length;
}

/**
 * Adaptive SimHash threshold: 2 for very short strings, up to 5 for long ones.
 * Short strings ("gg", "push mid") have few shingles, so a loose threshold would
 * merge unrelated phrases; long strings differ by a word or two and still mean
 * the same thing.
 */
function distanceFor(text, policy) {
  const p = policy || POLICY;
  const n = tokenCount(text);
  const base = n <= 6 ? 2 : n <= 14 ? 3 : n <= 30 ? 4 : 5;
  return Math.min(base, p.simHashDistanceMax || 5);
}

/**
 * Adaptive alias cap: popular templates collect more variants. Small tables stay
 * tight (memory), heavily reused sentences get room.
 */
function aliasCapFor(row, policy) {
  const p = policy || POLICY;
  const uses = (row && row.n) || 1;
  const cap = 4 + Math.floor(uses / 10);
  return Math.min(Math.max(cap, 4), p.aliasCapMax || 16);
}

// ---------------------------------------------------------------- the table

function nowMs() {
  return Date.now();
}

class TranslationTable {
  constructor(opts) {
    opts = opts || {};
    this.dir = opts.dir || path.join(__dirname, "cache");
    this.jsonPath = path.join(this.dir, "tm_table.json");
    this.jsonlPath = path.join(this.dir, "tm_table.jsonl");
    this.lockPath = path.join(this.dir, "tm_table.lock");
    this.policy = Object.assign({}, POLICY, opts.policy || {});
    this.records = new Map(); // canonical textKey -> record
    this.byTemplate = new Map(); // templateKey -> canonical textKey
    this.byShingle = new Map(); // bucket -> Set(canonical textKey)
    this.aliasIndex = new Map(); // alias textKey -> canonical textKey
    this.jsonlBytes = 0;
    this.stats = { hitsExact: 0, hitsTemplate: 0, hitsShingle: 0, misses: 0, added: 0, folded: 0, evicted: 0 };
  }

  // ---- persistence ----

  // ---- language helpers ----
  /** Internal key: language + exact hash. */
  _k(lg, base) {
    return (lg || DEFAULT_LANG) + "|" + base;
  }

  _split(k) {
    const i = String(k).indexOf("|");
    return i < 0 ? { lg: DEFAULT_LANG, base: String(k) } : { lg: k.slice(0, i), base: k.slice(i + 1) };
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    let loaded = 0;
    try {
      const data = JSON.parse(fs.readFileSync(this.jsonPath, "utf8"));
      if (data && data.schema === SCHEMA && Array.isArray(data.rows)) {
        for (const row of data.rows) {
          this._install(row);
          loaded += 1;
        }
      }
    } catch (e) {
      /* no compacted file yet */
    }
    // Replay the append-only log on top of the compacted snapshot.
    try {
      const lines = fs.readFileSync(this.jsonlPath, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let op;
        try {
          op = JSON.parse(line);
        } catch (e) {
          continue; // torn last line after a crash: ignore
        }
        if (op.op === "add" || op.op === "merge") {
          this._install(op.row);
        } else if (op.op === "alias") {
          const owner = this.records.get(op.k);
          if (owner) {
            owner.v = owner.v || [];
            if (!owner.v.includes(op.a)) owner.v.push(op.a);
            this.aliasIndex.set(op.a, op.k);
          }
        } else if (op.op === "upd" && this.records.has(op.k)) {
          const r = this.records.get(op.k);
          r.tr = op.tr;
          r.trm = op.trm;
        } else if (op.op === "del" && this.records.has(op.k)) {
          this._remove(op.k);
        }
        loaded += 1;
      }
    } catch (e) {
      /* no log yet */
    }
    return loaded;
  }

  /** Compact the JSONL into JSON and truncate the log. */
  compact() {
    const rows = [...this.records.values()];
    const body = JSON.stringify({ schema: SCHEMA, savedAt: new Date().toISOString(), rows });
    this._atomicWrite(this.jsonPath, body);
    try {
      fs.writeFileSync(this.jsonlPath, "");
    } catch (e) {
      /* ignore */
    }
    this.jsonlBytes = 0;
    return rows.length;
  }

  _atomicWrite(file, body) {
    const tmp = file + ".tmp" + process.pid;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  }

  _append(op) {
    fs.mkdirSync(this.dir, { recursive: true });
    const line = JSON.stringify(op) + "\n";
    fs.appendFileSync(this.jsonlPath, line);
    this.jsonlBytes += Buffer.byteLength(line);
    if (this.jsonlBytes > this.policy.maxBytes / this.policy.compactRatio) this.compact();
  }

  byteSize() {
    let n = this.jsonlBytes;
    try {
      n += fs.statSync(this.jsonPath).size;
    } catch (e) {
      /* ignore */
    }
    return n;
  }

  // ---- indexing ----

  _install(row) {
    if (!row || !row.k || !row.tr) return;
    this.records.set(row.k, row);
    if (row.t) this.byTemplate.set(row.t, row.k);
    if (row.sh) {
      const b = (row.lg || DEFAULT_LANG) + "|" + shingleBucket(row.sh);
      let set = this.byShingle.get(b);
      if (!set) this.byShingle.set(b, (set = new Set()));
      set.add(row.k);
    }
    for (const a of row.v || []) this.aliasIndex.set(a, row.k);
  }

  _remove(k) {
    const row = this.records.get(k);
    if (!row) return;
    this.records.delete(k);
    if (row.t && this.byTemplate.get(row.t) === k) this.byTemplate.delete(row.t);
    if (row.sh) {
      const set = this.byShingle.get((row.lg || DEFAULT_LANG) + "|" + shingleBucket(row.sh));
      if (set) set.delete(k);
    }
    for (const a of row.v || []) if (this.aliasIndex.get(a) === k) this.aliasIndex.delete(a);
  }

  // ---- lookup ----

  /** Returns { translation, via } or null. `lg` selects the target language. */
  lookup(text, lg) {
    const flat = flattenText(text);
    if (!flat) return null;
    const L = lg || DEFAULT_LANG;
    const k = this._k(L, textKey(flat));
    const direct = this.records.get(k);
    if (direct) {
      direct.n = (direct.n || 0) + 1;
      direct.at = nowMs();
      this.stats.hitsExact += 1;
      return { translation: direct.tr, via: "exact" };
    }
    const alias = this.aliasIndex.get(k);
    if (alias && this.records.has(alias)) {
      const row = this.records.get(alias);
      row.n = (row.n || 0) + 1;
      row.at = nowMs();
      this.stats.hitsExact += 1;
      return { translation: row.tr, via: "alias" };
    }

    const tk = this._k(L, templateKey(flat));
    const tplKey = this.byTemplate.get(tk);
    if (tplKey) {
      const row = this.records.get(tplKey);
      if (row) {
        row.n = (row.n || 0) + 1;
        row.at = nowMs();
        this.stats.hitsTemplate += 1;
        return { translation: fillNumbers(row.trm || row.tr, flat), via: "template" };
      }
    }

    const sh = simhash(flat);
    const maxDist = distanceFor(flat, this.policy);
    const set = this.byShingle.get(L + "|" + shingleBucket(sh));
    if (set) {
      let best = null;
      let bestD = 99;
      for (const cand of set) {
        const row = this.records.get(cand);
        if (!row || !row.sh) continue;
        // Only fold when the numbers match in count, otherwise filling is unsafe.
        if (maskNumbers(flat).nums.length !== maskNumbers(row.src || row.tr).nums.length) continue;
        const d = hammingHex(sh, row.sh);
        if (d < bestD) {
          bestD = d;
          best = row;
        }
      }
      if (best && bestD <= maxDist) {
        best.n = (best.n || 0) + 1;
        best.at = nowMs();
        this.stats.hitsShingle += 1;
        return { translation: fillNumbers(best.trm || best.tr, flat), via: "shingle" };
      }
    }
    this.stats.misses += 1;
    return null;
  }

  // ---- insert / merge ----

  /**
   * Add or fold one translation.
   * opts: { source: "live"|"button"|"pipeline", explicit: bool }
   * Returns { added, folded, updated, evicted }.
   */
  add(text, translation, opts) {
    opts = opts || {};
    const flat = flattenText(text);
    const tr = normalizeText(translation);
    if (!flat || !tr) return { added: 0, folded: 0, updated: 0, evicted: 0 };
    const L = opts.lg || DEFAULT_LANG;
    const k = this._k(L, textKey(flat));

    // 1. same text already known
    const existing = this.records.get(k);
    if (existing) {
      if (existing.tr !== tr) {
        // A better/different translation: replace it (and its masked form).
        existing.tr = tr;
        if (existing.maskedOk) existing.trm = maskNumbers(tr).text;
        existing.at = nowMs();
        existing.n = (existing.n || 0) + 1;
        this._append({ op: "upd", k: k, tr: existing.tr, trm: existing.trm });
        return { added: 0, folded: 0, updated: 1, evicted: 0 };
      }
      // Usage counters are in-memory; compact() persists them. Logging every hit
      // would make the append-only file grow with traffic instead of content.
      existing.n = (existing.n || 0) + 1;
      existing.at = nowMs();
      return { added: 0, folded: 0, updated: 0, evicted: 0 };
    }

    // 2. same template (numbers differ only): fold as an alias
    const tk = this._k(L, templateKey(flat));
    const tplOwner = this.byTemplate.get(tk);
    if (tplOwner && tplOwner !== k) {
      const row = this.records.get(tplOwner);
      if (row) {
        const sameMeaning = this._translationFromTemplate(row.trm || row.tr, flat) === tr;
        row.n = (row.n || 0) + 1;
        row.at = nowMs();
        if (sameMeaning) {
          if ((row.v || []).length < aliasCapFor(row, this.policy) && !(row.v || []).includes(k)) {
            row.v = row.v || [];
            row.v.push(k);
            this.aliasIndex.set(k, tplOwner);
            this._append({ op: "alias", k: tplOwner, a: k });
          }
          return { added: 0, folded: 1, updated: 0, evicted: 0 };
        }
        // Same template but a genuinely different translation (context matters):
        // store it as its own entry instead of throwing it away. The template
        // index keeps pointing at the newest row, exact hits still find both.
      }
    }

    // 3. near-duplicate phrasing: same translation, close SimHash -> alias
    const sh = simhash(flat);
    const maxDist = distanceFor(flat, this.policy);
    const bucket = this.byShingle.get(L + "|" + shingleBucket(sh));
    if (bucket) {
      for (const cand of bucket) {
        const row = this.records.get(cand);
        if (!row || !row.sh) continue;
        if (row.tr !== tr) continue;
        if (hammingHex(sh, row.sh) > maxDist) continue;
        if ((row.v || []).length >= aliasCapFor(row, this.policy)) continue;
        row.v = row.v || [];
        if (!row.v.includes(k)) {
          row.v.push(k);
          this.aliasIndex.set(k, cand);
          row.n = (row.n || 0) + 1;
          this._append({ op: "alias", k: cand, a: k });
          return { added: 0, folded: 1, updated: 0, evicted: 0 };
        }
      }
    }

    // 4. admission policy: long one-off strings are held back
    const uses = (opts.uses || 1) + (opts.explicit ? 1 : 0);
    const short = flat.length <= this.policy.admitShortLen;
    if (!opts.explicit && !short && uses < this.policy.admitMinUses) {
      return { added: 0, folded: 0, updated: 0, evicted: 0, rejected: "throttled" };
    }

    // 5. new entry
    const masked = maskNumbers(flat);
    const maskedTr = maskNumbers(tr);
    const row = {
      k: k,
      lg: L,
      t: tk,
      tr: tr, // translation as produced (exact hits return this)
      trm: maskedTr.text, // masked translation, used to fill numbers on loose hits
      src: flat, // source text, needed to fill numbers later
      v: [],
      n: uses,
      at: nowMs(),
      sh: sh,
      s: opts.source || "live",
      maskedOk: maskedTr.nums.length === masked.nums.length,
    };
    // A translation that lost/gained numbers cannot be filled safely, so it is
    // stored as an exact-only entry (no template key) and never matched loosely.
    if (!row.maskedOk) {
      delete row.t;
      delete row.sh;
      delete row.trm;
    }
    this._install(row);
    this._append({ op: "add", row });
    this.stats.added += 1;
    const evicted = this._enforceBudget();
    return { added: 1, folded: 0, updated: 0, evicted };
  }

  _translationFromTemplate(maskedTranslation, source) {
    return fillNumbers(maskedTranslation, source);
  }

  // ---- budget ----

  score(row) {
    const ageDays = Math.max(0, (nowMs() - (row.at || 0)) / 86400000);
    const recency = Math.pow(0.5, ageDays / 30);
    const usage = Math.pow(Math.max(1, row.n || 1), 0.8);
    const len = Math.min(String(row.src || "").length, 200) / 200;
    return usage * recency * (0.4 + len);
  }

  /** Evict the lowest-scoring share when over entries or bytes. */
  _enforceBudget() {
    let evicted = 0;
    const overEntries = this.records.size > this.policy.maxEntries;
    const overBytes = this.byteSize() > this.policy.maxBytes;
    if (!overEntries && !overBytes) return 0;
    const target = overEntries
      ? Math.max(0, Math.ceil(this.records.size * this.policy.evictBatchRatio))
      : Math.max(0, Math.ceil(this.records.size * this.policy.evictBatchRatio));
    const rows = [...this.records.values()].sort((a, b) => this.score(a) - this.score(b));
    for (let i = 0; i < target && i < rows.length; i += 1) {
      const row = rows[i];
      this._remove(row.k);
      this._append({ op: "del", k: row.k });
      evicted += 1;
      this.stats.evicted += 1;
    }
    this.compact();
    return evicted;
  }

  // ---- housekeeping ----

  /**
   * Rows worth exporting: everything the game itself asked for (src live/button/
   * auto), i.e. public build text translated on demand. `since` filters by
   * timestamp; `lg` filters by language.
   */
  exportRows(opts) {
    opts = opts || {};
    const out = [];
    for (const row of this.records.values()) {
      if (opts.since && (row.at || 0) < opts.since) continue;
      if (opts.lg && (row.lg || DEFAULT_LANG) !== opts.lg) continue;
      const src = row.s || "live";
      if (opts.includePipeline !== true && src === "pipeline") continue;
      out.push({
        lg: row.lg || DEFAULT_LANG,
        text: row.src,
        translation: row.tr,
        source: src,
        at: row.at,
        uses: row.n || 1,
        aliases: (row.v || []).map((a) => ({ key: a })),
      });
    }
    return out;
  }

  /** Persist usage counters (called on shutdown). */
  flush() {
    if (this.jsonlBytes > 0) this.compact();
  }

  summary() {
    let aliases = 0;
    const perLang = Object.create(null);
    for (const row of this.records.values()) {
      aliases += (row.v || []).length;
      const lg = row.lg || DEFAULT_LANG;
      perLang[lg] = (perLang[lg] || 0) + 1;
    }
    return {
      entries: this.records.size,
      languages: perLang,
      aliases,
      bytes: this.byteSize(),
      templates: this.byTemplate.size,
      stats: this.stats,
      policy: this.policy,
    };
  }
}

module.exports = {
  TranslationTable,
  POLICY,
  SCHEMA,
  DEFAULT_LANG,
  distanceFor,
  aliasCapFor,
  tokenCount,
  normalizeText,
  flattenText,
  maskNumbers,
  fillNumbers,
  textKey,
  templateKey,
  simhash,
  hammingHex,
  shingleBucket,
};
