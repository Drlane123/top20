// Seed: 36 demo songs (6 per genre), generated covers + audio,
// a jittered "yesterday" chart snapshot, then the first real recalc
// (which fires chart-entry notifications against yesterday — spec 3.9).
// Re-running seed.js resets all demo data.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { openDb, DB_PATH } = require("./db");
const { CATEGORIES, GENRES, regionForState } = require("./config");
const { mulberry32, scoreFromBase } = require("./judge");
const charts = require("./charts");

const ROOT = __dirname;
const COVERS_DIR = path.join(ROOT, "public", "covers");
const AUDIO_DIR = path.join(ROOT, "public", "audio");
const AVATARS_DIR = path.join(ROOT, "public", "avatars");
const VIDEOS_DIR = path.join(ROOT, "public", "videos");

// [genre, title, artist, city, state, baseQuality 4.6..9.7]
const CATALOG = [
  ["R&B", "Velvet Hours", "Amara Cole", "Dallas", "TX", 8.9],
  ["R&B", "Slow Reply", "Jaylen Brooks", "Houston", "TX", 7.4],
  ["R&B", "Silk & Smoke", "Nia Valentine", "Atlanta", "GA", 9.3],
  ["R&B", "After Midnight Text", "Dario Wells", "Chicago", "IL", 6.8],
  ["R&B", "Honey Moon Phase", "Selene Park", "Los Angeles", "CA", 8.1],
  ["R&B", "Come Back Season", "Marcus Reed", "Mesquite", "TX", 7.9],

  ["Southern Soul", "Front Porch Confessions", "Big Earl Thompson", "Memphis", "TN", 8.6],
  ["Southern Soul", "Grown Folks Business", "Miss Loretta James", "Dallas", "TX", 9.0],
  ["Southern Soul", "Trail Ride Heart", "Cowboy Curtis Lee", "Houston", "TX", 7.2],
  ["Southern Soul", "Sweet Tea & Regrets", "Pearl Ann Davis", "Jackson", "MS", 8.3],
  ["Southern Soul", "Two Step Confession", "Deacon Ray", "New Orleans", "LA", 6.9],
  ["Southern Soul", "Mama's Front Room", "Thelma Brooks", "Mesquite", "TX", 7.7],

  ["Hip-Hop", "Corner Store Prophet", "Yung Malachi", "Atlanta", "GA", 9.1],
  ["Hip-Hop", "Rent Due", "Kash Kartel", "Detroit", "MI", 7.6],
  ["Hip-Hop", "Southside Sermon", "Preacha P", "Houston", "TX", 8.4],
  ["Hip-Hop", "Concrete Roses", "Queen Nyla", "New York", "NY", 9.5],
  ["Hip-Hop", "Mesquite Made", "Lil Darnell", "Mesquite", "TX", 6.7],
  ["Hip-Hop", "Fourth Quarter", "Monte Carlo", "Chicago", "IL", 8.0],

  ["Trap", "Pack Mover", "Zay Bandz", "Atlanta", "GA", 8.2],
  ["Trap", "Trap Cathedral", "Guapo Nino", "Dallas", "TX", 7.1],
  ["Trap", "Digital Scale Dreams", "Young Peso", "Memphis", "TN", 8.8],
  ["Trap", "No Sleep Committee", "Kiki Bands", "Houston", "TX", 6.5],
  ["Trap", "Mud Baby Anthem", "Dirt Road D", "Charlotte", "NC", 7.8],
  ["Trap", "Overnight Shift", "Trap Selena", "Los Angeles", "CA", 8.5],

  ["Country", "Dirt Road Halo", "Colton Ray", "Nashville", "TN", 9.2],
  ["Country", "Mesquite Skyline", "Hadley Brooks", "Mesquite", "TX", 8.7],
  ["Country", "Whiskey & Wildflowers", "June Callahan", "Dallas", "TX", 7.3],
  ["Country", "Small Town Static", "Beau Harrington", "Fort Worth", "TX", 6.6],
  ["Country", "Tailgate Confession", "Sadie Lynn", "Knoxville", "TN", 8.9],
  ["Country", "Neon Honky Tonk", "Wyatt Cole", "Austin", "TX", 7.5],

  ["Pop", "Glitter Cannon", "Vivi Valentine", "Los Angeles", "CA", 9.4],
  ["Pop", "Textbook Crush", "Noah Skye", "New York", "NY", 7.0],
  ["Pop", "Ultraviolet", "Zara Moon", "Chicago", "IL", 8.6],
  ["Pop", "Dance Floor Apology", "Milo Ferreira", "Houston", "TX", 7.9],
  ["Pop", "Cherry Lipstick Weather", "Poppy Lane", "Nashville", "TN", 8.2],
  ["Pop", "Main Character Energy", "Gia Laurent", "Atlanta", "GA", 6.3],

  ["Dance/Techno/House", "Laser Confession", "Nova Reign", "Miami", "FL", 9.3],
  ["Dance/Techno/House", "Warehouse Heartbeat", "KAIRO", "Chicago", "IL", 8.4],
  ["Dance/Techno/House", "Neon Skyline Run", "Vex Marlowe", "Las Vegas", "NV", 7.7],
  ["Dance/Techno/House", "Bassline Confidential", "DJ Solenne", "Los Angeles", "CA", 8.8],
  ["Dance/Techno/House", "4AM in Dallas", "Rio Delacroix", "Dallas", "TX", 7.1],
  ["Dance/Techno/House", "Glass Cathedral", "Iona Waves", "New York", "NY", 6.6],
];

