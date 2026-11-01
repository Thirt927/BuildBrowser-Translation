"use strict";

/*
 * wiring_simtest.js - offline contract/behaviour test for the v1.9.12 toolbar
 * rework (XML `BBTActivate('action', $.GetContextPanel())` + script
 * `dispatch(action, origin)` + `expose()`), which replaced the v1.9.8 dropdown
 * with a mode-cycle button and put the toolbar inside the engine control row.
 *
 * Read-only: this test loads the real mod/panorama/scripts/bba_translate.js in
 * a vm sandbox with fake Panorama panels built from the real
 * citadel_ui_build_details.xml, and never writes to the repo.
 *
 * Groups:
 *   [1] XML -> JS name contract (layout handlers must resolve to exposed names)
 *   [2] multi-instance isolation (visible details A vs hidden tooltip copy B)
 *   [3] refresh feedback lands on the refresh button itself
 *   [4] missing handler export is visible in log + status line
 *   [5] works with and without engine SetPanelEvent support
 *
 * Run: node tests\wiring_simtest.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS_DIR = path.join(ROOT, "mod", "panorama", "scripts");
const DETAILS_XML = path.join(ROOT, "mod", "panorama", "layout", "citadel_ui_build_details.xml");

const detailsXml = fs.readFileSync(DETAILS_XML, "utf8");
const translateSrc = fs.readFileSync(path.join(SCRIPTS_DIR, "bba_translate.js"), "utf8");
const glossarySrc = fs.readFileSync(path.join(SCRIPTS_DIR, "bba_glossary.js"), "utf8");
const layoutTokensSrc = fs.readFileSync(path.join(SCRIPTS_DIR, "bba_layout_tokens.js"), "utf8");
const tmFormat = require(path.join(ROOT, "tools", "tm_format.js"));

const TM = {
  "Bob's Carry Build": "Bob的带飞出装",
  "Stack spirit on Haze, then go mid.": "在岚梦身上堆精神，然后去中路。",
};
const tmSrc = tmFormat.emitScript(TM, { generated_at: "wiring_simtest" });

/* ------------------------------------------------------------------ */
/* tiny assertion helpers                                              */
/* ------------------------------------------------------------------ */

let checks = 0;
let failures = 0;

function check(cond, label, detail) {
  checks += 1;
  if (cond) {
    console.log("PASS  " + label);
  } else {
    failures += 1;
    console.error("FAIL  " + label + (detail === undefined ? "" : "  :: " + detail));
  }
}

function checkEq(actual, expected, label) {
  check(actual === expected, label, "expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual));
}

function checkMatch(value, re, label) {
  check(re.test(String(value)), label, "value=" + JSON.stringify(value) + " re=" + re);
}

/* ------------------------------------------------------------------ */
/* XML parsing (real layout -> fake panel tree)                        */
/* ------------------------------------------------------------------ */

const NON_PANEL = { styles: true, scripts: true, snippets: true };

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseXml(xml) {
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, "");
  const doc = { name: "#document", attrs: {}, children: [] };
  const stack = [doc];
  const tagRe = /<([^<>]+)>/g;
  let m;
  while ((m = tagRe.exec(stripped))) {
    let body = m[1].trim();
    if (!body || body.charAt(0) === "!" || body.charAt(0) === "?") continue;
    if (body.charAt(0) === "/") {
      const name = body.slice(1).trim();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    let selfClosing = false;
    if (body.endsWith("/")) {
      selfClosing = true;
      body = body.slice(0, -1).trim();
    }
    const nameMatch = /^([A-Za-z_][\w:.-]*)/.exec(body);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const attrSrc = body.slice(name.length);
    const attrs = {};
    const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = attrRe.exec(attrSrc))) {
      attrs[a[1]] = decodeEntities(a[3] !== undefined ? a[3] : a[4]);
    }
    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return doc;
}

function findLayoutRoot(doc) {
  const top = doc.children[0];
  if (!top) return null;
  if (!NON_PANEL[top.name] && top.name !== "#document" && top.name !== "root") return top;
  for (const child of top.children) {
    if (NON_PANEL[child.name]) continue;
    return child;
  }
  return null;
}

const detailsDoc = parseXml(detailsXml);
const detailsRootNode = findLayoutRoot(detailsDoc);

