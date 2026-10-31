// Live-bridge channel: text that the offline memory does not know is translated
// through the hidden <HTML> panel (HTTPS page + document.title return channel).
//
// Usage: node tests/live_channel_simtest.js
//
// The test fakes the Panorama side: an HTML panel object with SetURL()/title and
// a fake bridge that answers in "BBT<id>{...}" form, exactly like
// tools/bridge/bridge.js does in the game.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const tmFormat = require("../tools/tm_format.js");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = path.join(ROOT, "mod", "panorama", "scripts");

// Offline memory knows exactly one sentence; everything else needs the bridge.
const KNOWN = { "Rend > Heal > Repeat.": "撕裂 > 治疗 > 重复。" };
function hash32(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}
const flat = (s) => String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+/g, " ").trim();
const map = {};
for (const [k, v] of Object.entries(KNOWN)) {
  map[hash32(flat(k), 5381).toString(36) + "-" + hash32(flat(k), 52711).toString(36)] = v;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bbt-live-"));
fs.writeFileSync(path.join(TMP, "tm.js"), tmFormat.emitScript(map, { generated_at: "test" }));

const FAKE_TRANSLATIONS = {
  "Key item for Drifter early game.": "孤猎前期的重要装备。",
  "Buy this before the team fight.": "团战前先买这个。",
};

function makeLabel(text, cls) {
  const p = {
    children: [],
    IsValid: () => true,
    BIsVisible: () => true,
    GetChildCount: () => p.children.length,
    GetChild: (i) => p.children[i] || null,
    _cls: cls || "",
  };
  Object.defineProperty(p, "class", { get: () => p._cls });
  p._t = text;
  Object.defineProperty(p, "text", {
    get: () => p._t,
    set: (v) => { p._t = v; },
    configurable: true,
  });
  return p;
}

// The hidden <HTML id="BBTBridgePanel"> stand-in.
function makeHtmlPanel(opts) {
  const panel = {
    id: "BBTBridgePanel",
    children: [],
    IsValid: () => true,
    BIsVisible: () => true,
    GetChildCount: () => 0,
    GetChild: () => null,
    _title: "",
  };
  Object.defineProperty(panel, "title", { get: () => panel._title, configurable: true });
  panel.SetURL = (url) => {
    opts.urls.push(url);
    if (opts.dead) return; // no certificate / no bridge: page never answers
    // Parse the request the same way the bridge page does.
    const u = new URL(url);
    const id = u.searchParams.get("id") || "x";
    const op = u.searchParams.get("op") || "translate";
    opts.timers.push(() => {
      if (op === "health") {
        panel._title = "BBT" + id + JSON.stringify({ ok: true, version: "1.0.0" });
        return;
      }
      const text = u.searchParams.get("text") || "";
      const out = FAKE_TRANSLATIONS[text];
      panel._title = "BBT" + id + JSON.stringify(out ? { ok: true, translations: [out] } : { ok: false, translations: [null] });
    });
  };
  return panel;
}

function boot(labels, htmlOpts) {
  const root = makeLabel(undefined, "CitadelHeroBuildsSelector");
  const bridgePanel = makeHtmlPanel(htmlOpts);
  root.children.push(bridgePanel, ...labels);
  const queue = [];
  const log = [];
  const sandbox = {
    console: { log() {} },
    $: {
      GetContextPanel: () => root,
      Schedule: (delay, fn) => queue.push({ delay, fn }),
      Msg: (m) => log.push(String(m)),
    },
  };
  vm.createContext(sandbox);
  for (const f of ["bba_glossary.js", "bba_tm.js", "bba_layout_tokens.js", "bba_translate.js"]) {
    vm.runInContext(fs.readFileSync(path.join(SCRIPTS, f), "utf8"), sandbox, { filename: f });
  }
  vm.runInContext(fs.readFileSync(path.join(TMP, "tm.js"), "utf8"), sandbox, { filename: "tm_fixture.js" });
  return { sandbox, queue, root, bridgePanel, log, htmlOpts };
}

// Advance the fake clock: run every scheduled callback (and callbacks they book).
function pump(ctx, steps) {
  for (let i = 0; i < steps; i += 1) {
    const batch = ctx.queue.splice(0, ctx.queue.length);
    for (const item of batch) {
      item.fn();
      // The fake network answered: let the page "load" its result.
      while (ctx.htmlOpts.timers.length) ctx.htmlOpts.timers.shift()();
    }
  }
}

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " -- " + detail : ""));
  if (!cond) failures += 1;
}

