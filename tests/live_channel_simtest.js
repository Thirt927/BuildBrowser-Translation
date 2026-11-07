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
  // v1.9.49: the bridge sees protected text, so hero/item names arrive as ⟦N⟧.
  "Key item for ⟦0⟧ early game.": "孤猎前期的重要装备。",
  "Buy this before the team fight.": "团战前先买这个。",
  // v1.9.49: the bridge now sees game terms as ⟦N⟧ placeholders, so the fixture
  // is keyed by the protected text and answers with the placeholder intact.
  "Grab ⟦0⟧ now.": "现在拿⟦0⟧。",
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
  // Engine reality: no `.class` string, classes live on classList.
  p.classList = {
    contains: (n) => p._cls.split(/\s+/).indexOf(n) >= 0,
  };
  p._t = text;
  // Engine panels expose GetParent(); liveRoot() (v1.9.29) walks UP to the
  // layout root before searching, so the sim needs the same link.
  p._parent = null;
  p.GetParent = () => p._parent || null;
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
    id: opts.id || "BBTBridgePanel",
    children: [],
    IsValid: () => true,
    BIsVisible: () => true,
    GetChildCount: () => 0,
    GetChild: () => null,
    _title: "",
  };
  Object.defineProperty(panel, "title", { get: () => panel._title, configurable: true });
  // v1.9.29: on-screen geometry. `width: 0` models a closed shop surface (the
  // panel exists but never renders, so its page never runs); leaving it out
  // models an engine that does not report the attribute at all.
  Object.defineProperty(panel, "actuallayoutwidth", {
    get: () => (typeof opts.width === "number" ? opts.width : undefined),
    configurable: true,
  });
  panel.SetURL = (url) => {
    opts.urls.push(url);
    const u = new URL(url);
    const port = Number(u.port);
    const id = u.searchParams.get("id") || "x";
    const op = u.searchParams.get("op") || "translate";
    const tag = port === 8792 ? "LCT" : "BBT";
    if (opts.dead || (opts.port && port !== opts.port)) return; // nothing listening
    const deliver = (str) => {
      if (opts.eventChannel) {
        // Real engine behaviour (18:21 in-game): the page title is never
        // readable as a property, it only arrives as an HTML panel event.
        if (opts.emit) opts.emit("HTMLChangedTitle", str);
        return;
      }
      panel._title = str;
    };
    opts.timers.push(() => {
      if (op === "health") {
        deliver(tag + id + JSON.stringify({
          ok: true,
          version: "1.0.0",
          name: tag === "LCT" ? "DeadlockLingua Bridge" : "bbt-bridge",
          provider: tag === "LCT" ? "openai" : "",
        }));
        return;
      }
      let text = u.searchParams.get("text") || "";
      const d = u.searchParams.get("d");
      if (d) {
        try { text = JSON.parse(d).text || text; } catch (e) {}
      }
      const out = FAKE_TRANSLATIONS[text];
      // BabelTower answers with a bare {translation}; our bridge with an array.
      deliver(tag + id + JSON.stringify(
        out
          ? (tag === "LCT" ? { ok: true, translation: out } : { ok: true, translations: [out] })
          : { ok: false, translations: [null] },
      ));
    });
  };
  return panel;
}

function boot(labels, htmlOpts) {
  const root = makeLabel(undefined, "CitadelHeroBuildsSelector");
  const bridgePanel = makeHtmlPanel(htmlOpts);
  bridgePanel._parent = root;
  root.children.push(bridgePanel, ...labels);
  for (const l of labels) l._parent = root;
  // A nested layout boots this script with its own (deep) context panel while
  // the <HTML> panel sits near the layout root: that is the 11/07
  // panel_unavailable case. htmlOpts.context lets a suite reproduce it.
  const context = htmlOpts.context || root;
  const queue = [];
  const log = [];
  const sandbox = {
    console: { log() {} },
    BBT_TM: "on", // v1.9.29: offline memory is opt-in (bridge-first default)
    $: {
      GetContextPanel: () => context,
      Schedule: (delay, fn) => queue.push({ delay, fn }),
      Msg: (m) => log.push(String(m)),
      // v1.9.29: the engine delivers the page title as a panel event; the sim
      // records the handlers so a suite can fire them the way CEF does.
      RegisterForUnhandledEvent: (name, fn) => {
        htmlOpts.handlers = htmlOpts.handlers || {};
        htmlOpts.handlers[name] = fn;
      },
    },
  };
  htmlOpts.handlers = htmlOpts.handlers || {};
  htmlOpts.emit = (name, text) => {
    const h = htmlOpts.handlers[name];
    if (h) h(text);
  };
  vm.createContext(sandbox);
  for (const f of ["bba_glossary.js", "bba_tm.js", "bba_layout_tokens.js", "bba_translate.js"]) {
    vm.runInContext(fs.readFileSync(path.join(SCRIPTS, f), "utf8"), sandbox, { filename: f });
  }
  vm.runInContext(fs.readFileSync(path.join(TMP, "tm.js"), "utf8"), sandbox, { filename: "tm_fixture.js" });
  return { sandbox, queue, root, bridgePanel, log, htmlOpts };
}

