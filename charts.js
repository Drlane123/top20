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

// Recalculate today's charts. Compares Top 20 membership against the
// previous chart date: every NEW Top 20 entry creates exactly one
// 'chart_entry' notification (the simulated email). Songs that fall OUT
// create nothing — fall-off is never notified (spec 3.9, section 9).
function recalc(db, date = todayStr()) {
  const prevDate = previousChartDate(db, date);
  const prevTop = top20Keys(db, prevDate);
  const existingTodayTop = top20Keys(db, date); // guards same-day re-runs

  const entries = computeRankings(db);
  const insert = db.prepare(
    `INSERT INTO chart_entries (chart_date, level, genre, region_key, song_id, rank, chart_score)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
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
      insert.run(date, e.level, e.genre, e.region_key, e.song_id, e.rank, e.chart_score);
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

module.exports = { computeRankings, recalc, latestChartDate, previousChartDate, todayStr, LEVELS, CHART_GENRES };
