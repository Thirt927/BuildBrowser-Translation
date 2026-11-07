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

  var VERSION = "1.9.46";
  // Debug logging is a runtime switch: set `BBT_DEBUG = true` in the game
  // console (`-condebug`) to see every write without rebuilding the VPK.
  var DEBUG = true;
  function debugOn() {
    return DEBUG || !!G.BBT_DEBUG;
  }
  var POLL_INTERVAL = 0.15; // seconds between scans while something changes
  var FAST_INTERVAL = 0.08; // burst poll right after new content appears
  var BURST_TICKS = 4; // how many fast polls after a change
  var IDLE_MAX_INTERVAL = 1.0; // back off to this when the tree is quiet
  var PARKED_INTERVAL = 0.5; // layout not visible (shop closed, browser closed)
  var IDLE_TICKS_BEFORE_BACKOFF = 6;
  var SCAN_BUDGET = 2000; // panels visited per tick (T6 chunking: the walk is a
                          // persistent carry — a budget-capped tick resumes where it
                          // stopped instead of dropping 6000 unvisited panels and
                          // restarting the whole tree one tick later)
  var TERM_FALLBACK_MAX = 160; // only short labels get glossary substitution
  // Glossary substitution is only written when it actually produced a Chinese
  // sentence: below this CJK share (or when a run of English words survives) the
  // "translation" is a mid-sentence mix that reads worse than the original, so
  // we keep the English and count it as missing instead.
  var TERM_FALLBACK_MIN_RATIO = 0.55; // CJK share of the result, must reach this
  var TERM_FALLBACK_MAX_EN_WORDS = 4; // ...or <= this many consecutive English words
  // Unseen English text is logged as "[BBT] MISS <key> <text>" so
  // tools/collect_new_texts.js can harvest it and grow the translation memory.
  var COLLECT_MISSES = true;
  var MISS_CAP = 300; // per layout instance and session

  // ---- optional live bridge (see the header) ----
  // AUTO: probe once at boot; if nothing answers, this channel stays off for the
  // session and the mod behaves exactly like a pure offline build.
  // Runtime override: set `BBT_LIVE = "off"` (or "on") in the game console.
  var LIVE_MODE_DEFAULT = "auto"; // "auto" | "off" | "on"
  // v1.9.29 (user 11/07): "先不要用离线翻译容易误导我，就把用桥翻译做好再加离线翻译".
  // The shipped memory answers a lot of the page, so when the bridge is down the
  // result looks half-translated and there is no way to tell which half came from
  // where. Bridge-first is now the default: the memory / fragment / glossary
  // paths stay in the code but are OFF until BBT_TM="on" (runtime switch, no
  // repack). Overrides still apply - they are explicit local corrections.
  var OFFLINE_MODE_DEFAULT = "off"; // "off" | "on"
  // G is assigned further down, so the override is read at call time.
  function offlineOn() {
    var m = null;
    try { m = G.BBT_TM; } catch{ m = null; }
    if (m === "on" || m === "auto" || m === true) return true;
    if (m === "off" || m === false) return false;
    return OFFLINE_MODE_DEFAULT === "on";
  }
  // One id per layout: the details layout is instantiated *inside* the selector,
  // so reusing a single id would put two panels with the same id in one tree.
  var LIVE_PANEL_IDS = ["BBTBridgePanel", "BBTBridgePanelDetails", "BBTBridgePanelShop", "BBTBridgePanelCategory"];
  // Try an already running Babel Tower bridge first (DeadlockLingua, port 8792):
  // it serves a page with the same technique and the same certificate, so people
  // who already use that mod need neither a second certificate nor a second
  // process. Our own bridge listens on 8793.
  var LIVE_TARGETS = [
    { port: 8792, tag: "LCT", name: "BabelTower" },
    { port: 8793, tag: "BBT", name: "bbt-bridge" },
  ];
  var LIVE_TARGET = null; // { port, tag, name } once the probe succeeded
  var LIVE_PROBE_TIMEOUT = 4.0; // seconds to wait for the health answer (v1.9.21: page load + API round trip)
  var LIVE_REQUEST_TIMEOUT = 6.0; // seconds per translation request
  var LIVE_POLL = 0.1; // title poll interval
  var LIVE_HARD_FAILS_MAX = 3; // give up after this many dead round trips
  var LIVE_TEXT_MAX = 1800; // per-text cap (v1.9.33: was 700, which dropped
  // the author overview - three paragraphs of build notes ran past it and the
  // label was skipped without a word)
  var LIVE_BATCH_CHARS = 2500; // total source characters per batch request
  var LIVE_CACHE_MAX = 600; // session-only memory of live translations

  function realGlobal() {
    // v1.9.34: the eval fallback is gone. It was the only way to reach the
    // global object on builds without globalThis, but this engine has it (the
    // BabelTower/BBA_* handshake and the mod's own shared two-state store both
    // go through it in game), and a dynamic-code call in a mod that ships to
    // players is not worth keeping for a build nobody runs.
    try { if (typeof globalThis !== "undefined" && globalThis) return globalThis; } catch{}
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
    } catch{}
    return fallback;
  }

  function settingsSet(key, value) {
    try {
      if ($.PersistentStorage && typeof $.PersistentStorage.SetString === "function") {
        $.PersistentStorage.SetString(key, value);
      }
    } catch{}
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
    if (!offlineOn()) return null;
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

  var ui = { busy: false, busySince: 0, lastResult: "", batch: [] };

  // Depth-first scan bounded by `root`. Every lookup in this file goes through
  // here: the build browser, the spec page nested inside it and the hover tooltip
  // all run a copy of this script, so "search from whatever panel is handy" can
  // land in the wrong instance and make a button look dead (v1.9.7 bug).
  function uiPanelIn(root, ids) {
    var list = typeof ids === "string" ? [ids] : ids;
    if (!root || !list || !list.length) return null;
    var stack = [root];
    var budget = 4000;
    while (stack.length && budget > 0) {
      budget -= 1;
      var p = stack.pop();
      if (!p) continue;
      try {
        for (var k = 0; k < list.length; k += 1) {
          if (p.id === list[k]) return p;
        }
      } catch{}
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch{ n = 0; }
      for (var i = 0; i < n; i += 1) {
        try {
          var c = p.GetChild(i);
          if (c) stack.push(c);
        } catch{}
      }
    }
    return null;
  }

  function contextPanel() {
    try { return $.GetContextPanel() || null; } catch{ return null; }
  }

  function uiPanel(ids) {
    return uiPanelIn(contextPanel(), ids);
  }

  // The XML handlers are resolved once, in the global scope, so the panel that
  // was clicked is the only reliable pointer to "which instance did the user
  // hit". From it we walk up to that instance's layout root.
  // The engine reports the layout name on `panel.tag` (boot() logs it that way
  // and it works in-game); `panel.paneltype` is only populated on a subset of
  // panels, so it is an unreliable fallback. Read tag first, paneltype second.
  function panelTag(p) {
    try { return String(p.tag || p.paneltype || ""); } catch{ return ""; }
  }

  function layoutRoot(panel) {
    var cur = panel;
    var top = panel;
    for (var i = 0; cur && i < 40; i += 1) {
      var pt = panelTag(cur);
      if (isLayoutRootTag(pt)) return cur;
      top = cur;
      var up = null;
      try { up = cur.GetParent ? cur.GetParent() : null; } catch{ up = null; }
      if (!up) break;
      cur = up;
    }
    return top;
  }

  // The layouts this mod injects into. A category frame boots with its own
  // context panel but lives INSIDE the shop layout, so both tags count as a
  // layout root; walking past them lands in the shared HUD tree, where a panel
  // search has thousands of irrelevant nodes in front of ours (v1.9.29).
  function isLayoutRootTag(tag) {
    return tag === "CitadelBuildDetails" || tag === "CitadelHeroBuildsSelector" ||
      tag === "CitadelShopModsBuild" || tag === "CitadelShopModsBuildCategory";
  }

  function rootOf(origin) {
    if (origin && typeof origin.GetChildCount === "function") return layoutRoot(origin);
    var ctx = contextPanel();
    return ctx ? layoutRoot(ctx) : null;
  }

  // Wide enough root for page-wide work: the build browser owns the whole page,
  // the spec/details instance is nested inside it. pageRoot() below walks up to
  // the same kind of panel directly from the clicked control.

  // Short, log-safe name of an instance ("browser<CitadelBuildDetails"): one
  // console line is then enough to tell the visible page from the tooltip copy.
  function instTag(root) {
    if (!root) return "?";
    var bits = [];
    var p = root;
    for (var i = 0; p && i < 3; i += 1) {
      var s = "";
      try { s = String(p.id || "") || String(p.paneltype || "") || "?"; } catch{ s = "?"; }
      bits.push(s);
      try { p = p.GetParent ? p.GetParent() : null; } catch{ p = null; }
    }
    return bits.join("<");
  }

  // Write the status text onto a panel inside `root` (default: our own instance).
  function uiSetText(ids, text, root) {
    var scope = root || contextPanel();
    var p = uiPanelIn(scope, ids);
    if (!p) return false;
    try {
      p.text = text;
      return true;
    } catch{
      return false;
    }
  }

  // Names of layout handlers that failed to export (normally empty). Kept so the
  // status line can carry the warning forever: a later "接线 13 项" write would
  // otherwise hide the one message that explains "button is not defined".
  var handlerMissingNames = [];

  // The one-line, always-visible state readout in the toolbar (see the layout).
  // The user cannot open the game console, so this is how "did my click arrive?"
  // gets answered without a log.
  function uiSetStatus(text, root) {
    var t = String(text == null ? "" : text);
    if (handlerMissingNames.length && t.indexOf("缺少:") < 0) {
      t += " ·缺:" + handlerMissingNames.join(",");
    }
    uiSetText(["BBTStatusLabel2", "BBTStatusLabel"], t, root);
  }

  function uiSetRefreshText(text, root) {
    // v1.9.15 folded the dedicated refresh button into the dropdown; feedback
    // lands on the trigger (the only always-visible control) via uiSetLabel.
    return uiSetText(["BBTTranslateButton2", "BBTTranslateButton"], text, root);
  }

  // The trigger's caption is the persistent readout (翻译 / 原文 / 中英对照).
  // The browser trigger is #BBTTranslateButton2; the in-game header button is
  // #BBTTranslateButton3 (the only control in that layout).
  function uiSetModeText(text, root) {
    return uiSetText(["BBTTranslateButton2", "BBTTranslateButton", "BBTTranslateButton3"], text, root);
  }

  function uiSetLabel(text, root, ttlSec) {
    var scope = root || null;
    // v1.9.29: every progress/feedback caption gets a deadline. The bridge probe
    // can hang without ever calling back (a destroyed context stops its
    // $.Schedule chain), and the old code then left "正在连接桥…" on the button
    // forever - the user's "连接桥这几个字会一直保留而不是变成原文" report. The
    // tick loop enforces the deadline, so the resting caption always comes back
    // even when no callback ever runs.
    ui.captionDeadline = (nowMs() || 0) + (typeof ttlSec === "number" ? ttlSec : 4.0) * 1000;
    var scope = root || null;
    var l = uiPanelIn(scope || contextPanel(), ["BBTTranslateLabel", "BBTTranslateLabel2"]);
    if (l) {
      try { l.text = text; } catch{}
    } else {
      // The toolbar uses the game's TextButton (native look), whose text lives on
      // the button itself instead of in a child label. The in-game build page's
      // header button (#BBTTranslateButton3) is the only control there, so it
      // carries the progress too - otherwise pressing it looks like nothing
      // happened at all (no status label and no toolbar in that layout).
      var b = uiPanelIn(scope || contextPanel(), ["BBTTranslateButton2", "BBTTranslateButton"]);
      if (!b) b = uiPanelIn(scope || contextPanel(), "BBTTranslateButton3");
      if (b) {
        try { b.text = text; } catch{}
      }
    }
    ui.lastResult = text;
  }

  // Restore the trigger's caption. Progress feedback ("已译 N 条") overwrites it
  // while an action runs; this puts the correct resting caption back. v1.9.26:
  // the caption names the NEXT action from the SHARED two-state mode - "原文"
  // while the page is translated, "翻译" while it shows the original. The
  // in-game header button (#BBTTranslateButton3) and the browser toolbar
  // button both resolve through uiSetModeText's id list.
  function uiResetLabel(root) {
    ui.captionDeadline = 0;
    var b = null;
    try { b = uiPanelIn(root || contextPanel(), ["BBTTranslateButton2", "BBTTranslateButton"]); } catch{ b = null; }
    var key = "";
    try { key = tsKeyOf(b || root || contextPanel()); } catch{ key = ""; }
    uiSetModeText(key && tsMode(key) === "zh" ? "原文" : "翻译", root);
  }

  // The widest panel the toolbar button should act on. Several layout instances
  // run this script (selector, details, tooltips) and all of them share the same
  // global handlers; resolving the root from the button itself keeps "翻译"
  // pointing at the whole page instead of whichever layout booted last.
  function pageRoot(origin) {
    // A clicked panel (the XML handlers pass one) names its instance directly;
    // that is always more trustworthy than "the first button we can find".
    if (origin && typeof origin.GetChildCount === "function") {
      // Nearest page-ish ancestor: the browser selector, a details pane, or the
      // standalone in-game build page behind #ControlButtons. Snapping to the
      // HUD root (which is what layoutRoot() returns in game) would start the
      // scan far above the page and burn its budget before reaching it, so the
      // header button would report "nothing to translate".
      var q = origin;
      for (var j = 0; q && j < 20; j += 1) {
        var qt = panelTag(q);
        if (qt === "CitadelHeroBuildsSelector" || qt === "CitadelBuildDetails" || qt === "CitadelShopModsBuild") return q;
        try { q = q.GetParent ? q.GetParent() : null; } catch{ q = null; }
      }
      return layoutRoot(origin) || origin;
    }
    var p = uiPanel(["BBTTranslateButton2", "BBTTranslateButton", "BBTTranslateLabel2", "BBTTranslateLabel"]);
    var details = null;
    for (var i = 0; p && i < 12; i += 1) {
      var pt = panelTag(p);
      if (pt === "CitadelHeroBuildsSelector") return p; // the whole browser
      if (pt === "CitadelBuildDetails" && !details) details = p;
      try { p = p.GetParent ? p.GetParent() : null; } catch{ p = null; }
    }
    if (details) return details;
    try { return $.GetContextPanel(); } catch{}
    return null;
  }

  // Collect the texts on screen that neither the shipped memory nor the session
  // cache knows. These are exactly the rows the button asks about.
  // `root` is passed by the toolbar handlers (see pageRoot): the button must act
  // on the whole build browser even when the script instance that happens to own
  // the last global handler belongs to a smaller layout (tooltip).
  function collectMisses(limit, root, counts) {
    if (!root) {
      try { root = $.GetContextPanel(); } catch{ return []; }
    }
    var out = [];
    var seen = Object.create(null);
    var stack = [root];
    var budget = 3000;
    var scanned = 0, already = 0;
    while (stack.length && budget > 0) {
      budget -= 1;
      var p = stack.pop();
      if (!p) continue;
      if (!panelVisible(p)) continue;
      var t = null;
      try { t = p.text; } catch{ t = null; }
      if (typeof t === "string" && t.length >= 3 && t.length <= LIVE_TEXT_MAX) {
        scanned += 1;
        if (t.indexOf("#") !== 0 && !HAS_CJK.test(t) && !seen[t]) {
          var rec = memo.get(p);
          var translatedAlready = rec && rec.k === 1 && rec.in === t;
          if (translatedAlready) {
            already += 1;
          } else if (!lookup(t) && !liveCacheGet(t) && !overrideFor(t)) {
            seen[t] = 1;
            out.push(t);
            if (limit && out.length >= limit) break;
          }
        }
      }
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch{ n = 0; }
      // Push children in reverse so the stack pops them in DOM order (first
      // card first). v1.9.23: the old forward push made the LAST recommended
      // build card collect before the earlier ones, so the text limit filled
      // up on that card's annotations and the previous cards were truncated
      // ("only the last card translates").
      for (var i = n; i > 0; i -= 1) {
        try {
          var c = p.GetChild(i - 1);
          if (c) stack.push(c);
        } catch{}
      }
    }
    if (counts) { counts.scanned = scanned; counts.already = already; }
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
            // v1.9.32: a per-text request must only ever claim the FIRST answer.
            // BabelTower's bridge answers with its own array, so reading got[k]
            // for a chunk we sent one text at a time attached the previous
            // text's translation to this one (observed in game: category name
            // "Laning Phase" rendered as the build name's translation).
            var take = batchable ? chunk.length : 1;
            if (!batchable && got.length > 1 && debugOn()) {
              try { $.Msg("[BBT] live: per-text answer carried " + got.length + " translations; taking the first"); } catch{}
            }
            for (var k = 0; k < take && k < chunk.length; k += 1) {
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
    try { root = $.GetContextPanel(); } catch{ return 0; }
    var applied = 0;
    var stack = [root];
    var budget = 3000;
    while (stack.length && budget > 0) {
      budget -= 1;
      var p = stack.pop();
      if (!p) continue;
      if (!panelVisible(p)) continue;
      var t = null;
      try { t = p.text; } catch{ t = null; }
      if (typeof t === "string") {
        var tr = results[t] || liveCacheGet(t);
        if (tr) {
          // v1.9.32: do not rewrite a label that already shows this translation
          // (the tick re-scans constantly; 23 identical writes per click showed
          // up in the log as flicker).
          var rec0 = memo.get(p);
          if (!(rec0 && rec0.k === 1 && rec0.in === t && rec0.out === present(t, tr))) {
            if (writeText(p, present(t, tr))) {
              applied += 1;
              remember(p, 1, t, present(t, tr));
            }
          }
        }
      }
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch{ n = 0; }
      for (var i = 0; i < n; i += 1) {
        try {
          var c = p.GetChild(i);
          if (c) stack.push(c);
        } catch{}
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
    settled: false, // last probe finished? (on-demand re-probes wait on this)
    settleListeners: [],
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
    resets: 0, // v1.9.29: self-heal navigations, capped (each one is a CEF reload)
    disarmed: false, // v1.9.29: given up in this context - stop navigating entirely
  };

  // v1.9.29 (lobby stutter): every SetURL is a full CEF navigation. A dead
  // endpoint that still accepts the connection, plus the "reset to about:blank"
  // self-heal, used to re-navigate the panel many times per second in EVERY
  // layout context (the shop, the browser, each category frame). That churn is
  // felt as heavy stutter in the lobby while the out-of-match shop is open, and
  // it buys nothing once the bridge has answered nothing at all. Disarming is
  // per context and reversible: a click on 翻译 re-probes (liveReprobe clears
  // the flag), so the user can still bring the channel back at will.
  function liveDisarm(reason) {
    if (live.disarmed) return;
    live.disarmed = true;
    live.state = "off";
    live.pending = null;
    var p = null;
    try { p = livePanel(); } catch{ p = null; }
    if (p && typeof p.SetURL === "function") { try { p.SetURL("about:blank"); } catch{} }
    $.Msg("[BBT] live channel disarmed (" + reason + "); panel parked, no further navigation from this context");
  }

  function liveRoot() {
    var ctx = null;
    try { ctx = $.GetContextPanel(); } catch{ return null; }
    // The <HTML> panel is declared in the layout; find it by id once.
    //
    // v1.9.29 fix (the real reason the bridge never connected): the old walk was
    // DOWN-ONLY from $.GetContextPanel(). Our script also boots inside nested
    // layouts (CitadelShopModsBuildCategory, BuildDetails_Overview, the embedded
    // HeroBuildSelector) whose context panel is a deep node - the layout's
    // <HTML> panel is a SIBLING of that subtree, near the layout root, so a
    // downward BFS can never reach it. That is the `panel_unavailable` we logged
    // from every shop context on 11/07 14:02:53. Walk up to the layout root
    // first (checking each ancestor), then search downward from there.
    var top = ctx;
    for (var up = 0; up < 48; up += 1) {
      if (top.id && LIVE_PANEL_IDS.indexOf(String(top.id)) >= 0) {
        registerBridgePanel(top);
        return top;
      }
      // Stop at the layout root, NOT at the global HUD root: the shop tree has
      // thousands of panels, so a search from the top of the game UI burns out
      // before it ever reaches our layout (that was the 14:39:16 in-game
      // `panel_unavailable`, logged from 8 category contexts).
      if (isLayoutRootTag(panelTag(top))) break;
      var parent = null;
      try { parent = top.GetParent ? top.GetParent() : null; } catch{ parent = null; }
      if (!parent) break;
      top = parent;
    }
    if (top.id && LIVE_PANEL_IDS.indexOf(String(top.id)) >= 0) {
      registerBridgePanel(top);
      return top;
    }
    var stack = [top];
    var budget = 40000; // one layout, not the whole UI: this is enough and cheap
    while (stack.length && budget > 0) {
      budget -= 1;
      var p = stack.pop();
      if (!p) continue;
      try {
        if (p.id && LIVE_PANEL_IDS.indexOf(String(p.id)) >= 0) {
          registerBridgePanel(p);
          return p;
        }
      } catch{}
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch{ n = 0; }
      for (var i = 0; i < n; i += 1) {
        try {
          var c = p.GetChild(i);
          if (c) stack.push(c);
        } catch{}
      }
    }
    return null;
  }

  // v1.9.24: cross-context registry. Only some layouts declare the <HTML>
  // bridge panel (the shop-category layout does NOT), and a context without
  // one cannot reach another layout's panel tree. Register every panel we
  // find so any context can reuse it.
  function registerBridgePanel(p) {
    try {
      var reg = G.__BBT_BRIDGE_PANELS;
      if (!reg) { reg = G.__BBT_BRIDGE_PANELS = []; }
      for (var i = 0; i < reg.length; i += 1) { if (reg[i] === p) return; }
      reg.push(p);
      if (reg.length > 8) reg.shift();
    } catch{}
  }

  function liveRegistryPanel() {
    try {
      var reg = G.__BBT_BRIDGE_PANELS;
      if (!reg) return null;
      for (var i = reg.length; i > 0; i -= 1) {
        var p = reg[i - 1];
        if (p && p.IsValid && p.IsValid()) return p;
      }
    } catch{}
    return null;
  }

  // v1.9.29: a WebView is only created for an <HTML> panel that really gets
  // laid out. Closed shop frames / a hidden tooltip report width=height=0, so
  // "pick the first panel that exists" silently parked the channel on a dead
  // panel (in-game 17:39: 152 x `live probe deferred ... actuallayoutwidth=0`
  // with the shop open). Rank candidates by laid-out area instead.
  function panelArea(p) {
    if (!p) return 0;
    var w = 0;
    var h = 0;
    try { w = p.actuallayoutwidth || 0; } catch{}
    try { h = p.actuallayoutheight || 0; } catch{}
    return (w > 0 && h > 0) ? w * h : 0;
  }

  function livePanel() {
    var cache = live.panel;
    try {
      if (cache && cache.IsValid && cache.IsValid() && panelArea(cache) > 0) return cache;
    } catch{}
    var best = null;
    var bestArea = 0;
    try {
      var reg = G.__BBT_BRIDGE_PANELS;
      for (var i = 0; reg && i < reg.length; i += 1) {
        var rp = reg[i];
        var ok = false;
        try { ok = !!(rp && rp.IsValid && rp.IsValid()); } catch{ ok = false; }
        if (!ok) continue;
        var ra = panelArea(rp);
        if (ra > bestArea) { bestArea = ra; best = rp; }
      }
    } catch{}
    if (best) { live.panel = best; return best; }
    var found = null;
    try { found = liveRoot(); } catch{ found = null; }
    if (found) { live.panel = found; return found; }
    live.panel = liveRegistryPanel();
    return live.panel;
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
    // Parked for good in this context (see liveDisarm): never navigate again.
    if (live.disarmed) {
      cb(false, "disarmed", null);
      return null;
    }
    var panel = livePanel();
    var tj = target || LIVE_TARGET;
    liveBindEvents();
    if (!panel || typeof panel.SetURL !== "function") {
      if (debugOn()) $.Msg("[BBT] live probe: panel unavailable on " + (tj ? tj.port : "?") + " (no HTML panel found from this context)");
      cb(false, "panel_unavailable", null);
      return null;
    }
    // Distinguish "no panel in this layout" from "panel exists but is not being
    // rendered" (closed shop surface): the second one silently produces an empty
    // title for 4s, which is indistinguishable from a dead bridge in the log.
    // Log-only: actuallayoutwidth can read 0 in cases we have not mapped yet, and
    // refusing to navigate on a guess would break a working channel.
    try {
      if (debugOn() && !(Number(panel.actuallayoutwidth) > 0)) {
        $.Msg("[BBT] live probe: panel reports actuallayoutwidth=0 on " + (tj ? tj.port : "?") + " (surface closed? still navigating)");
      }
    } catch{}
    if (!tj) {
      cb(false, "no_target", null);
      return null;
    }
    var id = "r" + (++live.seq).toString(36);
    var job = {
      id: id,
      tag: tj.tag,
      port: tj.port,
      url: liveRequestUrl(tj, id, req),
      panel: panel, // v1.9.29: poll the panel we navigated, not "whichever is
                    // first in the registry" - with several bridge panels the
                    // trace showed the request leaving one panel while the poll
                    // read another one's (always empty) title.
      cb: cb,
      startedAt: 0,
      polls: 0,
      maxPolls: Math.ceil((timeoutSec || LIVE_REQUEST_TIMEOUT) / LIVE_POLL),
      done: false,
    };
    live.pending = job;
    try {
      panel.SetURL(job.url);
    } catch (e){
      live.pending = null;
      if (debugOn()) $.Msg("[BBT] live probe: SetURL failed on " + tj.port + " (" + e + ")");
      cb(false, "seturl_failed", null);
      return null;
    }
    $.Schedule(LIVE_POLL, function () { livePoll(job); });
    return job;
  }

  // document.title carries "BBT<id>{json}" once the page has the answer.
  // The engine may expose the page title only through the attribute or the
  // method getter (the BabelTower fork's in-game-verified reader tries all
  // three) - .title alone can stay "" forever, which is exactly the
  // v1.9.19-21 "bridge unavailable" symptom even with a live bridge +
  // trusted cert.
  function liveTitleOf(panel) {
    try { if (typeof panel.title === "string" && panel.title) return panel.title; } catch{}
    try { var a = panel.GetAttributeString ? panel.GetAttributeString("title", "") : ""; if (a) return a; } catch{}
    try { if (typeof panel.GetTitle === "function") { var t = panel.GetTitle(); if (t) return String(t); } } catch{}
    return "";
  }

  // v1.9.29 fallback channel: if the engine never surfaces the page title, the
  // panel's own src attribute is the next thing it must remember (it is what
  // SetURL writes). The bridge page can put its answer in the URL instead
  // (`/done?d=<payload>`), so "can we read src back?" decides whether that
  // channel is available at all.
  function liveSrcOf(panel) {
    var keys = ["src", "url", "href"];
    for (var i = 0; i < keys.length; i++) {
      try {
        var v = panel.GetAttributeString ? panel.GetAttributeString(keys[i], "") : "";
        if (v) return String(v);
      } catch{}
    }
    return "";
  }

  // v1.9.29 (18:24 in-game): the engine does NOT surface the page title as a
  // property on these panels - .title, GetAttributeString("title") and the src
  // attribute all read "" while the page is demonstrably running (the bridge
  // logged the page's own /api/v1/health fetches). BabelTower's in-game reader
  // gets the title through a *panel event* (`HTMLChangedTitle` etc. registered
  // with $.RegisterForUnhandledEvent); its .title polling is only a fallback.
  // That event is the missing channel here.
  var LIVE_EVENT_NAMES = [
    "HTMLChangedTitle", "HTMLTitle", "HTMLContentLoaded",
    "HTMLURLChanged", "HTMLLoadPage", "HTMLStartRequest", "HTMLFinishRequest"
  ];
  var liveEventsBound = false;

  function liveEventText(arg) {
    if (arg == null) return "";
    try { if (typeof arg === "string") return arg; } catch{}
    try { if (typeof arg.title === "string" && arg.title) return arg.title; } catch{}
    try { if (typeof arg.text === "string" && arg.text) return arg.text; } catch{}
    try { if (typeof arg.url === "string" && arg.url) return arg.url; } catch{}
    try {
      if (typeof arg.GetAttributeString === "function") {
        return String(arg.GetAttributeString("title", "") || arg.GetAttributeString("url", "") || "");
      }
    } catch{}
    return "";
  }

  // Returns true when the text carried this job's answer (payload handled).
  function liveAccept(job, title) {
    if (!job || job.done || !title) return false;
    var prefix = (job.tag || "BBT") + job.id;
    if (title.indexOf(prefix) !== 0) return false;
    var payload = null;
    try { payload = JSON.parse(title.slice(prefix.length)); } catch{ payload = null; }
    if (!payload) return false;
    if (payload.translation && !payload.translations) {
      // BabelTower answers with a single {translation}; normalise it.
      payload = { ok: payload.ok !== false, translations: [String(payload.translation)] };
    }
    job.done = true;
    live.pending = null;
    job.cb(true, null, payload);
    return true;
  }

  function liveOnEvent(a, b, c, d) {
    try {
      var job = live.pending;
      if (!job) return;
      var args = [a, b, c, d];
      for (var i = 0; i < args.length; i++) {
        var t = liveEventText(args[i]);
        if (!t) continue;
        if (liveAccept(job, t)) return;
      }
    } catch (eEv){ try { if (debugOn()) $.Msg("[BBT] live event handler error: " + eEv); } catch{} }
  }

  function liveBindEvents() {
    if (liveEventsBound) return;
    liveEventsBound = true;
    if (!$.RegisterForUnhandledEvent) return;
    var n = 0;
    for (var i = 0; i < LIVE_EVENT_NAMES.length; i++) {
      try { $.RegisterForUnhandledEvent(LIVE_EVENT_NAMES[i], liveOnEvent); n += 1; } catch{}
    }
    if (debugOn()) { try { $.Msg("[BBT] live events registered: " + n + "/" + LIVE_EVENT_NAMES.length); } catch{} }
  }

  function livePoll(job) {
    if (!live.pending || live.pending !== job || job.done) return;
    var panel = job.panel || null;
    if (panel) {
      var still = true;
      try { still = !!(panel.IsValid && panel.IsValid()); } catch{ still = true; }
      if (!still) panel = null;
    }
    if (!panel) panel = livePanel();
    var title = "";
    try { title = liveTitleOf(panel); } catch{ title = ""; }
    var prefix = (job.tag || "BBT") + job.id;
    if (title && title.indexOf(prefix) === 0) {
      var payload = null;
      try { payload = JSON.parse(title.slice(prefix.length)); } catch{ payload = null; }
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
      if (debugOn()) {
        // v1.9.21 decisive diagnostic: which title did the page actually
        // carry when we gave up? "(no panel)"/"" = page never loaded
        // (cert/HTTPS issue or panel missing); a non-matching title =
        // protocol skew.
        var lastTitle = "(no panel)";
        try {
          var lp = livePanel();
          if (lp) {
            lastTitle = liveTitleOf(lp).slice(0, 80);
            if (!lastTitle) lastTitle = "(empty title)";
            // Can the panel remember what it navigated to? If yes, the bridge
            // page can answer through the URL instead of document.title.
            var srcNow = "";
            try { srcNow = String(liveSrcOf(lp) || "").slice(0, 120); } catch{ srcNow = ""; }
            lastTitle += " src=" + JSON.stringify(srcNow) + " want=" + JSON.stringify(String(job.url || "").slice(0, 120));
          }
        } catch{}
        $.Msg("[BBT] live probe timeout on " + (job.tag || "") + " " + job.id + ": polls=" + job.polls + " lastTitle=" + JSON.stringify(lastTitle));
        // v1.9.29 (empty title on every surface, 17:16:43): an <HTML> panel that
        // is not laid out never renders, so the page never runs and the title can
        // never arrive. Report the panel's own geometry so that case is not
        // confused with a certificate problem.
        try {
          var dp = livePanel();
          if (dp) {
            $.Msg("[BBT] live panel geometry: id=" + dp.id +
              " visible=" + (dp.BIsVisible ? dp.BIsVisible() : "?") +
              " w=" + dp.actuallayoutwidth + " h=" + dp.actuallayoutheight +
              " x=" + dp.actualxoffset + " y=" + dp.actualyoffset +
              " parent=" + panelTag(dp.GetParent ? dp.GetParent() : null));
          }
        } catch (eGeo){ try { $.Msg("[BBT] live panel geometry failed: " + eGeo); } catch{} }
        // v1.9.29: carry the last title into the summary line too, so one log
        // line separates "the page never loaded" ((no panel)/(empty title)) from
        // "the page answered something we do not parse" (protocol skew).
        if (lastTitle !== "(no panel)" && lastTitle !== "(empty title)") {
          liveProbeNotes.push((job.port || "?") + ":title=" + JSON.stringify(lastTitle.slice(0, 40)));
        }
      }
      // v1.9.22 panel self-heal (fork-verified recipe): an HTML panel that
      // failed to navigate can stay dead forever - SetURL stops producing
      // anything. Resetting to about:blank and re-navigating is the only
      // safe recovery (a runtime CreatePanel would orphan the one working
      // panel). Two consecutive no-answer probes trigger one reset.
      live.noAnswerStreak = (live.noAnswerStreak || 0) + 1;
      if (live.noAnswerStreak >= 2) {
        live.noAnswerStreak = 0;
        live.resets = (live.resets || 0) + 1;
        // Each reset is a full navigation. Three is plenty to recover a
        // genuinely wedged page; past that the endpoint is simply not there
        // and reloading it forever only costs frames.
        if (live.resets > 3) {
          job.cb(false, "timeout", null);
          liveDisarm("repeated timeouts");
          return;
        }
        var hp = livePanel();
        if (hp && typeof hp.SetURL === "function") {
          try { hp.SetURL("about:blank"); } catch{}
          if (debugOn()) $.Msg("[BBT] live panel reset to about:blank after repeated no-answer probes (self-heal " + live.resets + "/3)");
        }
      }
      job.cb(false, "timeout", null);
      return;
    }
    $.Schedule(LIVE_POLL, function () { livePoll(job); });
  }

  function liveMarkFailure(reason) {
    live.hardFails += 1;
    if (live.hardFails >= LIVE_HARD_FAILS_MAX) {
      $.Msg("[BBT] live bridge disabled after " + live.hardFails + " failures (" + reason + "); offline memory only");
      liveDisarm("hard failures");
    }
  }

  var liveProbeNotes = []; // v1.9.28: per-target failure reason for the summary line
  function liveProbeTargets(index) {
    index = index || 0;
    if (index >= LIVE_TARGETS.length) {
      live.state = "off";
      // v1.9.28 (user report 11/06 21:31 "bing的桥连接不上吗？"): the plain
      // "not available" line cannot tell a dead bridge from an unreachable
      // HTML panel. Print the failure code per port (panel_unavailable =
      // the <HTML> panel was not found from this context; timeout = the
      // page never answered, i.e. cert/CEF or the bridge itself).
      $.Msg("[BBT] live bridge: not available on " +
        LIVE_TARGETS.map(function (t) { return t.port; }).join("/") +
        (liveProbeNotes.length ? " (" + liveProbeNotes.join(", ") + ")" : "") +
        "; offline memory only");
      liveProbeNotes = [];
      liveProbeSettled();
      return;
    }
    var t = LIVE_TARGETS[index];
    liveSend({ kind: "health" }, LIVE_PROBE_TIMEOUT, function (ok, err, payload) {
      if (!ok) liveProbeNotes.push(t.port + ":" + (err || "fail"));
      if (!ok && debugOn()) $.Msg("[BBT] live probe failed on " + t.port + ": " + err);
      if (ok && payload && (payload.ok || payload.translations)) {
        LIVE_TARGET = t;
        live.provider = payload.provider ? String(payload.provider) : "";
        live.targetName = payload.name ? String(payload.name) : t.name;
        live.state = "on";
        stats.liveProvider = live.provider;
        // Delayed so the first on-screen texts get the channel first: overrides
        // exist to correct the pak, not to block it.
        $.Schedule(1.5, function () {
          try { liveFetchOverrides(); } catch{}
        });
        $.Msg("[BBT] live bridge: connected to " + live.targetName + " (localhost:" + t.port +
          (live.provider ? ", provider=" + live.provider : "") +
          "), offline memory + live fallback" +
          (live.provider && live.provider !== "bing" ? " [note: that provider is configured in the bridge's own settings]" : ""));
        try { liveUpgradeWeakWrites(); } catch{}
        liveProbeSettled();
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
    // v1.9.29 (the 15:00:55 `lastTitle="(empty title)"` session): a panel that
    // is not on screen never renders, so the page never runs and the title can
    // never arrive - the boot probe from a CLOSED shop surface can only burn 4s
    // and then park the channel. Defer instead: the click path (dispatch) probes
    // again once the page the user is reading is actually visible.
    var w = -1; // -1 = the engine did not report a width: do not guess, probe.
    try {
      var bp = livePanel();
      if (bp && typeof bp.actuallayoutwidth === "number") w = bp.actuallayoutwidth;
    } catch{ w = -1; }
    // v1.9.29 (18:29 in-game): `actuallayoutwidth` came back 0 even with the shop
    // surface open and the page demonstrably running (the bridge logged the
    // page's own fetches), so it is not a usable gate - and gating on it parked
    // every probe. Navigate anyway; the readback channel now comes from the
    // engine's HTML panel events rather than from the title property.
    if (w === 0 && !live.deferLogged) {
      live.deferLogged = true;
      if (debugOn()) $.Msg("[BBT] live probe: actuallayoutwidth=0 (surface closed or not laid out yet); probing anyway");
    }
    liveReprobe();
  }

  // v1.9.16: the button probes on demand. The boot probe only runs once
  // (state "unknown" -> settled); if the user starts the bridge later, the
  // first translate click re-runs the port scan instead of giving up. While a
  // probe is in flight the click hands the page to the offline pass and waits
  // for the settled flag rather than starting a second probe.
  function liveReprobe() {
    if (liveMode() === "off") return false;
    if (live.state === "on" || live.state === "probing") return true;
    live.disarmed = false; // an explicit click always gets one more chance
    live.resets = 0;
    live.hardFails = 0;
    live.state = "probing";
    live.settled = false;
    liveProbeTargets(0);
    return true;
  }

  function liveProbeSettled() {
    live.settled = true;
    var listeners = live.settleListeners;
    live.settleListeners = [];
    for (var i = 0; i < listeners.length; i += 1) {
      try { listeners[i](); } catch{}
    }
  }

  function liveWaitSettled(fn) {
    if (live.settled) { fn(); return; }
    live.settleListeners.push(fn);
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
      try { cur = p.text; } catch{ continue; }
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
    try { cur = p.text; } catch{ return; }
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
    if (live.state === "on") $.Schedule(0.5, function () { try { liveFetchOverrides(); } catch{} });
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
        try { resetMemos($.GetContextPanel()); } catch{}
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
        try { cur = panel.text; } catch{ cur = null; }
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

  // Glossary substitution only ships when it really produced a Chinese sentence.
  // A result that keeps most of the text English (or a run of >=4 consecutive
  // English words) would render as a confusing mid-sentence mix, worse than the
  // original - so it is rejected and the text stays English + counted missing.
  function termFallbackAcceptable(_raw, mixed) {
    if (!mixed) return false;
    var cjk = 0;
    var lat = 0;
    var wordRun = 0;
    var maxWordRun = 0;
    var inWord = false;
    for (var i = 0; i < mixed.length; i += 1) {
      var c = mixed.charCodeAt(i);
      var isCJK = c >= 0x4E00 && c <= 0x9FFF;
      var isLat = (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
      if (isCJK) {
        cjk += 1;
        inWord = false;
        wordRun = 0;
      } else if (isLat) {
        lat += 1;
        if (!inWord) { wordRun += 1; inWord = true; }
        if (wordRun > maxWordRun) maxWordRun = wordRun;
      } else {
        inWord = false;
      }
    }
    var total = cjk + lat;
    if (total <= 0) return false;
    if (maxWordRun >= TERM_FALLBACK_MAX_EN_WORDS) return false;
    return (cjk / total) >= TERM_FALLBACK_MIN_RATIO;
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
    stableSkips: 0, // T6-3: ticks where the stable-root probe skipped the walk
    offline: "off", // v1.9.29: "on"|"off" - bridge-first mode ships with "off"
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
    } catch{}
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
    } catch{}
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
  // Source 2 in-game panels expose no `.class` string and no DOM-like
  // classList: the engine binding is panel.BHasClass(name) (the form BabelTower
  // verified in game; our v1.9.6 test proved classList/.class collect 0 labels
  // there). Test shims lack BHasClass, so read all three: BHasClass first
  // (engine), classList second, `.class` string last (legacy shims).
  function panelHasClass(panel, cls) {
    try {
      if (typeof panel.BHasClass === "function") return panel.BHasClass(cls) === true;
    } catch{}
    try {
      var cl = panel.classList;
      if (cl && typeof cl.contains === "function") return cl.contains(cls) === true;
    } catch{}
    try {
      var c = panel.class;
      if (typeof c === "string") {
        var parts = c.split(/\s+/);
        for (var i = 0; i < parts.length; i += 1) if (parts[i] === cls) return true;
      }
    } catch{}
    return false;
  }

  // ---- our own chrome is not game text ----
  // The toolbar status line and the click de-duplication marker are written by
  // this script, not by the game. If the scanner treated them as content:
  //   * "act:menu@<ms>" has no CJK, so it reached noteMiss() and the
  //     "[BBT] MISS" harvest (tools/collect_new_texts.js -> build_tm.js ->
  //     machine translation of a marker string into bba_tm.js);
  //   * once such an entry exists, a translation would be written BACK into the
  //     marker label, the "name@<ms>" stamp stops parsing and the second
  //     activation path of one click is no longer de-duplicated (the v1.9.7
  //     "dropdown opens and instantly closes" symptom would return);
  //   * every click also added a junk MISS line, eating the 300-entry harvest
  //     budget that real untranslated build text needs.
  // Layouts mark these labels with class="BBTNoTranslate".
  function isOwnChrome(panel) {
    try {
      if (panelHasClass(panel, "BBTNoTranslate")) return true;
    } catch{}
    return false;
  }

  // Only classes whose declaration is unambiguous get re-resolved as a single
  // token. ModifiesLabel is the exception: one class name is declared with two
  // different #tokens, so it carries a candidate list and resyncLabel tries
  // them until one resolves (a wrong candidate just fails resolvedText).
  var RESYNC_TOKENS = [
    ["BuildDescription", "#Citadel_HeroBuilds_BuildDescription"],
    ["BuildName", "#Citadel_HeroBuilds_BuildName"],
    ["CategoryName", "#Citadel_HeroBuilds_CategoryName"],
    ["CategoryDescription", "#Citadel_HeroBuilds_CategoryDescription"],
    ["ModifiesLabel", ["#Citadel_Item_Build_Annotation", "#Citadel_ItemModifies"]],
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
  // What this English should say in Chinese, or null when nothing is known.
  // Kept separate from translatePanel() so a resync can write the final text in
  // ONE assignment: writing the English first and the Chinese a moment later is
  // a visible two-step repaint (the "translation is flickering" report).
  function translationFor(raw) {
    if (!offlineOn()) return null;
    var hit = lookup(raw);
    if (hit) return hit.wasCopy ? hit.text + " 的副本" : hit.text;
    var frag = fragmentTranslate(raw);
    if (frag) return frag;
    if (normalize(raw).length <= TERM_FALLBACK_MAX) {
      var mixed = substituteTerms(raw);
      if (mixed) return mixed;
    }
    return null;
  }

  function applyResync(p, raw) {
    var cur = null;
    try { cur = p.text; } catch{ cur = null; }
    memo.delete(p);
    if (mode === "orig") {
      if (cur !== raw) {
        try { p.text = raw; } catch{}
      }
      return;
    }
    var target = translationFor(raw);
    if (target) {
      target = present(raw, target);
      if (writeText(p, target)) stats.writes += 1;
      remember(p, 1, raw, target);
      return;
    }
    // Nothing known yet: show the engine's new English (single write) and let
    // the scanner / live bridge fill it in on a later pass.
    if (cur !== raw) {
      try { p.text = raw; } catch{}
    }
    remember(p, 0, raw, null);
  }

  // Panels the engine will not re-localize for us. v1.9.8 and earlier "restored"
  // the declared #token into label.text and waited for the engine to resolve it;
  // the engine only localizes the token in the XML attribute, NOT when JS assigns
  // it, so the label rendered the literal "#Citadel_HeroBuilds_CategoryDescription"
  // on screen (screenshots 2026-11-01) and the next scan pass translated it again
  // = the reported flicker. Never write a token; freeze the panel for a while so
  // the refresh loop cannot alternate between our text and a raw token either.
  var resyncFrozen = new WeakMap();
  var RESYNC_FREEZE_MS = 4000;

  function freezeResync(p) {
    try { resyncFrozen.set(p, nowMs() + RESYNC_FREEZE_MS); } catch{}
  }

  function isResyncFrozen(p) {
    var until = 0;
    try { until = resyncFrozen.get(p) || 0; } catch{ return false; }
    if (!until) return false;
    if (nowMs() < until) return true;
    try { resyncFrozen.delete(p); } catch{}
    return false;
  }

  var localizeProbed = false;
  function resyncLabel(p) {
    var roleTok = roleTokenFor(p);
    if (!roleTok) return false;
    // Role entries may carry a candidate list (ambiguous classes declare one
    // name for two #tokens); resyncLabel tries them until one resolves.
    var cands = (typeof roleTok === "string" ? [roleTok] : roleTok.slice());
    var prev = null;
    try { prev = p.text; } catch{ return false; }
    // 1) Ask the engine for the current value with the label's dialog variables.
    var fresh = null;
    var usedTok = null;
    for (var i = 0; i < cands.length; i += 1) {
      var cand = cands[i];
      var f = null;
      try { f = $.Localize(cand, p); } catch{ f = null; }
      f = resolvedText(f, cand);
      if (f) { fresh = f; usedTok = cand; break; }
    }
    if (fresh) {
      stats.resyncOk = (stats.resyncOk || 0) + 1;
      if (debugOn() && cands.length > 1) $.Msg("[BBT] resync-localized " + usedTok);
      applyResync(p, fresh);
      return true;
    }
    // One probe per layout instance (BBT_DEBUG-gated): the -condebug log then
    // shows whether the engine's $.Localize really yields the current value
    // (2-arg form), or only the raw token / template. The next fix step
    // depends on this answer.
    if (!localizeProbed && debugOn()) {
      localizeProbed = true;
      for (var j = 0; j < cands.length; j += 1) {
        var two = null, one = null;
        try { two = $.Localize(cands[j], p); } catch (e){ two = "err:" + e; }
        try { one = $.Localize(cands[j]); } catch (e){ one = "err:" + e; }
        $.Msg(
          "[BBT] localize-probe " + cands[j] +
            " 2arg=" + JSON.stringify(String(two).slice(0, 48)) +
            " 1arg=" + JSON.stringify(String(one).slice(0, 48))
        );
      }
    }
    // 2) The engine will not hand us the current value. Do NOT write the token
    // back (see freezeResync): the engine does not re-localize a token assigned
    // through JS, so the label would render "#Citadel_..." literally and the
    // next scan would translate it again. Leaving the label alone keeps the last
    // good text on screen; the freeze stops the refresh loop from retrying it
    // every tick, and a panel whose text the engine does replace will be picked
    // up by the scanner (raw text + memo miss) rather than by us.
    freezeResync(p);
    stats.resyncFail = (stats.resyncFail || 0) + 1;
    if (debugOn()) {
      $.Msg("[BBT] resync-unresolved " + cands.join(",") + " text=" + JSON.stringify(String(prev).slice(0, 24)));
    }
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

  function resyncAll(limit, origin) {
    var max = limit || 40;
    var root = null;
    try { root = pageRoot(origin); } catch{ root = null; }
    if (!root) root = contextPanel();
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
      try { if (p.IsValid && !p.IsValid()) ok = false; } catch{ ok = false; }
      if (!ok) continue;
      if (!panelVisible(p)) continue;
      if (roleTokenFor(p) && !isResyncFrozen(p)) {
        if (primaryRole(p)) primary.push(p);
        else secondary.push(p);
      }
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch{ n = 0; }
      for (var k = n - 1; k >= 0; k -= 1) {
        try {
          var ch = p.GetChild(k);
          if (ch) stack.push(ch);
        } catch{}
      }
    }
    var count = 0;
    var order = primary.concat(secondary);
    for (var i = 0; i < order.length && count < max; i += 1) {
      count += 1;
      try { resyncLabel(order[i]); } catch{}
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
    try { current = panel.text; } catch{ return false; }
    if (typeof current === "string" && current === value) return false;
    try {
      panel.text = value;
      if (written.length < 400 && written.indexOf(panel) < 0) written.push(panel);
      return true;
    } catch{
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

  // T6-2: session-global MISS ledger on globalThis. Every layout context has
  // its own closure scope, but all contexts share one globalThis — so each key
  // logs its first [BBT] MISS line ONCE per game session, not once per context
  // (the v1.9.14 console.log showed the same key ~17× across 12 contexts).
  // Also cuts per-tick $.Msg I/O: after the first hit the check is one
  // property read.
  var missLedger = (G && G.__BBT_MISS_LOGGED) || (G && (G.__BBT_MISS_LOGGED = Object.create(null)));

  function noteMiss(raw, panel) {
    if (!COLLECT_MISSES || stats.misses >= MISS_CAP) return;
    // Never harvest our own chrome: "act:mode:next@<ms>" would be machine
    // translated into bba_tm.js and then written back into the marker label.
    if (panel && isOwnChrome(panel)) return;
    try {
      // Custom panels can expose their type name through .text; never collect that.
      if (panel && panel.paneltype && raw === panel.paneltype) return;
    } catch{}
    var flat = flatten(raw);
    if (flat.length < 4 || flat.length > 2000) return;
    if (!/[A-Za-z]{2}/.test(flat)) return;
    if (/^https?:\/\//i.test(flat)) return;
    var k = keyOf(flat);
    if (missLedger[k]) return; // T6-2: 同一 key 全会话只记首条
    missLedger[k] = 1;
    stats.misses += 1;
    $.Msg("[BBT] MISS " + k + " " + flat);
  }

  function isTextEntry(panel) {
    try {
      if (typeof panel.placeholder === "string") return true;
      // maxchars may be exposed as a number or as the raw attribute string.
      if (typeof panel.maxchars === "number" || typeof panel.maxchars === "string") return true;
    } catch{}
    return false;
  }

  // Deadlock panels expose visibility as BIsVisible(); IsVisible() is not reliable here.
  function panelVisible(panel) {
    try {
      if (typeof panel.BIsVisible === "function") return panel.BIsVisible();
      if (typeof panel.IsVisible === "function") return panel.IsVisible();
    } catch{}
    return true;
  }

  // Per-scan counters (S3): scan() resets these, translatePanel() increments
  // token on every engine-owned token/template label it meets, and scan() reads
  // them back to emit the one-shot scan-summary line.
  var scanCtx = { token: 0, baselineWrites: 0, root: null };
  // $.Localize is an engine round-trip; a stuck #token label would otherwise
  // call it every poll. Try at most once per TOKEN_REREAD_MS per label.
  var tokenStamp = new WeakMap();
  var TOKEN_REREAD_MS = 1500;

  function translatePanel(panel, preRead) {
    // Defence in depth: the scan already skips our own chrome, but every write
    // entry point funnels through here (resyncAll, refresh, live bridge).
    if (isOwnChrome(panel)) return;
    var raw;
    try {
      // Scan already read the text; re-reading it here would double the number
      // of JS <-> UI binding crossings, which dominate the in-game cost.
      raw = preRead === undefined ? panel.text : preRead;
    } catch{
      return;
    }
    if (typeof raw !== "string" || raw.length < 2) return;

    if (mode === "orig") {
      // "show the original": never write; if we had written before, put it back.
      var rec0 = memo.get(panel);
      if (rec0 && rec0.k >= 1 && raw === rec0.out) {
        // The label still shows OUR translation. If it is engine-driven, the
        // engine may already hold a newer value for it (the user switched
        // builds) that never reached the label: writing .text replaced the
        // dialog-variable template, so SetDialogVariable had nowhere to land.
        // Ask the engine directly via $.Localize before falling back to the
        // English we translated (v1.9.28: the right-hand build name stayed on
        // the previous build's Chinese after a switch).
        var fresh0 = null;
        var tk0 = tokenFor(panel);
        if (tk0) {
          var lv0 = null;
          try { lv0 = $.Localize(tk0, panel); } catch{ lv0 = null; }
          lv0 = resolvedText(lv0, tk0);
          if (lv0 && lv0 !== rec0.in) fresh0 = lv0;
        }
        if (fresh0) {
          applyResync(panel, fresh0);
          return;
        }
        try { panel.text = rec0.in; } catch{}
        memo.delete(panel);
      }
      return;
    }
    if (raw.indexOf("#") === 0 || raw.indexOf("{s:") >= 0) {
      // Engine-owned label: either a declared #token whose localization the
      // engine resolves, or an unresolved {s:var} template waiting on dialog
      // variables. Neither is translatable as-is, and a {s:var} template must
      // never reach noteMiss() (it would machine-translate the template string
      // into bba_tm.js). Record the token for identity tracking and leave the
      // label for a later pass: the moment the engine resolves it, .text changes
      // and the normal path re-runs (the k:0 memo below never blocks that — a
      // changed text falls through the memo check).
      scanCtx.token += 1;
      if (raw.indexOf("#") === 0 && !memo.has(panel)) tokenOf.set(panel, raw);
      observedToken.set(panel, raw);
      remember(panel, 0, raw, null);
      // A label can be STUCK on its declared token: the engine localizes the
      // token written in the XML attribute, not one assigned through JS (v1.9.8
      // wrote tokens and rendered "#Citadel_HeroBuilds_CategoryDescription" on
      // screen). Repair it instead of leaving the raw token visible: localize
      // it ourselves, then translate the result. Panels bound to a {s:var}
      // template cannot be repaired this way (Localize hands back the template
      // itself), and they are left alone.
      if (raw.indexOf("#") === 0) {
        var lastTok = tokenStamp.get(panel);
        if (lastTok === undefined || nowMs() - lastTok >= TOKEN_REREAD_MS) {
          tokenStamp.set(panel, nowMs());
          repairToken(panel, raw);
        }
      }
      return;
    }
    // Some custom panels expose their type name through .text; never treat that
    // as content (and never write to it).
    try {
      if (panel.paneltype && raw === panel.paneltype) {
        remember(panel, 0, raw, null);
        return;
      }
    } catch{}

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
    var frag = offlineOn() ? fragmentTranslate(raw) : null;
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
    if (offlineOn() && normalize(raw).length <= TERM_FALLBACK_MAX) {
      mixed = substituteTerms(raw);
      // Quality gate: a glossary pass that leaves most of the sentence English
      // (or a run of >=4 English words) would render a confusing mix. Keep the
      // original and count it as missing instead.
      if (mixed && !termFallbackAcceptable(raw, mixed)) mixed = null;
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

  // See the #token branch of translatePanel. Writes at most once: either the
  // translated text (when we know it) or the engine's own localized string.
  function repairToken(panel, tok) {
    var val = null;
    try { val = $.Localize(tok, panel); } catch{ val = null; }
    if (typeof val !== "string" || !val) return false;
    if (val === tok || val.indexOf("#") === 0 || val.indexOf("{s:") >= 0) return false;
    var out = translationFor(val);
    if (out) {
      var shown = present(val, out);
      if (writeText(panel, shown)) {
        stats.translated += 1;
        stats.writes += 1;
        stats.repaired = (stats.repaired || 0) + 1;
      }
      remember(panel, 1, val, shown);
      return true;
    }
    // Nothing known for the localized text yet: show the engine's own words and
    // let the scanner/bridge translate it on a later pass. This is the raw
    // English, never the token, so the label cannot stay on "#Citadel_...".
    if (writeText(panel, val)) stats.writes += 1;
    remember(panel, 0, val, null);
    return true;
  }

  // One-shot per-instance diagnostic (S3): on the first fully-stable scan of a
  // layout instance, report how many panels were walked and why the rest were
  // skipped. Ungated (a once-per-instance line is not spam) so a "tooltip never
  // translates" report comes back with the actual skip reason.
  var scanSummaries = new WeakMap();
  function scanSummaryOnce(root, visited, skippedToken, skippedHidden, skippedOwn, wrote) {
    try {
      if (scanSummaries.get(root)) return;
      scanSummaries.set(root, 1);
    } catch{
      return;
    }
    $.Msg("[BBT] scan-summary " + instTag(root) + "：visited=" + visited + " skippedToken=" + skippedToken + " skippedHidden=" + skippedHidden + " skippedOwn=" + skippedOwn + " wrote=" + wrote);
  }

  // Cumulative writes per layout instance (S3): the scan-summary's `wrote` is
  // the total this instance has written since it appeared, not just the one
  // stable scan that happens to emit the line.
  var scanBaselines = new WeakMap();

  var scanCarry = []; // T6: unvisited panels left over from a budget-capped tick.
  // T6-3: fully-memoed tree fast-exit. A root is only ever marked stable by a
  // FULL walk (carry drained) that found nothing new, skipped nothing hidden and
  // wrote nothing — that is the proof the whole visible tree is in the memo. A
  // stable tick then probes only the identity labels recorded at the end of
  // that walk (build-switch detector) plus whether the child set changed. Any
  // changed probe or new child drops the root and the NEXT tick does a full
  // walk again — so this adds no new periodic rescan, it only replaces a
  // zero-work walk with a handful of `.text` reads (the "不拖帧" target).
  var stableRoots = new WeakMap(); // root -> { probes: [[panel, text]], children: n }

  // v1.9.45 (user feedback 11/07 20:45): the item tooltip already shows
  // Chinese for everything the game localises (name, cost, stat lines, passive
  // text). Translating those again produced doubled/mixed copy, so on that one
  // surface only the build author's own annotation - rendered inside the
  // engine's .NotesContainer - is translated.
  var notesOnlySurface = false;
  function tooltipNeedsTranslation(t) {
    if (typeof t !== "string" || t.length < 2) return false;
    var hasCjk = false;
    var hasLatin = false;
    for (var i = 0; i < t.length; i += 1) {
      var c = t.charCodeAt(i);
      if (c >= 0x4E00 && c <= 0x9FFF) { hasCjk = true; break; }
      if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) hasLatin = true;
    }
    if (hasCjk) return false;   // engine copy, already localised by the game
    return hasLatin;            // pure numbers/symbols ("800", "+2.5") are engine data
  }

  function scan(root) {
    // T6 chunking: a walk is a persistent cycle. When carry is empty this is the
    // first tick of a cycle (push root); otherwise we resume mid-walk. A panel
    // has exactly one parent, so nothing is re-pushed; disposed panels die on the
    // IsValid() guard below. Burst ticks keep going at FAST_INTERVAL — each is
    // just another chunk of the same walk.
    if (scanCarry.length === 0) scanCarry.push(root);
    var stack = scanCarry;
    var visited = 0;
    var fresh = 0;
    var skipped = 0;
    var skippedOwn = 0;
    var writesBefore = stats.writes; // T6-3: stability is judged on THIS tick's writes only
    var rootChildren = 0; // T6-3: child-set snapshot taken before the walk
    try { rootChildren = root.GetChildCount ? root.GetChildCount() : 0; } catch{}
    var probes = []; // T6-3: identity-label texts recorded during the walk
    scanCtx.root = root; // v1.9.17: displayOrig gate (原文/翻译 toggle)
    scanCtx.token = 0;
    // v1.9.26 R1/R2/R4: shared two-state gate. Build pages (selector / details /
    // shop) start on the ORIGINAL text; the button is the only way in and out.
    // "" = no gate (tooltips and any surface above the page tags keep auto).
    var tsKey = "";
    try { tsKey = tsKeyOf(root); } catch{ tsKey = ""; }
    scanCtx.tsGate = tsKey !== "" && tsMode(tsKey) !== "zh";
    try {
      if (!scanBaselines.has(root)) scanBaselines.set(root, stats.writes);
      scanCtx.baselineWrites = scanBaselines.get(root);
    } catch{
      scanCtx.baselineWrites = stats.writes;
    }
    while (stack.length && visited < SCAN_BUDGET) {
      var p = stack.pop();
      visited += 1;
      if (!p) continue;
      try {
        if (p.IsValid && !p.IsValid()) continue;
      } catch{
        continue;
      }
      if (isOwnChrome(p)) { skippedOwn += 1; continue; } // own status line / dedupe marker
      var known = memo.has(p);
      if (!known) fresh += 1;
      // Only panels that carry a string need the extra TextEntry probes; every
      // other panel type would cost two more property reads per tick.
      var t;
      try { t = p.text; } catch{ t = null; }
      // Resolve the label's declared #token once (id/class lookup), then reuse
      // it: identity labels tell us the shown build/item changed, even when the
      // panels we already translated are stuck on an old translation.
      if (!known) {
        var tk = tokenFor(p);
        if (tk) tokenOf.set(p, tk);
      }
      if (typeof t === "string" && t.length >= 2) {
        if (!isTextEntry(p)) {
          // v1.9.17 原文/翻译 toggle: while this page is deliberately showing
          // the original text, the scanner must not re-translate it.
          // v1.9.26: the default state is "original" for every build page
          // (R1/R4), gated cross-context via G (scanCtx.tsGate).
          var origOn = false;
          try { origOn = scanCtx.tsGate || !!(scanCtx.root && displayOrig.get(scanCtx.root)); } catch{}
          if (!origOn && (!notesOnlySurface || tooltipNeedsTranslation(t))) translatePanel(p, t);
          // v1.9.29 (lobby stutter, the real source): a page pinned to 原文
          // never reached translatePanel, so nothing ever memoed its labels -
          // every scan counted the whole page as "fresh" and re-armed the burst
          // forever (in-game 17:11: 9 contexts at 0.08s, scanned=1,027,320 in
          // one context, stableSkips=0). Remember the panel as seen so an
          // unchanged page goes quiet; flipping to 翻译 clears the memos.
          else if (!known) remember(p, 0, t, null);
        }
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
          probes.push([p, t]); // T6-3: stable-root probe (build-switch detector)
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
      } catch{
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
        } catch{}
      }
    }
    stats.scanned += visited;
    stats.skipped += skipped;
    scanCtx.wrote = stats.writes - scanCtx.baselineWrites;
    if (fresh === 0) scanSummaryOnce(root, visited, scanCtx.token, skipped, skippedOwn, scanCtx.wrote);
    // T6-3: stamp stability only on a clean, full walk — chunk drained, no new
    // panels, nothing hidden (a visibility toggle could not be probed otherwise),
    // zero writes this tick, and at least one identity label to probe. Without
    // any of that the root stays unstable and keeps its ordinary walk.
    if (stack.length === 0 && fresh === 0 && skipped === 0 &&
        stats.writes - writesBefore === 0 && probes.length > 0) {
      stableRoots.set(root, { probes: probes, children: rootChildren });
    } else {
      stableRoots.delete(root);
    }
    return fresh;
  }

  // Adaptive polling: a freshly painted layout (new build, opened tooltip) is
  // rescanned every POLL_INTERVAL; a quiet one backs off to IDLE_MAX_INTERVAL.
  // This is what keeps the mod from walking thousands of panels 6-7 times a
  // second forever while the player is just looking at a screen.
  var interval = POLL_INTERVAL;
  var idleTicks = 0;
  var burstTicks = 0;
  var perfTicks = 0; // v1.9.29: BBT_DEBUG PERF sampling cadence (per context)
  var noWriteTicks = 0; // v1.9.29: consecutive ticks that found panels but wrote none
  var bootLayoutTag = ""; // set in boot(); tick() logs it (must be module scope)
  var ticksSinceRebind = 99;
  // §6 rect probe (BBT_DEBUG-gated): real geometry of the rows the toolbar
  // sits in, so a position can be computed from the log instead of guessed.
  // v1.9.41: the one-shot version ran during boot, when every panel still
  // reports NaN (nothing is laid out yet), so it never produced a usable
  // number. It now re-runs from tick() until the trigger has a real width.
  // v1.9.43: pure diagnostics. The previous versions returned early and logged
  // nothing when the API they assumed was missing (Panorama has no
  // GetPositionWithinWindow on every build), so the log stayed empty for three
  // builds. This prints what the trigger panel actually reports, six times per
  // context, then disarms itself.
  function probeRects(ctx) {
    if (!ctx) return false;
    var tries = G.__BBT_RECT_TRY || 0;
    if (tries >= 6 || G.__BBT_RECT_DONE) return true;
    var host = uiPanelIn(ctx, "BBTTabBtnHost");
    if (!host) return false;
    G.__BBT_RECT_TRY = tries + 1;
    var api = "none";
    var rect = null;
    try { api = typeof host.GetPositionWithinWindow; } catch{}
    try { rect = host.GetPositionWithinWindow(); } catch{}
    var lw = -1;
    var lh = -1;
    try { lw = host.actuallayoutwidth; lh = host.actuallayoutheight; } catch{}
    $.Msg(
      "[BBT] rect diag " + (tries + 1) + "/6 api=" + api +
        " lw=" + lw + " lh=" + lh +
        " rect=" + (rect ? (rect.x + "," + rect.y + "," + rect.w + "," + rect.h) : "null")
    );
    if (!(lw > 0)) return false; // still not laid out
    G.__BBT_RECT_DONE = true;
    var ids = ["ControlArea", "BBTTabBtnHost", "BBTTranslateButton2", "BuildControls", "BuildOptionButton", "BuildHeader"];
    var pane = layoutRoot(ctx);
    if (pane) {
      var pr = null;
      try { pr = pane.GetPositionWithinWindow(); } catch{}
      var pw = -1;
      try { pw = pane.actuallayoutwidth; } catch{}
      $.Msg("[BBT] rectPane " + (pr ? (pr.x + "," + pr.y + "," + pr.w + "," + pr.h) : "null") + " w=" + pw);
    }
    for (var i = 0; i < ids.length; i += 1) {
      var el = uiPanelIn(ctx, ids[i]);
      if (!el) continue;
      var r = null;
      try { r = el.GetPositionWithinWindow(); } catch{}
      var w = -1;
      var h = -1;
      try { w = el.actuallayoutwidth; h = el.actuallayoutheight; } catch{}
      $.Msg("[BBT] rect " + ids[i] + " " + (r ? (r.x + "," + r.y + "," + r.w + "," + r.h) : "null") + " lw=" + w + " lh=" + h);
    }
    return true;
  }

  function tick() {
    var t0 = Date.now ? Date.now() : 0;
    var before = stats.translated + stats.fallback;
    var fresh = 0;
    var hidden = false;
    try {
      var ctx = $.GetContextPanel();
      if (ctx && panelVisible(ctx)) {
        // v1.9.41: retry the rect dump from the tick until the trigger is laid
        // out (at boot every panel reports NaN, so the one-shot version never
        // produced a number). BBT_DEBUG-gated, self-disarming.
        if (debugOn() && !G.__BBT_RECT_DONE) { try { probeRects(ctx); } catch{} }
        // T6-3 fast-exit: a stable root is probed, not walked — identity-label
        // texts plus the child count. Stable tick = a few .text reads, zero
        // writes, interval backoff continues unchanged. Any change drops the
        // root and runs a full walk right now, so nothing can lag by more
        // than one tick (and the burst/resync paths pick up fresh/identity).
        var snap = stableRoots.get(ctx);
        if (snap) {
          var stale = false;
          try {
            var cc = ctx.GetChildCount ? ctx.GetChildCount() : 0;
            if (cc !== snap.children) stale = true;
          } catch{ stale = true; }
          if (!stale) {
            for (var pi = 0; pi < snap.probes.length; pi += 1) {
              try {
                var pp = snap.probes[pi][0];
                if (pp.IsValid && !pp.IsValid()) { stale = true; break; }
                if (pp.text !== snap.probes[pi][1]) { stale = true; break; }
              } catch{ stale = true; break; }
            }
          }
          if (stale) {
            stableRoots.delete(ctx);
            fresh = scan(ctx);
          } else {
            stats.stableSkips += 1; // observability: walks replaced by probes
          }
        } else {
          fresh = scan(ctx);
        }
      } else hidden = true;
    } catch{
      hidden = true;
    }
    // v1.9.26 two-state sync: the button flip is shared on G (tsSet bumps
    // ver). Every context that owns this page - the shop-build parent AND
    // each embedded category frame, the browser selector AND its nested
    // details instance - must honour the new mode on its next fast tick,
    // not only the one that got the click. That is what stops the last
    // category frame from flicking back to the translation after a 原文
    // click (R2). The bump resets the backoff so the flip lands ~150ms on
    // every context. Revert runs once per flip (tsRevertDone, per context).
    try {
      var gts = G.__BBT_TWO_STATE;
      if (gts && gts.ver !== tsVer) {
        tsVer = gts.ver;
        var tsSyncKey = "";
        try { tsSyncKey = tsKeyOf(ctx); } catch{ tsSyncKey = ""; }
        if (tsSyncKey) {
          if (tsMode(tsSyncKey) === "orig" && !tsRevertDone[tsSyncKey]) {
            try { resetMemos(ctx); } catch{}
            tsRevertDone[tsSyncKey] = 1;
            if (debugOn()) $.Msg("[BBT] two-state: show original on " + tsSyncKey + " in " + instTag(ctx));
          }
          if (tsMode(tsSyncKey) === "zh") delete tsRevertDone[tsSyncKey];
          idleTicks = 0;
          burstTicks = BURST_TICKS;
          interval = FAST_INTERVAL;
        }
      }
    } catch{}
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
      var manual = false, origNow = false;
      try { manual = !!(ctx && manualMode.get(ctx)); } catch{}
      if (manual) {
        // v1.9.25 two-state manual page: honour the current toggle state.
        try { origNow = !!(ctx && displayOrig.get(ctx)); } catch{}
        if (origNow) {
          // Pinned to the original: stay parked, no writes -> no flicker.
          ticksSinceRebind = 0;
        } else {
          // Translated state: re-resolve the engine labels for the new build.
          try { if (resyncAll(40)) ticksSinceRebind = 0; } catch{}
        }
      } else {
        // Non-manual page (selector list / in-game build page): a fresh page,
        // not one the user toggled - clear the gate and auto-translate.
        try { displayOrig.delete(ctx); } catch{}
        // v1.9.26: a shared two-state page (browser / in-game build page)
        // pinned to the ORIGINAL text must NOT auto-resync on a build
        // switch - the user explicitly asked for the original. Only truly
        // un-gated surfaces (tooltips, tsKey "") take the auto path.
        var tsRebindKey = "";
        try { tsRebindKey = tsKeyOf(ctx); } catch{ tsRebindKey = ""; }
        if (tsRebindKey && tsMode(tsRebindKey) !== "zh") {
          ticksSinceRebind = 0;
        } else {
          try {
            if (resyncAll(40)) ticksSinceRebind = 0;
          } catch{}
        }
      }
    }
    ticksSinceRebind += 1;
    // v1.9.29 caption watchdog: a progress string must never be the resting
    // state. If the action's callback never arrives, restore 翻译/原文 here.
    try {
      if (ui.captionDeadline && !ui.busy) {
        var capNow = nowMs();
        if (capNow && capNow > ui.captionDeadline) {
          ui.captionDeadline = 0;
          uiResetLabel(ctx);
        }
      }
    } catch{ ui.captionDeadline = 0; }
    try { liveDrainQueue(); } catch{}
    try { liveDrainUpgrades(); } catch{}
    // v1.9.29 (lobby stutter, measured): "fresh" alone is NOT progress. Panels that were
    // never memoed (a tree the engine rebuilds, a page kept on 原文) make every
    // tick look productive, which re-armed the burst forever: 9 contexts sat at
    // 0.08s and re-walked 2000+ panels each time (in-game 17:05: scanned=
    // 378600/context, stableSkips=0, nothing written). Only real writes, or a
    // walk that finished with new panels, may keep the fast cadence.
    var carryLeft = scanCarry.length;
    var wrote = stats.translated + stats.fallback > before;
    var worked = wrote || (fresh > 0 && carryLeft === 0);
    if (worked) {
      noWriteTicks = 0;
    } else {
      noWriteTicks += 1;
      // Fresh panels with no write at all for this many ticks is the churn case
      // (engine-rebuilt tree / page pinned to 原文), not progress: drop the
      // burst and let the idle backoff take the cadence down to 1s.
      if (noWriteTicks > 8) burstTicks = 0;
    }
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
    // v1.9.29: the boot probe defers while the shop surface is closed (its
    // <HTML> panel has no layout width, so the page never runs). Keep offering
    // it once per tick until it happens: state leaves "unknown" the first time a
    // probe really starts, so this is one cheap property read per idle tick.
    if (live.state === "unknown" && !live.disarmed) {
      try { liveProbe(); } catch{}
    }
    // v1.9.29 (lobby stutter report): a number the user can quote back. "The
    // lobby is extremely laggy" cannot be worked on without knowing whether the
    // cost is our scan (scanMs) or the frame itself (fps), so log both when
    // BBT_DEBUG is on: `BBT_PERF` samples every 120 ticks of this context.
    perfTicks += 1;
    if (debugOn() && perfTicks >= 120) {
      perfTicks = 0;
      // Never let diagnostics kill the poll loop: an exception here used to skip
      // the reschedule below (in-game 14:39:28, "layoutTag is not defined").
      try {
      var fms = -1;
      try { if (G.Game && typeof G.Game.GetFrameTime === "function") fms = Number(G.Game.GetFrameTime()); } catch{ fms = -1; }
      $.Msg("[BBT] PERF tag=" + bootLayoutTag +
        " fps=" + (fms > 0 ? (1 / fms).toFixed(1) : "?") +
        " frameMs=" + (fms > 0 ? (fms * 1000).toFixed(2) : "?") +
        " scanMs=" + stats.ms +
        " scanned=" + stats.scanned +
        " translated=" + stats.translated +
        " fallback=" + stats.fallback +
        " misses=" + stats.misses +
        " interval=" + interval +
        " stableSkips=" + stats.stableSkips +
        " live=" + live.state + (live.disarmed ? "(disarmed)" : ""));
      } catch (ePerf){ try { $.Msg("[BBT] PERF log failed: " + ePerf); } catch{} }
    }
    $.Schedule(interval, tick);
  }



  // ---------- wiring the toolbar ----------
  // Two independent paths can start a toolbar action, because we cannot see the
  // engine's panel-event semantics from outside:
  //   1. the layout's onactivate="..." string, resolved by the engine in the
  //      global scope (needs the handler exported there), and
  //   2. SetPanelEvent("onactivate", fn), which attaches to the panel object.
  // Both funnel through uiGuard() so a single click can never run twice, and both
  // report a status line so a "nothing happens" report comes back with which path
  // fired instead of requiring the console.
  var uiWired = Object.create(null);
  var uiWiredOnce = false;
  // v1.9.17 two-state trigger toggle: pageRoot -> 1 while that page is
  // deliberately showing the ORIGINAL text (scanner must not re-translate).
  var displayOrig = new WeakMap();
  // v1.9.25 manual two-state page flag: armed in boot() for the build-details
  // context only. tick() honours it on a build switch - a manual page pinned
  // to the original stays parked (no re-translate, no flicker); one in the
  // translated state is re-synced to stay fresh. Non-manual contexts (selector
  // list, in-game build page) keep the old auto-translate-on-switch path.
  // The actual show/gate state lives in displayOrig; manualMode only tells
  // tick() to honour it instead of forcing an auto-translate.
  var manualMode = new WeakMap();

  // ---------- v1.9.26 R1/R2/R4: unified two-state translate button (shared) ----------
  // v1.9.25 armed the manual two-state inside the build-details context only;
  // but a page is scanned by several JS contexts at once (the shop-build page
  // parent + one context per embedded category frame, the browser details +
  // selector), and a per-context WeakMap cannot gate the OTHER contexts'
  // rewrites - that is why the last category frame kept flicking back to the
  // translation after a 原文 click (user report R2). The mode now lives on G
  // (all layout contexts share one globalThis - the __BBT_BRIDGE_PANELS /
  // MISS-ledger pattern), keyed by the STABLE page identity: the outermost
  // build-page instance above the panel. The button caption always names the
  // NEXT action (翻译 | 原文) on every surface: browser toolbar, embedded
  // trigger, in-game header button.
  var TWO_STATE_PAGES = ["CitadelHeroBuildsSelector", "CitadelBuildDetails", "CitadelShopModsBuild"];
  var tsVer = 0; // this context's copy of the shared version counter
  var tsRevertDone = Object.create(null); // this context: page key -> already reverted since the last flip
  // v1.9.27 (field bugs ②③): the two-state display is a SINGLE GLOBAL switch
  // (on = translated, off = original), shared by every JS context through the
  // engine-shared globalThis BBA_* store. The v1.9.26 per-key table
  // (mode[tsKeyOf(ctx)]) split whenever nested instances carried different
  // panel ids - the click only opened its own context's key, so sibling
  // instances (the embedded category frames, the build description) kept the
  // default gate and never translated, and the caption never moved to 原文.
  // A click now flips the global; every context's tick sync picks up the new
  // state via the shared ver bump.
  function twoStateGlobal() {
    try {
      if (!G.__BBT_TWO_STATE) G.__BBT_TWO_STATE = { on: false, ver: 0 };
      return G.__BBT_TWO_STATE;
    } catch { return null; }
  }
  // Stable key of the build page owning `panel`: walk up and keep the LAST
  // (outermost) matching page tag, so the browser's nested details instance
  // and its selector root share one key, and every embedded category frame
  // shares the shop page's key. A tooltip (or any surface above the
  // topmost page tag) gets "" = no gate: hover tooltips must keep
  // auto-translating (transient content, R3 "don't break").
  function tsKeyOf(panel) {
    var key = "", p = panel;
    for (var i = 0; p && i < 40; i += 1) {
      var tag = panelTag(p);
      if (TWO_STATE_PAGES.indexOf(tag) >= 0) key = String(p.id || "") || tag;
      try { p = p.GetParent ? p.GetParent() : null; } catch { p = null; }
    }
    return key;
  }
  function tsMode(key) {
    if (!key) return "auto";
    // v1.9.27: `key` only says this context drives a two-state surface; the
    // display state itself is the GLOBAL switch (one value, every context).
    var g = twoStateGlobal();
    return g && g.on ? "zh" : "orig";
  }
  function tsSet(key, m) {
    if (!key) return;
    var g = twoStateGlobal();
    if (!g) return;
    var want = m === "zh";
    if (g.on !== want) {
      // v1.9.33: one physical click can reach two contexts (the details pane
      // and the selector it is embedded in both carry a trigger). Each flipped
      // the shared switch, so the pair cancelled out and the caption snapped
      // back to 翻译 - the user's "按钮没有双状态". A flip inside 400ms of the
      // previous one is the same click arriving twice.
      var t0 = 0;
      try { t0 = nowMs() || 0; } catch{ t0 = 0; }
      if (t0 > 0 && g.flipAt && (t0 - g.flipAt) < 400) return;
      g.flipAt = t0;
      g.on = want;
      g.ver = (g.ver || 0) + 1; // every context's tick() sees the bump on its next run
    }
  }

  // v1.9.27: the shared global version counter of the two-state switch.
  // (Named tsGlobalVer: `tsVer` is already the per-context copy variable.)
  function tsGlobalVer() {
    var g = twoStateGlobal();
    return g ? g.ver : 0;
  }
  // Convenience alias used by the dispatch log lines (reads the shared
  // global version counter of the two-state switch).
  function tsVerNow() { return tsGlobalVer(); }

  function nowMs() {
    try { if (typeof Date.now === "function") return Date.now(); } catch{}
    return 0;
  }

  // One physical click can reach us twice: once through the layout's
  // onactivate/onmouseactivate expression and once through the SetPanelEvent
  // callback. When the layout is instantiated more than once those two paths can
  // even run in different script contexts (and different instances), so neither
  // a per-instance variable nor a global object is a reliable ledger. The marker
  // therefore lives in the clicked instance's own panel tree
  // (<Label id="BBTActMark2">), which both paths always touch, and the global
  // ledger stays as a second net. For a toggle like the dropdown, running the
  // action twice used to open and immediately close the menu = "dead button".
  function uiGuard(root, name, windowMs) {
    var win = windowMs || 350;
    var now = nowMs();
    var g = null;
    try {
      g = G.__BBT_ACT || (G.__BBT_ACT = {});
    } catch{
      g = null;
    }
    var gAt = 0;
    if (g && now > 0) {
      gAt = Number(g[name]) || 0;
      if (gAt > 0 && now - gAt < win) return false;
    }
    var mark = uiPanelIn(root, ["BBTActMark2", "BBTActMark"]);
    var prev = "";
    if (mark) {
      try { prev = String(mark.text || ""); } catch{ prev = ""; }
    }
    var cut = prev.lastIndexOf("@");
    if (cut > 0) {
      var mAt = prev.slice(0, cut) === name ? (parseInt(prev.slice(cut + 1), 10) || 0) : 0;
      if (mAt > 0 && now - mAt < win) return false;
    }
    if (g && now > 0) {
      try { g[name] = now; } catch{}
    }
    if (mark) {
      try { mark.text = name + "@" + now; } catch{}
    }
    return true;
  }

  // A toggle is only correct once per click; give the onmouseactivate/onactivate
  // pair a wider window than ordinary idempotent actions (translating twice is
  // merely wasteful, opening+closing the menu looks like a dead button).
  function actionWindow(name) {
    // The translate click can start a bridge round-trip (seconds); give a
    // patient double-click a real window so the second press doesn't double-send.
    return name === "translate" ? 600 : 350;
  }

  // Always-on click log: one line per user click, so the volume is negligible
  // and it must NOT be gated by BBT_DEBUG. This is the proof a click reached our
  // handler; the result also lands on the button itself (uiSetLabel).
  function clickProbe(name, panel) {
    var tag = "?";
    try {
      if (panel) tag = String(panel.id || (panel.tag ? panel.tag : "panel")) || "?";
    } catch{ tag = "?"; }
    $.Msg("[BBT] click " + name + " on " + tag);
    // One-shot (ungated) ancestor chain: the first real click dumps the clicked
    // panel's id|tag|paneltype up 20 levels. This is the evidence that proves
    // which ancestor is the real layout (pageRoot/layoutRoot match on tag), and
    // it is needed exactly once per process, so it must never be gated away.
    if (!G.__BBT_CHAIN_DUMPED && panel) {
      G.__BBT_CHAIN_DUMPED = true;
      var chain = [];
      var c = panel;
      for (var i = 0; c && i < 20; i += 1) {
        var id = "", tg = "", pt = "";
        try { id = String(c.id || ""); } catch{}
        try { tg = String(c.tag || ""); } catch{}
        try { pt = String(c.paneltype || ""); } catch{}
        chain.push(id + "|" + tg + "|" + pt);
        var up = null;
        try { up = c.GetParent ? c.GetParent() : null; } catch{ up = null; }
        c = up;
      }
      $.Msg("[BBT] click-chain " + chain.join(" > "));
    }
  }

  function reportClick(name, root) {
    clickProbe(name, root);
    uiSetStatus("点:" + name, root);
  }

  function bindClick(panel, name, fn) {
    if (!panel) return false;
    try {
      if (typeof panel.SetPanelEvent !== "function") return false;
      var handler = function (evName) {
        var root = rootOf(panel);
        // v1.9.29 (18:43 in-game "有翻译按钮但点击无反应"): the click had no
        // log line at all, so the handler never ran. Log the event name before
        // the guard - otherwise "event never arrived" and "guard swallowed it"
        // look identical from the outside.
        if (debugOn()) {
          try { $.Msg("[BBT] click " + name + " via " + evName + " root=" + (root ? instTag(root) : "(null)")); } catch{}
        }
        if (!uiGuard(root, "act:" + name, actionWindow(name))) {
          if (debugOn()) { try { $.Msg("[BBT] click " + name + " blocked by uiGuard"); } catch{} }
          return;
        }
        reportClick(name, root);
        try {
          // v1.9.31: tell dispatch() the guard is already satisfied for this
          // click (it re-checks under the same ledger key), otherwise the click
          // is swallowed with no log at all.
          G.__BBT_IN_HANDLER = name;
          try { fn(panel); } finally { G.__BBT_IN_HANDLER = null; }
        } catch (e){
          $.Msg("[BBT] handler " + name + " threw: " + e);
          uiSetStatus("错误:" + name, root);
        }
      };
      panel.SetPanelEvent("onactivate", function () { handler("onactivate"); });
      // CitadelButton in the engine's own rows is wired with `onmouseactivate`
      // (see the neighbouring BrowseBuildsButton etc. in the layout), and the
      // engine's activate path is what the game's buttons actually use. Bind
      // both: the uiGuard window absorbs the duplicate when they both fire.
      try { panel.SetPanelEvent("onmouseactivate", function () { handler("onmouseactivate"); }); } catch{}
      // Hit-test proof: if hovering does not log either, a sibling panel is
      // covering the button and no click can ever reach it.
      try {
        panel.SetPanelEvent("onmouseover", function () {
          if (uiWired["hov:" + name]) return;
          uiWired["hov:" + name] = true;
          if (debugOn()) { try { $.Msg("[BBT] hover " + name + " (hittest reaches the button)"); } catch{} }
        });
      } catch{}
      uiWired[name] = true;
      return true;
    } catch{
      return false;
    }
  }

  function onActivate(ids, fn, name, root) {
    return bindClick(uiPanelIn(root || contextPanel(), ids), name, fn);
  }

  function wireToolbar(root) {
    var scope = root || contextPanel();
    if (!scope) return false;
    try { wireHeaderButton(scope); } catch{}
    // v1.9.17 (T2 fix): the overview/category collapse must run in EVERY
    // context that carries a trigger, before the uiWiredOnce early return -
    // the flag belongs to whichever context wired first, and the overview
    // page's own embedded details context would otherwise keep a visible,
    // dead trigger under the engine's 出装选项 button (the v1.9.16 report).
    var trigger = uiPanelIn(scope, ["BBTTranslateButton", "BBTTranslateButton2"]);
    if (trigger && nestedInOverview(trigger)) {
      if (inBuildBrowser(trigger)) {
        // v1.9.26 R1: the browser overview page carries its own two-state
        // button. v1.9.17 T2 collapsed it there (the engine's 出装选项 button
        // owns the row and our trigger would sit under it); the unified
        // two-state model needs the control visible, so show + bind it.
        // BBTOnOverview is the CSS hook to shift it clear of the engine row
        // if the in-game geometry actually overlaps (R5: verify the click
        // lands - a stuck button means hittest occlusion, B1/B5 §6.6).
        try { trigger.AddClass("BBTOnOverview"); } catch{}
        try { trigger.style.visibility = "visible"; } catch{}
        try { trigger.hittest = true; } catch{}
        onActivate(["BBTTranslateButton", "BBTTranslateButton2"], function () { dispatch("translate", scope); }, "translate", scope);
        if (debugOn()) $.Msg("[BBT] trigger shown in overview context (" + instTag(scope) + ")");
      } else {
        // In-game embedded surfaces (category frames, embedded details page):
        // keep the v1.9.25 collapse + disable hit-testing; the engine's own
        // 出装选项 button owns the row there and the in-game header button
        // (#BBTTranslateButton3) is the two-state control for that page.
        // v1.9.17 (T2 fix): the overview/category collapse must run in EVERY
        // context that carries a trigger, before the uiWiredOnce early return.
        try { trigger.style.visibility = "collapse"; } catch{}
        try { trigger.hittest = false; } catch{}
        if (debugOn()) $.Msg("[BBT] trigger hidden in overview context (" + instTag(scope) + ")");
      }
      uiWiredOnce = true;
      return true;
    }
    if (uiWiredOnce) {
      if (debugOn() && !G.__BBT_WIRED_SKIP_LOGGED) {
        G.__BBT_WIRED_SKIP_LOGGED = true;
        $.Msg("[BBT] trigger wiring skipped in " + instTag(scope) + " (uiWiredOnce set by an earlier context)");
      }
      return true;
    }
    if (!trigger) return false;
    if (debugOn() && !G.__BBT_TRIGGER_ANCESTORS_LOGGED) {
      G.__BBT_TRIGGER_ANCESTORS_LOGGED = true;
      // One-shot B1-class diagnostic (v1.9.18): if the overview hide still
      // fails in game, this line shows the exact ancestor chain so the
      // nestedInOverview matcher can be fixed from the morning log instead
      // of by guessing the in-game tag spelling.
      var chain = [];
      var ap = trigger;
      for (var ad = 0; ap && ad < 16; ad += 1) {
        chain.push(String(ap.id || "?") + "|" + panelTag(ap));
        try { ap = ap.GetParent ? ap.GetParent() : null; } catch{ ap = null; }
      }
      $.Msg("[BBT] trigger ancestors: " + chain.join(" < "));
    }
    // v1.9.16: one plain trigger. The v1.9.15 dropdown (the
    // 原文/翻译/中英对照 modes) was dropped - in game it surfaced as a floating,
    // clipped list that looked like it appeared out of nowhere. The button now
    // does the job itself: click = translate this page (offline memory first,
    // bridge batch when a bridge is reachable, probing on demand). The bind
    // name stays "translate" so the XML's BBTActivate('translate', ...) and
    // this JS binding share one uiGuard key; the longer window tolerates the
    // onactivate/onmouseactivate pair plus a user's impatient double-click.
    onActivate(["BBTTranslateButton", "BBTTranslateButton2"], function () { dispatch("translate", scope); }, "translate", scope);
    uiWiredOnce = true;
    var n = Object.keys(uiWired).length;
    $.Msg("[BBT] toolbar wired: " + n + " control(s) in " + instTag(scope));
    // Debug aid for blind in-game verification: report where the manual button
    // actually sits in window coordinates, so the harness can click it directly.
    try {
      var posIds = ["BBTTranslateButton", "BBTTranslateButton2"];
      for (var pi = 0; pi < posIds.length; pi++) {
        var bp = scope.FindChildTraverse ? scope.FindChildTraverse(posIds[pi]) : null;
        if (!bp) continue;
        var pos = bp.GetPositionWithinWindow ? bp.GetPositionWithinWindow() : null;
        $.Msg("[BBT] button pos " + posIds[pi] + " " + (pos ? (pos.x + "," + pos.y) : "-") +
          " " + bp.actuallayoutwidth + "x" + bp.actuallayoutheight);
      }
    } catch (ePos) { try { $.Msg("[BBT] button pos failed: " + ePos); } catch {} }
    return true;
  }

  // The in-game build page (citadel_shop_mods_build.xml) carries one extra
  // button in the engine's own header row (#ControlButtons, the slot left of
  // the info icon). The same layout is embedded in the build browser, which has
  // its own toolbar, so the button must stay collapsed there. layoutRoot()
  // cannot tell them apart - in game it walks up to the HUD root - so look for
  // a CitadelBuildDetails ancestor instead: that is exactly what the browser
  // wraps the embedded page in.
  function nestedInDetails(panel) {
    var p = panel;
    for (var d = 0; p && d < 16; d += 1) {
      var tag = "";
      try { tag = String(p.id || "") + "|" + String(p.paneltype || p.tag || ""); } catch{ tag = ""; }
      if (tag.indexOf("BuildDetails") >= 0) return true;
      try { p = p.GetParent ? p.GetParent() : null; } catch{ p = null; }
    }
    return false;
  }

  var uiHeaderWired = false;
  // v1.9.16: overview / category surfaces embed the details layout, and there
  // the engine's own 出装选项 button stacks over ours and eats the click, so
  // the trigger is hidden on those surfaces. They are translated by the
  // polling scanner anyway (no button needed). A ≤16-step ancestor walk, the
  // same pattern as nestedInDetails: on the plain details page
  // BuildDetails_Overview is a SIBLING of #BuildControls, so only genuinely
  // embedded contexts (CitadelShopModsBuildCategory, the in-game category tab,
  // or a build list under BuildDetails_Overview) match.
  function nestedInOverview(panel) {
    var p = panel;
    for (var d = 0; p && d < 16; d += 1) {
      var tag = "";
      try { tag = String(p.id || "") + "|" + String(p.paneltype || p.tag || ""); } catch{ tag = ""; }
      // v1.9.20: HeroBuildSelector added - the build browser's overview embeds
      // the details layout under its selector root, and there our trigger sits
      // in the engine's own 出装选项 row (overlapping the 复制出装 dropdown).
      // The in-game shop page (CitadelShopModsBuild, no HeroBuildSelector in
      // the chain) keeps its button.
      if (tag.indexOf("CitadelShopModsBuildCategory") >= 0 || tag.indexOf("BuildDetails_Overview") >= 0 ||
          tag.indexOf("HeroBuildSelector") >= 0 || tag.indexOf("HeroBuildsSelector") >= 0) return true;
      try { p = p.GetParent ? p.GetParent() : null; } catch{ p = null; }
    }
    return false;
  }

  // R1 (v1.9.26): the BROWSER-only ancestor test. The same surfaces match
  // nestedInOverview, but only the HeroBuildsSelector chain un-collapses its
  // trigger (the browser needs the two-state button on the overview page);
  // the in-game category frames keep the v1.9.25 collapse (the engine's
  // 出装选项 button owns that row, the header button #3 is the control).
  function inBuildBrowser(panel) {
    var p = panel;
    for (var d = 0; p && d < 16; d += 1) {
      var tag = "";
      try { tag = String(p.id || "") + "|" + String(p.paneltype || p.tag || ""); } catch{ tag = ""; }
      if (tag.indexOf("HeroBuildSelector") >= 0 || tag.indexOf("HeroBuildsSelector") >= 0) return true;
      try { p = p.GetParent ? p.GetParent() : null; } catch{ p = null; }
    }
    return false;
  }

  function wireHeaderButton(scope) {
    if (uiHeaderWired) return true;
    var btn = uiPanelIn(scope, "BBTTranslateButton3");
    if (!btn) return false;
    uiHeaderWired = true;
    if (nestedInDetails(btn)) {
      $.Msg("[BBT] header button hidden (this layout is embedded in the build browser) in " + instTag(scope));
      return true;
    }
    try { btn.AddClass("BBTShow"); } catch{}
    try { btn.style.visibility = "visible"; } catch{}
    // v1.9.27 (field bug ③): the header button drives the SAME two-state
    // dispatch as the in-page trigger. It used to call translatePage(rootOf())
    // directly - that neither flipped the switch (the caption never became
    // 原文) nor reached the sibling category frames in their own contexts.
    // dispatch() flips the GLOBAL switch; every context's tick sync then
    // translates (or reverts) the whole page, and uiSetModeText() updates the
    // caption. The comment about $.GetContextPanel() burning the HUD scan
    // budget (v1.9.13) still applies: bindClick hands dispatch the real button
    // panel, so pageRoot()/tsKeyOf() resolve against the build page, not the HUD.
    bindClick(btn, "translate", function (panel) { dispatch("translate", panel); });
    $.Msg("[BBT] header button wired in " + instTag(scope));
    return true;
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

    // v1.9.16: the 原文/中英对照 mode UI was dropped together with the dropdown;
    // the display now always stays in zh mode. The mode variable and
  // the present()/applyMode() pipeline are kept so a future UI can re-add the
  // modes without touching the scanner.

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
        try { cur = p.text; } catch{ cur = null; }
        if (cur !== null && cur !== rec.in) {
          // Always restore the source text we translated: that is what "original"
          // means, and the token table is only a heuristic for engine labels.
          try { p.text = rec.in; } catch{}
        }
      }
      memo.delete(p);
      var n = 0;
      try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch{ n = 0; }
      for (var i = 0; i < n; i += 1) {
        try {
          var c = p.GetChild(i);
          if (c) stack.push(c);
        } catch{}
      }
    }
  }

  // Manual refresh: re-resolve every engine label (build name/description,
  // category headers) and translate the value for the build that is on screen.
  // It deliberately does NOT reset the memos: that restored the old source text
  // right after the #token had been re-applied, so the label was re-translated
  // from the previous build's English and the overview never changed.
  function refreshPage(root) {
    var scope = root || contextPanel();
    // Feedback lands on the trigger (the only always-visible control), the same
    // surface translate uses. The previous release wrote onto a dedicated refresh
    // button; the dropdown now holds that action, and a hidden menu item would
    // swallow the feedback.
    uiSetRefreshText("刷新中…", scope);
    // v1.9.25: the button must cover every category + item annotation on the
    // page, not just the last card - re-resolve up to 400 engine labels instead
    // of 80. This is the one-shot click path (never the periodic scanner), so
    // a higher limit costs nothing at idle.
    var n = 0;
    try { n = resyncAll(400, scope); } catch{ n = -1; }
    $.Msg("[BBT] refresh: re-resolved " + n + " engine label(s) in " + instTag(scope));
    uiSetRefreshText(n >= 0 ? "已刷新 " + n + " 条" : "刷新失败", scope);
    uiSetStatus("刷新 " + n + " 条", scope);
    $.Schedule(1.6, function () {
      uiResetLabel(scope);
    });
  }

  // The offline leg of the translate click: re-run the memory/glossary pass
  // over the whole page so the button visibly does something even without the
  // bridge. Whatever is still missing cannot be translated here (the memory
  // shipped inside the VPK is fixed) - say so on the control instead of
  // looking dead. noBridge: the on-demand probe just failed, so the "still
  // missing" readout names the bridge instead of the memory.
  function offlineTranslateFallback(scope, page, counts, texts, miss, noBridge) {
    // v1.9.29 bridge-first: with the memory disabled there is nothing this leg
    // can write. Say so plainly instead of running a pass that cannot change a
    // single label (that pass was the "翻了一部分" illusion).
    if (!offlineOn()) {
      $.Msg("[BBT] translate: scanned=" + counts.scanned + " wrote=0 already=" + counts.already +
        " miss=" + miss + " scope=" + instTag(scope) + " (offline memory off; bridge not connected)");
      uiSetLabel("桥未连接(" + miss + " 条缺)", scope);
      uiSetStatus("桥未连接", scope);
      $.Schedule(3.0, function () { uiResetLabel(scope); });
      return;
    }
    var before = stats.translated + stats.fallback;
    try { if (page) resetMemos(page); } catch{}
    uiSetLabel("重新翻译中…", scope);
    uiSetStatus("翻译中", scope);
    $.Schedule(0.5, function () {
      var done = stats.translated + stats.fallback - before;
      $.Msg("[BBT] translate: scanned=" + counts.scanned + " wrote=" + done + " already=" + counts.already +
        " miss=" + miss + " scope=" + instTag(scope) +
        (noBridge ? " (bridge unavailable)" : (texts.length ? "" : " (no bridge configured)")));
      if (noBridge && done === 0 && miss > 0) {
        uiSetLabel("桥未连接(" + miss + " 条缺)", scope);
        uiSetStatus("桥未连接", scope);
      } else if (done > 0) {
        uiSetLabel("已译 " + done + " 条", scope);
        uiSetStatus("已译 " + done + " 条", scope);
      } else {
        uiSetLabel("无新译文(" + miss + " 条缺)", scope);
        uiSetStatus("缺 " + miss + " 条", scope);
      }
    });
    $.Schedule(3.5, function () { uiResetLabel(scope); });
  }

  // The main button: "translate everything on this page that we do not know yet".
  function translatePage(root) {
    if (ui.busy) {
      // v1.9.18 self-heal: a lost bridge callback must not block the button
      // forever - the lock expires after 15s.
      var stale = 0;
      try { stale = nowMs(); } catch{}
      // No clock, or no busy timestamp, or a stale lock -> release. Only a
      // *live* lock (with a working clock) keeps the button quiet.
      // v1.9.31: 15s of a silently-locked button is what the user experiences as
      // "clicked, nothing happened, not even a log line". Heal after 8s and
      // always leave a trace so the branch can never be silent again.
      var age = ui.busySince ? (stale - ui.busySince) : -1;
      if (!ui.busySince || stale <= 0 || age > 8000) {
        try { $.Msg("[BBT] translate: busy lock healed (age=" + age + "ms)"); } catch{}
        ui.busy = false;
      } else {
        try { $.Msg("[BBT] translate: skipped, batch already in flight (age=" + age + "ms)"); } catch{}
        return;
      }
    }
    var scope = root || contextPanel();
    var page = pageRoot(scope);
    var counts = { scanned: 0, already: 0 };
    // v1.9.23: 24 filled up on the last card's annotations alone. The batch
    // sender chunks at UI_BATCH / LIVE_BATCH_CHARS, so a larger pool is still
    // safe for the document.title channel - it just takes more chunks.
    // v1.9.25: 800 (was 160) so every category's description + the item
    // annotations across all categories are collected, not truncated to the
    // last few cards. The batch sender still chunks at UI_BATCH / LIVE_BATCH_CHARS.
    var texts = collectMisses(2000, page, counts);
    var miss = texts.length;
    if (!texts.length) {
      uiSetLabel("没有需要翻译的文本", scope);
      uiSetStatus("无可翻译文本", scope);
      $.Msg("[BBT] translate: scanned=" + counts.scanned + " wrote=0 already=" + counts.already + " miss=0 scope=" + instTag(scope));
      $.Schedule(2.0, function () { uiResetLabel(scope); });
      return;
    }
    if (live.state !== "on") {
      // v1.9.16: bridge probe on demand. The boot probe runs once; if the user
      // started the bridge afterwards, this click re-scans 8792/8793 and the
      // batch goes through it without restarting the game. While the probe is in
      // flight we hand the page to the offline pass (below) and wait for the
      // settled flag before sending the batch.
      if (texts.length && liveMode() !== "off") {
        liveReprobe();
        uiSetLabel("正在连接桥…", scope, 1.6);
        uiSetStatus("连接桥中", scope);
        liveWaitSettled(function () {
          if (live.state === "on") {
            uiRequestBatch(texts, function (results, err) {
              var applied = results ? uiApplyResults(results) : 0;
              if (err) {
                uiSetLabel("桥不可用(" + err + ")", scope);
              } else {
                uiSetLabel("已翻译 " + applied + " 条", scope);
                uiSetStatus("已翻译 " + applied + " 条", scope);
                try { liveUpgradeWeakWrites(); } catch{}
              }
              $.Msg("[BBT] translate: scanned=" + counts.scanned + " wrote=" + applied +
                " already=" + counts.already + " miss=" + Math.max(0, texts.length - applied) +
                " scope=" + instTag(scope) + " (reprobe)");
              $.Schedule(4.0, function () { uiResetLabel(scope); });
            });
          } else {
            // Probe finished, still down: run the offline pass and tell the
            // user plainly that the bridge is not reachable.
            offlineTranslateFallback(scope, page, counts, texts, miss, true);
          }
        });
        return;
      }
      offlineTranslateFallback(scope, page, counts, texts, miss);
      return;
    }
    ui.busy = true;
    ui.busySince = nowMs();
    uiSetLabel("翻译中… " + texts.length, scope);
    uiSetStatus("翻译中 " + texts.length, scope);
    uiRequestBatch(texts, function (results, err) {
      ui.busy = false;
      var applied = results ? uiApplyResults(results) : 0;
      if (err) {
        uiSetLabel("翻译失败: " + err, scope);
        uiSetStatus("翻译失败", scope);
      } else {
        uiSetLabel("已翻译 " + applied + " 条", scope);
        uiSetStatus("已翻译 " + applied, scope);
        // New translations may unlock panels we had memoised as "nothing found".
        try { liveUpgradeWeakWrites(); } catch{}
      }
      $.Msg("[BBT] translate: scanned=" + counts.scanned + " wrote=" + applied + " already=" + counts.already + " miss=" + Math.max(0, texts.length - applied) + " scope=" + instTag(scope));
      $.Schedule(4.0, function () { uiResetLabel(scope); });
    });
  }

  function setTargetLang(lang, root) {
    if (!lang || typeof lang !== "string") return;
    TARGET_LANG = lang;
    settingsSet(LANG_KEY, TARGET_LANG);
    overrides = null;
    try { var r = pageRoot(root); if (r) resetMemos(r); } catch{}
    // Non-Chinese targets come from the local table / bridge only.
    if (LIVE_TARGET && LIVE_TARGET.tag === "BBT") {
      try { liveFetchOverrides(); } catch{}
    }
    uiSetLabel("语言:" + TARGET_LANG, root);
    $.Msg("[BBT] target language -> " + TARGET_LANG);
  }

  // Dropdown: push what is on screen into the local table (NO network call).
  // It sends the pairs it already has, so this works even when the bridge cannot
  // reach a provider.
  function savePageToTable(root) {
    if (live.state !== "on" || !LIVE_TARGET || LIVE_TARGET.tag !== "BBT") {
      uiSetLabel("本地库需要本仓库的 bridge", root);
      $.Schedule(2.5, function () { uiSetLabel("翻译", root); });
      return;
    }
    var pairs = [];
    try {
      var ctx = pageRoot(root);
      if (!ctx) ctx = contextPanel();
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
          try { cur = p.text; } catch{ cur = null; }
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
        try { n = p.GetChildCount ? p.GetChildCount() : 0; } catch{ n = 0; }
        for (var i = 0; i < n; i += 1) {
          try {
            var c = p.GetChild(i);
            if (c) stack.push(c);
          } catch{}
        }
      }
    } catch{}
    if (!pairs.length) {
      uiSetLabel("本页没有可存的译文", root);
      $.Schedule(2.5, function () { uiSetLabel("翻译", root); });
      return;
    }
    liveSend(
      { kind: "remember", pairs: pairs, target: TARGET_LANG },
      LIVE_REQUEST_TIMEOUT,
      function (ok, err, res) {
        if (ok && res) {
          uiSetLabel("已存入本地库:新增 " + (res.added || 0) + " 条", root);
          stats.batchAdded += res.added || 0;
          noteTableSize(res.table);
        } else {
          uiSetLabel("存入失败: " + err, root);
        }
      $.Schedule(3.0, function () { uiSetLabel("翻译", root); });
      },
      LIVE_TARGET,
    );
  }

  function showTableStats(root) {
    var provider = stats.liveProvider ? (" / provider=" + stats.liveProvider) : "";
    uiSetLabel(
      "条目 " + (stats.tableEntries || 0) + " · 别名 " + (stats.tableAliases || 0) +
        " · 本次实时 " + stats.live + provider,
      root,
    );
    $.Schedule(4.0, function () { uiSetLabel("翻译", root); });
  }

  // ---- handler dispatch ---------------------------------------------------
  // One entry point for everything the layout declares:
  //   onactivate="BBTActivate('refresh', $.GetContextPanel());"
  // The clicked panel is passed in as the instance hint, so the action lands in
  // the tree the user is looking at even when another layout owns the globals.
  function dispatch(action, origin) {
    if (!action) return;
    var root = rootOf(origin);
    // v1.9.31: bindClick() already ran the guard for THIS click, under the same
    // ledger key ("act:"+action). Running it a second time always saw the
    // timestamp the handler had just written, so every click died here without
    // a single log line - the user's "按钮在那、点了没反应".
    var inHandler = null;
    try { inHandler = G.__BBT_IN_HANDLER; } catch{ inHandler = null; }
    if (inHandler !== action && !uiGuard(root, "act:" + action, actionWindow(action))) return;
    reportClick(action, root);
    try {
      if (action === "translate") {
        // v1.9.26 unified two-state button (R1/R2): the caption always names
        // the NEXT action. 翻译 click: translate the WHOLE page - list +
        // overview + every category frame; the shared key makes every context
        // that owns the page honour the flip on its next fast tick - and the
        // caption becomes 原文. 原文 click: put the original text back in
        // place, caption becomes 翻译. All surfaces share this path (browser
        // toolbar #2, embedded trigger, in-game header #3): the page key comes
        // from the clicked panel, not from which button fired. This replaces
        // the v1.9.17 text-sniffing toggle (the label was the state, lost on
        // every 3.5s caption reset - the user's R2 "点了不切换" bug).
        var page = pageRoot(root);
        var key = "";
        try { key = tsKeyOf(root); } catch{ key = ""; }
        var isZht = key !== "" && tsMode(key) === "zh";
        if (isZht) {
          tsSet(key, "orig");
          resetMemos(page); // my own writes now; the other contexts revert on
          // their next tick via the shared version bump (the tick sync above)
          displayOrig.set(page, 1); // legacy per-context scanner gates:
          displayOrig.set(root, 1); // alias: the context panel of the clicked instance
          if (origin) displayOrig.set(origin, 1); // the scanner gate key (context panel)
          uiSetModeText("翻译", root); // next action = translate
          if (debugOn()) $.Msg("[BBT] two-state global: 原文 (key=" + key + ", ctx=" + instTag(root) + ", ver=" + tsVerNow() + ")");
          return;
        }
        if (key) tsSet(key, "zh");
        displayOrig.delete(page);
        displayOrig.delete(root);
        if (origin) displayOrig.delete(origin); // the scanner gate key (context panel)
        uiSetModeText("原文", root); // next action = show original; the async
        // feedback (正在连接桥…/已译 N 条) overrides it while running
        // v1.9.18: re-resolve the engine labels (build title / description /
        // annotations) for the build that is on screen NOW before the bridge
        // batch - a hero/build switch that left the title stale is what the
        // user sees as "点了翻译没用". refreshPage's 刷新中…/已刷新 N 条
        // feedback is immediately followed by the translate feedback.
        try { refreshPage(root); } catch{}
        translatePage(root);
        if (debugOn()) $.Msg("[BBT] two-state global: 翻译 (key=" + key + ", ctx=" + instTag(root) + ", ver=" + tsVerNow() + ")");
        return;
      }
      else if (action === "refresh") refreshPage(root);
      else if (action.indexOf("hover") === 0) return; // status only
      else if (action.indexOf("lang:") === 0) setTargetLang(action.slice(5), root);
      else if (action === "save") savePageToTable(root);
      else if (action === "stats") showTableStats(root);
      else $.Msg("[BBT] unknown action " + action);
    } catch (e){
      $.Msg("[BBT] action " + action + " threw: " + e);
      uiSetStatus("错误:" + action, root);
    }
  }

  // XML attributes are evaluated in the panel's *script scope*, so the handler
  // must exist there (this is why v1.9.7's bare onactivate="BBTRefreshPage()"
  // never fired: the function lived inside this IIFE and was invisible to the
  // panel scope). Three nets, each isolated so one failure cannot skip the rest:
  //   1. the script global object (what a bare `Name()` resolves against),
  //   2. the `$` object, for builds that expose `$.Name()`,
  //   3. $.GetContextObject() — the documented "context object" that is used as
  //      the script context when evaluating code embedded in panel tags.
  // BabelTower (the other long-lived Deadlock Panorama mod here) lost a whole
  // session's buttons to one exception that skipped its export lines, so every
  // assignment below is try/catch'd and the result is collected: boot() reports
  // a missing handler on the visible status line instead of dying silently.
  var exposedOk = {};
  function expose(name, fn) {
    var ok = false;
    try {
      G[name] = fn;
      ok = typeof G[name] === "function";
    } catch{ ok = false; }
    try {
      if (typeof $ !== "undefined" && $) $[name] = fn;
    } catch{}
    try {
      if (typeof $ !== "undefined" && $ && typeof $.GetContextObject === "function") {
        var ctxObj = $.GetContextObject();
        if (ctxObj) {
          ctxObj[name] = fn;
          if (typeof ctxObj[name] === "function") ok = true;
        }
      }
    } catch{}
    exposedOk[name] = ok;
    return ok;
  }

  expose("BBTActivate", dispatch);
  expose("BBTTranslatePage", translatePage);
  expose("BBTRefreshPage", refreshPage);
  // v1.9.16 removed the mode UI; the scanner stays in zh mode (see above).
  // BBTSetLanguageMode is no longer exposed.
  expose("BBTSetTargetLang", setTargetLang);
  expose("BBTSavePageToTable", savePageToTable);
  expose("BBTShowTableStats", showTableStats);

  function missingHandlers() {
    var out = [];
    for (var k in exposedOk) {
      if (!exposedOk[k]) out.push(k);
    }
    return out;
  }

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
    } catch{}
    bootLayoutTag = layoutTag;
    notesOnlySurface = layoutTag === "CitadelTooltipModDetails";
    // The build-details layout is reused as a hover tooltip (hittest=false).
    // A toolbar there can never be clicked, it would only sit on top of the
    // tooltip, so hide it.
    var isTooltip = false;
    try {
      var up = ctx;
      for (var d = 0; up && d < 10; d += 1) {
        var upt = "";
        try { upt = String(up.paneltype || ""); } catch{ upt = ""; }
        var upc = "";
        try {
          if (panelHasClass(up, "BuildDetailsTooltip")) upc = "BuildDetailsTooltip";
          if (!upc) upc = String(up.class || "");
        } catch{ upc = ""; }
        if (upt.indexOf("TooltipBuildDetails") >= 0 || upc.indexOf("BuildDetailsTooltip") >= 0) {
          isTooltip = true;
          // Collapse the toolbar wrapper + every button: the hover tooltip
          // reuses this layout but its buttons can never be clicked.
          var toolbarIds = ["BBTTranslateButton2", "BBTTranslateButton"];
          for (var ti = 0; ti < toolbarIds.length; ti += 1) {
            var tb = uiPanelIn(ctx, toolbarIds[ti]);
            if (tb && tb.style) tb.style.visibility = "collapse";
          }
          // Permanent B1/B5 instrumentation: proves in the morning log that the
          // hover-tooltip surface really gets its toolbar hidden (v1.9.6 never
          // hid it - the class check failed on the wrong API).
          if (debugOn()) $.Msg("[BBT] toolbar hidden in tooltip context (" + (upt || upc) + ")");
          break;
        }
        try { up = up.GetParent ? up.GetParent() : null; } catch{ up = null; }
      }
    } catch{}
    // B5 instrumentation (permanent, BBT_DEBUG-gated): dump the toolbar's own
    // visibility and first layout sizes so the morning log shows whether the
    // toolbar exists but is clipped/hidden on a given surface.
    if (debugOn()) {
      var tc2 = uiPanel("BBTTranslateButton2");
      if (tc2) {
        var gv = "?";
        try { gv = tc2.style ? String(tc2.style.visibility) : "?"; } catch{ gv = "?"; }
        $.Msg(
          "[BBT] toolbar-geom " +
            "vis=" + gv +
            " actual=" + (function () { try { return tc2.actualwidth + "x" + tc2.actualheight; } catch{ return "?"; } })() +
            " tag=" + (function () { try { return tc2.tag; } catch{ return "?"; } })()
        );
      } else {
        $.Msg("[BBT] toolbar-geom none in this layout");
      }
    }
    if (debugOn() && !G.__BBT_RECT_DONE) probeRects(ctx);
    // The tag tells you WHICH layout actually carries the scanner; use it with
    // -condebug to check that every layout surface that shows player text is
    // really covered (e.g. a game update may spawn a new out-of-tree layout).
    var bootRoot = layoutRoot(ctx);
    // v1.9.25 two-state manual page: the build-details page defaults to the
    // ORIGINAL text. The 翻译/原文 trigger (BBTTranslateButton2) is the only
    // way in or out of the translated state - click 翻译 to translate every
    // category + item annotation on the page, click 原文 to put it back. The
    // transient hover tooltip reuses this layout but must keep auto-translating,
    // so it is excluded (isTooltip). See tick()'s manual branch + dispatch().
    if (!isTooltip && layoutTag === "CitadelBuildDetails") {
      try {
        manualMode.set(ctx, 1);
        displayOrig.set(ctx, 1); // default: show the original text
        var mp = pageRoot(ctx);
        if (mp) displayOrig.set(mp, 1);
        if (bootRoot) displayOrig.set(bootRoot, 1);
        uiSetModeText("翻译", bootRoot); // resting label: next action = translate
      } catch{}
      // v1.9.27 (R1): entering the details page starts on the ORIGINAL text.
      // The global switch is shared by every context (one per process), so a
      // leftover 翻译 from a previous page/surface would carry over; reset it
      // here, the only user-facing "page entry" boots (the in-game embedded
      // frames boot once at login and must NOT reset a live switch). Every
      // context's tick sync picks the bump up within one fast tick.
      try {
        var gsw = twoStateGlobal();
        if (gsw && gsw.on) {
          gsw.on = false;
          gsw.ver = (gsw.ver || 0) + 1;
        }
      } catch{}
      if (debugOn()) $.Msg("[BBT] manual two-state armed on " + instTag(bootRoot) + " (default 原文, global reset)");
    }
    var missing = missingHandlers();
    stats.offline = offlineOn() ? "on" : "off";
    $.Msg(
      "[BBT] v" + VERSION + " loaded (tm=" + tmCount + ", glossary=" + (GLOSS ? 1 : 0) +
        ", offline=" + (offlineOn() ? "on" : "off") + ") in layout: " + (layoutTag || "?") + " root=" + instTag(bootRoot)
    );
    if (!offlineOn()) {
      // One line so a "nothing is translated" report is immediately attributable
      // to the bridge rather than to the shipped memory.
      $.Msg("[BBT] offline memory: disabled (bridge-first mode); set BBT_TM=\"on\" to re-enable");
    }
    if (missing.length) {
      // This is the "button is not defined" failure: the layout will call a name
      // that does not exist, and the click dies before any of our code runs.
      // uiSetStatus appends the warning to every later status write too, so the
      // wiring pass below cannot hide it behind "接线 N 项".
      handlerMissingNames = missing;
      $.Msg("[BBT] HANDLER EXPORT FAILED: " + missing.join(","));
      uiSetStatus("缺少:" + missing.join(","), bootRoot);
    } else {
      uiSetStatus("v" + VERSION + " 启动中", bootRoot);
    }
    $.Schedule(0.05, tick);
    // Probe the optional bridge a moment later so it never delays first paint.
    if (liveMode() !== "off") $.Schedule(1.2, liveProbe);
    // The toolbar lives in the details layout; retry while the engine is still
    // creating panels (a freshly created layout may not expose its buttons until
    // the first layout pass).
    var wireTries = 0;
    (function wire() {
      try { wireToolbar(bootRoot); } catch (e){ $.Msg("[BBT] wire threw: " + e); }
      wireTries += 1;
      if (wireTries < 12 && (!uiWiredOnce || wireTries < 8)) $.Schedule(0.5, wire);
    })();
  }

  G.BBT_STATS = stats;
  G.BBT_VERSION = VERSION;
  boot();
})();
