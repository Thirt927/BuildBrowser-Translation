// BuildBrowser Translation - optional local translation bridge.
//
// Why this exists
// ---------------
// Panorama removed $.AsyncWebRequest, so the UI cannot call an HTTP API directly.
// It CAN still render an <HTML> panel, and that panel's embedded browser does
// real networking. Two things make the round trip usable:
//   1. the panel's page is served over HTTPS with a locally trusted certificate
//      (a self-signed cert installed into CurrentUser\Root; see
//      scripts/gen_bridge_cert.ps1 -Trust). WebKit refuses a plain http page and
//      refuses an untrusted https page (neterror -202);
//   2. the result comes back through document.title, which Panorama reads with a
//      0.1s poll. One RTT, no shared memory, no pipes.
// This is the same technique as deadlockmodding's BabelTower bridge (btipc-https),
// independently implemented here.
//
// Scope
// -----
// The bridge only translates text the offline memory does not know. It is
// best-effort: bba_translate.js keeps using the shipped memory and disables this
// channel after a few hard failures.
//
// Endpoints (loopback only)
//   GET  /bridge?id=..&text=..&target=zh-Hans   HTML page; its JS POSTs to the API
//                                               and writes "BBT<id>{json}" to title
//   GET  /api/v1/health                         {"ok":true,...}
//   POST /api/v1/translate  {text:[..],target}  {"ok":true,"translations":[..]}
//   GET  /api/v1/translate?text=..&target=..     same, GET for the page fallback
//
// Usage:
//   node tools/bridge/bridge.js [--port 8793] [--pfx config/certs/bbt.pfx]
//        [--pass-file config/certs/bbt.pass] [--target zh-Hans]
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const bing = require("../providers/bing.js");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULTS = {
  port: 8793,
  pfx: path.join(ROOT, "config", "certs", "bbt.pfx"),
  passFile: path.join(ROOT, "config", "certs", "bbt.pass"),
  target: "zh-Hans",
  titleLimit: 6000,
  seen: path.join(ROOT, "tools", "cache", "live_seen.json"),
  transCache: path.join(ROOT, "tools", "cache", "translations.json"),
};

// Certificates that may already be installed and trusted. Reusing one avoids
// asking the user to trust a second certificate: BabelTower (DeadlockLingua)
// ships CN=BabelTower-localhost with the same SAN set (localhost / 127.0.0.1 /
// ::1), so it works for this bridge too (certificates are port independent).
function knownCerts() {
  const out = [];
  const env = process.env.BBT_CERT_PFX;
  if (env) out.push({ pfx: env, pass: process.env.BBT_CERT_PASS_FILE || "" });
  out.push({ pfx: DEFAULTS.pfx, pass: path.join(ROOT, "config", "certs", "bbt.pass") });

  const home = process.env.USERPROFILE || process.env.HOME || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [];
  // sibling checkouts of BabelTower / DeadlockLingua
  candidates.push(path.join(path.dirname(ROOT), "DeadlockLingua"));
  candidates.push(path.join(path.dirname(ROOT), "BabelTower"));
  if (localAppData) candidates.push(path.join(localAppData, "BabelTower"));
  if (home) {
    candidates.push(path.join(home, "DeadlockLingua"));
    candidates.push(path.join(home, "BabelTower"));
    candidates.push(path.join(home, "Documents", "BabelTower"));
  }
  for (const base of candidates) {
    out.push({
      pfx: path.join(base, "config", "certs", "bridge.pfx"),
      pass: path.join(base, "config", "certs", "bridge.pass"),
    });
  }
  return out;
}

