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

  var VERSION = "1.0.0";
  var DEBUG = false;
  var POLL_INTERVAL = 0.15; // seconds between scans
  var SCAN_BUDGET = 6000; // panels visited per tick
  var TERM_FALLBACK_MAX = 160; // only short labels get glossary substitution

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

  function lookup(raw) {
    var tm = G.BBA_TM;
    if (!tm) return null;
    var flat = flatten(raw);
    if (!flat) return null;
    var candidates = [flat];
    var noSuffix = flat.replace(COPY_SUFFIX, "");
    if (noSuffix && noSuffix !== flat) candidates.push(noSuffix);
    if (/<[^>]+>/.test(flat)) {
      // Some labels are html=true and wrap the user text in markup.
      var plain = flatten(flat.replace(/<[^>]+>/g, " "));
      candidates.push(plain);
      var plainNoSuffix = plain.replace(COPY_SUFFIX, "");
      if (plainNoSuffix && plainNoSuffix !== plain) candidates.push(plainNoSuffix);
    }
    for (var i = 0; i < candidates.length; i += 1) {
      var hit = tm[keyOf(candidates[i])];
      if (hit) return hit;
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

  var stats = { translated: 0, fallback: 0, scanned: 0 };

  function isTextEntry(panel) {
    try {
      if (typeof panel.placeholder === "string") return true;
      if (typeof panel.maxchars === "number") return true;
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

  function translatePanel(panel) {
    var raw;
    try {
      raw = panel.text;
    } catch (e) {
      return;
    }
    if (typeof raw !== "string" || raw.length < 2) return;
    if (raw.indexOf("#") === 0) return; // localization token, already localized by the game

    // Look the text up first: duplicated builds carry a Chinese "(copy)" suffix,
    // and lookup strips it before hashing.
    var hit = lookup(raw);
    if (hit) {
      try {
        panel.text = hit;
        stats.translated += 1;
        if (DEBUG) $.Msg("[BBT] TM " + raw.slice(0, 40));
      } catch (e) {}
      return;
    }

    if (/[\u3400-\u9fff]/.test(raw)) return; // already Chinese (or mixed with Chinese)

    if (normalize(raw).length <= TERM_FALLBACK_MAX) {
      var mixed = substituteTerms(raw);
      if (mixed) {
        try {
          panel.text = mixed;
          stats.fallback += 1;
          if (DEBUG) $.Msg("[BBT] term " + raw.slice(0, 40));
        } catch (e) {}
      }
    }
  }

  function scan(root) {
    var stack = [root];
    var visited = 0;
    while (stack.length && visited < SCAN_BUDGET) {
      var p = stack.pop();
      visited += 1;
      if (!p) continue;
      try {
        if (p.IsValid && !p.IsValid()) continue;
      } catch (e) {
        continue;
      }
      if (!isTextEntry(p)) translatePanel(p);
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
  }

  function tick() {
    try {
      var ctx = $.GetContextPanel();
      if (ctx && panelVisible(ctx)) scan(ctx);
    } catch (e) {}
    $.Schedule(POLL_INTERVAL, tick);
  }

  function boot() {
    buildTermRegex();
    var tmCount = 0;
    if (G.BBA_TM) {
      try {
        tmCount = Object.keys(G.BBA_TM).length;
      } catch (e) {}
    }
    $.Msg("[BBT] v" + VERSION + " loaded (tm=" + tmCount + ", glossary=" + (GLOSS ? 1 : 0) + ")");
    $.Schedule(0.05, tick);
  }

  G.BBT_STATS = stats;
  G.BBT_VERSION = VERSION;
  boot();
})();
