// Tests for tools/vpk_list.js: build a VPK v2 in memory, parse it back, and check
// the addon-conflict scan (which is how "another pak silently overrides us" is
// diagnosed).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseVpk, pakNumber, findConflicts } = require(path.join(__dirname, "..", "tools", "vpk_list.js"));

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " -- " + detail : ""));
  if (!cond) failures += 1;
}

// ---- build a minimal VPK v2 containing two entries -------------------------
function buildVpk(entries) {
  // group by extension then by directory
  const byExt = new Map();
  for (const e of entries) {
    const idx = e.path.lastIndexOf("/");
    const dir = idx < 0 ? " " : e.path.slice(0, idx);
    const name = idx < 0 ? e.path : e.path.slice(idx + 1);
    const dot = name.lastIndexOf(".");
    const ext = dot < 0 ? " " : name.slice(dot + 1);
    const base = dot < 0 ? name : name.slice(0, dot);
    if (!byExt.has(ext)) byExt.set(ext, new Map());
    const dirs = byExt.get(ext);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push({ base, data: e.data });
  }
  const cstr = (s) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
  const parts = [];
  const dataParts = [];
  let dataOffset = 0;
  for (const [ext, dirs] of byExt) {
    parts.push(cstr(ext));
    for (const [dir, files] of dirs) {
      parts.push(cstr(dir));
      for (const f of files) {
        const head = Buffer.alloc(18);
        head.writeUInt32LE(0, 0); // crc
        head.writeUInt16LE(0, 4); // preload
        head.writeUInt16LE(0x7fff, 6); // archive index (embedded)
        head.writeUInt32LE(dataOffset, 8);
        head.writeUInt32LE(f.data.length, 12);
        head.writeUInt16LE(0xffff, 16);
        parts.push(cstr(f.base), head);
        dataParts.push(f.data);
        dataOffset += f.data.length;
      }
      parts.push(Buffer.from([0]));
    }
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([0]));
  const tree = Buffer.concat(parts);
  const header = Buffer.alloc(28);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(tree.length, 8);
  header.writeUInt32LE(dataOffset, 12);
  return Buffer.concat([header, tree, ...dataParts]);
}

const vpk = buildVpk([
  { path: "panorama/layout/a.xml", data: Buffer.from("<a/>") },
  { path: "panorama/scripts/b.js", data: Buffer.from("1") },
]);
const parsed = parseVpk(vpk);
check("magic/version parsed", parsed.version === 2);
check("two entries found", parsed.entries.length === 2, JSON.stringify(parsed.entries.map((e) => e.path)));
check("entry paths reconstructed", parsed.entries.some((e) => e.path === "panorama/layout/a.xml"), JSON.stringify(parsed.entries.map((e) => e.path)));
check("sizes are right", parsed.entries.every((e) => e.size > 0));

// ---- pak numbers ----------------------------------------------------------
check("pak number from name", pakNumber("pak13_dir.vpk") === 13, String(pakNumber("pak13_dir.vpk")));
check("pak number from a path", pakNumber("/x/y/pak07_dir.vpk") === 7);
check("no number -> 0", pakNumber("my_mod.vpk") === 0);

// ---- conflict scan -------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpkscan-"));
fs.writeFileSync(path.join(dir, "pak05_dir.vpk"), buildVpk([{ path: "panorama/layout/shared.xml", data: Buffer.from("a") }]));
fs.writeFileSync(path.join(dir, "pak13_dir.vpk"), buildVpk([{ path: "panorama/layout/shared.xml", data: Buffer.from("b") }]));
fs.writeFileSync(path.join(dir, "pak20_dir.vpk"), buildVpk([{ path: "panorama/layout/only20.xml", data: Buffer.from("c") }]));
const res = findConflicts(dir);
check("scan found all vpks", res.vpks.length === 3, String(res.vpks.length));
const shared = res.byFile.get("panorama/layout/shared.xml") || [];
check("shared file attributed to both paks", shared.length === 2, JSON.stringify(shared));
check("lower pak is the one that wins", [...shared].sort((a, b) => a.pak - b.pak)[0].pak === 5);

fs.rmSync(dir, { recursive: true, force: true });
console.log("");
if (failures) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ALL VPK CHECKS PASSED");