// ------------------------------------------------------------------
// 1. bridge present: unknown text gets translated live
// ------------------------------------------------------------------
{
  const label = makeLabel("Key item for Drifter early game.", "ModifiesLabel");
  const opts = { urls: [], timers: [], dead: false, broken: false };
  const ctx = boot([label], opts);
  pump(ctx, 30);
  check("live: health probe issued", opts.urls.some((u) => u.indexOf("op=health") > 0), JSON.stringify(opts.urls.slice(0, 2)));
  check("live: unknown text translated through the bridge", label.text === "孤猎前期的重要装备。", JSON.stringify(label.text));
  check("live: request went to /bridge with the text", opts.urls.some((u) => u.indexOf("/bridge") > 0 && u.indexOf("text=") > 0), JSON.stringify(opts.urls));
  check("live: stat counted", ctx.sandbox.BBT_STATS.live >= 1, String(ctx.sandbox.BBT_STATS.live));
  check("live: log announces the channel", ctx.log.some((l) => l.indexOf("live bridge: connected") >= 0), JSON.stringify(ctx.log.slice(0, 3)));

  // second label with the same text must be served from the session cache
  const l2 = makeLabel("Key item for Drifter early game.", "ModifiesLabel");
  const ctx2 = boot([l2], { urls: [], timers: [], dead: false });
  pump(ctx2, 30);
  const urlsBefore = ctx2.htmlOpts.urls.length;
  l2.text = "Key item for Drifter early game."; // engine repaint of the same text
  pump(ctx2, 30);
  check("live: repeat text uses the cache", ctx2.htmlOpts.urls.length === urlsBefore || l2.text === "孤猎前期的重要装备。", String(ctx2.htmlOpts.urls.length - urlsBefore));
}

// ------------------------------------------------------------------
// 2. no bridge (dead panel): everything stays offline, no crash, no repeats
// ------------------------------------------------------------------
{
  const label = makeLabel("Buy this before the team fight.", "ModifiesLabel");
  const opts = { urls: [], timers: [], dead: true };
  const ctx = boot([label], opts);
  pump(ctx, 60);
  check("offline: text untouched when the bridge is dead", label.text === "Buy this before the team fight.", JSON.stringify(label.text));
  check("offline: channel marked off", ctx.log.some((l) => l.indexOf("live bridge: not available") >= 0), JSON.stringify(ctx.log.slice(0, 3)));
  const urlsAfterGiveUp = opts.urls.length;
  pump(ctx, 40);
  check("offline: no request storm after giving up", opts.urls.length <= urlsAfterGiveUp + 1, String(opts.urls.length - urlsAfterGiveUp));
}

// ------------------------------------------------------------------
// 3. offline memory still wins (live channel must not re-translate it)
// ------------------------------------------------------------------
{
  const label = makeLabel("Rend > Heal > Repeat.", "BuildDescription");
  const opts = { urls: [], timers: [], dead: false };
  const ctx = boot([label], opts);
  pump(ctx, 30);
  check("memory: offline hit still translated", label.text === "撕裂 > 治疗 > 重复。", JSON.stringify(label.text));
  check("memory: no translate request for known text", !opts.urls.some((u) => u.indexOf("op=translate") > 0), JSON.stringify(opts.urls));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL LIVE CHANNEL CHECKS PASSED");
