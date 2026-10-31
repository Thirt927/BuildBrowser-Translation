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
};

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

async function translateOne(text, target) {
  const src = String(text == null ? "" : text);
  if (!src.trim()) return src;
  const key = target + "\u0000" + src;
  const hit = cacheGet(key);
  if (hit != null) return hit;
  const out = await bing.translate(src, { from: "auto", to: target });
  const value = out && out.translation ? String(out.translation) : "";
  if (value) cachePut(key, value);
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
  const reqBody = d || { text: [text], target };
  const op = String(query.get("op") || "translate").replace(/[^a-z]/g, "");
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
    "var url=op==='health'?'/api/v1/health':'/api/v1/translate';",
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

function start() {
  let pfx;
  try {
    pfx = fs.readFileSync(PFX);
  } catch (e) {
    console.error(
      "bridge: cannot read certificate " + PFX + "\n" +
        "generate + trust one first:\n" +
        "  powershell -ExecutionPolicy Bypass -File scripts\\gen_bridge_cert.ps1 -Trust\n" +
        "then FULLY restart Steam (the tray icon too).",
    );
    process.exit(3);
  }
  let passphrase = "";
  try {
    passphrase = fs.readFileSync(PASS_FILE, "utf8").trim();
  } catch (e) {
    /* empty passphrase is allowed */
  }

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

  server.listen(PORT, "127.0.0.1", () => {
    console.log("bridge: https://localhost:" + PORT + "/bridge (cert " + PFX + ")");
    console.log("bridge: health https://localhost:" + PORT + "/api/v1/health");
  });
}

if (require.main === module) start();

module.exports = { bridgePage, translateMany, translateOne };