/* engine localised strings for #tokens used by the layout */
const ENGINE_TEXT = {
  "#Citadel_HeroBuilds_BuildName": "Bob's Carry Build",
  "#Citadel_HeroBuilds_BuildDescription": "Stack spirit on Haze, then go mid.",
  "#Citadel_HeroBuilds_BuildID": "48231970",
  "#Citadel_HeroBuilds_Overview": "Overview",
  "#Citadel_HeroBuilds_BuildOptions": "Build Options",
};

function engineText(raw) {
  if (!raw) return "";
  const s = String(raw);
  if (s.charAt(0) !== "#") return s;
  if (ENGINE_TEXT[s]) return ENGINE_TEXT[s];
  return s.slice(1).replace(/_/g, " ");
}

/* ------------------------------------------------------------------ */
/* fake Panorama panels                                                */
/* ------------------------------------------------------------------ */

let WRITE_LOG = null;

function geometryFor(node) {
  const cls = node.attrs.class || "";
  if (node.name === "CitadelBuildDetails" || node.name === "CitadelHeroBuildsSelector") {
    return { w: 600, h: 400, x: 0, y: 0 };
  }
  if (cls.indexOf("HeroBuildsExtraInfo") >= 0) return { w: 600, h: 320, x: 10, y: 10 };
  return { w: 200, h: 20, x: 10, y: 10 };
}

function makePanel(node, parent, opts) {
  const g = geometryFor(node);
  const p = {
    _node: node,
    _id: node.attrs.id || "",
    _parent: parent || null,
    _children: [],
    _classes: String(node.attrs.class || "").split(/\s+/).filter(Boolean),
    _events: {},
    _style: {
      visibility: String(node.attrs.class || "").split(/\s+/).indexOf("BBTMenu") >= 0 ? "collapse" : "visible",
      marginTop: "",
      marginRight: "",
    },
    _text: engineText(node.attrs.text),
    actualwidth: g.w,
    actualheight: g.h,
    actualx: g.x,
    actualy: g.y,
  };
  Object.defineProperty(p, "id", { get: () => p._id });
  if (!opts.noPaneltype) {
    Object.defineProperty(p, "paneltype", { get: () => node.name });
  }
  Object.defineProperty(p, "text", {
    get: () => p._text,
    set: (v) => {
      const from = p._text;
      p._text = String(v);
      if (WRITE_LOG) WRITE_LOG.push({ panel: p, prop: "text", from, to: p._text });
    },
  });
  Object.defineProperty(p, "style", { get: () => p._style });
  p.tag = node.name;
  p.GetParent = () => p._parent;
  p.GetChildCount = () => p._children.length;
  p.GetChild = (i) => p._children[i] || null;
  p.IsValid = () => true;
  p.BIsVisible = () => p._style.visibility !== "collapse";
  p.IsVisible = () => p._style.visibility !== "collapse";
  p.BHasClass = (c) => p._classes.indexOf(c) >= 0;
  p.HasClass = (c) => p.BHasClass(c);
  p.SetHasClass = (c, on) => {
    const has = p.BHasClass(c);
    if (on && !has) p._classes.push(c);
    if (!on && has) p._classes = p._classes.filter((x) => x !== c);
  };
  p.AddClass = (c) => p.SetHasClass(c, true);
  p.RemoveClass = (c) => p.SetHasClass(c, false);
  p.ToggleClass = (c) => p.SetHasClass(c, !p.BHasClass(c));
  p.classList = {
    contains: (c) => p.BHasClass(c),
    add: (c) => p.SetHasClass(c, true),
    remove: (c) => p.SetHasClass(c, false),
  };
  if (opts.supportsEvents !== false) {
    p.SetPanelEvent = (event, fn) => {
      p._events[event] = p._events[event] || [];
      p._events[event].push(fn);
    };
  }
  if (node.name === "HTML") {
    p.title = "";
    p.SetURL = () => {};
    p.SetAttributeString = () => {};
  }
  return p;
}

function buildTree(opts) {
  const byId = new Map();
  const byTagSample = [];

  function walk(node, parent) {
    const panel = makePanel(node, parent, opts);
    if (panel._id && !byId.has(panel._id)) byId.set(panel._id, panel);
    if (panel._id) byTagSample.push(panel);
    for (const child of node.children) {
      if (NON_PANEL[child.name]) continue;
      panel._children.push(walk(child, panel));
    }
    return panel;
  }

  const root = walk(detailsRootNode, null);
  return { root, byId };
}

/* ------------------------------------------------------------------ */
/* vm sandbox with controllable clock + fake $                          */
/* ------------------------------------------------------------------ */

