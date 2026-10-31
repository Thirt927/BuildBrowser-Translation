// BuildBrowser Translation - fetch public builds from deadlock-api.
//
// Usage:
//   node tools/fetch_builds.js [--weekly 50] [--alltime 30] [--recent 40]
//                              [--author <SteamID64>] [--lang English]
//                              [--ids 123,456] [--ids-only] [--concurrency 3]
// Output: tools/cache/builds.json
//
// The three sources answer three different questions:
//   --weekly / --alltime  what the in-game browser currently ranks highest
//                         (same Valve build data the game shows)
//   --recent              what changed lately: sorted by updated_at, so brand
//                         new builds that have no favorites yet are included
//   --author              your own published builds, which never rank
// --lang keeps only builds written in that language (default English, because
// the pipeline translates English -> Chinese; Chinese builds need nothing).
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
// Your own Steam account id: every public build you authored is fetched too,
// so the in-game TM always knows your texts (they rarely hit popularity
// rankings and would otherwise fall out of coverage).
const AUTHOR = String(arg("author", "")).trim();
// Builds updated within this many days are pulled in as well (0 disables).
const RECENT = Number(arg("recent", 40));
const RECENT_DAYS = Number(arg("recent-days", 45));
const LANG = String(arg("lang", "English")).trim();

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
          const hint = res.statusCode === 404
            ? " (endpoint missing: deadlock-api changed? see openapi.json)"
            : " (rate limited or API error; retry later)";
          reject(new Error(pathname + " -> HTTP " + res.statusCode + hint + ": " + data.slice(0, 200)));
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

/** Query string for /v1/builds. Exported so tests can assert its shape. */
function buildQuery(opts) {
  let q = "/v1/builds?hero_id=" + opts.heroId + "&sort_by=" + opts.sort +
    "&sort_direction=desc&limit=" + opts.limit + "&only_latest=true";
  if (opts.since) q += "&min_unix_timestamp=" + opts.since;
  if (opts.lang) q += "&build_language=" + encodeURIComponent(opts.lang);
  return q;
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

  const langFilter = LANG ? "&build_language=" + encodeURIComponent(LANG) : "";

  if (!IDS_ONLY) {
    const jobs = [];
    for (const hero of active) {
      jobs.push({ hero, sort: "weekly_favorites", limit: WEEKLY });
      if (ALLTIME > 0) jobs.push({ hero, sort: "favorites", limit: ALLTIME });
      if (RECENT > 0) {
        // Only look at builds someone touched recently: this is what keeps the
        // memory in step with the live browser without re-walking old data.
        const since = Math.floor(Date.now() / 1000) - RECENT_DAYS * 86400;
        jobs.push({ hero, sort: "updated_at", limit: RECENT, since });
      }
    }

    const fetched = await pool(jobs, CONCURRENCY, async (job) => {
      const q = buildQuery({
        heroId: job.hero.id,
        sort: job.sort,
        limit: job.limit,
        since: job.since,
        lang: LANG,
      });
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

  if (AUTHOR) {
    if (!/^\d{4,20}$/.test(AUTHOR)) {
      console.warn("author " + AUTHOR + " is not a Steam account id, skipping");
    } else {
      console.log("fetching public builds by author:", AUTHOR);
      try {
        const rows = await getJson("/v1/builds/by-author/" + AUTHOR + "?limit=200" + langFilter);
        for (const r of rows || []) {
          byId.set(keyOf(r), { ...r, _sort: "author" });
        }
        console.log("author builds merged: " + (rows || []).length);
      } catch (e) {
        console.warn("author fetch failed:", e.message);
      }
    }
  }

  const builds = [...byId.values()];
  const out = {
    fetched_at: new Date().toISOString(),
    source: API + "/v1/builds",
    heroes: active,
    requested: {
    weekly: WEEKLY,
    alltime: ALLTIME,
    recent: RECENT,
    language: LANG || "any",
    ids: IDS ? IDS.split(",").length : 0,
    author: AUTHOR,
  },
    builds,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("unique builds:", builds.length, "->", OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + " KB");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { buildQuery };
