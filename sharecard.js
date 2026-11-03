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
// record's album cover filling the square (the artist's photo when no
// song is live yet), their name, city and genre on the
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

// Bragging plaques (owner, Nov 2, 2026 — from the scorecard review Dale
// brought in): a TALL 1080x1920 picture made for Instagram Stories and
// TikTok. Artists love to brag, and every brag carries the brand: the
// cover fills the frame, the platinum rank rides the top band like the
// Stage, the bottom band carries title, artist and craft score, and the
// tagline closes it. Same standing rule as the share card — no standing
// in a Top 100, no plaque.
function renderBadge({ songId, title, artist, coverAbs, standing, chartDate, craftScore }) {
  const top20 = standing.rank <= 20;
  const key = ["badge1", songId, chartDate, standing.level, standing.genre, standing.region_key, standing.rank, title, artist, craftScore].join("|");
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "badge-"));
  const put = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, cardText(text, 200)); return p; };
  const fBrand = put("brand.txt", "TOP 20");
  const fRank = put("rank.txt", "#" + standing.rank);
  const fLabel = put("label.txt", chartLabelText(standing));
  const fTier = put("tier.txt", top20 ? "★ OFFICIAL TOP 20" : "TOP 100");
  const fTitle = put("title.txt", cardText(title, 22));
  const fArtist = put("artist.txt", cardText(artist, 28));
  const fCraft = put("craft.txt", craftScore != null ? `CRAFT SCORE ${craftScore} / 100` : "15-POINT SCALE EVALUATION");
  const fTag = put("tag.txt", "CHARTS BY CRAFT, NOT JUST CLOUT");
  const fDomain = put("domain.txt", "HOTTOP20.COM");
  const rankSize = top20 ? 200 : 160;
  const digits = String(standing.rank).length;
  const textX = Math.round(44 + (0.52 + 0.60 * digits) * rankSize + 40);
  const dt = (file, size, color, x, y) =>
    `drawtext=fontfile=${FONT}:textfile=${file}:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}`;
  const graph = [
    "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bg]",
    "[bg]drawbox=x=0:y=0:w=1080:h=310:color=0x060B1C:t=fill,"
      + "drawbox=x=0:y=1450:w=1080:h=470:color=0x060B1C:t=fill,"
      + "drawbox=x=0:y=0:w=1080:h=1920:color=0xFFC44D:t=6,"
      + dt(fRank, rankSize, "0x54657F", 51, 42) + "," // platinum shadow pass
      + dt(fRank, rankSize, "0xF4F8FF", 44, 35) + "," // platinum face
      + dt(fBrand, 62, "0xFFC44D", textX, 44) + ","
      + dt(fLabel, 38, "0xFFFFFF", textX, 128) + ","
      + `drawtext=fontfile=${FONT_STAR}:textfile=${fTier}:fontsize=34:fontcolor=0xFFC44D:x=${textX}:y=188` + ","
      + dt(fTitle, 66, "0xFFFFFF", 44, 1496) + ","
      + dt(fArtist, 46, "0xCFE0FF", 44, 1588) + ","
      + dt(fCraft, 40, "0xFFC44D", 44, 1680) + ","
      + dt(fTag, 30, "0x8FA8D8", 44, 1760) + ","
      + dt(fDomain, 28, "0x8FA8D8", 44, 1812)
      + "[out]",
  ].join(";");
  const out = path.join(dir, "badge.jpg");
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

