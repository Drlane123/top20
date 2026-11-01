"use strict";
// Share-my-position cards — Dale's spec (Oct 31, 2026).
//
// When a song is standing anywhere in a Top 100, its share card is a
// composed image: the cover big on the left, and on the right the song's
// LIVE headline rank, read from today's chart at render time. A Top 20
// rank gets the big-number glory treatment; #21–100 show their number
// plain. When a song leaves the Top 100 it has no standing, and no card —
// the number vanishes, exactly like the badge on its page.
//
// Headline standing (Dale-approved): National Overall first, else the
// song's National genre chart, else its best remaining chart.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { latestChartDate } = require("./charts");

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
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
  const key = [songId, chartDate, standing.level, standing.genre, standing.region_key, standing.rank, title, artist].join("|");
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-"));
  const put = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, cardText(text, 200)); return p; };
  const fBrand = put("brand.txt", "TOP 20");
  const fRank = put("rank.txt", "#" + standing.rank);
  const fLabel = put("label.txt", chartLabelText(standing));
  const fTier = put("tier.txt", top20 ? "★ OFFICIAL TOP 20" : "TOP 100");
  const fTitle = put("title.txt", cardText(title, 22));
  const fArtist = put("artist.txt", cardText(artist, 28));
  const dt = (file, size, color, x, y) =>
    `drawtext=fontfile=${FONT}:textfile=${file}:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}`;
  const graph = [
    "[0:v]scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630,gblur=sigma=20,eq=brightness=-0.38[bg]",
    "[0:v]scale=560:560[fg]",
    "[bg][fg]overlay=40:35[comp]",
    "[comp]drawbox=x=38:y=33:w=564:h=564:color=0xFFC44D:t=3,"
      + dt(fBrand, 56, "0xFFC44D", 665, 46) + ","
      + dt(fRank, top20 ? 215 : 118, top20 ? "0xFFC44D" : "0xFFFFFF", 665, top20 ? 118 : 150) + ","
      + dt(fLabel, 37, "0xFFFFFF", 665, top20 ? 372 : 302) + ","
      + dt(fTier, 33, "0xFFC44D", 665, top20 ? 428 : 356) + ","
      + dt(fTitle, 43, "0xFFFFFF", 665, 486) + ","
      + dt(fArtist, 35, "0xCFE0FF", 665, 542)
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

module.exports = { headlineStanding, chartLabelText, renderCard };
