// UI flow: the toolbar button, the batch request and the language modes.
//
// Usage: node tests/ui_button_simtest.js
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const tmFormat = require("../tools/tm_format.js");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = path.join(ROOT, "mod", "panorama", "scripts");

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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bbt-ui-"));
fs.writeFileSync(path.join(TMP, "tm.js"), tmFormat.emitScript(map, { generated_at: "test" }));

// same key derivation as the game: double hash of the flattened text
function hashKey(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < flat.length; i += 1) {
    h1 = (h1 * 33 + flat.charCodeAt(i)) >>> 0;
    h2 = (h2 * 33 + flat.charCodeAt(i)) >>> 0;
  }
  return h1.toString(36) + "-" + h2.toString(36);
}

const NEW_TEXTS = {
  "Key item for Drifter early game.": "孤猎前期的重要装备。",
  "Buy two more copies later.": "之后再买两份。",
};

function makePanel(opts) {
  const p = {
    children: [],
    IsValid: () => true,
    BIsVisible: () => opts.hidden !== true,
    GetChildCount: () => p.children.length,
    GetChild: (i) => p.children[i] || null,
    _id: opts.id || "",
    _cls: opts.cls || "",
  };
  Object.defineProperty(p, "id", { get: () => p._id });
  // Engine-style classList: a token list with contains/add/remove. No `.class`
  // string (Source 2 panels don't expose one).
  const names = p._cls ? p._cls.split(/\s+/) : [];
  p.classList = {
    contains: (n) => names.indexOf(n) >= 0,
    add: (n) => { if (names.indexOf(n) < 0) names.push(n); },
    remove: (n) => { const i = names.indexOf(n); if (i >= 0) names.splice(i, 1); },
  };
  p.ToggleClass = (c) => {
    const i = names.indexOf(c);
    if (i >= 0) names.splice(i, 1);
    else names.push(c);
  };
  p.AddClass = (c) => { if (names.indexOf(c) < 0) names.push(c); };
  p.RemoveClass = (c) => { const i = names.indexOf(c); if (i >= 0) names.splice(i, 1); };
  p._t = opts.text;
  Object.defineProperty(p, "text", {
    get: () => p._t,
    set: (v) => { p._t = v; },
    configurable: true,
  });
  // Engine panels expose GetParent() - tsKeyOf/pageRoot walk up with it to find
  // the outermost page tag (the two-state key). A sim panel without it resolves
  // key="" and the caption reset falls back to 翻译 (R1/R2 fidelity bug).
  p._parent = null;
  p.GetParent = () => p._parent || null;
  // v1.9.31: the engine hands our handlers to SetPanelEvent. Without it
  // bindClick() bails out, so the sim could never reproduce the real click
  // path - which is exactly how the double-guard regression slipped through.
  p._events = {};
  p.SetPanelEvent = (event, fn) => {
    p._events[event] = p._events[event] || [];
    p._events[event].push(fn);
  };
  return p;
}

// children.push alone loses the parent link; attach() sets it both ways.
function attach(parent, ...kids) {
  for (const c of kids) {
    c._parent = parent;
    parent.children.push(c);
  }
}

