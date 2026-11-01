// own_chrome_simtest.js - regression guard for "our UI is not game text".
//
// Why this exists: tools/collect_new_texts.js harvests every "[BBT] MISS <key>
// <text>" console line, tools/build_tm.js machine-translates those into
// mod/panorama/scripts/bba_tm.js, and long-lived rows are written back into the
// labels they came from. Our own toolbar chrome is written by bba_translate.js,
// not by the game, so it must never enter that pipeline:
//   * "act:mode:next@<ms>" (the click de-duplication marker) has no CJK, so
//     without the guard it is harvested, translated, and then written back -
//     the stamp stops parsing, the two activation paths of one click are no
//     longer de-duplicated, and the mode button advances two steps per click;
//   * the mode button captions are CJK ("中"/"原"/"双"), already shielded by
//     the scanner's CJK early-out, but tagging them makes the guarantee
//     explicit and testable;
//   * every click would burn one of the 300 MISS slots real build text needs.
//
// The fix has two halves that must both stay: layouts tag the chrome with
// class="BBTNoTranslate", and the script skips those panels in scan(),
// translatePanel() and noteMiss().
"use strict";

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var JS = path.join(ROOT, "mod", "panorama", "scripts", "bba_translate.js");
var XML = path.join(ROOT, "mod", "panorama", "layout", "citadel_ui_build_details.xml");

var js = fs.readFileSync(JS, "utf8");
var xml = fs.readFileSync(XML, "utf8");

var checks = 0;
var failures = 0;
function check(name, ok) {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log("FAIL " + name);
  } else {
    console.log("ok   " + name);
  }
}

function count(hay, needle) {
  var n = 0;
  var i = hay.indexOf(needle);
  while (i >= 0) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

// Attributes of the element that owns id="<id>" (single-tag, no nesting needed).
function attrsOf(id) {
  var m = new RegExp('<[A-Za-z][^>]*\\bid="' + id + '"[^>]*>').exec(xml);
  return m ? m[0] : null;
}
function classOf(id) {
  var el = attrsOf(id);
  if (!el) return null;
  var c = /class="([^"]*)"/.exec(el);
  return c ? c[1] : "";
}
function isNoTranslate(id) {
  var cls = classOf(id);
  return !!cls && /(^|\s)BBTNoTranslate(\s|$)/.test(cls);
}

// ---- layout half: the chrome carries BBTNoTranslate ----------------------
check("details.xml has BBTControls2", !!attrsOf("BBTControls2"));
check("BBTControls2 (toolbar wrapper) is BBTNoTranslate", isNoTranslate("BBTControls2"));
check("BBTTranslateButton2 is BBTNoTranslate", isNoTranslate("BBTTranslateButton2"));
check("BBTRefreshButton2 is BBTNoTranslate", isNoTranslate("BBTRefreshButton2"));
check("BBTModeButton2 is BBTNoTranslate", isNoTranslate("BBTModeButton2"));
check("BBTActMark2 (dedupe marker) is BBTNoTranslate", isNoTranslate("BBTActMark2"));

// The three buttons sit inside BBTControls2 (no dropdown), and their captions
// are our CJK literals, never game #Token text.
var controlsIdx = xml.indexOf('id="BBTControls2"');
check(
  "the three buttons are inside BBTControls2",
  controlsIdx >= 0
    && xml.indexOf('id="BBTTranslateButton2"') > controlsIdx
    && xml.indexOf('id="BBTRefreshButton2"') > controlsIdx
    && xml.indexOf('id="BBTModeButton2"') > controlsIdx
);
check(
  "button captions are our literals (翻译/刷新/中), no #Token",
  xml.indexOf('text="翻译"') > controlsIdx
    && xml.indexOf('text="刷新"') > controlsIdx
    && xml.indexOf('text="中"') > controlsIdx
);

// ---- script half: the guard exists at every write entry point ------------
check("isOwnChrome() is defined", /function isOwnChrome\s*\(/.test(js));
check(
  "isOwnChrome() tests the BBTNoTranslate class",
  /panelHasClass\(\s*panel\s*,\s*"BBTNoTranslate"\s*\)/.test(js)
);
check(
  "scan() skips own chrome",
  /if \(isOwnChrome\(p\)\) continue;/.test(js)
);
check(
  "translatePanel() returns early for own chrome",
  /function translatePanel\(panel, preRead\) \{[\s\S]{0,400}?if \(isOwnChrome\(panel\)\) return;/.test(js)
);
check(
  "noteMiss() refuses own chrome",
  /function noteMiss\(raw, panel\) \{[\s\S]{0,400}?if \(panel && isOwnChrome\(panel\)\) return;/.test(js)
);
check(
  "own-chrome guard is used in all three places (plus definition)",
  count(js, "isOwnChrome(") >= 4
);

// ---- the hover tooltip must hide the whole bar, not just the buttons ------
check(
  "boot() collapses BBTControls2 in the hover tooltip",
  /uiPanelIn\(ctx, \["BBTControls2", "BBTControls"\]\)/.test(js)
);

// ---- harvest pipeline reminder ------------------------------------------
check(
  "collect_new_texts.js still harvests from [BBT] MISS lines only",
  /\[BBT\] MISS/.test(
    fs.readFileSync(path.join(ROOT, "tools", "collect_new_texts.js"), "utf8")
  )
);

console.log("");
if (failures) {
  console.log(failures + " of " + checks + " OWN CHROME CHECKS FAILED");
  process.exit(1);
}
console.log("ALL OWN CHROME CHECKS PASSED (" + checks + " checks)");
