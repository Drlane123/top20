// Chart engine (spec 3.4 + 3.9).
// chart_score = 0.6 * craft + 0.4 * engagement
// engagement  = 0.75 * (in-app, normalized to the chart's max) + 0.25 * buzz
// Charts: per genre + a cross-genre 'Overall' chart, at local / regional /
// national level. FULL rankings are stored, not just the Top 20.
const { GENRES, OVERALL, FORMULA, ENGAGEMENT_WEIGHTS, localKey } = require("./config");

const LEVELS = ["local", "regional", "national"];
const CHART_GENRES = [...GENRES, OVERALL];

function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function rawEngagementBySong(db) {
  const w = ENGAGEMENT_WEIGHTS;
  const caseSql = Object.entries(w)
    .map(([type, weight]) => `WHEN '${type}' THEN ${weight}`)
    .join(" ");
  const rows = db.prepare(
    `SELECT song_id, SUM(count * CASE type ${caseSql} ELSE 0 END) AS raw
     FROM engagements GROUP BY song_id`
  ).all();
  const map = new Map();
  for (const r of rows) map.set(r.song_id, r.raw || 0);
  return map;
}

function loadSongs(db) {
  const raw = rawEngagementBySong(db);
  const rows = db.prepare(`
    SELECT s.id AS song_id, s.title, s.genre, u.id AS artist_id, u.name AS artist,
           u.city, u.state, u.region, u.buzz_score, j.craft_score
    FROM songs s
    JOIN users u ON u.id = s.artist_id
    JOIN judge_scores j ON j.song_id = s.id
    WHERE s.status = 'live'
  `).all();
  return rows.map((r) => ({ ...r, rawEngagement: raw.get(r.song_id) || 0 }));
}

// Group songs into charts and rank each chart. jitterFn(songId) optionally
// perturbs chart scores (used by the seed to fabricate yesterday's snapshot).
function computeRankings(db, jitterFn = null) {
  const songs = loadSongs(db);
  const entries = [];

  const rankGroup = (level, genreKey, regionKey, members) => {
    if (!members.length) return;
    const maxRaw = Math.max(...members.map((m) => m.rawEngagement), 0);
    const scored = members.map((m) => {
      const inApp = maxRaw > 0 ? (m.rawEngagement / maxRaw) * 100 : 0;
      const engagement = FORMULA.inAppShare * inApp + FORMULA.buzzShare * (m.buzz_score || 0);
      let chartScore = FORMULA.craftWeight * m.craft_score + FORMULA.engagementWeight * engagement;
      if (jitterFn) chartScore += jitterFn(m.song_id);
      return { song: m, chartScore: Math.round(chartScore * 10) / 10 };
    });
    scored.sort((a, b) =>
      b.chartScore - a.chartScore ||
      b.song.craft_score - a.song.craft_score ||
      a.song.song_id - b.song.song_id
    );
    scored.forEach((s, i) => {
      entries.push({
        level, genre: genreKey, region_key: regionKey,
        song_id: s.song.song_id, rank: i + 1, chart_score: s.chartScore,
      });
    });
  };

  for (const genreKey of CHART_GENRES) {
    const inGenre = genreKey === OVERALL ? songs : songs.filter((s) => s.genre === genreKey);
    rankGroup("national", genreKey, "ALL", inGenre);
    const byRegion = new Map();
    const byLocal = new Map();
    for (const s of inGenre) {
      if (!byRegion.has(s.region)) byRegion.set(s.region, []);
      byRegion.get(s.region).push(s);
      const lk = localKey(s.city, s.state);
      if (!byLocal.has(lk)) byLocal.set(lk, []);
      byLocal.get(lk).push(s);
    }
    for (const [region, members] of byRegion) rankGroup("regional", genreKey, region, members);
    for (const [lk, members] of byLocal) rankGroup("local", genreKey, lk, members);
  }
  return entries;
}

function latestChartDate(db) {
  const row = db.prepare("SELECT MAX(chart_date) AS d FROM chart_entries").get();
  return row ? row.d : null;
}

function previousChartDate(db, beforeDate) {
  const row = db.prepare(
    "SELECT MAX(chart_date) AS d FROM chart_entries WHERE chart_date < ?"
  ).get(beforeDate);
  return row ? row.d : null;
}