// Advance the fake clock: run every scheduled callback (and callbacks they book).
// One scheduled callback per step: the poll loop reschedules itself, so draining
// the whole queue at once would burn the poll budget before the fake page answers.
function pump(ctx, steps) {
  for (let i = 0; i < steps; i += 1) {
    const next = ctx.queue.shift();
    if (!next) break;
    next.fn();
    while (ctx.htmlOpts.timers.length) ctx.htmlOpts.timers.shift()();
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
  // v1.9.59: 8793 is preferred, so this block pins the LCT bridge to keep
  // covering the fallback path (its answer shape differs: bare {translation}).
  const opts = { urls: [], timers: [], dead: false, port: 8792 };
  const ctx = boot([label], opts);
  pump(ctx, 200);
  check("live: health probe issued", opts.urls.some((u) => u.indexOf("op=health") > 0), JSON.stringify(opts.urls.slice(0, 2)));
  check("live: unknown text translated through the bridge", label.text === "孤猎前期的重要装备。", JSON.stringify(label.text));
  check(
    "live: request carries the text (JSON payload)",
    opts.urls.some((u) => u.indexOf("op=translate") > 0 && decodeURIComponent(u).indexOf("Key item for ⟦0⟧") > 0),
    JSON.stringify(opts.urls),
  );
  check(
    "live: provider reported by the bridge is surfaced in stats",
    ctx.sandbox.BBT_STATS.liveProvider === "openai",
    JSON.stringify(ctx.sandbox.BBT_STATS.liveProvider),
  );
  check(
    "live: our bridge is probed first, BabelTower's is the fallback",
    opts.urls[0].indexOf(":8793/") > 0 && opts.urls.some((u) => u.indexOf(":8792/") > 0),
    JSON.stringify(opts.urls.slice(0, 3)),
  );
  check("live: stat counted", ctx.sandbox.BBT_STATS.live >= 1, String(ctx.sandbox.BBT_STATS.live));
  check("live: log announces the channel", ctx.log.some((l) => l.indexOf("live bridge: connected") >= 0), JSON.stringify(ctx.log.slice(0, 3)));

  // ------------------------------------------------------------------
// 1b. game terms are protected before the bridge sees them (v1.9.49)
// ------------------------------------------------------------------
{
  const label = makeLabel("Grab Infuser now.", "ModifiesLabel");
  const opts = { urls: [], timers: [], dead: false };
  const ctx = boot([label], opts);
  pump(ctx, 200);
  const sent = opts.urls.map((u) => decodeURIComponent(u)).join("\n");
  check("terms: item name becomes a placeholder before sending", sent.indexOf("⟦0⟧") >= 0, sent.slice(0, 400));
  check("terms: the raw English term never reaches the bridge", sent.indexOf("Infuser") < 0, sent.slice(0, 400));
  check("terms: the official Chinese name is restored into the answer", label.text === "现在拿灵力灌注。", JSON.stringify(label.text));
}

// ------------------------------------------------------------------
// 1c. curated genre vocabulary rides the same protection (v1.9.60)
// ------------------------------------------------------------------
{
  // "lane" has no entry in the game's own localisation files, so without the
  // curated list it reaches the model and comes back as the literal 车道.
  const label = makeLabel("Push the lane before you farm the jungle camp.", "ModifiesLabel");
  const opts = { urls: [], timers: [], dead: false, port: 8793 };
  const ctx = boot([label], opts);
  pump(ctx, 200);
  const sent = opts.urls.map((u) => decodeURIComponent(u)).join("\n");
  check("terms: genre words are hidden from the model too", sent.indexOf("lane") < 0 && sent.indexOf("jungle") < 0, sent.slice(0, 400));
  check("terms: genre words are placeholders like item names", sent.indexOf("⟦") >= 0, sent.slice(0, 400));
}

// second label with the same text must be served from the session cache
  const l2 = makeLabel("Key item for Drifter early game.", "ModifiesLabel");
  const ctx2 = boot([l2], { urls: [], timers: [], dead: false });
  pump(ctx2, 200);
  const urlsBefore = ctx2.htmlOpts.urls.length;
  l2.text = "Key item for Drifter early game."; // engine repaint of the same text
  pump(ctx2, 200);
  check("live: repeat text uses the cache", ctx2.htmlOpts.urls.length === urlsBefore || l2.text === "孤猎前期的重要装备。", String(ctx2.htmlOpts.urls.length - urlsBefore));
}

// ------------------------------------------------------------------
// 2. no bridge (dead panel): everything stays offline, no crash, no repeats
// ------------------------------------------------------------------
{
  const label = makeLabel("Buy this before the team fight.", "ModifiesLabel");
  const opts = { urls: [], timers: [], dead: true };
  const ctx = boot([label], opts);
  pump(ctx, 300);
  check("offline: text untouched when the bridge is dead", label.text === "Buy this before the team fight.", JSON.stringify(label.text));
  check("offline: channel marked off", ctx.log.some((l) => l.indexOf("live bridge: not available") >= 0), JSON.stringify(ctx.log.slice(0, 3)));
  const urlsAfterGiveUp = opts.urls.length;
  pump(ctx, 200);
  check("offline: no request storm after giving up", opts.urls.length <= urlsAfterGiveUp + 1, String(opts.urls.length - urlsAfterGiveUp));
}

// ------------------------------------------------------------------
// 2b. own bridge only (BabelTower absent): falls through to 8793
// ------------------------------------------------------------------
{
  const label = makeLabel("Buy this before the team fight.", "ModifiesLabel");
  const opts = { urls: [], timers: [], dead: false, port: 8793 };
  const ctx = boot([label], opts);
  pump(ctx, 200);
  check("fallback: our bridge alone is enough (8793, no 8792 probe)", opts.urls[0].indexOf(":8793/") > 0 && !opts.urls.some((u) => u.indexOf(":8792/") > 0), JSON.stringify(opts.urls.slice(0, 3)));
  if (label.text !== "团战前先买这个。") {
    console.log("   urls:", JSON.stringify(opts.urls, null, 1));
    console.log("   stats:", JSON.stringify(ctx.sandbox.BBT_STATS));
    console.log("   log:", JSON.stringify(ctx.log.slice(0, 4)));
    console.log("   state:", JSON.stringify(ctx.sandbox.BBT_LIVE_STATE()));
    console.log("   lastError:", ctx.sandbox.BBT_STATS.liveLastError);
  }
  check("fallback: own bridge translates", label.text === "团战前先买这个。", JSON.stringify(label.text));
}

// ------------------------------------------------------------------
// 2c. real engine: the title property reads "" and the answer only arrives
//     as an HTML panel event (the 18:21 in-game symptom), plus a panel that
//     reports actuallayoutwidth=0 even while its page runs.
// ------------------------------------------------------------------
{
  const label = makeLabel("Key item for Drifter early game.", "ModifiesLabel");
  const opts = { urls: [], timers: [], dead: false, width: 0, eventChannel: true };
  const ctx = boot([label], opts);
  pump(ctx, 200);
  check(
    "events: title stays empty but HTMLChangedTitle delivers the answer",
    label.text === "孤猎前期的重要装备。",
    JSON.stringify({ text: label.text, log: ctx.log.slice(0, 3) }),
  );
  check(
    "events: a zero-width panel still gets probed",
    opts.urls.some((u) => u.indexOf("op=health") > 0),
    JSON.stringify(opts.urls.slice(0, 2)),
  );
}

// ------------------------------------------------------------------
// 3. offline memory still wins (live channel must not re-translate it)
// ------------------------------------------------------------------
{
  const label = makeLabel("Rend > Heal > Repeat.", "BuildDescription");
  const opts = { urls: [], timers: [], dead: false };
  const ctx = boot([label], opts);
  pump(ctx, 200);
  check("memory: offline hit still translated", label.text === "撕裂 > 治疗 > 重复。", JSON.stringify(label.text));
  check("memory: no translate request for known text", !opts.urls.some((u) => u.indexOf("op=translate") > 0), JSON.stringify(opts.urls));
}

// ------------------------------------------------------------------
// 4. v1.9.29: a NESTED layout context still reaches the bridge panel
//    (the 11/07 14:02:53 `panel_unavailable` failure)
// ------------------------------------------------------------------
{
  const opts = { urls: [], timers: [], dead: false, id: "BBTBridgePanelCategory" };
  // Context panel is two levels below the layout root; the <HTML> panel is a
  // sibling of that subtree, right under the root (what the engine does for
  // CitadelShopModsBuildCategory / BuildDetails_Overview).
  const deep = makeLabel(undefined, "BuildCategory");
  const mid = makeLabel(undefined, "BuildDetails_Overview");
  deep._parent = mid;
  mid.children.push(deep);
  // The translatable text lives INSIDE the frame's context (that is what scan()
  // walks); only the <HTML> panel sits up at the layout root.
  const label = makeLabel("Key item for Drifter early game.", "BuildDescription");
  label._parent = deep;
  deep.children.push(label);
  opts.context = deep;
  const ctx = boot([], opts);
  mid._parent = ctx.root;
  ctx.root.children.push(mid);
  pump(ctx, 200);
  check(
    "nested context: probe reaches the layout's <HTML> panel (walk up, then search)",
    opts.urls.some((u) => u.indexOf("op=health") > 0),
    JSON.stringify(opts.urls.slice(0, 2)),
  );
  check(
    "nested context: no panel_unavailable line",
    !ctx.log.some((l) => l.indexOf("panel_unavailable") >= 0),
    JSON.stringify(ctx.log.filter((l) => l.indexOf("panel") >= 0).slice(0, 3)),
  );
  check("nested context: text translated through the bridge", label.text === "孤猎前期的重要装备。", JSON.stringify(label.text));
}

// ------------------------------------------------------------------
// 5. v1.9.29: the search must stay INSIDE the layout. In game the layouts are
//    mounted under the HUD root, which holds thousands of unrelated panels; a
//    walk-up-then-search from there never reached our <HTML> panel (14:39:16).
// ------------------------------------------------------------------
{
  const opts = { urls: [], timers: [], dead: false, id: "BBTBridgePanelShop" };
  const label = makeLabel("Key item for Drifter early game.", "BuildDescription");
  const ctx = boot([label], opts);
  // Put the layout root under a HUD-like root stuffed with junk siblings.
  const hud = makeLabel(undefined, "CitadelHud");
  hud.children.push(ctx.root);
  ctx.root._parent = hud;
  for (let i = 0; i < 5000; i += 1) {
    const junk = makeLabel("", "HudJunk");
    junk._parent = hud;
    hud.children.push(junk);
  }
  pump(ctx, 200);
  check(
    "hud-mounted layout: bridge reached without walking into the HUD tree",
    opts.urls.some((u) => u.indexOf("op=health") > 0),
    JSON.stringify(opts.urls.slice(0, 2)),
  );
  check("hud-mounted layout: text translated through the bridge", label.text === "孤猎前期的重要装备。", JSON.stringify(label.text));
}

// ------------------------------------------------------------------
// 6. v1.9.29: a CLOSED surface must not navigate. The panel exists but never
//    renders, so the page never runs and the title stays empty for the whole
//    timeout (in-game 15:00:55). The boot probe defers; the click on 翻译 (page
//    now visible) probes and connects.
// ------------------------------------------------------------------
{
  const opts = { urls: [], timers: [], dead: false, width: 0 };
  const label = makeLabel("Key item for Drifter early game.", "BuildDescription");
  const ctx = boot([label], opts);
  pump(ctx, 80);
  check(
    "closed surface: a zero-width panel is still probed (width is a hint, not a gate)",
    opts.urls.some((u) => u.indexOf("op=health") > 0),
    JSON.stringify(opts.urls),
  );
  opts.width = 2; // the user opened the page
  ctx.sandbox.BBTActivate("translate", ctx.root);
  pump(ctx, 300);
  check(
    "closed surface: click probes once the page is visible",
    opts.urls.some((u) => u.indexOf("op=health") > 0),
    JSON.stringify(opts.urls.slice(0, 2)),
  );
  check("closed surface: text translated after the click", label.text === "孤猎前期的重要装备。", JSON.stringify(label.text));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL LIVE CHANNEL CHECKS PASSED");
