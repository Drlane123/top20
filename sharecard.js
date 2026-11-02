"use strict";
// Share-my-position cards — Dale's spec (Oct 31, 2026; v2 same night).
//
// When a song is standing anywhere in a Top 100, its share card mirrors
// the site's Stage panel: the cover fills the whole square, a lacquer
// band across the top carries the song's LIVE headline rank — a big
// PLATINUM number at the top-left, just like the Stage — and a bottom
// band carries the title and artist. A Top 20 rank gets the full-size
// number; #21–100 show a smaller one. No standing, no card: the number
// vanishes, exactly like the badge on the song's page.
//
// Headline standing (Dale-approved): National Overall first, else the
// song's National genre chart, else its best remaining chart.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { latestChartDate } = require("./charts");

const FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";
const FONT_STAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"; // Liberation has no ★ glyph
const cache = new Map(); // render key -> Buffer

function headlineStanding(db, songId) {
  const date = latestChartDate(db);
  if (!date) return null;
  const rows = db.prepare(
    "SELECT * FROM chart_entries WHERE song_id = ? AND chart_date = ? AND rank <= 100"
  ).all(songId, date);
  if (!rows.length) return null;
  const best = (list) => list.slice().sort((a, b) => a.rank - b.rank)[0] || null;
  return best(rows.filter((r) => r.level === "national" && r.genre === "Overall"))
      || best(rows.filter((r) => r.level === "national"))
      || best(rows);
}

function chartLabelText(row) {
  const base = `${String(row.level).toUpperCase()} ${String(row.genre).toUpperCase()}`;
  return row.level === "national" ? base : `${base} · ${String(row.region_key).toUpperCase()}`;
}

// Text for the card image only: one line, no characters that trouble the
// renderer. The page itself always shows the true title.
const cardText = (s, max) => String(s || "").replace(/[%\\]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

function renderCard({ songId, title, artist, coverAbs, standing, chartDate }) {
  const top20 = standing.rank <= 20;
  const key = ["v2", songId, chartDate, standing.level, standing.genre, standing.region_key, standing.rank, title, artist].join("|");
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-"));
  const put = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, cardText(text, 200)); return p; };
  const fBrand = put("brand.txt", "TOP 20");
  const fRank = put("rank.txt", "#" + standing.rank);
  const fLabel = put("label.txt", chartLabelText(standing));
  const fTier = put("tier.txt", top20 ? "★ OFFICIAL TOP 20" : "TOP 100");
  const fTitle = put("title.txt", cardText(title, 24));
  const fArtist = put("artist.txt", cardText(artist, 30));
  const fDomain = put("domain.txt", "HOTTOP20.COM");
  const rankSize = top20 ? 205 : 165;
  const digits = String(standing.rank).length;
  const textX = Math.round(48 + (0.52 + 0.60 * digits) * rankSize + 46);
  const dt = (file, size, color, x, y) =>
    `drawtext=fontfile=${FONT}:textfile=${file}:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}`;
  const graph = [
    "[0:v]scale=1200:1200:force_original_aspect_ratio=increase,crop=1200:1200[bg]",
    "[bg]drawbox=x=0:y=0:w=1200:h=250:color=0x060B1C:t=fill,"
      + "drawbox=x=0:y=1000:w=1200:h=200:color=0x060B1C:t=fill,"
      + "drawbox=x=0:y=0:w=1200:h=1200:color=0xFFC44D:t=6,"
      + dt(fRank, rankSize, "0x54657F", 55, 30) + "," // platinum shadow pass
      + dt(fRank, rankSize, "0xF4F8FF", 48, 23) + "," // platinum face
      + dt(fBrand, 68, "0xFFC44D", textX, 32) + ","
      + dt(fLabel, 44, "0xFFFFFF", textX, 118) + ","
      + `drawtext=fontfile=${FONT_STAR}:textfile=${fTier}:fontsize=38:fontcolor=0xFFC44D:x=${textX}:y=182` + ","
      + dt(fTitle, 56, "0xFFFFFF", 48, 1032) + ","
      + dt(fArtist, 44, "0xCFE0FF", 48, 1106) + ","
      + dt(fDomain, 28, "0x8FA8D8", 890, 1122)
      + "[out]",
  ].join(";");
  const out = path.join(dir, "card.jpg");
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-i", coverAbs, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "3", out],
      { timeout: 30000 }, (err) => {
        let buf = null, readErr = err;
        if (!err) {
          try { buf = fs.readFileSync(out); } catch (e) { readErr = e; }
        }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
        if (readErr) return reject(readErr);
        if (cache.size > 200) cache.clear();
        cache.set(key, buf);
        resolve(buf);
      });
  });
}