function top20Keys(db, date) {
  if (!date) return new Set();
  const rows = db.prepare(
    "SELECT level, genre, region_key, song_id FROM chart_entries WHERE chart_date = ? AND rank <= 20"
  ).all(date);
  return new Set(rows.map((r) => `${r.level}|${r.genre}|${r.region_key}|${r.song_id}`));
}

// DJ'S HOT PICKS — the one stated exception to the strictly-algorithmic
// rule. On a pick Friday, the panel's picks (max 3, entered in dj_picks)
// step into the National Overall Top 20: a pick already in the Top 20 by
// score keeps its earned spot; picks outside take the bottom slots of the
// 20, in pick order, and every pick is flagged dj_pick = 1 so the badge
// shows everywhere. All other charts stay purely algorithmic, and from
// the next day's recalc a pick is treated like any other song.
function applyDjPicks(db, entries, date) {
  let picks = [];
  try {
    picks = db.prepare("SELECT song_id FROM dj_picks WHERE pick_date = ? ORDER BY id").all(date).map((r) => r.song_id);
  } catch (e) { picks = []; }
  const out = entries.map((e) => ({ ...e, dj_pick: 0 }));
  if (!picks.length) return out;
  const pickSet = new Set(picks);
  const isGroup = (e) => e.level === "national" && e.genre === OVERALL && e.region_key === "ALL";
  const group = out.filter(isGroup).sort((a, b) => a.rank - b.rank);
  const rest = out.filter((e) => !isGroup(e));
  const topIds = new Set(group.filter((e) => e.rank <= 20).map((e) => e.song_id));
  const outPicks = picks.filter((id) => !topIds.has(id));
  const keepNonPicks = 20 - picks.length;
  const chosenNonPicks = new Set(group.filter((e) => !pickSet.has(e.song_id)).slice(0, keepNonPicks).map((e) => e.song_id));
  const scoredPart = group.filter((e) => chosenNonPicks.has(e.song_id) || (pickSet.has(e.song_id) && topIds.has(e.song_id)));
  const outPart = outPicks.map((id) => group.find((e) => e.song_id === id)).filter(Boolean);
  const remainder = group.filter((e) => !scoredPart.includes(e) && !outPart.includes(e));
  const newGroup = [...scoredPart, ...outPart, ...remainder];
  newGroup.forEach((e, i) => { e.rank = i + 1; e.dj_pick = pickSet.has(e.song_id) ? 1 : 0; });
  return [...rest, ...newGroup];
}

// ADMIN PLACEMENTS — the owner's placement tool (Oct 31 2026). After
// scores and DJ picks settle the order, any ACTIVE placement pins its
// song at the chosen rank inside its chart group, shifting the songs
// below it down one. Placements apply on every recalc inside their
// date window, so a pin survives the daily midnight recalculation
// until it expires or the owner removes it. A placement changes chart
// ORDER only — chart_score and every evaluation number stay exactly
// what the system computed. Each applied entry is flagged admin_pick.
function applyAdminPlacements(db, entries, date) {
  let placements = [];
  try {
    placements = db.prepare(
      `SELECT * FROM admin_placements
       WHERE removed_at IS NULL AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?)
       ORDER BY id`
    ).all(date, date);
  } catch (e) { placements = []; }
  const out = entries.map((e) => ({ ...e, admin_pick: e.admin_pick || 0 }));
  if (!placements.length) return out;
  for (const p of placements) {
    const isGroup = (e) => e.level === p.level && e.genre === p.genre && e.region_key === p.region_key;
    const group = out.filter(isGroup).sort((a, b) => a.rank - b.rank);
    const idx = group.findIndex((e) => e.song_id === p.song_id);
    if (idx === -1) continue; // song doesn't compete in that chart
    const [entry] = group.splice(idx, 1);
    const target = Math.max(1, Math.min(p.rank, group.length + 1));
    group.splice(target - 1, 0, entry);
    group.forEach((e, i) => {
      e.rank = i + 1;
      if (e.song_id === p.song_id) e.admin_pick = 1;
    });
  }
  return out;
}

// Small deterministic PRNG (same family the seed uses) so a given
// (song, date) pair always produces the same daily drift — the chart is
// stable all day, identical for every viewer, and genuinely different
// tomorrow.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dateSeed(dateStr) {
  let h = 20261030;
  for (const ch of String(dateStr)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return h >>> 0;
}

