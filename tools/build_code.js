// BuildBrowser Translation (BBT)
// Deadlock build share-code codec: base64(zstd(CMsgHeroBuild protobuf)).
//
// Field layout follows Valve's CMsgHeroBuild (see deadlock-api
// scripts/export_deadlock_hero_build_blobs.py):
//   1 hero_build_id, 2 hero_id, 3 author_account_id, 4 last_updated_timestamp,
//   5 name, 6 description, 7 language, 8 version, 9 origin_build_id,
//   10 details, 11 tags (repeated), 12 development_build, 13 publish_timestamp
// details:      1 mod_categories (repeated), 2 ability_order
// mod_category: 1 mods (repeated), 2 name, 3 description, 4 width, 5 height, 6 optional
// mod:          1 ability_id, 2 annotation, 3 required_flex_slots,
//               4 sell_priority, 5 imbue_target_ability_id
// ability_order / currency_change: 1 ability_id, 2 currency_type, 3 delta, 4 annotation
"use strict";

const zlib = require("zlib");

function readVarint(buf, index) {
  let value = 0;
  let shift = 0;
  while (true) {
    if (index >= buf.length) throw new Error("truncated varint");
    const byte = buf[index++];
    value |= (byte & 0x7f) << shift;
    if (byte < 0x80) return [value >>> 0, index];
    shift += 7;
    if (shift > 63) throw new Error("varint too long");
  }
}