function boot(texts, opts) {
  const root = makePanel({ cls: "CitadelHeroBuildsSelector" });
  const bridge = makePanel({ id: "BBTBridgePanel" });
  bridge._title = "";
  Object.defineProperty(bridge, "title", { get: () => bridge._title, configurable: true });
  const urls = [];
  const timers = [];
  bridge.SetURL = (url) => {
    urls.push(url);
    if (opts.dead) return;
    const u = new URL(url);
    if (opts.port && Number(u.port) !== opts.port) return; // only that bridge answers
    const id = u.searchParams.get("id");
    const op = u.searchParams.get("op");
    const tag = Number(u.port) === 8792 ? "LCT" : "BBT";
    timers.push(() => {
      if (decodeURIComponent(url).indexOf("tm/remember") > 0) {
        const dd = JSON.parse(u.searchParams.get("d") || "{}");
        bridge._title = tag + id + JSON.stringify({ ok: true, added: (dd.pairs || []).length });
        return;
      }
      if (decodeURIComponent(url).indexOf("tm/overrides") > 0) {
        const list = Object.keys(opts.overrides || {}).map((text) => ({
          k: hashKey(text),
          text,
          tr: opts.overrides[text],
        }));
        bridge._title = tag + id + JSON.stringify({ ok: true, overrides: list });
        return;
      }
      if (op === "health") {
        bridge._title = tag + id + JSON.stringify({ ok: true, name: "bbt-bridge", provider: "bing" });
        return;
      }
      const d = JSON.parse(u.searchParams.get("d") || "{}");
      if (Array.isArray(d.texts)) {
        bridge._title = tag + id + JSON.stringify({
          ok: true,
          translations: d.texts.map((t) => NEW_TEXTS[t] || null),
          added: d.texts.filter((t) => NEW_TEXTS[t]).length,
        });
      } else {
        const out = NEW_TEXTS[d.text];
        bridge._title = tag + id + JSON.stringify({ ok: !!out, translation: out || null });
      }
    });
  };
  const label = makePanel({ id: "BBTTranslateLabel", cls: "BBTLabel", text: "翻译本页" });
  const menu = makePanel({ id: "BBTMenu" });
  attach(root, bridge, label, menu);

  for (const t of texts) attach(root, makePanel({ cls: "BuildDescription", text: t }));

  const queue = [];
  const log = [];
  const stored = Object.create(null);
  // uiGuard keys its click window on host wall-clock Date.now(); a fake clock
  // lets tests space two deliberate clicks more than 600ms apart without
  // sleeping (the in-game guard protects against accidental double-taps, not
  // against spaced flips - the R1 原文 click must reach dispatch).
  const clock = { now: 1000 };
  const sandbox = {
    console: { log() {} },
    $: {
      GetContextPanel: () => root,
      Schedule: (d, fn) => queue.push({ d, fn }),
      Msg: (m) => log.push(String(m)),
      PersistentStorage: {
        GetString: (k, d) => (k in stored ? stored[k] : d),
        SetString: (k, v) => { stored[k] = v; },
      },
    },
  };
  sandbox.Date = { now: () => clock.now };
  // v1.9.29: the shipped memory is opt-in (bridge-first default). Suites that
  // exercise the offline engine pass { offline: true } or nothing at all.
  if (opts.offline !== false) sandbox.BBT_TM = "on";
  vm.createContext(sandbox);
  for (const f of ["bba_glossary.js", "bba_tm.js", "bba_layout_tokens.js", "bba_translate.js"]) {
    vm.runInContext(fs.readFileSync(path.join(SCRIPTS, f), "utf8"), sandbox, { filename: f });
  }
  vm.runInContext(fs.readFileSync(path.join(TMP, "tm.js"), "utf8"), sandbox, { filename: "tm.js" });
  return { sandbox, queue, root, label, menu, urls, timers, log, stored, advance: (ms) => { clock.now += ms; } };
}

function pump(ctx, steps) {
  for (let i = 0; i < steps; i += 1) {
    const batch = ctx.queue.splice(0, ctx.queue.length);
    for (const item of batch) {
      item.fn();
      while (ctx.timers.length) ctx.timers.shift()();
    }
  }
}

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " -- " + detail : ""));
  if (!cond) failures += 1;
}

// ---------------------------------------------------------------- button
{
  const texts = ["Key item for Drifter early game.", "Buy two more copies later.", "Rend > Heal > Repeat."];
  const ctx = boot(texts, {});
  pump(ctx, 30); // boot + probe + first scans
  check("boot announced the bridge", ctx.log.some((l) => l.indexOf("live bridge: connected") >= 0), JSON.stringify(ctx.log.slice(0, 2)));

  // The background channel translates what it sees; introduce brand new content
  // and click before the next scan tick so the button path is the only one.
  ctx.root.children[2].text = "Brand new sentence about rotations and tempo.";
  ctx.root.children[3].text = "Another unseen line about the objective timer.";
  NEW_TEXTS["Brand new sentence about rotations and tempo."] = "关于游走与节奏的全新句子。";
  NEW_TEXTS["Another unseen line about the objective timer."] = "另一条关于目标计时器的未见过句子。";

  const before = ctx.urls.length;
  ctx.sandbox.BBTTranslatePage();
  pump(ctx, 20);
  const batchUrls = ctx.urls.slice(before).filter((u) => u.indexOf("tm/translate") > 0 || u.indexOf("d=") > 0);
  check("button issued a request", batchUrls.length > 0, JSON.stringify(ctx.urls.slice(before)));
  check(
    "against BabelTower the button falls back to one text per request",
    ctx.urls.slice(before).every((u) => decodeURIComponent(u).indexOf('"text":') > 0),
    JSON.stringify(ctx.urls.slice(before)),
  );
  check("button label reports progress or result", /翻译|已翻译/.test(ctx.label.text), ctx.label.text);
}