function resolveCert(explicit) {
  const list = explicit ? [{ pfx: explicit, pass: String(arg("pass-file", "")) || "" }] : knownCerts();
  for (const cand of list) {
    try {
      if (cand.pfx && fs.existsSync(cand.pfx)) return cand;
    } catch (e) {
      /* ignore */
    }
  }
  return null;
}

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const PORT = Number(arg("port", DEFAULTS.port)) || DEFAULTS.port;
const PFX = String(arg("pfx", DEFAULTS.pfx));
const PASS_FILE = String(arg("pass-file", DEFAULTS.passFile));
const TARGET = String(arg("target", DEFAULTS.target));

// ---------- translation with a small cache ----------
const CACHE_MAX = 4000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key); // LRU touch
  cache.set(key, hit);
  return hit;
}
function cachePut(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

// ---------- persist what we translated ----------
// Two files, both consumed by the offline pipeline:
//   tools/cache/live_seen.json      [{ text, translation, target, at }] what the
//                                   game actually asked for (build_tm.js merges
//                                   these into the shipped memory)
//   tools/cache/translations.json   { <textKey>: translation } the pipeline's own
//                                   cache, so build_tm.js does not re-translate
const { textKey } = require("../build_tm.js");
const { TranslationTable } = require("../tm_table.js");

// Growing translation table (tools/cache/tm_table.jsonl + .json). Lookups here
// happen before the network, so a text translated once is instant forever.
const table = new TranslationTable({ dir: path.join(ROOT, "tools", "cache") });

const seenFile = process.env.BBT_SEEN_FILE || path.join(ROOT, "tools", "cache", "live_seen.json");
const transCacheFile = process.env.BBT_TRANS_CACHE_FILE || path.join(ROOT, "tools", "cache", "translations.json");
let seen = null;
let seenDirty = false;

function loadSeen() {
  if (seen) return seen;
  try {
    const raw = JSON.parse(fs.readFileSync(seenFile, "utf8"));
    seen = Array.isArray(raw) ? raw : [];
  } catch (e) {
    seen = [];
  }
  return seen;
}

let saveTimer = null;

// Debounced, and flushed on exit: the bridge is a long-lived process, but a
// Ctrl+C must not lose the last few translations.
function flushSeen() {
  if (!seenDirty) return;
  seenDirty = false;
  try {
      fs.mkdirSync(path.dirname(seenFile), { recursive: true });
      fs.writeFileSync(seenFile, JSON.stringify(loadSeen(), null, 0));
      // keep the pipeline's translation cache in step so build_tm.js skips these
      let cache = {};
      try { cache = JSON.parse(fs.readFileSync(transCacheFile, "utf8")); } catch (e) { cache = {}; }
      for (const row of loadSeen()) {
        if (row && row.text && row.translation) cache[textKey(row.text)] = row.translation;
      }
    fs.mkdirSync(path.dirname(transCacheFile), { recursive: true });
    fs.writeFileSync(transCacheFile, JSON.stringify(cache));
  } catch (e) {
    console.error("bridge: cannot persist live translations:", e.message);
  }
}

function scheduleSave() {
  seenDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSeen();
  }, 5000);
  if (saveTimer.unref) saveTimer.unref();
}

process.on("exit", () => {
  flushSeen();
  try { table.flush(); } catch (e) {}
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  try {
    process.on(sig, () => {
      flushSeen();
      try { table.flush(); } catch (e) {}
      process.exit(0);
    });
  } catch (e) {}
}

function recordSeen(text, translation, target) {
  if (!text || !translation) return;
  const list = loadSeen();
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].text === text) {
      if (list[i].translation !== translation) {
        list[i].translation = translation;
        list[i].at = new Date().toISOString();
        scheduleSave();
      }
      return;
    }
  }
  list.push({ text, translation, target, at: new Date().toISOString() });
  scheduleSave();
}

