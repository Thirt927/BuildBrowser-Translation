// BuildBrowser Translation - fetch popular public builds from deadlock-api.
// Usage: node tools/fetch_builds.js [--weekly 50] [--alltime 30] [--concurrency 3]
// Output: tools/cache/builds.json
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const API = "https://api.deadlock-api.com";
const CACHE_DIR = path.join(__dirname, "cache");
const OUT = path.join(CACHE_DIR, "builds.json");

const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const WEEKLY = Number(arg("weekly", 50));
const ALLTIME = Number(arg("alltime", 30));
const CONCURRENCY = Number(arg("concurrency", 3));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getJson(pathname, attempt) {
  attempt = attempt || 1;
  return new Promise((resolve, reject) => {
    const req = https.get(API + pathname, { agent, headers: { "User-Agent": "bbt-builds-fetch/1.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("bad json for " + pathname));
          }
        } else if ((res.statusCode === 429 || res.statusCode >= 500) && attempt < 5) {
          sleep(2000 * attempt).then(() => resolve(getJson(pathname, attempt + 1)));
        } else {
          reject(new Error(pathname + " -> HTTP " + res.statusCode + ": " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", (e) => {
      if (attempt < 5) sleep(1500 * attempt).then(() => resolve(getJson(pathname, attempt + 1)));
      else reject(e);
    });
    req.setTimeout(90000, () => req.destroy(new Error("timeout " + pathname)));
  });
}

async function pool(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = items[index++];
      results.push(await worker(current));
    }
  });
  await Promise.all(runners);
  return results;
}

function keyOf(build) {
  const hb = build.hero_build || build;
  return hb.hero_build_id != null ? String(hb.hero_build_id) : JSON.stringify(hb).slice(0, 80);
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const heroes = await getJson("/v1/assets/heroes?only_active=true");
  const active = heroes
    .filter((h) => h && h.id != null && !h.disabled)
    .map((h) => ({ id: h.id, name: h.name, class_name: h.class_name }))
    .sort((a, b) => a.id - b.id);
  console.log("heroes:", active.length);

  const jobs = [];
  for (const hero of active) {
    jobs.push({ hero, sort: "weekly_favorites", limit: WEEKLY });
    if (ALLTIME > 0) jobs.push({ hero, sort: "favorites", limit: ALLTIME });
  }

  const fetched = await pool(jobs, CONCURRENCY, async (job) => {
    const q =
      "/v1/builds?hero_id=" +
      job.hero.id +
      "&sort_by=" +
      job.sort +
      "&sort_direction=desc&limit=" +
      job.limit +
      "&only_latest=true";
    let rows = [];
    try {
      rows = await getJson(q);
    } catch (e) {
      console.warn("skip", job.hero.name, job.sort, e.message);
    }
    console.log("  " + job.hero.name + " " + job.sort + ": " + rows.length);
    return rows.map((r) => ({ ...r, _sort: job.sort }));
  });

  const byId = new Map();
  for (const rows of fetched) {
    for (const row of rows) {
      const id = keyOf(row);
      if (!byId.has(id)) byId.set(id, row);
    }
  }
  const builds = [...byId.values()];
  const out = {
    fetched_at: new Date().toISOString(),
    source: API + "/v1/builds",
    heroes: active,
    requested: { weekly: WEEKLY, alltime: ALLTIME },
    builds,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("unique builds:", builds.length, "->", OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + " KB");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