// ---------------------------------------------------------------- batch against our own bridge
{
  const texts = ["Unseen one about tempo.", "Unseen two about tempo."];
  const ctx = boot(texts, { port: 8793 });
  pump(ctx, 30);
  ctx.root.children[2].text = "Fresh batch line A about rotations.";
  ctx.root.children[3].text = "Fresh batch line B about rotations.";
  NEW_TEXTS["Fresh batch line A about rotations."] = "批量A。";
  NEW_TEXTS["Fresh batch line B about rotations."] = "批量B。";
  const before = ctx.urls.length;
  ctx.sandbox.BBTTranslatePage();
  pump(ctx, 24);
  const reqs = ctx.urls.slice(before);
  const batched = reqs.filter((u) => decodeURIComponent(u).indexOf('"texts":[') > 0);
  check("our bridge gets exactly one batched request for the button", batched.length === 1, JSON.stringify(reqs));
  check(
    "batch request hits /api/v1/tm/translate",
    reqs.some((u) => decodeURIComponent(u).indexOf("/api/v1/tm/translate") > 0),
    JSON.stringify(reqs),
  );
}

// ---------------------------------------------------------------- language modes (T1: UI dropped)
{
  // v1.9.16: the three-mode dropdown (原文/翻译/中英对照) and the programmatic
  // BBTSetLanguageMode export were dropped. Display is now fixed to zh (offline
  // TM + bridge). The internal mode state machine was removed along with it; the
  // stored value is read back as the default "zh".
  const ctx = boot(["Rend > Heal > Repeat."], {});
  pump(ctx, 12);
  const label = ctx.root.children[3];
  check("display is fixed to zh (no mode UI)", label.text === "撕裂 > 治疗 > 重复。", JSON.stringify(label.text));
  check("BBTSetLanguageMode is no longer exposed", typeof ctx.sandbox.BBTSetLanguageMode === "undefined");
}

// ---------------------------------------------------------------- dispatch: no mode:next (T1)
{
  const ctx = boot(["Rend > Heal > Repeat."], {});
  pump(ctx, 12);
  const label = ctx.root.children[3];
  check("starts in zh", label.text === "撕裂 > 治疗 > 重复。", JSON.stringify(label.text));
  // mode:next was removed with the dropdown; a dispatch of it is a no-op
  // (unknown action) and must not change the label or throw.
  ctx.sandbox.BBTActivate("mode:next", ctx.root);
  pump(ctx, 6);
  check("BBTActivate('mode:next') is a no-op (route removed)", label.text === "撕裂 > 治疗 > 重复。", JSON.stringify(label.text));
}

// ---------------------------------------------------------------- overrides + language
{
  const ctx = boot(["Rend > Heal > Repeat.", "Key item for Drifter early game."], { port: 8793, overrides: { "Rend > Heal > Repeat.": "覆盖后的译文。" } });
  pump(ctx, 200);
  const offlineLabel = ctx.root.children[3]; // first injected text label
  const liveLabel = ctx.root.children[4];
  check("override replaces the shipped translation", offlineLabel.text === "覆盖后的译文。", JSON.stringify(offlineLabel.text));
  check("non-overridden text still uses the bridge", liveLabel.text === "孤猎前期的重要装备。", JSON.stringify(liveLabel.text));
  check("override count surfaced", ctx.sandbox.BBT_STATS.overrides >= 1, String(ctx.sandbox.BBT_STATS.overrides));

  // switch target language: zh-Hans lookups stop applying, the local table serves
  ctx.sandbox.BBTSetTargetLang("ja");
  pump(ctx, 10);
  check("language choice is persisted", ctx.stored.bbt_target_lang === "ja", JSON.stringify(ctx.stored));
  check("stats report the target language", ctx.sandbox.BBT_LIVE_STATE().targetLang === "ja", JSON.stringify(ctx.sandbox.BBT_LIVE_STATE().targetLang));
}

// ---------------------------------------------------------------- save page to table
{
  const ctx = boot(["Rend > Heal > Repeat."], { port: 8793 });
  pump(ctx, 200);
  const before = ctx.urls.length;
  ctx.sandbox.BBTSavePageToTable();
  pump(ctx, 10);
  const reqs = ctx.urls.slice(before).map((u) => decodeURIComponent(u));
  check("save-to-table calls tm/remember", reqs.some((u) => u.indexOf("/api/v1/tm/remember") > 0), JSON.stringify(reqs));
  check("save-to-table sends the translation it already has", reqs.some((u) => u.indexOf("撕裂 > 治疗 > 重复。") > 0), JSON.stringify(reqs));
  check("label reports the result", /存入|^翻译$/.test(ctx.label.text), ctx.label.text);
}

