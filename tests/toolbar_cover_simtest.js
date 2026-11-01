// Structural check for the BBT toolbar.
//
// v1.9.15 replaces the three control buttons with a single dropdown trigger
// (#BBTTranslateButton2, a native Medium Fill + DropdownArrow button that
// mirrors the engine's own 出装选项 BuildOptionButton). It toggles the
// BBTMenuOpen class on the layout root, which shows #BBTMenu2 - a sibling of
// the engine's own BuildControlsContainer, the only dropdown mechanism proven
// to survive Panorama's hit-testing/clipping. The menu holds the three display
// modes (原文/翻译/中英对照) plus 刷新本页 / 把新译文存入本地库. This retires
// the v1.9.14 mode-cycle button (#BBTModeButton2) and refresh button
// (#BBTRefreshButton2), the v1.9.13 bare-button unwrap, the v1.9.8 dropdown
// (BBTMenuButton2/BBTMenu2 inside BuildInfo), and the retired overlay
// (BBTLayer2/BBTBar2/BBTSlot2).
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

  // The single trigger; the two retired buttons are gone.
  check(detailsFile + ": dropdown trigger", xml.indexOf('id="BBTTranslateButton2"') >= 0);
  check(detailsFile + ": no manual refresh button", xml.indexOf('id="BBTRefreshButton2"') < 0);
  check(detailsFile + ": no mode cycle button", xml.indexOf('id="BBTModeButton2"') < 0);

  // The dropdown panel is back (sibling of BuildControlsContainer); the retired
  // v1.9.8 dropdown and overlay machinery must remain gone.
  check(detailsFile + ": dropdown panel", xml.indexOf('id="BBTMenu2"') >= 0);
  check(detailsFile + ": no legacy dropdown trigger", xml.indexOf('id="BBTMenuButton2"') < 0);
  check(detailsFile + ": no toolbar row", xml.indexOf('id="BBTBar2"') < 0);
  check(detailsFile + ": no overlay layer", xml.indexOf('id="BBTLayer2"') < 0);
  check(detailsFile + ": no spacer slot", xml.indexOf('id="BBTSlot2"') < 0);
  check(detailsFile + ": no wrapper panel", xml.indexOf('id="BBTControls2"') < 0);

  // Native look: same TextButton style + DropdownArrow as 出装选项.
  check(
    detailsFile + ": trigger uses the native Medium Fill style",
    /<TextButton id="BBTTranslateButton2"[^>]*class="[^"]*Medium[^"]*Fill/.test(xml)
  );
  const triggerOpen = xml.indexOf('id="BBTTranslateButton2"');
  const triggerClose = xml.indexOf("</TextButton>", triggerOpen);
  const triggerBody = xml.slice(triggerOpen, triggerClose);
  check(detailsFile + ": trigger carries a DropdownArrow child", triggerBody.indexOf('class="DropdownArrow"') >= 0);

  // The trigger lives inside the engine's own #BuildControls row, right after
  // #BuildOptionButton (not in the old 220px #BuildControls panel confusion).
  const triggerHost = parentOf(xml, "BBTTranslateButton2");
  check(detailsFile + ": trigger lives inside #BuildControls", triggerHost === "BuildControls", "host=" + triggerHost);
  check(
    detailsFile + ": trigger sits after #BuildOptionButton",
    xml.indexOf('id="BuildOptionButton"') < xml.indexOf('id="BBTTranslateButton2"') &&
      xml.indexOf('id="BBTTranslateButton2"') < xml.indexOf('id="BuildControlsContainer"')
  );

  // #BBTMenu2 must be a sibling of the engine's own #BuildControlsContainer
  // (same parent, so it inherits the same dropdown anchoring).
  const menuHost = parentOf(xml, "BBTMenu2");
  const engineHost = parentOf(xml, "BuildControlsContainer");
  check(detailsFile + ": dropdown shares BuildControlsContainer's parent", menuHost !== "" && menuHost === engineHost, "menu=" + menuHost + " engine=" + engineHost);

  // No retired BBTButton/BBTControls styling.
  check(detailsFile + ": no BBTButton class left", xml.indexOf("BBTButton ") < 0 && xml.indexOf('class="BBTButton') < 0);

  // Trigger + menu items route through BBTActivate.
  check(detailsFile + ": trigger routes through BBTActivate", xml.indexOf("BBTActivate(&apos;menu:toggle&apos;, $.GetContextPanel())") >= 0);
  check(detailsFile + ": 原文 item routes mode:orig", xml.indexOf("BBTActivate(&apos;mode:orig&apos;, $.GetContextPanel())") >= 0);
  check(detailsFile + ": 翻译 item routes mode:zh", xml.indexOf("BBTActivate(&apos;mode:zh&apos;, $.GetContextPanel())") >= 0);
  check(detailsFile + ": 中英对照 item routes mode:both", xml.indexOf("BBTActivate(&apos;mode:both&apos;, $.GetContextPanel())") >= 0);
  check(detailsFile + ": 刷新本页 item routes refresh", xml.indexOf("BBTActivate(&apos;refresh&apos;, $.GetContextPanel())") >= 0);
}

