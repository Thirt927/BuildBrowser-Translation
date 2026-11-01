// Structural check for the BBT toolbar.
//
// v1.8.0 moved the toolbar out of the build-list header (where it overlapped the
// 我的出装 / 公开 tabs and its dropdown never opened) into the build-details
// header, right next to 出装选项. The details layout is rendered both standalone
// and inside the selector, so one toolbar covers every surface.
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

const detailsFile = "citadel_ui_build_details.xml";
const selectorFile = "citadel_ui_build_selector.xml";

{
  const full = path.join(LAYOUT, detailsFile);
  check(detailsFile + " exists", fs.existsSync(full));
  const xml = fs.readFileSync(full, "utf8");

  check(detailsFile + ": translate button", xml.indexOf('id="BBTTranslateButton2"') >= 0);
  check(detailsFile + ": manual refresh button", xml.indexOf('id="BBTRefreshButton2"') >= 0);
  check(detailsFile + ": dropdown trigger", xml.indexOf('id="BBTMenuButton2"') >= 0);
  check(detailsFile + ": dropdown panel", xml.indexOf('id="BBTMenu2"') >= 0);
  // native look: the game's own TextButton style, same as 出装选项 / 出装浏览器
  check(detailsFile + ": button uses the native TextButton style", /<TextButton id="BBTTranslateButton2"[^>]*class="[^"]*Medium[^"]*Fill/.test(xml));
  // The toolbar needs its own row inside #BuildInfo (flow-children: down, so the
  // row is laid out and clickable). It must NOT go into #BuildControls: the game
  // styles that box as 220px wide WITHOUT flow-children, so every child lands on
  // the same spot (that is what produced the overlapped/dead buttons).
  check(detailsFile + ": toolbar row", xml.indexOf('id="BBTBar2"') >= 0);
  const toolbarInsideBuildControls = (function () {
    let depth = 0;
    let controlsDepth = -1;
    for (const m of xml.matchAll(/<(\/?)(Panel|Button|Label|HTML|TextButton)([^>]*)>/g)) {
      const closing = m[1] === "/";
      const self = /\/\s*$/.test(m[3] || "");
      const idMatch = /id="([^"]+)"/.exec(m[3] || "");
      const id = idMatch ? idMatch[1] : "";
      if (!closing && !self) {
        depth += 1;
        if (id === "BuildControls") controlsDepth = depth;
        if (id === "BBTControls2" && controlsDepth > 0) return true;
      } else if (closing) {
        if (depth === controlsDepth && controlsDepth > 0) controlsDepth = -1;
        depth -= 1;
      }
    }
    return false;
  })();
  check(detailsFile + ": toolbar is not stacked inside #BuildControls", !toolbarInsideBuildControls);

  // Panorama only hit-tests inside the parent's bounds, so the dropdown must sit
  // in a box that covers the whole details pane: the .BBTLayer overlay, whose
  // parent is .HeroBuildsExtraInfo (the panel that already stacks #Background and
  // #BuildInfo on top of each other). The layout ROOT is flow-children: down, so
  // a root-level menu is laid out under the full-height pane and never shows -
  // that is the v1.9.8 "dropdown never appears" report.
  const menuHostId = (function () {
    let depth = 0;
    const stack = [];
    for (const m of xml.matchAll(/<(\/?)(Panel|Button|Label|HTML|TextButton)([^>]*)>/g)) {
      const closing = m[1] === "/";
      const self = /\/\s*$/.test(m[3] || "");
      const idMatch = /id="([^"]+)"/.exec(m[3] || "");
      const id = idMatch ? idMatch[1] : "";
      if (!closing && !self) {
        stack.push(id);
        depth += 1;
      } else if (closing) {
        if (id === "BBTMenu2") return stack[stack.length - 1] || "";
        stack.pop();
        depth -= 1;
      }
    }
    return "";
  })();
  check(menuHostId === "BBTLayer2", detailsFile + ": 下拉菜单挂在铺满详情面板的 #BBTLayer2 上", "host=" + menuHostId);
  check(
    xml.indexOf('class="HeroBuildsExtraInfo"') < xml.indexOf('id="BBTLayer2"'),
    detailsFile + ": #BBTLayer2 在 .HeroBuildsExtraInfo 里（同源叠放，覆盖整个详情面板）"
  );

  // the dropdown must sit outside the horizontal button row, otherwise it flows off
  // to the right instead of dropping below (this was the "cannot open" layout bug)
  const menuInsideRow = (function () {
    let depth = 0;
    let controlsDepth = -1;
    for (const m of xml.matchAll(/<(\/?)(Panel|Button|Label|HTML|TextButton)([^>]*)>/g)) {
      const closing = m[1] === "/";
      const self = /\/\s*$/.test(m[3] || "");
      const idMatch = /id="([^"]+)"/.exec(m[3] || "");
      const id = idMatch ? idMatch[1] : "";
      if (!closing && !self) {
        depth += 1;
        if (id === "BBTControls2") controlsDepth = depth;
        if (id === "BBTMenu2" && controlsDepth > 0 && depth > controlsDepth) return true;
      } else if (closing) {
        if (depth === controlsDepth && controlsDepth > 0) controlsDepth = -1;
        depth -= 1;
      }
    }
    return false;
  })();
  check(detailsFile + ": dropdown is not inside the button row", !menuInsideRow, "nested dropdowns do not open downward");

  for (const item of EXPECTED_ITEMS) {
    check(detailsFile + ": menu item " + item, xml.indexOf(item) >= 0);
  }
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
check("script exports the refresh handler to the engine's scope", js.indexOf('expose("BBTRefreshPage"') >= 0 && js.indexOf('"BBTRefreshButton2"') >= 0);
check("script writes the refresh result onto the refresh button itself", js.indexOf("function uiSetRefreshText") >= 0);
check("script can update the TextButton caption", js.indexOf('b.text = text') >= 0);
check("script drives the dropdown", js.indexOf('"BBTMenu2"') >= 0);
check("dropdown opens through the class and an inline style fallback", js.indexOf('"BBTMenuOpen"') >= 0 && js.indexOf("style.visibility") >= 0);
check("script measures the toolbar position from the header", js.indexOf("function placeToolbar") >= 0 && js.indexOf("actualx") >= 0);
check("menu items act inside the toolbar's own layout", js.indexOf("wireMenuItems(modes, setLanguageMode") >= 0);
check("script resolves panels inside a given instance root", js.indexOf("function uiPanelIn") >= 0 && js.indexOf("function layoutRoot") >= 0);
const detailsXml = fs.readFileSync(path.join(LAYOUT, detailsFile), "utf8");
check("layout handlers carry the clicked panel into the script", detailsXml.indexOf("BBTActivate(&apos;refresh&apos;, $.GetContextPanel())") >= 0);
check("no bare global handler name is left in the layout", !/on(?:mouse)?activate="BBT(?!Activate)[A-Za-z]+\(/.test(detailsXml));

console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL TOOLBAR CHECKS PASSED");