// DAILY DRIFT — the living chart. Audience attention moves every day, so
// each day's recalc deals every song a deterministic daily swing
// (±DAILY_DRIFT chart points) keyed to the date. Craft scores never
// move; only the day's engagement weather does. Fridays belong to the
// DJ's Hot Picks: on a Friday the drift is muted so the panel's three
// picks (seeded at unjittered ranks 22/25/28) still step into the bottom
// of the Top 20 exactly the way applyDjPicks seats them.
const DAILY_DRIFT = 6.5;
const FRIDAY_DRIFT = 1.2;

function isFriday(dateStr) {
  return new Date(dateStr + "T12:00:00Z").getUTCDay() === 5;
}

function dailyDriftFn(dateStr) {
  const amp = isFriday(dateStr) ? FRIDAY_DRIFT : DAILY_DRIFT;
  const ds = dateSeed(dateStr);
  return (songId) => (mulberry32((songId * 7919) ^ ds)() * 2 - 1) * amp;
}

// Recalculate today's charts. Compares Top 20 membership against the
// previous chart date: every NEW Top 20 entry creates exactly one
// 'chart_entry' notification (the simulated email). Songs that fall OUT
// create nothing — fall-off is never notified (spec 3.9, section 9).
function recalc(db, date = todayStr()) {
  const prevDate = previousChartDate(db, date);
  const prevTop = top20Keys(db, prevDate);
  const existingTodayTop = top20Keys(db, date); // guards same-day re-runs

  const entries = applyAdminPlacements(db, applyDjPicks(db, computeRankings(db, dailyDriftFn(date)), date), date);
  const insert = db.prepare(
    `INSERT INTO chart_entries (chart_date, level, genre, region_key, song_id, rank, chart_score, dj_pick, admin_pick)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const artistOf = db.prepare("SELECT artist_id FROM songs WHERE id = ?");
  const alreadyNotified = db.prepare(
    `SELECT id FROM notifications
     WHERE song_id = ? AND level = ? AND genre = ? AND date(created_at) = date(?)`
  );
  const insertNotif = db.prepare(
    `INSERT INTO notifications (user_id, song_id, type, level, genre, rank)
     VALUES (?, ?, 'chart_entry', ?, ?, ?)`
  );

  const created = [];
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM chart_entries WHERE chart_date = ?").run(date);
    for (const e of entries) {
      insert.run(date, e.level, e.genre, e.region_key, e.song_id, e.rank, e.chart_score, e.dj_pick || 0, e.admin_pick || 0);
      if (e.rank > 20) continue;
      const key = `${e.level}|${e.genre}|${e.region_key}|${e.song_id}`;
      if (prevTop.has(key) || existingTodayTop.has(key)) continue;
      if (alreadyNotified.get(e.song_id, e.level, e.genre, date)) continue;
      const { artist_id } = artistOf.get(e.song_id);
      const info = insertNotif.run(artist_id, e.song_id, e.level, e.genre, e.rank);
      created.push({
        id: Number(info.lastInsertRowid), user_id: artist_id, song_id: e.song_id,
        level: e.level, genre: e.genre, region_key: e.region_key, rank: e.rank,
      });
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { date, prevDate, notifications: created, entryCount: entries.length };
}

// Runtime day-rollover: if the newest stored chart is older than today,
// deal today's chart (and any missed days in between, so movement arrows,
// risers and days-charted always compare against a real yesterday).
// Returns the number of days dealt. Safe to call on every boot.
function ensureCurrent(db, today = todayStr()) {
  let latest = latestChartDate(db);
  if (!latest || latest >= today) return 0;
  let dealt = 0;
  let cursor = latest;
  while (cursor < today) {
    const next = new Date(new Date(cursor + "T12:00:00Z").getTime() + 86400000)
      .toISOString().slice(0, 10);
    recalc(db, next);
    cursor = next;
    dealt++;
    if (dealt > 31) break; // sanity cap; a fresh seed is never behind
  }
  return dealt;
}

module.exports = { computeRankings, recalc, latestChartDate, previousChartDate, todayStr, ensureCurrent, dailyDriftFn, LEVELS, CHART_GENRES };