const COMPILED = [
  new vm.Script(glossarySrc, { filename: "bba_glossary.js" }),
  new vm.Script(tmSrc, { filename: "bba_tm.generated.js" }),
  new vm.Script(layoutTokensSrc, { filename: "bba_layout_tokens.js" }),
  new vm.Script(translateSrc, { filename: "bba_translate.js" }),
];

function newHarness() {
  const state = { ctx: null, queue: [], msgs: [], writes: [] };
  const persistent = {};
  const dollarTarget = {
    GetContextPanel: () => state.ctx,
    Schedule: (delay, fn) => {
      state.queue.push({ fn, ctx: state.ctx, delay });
    },
    Msg: (msg) => state.msgs.push(String(msg)),
    Localize: (token) => (ENGINE_TEXT[token] !== undefined ? ENGINE_TEXT[token] : String(token || "")),
    PersistentStorage: {
      GetString: (k, d) => (Object.prototype.hasOwnProperty.call(persistent, k) ? persistent[k] : d),
      SetString: (k, v) => {
        persistent[k] = v;
      },
    },
    AsyncWebRequest: () => {},
    DispatchEvent: () => {},
    PlaySoundEffect: () => {},
  };
  const $ = new Proxy(dollarTarget, {
    get: (target, prop) => (prop in target ? target[prop] : function noop() {}),
    has: () => true,
  });

  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    $,
    __fakeNow: 1700000000000,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext("Date.now = function () { return __fakeNow; };", ctx);
  return { ctx, sandbox, state };
}

function advanceClock(h) {
  vm.runInContext("__fakeNow += 1000;", h.ctx);
}

function pump(h, maxSteps) {
  WRITE_LOG = h.state.writes;
  let steps = 0;
  while (h.state.queue.length > 0 && steps < maxSteps) {
    const item = h.state.queue.shift();
    const previous = h.state.ctx;
    h.state.ctx = item.ctx;
    try {
      item.fn();
    } catch (err) {
      h.state.msgs.push("[harness pump] " + String(err));
    }
    h.state.ctx = previous;
    steps += 1;
  }
  return steps;
}

function bootTree(h, buildOpts, keepWrites) {
  const tree = buildTree(buildOpts || {});
  h.state.ctx = tree.root;
  h.state.writes.length = 0;
  WRITE_LOG = h.state.writes;
  for (const script of COMPILED) script.runInContext(h.ctx);
  pump(h, 400);
  h.state.queue.length = 0; // stop the tick chain; assertions stay deterministic
  if (!keepWrites) h.state.writes.length = 0;
  return tree;
}

function globalOf(h, name) {
  return vm.runInContext(name, h.ctx);
}

function activate(h, action, origin) {
  advanceClock(h);
  WRITE_LOG = h.state.writes;
  const fn = globalOf(h, "BBTActivate");
  if (typeof fn !== "function") throw new Error("BBTActivate is not exported to globalThis");
  return fn(action, origin);
}

function isInTree(panel, root) {
  let p = panel;
  while (p) {
    if (p === root) return true;
    p = p._parent;
  }
  return false;
}