// ---------------------------------------------------------------- no bridge: button says so
{
  const ctx = boot(["Some unknown english sentence here."], { dead: true });
  pump(ctx, 30);
  ctx.sandbox.BBTTranslatePage();
  // The on-demand reprobe takes up to ~2*20 queue slots to settle both
  // targets as dead; pump far enough for the settled fallback to run.
  pump(ctx, 60);
  check("button reports the missing bridge", /未连接|没有需要|重新翻译/.test(ctx.label.text), ctx.label.text);
}

// ---------------------------------------------------------------- offline translate reports numbers (S2)
{
  const ctx = boot(["Rend > Heal > Repeat.", "Some totally unknown sentence here."], { dead: true });
  pump(ctx, 30);
  ctx.sandbox.BBTTranslatePage();
  // Wait for the on-demand reprobe to settle dead and for the 0.5s
  // fallback to run: that is when the [BBT] translate: line is logged.
  pump(ctx, 60);
  const line = ctx.log.find((l) => l.indexOf("translate: scanned=") >= 0);
  check(
    "offline translate logs scanned/wrote/already/miss",
    !!line && /translate: scanned=\d+ wrote=\d+ already=\d+ miss=\d+/.test(line),
    line || "(no translate line)"
  );
  check("offline translate counts the unknown sentence as missing", !!line && /miss=1\b/.test(line), line || "");
}

// ---------------------------------------------------------------- R1/R2/R4: two-state button (v1.9.26)
{
  // Multi-category-frame regression (RALPH Task 3): one 翻译 click must
  // translate the annotation of EVERY category frame on the page - not just
  // the last-generated batch - and 原文 must revert every frame back. The
  // build page starts on the original text (R4: no auto-translation).
  // The frames are plain subtrees here; in game each frame runs its own JS
  // context, shared through G.__BBT_TWO_STATE (the flip is per page key).
  const frameTexts = [
    "Frame zero annotation about tempo.",
    "Frame one annotation about tempo.",
    "Frame two annotation about tempo.",
  ];
  frameTexts.forEach((t, i) => { NEW_TEXTS[t] = "第" + i + "框的节奏注释。"; });
  const ctx = boot(["Key item for Drifter early game."], {});
  ctx.root.tag = "CitadelShopModsBuild"; // outermost page tag = the two-state key
  const frames = [];
  frameTexts.forEach((t, i) => {
    const frame = makePanel({ id: "BBTCatFrame" + i, cls: "BuildCategory" });
    const ann = makePanel({ cls: "BuildDescription", text: t });
    attach(frame, ann);
    attach(ctx.root, frame);
    frames.push(ann);
  });
  // The browser toolbar trigger: the caption source (uiSetModeText writes it).
  const button = makePanel({ id: "BBTTranslateButton2", text: "翻译本页" });
  attach(ctx.root, button);

  pump(ctx, 12);
  check(
    "R4: build page starts on the ORIGINAL text (scanner is gated, nothing auto-translates)",
    frames.every((l) => /^[A-Za-z]/.test(l.text)) && ctx.root.children[3].text === "Key item for Drifter early game.",
    JSON.stringify(frames.map((l) => l.text)) + " / " + ctx.root.children[3].text
  );

  // One 翻译 click: every frame's annotation gets translated.
  ctx.sandbox.BBTActivate("translate", ctx.root);
  pump(ctx, 30);
  check(
    "R2: 翻译 click translates EVERY category frame's annotation (not just the last)",
    frames.every((l, i) => l.text === "第" + i + "框的节奏注释。"),
    JSON.stringify(frames.map((l) => l.text))
  );
  check("button caption names the NEXT action (原文)", button.text === "原文", button.text);

  // One 原文 click: every frame reverts to the original text, round-trip.
  // Space the flip more than the 600ms anti-double-tap guard window (fake
  // clock) - a deliberate second press, not a duplicate of the first.
  ctx.advance(800);
  ctx.sandbox.BBTActivate("translate", ctx.root);
  pump(ctx, 30);
  check(
    "R1: 原文 click reverts EVERY frame to the original text",
    frames.every((l, i) => l.text === frameTexts[i]),
    JSON.stringify(frames.map((l) => l.text))
  );
  check("button caption back to 翻译", button.text === "翻译", button.text);

  // v1.9.31 regression - "有翻译按钮但点击无反应，日志一行都没有".
  // bindClick() runs uiGuard("act:"+name) and only then calls dispatch(), which
  // used to run the SAME guard key again. The second check always saw the
  // timestamp the handler had just written, so the click died inside dispatch
  // with no log line at all. Simulate exactly that: prime the ledger by firing
  // once, then dispatch again while flagged as "inside the handler".
  ctx.sandbox.BBT_DEBUG = true;
  const before = ctx.log.filter((l) => l.indexOf("two-state global") >= 0).length;
  ctx.sandbox.__BBT_ACT = {}; // clear the click ledger the earlier clicks wrote
  ctx.sandbox.BBTActivate("translate", ctx.root); // primes act:translate
  const primed = ctx.log.filter((l) => l.indexOf("two-state global") >= 0).length;
  ctx.sandbox.__BBT_IN_HANDLER = "translate"; // what bindClick sets around fn()
  ctx.sandbox.BBTActivate("translate", ctx.root); // the click itself
  ctx.sandbox.__BBT_IN_HANDLER = null;
  const after = ctx.log.filter((l) => l.indexOf("two-state global") >= 0).length;
  check(
    "v1.9.31: a click that already passed bindClick's guard still reaches dispatch",
    primed === before + 1 && after === primed + 1,
    "before=" + before + " primed=" + primed + " after=" + after
  );
  ctx.sandbox.BBT_DEBUG = false;
}