// Facebook bragging plaque (owner, Nov 3, 2026): the story plaque is
// cropped-to-fill for Instagram/TikTok, but Facebook gets its OWN —
// a 1200x1500 (4:5, the biggest a Facebook feed shows whole) picture
// where the cover is shown COMPLETE, head to toe, never cropped: the
// cover is fit inside its zone and the lacquer shows around it. The
// header carries the platinum rank; under the whole cover sit title,
// artist, craft score, the counts (plays, likes, shares, fan bonus,
// days charted, total) and the measured specs line — the full brag,
// made for a Facebook post. Same standing rule as the other cards.
function renderFbBadge({ songId, title, artist, coverAbs, standing, chartDate, craftScore, statsLine, specsLine }) {
  const top20 = standing.rank <= 20;
  const key = ["fbbadge1", songId, chartDate, standing.level, standing.genre, standing.region_key, standing.rank, title, artist, craftScore, statsLine, specsLine].join("|");
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbbadge-"));
  const put = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, cardText(text, 200)); return p; };
  // Fit a " · "-joined line to the plaque width by dropping trailing
  // tokens — a line never runs off the edge.
  const fit = (line, size) => {
    const per = size * 0.54;
    const parts = String(line || "").split(" · ").filter(Boolean);
    while (parts.length > 1 && parts.join(" · ").length * per > 1112) parts.pop();
    return parts.join(" · ");
  };
  const fBrand = put("brand.txt", "TOP 20");
  const fRank = put("rank.txt", "#" + standing.rank);
  const fLabel = put("label.txt", chartLabelText(standing));
  const fTier = put("tier.txt", top20 ? "★ OFFICIAL TOP 20" : "TOP 100");
  const fTitle = put("title.txt", cardText(title, 22));
  const fArtist = put("artist.txt", cardText(artist, 28));
  const fCraft = put("craft.txt", craftScore != null ? `CRAFT ${craftScore} / 100` : "15-POINT SCALE");
  const fStats = put("stats.txt", fit(statsLine, 31) || "15-POINT SCALE EVALUATION");
  const fSpecs = put("specs.txt", fit(specsLine, 27));
  const fTag = put("tag.txt", "CHARTS BY CRAFT, NOT JUST CLOUT");
  const fDomain = put("domain.txt", "HOTTOP20.COM");
  const rankSize = top20 ? 138 : 112;
  const digits = String(standing.rank).length;
  const textX = Math.round(44 + (0.52 + 0.60 * digits) * rankSize + 40);
  const dt = (file, size, color, x, y) =>
    `drawtext=fontfile=${FONT}:textfile=${file}:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}`;
  const graph = [
    "[0:v]scale=1200:1060:force_original_aspect_ratio=decrease,pad=1200:1500:(ow-iw)/2:170:color=0x060B1C[bg]",
    "[bg]drawbox=x=0:y=164:w=1200:h=5:color=0xFFC44D:t=fill,"
      + "drawbox=x=0:y=1230:w=1200:h=270:color=0x060B1C:t=fill,"
      + "drawbox=x=0:y=1226:w=1200:h=4:color=0xFFC44D:t=fill,"
      + "drawbox=x=0:y=0:w=1200:h=1500:color=0xFFC44D:t=6,"
      + dt(fRank, rankSize, "0x54657F", 51, 26) + ","
      + dt(fRank, rankSize, "0xF4F8FF", 44, 19) + ","
      + dt(fBrand, 54, "0xFFC44D", textX, 22) + ","
      + dt(fLabel, 35, "0xFFFFFF", textX, 88) + ","
      + `drawtext=fontfile=${FONT_STAR}:textfile=${fTier}:fontsize=29:fontcolor=0xFFC44D:x=${textX}:y=132` + ","
      + dt(fTitle, 50, "0xFFFFFF", 44, 1252) + ","
      + dt(fCraft, 42, "0xFFC44D", "(w-text_w-44)", 1258) + ","
      + dt(fArtist, 37, "0xCFE0FF", 44, 1324) + ","
      + dt(fStats, 31, "0xFFFFFF", 44, 1384) + ","
      + (specsLine ? dt(fSpecs, 27, "0xFFC44D", 44, 1432) + "," : "")
      + dt(fTag, 25, "0x8FA8D8", 44, 1466) + ","
      + dt(fDomain, 25, "0x8FA8D8", "(w-text_w-44)", 1466)
      + "[out]",
  ].join(";");
  const out = path.join(dir, "fbbadge.jpg");
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

module.exports = { headlineStanding, chartLabelText, renderCard, renderProfileCard, renderBadge, renderFbBadge };
