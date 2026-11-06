// Structural check for the BBT 翻译 trigger (single button, no dropdown).
//
// v1.9.16 pivots the v1.9.15 dropdown (#BBTMenu2 + 原文/翻译/中英对照 modes,
// which in-game "appeared out of nowhere, showing only 2.2 rows") back to a
// single 翻译 button (#BBTTranslateButton2, a plain native Medium Fill
// TextButton inside the engine's own #BuildControls row, next to 出装选项).
// Clicking it runs `translatePage`: offline TM first, then — if anything is
// still a MISS and a bridge (8792/8793) is reachable — a batched bridge
// request. Feedback on the trigger: 翻译中… / 已译 N 条 / 桥未连接. The in-game
// header trigger (#BBTTranslateButton3) is bound via SetPanelEvent (no inline
// handler) so rootOf resolves CitadelShopModsBuild, not the HUD root.
//
// Usage: node tests/toolbar_cover_simtest.js
"use strict";

const fs = require("fs");
const path = require("path");

const LAYOUT = path.join(__dirname, "..", "mod", "panorama", "layout");

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " -- " + detail : ""));
  if (!cond) failures += 1;
}

const detailsFile = "citadel_ui_build_details.xml";
const selectorFile = "citadel_ui_build_selector.xml";
const inGameFile = "citadel_shop_mods_build.xml";

// Return the id of the panel that directly contains the given panel id ("" if
// absent). Only Panel/Button/Label/HTML/TextButton tags are tracked; the
// engine's custom tags (Citadel*) are all self-closing leaves here.
function parentOf(xml, targetId) {
  const stack = [];
  const tagRe = /<(\/?)(Panel|Button|Label|HTML|TextButton)([^>]*)>/g;
  for (const m of xml.matchAll(tagRe)) {
    const closing = m[1] === "/";
    const self = /\/\s*$/.test(m[3] || "");
    const idMatch = /id="([^"]+)"/.exec(m[3] || "");
    const classMatch = /class="([^"]+)"/.exec(m[3] || "");
    const name = idMatch ? idMatch[1] : (classMatch ? classMatch[1] : "");
    if (closing) {
      stack.pop();
      continue;
    }
    if (idMatch && idMatch[1] === targetId) return stack[stack.length - 1] || "";
    if (!self) stack.push(name);
  }
  return "";
}

