// SQLite (built-in node:sqlite) — schema auto-created on first open.
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const { CATEGORIES } = require("./config");

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "top20.db");

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  const categoryCols = CATEGORIES.map((c) => `${c.key} REAL NOT NULL`).join(",\n      ");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      region TEXT NOT NULL,
      buzz_score REAL NOT NULL DEFAULT 0,   -- seeded/measured social buzz, 0-100
      -- Artist profile page fields (Phase 2). A profile page + at least one
      -- uploaded song is how an artist gets recognized.
      photo_path TEXT,                      -- uploaded photo; NULL = initial avatar
      bio TEXT,
      age INTEGER,                          -- NULL = private / not shown
      history TEXT,                         -- long-form artist history
      years_in_game INTEGER,                -- NULL = not stated
      genre TEXT,                           -- artist's primary genre
      facebook TEXT,                        -- socials: the judging search locates the artist by these
      instagram TEXT,
      tiktok TEXT,
      youtube TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      genre TEXT NOT NULL,
      audio_path TEXT NOT NULL,             -- web path, e.g. /audio/song-1.mp3
      cover_path TEXT NOT NULL,             -- REQUIRED (spec 3.2)
      lyrics TEXT,
      status TEXT NOT NULL DEFAULT 'live',  -- 'live' | 'removed'; only live songs are judged/charted; max 2 live per artist
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS judge_scores (
      song_id INTEGER PRIMARY KEY REFERENCES songs(id),
      ${categoryCols},
      total_score REAL NOT NULL,            -- out of 150 (15 criteria x 10)
      craft_score REAL NOT NULL,            -- 0-100
      notes TEXT NOT NULL                   -- JSON: { categoryKey: "critique note" }
    );

    CREATE TABLE IF NOT EXISTS engagements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER NOT NULL REFERENCES songs(id),
      type TEXT NOT NULL CHECK (type IN ('play','like','share','save')),
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (song_id, type)
    );

    CREATE TABLE IF NOT EXISTS chart_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chart_date TEXT NOT NULL,             -- YYYY-MM-DD
      level TEXT NOT NULL CHECK (level IN ('local','regional','national')),
      genre TEXT NOT NULL,                  -- one of GENRES, or 'Overall'
      region_key TEXT NOT NULL,             -- 'City, ST' | region name | 'ALL'
      song_id INTEGER NOT NULL REFERENCES songs(id),
      rank INTEGER NOT NULL,
      chart_score REAL NOT NULL,
      dj_pick INTEGER NOT NULL DEFAULT 0,   -- 1 when this entry is a DJ's Hot Pick (charts.js)
      UNIQUE (chart_date, level, genre, region_key, song_id)
    );

    -- Simulated email outbox (spec 3.9). ONLY 'chart_entry' exists.
    -- There is intentionally NO fall-off notification type, ever.
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      song_id INTEGER NOT NULL REFERENCES songs(id),
      type TEXT NOT NULL DEFAULT 'chart_entry' CHECK (type IN ('chart_entry')),
      level TEXT NOT NULL,
      genre TEXT NOT NULL,
      rank INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ONE profile video per artist, attached to one of the artist's own
    -- songs: either the song's music video, or a video bio where the
    -- artist talks about that song. A new upload replaces the old one
    -- (the upload handler deletes the artist's previous row + file).
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id INTEGER NOT NULL REFERENCES users(id),
      song_id INTEGER NOT NULL REFERENCES songs(id),
      video_path TEXT NOT NULL,             -- web path, e.g. /uploads/videos/video-....mp4
      kind TEXT NOT NULL CHECK (kind IN ('music_video', 'video_bio')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- DJ of the Month (owner feature). The DJs who support independent
    -- artists get submitted — by themselves, an artist, or a fan — and
    -- voted on per city, per month. The top DJ in each city for a month
    -- is that city's DJ of the Month (spotlight + archive). Recognition
    -- only: DJ votes never touch song scores or charts.
    CREATE TABLE IF NOT EXISTS dj_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dj_name TEXT NOT NULL,
      city TEXT NOT NULL,
      state TEXT,
      hood TEXT,                            -- neighborhood, if given
      support_text TEXT,                    -- how this DJ supports independent artists
      socials TEXT,                         -- links/handles, free text
      submitted_by TEXT,                    -- who sent this DJ in
      month TEXT NOT NULL,                  -- 'YYYY-MM' — the month this DJ is racing in
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One vote per person per DJ per month, enforced by the UNIQUE
    -- constraint. A "person" is the long-lived t20_voter cookie.
    CREATE TABLE IF NOT EXISTS dj_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dj_id INTEGER NOT NULL REFERENCES dj_submissions(id),
      voter_key TEXT NOT NULL,
      month TEXT NOT NULL,                  -- 'YYYY-MM'
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (dj_id, voter_key, month)
    );

    -- DJ'S HOT PICKS (owner feature): every Friday a panel of DJs picks
    -- up to 3 songs that are already hot, and those picks step into the
    -- National Overall Top 20 for that Friday's chart — the ONE stated
    -- exception to the strictly-algorithmic rule. Max 3 per pick_date is
    -- enforced where picks are entered. From the next day's recalc the
    -- algorithm treats a pick like any other song.
    CREATE TABLE IF NOT EXISTS dj_picks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER NOT NULL REFERENCES songs(id),
      pick_date TEXT NOT NULL,              -- the Friday, YYYY-MM-DD
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (song_id, pick_date)
    );

    -- STAGE ADS (owner feature, Oct 31 2026): advertisement slots inside
    -- the Stage rotation. The owner uploads image or video ads (video
    -- capped at 30 seconds); active ads rotate into the playlist between
    -- songs. Ads never touch scores, ranks or judging.
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,                    -- 'image' | 'video'
      file_path TEXT NOT NULL,
      link_url TEXT,
      title TEXT,
      seconds INTEGER NOT NULL DEFAULT 8,    -- image ads: seconds on screen
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ADMIN PLACEMENTS (owner feature, Oct 31 2026): the owner can pin
    -- any song that is already uploaded and live into a chosen chart at
    -- a chosen rank, any time, for as long as the placement is active.
    -- Placements move chart ORDER only: the song's evaluation scores and
    -- chart_score are never altered. Every placement is written down
    -- here (including removals, via removed_at) so the owner always has
    -- a complete record of what was placed, where, and for how long.
    -- Owner admin code override: when the owner changes his 8-digit
    -- admin code from inside the site, the new salted hash lands here
    -- and wins over the starter code baked into server.js.
    CREATE TABLE IF NOT EXISTS admin_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_placements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER NOT NULL REFERENCES songs(id),
      level TEXT NOT NULL CHECK (level IN ('local','regional','national')),
      genre TEXT NOT NULL,
      region_key TEXT NOT NULL,
      rank INTEGER NOT NULL,                -- the pinned chart position
      starts_on TEXT NOT NULL,              -- first chart date it applies
      ends_on TEXT,                         -- last chart date (NULL = until removed)
      note TEXT,                            -- owner's private note (who/why)
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at TEXT                       -- set when the owner removes it
    );
  `);

  // Migrations for a DB created by an earlier build (seed rebuilds from
  // scratch, but a live DB should survive a code update too).
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((r) => r.name);
  const addUserCol = (name, ddl) => {
    if (!userCols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  };
  addUserCol("photo_path", "photo_path TEXT");
  addUserCol("bio", "bio TEXT");
  addUserCol("age", "age INTEGER");
  addUserCol("history", "history TEXT");
  addUserCol("years_in_game", "years_in_game INTEGER");
  addUserCol("genre", "genre TEXT");
  addUserCol("facebook", "facebook TEXT");
  addUserCol("instagram", "instagram TEXT");
  addUserCol("tiktok", "tiktok TEXT");
  addUserCol("youtube", "youtube TEXT");
  const scoreCols = db.prepare("PRAGMA table_info(judge_scores)").all().map((r) => r.name);
  if (!scoreCols.includes("cover_art")) {
    db.exec("ALTER TABLE judge_scores ADD COLUMN cover_art REAL NOT NULL DEFAULT 5");
  }
  const ceCols = db.prepare("PRAGMA table_info(chart_entries)").all().map((r) => r.name);
  if (!ceCols.includes("dj_pick")) {
    db.exec("ALTER TABLE chart_entries ADD COLUMN dj_pick INTEGER NOT NULL DEFAULT 0");
  }
  if (!ceCols.includes("admin_pick")) {
    db.exec("ALTER TABLE chart_entries ADD COLUMN admin_pick INTEGER NOT NULL DEFAULT 0");
  }
  // Status vocabulary moved from 'active' to 'live' (Phase 2).
  db.exec("UPDATE songs SET status = 'live' WHERE status = 'active'");

  return db;
}

module.exports = { openDb, DB_PATH };