async function translateOne(text, target) {
  const src = String(text == null ? "" : text);
  if (!src.trim()) return src;
  const key = target + "\u0000" + src;
  const hit = cacheGet(key);
  if (hit != null) return hit;
  const out = await bing.translate(src, { from: "auto", to: target });
  const value = out && out.translation ? String(out.translation) : "";
  if (value) {
    cachePut(key, value);
    recordSeen(src, value, target); // grows the offline memory next time
    // Auto-save: everything the game asked for lands in the local table, so the
    // next time it is an instant lookup instead of a network round trip.
    try {
      table.add(src, value, { source: "auto", explicit: true, lg: target });
    } catch (e) {
      /* a broken table must never break translation */
    }
  }
  return value;
}

async function translateMany(texts, target) {
  const list = Array.isArray(texts) ? texts : [texts];
  const out = [];
  for (const t of list) {
    try {
      out.push(await translateOne(t, target));
    } catch (e) {
      out.push(null); // per-item failure must not fail the batch
    }
  }
  return out;
}

// ---------- the page the HTML panel loads ----------
function bridgePage(query) {
  const id = String(query.get("id") || "x").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "x";
  const text = String(query.get("text") || "");
  const target = String(query.get("target") || TARGET);
  let d = null;
  const rawD = query.get("d");
  if (rawD) {
    try { d = JSON.parse(rawD); } catch (e) { d = null; }
  }
  // Accept both shapes: { text: [..], target } (ours) and BabelTower's
  // { operation, text, sourceLanguage, targetLanguage } so the same in-game
  // client can talk to either bridge.
  let reqBody;
  if (d && Array.isArray(d.texts)) {
    reqBody = { texts: d.texts, target: String(d.target || d.targetLanguage || target) };
  } else if (d && (d.operation || d.targetLanguage)) {
    reqBody = {
      text: Array.isArray(d.text) ? d.text : [String(d.text || text)],
      target: String(d.targetLanguage || d.target || target),
    };
  } else if (d) {
    reqBody = { text: Array.isArray(d.text) ? d.text : [String(d.text || text)], target: String(d.target || target) };
  } else {
    reqBody = { text: [text], target };
  }
  const op = String(query.get("op") || "translate").replace(/[^a-z]/g, "");
  // ?p= lets the caller pick the API endpoint (e.g. /api/v1/tm/translate); it is
  // whitelisted so the page can never be pointed at arbitrary URLs.
  // ?api= is a raw GET passthrough for whitelisted endpoints (used by the
  // overrides fetch, which needs a query string of its own).
  const rawApi = String(query.get("api") || "");
  if (/^\/api\/v1\/(tm\/(lookup|overrides|stats|translate)|translate)(\?[^\s]*)?$/.test(rawApi)) {
    return [
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>bbt-bridge</title></head><body>",
      "<script>(function(){",
      "var id=" + JSON.stringify(id) + ";",
      "function out(o){try{document.title='BBT'+id+JSON.stringify(o);}catch(e){}}",
      "try{document.title='bbt-alive';}catch(e){}",
      "fetch(" + JSON.stringify(rawApi) + ").then(function(r){return r.json();})",
      ".then(function(j){out(j);}).catch(function(e){out({ok:false,error:String(e)});});",
      "})();</script></body></html>",
    ].join("");
  }
  const wantedPath = String(query.get("p") || "");
  const apiPath = /^\/api\/v1\/(translate|tm\/translate|health)$/.test(wantedPath)
    ? wantedPath
    : op === "health" ? "/api/v1/health" : "/api/v1/translate";
  // The page writes one string into document.title; Panorama matches on the
  // "BBT<id>" prefix. Keep the payload small enough for the title limit.
  return [
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>bbt-bridge</title></head><body>",
    "<script>(function(){",
    "var id=" + JSON.stringify(id) + ";",
    "var limit=" + DEFAULTS.titleLimit + ";",
    "var done=false;",
    "function out(o){var s;try{s='BBT'+id+JSON.stringify(o);}catch(e){s='BBT'+id+'{\"ok\":false,\"error\":\"encode\"}';}",
    "try{document.title=s;}catch(e){}",
    "try{location.hash='#'+encodeURIComponent(s);}catch(e){}}",
    "try{document.title='bbt-alive';}catch(e){}",
    "var t=setTimeout(function(){if(!done){done=true;out({ok:false,error:'bridge_timeout'});}},8000);",
    "var op=" + JSON.stringify(op) + ";",
    "var body=" + JSON.stringify(reqBody) + ";",
    "var url=" + JSON.stringify(apiPath) + ";",
    "var opts=op==='health'?{method:'GET'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};",
    "fetch(url,opts).then(function(r){return r.json();})",
    ".then(function(j){if(done)return;done=true;clearTimeout(t);",
    "var s='BBT'+id+JSON.stringify(j);if(s.length>limit){out({ok:false,error:'too_large'});return;}out(j);})",
    ".catch(function(e){if(done)return;done=true;clearTimeout(t);out({ok:false,error:String(e)});});",
    "})();</script></body></html>",
  ].join("");
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1 << 20) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