// ------------------------------------------- v1.9.29 bridge-first + watchdog
{
  // (a) Default build: the shipped memory is OFF, so text only the memory knows
  // stays English and the log says why. This is the deliberate "do not mislead
  // me with offline results" default.
  const ctx = boot(["Key item for Drifter early game."], { offline: false, dead: true });
  pump(ctx, 12);
  const lines = ctx.log.join("\n");
  check("bridge-first: boot line announces offline=off", /offline=off\)/.test(lines), lines.slice(0, 200));
  check(
    "bridge-first: offline memory reported disabled",
    /offline memory: disabled \(bridge-first mode\)/.test(lines),
    lines.slice(0, 300)
  );
  check("bridge-first: stats.offline is 'off'", ctx.sandbox.BBT_STATS.offline === "off", String(ctx.sandbox.BBT_STATS.offline));
  const desc = ctx.root.children.filter((c) => c.classList.contains("BuildDescription"))[0];
  check("bridge-first: a memory-known text stays English", desc && /^[A-Za-z]/.test(desc.text), desc && desc.text);

  // (b) The same fixture with the switch on still translates: the opt-in path
  // is intact, so the default flip is a policy change, not a regression.
  const ctxOn = boot(["Key item for Drifter early game."], { offline: true });
  pump(ctxOn, 30);
  const descOn = ctxOn.root.children.filter((c) => c.classList.contains("BuildDescription"))[0];
  check(
    "bridge-first: BBT_TM=on still translates from the memory",
    descOn && descOn.text === "孤猎前期的重要装备。",
    descOn && descOn.text
  );
}

{
  // (c) Caption watchdog: a bridge that never answers must not leave
  // "正在连接桥…" on the control. The panel has no BBTTranslateLabel here, so
  // the transient caption lands on the button exactly like the in-game header
  // button (#BBTTranslateButton3) whose context has no status label.
  const ctx = boot(["Key item for Drifter early game."], { dead: true, offline: true });
  ctx.root.tag = "CitadelShopModsBuild";
  const btn = makePanel({ id: "BBTTranslateButton2", text: "翻译" });
  attach(ctx.root, btn);
  // Detach the status label so uiSetLabel writes to the button (the on-screen
  // control the user was reading).
  const li = ctx.root.children.indexOf(ctx.label);
  if (li >= 0) ctx.root.children.splice(li, 1);
  pump(ctx, 6);
  ctx.sandbox.BBTActivate("translate", ctx.root);
  pump(ctx, 3);
  // The click may already have settled the caption to its resting mode name
  // (dispatch rewrites it after the action starts); what must never survive is
  // the bridge wording, so assert on the settled state below.
  ctx.advance(2500);
  pump(ctx, 40);
  check(
    "watchdog: a silent probe never leaves 连接桥 as the resting caption",
    (btn.text === "翻译" || btn.text === "原文") && btn.text.indexOf("连接") < 0,
    btn.text
  );
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL UI CHECKS PASSED");