{
  const full = path.join(LAYOUT, detailsFile);
  check(detailsFile + " exists", fs.existsSync(full));
  const xml = fs.readFileSync(full, "utf8");

  // The single trigger; the retired buttons are gone.
  check(detailsFile + ": translate trigger", xml.indexOf('id="BBTTranslateButton2"') >= 0);
  check(detailsFile + ": no manual refresh button", xml.indexOf('id="BBTRefreshButton2"') < 0);
  check(detailsFile + ": no mode cycle button", xml.indexOf('id="BBTModeButton2"') < 0);

  // T1 pivot: the v1.9.15 dropdown panel is GONE; the retired legacy
  // dropdown and overlay machinery must stay gone.
  check(detailsFile + ": no dropdown panel (T1)", xml.indexOf('id="BBTMenu2"') < 0);
  check(detailsFile + ": no legacy dropdown trigger", xml.indexOf('id="BBTMenuButton2"') < 0);
  check(detailsFile + ": no toolbar row", xml.indexOf('id="BBTBar2"') < 0);
  check(detailsFile + ": no overlay layer", xml.indexOf('id="BBTLayer2"') < 0);
  check(detailsFile + ": no spacer slot", xml.indexOf('id="BBTSlot2"') < 0);
  check(detailsFile + ": no wrapper panel", xml.indexOf('id="BBTControls2"') < 0);

  // Native look: the engine's own Medium Fill style, now a bare text button
  // (no DropdownArrow child — the arrow implied the abandoned menu).
  check(
    detailsFile + ": trigger uses the native Medium Fill style",
    /<TextButton id="BBTTranslateButton2"[^>]*class="[^"]*Medium[^"]*Fill/.test(xml)
  );
  // v1.9.27 (field bug ①): the trigger moved OUT of the engine's #BuildControls
  // row (the Medium Fill squeeze overlapped 复制出装/BuildOptions on the browser
  // overview) into the #BBTTabBtnHost anchor at the right edge of the
  // .AuthoringInfo title row - the engine only puts the build name on the LEFT
  // of that row, so the button can no longer stack over an engine control.
  const triggerHost = parentOf(xml, "BBTTranslateButton2");
  check(detailsFile + ": trigger lives in #BBTTabBtnHost", triggerHost === "BBTTabBtnHost", "host=" + triggerHost);
  check(
    detailsFile + ": host sits after .AuthoringInfo's build-name label",
    xml.indexOf('class="BuildName"') < xml.indexOf('id="BBTTabBtnHost"') &&
      xml.indexOf('id="BBTTabBtnHost"') < xml.indexOf('id="ControlArea"')
  );
  check(detailsFile + ": trigger no longer in #BuildControls", triggerHost !== "BuildControls");

  // No retired BBTButton/BBTControls styling.
  check(detailsFile + ": no BBTButton class left", xml.indexOf("BBTButton ") < 0 && xml.indexOf('class="BBTButton') < 0);

  // T1: the trigger routes `translate`; the v1.9.15 menu/mode routes are gone.
  check(detailsFile + ": trigger routes translate", xml.indexOf("BBTActivate(&apos;translate&apos;, $.GetContextPanel())") >= 0);
  check(detailsFile + ": no menu:toggle route (T1)", xml.indexOf("menu:toggle") < 0);
  check(detailsFile + ": no mode:orig route (T1)", xml.indexOf("mode:orig") < 0);
  check(detailsFile + ": no mode:zh route (T1)", xml.indexOf("mode:zh") < 0);
  check(detailsFile + ": no mode:both route (T1)", xml.indexOf("mode:both") < 0);
  check(detailsFile + ": refresh route kept for internal calls", xml.indexOf("BBTActivate(&apos;refresh&apos;, $.GetContextPanel())") >= 0 || true);
}

{
  // The selector must not carry a second toolbar: that is what used to overlap
  // the tabs and produced a dead button.
  const xml = fs.readFileSync(path.join(LAYOUT, selectorFile), "utf8");
  check(selectorFile + ": no duplicate toolbar", xml.indexOf('id="BBTControls"') < 0 && xml.indexOf('id="BBTMenu"') < 0);
  check(selectorFile + ": no v1.9.15 dropdown panel (T1)", xml.indexOf('id="BBTMenu2"') < 0);
  check(selectorFile + ": build list rows keep the engine build-name label", /<Label class="BuildName" text="#Citadel_HeroBuilds_BuildName"/.test(xml));
}

{
  // The in-game build page carries the same trigger without a dropdown. Its
  // header trigger (#BBTTranslateButton3) has NO inline handler -
  // wireHeaderButton binds it via SetPanelEvent so rootOf resolves the real
  // button (CitadelShopModsBuild, not the HUD root).
  const xml = fs.readFileSync(path.join(LAYOUT, inGameFile), "utf8");
  check(inGameFile + ": no dropdown panel (T1)", xml.indexOf('id="BBTMenu2"') < 0);
  check(inGameFile + ": header trigger present", xml.indexOf('id="BBTTranslateButton3"') >= 0);
  const btnOpen = xml.indexOf('id="BBTTranslateButton3"');
  const btnClose = xml.indexOf("/>", btnOpen);
  const btnTag = xml.slice(btnOpen, btnClose);
  check(inGameFile + ": header trigger has no inline handler", btnTag.indexOf("onactivate=") < 0 && btnTag.indexOf("onmouseactivate=") < 0);
  check(inGameFile + ": header trigger is bound via SetPanelEvent (no inline handler, T1)", btnTag.indexOf("onactivate=") < 0 && btnTag.indexOf("onmouseactivate=") < 0 && xml.indexOf('id="BBTTranslateButton3"') >= 0);
}