// ---- overrides against the shipped memory ----
let offlineCache = null; // { "zh-Hans": { key: translation } }
function offlineMemory(lg) {
  if (offlineCache && offlineCache[lg]) return offlineCache[lg];
  offlineCache = offlineCache || {};
  const file = path.join(ROOT, "mod", "panorama", "scripts", "bba_tm.js");
  let map = {};
  try {
    const { readFromScript } = require("../tm_format.js");
    map = readFromScript(fs.readFileSync(file, "utf8"));
  } catch (e) {
    map = {};
  }
  // The shipped memory is Chinese only.
  offlineCache[lg] = lg === "zh-Hans" || !lg ? map : {};
  offlineCache["zh-Hans"] = offlineCache[lg];
  return offlineCache[lg];
}

/** Local rows whose translation differs from what the VPK ships. */
function overridesFor(lg) {
  const offline = offlineMemory(lg);
  const out = [];
  for (const row of table.records.values()) {
    if ((row.lg || "zh-Hans") !== lg) continue;
    const base = String(row.k).slice(String(row.k).indexOf("|") + 1);
    const shipped = offline[base];
    if (shipped && shipped === row.tr) continue; // same as the pak: no override
    out.push({ k: base, text: row.src, tr: row.tr });
    if (out.length >= 500) break; // bounded payload
  }
  return out;
}

