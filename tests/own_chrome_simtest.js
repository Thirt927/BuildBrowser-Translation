// own_chrome_simtest.js - regression guard for "our UI is not game text".
//
// Why this exists: tools/collect_new_texts.js harvests every "[BBT] MISS <key>
// <text>" console line, tools/build_tm.js machine-translates those into
// mod/panorama/scripts/bba_tm.js, and long-lived rows are written back into the
// labels they came from. Our own toolbar chrome is written by bba_translate.js,
// not by the game, so it must never enter that pipeline:
//   * "act:menu:toggle@<ms>" (the click de-duplication marker) has no CJK, so
//     without the guard it is harvested, translated, and then written back -
//     the stamp stops parsing, the two activation paths of one click are no
//     longer de-duplicated, and the menu opens twice per click;
//   * the trigger/menu captions are CJK ("原文"/"翻译"/"中英对照"), already
//     shielded by the scanner's CJK early-out, but tagging them makes the
//     guarantee explicit and testable;
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
check("details.xml has the dropdown trigger", !!attrsOf("BBTTranslateButton2"));
check("BBTTranslateButton2 (trigger) is BBTNoTranslate", isNoTranslate("BBTTranslateButton2"));
check("BBTMenu2 (dropdown) is BBTNoTranslate", isNoTranslate("BBTMenu2"));
check("BBTMenuOrig is BBTNoTranslate", isNoTranslate("BBTMenuOrig"));
check("BBTMenuZh is BBTNoTranslate", isNoTranslate("BBTMenuZh"));
check("BBTMenuBoth is BBTNoTranslate", isNoTranslate("BBTMenuBoth"));
check("BBTMenuRefresh is BBTNoTranslate", isNoTranslate("BBTMenuRefresh"));
check("BBTMenuSave is BBTNoTranslate", isNoTranslate("BBTMenuSave"));
check("BBTActMark2 (dedupe marker) is BBTNoTranslate", isNoTranslate("BBTActMark2"));
check("no BBTControls2 wrapper left", !attrsOf("BBTControls2"));

// The trigger lives inside the engine's own #BuildControls row (after
// #BuildOptionButton); the menu captions are our CJK literals, never game
// #Token text.
var buildControlsIdx = xml.indexOf('id="BuildControls"');
var triggerIdx = xml.indexOf('id="BBTTranslateButton2"');
var menuIdx = xml.indexOf('id="BBTMenu2"');
check(
  "trigger is inside #BuildControls",
  buildControlsIdx >= 0 && triggerIdx > buildControlsIdx && triggerIdx < xml.indexOf('id="BuildControlsContainer"')
);
check(
  "menu captions are our literals (原文/翻译/中英对照), no #Token",
  xml.indexOf('text="原文"', menuIdx) > menuIdx
    && xml.indexOf('text="翻译"', menuIdx) > menuIdx
    && xml.indexOf('text="中英对照"', menuIdx) > menuIdx
);

// ---- script half: the guard exists at every write entry point ------------
check("isOwnChrome() is defined", /function isOwnChrome\s*\(/.test(js));
check(
  "isOwnChrome() tests the BBTNoTranslate class",
  /panelHasClass\(\s*panel\s*,\s*"BBTNoTranslate"\s*\)/.test(js)
);
check(
  "scan() skips own chrome",
  /if \(isOwnChrome\(p\)\) \{ skippedOwn \+= 1; continue; \}/.test(js)
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

// ---- the hover tooltip must hide every toolbar button --------------------
check(
  "boot() collapses the dropdown in the hover tooltip",
  /var toolbarIds = \["BBTMenu2"/.test(js) && /tb.style.visibility = "collapse"/.test(js)
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