function parseFields(buf) {
  const fields = [];
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      let value;
      [value, i] = readVarint(buf, i);
      fields.push({ field, wire: 0, value });
    } else if (wire === 1) {
      fields.push({ field, wire: 1, value: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      fields.push({ field, wire: 2, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      fields.push({ field, wire: 5, value: buf.subarray(i, i + 4) });
      i += 4;
    } else {
      throw new Error("unsupported protobuf wire type " + wire + " at " + i);
    }
  }
  return fields;
}

function readString(field) {
  return field ? field.value.toString("utf8") : null;
}

function readFloat(field) {
  if (!field) return null;
  if (field.wire === 5) return field.value.readFloatLE(0);
  return null;
}

function decodeMod(buf) {
  const mod = {
    ability_id: null,
    annotation: null,
    required_flex_slots: null,
    sell_priority: null,
    imbue_target_ability_id: null,
  };
  for (const f of parseFields(buf)) {
    if (f.field === 1 && f.wire === 0) mod.ability_id = f.value;
    else if (f.field === 2 && f.wire === 2) mod.annotation = readString(f);
    else if (f.field === 3 && f.wire === 0) mod.required_flex_slots = f.value;
    else if (f.field === 4 && f.wire === 0) mod.sell_priority = f.value;
    else if (f.field === 5 && f.wire === 0) mod.imbue_target_ability_id = f.value;
  }
  return mod;
}

function decodeCategory(buf) {
  const cat = { name: null, description: null, width: null, height: null, optional: false, mods: [] };
  for (const f of parseFields(buf)) {
    if (f.field === 1 && f.wire === 2) cat.mods.push(decodeMod(f.value));
    else if (f.field === 2 && f.wire === 2) cat.name = readString(f);
    else if (f.field === 3 && f.wire === 2) cat.description = readString(f);
    else if (f.field === 4) cat.width = readFloat(f);
    else if (f.field === 5) cat.height = readFloat(f);
    else if (f.field === 6 && f.wire === 0) cat.optional = f.value !== 0;
  }
  return cat;
}

function decodeAbilityOrder(buf) {
  const order = [];
  for (const f of parseFields(buf)) {
    if (f.field !== 1 || f.wire !== 2) continue;
    const change = { ability_id: null, currency_type: null, delta: null, annotation: null };
    for (const c of parseFields(f.value)) {
      if (c.field === 1 && c.wire === 0) change.ability_id = c.value;
      else if (c.field === 2 && c.wire === 0) change.currency_type = c.value;
      else if (c.field === 3 && c.wire === 0) change.delta = c.value;
      else if (c.field === 4 && c.wire === 2) change.annotation = readString(c);
    }
    order.push(change);
  }
  return order;
}

function decodeDetails(buf) {
  const details = { mod_categories: [], ability_order: [] };
  for (const f of parseFields(buf)) {
    if (f.field === 1 && f.wire === 2) details.mod_categories.push(decodeCategory(f.value));
    else if (f.field === 2 && f.wire === 2) details.ability_order = decodeAbilityOrder(f.value);
  }
  return details;
}

/** Decode a share code into JSON.
 *  Accepts base64(zstd(CMsgHeroBuild)) or a bare (uncompressed) protobuf
 *  payload: the zstd frame magic 0x28b52ffd decides, everything else is
 *  parsed as protobuf directly. */
function decode(code) {
  const raw = Buffer.from(String(code).trim(), "base64");
  // Detect zstd frame vs bare protobuf.
  const magic = raw.subarray(0, 4).toString("hex");
  let parsed = raw;
  if (magic === "28b52ffd") {
    if (typeof zlib.zstdDecompressSync !== "function") {
      throw new Error(
        "this Node.js build has no zstd support (" + process.version + "); use Node >= 22.15 (24 recommended)",
      );
    }
    parsed = zlib.zstdDecompressSync(raw);
  }

  const build = {
    hero_build_id: null,
    hero_id: null,
    author_account_id: null,
    last_updated_timestamp: null,
    name: null,
    description: null,
    language: null,
    version: null,
    origin_build_id: null,
    tags: [],
    development_build: null,
    publish_timestamp: null,
    details: { mod_categories: [], ability_order: [] },
  };
  for (const f of parseFields(parsed)) {
    if (f.field === 1 && f.wire === 0) build.hero_build_id = f.value;
    else if (f.field === 2 && f.wire === 0) build.hero_id = f.value;
    else if (f.field === 3 && f.wire === 0) build.author_account_id = f.value;
    else if (f.field === 4 && f.wire === 0) build.last_updated_timestamp = f.value;
    else if (f.field === 5 && f.wire === 2) build.name = readString(f);
    else if (f.field === 6 && f.wire === 2) build.description = readString(f);
    else if (f.field === 7 && f.wire === 0) build.language = f.value;
    else if (f.field === 8 && f.wire === 0) build.version = f.value;
    else if (f.field === 9 && f.wire === 0) build.origin_build_id = f.value;
    else if (f.field === 10 && f.wire === 2) build.details = decodeDetails(f.value);
    else if (f.field === 11 && f.wire === 0) build.tags.push(f.value);
    else if (f.field === 12 && f.wire === 0) build.development_build = f.value !== 0;
    else if (f.field === 13 && f.wire === 0) build.publish_timestamp = f.value;
  }
  return build;
}

// ---------------- encoder ----------------

function varint(value) {
  const bytes = [];
  let v = Number(value) >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function key(field, wire) {
  return varint((field << 3) | wire);
}

function fieldVarint(field, value) {
  return value === null || value === undefined ? Buffer.alloc(0) : Buffer.concat([key(field, 0), varint(value)]);
}

function fieldString(field, value) {
  if (value === null || value === undefined) return Buffer.alloc(0);
  const body = Buffer.from(String(value), "utf8");
  return Buffer.concat([key(field, 2), varint(body.length), body]);
}

function fieldMessage(field, body) {
  if (!body || !body.length) return Buffer.alloc(0);
  return Buffer.concat([key(field, 2), varint(body.length), body]);
}

function fieldFloat(field, value) {
  if (value === null || value === undefined) return Buffer.alloc(0);
  const b = Buffer.alloc(4);
  b.writeFloatLE(Number(value), 0);
  return Buffer.concat([key(field, 5), b]);
}

function encodeMod(mod) {
  return Buffer.concat([
    fieldVarint(1, mod.ability_id),
    fieldString(2, mod.annotation),
    fieldVarint(3, mod.required_flex_slots),
    fieldVarint(4, mod.sell_priority),
    fieldVarint(5, mod.imbue_target_ability_id),
  ]);
}

function encodeCategory(cat) {
  return Buffer.concat([
    ...(cat.mods || []).map((m) => fieldMessage(1, encodeMod(m))),
    fieldString(2, cat.name),
    fieldString(3, cat.description),
    fieldFloat(4, cat.width),
    fieldFloat(5, cat.height),
    fieldVarint(6, cat.optional ? 1 : 0),
  ]);
}

function encodeAbilityChange(change) {
  return Buffer.concat([
    fieldVarint(1, change.ability_id),
    fieldVarint(2, change.currency_type),
    fieldVarint(3, change.delta),
    fieldString(4, change.annotation),
  ]);
}

function encodeDetails(details) {
  const parts = (details.mod_categories || []).map((c) => fieldMessage(1, encodeCategory(c)));
  const order = details.ability_order || [];
  if (order.length) {
    const body = Buffer.concat(order.map((ch) => fieldMessage(1, encodeAbilityChange(ch))));
    parts.push(fieldMessage(2, body));
  }
  return Buffer.concat(parts);
}

/** Encode a JSON build back into a share code (lossless round-trip: all
 *  decoded fields, including ability_order and development_build, are
 *  preserved). */
function encode(build) {
  const parts = [
    fieldVarint(1, build.hero_build_id),
    fieldVarint(2, build.hero_id),
    fieldVarint(3, build.author_account_id),
    fieldVarint(4, build.last_updated_timestamp),
    fieldString(5, build.name),
    fieldString(6, build.description),
    fieldVarint(7, build.language),
    fieldVarint(8, build.version),
    fieldVarint(9, build.origin_build_id),
    fieldMessage(10, encodeDetails(build.details || {})),
    ...(build.tags || []).map((t) => fieldVarint(11, t)),
    ...(build.development_build ? [fieldVarint(12, 1)] : []),
    fieldVarint(13, build.publish_timestamp),
  ];
  const compressed = zlib.zstdCompressSync(Buffer.concat(parts));
  return compressed.toString("base64");
}

/** Flatten every user-authored text field of a build (for TM extraction). */
function collectTexts(build) {
  const out = [];
  if (build.name) out.push({ kind: "name", text: build.name });
  if (build.description) out.push({ kind: "description", text: build.description });
  for (const cat of build.details.mod_categories || []) {
    if (cat.name) out.push({ kind: "category", text: cat.name });
    if (cat.description) out.push({ kind: "category_desc", text: cat.description });
    for (const mod of cat.mods || []) {
      if (mod.annotation) out.push({ kind: "annotation", text: mod.annotation });
    }
  }
  const order = build.details.ability_order;
  const changes = Array.isArray(order) ? order : (order && order.currency_changes) || [];
  for (const change of changes) {
    if (change.annotation) out.push({ kind: "ability_note", text: change.annotation });
  }
  return out;
}

module.exports = { decode, encode, collectTexts };

if (require.main === module) {
  const fs = require("fs");
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node tools/build_code.js <file-with-code | -c CODE | --json build.json>");
    process.exit(2);
  }
  if (arg === "--json") {
    // Round-trip: decode -> edit the JSON -> encode a share code again.
    const file = process.argv[3];
    if (!file || !fs.existsSync(file)) {
      console.error("usage: node tools/build_code.js --json <build.json>");
      process.exit(2);
    }
    let raw = fs.readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // PowerShell redirection writes a BOM
    const build = JSON.parse(raw);
    console.log(encode(build));
    return;
  }
  const input = arg === "-c" ? process.argv[3] : fs.readFileSync(arg, "utf8");
  // A seed file may hold several codes, one per line; decode each separately
  // (concatenated base64 streams would decode silently into garbage).
  const lines = String(input)
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
  if (!lines.length) {
    console.error("no share codes found");
    process.exit(2);
  }
  const out = lines.map((code) => {
    try {
      return decode(code);
    } catch (e) {
      return { error: e.message, code: code.slice(0, 40) + "..." };
    }
  });
  console.log(JSON.stringify(lines.length === 1 ? out[0] : out, null, 2));
}
