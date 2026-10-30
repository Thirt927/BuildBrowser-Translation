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
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  // A bare flag (--ids-only, --dry) is present regardless of what follows, so
  // argument order no longer matters.
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

const WEEKLY = Number(arg("weekly", 50));
const ALLTIME = Number(arg("alltime", 30));
const CONCURRENCY = Number(arg("concurrency", 3));
const IDS = String(arg("ids", "")).trim();
const IDS_ONLY = !!arg("ids-only", false);

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

  let existing = null;
  if (IDS_ONLY) {
    if (!fs.existsSync(OUT)) throw new Error("--ids-only needs an existing " + OUT + ", run a normal fetch first");
    existing = JSON.parse(fs.readFileSync(OUT, "utf8"));
    console.log("loaded existing cache:", existing.builds.length, "builds");
  }

  let active = existing ? existing.heroes : null;
  if (!active) {
    const heroes = await getJson("/v1/assets/heroes?only_active=true");
    active = heroes
      .filter((h) => h && h.id != null && !h.disabled)
      .map((h) => ({ id: h.id, name: h.name, class_name: h.class_name }))
      .sort((a, b) => a.id - b.id);
    console.log("heroes:", active.length);
  }

  const byId = new Map();
  if (existing) for (const row of existing.builds) byId.set(keyOf(row), row);

  if (!IDS_ONLY) {
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

    for (const rows of fetched) {
      for (const row of rows) byId.set(keyOf(row), row);
    }
  }

  if (IDS) {
    const ids = IDS.split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s) && Number(s) > 0);
    console.log("fetching build ids:", ids.length);
    const rows = await pool(ids, CONCURRENCY, async (id) => {
      try {
        const r = await getJson("/v1/builds?build_id=" + id + "&limit=1");
        return r && r[0] ? { ...r[0], _sort: "selected" } : null;
      } catch (e) {
        console.warn("skip build", id, e.message);
        return null;
      }
    });
    for (const row of rows) if (row) byId.set(keyOf(row), row);
    console.log("after ids:", byId.size, "builds");
  }

  const builds = [...byId.values()];
  const out = {
    fetched_at: new Date().toISOString(),
    source: API + "/v1/builds",
    heroes: active,
    requested: { weekly: WEEKLY, alltime: ALLTIME, ids: IDS ? IDS.split(",").length : 0 },
    builds,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("unique builds:", builds.length, "->", OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + " KB");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
