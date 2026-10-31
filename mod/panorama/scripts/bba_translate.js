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
// and write the Chinese string back. No network access is used or needed
// (Panorama removed AsyncWebRequest); everything ships inside the VPK.
// ------------------------------------------------------------------
(function () {
  "use strict";

  var VERSION = "1.2.0";
  var DEBUG = false;
  var POLL_INTERVAL = 0.15; // seconds between scans while something changes
  var IDLE_MAX_INTERVAL = 1.0; // back off to this when the tree is quiet
  var IDLE_TICKS_BEFORE_BACKOFF = 6;
  var SCAN_BUDGET = 6000; // panels visited per tick
  var TERM_FALLBACK_MAX = 160; // only short labels get glossary substitution
  // Unseen English text is logged as "[BBT] MISS <key> <text>" so
  // tools/collect_new_texts.js can harvest it and grow the translation memory.
  var COLLECT_MISSES = true;
  var MISS_CAP = 300; // per layout instance and session

  var G = globalThis || this || {};
  var GLOSS = G.BBA_GLOSSARY || null;
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

  function lookup(raw) {
    if (typeof G.BBA_TM_GET !== "function" && !G.BBA_TM) return null;
    var flat = flatten(raw);
    if (!flat) return null;
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

  var stats = { translated: 0, fallback: 0, scanned: 0, misses: 0, ms: 0, interval: 0 };
  // Write only when the label currently shows something else. Comparing against
  // the live text (instead of a "last written" cache) is what makes the scanner
  // re-apply after the engine resets a label to its original English on refresh.
  function writeText(panel, value) {
    var current;
    try { current = panel.text; } catch (e) { return false; }
    if (typeof current === "string" && current === value) return false;
    try {
      panel.text = value;
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
    if (raw.indexOf("#") === 0) {
      // localization token, already localized by the game
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
        if (raw === seen.in) return;
      } else if (raw === seen.out) {
        return;
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
      if (writeText(panel, display)) {
        stats.translated += 1;
        if (DEBUG) $.Msg("[BBT] TM " + raw.slice(0, 40));
      }
      remember(panel, 1, raw, display);
      return;
    }

    noteMiss(raw, panel);

    var mixed = null;
    if (normalize(raw).length <= TERM_FALLBACK_MAX) {
      mixed = substituteTerms(raw);
      if (mixed && writeText(panel, mixed)) {
        stats.fallback += 1;
        if (DEBUG) $.Msg("[BBT] term " + raw.slice(0, 40));
      }
    }
    if (mixed) remember(panel, 1, raw, mixed);
    else remember(panel, 0, raw, null);
  }

  var lastVisited = 0;

  function scan(root) {
    var stack = [root];
    var visited = 0;
    var fresh = 0;
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
      if (typeof t === "string" && t.length >= 2) {
        if (!isTextEntry(p)) translatePanel(p, t);
        else if (!known) remember(p, 0, t, null);
      } else if (!known) {
        remember(p, 0, null, null);
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
          if (c) stack.push(c);
        } catch (e) {}
      }
    }
    stats.scanned += visited;
    lastVisited = visited;
    return fresh;
  }

  // Adaptive polling: a freshly painted layout (new build, opened tooltip) is
  // rescanned every POLL_INTERVAL; a quiet one backs off to IDLE_MAX_INTERVAL.
  // This is what keeps the mod from walking thousands of panels 6-7 times a
  // second forever while the player is just looking at a screen.
  var interval = POLL_INTERVAL;
  var idleTicks = 0;

  function tick() {
    var t0 = Date.now ? Date.now() : 0;
    var before = stats.translated + stats.fallback;
    var fresh = 0;
    try {
      var ctx = $.GetContextPanel();
      if (ctx && panelVisible(ctx)) fresh = scan(ctx);
    } catch (e) {}
    var worked = stats.translated + stats.fallback > before || fresh > 0;
    if (worked) {
      idleTicks = 0;
      interval = POLL_INTERVAL;
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

  function boot() {
    buildTermRegex();
    // bba_tm.js publishes the entry count; counting 58k keys at boot would stall
    // the UI for tens of milliseconds on every layout instance.
    var tmCount = G.BBA_TM_COUNT || 0;
    var layoutTag = "";
    try {
      var ctx = $.GetContextPanel();
      if (ctx && ctx.tag) layoutTag = String(ctx.tag);
    } catch (e) {}
    // The tag tells you WHICH layout actually carries the scanner; use it with
    // -condebug to check that every layout surface that shows player text is
    // really covered (e.g. a game update may spawn a new out-of-tree layout).
    $.Msg("[BBT] v" + VERSION + " loaded (tm=" + tmCount + ", glossary=" + (GLOSS ? 1 : 0) + ") in layout: " + (layoutTag || "?") + "");
    $.Schedule(0.05, tick);
  }

  G.BBT_STATS = stats;
  G.BBT_VERSION = VERSION;
  boot();
})();