function emailFor(name) {
  return name.toLowerCase().replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".") + "@example.com";
}

function initialsFor(name) {
  const words = name.replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || "A") + (words[1]?.[0] || "")).toUpperCase();
}

// Demo profile copy (Phase 2): plausible bios + histories, rotated so the
// 36 artists read differently. Completeness varies on purpose — some
// artists keep age private, some have no photo (initial-avatar fallback).
const BIOS = [
  (a) => `${a.name} is an independent ${a.genre} artist out of ${a.city}, ${a.state} — writing, recording and releasing everything in-house.`,
  (a) => `Straight out of ${a.city}, ${a.name} makes ${a.genre} for the people who raised them: real stories, real voices, no shortcuts.`,
  (a) => `${a.genre} singer-songwriter from ${a.city}, ${a.state}. ${a.name} believes a great record starts with a true story.`,
  (a) => `${a.name} (${a.city}, ${a.state}) — independent ${a.genre} artist building a catalog one honest record at a time.`,
  (a) => `From the church pews to the studio booth: ${a.name} brings a lifetime of ${a.city} soul to every ${a.genre} record.`,
  (a) => `${a.name} is a ${a.city}-based ${a.genre} artist and self-taught producer, releasing music fully independent.`,
];
const HISTORIES = [
  (a, y) => `${a.name} started singing in the family living room in ${a.city} and never really stopped. After ${y} years of open mics, church programs and local showcases, the records started finding their people — first around ${a.state}, then everywhere the music travels online. Still independent, still writing every word.`,
  (a, y) => `The road here wasn't straight. ${a.name} spent ${y} years working day jobs around ${a.city} while recording at night, learning production from whoever would teach and saving for studio time a paycheck at a time. That grind is in every record — you can hear it.`,
  (a, y) => `${a.name} came up through the ${a.city} scene the slow way: talent shows, barbershop harmonies, and hand-to-hand CDs. ${y} years in, the sound is fully their own — rooted in ${a.genre}, raised on the classics, aimed at the charts.`,
  (a, y) => `Music was always the plan. ${a.name} wrote the first songs as a teenager in ${a.city}, formed a local following playing anywhere with a PA system, and has spent ${y} years turning that following into a movement — one release, one stage, one city at a time.`,
];

function profileFor(artist, genre, city, state, i) {
  const a = { name: artist, genre, city, state };
  const years = 1 + ((i * 7) % 18);
  return {
    // Every 5th artist has no photo on file -> styled initial avatar.
    photo_path: i % 5 === 4 ? null : `/avatars/artist-${i + 1}.png`,
    bio: BIOS[i % BIOS.length](a),
    // Roughly a third of artists keep their age private (not shown).
    age: i % 3 === 0 ? null : 21 + ((i * 3) % 25),
    // A few artists haven't written their history yet.
    history: i % 4 === 3 ? null : HISTORIES[i % HISTORIES.length](a, years),
    years_in_game: years,
    genre,
  };
}

function genAudio(file, songIndex) {
  const pattern = [0, 2, 4, 7, 9, 12, 9, 4];
  const root = 110 * Math.pow(2, (songIndex % 12) / 12);
  const args = ["-y", "-loglevel", "error"];
  const inputs = [];
  for (let i = 0; i < 8; i++) {
    const semi = pattern[(i + songIndex) % pattern.length];
    const freq = root * Math.pow(2, semi / 12);
    args.push("-f", "lavfi", "-i", `sine=frequency=${freq.toFixed(2)}:duration=1.875`);
    inputs.push(`[${i}:a]`);
  }
  args.push(
    "-filter_complex",
    `${inputs.join("")}concat=n=8:v=0:a=1,volume=0.4,afade=t=in:st=0:d=0.2,afade=t=out:st=13.8:d=1.2[aout]`,
    // 320 kbps CBR: demo audio must pass the radio-quality upload gate.
    "-map", "[aout]", "-c:a", "libmp3lame", "-b:a", "320k", file
  );
  execFileSync("ffmpeg", args);
}