function countEvents(root) {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    for (const key in p._events) n += p._events[key].length;
    for (const c of p._children) stack.push(c);
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* [1] XML -> JS name contract                                         */
/* ------------------------------------------------------------------ */

console.log("== [1] XML -> JS handler-name contract ==");

check(detailsRootNode !== null, "细节布局解析出面板根", detailsRootNode ? detailsRootNode.name : "null");
checkEq(detailsRootNode && detailsRootNode.name, "CitadelBuildDetails", "细节布局根标签是 CitadelBuildDetails");
check(detailsXml.indexOf("BBTActivate") >= 0, "布局里出现 BBTActivate 入口");

function walkNodes(node, fn) {
  fn(node);
  for (const child of node.children) walkNodes(child, fn);
}

const handlerAttrs = []; // { nodeName, attr, value }
walkNodes(detailsRootNode, (node) => {
  for (const key of Object.keys(node.attrs)) {
    if (/^on[a-z]+$/.test(key)) {
      handlerAttrs.push({ nodeName: node.name, attr: key, value: node.attrs[key] });
    }
  }
});

check(handlerAttrs.length >= 10, "布局里至少 10 个 on* 事件处理属性", "found " + handlerAttrs.length);

const exported = new Set();
for (const m of translateSrc.matchAll(/expose\(\s*"([A-Za-z_$][\w$]*)"\s*,/g)) exported.add(m[1]);
for (const m of translateSrc.matchAll(/\bG\.([A-Za-z_$][\w$]*)\s*=/g)) exported.add(m[1]);

check(exported.has("BBTActivate"), "bbe_translate.js 导出 BBTActivate（expose）", [...exported].join(","));
for (const name of ["BBTTranslatePage", "BBTRefreshPage", "BBTSetLanguageMode", "BBTSetTargetLang", "BBTSavePageToTable", "BBTShowTableStats"]) {
  check(exported.has(name), "导出清单包含 " + name);
}

const LEGACY = ["BBTTranslatePage", "BBTRefreshPage", "BBTSetLanguageMode", "BBTSetTargetLang", "BBTSavePageToTable", "BBTShowTableStats"];
const enginePattern = /^(\$|Citadel|UI|Game|Dispatch|Players|CustomNetTable|Steam)/;

const bbtNames = new Set();
const unknownNames = new Set();
let bbtActivateCalls = 0;
let legacyHits = 0;
const notTwoArgs = [];

function splitArgs(src) {
  const args = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (const ch of src) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

function callsOf(expr, name) {
  const calls = [];
  let index = 0;
  while ((index = expr.indexOf(name + "(", index)) >= 0) {
    let i = index + name.length + 1;
    let depth = 1;
    let quote = null;
    for (; i < expr.length; i += 1) {
      const ch = expr.charAt(i);
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(expr.slice(index + name.length + 1, i));
    index = i + 1;
  }
  return calls;
}

for (const item of handlerAttrs) {
  const firstIdent = (/^\s*([A-Za-z_$][\w$]*)/.exec(item.value) || [])[1] || "";
  if (firstIdent.startsWith("BBT")) {
    bbtNames.add(firstIdent);
    check(exported.has(firstIdent), "handler " + item.attr + " 的首个名字在导出清单里: " + firstIdent, item.value);
  } else if (firstIdent && !firstIdent.startsWith("$") && !enginePattern.test(firstIdent)) {
    unknownNames.add(firstIdent);
  }
  for (const legacy of LEGACY) {
    if (new RegExp("\\b" + legacy + "\\s*\\(").test(item.value)) legacyHits += 1;
  }
  for (const body of callsOf(item.value, "BBTActivate")) {
    bbtActivateCalls += 1;
    const args = splitArgs(body);
    const okArgs = args.length === 2 && args[1].replace(/\s+/g, "").indexOf("$.GetContextPanel()") >= 0;
    if (!okArgs) notTwoArgs.push(item.attr + " -> " + body.trim());
  }
}

check(bbtNames.has("BBTActivate"), "布局里 BBT 侧唯一入口名是 BBTActivate", [...bbtNames].join(","));
check(unknownNames.size === 0, "布局里没有无法解析（既非引擎名也非导出名）的 handler", [...unknownNames].join(","));
checkEq(legacyHits, 0, "布局里不存在旧的裸名 handler（BBTTranslatePage() 等）");
check(bbtActivateCalls >= 6, "布局里 BBTActivate 调用数 >= 6", "found " + bbtActivateCalls);
checkEq(notTwoArgs.length, 0, "所有 BBTActivate 调用都带两个参数且第二个是 $.GetContextPanel()", notTwoArgs.join(" | "));

const modeButtonXml = detailsXml.match(/<[^>]*\bid="BBTModeButton2"[^>]*>/);
const modeButtonTag = modeButtonXml ? decodeEntities(modeButtonXml[0]) : null;
check(modeButtonXml !== null, "布局里存在 BBTModeButton2");
if (modeButtonTag) {
  check(/onactivate="[^"]*BBTActivate\('mode:next'/.test(modeButtonTag), "模式按钮 onactivate 走 BBTActivate('mode:next')");
  check(/onmouseactivate="[^"]*BBTActivate\('mode:next'/.test(modeButtonTag), "模式按钮还挂了 onmouseactivate（第二激活事件）");
}

/* ------------------------------------------------------------------ */
/* [2] multi-instance isolation                                        */
/* ------------------------------------------------------------------ */

console.log("== [2] visible details instance (A) vs hidden tooltip copy (B) ==");

const h = newHarness();
const A = bootTree(h, {});
const B = bootTree(h, {});

checkMatch(h.state.msgs.filter((m) => /\] v\d+\.\d+\.\d+ loaded/.test(m)).length >= 2 ? "ok" : "missing", /ok/, "两个实例各打印一条 loaded 日志");
checkEq(A.byId.get("BBTModeButton2").text, "中", "A 模式按钮初始显示 中");
checkEq(B.byId.get("BBTModeButton2").text, "中", "B 模式按钮初始显示 中");

const aMode = A.byId.get("BBTModeButton2");
const bMode = B.byId.get("BBTModeButton2");
const aRefresh = A.byId.get("BBTRefreshButton2");
const bRefresh = B.byId.get("BBTRefreshButton2");
const aTranslate = A.byId.get("BBTTranslateButton2");
const bTranslate = B.byId.get("BBTTranslateButton2");

activate(h, "mode:next", A.byId.get("BBTModeButton2"));
checkEq(aMode.text, "原", "点可见实例模式按钮 -> A 从 中 循环到 原");
checkEq(bMode.text, "中", "A 点击不改隐藏副本 B 的模式按钮");

advanceClock(h);
activate(h, "mode:next", A.byId.get("BBTModeButton2"));
checkEq(aMode.text, "双", "再次点击 A 模式按钮 -> 原 -> 双");

advanceClock(h);
activate(h, "mode:next", A.byId.get("BBTModeButton2"));
checkEq(aMode.text, "中", "第三次点击 A 模式按钮 -> 双 -> 中");

activate(h, "mode:next", B.byId.get("BBTModeButton2"));
checkEq(bMode.text, "原", "点隐藏副本模式按钮 -> B 从 中 循环到 原");
checkEq(aMode.text, "中", "B 点击不影响 A 模式按钮");

const bModeBeforeRefresh = bMode.text;
h.state.writes.length = 0;
activate(h, "refresh", aRefresh);
checkMatch(aRefresh.text, /^已刷新 \d+$/, "A 刷新按钮显示已刷新 N 条");
checkEq(bRefresh.text, "刷新", "A 刷新不写脏隐藏副本 B 的刷新按钮（v1.9.7 bug）");
checkEq(bTranslate.text, "翻译", "A 刷新不写脏隐藏副本 B 的翻译按钮");
checkEq(bMode.text, bModeBeforeRefresh, "A 刷新不写 B 的模式按钮");
check(h.state.writes.length > 0, "A 刷新产生了写操作", "writes=" + h.state.writes.length);
check(
  h.state.writes.every((w) => isInTree(w.panel, A.root)),
  "A 刷新只写 A 树",
  h.state.writes
    .filter((w) => !isInTree(w.panel, A.root))
    .map((w) => w.prop + ":" + w.to)
    .join(" | ")
);
checkEq(aTranslate.text, "翻译", "A 刷新不把“翻译”标签写成刷新文案");

pump(h, 400);
checkEq(aRefresh.text, "刷新", "刷新反馈 1.6s 后复位为“刷新”");

const aModeBeforeBRefresh = aMode.text;
h.state.writes.length = 0;
activate(h, "refresh", bRefresh);
checkMatch(bRefresh.text, /^已刷新 \d+$/, "B 刷新按钮显示已刷新 N 条");
checkEq(aRefresh.text, "刷新", "B 刷新不写脏 A 的刷新按钮");
checkEq(aTranslate.text, "翻译", "B 刷新不写脏 A 的翻译按钮");
checkEq(aMode.text, aModeBeforeBRefresh, "B 刷新不写 A 的模式按钮");
check(
  h.state.writes.every((w) => isInTree(w.panel, B.root)),
  "B 刷新只写 B 树",
  h.state.writes
    .filter((w) => !isInTree(w.panel, B.root))
    .map((w) => w.prop + ":" + w.to)
    .join(" | ")
);

/* ------------------------------------------------------------------ */
/* [3] refresh feedback lands on the refresh button itself             */
/* ------------------------------------------------------------------ */

console.log("== [3] refresh feedback on the refresh button itself ==");

const h3 = newHarness();
const C = bootTree(h3, {});
const cRefresh = C.byId.get("BBTRefreshButton2");
const cTranslate = C.byId.get("BBTTranslateButton2");

h3.state.writes.length = 0;
activate(h3, "refresh", cRefresh);
const refreshWrites = h3.state.writes.filter((w) => w.panel === cRefresh);
check(refreshWrites.length >= 2, "刷新按钮在一次刷新里被写多次（进度 + 结果）", "writes=" + refreshWrites.length);
checkEq(refreshWrites[0] ? refreshWrites[0].to : "", "刷新中…", "第一次写是“刷新中…”进度");
check(
  refreshWrites.some((w) => /^已刷新 \d+$/.test(w.to)),
  "随后写入“已刷新 N”结果",
  refreshWrites.map((w) => w.to).join(" -> ")
);
check(
  !h3.state.writes.some((w) => w.panel === cTranslate && w.to === "刷新中…"),
  "刷新不会把“翻译”按钮写成“刷新中…”"
);

pump(h3, 400);
checkEq(cRefresh.text, "刷新", "刷新按钮最终复位为“刷新”");

/* ------------------------------------------------------------------ */
/* [4] missing export is visible                                       */
/* ------------------------------------------------------------------ */

console.log("== [4] missing handler export is reported ==");

const h4 = newHarness();
vm.runInContext(
  "Object.defineProperty(globalThis, 'BBTActivate', {" +
    " configurable: true," +
    " get: function () { return undefined; }," +
    " set: function () { throw new Error('blocked by wiring_simtest'); }" +
    "});",
  h4.ctx
);
bootTree(h4, {}, true);

check(
  h4.state.msgs.some((m) => /HANDLER EXPORT FAILED/.test(m) && /BBTActivate/.test(m)),
  "boot 日志出现 HANDLER EXPORT FAILED 且点名 BBTActivate",
  h4.state.msgs.filter((m) => /EXPORT/.test(m)).join(" | ")
);
checkEq(globalOf(h4, "typeof BBTActivate"), "undefined", "globalThis.BBTActivate 确实没有被导出");

/* ------------------------------------------------------------------ */
/* [5] engine SetPanelEvent support: absent and present                */
/* ------------------------------------------------------------------ */

console.log("== [5] works with and without engine SetPanelEvent support ==");

const h5 = newHarness();
const E = bootTree(h5, { supportsEvents: false });
checkEq(typeof E.byId.get("BBTModeButton2").SetPanelEvent, "undefined", "无 SetPanelEvent 的假面板确实没有该方法");
check(
  h5.state.msgs.some((m) => /toolbar wired: 0 control\(s\)/.test(m)),
  "无 SetPanelEvent 时脚本报告 0 个控件被绑定",
  h5.state.msgs.filter((m) => /wired/.test(m)).join(" | ")
);
activate(h5, "mode:next", E.byId.get("BBTModeButton2"));
checkEq(E.byId.get("BBTModeButton2").text, "原", "无 SetPanelEvent 时 XML inline 路径仍能循环模式");

const h6 = newHarness();
const F = bootTree(h6, {});
const fModeBtn = F.byId.get("BBTModeButton2");
checkEq((fModeBtn._events.onactivate || []).length, 1, "有 SetPanelEvent 时模式按钮被脚本绑定一次");
checkEq(countEvents(F.root), 3, "脚本共绑定 3 个 onactivate 事件");
checkEq(globalOf(h6, "typeof BBTActivate"), "function", "有 SetPanelEvent 时全局入口已导出");

advanceClock(h6);
const speHandler = fModeBtn._events.onactivate[0];
speHandler();
checkEq(F.byId.get("BBTModeButton2").text, "原", "直接调用 SetPanelEvent 回调也能循环模式");
advanceClock(h6);
speHandler();
checkEq(F.byId.get("BBTModeButton2").text, "双", "SetPanelEvent 回调第二次调用循环到双");

// The same button keeps BOTH the XML inline handler and the script's
// SetPanelEvent binding: either path alone may be the one this engine delivers,
// so both stay. A real click therefore reaches the script twice in the same
// frame, and uiGuard's cross-path marker (BBTActMark2 in the clicked instance's
// own tree, plus the global ledger) drops the second delivery.
check(modeButtonTag !== null && /onactivate="[^"]*BBTActivate\('mode:next'/.test(modeButtonTag), "模式按钮同时有 XML inline handler");
checkEq((fModeBtn._events.onactivate || []).length, 1, "模式按钮同时有脚本 SetPanelEvent 绑定（两条路径由 marker 去重）");

/* ------------------------------------------------------------------ */
/* [6] full-click diagnostic: XML inline handler + SetPanelEvent        */
/* ------------------------------------------------------------------ */

console.log("== [6] full-click diagnostic (inline XML handler + SetPanelEvent) ==");

// One physical click runs BOTH paths in the same frame: the layout's inline
// onactivate (BBTActivate(...), resolved in the layout global scope) and the
// script's SetPanelEvent("onactivate") callback. The two paths can be evaluated
// by different booted instances (visible details + tooltip copy), so the ledger
// lives in the clicked instance's tree (BBTActMark2) as well as on the global.
const hd = newHarness();
const XA = bootTree(hd, {});
const XB = bootTree(hd, {});

const inlineExprMatch = modeButtonTag ? modeButtonTag.match(/onactivate="([^"]*)"/) : null;
const inlineExpr = inlineExprMatch ? inlineExprMatch[1] : "";
const xMode = XA.byId.get("BBTModeButton2");
const xModeBtn = XA.byId.get("BBTModeButton2");

hd.state.ctx = XA.root;
advanceClock(hd);
const beforeClick = xMode.text;
vm.runInContext(inlineExpr, hd.ctx);
const afterInline = xMode.text;
const xSpe = (xModeBtn._events.onactivate || [])[0];
if (typeof xSpe === "function") xSpe();
const afterSpe = xMode.text;

console.log(
  "INFO  click vv: before=" + beforeClick + " -> inline=" + afterInline + " -> +SetPanelEvent=" + afterSpe
);
check(
  afterInline === "原" && afterSpe === "原",
  "一次点击只循环一次：inline 从 中 到 原，SetPanelEvent 第二次投递被去重丢弃（不会跳到 双）",
  "before=" + beforeClick + " inline=" + afterInline + " after=" + afterSpe
);
checkEq(XB.byId.get("BBTModeButton2").text, "中", "tooltip 副本的模式按钮不受牵连");
checkEq(XA.byId.get("BBTActMark2").text.indexOf("act:mode:next@"), 0, "去重 marker 写在被点实例自己的树里");

/* ------------------------------------------------------------------ */
/* [7] v1.9.9: toolbar row on the layout root + never write a #token   */
/* ------------------------------------------------------------------ */

console.log("== [7] v1.9.13 toolbar in the engine control row + no token writes ==");

// Panorama only hit-tests inside the parent's bounds. v1.9.8 put the toolbar
// row inside #BuildInfo (clipped), v1.9.9 moved it to the layout root (pushed
// below the tall .HeroBuildsExtraInfo), and v1.9.10/v1.9.11 tried an overlay
// that compressed the overview. v1.9.13 dropped the wrapper entirely and the
// native "Fill" style inflated each bare button in #ControlArea to full width,
// pushing the rest out of view; v1.9.14 restores a compact #BBTControls2
// wrapper (flow-children:right) inside #ControlArea, before #BuildControls:
// no overlay, no spacer, no measuring, intrinsic-width buttons.
const g7 = newHarness();
const G7 = bootTree(g7, {}, true);
const tBtn = G7.byId.get("BBTTranslateButton2");
const tParent = tBtn ? tBtn.GetParent() : null;
check(G7.byId.get("BBTControls2") !== undefined, "有 BBTControls2 包裹层");
checkEq(tParent && tParent.id, "BBTControls2", "翻译按钮挂在 #BBTControls2 包裹层里");
checkEq(G7.byId.get("BBTControls2").GetParent().id, "ControlArea", "BBTControls2 包裹层挂在 #ControlArea 里");
checkEq(G7.byId.get("BBTRefreshButton2").GetParent().id, "BBTControls2", "刷新按钮挂在 #BBTControls2 里");
checkEq(G7.byId.get("BBTModeButton2").GetParent().id, "BBTControls2", "模式按钮挂在 #BBTControls2 里");
check(G7.byId.get("BBTLayer2") === undefined, "没有 BBTLayer2 覆盖层");
check(G7.byId.get("BBTBar2") === undefined, "没有 BBTBar2 独立行");
check(G7.byId.get("BBTSlot2") === undefined, "没有 BBTSlot2 占位");
check(G7.byId.get("BBTMenu2") === undefined, "没有 BBTMenu2 下拉");
checkEq(G7.byId.get("BBTModeButton2").text, "中", "模式按钮初始为 中");

// The in-game build page gets one extra button in the engine's own header row:
// first child of #ControlButtons, i.e. immediately left of the info icon (the
// slot the player pointed at). The same layout is embedded in the browser, so
// the button is collapsed by default and shown only on the standalone page.
const shopXml = fs.readFileSync(path.join(ROOT, "mod", "panorama", "layout", "citadel_shop_mods_build.xml"), "utf8");
const bbaCss = fs.readFileSync(path.join(ROOT, "mod", "panorama", "styles", "bba.css"), "utf8");
const headerBtnXml = shopXml.match(/<[^>]*\bid="BBTTranslateButton3"[^>]*>/);
const headerBtnTag = headerBtnXml ? decodeEntities(headerBtnXml[0]) : null;
const controlButtonsIdx = shopXml.indexOf('<Panel id="ControlButtons">');
check(headerBtnXml !== null, "游戏内出装页头部有翻译按钮（#BBTTranslateButton3）");
check(
  controlButtonsIdx >= 0 && shopXml.indexOf('id="BBTTranslateButton3"') > controlButtonsIdx,
  "头部按钮在 #ControlButtons 行内（信息图标左侧）"
);
check(headerBtnTag !== null && /BBTActivate\('translate'/.test(headerBtnTag), "头部按钮走 BBTActivate('translate')（与浏览器的翻译同一条路径）");
check(/#BBTTranslateButton3\s*\{[^}]*visibility:\s*collapse/.test(bbaCss), "头部按钮默认折叠（内嵌到出装浏览器时不重复出现）");
check(/\.BBTShow[^}]*visibility:\s*visible/.test(bbaCss), "头部按钮用 .BBTShow 显形（行内样式 + 类两道保险）");

// The in-game page has no toolbar and no status label: the header button is the
// only place a result can show up, otherwise pressing it looks like nothing
// happened ("点击翻译按钮无效果", 2026-11-01).
check(
  /function uiSetLabel[\s\S]{0,1200}BBTTranslateButton3/.test(translateSrc),
  "uiSetLabel 会回退到头部按钮写进度（该布局没有工具条/状态行）"
);
check(/function uiResetLabel/.test(translateSrc), "uiResetLabel 按布局恢复按钮标题（翻译）");
// layoutRoot() returns the HUD root in game, so pageRoot() must snap to the
// nearest page-ish ancestor or the scan starts above the page and its 3000-panel
// budget runs out before reaching it.
check(
  /function pageRoot\([\s\S]{0,1600}CitadelShopModsBuild/.test(translateSrc),
  "pageRoot 从被点控件向上找 CitadelShopModsBuild（不会一路走到 HUD 根）"
);

// The v1.9.8 flicker root cause: the resync path used to write the declared
// #token back into label.text, and Panorama does not re-localize a token that
// JS assigns, so the label rendered "#Citadel_HeroBuilds_CategoryDescription"
// literally and the next scan translated it again. No write may ever start
// with "#".
const tokenWrites = g7.state.writes.filter((w) => w.prop === "text" && String(w.to).charAt(0) === "#");
checkEq(tokenWrites.length, 0, "没有任何写操作把 #token 写进 label.text（v1.9.8 闪烁根因）");

/* ------------------------------------------------------------------ */
/* [8] S1: root resolution reads panel.tag, not paneltype             */
/* ------------------------------------------------------------------ */

console.log("== [8] S1: 根解析用 tag（paneltype 缺失也能工作） ==");

// The engine reports the layout name on panel.tag; panel.paneltype is only
// populated on a subset of panels, so reading paneltype is unreliable. A fake
// tree whose panels carry NO paneltype must still resolve its root and wire
// the toolbar.
const g8 = newHarness();
const G8 = bootTree(g8, { noPaneltype: true }, true);
const bootLine8 = g8.state.msgs.find((m) => m.indexOf("loaded") >= 0);
check(bootLine8 !== undefined, "无 paneltype 的树 boot 后仍有 loaded 日志");
check(
  /in layout: CitadelBuildDetails/.test(bootLine8 || ""),
  "boot 从 tag 读出 layout 名（paneltype 缺失时仍对）",
  bootLine8 || ""
);
checkEq(G8.byId.get("BBTModeButton2").text, "中", "无 paneltype 时模式按钮仍被接线（根解析未断）");
check(
  /function panelTag\s*\(/.test(translateSrc) && /String\(p\.tag \|\| p\.paneltype/.test(translateSrc),
  "panelTag 先读 tag 再读 paneltype"
);

/* ------------------------------------------------------------------ */

console.log("");
console.log("checks: " + checks + ", failures: " + failures);
if (failures > 0) {
  console.error("WIRING CHECKS FAILED (" + failures + ")");
  process.exit(1);
}
console.log("ALL WIRING CHECKS PASSED");
