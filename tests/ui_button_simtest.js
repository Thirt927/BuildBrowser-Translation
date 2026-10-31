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
    classList: [],
  };
  Object.defineProperty(p, "id", { get: () => p._id });
  Object.defineProperty(p, "class", { get: () => p._cls });
  p.ToggleClass = (c) => {
    const i = p.classList.indexOf(c);
    if (i >= 0) p.classList.splice(i, 1);
    else p.classList.push(c);
  };
  p.AddClass = (c) => { if (p.classList.indexOf(c) < 0) p.classList.push(c); };
  p.RemoveClass = (c) => { const i = p.classList.indexOf(c); if (i >= 0) p.classList.splice(i, 1); };
  p._t = opts.text;
  Object.defineProperty(p, "text", {
    get: () => p._t,
    set: (v) => { p._t = v; },
    configurable: true,
  });
  return p;
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
  root.children.push(bridge, label, menu);

  for (const t of texts) root.children.push(makePanel({ cls: "BuildDescription", text: t }));

  const queue = [];
  const log = [];
  const stored = Object.create(null);
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
  vm.createContext(sandbox);
  for (const f of ["bba_glossary.js", "bba_tm.js", "bba_layout_tokens.js", "bba_translate.js"]) {
    vm.runInContext(fs.readFileSync(path.join(SCRIPTS, f), "utf8"), sandbox, { filename: f });
  }
  vm.runInContext(fs.readFileSync(path.join(TMP, "tm.js"), "utf8"), sandbox, { filename: "tm.js" });
  return { sandbox, queue, root, label, menu, urls, timers, log, stored };
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

// ---------------------------------------------------------------- language modes
{
  const ctx = boot(["Rend > Heal > Repeat."], {});
  pump(ctx, 12);
  const label = ctx.root.children[3];
  check("mode zh shows the translation", label.text === "撕裂 > 治疗 > 重复。", JSON.stringify(label.text));

  ctx.sandbox.BBTSetLanguageMode("both");
  pump(ctx, 6);
  check("mode both shows translation + original", /撕裂 > 治疗 > 重复。\nRend > Heal > Repeat\./.test(label.text), JSON.stringify(label.text));
  check("mode is persisted", ctx.stored.bbt_language_mode === "both", JSON.stringify(ctx.stored));

  ctx.sandbox.BBTSetLanguageMode("orig");
  pump(ctx, 6);
  check("mode orig restores the original text", label.text === "Rend > Heal > Repeat.", JSON.stringify(label.text));

  ctx.sandbox.BBTSetLanguageMode("zh");
  pump(ctx, 6);
  check("mode zh again", label.text === "撕裂 > 治疗 > 重复。", JSON.stringify(label.text));
}

// ---------------------------------------------------------------- menu toggle
{
  const ctx = boot([], {});
  pump(ctx, 4);
  ctx.sandbox.BBTToggleMenu();
  check("menu opens", ctx.menu.classList.indexOf("BBTMenuOpen") >= 0, JSON.stringify(ctx.menu.classList));
  ctx.sandbox.BBTToggleMenu();
  check("menu closes", ctx.menu.classList.indexOf("BBTMenuOpen") < 0, JSON.stringify(ctx.menu.classList));
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
  check("label reports the result", /存入|翻译本页/.test(ctx.label.text), ctx.label.text);
}

// ---------------------------------------------------------------- no bridge: button says so
{
  const ctx = boot(["Some unknown english sentence here."], { dead: true });
  pump(ctx, 30);
  ctx.sandbox.BBTTranslatePage();
  check("button reports the missing bridge", /重新翻译|未连接|没有需要/.test(ctx.label.text), ctx.label.text);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL UI CHECKS PASSED");