function start() {
  const explicit = process.argv.indexOf("--pfx") >= 0 ? PFX : "";
  const chosen = resolveCert(explicit);
  if (!chosen) {
    console.error(
      "bridge: no usable certificate found (looked for config/certs/bbt.pfx and an\n" +
        "existing BabelTower/DeadlockLingua config/certs/bridge.pfx)\n" +
        "generate + trust one first:\n" +
        "  powershell -ExecutionPolicy Bypass -File scripts\\gen_bridge_cert.ps1 -Trust\n" +
        "then FULLY restart Steam (the tray icon too).\n" +
        "If Babel Tower / DeadlockLingua is already installed and trusted, point at its\n" +
        "certificate instead:  node tools/bridge/bridge.js --pfx <...>\\config\\certs\\bridge.pfx --pass-file <...>\\bridge.pass\n" +
        "or set BBT_CERT_PFX / BBT_CERT_PASS_FILE.",
    );
    process.exit(3);
  }
  let passphrase = "";
  try {
    passphrase = fs.readFileSync(chosen.pass || PASS_FILE, "utf8").trim();
  } catch (e) {
    /* empty passphrase is allowed */
  }
  const pfx = fs.readFileSync(chosen.pfx);
  console.log("bridge: certificate " + chosen.pfx);

  const server = https.createServer({ pfx, passphrase }, async (req, res) => {
    const url = new URL(req.url || "/", "https://127.0.0.1");
    const p = url.pathname;
    const send = (code, type, body) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };

    if (p === "/bridge") {
      return send(200, "text/html; charset=utf-8", bridgePage(url.searchParams));
    }
    if (p === "/api/v1/health") {
      return send(200, "application/json", JSON.stringify({ ok: true, version: "1.0.0", target: TARGET }));
    }
    if (p === "/api/v1/tm/stats") {
    return send(200, "application/json", JSON.stringify({ ok: true, table: table.summary() }));
  }

  // Batch lookup only (no network): what the UI asks for on every page open.
  if (p === "/api/v1/tm/lookup") {
    let body = {};
    if (req.method === "POST") body = await readJson(req);
    else body = Object.fromEntries(url.searchParams.entries());
    const texts = Array.isArray(body.texts) ? body.texts : body.texts ? [body.texts] : [];
    const lg = String(body.target || body.lg || TARGET);
    const results = texts.map((t) => {
      const hit = table.lookup(String(t || ""), lg);
      return hit ? hit.translation : null;
    });
    return send(200, "application/json", JSON.stringify({ ok: true, results }));
  }

  // Entries that override the shipped memory (the user asked for local wins).
  // Loaded once from bba_tm.js so we only send real conflicts, not the whole
  // table: a local translation for a text the VPK also has, but different.
  if (p === "/api/v1/tm/overrides") {
    const lg = String(url.searchParams.get("target") || url.searchParams.get("lg") || TARGET);
    const list = overridesFor(lg);
    return send(200, "application/json", JSON.stringify({ ok: true, overrides: list }));
  }

  // Lookup + translate the misses + grow the table. This is the button's request.
  if (p === "/api/v1/tm/translate") {
    let body = {};
    if (req.method === "POST") body = await readJson(req);
    else body = Object.fromEntries(url.searchParams.entries());
    const target = String(body.target || TARGET);
    const texts = (Array.isArray(body.texts) ? body.texts : [body.texts]).filter((t) => t);
    if (!texts.length) return send(400, "application/json", JSON.stringify({ ok: false, error: "no_text" }));
    const source = String(body.source || "button");
    try {
      const out = [];
      let hits = 0;
      let added = 0;
      for (const raw of texts) {
        const text = String(raw);
        const hit = table.lookup(text, target);
        if (hit) {
          hits += 1;
          out.push(hit.translation);
          continue;
        }
        const value = await translateOne(text, target);
        if (!value) {
          out.push(null);
          continue;
        }
        const r = table.add(text, value, { source, explicit: true, lg: target });
        added += r.added;
        out.push(value);
      }
      return send(200, "application/json", JSON.stringify({ ok: true, translations: out, hits, added }));
    } catch (e) {
      return send(502, "application/json", JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
    }
  }

  if (p === "/api/v1/translate") {
      let body = {};
      if (req.method === "POST") body = await readJson(req);
      else body = Object.fromEntries(url.searchParams.entries());
      const target = String(body.target || TARGET);
      const texts = Array.isArray(body.text) ? body.text : body.text != null ? [body.text] : [];
      if (!texts.length) return send(400, "application/json", JSON.stringify({ ok: false, error: "no_text" }));
      try {
        const translations = await translateMany(texts, target);
        const ok = translations.some((t) => t);
        return send(200, "application/json", JSON.stringify({ ok, translations }));
      } catch (e) {
        return send(502, "application/json", JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
      }
    }
    // Everything else is refused: this is not a general proxy.
    return send(404, "application/json", JSON.stringify({ ok: false, error: "not_found" }));
  });

  const loadedRows = table.load();
  console.log("bridge: translation table " + loadedRows + " rows, " + table.summary().bytes + " bytes");

  server.listen(PORT, "127.0.0.1", () => {
    console.log("bridge: https://localhost:" + PORT + "/bridge (cert " + PFX + ")");
    console.log("bridge: health https://localhost:" + PORT + "/api/v1/health");
  });
}

if (require.main === module) start();

module.exports = {
  bridgePage, translateMany, translateOne, resolveCert, knownCerts, recordSeen, flushSeen, seenFile,
  table, overridesFor, offlineMemory,
};