{
  // The selector must not carry a second toolbar: that is what used to overlap
  // the tabs and produced a dead button.
  const xml = fs.readFileSync(path.join(LAYOUT, selectorFile), "utf8");
  check(selectorFile + ": no duplicate toolbar", xml.indexOf('id="BBTControls"') < 0 && xml.indexOf('id="BBTMenu"') < 0);
  check(selectorFile + ": build list rows keep the engine build-name label", /<Label class="BuildName" text="#Citadel_HeroBuilds_BuildName"/.test(xml));
}

{
  // The in-game build page carries the same dropdown, but its header trigger
  // (#BBTTranslateButton3) has NO inline handler - wireHeaderButton binds it
  // via SetPanelEvent so rootOf resolves the real button (CitadelShopModsBuild,
  // not the HUD root).
  const xml = fs.readFileSync(path.join(LAYOUT, inGameFile), "utf8");
  check(inGameFile + ": in-game dropdown panel", xml.indexOf('id="BBTMenu2"') >= 0);
  const btnOpen = xml.indexOf('id="BBTTranslateButton3"');
  const btnClose = xml.indexOf("/>", btnOpen);
  const btnTag = xml.slice(btnOpen, btnClose);
  check(inGameFile + ": header trigger has no inline handler", btnTag.indexOf("onactivate=") < 0 && btnTag.indexOf("onmouseactivate=") < 0);
  check(inGameFile + ": header trigger routes via BBTMenu2", xml.indexOf('id="BBTMenu2"') > btnOpen);
}

// the script must know how to drive this dropdown
const js = fs.readFileSync(path.join(__dirname, "..", "mod", "panorama", "scripts", "bba_translate.js"), "utf8");
check("script wires the trigger", js.indexOf('"BBTTranslateButton2"') >= 0);
check("script toggles the dropdown", js.indexOf("function toggleMenu") >= 0 && js.indexOf("function closeMenu") >= 0);
check("script has the dropdown drive", js.indexOf('"BBTMenu2"') >= 0 && js.indexOf('"BBTMenuOpen"') >= 0);
check("script exports the refresh handler to the engine's scope", js.indexOf('expose("BBTRefreshPage"') >= 0);
check("script writes the mode readout onto the trigger", js.indexOf("function uiSetModeText") >= 0 && js.indexOf('"BBTTranslateButton3"') >= 0);
check("script still cycles the display mode (programmatic)", js.indexOf("function cycleMode") >= 0 && js.indexOf("mode:next") >= 0);
check("script highlights the current mode item", js.indexOf("function refreshMenuSelected") >= 0 && js.indexOf("BBTMenuSelected") >= 0);
check("script can update the TextButton caption", js.indexOf("b.text = text") >= 0);
check("script has no toolbar-position measuring left", js.indexOf("function placeToolbar") < 0 && js.indexOf("function actualOffset") < 0);
check("script resolves panels inside a given instance root", js.indexOf("function uiPanelIn") >= 0 && js.indexOf("function layoutRoot") >= 0);
check("script matches the in-game layout root", js.indexOf("CitadelShopModsBuild") >= 0);
const detailsXml = fs.readFileSync(path.join(LAYOUT, detailsFile), "utf8");
check("layout handlers carry the clicked panel into the script", detailsXml.indexOf("BBTActivate(&apos;menu:toggle&apos;, $.GetContextPanel())") >= 0);
check("no bare global handler name is left in the layout", !/on(?:mouse)?activate="BBT(?!Activate)[A-Za-z]+\(/.test(detailsXml));

// CSS: the dropdown is collapse by default and visible while the layout root
// carries BBTMenuOpen (both the browser and in-game instances); the retired
// BBTButton rule, mode-button width, and wrapper flow are gone.
const css = fs.readFileSync(path.join(__dirname, "..", "mod", "panorama", "styles", "bba.css"), "utf8");
check("css shows the menu on the browser root", css.indexOf("CitadelBuildDetails.BBTMenuOpen #BBTMenu2") >= 0 && /visibility:\s*visible/.test(css));
check("css shows the menu on the in-game root", css.indexOf("CitadelShopModsBuild.BBTMenuOpen #BBTMenu2") >= 0);
check("css styles the menu items", css.indexOf(".BBTMenuItem") >= 0);
check("css highlights the selected item", css.indexOf(".BBTMenuSelected") >= 0);
check("css separates the menu groups", css.indexOf(".BBTMenuSeparator") >= 0);
check("css dropped the BBTButton rule", css.indexOf(".BBTButton") < 0);
check("css dropped the mode button width", css.indexOf("#BBTModeButton2") < 0);
check("css dropped the wrapper flow", css.indexOf(".BBTControls") < 0);

console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL TOOLBAR CHECKS PASSED");
