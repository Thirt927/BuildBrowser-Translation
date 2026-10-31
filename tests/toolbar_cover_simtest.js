// Structural check: every layout that carries the BBT toolbar must have a button,
// a dropdown trigger, and a dropdown with all menu items - so "translate this page"
// exists both in the build browser and in the standalone build-details view.
//
// Usage: node tests/toolbar_cover_simtest.js
"use strict";

const fs = require("fs");
const path = require("path");

const LAYOUT = path.join(__dirname, "..", "mod", "panorama", "layout");
const EXPECTED_ITEMS = [
  "显示中文", "显示原文", "中英对照",
  "简体中文", "繁體中文", "日本語", "한국어", "English",
  "把新译文存入本地库", "查看本地库统计",
];

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " -- " + detail : ""));
  if (!cond) failures += 1;
}

// [layout file, toolbar suffix] - suffix is "" for the selector and "2" for the
// standalone details view.
const TARGETS = [
  ["citadel_ui_build_selector.xml", ""],
  ["citadel_ui_build_details.xml", "2"],
];

for (const [file, sfx] of TARGETS) {
  const full = path.join(LAYOUT, file);
  check(file + " exists", fs.existsSync(full));
  if (!fs.existsSync(full)) continue;
  const xml = fs.readFileSync(full, "utf8");

  check(file + ": translate button", xml.indexOf('id="BBTTranslateButton' + sfx + '"') >= 0);
  check(file + ": translate button has a label", xml.indexOf('id="BBTTranslateLabel' + sfx + '"') >= 0);
  check(file + ": dropdown trigger", xml.indexOf('id="BBTMenuButton' + sfx + '"') >= 0);
  check(file + ": dropdown panel", xml.indexOf('id="BBTMenu' + sfx + '"') >= 0);

  // the dropdown must sit outside the horizontal button row, otherwise it flows off
  // to the right instead of dropping below (this was the "cannot open" layout bug)
  // Walk the XML tracking depth: if BBTMenu<sfx> is opened while BBTControls<sfx>
  // is still open, it is nested inside the horizontal button row.
  const menuInsideRow = (function () {
    let depth = 0;
    let controlsDepth = -1;
    for (const m of xml.matchAll(/<(\/?)(Panel|Button|Label|HTML)([^>]*)>/g)) {
      const closing = m[1] === "/";
      const self = /\/\s*$/.test(m[3] || "");
      const idMatch = /id="([^"]+)"/.exec(m[3] || "");
      const id = idMatch ? idMatch[1] : "";
      if (!closing && !self) {
        depth += 1;
        if (id === "BBTControls" + sfx) controlsDepth = depth;
        if (id === "BBTMenu" + sfx && controlsDepth > 0 && depth > controlsDepth) return true;
      } else if (closing) {
        if (depth === controlsDepth && controlsDepth > 0) controlsDepth = -1;
        depth -= 1;
      }
    }
    return false;
  })();
  check(file + ": dropdown is not inside the button row", !menuInsideRow, "nested dropdowns do not open downward");

  for (const item of EXPECTED_ITEMS) {
    check(file + ": menu item " + item, xml.indexOf(item) >= 0);
  }

  // clicks must reach the buttons: labels inside them must not swallow the hit
  const swallowing = [...xml.matchAll(/<Label[^>]*text="[^"]*"[^>]*\/>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.indexOf('id="BBTTranslateLabel' + sfx + '"') >= 0 && tag.indexOf('hittest="false"') < 0);
  check(file + ": button label does not swallow clicks", swallowing.length === 0, swallowing.join(" | "));
}

// the script must know about both toolbars
const js = fs.readFileSync(path.join(__dirname, "..", "mod", "panorama", "scripts", "bba_translate.js"), "utf8");
check("script wires the second toolbar", js.indexOf('"BBTTranslateButton2"') >= 0);
check("script updates the second status label", js.indexOf('"BBTTranslateLabel2"') >= 0);
check("script toggles the second dropdown", js.indexOf('"BBTMenu2"') >= 0);

console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL TOOLBAR CHECKS PASSED");