// Profile share cards (owner, Nov 1, 2026): when an artist shares their
// profile, Facebook was showing the generic site card — the artist's own
// photo is served through a storage redirect Facebook's scraper won't
// follow, so the post came out as a bare link with site branding. This
// card is served straight from the site as one finished picture: the
// artist's photo filling the square, their name, city and genre on the
// lacquer band, and the line that sells the click — their songs play
// right on the profile page. The click still lands on /artist/<id>.
function renderProfileCard({ userId, name, city, state, genre, imageAbs, standingLine }) {
  const key = ["pv1", userId, name, city, state, genre, imageAbs || "none", standingLine || ""].join("|");
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcard-"));
  const put = (n, text) => { const p = path.join(dir, n); fs.writeFileSync(p, cardText(text, 200)); return p; };
  const fBrand = put("brand.txt", "TOP 20");
  const fKind = put("kind.txt", "ARTIST PROFILE");
  const fDomain = put("domain.txt", "HOTTOP20.COM");
  const fStand = put("stand.txt", standingLine || "INDEPENDENT ARTIST");
  const fName = put("name.txt", cardText(name, 26));
  const fMeta = put("meta.txt", cardText([city && state ? `${city}, ${state}` : (city || state || ""), genre || ""].filter(Boolean).join(" · "), 48));
  const fTag = put("tag.txt", "TAP TO LISTEN — SONGS PLAY ON THIS PAGE");
  const dt = (file, size, color, x, y) =>
    `drawtext=fontfile=${FONT}:textfile=${file}:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}`;
  const graph = [
    "[0:v]scale=1200:1200:force_original_aspect_ratio=increase,crop=1200:1200[bg]",
    "[bg]drawbox=x=0:y=0:w=1200:h=190:color=0x060B1C:t=fill,"
      + "drawbox=x=0:y=900:w=1200:h=300:color=0x060B1C:t=fill,"
      + "drawbox=x=0:y=0:w=1200:h=1200:color=0xFFC44D:t=6,"
      + dt(fBrand, 72, "0xFFC44D", 48, 30) + ","
      + dt(fKind, 40, "0xFFFFFF", 50, 122) + ","
      + dt(fDomain, 28, "0x8FA8D8", 905, 46) + ","
      + dt(fStand, 38, "0xFFC44D", 48, 924) + ","
      + dt(fName, 64, "0xFFFFFF", 48, 972) + ","
      + dt(fMeta, 42, "0xCFE0FF", 48, 1054) + ","
      + dt(fTag, 34, "0xFFC44D", 48, 1120)
      + "[out]",
  ].join(";");
  const out = path.join(dir, "pcard.jpg");
  const args = imageAbs
    ? ["-y", "-i", imageAbs, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "3", out]
    : ["-y", "-f", "lavfi", "-i", "color=c=0x0A1230:s=1200x1200", "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "3", out];
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 30000 }, (err) => {
      let buf = null, readErr = err;
      if (!err) {
        try { buf = fs.readFileSync(out); } catch (e) { readErr = e; }
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
      if (readErr) return reject(readErr);
      if (cache.size > 200) cache.clear();
      cache.set(key, buf);
      resolve(buf);
    });
  });
}

module.exports = { headlineStanding, chartLabelText, renderCard, renderProfileCard };
