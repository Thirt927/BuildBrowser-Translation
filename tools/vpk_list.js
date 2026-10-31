// VPK inspector: list the contents of a VPK and find addon conflicts.
//
// Two uses:
//   1. see what a mod actually ships            ->  node tools/vpk_list.js <file.vpk>
//   2. find WHY a layout override is not taking  ->  node tools/vpk_list.js --addons "<Deadlock>/game/citadel/addons"
//
// Case 2 matters because addons are loaded by pak number (lower number wins), so
// another mod that ships the same panorama file silently overrides ours. This
// prints, per file, every addon that provides it plus the winning one.
//
// Format: VPK v1/v2 directory tree (no external dependencies).
"use strict";

const fs = require("fs");
const path = require("path");

const MAGIC = 0x55aa1234;

function readCString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end += 1;
  return { s: buf.toString("utf8", off, end), next: end + 1 };
}

/** Parse a VPK directory tree. Returns { version, entries:[{path,...}] }. */
function parseVpk(buf) {
  if (buf.length < 12 || buf.readUInt32LE(0) !== MAGIC) throw new Error("not a VPK file");
  const version = buf.readUInt32LE(4);
  const treeSize = buf.readUInt32LE(8);
  const headerSize = version === 1 ? 12 : 28;
  const treeEnd = headerSize + treeSize;
  const dataOffset = treeEnd; // archive 0 lives directly after the tree
  const entries = [];
  let off = headerSize;
  while (off < treeEnd) {
    const ext = readCString(buf, off);
    if (!ext.s) break;
    off = ext.next;
    while (off < treeEnd) {
      const pth = readCString(buf, off);
      if (!pth.s) break;
      off = pth.next;
      while (off < treeEnd) {
        const name = readCString(buf, off);
        if (!name.s) break;
        off = name.next;
        if (off + 18 > treeEnd) throw new Error("truncated tree");
        const preload = buf.readUInt16LE(off + 4);
        const archIndex = buf.readUInt16LE(off + 6);
        const entryOffset = buf.readUInt32LE(off + 8);
        const entryLength = buf.readUInt32LE(off + 12);
        off += 18;
        const dir = pth.s === " " ? "" : pth.s + "/";
        const suffix = name.s.endsWith("." + ext.s) ? "" : "." + ext.s;
        entries.push({
          path: (dir + name.s + suffix).replace(/\/+/g, "/"),
          preload,
          archIndex,
          entryOffset,
          entryLength,
          dataOffset,
          size: preload + entryLength,
        });
      }
      off += 1;
    }
    off += 1;
  }
  return { version, treeSize, entries };
}

function listVpk(file) {
  const buf = fs.readFileSync(file);
  const vpk = parseVpk(buf);
  return { file, version: vpk.version, entries: vpk.entries, buf };
}

/** pak number from a VPK name: pak07_dir.vpk -> 7 (0 when it has none). */
function pakNumber(file) {
  const base = String(file).split(/[\\/]/).pop();
  const m = /^pak(\d+)(?:_dir)?\.vpk$/i.exec(base);
  return m ? Number(m[1]) : 0;
}

/** Group addon VPKs by the panorama files they provide (lower pak wins). */
function findConflicts(dir) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.vpk$/i.test(e.name)) files.push(p);
    }
  })(dir);

  const byFile = new Map(); // entry path -> [{vpk, pak}]
  for (const f of files) {
    let parsed;
    try {
      parsed = listVpk(f);
    } catch (e) {
      continue; // not a VPK (could be an _000.vpk chunk etc.)
    }
    for (const e of parsed.entries) {
      if (!byFile.has(e.path)) byFile.set(e.path, []);
      byFile.get(e.path).push({ vpk: path.basename(f), pak: pakNumber(f) });
    }
  }
  return { vpks: files, byFile };
}

// ---------------------------------------------------------------- CLI

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

if (require.main === module) {
  const addons = arg("addons", "");
  const filter = String(arg("filter", "") || "");
  const target = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";

  if (addons) {
    if (!fs.existsSync(addons)) {
      console.error("addons folder not found: " + addons);
      process.exit(2);
    }
    const { vpks, byFile } = findConflicts(addons);
    console.log("scanned " + vpks.length + " VPK(s) in " + addons);
    const panorama = [...byFile.entries()].filter(([p]) => p.indexOf("panorama/") === 0);
    const clashing = panorama.filter(([, list]) => list.length > 1);
    console.log("panorama files provided by any addon: " + panorama.length);
    console.log("provided by more than one addon : " + clashing.length);
    if (clashing.length) {
      console.log("");
      console.log("conflicts (lower pak number wins):");
      for (const [file, list] of clashing.sort((a, b) => a[0].localeCompare(b[0]))) {
        const sorted = [...list].sort((a, b) => a.pak - b.pak);
        console.log("  " + file);
        for (const l of sorted) {
          console.log("      pak" + String(l.pak).padStart(2, "0") + "  " + l.vpk + (l === sorted[0] ? "   <= wins" : ""));
        }
      }
    }
    const mine = panorama.filter(([p]) => /bba_|citadel_ui_build_selector|citadel_ui_build_details|citadel_shop_mods_build|citadel_tooltip_(mod|build)_details/.test(p));
    if (mine.length) {
      console.log("");
      console.log("BBT-relevant files and who provides them:");
      for (const [file, list] of mine.sort((a, b) => a[0].localeCompare(b[0]))) {
        const winner = [...list].sort((a, b) => a.pak - b.pak)[0];
        console.log("  " + file + "  ->  " + winner.vpk + " (pak" + winner.pak + ")" + (winner.vpk.indexOf("pak") === 0 && list.length > 1 ? "  [CHECK]" : ""));
      }
    }
    process.exit(0);
  }

  if (!target) {
    console.error("usage:");
    console.error("  node tools/vpk_list.js <file.vpk> [--filter panorama/layout]");
    console.error('  node tools/vpk_list.js --addons "<Deadlock>/game/citadel/addons"');
    process.exit(2);
  }
  const info = listVpk(target);
  const rows = info.entries.filter((e) => !filter || e.path.indexOf(filter) >= 0);
  console.log(path.basename(target) + ": VPK v" + info.version + ", " + info.entries.length + " entries");
  for (const e of rows.sort((a, b) => a.path.localeCompare(b.path))) {
    console.log("  " + e.path + "  (" + e.size + " bytes)");
  }
}

module.exports = { parseVpk, listVpk, pakNumber, findConflicts };
