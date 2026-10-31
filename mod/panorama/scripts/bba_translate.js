// BuildBrowser Translation (BBT) - in-game Panorama script.
// ------------------------------------------------------------------
// Translates user-authored English text in the Deadlock build browser:
//   * build list names            (CitadelHeroBuildsSelector)
//   * build name / description    (CitadelBuildDetails)
//   * category names/descriptions (CitadelShopModsBuildCategory)
//   * per-item annotations        (CitadelShopModsBuild / mod tooltip)
//   * build hover descriptions    (citadel_tooltip_build_details)
//
// Translations come from bba_tm.js, a translation memory generated offline
// (tools/build_tm.js) from the most popular public builds. Text that is not in
// the memory falls back to a glossary pass that only swaps hero/item/rank names.
//
// Mechanics: poll the layout subtree, hash every label's text, look the hash up
// and write the Chinese string back. Everything needed ships inside the VPK, so
// the mod works with no extra software.
//
// Optional live channel (off unless a local bridge is running):
//   $.AsyncWebRequest is gone, but an <HTML> panel still has a real browser and
//   can reach the network. If a bridge process serves the page over HTTPS with a
//   certificate the engine trusts (scripts/gen_bridge_cert.ps1 -Trust +
//   tools/bridge/bridge.js), text that the offline memory does not know can be
//   translated on the spot: the page fetches the translation and hands it back
//   through document.title, which we poll. Same technique as BabelTower's
//   btipc-https channel.
// ------------------------------------------------------------------
(function () {
  "use strict";

  var VERSION = "1.9.7";
  // Debug logging is a runtime switch: set `BBT_DEBUG = true` in the game
  // console (`-condebug`) to see every write without rebuilding the VPK.
  var DEBUG = false;
  function debugOn() {
    return DEBUG || !!G.BBT_DEBUG;
  }
  var POLL_INTERVAL = 0.15; // seconds between scans while something changes
  var FAST_INTERVAL = 0.08; // burst poll right after new content appears
  var BURST_TICKS = 4; // how many fast polls after a change
  var IDLE_MAX_INTERVAL = 1.0; // back off to this when the tree is quiet
  var PARKED_INTERVAL = 0.5; // layout not visible (shop closed, browser closed)
  var IDLE_TICKS_BEFORE_BACKOFF = 6;
  var SCAN_BUDGET = 6000; // panels visited per tick
  var TERM_FALLBACK_MAX = 160; // only short labels get glossary substitution
  // Unseen English text is logged as "[BBT] MISS <key> <text>" so
  // tools/collect_new_texts.js can harvest it and grow the translation memory.
  var COLLECT_MISSES = true;
  var MISS_CAP = 300; // per layout instance and session

  // ---- optional live bridge (see the header) ----
  // AUTO: probe once at boot; if nothing answers, this channel stays off for the
  // session and the mod behaves exactly like a pure offline build.
  // Runtime override: set `BBT_LIVE = "off"` (or "on") in the game console.
  var LIVE_MODE_DEFAULT = "auto"; // "auto" | "off" | "on"
  // One id per layout: the details layout is instantiated *inside* the selector,
  // so reusing a single id would put two panels with the same id in one tree.
  var LIVE_PANEL_IDS = ["BBTBridgePanel", "BBTBridgePanelDetails"];
  // Try an already running Babel Tower bridge first (DeadlockLingua, port 8792):
  // it serves a page with the same technique and the same certificate, so people
  // who already use that mod need neither a second certificate nor a second
  // process. Our own bridge listens on 8793.
  var LIVE_TARGETS = [
    { port: 8792, tag: "LCT", name: "BabelTower" },
    { port: 8793, tag: "BBT", name: "bbt-bridge" },
  ];
  var LIVE_TARGET = null; // { port, tag, name } once the probe succeeded
  var LIVE_PROBE_TIMEOUT = 2.0; // seconds to wait for the health answer
  var LIVE_REQUEST_TIMEOUT = 6.0; // seconds per translation request
  var LIVE_POLL = 0.1; // title poll interval
  var LIVE_HARD_FAILS_MAX = 3; // give up after this many dead round trips
  var LIVE_TEXT_MAX = 700; // per-text cap (the title channel is a few KB)
  var LIVE_BATCH_CHARS = 2500; // total source characters per batch request
  var LIVE_CACHE_MAX = 600; // session-only memory of live translations

  function realGlobal() {
    try {
      if (typeof globalThis !== "undefined" && globalThis) return globalThis;
    } catch (e) {}
    try {
      return Function("return this")();
    } catch (e) {}
    return {};
  }
  var G = realGlobal();

  // ---- display mode (zh / orig / both), persisted between sessions ----
  // Panorama exposes $.PersistentStorage for small values; fall back to a global
  // so the tests (and engines without it) still work.
  var MODE_KEY = "bbt_language_mode";
  var mode = "zh";
  // Target language for translations. The shipped memory is zh-Hans only; any
  // other target is served by the local table / live bridge.
  var LANG_KEY = "bbt_target_lang";
  var TARGET_LANG = "zh-Hans";
  // Local translations that override the shipped memory (fetched from the bridge
  // when it connects). key(base hash) -> translation
  var overrides = null;

  function settingsGet(key, fallback) {
    try {
      if ($.PersistentStorage && typeof $.PersistentStorage.GetString === "function") {
        var v = $.PersistentStorage.GetString(key, "");
        if (v) return v;
      }
    } catch (e) {}
    return fallback;
  }

  function settingsSet(key, value) {
    try {
      if ($.PersistentStorage && typeof $.PersistentStorage.SetString === "function") {
        $.PersistentStorage.SetString(key, value);
      }
    } catch (e) {}
  }
  var GLOSS = G.BBA_GLOSSARY || null;
  // class/id -> the text="..." our layouts declare. Lets the scanner recognise
  // engine-driven labels. Generated by tools/build_layout_tokens.js.
  var LAYOUT_TOKENS = G.BBA_LAYOUT_TOKENS || null;
  // The translation memory is only shipped in the long-lived layouts (build
  // browser + shop). Tooltip layouts read it from the shared globalThis and
  // therefore look it up on every call instead of capturing it at boot.

  // ---------- text normalization (must match tools/build_tm.js) ----------

  function stripInvisible(s) {
    return s
      .replace(/\uFEFF/g, "")
      .replace(/[\u200B-\u200D\u2060]/g, "");
  }

  function normalize(s) {
    return stripInvisible(String(s == null ? "" : s))
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s+/, "")
      .replace(/\s+$/, "");
  }

  function flatten(s) {
    return normalize(s).replace(/\s+/g, " ");
  }

  function hash32(s, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < s.length; i += 1) {
      h = (h * 33 + s.charCodeAt(i)) >>> 0;
    }
    return h >>> 0;
  }

  function keyOf(s) {
    return hash32(s, 5381).toString(36) + "-" + hash32(s, 52711).toString(36);
  }

  // Copy suffix the game appends when you duplicate a build ("X 的副本" / "X (Copy)").
  var COPY_SUFFIX = /\s*(的副本|\(Copy\)|\(copy\)|Copy)$/;
  var HAS_CJK = /[\u3400-\u9fff]/;

  // Lookup goes through BBA_TM_GET (compact format) when available and falls
  // back to the legacy object literal. Tooltip layouts load their own copy of
  // the memory, so this is resolved per call, never captured at boot.
  function tmGet(key) {
    var get = G.BBA_TM_GET;
    if (typeof get === "function") {
      var v = get(key);
      return v || null;
    }
    var tm = G.BBA_TM;
    return tm ? tm[key] || null : null;
  }

  function overrideFor(flat) {
    if (!overrides || !flat) return null;
    return overrides[keyOf(flat)] || overrides[keyOf(flat.replace(COPY_SUFFIX, ""))] || null;
  }

  function lookup(raw) {
    var flat = flatten(raw);
    if (!flat) return null;

    // 1. local overrides (translations the user/bridge corrected or added).
    var ov = overrideFor(flat);
    if (ov) return { text: ov, wasCopy: false, via: "override" };

    // 2. the shipped memory (Chinese only).
    if (TARGET_LANG !== "zh-Hans") return null;
    if (typeof G.BBA_TM_GET !== "function" && !G.BBA_TM) return null;
    // Candidates: [text, wasCopySuffixStripped]. The stripped-suffix variant
    // is reported back so the caller can re-append the copy marker.
    var candidates = [[flat, false]];
    var noSuffix = flat.replace(COPY_SUFFIX, "");
    if (noSuffix && noSuffix !== flat) candidates.push([noSuffix, true]);
    if (/<[^>]+>/.test(flat)) {
      // Some labels are html=true and wrap the user text in markup.
      var plain = flatten(flat.replace(/<[^>]+>/g, " "));
      candidates.push([plain, false]);
      var plainNoSuffix = plain.replace(COPY_SUFFIX, "");
      if (plainNoSuffix && plainNoSuffix !== plain) candidates.push([plainNoSuffix, true]);
    }
    for (var i = 0; i < candidates.length; i += 1) {
      var hit = tmGet(keyOf(candidates[i][0]));
      if (hit) return { text: hit, wasCopy: candidates[i][1] };
    }
    return null;
  }

  // ---------- fragment fallback ----------
  // New builds reuse plenty of sentences from older ones ("Key item early game.",
  // "Lane phase matters."). When the whole description is not in the memory we
  // translate the parts that ARE, and keep the rest in English -- a mixed result
  // that is far more useful than "all English". Applied only when most of the
  // text is covered, so we never produce a mostly-English soup.
  var FRAG_MIN_LEN = 10; // ignore very short fragments (risky, low information)
  var FRAG_MIN_COVERAGE = 0.55;
  // Long generated descriptions ("Top <hero> build generated by <mask> every
  // build path in 1,853 matches ...") change a few numbers/masks per day, so an
  // exact hit is rare. For those, some Chinese sentences beat none.
  var FRAG_MIN_COVERAGE_LONG = 0.35;
  var FRAG_LONG_CHARS = 200;

  // Split on sentence enders, line breaks and the ">" / "|" separators common in
  // build notes. No lookbehind (Panorama's engine does not support it).
  function splitFragments(text) {
    // Split on sentence enders and the separators build notes use, but KEEP the
    // separator in the output: the caller joins the parts back and compares with
    // the input, and a dropped ">" or space would corrupt the mixed result.
    var out = [];
    var buf = "";
    for (var i = 0; i < text.length; i += 1) {
      var c = text.charAt(i);
      if (c === "\n" || c === "|" || c === ">") {
        buf += c;
        out.push(buf);
        buf = "";
        continue;
      }
      buf += c;
      if (c === "." || c === "!" || c === "?" || c === ";") {
        var nx = i + 1 < text.length ? text.charAt(i + 1) : "";
        if (nx === " " || nx === "\n" || nx === "\t") {
          out.push(buf);
          buf = "";
        }
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  function fragmentTranslate(raw) {
    var parts = splitFragments(raw);
    if (parts.length < 2) return null;
    var total = 0;
    var covered = 0;
    var hits = 0;
    var out = [];
    for (var i = 0; i < parts.length; i += 1) {
      var piece = parts[i];
      var trimmed = piece.replace(/^\s+/, "").replace(/\s+$/, "");
      total += trimmed.length;
      var hit = null;
      if (trimmed.length >= FRAG_MIN_LEN) hit = lookup(trimmed);
      if (hit && hit.text) {
        covered += trimmed.length;
        hits += 1;
        // Keep the original leading/trailing whitespace so the joined text keeps
        // its shape (the separators themselves live in the parts).
        var lead = piece.slice(0, piece.indexOf(trimmed));
        var trail = piece.slice(piece.indexOf(trimmed) + trimmed.length);
        out.push(lead + hit.text + trail);
      } else {
        out.push(piece);
      }
    }
    if (!hits || !total) return null;
    var minCoverage = raw.length > FRAG_LONG_CHARS ? FRAG_MIN_COVERAGE_LONG : FRAG_MIN_COVERAGE;
    if (covered / total < minCoverage) return null;
    var joined = out.join("");
    return joined === raw ? null : joined;
  }



  // ---------- UI: the toolbar button, the dropdown and the page batch ----------
  // Handlers are global functions because Panorama resolves onactivate="Name()"
  // in the global scope.

  var ui = { busy: false, lastResult: "", batch: [] };

  function uiPanel(id) {
    var ids = typeof id === "string" ? [id] : id;
    if (!ids || !ids.length) return null;
    var root = null;
    try { root = $.GetContextPanel(); } catch (e) { return null; }
    var stack = [root];
    var budget = 4000;
    while (stack.length && budget > 0) {
      budget -= 1;
      var p = stack.pop();
      if (!p) continue;
      try {
        for (var k = 0; k < ids.length; k += 1) {
          if (p.id === ids[k]) return p;
        }
      } catch (e) {}
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch (e) { n = 0; }
      for (var i = 0; i < n; i += 1) {
        try {
          var c = p.GetChild(i);
          if (c) stack.push(c);
        } catch (e) {}
      }
    }
    return null;
  }

  function uiSetLabel(text) {
    var l = uiPanel(["BBTTranslateLabel", "BBTTranslateLabel2"]);
    if (l) {
      try { l.text = text; } catch (e) {}
    } else {
      // The toolbar uses the game's TextButton (native look), whose text lives on
      // the button itself instead of in a child label.
      var b = uiPanel(["BBTTranslateButton2", "BBTTranslateButton"]);
      if (b) {
        try { b.text = text; } catch (e) {}
      }
    }
    ui.lastResult = text;
  }

  // The widest panel the toolbar button should act on. Several layout instances
  // run this script (selector, details, tooltips) and all of them share the same
  // global handlers; resolving the root from the button itself keeps "翻译本页"
  // pointing at the whole page instead of whichever layout booted last.
  function pageRoot() {
    var p = uiPanel(["BBTTranslateButton2", "BBTTranslateButton", "BBTTranslateLabel2", "BBTTranslateLabel"]);
    var details = null;
    for (var i = 0; p && i < 12; i += 1) {
      var pt = "";
      try { pt = String(p.paneltype || ""); } catch (e) { pt = ""; }
      if (pt === "CitadelHeroBuildsSelector") return p; // the whole browser
      if (pt === "CitadelBuildDetails" && !details) details = p;
      try { p = p.GetParent ? p.GetParent() : null; } catch (e) { p = null; }
    }
    if (details) return details;
    try { return $.GetContextPanel(); } catch (e) {}
    return null;
  }

  // Collect the texts on screen that neither the shipped memory nor the session
  // cache knows. These are exactly the rows the button asks about.
  // `root` is passed by the toolbar handlers (see pageRoot): the button must act
  // on the whole build browser even when the script instance that happens to own
  // the last global handler belongs to a smaller layout (tooltip).
  function collectMisses(limit, root) {
    if (!root) {
      try { root = $.GetContextPanel(); } catch (e) { return []; }
    }
    var out = [];
    var seen = Object.create(null);
    var stack = [root];
    var budget = 3000;
    while (stack.length && budget > 0) {
      budget -= 1;
      var p = stack.pop();
      if (!p) continue;
      if (!panelVisible(p)) continue;
      var t = null;
      try { t = p.text; } catch (e) { t = null; }
      if (typeof t === "string" && t.length >= 3 && t.length <= LIVE_TEXT_MAX) {
        if (t.indexOf("#") !== 0 && !HAS_CJK.test(t) && !seen[t]) {
          var rec = memo.get(p);
          var translatedAlready = rec && rec.k === 1 && rec.in === t;
          if (!translatedAlready && !lookup(t) && !liveCacheGet(t) && !overrideFor(t)) {
            seen[t] = 1;
            out.push(t);
            if (limit && out.length >= limit) break;
          }
        }
      }
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch (e) { n = 0; }
      for (var i = 0; i < n; i += 1) {
        try {
          var c = p.GetChild(i);
          if (c) stack.push(c);
        } catch (e) {}
      }
    }
    return out;
  }

  // The bridge translates a batch and grows the table; the payload travels in
  // ?d= (JSON) and comes back through document.title, so keep batches small.
  var UI_BATCH = 8;

  function uiRequestBatch(texts, onDone) {
    if (live.state !== "on" || !LIVE_TARGET) {
      onDone(null, "offline");
      return;
    }
    // Chunk by count *and* by characters: eight long descriptions would blow the
    // document.title budget and come back as "too_large".
    var chunks = [];
    var cur = [];
    var chars = 0;
    for (var i = 0; i < texts.length; i += 1) {
      var len = String(texts[i]).length;
      if (cur.length && (cur.length >= UI_BATCH || chars + len > LIVE_BATCH_CHARS)) {
        chunks.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(texts[i]);
      chars += len;
    }
    if (cur.length) chunks.push(cur);
    var results = Object.create(null);
    var index = 0;

    function next() {
      if (index >= chunks.length) {
        onDone(results, null);
        return;
      }
      var chunk = chunks[index];
      index += 1;
      // Our bridge translates the whole chunk in one round trip; BabelTower's API
      // takes one text at a time, so it gets them one by one.
      var batchable = LIVE_TARGET.tag === "BBT" && chunk.length > 1;
      var req = batchable
        ? { kind: "batch", texts: chunk, target: TARGET_LANG }
        : { kind: "text", text: chunk[0], target: TARGET_LANG };
      liveSend(
        req,
        LIVE_REQUEST_TIMEOUT,
        function (ok, err, res) {
          if (ok && res && (res.translations || res.translation)) {
            var got = res.translations || [res.translation];
            var appliedCount = 0;
            for (var k = 0; k < chunk.length; k += 1) {
              if (got[k]) {
                results[chunk[k]] = String(got[k]);
                liveCachePut(chunk[k], String(got[k]));
                appliedCount += 1;
              }
            }
            stats.batchAdded += res.added || 0;
            stats.live += appliedCount;
            noteTableSize(res.table);
            // BabelTower answers one text per request: continue with the rest of
            // the chunk by re-queueing the remainder.
            if (!batchable && appliedCount && chunk.length > 1) {
              chunks.splice(index, 0, chunk.slice(1));
            }
            next();
          } else {
            liveMarkFailure(err || (res && res.error) || "batch_failed");
            onDone(results, err || "batch_failed");
          }
        },
        LIVE_TARGET,
        "/api/v1/tm/translate",
      );
    }
    next();
  }

  // Write the freshly translated strings into the labels that are on screen now.
  function uiApplyResults(results) {
    var root = null;
    try { root = $.GetContextPanel(); } catch (e) { return 0; }
    var applied = 0;
    var stack = [root];
    var budget = 3000;
    while (stack.length && budget > 0) {
      budget -= 1;
      var p = stack.pop();
      if (!p) continue;
      if (!panelVisible(p)) continue;
      var t = null;
      try { t = p.text; } catch (e) { t = null; }
      if (typeof t === "string") {
        var tr = results[t] || liveCacheGet(t);
        if (tr) {
          if (writeText(p, present(t, tr))) {
            applied += 1;
            remember(p, 1, t, present(t, tr));
          }
        }
      }
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch (e) { n = 0; }
      for (var i = 0; i < n; i += 1) {
        try {
          var c = p.GetChild(i);
          if (c) stack.push(c);
        } catch (e) {}
      }
    }
    return applied;
  }

  // ---------- optional live bridge ----------
  // Everything here is guarded: if no bridge answers, these functions do nothing
  // and the offline memory is the only source. Requests are serialised (one in
  // flight) because the transport is a single HTML panel whose document.title is
  // the return channel.

  var live = {
    state: "unknown", // unknown | probing | on | off
    provider: "",
    targetName: "",
    tableSize: -1,
    panel: null,
    seq: 0,
    pending: null, // { id, text, target, done, startedAt, to }
    queue: [],
    cache: Object.create(null),
    tried: Object.create(null), // texts already requested this session
    triedCount: 0,
    cacheKeys: [],
    hardFails: 0,
    translated: 0,
  };

  function liveRoot() {
    var ctx = null;
    try { ctx = $.GetContextPanel(); } catch (e) { return null; }
    // The <HTML> panel is declared in the layout; find it by id once.
    var stack = [ctx];
    var budget = 4000;
    while (stack.length && budget > 0) {
      budget -= 1;
      var p = stack.pop();
      if (!p) continue;
      try {
        if (p.id && LIVE_PANEL_IDS.indexOf(String(p.id)) >= 0) return p;
      } catch (e) {}
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch (e) { n = 0; }
      for (var i = 0; i < n; i += 1) {
        try {
          var c = p.GetChild(i);
          if (c) stack.push(c);
        } catch (e) {}
      }
    }
    return null;
  }

  function livePanel() {
    if (live.panel && live.panel.IsValid && live.panel.IsValid()) return live.panel;
    live.panel = liveRoot();
    return live.panel;
  }

  function liveHealthUrl(t, id) {
    return "https://localhost:" + t.port + "/bridge?id=" + id + "&op=health";
  }

  // BabelTower's page reads a JSON payload from ?d= and posts it to its own API;
  // our bridge accepts the same shape, so one client works with both.
  function liveTranslateUrl(t, id, text, target) {
    var payload = {
      operation: "translate",
      text: text,
      targetLanguage: target || "zh-Hans",
    };
    return "https://localhost:" + t.port + "/bridge?id=" + id +
      "&op=translate&d=" + encodeURIComponent(JSON.stringify(payload));
  }

  // Build the bridge page URL for one request.
  //   kind "health"        -> ?op=health
  //   kind "text"          -> one text, works with BabelTower and our bridge
  //   kind "batch"         -> { texts: [...] }, only our bridge has that API
  function liveRequestUrl(t, id, req) {
    var base = "https://localhost:" + t.port + "/bridge?id=" + id;
    if (req.kind === "health") return base + "&op=health";
    if (req.kind === "remember") {
      return base + "&op=health&api=" + encodeURIComponent("/api/v1/tm/remember") +
        "&d=" + encodeURIComponent(JSON.stringify({ pairs: req.pairs, target: req.target || TARGET_LANG }));
    }
    if (req.kind === "overrides") {
      return base + "&op=health&api=" + encodeURIComponent("/api/v1/tm/overrides") +
        "&target=" + encodeURIComponent(req.target || "zh-Hans");
    }
    var payload;
    var extra = "";
    if (req.kind === "batch") {
      payload = { texts: req.texts, target: req.target || "zh-Hans" };
      // our page needs to know which endpoint to hit; BabelTower's ignores ?p
      if (t.tag === "BBT") extra = "&p=/api/v1/tm/translate";
    } else {
      payload = { operation: "translate", text: req.text, targetLanguage: req.target || TARGET_LANG };
    }
    return base + "&op=translate&d=" + encodeURIComponent(JSON.stringify(payload)) + extra;
  }

  function liveSend(req, timeoutSec, cb, target) {
    // Only one request may be in flight: document.title is a single channel and
    // a second job would clobber the first one's pending slot (losing its reply).
    if (live.pending) {
      cb(false, "busy", null);
      return null;
    }
    var panel = livePanel();
    if (!panel || typeof panel.SetURL !== "function") {
      cb(false, "panel_unavailable", null);
      return null;
    }
    var t = target || LIVE_TARGET;
    if (!t) {
      cb(false, "no_target", null);
      return null;
    }
    var id = "r" + (++live.seq).toString(36);
    var job = {
      id: id,
      tag: t.tag,
      url: liveRequestUrl(t, id, req),
      cb: cb,
      startedAt: 0,
      polls: 0,
      maxPolls: Math.ceil((timeoutSec || LIVE_REQUEST_TIMEOUT) / LIVE_POLL),
      done: false,
    };
    live.pending = job;
    try {
      panel.SetURL(job.url);
    } catch (e) {
      live.pending = null;
      cb(false, "seturl_failed", null);
      return null;
    }
    $.Schedule(LIVE_POLL, function () { livePoll(job); });
    return job;
  }

  // document.title carries "BBT<id>{json}" once the page has the answer.
  function livePoll(job) {
    if (!live.pending || live.pending !== job || job.done) return;
    var panel = livePanel();
    var title = "";
    try { title = panel && panel.title ? String(panel.title) : ""; } catch (e) { title = ""; }
    var prefix = (job.tag || "BBT") + job.id;
    if (title && title.indexOf(prefix) === 0) {
      var payload = null;
      try { payload = JSON.parse(title.slice(prefix.length)); } catch (e) { payload = null; }
      if (payload && payload.translation && !payload.translations) {
        // BabelTower answers with a single {translation}; normalise it.
        payload = { ok: payload.ok !== false, translations: [String(payload.translation)] };
      }
      if (payload) {
        job.done = true;
        live.pending = null;
        job.cb(true, null, payload);
        return;
      }
    }
    job.polls += 1;
    if (job.polls > job.maxPolls) {
      job.done = true;
      live.pending = null;
      job.cb(false, "timeout", null);
      return;
    }
    $.Schedule(LIVE_POLL, function () { livePoll(job); });
  }

  function liveMarkFailure(reason) {
    live.hardFails += 1;
    if (live.hardFails >= LIVE_HARD_FAILS_MAX) {
      live.state = "off";
      $.Msg("[BBT] live bridge disabled after " + live.hardFails + " failures (" + reason + "); offline memory only");
    }
  }

  function liveProbeTargets(index) {
    index = index || 0;
    if (index >= LIVE_TARGETS.length) {
      live.state = "off";
      $.Msg("[BBT] live bridge: not available on " +
        LIVE_TARGETS.map(function (t) { return t.port; }).join("/") +
        "; offline memory only");
      return;
    }
    var t = LIVE_TARGETS[index];
    liveSend({ kind: "health" }, LIVE_PROBE_TIMEOUT, function (ok, err, payload) {
      if (ok && payload && (payload.ok || payload.translations)) {
        LIVE_TARGET = t;
        live.provider = payload.provider ? String(payload.provider) : "";
        live.targetName = payload.name ? String(payload.name) : t.name;
        live.state = "on";
        stats.liveProvider = live.provider;
        // Delayed so the first on-screen texts get the channel first: overrides
        // exist to correct the pak, not to block it.
        $.Schedule(1.5, function () {
          try { liveFetchOverrides(); } catch (e) {}
        });
        $.Msg("[BBT] live bridge: connected to " + live.targetName + " (localhost:" + t.port +
          (live.provider ? ", provider=" + live.provider : "") +
          "), offline memory + live fallback" +
          (live.provider && live.provider !== "bing" ? " [note: that provider is configured in the bridge's own settings]" : ""));
        try { liveUpgradeWeakWrites(); } catch (e) {}
        return;
      }
      liveProbeTargets(index + 1);
    }, t);
  }

  function liveMode() {
    var m = G.BBT_LIVE;
    return m === "off" || m === "on" || m === "auto" ? m : LIVE_MODE_DEFAULT;
  }

  function liveProbe() {
    if (liveMode() === "off" || live.state !== "unknown") return;
    live.state = "probing";
    liveProbeTargets(0);
  }

  // Panels that only got glossary term substitution get a second chance now that
  // a real translator is available. The source text is taken from the memo (the
  // label currently shows the mixed string, not the original English).
  function liveUpgradeWeakWrites() {
    // Re-arm every "nothing found" panel: the bridge may know it.
    for (var m = 0; m < missedList.length; m += 1) {
      var mp = missedList[m];
      var mrec = memo.get(mp);
      if (mrec && mrec.k === 0) memo.delete(mp);
    }
    missedList.length = 0;
    if (!weakWrites || !weakWrites.has) return;
    for (var i = 0; i < written.length; i += 1) {
      var p = written[i];
      if (!weakWrites.has(p)) continue;
      weakWrites.delete(p);
      var rec = memo.get(p);
      if (!rec || rec.k !== 1 || !rec.in) continue;
      var cur;
      try { cur = p.text; } catch (e) { continue; }
      if (cur !== rec.out) continue; // repainted meanwhile: the scan will redo it
      queueLiveUpgrade(p, rec.in, rec.out);
    }
  }

  var liveUpgrades = [];

  function queueLiveUpgrade(panel, srcText, shownText) {
    liveUpgrades.push({ panel: panel, text: srcText, shown: shownText });
  }

  function liveDrainUpgrades() {
    if (live.state !== "on" || live.pending || !liveUpgrades.length) return;
    var job = liveUpgrades.shift();
    var cached = liveCacheGet(job.text);
    if (cached) {
      applyLiveUpgrade(job, cached);
      return;
    }
    liveSend({ kind: "text", text: job.text, target: TARGET_LANG }, LIVE_REQUEST_TIMEOUT, function (ok, err, payload) {
      if (!ok) { liveMarkFailure(err || "no_answer"); return; }
      var out = payload && payload.translations ? payload.translations[0] : null;
      if (payload && payload.ok && out) {
        live.hardFails = 0;
        liveCachePut(job.text, String(out));
        applyLiveUpgrade(job, String(out));
      }
    });
  }

  function applyLiveUpgrade(job, value) {
    var p = job.panel;
    var cur;
    try { cur = p.text; } catch (e) { return; }
    if (cur !== job.shown) return; // user already moved on
    var shown = present(job.text, value);
    if (writeText(p, shown)) {
      stats.live += 1;
      if (debugOn()) logWrite(p, job.text, shown, "live-upgrade");
    }
    remember(p, 1, job.text, shown);
  }

  // Pull the local translations that differ from the shipped memory, so a
  // correction made in the local table wins over the pak.
  // Track the bridge's table size: when it grows, the overrides may have changed
  // (a correction made later must still win over the shipped text).
  function noteTableSize(n) {
    if (typeof n !== "number") return;
    if (live.tableSize === n) return;
    live.tableSize = n;
    if (live.state === "on") $.Schedule(0.5, function () { try { liveFetchOverrides(); } catch (e) {} });
  }

  function liveFetchOverrides(attempt) {
    attempt = attempt || 0;
    if (!LIVE_TARGET || LIVE_TARGET.tag !== "BBT") return; // only our bridge has it
    liveSend({ kind: "overrides", target: TARGET_LANG }, LIVE_REQUEST_TIMEOUT, function (ok, err, res) {
      if (!ok || !res || !res.overrides) {
        // "busy" just means a translation is in flight: try again later.
        if (attempt < 3) {
          $.Schedule(err === "busy" ? 1.0 : 3.0, function () { liveFetchOverrides(attempt + 1); });
        }
        return;
      }
      var map = Object.create(null);
      var n = 0;
      for (var i = 0; i < res.overrides.length; i += 1) {
        var row = res.overrides[i];
        if (!row || !row.k || !row.tr) continue;
        map[row.k] = String(row.tr);
        n += 1;
      }
      var changed = false;
      if (overrides) {
        var oldKeys = Object.keys(overrides);
        changed = oldKeys.length !== n;
        for (var j = 0; j < oldKeys.length && !changed; j += 1) {
          if (overrides[oldKeys[j]] !== map[oldKeys[j]]) changed = true;
        }
      } else {
        changed = n > 0;
      }
      overrides = map;
      stats.overrides = n;
      if (changed) {
        $.Msg("[BBT] local overrides loaded: " + n);
        try { resetMemos($.GetContextPanel()); } catch (e) {}
      }
      // No timer: the bridge reports its table size on every response, and a
      // change there (new translations, new corrections) triggers a refetch. See
      // noteTableSize().
    }, LIVE_TARGET, "/api/v1/tm/overrides?target=" + encodeURIComponent(TARGET_LANG));
  }

  function liveCacheGet(text) {
    return live.cache[text] || null;
  }

  function liveCachePut(text, value) {
    if (live.cache[text] !== undefined) return;
    if (live.cacheKeys.length >= LIVE_CACHE_MAX) delete live.cache[live.cacheKeys.shift()];
    live.cache[text] = value;
    live.cacheKeys.push(text);
  }

  // Ask the bridge for one text. Returns the cached value immediately when known.
  function liveTranslate(panel, raw) {
    if (live.state !== "on") return false;
    if (typeof raw !== "string" || raw.length < 3 || raw.length > LIVE_TEXT_MAX) return false;
    var cached = liveCacheGet(raw);
    if (cached) {
      var shown = present(raw, cached);
      if (writeText(panel, shown)) {
        stats.live += 1;
        if (debugOn()) logWrite(panel, raw, shown, "live-cache");
      }
      remember(panel, 1, raw, shown);
      return true;
    }
    if (live.tried[raw]) return false; // asked already: wait for the answer
    if (live.pending) {
      // One request at a time; retry this text shortly.
      if (live.queue.indexOf(raw) < 0) live.queue.push(raw);
      return false;
    }
    live.tried[raw] = 1;
    live.triedCount += 1;
    if (live.triedCount > 2000) {
      live.tried = Object.create(null);
      live.triedCount = 1;
      live.tried[raw] = 1;
    }
    liveSend({ kind: "text", text: raw, target: TARGET_LANG }, LIVE_REQUEST_TIMEOUT, function (ok, err, payload) {
      if (!ok) {
        stats.liveLastError = err || "no_answer";
        liveMarkFailure(err || "no_answer");
        return;
      }
      var out = payload && payload.translations ? payload.translations[0] : null;
      if (payload && payload.ok && out) {
        live.hardFails = 0;
        noteTableSize(payload.table);
        liveCachePut(raw, String(out));
        stats.live += 1;
        // Re-read the label: it may have been repainted meanwhile.
        var cur;
        try { cur = panel.text; } catch (e) { cur = null; }
        if (cur === raw) {
          var shownLive = present(raw, String(out));
          writeText(panel, shownLive);
          remember(panel, 1, raw, shownLive);
        } else {
          memo.delete(panel); // let the next scan decide with the current text
        }
      }
    });
    return false;
  }

  function liveDrainQueue() {
    if (live.state !== "on" || live.pending || !live.queue.length) return;
    var next = live.queue.shift();
    if (liveCacheGet(next)) return;
    // No panel reference any more: the label is re-scanned anyway, so just ask
    // for the text and let the cache serve it next tick.
    liveSend({ kind: "text", text: next, target: TARGET_LANG }, LIVE_REQUEST_TIMEOUT, function (ok, err, payload) {
      if (!ok) { liveMarkFailure(err || "no_answer"); return; }
      var out = payload && payload.translations ? payload.translations[0] : null;
      if (payload && payload.ok && out) {
        live.hardFails = 0;
        liveCachePut(next, String(out));
      }
    });
  }

  // ---------- glossary term fallback ----------

  var TERM_RE = null;
  var TERM_MAP = {};
  var TERM_CASED = {};

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildTermRegex() {
    if (!GLOSS || TERM_RE) return;
    var terms = [];
    var push = function (map, cased) {
      if (!map) return;
      for (var en in map) {
        if (!Object.prototype.hasOwnProperty.call(map, en)) continue;
        if (en.length < 3 || en.length > 48) continue;
        terms.push(en);
        TERM_MAP[en.toLowerCase()] = map[en];
        if (cased) TERM_CASED[en.toLowerCase()] = true;
      }
    };
    push(GLOSS.items, false);
    push(GLOSS.heroes, true);
    push(GLOSS.ranks, true);
    if (!terms.length) return;
    terms.sort(function (a, b) {
      return b.length - a.length;
    });
    // No lookbehind: ECMAScript engines inside Panorama do not reliably support it.
    TERM_RE = new RegExp("(^|[^A-Za-z0-9])(" + terms.map(escapeRe).join("|") + ")(?![A-Za-z0-9])", "gi");
  }

  function substituteTerms(raw) {
    if (!TERM_RE) return null;
    var count = 0;
    var out = raw.replace(TERM_RE, function (all, lead, term) {
      var lower = term.toLowerCase();
      var cn = TERM_MAP[lower];
      if (!cn) return all;
      if (TERM_CASED[lower]) {
        var first = term.charAt(0);
        if (first !== first.toUpperCase() || first === first.toLowerCase()) return all;
      }
      count += 1;
      return lead + cn;
    });
    return count > 0 ? out : null;
  }

  // ---------- DOM scan ----------
  var stats = {
    translated: 0, fallback: 0, scanned: 0, misses: 0, ms: 0, interval: 0,
    writes: 0, rebinds: 0, skipped: 0, hidden: 0, fragments: 0, live: 0,
    liveProvider: "",
    batchAdded: 0,
    overrides: 0,
    rebindUndone: 0,
    tableEntries: 0,
    tableAliases: 0,
  };
  // Labels that were seen carrying a #token before the engine filled them in.
  var tokenOf = new WeakMap();
  // Labels we literally saw as "#Something" (not merely inferred from the layout
  // table). Restoring a token is only safe when we really saw one; see
  // resyncLabel below for the safety net.
  var observedToken = new WeakMap();
  // Panels whose token we just restored: the engine has to resolve it on the next
  // frame. If it does not, the label was not token-bound after all.
  // Panels we have written a translation into (bounded, for the rebind sweep).
  var written = [];
  // Panels whose text we only changed by substituting glossary terms. When the
  // live bridge comes up these are worth redoing: the offline pass produced a
  // mixed string, the bridge can produce a real translation of the original.
  var weakWrites = new WeakSet ? new WeakSet() : null;
  // Panels we looked at and found nothing for. They are re-armed when the live
  // bridge becomes available (otherwise the "nothing to do" memo would keep them
  // English forever).
  var missedList = [];
  if (!WeakSet) {
    var weakList = [];
  }
  // Identity labels (build name, build id, mod name): their text changes when
  // the shown build/item changes.
  var identity = new WeakMap();
  var identityChanged = false;
  // Set when an untranslated label changed for a reason other than identity.
  var contentChanged = false;

  // Only labels we never translate can act as "the shown build changed" signals:
  // build id, version, last-updated, mod name. (Build name/description are user
  // text, so they get translated and would feed us our own writes.)
  var IDENTITY_TOKEN = /BuildID|LastUpdatedTime|HeroBuilds_Version|ModName|Item_Name/i;
  // Labels that change on their own (relative timestamps, timers): they must not
  // be read as "a different build is shown", or the panel would re-translate
  // every second.
  var TICKING_TOKEN = /_Time|LastUpdated|Timer|Clock|Cooldown|Ammo|Health|Level/i;

  // Log-only display name. In the real engine the classes live on
  // panel.classList (Source 2 has no `.class` string), so when the string
  // form is absent, probe the class names that matter for logging.
  var CLASS_PROBES = [
    "BuildName", "BuildDescription", "CategoryName", "CategoryDescription",
    "BuildID", "LastUpdated", "CopiedToClipboard", "BBTSrc", "BBTDst",
  ];
  function classOf(panel) {
    try {
      var c = panel.class;
      if (typeof c === "string") return c.split(/\s+/)[0] || "?";
    } catch (e) {}
    for (var i = 0; i < CLASS_PROBES.length; i += 1) {
      if (panelHasClass(panel, CLASS_PROBES[i])) return CLASS_PROBES[i];
    }
    return "?";
  }

  // The #token this label is declared with. Prefer what we actually saw at boot;
  // fall back to the generated layout table (keys by id, then by class).
  function tokenFor(panel) {
    var t = tokenOf.get(panel);
    if (t) return t;
    if (!LAYOUT_TOKENS) return null;
    try {
      var id = panel.id;
      if (typeof id === "string" && id && LAYOUT_TOKENS.byId[id]) return LAYOUT_TOKENS.byId[id];
    } catch (e) {}
    // The real engine exposes no `.class` string: CSS classes live on
    // panel.classList (a token list with .contains()), so probe the known
    // class names instead of splitting a string.
    // Our own source/mirror labels are never token-bound for our purposes.
    if (panelHasClass(panel, "BBTSrc") || panelHasClass(panel, "BBTDst")) return null;
    var bc = LAYOUT_TOKENS.byClass;
    for (var cn in bc) {
      if (bc[cn] && panelHasClass(panel, cn)) return bc[cn];
    }
    // Ambiguous classes (two labels, two tokens) are not in byClass; byClassAll
    // still tells us one plausible token, which is enough for logging and for
    // the frozen-label sweep (the dialog-variable path keys off the class).
    var ba = LAYOUT_TOKENS.byClassAll;
    if (ba) {
      for (var an in ba) {
        if (!panelHasClass(panel, an)) continue;
        var all = ba[an];
        if (all && all.length) return all[0];
      }
    }
    return null;
  }

  // ---------- engine labels: re-resolve on demand ----------
  // A label declared with text="#Token" whose localized value is a {s:var}
  // template is owned by the engine: writing `.text` destroys the template, and
  // from then on the engine's own updates have nowhere to land (the label keeps
  // the first translation forever). Hiding the engine label is not a way out
  // either: a collapsed or zero-sized label resolves nothing at all, so the text
  // simply disappears (both verified in game).
  //
  // So the labels stay in place and are translated in place. To get the value
  // for the build that is on screen *now* we first ask the engine through
  // $.Localize(token, panel): the token is resolved with the dialog variables in
  // scope for that label, which are exactly the ones for the selected build.
  // That covers the description as well (the header name happened to survive a
  // token re-render, the overview description did not).
  // Only when that yields nothing we put the declared #token back into the label
  // and let the engine render it; if that fails too the previous text is
  // restored, so the UI never sits on a raw "#Token".
  function classListOf(panel) {
    try {
      var c = panel.class;
      if (typeof c === "string") return c;
    } catch (e) {}
    return "";
  }

  // Source 2 in-game panels expose no `.class` string and no DOM-like
  // classList: the engine binding is panel.BHasClass(name) (the form BabelTower
  // verified in game; our v1.9.6 test proved classList/.class collect 0 labels
  // there). Test shims lack BHasClass, so read all three: BHasClass first
  // (engine), classList second, `.class` string last (legacy shims).
  function panelHasClass(panel, cls) {
    try {
      if (typeof panel.BHasClass === "function") return panel.BHasClass(cls) === true;
    } catch (e) {}
    try {
      var cl = panel.classList;
      if (cl && typeof cl.contains === "function") return cl.contains(cls) === true;
    } catch (e) {}
    try {
      var c = panel.class;
      if (typeof c === "string") {
        var parts = c.split(/\s+/);
        for (var i = 0; i < parts.length; i += 1) if (parts[i] === cls) return true;
      }
    } catch (e) {}
    return false;
  }

  // Only classes whose declaration is unambiguous get re-resolved: ModifiesLabel,
  // for instance, is used for two different tokens.
  var RESYNC_TOKENS = [
    ["BuildDescription", "#Citadel_HeroBuilds_BuildDescription"],
    ["BuildName", "#Citadel_HeroBuilds_BuildName"],
    ["CategoryName", "#Citadel_HeroBuilds_CategoryName"],
    ["CategoryDescription", "#Citadel_HeroBuilds_CategoryDescription"],
  ];

  function roleTokenFor(panel) {
    for (var i = 0; i < RESYNC_TOKENS.length; i += 1) {
      if (panelHasClass(panel, RESYNC_TOKENS[i][0])) return RESYNC_TOKENS[i][1];
    }
    return null;
  }

  // Reject anything that is not a usable English source: an unresolved token,
  // an unresolved {s:var} template, or the token itself coming back verbatim.
  function resolvedText(v, tok) {
    if (typeof v !== "string" || !v) return null;
    if (v.indexOf("#") === 0) return null;
    if (v === tok) return null;
    if (v.indexOf("{s:") >= 0) return null;
    return v;
  }

  // Show `raw` (the engine's current English) again and translate it. The old
  // text is dropped first: when the translation memory has nothing for the new
  // build the label must fall back to the new English instead of keeping the
  // previous build's Chinese (that was the "overview never changes" report).
  function applyResync(p, raw) {
    var cur = null;
    try { cur = p.text; } catch (e) { cur = null; }
    memo.delete(p);
    if (mode === "orig") {
      try { p.text = raw; } catch (e) {}
      return;
    }
    if (cur !== raw) {
      try { p.text = raw; } catch (e) {}
    }
    try { translatePanel(p, raw); } catch (e) {}
  }

  var localizeProbed = false;
  function resyncLabel(p) {
    var tok = roleTokenFor(p);
    if (!tok) return false;
    var prev = null;
    try { prev = p.text; } catch (e) { return false; }
    // 1) Ask the engine for the current value with the label's dialog variables.
    var fresh = null;
    try { fresh = $.Localize(tok, p); } catch (e) { fresh = null; }
    fresh = resolvedText(fresh, tok);
    if (fresh) {
      stats.resyncOk = (stats.resyncOk || 0) + 1;
      applyResync(p, fresh);
      return true;
    }
    // One probe per layout instance: the -condebug log then shows whether the
    // engine's $.Localize really yields the current value (2-arg form), or
    // only the raw token / template. The next fix step depends on this answer.
    if (!localizeProbed) {
      localizeProbed = true;
      var two = null, one = null;
      try { two = $.Localize(tok, p); } catch (e) { two = "err:" + e; }
      try { one = $.Localize(tok); } catch (e) { one = "err:" + e; }
      $.Msg(
        "[BBT] localize-probe " + tok +
          " 2arg=" + JSON.stringify(String(two).slice(0, 48)) +
          " 1arg=" + JSON.stringify(String(one).slice(0, 48))
      );
    }
    // 2) Not available: put the declared token back and let the engine render
    // it (0.2s is enough for the label to be laid out again).
    if (typeof prev !== "string" || prev.indexOf("#") === 0) prev = null;
    try { p.text = tok; } catch (e) { return false; }
    var tries = 0;
    (function check() {
      tries += 1;
      var now = null;
      try { now = p.text; } catch (e) { now = null; }
      var val = resolvedText(now, tok);
      if (val) {
        stats.resyncOk = (stats.resyncOk || 0) + 1;
        if (debugOn()) $.Msg("[BBT] resync-ok " + tok + " -> " + JSON.stringify(val.slice(0, 40)));
        applyResync(p, val);
        return;
      }
      if (tries < 3) { $.Schedule(0.2, check); return; }
      stats.resyncFail = (stats.resyncFail || 0) + 1;
      if (prev !== null) {
        try { p.text = prev; } catch (e) {}
      }
      $.Msg("[BBT] resync-fail " + tok + " raw=" + JSON.stringify(String(now).slice(0, 24)));
    })();
    return true;
  }

  // Re-resolve every visible engine label under the page root. This is walked
  // from the tree on purpose: the labels that matter (build name/description)
  // may have been written by another layout instance, so relying on this
  // instance's `written`/`memo` lists silently skipped them.
  // The header/overview labels are handled first: the budget must never be spent
  // on list rows and leave the overview on the previous build's translation.
  function primaryRole(panel) {
    return panelHasClass(panel, "BuildName") || panelHasClass(panel, "BuildDescription");
  }

  function resyncAll(limit) {
    var max = limit || 40;
    var root = null;
    try { root = pageRoot(); } catch (e) { root = null; }
    if (!root) {
      try { root = $.GetContextPanel(); } catch (e) { root = null; }
    }
    if (!root) return 0;
    var primary = [];
    var secondary = [];
    var stack = [root];
    var budget = 3000;
    while (stack.length && budget > 0) {
      budget -= 1;
      var p = stack.pop();
      if (!p) continue;
      var ok = true;
      try { if (p.IsValid && !p.IsValid()) ok = false; } catch (e) { ok = false; }
      if (!ok) continue;
      if (!panelVisible(p)) continue;
      if (roleTokenFor(p)) {
        if (primaryRole(p)) primary.push(p);
        else secondary.push(p);
      }
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch (e) { n = 0; }
      for (var k = n - 1; k >= 0; k -= 1) {
        try {
          var ch = p.GetChild(k);
          if (ch) stack.push(ch);
        } catch (e) {}
      }
    }
    var count = 0;
    var order = primary.concat(secondary);
    for (var i = 0; i < order.length && count < max; i += 1) {
      count += 1;
      try { resyncLabel(order[i]); } catch (e) {}
    }
    return count;
  }

  // One line per write. `via` says which path produced it, and the trailing
  // `tok=` shows the label's original #token (proving it is engine-driven).
  function logWrite(panel, raw, out, via) {
    var tok = tokenFor(panel) || "-";
    $.Msg(
      "[BBT] W " + via + " ." + classOf(panel) + " " + JSON.stringify(raw.slice(0, 60)) +
        " => " + JSON.stringify(out.slice(0, 60)) + " tok=" + tok,
    );
  }
  // Write only when the label currently shows something else. Comparing against
  // the live text (instead of a "last written" cache) is what makes the scanner
  // re-apply after the engine resets a label to its original English on refresh.
  // Apply the current display mode to a translated string:
  //   zh   -> 译文
  //   orig -> 原文(不写入,交由调用方跳过)
  //   both -> 译文 + 空行 + 原文
  function present(raw, translated) {
    if (mode === "both") return translated + "\n" + raw;
    return translated;
  }

  function writeText(panel, value) {
    var current;
    try { current = panel.text; } catch (e) { return false; }
    if (typeof current === "string" && current === value) return false;
    try {
      panel.text = value;
      if (written.length < 400 && written.indexOf(panel) < 0) written.push(panel);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Per-panel memo. Two shapes:
  //   {k:0, in}        nothing was written (miss / already Chinese) -> skip while
  //                    the label still shows that same text.
  //   {k:1, in, out}   we wrote `out` -> skip while the label still shows `out`.
  //                    When the engine repaints the original English, raw === in
  //                    and no longer equals out, so the lookup runs again.
  // A single "last seen text" cache cannot express this: it would also skip the
  // repaint case and leave labels stuck in English.
  var memo = new WeakMap();

  function remember(panel, kind, raw, out) {
    memo.set(panel, { k: kind, in: raw, out: out || null });
  }

  var missSeen = Object.create(null);

  function noteMiss(raw, panel) {
    if (!COLLECT_MISSES || stats.misses >= MISS_CAP) return;
    try {
      // Custom panels can expose their type name through .text; never collect that.
      if (panel && panel.paneltype && raw === panel.paneltype) return;
    } catch (e) {}
    var flat = flatten(raw);
    if (flat.length < 4 || flat.length > 2000) return;
    if (!/[A-Za-z]{2}/.test(flat)) return;
    if (/^https?:\/\//i.test(flat)) return;
    var k = keyOf(flat);
    if (missSeen[k]) return;
    missSeen[k] = 1;
    stats.misses += 1;
    $.Msg("[BBT] MISS " + k + " " + flat);
  }

  function isTextEntry(panel) {
    try {
      if (typeof panel.placeholder === "string") return true;
      // maxchars may be exposed as a number or as the raw attribute string.
      if (typeof panel.maxchars === "number" || typeof panel.maxchars === "string") return true;
    } catch (e) {}
    return false;
  }

  // Deadlock panels expose visibility as BIsVisible(); IsVisible() is not reliable here.
  function panelVisible(panel) {
    try {
      if (typeof panel.BIsVisible === "function") return panel.BIsVisible();
      if (typeof panel.IsVisible === "function") return panel.IsVisible();
    } catch (e) {}
    return true;
  }

  function translatePanel(panel, preRead) {
    var raw;
    try {
      // Scan already read the text; re-reading it here would double the number
      // of JS <-> UI binding crossings, which dominate the in-game cost.
      raw = preRead === undefined ? panel.text : preRead;
    } catch (e) {
      return;
    }
    if (typeof raw !== "string" || raw.length < 2) return;

    if (mode === "orig") {
      // "show the original": never write; if we had written before, put it back.
      var rec0 = memo.get(panel);
      if (rec0 && rec0.k >= 1 && raw === rec0.out) {
        try { panel.text = rec0.in; } catch (e) {}
        memo.delete(panel);
      }
      return;
    }
    if (raw.indexOf("#") === 0) {
      // localization token, already localized by the game. Remember it: if this
      // label later shows the engine's resolved English, the token proves the
      // label is engine-driven (and, when the localized value contains {s:var},
      // that it is bound to dialog variables).
      if (!memo.has(panel)) tokenOf.set(panel, raw);
      observedToken.set(panel, raw);
      remember(panel, 0, raw, null);
      return;
    }
    // Some custom panels expose their type name through .text; never treat that
    // as content (and never write to it).
    try {
      if (panel.paneltype && raw === panel.paneltype) {
        remember(panel, 0, raw, null);
        return;
      }
    } catch (e) {}

    // Cheap early-outs before any hashing: the overwhelming majority of labels
    // in the game UI are Chinese localization output and never need a lookup.
    // Only duplicated-build names ("X 的副本") mix CJK with English source text
    // and therefore still have to be looked up.
    var seen = memo.get(panel);
    if (seen) {
      if (seen.k === 0) {
        if (raw === seen.in) {
          // Memoised as "nothing found". Re-check the cheap sources: the live
          // cache may have been filled (background translation, overrides fetch)
          // since then, in which case this label must be redone now.
          if (!liveCacheGet(raw) && !overrideFor(raw)) {
            // Not available yet. If the bridge is up and we have not asked for
            // this text, fall through and ask now; otherwise stay quiet.
            if (!(live.state === "on" && !live.tried[raw])) return;
          }
        }
      } else if (seen.k === 1) {
        if (raw === seen.out) return;
      }
    }
    if (HAS_CJK.test(raw) && !COPY_SUFFIX.test(raw)) {
      remember(panel, 0, raw, null);
      return;
    }

    // Look the text up first: duplicated builds carry a copy suffix, which
    // lookup strips before hashing; the marker is re-appended below so the
    // display still tells copies apart.
    var hit = lookup(raw);
    if (hit) {
      var display = hit.wasCopy ? hit.text + " 的副本" : hit.text;
      display = present(raw, display);
      if (writeText(panel, display)) {
        stats.translated += 1;
        stats.writes += 1;
        if (debugOn()) logWrite(panel, raw, display, "TM");
      }
      remember(panel, 1, raw, display);
      return;
    }

    // Sentence-level: new builds mostly reuse sentences from older ones.
    var frag = fragmentTranslate(raw);
    if (frag) {
      frag = present(raw, frag); // "both" mode appends the source text
      if (writeText(panel, frag)) {
        stats.fragments += 1;
        if (debugOn()) logWrite(panel, raw, frag, "frag");
      }
      remember(panel, 1, raw, frag);
      return;
    }

    // Unknown text: ask the optional bridge (no-op when it is not running).
    if (liveTranslate(panel, raw)) return;

    noteMiss(raw, panel);

    var mixed = null;
    if (normalize(raw).length <= TERM_FALLBACK_MAX) {
      mixed = substituteTerms(raw);
      if (mixed) mixed = present(raw, mixed);
      if (mixed && writeText(panel, mixed)) {
        stats.fallback += 1;
        stats.writes += 1;
        if (debugOn()) logWrite(panel, raw, mixed, "term");
      }
    }
    if (mixed) {
      remember(panel, 1, raw, mixed);
      if (weakWrites && weakWrites.add) weakWrites.add(panel);
    } else {
      remember(panel, 0, raw, null);
      if (missedList.length < 800 && missedList.indexOf(panel) < 0) missedList.push(panel);
    }
  }

  var lastVisited = 0;

  function scan(root) {
    var stack = [root];
    var visited = 0;
    var fresh = 0;
    var skipped = 0;
    while (stack.length && visited < SCAN_BUDGET) {
      var p = stack.pop();
      visited += 1;
      if (!p) continue;
      try {
        if (p.IsValid && !p.IsValid()) continue;
      } catch (e) {
        continue;
      }
      var known = memo.has(p);
      if (!known) fresh += 1;
      // Only panels that carry a string need the extra TextEntry probes; every
      // other panel type would cost two more property reads per tick.
      var t;
      try { t = p.text; } catch (e) { t = null; }
      // Resolve the label's declared #token once (id/class lookup), then reuse
      // it: identity labels tell us the shown build/item changed, even when the
      // panels we already translated are stuck on an old translation.
      if (!known) {
        var tk = tokenFor(p);
        if (tk) tokenOf.set(p, tk);
      }
      if (typeof t === "string" && t.length >= 2) {
        if (!isTextEntry(p)) translatePanel(p, t);
        else if (!known) remember(p, 0, t, null);
      } else if (!known) {
        remember(p, 0, null, null);
      }
      // Track identity only on labels the translator leaves alone; tracking a
      // label we translated would see our own write as "the build changed".
      var tok = tokenOf.get(p);
      var rec = memo.get(p);
      if (tok && typeof t === "string" && (!rec || rec.k === 0)) {
        if (IDENTITY_TOKEN.test(tok)) {
          var prev = identity.get(p);
          if (prev !== undefined && prev !== t) identityChanged = true;
          identity.set(p, t);
        } else if (!TICKING_TOKEN.test(tok) && rec && rec.in !== t) {
          // Some other engine-driven label changed inside this layout: the
          // hovered item / opened panel is a different one even if no explicit
          // identity label exists (tooltips have very few labels).
          contentChanged = true;
          remember(p, 0, t, null);
        }
      }
      var n = 0;
      try {
        n = p.GetChildCount ? p.GetChildCount() : 0;
      } catch (e) {
        n = 0;
      }
      for (var i = n - 1; i >= 0; i -= 1) {
        try {
          var c = p.GetChild(i);
          if (!c) continue;
          // Hidden subtrees cannot show text (collapsed build sections, closed
          // tabs, off-screen list pages). Skipping them costs one call and
          // saves every read below them -- this is what keeps a big page cheap.
          if (!panelVisible(c)) {
            skipped += 1;
            continue;
          }
          stack.push(c);
        } catch (e) {}
      }
    }
    stats.scanned += visited;
    stats.skipped += skipped;
    lastVisited = visited;
    return fresh;
  }

  // Adaptive polling: a freshly painted layout (new build, opened tooltip) is
  // rescanned every POLL_INTERVAL; a quiet one backs off to IDLE_MAX_INTERVAL.
  // This is what keeps the mod from walking thousands of panels 6-7 times a
  // second forever while the player is just looking at a screen.
  var interval = POLL_INTERVAL;
  var idleTicks = 0;
  var burstTicks = 0;
  var ticksSinceRebind = 99;
  // Toolbar placement state (see placeToolbar): retried from tick until the
  // engine's header has a real size.
  var toolbarPlaced = false;
  var placeTries = 0;

  function tick() {
    var t0 = Date.now ? Date.now() : 0;
    var before = stats.translated + stats.fallback;
    var fresh = 0;
    var hidden = false;
    try {
      var ctx = $.GetContextPanel();
      if (ctx && panelVisible(ctx)) fresh = scan(ctx);
      else hidden = true;
    } catch (e) {
      hidden = true;
    }
    if (hidden) {
      // Nothing on screen: no reason to walk anything. Re-check rarely; the
      // panel becomes visible again long before a human notices 2s.
      stats.hidden += 1;
      stats.interval = PARKED_INTERVAL;
      idleTicks = 0;
      burstTicks = 0;
      interval = POLL_INTERVAL;
      $.Schedule(PARKED_INTERVAL, tick);
      return;
    }
    // A new build/item is on screen: the engine-owned labels (build name,
    // description, category headers) still show our previous translation, so
    // re-apply their #token to let the engine resolve the new English, then
    // translate it again.
    if (identityChanged || (contentChanged && ticksSinceRebind > 3)) {
      identityChanged = false;
      contentChanged = false;
      // A new build/item is showing: stay responsive for a moment instead of
      // sitting at the backed-off interval, so a hovered tooltip is translated
      // on the next poll (~150ms) rather than up to a second later.
      idleTicks = 0;
      interval = POLL_INTERVAL;
      try {
        if (resyncAll(40)) ticksSinceRebind = 0;
      } catch (e) {}
    }
    ticksSinceRebind += 1;
    // The toolbar position is measured from the engine's header. A layout that
    // was not laid out yet reports zero sizes, so keep retrying (bounded) until
    // it can be placed; afterwards it stays put.
    if (!toolbarPlaced) {
      placeTries += 1;
      if (placeTries < 120) {
        try { toolbarPlaced = placeToolbar(); } catch (e) {}
      }
    }
    try { liveDrainQueue(); } catch (e) {}
    try { liveDrainUpgrades(); } catch (e) {}
    var worked = stats.translated + stats.fallback > before || fresh > 0;
    if (worked) {
      idleTicks = 0;
      // New panels (opened tooltip, freshly rendered build page) deserve a
      // short burst of fast polls so the text is translated as soon as it
      // exists, instead of waiting for the 150ms cadence.
      if (fresh > 0) burstTicks = BURST_TICKS;
      interval = burstTicks > 0 ? FAST_INTERVAL : POLL_INTERVAL;
    } else if (burstTicks > 0) {
      burstTicks -= 1;
      idleTicks = 0;
      interval = burstTicks > 0 ? FAST_INTERVAL : POLL_INTERVAL;
    } else {
      idleTicks += 1;
      if (idleTicks > IDLE_TICKS_BEFORE_BACKOFF && interval < IDLE_MAX_INTERVAL) {
        interval = Math.min(interval * 2, IDLE_MAX_INTERVAL);
      }
    }
    if (t0) stats.ms = (Date.now ? Date.now() : 0) - t0;
    stats.interval = interval;
    $.Schedule(interval, tick);
  }



  // ---------- wiring the toolbar ----------
  // onactivate="Name()" makes the engine resolve `Name` in the layout's global
  // scope. That fails silently when the script is wrapped in an IIFE or the global
  // is not where the engine looks, which looks exactly like "the button does
  // nothing". SetPanelEvent binds the callback to the panel itself, so the buttons
  // work regardless. The XML handlers stay as a fallback; uiGuard() stops the two
  // paths from running the same action twice.
  var uiWired = Object.create(null);
  var uiWiredOnce = false;
  var lastAction = { name: "", at: 0 };

  function uiGuard(name) {
    var now = 0;
    try { now = Date.parse(new Date().toISOString()) || 0; } catch (e) { now = 0; }
    if (lastAction.name === name && now - lastAction.at < 350) return false;
    lastAction.name = name;
    lastAction.at = now;
    return true;
  }

  function onActivate(ids, fn, name) {
    var panel = uiPanel(ids);
    if (!panel) return false;
    try {
      if (typeof panel.SetPanelEvent === "function") {
        panel.SetPanelEvent("onactivate", function () {
          if (uiGuard(name)) fn();
        });
        uiWired[name] = true;
        return true;
      }
    } catch (e) {}
    return false;
  }

  // Panorama only hit-tests inside the parent's bounds, so the dropdown (which
  // drops over the header, well outside the toolbar's row) lives on the layout
  // root. Its position is measured from the toolbar itself, not from a hardcoded
  // offset: the header height depends on the game's locale and build.
  function actualOffset(panel, ancestor) {
    var x = 0;
    var y = 0;
    var p = panel;
    var guard = 0;
    while (p && p !== ancestor && guard < 40) {
      try {
        x += Number(p.actualx) || 0;
        y += Number(p.actualy) || 0;
      } catch (e) {}
      try { p = p.GetParent ? p.GetParent() : null; } catch (e) { p = null; }
      guard += 1;
    }
    if (p !== ancestor) return null;
    return { x: x, y: y };
  }

  function placeToolbar() {
    var ctl = uiPanel("BBTControls2");
    var menu = uiPanel("BBTMenu2");
    if (!ctl || !menu) return false;
    var root = null;
    try { root = menu.GetParent(); } catch (e) { root = null; }
    if (!root) return false;
    var off = actualOffset(ctl, root);
    if (!off) return false;
    var ch = 0;
    var cw = 0;
    var rw = 0;
    try { ch = Number(ctl.actualheight) || 0; cw = Number(ctl.actualwidth) || 0; } catch (e) {}
    try { rw = Number(root.actualwidth) || 0; } catch (e) {}
    // Before the first layout pass every size is 0; the CSS fallback stays until
    // the next attempt.
    if (ch <= 0 || cw <= 0 || rw <= 0) return false;
    var top = Math.round(off.y + ch + 4);
    var right = Math.round(rw - (off.x + cw));
    if (!(top > 0)) return false;
    if (right < 4) right = 4;
    try {
      menu.style.marginTop = top + "px";
      menu.style.marginRight = right + "px";
    } catch (e) { return false; }
    return true;
  }

  function wireToolbar() {
    try { placeToolbar(); } catch (e) {}
    if (uiWiredOnce) return;
    if (!uiPanel(["BBTTranslateButton", "BBTTranslateButton2", "BBTMenuButton", "BBTMenuButton2"])) return;
    uiWiredOnce = true;
    // Bind every toolbar present in this layout (the selector has one, the
    // standalone details view has another; a nested details panel hides its own
    // copy, but the binding is harmless and keeps the code simple).
    // The handlers use this instance's functions (not G.BBT*Page): the global is
    // overwritten by whichever layout booted last, and that instance does not
    // share our memo/written state.
    onActivate(["BBTTranslateButton", "BBTTranslateButton2"], function () { translatePage(); }, "translate");
    onActivate(["BBTRefreshButton", "BBTRefreshButton2"], function () { refreshPage(); }, "refresh");
    onActivate(["BBTMenuButton", "BBTMenuButton2"], function () { toggleMenu(); }, "menu");
    var modes = [["zh", "显示中文"], ["orig", "显示原文"], ["both", "中英对照"]];
    wireMenuItems(modes, setLanguageMode, "mode-");
    var langs = [
      ["zh-Hans", "简体中文"], ["zh-Hant", "繁體中文"], ["ja", "日本語"],
      ["ko", "한국어"], ["en", "English"],
    ];
    wireMenuItems(langs, setTargetLang, "lang-");
    wireMenuItems(
      [["save", "把新译文存入本地库"], ["stats", "查看本地库统计"]],
      function (v) {
        if (v === "save") savePageToTable();
        else showTableStats();
      },
      "misc-",
    );
    $.Msg("[BBT] toolbar wired: " + Object.keys(uiWired).length + " control(s)");
  }

  // Menu buttons have no ids (they are generated from the layout), so they are
  // located by their label text. That also covers the second toolbar.
  // `action` is called with the item's value; it runs in this instance so the
  // mode/language change lands in the layout that owns the toolbar.
  function wireMenuItems(items, action, prefix) {
    var menuPanels = [uiPanel("BBTMenu"), uiPanel("BBTMenu2")];
    for (var m = 0; m < menuPanels.length; m += 1) {
      var menu = menuPanels[m];
      if (!menu) continue;
      var n = 0;
      try { n = menu.GetChildCount ? menu.GetChildCount() : 0; } catch (e) { n = 0; }
      for (var i = 0; i < n; i += 1) {
        var child = null;
        try { child = menu.GetChild(i); } catch (e) { child = null; }
        if (!child) continue;
        var text = "";
        try {
          var lbl = child.GetChild && child.GetChild(0);
          text = lbl && typeof lbl.text === "string" ? lbl.text : "";
        } catch (e) {
          text = "";
        }
        if (!text) continue;
        for (var k = 0; k < items.length; k += 1) {
          if (text.indexOf(items[k][1]) < 0) continue;
          onActivateChild(child, (function (value) {
            return function () { action(value); };
          })(items[k][0]), prefix + items[k][0] + m);
        }
      }
    }
  }

  function onActivateChild(panel, fn, name) {
    try {
      if (typeof panel.SetPanelEvent === "function") {
        panel.SetPanelEvent("onactivate", function () {
          if (uiGuard(name)) fn();
        });
        uiWired[name] = true;
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ---------- global UI handlers (referenced from the layout) ----------

  function uiMenuPanel() {
    return uiPanel(["BBTMenu", "BBTMenu2"]);
  }

  // Small introspection helper (console: BBT_LIVE_STATE()) - handy when a user
  // reports "the button does nothing".
  G.BBT_LIVE_STATE = function () {
    return {
      state: live.state,
      target: LIVE_TARGET ? LIVE_TARGET.name + ":" + LIVE_TARGET.port : null,
      pending: !!live.pending,
      queue: live.queue.length,
      cache: Object.keys(live.cache).length,
      overrides: overrides ? Object.keys(overrides).length : -1,
      mode: mode,
      targetLang: TARGET_LANG,
      stats: stats,
    };
  };

  // The dropdown is toggled through its inline style: that always wins, whereas
  // a `visibility: collapse` rule plus a `.BBTMenuOpen` class depends on the CSS
  // cascade (which is why the menu never opened in the field).
  var menuOpen = false;
  function setMenuOpen(open) {
    menuOpen = !!open;
    // The menu is placed relative to the toolbar, which the engine may have
    // moved since the last measurement (window resize, header height change).
    if (menuOpen) {
      try { placeToolbar(); } catch (e) {}
    }
    var m = uiMenuPanel();
    if (!m) return;
    try {
      if (m.style) m.style.visibility = menuOpen ? "visible" : "collapse";
    } catch (e) {}
    try {
      if (typeof m.SetHasClass === "function") m.SetHasClass("BBTMenuOpen", menuOpen);
      else if (menuOpen && m.AddClass) m.AddClass("BBTMenuOpen");
      else if (!menuOpen && m.RemoveClass) m.RemoveClass("BBTMenuOpen");
    } catch (e) {}
  }

  function toggleMenu() {
    setMenuOpen(!menuOpen);
  }
  G.BBTToggleMenu = toggleMenu;

  function setLanguageMode(next) {
    if (next !== "zh" && next !== "orig" && next !== "both") return;
    mode = next;
    settingsSet(MODE_KEY, mode);
    // Everything on screen has to be re-evaluated in the new mode.
    try {
      var ctx = pageRoot();
      if (ctx) resetMemos(ctx);
    } catch (e) {}
    uiSetLabel(mode === "zh" ? "显示:中文" : mode === "orig" ? "显示:原文" : "显示:中英对照");
    setMenuOpen(false);
    $.Msg("[BBT] language mode -> " + mode);
  }
  G.BBTSetLanguageMode = setLanguageMode;

  function resetMemos(root) {
    var stack = [root];
    var budget = 5000;
    while (stack.length && budget > 0) {
      budget -= 1;
      var p = stack.pop();
      if (!p) continue;
      var rec = memo.get(p);
      if (rec && rec.k >= 1 && rec.in) {
        // Put the source text back so the next scan re-evaluates it under the new
        // mode. Token-bound labels get their #token back (the engine re-resolves).
        var cur = null;
        try { cur = p.text; } catch (e) { cur = null; }
        if (cur !== null && cur !== rec.in) {
          // Always restore the source text we translated: that is what "original"
          // means, and the token table is only a heuristic for engine labels.
          try { p.text = rec.in; } catch (e) {}
        }
      }
      memo.delete(p);
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch (e) { n = 0; }
      for (var i = 0; i < n; i += 1) {
        try {
          var c = p.GetChild(i);
          if (c) stack.push(c);
        } catch (e) {}
      }
    }
  }

  // Manual refresh: re-resolve every engine label (build name/description,
  // category headers) and translate the value for the build that is on screen.
  // It deliberately does NOT reset the memos: that restored the old source text
  // right after the #token had been re-applied, so the label was re-translated
  // from the previous build's English and the overview never changed.
  function refreshPage() {
    var n = 0;
    try { n = resyncAll(80); } catch (e) { n = -1; }
    $.Msg("[BBT] refresh: re-resolved " + n + " engine label(s) (see resync-ok/resync-fail)");
    uiSetLabel("刷新中…");
    $.Schedule(1.0, function () { uiSetLabel("翻译本页"); });
  }
  G.BBTRefreshPage = refreshPage;

  // The main button: "translate everything on this page that we do not know yet".
  function translatePage() {
    if (ui.busy) return;
    var root = pageRoot();
    var texts = collectMisses(24, root);
    if (!texts.length) {
      uiSetLabel("没有需要翻译的文本");
      $.Schedule(2.0, function () { uiSetLabel("翻译本页"); });
      return;
    }
    if (live.state !== "on") {
      // Offline: re-run the memory/glossary pass over the whole page so the
      // button visibly does something even without the bridge.
      var before = stats.translated + stats.fallback;
      try { if (root) resetMemos(root); } catch (e) {}
      uiSetLabel("重新翻译中…");
      $.Schedule(0.5, function () {
        var done = stats.translated + stats.fallback - before;
        uiSetLabel("离线已重译 " + (done > 0 ? done + " 条" : "整页文本"));
      });
      $.Schedule(3.5, function () { uiSetLabel("翻译本页"); });
      return;
    }
    ui.busy = true;
    uiSetLabel("翻译中… " + texts.length);
    uiRequestBatch(texts, function (results, err) {
      ui.busy = false;
      var applied = results ? uiApplyResults(results) : 0;
      if (err) {
        uiSetLabel("翻译失败: " + err);
      } else {
        uiSetLabel("已翻译 " + applied + " 条");
        // New translations may unlock panels we had memoised as "nothing found".
        try { liveUpgradeWeakWrites(); } catch (e) {}
      }
      $.Schedule(4.0, function () { uiSetLabel("翻译本页"); });
    });
  }
  G.BBTTranslatePage = translatePage;

  function setTargetLang(lang) {
    if (!lang || typeof lang !== "string") return;
    TARGET_LANG = lang;
    settingsSet(LANG_KEY, TARGET_LANG);
    overrides = null;
    try { var r = pageRoot(); if (r) resetMemos(r); } catch (e) {}
    // Non-Chinese targets come from the local table / bridge only.
    if (LIVE_TARGET && LIVE_TARGET.tag === "BBT") {
      try { liveFetchOverrides(); } catch (e) {}
    }
    uiSetLabel("语言:" + TARGET_LANG);
    setMenuOpen(false);
    $.Msg("[BBT] target language -> " + TARGET_LANG);
  }
  G.BBTSetTargetLang = setTargetLang;

  // Dropdown: push what is on screen into the local table (NO network call).
  // It sends the pairs it already has, so this works even when the bridge cannot
  // reach a provider.
  function savePageToTable() {
    if (live.state !== "on" || !LIVE_TARGET || LIVE_TARGET.tag !== "BBT") {
      uiSetLabel("本地库需要本仓库的 bridge");
      $.Schedule(2.5, function () { uiSetLabel("翻译本页"); });
      return;
    }
    var pairs = [];
    try {
      var ctx = pageRoot();
      if (!ctx) ctx = $.GetContextPanel();
      var stack = [ctx];
      var budget = 3000;
      while (stack.length && budget > 0) {
        budget -= 1;
        var p = stack.pop();
        if (!p) continue;
        if (!panelVisible(p)) continue;
        var rec = memo.get(p);
        if (rec && rec.k === 1 && rec.in) {
          var cur = null;
          try { cur = p.text; } catch (e) { cur = null; }
          if (cur && cur !== rec.in) {
            // In "both" mode the label shows translation + original: keep only
            // the translation part.
            var tr = cur;
            if (mode === "both") {
              var nl = cur.indexOf("\n");
              if (nl > 0) tr = cur.slice(0, nl);
            }
            pairs.push({ text: rec.in, translation: tr });
          }
        }
        var n = 0;
        try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch (e) { n = 0; }
        for (var i = 0; i < n; i += 1) {
          try {
            var c = p.GetChild(i);
            if (c) stack.push(c);
          } catch (e) {}
        }
      }
    } catch (e) {}
    if (!pairs.length) {
      uiSetLabel("本页没有可存的译文");
      $.Schedule(2.5, function () { uiSetLabel("翻译本页"); });
      return;
    }
    liveSend(
      { kind: "remember", pairs: pairs, target: TARGET_LANG },
      LIVE_REQUEST_TIMEOUT,
      function (ok, err, res) {
        if (ok && res) {
          uiSetLabel("已存入本地库:新增 " + (res.added || 0) + " 条");
          stats.batchAdded += res.added || 0;
          noteTableSize(res.table);
        } else {
          uiSetLabel("存入失败: " + err);
        }
        $.Schedule(3.0, function () { uiSetLabel("翻译本页"); });
      },
      LIVE_TARGET,
    );
  }
  G.BBTSavePageToTable = savePageToTable;

  function showTableStats() {
    var provider = stats.liveProvider ? (" / provider=" + stats.liveProvider) : "";
    uiSetLabel(
      "条目 " + (stats.tableEntries || 0) + " · 别名 " + (stats.tableAliases || 0) +
        " · 本次实时 " + stats.live + provider,
    );
    $.Schedule(4.0, function () { uiSetLabel("翻译本页"); });
  }
  G.BBTShowTableStats = showTableStats;

  function boot() {
    buildTermRegex();
    var saved = settingsGet(MODE_KEY, "zh");
    if (saved === "zh" || saved === "orig" || saved === "both") mode = saved;
    var savedLang = settingsGet(LANG_KEY, "zh-Hans");
    if (savedLang) TARGET_LANG = savedLang;
    // bba_tm.js publishes the entry count; counting 58k keys at boot would stall
    // the UI for tens of milliseconds on every layout instance.
    var tmCount = G.BBA_TM_COUNT || 0;
    var layoutTag = "";
    var ctx = null;
    try {
      ctx = $.GetContextPanel();
      if (ctx && ctx.tag) layoutTag = String(ctx.tag);
      if (!layoutTag && ctx && ctx.paneltype) layoutTag = String(ctx.paneltype);
    } catch (e) {}
    // The build-details layout is reused as a hover tooltip (hittest=false).
    // A toolbar there can never be clicked, it would only sit on top of the
    // tooltip, so hide it.
    try {
      var up = ctx;
      for (var d = 0; up && d < 10; d += 1) {
        var upt = "";
        try { upt = String(up.paneltype || ""); } catch (e) { upt = ""; }
        var upc = "";
        try {
          if (up.classList && typeof up.classList.contains === "function" &&
              up.classList.contains("BuildDetailsTooltip")) upc = "BuildDetailsTooltip";
          if (!upc) upc = String(up.class || "");
        } catch (e) { upc = ""; }
        if (upt.indexOf("TooltipBuildDetails") >= 0 || upc.indexOf("BuildDetailsTooltip") >= 0) {
          var tc = uiPanel("BBTControls2");
          if (tc && tc.style) tc.style.visibility = "collapse";
          var tm = uiPanel("BBTMenu2");
          if (tm && tm.style) tm.style.visibility = "collapse";
          break;
        }
        try { up = up.GetParent ? up.GetParent() : null; } catch (e) { up = null; }
      }
    } catch (e) {}
    // The tag tells you WHICH layout actually carries the scanner; use it with
    // -condebug to check that every layout surface that shows player text is
    // really covered (e.g. a game update may spawn a new out-of-tree layout).
    $.Msg("[BBT] v" + VERSION + " loaded (tm=" + tmCount + ", glossary=" + (GLOSS ? 1 : 0) + ") in layout: " + (layoutTag || "?") + "");
    $.Schedule(0.05, tick);
    // Probe the optional bridge a moment later so it never delays first paint.
    if (liveMode() !== "off") $.Schedule(1.2, liveProbe);
    // The toolbar lives in the browser/details layouts; retry while the engine is
    // still creating panels. Placement is measured from the 出装选项 button, so it
    // needs a few attempts until the header has been laid out (sizes are 0 before
    // the first layout pass).
    var wireTries = 0;
    (function wire() {
      try { wireToolbar(); } catch (e) {}
      try { placeToolbar(); } catch (e) {}
      wireTries += 1;
      if (wireTries < 12 && (!uiWiredOnce || wireTries < 8)) $.Schedule(0.5, wire);
    })();
  }

  G.BBT_STATS = stats;
  G.BBT_VERSION = VERSION;
  boot();
})();