// Seeded profile video (artist 1, Amara Cole): a ~10s video_bio title
// card for "Velvet Hours" with her demo song under it. Generated here so
// reseeding is fully self-contained.
function genBioVideo(file, songAudio) {
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const dt = (text, size, color, dy) =>
    `drawtext=fontfile=${font}:text='${text}':fontsize=${size}:fontcolor=${color}:borderw=2:bordercolor=black:x=(w-text_w)/2:y=(h-text_h)/2${dy}`;
  const vf = [
    dt("AMARA COLE", 86, "white", "-160"),
    dt("VELVET HOURS - THE STORY", 52, "0xd7dae1", "-30"),
    dt("video bio", 36, "0xffb300", "+60"),
  ].join(",");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x0a0a12:s=1280x720:r=30:d=10",
    "-i", songAudio,
    "-filter_complex", `[0:v]${vf}[v]`,
    "-map", "[v]", "-map", "1:a",
    "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest",
    file,
  ]);
}

function main() {
  // Reset demo state.
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
  for (const dir of [COVERS_DIR, AUDIO_DIR, AVATARS_DIR, VIDEOS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  }

  const db = openDb();
  const rng = mulberry32(20261030);

  // Covers: generated album artwork ships with the app (cover-art.js,
  // base64 webp per song). Fall back to the PIL gradient covers only if
  // the artwork bundle is missing.
  let art = null;
  try { art = require("./cover-art.js"); } catch { art = null; }
  if (art) {
    CATALOG.forEach((c, i) => {
      const b64 = art[String(i + 1)];
      if (b64) fs.writeFileSync(path.join(COVERS_DIR, `song-${i + 1}.png`), Buffer.from(b64, "base64"));
    });
    console.log("covers: generated artwork written");
  } else {
    const manifest = CATALOG.map((c, i) => ({
      file: path.join(COVERS_DIR, `song-${i + 1}.png`),
      title: c[1], artist: c[2], genre: c[0],
    }));
    const manifestPath = path.join(ROOT, "tools", "covers-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    execFileSync("python3", [path.join(ROOT, "tools", "gen_covers.py"), manifestPath], { stdio: "inherit" });
  }

  // Artist avatars (PIL) via manifest — profile photos for the seed
  // artists who have one on file (see profileFor).
  const avatarManifest = CATALOG
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => i % 5 !== 4)
    .map(({ c, i }) => ({
      file: path.join(AVATARS_DIR, `artist-${i + 1}.png`),
      initials: initialsFor(c[2]), genre: c[0],
    }));
  const avatarManifestPath = path.join(ROOT, "tools", "avatars-manifest.json");
  fs.writeFileSync(avatarManifestPath, JSON.stringify(avatarManifest, null, 2));
  execFileSync("python3", [path.join(ROOT, "tools", "gen_avatars.py"), avatarManifestPath], { stdio: "inherit" });

  // Audio loops (ffmpeg).
  CATALOG.forEach((c, i) => genAudio(path.join(AUDIO_DIR, `song-${i + 1}.mp3`), i));
  console.log(`audio: ${CATALOG.length} loops written`);

  const insUser = db.prepare(
    `INSERT INTO users (name, email, city, state, region, buzz_score, photo_path, bio, age, history, years_in_game, genre)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insSong = db.prepare(
    "INSERT INTO songs (artist_id, title, genre, audio_path, cover_path, lyrics, status) VALUES (?, ?, ?, ?, ?, ?, 'live')"
  );
  const catCols = CATEGORIES.map((c) => c.key).join(", ");
  const catPlaceholders = CATEGORIES.map(() => "?").join(", ");
  const insJudge = db.prepare(
    `INSERT INTO judge_scores (song_id, ${catCols}, total_score, craft_score, notes)
     VALUES (?, ${catPlaceholders}, ?, ?, ?)`
  );
  const insEng = db.prepare("INSERT INTO engagements (song_id, type, count) VALUES (?, ?, ?)");
  let firstArtistId = null, firstSongId = null;

  db.exec("BEGIN");
  try {
    CATALOG.forEach((c, i) => {
      const [genre, title, artist, city, state, base] = c;
      const buzz = Math.round(15 + rng() * 78);
      const profile = profileFor(artist, genre, city, state, i);
      const user = insUser.run(
        artist, emailFor(artist), city, state, regionForState(state), buzz,
        profile.photo_path, profile.bio, profile.age, profile.history,
        profile.years_in_game, profile.genre
      );
      const artistId = Number(user.lastInsertRowid);
      const song = insSong.run(
        artistId, title, genre,
        `/audio/song-${i + 1}.mp3`, `/covers/song-${i + 1}.png`,
        `Demo lyric sheet for "${title}" by ${artist}.`
      );
      const songId = Number(song.lastInsertRowid);
      if (i === 0) { firstArtistId = artistId; firstSongId = songId; }

      // Criterion 15 is scored from the seeded cover file itself.
      const judged = scoreFromBase(1000 + i * 137, base, path.join(COVERS_DIR, `song-${i + 1}.png`));
      insJudge.run(
        songId,
        ...CATEGORIES.map((cat) => judged.scores[cat.key]),
        judged.totalScore, judged.craftScore, JSON.stringify(judged.notes)
      );

      const plays = Math.round((350 + rng() * 2600) * Math.pow(base / 6, 2.4));
      const likes = Math.round(plays * (0.05 + rng() * 0.06));
      const shares = Math.round(plays * (0.008 + rng() * 0.03));
      const saves = Math.round(plays * (0.02 + rng() * 0.05));
      insEng.run(songId, "play", plays);
      insEng.run(songId, "like", likes);
      insEng.run(songId, "share", shares);
      insEng.run(songId, "save", saves);
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Amara Cole's profile video: one video_bio on her profile, attached
  // to "Velvet Hours" — generated above from her demo song's audio.
  if (firstArtistId) {
    genBioVideo(path.join(VIDEOS_DIR, "amara-velvet-hours-bio.mp4"), path.join(AUDIO_DIR, "song-1.mp3"));
    db.prepare("INSERT INTO videos (artist_id, song_id, video_path, kind) VALUES (?, ?, ?, 'video_bio')")
      .run(firstArtistId, firstSongId, "/videos/amara-velvet-hours-bio.mp4");
    console.log("profile video: seeded video_bio for Amara Cole (Velvet Hours)");
  }

  // DJ of the Month (owner feature): city DJ races. This month — Dallas
  // (3 DJs), Houston (2), Atlanta (2), votes spread by seeded vote rows
  // with distinct voter keys, exactly how real votes land. Last month —
  // a finished Dallas race with a clear winner, for the archive and the
  // city board's "last month's winner" panel. All invented demo DJs.
  const thisMonth = new Date().toISOString().slice(0, 7);
  const lastMonth = (() => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();
  const insDj = db.prepare(
    `INSERT INTO dj_submissions (dj_name, city, state, hood, support_text, socials, submitted_by, month)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insDjVote = db.prepare("INSERT INTO dj_votes (dj_id, voter_key, month) VALUES (?, ?, ?)");
  const seedDj = (row, votes, month) => {
    const id = Number(insDj.run(...row, month).lastInsertRowid);
    for (let i = 0; i < votes; i++) insDjVote.run(id, `seed-voter-${id}-${i + 1}`, month);
    return id;
  };
  db.exec("BEGIN");
  try {
    // This month — Dallas, TX.
    seedDj(["DJ Southside Smoke", "Dallas", "TX", "Oak Cliff",
      "Runs an indie-only first hour on his Friday night mixshow and breaks new Dallas records before anybody else touches them.",
      "@djsouthsidesmoke · Instagram / TikTok", "Amara Cole"], 42, thisMonth);
    seedDj(["DJ Lady T", "Dallas", "TX", "Pleasant Grove",
      "Hosts a monthly open-mic and spin night where new artists get their record played front to back — with real feedback after.",
      "@djladyt214 · Instagram", "Marcus Reed"], 27, thisMonth);
    seedDj(["DJ TrillWill", "Dallas", "TX", "South Dallas",
      "Keeps a standing Mesquite & Dallas independents block in every club set and shouts the artists out by name.",
      "@trillwilldtx · TikTok", "a fan"], 13, thisMonth);
    // This month — Houston, TX.
    seedDj(["DJ H-Town Heavy", "Houston", "TX", "Third Ward",
      "His Hometown Heat segment is all Houston independents, every single week. No pay to play, ever.",
      "@dhtownheavy · Instagram", "Jaylen Brooks"], 19, thisMonth);
    seedDj(["DJ Marlo Da Mixer", "Houston", "TX", "Acres Homes",
      "Books local openers at every party he plays and hands the aux to new artists between sets.",
      "@marlodamixer · TikTok", "a fan"], 8, thisMonth);
    // This month — Atlanta, GA.
    seedDj(["DJ Peachtree P", "Atlanta", "GA", "South Atlanta",
      "Runs Indie ATL Tuesdays — a full night of nothing but independent Atlanta records.",
      "@djpeachtreep · Instagram / TikTok", "Yung Malachi"], 23, thisMonth);
    seedDj(["DJ Eastside E", "Atlanta", "GA", "East Atlanta",
      "Breaks new ATL artists on his livestream mixes and posts their links for his whole following.",
      "@eastsideeatl · Instagram", "Gia Laurent"], 11, thisMonth);
    // Last month — Dallas, TX (race closed; DJ Dallas Rose took it).
    seedDj(["DJ Dallas Rose", "Dallas", "TX", "Bishop Arts",
      "Spent the month spinning indie records at every block party on the block, and put three brand-new artists into her radio mix.",
      "@djdallasrose · Instagram", "Miss Loretta James"], 38, lastMonth);
    seedDj(["DJ Big Ced", "Dallas", "TX", "Red Bird",
      "His Sunday indie brunch set is a Dallas staple — local records only till 2 PM.",
      "@bigceddtx · TikTok", "a fan"], 21, lastMonth);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  console.log(`dj of the month: seeded races for ${thisMonth} (Dallas/Houston/Atlanta) + ${lastMonth} Dallas archive`);

  // Chart history: the past 13 days of snapshots, same computation with a
  // per-day score jitter, so movement arrows, WEEKS and days-charted counts
  // all have something real to compare against.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const insEntry = db.prepare(
    `INSERT INTO chart_entries (chart_date, level, genre, region_key, song_id, rank, chart_score)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // Designate today's NEW ENTRY: the song sitting at #19 on the real
  // (unjittered) National Overall chart is held out of every past day's
  // Top 20, so its first day on the big chart is today — a genuine Day 1.
  const baseRanks = charts.computeRankings(db, () => 0);
  const newEntryRow = baseRanks.find((e) => e.level === "national" && e.genre === "Overall" && e.rank === 19);
  const newEntryId = newEntryRow ? newEntryRow.song_id : -1;
  db.exec("BEGIN");
  try {
    for (let back = 13; back >= 1; back--) {
      const day = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
      const jitter = (songId) => songId === newEntryId
        ? -6.5 - mulberry32(songId * 31 + back * 7)() * 2
        : mulberry32(songId * 7919 + back * 131 + 13)() * 7 - 3.5;
      for (const e of charts.computeRankings(db, jitter)) {
        insEntry.run(day, e.level, e.genre, e.region_key, e.song_id, e.rank, e.chart_score);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // DJ'S HOT PICKS: this Friday's panel picks — 3 songs that are already
  // hot just outside the Top 20 (unjittered National Overall ranks 22, 25
  // and 28). The recalc below steps them into today's Top 20, badged.
  const pickDate = charts.todayStr();
  const insPick = db.prepare("INSERT OR IGNORE INTO dj_picks (song_id, pick_date) VALUES (?, ?)");
  const hotPicks = [22, 25, 28]
    .map((rk) => baseRanks.find((e) => e.level === "national" && e.genre === "Overall" && e.rank === rk))
    .filter(Boolean);
  for (const e of hotPicks) insPick.run(e.song_id, pickDate);
  console.log(`dj's hot picks: seeded ${hotPicks.length} for Friday ${pickDate}`);

  const result = charts.recalc(db);
  const counts = {
    users: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    songs: db.prepare("SELECT COUNT(*) c FROM songs").get().c,
    videos: db.prepare("SELECT COUNT(*) c FROM videos").get().c,
    djSubmissions: db.prepare("SELECT COUNT(*) c FROM dj_submissions").get().c,
    djVotes: db.prepare("SELECT COUNT(*) c FROM dj_votes").get().c,
    entriesToday: db.prepare("SELECT COUNT(*) c FROM chart_entries WHERE chart_date = ?").get(result.date).c,
    entriesYesterday: db.prepare("SELECT COUNT(*) c FROM chart_entries WHERE chart_date = ?").get(yesterday).c,
    notifications: db.prepare("SELECT COUNT(*) c FROM notifications").get().c,
  };
  console.log("seed complete:", JSON.stringify(counts));
  console.log(`genres: ${GENRES.join(", ")} (+ Overall charts)`);
}

main();