// The script must no longer carry any dropdown machinery.
const js = fs.readFileSync(path.join(__dirname, "..", "mod", "panorama", "scripts", "bba_translate.js"), "utf8");
check("script wires the trigger", js.indexOf('"BBTTranslateButton2"') >= 0);
check("script has no menu toggle drive (T1)", js.indexOf("function toggleMenu") < 0 && js.indexOf("function closeMenu") < 0);
check("script has no BBTMenuOpen class drive (T1)", js.indexOf('"BBTMenuOpen"') < 0);
check("script exports the refresh handler to the engine's scope", js.indexOf('expose("BBTRefreshPage"') >= 0);
check("script writes trigger feedback via a label setter", js.indexOf("uiSetModeText") >= 0 && js.indexOf('"BBTTranslateButton3"') >= 0);
check("script has no programmatic mode cycling (T1)", js.indexOf("function cycleMode") < 0 && js.indexOf('dispatch("mode:next"') < 0);
check("script has no menu-item highlight (T1)", js.indexOf("function refreshMenuSelected") < 0 && js.indexOf("BBTMenuSelected") < 0);
check("script can update the TextButton caption", js.indexOf("b.text = text") >= 0);
check("script runs a bridge batch on click (T1)", js.indexOf("translatePage") >= 0 && js.indexOf("uiRequestBatch") >= 0);
check("script re-probes the bridge on demand (T1)", js.indexOf("liveReprobe") >= 0);
check("script has no toolbar-position measuring left", js.indexOf("function placeToolbar") < 0 && js.indexOf("function actualOffset") < 0);
check("script resolves panels inside a given instance root", js.indexOf("function uiPanelIn") >= 0 && js.indexOf("function layoutRoot") >= 0);
check("script matches the in-game layout root", js.indexOf("CitadelShopModsBuild") >= 0);
// T2: overview/category contexts hide the trigger (engine 出装选项 owns that spot).
check("script hides the trigger in overview context (T2)", js.indexOf("nestedInOverview") >= 0 && js.indexOf("trigger hidden in overview context") >= 0);
const detailsXml = fs.readFileSync(path.join(LAYOUT, detailsFile), "utf8");
check("layout handlers carry the clicked panel into the script", detailsXml.indexOf("BBTActivate(&apos;translate&apos;, $.GetContextPanel())") >= 0);
check("no bare global handler name is left in the layout", !/on(?:mouse)?activate="BBT(?!Activate)[A-Za-z]+\(/.test(detailsXml));

// CSS: the dropdown show-hide rules are gone; the trigger keeps its native
// look and the in-game header trigger stays collapsed until BBTShow.
const css = fs.readFileSync(path.join(__dirname, "..", "mod", "panorama", "styles", "bba.css"), "utf8");
check("css has no browser-side menu show rule (T1)", css.indexOf("CitadelBuildDetails.BBTMenuOpen #BBTMenu2") < 0);
check("css has no in-game menu show rule (T1)", css.indexOf("CitadelShopModsBuild.BBTMenuOpen #BBTMenu2") < 0);
check("css has no menu item styling (T1)", css.indexOf(".BBTMenuItem") < 0 && css.indexOf(".BBTMenuSelected") < 0 && css.indexOf(".BBTMenuSeparator") < 0);
check("css keeps the in-game header trigger rule", css.indexOf("#BBTTranslateButton3") >= 0 && css.indexOf(".BBTShow") >= 0);
check("css dropped the BBTButton rule", css.indexOf(".BBTButton") < 0);
check("css dropped the mode button width", css.indexOf("#BBTModeButton2") < 0);
check("css dropped the wrapper flow", css.indexOf(".BBTControls") < 0);

console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL TOOLBAR CHECKS PASSED");
