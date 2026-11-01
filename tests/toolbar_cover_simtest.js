// Structural check for the BBT toolbar.
//
// v1.9.13 places the three native buttons directly in the engine's own control
// row (#ControlArea, immediately before #BuildControls, no wrapper panel), so
// they are clickable by construction and styled exactly like the engine's own
// 出装选项 button (class="Medium Fill"). The v1.9.8 row (inside #BuildInfo)
// was clipped to its parent's bounds, the v1.9.9 root child was laid out under
// the full-height pane, and the v1.9.10/v1.9.11 overlay squeezed #BuildInfo -
// all retired. The v1.9.8 dropdown is replaced by a mode-cycle button
// (#BBTModeButton2).
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
    const id = idMatch ? idMatch[1] : "";
    if (closing) {
      stack.pop();
      continue;
    }
    if (id === targetId) return stack[stack.length - 1] || "";
    if (!self) stack.push(id);
  }
  return "";
}

{
  const full = path.join(LAYOUT, detailsFile);
  check(detailsFile + " exists", fs.existsSync(full));
  const xml = fs.readFileSync(full, "utf8");

  // The three controls.
  check(detailsFile + ": translate button", xml.indexOf('id="BBTTranslateButton2"') >= 0);
  check(detailsFile + ": manual refresh button", xml.indexOf('id="BBTRefreshButton2"') >= 0);
  check(detailsFile + ": mode cycle button", xml.indexOf('id="BBTModeButton2"') >= 0);

  // None of the retired overlay/menu machinery may remain.
  check(detailsFile + ": no dropdown trigger", xml.indexOf('id="BBTMenuButton2"') < 0);
  check(detailsFile + ": no dropdown panel", xml.indexOf('id="BBTMenu2"') < 0);
  check(detailsFile + ": no toolbar row", xml.indexOf('id="BBTBar2"') < 0);
  check(detailsFile + ": no overlay layer", xml.indexOf('id="BBTLayer2"') < 0);
  check(detailsFile + ": no spacer slot", xml.indexOf('id="BBTSlot2"') < 0);

  // native look: the game's own TextButton style, same as 出装选项
  check(
    detailsFile + ": buttons use the native Medium Fill style",
    /<TextButton id="BBTTranslateButton2"[^>]*class="[^"]*Medium[^"]*Fill/.test(xml) &&
      /<TextButton id="BBTRefreshButton2"[^>]*class="[^"]*Medium[^"]*Fill/.test(xml) &&
      /<TextButton id="BBTModeButton2"[^>]*class="[^"]*Medium[^"]*Fill/.test(xml)
  );

  // No wrapper panel: the three buttons sit directly inside #ControlArea (the
  // engine's header row), BEFORE #BuildControls (not inside it, a 220px box
  // without flow).
  check(detailsFile + ": no toolbar wrapper panel", xml.indexOf('id="BBTControls2"') < 0);
  const translateHost = parentOf(xml, "BBTTranslateButton2");
  const refreshHost = parentOf(xml, "BBTRefreshButton2");
  const modeHost = parentOf(xml, "BBTModeButton2");
  check(detailsFile + ": translate button lives inside #ControlArea", translateHost === "ControlArea", "host=" + translateHost);
  check(detailsFile + ": refresh button lives inside #ControlArea", refreshHost === "ControlArea", "host=" + refreshHost);
  check(detailsFile + ": mode button lives inside #ControlArea", modeHost === "ControlArea", "host=" + modeHost);
  check(
    detailsFile + ": buttons sit before #BuildControls",
    xml.indexOf('id="BBTTranslateButton2"') < xml.indexOf('id="BuildControls"')
  );
  // The retired BBTButton/BBTControls styling must be gone.
  check(detailsFile + ": buttons carry no BBTButton class", xml.indexOf("BBTButton ") < 0 && xml.indexOf('class="BBTButton') < 0);

  // Each button routes through BBTActivate(action, $.GetContextPanel()).
  check(detailsFile + ": translate routes through BBTActivate", xml.indexOf("BBTActivate(&apos;translate&apos;, $.GetContextPanel())") >= 0);
  check(detailsFile + ": refresh routes through BBTActivate", xml.indexOf("BBTActivate(&apos;refresh&apos;, $.GetContextPanel())") >= 0);
  check(detailsFile + ": mode routes through BBTActivate", xml.indexOf("BBTActivate(&apos;mode:next&apos;, $.GetContextPanel())") >= 0);
}

{
  // The selector must not carry a second toolbar: that is what used to overlap
  // the tabs and produced a dead button.
  const xml = fs.readFileSync(path.join(LAYOUT, selectorFile), "utf8");
  check(selectorFile + ": no duplicate toolbar", xml.indexOf('id="BBTControls"') < 0 && xml.indexOf('id="BBTMenu"') < 0);
  check(selectorFile + ": build list rows keep the engine build-name label", /<Label class="BuildName" text="#Citadel_HeroBuilds_BuildName"/.test(xml));
}

// the script must know how to drive this toolbar
const js = fs.readFileSync(path.join(__dirname, "..", "mod", "panorama", "scripts", "bba_translate.js"), "utf8");
check("script wires the toolbar", js.indexOf('"BBTTranslateButton2"') >= 0);
check("script wires the mode cycle button", js.indexOf('"BBTModeButton2"') >= 0);
check("script exports the refresh handler to the engine's scope", js.indexOf('expose("BBTRefreshPage"') >= 0 && js.indexOf('"BBTRefreshButton2"') >= 0);
check("script writes the refresh result onto the refresh button itself", js.indexOf("function uiSetRefreshText") >= 0);
check("script writes the mode readout onto the mode button", js.indexOf("function uiSetModeText") >= 0);
check("script cycles the display mode", js.indexOf("function cycleMode") >= 0 && js.indexOf("mode:next") >= 0);
check("script can update the TextButton caption", js.indexOf("b.text = text") >= 0);
check("script has no dropdown drive left", js.indexOf('"BBTMenu2"') < 0 && js.indexOf('"BBTMenuOpen"') < 0);
check("script has no toolbar-position measuring left", js.indexOf("function placeToolbar") < 0 && js.indexOf("function actualOffset") < 0);
check("script resolves panels inside a given instance root", js.indexOf("function uiPanelIn") >= 0 && js.indexOf("function layoutRoot") >= 0);
const detailsXml = fs.readFileSync(path.join(LAYOUT, detailsFile), "utf8");
check("layout handlers carry the clicked panel into the script", detailsXml.indexOf("BBTActivate(&apos;refresh&apos;, $.GetContextPanel())") >= 0);
check("no bare global handler name is left in the layout", !/on(?:mouse)?activate="BBT(?!Activate)[A-Za-z]+\(/.test(detailsXml));

// CSS: the mode button gets a fixed minimum width (a single 中/原/双 character
// would render too narrow under the native Medium style), and the retired
// BBTButton/BBTControls rules are gone.
const css = fs.readFileSync(path.join(__dirname, "..", "mod", "panorama", "styles", "bba.css"), "utf8");
check("css gives the mode button a minimum width", /#BBTModeButton2\s*\{[^}]*min-width:\s*40px/.test(css));
check("css dropped the BBTButton rule", css.indexOf(".BBTButton") < 0);
check("css dropped the BBTControls rule", css.indexOf(".BBTControls") < 0);

console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL TOOLBAR CHECKS PASSED");
