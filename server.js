// Top 20 — v1 server. Express + node:sqlite. Mobile-first, black gloss +
// chrome theme. Pages: Stage (/), Charts, Song, Upload, Dashboard, Outbox.
const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync, execFile } = require("node:child_process");
const { openDb, DB_PATH } = require("./db");
const { GENRES, OVERALL, CATEGORIES, regionForState, localKey } = require("./config");
const { judgeAudioFile } = require("./judge");
const { judgeMeasuredFile } = require("./judge2");
const storage = require("./storage");
const VIEWCAST_SETS = require("./viewcast-data");
const sharecard = require("./sharecard");
const { recalc, latestChartDate, previousChartDate, ensureCurrent, todayStr, supportBonus, supportBySong } = require("./charts");

const PORT = process.env.PORT || 8077;
// Build identity for the stale-page self-heal: Render sets
// RENDER_GIT_COMMIT per deploy; locally this stays "dev" (no checks).
const BUILD = process.env.RENDER_GIT_COMMIT || "dev";
const PUBLIC_DIR = path.join(__dirname, "public");
const AUDIO_UP = path.join(PUBLIC_DIR, "uploads", "audio");
const COVER_UP = path.join(PUBLIC_DIR, "uploads", "covers");
const VIDEO_UP = path.join(PUBLIC_DIR, "uploads", "videos");
const VIEWCAST_UP = path.join(PUBLIC_DIR, "uploads", "viewcast");
fs.mkdirSync(AUDIO_UP, { recursive: true });
fs.mkdirSync(COVER_UP, { recursive: true });
fs.mkdirSync(VIDEO_UP, { recursive: true });
fs.mkdirSync(VIEWCAST_UP, { recursive: true });

// Storage phase 2: on a fresh deploy the local record book is gone —
// pull the latest snapshot from the bucket BEFORE opening the database.
// Runs a small helper process and waits for it; a no-op when storage is
// not configured or a local copy already exists.
try {
  const { spawnSync } = require("node:child_process");
  const rr = spawnSync(process.execPath, [path.join(__dirname, "restore-db.js")], { stdio: "inherit", timeout: 30000 });
  if (rr && rr.error) console.error("[restore] skipped:", rr.error.message);
} catch (e) { console.error("[restore] skipped:", e.message); }

const db = openDb();
const app = express();
app.set("trust proxy", 1); // Render terminates HTTPS — believe its forwarded protocol so absolute links (share cards) come out https

// Hero welcome video: the binary ships base64-embedded (hero-data.js)
// Build probe for the stale-page self-heal (see layout): an open page
// asks here whether the site has been rebuilt since it loaded.
app.get("/version", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ build: BUILD });
});

// because the repo pipeline is text-only. Decoded once at boot, then
// streamed with HTTP range support so phones can play/seek it.
// (Seal commit Oct 31: forces a clean rebuild from the complete hero v5
// part set — an intermediate deploy had mixed v5 parts 1-4 with the old
// part 5 and served a scrambled, unplayable video file.)
// (Second seal, Oct 31 evening: the new-soundtrack swap stitched again —
// an intermediate deploy mixed new parts 1-2 with silent-cut parts 3-5.
// The owner called this failure mode himself: the pieces are the risk.)
const HERO = (() => {
  try {
    const parts = [];
    for (let i = 1; i <= 8; i++) { try { parts.push(require("./hero-data-" + i)); } catch (e) { break; } }
    if (!parts.length) throw new Error("no hero parts");
    return { mp4: Buffer.from(parts.join(""), "base64"), poster: Buffer.from(require("./hero-poster-data"), "base64") };
  } catch (e) { return null; }
})();
// HERO2 — the stripped-and-rebuilt welcome video (Oct 31, owner's cure
// for the doubled soundtrack): fresh re-encode, clean timestamps, and
// served at a NEW address with no-store. The old /hero.mp4 kept a
// 24-hour cache header while its file was swapped three times in a day;
// the owner's phone cached pieces of different versions at one address
// and stitched them into a promo that repeated over itself — same spot
// every time, surviving restarts, invisible to any fresh browser.
const HERO2 = (() => {
  try {
    const parts = [];
    for (let i = 1; i <= 8; i++) { try { parts.push(require("./hero2-data-" + i)); } catch (e) { break; } }
    if (!parts.length) throw new Error("no hero2 parts");
    return { mp4: Buffer.from(parts.join(""), "base64") };
  } catch (e) { return null; }
})();
// Stage DJ announcement clips: the owner's chosen recorded voice (Take 3),
// shipped base64-embedded like the hero video. Keys: rank-1..20,
// title-<songId>, days-fresh, days-one, days-2..60, closer.
const ANN = (() => {
  const raw = {};
  for (const m of ["./announce-data-1", "./announce-data-2"]) {
    try { Object.assign(raw, require(m)); } catch (e) {}
  }
  const bufs = {};
  for (const k of Object.keys(raw)) { try { bufs[k] = Buffer.from(raw[k], "base64"); } catch (e) {} }
  return bufs;
})();
app.get("/ann/:file", (req, res) => {
  const key = String(req.params.file || "").replace(/\.mp3$/i, "").replace(/[^a-z0-9-]/gi, "");
  const b = ANN[key];
  if (!b) return res.status(404).end();
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=604800");
  res.send(b);
});
// If the owner has uploaded his own hero video to Cloudflare storage, the
// home page's hero is served from there (whole file, signed link, streamed
// by Cloudflare). Until he does — or if storage is ever unconfigured — the
// request falls through to the built-in copy below, untouched.
app.get("/hero.mp4", (req, res, next) => {
  try {
    if (storage.configured()) {
      const row = db.prepare("SELECT value FROM admin_config WHERE key = 'hero_r2'").get();
      if (row) {
        const url = storage.presignGet(JSON.parse(row.value).key, 3600);
        if (url) {
          res.setHeader("Cache-Control", "no-store");
          return res.redirect(url);
        }
      }
    }
  } catch { /* fall through to the built-in hero */ }
  return next();
});
if (HERO) {
  app.get("/hero.mp4", (req, res) => {
    const total = HERO.mp4.length;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", end - start + 1);
      res.end(HERO.mp4.subarray(start, end + 1));
    } else {
      res.setHeader("Content-Length", total);
      res.end(HERO.mp4);
    }
  });
  app.get("/hero-poster.jpg", (req, res) => {
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(HERO.poster);
  });
}
if (HERO2) {
  app.get("/hero2.mp4", (req, res) => {
    const total = HERO2.mp4.length;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", end - start + 1);
      res.end(HERO2.mp4.subarray(start, end + 1));
    } else {
      res.setHeader("Content-Length", total);
      res.end(HERO2.mp4);
    }
  });
}
// Header artist crowd (owner request): two generated artist lineups that
// stand at the top of every page, behind the TOP 20 wordmark. Same
// base64-embed shipping as the hero (repo pipeline is text-only).
const CROWD = (() => {
  try {
    return {
      left: Buffer.from(require("./crowd-left-data"), "base64"),
      right: Buffer.from(require("./crowd-right-data"), "base64"),
      center: Buffer.from(require("./crowd-center-data"), "base64"),
      guy: Buffer.from(require("./crowd-guy-data"), "base64"),
      lady: Buffer.from(require("./crowd-lady-data"), "base64"),
    };
  } catch (e) { return null; }
})();
if (CROWD) {
  app.get("/crowd-left.webp", (req, res) => {
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(CROWD.left);
  });
  app.get("/crowd-right.webp", (req, res) => {
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(CROWD.right);
  });
  app.get("/crowd-center.webp", (req, res) => {
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(CROWD.center);
  });
  app.get("/crowd-guy.webp", (req, res) => {
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(CROWD.guy);
  });
  app.get("/crowd-lady.webp", (req, res) => {
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(CROWD.lady);
  });
}
// App icons — the owner's platinum HOT TOP 20 logo (Nov 1, 2026): served
// from baked data like the hero, because the repo push path cannot carry
// binary PNG files. These routes sit ahead of the static folder, so the
// new mark wins everywhere the icon shows: favicon/Google, the install
// bar, the download pill, and installed home-screen icons.
const ICONS = (() => {
  try {
    const raw = require("./icon-data");
    const out = {};
    for (const k of Object.keys(raw)) out[k] = Buffer.from(raw[k], "base64");
    return out;
  } catch (e) { return null; }
})();
if (ICONS) {
  const iconRoute = (pathName, key) => app.get(pathName, (req, res) => {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(ICONS[key]);
  });
  iconRoute("/icons/icon-512x512.png", "icon-512x512.png");
  iconRoute("/icons/icon-192x192.png", "icon-192x192.png");
  iconRoute("/icons/icon-maskable-512x512.png", "icon-maskable-512x512.png");
  iconRoute("/icons/apple-touch-icon.png", "apple-touch-icon.png");
  iconRoute("/apple-touch-icon.png", "apple-touch-icon.png");
}
// Pages always re-fetch fresh HTML (owner hit a stale cached page more
// than once — new features like the DJ voice never reached his phone).
// Media and data files keep their normal caching.
app.use((req, res, next) => {
  const p = req.path || "";
  const isAsset = /^\/(ann|covers|audio|uploads|api)\//.test(p) || /\.(js|css|png|jpe?g|webp|mp3|mp4|ico|svg)$/i.test(p);
  if (req.method === "GET" && !isAsset) res.set("Cache-Control", "no-store, must-revalidate");
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "1mb" })); // Viewcast signaling posts JSON
// Uploaded media is mirrored to the cloud bucket (storage phase 2): when
// a file is missing from this instance's disk — every deploy starts with
// an empty disk — send the visitor to the bucket copy instead of a 404.
app.use("/uploads", (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const rel = decodeURIComponent(req.path || "").replace(/^\/+/, "");
  if (!rel || rel.includes("..")) return next();
  if (fs.existsSync(path.join(PUBLIC_DIR, "uploads", rel))) return next();
  if (!storage.configured()) return next();
  const url = storage.presignGet(`uploads/${rel}`, 3600);
  if (!url) return next();
  res.set("Cache-Control", "no-store");
  return res.redirect(302, url);
});
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".webmanifest")) {
      res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
    }
    if (filePath.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));

/* ---------------------------------- utils --------------------------------- */

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const CSS = `
:root{
  --accent:#2b5cff; /* royal blue: TOP wordmark + primary accents (owner-swappable) */
  --ink:#f4f4f6; --dim:#a7abb5; --line:#33363d;
  --chrome:linear-gradient(180deg,#fdfdff 0%,#d7dae1 28%,#969ca8 50%,#e9ebf0 54%,#b7bcc7 78%,#f5f6f8 100%);
  --up:#2ee06f; --down:#ff5252; --flat:#8a8f98; --newgreen:#00d95f;
  --fire1:#ff5a00; --fire2:#ffb300; --fire3:#ff2d00;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;overflow-x:clip}
body{margin:0;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:#04060c;background-image:radial-gradient(1100px 560px at 50% -6%,rgba(38,92,255,.15) 0%,rgba(16,42,120,.04) 42%,rgba(20,36,86,0) 62%),linear-gradient(180deg,#0e1830 0%,#0a1224 26%,#060b18 58%,#030509 100%);
  background-attachment:fixed;-webkit-font-smoothing:antialiased;overflow-x:clip}
body::after{content:"";position:fixed;inset:0;z-index:80;pointer-events:none;
  background:linear-gradient(180deg,rgba(255,255,255,.02),transparent 18%)}
.app{max-width:430px;margin:6px auto 0;min-height:100vh;padding:0 14px 34px;
  background:radial-gradient(720px 360px at 50% -40px,rgba(64,110,255,.05),transparent 62%);
  border-left:1px solid;border-right:1px solid;border-top:3px solid;
  border-image:linear-gradient(180deg,#f8fafc 0%,#7e8ea6 28%,#eef3fa 50%,#5f6b7d 76%,#dfe7f2 100%) 1;
  box-shadow:0 0 70px rgba(120,160,255,.03)}
a{color:var(--ink)}
header.site{padding:20px 2px 2px;text-align:center;position:relative}
.crowd{position:absolute;bottom:44px;height:198px;width:auto;z-index:0;pointer-events:none;mix-blend-mode:screen;opacity:1;filter:saturate(1.08) contrast(1.04) brightness(1.03);-webkit-mask-image:linear-gradient(180deg,#000 85%,transparent 99%);mask-image:linear-gradient(180deg,#000 85%,transparent 99%)}
.crowd.cl{left:-6px}
.crowd.cr{right:-14px}
.crowd.cc{left:50%;transform:translateX(-50%);height:232px;bottom:22px}
header.site .wm,header.site .tagline,header.site nav.main{position:relative;z-index:2}
header.site .hotline{position:relative;z-index:5}
@media (min-width:901px){header.site{padding-top:58px}}
@media (max-width:900px){.crowd{height:150px;bottom:40px}.crowd.cc{height:190px;bottom:24px}}
@media (max-width:560px){.crowd{height:74px;opacity:.95;bottom:110px}.crowd.cl{left:-10px}.crowd.cr{right:-10px}.wordmark .top{font-size:30px}.wordmark .twenty{font-size:34px}}
@media (max-width:400px){.crowd{bottom:130px}}
.wm{display:inline-block;text-align:center;position:relative;isolation:isolate}
@keyframes shine{from{background-position:50% 0%}to{background-position:50% 100%}}
/* Futuristic wordmark (owner round 3): the ENTIRE mark leans right in
   italic + skew, stamped into the black surface — dark shadow pressed at
   the top/inner edge, thin bright highlight along the bottom edge. The
   blaze runs the full width of the mark, under TOP and the 20 both. */
.wordmark{font-size:46px;font-weight:900;letter-spacing:.5px;line-height:1;text-align:center;
  font-style:italic;transform:skewX(-12deg)}
/* The logo blinks (owner, Nov 1): a gold double-blink rolls across the
   wordmark every few seconds — an eye-catcher, not a strobe. */
@keyframes wmblink{0%,100%{filter:brightness(1)}8%{filter:brightness(1.55) drop-shadow(0 0 14px rgba(255,196,77,.85))}16%{filter:brightness(1)}24%{filter:brightness(1.55) drop-shadow(0 0 14px rgba(255,196,77,.85))}34%{filter:brightness(1)}}
.wordmark{animation:wmblink 3.2s ease-in-out infinite}
/* Download-the-app button at the VERY TOP of the site (owner, Nov 1 —
   third pass at his word: a small pill, no band, no lines under it, the
   WORDS blink on and off, and it must fit a phone screen — the small
   home-screen words give way first on narrow screens). */
.appchip{display:flex;align-items:center;justify-content:center;gap:7px;width:fit-content;max-width:calc(100% - 16px);margin:7px auto 3px;padding:6px 13px;border:none;border-radius:999px;background:linear-gradient(180deg,rgba(255,190,60,.22),rgba(255,190,60,.08));color:#fff;font:inherit;cursor:pointer;animation:chipglow 1.6s ease-in-out infinite}
.appchip img{width:18px;height:18px;border-radius:5px;flex:0 0 auto}
.appchip .blinkwrap{display:flex;align-items:baseline;gap:6px;animation:wordblink 1.5s ease-in-out infinite}
.appchip-t{font-weight:900;letter-spacing:.4px;font-size:12px;color:#ffd98a;white-space:nowrap;flex:0 0 auto}
.appchip-free{font-weight:900;letter-spacing:.4px;font-size:12px;color:#7dff9a;white-space:nowrap;flex:0 0 auto}
.appchip-s{font-size:10px;color:#cfd8ee;letter-spacing:0;white-space:nowrap;flex:0 0 auto}
@media (max-width:340px){.appchip-s{display:none}}
@keyframes chipglow{0%,100%{box-shadow:0 0 0 rgba(255,196,77,0)}50%{box-shadow:0 0 14px rgba(255,196,77,.45)}}
@keyframes wordblink{0%,62%{opacity:1}72%,88%{opacity:.15}100%{opacity:1}}
@font-face{font-family:'Bowlby One';font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,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) format('woff2')}
@font-face{font-family:'Anton';font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,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) format('woff2')}
.wordmark .top{display:inline-block;color:var(--accent);font-size:96px;font-family:'Bowlby One','Anton',sans-serif;letter-spacing:.5px;padding-right:.12em;
  background:linear-gradient(180deg,#f4f9ff 0%,#bcd6ff 16%,#5f8dff 36%,#ffffff 46%,#2b5cff 58%,#0d2c86 84%,#7ea6ff 100%);
  background-size:100% 210%;
  animation:shine 4.5s ease-in-out infinite alternate;
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 -1px 1px rgba(0,0,0,.95)) drop-shadow(0 1px 0 rgba(210,228,255,.5)) drop-shadow(0 0 10px rgba(43,92,255,.4))}
.wordmark .twenty{display:inline-block;font-family:'Bowlby One',Impact,"Arial Narrow Bold","Franklin Gothic Medium Cond","Helvetica Neue Condensed Black",sans-serif;
  font-weight:900;font-style:italic;letter-spacing:.02em;padding-right:.1em;
  font-size:96px;position:relative;z-index:2;margin-left:.08em;
  background:linear-gradient(180deg,#ffffff 0%,#f4f8ff 20%,#aebdd2 38%,#ffffff 47%,#c3d0e2 58%,#7e8ea6 80%,#eef3fa 100%);
  background-size:100% 210%;
  animation:shine 4.5s ease-in-out infinite alternate;
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 -1px 1px rgba(0,0,0,.95)) drop-shadow(0 1px 0 rgba(255,255,255,.4)) drop-shadow(0 0 9px rgba(215,230,255,.3))}
/* Phone wordmark + crowd (owner, Oct 30): TOP a little bigger than the 20;
   the mark stays narrow enough that the artist bunches flank it from
   OUTSIDE the letters instead of standing behind them. Placed after the
   base wordmark rules on purpose — later rules win. */
@media (max-width:560px){header.site{padding-top:26px}.wordmark .top{font-size:48px}.wordmark .twenty{font-size:48px}.crowd{height:80px;opacity:.95;bottom:108px}.crowd.cl{left:-8px}.crowd.cr{right:-8px}.crowd.cc{height:146px;bottom:58px}}
@media (max-width:400px){.wordmark .top{font-size:44px}.wordmark .twenty{font-size:44px}.crowd{height:76px;bottom:106px}.crowd.cl{left:-10px}.crowd.cr{right:-10px}.crowd.cc{height:140px;bottom:68px}}
.blaze{height:11px;width:100%;margin:7px auto 0;position:relative;
  background:
   radial-gradient(16px 11px at 16% 100%,rgba(255,45,0,.85),transparent 70%),
   radial-gradient(22px 13px at 33% 100%,rgba(255,90,0,.95),transparent 70%),
   radial-gradient(18px 12px at 50% 100%,rgba(255,179,0,.9),transparent 70%),
   radial-gradient(24px 13px at 67% 100%,rgba(255,90,0,.95),transparent 70%),
   radial-gradient(16px 11px at 84% 100%,rgba(255,45,0,.85),transparent 70%);
  filter:blur(.3px);animation:flick 2.6s ease-in-out infinite;transform-origin:50% 100%}
@keyframes flick{0%,100%{transform:scaleY(1);opacity:1}30%{transform:scaleY(1.14);opacity:.92}55%{transform:scaleY(.93);opacity:1}75%{transform:scaleY(1.08);opacity:.95}}
.blaze-line{height:2px;width:100%;margin:1px auto 0;border-radius:2px;
  background:linear-gradient(90deg,transparent,var(--fire3) 25%,var(--fire2) 50%,var(--fire3) 75%,transparent)}
.hotline{margin-top:5px;font-size:11px;font-weight:800;letter-spacing:3.5px;white-space:nowrap;overflow:hidden}
.hotline .tick{display:inline-block;padding-right:12px;
  background:linear-gradient(90deg,#ff7a18,#ffc933,#ff7a18);-webkit-background-clip:text;background-clip:text;color:transparent;
  animation:tickmove 22s linear infinite}
@keyframes tickmove{from{transform:translateX(0)}to{transform:translateX(-100%)}}
.tagline{color:var(--dim);font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-top:5px}
nav.main{display:flex;flex-wrap:wrap;gap:4px 22px;justify-content:center;padding:14px 0 4px}
nav.main a{flex:0 0 auto;text-decoration:none;color:#c9cdd6;padding:6px 2px;
  font-size:15px;font-weight:800;letter-spacing:.4px;border-bottom:2px solid transparent}
nav.main a.active{color:#fff;border-bottom:2px solid var(--accent)}
.panel{position:relative;background:linear-gradient(180deg,#1a1b20,#0a0a0c);border:1px solid #3a3d45;border-radius:18px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14),inset 0 -18px 28px rgba(0,0,0,.38),0 12px 26px rgba(0,0,0,.5);
  padding:18px;margin:18px 0;overflow:hidden}
.panel::before{content:"";position:absolute;left:0;right:0;top:0;height:55%;
  background:linear-gradient(180deg,rgba(255,255,255,.13),rgba(255,255,255,0));pointer-events:none}
.chrome-frame{border:1px solid transparent;border-radius:20px;padding:2px;
  background:linear-gradient(#101013,#0a0a0c) padding-box,var(--chrome) border-box;
  box-shadow:0 8px 22px rgba(0,0,0,.55)}
.chrome-frame .panel{background-image:
  radial-gradient(560px 240px at 50% 116%,rgba(255,122,24,.17),transparent 62%),
  radial-gradient(420px 300px at 6% -12%,rgba(43,92,255,.13),transparent 60%),
  radial-gradient(380px 260px at 98% -4%,rgba(140,60,255,.10),transparent 60%),
  linear-gradient(180deg,#1a1b20,#0a0a0c)}
.chrome-frame .panel{margin:0;border-color:#232429;border-radius:18px;box-shadow:none}
.chrome-frame .panel::before{display:none}
h1{font-size:25px;margin:12px 0 4px;font-weight:900;letter-spacing:.2px} h2{font-size:20px;margin:4px 0 10px;letter-spacing:.6px;font-weight:900;text-transform:uppercase} h3{font-size:16px;margin:14px 0 6px}
h1,h2{font-family:'Anton',sans-serif}
h2{letter-spacing:1px}
.sub{color:var(--dim);font-size:14px;line-height:1.5}
.tabs{display:flex;flex-wrap:wrap;gap:4px 18px;padding:6px 0 2px}
.tabs a,.tabs button{flex:0 0 auto;text-decoration:none;cursor:pointer;color:#c9cdd6;padding:6px 2px;
  background:none;border:none;border-bottom:2px solid transparent;border-radius:0;
  font-size:14.5px;font-weight:800;font-family:inherit}
.tabs a.active,.tabs button.active{color:#fff;border-bottom:2px solid var(--accent)}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.chip{border:1px solid #43464e;border-radius:999px;padding:5px 11px;font-size:13px;color:var(--ink);
  background:linear-gradient(180deg,#1d1d20,#101012)}
.chip b{color:#fff}
.btn{display:inline-block;cursor:pointer;text-decoration:none;text-align:center;min-height:48px;
  padding:13px 20px;border-radius:999px;border:1px solid #767b86;background:var(--chrome);
  color:#0b0b0d;font-weight:800;font-size:15px;font-family:inherit;
  box-shadow:inset 0 1px 0 #fff,0 5px 12px rgba(0,0,0,.5)}
.btn:active{transform:translateY(1px)}
.btn-blue{background:linear-gradient(180deg,#7198ff,#2b5cff 48%,#1740b4);color:#fff;border-color:#0f2c7d;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 5px 12px rgba(0,0,0,.5)}
.btn-block{display:block;width:100%}
.np-top{display:flex;align-items:center;gap:14px}
#npPanel{scroll-margin-top:0px}
@media (max-width:700px){
  /* One tap on PLAYLIST LIVE frames the whole now-playing panel on a
     phone screen (owner request, Nov 1): the cover gives up height on
     short screens so the big rank through the Share button fit at once. */
  #npCover{width:min(100%,calc(100vh - 448px));width:min(100%,calc(100dvh - 448px));height:auto;aspect-ratio:1/1;display:block;margin-left:auto;margin-right:auto}
}
.np-bigrank{font-family:Impact,"Arial Narrow Bold",sans-serif;font-weight:900;font-style:italic;font-size:56px;line-height:.9;padding-right:.06em;background:linear-gradient(180deg,#ffffff 0%,#f4f8ff 20%,#aebdd2 38%,#ffffff 47%,#c3d0e2 58%,#7e8ea6 80%,#eef3fa 100%);background-size:100% 210%;animation:shine 4.5s ease-in-out infinite alternate;-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 -1px 1px rgba(0,0,0,.95)) drop-shadow(0 1px 0 rgba(255,255,255,.4)) drop-shadow(0 0 9px rgba(215,230,255,.3))}
.np-ranklab{font-size:10px;letter-spacing:2px;color:var(--dim);text-transform:uppercase;margin-top:3px}
.cover{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:16px;border:1px solid #4a4e58;display:block;
  box-shadow:0 10px 24px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.2)}
/* The Spinner — the Top 20 covers ride a rotating 3D ring (SpinQuest-style
   motion, owner request): front cover big and glowing, the ring keeps
   turning on its own and swings to each song as it plays. */
.ringwrap{position:relative;height:238px;margin-top:10px;perspective:720px;overflow:hidden;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent);
  mask-image:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent)}
.ring{position:absolute;left:50%;top:50%;width:0;height:0;transform-style:preserve-3d;
  transition:transform 1.1s cubic-bezier(.25,.8,.25,1)}
.cell{position:absolute;left:-50px;top:-66px;width:100px;text-align:center;cursor:pointer;backface-visibility:hidden;
  transition:opacity .8s ease,transform .45s ease}
.cell img{width:100px;height:100px;border-radius:14px;border:1px solid #4a4e58;object-fit:cover;display:block;
  box-shadow:0 14px 28px rgba(0,0,0,.62),inset 0 1px 0 rgba(255,255,255,.25)}
.cellin{position:relative;transition:transform .45s cubic-bezier(.2,.9,.3,1.35)}
.cellin::after{content:"";position:absolute;inset:0;height:100px;border-radius:14px;pointer-events:none;
  background:linear-gradient(155deg,rgba(120,170,255,.22),rgba(255,255,255,.06) 40%,transparent 62%)}
.cell:hover .cellin,.cell.pop .cellin{transform:scale(1.25)}
.cell.front .cellin::after{background:linear-gradient(155deg,rgba(120,170,255,.34),rgba(255,255,255,.10) 40%,transparent 62%)}
.cell .ct{margin-top:7px;font-size:11.5px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cell .ca{font-size:10.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cell:hover .ct,.cell.pop .ct{font-size:13px;color:#fff;white-space:normal;overflow:visible}
.cell:hover .ca,.cell.pop .ca{font-size:11.5px;color:#cfd6e4;white-space:normal;overflow:visible}
.cell.front img{border-color:#aeb6c4;
  box-shadow:0 0 0 1px rgba(255,255,255,.3),0 0 30px rgba(43,92,255,.4),0 18px 34px rgba(0,0,0,.68)}
.cell:hover img,.cell.pop img{border-color:#8fb4ff;
  box-shadow:0 0 0 1px rgba(160,195,255,.55),0 0 34px rgba(43,92,255,.55),0 20px 38px rgba(0,0,0,.7)}
.ringnow{text-align:center;font-size:13px;color:var(--dim);margin-top:4px}
.ringnow b{color:#fff}
.spinlabel{display:inline-block;margin:16px 0 0;padding:6px 14px;border-radius:999px;font-size:12px;font-weight:900;
  letter-spacing:2px;color:#e3edff;border:1px solid #5f8dff;
  background:linear-gradient(180deg,#4a7de6,#1c46a8 55%,#122c6e);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 0 16px rgba(43,92,255,.35);transition:box-shadow .6s ease,filter .6s ease}
.cell.playing .cellin{transform:scale(1.45)}
.cell.playing img{border-color:#d7e6ff;
  box-shadow:0 0 0 1px rgba(210,230,255,.7),0 0 48px rgba(43,92,255,.75),0 22px 40px rgba(0,0,0,.72)}
.cell.playing .ct{font-size:13.5px;color:#fff;white-space:normal;overflow:visible}
.spinlabel.lit{filter:brightness(1.3);animation:litpulse 1.6s ease-in-out infinite}
@keyframes litpulse{0%,100%{box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 0 16px rgba(43,92,255,.4)}50%{box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 0 34px rgba(43,92,255,.85)}}
.ringwrap{transition:opacity .6s ease}
.ringwrap.lit{background:radial-gradient(300px 150px at 50% 46%,rgba(43,92,255,.17),transparent 68%)}
.ringwrap.dim{opacity:.72}
.prog{display:block;height:5px;background:#232429;border-radius:99px;overflow:hidden;margin-top:6px}
.prog i{display:block;height:100%;background:linear-gradient(90deg,#2b5cff,#7db1ff);border-radius:99px;transition:width .5s linear}
.stagegrid{display:block}
.ringsrow{display:flex;flex-direction:column}
.ringcol{min-width:0}
.homegrid{display:block}
.ctabar{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.ctabar .cta-txt{flex:1;min-width:210px}
.ctabar .cta-txt b{display:block;font-size:15.5px;color:#fff}
.ctabar .cta-txt span{color:var(--dim);font-size:13px}
.ctabar .cta-btn{min-height:40px;padding:9px 18px;font-size:13.5px;white-space:nowrap;margin-left:auto}
@media (min-width:700px){
  .app{max-width:720px;padding:0 22px 40px}
  .songcover{max-width:520px;margin-left:auto;margin-right:auto}
  .homegrid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px;align-items:start}
}
@media (min-width:1024px){
  .app{max-width:1120px;padding:0 28px 48px}
  .stagegrid{display:grid;grid-template-columns:5fr 7fr;gap:18px;align-items:start}
  .stagegrid>.panel{margin-top:0}
  .ringsrow{flex-direction:row;gap:10px}
  .ringcol{flex:1}
  h1{font-size:29px}
  h2{font-size:22px}
}
@media (min-width:1400px){
  .app{max-width:1400px}
  .herovid{max-width:920px;margin-left:auto;margin-right:auto}
  #npCover{max-width:480px;margin-left:auto;margin-right:auto}
}
@media (min-width:1750px){
  .app{max-width:1560px}
}
.statstrip{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}
.stat{background:linear-gradient(180deg,#1a1b20,#0c0c0f);border:1px solid #2c2e35;border-radius:12px;padding:9px 4px;text-align:center;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.stat b{display:block;font-size:16px;color:#fff}
.stat span{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#9aa3b2}
.upnext{position:absolute;top:44%;right:2px;z-index:5;display:flex;align-items:center;gap:7px;
  padding:6px 9px;border-radius:999px;font-size:10.5px;font-weight:900;letter-spacing:1px;color:#eaf2ff;
  background:linear-gradient(180deg,rgba(38,84,205,.92),rgba(16,38,96,.92));border:1px solid #7db1ff;
  box-shadow:0 0 18px rgba(43,92,255,.5);animation:nextnudge 1s ease-in-out infinite}
.upnext[hidden]{display:none}
.upnext img{width:26px;height:26px;border-radius:7px;object-fit:cover;border:1px solid rgba(255,255,255,.5)}
.picktag{display:inline-block;margin-left:7px;padding:2px 8px;border-radius:999px;font-size:9.5px;font-weight:900;
  letter-spacing:1px;vertical-align:2px;color:#231a04;white-space:nowrap;
  background:linear-gradient(180deg,#ffe9a8,#e8b93c 55%,#b8860b);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 0 10px rgba(232,185,60,.35)}
.pickchip{border-color:#caa64b;color:#ffd97a}
.rowlink{transition:padding .35s ease,background .35s ease,box-shadow .35s ease}
.rowlink .thumb{transition:width .35s ease,height .35s ease}
.rowlink.expanded{background:linear-gradient(180deg,rgba(43,92,255,.14),rgba(43,92,255,.03));border-radius:14px;
  box-shadow:inset 0 0 0 1px rgba(125,177,255,.45),0 0 22px rgba(43,92,255,.22);padding-top:14px;padding-bottom:14px}
.rowlink.expanded .thumb{width:96px;height:96px;border-radius:12px}
.rowlink.expanded .t{font-size:18px}
.rowlink.expanded .rank{font-size:26px}
.openhint{display:none}
.herovid{position:relative;margin:14px 0 6px;border:1px solid #454a56;border-radius:18px;overflow:hidden;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 14px 30px rgba(0,0,0,.55);background:#000}
.herovid video{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}
@media (min-width:1400px){.herovid{margin-left:auto;margin-right:auto}}
.rowlink.expanded .openhint{display:block;font-size:11px;color:#9db9ff;margin-top:5px;letter-spacing:.4px}
.upnext .arr{font-size:14px}
@keyframes nextnudge{0%,100%{transform:translateX(0)}50%{transform:translateX(5px)}}
.ringwrap{touch-action:pan-y;cursor:grab}
.ring.drag{transition:none}
.ring.live{transition:none}
.ringwrap img{-webkit-user-drag:none;user-drag:none}
.cell{-webkit-user-select:none;user-select:none}
nav.main a,.tabs a,.tabs button{position:relative}
@keyframes sheen{0%,55%{left:-70%}85%,100%{left:130%}}
.row{display:flex;gap:11px;align-items:center;padding:10px 4px;border-bottom:1px solid #232429;text-decoration:none;color:var(--ink)}
.row:last-child{border-bottom:none}
.row .rank{font-size:20px;font-weight:800;width:32px;text-align:center;flex:0 0 auto}
.row .thumb{width:46px;height:46px;border-radius:10px;border:1px solid #4a4e58;object-fit:cover;flex:0 0 auto;box-shadow:0 4px 10px rgba(0,0,0,.45)}
.row .meta{flex:1;min-width:0}
.row .t{display:block;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .a{display:block;color:var(--dim);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .t + br,.row .a + br{display:none}
.row .artistlink{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .nums{text-align:right;font-size:12.5px;color:var(--dim);flex:0 0 auto}
.row .nums b{color:var(--ink);font-size:15px}
.row.playing{background:linear-gradient(90deg,rgba(43,92,255,.14),transparent);border-radius:10px}
.move{width:52px;text-align:right;font-size:12.5px;flex:0 0 auto;font-weight:700}
.move .up{color:var(--up)}
.move .down{color:var(--down)}
.move .flat{color:var(--flat)}
.move .new{color:var(--newgreen)}
.rankwrap{display:flex;flex-direction:column;align-items:center;gap:3px;width:38px;flex:0 0 auto}
.rankwrap .move{width:auto;text-align:center;font-size:12px}
.rankpill{font-size:8.5px;font-weight:900;letter-spacing:.6px;padding:1.5px 5px;border-radius:5px;line-height:1.25;white-space:nowrap}
.rankpill.new{background:var(--newgreen);color:#03140a}
.rankpill.reentry{background:#454b57;color:#e6e9ef;border:1px solid #6a707c}
.rankbadge{flex:0 0 auto;min-width:46px;text-align:center;font-weight:900;font-size:14.5px;padding:5px 7px;border-radius:9px;
  background:var(--chrome);color:#0b0b0d;box-shadow:inset 0 1px 0 #fff,0 3px 8px rgba(0,0,0,.45)}
.gainchip{flex:0 0 auto;font-weight:800;font-size:13px;color:#03140a;background:var(--up);
  border-radius:999px;padding:5px 11px;box-shadow:0 0 12px rgba(46,224,111,.28)}
.crownbadge{display:inline-block;vertical-align:2px;margin-left:7px;font-size:10.5px;font-weight:900;letter-spacing:1px;
  padding:3.5px 8px;border-radius:999px;color:#241100;white-space:nowrap;
  background:linear-gradient(180deg,#ffe27a,#ffb300 55%,#e07b00);
  box-shadow:inset 0 1px 0 #fff6cf,0 0 12px rgba(255,179,0,.35)}
.votebtn{flex:0 0 auto;cursor:pointer;border:1px solid #0f2c7d;border-radius:999px;padding:11px 18px;
  min-height:46px;font-family:inherit;font-size:14px;font-weight:800;color:#fff;
  background:linear-gradient(180deg,#7198ff,#2b5cff 48%,#1740b4);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 4px 10px rgba(0,0,0,.5)}
.votebtn:active{transform:translateY(1px)}
.stats{display:block;margin-top:3px;font-size:10.5px;letter-spacing:1.2px;line-height:1.6;text-transform:uppercase;color:var(--dim);white-space:normal}
.stats b{color:#eceef1;font-weight:800}
.chartdate{text-align:center;font-size:12.5px;font-weight:800;letter-spacing:2.5px;color:#dfe3ea;margin:12px 0 2px;text-transform:uppercase}
.hero{display:flex;flex-wrap:wrap;gap:13px;align-items:center;padding:14px 12px;margin-bottom:6px;border-radius:16px;text-decoration:none;color:var(--ink);
  border:1px solid transparent;
  background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,0) 46%) padding-box,linear-gradient(180deg,#191a1f,#0c0c0e) padding-box,linear-gradient(180deg,#f2f4f8,#9aa1ae 50%,#e8ebf0) border-box;
  box-shadow:0 0 22px rgba(210,218,232,.13),0 10px 22px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.18)}
.hero .rank{font-size:36px;font-weight:900;line-height:1;
  background:linear-gradient(180deg,#ffffff,#c9cedb 55%,#f4f6fa);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero .cover-lg{width:96px;height:96px;border-radius:12px;border:1px solid #565b66;object-fit:cover;flex:0 0 auto}
.hero .meta{flex:1;min-width:0}
.hero .t{display:block;font-size:19px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hero .t + br{display:none}
.hero .artistlink{display:block;color:var(--dim);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hero .a{color:var(--dim);font-size:13.5px}
.hero .herobar{flex:1 1 100%;display:flex;justify-content:space-between;align-items:baseline;gap:12px;border-top:1px solid #232429;padding-top:9px}
.hero .herobar .stats{margin-top:0}
.hero .herobar .nums{flex:0 0 auto;text-align:right;font-size:12.5px;color:var(--dim)}
.hero .herobar .nums b{color:var(--ink);font-size:15px}
.hero .nums{text-align:right;font-size:12.5px;color:var(--dim);flex:0 0 auto}
.hero .nums b{color:var(--ink);font-size:15px}
.ne{border:1px solid transparent;border-radius:16px;padding:13px 14px;margin:14px 0;
  background:linear-gradient(180deg,#150d08,#0b0906) padding-box,linear-gradient(90deg,#7a2400,#ff5a00,#ffb300,#ff5a00,#7a2400) border-box;
  box-shadow:0 0 20px rgba(255,90,0,.16)}
.ne-banner{text-align:center;font-size:15px;font-weight:900;letter-spacing:3px;margin-bottom:6px;
  background:linear-gradient(90deg,#ff7a18,#ffd23e,#ff7a18);-webkit-background-clip:text;background-clip:text;color:transparent}
.ne .row{border-bottom-color:#2b1c10}
.ne-tag{display:inline-block;font-size:11px;font-weight:900;letter-spacing:1.2px;color:#ffb300;text-transform:uppercase}
.ne-more,.viewmore{display:block;width:100%;margin-top:10px;cursor:pointer;background:none;border:none;color:var(--ink);
  font-family:inherit;font-size:14.5px;font-weight:700;padding:9px 0 3px;text-align:center}
.ne-more{color:#ffb300}
.bar-row{display:grid;grid-template-columns:1fr auto;gap:3px 10px;margin-top:12px}
.bar-row .lbl{font-weight:600;font-size:14.5px}
.bar-row .val{font-weight:800}
.bar{grid-column:1/-1;height:9px;background:#232429;border-radius:99px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--chrome);border-radius:99px}
.note{color:var(--dim);font-size:13.5px;line-height:1.5;margin:5px 0 2px}
.craftbig{font-size:44px;font-weight:900;line-height:1}
.rankline{display:flex;justify-content:space-between;gap:10px;padding:10px 2px;border-bottom:1px solid #232429;font-size:14.5px}
.rankline:last-child{border-bottom:none}
.rankline .where{color:var(--dim)}
.rankline .dist{color:var(--dim);font-size:13px;text-align:right}
label{display:block;font-size:12px;color:var(--dim);letter-spacing:.6px;text-transform:uppercase;margin-top:12px}
input,select,textarea{width:100%;background:#101012;border:1px solid #3a3d44;color:var(--ink);border-radius:12px;
  padding:13px 14px;font-size:16px;margin-top:6px;font-family:inherit}
input[type=file]{padding:11px 14px;font-size:14px}
.playerbar{position:sticky;bottom:10px;z-index:6;margin-top:14px}
.playerbar .panel{display:flex;gap:12px;align-items:center;padding:10px 12px;margin:0}
.playerbar img{width:52px;height:52px;border-radius:10px;border:1px solid #43464e;object-fit:cover}
.playerbar .meta{flex:1;min-width:0}
.playerbar .t{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.playerbar .a{color:var(--dim);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.playbtn{flex:0 0 auto;width:68px;height:50px;border-radius:13px;cursor:pointer;border:1px solid #84888f;
  background:var(--chrome);box-shadow:inset 0 1px 0 #fff,0 6px 14px rgba(0,0,0,.55);
  color:var(--accent);font-size:24px;line-height:1;display:flex;align-items:center;justify-content:center;font-family:inherit}
.playbtn:active{transform:translateY(1px)}
.btn{box-shadow:inset 0 1px 0 rgba(255,255,255,.5),inset 0 -10px 16px rgba(0,0,0,.16),0 6px 16px rgba(0,0,0,.45)}
.err{border-color:#e8e8ec}
.rowlink{position:relative}
.rowlink .stretch{position:absolute;inset:0;z-index:1;border-radius:inherit}
.artistlink{position:relative;z-index:2;color:var(--dim);font-size:13px;text-decoration:none}
.artistlink:hover,.artistlink:active{color:#fff;text-decoration:underline}
.avatar{width:120px;height:120px;border-radius:50%;border:2px solid #565b66;object-fit:cover;display:block}
.avatar-init{width:120px;height:120px;border-radius:50%;border:2px solid #565b66;display:flex;align-items:center;justify-content:center;
  font-size:42px;font-weight:900;letter-spacing:1px;color:#fff;flex:0 0 auto;
  background:linear-gradient(140deg,#3d3f47,#141416 60%);text-shadow:0 2px 8px rgba(0,0,0,.7)}
.avatar-sm{width:46px;height:46px;font-size:17px;border-width:1px}
.btn-danger{background:linear-gradient(180deg,#3a3d44,#22242a);color:#ffb3b3;border-color:#6e3a3a;box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 5px 12px rgba(0,0,0,.5)}
.rules{list-style:none;margin:8px 0;padding:0}
.rules li{padding:9px 2px;border-bottom:1px solid #232429;font-size:14.5px;line-height:1.5}
.rules li:last-child{border-bottom:none}
.rules b{color:#fff}
footer.site{color:#5c6069;font-size:12px;text-align:center;padding:26px 8px 6px;line-height:1.6}
.installbar{position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:60;width:calc(100% - 20px);max-width:410px;
  display:none;align-items:center;gap:11px;padding:11px 13px;border-radius:16px;color:var(--ink);
  background:linear-gradient(180deg,#1b1b1f,#0d0d0f);border:1px solid #4a4e57;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 12px 30px rgba(0,0,0,.65)}
.installbar.show{display:flex}
.installbar img{width:44px;height:44px;border-radius:10px;flex:0 0 auto;border:1px solid #43464e}
.installbar .ib-meta{flex:1;min-width:0}
.installbar .ib-t{font-weight:800;font-size:14.5px;line-height:1.25}
.installbar .ib-s{color:var(--dim);font-size:12.5px;line-height:1.35;margin-top:1px}
.installbar .ib-go{flex:0 0 auto;cursor:pointer;border:1px solid #0f2c7d;border-radius:999px;padding:10px 15px;
  font-family:inherit;font-size:13.5px;font-weight:800;color:#fff;min-height:42px;
  background:linear-gradient(180deg,#7198ff,#2b5cff 48%,#1740b4)}
.installbar .ib-x{flex:0 0 auto;cursor:pointer;background:none;border:none;color:var(--dim);font-size:19px;line-height:1;padding:6px;font-family:inherit}
audio{width:100%;margin-top:10px}
.flexbtns{display:flex;gap:10px;margin-top:12px}
.flexbtns form{flex:1}
.flexbtns .btn{width:100%}
`;

const DEFAULT_OG_DESC = "TOP 20 — the first-of-its-kind chart algorithm for independent artists. Every uploaded song is judged by the 15-point scale evaluation and ranked daily. Only songs uploaded to TOP 20 are ever judged.";

function layout(title, active, body, opts = {}) {
  const nav = [
    ["/", "stage", "The Stage"],
    ["/charts", "charts", "Charts"],
    ["/upload", "upload", "Upload"],
    ["/profile", "profile", "Profile"],
    ["/dashboard", "dashboard", "Dashboard"],
    ["/djs", "djs", "DJs"],
    ["/viewcast", "viewcast", "Viewcast"],
    ["/how-it-works", "how", "How It Works"],
    ["/admin/outbox", "outbox", "Outbox"],
  ].map(([href, key, label]) =>
    `<a href="${href}" class="${active === key ? "active" : ""}">${label}</a>`).join("");
  // Open Graph + Twitter cards: pages are fully server-rendered, so links
  // shared to Facebook / TikTok / anywhere open and read complete with no
  // login and no JavaScript needed.
  const meta = opts.meta || {};
  const ogTitle = meta.title || `${title} — TOP 20`;
  const ogDesc = meta.description || DEFAULT_OG_DESC;
  const ogType = meta.type || "website";
  const ogTags = `
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:site_name" content="TOP 20">${meta.image ? `
<meta property="og:image" content="${esc(meta.image)}">${meta.image.includes("/card/") ? `
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="1200">
<meta property="og:image:type" content="image/jpeg">` : ""}${meta.imageW ? `
<meta property="og:image:width" content="${meta.imageW}">
<meta property="og:image:height" content="${meta.imageH}">` : ""}` : ""}${meta.video ? `
<meta property="og:video" content="${esc(meta.video)}">
<meta property="og:video:secure_url" content="${esc(meta.video)}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="${meta.videoW || 960}">
<meta property="og:video:height" content="${meta.videoH || 540}">` : ""}
<meta name="twitter:card" content="${meta.image ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDesc)}">${meta.image ? `
<meta name="twitter:image" content="${esc(meta.image)}">` : ""}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#000000">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192x192.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Top 20">
<title>${esc(title)} — TOP 20</title>${ogTags}<style>${CSS}</style></head>
<body><div class="app">
<button type="button" class="appchip" id="appChip" aria-label="Download the Top 20 app"><img src="/icons/icon-192x192.png" alt=""><span class="blinkwrap"><span class="appchip-t">DOWNLOAD APP TODAY</span><span class="appchip-free">· FREE ·</span><span class="appchip-s">for your home screen</span></span></button>
<header class="site">
  <img class="crowd cc" src="/crowd-center.webp?v=7" alt="" aria-hidden="true">
  <img class="crowd cl" src="/crowd-left.webp?v=7" alt="" aria-hidden="true">
  <img class="crowd cr" src="/crowd-right.webp?v=7" alt="" aria-hidden="true">
  <div class="wm">
    <div class="wordmark"><span class="top">TOP</span> <span class="twenty">20</span></div>
    <div class="blaze"></div><div class="blaze-line"></div>
  </div>
  ${opts.home ? `<div class="hotline"><span class="tick">— HOT 20 — TRENDING NOW — CHARTS BY CRAFT, NOT JUST CLOUT — GREAT SONGS HOLD THEIR SPOT — NEW ENTRIES HIT AT MIDNIGHT — DJ'S HOT PICKS — EVERY FRIDAY — </span><span class="tick">— HOT 20 — TRENDING NOW — CHARTS BY CRAFT, NOT JUST CLOUT — GREAT SONGS HOLD THEIR SPOT — NEW ENTRIES HIT AT MIDNIGHT — DJ'S HOT PICKS — EVERY FRIDAY — </span></div>` : ""}
  <div class="tagline">Charts by craft, not just clout</div>
  <nav class="main">${nav}</nav>
</header>
${body}
<footer class="site">TOP 20 — the Stage plays only the Top 20, 24/7.<br>
Fall off the chart and the rotation moves on. Check your rank on the Dashboard.<br>
<a href="/how-it-works" style="color:var(--accent);font-weight:700;text-decoration:none">How it works →</a> · <a href="/advertise" style="color:var(--accent);font-weight:700;text-decoration:none">Advertise →</a> · <a href="/terms" style="color:var(--accent);font-weight:700;text-decoration:none">Terms →</a><br>
<a href="/admin/login" style="color:#8a8f99;font-size:11.5px;text-decoration:none">Staff Login</a> · <a href="/dj/login" style="color:#8a8f99;font-size:11.5px;text-decoration:none">DJ Login</a></footer>
</div>
<div class="installbar" id="installBar" role="dialog" aria-label="Install Top 20">
  <img src="/icons/icon-192x192.png" alt="">
  <div class="ib-meta"><div class="ib-t">Add Top 20 to your home screen</div>
  <div class="ib-s" id="installHint">Your chart, your Stage — one tap away, no app store.</div></div>
  <button type="button" class="ib-go" id="installGo">Install</button>
  <button type="button" class="ib-x" id="installX" aria-label="Dismiss">✕</button>
</div>
<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
(function () {
  var DISMISS_KEY = 'top20.installDismissed';
  var SHOWN_KEY = 'top20.installShown';
  var chip = document.getElementById('appChip');
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) { if (chip) chip.style.display = 'none'; return; }
  var bar = document.getElementById('installBar');
  if (!bar) return;
  var barDismissed = false;
  try { barDismissed = !!localStorage.getItem(DISMISS_KEY); } catch (e) {}
  var deferred = null;
  var isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  function showBar(force) {
    try {
      if (!force) {
        if (sessionStorage.getItem(SHOWN_KEY)) return;
        sessionStorage.setItem(SHOWN_KEY, '1');
      }
    } catch (e) {}
    if (isIOS && !deferred) {
      document.getElementById('installHint').textContent = 'Tap Share, then \u201CAdd to Home Screen\u201D — Top 20 lives on your phone like an app.';
      document.getElementById('installGo').style.display = 'none';
    }
    if (!isIOS && !deferred) {
      document.getElementById('installHint').textContent = 'Open your browser menu and choose Install app or Add to Home screen — Top 20 lives on your phone like an app.';
      document.getElementById('installGo').style.display = 'none';
    }
    bar.classList.add('show');
  }
  function schedule() { setTimeout(function () { if (!barDismissed && (deferred || isIOS)) showBar(); }, 3500); }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    schedule();
  });
  if (isIOS) schedule();
  document.getElementById('installX').addEventListener('click', function () {
    bar.classList.remove('show');
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {}
  });
  document.getElementById('installGo').addEventListener('click', function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function () {
      deferred = null;
      bar.classList.remove('show');
    }).catch(function () {});
  });
  window.addEventListener('appinstalled', function () { bar.classList.remove('show'); if (chip) chip.style.display = 'none'; });
  if (chip) chip.addEventListener('click', function () {
    if (deferred) {
      deferred.prompt();
      deferred.userChoice.then(function (c) {
        if (c && c.outcome === 'accepted') chip.style.display = 'none';
        deferred = null;
      }).catch(function () {});
    } else {
      showBar(true);
    }
  });
})();
</script>
<script>
window.__BUILD = "${BUILD}";
// One audible player across ALL open copies of the site (owner hit
// "stacked" sound with the site open in several tabs — each tab's Stage
// or video kept playing over the others). Any tab that starts audible
// playback claims the sound via localStorage; every other tab hears the
// claim (storage event) and goes quiet: Stage stopped, hero muted, any
// other player paused. Muted autoplay (the hero loop) never claims.
(function () {
  var KEY = "t20-audio-claim";
  var TAB = Math.random().toString(36).slice(2) + Date.now().toString(36);
  function claim() { try { localStorage.setItem(KEY, JSON.stringify({ tab: TAB, at: Date.now() })); } catch (e) {} }
  function audible(el) { return el && (el.tagName === "AUDIO" || el.tagName === "VIDEO") && !el.muted && el.volume !== 0; }
  document.addEventListener("play", function (e) { if (audible(e.target)) claim(); }, true);
  document.addEventListener("volumechange", function (e) { var el = e.target; if (audible(el) && !el.paused) claim(); }, true);
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY || !e.newValue) return;
    var c = null; try { c = JSON.parse(e.newValue); } catch (err) {}
    if (!c || c.tab === TAB) return;
    if (window.__stopStage) window.__stopStage();
    if (window.__muteHero) window.__muteHero();
    document.querySelectorAll("audio,video").forEach(function (el) { if (el.id !== "heroVid") { try { el.pause(); } catch (err) {} } });
  });
  // Self-heal a stale open page: if the site was rebuilt while this
  // page sat open (an hours-old page kept stacking sound because the
  // fixes had not been written when it loaded), reload ONCE when the
  // page comes back into view on the newer build.
  function checkBuild() {
    var mine = window.__BUILD || "";
    if (!mine || mine === "dev") return;
    fetch("/version", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.build || j.build === mine) return;
      var key = "t20-healed-" + j.build;
      try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch (e) {}
      location.reload();
    }).catch(function () {});
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) checkBuild(); });
  checkBuild();
  // When the site is left — tab switched, app switched, page closed —
  // EVERYTHING stops (owner: a leftover media player kept playing
  // outside the website). Nothing on this site is meant to play in the
  // background.
  function stopEverything() {
    if (window.__stopStage) window.__stopStage();
    if (window.__muteHero) window.__muteHero();
    document.querySelectorAll("audio,video").forEach(function (el) { try { el.pause(); } catch (err) {} });
    // Kill any floating picture-in-picture window too — that little
    // corner player WAS the doubled soundtrack: the video popped out
    // of the page and kept playing over the page's own copy.
    try { if (document.pictureInPictureElement && document.exitPictureInPicture) document.exitPictureInPicture().catch(function () {}); } catch (err) {}
  }
  document.addEventListener("visibilitychange", function () { if (document.hidden) stopEverything(); });
  window.addEventListener("pagehide", stopEverything);
})();
</script>
</body></html>`;
}

function absUrl(req, webPath) {
  if (!webPath) return "";
  return `${req.protocol}://${req.get("host")}${webPath}`;
}

// Artist photo, or a styled initial avatar when they have no photo on file.
function avatarHtml(user, { small = false } = {}) {
  if (user.photo_path) {
    return `<img class="${small ? "thumb" : "avatar"}" src="${esc(user.photo_path)}" alt="${esc(user.name)}">`;
  }
  const words = String(user.name || "?").replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] || "A") + (words[1]?.[0] || "")).toUpperCase();
  return `<span class="avatar-init${small ? " avatar-sm" : ""}" aria-hidden="true">${esc(initials)}</span>`;
}

// A profile counts as set up when the artist name + home city are on file.
function hasProfile(user) {
  return !!(user && String(user.name || "").trim() && String(user.city || "").trim());
}

const PROFILE_FIELDS = [
  ["name", "Artist name"], ["city", "Home city"], ["state", "Home state"],
  ["genre", "Genre"], ["photo_path", "Photo"], ["bio", "Bio"],
  ["history", "History"], ["years_in_game", "Years in the game"], ["age", "Age"],
  ["facebook", "Facebook"], ["instagram", "Instagram"], ["tiktok", "TikTok"], ["youtube", "YouTube"],
];

// Social links: artists may paste a full link or just their handle.
function socialUrl(platform, v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  const dom = { facebook: "facebook.com", instagram: "instagram.com", tiktok: "tiktok.com", youtube: "youtube.com" }[platform];
  const di = dom ? s.toLowerCase().indexOf(dom + "/") : -1;
  const h = (di >= 0 ? s.slice(di + dom.length + 1) : s).replace(/^@/, "").replace(/\/+$/, "");
  if (platform === "facebook") return "https://facebook.com/" + h;
  if (platform === "instagram") return "https://instagram.com/" + h;
  if (platform === "tiktok") return "https://tiktok.com/@" + h;
  if (platform === "youtube") return "https://youtube.com/@" + h;
  return s;
}
// The judging search finds the artist by their socials — Facebook,
// Instagram and TikTok are required on the profile (owner, Oct 31 2026).
function missingSocials(user) {
  if (!user) return ["Facebook", "Instagram", "TikTok"];
  return [["facebook", "Facebook"], ["instagram", "Instagram"], ["tiktok", "TikTok"]]
    .filter(([k]) => !String(user[k] || "").trim()).map(([, label]) => label);
}
function profileCompleteness(user) {
  const filled = PROFILE_FIELDS.filter(([key]) => {
    const v = user[key];
    return v !== null && v !== undefined && String(v).trim() !== "";
  }).length;
  return { filled, total: PROFILE_FIELDS.length };
}

function scoreBars(judge, { withNotes = true } = {}) {
  const notes = JSON.parse(judge.notes || "{}");
  return CATEGORIES.map((c) => {
    const v = judge[c.key];
    return `<div class="bar-row"><span class="lbl">${c.label}</span><span class="val">${v}/10</span>
      <span class="bar"><i style="width:${v * 10}%"></i></span></div>
      ${withNotes ? `<p class="note">${esc(notes[c.key] || "")}</p>` : ""}`;
  }).join("");
}

function songRanks(songId) {
  const date = latestChartDate(db);
  if (!date) return { date, ranks: [] };
  const rows = db.prepare(
    "SELECT * FROM chart_entries WHERE song_id = ? AND chart_date = ?"
  ).all(songId, date);
  const levelOrder = { national: 0, regional: 1, local: 2 };
  rows.sort((a, b) =>
    (a.genre === OVERALL) - (b.genre === OVERALL) ||
    levelOrder[a.level] - levelOrder[b.level]);
  const rank20 = db.prepare(
    `SELECT chart_score FROM chart_entries
     WHERE chart_date = ? AND level = ? AND genre = ? AND region_key = ? AND rank = 20`
  );
  for (const r of rows) {
    r.distance = null;
    if (r.rank > 20) {
      const cut = rank20.get(r.chart_date, r.level, r.genre, r.region_key);
      if (cut) r.distance = Math.round((cut.chart_score - r.chart_score) * 10) / 10;
    }
  }
  return { date, ranks: rows };
}

function rankLines(ranks) {
  if (!ranks.length) return `<p class="sub">Not ranked yet — charts recalculate daily.</p>`;
  return ranks.map((r) => `
    <div class="rankline">
      <span>${cap(r.level)} ${esc(r.genre)} <span class="where">· ${esc(r.region_key === "ALL" ? "National" : r.region_key)}</span></span>
      <span><b>#${r.rank}</b>${r.distance != null ? `<div class="dist">${r.distance} pts from the Top 20</div>` : ""}</span>
    </div>`).join("");
}

/* ------------------------- Billboard-style chart data ------------------------ */

function fmtChartDate(date) {
  if (!date) return "";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  }).toUpperCase();
}

// Per-chart history for one chart (level/genre/region), computed from
// chart_entries: LW, PEAK, WEEKS on chart (Top 20), weeks at #1, and
// new / re-entry detection for today's Top 20.
function chartContext(date, level, genre, regionKey) {
  const ctx = { prevDate: null, stats: new Map(), prevTop20: new Set(), todayTop20: new Set() };
  if (!date) return ctx;
  ctx.prevDate = previousChartDate(db, date);
  const hist = db.prepare(
    "SELECT song_id, chart_date, rank FROM chart_entries WHERE level = ? AND genre = ? AND region_key = ?"
  ).all(level, genre, regionKey);
  const bySong = new Map();
  for (const h of hist) {
    if (!bySong.has(h.song_id)) bySong.set(h.song_id, []);
    bySong.get(h.song_id).push(h);
  }
  for (const [songId, rows] of bySong) {
    const st = { lw: null, peak: null, weeks: 0, weeksAt1: 0, inPrevTop20: false, top20BeforePrev: false, todayRank: null };
    const weekDates = new Set(), at1Dates = new Set();
    for (const r of rows) {
      if (st.peak == null || r.rank < st.peak) st.peak = r.rank;
      if (r.rank <= 20) {
        const wk = Math.floor(new Date(r.chart_date + "T00:00:00Z").getTime() / 604800000);
        weekDates.add(wk);
        if (r.rank === 1) at1Dates.add(wk);
        if (r.chart_date === ctx.prevDate) st.inPrevTop20 = true;
        else if (r.chart_date < date) st.top20BeforePrev = true;
      }
      if (r.chart_date === ctx.prevDate) st.lw = r.rank <= 20 ? r.rank : null;
      if (r.chart_date === date) st.todayRank = r.rank;
    }
    st.weeks = weekDates.size;
    st.weeksAt1 = at1Dates.size;
    ctx.stats.set(songId, st);
    if (st.inPrevTop20) ctx.prevTop20.add(songId);
    if (st.todayRank != null && st.todayRank <= 20) ctx.todayTop20.add(songId);
  }
  return ctx;
}

// Days charted: distinct chart days the song has held a spot on THE chart —
// the National Overall Top 20 (the one the Stage plays). A song whose first
// day on it is the latest chart day is a NEW ENTRY, Day 1.
function daysCharted(songId) {
  const r = db.prepare(
    "SELECT COUNT(DISTINCT chart_date) AS days, MIN(chart_date) AS first_date FROM chart_entries WHERE song_id = ? AND rank <= 20 AND level = 'national' AND genre = 'Overall' AND region_key = 'ALL'"
  ).get(songId);
  return { days: r && r.days ? r.days : 0, first: r ? r.first_date : null };
}

function moveHtml(prevRank, rank) {
  if (prevRank == null) return `<span class="new">• New</span>`;
  if (prevRank > rank) return `<span class="up">+${prevRank - rank} ▲</span>`;
  if (prevRank < rank) return `<span class="down">−${rank - prevRank} ▼</span>`;
  return `<span class="flat">—</span>`;
}

function statsLine(st) {
  if (!st || st.peak == null) return "";
  const parts = [
    `LW <b>${st.lw == null ? "–" : st.lw}</b>`,
    `PEAK <b>${st.peak}</b>`,
    `WEEKS <b>${st.weeks}</b>`,
  ];
  if (st.weeksAt1 > 0) parts.push(`WEEKS AT NO. 1 <b>${st.weeksAt1}</b>`);
  return `<span class="stats">${parts.join(" · ")}</span>`;
}

function rankPill(st, rank) {
  if (!st || rank > 20 || st.inPrevTop20) return "";
  return st.top20BeforePrev
    ? `<span class="rankpill reentry">RE-ENTRY</span>`
    : `<span class="rankpill new">NEW</span>`;
}

// Today's Top 20 songs in a chart that were NOT in that chart's Top 20 on
// the previous chart date — the "new entries" (includes re-entries).
function newEntryRows(date, level, genre, regionKey, ctx) {
  if (!date) return [];
  return db.prepare(`
    SELECT ce.rank, ce.song_id, s.title, s.cover_path, u.id AS artist_id, u.name AS artist
    FROM chart_entries ce
    JOIN songs s ON s.id = ce.song_id
    JOIN users u ON u.id = s.artist_id
    WHERE ce.chart_date = ? AND ce.level = ? AND ce.genre = ? AND ce.region_key = ? AND ce.rank <= 20
    ORDER BY ce.rank
  `).all(date, level, genre, regionKey).filter((e) => !ctx.prevTop20.has(e.song_id));
}

function newEntriesSection(idPrefix, list) {
  if (!list.length) return "";
  const row = (e) => `
    <div class="row rowlink" data-song="${e.song_id}">
      <a class="stretch" href="/song/${e.song_id}" aria-label="${esc(e.title)}"></a>
      <img class="thumb" src="${esc(e.cover_path)}" alt="">
      <span class="meta"><span class="ne-tag">🔥 New Entry #${e.rank}</span><br>
      <span class="t">${esc(e.title)}</span><br><a class="artistlink" href="/artist/${e.artist_id}">${esc(e.artist)}</a></span>
      <span class="move"><span class="new">• New</span></span>
    </div>`;
  const first = list.slice(0, 3).map(row).join("");
  const rest = list.slice(3);
  return `<div class="ne">
    <div class="ne-banner">🔥 NEW ENTRIES 🔥</div>
    ${first}
    ${rest.length ? `<div id="${idPrefix}More" hidden>${rest.map(row).join("")}</div>
    <button type="button" class="ne-more" id="${idPrefix}Btn">Show ${rest.length} more ↓</button>
    <script>
    document.getElementById('${idPrefix}Btn').addEventListener('click', function () {
      var m = document.getElementById('${idPrefix}More');
      var open = m.hidden;
      m.hidden = !open;
      this.textContent = open ? 'Show less ↑' : 'Show ${rest.length} more ↓';
    });
    </script>` : ""}
  </div>`;
}

function emailSubject(n) {
  return `You charted: #${n.rank} on the ${cap(n.level)} ${n.genre} Top 20`;
}

// Billboard-style chart row: rank (+ NEW / RE-ENTRY pill under it), cover,
// title / artist / stats line to the side, movement marker at the right edge.
// opts.stats=false gives the lighter home-page variant (no LW/PEAK/WEEKS).
function billboardRow(e, ctx, prevMap, { stats = true } = {}) {
  const st = ctx.stats.get(e.song_id);
  return `
  <div class="row rowlink" data-song="${e.song_id}" data-rank="${e.rank}">
    <a class="stretch" href="/song/${e.song_id}" aria-label="${esc(e.title)}"></a>
    <span class="rankwrap"><span class="rank">${e.rank}</span>${rankPill(st, e.rank)}<span class="move">${moveHtml(prevMap.get(e.song_id), e.rank)}</span></span>
    <img class="thumb" src="${esc(e.cover_path)}" alt="">
    <span class="meta"><span class="t">${esc(e.title)}</span>${e.dj_pick ? `<span class="picktag">🎧 DJ Pick</span>` : ""}<br><a class="artistlink" href="/artist/${e.artist_id}">${esc(e.artist)}</a>${stats ? statsLine(st) : ""}<span class="openhint">▶ Playing — tap again to open the song page →</span></span>
    <span class="nums">Craft <b>${e.craft_score}</b><br>Chart <b>${e.chart_score}</b></span>
  </div>`;
}

// #1 gets the hero treatment (unlike Billboard): bigger cover, bigger rank,
// thin platinum-tinted border — with the full stats line.
function heroRow(e, ctx, prevMap) {
  const st = ctx.stats.get(e.song_id);
  return `
  <div class="hero rowlink" data-song="${e.song_id}" data-rank="${e.rank}">
    <a class="stretch" href="/song/${e.song_id}" aria-label="${esc(e.title)}"></a>
    <span class="rankwrap"><span class="rank">${e.rank}</span>${rankPill(st, e.rank)}</span>
    <img class="cover-lg" src="${esc(e.cover_path)}" alt="">
    <span class="meta"><span class="t">${esc(e.title)}</span>${e.dj_pick ? `<span class="picktag">🎧 DJ Pick</span>` : ""}<br><a class="artistlink" href="/artist/${e.artist_id}">${esc(e.artist)}</a></span>
    <span class="herobar">${statsLine(st)}<span class="nums">Craft <b>${e.craft_score}</b> · Chart <b>${e.chart_score}</b></span><span class="move">${moveHtml(prevMap.get(e.song_id), e.rank)}</span></span>
  </div>`;
}

function chartEntriesFor(date, level, genre, regionKey, limit = 100) {
  if (!date) return [];
  return db.prepare(`
    SELECT ce.*, s.title, s.cover_path, u.id AS artist_id, u.name AS artist, j.craft_score
    FROM chart_entries ce
    JOIN songs s ON s.id = ce.song_id
    JOIN users u ON u.id = s.artist_id
    JOIN judge_scores j ON j.song_id = s.id
    WHERE ce.chart_date = ? AND ce.level = ? AND ce.genre = ? AND ce.region_key = ?
    ORDER BY ce.rank LIMIT ${limit}
  `).all(date, level, genre, regionKey);
}

// DJ'S HOT PICKS reads: the latest Friday's picks, with each pick's
// current National Overall rank on the given chart date.
function latestPickDate() {
  const r = db.prepare("SELECT MAX(pick_date) AS d FROM dj_picks").get();
  return r ? r.d : null;
}
function djHotPicks(pickDate, chartDate) {
  if (!pickDate) return [];
  return db.prepare(`
    SELECT s.id, s.title, s.cover_path, u.id AS artist_id, u.name AS artist, ce.rank AS nowRank
    FROM dj_picks p
    JOIN songs s ON s.id = p.song_id
    JOIN users u ON u.id = s.artist_id
    LEFT JOIN chart_entries ce ON ce.song_id = s.id AND ce.chart_date = ?
      AND ce.level = 'national' AND ce.genre = 'Overall' AND ce.region_key = 'ALL'
    WHERE p.pick_date = ? ORDER BY p.id
  `).all(chartDate, pickDate);
}

function prevRankMap(ctx, level, genre, regionKey) {
  const map = new Map();
  if (ctx.prevDate) {
    for (const r of db.prepare(
      "SELECT song_id, rank FROM chart_entries WHERE chart_date = ? AND level = ? AND genre = ? AND region_key = ?"
    ).all(ctx.prevDate, level, genre, regionKey)) map.set(r.song_id, r.rank);
  }
  return map;
}

// TOP RISERS (owner feature): the 3 songs rising the fastest just OUTSIDE
// the Top 20 — today's ranks 21-50 in one chart, ordered by places gained
// vs the previous chart date. A song that wasn't in yesterday's Top 50
// (lower, or not charted at all) counts as coming from #51.
function topRisers(date, level, genre, regionKey) {
  if (!date) return [];
  const prevDate = previousChartDate(db, date);
  if (!prevDate) return [];
  const prev = new Map();
  for (const r of db.prepare(
    "SELECT song_id, rank FROM chart_entries WHERE chart_date = ? AND level = ? AND genre = ? AND region_key = ?"
  ).all(prevDate, level, genre, regionKey)) prev.set(r.song_id, r.rank);
  const today = db.prepare(`
    SELECT ce.rank, ce.song_id, s.title, s.cover_path, s.audio_path, u.id AS artist_id, u.name AS artist
    FROM chart_entries ce
    JOIN songs s ON s.id = ce.song_id
    JOIN users u ON u.id = s.artist_id
    WHERE ce.chart_date = ? AND ce.level = ? AND ce.genre = ? AND ce.region_key = ?
      AND ce.rank BETWEEN 21 AND 50
    ORDER BY ce.rank
  `).all(date, level, genre, regionKey);
  const out = [];
  for (const e of today) {
    const yRank = prev.has(e.song_id) ? prev.get(e.song_id) : null;
    const base = yRank != null && yRank <= 50 ? yRank : 51;
    const gain = base - e.rank;
    if (gain > 0) out.push({ ...e, prevRank: yRank, gain });
  }
  out.sort((a, b) => b.gain - a.gain || a.rank - b.rank);
  return out.slice(0, 3);
}

function risersHtml(list) {
  if (!list.length) return "";
  const rows = list.map((e) => `
    <div class="row rowlink" data-song="${e.song_id}" data-rank="${e.rank}" data-audio="${esc(e.audio_path)}" data-title="${esc(e.title)}" data-artist="${esc(e.artist)}" data-cover="${esc(e.cover_path)}">
      <a class="stretch" href="/song/${e.song_id}" aria-label="${esc(e.title)}"></a>
      <span class="rankbadge">#${e.rank}</span>
      <img class="thumb" src="${esc(e.cover_path)}" alt="">
      <span class="meta"><span class="t">${esc(e.title)}</span><br><a class="artistlink" href="/artist/${e.artist_id}">${esc(e.artist)}</a><span class="openhint">Playing now — tap again to open the song page →</span></span>
      <span class="gainchip">▲ ${e.gain}</span>
    </div>`).join("");
  return `<div class="panel riserspanel">
    <h2 style="margin-top:0">TOP RISERS</h2>
    <p class="sub" style="margin-top:-4px">Rising the fastest — not in the Top 20 yet. These are knocking on the door.</p>
    ${rows}
  </div>`;
}

/* --------------------------- Profile video -------------------------------- */
// ONE video per artist, attached to one of the artist's own live songs:
// the song's music video, or a video bio — the artist telling the story
// of that song. A new upload replaces the old one (file + row deleted).

const VIDEO_EXTS = [".mp4", ".webm", ".mov"];
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, VIDEO_UP),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || "").toLowerCase().replace(/[^.a-z0-9]/g, "") || ".mp4";
      cb(null, `video-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || "").toLowerCase();
    if (VIDEO_EXTS.includes(ext)) return cb(null, true);
    const err = new Error("bad-video-type");
    err.code = "BAD_VIDEO_TYPE";
    cb(err);
  },
});

// Runs multer for the video field and turns its errors into plain 400s.
function videoUploadMw(req, res, next) {
  videoUpload.single("video")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "BAD_VIDEO_TYPE") {
      return videoError(res, req.body?.from || "profile",
        "That file isn't a video we can use — upload an MP4, WebM, or MOV file.",
        String(req.body?.email || "").trim().toLowerCase());
    }
    if (err.code === "LIMIT_FILE_SIZE") {
      return videoError(res, req.body?.from || "profile",
        "That video is too large — profile videos are capped at 200 MB.",
        String(req.body?.email || "").trim().toLowerCase());
    }
    return videoError(res, req.body?.from || "profile",
      "The video upload didn't go through — try again.",
      String(req.body?.email || "").trim().toLowerCase());
  });
}

function videoBackHref(from, emailLc) {
  const q = emailLc ? `?email=${encodeURIComponent(emailLc)}` : "";
  return from === "dashboard" ? `/dashboard${q}` : `/profile${q}`;
}

function videoError(res, from, message, emailLc) {
  const back = videoBackHref(from, emailLc);
  return res.status(400).send(layout("Profile video", from === "dashboard" ? "dashboard" : "profile", `
  <div class="panel err"><h2 style="margin-top:0">Video upload stopped</h2>
  <p class="sub" style="color:#fff;font-size:16px">${esc(message)}</p>
  <p><a class="btn" href="${back}">Back</a></p></div>`));
}

function artistVideo(artistId) {
  return db.prepare(`
    SELECT v.*, s.title AS song_title FROM videos v
    JOIN songs s ON s.id = v.song_id
    WHERE v.artist_id = ? ORDER BY v.id DESC LIMIT 1
  `).get(artistId);
}

function videoKindLabel(v) {
  return v.kind === "music_video"
    ? `MUSIC VIDEO — &ldquo;${esc(v.song_title)}&rdquo;`
    : `VIDEO BIO — about &ldquo;${esc(v.song_title)}&rdquo;`;
}

// The embedded player block shown on the artist page and the song page.
function videoDisplayHtml(v) {
  return `<div class="panel">
    <div class="sub" style="letter-spacing:2px;text-transform:uppercase;font-size:11px">${videoKindLabel(v)}</div>
    <video controls preload="metadata" playsinline disablepictureinpicture src="${esc(v.video_path)}" style="width:100%;border-radius:12px;margin-top:10px;background:#000"></video>
  </div>`;
}

// The "Your profile video" management section (profile edit view +
// dashboard): current video + the upload/replace form.
function videoPanelHtml(user, from) {
  const v = artistVideo(user.id);
  const liveSongs = db.prepare(
    "SELECT id, title FROM songs WHERE artist_id = ? AND status = 'live' ORDER BY id"
  ).all(user.id);
  const back = videoBackHref(from, user.email);
  let inner = `<h2 style="margin-top:0">Your profile video</h2>
  <p class="sub">One video. Make it count — the music video for your song, or sit down and tell the story of it. Your video lives on your profile page and on that song's page.</p>`;
  if (v) {
    inner += `<div class="sub" style="letter-spacing:2px;text-transform:uppercase;font-size:11px">${videoKindLabel(v)}</div>
    <video controls preload="metadata" playsinline disablepictureinpicture src="${esc(v.video_path)}" style="width:100%;border-radius:12px;margin-top:8px;background:#000"></video>
    <p class="note">Uploading a new video below replaces this one.</p>`;
  }
  if (!liveSongs.length) {
    inner += `<p class="note" style="color:#ffb3b3">Upload a song first — your video has to belong to one of your songs.</p>`;
  } else {
    inner += `<form method="post" action="/profile/video" enctype="multipart/form-data">
      <input type="hidden" name="email" value="${esc(user.email)}">
      <input type="hidden" name="from" value="${from}">
      <label>Video file — MP4, WebM or MOV, up to 200 MB<input name="video" type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" required></label>
      <label>Which song is this video for?<select name="song_id" required>
        ${liveSongs.map((s) => `<option value="${s.id}" ${v && v.song_id === s.id ? "selected" : ""}>${esc(s.title)}</option>`).join("")}
      </select></label>
      <label>What kind of video is it?<select name="kind" required>
        <option value="music_video" ${v && v.kind === "music_video" ? "selected" : ""}>Music video for this song</option>
        <option value="video_bio" ${v && v.kind === "video_bio" ? "selected" : ""}>Video bio — the story of this song</option>
      </select></label>
      <button class="btn btn-blue btn-block" type="submit">${v ? "Replace my video" : "Add my video"}</button>
    </form>`;
  }
  return `<div class="panel">${inner}</div>`;
}

// Replace semantics: delete the artist's previous video row(s) AND the
// old file(s), then insert the new one. One video per artist, always.
app.post("/profile/video", videoUploadMw, (req, res) => {
  const from = req.body.from === "dashboard" ? "dashboard" : "profile";
  const emailLc = String(req.body.email || "").trim().toLowerCase();
  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  const fail = (msg) => { cleanup(); return videoError(res, from, msg, emailLc); };
  if (!req.file) return fail("Choose a video file to upload.");
  const user = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(emailLc);
  if (!hasProfile(user)) return fail("Set up your profile first — your video lives on your profile page.");
  const kind = ["music_video", "video_bio"].includes(req.body.kind) ? req.body.kind : null;
  if (!kind) return fail("Tell us what kind of video it is — the music video for the song, or a video bio about it.");
  const songId = Number(req.body.song_id);
  if (!Number.isFinite(songId) || !songId) {
    return fail("Pick which song this video belongs to — your video has to belong to one of your songs.");
  }
  const song = db.prepare("SELECT * FROM songs WHERE id = ? AND artist_id = ?").get(songId, user.id);
  if (!song) return fail("That song isn't one of yours — your video has to belong to one of your songs.");
  if (song.status !== "live") return fail("That song isn't live anymore — pick one of your live songs for the video.");

  const old = db.prepare("SELECT * FROM videos WHERE artist_id = ?").all(user.id);
  for (const o of old) {
    if (o.video_path.startsWith("/uploads/videos/")) {
      fs.unlink(path.join(PUBLIC_DIR, o.video_path), () => {});
    }
  }
  db.prepare("DELETE FROM videos WHERE artist_id = ?").run(user.id);
  db.prepare("INSERT INTO videos (artist_id, song_id, video_path, kind) VALUES (?, ?, ?, ?)")
    .run(user.id, song.id, `/uploads/videos/${req.file.filename}`, kind);
  res.redirect(videoBackHref(from, emailLc));
});

function emailBody(n, artistName, songTitle, dateStr) {
  return `Hi ${artistName} — your song "${songTitle}" entered the ${cap(n.level)} ${n.genre} Top 20 at #${n.rank} on ${dateStr}. ` +
    `Only the Top 20 plays on the Stage, so your song is now in rotation, 24/7, while it holds its spot. ` +
    `Come back to TOP 20 any time to watch your rank — and remember, any day a song can pop into the Top 20.`;
}

/* --------------------------------- Stage ---------------------------------- */

function stagePlaylist(genreKey, date) {
  if (!date) return [];
  return db.prepare(`
    SELECT s.id, s.title, s.audio_path, s.cover_path, u.name AS artist,
           ce.rank, ce.dj_pick, j.craft_score,
           (SELECT count FROM engagements WHERE song_id = s.id AND type = 'play') AS plays,
           (SELECT count FROM engagements WHERE song_id = s.id AND type = 'like') AS likes,
           (SELECT count FROM engagements WHERE song_id = s.id AND type = 'share') AS shares
    FROM chart_entries ce
    JOIN songs s ON s.id = ce.song_id
    JOIN users u ON u.id = s.artist_id
    JOIN judge_scores j ON j.song_id = s.id
    WHERE ce.chart_date = ? AND ce.level = 'national' AND ce.genre = ? AND ce.region_key = 'ALL' AND ce.rank <= 20
    ORDER BY ce.rank
  `).all(date, genreKey).map((r) => {
    const dc = daysCharted(r.id);
    return {
      id: r.id, title: r.title, artist: r.artist, cover: r.cover_path,
      audio: r.audio_path, rank: r.rank, craft: r.craft_score,
      plays: r.plays || 0, likes: r.likes || 0, shares: r.shares || 0,
      days: dc.days, fresh: dc.days > 0 && dc.first === date, pick: !!r.dj_pick,
    };
  });
}

app.get("/", (req, res) => {
  const date = latestChartDate(db);
  const channels = [
    { label: "Main Stage", list: stagePlaylist(OVERALL, date) },
    ...GENRES.map((g) => ({ label: g, list: stagePlaylist(g, date) })),
  ];
  const first = channels[0].list[0];

  // Home chart block: National Overall Top 20, Billboard-lite rows.
  const homeCtx = chartContext(date, "national", OVERALL, "ALL");
  const homePrev = prevRankMap(homeCtx, "national", OVERALL, "ALL");
  const homeEntries = chartEntriesFor(date, "national", OVERALL, "ALL", 20);
  const homeNewHtml = newEntriesSection("homeNe", newEntryRows(date, "national", OVERALL, "ALL", homeCtx));
  const homeRisersHtml = risersHtml(topRisers(date, "national", OVERALL, "ALL"));
  // CITY DJs strip: the DJ of the Month race gets a home-page seat, with
  // the current Dallas leader named (djBoard/djMonth are hoisted helpers
  // from the DJ section below).
  const homeDjLeader = djBoard(djMonth(), "Dallas", "TX")[0];
  const homeDjHtml = `
  <div class="panel">
    <h2 style="margin-top:0">CITY DJs</h2>
    <p class="sub">The DJs who spin independents get their flowers too — vote your city's DJ of the Month.</p>
    ${homeDjLeader ? `<p class="sub" style="margin-top:8px">Dallas is riding with <b style="color:#fff">${esc(homeDjLeader.dj_name)}</b> — ${homeDjLeader.votes} vote${homeDjLeader.votes === 1 ? "" : "s"}.</p>` : ""}
    <p style="margin:10px 0 2px"><a href="/djs" style="color:var(--accent);font-weight:700;text-decoration:none">See the city boards →</a></p>
  </div>`;
  // DJ'S HOT PICKS panel: this Friday's panel picks, front and center.
  const pickDate = latestPickDate();
  const djPickRows = djHotPicks(pickDate, date);
  const djPicksHtml = djPickRows.length ? `
  <div class="panel">
    <h2 style="margin-top:0">🎧 DJ's Hot Picks</h2>
    <p class="sub">Top 20 is strictly algorithmic — with <b style="color:#fff">one exception</b>. Every Friday, a panel of DJs picks 3 songs that are already hot, and those picks step straight into the Top 20. After Friday, the algorithm treats them like everybody else — their spot rides on their score, same as every song on the chart.</p>
    ${djPickRows.map((p) => `
    <a class="row" href="/song/${p.id}">
      <img class="thumb" src="${esc(p.cover_path)}" alt="">
      <span class="meta"><span class="t">${esc(p.title)}</span><br><span class="a">${esc(p.artist)}</span></span>
      <span class="nums">${p.nowRank ? `NOW <b>#${p.nowRank}</b>` : "<b>Top 20</b>"}</span>
    </a>`).join("")}
    <p class="note" style="margin-top:8px">This week's picks — ${fmtChartDate(pickDate)}. A new panel, new picks, every Friday.</p>
  </div>` : "";
  // SPOTLIGHT OF THE WEEK (owner feature): the 16th Law in action — the
  // owner names one artist worth recognizing. Recognition only: the
  // spotlight never touches a score or a rank. Set from the admin area
  // (admin_config 'spotlight'); hidden until the owner picks somebody.
  let spotlightHtml = "";
  try {
    const srow = db.prepare("SELECT value FROM admin_config WHERE key = 'spotlight'").get();
    const spot = srow && srow.value ? JSON.parse(srow.value) : null;
    if (spot && spot.song_id) {
      const s = db.prepare(`
        SELECT s.id, s.title, s.cover_path, s.genre, u.name AS artist FROM songs s
        JOIN users u ON u.id = s.artist_id WHERE s.id = ? AND s.status = 'live'`).get(spot.song_id);
      if (s) {
        const rk = db.prepare(`SELECT rank FROM chart_entries WHERE chart_date = ? AND level = 'national' AND genre = ? AND region_key = 'ALL' AND song_id = ?`).get(date, OVERALL, s.id);
        const dc = daysCharted(s.id);
        spotlightHtml = `
  <div class="panel" style="border:1px solid rgba(255,190,60,.55);background:linear-gradient(180deg,rgba(255,170,40,.12),rgba(255,170,40,.04))">
    <h2 style="margin-top:0;color:#ffd98a">⭐ SPOTLIGHT OF THE WEEK</h2>
    <p class="sub">The <b style="color:#fff">16th Law</b> at work — beyond the 15 points, our staff watches for the gift: pure raw talent and the value an artist brings. Every week, one artist gets named <b style="color:#fff">worth recognizing</b>.</p>
    <a class="row" href="/song/${s.id}">
      <img class="thumb" src="${esc(s.cover_path)}" alt="">
      <span class="meta"><span class="t">${esc(s.title)}</span><br><span class="a">${esc(s.artist)}</span></span>
      <span class="nums">${rk ? `NOW <b>#${rk.rank}</b>` : `<b>${esc(s.genre)}</b>`}</span>
    </a>
    ${spot.note ? `<p class="sub" style="margin-top:10px;font-style:italic;color:#ffe9b0">“${esc(spot.note)}”</p>` : ""}
    <p class="note" style="margin-top:8px">${dc.days ? `Day ${dc.days} on the chart · ` : ""}Named ${esc(fmtChartDate(spot.set_on))}. The spotlight is an honor — chart spots still ride on the scores.</p>
  </div>`;
      }
    }
  } catch (e) { spotlightHtml = ""; }
  const homeFirst = homeEntries.slice(0, 5);
  const homeRest = homeEntries.slice(5);
  const homeChartHtml = homeEntries.length ? `
  <div class="chartdate">Today's Top 20 — ${fmtChartDate(date)}</div>
  <div class="panel" style="margin-top:6px">
    <div id="homeChart">${homeFirst.map((e, i) => i === 0 ? heroRow(e, homeCtx, homePrev) : billboardRow(e, homeCtx, homePrev, { stats: false })).join("")}</div>
    ${homeRest.length ? `<div id="homeMore" hidden>${homeRest.map((e) => billboardRow(e, homeCtx, homePrev, { stats: false })).join("")}</div>
    <button type="button" class="viewmore" id="homeMoreBtn">View ${homeRest.length} More ↓</button>
    <script>
    document.getElementById('homeMoreBtn').addEventListener('click', function () {
      var m = document.getElementById('homeMore');
      var open = m.hidden;
      m.hidden = !open;
      this.textContent = open ? 'Show Less ↑' : 'View ${homeRest.length} More ↓';
    });
    </script>` : ""}
    <p style="text-align:center;margin:10px 0 2px"><a href="/charts?level=national&amp;genre=${encodeURIComponent(OVERALL)}" style="color:var(--accent);font-weight:700;text-decoration:none">See the full charts →</a></p>
  </div>` : "";

  const howStrip = `
  <div class="panel">
    <h2 style="margin-top:0">How it works</h2>
    <p class="sub"><b style="color:#fff">Part 1 — The Search.</b> The algorithm searches Facebook, Instagram, TikTok, YouTube, the music platforms where independents promote, and the open web — gathering everything it can find about you and your songs.</p>
    <p class="sub"><b style="color:#fff">Part 2 — The Judging.</b> Every song uploaded here is scored by the 15-point scale evaluation, 1–10 on each point, fitted genre by genre — then the charts recalculate daily. And the artist has to be real — <b style="color:#fff">no AI artists, no AI vocals</b>. A producer may use AI tools, but he still has to produce the song — generating the whole instrumental from a prompt is not producing. If a song turns out to cross that line, it comes off the charts immediately.</p>
    <p style="margin:10px 0 2px"><a href="/how-it-works" style="color:var(--accent);font-weight:700;text-decoration:none">See how it works →</a></p>
  </div>`;
  const stageRules = `
  <div class="panel">
    <h2 style="margin-top:0">How the Stage runs</h2>
    <p class="sub">The rotation plays the Top 20 in order, 1 through 20, 24 hours a day.</p>
    <p class="sub">Your music is being evaluated 24 hours a day — the algorithm never sleeps.</p>
    <p class="sub">New entries come into play at 12:00 midnight, every night — that's when the new chart takes effect and knocked-off songs leave the rotation.</p>
    <p class="sub"><b style="color:#fff">A great song holds its spot.</b> New entries can hit at midnight any night, but nobody loses a Top 20 spot for not uploading — a song only moves when hotter songs out-score it. So put your hottest material up here and keep doing what you're doing — that's what got you into the Top 20 in the first place. And a song that slides out of the 20 doesn't disappear — it stays in the big Top 100, ready to climb back.</p>
    <p class="sub">Same rule in the Top 100: a song only leaves the hundred when a hotter new entry out-scores it — every song faces the same evaluation. The 15-point scale evaluation measures every song on these 15 points: Mix Quality · Mastering &amp; Sound Quality · Hook Strength · Melody · Lyrical Quality · Song Structure · Vocal Delivery &amp; Performance · Production &amp; Instrumentation · Groove &amp; Rhythm · Emotional Impact · Dynamics &amp; Energy · Originality &amp; Identity · Replay Value · Radio &amp; Commercial Readiness · Cover Art &amp; Presentation. And even a song that falls out of the Top 100 still stays in the system — it's just not one of the Hot 100 right now.</p>
    <p class="sub"><b style="color:#fff">Give it time to be judged.</b> The system takes 24 hours to run a song through the full 15-point scale evaluation — it has to collect the data on you and your song first. So if you don't see your song in the Top 100 today or tomorrow, that doesn't mean anything — just wait. And if a week or so goes by and it still hasn't cracked the hundred, your song may just not be strong enough to break through yet — but don't pull it down. Leave it up, keep doing what you're doing, and keep giving your song its opportunity — the algorithm is checking 24 hours a day, and songs move when the numbers say so.</p>
  </div>
  <div class="panel" style="border:1px solid rgba(255,190,60,.55);background:linear-gradient(180deg,rgba(255,170,40,.10),rgba(255,170,40,.03))">
    <h2 style="margin-top:0;color:#ffd98a">The 16th Law</h2>
    <p class="sub">The 15 points measure your song. The 16th law is <b style="color:#fff">pure raw talent</b> — the gift no machine can value. Motown saw it in a young Michael Jackson; the world saw it in New Edition, and in a young Chris Brown. Our staff is always looking for that gift, and the law is simple: <b style="color:#fff">talent like that does not escape.</b> When we see it, you get the opportunity to grow right here on Top 20.</p>
  </div>
  <div class="panel" style="border:1px solid rgba(255,190,60,.55);background:linear-gradient(180deg,rgba(255,170,40,.10),rgba(255,170,40,.03))">
    <h2 style="margin-top:0;color:#ffd98a">The Fan Bonus</h2>
    <p class="sub">The 15 points judge your song — but your people can push it. Every <b style="color:#fff">like</b> and <b style="color:#fff">share</b> from your song's page is a <b style="color:#fff">bonus</b> on top of your chart score (up to +6, counted at the midnight chart change). Sitting deep in the Top 100? Work your fans — their likes and shares lift you up the chart. Craft still rules: the bonus helps you climb, it can't crown a song by itself.</p>
  </div>
  <div class="panel" style="border:1px solid rgba(201,162,39,.7)">
    <h2 style="margin-top:0">🎙️ VIEWCAST — THE TALK OF THE CHARTS</h2>
    <p class="sub">The uploads, the artists, and what's hot this week — filmed in the Viewcast studio, right here on Top 20.</p>
    <p style="margin:8px 0 2px"><a href="/viewcast" style="display:inline-block;background:#f2c14e;color:#131313;font-weight:800;border-radius:9px;padding:11px 18px;text-decoration:none">🎙️ Watch Viewcast</a></p>
  </div>`;

  const tabs = channels.map((c, i) =>
    `<button type="button" data-ch="${i}" class="${i === 0 ? "active" : ""}">${esc(c.label)}</button>`).join("");
  const body = `
  <div class="plj-wrap"><style>
  .plj-wrap { text-align:center; margin:12px 0 2px; }
  .plj { display:inline-flex; align-items:center; gap:11px; font-family:inherit; font-weight:900; letter-spacing:2.5px; font-size:15px; color:#46ff7d; background:linear-gradient(180deg,#1c2635,#090e16); border:none; border-radius:999px; padding:12px 24px; cursor:pointer; box-shadow:0 0 0 2px rgba(216,230,255,.9), 0 0 20px rgba(57,255,106,.35), inset 0 1px 0 rgba(255,255,255,.4), inset 0 -8px 14px rgba(0,0,0,.55); text-shadow:0 0 8px rgba(57,255,106,.65); }
  .plj:active { transform:scale(.97); }
  .plj-dot { width:10px; height:10px; border-radius:50%; background:#39ff6a; box-shadow:0 0 12px #39ff6a; animation:pljblink 1.05s steps(1) infinite; }
  @keyframes pljblink { 0%,55% { opacity:1; } 56%,100% { opacity:.12; } }
  .plj-arrow { font-size:12px; color:#d8e6ff; text-shadow:0 0 6px rgba(216,230,255,.8); animation:pljbob 1.2s ease-in-out infinite; }
  @keyframes pljbob { 0%,100% { transform:translateY(-1.5px); } 50% { transform:translateY(2px); } }
  .plj-push { display:inline-block; vertical-align:middle; margin-right:10px; font-weight:900; letter-spacing:2px; font-size:12.5px; color:#ffd98a; text-shadow:0 0 8px rgba(255,190,60,.5); }
  .plj-push .arr { display:inline-block; color:#46ff7d; text-shadow:0 0 8px rgba(57,255,106,.7); animation:pljnudge 1.2s ease-in-out infinite; }
  @keyframes pljnudge { 0%,100% { transform:translateX(0); } 50% { transform:translateX(4px); } }
  </style><span class="plj-push">PUSH <span class="arr">➜</span></span><button type="button" class="plj" id="playlistJump" aria-label="Jump to the live playlist"><span class="plj-arrow">▼</span><span class="plj-dot"></span>PLAYLIST LIVE<span class="plj-arrow">▼</span></button></div>
  <div class="herovid" style="position:relative"><video id="heroVid" src="/hero.mp4" poster="/hero-poster.jpg" autoplay muted loop playsinline disablepictureinpicture preload="auto" aria-label="Top 20 welcome video — artists performing on stage"></video><button type="button" id="heroSound" aria-label="Turn the welcome video sound on or off" style="position:absolute;right:10px;bottom:10px;background:rgba(10,10,18,.72);border:1px solid rgba(255,190,60,.65);color:#ffd98a;border-radius:999px;padding:8px 14px;font-size:12.5px;font-weight:800;letter-spacing:.4px;cursor:pointer">🔊 SOUND ON</button></div>
  <script>
  (function () {
    var v = document.getElementById("heroVid"), b = document.getElementById("heroSound");
    if (!v || !b) return;
    // One sound at a time on this page: the Stage player and the welcome
    // video both carry the DJ's voice — if both play, he sounds stacked.
    window.__muteHero = function () { if (!v.muted) { v.muted = true; b.textContent = "🔊 SOUND ON"; } };
    // Sound model (owner): phones forbid any website from playing sound
    // before the visitor's first touch, so the video's sound turns ON at
    // that first touch anywhere on the page — no button hunt — unless
    // the visitor has turned it off, a choice the site remembers.
    var choseOff = false;
    try { choseOff = localStorage.getItem("heroSound") === "off"; } catch (e) {}
    function soundOn() {
      if (window.__stopStage) window.__stopStage();
      v.muted = false;
      try { v.currentTime = 0; } catch (e) {}
      var p = v.play(); if (p && p.catch) p.catch(function () {});
      b.textContent = "🔈 SOUND OFF";
    }
    function soundOff() { v.muted = true; b.textContent = "🔊 SOUND ON"; }
    b.addEventListener("click", function () {
      if (v.muted) { try { localStorage.removeItem("heroSound"); } catch (e) {} choseOff = false; soundOn(); }
      else { try { localStorage.setItem("heroSound", "off"); } catch (e) {} choseOff = true; soundOff(); }
    });
    if (!choseOff) {
      var arm = function (e) {
        var t = e.target;
        if (t && t.closest && t.closest("button, a, input, select, textarea, audio, video")) return;
        document.removeEventListener("pointerdown", arm, true);
        if (v.muted) soundOn();
      };
      document.addEventListener("pointerdown", arm, true);
    }
    // The video's sound zone is the top of the page (owner): scroll down
    // past the video and its sound cuts off by itself — the video keeps
    // playing on mute and the Stage owns the sound below. Scroll back up
    // and, if the Stage isn't playing and the visitor hasn't chosen off,
    // the sound rejoins the video right where it is.
    var scrolledMute = false;
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        var en = entries[0]; if (!en) return;
        if (!en.isIntersecting) {
          if (!v.muted) { v.muted = true; b.textContent = "🔊 SOUND ON"; scrolledMute = true; }
        } else if (scrolledMute) {
          scrolledMute = false;
          var stageBusy = false;
          try { stageBusy = !!(window.__stageAudible && window.__stageAudible()); } catch (e) {}
          if (!choseOff && !stageBusy && v.muted) { v.muted = false; var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () {}); b.textContent = "🔈 SOUND OFF"; }
        }
      }, { threshold: 0.12 });
      io.observe(v);
    }
    // Coming back to the tab: the video itself resumes (still muted
    // unless its sound was on) — the Stage stays as the visitor left it.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && v.paused) { var p3 = v.play(); if (p3 && p3.catch) p3.catch(function () {}); }
    });
    // PLAYLIST LIVE jump button (above the video): one tap glides down
    // to the Stage, the video's sound cuts off, and the current song
    // starts if the playlist isn't already playing.
    var pj = document.getElementById("playlistJump");
    if (pj) pj.addEventListener("click", function () {
      scrolledMute = false;
      if (!v.muted) { v.muted = true; b.textContent = "🔊 SOUND ON"; }
      var tgt = document.getElementById("npPanel") || document.getElementById("channelTabs");
      if (tgt) tgt.scrollIntoView({ behavior: "smooth", block: "start" });
      var busy = false;
      try { busy = !!(window.__stageAudible && window.__stageAudible()); } catch (e) {}
      if (!busy) { var pb = document.getElementById("playBtn"); if (pb) pb.click(); }
    });
  })();
  </script>
  <div id="rolloutBar" title="Tap to hear it" style="margin:12px 0 2px;padding:14px 14px 12px;border:1px solid rgba(255,190,60,.65);border-radius:12px;background:linear-gradient(180deg,rgba(14,24,52,.92),rgba(6,10,22,.94));text-align:center;cursor:pointer">
    <div style="font-family:Anton,sans-serif;letter-spacing:2.5px;font-size:15px;color:#ffd98a">⏳ THE TOP 20 ROLLOUT — COMING SOON 🔊</div>
    <div style="display:flex;justify-content:center;gap:10px;margin:10px 0 8px">
      <div style="min-width:64px;padding:8px 4px;border-radius:10px;background:rgba(255,190,60,.10);border:1px solid rgba(255,190,60,.35)"><div id="cdD" style="font-family:Anton,sans-serif;font-size:30px;color:#fff;line-height:1">--</div><div style="font-size:10px;letter-spacing:2px;color:#ffd98a;margin-top:4px">DAYS</div></div>
      <div style="min-width:64px;padding:8px 4px;border-radius:10px;background:rgba(255,190,60,.10);border:1px solid rgba(255,190,60,.35)"><div id="cdH" style="font-family:Anton,sans-serif;font-size:30px;color:#fff;line-height:1">--</div><div style="font-size:10px;letter-spacing:2px;color:#ffd98a;margin-top:4px">HOURS</div></div>
      <div style="min-width:64px;padding:8px 4px;border-radius:10px;background:rgba(255,190,60,.10);border:1px solid rgba(255,190,60,.35)"><div id="cdM" style="font-family:Anton,sans-serif;font-size:30px;color:#fff;line-height:1">--</div><div style="font-size:10px;letter-spacing:2px;color:#ffd98a;margin-top:4px">MIN</div></div>
      <div style="min-width:64px;padding:8px 4px;border-radius:10px;background:rgba(255,190,60,.10);border:1px solid rgba(255,190,60,.35)"><div id="cdS" style="font-family:Anton,sans-serif;font-size:30px;color:#fff;line-height:1">--</div><div style="font-size:10px;letter-spacing:2px;color:#ffd98a;margin-top:4px">SEC</div></div>
    </div>
    <div style="font-size:13.5px;line-height:1.45;color:#e8eaf0"><b style="color:#fff">Upload your song now</b> and get prepared — the Top 100 bucket fills first, then the Top 20 rollout begins. <a href="/upload" style="color:#ffd98a;font-weight:800;text-decoration:none">Upload your song →</a></div>
  </div>
  <script>
  (function () {
    var target = new Date("2026-12-16T06:00:00Z").getTime(); // Dec 16, 2026, 12:00 AM Central (45-day rollout countdown — restarted by Dale the night of Oct 31, a full 45 days from Nov 1)
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    function tick() {
      var left = target - Date.now();
      var d = document.getElementById("cdD"), h = document.getElementById("cdH"),
          m = document.getElementById("cdM"), s = document.getElementById("cdS");
      if (!d) return;
      if (left <= 0) {
        d.textContent = "00"; h.textContent = "00"; m.textContent = "00"; s.textContent = "00";
        var bar = document.getElementById("rolloutBar");
        if (bar) bar.querySelector("div").textContent = "🔥 THE TOP 20 ROLLOUT IS ON";
        return;
      }
      d.textContent = pad(Math.floor(left / 86400000));
      h.textContent = pad(Math.floor(left / 3600000) % 24);
      m.textContent = pad(Math.floor(left / 60000) % 60);
      s.textContent = pad(Math.floor(left / 1000) % 60);
      setTimeout(tick, 1000);
    }
    // Tap the rollout box and the DJ voice (Take B) reads the line under
    // the clock out loud (owner request, Oct 31). Taps on the Upload link
    // inside the box still navigate — they are left alone.
    var rb = document.getElementById("rolloutBar");
    var rAudio = null;
    if (rb) rb.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("a")) return;
      if (!rAudio) rAudio = new Audio("/ann/rollout.mp3?v=2");
      try { rAudio.currentTime = 0; } catch (err) {}
      var p = rAudio.play(); if (p && p.catch) p.catch(function () {});
    });
    tick();
  })();
  </script>
  <div style="margin:12px 0 2px;padding:10px 14px;border:1px solid rgba(255,190,60,.55);border-radius:12px;background:linear-gradient(180deg,rgba(255,170,40,.14),rgba(255,170,40,.05));color:#ffd98a;font-size:13.5px;line-height:1.45;text-align:center">🎧 <b style="color:#fff">STAGE SHOWCASE</b> — these covers are on display for show right now. <b style="color:#fff">The Top 20 starts airing within 45 days of launch.</b> Artists — get your song uploaded and judged now, and be ready when the real rotation begins.</div>
  <div class="tabs" id="channelTabs">${tabs}</div>
  ${first ? `
  <div class="stagegrid">
  <div class="chrome-frame" id="npPanel"><div class="panel">
    <div class="np-top"><div class="np-bigrank" id="npBigRank">#${first.rank}</div><div><div class="sub" style="letter-spacing:2px;text-transform:uppercase;font-size:11px">Now playing — <span id="npChannel">Main Stage</span></div><div class="np-ranklab">National rank</div></div></div>
    <img class="cover" id="npCover" src="${esc(first.cover)}" alt="cover" style="margin-top:10px">
    <h1 id="npTitle">${esc(first.title)}</h1>
    <div class="sub" id="npArtist">${esc(first.artist)}</div>
    <div class="chips">
      <span class="chip">Craft score <b id="npCraft">${first.craft}</b></span>
      <span class="chip">Only the Top 20 plays — 24/7</span>
    </div>
    <div class="chips" style="margin-top:8px">
      <span class="chip">▶ <b id="npPlays">${fmtNum(first.plays || 0)}</b> plays</span>
      <span class="chip">♥ <b id="npLikes">${fmtNum(first.likes || 0)}</b> likes</span>
      <span class="chip" id="npSharesChip" style="cursor:pointer" title="Share this song">⤴ <b id="npShares">${fmtNum(first.shares || 0)}</b> shares</span>
      <span class="chip" id="npDays">${first.fresh ? "🔥 New entry · Day 1" : "Days charted · " + (first.days || 0)}</span>
      <span class="chip pickchip" id="npPick"${first.pick ? "" : " hidden"}>🎧 DJ's Hot Pick</span>
    </div>
    <button type="button" id="npShareBtn" class="btn" style="margin-top:12px">⤴ Share this song</button>
    <p class="sub" id="npShareMsg" style="margin:6px 0 0"></p>
    <div id="npShareMenu" class="panel" style="display:none;padding:12px;margin-top:8px;text-align:left">
      <p class="sub" style="margin:0 0 10px"><b style="color:#fff">Share this song</b> — pick where it goes:</p>
      <div style="display:grid;gap:8px">
        <a id="npShareFb" data-npdest="facebook" target="_blank" rel="noopener" href="#" style="display:block;padding:13px 14px;border-radius:10px;border:1px solid #3a4a6b;background:#0d1730;color:#fff;font-weight:700;text-decoration:none">📘&nbsp; Share to Facebook</a>
        <a id="npShareWa" data-npdest="whatsapp" target="_blank" rel="noopener" href="#" style="display:block;padding:13px 14px;border-radius:10px;border:1px solid #3a4a6b;background:#0d1730;color:#fff;font-weight:700;text-decoration:none">💬&nbsp; Share to WhatsApp</a>
        <a id="npShareX" data-npdest="x" target="_blank" rel="noopener" href="#" style="display:block;padding:13px 14px;border-radius:10px;border:1px solid #3a4a6b;background:#0d1730;color:#fff;font-weight:700;text-decoration:none">✖️&nbsp; Share to X</a>
        <button type="button" id="npShareCopy" style="display:block;width:100%;font:inherit;text-align:left;cursor:pointer;padding:13px 14px;border-radius:10px;border:1px solid #3a4a6b;background:#0d1730;color:#fff;font-weight:700">🔗&nbsp; Copy the link</button>
        <button type="button" id="npShareNative" style="display:none;width:100%;font:inherit;text-align:left;cursor:pointer;padding:13px 14px;border-radius:10px;border:1px solid #3a4a6b;background:#0d1730;color:#fff;font-weight:700">📲&nbsp; More options — Instagram and more</button>
      </div>
      <p class="note" style="margin:10px 0 0">Instagram sits under "More options" — that opens the share panel built into the phone, where Instagram lives.</p>
    </div>
    <script>
    (function(){
      var btn = document.getElementById('npShareBtn');
      var menu = document.getElementById('npShareMenu');
      var msg = document.getElementById('npShareMsg');
      if (!btn || !menu) return;
      var cur = { id: ${first.id}, title: ${JSON.stringify(first.title)}, artist: ${JSON.stringify(first.artist)}, shares: ${Number(first.shares || 0)} };
      var countedFor = 0;
      function songUrl(){ return location.origin + '/song/' + cur.id; }
      function words(){ return '"' + cur.title + '" by ' + cur.artist + ' — playing now on the TOP 20 Stage'; }
      function refresh(){
        var u = encodeURIComponent(songUrl());
        document.getElementById('npShareFb').href = 'https://www.facebook.com/sharer/sharer.php?u=' + u;
        document.getElementById('npShareWa').href = 'https://wa.me/?text=' + encodeURIComponent(words() + ' ' + songUrl());
        document.getElementById('npShareX').href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(words()) + '&url=' + u;
      }
      function count(){
        if (countedFor === cur.id) return; countedFor = cur.id; cur.shares++;
        var el = document.getElementById('npShares'); if (el) el.textContent = cur.shares.toLocaleString('en-US');
        try { fetch('/song/' + cur.id + '/engage', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'type=share', keepalive: true }); } catch (e) {}
      }
      window.__npShareSet = function(t){ cur = { id: t.id, title: t.title, artist: t.artist, shares: t.shares || 0 }; refresh(); };
      function toggle(){
        var open = menu.style.display !== 'none';
        menu.style.display = open ? 'none' : 'block';
      }
      btn.addEventListener('click', toggle);
      var chip = document.getElementById('npSharesChip');
      if (chip) chip.addEventListener('click', toggle);
      var dests = menu.querySelectorAll('[data-npdest]');
      for (var i = 0; i < dests.length; i++) dests[i].addEventListener('click', function(){ count(); msg.textContent = 'Opening your pick — thanks for spreading the word.'; });
      function fallbackCopy(done){
        var ta = document.createElement('textarea');
        ta.value = songUrl(); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta); done();
      }
      var copyBtn = document.getElementById('npShareCopy');
      if (copyBtn) copyBtn.addEventListener('click', function(){
        var done = function(){ count(); msg.textContent = 'Link copied — paste it anywhere you like.'; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(songUrl()).then(done, function(){ fallbackCopy(done); });
        else fallbackCopy(done);
      });
      var nativeBtn = document.getElementById('npShareNative');
      if (nativeBtn && navigator.share) {
        nativeBtn.style.display = 'block';
        nativeBtn.addEventListener('click', function(){
          navigator.share({ title: document.title, text: words(), url: songUrl() }).then(function(){ count(); msg.textContent = 'Shared — thanks for spreading the word.'; }, function(){});
        });
      }
      refresh();
    })();
    </script>
  </div></div>
  <div class="panel">
    <h2 style="margin-top:0">In rotation</h2>
    <p class="sub">The Top 20 never sits still — the first 10 ride one spinner, the next 10 ride the other. The song that's playing sticks out big, with its timer running under it. Drag a spinner to look around — it always swings back to the song that's playing.</p>
    <div class="ringsrow"><div class="ringcol">
    <div class="spinlabel" id="spinLabelA">TOP 10</div>
    <div class="ringwrap" id="wrapA"><div class="ring" id="ringA"></div><div class="upnext" id="upNextA" hidden></div></div>
    <div class="ringnow" id="ringNowA"></div>
    </div><div class="ringcol" id="ringBBlock">
      <div class="spinlabel" id="spinLabelB">11 – 20</div>
      <div class="ringwrap" id="wrapB"><div class="ring" id="ringB"></div><div class="upnext" id="upNextB" hidden></div></div>
      <div class="ringnow" id="ringNowB"></div>
    </div></div>
  </div></div>
  ${djPicksHtml}
  ${spotlightHtml}
  <div class="homegrid">
  ${homeNewHtml}
  ${homeChartHtml}
  ${homeRisersHtml}
  ${homeDjHtml}
  </div>
  ${howStrip}
  <div class="panel ctabar">
    <div class="cta-txt"><b>Your music and your profile will speak for themselves.</b><span>Make your free artist profile, upload a song, and let the 15 judges do the rest.</span></div>
    <a class="btn btn-blue cta-btn" href="/profile">Create Profile</a>
  </div>
  ${stageRules}
  <div id="adBreak" hidden style="margin:12px 0 2px;border:1px solid rgba(255,190,60,.55);border-radius:14px;background:#05070d;padding:10px 12px;text-align:center">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px">
      <span style="color:#ffd98a;font-weight:800;letter-spacing:1.5px;font-size:12px">📣 ADVERTISEMENT</span>
      <span id="adCount" style="color:#bcd;font-size:12px"></span>
    </div>
    <img id="adImg" alt="Advertisement" style="display:none;width:100%;max-height:340px;object-fit:contain;border-radius:10px;background:#000">
    <video id="adVid" playsinline disablepictureinpicture style="display:none;width:100%;max-height:340px;border-radius:10px;background:#000"></video>
    <p class="note" style="margin:8px 0 0">Back to the countdown right after this.</p>
  </div>
  <div class="playerbar"><div class="panel">
    <img id="barThumb" src="${esc(first.cover)}" alt="">
    <div class="meta"><div class="t" id="barTitle">${esc(first.title)}</div><div class="a" id="barArtist">${esc(first.artist)}</div></div>
    <button type="button" class="playbtn" id="playBtn" aria-label="Play or pause">▶</button>
    <button type="button" id="djBtn" aria-label="Toggle the DJ announcement voice" style="flex:0 0 auto;background:rgba(255,190,60,.12);border:1px solid rgba(255,190,60,.45);color:#ffd98a;border-radius:999px;padding:7px 11px;font-size:11.5px;font-weight:800;letter-spacing:.4px;cursor:pointer">🎙️ DJ VOICE ON</button>
    <audio id="stageAudio" preload="none"></audio>

  </div></div>
  <script>
  const PLAYLISTS = ${JSON.stringify(channels.map((c) => c.list)).replace(/</g, "\\u003c")};
  const LABELS = ${JSON.stringify(channels.map((c) => c.label))};
  const ADS_BY_CH = ${JSON.stringify((() => { try { const all = db.prepare("SELECT kind, file_path, link_url, seconds, genre FROM ads WHERE active = 1 AND status = 'live' ORDER BY id").all().map((a) => ({ kind: a.kind, src: a.file_path, link: a.link_url || "", seconds: a.seconds, genre: a.genre || "All" })); return [OVERALL, ...GENRES].map((g) => (g === OVERALL ? all : all.filter((a) => a.genre === "All" || a.genre === g))); } catch (e) { return []; } })())};
  const ANN_KEYS = ${JSON.stringify(Object.keys(ANN))};
  const ANN_V = 2; // announcement voice generation (2 = the Take B radio voice) — bump on every re-record so phones fetch the new clips instead of playing a cached old voice
  let ch = 0, idx = 0, lastCounted = "";
  let previewOn = false; // a Top Risers preview is playing outside the rotation
  const audio = document.getElementById('stageAudio');
  const $ = (id) => document.getElementById(id);
  // Radio DJ voice (owner request): before a song plays on the Stage, the
  // voice announces its number spot, title, artist and days charted.
  let loadSeq = 0;
  let djOn = true;
  try { djOn = localStorage.getItem('djVoice') !== '0'; } catch (e) {}
  function djLabel(){ const b = $('djBtn'); if (b) b.textContent = djOn ? '🎙️ DJ VOICE ON' : '🎙️ DJ VOICE OFF'; }
  function djText(t){
    const d = t.fresh ? 'A brand new entry — day one on the chart.' : (t.days === 1 ? 'Day one on the chart.' : (t.days || 0) + ' days on the chart.');
    return 'The number ' + t.rank + ' song on Top 20 is "' + t.title + '" by ' + t.artist + '. ' + d + " Hot Top 20 — non-stop!";
  }
  // Stage ad slots (owner feature): after every 5 songs in the rotation,
  // one active ad plays (image for its seconds, video to its end — hard
  // capped at 30s). When the ad finishes, the rotation resumes with the
  // next song and its on-screen countdown keeps running as normal.
  const AD_EVERY = 5;
  let songsSinceAd = 0, adIdx = 0, adBusy = false, adSeq = 0, adCleanup = null;
  function stopAdVisual(){
    const box = $('adBreak'), vid = $('adVid'), img = $('adImg');
    if (vid) { try { vid.pause(); vid.removeAttribute('src'); vid.load(); } catch (e) {} vid.style.display = 'none'; }
    if (img) { img.removeAttribute('src'); img.style.display = 'none'; }
    if (box) box.hidden = true;
  }
  function playAd(done){
    const pool = (typeof ADS_BY_CH !== 'undefined' && ADS_BY_CH[ch]) || [];
    if (!pool.length) { done(); return; }
    const ad = pool[adIdx % pool.length]; adIdx++;
    const my = ++adSeq;
    adBusy = true;
    const box = $('adBreak'), img = $('adImg'), vid = $('adVid'), cnt = $('adCount');
    box.hidden = false;
    let finished = false, timer = null, hard = null;
    const finish = () => {
      if (finished) return; finished = true;
      if (timer) clearInterval(timer);
      if (hard) clearTimeout(hard);
      stopAdVisual();
      adBusy = false; adCleanup = null;
      if (my === adSeq) done();
    };
    adCleanup = () => { if (timer) clearInterval(timer); if (hard) clearTimeout(hard); finished = true; stopAdVisual(); adBusy = false; adCleanup = null; };
    box.onclick = () => { if (ad.link) window.open(ad.link, '_blank', 'noopener'); };
    if (ad.kind === 'video') {
      img.style.display = 'none'; vid.style.display = 'block';
      vid.src = ad.src; vid.muted = false;
      cnt.textContent = 'Ad · video';
      vid.ontimeupdate = () => {
        const d = vid.duration || 0, c = vid.currentTime || 0;
        if (c >= 30) { finish(); return; }
        if (d > 0) cnt.textContent = 'Ad · ' + Math.max(0, Math.ceil(Math.min(d, 30) - c)) + 's left';
      };
      vid.onended = finish; vid.onerror = finish;
      vid.play().then(() => {}).catch(() => { vid.muted = true; vid.play().catch(() => finish()); });
      hard = setTimeout(finish, 32000);
    } else {
      vid.style.display = 'none'; img.style.display = 'block';
      img.src = ad.src;
      let remain = Math.max(3, Math.min(30, ad.seconds || 8));
      cnt.textContent = 'Ad · ' + remain + 's left';
      timer = setInterval(() => { remain -= 1; if (remain <= 0) { finish(); return; } cnt.textContent = 'Ad · ' + remain + 's left'; }, 1000);
      hard = setTimeout(finish, (remain + 1) * 1000);
    }
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function djSpeak(t, done){
    if (!djOn || !t || !('speechSynthesis' in window)) { done(); return; }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(djText(t));
      u.rate = 0.98; u.pitch = 0.6; u.volume = 1;
      const vs = speechSynthesis.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
      const pick = vs.find((v) => /male|david|daniel|guy|christopher|george/i.test(v.name)) || vs[0];
      if (pick) u.voice = pick;
      let fired = false; const go = () => { if (!fired) { fired = true; done(); } };
      u.onend = go; u.onerror = go;
      setTimeout(go, 6000); // never hold the music hostage to a stuck voice
      speechSynthesis.speak(u);
    } catch (e) { done(); }
  }
  // Recorded DJ announcements (the owner's chosen voice): rank clip +
  // "title by artist" clip + days clip + the "Hot Top 20 — non-stop!"
  // closer, played in order before the song ON THE STAGE PLAYER ITSELF.
  // (A separate DJ audio element got blocked by phone autoplay rules at
  // automatic song changes — the tap that starts it is long past — which
  // left the DJ silent; the player element the listener started with a
  // tap stays allowed.) If any clip is missing (a brand-new song, a
  // chart run past 60 days), the phone voice reads it instead.
  let djChain = 0, announcing = false, annStep = null;
  function djStop(){ djChain++; announcing = false; annStep = null; }
  function djAnnounce(t, done){
    if (!djOn || !t) { done(); return; }
    const daysKey = t.fresh ? 'days-fresh' : (t.days === 1 ? 'days-one' : (t.days >= 2 && t.days <= 60 ? 'days-' + t.days : null));
    const keys = ['rank-' + t.rank, 'title-' + t.id, daysKey, 'closer'];
    if (keys.some((k) => !k || ANN_KEYS.indexOf(k) === -1)) { djSpeak(t, done); return; }
    const my = ++djChain;
    let i = 0, fired = false;
    const hard = setTimeout(() => { if (my === djChain) finish(); }, 12000);
    function finish(){
      if (fired) return; fired = true;
      clearTimeout(hard);
      if (my === djChain) { announcing = false; annStep = null; audio.onerror = null; audio.src = t.audio; }
      done();
    }
    const step = () => {
      if (fired || my !== djChain) return;
      if (i >= keys.length) { finish(); return; }
      audio.src = '/ann/' + keys[i] + '.mp3?v=' + ANN_V; i++;
      const p = audio.play(); if (p && p.catch) p.catch(() => finish());
    };
    announcing = true;
    annStep = step;
    audio.onerror = () => { if (announcing && my === djChain) finish(); };
    step();
  }
  // The welcome video's SOUND ON button calls this: stop the Stage dead
  // (pending announcements invalidated) so the two never play at once.
  window.__stopStage = function(){ loadSeq++; djStop(); try { audio.pause(); } catch (e) {} };
  window.__stageAudible = function(){ return !audio.paused; };
  const rings = [
    { el: 'ringA', now: 'ringNowA', from: 0, to: 10, front: 0, dir: 1, hover: false, ang: 0, mode: 'spin', hold: false, dragging: false, resumeT: null },
    { el: 'ringB', now: 'ringNowB', from: 10, to: 20, front: 0, dir: -1, hover: false, ang: 0, mode: 'spin', hold: false, dragging: false, resumeT: null },
  ];
  let ringTimer = null;
  function ringList(r){ return PLAYLISTS[ch].slice(r.from, Math.min(r.to, PLAYLISTS[ch].length)); }
  function ringRadius(n){ return Math.round(50 / Math.tan(Math.PI / n)) + 8; }
  function buildRing(r){
    const list = ringList(r);
    const ring = $(r.el);
    if (r.el === 'ringB') $('ringBBlock').style.display = list.length ? '' : 'none';
    if (!list.length){ ring.innerHTML = ''; return; }
    if (r.front >= list.length) r.front = 0;
    const R = ringRadius(list.length), step = 360 / list.length;
    ring.innerHTML = list.map((t, i) =>
      '<div class="cell" data-gi="' + (r.from + i) + '" style="transform:rotateY(' + (i * step) + 'deg) translateZ(' + R + 'px)">' +
      '<div class="cellin"><img src="' + t.cover + '" alt="" draggable="false">' +
      '<div class="ct">#' + t.rank + ' ' + t.title + (t.pick ? ' 🎧' : '') + '</div><div class="ca">' + t.artist + '</div></div></div>').join('');
    ring.querySelectorAll('.cell').forEach((el, i) => {
      el.dataset.a = String(i * step);
      el.dataset.r = String(R);
      el.addEventListener('click', (e) => {
        if (dragMoved) { dragMoved = false; return; }
        lastInteract = Date.now();
        const t = PLAYLISTS[ch][parseInt(el.dataset.gi, 10)];
        if (!t) return;
        const touchy = (e.pointerType === 'touch') || window.matchMedia('(hover: none)').matches;
        if (touchy && !el.classList.contains('pop')) {
          ring.querySelectorAll('.cell').forEach((x) => x.classList.remove('pop'));
          el.classList.add('pop');
          r.hold = true; clearTimeout(r.resumeT); snapTo(r, i);
          r.resumeT = setTimeout(() => { el.classList.remove('pop'); r.hold = false; settle(r, 0); }, 2800);
          return;
        }
        location.href = '/song/' + t.id;
      });
      el.addEventListener('mouseenter', () => { r.hold = true; r.hover = true; clearTimeout(r.resumeT); lastInteract = Date.now(); snapTo(r, i); });
      el.addEventListener('mouseleave', () => { r.hold = false; r.hover = false; el.classList.remove('pop'); settle(r, 900); });
    });
    ring.classList.add('live');
    r.ang = -r.front * step;
    r.mode = 'spin';
    setRing(r);
    face(r, r.front);
    settle(r, 0);
  }
  function setRing(r){
    const list = ringList(r); if (!list.length) return;
    const R = ringRadius(list.length);
    $(r.el).style.transform = 'translateZ(' + (-R) + 'px) rotateY(' + r.ang + 'deg)';
  }
  function frontFromAng(r){
    const list = ringList(r); if (!list.length) return 0;
    const step = 360 / list.length;
    return ((Math.round(-r.ang / step) % list.length) + list.length) % list.length;
  }
  function isPlayingRing(r){
    const list = ringList(r); const local = idx - r.from;
    return !!(list.length && local >= 0 && local < list.length);
  }
  function face(r, front){
    const list = ringList(r); if (!list.length) return;
    r.front = front;
    $(r.el).querySelectorAll('.cell').forEach((el, i) => {
      el.classList.toggle('front', i === front);
      const d = Math.min(Math.abs(i - front), list.length - Math.abs(i - front));
      el.style.opacity = d === 0 ? '1' : d === 1 ? '.88' : d === 2 ? '.62' : '.4';
    });
    const t = list[front];
    if (t && !isPlayingRing(r)) $(r.now).innerHTML = 'Up front: <b>#' + t.rank + ' — ' + t.title + '</b> · ' + t.artist + ' · Craft ' + t.craft;
  }
  function spinRing(r){ setRing(r); face(r, frontFromAng(r)); }
  function snapTo(r, index){
    const list = ringList(r); if (!list.length) return;
    const step = 360 / list.length;
    const base = -index * step;
    r.ang = base + 360 * Math.round((r.ang - base) / 360);
    r.mode = 'snap';
    $(r.el).classList.remove('live');
    setRing(r); face(r, index);
  }
  function settle(r, delay){
    clearTimeout(r.resumeT);
    r.resumeT = setTimeout(() => {
      if (r.hold || r.dragging) return;
      if (isPlayingRing(r)) snapTo(r, idx - r.from);
      else { $(r.el).classList.add('live'); r.mode = 'spin'; }
    }, delay == null ? 900 : delay);
  }
  let lastTs = 0, faceClock = 0;
  function spinLoop(ts){
    requestAnimationFrame(spinLoop);
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.05, (ts - lastTs) / 1000); lastTs = ts;
    faceClock += dt;
    const doFace = faceClock > 0.18;
    if (doFace) faceClock = 0;
    rings.forEach((r) => {
      if (isPlayingRing(r)) { if (r.mode === 'spin' && !r.hold && !r.dragging) snapTo(r, idx - r.from); return; }
      if (r.mode !== 'spin' || r.hold || r.dragging) return;
      if (ringList(r).length < 2) return;
      r.ang += r.dir * 6.5 * dt;
      setRing(r);
      if (doFace) face(r, frontFromAng(r));
    });
  }
  requestAnimationFrame(spinLoop);
  function renderRings(){ rings.forEach(buildRing); }
  function syncRings(){
    rings.forEach((r) => {
      const list = ringList(r);
      const local = idx - r.from;
      const has = !!(list.length && local >= 0 && local < list.length);
      const wrap = $(r.el === 'ringA' ? 'wrapA' : 'wrapB');
      const label = $(r.el === 'ringA' ? 'spinLabelA' : 'spinLabelB');
      wrap.classList.toggle('lit', has);
      wrap.classList.toggle('dim', !has);
      label.classList.toggle('lit', has);
      $(r.el).querySelectorAll('.cell').forEach((el, i) => {
        const on = has && i === local;
        el.classList.toggle('playing', on);
        const a = parseInt(el.dataset.a, 10);
        const rr = parseInt(el.dataset.r, 10) + (on ? 40 : 0);
        el.style.transform = 'rotateY(' + a + 'deg) translateZ(' + rr + 'px)';
      });
      settle(r, 0);
    });
  }
  let lastInteract = 0, dragMoved = false, tickN = 0;
  function fmtN(n){ return (n || 0).toLocaleString('en-US'); }
  function fmtT(s){ if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function tick(){
    tickN++;
    let anc = null;
    rings.forEach((r) => {
      const list = ringList(r);
      const local = idx - r.from;
      if (list.length && local >= 0 && local < list.length) anc = { r, list, local };
    });
    if (previewOn) { const ua = $('upNextA'), ub = $('upNextB'); if (ua) ua.hidden = true; if (ub) ub.hidden = true; anc = null; }
    if (anc) {
      const t = anc.list[anc.local];
      if (announcing) {
        $(anc.r.now).innerHTML = '🎙️ <b>DJ announcing:</b> #' + t.rank + ' — ' + t.title + ' · ' + t.artist;
        const ua2 = $('upNextA'), ub2 = $('upNextB'); if (ua2) ua2.hidden = true; if (ub2) ub2.hidden = true;
        return;
      }
      const dur = audio.duration || 0, cur = audio.currentTime || 0;
      const pct = dur ? Math.min(100, Math.round(cur / dur * 100)) : 0;
      $(anc.r.now).innerHTML = (audio.paused ? 'Loaded: ' : '&#9654; Playing: ') + '<b>#' + t.rank + ' — ' + t.title + '</b> · ' + t.artist +
        '<br>' + fmtT(cur) + ' / ' + fmtT(dur) + '<span class="prog"><i style="width:' + pct + '%"></i></span>';
      const all = PLAYLISTS[ch];
      const nx = all.length > 1 ? all[(idx + 1) % all.length] : null;
      const upEl = $(anc.r.el === 'ringA' ? 'upNextA' : 'upNextB');
      const win = dur ? Math.min(25, dur * 0.45) : 0;
      if (nx && !audio.paused && dur > 0 && (dur - cur) <= win) {
        upEl.innerHTML = '<span>UP NEXT</span><img src="' + nx.cover + '" alt=""><span>#' + nx.rank + ' ' + nx.title + '</span><span class="arr">&#10132;</span>';
        upEl.hidden = false;
      } else upEl.hidden = true;
      const other = $(anc.r.el === 'ringA' ? 'upNextB' : 'upNextA');
      if (other) other.hidden = true;
    }
  }
  function startShowcase(){ stopShowcase(); ringTimer = setInterval(tick, 1000); }
  function stopShowcase(){ if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } }
  function load(i, autoplay){
    const t = PLAYLISTS[ch][i]; if (!t) return;
    if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
    djStop();
    if (adBusy) { adSeq++; if (adCleanup) adCleanup(); }
    previewOn = false;
    idx = i;
    audio.src = t.audio;
    $('npCover').src = t.cover; $('npTitle').textContent = t.title;
    $('npArtist').textContent = t.artist; $('npBigRank').textContent = '#' + t.rank;
    $('npCraft').textContent = t.craft; $('npChannel').textContent = LABELS[ch];
    $('npPlays').textContent = fmtN(t.plays); $('npLikes').textContent = fmtN(t.likes); $('npShares').textContent = fmtN(t.shares); if (window.__npShareSet) window.__npShareSet(t);
    $('npDays').textContent = t.fresh ? '🔥 New entry · Day 1' : 'Days charted · ' + (t.days || 0);
    $('npPick').hidden = !t.pick;
    $('barThumb').src = t.cover; $('barTitle').textContent = t.title; $('barArtist').textContent = t.artist;
    syncRings();
    if (autoplay) { if (window.__muteHero) window.__muteHero(); const seq = ++loadSeq; djAnnounce(t, () => { if (seq === loadSeq) audio.play().catch(() => {}); }); }
  }
  document.querySelectorAll('#channelTabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#channelTabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      ch = parseInt(b.dataset.ch, 10);
      rings.forEach((r) => { r.front = 0; });
      $('spinLabelA').textContent = ch === 0 ? 'TOP 10' : LABELS[ch].toUpperCase();
      renderRings();
      load(0, false);
    });
  });
  let userPausedStage = false; // the visitor's own pause is never overridden (radio autostart below)
  $('playBtn').addEventListener('click', () => {
    if (window.__muteHero) window.__muteHero();
    if (!audio.paused) { audio.pause(); userPausedStage = true; return; }
    userPausedStage = false;
    if (!previewOn && audio.currentTime === 0 && audio.src) {
      const t = PLAYLISTS[ch][idx];
      if (t) { const seq = ++loadSeq; djAnnounce(t, () => { if (seq === loadSeq) audio.play().catch(() => {}); }); return; }
    }
    audio.play().catch(() => {});
  });
  $('djBtn').addEventListener('click', () => {
    djOn = !djOn;
    try { localStorage.setItem('djVoice', djOn ? '1' : '0'); } catch (e) {}
    if (!djOn && 'speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
    djLabel();
  });
  djLabel();
  // Radio dial (owner, Oct 31): the moment the Stage — the now-playing
  // panel and the spindles — scrolls into view, the current song comes
  // ON by itself, DJ announcement first, exactly like turning a radio
  // dial. Phones allow sound only after the visitor's first touch, and
  // scrolling is a touch, so the dial arms on the first touch anywhere.
  // A visitor who pressed pause themselves is never overridden.
  let stageArmed = false, stageInView = false;
  function tryRadioStart(){
    if (!stageArmed || !stageInView || userPausedStage) return;
    if (document.hidden) return;
    if (!audio.paused || announcing || adBusy || previewOn) return;
    $('playBtn').click();
  }
  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, function () {
    stageArmed = true; tryRadioStart();
  }, { capture: true, passive: true }));
  if ('IntersectionObserver' in window) {
    const rio = new IntersectionObserver((entries) => {
      stageInView = !!(entries[0] && entries[0].isIntersecting);
      if (stageInView) tryRadioStart();
    }, { threshold: 0.25 });
    const sg = document.querySelector('.stagegrid');
    if (sg) rio.observe(sg);
  }
  audio.addEventListener('play', () => {
    $('playBtn').textContent = '❚❚';
    if (!announcing && audio.currentSrc !== lastCounted) {
      lastCounted = audio.currentSrc;
      const t = PLAYLISTS[ch][idx];
      if (t) fetch('/api/play/' + t.id, { method: 'POST' }).catch(() => {});
    }
  });
  audio.addEventListener('pause', () => { $('playBtn').textContent = '▶'; });
  audio.addEventListener('ended', () => {
    if (announcing && annStep) { annStep(); return; }
    if (previewOn) { previewOn = false; return; }
    if (adBusy) return;
    const next = (idx + 1) % PLAYLISTS[ch].length;
    songsSinceAd++;
    if (((typeof ADS_BY_CH !== 'undefined' && ADS_BY_CH[ch]) || []).length && songsSinceAd >= AD_EVERY) { songsSinceAd = 0; playAd(() => load(next, true)); }
    else load(next, true);
  });
  // Drag or scroll a spinner by hand — the playing ring always swings back
  // to the song that's playing; the other ring goes back to spinning.
  rings.forEach((r) => {
    const wrap = $(r.el === 'ringA' ? 'wrapA' : 'wrapB');
    const ringEl = $(r.el);
    let startX = 0, startAng = 0;
    wrap.addEventListener('dragstart', (e) => e.preventDefault());
    wrap.addEventListener('pointerdown', (e) => {
      if (ringList(r).length < 2) return;
      r.dragging = true; dragMoved = false; startX = e.clientX; startAng = r.ang;
      clearTimeout(r.resumeT);
      ringEl.classList.add('live'); r.mode = 'hold';
      lastInteract = Date.now();
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!r.dragging) return;
      const list = ringList(r); if (!list.length) return;
      const step = 360 / list.length;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 8 && !dragMoved) { dragMoved = true; try { wrap.setPointerCapture(e.pointerId); } catch (err) {} }
      if (!dragMoved) return;
      r.ang = startAng + dx * (step / 44);
      setRing(r);
      lastInteract = Date.now();
    });
    const endDrag = () => {
      if (!r.dragging) return;
      r.dragging = false;
      ringEl.classList.remove('live');
      snapTo(r, frontFromAng(r));
      settle(r, 1400);
      lastInteract = Date.now();
      setTimeout(() => { dragMoved = false; }, 60);
    };
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);
    wrap.addEventListener('wheel', (e) => {
      const list = ringList(r); if (list.length < 2) return;
      e.preventDefault();
      clearTimeout(r.resumeT);
      const f = frontFromAng(r);
      snapTo(r, (((f + (e.deltaY > 0 ? 1 : -1)) % list.length) + list.length) % list.length);
      settle(r, 1400);
      lastInteract = Date.now();
    }, { passive: false });
  });
  // Two-click rows (owner request): the FIRST click on a home Top 20 chart
  // row or a Top Risers row lifts it up big in place — like the #1 hero —
  // and plays it. The SECOND click on the same row opens the song page.
  function collapseRows(except){
    document.querySelectorAll('.rowlink.expanded').forEach((x) => { if (x !== except) x.classList.remove('expanded'); });
  }
  document.querySelectorAll('#homeChart .rowlink, #homeMore .rowlink').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.artistlink')) return;
      if (row.classList.contains('expanded')) return; // second click — open the song page
      e.preventDefault();
      collapseRows(row);
      row.classList.add('expanded');
      const rank = parseInt(row.dataset.rank, 10);
      if (rank >= 1 && rank <= 20) {
        if (ch !== 0) document.querySelector('#channelTabs button[data-ch="0"]').click();
        load(rank - 1, true);
      }
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });
  document.querySelectorAll('.riserspanel .rowlink').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.artistlink')) return;
      if (row.classList.contains('expanded')) return; // second click — open the song page
      e.preventDefault();
      collapseRows(row);
      row.classList.add('expanded');
      previewOn = true;
      audio.src = row.dataset.audio;
      $('barThumb').src = row.dataset.cover;
      $('barTitle').textContent = row.dataset.title;
      $('barArtist').textContent = row.dataset.artist;
      audio.play().catch(() => {});
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });
  renderRings(); load(0, false); startShowcase();
  </script>` : `<div class="panel"><h2>No songs yet</h2><p class="sub">Run the seed or upload the first song.</p></div>`}`;
  res.send(layout("The Stage", "stage", body, {
    home: true,
    meta: first ? {
      title: "TOP 20 — The Stage",
      description: `Now playing the National Overall Top 20. #1 today: "${first.title}" by ${first.artist}. The rotation plays the Top 20 in order, 1 through 20, 24 hours a day.`,
      image: absUrl(req, "/fb-poster.jpg"),
      imageW: 960,
      imageH: 540,
      type: "video.other",
      video: absUrl(req, "/hero.mp4"),
      videoW: 960,
      videoH: 540,
    } : {},
  }));
});

app.post("/api/play/:id", (req, res) => {
  db.prepare(
    `INSERT INTO engagements (song_id, type, count) VALUES (?, 'play', 1)
     ON CONFLICT(song_id, type) DO UPDATE SET count = count + 1`
  ).run(req.params.id);
  res.json({ ok: true });
});

/* --------------------------------- Charts --------------------------------- */

app.get("/charts", (req, res) => {
  const date = latestChartDate(db);
  const prevDate = date ? previousChartDate(db, date) : null;
  const CHART_GENRES = [...GENRES, OVERALL];
  const level = ["local", "regional", "national"].includes(req.query.level) ? req.query.level : "national";
  const genre = CHART_GENRES.includes(req.query.genre) ? req.query.genre : OVERALL;

  let regionKey = "ALL";
  let regionKeys = [];
  if (date && level !== "national") {
    regionKeys = db.prepare(
      "SELECT DISTINCT region_key FROM chart_entries WHERE chart_date = ? AND level = ? AND genre = ? ORDER BY region_key"
    ).all(date, level, genre).map((r) => r.region_key);
    const fallback = level === "local" ? "Dallas, TX" : "South";
    regionKey = regionKeys.includes(req.query.region_key) ? req.query.region_key
      : regionKeys.includes(fallback) ? fallback : regionKeys[0];
  }

  const tier = [5, 10, 20].includes(Number(req.query.tier)) ? Number(req.query.tier) : 20;
  const entries = regionKey ? chartEntriesFor(date, level, genre, regionKey, 100) : [];
  const ctx = chartContext(date, level, genre, regionKey);
  const prevMap = prevRankMap(ctx, level, genre, regionKey);
  const chartNewHtml = newEntriesSection("chartNe", newEntryRows(date, level, genre, regionKey, ctx));
  const chartRisersHtml = regionKey ? risersHtml(topRisers(date, level, genre, regionKey)) : "";

  const qs = (over) => {
    const p = new URLSearchParams({ level, genre, tier: String(tier), ...over });
    if (level !== "national" && regionKey) p.set("region_key", regionKey);
    return `/charts?${p.toString()}`;
  };
  const levelTabs = ["local", "regional", "national"].map((l) =>
    `<a href="${qs({ level: l })}" class="${l === level ? "active" : ""}">${cap(l)}</a>`).join("");
  const genrePills = CHART_GENRES.map((g) =>
    `<a href="${qs({ genre: g })}" class="${g === genre ? "active" : ""}">${esc(g)}</a>`).join("");
  const tierTabs = [5, 10, 20].map((t) =>
    `<a href="${qs({ tier: String(t) })}" class="${t === tier ? "active" : ""}">Top ${t}</a>`).join("");
  const regionForm = level !== "national" && regionKeys.length ? `
    <form method="get" action="/charts" style="display:flex;gap:8px;margin-top:10px">
      <input type="hidden" name="level" value="${level}">
      <input type="hidden" name="genre" value="${esc(genre)}">
      <input type="hidden" name="tier" value="${tier}">
      <select name="region_key" style="margin:0;flex:1">${regionKeys.map((k) =>
        `<option value="${esc(k)}" ${k === regionKey ? "selected" : ""}>${esc(k)}</option>`).join("")}</select>
      <button class="btn" type="submit" style="min-height:46px">Go</button>
    </form>` : "";

  const topHtml = entries.slice(0, tier).map((e, i) =>
    i === 0 ? heroRow(e, ctx, prevMap) : billboardRow(e, ctx, prevMap)).join("");

  // Two-click rows on the charts too (owner request): first click lifts the
  // row and PLAYS the song in this page's player bar (the chart the visitor
  // is looking at becomes the queue); second click opens the song page.
  const audioMap = {};
  if (entries.length) {
    const ids = entries.map((e) => e.song_id).join(",");
    for (const r of db.prepare(`SELECT id, audio_path FROM songs WHERE id IN (${ids})`).all()) audioMap[r.id] = r.audio_path;
  }
  const chartQ = entries.map((e) => ({ id: e.song_id, title: e.title, artist: e.artist, cover: e.cover_path, audio: audioMap[e.song_id] || "" }));
  const chartPlayer = entries.length ? `
  <div class="playerbar"><div class="panel">
    <img id="cBarThumb" src="${esc(entries[0].cover_path)}" alt="">
    <div class="meta"><div class="t" id="cBarTitle">${esc(entries[0].title)}</div><div class="a" id="cBarArtist">${esc(entries[0].artist)}</div></div>
    <button type="button" class="playbtn" id="cPlayBtn" aria-label="Play or pause">▶</button>
    <audio id="cAudio" preload="none"></audio>
  </div></div>
  <script>
  (function(){
    var Q = ${JSON.stringify(chartQ).replace(/</g, "\\u003c")};
    var byId = {}; Q.forEach(function(s, i){ byId[s.id] = i; });
    var audio = document.getElementById('cAudio');
    var btn = document.getElementById('cPlayBtn');
    var cur = -1;
    function paint(){ var s = Q[cur]; if (!s) return;
      document.getElementById('cBarThumb').src = s.cover;
      document.getElementById('cBarTitle').textContent = s.title;
      document.getElementById('cBarArtist').textContent = s.artist; }
    function playAt(i){ if (i < 0 || i >= Q.length || !Q[i].audio) return; cur = i;
      audio.src = Q[i].audio; audio.play().catch(function(){});
      fetch('/api/play/' + Q[i].id, { method: 'POST' }).catch(function(){});
      paint(); }
    audio.addEventListener('play', function(){ btn.textContent = '❚❚'; });
    audio.addEventListener('pause', function(){ btn.textContent = '▶'; });
    audio.addEventListener('ended', function(){ if (cur >= 0 && cur < Q.length - 1) playAt(cur + 1); });
    btn.addEventListener('click', function(){
      if (cur < 0) { playAt(0); return; }
      if (audio.paused) audio.play().catch(function(){}); else audio.pause();
    });
    document.querySelectorAll('.rowlink').forEach(function(row){
      row.addEventListener('click', function(e){
        if (e.target.closest('.artistlink')) return;
        if (row.classList.contains('expanded')) return;
        var sid = row.getAttribute('data-song');
        if (!sid || !(sid in byId)) return;
        e.preventDefault();
        document.querySelectorAll('.rowlink.expanded').forEach(function(x){ if (x !== row) x.classList.remove('expanded'); });
        row.classList.add('expanded');
        playAt(byId[sid]);
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    });
  })();
  </script>` : "";

  const body = `
  <h1>${cap(level)} Top 20 — ${esc(genre)}</h1>
  <div class="chartdate">Today's Top 20 — ${fmtChartDate(date)}</div>
  <p class="sub">${level === "national" ? "The whole country." : level === "regional" ? "Your region: " + esc(regionKey || "") + "." : "Your city chart: " + esc(regionKey || "") + "."}
  ${prevDate ? `Movement vs ${esc(prevDate)}.` : ""} Ranked by craft first — popularity alone never tops this chart.</p>
  <div class="tabs">${levelTabs}</div>
  <div class="tabs">${genrePills}</div>
  ${regionForm}
  ${chartNewHtml}
  <div class="tabs" style="margin-top:10px">${tierTabs}</div>
  <div class="panel"><h2 style="margin-top:0">Top ${tier}</h2>
    ${topHtml || `<p class="sub">No songs on this chart yet.</p>`}
  </div>
  ${chartRisersHtml}
  ${entries.length > 20 ? `<div class="panel"><h2 style="margin-top:0">Extended rankings — Top 100</h2>
    <p class="sub">Standing, not charting: no Stage play yet — but any day these can pop into the Top 20.</p>
    ${entries.slice(20, 100).map((e) => billboardRow(e, ctx, prevMap)).join("")}</div>` : ""}
  ${chartPlayer}`;
  res.send(layout("Charts", "charts", body, {
    meta: {
      title: `${cap(level)} ${genre} Top 20 — TOP 20`,
      description: `Today's ${cap(level)} ${genre} Top 20 on TOP 20 — ranked by craft first, recalculated daily. Only songs uploaded to TOP 20 are ever judged.`,
      image: entries.length ? absUrl(req, entries[0].cover_path) : "",
    },
  }));
});

/* ---------------------------------- Song ---------------------------------- */

// The share-my-position card image (Dale's spec): composed live from
// today's chart. Uncharted songs (or an unreadable cover) fall back to
// the plain cover, so a share never breaks.
// Homepage share poster: the hero video's face with the rollout clock
// banded across the bottom — Dale wants the clock seen wherever the
// homepage link gets posted. Baked in as data (fbposter-data.js) and
// served from memory, same pattern as the hero video: the live server
// would not render it on demand, so it ships pre-rendered. The band
// carries the landing date instead of a day count, so it never goes
// stale; the ticking clock itself lives on the page.
let fbPosterBuf = null;
try { fbPosterBuf = Buffer.from(require("./fbposter-data"), "base64"); } catch { fbPosterBuf = null; }
app.get("/fb-poster.jpg", (req, res) => {
  if (!fbPosterBuf) return res.redirect(302, "/hero-poster.jpg");
  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", "public, max-age=3600");
  res.send(fbPosterBuf);
});

app.get("/card/:id.jpg", async (req, res) => {
  const song = db.prepare(`
    SELECT s.*, u.name AS artist FROM songs s JOIN users u ON u.id = s.artist_id WHERE s.id = ?
  `).get(req.params.id);
  if (!song) return res.status(404).end();
  const standing = sharecard.headlineStanding(db, song.id);
  if (!standing) return res.redirect(song.cover_path);
  const coverAbs = [path.join(__dirname, "public", song.cover_path), path.join(__dirname, song.cover_path)]
    .find((p) => fs.existsSync(p));
  if (!coverAbs) return res.redirect(song.cover_path);
  try {
    const buf = await sharecard.renderCard({
      songId: song.id, title: song.title, artist: song.artist,
      coverAbs, standing, chartDate: latestChartDate(db),
    });
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(buf);
  } catch {
    res.redirect(song.cover_path);
  }
});

app.get("/song/:id", (req, res) => {
  const song = db.prepare(`
    SELECT s.*, u.name AS artist, u.city, u.state, u.email
    FROM songs s JOIN users u ON u.id = s.artist_id WHERE s.id = ?
  `).get(req.params.id);
  if (!song) return res.status(404).send(layout("Not found", "", `<div class="panel"><h2>Song not found</h2></div>`));
  const judge = db.prepare("SELECT * FROM judge_scores WHERE song_id = ?").get(song.id);
  const eng = {};
  for (const r of db.prepare("SELECT type, count FROM engagements WHERE song_id = ?").all(song.id)) eng[r.type] = r.count;
  const fanBonus = supportBonus(eng.like || 0, eng.share || 0);
  const dc = daysCharted(song.id);
  const dcNew = dc.days > 0 && dc.first === latestChartDate(db);
  const { ranks } = songRanks(song.id);
  // Share-my-position (Dale's spec): the headline standing drives the
  // badge on this page, the words in the share sheet, and the card image
  // other sites show. No standing in the Top 100 — no badge, plain share.
  const headline = sharecard.headlineStanding(db, song.id);
  const headlineLabel = headline ? sharecard.chartLabelText(headline) : null;
  const headlineTier = headline ? (headline.rank <= 20 ? 20 : 100) : null;
  const shareText = headline
    ? `${headline.rank <= 20 ? "🔥" : "🎵"} #${headline.rank} on the ${headlineLabel} Top ${headlineTier} — "${song.title}" by ${song.artist}. Listen on TOP 20:`
    : null;
  const standingBadge = headline ? `<p style="margin:2px 0 10px"><span style="display:inline-block;background:linear-gradient(180deg,#ffdf8e,#f5b921);color:#231a00;font-weight:900;padding:${headline.rank <= 20 ? "9px 18px" : "6px 13px"};border-radius:999px;font-size:${headline.rank <= 20 ? "17px" : "13.5px"};letter-spacing:.4px">🏆 #${headline.rank} · ${esc(headlineLabel)} TOP ${headlineTier}</span></p>` : "";
  const songUrlAbs = absUrl(req, `/song/${song.id}`);
  const shareWords = shareText || `"${song.title}" by ${song.artist} — TOP 20`;
  const encSongUrl = encodeURIComponent(songUrlAbs);
  const encShareWords = encodeURIComponent(shareWords);
  const encWaText = encodeURIComponent(shareWords + " " + songUrlAbs);
  const myPick = db.prepare("SELECT pick_date FROM dj_picks WHERE song_id = ? ORDER BY pick_date DESC LIMIT 1").get(song.id);
  const pickChip = myPick
    ? `<p style="margin:2px 0 10px"><span class="picktag" style="font-size:11px;padding:4px 11px">${myPick.pick_date === latestPickDate() ? "🎧 DJ's Hot Pick — this week" : "🎧 DJ's Hot Pick — " + fmtChartDate(myPick.pick_date)}</span></p>`
    : "";
  const songVideo = db.prepare(`
    SELECT v.*, s.title AS song_title FROM videos v
    JOIN songs s ON s.id = v.song_id WHERE v.song_id = ? ORDER BY v.id DESC LIMIT 1
  `).get(song.id);
  const removedNote = song.status !== "live"
    ? `<div class="panel"><p class="sub" style="margin:0">This song has been removed by the artist — only live songs are judged and charted.</p></div>` : "";
  const body = `
  <div class="chrome-frame songcover"><div class="panel" style="padding:10px">
    <img class="cover" src="${esc(song.cover_path)}" alt="cover">
  </div></div>
  <h1>${esc(song.title)}</h1>
  <p class="sub"><a href="/artist/${song.artist_id}" style="color:var(--accent);font-weight:700;text-decoration:none">${esc(song.artist)}</a> · ${esc(song.genre)} · ${esc(song.city)}, ${esc(song.state)}</p>
  ${pickChip}
  ${standingBadge}
  ${removedNote}
  <audio controls preload="metadata" src="${esc(song.audio_path)}"></audio>
  <div class="flexbtns">
    <form id="likeForm" method="post" action="/song/${song.id}/engage"><input type="hidden" name="type" value="like"><button class="btn" type="submit" id="likeBtn">♥ <span id="likeLabel">Like</span> (<span id="likeCount">${fmtNum(eng.like || 0)}</span>)</button></form>
    <form id="shareForm" method="post" action="/song/${song.id}/engage"><input type="hidden" name="type" value="share"><button class="btn" type="submit">⤴ Share (${fmtNum(eng.share || 0)})</button></form>
  </div>
  <p class="sub" id="shareMsg" style="margin-top:6px"></p>
  <div class="panel" style="padding:12px 14px">
    <p class="sub" style="margin:0">🔥 <b style="color:#fff">Fan Bonus: +${fanBonus.toFixed(1)}</b> — the likes and shares on this page are a <b style="color:#fff">bonus</b> on top of the chart score (up to +6, counted at the midnight chart change). ♥ ${fmtNum(eng.like || 0)} likes · ⤴ ${fmtNum(eng.share || 0)} shares so far — every one helps this song climb.</p>
  </div>
  <div id="shareMenu" class="panel" style="display:none;padding:12px;margin-top:2px">
    <p class="sub" style="margin:0 0 10px"><b style="color:#fff">Share this song</b> — pick where it goes:</p>
    <div style="display:grid;gap:8px">
      <a data-dest="facebook" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${encSongUrl}" style="display:block;padding:13px 14px;border-radius:10px;border:1px solid #3a4a6b;background:#0d1730;color:#fff;font-weight:700;text-decoration:none">📘&nbsp; Share to Facebook</a>
      <a data-dest="whatsapp" target="_blank" rel="noopener" href="https://wa.me/?text=${encWaText}" style="display:block;padding:13px 14px;border-radius:10px;border:1px solid #3a4a6b;background:#0d1730;color:#fff;font-weight:700;text-decoration:none">💬&nbsp; Share to WhatsApp</a>
      <a data-dest="x" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=${encShareWords}&url=${encSongUrl}" style="display:block;padding:13px 14px;border-radius:10px;border:1px solid #3a4a6b;background:#0d1730;color:#fff;font-weight:700;text-decoration:none">✖️&nbsp; Share to X</a>
      <button type="button" id="shareCopy" style="display:block;width:100%;font:inherit;text-align:left;cursor:pointer;padding:13px 14px;border-radius:10px;border:1px solid #3a4a6b;background:#0d1730;color:#fff;font-weight:700">🔗&nbsp; Copy the link</button>
      <button type="button" id="shareNative" style="display:none;width:100%;font:inherit;text-align:left;cursor:pointer;padding:13px 14px;border-radius:10px;border:1px solid #3a4a6b;background:#0d1730;color:#fff;font-weight:700">📲&nbsp; More options — Instagram and more</button>
    </div>
    <p class="note" style="margin:10px 0 0">Instagram sits under "More options" — that opens the share panel built into the phone, where Instagram lives.</p>
  </div>
  <div class="statstrip">
    <div class="stat"><b>${fmtNum(eng.play || 0)}</b><span>plays</span></div>
    <div class="stat"><b>${fmtNum(eng.share || 0)}</b><span>shares</span></div>
    <div class="stat"><b>${fmtNum(eng.like || 0)}</b><span>likes</span></div>
    <div class="stat"><b>${dcNew ? "Day 1" : dc.days > 0 ? dc.days : "—"}</b><span>${dcNew ? "🔥 new entry" : dc.days > 0 ? "days charted" : "not charted yet"}</span></div>
  </div>
  <script>
  (function(){
    var form = document.getElementById('shareForm');
    var menu = document.getElementById('shareMenu');
    var msg = document.getElementById('shareMsg');
    var likeForm = document.getElementById('likeForm');
    if (likeForm) {
      var likeKey = 't20-liked-${song.id}';
      var likeCountEl = document.getElementById('likeCount');
      var likeLabelEl = document.getElementById('likeLabel');
      var likeBtnEl = document.getElementById('likeBtn');
      var likedNow = false;
      try { likedNow = !!localStorage.getItem(likeKey); } catch (e) {}
      var paintLike = function(){
        if (likeLabelEl) likeLabelEl.textContent = likedNow ? 'Liked' : 'Like';
        if (likeBtnEl) likeBtnEl.style.borderColor = likedNow ? '#ffc44d' : '';
      };
      paintLike();
      likeForm.addEventListener('submit', function(ev){
        ev.preventDefault();
        var going = likedNow ? 'unlike' : 'like';
        likedNow = !likedNow;
        try { if (likedNow) localStorage.setItem(likeKey, '1'); else localStorage.removeItem(likeKey); } catch (e) {}
        if (likeCountEl) {
          var n = parseInt(likeCountEl.textContent.replace(/[^0-9]/g, ''), 10) || 0;
          likeCountEl.textContent = Math.max(0, n + (likedNow ? 1 : -1)).toLocaleString('en-US');
        }
        paintLike();
        try { fetch(likeForm.action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'type=' + going, keepalive: true }); } catch (e) {}
      });
    }
    if (!form || !menu) return;
    var url = location.origin + '/song/${song.id}';
    var shareCount = ${Number(eng.share || 0)};
    var counted = false;
    function count(){
      if (counted) return; counted = true; shareCount++;
      var b = form.querySelector('button');
      if (b) b.textContent = '⤴ Share (' + shareCount.toLocaleString('en-US') + ')';
      try {
        fetch('/song/${song.id}/engage', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'type=share', keepalive: true });
      } catch (e) {}
    }
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var open = menu.style.display !== 'none';
      menu.style.display = open ? 'none' : 'block';
      if (!open) menu.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    var dests = menu.querySelectorAll('[data-dest]');
    for (var i = 0; i < dests.length; i++) {
      dests[i].addEventListener('click', function(){ count(); msg.textContent = 'Opening your pick — thanks for spreading the word.'; });
    }
    function fallbackCopy(done){
      var ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); done();
    }
    var copyBtn = document.getElementById('shareCopy');
    if (copyBtn) copyBtn.addEventListener('click', function(){
      var done = function(){ count(); msg.textContent = 'Link copied — paste it anywhere you like.'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function(){ fallbackCopy(done); });
      } else { fallbackCopy(done); }
    });
    var nativeBtn = document.getElementById('shareNative');
    if (nativeBtn && navigator.share) {
      nativeBtn.style.display = 'block';
      nativeBtn.addEventListener('click', function(){
        navigator.share({ title: document.title, text: ${JSON.stringify(shareText)} || document.title, url: url }).then(function(){
          count(); msg.textContent = 'Shared — thanks for spreading the word.';
        }, function(){});
      });
    }
  })();
  </script>
  ${songVideo ? videoDisplayHtml(songVideo) : ""}
  <div class="panel">
    <div class="sub" style="letter-spacing:2px;text-transform:uppercase;font-size:11px">Craft score</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-top:4px">
      <span class="craftbig">${judge.craft_score}</span><span class="sub">/ 100 · total ${judge.total_score} / 150 across the 15 judges</span>
    </div>
    ${scoreBars(judge)}
  </div>
  <div class="panel">
    <h2 style="margin-top:0">Where it stands</h2>
    ${rankLines(ranks)}
    <p class="note" style="margin-top:10px">Only the Top 20 plays on the Stage. Any day, this song can pop in.</p>
  </div>
  ${song.lyrics ? `<div class="panel"><h2 style="margin-top:0">Lyrics</h2><p class="sub" style="white-space:pre-wrap">${esc(song.lyrics)}</p></div>` : ""}`;
  res.send(layout(song.title, "", body, {
    meta: {
      title: `"${song.title}" by ${song.artist} — TOP 20`,
      description: headline
        ? `#${headline.rank} on the ${headlineLabel} Top ${headlineTier} — "${song.title}" by ${song.artist} on TOP 20. Craft score ${judge.craft_score}/100 across the 15 judges — judged only because it was uploaded here.`
        : `${song.artist} · ${song.genre} · ${song.city}, ${song.state}. Craft score ${judge.craft_score}/100 across the 15 judges on TOP 20 — judged only because it was uploaded here.`,
      type: "music.song",
      image: headline ? absUrl(req, `/card/${song.id}.jpg`) : absUrl(req, song.cover_path),
    },
  }));
});

app.post("/song/:id/engage", (req, res) => {
  if (req.body.type === "unlike") {
    // Taking a like back: the Like button is a toggle — one like per
    // visitor, tap again to undo it. Never below zero.
    db.prepare("UPDATE engagements SET count = MAX(count - 1, 0) WHERE song_id = ? AND type = 'like'").run(req.params.id);
    return res.redirect(`/song/${req.params.id}`);
  }
  const type = ["like", "save", "share"].includes(req.body.type) ? req.body.type : "like";
  db.prepare(
    `INSERT INTO engagements (song_id, type, count) VALUES (?, ?, 1)
     ON CONFLICT(song_id, type) DO UPDATE SET count = count + 1`
  ).run(req.params.id, type);
  res.redirect(`/song/${req.params.id}`);
});

/* --------------------------------- Upload --------------------------------- */

const songDisk = multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === "audio" ? AUDIO_UP : COVER_UP),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || "").toLowerCase().replace(/[^.a-z0-9]/g, "")
      || (file.fieldname === "audio" ? ".mp3" : ".png");
    cb(null, `${file.fieldname}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${ext}`);
  },
});
const upload = multer({ storage: songDisk, limits: { fileSize: 40 * 1024 * 1024 } });

app.get("/upload", (req, res) => {
  const checkEmail = String(req.query.email || "").trim().toLowerCase();
  let profileStatus = "";
  if (checkEmail) {
    const u = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(checkEmail);
    if (hasProfile(u)) {
      const miss = missingSocials(u);
      profileStatus = `<p class="note" style="color:#9fe8b6">✔ Profile found: <b style="color:#fff">${esc(u.name)}</b> · ${esc(u.city)}, ${esc(u.state)} — your uploads will post under this profile.</p>` +
        (miss.length
          ? `<p class="note" style="color:#ffd98a">⚠ Your profile is missing your ${miss.join(", ")} — the judging system searches those platforms to locate you. <a href="/profile?email=${encodeURIComponent(checkEmail)}" style="color:var(--accent);font-weight:700">Add them here →</a></p>`
          : `<p class="note" style="color:#9fe8b6">✔ Socials on file — the judging system can find you on Facebook, Instagram and TikTok.</p>`);
    } else {
      profileStatus = `<p class="note" style="color:#ffb3b3">No profile on file for ${esc(checkEmail)} yet. <a href="/profile?email=${encodeURIComponent(checkEmail)}" style="color:var(--accent);font-weight:700">Set up your profile first →</a></p>`;
    }
  }
  const body = `
  <h1>Upload your song</h1>
  <p class="sub">Song uploads are <b style="color:#fff">FREE right now</b>. Your song is judged on the 15 craft criteria the moment it lands, then ranked on your Local, Regional, National and Overall charts. Only songs uploaded to TOP 20 are ever judged or charted — nothing is imported from outside. <b style="color:#fff">Real artists only:</b> the voice on the song has to be really you — no AI artists, no AI vocals. A producer may use AI tools, but he still has to produce the song — prompting a machine to generate the whole instrumental is not producing. If a song is found to have an AI artist, or a fully generated instrumental passed off as produced, it is pulled from the Top 20 and the Top 100 immediately.</p>
  <div class="panel">
    <h2 style="margin-top:0">First — your profile</h2>
    <p class="sub"><b style="color:#fff">No profile, no recognition</b> — you need a profile page and at least one song uploaded to get recognized. Your artist name, home city and state come from your profile.</p>
    <form method="get" action="/upload">
      <label>Check your profile by email<input name="email" type="email" value="${esc(checkEmail)}" placeholder="you@example.com"></label>
      <button class="btn btn-block" type="submit">Check my profile</button>
    </form>
    ${profileStatus}
    <p style="margin:10px 0 2px"><a class="btn btn-blue btn-block" href="/profile${checkEmail ? `?email=${encodeURIComponent(checkEmail)}` : ""}">Set up / edit my profile</a></p>
  </div>
  <div class="panel">
    <form method="post" action="/upload" enctype="multipart/form-data">
      <label>Song title<input name="title" required maxlength="120"></label>
      <label>Your email (must match your profile)<input name="email" type="email" required maxlength="120" value="${esc(checkEmail)}"></label>
      <label>Genre<select name="genre">${GENRES.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("")}</select></label>
      <label>Lyrics (optional)<textarea name="lyrics" rows="4"></textarea></label>
      <label>Audio file — required, radio quality only<input name="audio" type="file" accept="audio/*" required></label>
      <p class="note">Radio quality only: WAV or FLAC, or MP3 / M4A at 192 kbps or better — the same quality radio stations send and accept. Lower-quality files are turned away.</p>
      <label>Cover art — REQUIRED<input name="cover" type="file" accept="image/*" required></label>
      <p class="note">No cover, no upload, no judging, no chart. Every song must have its CD-style cover.</p>
      <p class="note">Your cover is judged too — it's one of the 15 points. Artists who believe in themselves put in the work: quality artwork helps your score; anything slapped together will hurt it.</p>
      <p class="note">You can only have two songs live at a time — those are the only songs that get judged. Remove one from your Dashboard to put another up.</p>
      <div class="panel" style="border-color:rgba(255,190,60,.55);text-align:left">
        <h3 style="margin-top:0">📜 Terms &amp; Conditions — read before you upload</h3>
        <ul class="rules">
          <li><b>Your song, your rights:</b> you certify this song is yours — you are the artist, or an authorized representative of the label — and you control the rights to upload it.</li>
          <li><b>The permission:</b> you grant Hot Top 20 <b>exclusive permission to add and play your song</b> on hottop20.com — streaming it on the Stage, placing it on the charts and in the rotation.</li>
          <li><b>Promotion:</b> Hot Top 20 may use the song, its cover art, and your artist name and profile on chart pages, share cards and platform promotion.</li>
          <li><b>Real artists only:</b> no AI artists, no AI vocals — a producer may use AI tools, but he still has to produce the song.</li>
          <li><b>Your music stays yours:</b> uploading grants the permission above — it does not transfer ownership of your song.</li>
          <li><b>Taking it down:</b> remove your song any time from your dashboard and it leaves the rotation and the charts at the next chart change.</li>
        </ul>
        <p class="note"><a href="/terms" style="color:var(--accent);font-weight:700;text-decoration:none">Read the full Terms &amp; Conditions →</a></p>
        <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" name="consent" value="yes" required style="width:20px;height:20px;margin-top:2px;flex:none">
          <span><b style="color:#fff">I agree to the Terms &amp; Conditions.</b> I am the artist or an authorized label representative for this song, and I grant Hot Top 20 exclusive permission to add and play it on this platform. My consent is recorded with this upload.</span>
        </label>
      </div>
      <button class="btn btn-blue btn-block" type="submit">Upload &amp; get judged</button>
    </form>
  </div>`;
  res.send(layout("Upload", "upload", body));
});

function uploadError(res, message) {
  return res.status(400).send(layout("Upload", "upload", `
  <div class="panel err"><h2 style="margin-top:0">Upload stopped</h2>
  <p class="sub" style="color:#fff;font-size:16px">${esc(message)}</p>
  <p><a class="btn" href="/upload">Back to upload</a></p></div>`));
}

function profileGate(res, emailLc) {
  return res.status(400).send(layout("Upload", "upload", `
  <div class="panel err"><h2 style="margin-top:0">Set up your profile first</h2>
  <p class="sub" style="color:#fff;font-size:16px">No profile, no recognition — you need a profile page and at least one song uploaded to get recognized.</p>
  <p class="sub">There's no artist profile on file for ${esc(emailLc)} yet. Build your profile page — it takes a minute — then come back and upload. Your music and your profile will speak for themselves.</p>
  <p><a class="btn btn-blue btn-block" href="/profile?email=${encodeURIComponent(emailLc)}">Create my profile</a></p>
  <p><a class="btn btn-block" href="/upload">Back to upload</a></p></div>`));
}

// Radio-quality gate (owner widened it Nov 1, 2026): TOP 20 takes what
// radio takes AND what radio SENDS — lossless WAV/FLAC at any bitrate,
// or MP3 / M4A at 192 kbps or better (>= 180 kbps allows for VBR
// reporting, so a true 192 never bounces). Radio copies go out at
// 192 / 256 / 320 and as M4A every day; the gate stopped knocking them
// off at the owner's word — he reviews quality personally from here.
function probeAudioQuality(absPath) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,bit_rate:format=bit_rate",
      "-of", "json", absPath,
    ], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    const stream = (parsed.streams || [])[0] || {};
    const streamRate = parseInt(stream.bit_rate, 10) || 0;
    const formatRate = parseInt((parsed.format || {}).bit_rate, 10) || 0;
    return {
      codec: String(stream.codec_name || "").toLowerCase(),
      bitRate: Math.max(streamRate, formatRate),
    };
  } catch {
    return { codec: "", bitRate: 0 };
  }
}

const LOSSLESS_CODECS = ["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_f64le", "pcm_u8", "flac", "alac"];
function isRadioQuality(q) {
  if (LOSSLESS_CODECS.includes(q.codec)) return true;
  if (q.codec === "mp3" || q.codec === "aac") return q.bitRate >= 180000;
  return false;
}

app.post("/upload", upload.fields([{ name: "audio", maxCount: 1 }, { name: "cover", maxCount: 1 }]), async (req, res) => {
  const audioFile = req.files?.audio?.[0];
  const coverFile = req.files?.cover?.[0];
  const cleanup = () => {
    for (const f of [audioFile, coverFile]) if (f) fs.unlink(f.path, () => {});
  };
  if (!req.body.consent) { cleanup(); return uploadError(res, "Upload stopped — the Terms & Conditions box wasn't checked. Hot Top 20 can only add and play a song with the artist's or label's permission on file, so that consent has to come first."); }
  if (!coverFile) { cleanup(); return uploadError(res, "Cover art is required — no cover, no upload, no judging, no chart."); }
  if (!audioFile) { cleanup(); return uploadError(res, "An audio file is required to upload a song."); }
  if (!isRadioQuality(probeAudioQuality(audioFile.path))) {
    cleanup();
    return uploadError(res, "That file isn't radio quality. Top 20 takes WAV or FLAC, or MP3 / M4A at 192 kbps or better — the same quality radio stations send and accept.");
  }
  const { title, email, genre, lyrics } = req.body;
  if (!title || !email || !GENRES.includes(genre)) {
    cleanup();
    return uploadError(res, "Please fill in the song title, your email, and a genre.");
  }

  const emailLc = String(email).trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(emailLc);
  // Recognition rule: no profile (artist name + home city on file), no upload.
  if (!hasProfile(user)) { cleanup(); return profileGate(res, emailLc); }

  // Hard rule: at most 2 live songs per artist — only live songs get judged.
  const liveCount = db.prepare(
    "SELECT COUNT(*) AS c FROM songs WHERE artist_id = ? AND status = 'live'"
  ).get(user.id).c;
  if (liveCount >= 2) {
    cleanup();
    return uploadError(res, "You can only have two songs live at a time — those are the only songs that get judged. Remove one to put another up.");
  }

  const audioWeb = `/uploads/audio/${audioFile.filename}`;
  const coverWeb = `/uploads/covers/${coverFile.filename}`;
  const songInfo = db.prepare(
    "INSERT INTO songs (artist_id, title, genre, audio_path, cover_path, lyrics, status, consent_at, consent_by) VALUES (?, ?, ?, ?, ?, ?, 'live', datetime('now'), ?)"
  ).run(user.id, title.trim(), genre, audioWeb, coverWeb, lyrics ? String(lyrics) : null, user.email);
  const songId = Number(songInfo.lastInsertRowid);

  // Judge v2 (measured): the spectrum analyzer reads the real file and the
  // genre templates score it. If a file can't be measured, Judge v1 covers
  // that one song so an upload never fails on the judging step.
  let judged = null;
  try { judged = await judgeMeasuredFile(audioFile.path, genre, coverFile.path, lyrics ? String(lyrics) : null, title ? String(title) : null); } catch { judged = null; }
  if (!judged) judged = judgeAudioFile(audioFile.path, coverFile.path);
  const catCols = CATEGORIES.map((c) => c.key).join(", ");
  const placeholders = CATEGORIES.map(() => "?").join(", ");
  db.prepare(
    `INSERT INTO judge_scores (song_id, ${catCols}, total_score, craft_score, notes) VALUES (?, ${placeholders}, ?, ?, ?)`
  ).run(songId, ...CATEGORIES.map((c) => judged.scores[c.key]), judged.totalScore, judged.craftScore, JSON.stringify(judged.notes));
  db.prepare("INSERT INTO engagements (song_id, type, count) VALUES (?, 'play', 0), (?, 'like', 0), (?, 'share', 0), (?, 'save', 0)")
    .run(songId, songId, songId, songId);

  mirrorUpload(audioFile.path); mirrorUpload(coverFile.path); snapshotDbSoon();
  const result = recalc(db);
  const myNotifications = result.notifications.filter((n) => n.song_id === songId);
  const judge = db.prepare("SELECT * FROM judge_scores WHERE song_id = ?").get(songId);
  const { ranks } = songRanks(songId);

  const emailsHtml = myNotifications.length ? `
  <div class="panel">
    <h2 style="margin-top:0">✉️ You charted — email sent</h2>
    ${myNotifications.map((n) => `
      <p class="sub" style="margin-top:12px"><b style="color:#fff">To:</b> ${esc(user.email)}<br>
      <b style="color:#fff">Subject:</b> ${esc(emailSubject(n))}</p>
      <p class="note">${esc(emailBody(n, user.name, title.trim(), result.date))}</p>`).join("")}
  </div>` : `
  <div class="panel"><h2 style="margin-top:0">Not in a Top 20 — yet</h2>
  <p class="sub">No chart email this time. Your exact ranks are below — charts recalculate daily, and any day you can pop into the Top 20. If you fall out later, we won't email that either: come back and check.</p></div>`;

  const body = `
  <h1>Judged &amp; ranked</h1>
  <p class="sub">"${esc(title)}" by ${esc(user.name)} was judged on all 15 criteria — cover art included — and placed on today's charts.</p>
  <div class="panel">
    <div class="sub" style="letter-spacing:2px;text-transform:uppercase;font-size:11px">Craft score</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-top:4px">
      <span class="craftbig">${judge.craft_score}</span><span class="sub">/ 100 · total ${judge.total_score} / 150</span>
    </div>
    ${scoreBars(judge)}
    <p style="margin-top:14px"><a class="btn btn-blue btn-block" href="/song/${songId}">Open your song page</a></p>
  </div>
  <div class="panel"><h2 style="margin-top:0">Your ranks today</h2>${rankLines(ranks)}</div>
  ${emailsHtml}`;
  res.send(layout("Upload result", "upload", body));
});

/* --------------------------- Artist profiles ------------------------------ */

const PHOTO_UP = path.join(PUBLIC_DIR, "uploads", "photos");
fs.mkdirSync(PHOTO_UP, { recursive: true });
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTO_UP),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || "").toLowerCase().replace(/[^.a-z0-9]/g, "") || ".png";
      cb(null, `photo-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

function findOrCreateShell(emailLc) {
  let user = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(emailLc);
  if (!user) {
    const buzz = 20 + (crypto.createHash("sha256").update(emailLc).digest()[0] % 60);
    const info = db.prepare(
      "INSERT INTO users (name, email, city, state, region, buzz_score) VALUES ('', ?, '', '', 'South', ?)"
    ).run(emailLc, buzz);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(info.lastInsertRowid));
  }
  return user;
}

const RULES_PANEL = `
  <div class="ne">
    <div class="ne-banner">THE RULES OF TOP 20</div>
    <ul class="rules" style="margin-bottom:2px">
      <li>A <b>profile page + at least one song uploaded</b> is how you get recognized.</li>
      <li><b>Add your Facebook, Instagram and TikTok</b> to your profile — the judging system searches them to locate you and your music. No socials on file, and the system can't find you.</li>
      <li><b>Two live songs max</b> — those are the only songs that get judged. Remove one to put another up.</li>
      <li>Every song needs its <b>cover — and the cover is judged too</b>, one of the 15 points.</li>
      <li>Every uploaded song is judged on the <b>same 15 points</b>, 1–10 each.</li>
      <li>Audio must be <b>radio quality</b> — WAV or FLAC, or MP3 / M4A at 192 kbps or better, the same quality radio stations send and accept.</li>
      <li>New charts land at <b>12:00 midnight</b>, every night.</li>
      <li>The only chart email is the <b>entry email</b> — when you enter a Top 20. Falling off is never emailed.</li>
      <li><b>No pay, no labels</b> can move a song — the algorithm decides, and artists who believe in themselves put in the work. The one exception: <b>DJ's Hot Picks</b> — every Friday, a DJ panel steps 3 songs that are already hot into the Top 20, badged for all to see.</li>
    </ul>
  </div>`;

app.get("/profile", (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  const intro = `
  <h1>Your artist profile</h1>
  <p class="sub">This is a professional platform. Your profile speaks for you — build it like a major artist. No profile and no song uploaded means no recognition.</p>`;
  if (!email) {
    return res.send(layout("Profile", "profile", `${intro}
    <div class="panel">
      <form method="get" action="/profile">
        <label>Your email<input name="email" type="email" required placeholder="you@example.com"></label>
        <button class="btn btn-blue btn-block" type="submit">Load / create my profile</button>
      </form>
      <p class="note">Demo tip: the seeded artists' emails look like queen.nyla@example.com.</p>
    </div>
    ${RULES_PANEL}`));
  }
  const user = findOrCreateShell(email);
  const comp = profileCompleteness(user);
  const body = `${intro}
  ${req.query.err ? `<div class="panel" style="border-left:3px solid #ff9d9d"><p class="sub" style="margin:0;color:#ffb3b3">${esc(req.query.err)}</p></div>` : ""}
  ${req.query.saved ? `<div class="panel" style="border-left:3px solid #7dff9a"><p class="sub" style="margin:0;color:#c9ffd6">✓ <b style="color:#fff">Profile saved.</b> It's yours — come back any time to add to it, and put a song on it whenever your song is ready.</p></div>` : ""}
  <div class="panel">
    <p class="sub" style="margin:0">Profile for <b style="color:#fff">${esc(email)}</b> — ${comp.filled} of ${comp.total} fields complete.
    ${hasProfile(user) ? `<a href="/artist/${user.id}" style="color:var(--accent);font-weight:700;text-decoration:none">View your public profile →</a>` : "Add your artist name and home city to go public."}</p>
  </div>
  <div class="panel">
    <form method="post" action="/profile" enctype="multipart/form-data">
      <input type="hidden" name="email" value="${esc(email)}">
      <label>Artist name<input name="name" required maxlength="80" value="${esc(user.name || "")}"></label>
      <label>Home city<input name="city" required maxlength="60" value="${esc(user.city || "")}"></label>
      <label>Home state (2 letters)<input name="state" required maxlength="2" style="text-transform:uppercase" value="${esc(user.state || "")}"></label>
      <label>Your genre<select name="genre"><option value="">— choose —</option>${GENRES.map((g) => `<option value="${esc(g)}" ${user.genre === g ? "selected" : ""}>${esc(g)}</option>`).join("")}</select></label>
      <div style="border:1px solid rgba(255,190,60,.45);border-radius:12px;padding:12px 12px 4px;margin:14px 0;background:rgba(255,170,40,.05)">
        <p class="sub" style="margin:0 0 6px"><b style="color:#ffd98a">Where the judging system finds you.</b> Before your songs are judged, the system searches the platforms below to locate you and your music — have your <b style="color:#fff">Facebook, Instagram and TikTok</b> on file before you upload (paste the full link or just your handle). Your profile saves either way — add these whenever you're ready.</p>
        <label>Facebook profile<input name="facebook" maxlength="160" placeholder="facebook.com/yourname or your page link" value="${esc(user.facebook || "")}"></label>
        <label>Instagram<input name="instagram" maxlength="160" placeholder="@yourhandle or instagram.com/yourhandle" value="${esc(user.instagram || "")}"></label>
        <label>TikTok<input name="tiktok" maxlength="160" placeholder="@yourhandle or tiktok.com/@yourhandle" value="${esc(user.tiktok || "")}"></label>
        <label>YouTube channel (if you have one)<input name="youtube" maxlength="160" placeholder="youtube.com/@yourchannel" value="${esc(user.youtube || "")}"></label>
      </div>
      <label>Profile photo (optional — leave blank and you get a styled initial avatar)<input name="photo" type="file" accept="image/*"></label>
      ${user.photo_path ? `<p class="note">Current photo: ${esc(user.photo_path)}</p>` : ""}
      <label>Bio<textarea name="bio" rows="3" maxlength="600">${esc(user.bio || "")}</textarea></label>
      <label>Age (optional — leave blank to keep it private)<input name="age" type="number" min="1" max="120" value="${user.age ?? ""}"></label>
      <label>Years in the game (optional)<input name="years_in_game" type="number" min="0" max="80" value="${user.years_in_game ?? ""}"></label>
      <label>Your history — where you started, how you got here<textarea name="history" rows="6" maxlength="4000">${esc(user.history || "")}</textarea></label>
      <button class="btn btn-blue btn-block" type="submit">Save my profile</button>
    </form>
  </div>
  ${hasProfile(user) ? videoPanelHtml(user, "profile") : ""}
  ${RULES_PANEL}`;
  res.send(layout("Profile", "profile", body));
});

app.post("/profile", photoUpload.single("photo"), (req, res) => {
  const emailLc = String(req.body.email || "").trim().toLowerCase();
  if (!emailLc) return res.redirect("/profile");
  const user = findOrCreateShell(emailLc);
  const state = String(req.body.state || "").trim().toUpperCase().slice(0, 2);
  const parseOptInt = (v) => {
    const n = parseInt(String(v ?? "").trim(), 10);
    return Number.isFinite(n) ? n : null;
  };
  const genre = GENRES.includes(req.body.genre) ? req.body.genre : user.genre;
  const photoPath = req.file ? `/uploads/photos/${req.file.filename}` : user.photo_path;
  const socials = {
    facebook: String(req.body.facebook || "").trim().slice(0, 160),
    instagram: String(req.body.instagram || "").trim().slice(0, 160),
    tiktok: String(req.body.tiktok || "").trim().slice(0, 160),
    youtube: String(req.body.youtube || "").trim().slice(0, 160),
  };
  // Every profile SAVES (owner, Nov 1, 2026 — "just like Facebook"): a
  // missing social never throws the artist's information away. The save
  // always lands; the artist adds the rest whenever they're ready, and
  // comes back to put songs on the profile whenever a song is ready.
  db.prepare(
    `UPDATE users SET name = ?, city = ?, state = ?, region = ?, genre = ?, bio = ?,
       age = ?, years_in_game = ?, history = ?, photo_path = ?,
       facebook = ?, instagram = ?, tiktok = ?, youtube = ? WHERE id = ?`
  ).run(
    String(req.body.name || "").trim().slice(0, 80),
    String(req.body.city || "").trim().slice(0, 60),
    state,
    regionForState(state),
    genre || null,
    String(req.body.bio || "").trim().slice(0, 600) || null,
    parseOptInt(req.body.age),
    parseOptInt(req.body.years_in_game),
    String(req.body.history || "").trim().slice(0, 4000) || null,
    photoPath || null,
    socials.facebook || null, socials.instagram || null, socials.tiktok || null, socials.youtube || null,
    user.id
  );
  const saved = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  snapshotDbSoon();
  if (hasProfile(saved)) return res.redirect(`/artist/${user.id}?saved=1`);
  return res.redirect(`/profile?email=${encodeURIComponent(emailLc)}&saved=1`);
});

app.get("/artist/:id", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user || !hasProfile(user)) {
    return res.status(404).send(layout("Artist not found", "profile",
      `<div class="panel"><h2>Artist not found</h2><p class="sub">This profile isn't public yet.</p></div>`));
  }
  const date = latestChartDate(db);
  const songs = db.prepare(`
    SELECT s.*, j.craft_score FROM songs s JOIN judge_scores j ON j.song_id = s.id
    WHERE s.artist_id = ? AND s.status = 'live' ORDER BY s.id
  `).all(user.id);
  const bestToday = db.prepare(`
    SELECT level, genre, region_key, rank FROM chart_entries
    WHERE song_id = ? AND chart_date = ? AND rank <= 20 ORDER BY rank ASC LIMIT 1
  `);
  const anyToday = db.prepare(`
    SELECT MIN(rank) AS best FROM chart_entries WHERE song_id = ? AND chart_date = ?
  `);
  const where = (r) => r.level === "national" ? "National"
    : r.level === "regional" ? `Regional · ${r.region_key}` : `Local · ${r.region_key}`;
  const support = supportBySong(db);
  const songCards = songs.map((s) => {
    const sup = support.get(s.id) || { likes: 0, shares: 0 };
    const bonusChip = `<span class="chip">🔥 Fan Bonus <b>+${supportBonus(sup.likes, sup.shares).toFixed(1)}</b></span>`;
    const best = date ? bestToday.get(s.id, date) : null;
    const any = date ? anyToday.get(s.id, date) : null;
    const standing = best
      ? `<span class="chip">In the Top 20 — best <b>#${best.rank}</b> ${esc(cap(best.level))} ${esc(best.genre)}</span>`
      : any && any.best != null
        ? `<span class="chip">Best rank today <b>#${any.best}</b></span>`
        : `<span class="chip">Not ranked yet</span>`;
    return `<div class="panel">
      <a class="row" href="/song/${s.id}" style="border-bottom:none">
        <img class="thumb" src="${esc(s.cover_path)}" alt="">
        <span class="meta"><span class="t">${esc(s.title)}</span><br><span class="a">${esc(s.genre)} · Craft ${s.craft_score}</span></span>
      </a>
      <div class="chips">${standing} ${bonusChip}</div>
    </div>`;
  }).join("");
  const highlights = db.prepare(`
    SELECT level, genre, region_key, MIN(rank) AS best
    FROM chart_entries
    WHERE song_id IN (SELECT id FROM songs WHERE artist_id = ?) AND rank <= 20
    GROUP BY level, genre, region_key ORDER BY best ASC LIMIT 3
  `).all(user.id);
  const highlightsLine = highlights.length
    ? `<p class="sub"><b style="color:#fff">Chart highlights:</b> ${highlights.map((h) => `#${h.best} ${cap(h.level)} ${esc(h.genre)}${h.level === "national" ? "" : ` (${esc(h.region_key)})`}`).join(" · ")}</p>`
    : `<p class="sub"><b style="color:#fff">Chart highlights:</b> the first Top 20 entry is still ahead — charts recalculate daily.</p>`;
  const metaBits = [
    `${esc(user.city)}, ${esc(user.state)}`,
    user.genre ? esc(user.genre) : "",
    user.years_in_game != null ? `${user.years_in_game} year${user.years_in_game === 1 ? "" : "s"} in the game` : "",
    user.age != null ? `Age ${user.age}` : "", // age shows ONLY when the artist set it
  ].filter(Boolean).join(" · ");
  const profileVideo = artistVideo(user.id);
  const body = `
  ${req.query.saved ? `<div class="panel" style="border-left:3px solid #7dff9a"><p class="sub" style="margin:0;color:#c9ffd6">✓ <b style="color:#fff">Profile saved.</b> This page is yours — come back any time, and add songs whenever you're ready.</p></div>` : ""}
  <div class="panel">
    <div style="display:flex;gap:14px;align-items:center">
      ${avatarHtml(user)}
      <div style="min-width:0">
        <h1 style="margin:0">${esc(user.name)}</h1>
        <p class="sub" style="margin:4px 0 0">${metaBits}</p>
      </div>
    </div>
    ${highlightsLine}
    ${(() => {
      const links = [["facebook", "Facebook"], ["instagram", "Instagram"], ["tiktok", "TikTok"], ["youtube", "YouTube"]]
        .filter(([k]) => String(user[k] || "").trim())
        .map(([k, l]) => `<a href="${esc(socialUrl(k, user[k]))}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:700;text-decoration:none">${l}</a>`);
      return links.length ? `<p class="sub" style="margin-top:8px"><b style="color:#fff">Find them:</b> ${links.join(" · ")}</p>` : "";
    })()}
  </div>
  ${user.bio ? `<div class="panel"><h2 style="margin-top:0">About</h2><p class="sub" style="white-space:pre-wrap">${esc(user.bio)}</p></div>` : ""}
  ${user.history ? `<div class="panel"><h2 style="margin-top:0">History</h2><p class="sub" style="white-space:pre-wrap">${esc(user.history)}</p></div>` : ""}
  ${profileVideo ? videoDisplayHtml(profileVideo) : ""}
  <h2 style="margin:16px 2px 4px">Live songs</h2>
  ${songCards || `<div class="panel"><p class="sub">No live songs yet — <a href="/upload">upload the first one</a> and get recognized.</p></div>`}`;
  res.send(layout(user.name, "profile", body, {
    meta: {
      title: `${user.name} — TOP 20 Artist`,
      description: `${user.name} · ${user.city}, ${user.state}${user.genre ? ` · ${user.genre}` : ""}. ${user.bio ? user.bio.slice(0, 140) : "Independent artist on TOP 20 — judged on craft, ranked daily."}`,
      type: "profile",
      image: absUrl(req, user.photo_path || (songs[0] && songs[0].cover_path) || ""),
    },
  }));
});

/* -------------------------------- Dashboard ------------------------------- */

app.get("/dashboard", (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  let content = `
  <h1>Artist dashboard</h1>
  <p class="sub">Enter the email on your artist account to see every song's exact rank — including outside the Top 20 — and how far each one is from rotation. We email you when you chart. We never email a fall-off: this page is where you check.</p>
  <div class="panel">
    <form method="get" action="/dashboard">
      <label>Artist email<input name="email" type="email" value="${esc(email)}" placeholder="you@example.com"></label>
      <button class="btn btn-blue btn-block" type="submit">See my ranks</button>
    </form>
    <p class="note">Demo tip: try one of the seeded artist emails, e.g. queen.nyla@example.com or colton.ray@example.com.</p>
  </div>`;
  if (email) {
    const user = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(email);
    if (!user) {
      content += `<div class="panel"><h2 style="margin-top:0">No artist found</h2><p class="sub">No account uses ${esc(email)} yet. <a href="/upload">Upload a song</a> to create one.</p></div>`;
    } else {
      const songs = db.prepare(`
        SELECT s.*, j.craft_score FROM songs s JOIN judge_scores j ON j.song_id = s.id
        WHERE s.artist_id = ? ORDER BY s.id
      `).all(user.id);
      const live = songs.filter((s) => s.status === "live");
      const removed = songs.filter((s) => s.status !== "live");
      const comp = profileCompleteness(user);
      content += `<div class="panel"><h2 style="margin-top:0">${esc(user.name)}</h2>
        <p class="sub">${esc(user.city)}, ${esc(user.state)} · ${esc(user.region)} region · social buzz ${user.buzz_score}/100</p>
        <p class="sub"><b style="color:#fff">Song slots: ${live.length} of 2 used</b> — only live songs get judged. Remove one to put another up.</p>
        <p class="sub">Profile: ${comp.filled} of ${comp.total} fields complete.
        ${hasProfile(user)
          ? `<a href="/artist/${user.id}" style="color:var(--accent);font-weight:700;text-decoration:none">View your public profile →</a> · `
          : ""}<a href="/profile?email=${encodeURIComponent(user.email)}" style="color:var(--accent);font-weight:700;text-decoration:none">Edit profile →</a></p></div>`;
      if (hasProfile(user)) content += videoPanelHtml(user, "dashboard");
      for (const s of live) {
        const { ranks } = songRanks(s.id);
        content += `<div class="panel">
          <a class="row" href="/song/${s.id}" style="border-bottom:1px solid #232429">
            <img class="thumb" src="${esc(s.cover_path)}" alt="">
            <span class="meta"><span class="t">${esc(s.title)}</span><br><span class="a">${esc(s.genre)} · Craft ${s.craft_score}</span></span>
          </a>
          ${rankLines(ranks)}
          <form method="post" action="/dashboard/remove" style="margin-top:10px">
            <input type="hidden" name="email" value="${esc(user.email)}">
            <input type="hidden" name="song_id" value="${s.id}">
            <button class="btn btn-danger btn-block" type="submit">Remove song — free the slot</button>
          </form>
        </div>`;
      }
      if (!live.length) content += `<div class="panel"><p class="sub">No live songs right now. <a href="/upload">Upload one</a> — a profile page plus at least one song is how you get recognized.</p></div>`;
      for (const s of removed) {
        content += `<div class="panel" style="opacity:.65">
          <div class="row" style="border-bottom:none">
            <img class="thumb" src="${esc(s.cover_path)}" alt="">
            <span class="meta"><span class="t">${esc(s.title)}</span><br><span class="a">${esc(s.genre)} · Craft ${s.craft_score} · REMOVED — not judged, not charted</span></span>
          </div>
        </div>`;
      }
    }
  }
  res.send(layout("Dashboard", "dashboard", content));
});

// Remove a live song: frees one of the artist's two slots and takes the
// song out of judging and the charts via an immediate recalc.
app.post("/dashboard/remove", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const songId = Number(req.body.song_id);
  const user = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(email);
  if (user && Number.isFinite(songId)) {
    const song = db.prepare("SELECT * FROM songs WHERE id = ? AND artist_id = ?").get(songId, user.id);
    if (song && song.status === "live") {
      db.prepare("UPDATE songs SET status = 'removed' WHERE id = ?").run(song.id);
      recalc(db);
    }
  }
  res.redirect(`/dashboard?email=${encodeURIComponent(email)}`);
});

/* ------------------------------ How It Works ------------------------------ */

app.get("/how-it-works", (req, res) => {
  const body = `
  <h1 style="text-align:center">The first-of-its-kind algorithm for independent artists</h1>
  <p class="sub" style="text-align:center">No labels. No payola. No hand-picks. Just your record, judged on its craft and measured against every other record uploaded here.</p>
  <div class="panel">
    <h2 style="margin-top:0">Part 1 — The Search</h2>
    <p class="sub">The algorithm searches Facebook, Instagram, TikTok, YouTube, the music platforms where independents promote, and the open web — gathering everything it can find about you and your songs: the posts, the buzz, the conversation around your music. Your music is being evaluated 24 hours a day — the algorithm never sleeps.</p>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">Part 2 — The Judging</h2>
    <p class="sub">Every song uploaded to TOP 20 is scored on <b style="color:#fff">15 points, 1–10 each</b> (total /150) — the same 15 for every song, fitted genre by genre:</p>
    <ul class="rules">${CATEGORIES.map((c, i) => `<li><b>${i + 1}. ${esc(c.label)}</b></li>`).join("")}</ul>
    <p class="sub">Yes — the cover is one of the points. Quality artwork helps your score; anything slapped together will hurt it. The craft score is then blended with real engagement (60% craft / 40% engagement, social buzz capped at about 10% of the total) to set the charts — chart position is never popularity alone, and the craft score can't be bought.</p>
    <p class="sub">Launch genres: <b style="color:#fff">${GENRES.join(" · ")}</b> — plus a cross-genre Overall chart at every level.</p>
  </div>
  <div class="panel" style="border:1px solid rgba(255,190,60,.55);background:linear-gradient(180deg,rgba(255,170,40,.10),rgba(255,170,40,.03))">
    <h2 style="margin-top:0;color:#ffd98a">The 16th Law</h2>
    <p class="sub">The 15-Point Scale Evaluation measures your song — point by point, the craft, the sound, the record. But the 16th law is about something no machine can measure: <b style="color:#fff">pure raw talent.</b></p>
    <p class="sub">Motown saw it in a young Michael Jackson. The world saw it in New Edition — and in a young Chris Brown. They were young, and the gift was already undeniable. If you have the eye, you recognize it from the door, before any number proves it.</p>
    <p class="sub">So the 16th law of TOP 20 is this: <b style="color:#fff">talent like that does not escape us.</b> Our staff is always looking for that raw, pure gift — and when we capture it, when we see it, that artist gets the opportunity to grow right here on Top 20.</p>
    <p class="sub" style="margin-bottom:0">Fifteen points measure the song. <b style="color:#ffd98a">The 16th law watches for the gift.</b></p>
  </div>
  <div class="panel" style="border:1px solid rgba(255,190,60,.55);background:linear-gradient(180deg,rgba(255,170,40,.10),rgba(255,170,40,.03))">
    <h2 style="margin-top:0;color:#ffd98a">The Fan Bonus — likes &amp; shares push the climb</h2>
    <p class="sub">Separate from the 15 points and the 16th law, there is a <b style="color:#fff">bonus</b>: the <b style="color:#fff">likes</b> and <b style="color:#fff">shares</b> your song earns right here on its TOP 20 page. They add bonus points on top of your chart score — up to <b style="color:#fff">+6</b> — counted fresh at every midnight chart change.</p>
    <p class="sub" style="margin-bottom:0">That's the road up out of the bucket: if your song is sitting at #60 or #85 in the Top 100, your people's activity is real leverage — every like and every share moves your number. The bonus rewards the push and early support counts most, and it is capped on purpose: <b style="color:#fff">craft still rules the chart</b> — the bonus helps a good song climb, it can't carry a weak one to #1.</p>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">The Stage</h2>
    <p class="sub">The rotation plays the Top 20 in order, 1 through 20, 24 hours a day. New entries come into play at 12:00 midnight, every night — that's when the new chart takes effect and knocked-off songs leave the rotation.</p>
    <p class="sub"><b style="color:#fff">A great song holds its spot.</b> New entries can hit at midnight any night, but nobody loses a Top 20 spot for not uploading — a song only moves when hotter songs out-score it. So put your hottest material up here and keep doing what you're doing — that's what got you into the Top 20 in the first place. And a song that slides out of the 20 doesn't disappear — it stays in the big Top 100, ready to climb back.</p>
    <p class="sub">Same rule in the Top 100: a song only leaves the hundred when a hotter new entry out-scores it — every song faces the same evaluation. The 15-point scale evaluation measures every song on these 15 points: Mix Quality · Mastering &amp; Sound Quality · Hook Strength · Melody · Lyrical Quality · Song Structure · Vocal Delivery &amp; Performance · Production &amp; Instrumentation · Groove &amp; Rhythm · Emotional Impact · Dynamics &amp; Energy · Originality &amp; Identity · Replay Value · Radio &amp; Commercial Readiness · Cover Art &amp; Presentation. And even a song that falls out of the Top 100 still stays in the system — it's just not one of the Hot 100 right now.</p>
    <p class="sub"><b style="color:#fff">Give it time to be judged.</b> The system takes 24 hours to run a song through the full 15-point scale evaluation — it has to collect the data on you and your song first. So if you don't see your song in the Top 100 today or tomorrow, that doesn't mean anything — just wait. And if a week or so goes by and it still hasn't cracked the hundred, your song may just not be strong enough to break through yet — but don't pull it down. Leave it up, keep doing what you're doing, and keep giving your song its opportunity — the algorithm is checking 24 hours a day, and songs move when the numbers say so.</p>
  </div>
  <div class="ne">
    <div class="ne-banner">THE RULES</div>
    <ul class="rules" style="margin-bottom:2px">
      <li>Only songs <b>uploaded to TOP 20</b> are ever judged — if it isn't uploaded here, it isn't looked at.</li>
      <li><b>Two live songs per artist, max</b> — those are the only songs that get judged. Remove one to put another up.</li>
      <li>A <b>profile page + at least one song uploaded</b> is how you get recognized.</li>
      <li><b>Add your Facebook, Instagram and TikTok</b> to your profile — the judging system searches them to locate you and your music. No socials on file, and the system can't find you.</li>
      <li><b>No labels, no pay</b> can move a song. The algorithm decides — with one exception: <b>DJ's Hot Picks</b>. Every Friday a panel of DJs picks 3 songs that are already hot, and those picks step into the Top 20, badged for all to see. After Friday, the algorithm treats them like everybody else.</li>
      <li><b>Real artists only — no AI artists.</b> The voice and the artist have to be real: your vocals, your ability, your work, your hours. A producer may use AI tools — that is not what this rule is about — but he still has to produce the song: prompting a machine to generate the whole instrumental, start to finish, is not producing. But an AI singer, an AI performer — a song with no real artist behind it — we can't grade that and we won't; it isn't fair to the real artists. If we find out the artist is AI — today, next week, whenever — the song is pulled from the Top 20 and out of the Top 100 immediately.</li>
      <li>Audio must be <b>radio quality</b> — WAV or FLAC, or MP3 / M4A at 192 kbps or better, the same quality radio stations send and accept.</li>
      <li>Charts <b>recalculate daily</b> — the new chart lands at 12:00 midnight.</li>
      <li>Only the <b>Top 20 plays on the Stage</b>.</li>
      <li>When you enter a Top 20, you get the email. Falling off is never emailed — you come back and check, like the pros check the charts.</li>
    </ul>
  </div>
  <div class="panel">
    <p class="sub" style="font-size:15.5px;line-height:1.65;color:#e8eaf0">This is a professional platform, built to have you shine — just like a major artist, because that's what you are. Even though you're independent, you're just as major as any other artist. Artists who believe in themselves put in the work — and your music and your profile will speak for themselves.</p>
    <p style="margin:12px 0 2px"><a class="btn btn-blue btn-block" href="/profile">Create your profile</a></p>
    <p style="margin:10px 0 2px"><a class="btn btn-block" href="/upload">Upload your song</a></p>
  </div>`;
  res.send(layout("How It Works", "how", body, {
    meta: {
      title: "How It Works — TOP 20",
      description: "The first-of-its-kind algorithm for independent artists: a 24/7 search across Facebook, Instagram, TikTok, YouTube and the web, then every uploaded song judged by the 15-point scale evaluation and ranked daily.",
    },
  }));
});

/* -------------------------------- City DJs -------------------------------- */
// DJ of the Month (owner feature): anybody can submit a DJ who supports
// independent artists — the DJ themselves, an artist, or a fan — and
// every city runs its own monthly race. One vote per person per DJ per
// month (the t20_voter cookie + a UNIQUE constraint in dj_votes). The
// top DJ in each city is crowned DJ of the Month: spotlight while the
// race runs, archived when the month closes. Recognition only — DJ
// votes never touch song scores or charts.

function djMonth(d = new Date()) {
  return d.toISOString().slice(0, 7); // 'YYYY-MM'
}
function djPrevMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}
function fmtMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US",
    { month: "long", year: "numeric", timeZone: "UTC" });
}
function djCityLabel(d) {
  return d.state ? `${d.city}, ${d.state}` : d.city;
}
function djBoardUrl(d) {
  return `/djs/city/${encodeURIComponent(d.city)}${d.state ? `?state=${encodeURIComponent(d.state)}` : ""}`;
}
const withMsg = (url, m) => url + (url.includes("?") ? "&" : "?") + "msg=" + m;

// One city's board for one month: submissions with live vote counts,
// ranked by votes desc (earliest submission wins a tie).
function djBoard(month, city, state) {
  return db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM dj_votes v WHERE v.dj_id = d.id AND v.month = ?) AS votes
    FROM dj_submissions d
    WHERE d.month = ? AND LOWER(d.city) = LOWER(?)
      AND LOWER(COALESCE(d.state, '')) = LOWER(COALESCE(?, ''))
    ORDER BY votes DESC, d.id ASC
  `).all(month, month, city, state || null);
}

function djCities(month) {
  return db.prepare(`
    SELECT city, state, COUNT(*) AS djs FROM dj_submissions
    WHERE month = ? GROUP BY city, state ORDER BY city COLLATE NOCASE, state
  `).all(month);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}

// The voter's identity: a long-lived random cookie, issued on first use.
function voterKey(req, res) {
  const existing = parseCookies(req).t20_voter;
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const key = crypto.randomBytes(16).toString("hex");
  res.cookie("t20_voter", key, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: true, sameSite: "lax", path: "/",
  });
  return key;
}

function djError(res, message) {
  return res.status(400).send(layout("Submit a DJ", "djs", `
  <div class="panel err"><h2 style="margin-top:0">Submission stopped</h2>
  <p class="sub" style="color:#fff;font-size:16px">${esc(message)}</p>
  <p><a class="btn" href="/djs/submit">Back to the form</a></p></div>`));
}

const DJ_MSGS = {
  thanks: "Thank you — your DJ is on the board. Now get your city voting.",
  voted: "Vote counted. The race runs all month — tell your city.",
  already: "You already voted for this DJ this month. One vote per person, per DJ, each month.",
  closed: "That month's race is over — voting has closed. This month's board is below.",
};
function djMsgHtml(req) {
  const m = DJ_MSGS[req.query.msg];
  if (!m) return "";
  return `<div class="panel" style="border-left:3px solid var(--accent)"><p class="sub" style="margin:0;color:#fff">${m}</p></div>`;
}

function djRowHtml(d, rank, { leader = false } = {}) {
  const place = [d.hood, djCityLabel(d)].filter(Boolean).join(" · ");
  return `
  <div class="row" style="align-items:flex-start">
    <span class="rankbadge" style="margin-top:2px">#${rank}</span>
    <span class="meta">
      <span class="t" style="white-space:normal">${esc(d.dj_name)}${leader ? `<span class="crownbadge">👑 LEADING</span>` : ""}</span><br>
      ${place ? `<span class="a">${esc(place)}</span>` : ""}
      ${d.support_text ? `<span class="note" style="display:block;margin:5px 0 0">${esc(d.support_text)}</span>` : ""}
      ${d.socials ? `<span style="display:block;color:var(--dim);font-size:13px;margin-top:4px">${esc(d.socials)}</span>` : ""}
      <span style="display:block;margin-top:6px;font-size:13px;color:var(--dim)"><b style="color:#fff;font-size:15.5px">${d.votes}</b> vote${d.votes === 1 ? "" : "s"} this month</span>
    </span>
    <form method="post" action="/djs/${d.id}/vote" style="margin:0"><button class="votebtn" type="submit">Vote</button></form>
  </div>`;
}

app.get("/djs", (req, res) => {
  const month = djMonth();
  const prev = djPrevMonth(month);
  const cities = djCities(month);
  const spotlights = cities
    .map((c) => ({ ...c, leader: djBoard(month, c.city, c.state)[0] }))
    .filter((c) => c.leader);
  const winners = djCities(prev)
    .map((c) => ({ ...c, winner: djBoard(prev, c.city, c.state)[0] }))
    .filter((c) => c.winner);

  // DJ'S HOT PICKS: this week's panel picks + the archive of past Fridays.
  const hpChartDate = latestChartDate(db);
  const hpLatest = latestPickDate();
  const hpWeeks = db.prepare("SELECT DISTINCT pick_date FROM dj_picks ORDER BY pick_date DESC LIMIT 5").all().map((r) => r.pick_date);
  const hpRow = (p) => `
    <a class="row" href="/song/${p.id}">
      <img class="thumb" src="${esc(p.cover_path)}" alt="">
      <span class="meta"><span class="t">${esc(p.title)}</span><br><span class="a">${esc(p.artist)}</span></span>
      <span class="nums">${p.nowRank ? `NOW <b>#${p.nowRank}</b>` : "<b>Top 20</b>"}</span>
    </a>`;
  const hotPicksHtml = hpLatest ? `
  <div class="panel">
    <h2 style="margin-top:0">🎧 DJ's Hot Picks</h2>
    <p class="sub">The DJs are the industry — radio and the clubs. So every <b style="color:#fff">Friday</b>, a panel of DJs gets a say-so: they pick <b style="color:#fff">3 songs that are already hot</b>, and those picks step straight into the Top 20. It's the one exception to the algorithm — and it's capped at 3 a week. The DJs take these records back to their stations and their clubs; after Friday, the algorithm treats a pick like everybody else.</p>
    <div class="sub" style="letter-spacing:2px;text-transform:uppercase;font-size:11px;margin-top:10px">This week — ${fmtChartDate(hpLatest)}</div>
    ${djHotPicks(hpLatest, hpChartDate).map(hpRow).join("")}
    ${hpWeeks.filter((d) => d !== hpLatest).length ? `
    <div class="sub" style="letter-spacing:2px;text-transform:uppercase;font-size:11px;margin-top:14px">Past Fridays</div>
    ${hpWeeks.filter((d) => d !== hpLatest).map((d) => `
    <p class="sub" style="margin:8px 0 0"><b style="color:#fff">${fmtChartDate(d)}</b> — ${djHotPicks(d, hpChartDate).map((p) => esc(p.title)).join(" · ")}</p>`).join("")}` : ""}
  </div>` : "";

  const body = `
  <h1>City DJs</h1>
  <p class="sub">The DJs who spin independent artists get their flowers too. Every month, every city picks its <b style="color:#fff">DJ of the Month</b> — submit the DJ who's been holding independents down in your city, and vote. Anybody can submit: the DJ, an artist, a fan.</p>
  <p><a class="btn btn-blue btn-block" href="/djs/submit">Submit a DJ</a></p>
  ${djMsgHtml(req)}
  ${hotPicksHtml}
  ${spotlights.length ? spotlights.map((c) => `
  <div class="panel">
    <div class="sub" style="letter-spacing:2px;text-transform:uppercase;font-size:11px">DJ of the Month race — ${esc(djCityLabel(c))} · ${fmtMonth(month)}</div>
    <h2 style="margin:8px 0 2px">${esc(c.leader.dj_name)}${c.leader.votes > 0 ? `<span class="crownbadge">👑 LEADING</span>` : ""}</h2>
    <p class="sub" style="margin:0">${c.leader.hood ? `${esc(c.leader.hood)} · ` : ""}<b style="color:#fff">${c.leader.votes} vote${c.leader.votes === 1 ? "" : "s"}</b>${c.leader.votes > 0 ? " and leading the city" : ""}</p>
    ${c.leader.support_text ? `<p class="note">${esc(c.leader.support_text)}</p>` : ""}
    <p style="margin:10px 0 2px"><a href="${djBoardUrl(c)}" style="color:var(--accent);font-weight:700;text-decoration:none">See the ${esc(c.city)} board →</a></p>
  </div>`).join("") : `<div class="panel"><p class="sub" style="margin:0">No DJs submitted yet this month. Be the first — <a href="/djs/submit" style="color:var(--accent);font-weight:700">submit a DJ</a>.</p></div>`}
  ${cities.length ? `
  <div class="panel">
    <h2 style="margin-top:0">Cities this month</h2>
    ${cities.map((c) => `
    <a class="row" href="${djBoardUrl(c)}">
      <span class="meta"><span class="t">${esc(djCityLabel(c))}</span><br><span class="a">${c.djs} DJ${c.djs === 1 ? "" : "s"} in the race</span></span>
      <span class="nums" style="font-size:17px">→</span>
    </a>`).join("")}
  </div>` : ""}
  ${winners.length ? `
  <div class="panel">
    <h2 style="margin-top:0">Past winners — DJ of the Month</h2>
    <p class="sub" style="margin-top:-4px">Crowned by their cities, and kept here for good.</p>
    ${winners.map((c) => `
    <a class="row" href="${djBoardUrl(c)}">
      <span class="meta"><span class="t">${esc(fmtMonth(prev))} — ${esc(djCityLabel(c))}</span><br><span class="a">👑 ${esc(c.winner.dj_name)} · ${c.winner.votes} vote${c.winner.votes === 1 ? "" : "s"}</span></span>
      <span class="nums" style="font-size:17px">→</span>
    </a>`).join("")}
  </div>` : ""}`;
  res.send(layout("City DJs", "djs", body, {
    meta: {
      title: "City DJs — DJ of the Month on TOP 20",
      description: "The DJs who spin independent artists get their flowers: submit your city's DJ and vote for DJ of the Month — a new race in every city, every month.",
    },
  }));
});

app.get("/djs/submit", (req, res) => {
  const body = `
  <h1>Submit a DJ</h1>
  <p class="sub">Put your city's DJ on the board. If they spin independent artists — really support them — they belong here. The DJ can submit themselves, or an artist or a fan can put them up. Voting runs all month; each city's top DJ is crowned DJ of the Month.</p>
  <form method="post" action="/djs/submit" class="panel">
    <label>DJ name *<input name="dj_name" required maxlength="80" placeholder="DJ …"></label>
    <label>City *<input name="city" required maxlength="60" placeholder="Dallas"></label>
    <label>State<input name="state" maxlength="30" placeholder="TX"></label>
    <label>Hood / neighborhood<input name="hood" maxlength="60" placeholder="Oak Cliff"></label>
    <label>How does this DJ support independent artists?<textarea name="support_text" rows="4" maxlength="600" placeholder="What do they actually do — the indie nights, the first spins, the shout-outs…"></textarea></label>
    <label>Socials / links<input name="socials" maxlength="200" placeholder="@handle · instagram.com/…"></label>
    <label>Your name<input name="submitted_by" maxlength="80" placeholder="Who's putting this DJ up?"></label>
    <button class="btn btn-blue btn-block" type="submit" style="margin-top:16px">Put them on the board</button>
  </form>`;
  res.send(layout("Submit a DJ", "djs", body));
});

app.post("/djs/submit", (req, res) => {
  const b = req.body || {};
  const clean = (v, max) => String(v || "").trim().slice(0, max);
  const djName = clean(b.dj_name, 80);
  const city = clean(b.city, 60);
  if (!djName) return djError(res, "A DJ name is required — who are we putting on the board?");
  if (!city) return djError(res, "A city is required — every DJ races for their own city.");
  let state = clean(b.state, 30);
  if (state.length === 2) state = state.toUpperCase();
  const row = {
    dj_name: djName,
    city,
    state: state || null,
    hood: clean(b.hood, 60) || null,
    support_text: clean(b.support_text, 600) || null,
    socials: clean(b.socials, 200) || null,
    submitted_by: clean(b.submitted_by, 80) || null,
    month: djMonth(),
  };
  db.prepare(`INSERT INTO dj_submissions (dj_name, city, state, hood, support_text, socials, submitted_by, month)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.dj_name, row.city, row.state, row.hood, row.support_text, row.socials, row.submitted_by, row.month);
  res.redirect(withMsg(djBoardUrl(row), "thanks"));
});

app.get("/djs/city/:city", (req, res) => {
  const month = djMonth();
  const prev = djPrevMonth(month);
  const wantState = req.query.state ? String(req.query.state) : null;
  const pairSql = `
    SELECT city, state FROM dj_submissions
    WHERE LOWER(city) = LOWER(?) ${wantState ? "AND LOWER(COALESCE(state, '')) = LOWER(?)" : ""}
    GROUP BY city, state ORDER BY MAX(month) DESC LIMIT 1`;
  const pair = wantState
    ? db.prepare(pairSql).get(req.params.city, wantState)
    : db.prepare(pairSql).get(req.params.city);
  if (!pair) {
    return res.status(404).send(layout("City DJs", "djs", `
    <div class="panel"><h2 style="margin-top:0">No DJs here yet</h2>
    <p class="sub">Nobody has submitted a DJ for ${esc(req.params.city)} yet. Put your city's DJ on the board — voting for ${fmtMonth(month)} is open.</p>
    <p><a class="btn btn-blue btn-block" href="/djs/submit">Submit a DJ</a></p></div>`));
  }
  const label = djCityLabel(pair);
  const rows = djBoard(month, pair.city, pair.state);
  const leaderId = rows.length && rows[0].votes > 0 ? rows[0].id : null;
  const lastWinner = djBoard(prev, pair.city, pair.state)[0];
  const body = `
  <h1>${esc(label)} DJs</h1>
  <p class="sub">The ${fmtMonth(month)} race for <b style="color:#fff">DJ of the Month — ${esc(label)}</b>. One vote per person, per DJ, this month. The winner is crowned at month's end and kept in the archive.</p>
  ${djMsgHtml(req)}
  <div class="panel">
    <h2 style="margin-top:0">This month's board</h2>
    ${rows.length ? rows.map((d, i) => djRowHtml(d, i + 1, { leader: d.id === leaderId })).join("")
      : `<p class="sub">No DJs on this city's board yet this month — <a href="/djs/submit" style="color:var(--accent);font-weight:700">submit the first one</a>.</p>`}
  </div>
  ${lastWinner ? `
  <div class="panel">
    <div class="sub" style="letter-spacing:2px;text-transform:uppercase;font-size:11px">Last month's winner — ${fmtMonth(prev)}</div>
    <h2 style="margin:8px 0 2px">${esc(lastWinner.dj_name)} <span class="crownbadge">👑 DJ OF THE MONTH</span></h2>
    <p class="sub" style="margin:0">${lastWinner.hood ? `${esc(lastWinner.hood)} · ` : ""}<b style="color:#fff">${lastWinner.votes} vote${lastWinner.votes === 1 ? "" : "s"}</b></p>
    ${lastWinner.support_text ? `<p class="note">${esc(lastWinner.support_text)}</p>` : ""}
  </div>` : ""}
  <p><a class="btn btn-block" href="/djs/submit">Submit a DJ</a></p>
  <p style="text-align:center"><a href="/djs" style="color:var(--accent);font-weight:700;text-decoration:none">← All city boards</a></p>`;
  res.send(layout(`${label} DJs`, "djs", body, {
    meta: {
      title: `${label} DJ of the Month race — TOP 20`,
      description: `Vote for ${label}'s DJ of the Month on TOP 20 — the DJs who support independent artists, crowned by their city every month.`,
    },
  }));
});

app.post("/djs/:id/vote", (req, res) => {
  const dj = db.prepare("SELECT * FROM dj_submissions WHERE id = ?").get(req.params.id);
  if (!dj) {
    return res.status(404).send(layout("City DJs", "djs", `
    <div class="panel"><h2 style="margin-top:0">DJ not found</h2>
    <p class="sub">That DJ isn't on any board. <a href="/djs" style="color:var(--accent);font-weight:700">See the city boards →</a></p></div>`));
  }
  const back = djBoardUrl(dj);
  if (dj.month !== djMonth()) return res.redirect(withMsg(back, "closed"));
  const key = voterKey(req, res);
  try {
    db.prepare("INSERT INTO dj_votes (dj_id, voter_key, month) VALUES (?, ?, ?)")
      .run(dj.id, key, dj.month);
    return res.redirect(withMsg(back, "voted"));
  } catch {
    // UNIQUE (dj_id, voter_key, month): this person already voted.
    return res.redirect(withMsg(back, "already"));
  }
});

/* --------------------------- Admin (owner only) --------------------------- */
// Owner access is an 8-DIGIT CODE entered on the website itself, like
// the owner's Da Muzik Box DAW — no hosting-dashboard password. Only a
// salted SHA-256 fingerprint of the code is ever stored (a starter
// fingerprint is baked in below; when the owner changes his code from
// inside the admin area, the new fingerprint is saved in admin_config
// and wins). The login cookie is an HMAC keyed by the active
// fingerprint, so changing the code logs every old session out. Five
// wrong tries lock the door for 15 minutes.
const ADMIN_CODE_STARTER = { salt: "762e16443a1fd814", hash: "3db3a7fd6e0079100b83aaf09d8417e79f16b38e4d03ffeae762fdd35e92a060" };
function activeCodeRecord() {
  try {
    const row = db.prepare("SELECT value FROM admin_config WHERE key = 'admin_code'").get();
    if (row && row.value) return JSON.parse(row.value);
  } catch (e) { /* table may not exist on a pre-update DB */ }
  return ADMIN_CODE_STARTER;
}
function hashAdminCode(salt, code) {
  return crypto.createHash("sha256").update(salt + ":" + code).digest("hex");
}
function verifyAdminCode(code) {
  if (!/^\d{8}$/.test(String(code || ""))) return false;
  const rec = activeCodeRecord();
  const got = Buffer.from(hashAdminCode(rec.salt, String(code)));
  const want = Buffer.from(rec.hash);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function adminToken() {
  return crypto.createHmac("sha256", activeCodeRecord().hash).update("top20-admin-v1").digest("hex");
}
function isAdmin(req) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "t20_admin") {
      const got = Buffer.from(v.join("="));
      const want = Buffer.from(adminToken());
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    }
  }
  return false;
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.redirect("/admin/login");
}
const loginFails = new Map(); // ip -> { fails, until }
function loginLocked(ip) {
  const r = loginFails.get(ip);
  return r && r.until && r.until > Date.now();
}
function noteLoginFail(ip) {
  const r = loginFails.get(ip) || { fails: 0, until: 0 };
  r.fails += 1;
  if (r.fails >= 5) { r.until = Date.now() + 15 * 60 * 1000; r.fails = 0; }
  loginFails.set(ip, r);
}

/* --------------------------- Stage ads (owner) --------------------------- */

const AD_UP = path.join(PUBLIC_DIR, "uploads", "ads");
fs.mkdirSync(AD_UP, { recursive: true });
const AD_IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const AD_VIDEO_EXTS = [".mp4", ".webm", ".mov"];
const adUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AD_UP),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || "").toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
      cb(null, `ad-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 40 * 1024 * 1024 },
});

function probeDurationSec(absPath) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", absPath], { encoding: "utf8" });
    return parseFloat((JSON.parse(out).format || {}).duration) || 0;
  } catch { return 0; }
}

app.post("/admin/ads", requireAdmin, (req, res) => {
  adUpload.single("adfile")(req, res, (err) => {
    const back = (m) => res.redirect("/admin/placements?admsg=" + encodeURIComponent(m));
    if (err || !req.file) return back("Pick an image or video file for the ad first.");
    const ext = (path.extname(req.file.filename) || "").toLowerCase();
    const web = `/uploads/ads/${req.file.filename}`;
    const title = String(req.body.title || "").trim().slice(0, 80) || req.file.originalname;
    const genre = [...GENRES, "All"].includes(req.body.genre) ? req.body.genre : "All";
    let link = String(req.body.link_url || "").trim().slice(0, 300);
    if (link && !/^https?:\/\//i.test(link)) link = "";
    if (AD_IMAGE_EXTS.includes(ext)) {
      const seconds = Math.max(3, Math.min(30, parseInt(req.body.seconds, 10) || 8));
      db.prepare("INSERT INTO ads (kind, file_path, link_url, title, seconds, genre) VALUES ('image', ?, ?, ?, ?, ?)").run(web, link || null, title, seconds, genre);
      return back(`Image ad "${title}" is in the rotation on ${genre === "All" ? "all channels" : "the " + genre + " channel"} (${seconds}s between songs).`);
    }
    if (AD_VIDEO_EXTS.includes(ext)) {
      const dur = probeDurationSec(req.file.path);
      if (dur > 30.5) {
        fs.unlink(req.file.path, () => {});
        return back(`That video runs ${Math.round(dur)} seconds — ads cap at 30 seconds. Trim it and upload again.`);
      }
      db.prepare("INSERT INTO ads (kind, file_path, link_url, title, seconds, genre) VALUES ('video', ?, ?, ?, ?, ?)").run(web, link || null, title, Math.ceil(dur) || 0, genre);
      return back(`Video ad "${title}" is in the rotation on ${genre === "All" ? "all channels" : "the " + genre + " channel"}${dur ? ` (${Math.round(dur)}s)` : ""}.`);
    }
    fs.unlink(req.file.path, () => {});
    return back("That file type won't run as an ad — use JPG/PNG/WebP for images or MP4/WebM/MOV for video.");
  });
});

app.post("/admin/ads/:id/toggle", requireAdmin, (req, res) => {
  db.prepare("UPDATE ads SET active = 1 - active WHERE id = ?").run(req.params.id);
  res.redirect("/admin/placements");
});

app.post("/admin/ads/:id/delete", requireAdmin, (req, res) => {
  const ad = db.prepare("SELECT * FROM ads WHERE id = ?").get(req.params.id);
  if (ad) {
    db.prepare("DELETE FROM ads WHERE id = ?").run(ad.id);
    const abs = path.join(PUBLIC_DIR, ad.file_path.replace(/^\//, ""));
    fs.unlink(abs, () => {});
  }
  res.redirect("/admin/placements");
});

app.get("/terms", (req, res) => {
  const body = `
  <h1>Terms &amp; Conditions</h1>
  <p class="sub">The deal between Hot Top 20 and every artist and label on the platform — in plain words.</p>
  <div class="panel">
    <h2>1. Who can upload</h2>
    <ul class="rules">
      <li>Only the <b>artist</b>, or a <b>representative the label has authorized</b>, may upload a song.</li>
      <li>By uploading, you certify that you own the song or control every right needed to upload it and grant the permission below. If that isn't true, don't upload it.</li>
      <li><b>Real artists only:</b> no AI artists and no AI vocals. A producer may use AI tools, but he still has to produce the song — a fully generated instrumental passed off as produced counts as an AI upload.</li>
    </ul>
    <h2>2. The permission you grant</h2>
    <ul class="rules">
      <li>You grant Hot Top 20 <b>exclusive permission to add and play your song on hottop20.com</b>: streaming it on the 24/7 Stage, placing it on the Local, Regional and National charts, and keeping it in the rotation while it is live on your profile.</li>
      <li>Hot Top 20 may use the song, its <b>cover art</b>, and your <b>artist name and profile</b> on chart pages, song pages, share cards and in promotion of the platform.</li>
      <li>Your consent is <b>recorded with the upload</b> — the date, the time, and the account that certified it.</li>
    </ul>
    <h2>3. What does not change</h2>
    <ul class="rules">
      <li><b>Your music stays yours.</b> Uploading grants the permission above — it does not transfer ownership of your song, your masters or your publishing to Hot Top 20.</li>
      <li>Chart position is earned on the <b>15-Point Scale</b> and engagement — it is never sold and never promised.</li>
    </ul>
    <h2>4. Taking a song down</h2>
    <ul class="rules">
      <li>You can remove your song at any time from your dashboard. It leaves the rotation and the charts at the next midnight chart change.</li>
      <li>If a song is found to break these terms — including the real-artists rule, or a rights claim that checks out — it is pulled from the Top 20 and the Top 100 immediately.</li>
    </ul>
    <p class="note">Uploading a song means you agreed to these terms. The consent checkbox on the Upload page is the signature.</p>
  </div>
  <p style="text-align:center"><a class="ghost" href="/upload">← To the Upload page</a></p>`;
  res.send(layout("Terms & Conditions", "", body));
});

app.get("/advertise", (req, res) => {
  const sent = req.query.sent ? `<div class="panel" style="border-color:rgba(80,220,140,.6)"><h2>✔ Your ad is in</h2><p style="margin:0">Dale reviews every ad personally. When yours is approved it goes straight into the Stage rotation on your channel — watch the Stage and you'll see it roll between the songs.</p></div>` : "";
  const err = req.query.err ? `<p class="note" style="color:#ffb3ab">${esc(req.query.err)}</p>` : "";
  const body = `
  <h1>Advertise on Top 20</h1>
  <p class="sub">The Stage runs 24/7 — the charts in rotation, in front of independent artists and the fans who ride for them. Here's exactly how advertising works here, no fine print:</p>
  ${sent}${err}
  <div class="panel" style="border-color:rgba(255,190,60,.65)">
    <h2>📣 HOW IT WORKS</h2>
    <ul class="rules">
      <li><b>Your ad plays inside the Stage rotation, between songs</b> — one ad break after every 5 songs, right in the middle of the show.</li>
      <li><b>Pick your channel</b> — R&amp;B, Southern Soul, Hip-Hop, Trap, Country, Pop, Dance/Techno/House — or run it on <b>every channel at once</b>, Main Stage included.</li>
      <li><b>Image ads</b> (8 seconds on screen) or <b>video ads up to 30 seconds</b>.</li>
      <li>Your ad can <b>link straight to your store, your page or your event</b> — one tap and they're there.</li>
      <li><b>Every ad is reviewed by Dale personally</b> before it runs. Nothing hits the Stage without his eyes on it.</li>
    </ul>
  </div>
  <form class="panel" method="post" action="/advertise/submit" enctype="multipart/form-data">
    <h2>📤 SEND YOUR AD</h2>
    <div class="field"><label for="adfile2">Your ad — image or video (max 30 seconds)</label><input id="adfile2" type="file" name="adfile" accept="image/*,video/mp4,video/webm,video/quicktime" required></div>
    <div class="grid">
      <div class="field"><label for="subname">Your name / business</label><input id="subname" name="submitter" maxlength="80" required placeholder="e.g. Mesquite BBQ Co."></div>
      <div class="field"><label for="subcontact">Your email (so we can reach you)</label><input id="subcontact" name="contact" type="email" maxlength="120" required placeholder="you@business.com"></div>
    </div>
    <div class="grid">
      <div class="field"><label for="subgenre">Run my ad on</label><select id="subgenre" name="genre"><option value="All">All channels (incl. Main Stage)</option>${GENRES.map((g) => `<option value="${esc(g)}">${esc(g)} only</option>`).join("")}</select></div>
      <div class="field"><label for="sublink">Tap/click takes people here (optional)</label><input id="sublink" name="link_url" maxlength="300" placeholder="https://..."></div>
    </div>
    <div class="field"><label for="subnote">Anything Dale should know? (optional)</label><input id="subnote" name="note" maxlength="280" placeholder="e.g. Grand opening Nov 8 — push it on Hip-Hop and All channels if you can"></div>
    <button class="btn primary">Send my ad for review</button>
    <p class="note">Sending is free and commits you to nothing — your ad waits in Dale's review box until he puts it in rotation himself.</p>
  </form>
  <p style="text-align:center"><a class="ghost" href="/">← Back to the Stage</a></p>`;
  res.send(layout("Advertise on Top 20", "", body));
});

app.post("/advertise/submit", (req, res) => {
  adUpload.single("adfile")(req, res, (err) => {
    const backErr = (m) => res.redirect("/advertise?err=" + encodeURIComponent(m));
    if (err || !req.file) return backErr("Pick your ad file first — an image, or a video up to 30 seconds.");
    const submitter = String(req.body.submitter || "").trim().slice(0, 80);
    const contact = String(req.body.contact || "").trim().slice(0, 120);
    if (!submitter || !contact.includes("@")) {
      fs.unlink(req.file.path, () => {});
      return backErr("Add your name/business and a real email so Dale knows whose ad this is.");
    }
    const ext = (path.extname(req.file.filename) || "").toLowerCase();
    const web = `/uploads/ads/${req.file.filename}`;
    const genre = [...GENRES, "All"].includes(req.body.genre) ? req.body.genre : "All";
    let link = String(req.body.link_url || "").trim().slice(0, 300);
    if (link && !/^https?:\/\//i.test(link)) link = "";
    const note = String(req.body.note || "").trim().slice(0, 280);
    const title = submitter + " — ad";
    if (AD_IMAGE_EXTS.includes(ext)) {
      db.prepare("INSERT INTO ads (kind, file_path, link_url, title, seconds, genre, status, submitter, contact, note) VALUES ('image', ?, ?, ?, 8, ?, 'pending', ?, ?, ?)").run(web, link || null, title, genre, submitter, contact, note || null);
      return res.redirect("/advertise?sent=1");
    }
    if (AD_VIDEO_EXTS.includes(ext)) {
      const dur = probeDurationSec(req.file.path);
      if (dur > 30.5) {
        fs.unlink(req.file.path, () => {});
        return backErr(`That video runs ${Math.round(dur)} seconds — ads cap at 30 seconds. Trim it and send it again.`);
      }
      db.prepare("INSERT INTO ads (kind, file_path, link_url, title, seconds, genre, status, submitter, contact, note) VALUES ('video', ?, ?, ?, ?, ?, 'pending', ?, ?, ?)").run(web, link || null, title, Math.ceil(dur) || 0, genre, submitter, contact, note || null);
      return res.redirect("/advertise?sent=1");
    }
    fs.unlink(req.file.path, () => {});
    return backErr("That file type won't run as an ad — JPG/PNG/WebP for images, MP4/WebM/MOV for video.");
  });
});

app.post("/admin/ads/:id/approve", requireAdmin, (req, res) => {
  db.prepare("UPDATE ads SET status = 'live', active = 1 WHERE id = ?").run(req.params.id);
  res.redirect("/admin/placements?admsg=" + encodeURIComponent("Ad approved — it's in the rotation now."));
});

app.get("/admin/login", (req, res) => {
  if (isAdmin(req)) return res.redirect("/admin/placements");
  const ip = req.ip || "x";
  const body = `
  <h1>Owner login</h1>
  <div class="panel">
    <form method="post" action="/admin/login">
      <p class="sub" style="margin-top:0">This area is for the site owner only. Enter your 8-digit admin code.</p>
      ${req.query.err ? `<p class="note" style="color:#ff9d9d">That code didn't match. Try again.</p>` : ""}
      ${loginLocked(ip) ? `<p class="note" style="color:#ff9d9d">Too many wrong tries — the door is locked for a few minutes.</p>` : ""}
      <label class="sub">Admin code<br>
      <input type="password" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]*" required
        style="width:100%;padding:14px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff;font-size:22px;letter-spacing:6px;text-align:center"></label>
      <button type="submit" style="padding:12px 22px;border-radius:10px;border:0;background:var(--accent);color:#fff;font-weight:800;cursor:pointer">Log in</button>
    </form>
  </div>`;
  res.send(layout("Owner login", "admin", body));
});

app.post("/admin/login", (req, res) => {
  const ip = req.ip || "x";
  if (loginLocked(ip)) return res.redirect("/admin/login?err=1");
  if (!verifyAdminCode(req.body.code)) { noteLoginFail(ip); return res.redirect("/admin/login?err=1"); }
  loginFails.delete(ip);
  res.cookie("t20_admin", adminToken(), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
  return res.redirect("/admin/placements");
});

// The owner changes his own code from inside the site — the new code
// never travels through chat, email, or a hosting dashboard.
app.post("/admin/code", requireAdmin, (req, res) => {
  const back = (m) => res.redirect("/admin/placements?msg=" + encodeURIComponent(m));
  if (!verifyAdminCode(req.body.current_code)) return back("That current code didn't match — code not changed.");
  const n1 = String(req.body.new_code || ""), n2 = String(req.body.new_code2 || "");
  if (!/^\d{8}$/.test(n1)) return back("The new code has to be exactly 8 digits.");
  if (n1 !== n2) return back("The new code didn't match itself — type it the same way twice.");
  const salt = crypto.randomBytes(8).toString("hex");
  const rec = { salt, hash: hashAdminCode(salt, n1) };
  db.prepare("INSERT INTO admin_config (key, value) VALUES ('admin_code', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(rec));
  res.cookie("t20_admin", adminToken(), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
  return back("Your admin code is changed. Use the new code from now on — and keep it somewhere safe.");
});

app.post("/admin/logout", (req, res) => {
  res.clearCookie("t20_admin", { path: "/" });
  res.redirect("/");
});

/* --------------------- DJ panel (weekly Hot Picks) --------------------- */
// A SEPARATE login for the DJ panel only (owner request, Oct 31 2026):
// one shared DJ password that the owner creates/sets inside his admin
// area and hands to his DJs. The DJ session opens ONLY the picks panel
// below — never placements, never the admin code. Same storage pattern
// as the owner code: only a salted SHA-256 fingerprint is kept (a
// starter fingerprint is baked in; the owner's saved password in
// admin_config wins), and the session cookie is an HMAC keyed by the
// active fingerprint, so changing the password logs every DJ out.
const DJ_PASSWORD_STARTER = { salt: "9f2c41aa07b3d5e8", hash: "823810b1a960791d9dac2aa4a8c714c492c999bbc791ae94e95dbdc5f390325c" };
function activeDjRecord() {
  try {
    const row = db.prepare("SELECT value FROM admin_config WHERE key = 'dj_password'").get();
    if (row && row.value) return JSON.parse(row.value);
  } catch (e) { /* table may not exist on a pre-update DB */ }
  return DJ_PASSWORD_STARTER;
}
function verifyDjPassword(pw) {
  const s = String(pw || "");
  if (s.length < 6 || s.length > 64) return false;
  const rec = activeDjRecord();
  const got = Buffer.from(hashAdminCode(rec.salt, s));
  const want = Buffer.from(rec.hash);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function djToken() {
  return crypto.createHmac("sha256", activeDjRecord().hash).update("top20-dj-v1").digest("hex");
}
function isDj(req) {
  if (isAdmin(req)) return true; // the owner can always open the panel
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "t20_dj") {
      const got = Buffer.from(v.join("="));
      const want = Buffer.from(djToken());
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    }
  }
  return false;
}
function requireDj(req, res, next) {
  if (isDj(req)) return next();
  return res.redirect("/dj/login");
}
const djLoginFails = new Map();
function djLoginLocked(ip) {
  const r = djLoginFails.get(ip);
  return r && r.until && r.until > Date.now();
}
function noteDjLoginFail(ip) {
  const r = djLoginFails.get(ip) || { fails: 0, until: 0 };
  r.fails += 1;
  if (r.fails >= 5) { r.until = Date.now() + 15 * 60 * 1000; r.fails = 0; }
  djLoginFails.set(ip, r);
}
// Picks are entered for the NEXT Friday whose chart hasn't been dealt
// yet (charts land at midnight, so on Friday itself the panel already
// targets the following Friday).
function nextFridayStr() {
  const today = todayStr();
  const dow = new Date(today + "T12:00:00Z").getUTCDay();
  let delta = (5 - dow + 7) % 7;
  if (delta === 0) delta = 7;
  return new Date(new Date(today + "T12:00:00Z").getTime() + delta * 86400000).toISOString().slice(0, 10);
}
function prettyDate(s) {
  return new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

app.get("/dj/login", (req, res) => {
  if (isDj(req)) return res.redirect("/dj");
  const ip = req.ip || "x";
  const body = `
  <h1>🎧 DJ panel login</h1>
  <div class="panel">
    <form method="post" action="/dj/login">
      <p class="sub" style="margin-top:0">For the Top 20 DJ panel. This password opens the weekly DJ's Hot Picks panel only — enter the password the owner gave you.</p>
      ${req.query.err ? `<p class="note" style="color:#ff9d9d">That password didn't match. Try again.</p>` : ""}
      ${djLoginLocked(ip) ? `<p class="note" style="color:#ff9d9d">Too many wrong tries — the door is locked for a few minutes.</p>` : ""}
      <label class="sub">DJ password<br>
      <input type="password" name="password" autocomplete="current-password" required
        style="width:100%;padding:14px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff;font-size:18px;text-align:center"></label>
      <button type="submit" style="padding:12px 22px;border-radius:10px;border:0;background:var(--accent);color:#fff;font-weight:800;cursor:pointer">Log in</button>
    </form>
  </div>`;
  res.send(layout("DJ panel login", "", body));
});

app.post("/dj/login", (req, res) => {
  const ip = req.ip || "x";
  if (djLoginLocked(ip)) return res.redirect("/dj/login?err=1");
  if (!verifyDjPassword(req.body.password)) { noteDjLoginFail(ip); return res.redirect("/dj/login?err=1"); }
  djLoginFails.delete(ip);
  res.cookie("t20_dj", djToken(), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
  return res.redirect("/dj");
});

app.post("/dj/logout", (req, res) => {
  res.clearCookie("t20_dj", { path: "/" });
  res.redirect("/");
});

app.get("/dj", requireDj, (req, res) => {
  const target = nextFridayStr();
  const songs = db.prepare(`
    SELECT s.id, s.title, s.genre, u.name AS artist FROM songs s
    JOIN users u ON u.id = s.artist_id WHERE s.status = 'live' ORDER BY s.title`).all();
  const saved = db.prepare("SELECT song_id FROM dj_picks WHERE pick_date = ? ORDER BY id").all(target).map((r) => r.song_id);
  const current = db.prepare(`
    SELECT p.pick_date, s.title, u.name AS artist FROM dj_picks p
    JOIN songs s ON s.id = p.song_id JOIN users u ON u.id = s.artist_id
    WHERE p.pick_date = (SELECT MAX(pick_date) FROM dj_picks WHERE pick_date <= ?)
    ORDER BY p.id`).all(todayStr());
  const sel = (slot) => `
      <select name="pick${slot}" style="width:100%;padding:12px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff">
        <option value="">— no pick —</option>
        ${songs.map((s) => `<option value="${s.id}" ${saved[slot - 1] === s.id ? "selected" : ""}>${esc(s.title)} — ${esc(s.artist)} (${esc(s.genre)})</option>`).join("")}
      </select>`;
  const body = `
  <h1>🎧 DJ's Hot Picks — panel</h1>
  <p class="sub">Every Friday the panel picks up to <b style="color:#fff">3 songs</b> that are already hot. Those picks step into the <b style="color:#fff">National Overall Top 20</b> when Friday's chart lands at midnight, wearing the gold 🎧 DJ Pick badge. From the next day the algorithm treats a pick like any other song. Picks can be changed any time before that Friday midnight.</p>
  ${req.query.msg ? `<div class="panel" style="border-left:3px solid var(--accent)"><p class="sub" style="margin:0">${esc(req.query.msg)}</p></div>` : ""}
  <div class="panel">
    <h2 style="margin-top:0">Picks for ${esc(prettyDate(target))}</h2>
    <form method="post" action="/dj/picks">
      <label class="sub">Pick 1<br>${sel(1)}</label>
      <label class="sub">Pick 2<br>${sel(2)}</label>
      <label class="sub">Pick 3<br>${sel(3)}</label>
      <button type="submit" style="padding:12px 22px;border-radius:10px;border:0;background:var(--accent);color:#fff;font-weight:800;cursor:pointer">Save the picks</button>
    </form>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">On the chart now</h2>
    ${current.length ? `<p class="sub" style="margin:0">The live picks (entered for ${esc(prettyDate(current[0].pick_date))}):</p>
    ${current.map((c, i) => `<p class="sub" style="margin:6px 0 0"><b style="color:#fff">${i + 1}. ${esc(c.title)}</b> — ${esc(c.artist)}</p>`).join("")}` : `<p class="sub" style="margin:0">No picks are live right now.</p>`}
  </div>
  <form method="post" action="/dj/logout">
    <button type="submit" style="padding:8px 16px;border-radius:8px;border:1px solid #3a4a6b;background:transparent;color:#bcd;font-weight:700;cursor:pointer">Log out</button>
  </form>`;
  res.send(layout("DJ's Hot Picks panel", "", body));
});

app.post("/dj/picks", requireDj, (req, res) => {
  const target = nextFridayStr();
  const ids = [];
  for (const k of ["pick1", "pick2", "pick3"]) {
    const n = Number(req.body[k]);
    if (n > 0 && !ids.includes(n)) ids.push(n);
  }
  const live = ids.filter((id) => db.prepare("SELECT id FROM songs WHERE id = ? AND status = 'live'").get(id));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM dj_picks WHERE pick_date = ?").run(target);
    const ins = db.prepare("INSERT INTO dj_picks (song_id, pick_date) VALUES (?, ?)");
    for (const id of live) ins.run(id, target);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  const msg = live.length
    ? `Saved ${live.length} pick${live.length === 1 ? "" : "s"} for ${prettyDate(target)}. They step into the National Overall Top 20 when that chart lands at midnight.`
    : `Picks cleared for ${prettyDate(target)} — no DJ picks will step in that Friday.`;
  return res.redirect("/dj?msg=" + encodeURIComponent(msg));
});

// The owner creates/changes the DJ password from inside his admin area
// and hands it to his DJs. Changing it logs every DJ out.
app.post("/admin/dj-password", requireAdmin, (req, res) => {
  const back = (m) => res.redirect("/admin/placements?msg=" + encodeURIComponent(m));
  const n1 = String(req.body.dj_password || ""), n2 = String(req.body.dj_password2 || "");
  if (n1.length < 6) return back("The DJ password needs at least 6 characters.");
  if (n1 !== n2) return back("The DJ password didn't match itself — type it the same way twice.");
  const salt = crypto.randomBytes(8).toString("hex");
  const rec = { salt, hash: hashAdminCode(salt, n1) };
  db.prepare("INSERT INTO admin_config (key, value) VALUES ('dj_password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(rec));
  return back("The DJ password is set. Give it to your DJs — they log in at the DJ Login link at the bottom of the site. Changing it logs every DJ out.");
});

// SPOTLIGHT OF THE WEEK — the owner names the artist the 16th Law says
// is worth recognizing. Stored in admin_config; recognition only.
app.post("/admin/spotlight", requireAdmin, (req, res) => {
  const back = (m) => res.redirect("/admin/placements?msg=" + encodeURIComponent(m));
  const songId = Number(req.body.song_id);
  if (!songId) {
    db.prepare("DELETE FROM admin_config WHERE key = 'spotlight'").run();
    return back("Spotlight cleared — the panel is hidden until you name the next artist.");
  }
  const song = db.prepare("SELECT id FROM songs WHERE id = ? AND status = 'live'").get(songId);
  if (!song) return back("That song isn't live — the spotlight needs a song that's uploaded and live.");
  const note = String(req.body.note || "").trim().slice(0, 280);
  const rec = { song_id: songId, note, set_on: todayStr() };
  db.prepare("INSERT INTO admin_config (key, value) VALUES ('spotlight', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(rec));
  return back("Spotlight set — it's live on the home page now. Name the next one whenever the 16th Law moves you.");
});

// The placement tool: pick any song already uploaded and live, pick a
// chart and a position, and the song is pinned there on every chart
// from today until the placement ends or is removed. Scores are never
// touched — this moves chart order only (charts.js applyAdminPlacements).
app.get("/admin/placements", requireAdmin, async (req, res) => {
  const songs = db.prepare(`
    SELECT s.id, s.title, s.genre, u.name AS artist FROM songs s
    JOIN users u ON u.id = s.artist_id WHERE s.status = 'live' ORDER BY s.title`).all();
  const latest = latestChartDate(db);
  const chartRows = latest ? db.prepare(`
    SELECT DISTINCT level, genre, region_key FROM chart_entries WHERE chart_date = ?
    ORDER BY CASE level WHEN 'national' THEN 0 WHEN 'regional' THEN 1 ELSE 2 END, genre, region_key`).all(latest) : [];
  const chartLabel = (c) => c.level === "national" ? `National · ${c.genre}`
    : c.level === "regional" ? `Regional · ${c.genre} · ${c.region_key}` : `Local · ${c.genre} · ${c.region_key}`;
  const active = db.prepare(`
    SELECT p.*, s.title, u.name AS artist FROM admin_placements p
    JOIN songs s ON s.id = p.song_id JOIN users u ON u.id = s.artist_id
    WHERE p.removed_at IS NULL ORDER BY p.id DESC`).all();
  const chartName = (p) => p.level === "national" ? `National ${p.genre}`
    : p.level === "regional" ? `Regional ${p.genre} (${p.region_key})` : `Local ${p.genre} (${p.region_key})`;
  const statusOf = (p) => p.ends_on && latest && p.ends_on < latest ? "ended"
    : latest && p.starts_on > latest ? "starts at midnight tonight" : "on the chart now";
  const adsList = db.prepare("SELECT * FROM ads ORDER BY id DESC").all();
  // Cloudflare storage (R2): connection state + what's in the bucket, for
  // the owner's media panel. Degrades to "not set up" when storage is off.
  let mediaState = { configured: false, ok: false, error: null, objects: [], hero: null };
  try {
    const hrow = db.prepare("SELECT value FROM admin_config WHERE key = 'hero_r2'").get();
    if (hrow) mediaState.hero = JSON.parse(hrow.value);
  } catch { /* no hero override yet */ }
  if (storage.configured()) {
    mediaState.configured = true;
    const t = await storage.testConnection();
    mediaState.ok = t.ok; mediaState.error = t.error;
    if (t.ok) { try { mediaState.objects = await storage.listObjects("", 100); } catch { /* list is a bonus */ } }
  }
  const body = `
  <h1>Chart placements</h1>
  ${req.query.admsg ? `<p class="note" style="color:#ffd98a">${esc(req.query.admsg)}</p>` : ""}
  <p class="sub">Owner tool. Place any song that's already uploaded and live into a chart at the position you choose. You can enter a placement any time — it goes onto the chart at the next 12 AM chart change, same as every entry, and holds through each midnight recalculation until it ends or you remove it (removals also land at midnight). A song's evaluation scores are never changed — this sets chart position only.</p>
  ${req.query.msg ? `<div class="panel" style="border-left:3px solid var(--accent)"><p class="sub" style="margin:0">${esc(req.query.msg)}</p></div>` : ""}
  <div class="panel">
    <h2 style="margin-top:0">Place a song</h2>
    <form method="post" action="/admin/placements">
      <label class="sub">Song<br>
      <select name="song_id" required style="width:100%;padding:12px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff">
        ${songs.map((s) => `<option value="${s.id}">${esc(s.title)} — ${esc(s.artist)} (${esc(s.genre)})</option>`).join("")}
      </select></label>
      <label class="sub">Chart<br>
      <select name="chart" required style="width:100%;padding:12px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff">
        ${chartRows.map((c) => `<option value="${esc(c.level)}|${esc(c.genre)}|${esc(c.region_key)}">${esc(chartLabel(c))}</option>`).join("")}
      </select></label>
      <label class="sub">Position (1 = #1)<br>
      <input type="number" name="rank" min="1" max="100" value="20" required
        style="width:120px;padding:12px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff"></label><br>
      <label class="sub">How long<br>
      <select name="duration" style="width:100%;padding:12px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff">
        <option value="open">Until I remove it</option>
        <option value="7">7 days</option>
        <option value="30">30 days</option>
      </select></label>
      <label class="sub">Private note (who / why — only you see this)<br>
      <input type="text" name="note" maxlength="200" placeholder="e.g. Pushed the site at his show in Dallas"
        style="width:100%;padding:12px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff"></label>
      <button type="submit" style="padding:12px 22px;border-radius:10px;border:0;background:var(--accent);color:#fff;font-weight:800;cursor:pointer">Place it</button>
    </form>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">Placements on record</h2>
    ${active.length ? active.map((p) => `
    <div style="border-bottom:1px solid #22304f;padding:10px 0">
      <p class="sub" style="margin:0"><b style="color:#fff">${esc(p.title)}</b> — ${esc(p.artist)}<br>
      ${esc(chartName(p))} at <b style="color:#fff">#${p.rank}</b> · ${p.starts_on} → ${p.ends_on || "until removed"} · <b style="color:#fff">${statusOf(p)}</b>
      ${p.note ? `<br>Note: ${esc(p.note)}` : ""}</p>
      <form method="post" action="/admin/placements/${p.id}/remove" style="margin-top:8px">
        <button type="submit" style="padding:8px 16px;border-radius:8px;border:1px solid #5b2b2b;background:#2a1113;color:#ff9d9d;font-weight:700;cursor:pointer">Remove placement</button>
      </form>
    </div>`).join("") : `<p class="sub">No placements yet.</p>`}
  </div>
  <div class="panel">
    <h2 style="margin-top:0">⭐ Spotlight of the Week</h2>
    <p class="sub">The 16th Law, in public: name the one artist you feel is <b style="color:#fff">worth recognizing</b> this week — the gift, the value they bring. Their song headlines a gold panel on the home page with your words under it. Recognition only — it never touches a score or a chart spot. Change it any week; clear it and the panel hides.</p>
    <form method="post" action="/admin/spotlight">
      <label class="sub">Artist's song<br>
      <select name="song_id" style="width:100%;padding:12px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff">
        <option value="">— clear the spotlight —</option>
        ${songs.map((s) => `<option value="${s.id}">${esc(s.title)} — ${esc(s.artist)} (${esc(s.genre)})</option>`).join("")}
      </select></label>
      <label class="sub">Your words — why this artist (shows on the home page)<br>
      <input type="text" name="note" maxlength="280" placeholder="e.g. Raw gift. You hear it once and you know — this is the one to watch."
        style="width:100%;padding:12px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff"></label>
      <button type="submit" style="padding:12px 22px;border-radius:10px;border:0;background:var(--accent);color:#fff;font-weight:800;cursor:pointer">Set the spotlight</button>
    </form>
  </div>
  ${(() => { const pend = adsList.filter((a) => a.status === 'pending'); return pend.length ? `<div class="panel" style="border-color:rgba(255,190,60,.7)"><h2>📥 Ad submissions waiting on you (${pend.length})</h2><p class="sub" style="margin-top:0">Sent from the Advertise page. Watch each one — nothing runs until you approve it.</p>${pend.map((a) => `
    <div style="padding:10px 0;border-bottom:1px solid var(--line)">
      ${a.kind === 'video' ? `<video src="${esc(a.file_path)}" controls preload="metadata" style="width:100%;max-height:220px;border-radius:10px;background:#000"></video>` : `<img src="${esc(a.file_path)}" alt="Submitted ad" style="width:100%;max-height:220px;object-fit:contain;border-radius:10px;background:#000">`}
      <p style="margin:8px 0 2px"><b style="color:#fff">${esc(a.submitter || a.title)}</b> <span class="note">${esc(a.contact || '')} · 🎯 ${!a.genre || a.genre === 'All' ? 'All channels' : esc(a.genre)} · ${a.kind === 'video' ? 'video' : 'image · ' + a.seconds + 's'}${a.link_url ? ` · links to ${esc(a.link_url)}` : ''}</span></p>
      ${a.note ? `<p class="note" style="margin:2px 0">“${esc(a.note)}”</p>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px">
        <form method="post" action="/admin/ads/${a.id}/approve"><button class="btn primary" style="padding:9px 16px">✔ Approve — put it in rotation</button></form>
        <form method="post" action="/admin/ads/${a.id}/delete" onsubmit="return confirm('Decline and delete this ad?')"><button class="mini" style="padding:9px 14px">✖ Decline</button></form>
      </div>
    </div>`).join('')}</div>` : ''; })()}
  <form class="panel" method="post" action="/admin/ads" enctype="multipart/form-data" style="border-color:rgba(255,120,190,.55)">
    <h2>📣 Stage ads — upload your own</h2>
    <p class="sub" style="margin-top:0">Ads play <b style="color:#fff">inside the Stage rotation, between songs</b> — one ad after every 5 songs, <b style="color:#fff">on the channel you pick</b>: a Pop ad runs on the Pop stage, a Hip-Hop ad on the Hip-Hop stage. "All channels" runs everywhere, and the Main Stage rotates every ad. Upload an <b style="color:#fff">image</b> or a <b style="color:#fff">video no longer than 30 seconds</b>. When the ad ends, the rotation picks right back up and the next song's countdown keeps running. Ads never touch scores or ranks.</p>
    <div class="field"><label for="adfile">Ad file — image or video (max 30 seconds)</label><input id="adfile" type="file" name="adfile" accept="image/*,video/mp4,video/webm,video/quicktime" required></div>
    <div class="grid">
      <div class="field"><label for="adtitle">Title (your label for it)</label><input id="adtitle" name="title" maxlength="80" placeholder="e.g. Mesquite BBQ Weekend"></div>
      <div class="field"><label for="adseconds">Image ads: seconds on screen</label><select id="adseconds" name="seconds"><option value="5">5 seconds</option><option value="8" selected>8 seconds</option><option value="10">10 seconds</option><option value="15">15 seconds</option><option value="20">20 seconds</option><option value="30">30 seconds</option></select></div>
      <div class="field"><label for="adgenre">Run this ad on</label><select id="adgenre" name="genre"><option value="All">All channels (incl. Main Stage)</option>${GENRES.map((g) => `<option value="${esc(g)}">${esc(g)} only</option>`).join("")}</select></div>
    </div>
    <div class="field"><label for="adlink">Tap/click takes people here (optional)</label><input id="adlink" name="link_url" maxlength="300" placeholder="https://..."></div>
    <button class="btn primary">Upload ad</button>
  </form>
  ${adsList.filter((a) => a.status !== 'pending').length ? `<div class="panel"><h2>Ads on file (${adsList.filter((a) => a.status !== 'pending').length})</h2>${adsList.filter((a) => a.status !== 'pending').map((a) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.kind === 'video' ? '🎬' : '🖼️'} <b style="color:#fff">${esc(a.title || a.file_path.split('/').pop())}</b> <span class="note">${a.kind === 'video' ? 'video' : 'image · ' + a.seconds + 's'} · 🎯 ${!a.genre || a.genre === 'All' ? 'All channels' : a.genre} · ${a.active ? '<b style="color:#9fe8b6">IN ROTATION</b>' : 'off'}</span></span>
      <span style="display:flex;gap:6px;flex:none">
        <form method="post" action="/admin/ads/${a.id}/toggle"><button class="mini">${a.active ? 'Pause' : 'Run it'}</button></form>
        <form method="post" action="/admin/ads/${a.id}/delete" onsubmit="return confirm('Delete this ad for good?')"><button class="mini">Delete</button></form>
      </span>
    </div>`).join('')}</div>` : `<div class="panel"><p class="note" style="margin:0">No ads yet — upload the first one above and it joins the rotation.</p></div>`}
  <div class="panel">
    <h2 style="margin-top:0">🎧 DJ panel access</h2>
    <p class="sub">Your DJs get their OWN login that opens <b style="color:#fff">only</b> the weekly DJ's Hot Picks panel — they pick the 3 songs for Friday there. They never see placements or anything else in the admin. Set the DJ password here and hand it to your DJs; they log in with the <b style="color:#fff">DJ Login</b> link at the bottom of any page. Changing the password logs every DJ out.</p>
    <form method="post" action="/admin/dj-password">
      <label class="sub">New DJ password (6+ characters)<br>
      <input type="password" name="dj_password" required style="width:240px;padding:12px;margin:6px 0 10px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff"></label><br>
      <label class="sub">New DJ password again<br>
      <input type="password" name="dj_password2" required style="width:240px;padding:12px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff"></label><br>
      <button type="submit" style="padding:10px 20px;border-radius:10px;border:0;background:var(--accent);color:#fff;font-weight:800;cursor:pointer">Set the DJ password</button>
    </form>
    <p class="sub" style="margin:12px 0 0"><a href="/dj" style="color:var(--accent);font-weight:700;text-decoration:none">Open the DJ panel →</a></p>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">🎙️ Viewcast Studio</h2>
    <p class="sub">Film an episode — you on camera, or an artist in front of you — inside a studio set, and post it to the Viewcast page.</p>
    <p class="sub" style="margin:12px 0 0"><a href="/admin/viewcast" style="color:var(--accent);font-weight:700;text-decoration:none">Open the Viewcast studio →</a></p>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">🎬 Site media — Cloudflare storage</h2>
    ${!mediaState.configured ? `<p class="sub">Storage is not connected yet — the four R2 settings still need to go into the site's Render environment. Until then the site runs on its built-in copies, same as always.</p>`
    : !mediaState.ok ? `<p class="sub" style="color:#ff9d9d">Storage is set up but the connection check failed: ${esc(mediaState.error || "unknown error")}. The site keeps running on its built-in copies. Tell Vesper what this line says and she'll sort it.</p>`
    : `<p class="sub" style="color:#9fe8a9">✅ Connected to your bucket <b style="color:#fff">top20-media</b>. Files uploaded here travel whole — no more pieces.</p>
    <p class="sub"><b style="color:#fff">Welcome video (hero):</b> ${mediaState.hero ? `your uploaded copy is LIVE on the home page — uploaded ${esc(new Date(mediaState.hero.at).toLocaleString("en-US", { timeZone: "America/Chicago" }))}, ${(mediaState.hero.size / 1048576).toFixed(1)} MB${mediaState.hero.name ? ` (${esc(mediaState.hero.name)})` : ""}.` : `the built-in copy is playing. Upload your own below and it takes over the home page.`}</p>
    <form method="post" action="/admin/media/hero" enctype="multipart/form-data">
      <label class="sub">${mediaState.hero ? "Replace the welcome video" : "Upload the welcome video"} (mp4)<br>
      <input type="file" name="file" accept="video/mp4,video/*" required style="margin:6px 0 10px;color:#fff"></label><br>
      <button type="submit" style="padding:10px 20px;border-radius:10px;border:0;background:var(--accent);color:#fff;font-weight:800;cursor:pointer">${mediaState.hero ? "Replace welcome video" : "Put it on the home page"}</button>
    </form>
    ${mediaState.hero ? `<form method="post" action="/admin/media/hero/reset" style="margin-top:10px"><button type="submit" style="padding:8px 16px;border-radius:8px;border:1px solid #3a4a6b;background:transparent;color:#bcd;font-weight:700;cursor:pointer">Go back to the built-in welcome video</button></form>` : ""}
    <hr style="border:0;border-top:1px solid #26355a;margin:18px 0">
    <form method="post" action="/admin/media/upload" enctype="multipart/form-data">
      <label class="sub">Upload another file to your storage (video, audio, image)<br>
      <input type="file" name="file" required style="margin:6px 0 10px;color:#fff"></label><br>
      <button type="submit" style="padding:10px 20px;border-radius:10px;border:0;background:#22355e;color:#fff;font-weight:800;cursor:pointer">Upload file</button>
    </form>
    ${mediaState.objects.length ? `<p class="sub" style="margin:16px 0 6px"><b style="color:#fff">In your bucket now (${mediaState.objects.length}):</b></p>
    ${mediaState.objects.map((o) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #1d2a47"><span class="sub" style="margin:0;word-break:break-all">${esc(o.key)} · ${(o.size / 1048576).toFixed(2)} MB</span><span style="white-space:nowrap"><a href="${esc(storage.presignGet(o.key, 3600) || "#")}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:700;text-decoration:none">Open</a>${o.key.startsWith("media/") ? ` <form method="post" action="/admin/media/delete" style="display:inline"><input type="hidden" name="key" value="${esc(o.key)}"><button type="submit" style="margin-left:8px;padding:4px 10px;border-radius:6px;border:1px solid #5a2630;background:transparent;color:#ff9d9d;font-weight:700;cursor:pointer">Delete</button></form>` : ""}</span></div>`).join("")}` : `<p class="sub" style="margin-top:14px">Your bucket is empty — the first upload lands here.</p>`}`}
  </div>
  <div class="panel">
    <h2 style="margin-top:0">Your admin code</h2>
    <p class="sub">Change the 8-digit code you log in with. You'll type your current code once, then the new code twice. If the site ever gets a big rebuild, the code can reset to the starter code you were given — change it again here any time.</p>
    <form method="post" action="/admin/code">
      <label class="sub">Current code<br>
      <input type="password" name="current_code" inputmode="numeric" maxlength="8" required style="width:180px;padding:12px;margin:6px 0 10px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff;letter-spacing:4px"></label><br>
      <label class="sub">New code (8 digits)<br>
      <input type="password" name="new_code" inputmode="numeric" maxlength="8" required style="width:180px;padding:12px;margin:6px 0 10px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff;letter-spacing:4px"></label><br>
      <label class="sub">New code again<br>
      <input type="password" name="new_code2" inputmode="numeric" maxlength="8" required style="width:180px;padding:12px;margin:6px 0 12px;border-radius:10px;border:1px solid #3a4a6b;background:#0a1122;color:#fff;letter-spacing:4px"></label><br>
      <button type="submit" style="padding:10px 20px;border-radius:10px;border:0;background:var(--accent);color:#fff;font-weight:800;cursor:pointer">Change my code</button>
    </form>
    <form method="post" action="/admin/logout" style="margin-top:14px">
      <button type="submit" style="padding:8px 16px;border-radius:8px;border:1px solid #3a4a6b;background:transparent;color:#bcd;font-weight:700;cursor:pointer">Log out</button>
    </form>
  </div>`;
  res.send(layout("Chart placements", "", body));
});

// ---- Owner site media on Cloudflare R2 storage -------------------------
// Files travel WHOLE from this panel into the owner's bucket — this is the
// permanent cure for media ever shipping through git in base64 pieces.
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AD_UP),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || "").toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
      cb(null, `media-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 150 * 1024 * 1024 },
});
const mediaMsg = (res, text) => res.redirect("/admin/placements?msg=" + encodeURIComponent(text));

app.post("/admin/media/hero", requireAdmin, (req, res) => {
  if (!storage.configured()) return mediaMsg(res, "Storage is not connected yet — the R2 settings still need to go into Render.");
  mediaUpload.single("file")(req, res, async (err) => {
    if (err || !req.file) return mediaMsg(res, "That upload didn't come through — try the file again.");
    try {
      const r = await storage.putFile("site/hero.mp4", req.file.path, req.file.mimetype || "video/mp4");
      db.prepare("INSERT INTO admin_config (key, value) VALUES ('hero_r2', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify({ key: r.key, size: r.size, at: new Date().toISOString(), name: req.file.originalname }));
      mediaMsg(res, "✅ Your welcome video is in storage and now plays on the home page.");
    } catch (e) {
      mediaMsg(res, "Upload failed: " + String(e.message || e).slice(0, 160));
    } finally {
      try { fs.unlinkSync(req.file.path); } catch { /* temp file gone either way */ }
    }
  });
});

app.post("/admin/media/hero/reset", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM admin_config WHERE key = 'hero_r2'").run();
  mediaMsg(res, "The built-in welcome video is back on the home page. Your uploaded copy is still in your bucket if you want it again.");
});

app.post("/admin/media/upload", requireAdmin, (req, res) => {
  if (!storage.configured()) return mediaMsg(res, "Storage is not connected yet — the R2 settings still need to go into Render.");
  mediaUpload.single("file")(req, res, async (err) => {
    if (err || !req.file) return mediaMsg(res, "That upload didn't come through — try the file again.");
    try {
      const safe = String(req.file.originalname || "file").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "file";
      const r = await storage.putFile(`media/${Date.now()}-${safe}`, req.file.path, req.file.mimetype || "application/octet-stream");
      mediaMsg(res, `✅ "${req.file.originalname}" is in your bucket (${(r.size / 1048576).toFixed(2)} MB).`);
    } catch (e) {
      mediaMsg(res, "Upload failed: " + String(e.message || e).slice(0, 160));
    } finally {
      try { fs.unlinkSync(req.file.path); } catch { /* temp file gone either way */ }
    }
  });
});

app.post("/admin/media/delete", requireAdmin, async (req, res) => {
  const key = String(req.body.key || "");
  if (!key.startsWith("media/")) return mediaMsg(res, "That file is managed by its own controls — it can't be deleted from the list.");
  try {
    await storage.deleteObject(key);
    mediaMsg(res, "Deleted from your bucket: " + key);
  } catch (e) {
    mediaMsg(res, "Delete failed: " + String(e.message || e).slice(0, 160));
  }
});

app.post("/admin/placements", requireAdmin, (req, res) => {
  const songId = Number(req.body.song_id);
  const [level, genre, region_key] = String(req.body.chart || "").split("|");
  const rank = Math.max(1, Math.min(100, Number(req.body.rank) || 20));
  const song = db.prepare("SELECT id, title FROM songs WHERE id = ? AND status = 'live'").get(songId);
  const chartOk = latestChartDate(db) && db.prepare(
    "SELECT id FROM chart_entries WHERE chart_date = ? AND level = ? AND genre = ? AND region_key = ? LIMIT 1"
  ).get(latestChartDate(db), level, genre, region_key);
  if (!song || !chartOk) return res.redirect("/admin/placements?msg=" + encodeURIComponent("That song or chart isn't available — the song has to be uploaded and live first."));
  const today = todayStr();
  // Placements ride the midnight cycle like every chart entry: entered
  // today, the song first appears on TOMORROW's chart (dealt at 12 AM).
  const starts_on = new Date(new Date(today + "T12:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
  let ends_on = null;
  const days = Number(req.body.duration);
  if (days === 7 || days === 30) {
    ends_on = new Date(new Date(starts_on + "T12:00:00Z").getTime() + (days - 1) * 86400000).toISOString().slice(0, 10);
  }
  db.prepare(`INSERT INTO admin_placements (song_id, level, genre, region_key, rank, starts_on, ends_on, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(songId, level, genre, region_key, rank, starts_on, ends_on, String(req.body.note || "").slice(0, 200) || null);
  return res.redirect("/admin/placements?msg=" + encodeURIComponent(`"${song.title}" is set for #${rank}. It goes onto the chart tonight at 12 AM (the ${starts_on} chart) and holds until ${ends_on || "you remove it"}.`));
});

app.post("/admin/placements/:id/remove", requireAdmin, (req, res) => {
  const today = todayStr();
  db.prepare(`UPDATE admin_placements
    SET removed_at = datetime('now'),
        ends_on = CASE WHEN ends_on IS NULL OR ends_on > ? THEN ? ELSE ends_on END
    WHERE id = ? AND removed_at IS NULL`).run(today, today, Number(req.params.id));
  return res.redirect("/admin/placements?msg=" + encodeURIComponent("Placement ends tonight at 12 AM — tomorrow's chart returns that song to pure score order."));
});

/* --------------------------------- Outbox --------------------------------- */

app.get("/admin/outbox", (req, res) => {
  const rows = db.prepare(`
    SELECT n.*, u.email, u.name AS artist, s.title
    FROM notifications n
    JOIN users u ON u.id = n.user_id
    JOIN songs s ON s.id = n.song_id
    ORDER BY n.id DESC
  `).all();
  const body = `
  <h1>Email outbox</h1>
  <p class="sub">Simulated chart-entry emails (v1: emails land here instead of a real inbox). This outbox only ever contains GOOD news — a song entering a Top 20. There is no fall-off email, by design: artists come back to the site to check their rank.</p>
  ${rows.length ? rows.map((n) => `
  <div class="panel" style="border-left:3px solid var(--accent)">
    <p class="sub" style="margin:0"><b style="color:#fff">To:</b> ${esc(n.email)}<br>
    <b style="color:#fff">Subject:</b> ${esc(emailSubject(n))}<br>
    <b style="color:#fff">When:</b> ${esc(n.created_at)}</p>
    <p class="note" style="margin-top:8px">${esc(emailBody(n, n.artist, n.title, String(n.created_at).slice(0, 10)))}</p>
  </div>`).join("") : `<div class="panel"><p class="sub">No chart-entry emails yet.</p></div>`}`;
  res.send(layout("Outbox", "outbox", body));
});

app.post("/admin/recalc", (req, res) => {
  const r = recalc(db);
  res.json({ ok: true, date: r.date, entries: r.entryCount, newNotifications: r.notifications.length });
});

/* ---------------------------------- main ---------------------------------- */

/* ------------------------------ Viewcast ---------------------------------
   (Owner, Nov 1, 2026.) The site's own little TV studio, behind the staff
   login. The owner opens a camera — front (talking to the people) or back
   (filming an artist on location) — and the studio lifts the person out of
   the real room and sets them inside a chosen backdrop: a true virtual
   background, segmented live in the browser (MediaPipe), with a VIEWCAST
   frame and a lower-third name bar burned in. Recording posts an episode:
   transcoded here to a universal MP4 with a poster frame, listed on
   /viewcast, and mirrored into the bucket like every other upload
   (storage phase 2). If the segmentation library can't load, the studio
   falls back to frame mode — the camera as a big framed picture over the
   set — so a take is never blocked. */

const VIEWCAST_KEYS = Object.keys(VIEWCAST_SETS);
const backdropBuf = {};
for (const k of VIEWCAST_KEYS) backdropBuf[k] = Buffer.from(VIEWCAST_SETS[k].data.split(",")[1], "base64");

app.get("/viewcast/backdrop/:key.jpg", (req, res) => {
  const buf = backdropBuf[req.params.key];
  if (!buf) return res.status(404).end();
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
  res.send(buf);
});

/* Foreground layers for the desk sets: the desk band of the same photo,
   drawn over the person so they stand behind the mixer (owner, Nov 1). */
const VIEWCAST_FG = require("./viewcast-fg-data");
const fgBuf = {};
for (const k of Object.keys(VIEWCAST_FG)) fgBuf[k] = Buffer.from(VIEWCAST_FG[k].split(",")[1], "base64");
app.get("/viewcast/foreground/:key.webp", (req, res) => {
  const buf = fgBuf[req.params.key];
  if (!buf) return res.status(404).end();
  res.set({ "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" });
  res.send(buf);
});

/* Tall (phone 9:16) versions of the sets, framed so the whole sign
   fits a phone screen. A set without one 404s and the studio falls
   back to its wide picture. */
const VIEWCAST_TALL = (() => { try { return require("./viewcast-tall-data"); } catch { return {}; } })();
const tallBuf = {};
for (const k of Object.keys(VIEWCAST_TALL)) tallBuf[k] = Buffer.from(VIEWCAST_TALL[k].split(",")[1], "base64");
app.get("/viewcast/backdrop-tall/:key.jpg", (req, res) => {
  const buf = tallBuf[req.params.key];
  if (!buf) return res.status(404).end();
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
  res.send(buf);
});

const viewcastUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, VIEWCAST_UP),
    filename: (req, file, cb) => cb(null, `raw-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${(path.extname(file.originalname || "") || ".webm").toLowerCase()}`),
  }),
  limits: { fileSize: 400 * 1024 * 1024 },
});

function episodeDuration(absPath) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", absPath], { encoding: "utf8" });
    return parseFloat(JSON.parse(out).format.duration) || null;
  } catch { return null; }
}

// Every take becomes a phone-friendly MP4 (H.264 + AAC, fast-start) plus a
// poster frame, whatever the recording browser handed us (usually WebM).
function buildEpisodeFiles(rawPath, mp4Path, posterPath) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-v", "error", "-i", rawPath, "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", mp4Path], (err) => {
      if (err) return reject(err);
      execFile("ffmpeg", ["-y", "-v", "error", "-ss", "1", "-i", mp4Path, "-frames:v", "1", "-q:v", "4", posterPath], () => resolve());
    });
  });
}

app.get("/admin/viewcast", requireAdmin, (req, res) => {
  const eps = db.prepare("SELECT * FROM viewcast_episodes ORDER BY id DESC").all();
  const setBtns = VIEWCAST_KEYS.map((k) => `
    <button type="button" class="vset${k === "graffiti" ? " on" : ""}" data-key="${k}" onclick="pickSet('${k}')" style="background:#0a0f22;border:2px solid ${k === "graffiti" ? "#f2c14e" : "#232a45"};border-radius:10px;padding:6px;cursor:pointer;color:#e9ecf2;width:132px">
      <img src="/viewcast/backdrop/${k}.jpg" alt="" style="width:100%;border-radius:6px;display:block">
      <span style="font-size:12.5px;font-weight:700">${esc(VIEWCAST_SETS[k].label)}</span>
    </button>`).join("");
  const epRows = eps.map((ep) => `
    <div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #232a45">
      ${ep.poster_path ? `<img src="${esc(ep.poster_path)}" alt="" style="width:96px;border-radius:6px">` : ""}
      <div style="flex:1;min-width:0">
        <strong>${esc(ep.title)}</strong> ${ep.status !== "live" ? `<span style="color:#ffb020;font-size:12px">HIDDEN</span>` : ""}
        <br><span style="color:#8a8f99;font-size:12.5px">${esc(String(ep.created_at).slice(0, 16))} · ${esc(VIEWCAST_SETS[ep.backdrop] ? VIEWCAST_SETS[ep.backdrop].label : ep.backdrop)}${ep.duration_sec ? " · " + Math.round(ep.duration_sec) + "s" : ""}</span>
        <br><a href="/viewcast/${ep.id}" style="color:#f2c14e;font-size:13px">Watch page</a>
      </div>
      <form method="post" action="/admin/viewcast/toggle" style="margin:0"><input type="hidden" name="id" value="${ep.id}"><button style="background:#1a2140;color:#e9ecf2;border:1px solid #2c3a6e;border-radius:8px;padding:6px 10px;cursor:pointer">${ep.status === "live" ? "Hide" : "Show"}</button></form>
      <form method="post" action="/admin/viewcast/delete" style="margin:0" onsubmit="return confirm('Delete this episode for good?')"><input type="hidden" name="id" value="${ep.id}"><button style="background:#3a1120;color:#ffb3c1;border:1px solid #6e2c3a;border-radius:8px;padding:6px 10px;cursor:pointer">Delete</button></form>
    </div>`).join("");
  res.send(layout("Viewcast Studio", "viewcast", `
  <p><a href="/admin/placements" style="color:#f2c14e">← Chart placements</a></p>
  <h1>🎙️ Viewcast Studio</h1>
  <p style="color:#c9cdd6">Your studio, right in the site. Turn the camera on, pick a set, and the person on camera is lifted out of the room and set inside it — film yourself up front, or flip the camera and film an artist wherever you're standing. Hit record, give the episode a title, and post it to the Viewcast page.</p>
  <div class="panel">
    <canvas id="vstage" width="1280" height="720" style="width:100%;border-radius:10px;background:#000;display:block"></canvas>
    <video id="vcam" playsinline muted style="display:none"></video>
    <p id="vstatus" style="color:#f2c14e;margin:10px 0 4px">Tap “Turn camera on” to open the studio.</p>
    <p style="margin:4px 0"><span id="vtimer" style="font-weight:800;color:#ff5f6b"></span></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
      <button type="button" onclick="startCam()" style="background:#f2c14e;color:#131313;border:0;border-radius:9px;padding:11px 16px;font-weight:800;cursor:pointer">📷 Turn camera on</button>
      <button type="button" onclick="flipCam()" style="background:#1a2140;color:#e9ecf2;border:1px solid #2c3a6e;border-radius:9px;padding:11px 16px;font-weight:700;cursor:pointer">🔄 Flip camera</button>
      <button type="button" id="recBtn" onclick="startRec()" disabled style="background:#c22743;color:#fff;border:0;border-radius:9px;padding:11px 16px;font-weight:800;cursor:pointer;opacity:.55">● Record</button>
      <button type="button" id="stopBtn" onclick="stopRec()" disabled style="background:#1a2140;color:#e9ecf2;border:1px solid #2c3a6e;border-radius:9px;padding:11px 16px;font-weight:700;cursor:pointer;opacity:.55">■ Stop</button>
    </div>
    <p style="margin:10px 0 4px"><strong>Screen:</strong><br>
      <button type="button" class="fmtBtn" data-fmt="wide" onclick="setFormat('wide')" style="background:#1a2140;color:#e9ecf2;border:2px solid #f2c14e;border-radius:8px;padding:9px 13px;font-weight:700;cursor:pointer;margin-top:6px">📺 YouTube — wide</button>
      <button type="button" class="fmtBtn" data-fmt="tall" onclick="setFormat('tall')" style="background:#1a2140;color:#e9ecf2;border:2px solid #2c3a6e;border-radius:8px;padding:9px 13px;font-weight:700;cursor:pointer;margin-top:6px">📱 Phone — tall</button>
      <span style="color:#8a8f99;font-size:12.5px;display:block;margin-top:4px">Tall sets are framed so the whole HOT TOP 20 sign fits the phone screen.</span>
    </p>
    <p style="margin:12px 0 6px"><strong>Pick your set:</strong></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${setBtns}</div>
    <p style="margin:14px 0 6px"><strong>✨ Effects — shape the person to fit the room:</strong></p>
    <div style="display:grid;gap:6px;max-width:560px">
      <label style="color:#c9cdd6;font-size:14px">Slim — narrow the figure a touch<input type="range" id="fxSlimR" min="0" max="100" value="0" oninput="setFx('slim', this.value)" style="width:100%"></label>
      <label style="color:#c9cdd6;font-size:14px">Step back — smaller in the room, deeper behind the desk<input type="range" id="fxBackR" min="0" max="100" value="0" oninput="setFx('back', this.value)" style="width:100%"></label>
      <label style="color:#c9cdd6;font-size:14px">Smooth — soften the skin, keep the edge crisp<input type="range" id="fxSmoothR" min="0" max="100" value="0" oninput="setFx('smooth', this.value)" style="width:100%"></label>
      <label style="color:#c9cdd6;font-size:14px">Brighten — lift a dim room's light on the face<input type="range" id="fxBrightR" min="0" max="100" value="0" oninput="setFx('bright', this.value)" style="width:100%"></label>
      <p style="margin:2px 0"><button type="button" onclick="resetFx()" style="background:#1a2140;color:#e9ecf2;border:1px solid #2c3a6e;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer">Reset effects</button></p>
    </div>
    <div style="display:grid;gap:8px;margin-top:14px;max-width:560px">
      <input id="vtitle" placeholder="Episode title — e.g. This Week's Uploads" style="padding:11px;border-radius:8px;border:1px solid #2c3a6e;background:#0a0f22;color:#e9ecf2">
      <input id="vname" placeholder="Name on screen — e.g. Dale · Top 20 (optional)" style="padding:11px;border-radius:8px;border:1px solid #2c3a6e;background:#0a0f22;color:#e9ecf2">
      <input id="vtopic" placeholder="Topic line — e.g. Talking new uploads (optional)" style="padding:11px;border-radius:8px;border:1px solid #2c3a6e;background:#0a0f22;color:#e9ecf2">
    </div>
    <video id="vprev" controls playsinline style="display:none;width:100%;border-radius:10px;margin-top:14px;background:#000"></video>
    <p style="margin-top:10px"><button type="button" id="postBtn" onclick="postEp()" disabled style="background:#1db954;color:#08130c;border:0;border-radius:9px;padding:12px 18px;font-weight:800;cursor:pointer;opacity:.55">⬆ Post episode to Viewcast</button></p>
    <p style="color:#8a8f99;font-size:12.5px">Good light on the face makes the cleanest edge. The take stays on this phone until you post it; posting saves it to your bucket for good.</p>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">👥 Bring in a guest — free</h2>
    <p style="color:#c9cdd6;margin:6px 0">Make an invite link and send it to your guest. They tap it on any phone or computer — no account, no app — and their camera joins this studio. Pick how they sit in the picture, then record like normal: the recording keeps both of you.</p>
    <p style="margin:8px 0"><button type="button" id="invBtn" onclick="makeInvite()" style="background:#f2c14e;color:#131313;border:0;border-radius:9px;padding:11px 16px;font-weight:800;cursor:pointer">🔗 Make my invite link</button></p>
    <div id="invBox" style="display:none">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input id="invLink" readonly style="flex:1;min-width:220px;padding:11px;border-radius:8px;border:1px solid #2c3a6e;background:#0a0f22;color:#e9ecf2">
        <button type="button" onclick="copyInvite()" style="background:#1a2140;color:#e9ecf2;border:1px solid #2c3a6e;border-radius:8px;padding:11px 14px;font-weight:700;cursor:pointer">Copy link</button>
      </div>
      <p id="invStatus" style="color:#f2c14e;margin:8px 0 4px">Send that link to your guest — waiting for them…</p>
      <p style="margin:8px 0 2px"><strong>Guest in the picture:</strong><br>
        <button type="button" class="layBtn" data-lay="split" onclick="setLayout('split')" style="background:#1a2140;color:#e9ecf2;border:2px solid #f2c14e;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;margin-top:6px">Side by side</button>
        <button type="button" class="layBtn" data-lay="pip" onclick="setLayout('pip')" style="background:#1a2140;color:#e9ecf2;border:2px solid #2c3a6e;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;margin-top:6px">Corner window</button>
        <button type="button" class="layBtn" data-lay="solo" onclick="setLayout('solo')" style="background:#1a2140;color:#e9ecf2;border:2px solid #2c3a6e;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;margin-top:6px">Just me</button>
        <button type="button" onclick="endGuest()" style="background:#3a1120;color:#ffb3c1;border:1px solid #6e2c3a;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;margin-top:6px">End guest</button>
      </p>
    </div>
    <video id="gremote" autoplay playsinline style="display:none"></video>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">Your episodes</h2>
    ${eps.length ? epRows : `<p style="color:#8a8f99;margin:4px 0">None yet — your first recording lands here.</p>`}
  </div>
  <script src="https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js" crossorigin="anonymous"></script>
  <script>
  var video = document.getElementById('vcam'), canvas = document.getElementById('vstage'), ctx = canvas.getContext('2d');
  var W = 1280, H = 720, stream = null, facing = 'user', micTrack = null;
  var seg = null, segBusy = false, mode = 'virtual';
  var currentSet = 'graffiti', backdropImg = new Image(); backdropImg.src = '/viewcast/backdrop/graffiti.jpg';
  // Screen format (owner, Nov 1): wide = YouTube 16:9, tall = phone
  // 9:16. Tall sets are framed so the whole HOT TOP 20 sign fits the
  // phone screen; a set without a tall version falls back to its wide
  // picture rather than breaking.
  var vcFormat = 'wide';
  function loadBackdrop() {
    var img = new Image();
    img.onload = function () { backdropImg = img; };
    img.onerror = function () { var f = new Image(); f.onload = function () { backdropImg = f; }; f.src = '/viewcast/backdrop/' + currentSet + '.jpg'; };
    img.src = (vcFormat === 'tall' ? '/viewcast/backdrop-tall/' : '/viewcast/backdrop/') + currentSet + '.jpg';
  }
  function setFormat(f) {
    vcFormat = f;
    W = f === 'tall' ? 720 : 1280; H = f === 'tall' ? 1280 : 720;
    canvas.width = W; canvas.height = H;
    var btns = document.querySelectorAll('.fmtBtn');
    for (var i = 0; i < btns.length; i++) btns[i].style.borderColor = (btns[i].getAttribute('data-fmt') === f) ? '#f2c14e' : '#2c3a6e';
    loadBackdrop();
  }
  // ✨ Effects (owner, Nov 1): the host shapes their own picture to fit
  // the room — slim, step back, smooth, brighten. Saved on this phone.
  var fxSlim = 0, fxBack = 0, fxSmooth = 0, fxBright = 0;
  try {
    var savedFx = JSON.parse(localStorage.getItem('vcfx') || '{}');
    fxSlim = (savedFx.slim || 0) / 100; fxBack = (savedFx.back || 0) / 100;
    fxSmooth = (savedFx.smooth || 0) / 100; fxBright = (savedFx.bright || 0) / 100;
  } catch (e) {}
  function saveFx() { try { localStorage.setItem('vcfx', JSON.stringify({ slim: fxSlim * 100, back: fxBack * 100, smooth: fxSmooth * 100, bright: fxBright * 100 })); } catch (e) {} }
  function setFx(which, v) {
    var f = Math.max(0, Math.min(100, +v || 0)) / 100;
    if (which === 'slim') fxSlim = f; else if (which === 'back') fxBack = f;
    else if (which === 'smooth') fxSmooth = f; else if (which === 'bright') fxBright = f;
    saveFx();
  }
  function resetFx() {
    fxSlim = fxBack = fxSmooth = fxBright = 0;
    var ids = ['fxSlimR', 'fxBackR', 'fxSmoothR', 'fxBrightR'];
    for (var i = 0; i < ids.length; i++) { var el = document.getElementById(ids[i]); if (el) el.value = 0; }
    saveFx();
  }
  (function initFxSliders() {
    var pairs = [['fxSlimR', fxSlim], ['fxBackR', fxBack], ['fxSmoothR', fxSmooth], ['fxBrightR', fxBright]];
    for (var i = 0; i < pairs.length; i++) { var el = document.getElementById(pairs[i][0]); if (el) el.value = Math.round(pairs[i][1] * 100); }
  })();
  var recorder = null, chunks = [], recTimer = null, recStart = 0, lastBlob = null;
  function setStatus(t) { document.getElementById('vstatus').textContent = t; }
  function pickSet(key) {
    currentSet = key; loadBackdrop();
    var btns = document.querySelectorAll('.vset');
    for (var i = 0; i < btns.length; i++) btns[i].style.borderColor = (btns[i].getAttribute('data-key') === key) ? '#f2c14e' : '#232a45';
  }
  function drawCoverInto(img, x, y, w, h) {
    var iw = img.videoWidth || img.naturalWidth || img.width, ih = img.videoHeight || img.naturalHeight || img.height;
    if (!iw || !ih) return;
    var s = Math.max(w / iw, h / ih), dw = iw * s, dh = ih * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  function roundRectPath(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function drawChrome() {
    ctx.save();
    ctx.lineWidth = Math.max(6, H * 0.012); ctx.strokeStyle = '#c9a227'; ctx.strokeRect(6, 6, W - 12, H - 12);
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(233,236,242,.85)'; ctx.strokeRect(18, 18, W - 36, H - 36);
    ctx.font = '800 ' + Math.round(H * 0.042) + 'px Arial';
    var label = 'VIEWCAST'; var tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(2,6,18,.72)'; roundRectPath(ctx, 30, 30, tw + 30, H * 0.078, 10); ctx.fill();
    ctx.fillStyle = '#f2c14e'; ctx.fillRect(44, 30 + H * 0.024, 10, H * 0.03);
    ctx.fillStyle = '#f2c14e'; ctx.textBaseline = 'middle'; ctx.fillText(label, 64, 30 + H * 0.039 + 2);
    var name = (document.getElementById('vname').value || '').trim();
    var topic = (document.getElementById('vtopic').value || '').trim();
    if (name || topic) {
      var bh = H * 0.135, by = H - bh - 30, bw = Math.min(W * 0.66, W - 60);
      ctx.fillStyle = 'rgba(2,6,18,.78)'; roundRectPath(ctx, 30, by, bw, bh, 10); ctx.fill();
      ctx.fillStyle = '#f2c14e'; ctx.fillRect(30, by, 7, bh);
      if (name) { ctx.fillStyle = '#ffffff'; ctx.font = '800 ' + Math.round(H * 0.04) + 'px Arial'; ctx.fillText(name, 54, by + bh * (topic ? 0.33 : 0.5)); }
      if (topic) { ctx.fillStyle = '#c9cdd6'; ctx.font = Math.round(H * 0.03) + 'px Arial'; ctx.fillText(topic, 54, by + bh * (name ? 0.72 : 0.5)); }
    }
    ctx.restore();
  }
  function drawFrameMode() {
    drawCoverInto(backdropImg, 0, 0, W, H);
    var ar = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9;
    var ch = H * 0.84, cw = ch * ar;
    if (cw > W * 0.88) { cw = W * 0.88; ch = cw / ar; }
    var cx = (W - cw) / 2, cy = (H - ch) / 2;
    ctx.save(); ctx.beginPath(); ctx.rect(cx, cy, cw, ch); ctx.clip(); drawCoverInto(video, cx, cy, cw, ch); ctx.restore();
    ctx.lineWidth = 6; ctx.strokeStyle = '#c9a227'; ctx.strokeRect(cx, cy, cw, ch);
    drawChrome();
  }
  function onSeg(results) {
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(results.segmentationMask, 0, 0, W, H);
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(results.image, 0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-over';
    drawCoverInto(backdropImg, 0, 0, W, H);
    ctx.restore();
    drawChrome();
  }
  function initSeg() {
    if (seg || mode === 'frame') return;
    try {
      if (typeof SelfieSegmentation === 'undefined') { mode = 'frame'; return; }
      seg = new SelfieSegmentation({ locateFile: function (f) { return 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/' + f; } });
      seg.setOptions({ modelSelection: 1 });
      seg.onResults(onSeg);
    } catch (e) { seg = null; mode = 'frame'; }
  }
  async function pump() {
    if (!stream) return;
    if (seg && !segBusy && video.readyState >= 2) {
      segBusy = true;
      try { await seg.send({ image: video }); } catch (e) { mode = 'frame'; }
      segBusy = false;
    }
    if (!seg || mode === 'frame') drawFrameMode();
    requestAnimationFrame(pump);
  }
  async function startCam() {
    try {
      if (stream) { var tr = stream.getTracks(); for (var i = 0; i < tr.length; i++) tr[i].stop(); }
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
      video.srcObject = stream;
      await video.play();
      if (video.videoWidth && video.videoHeight) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; W = canvas.width; H = canvas.height; }
      micTrack = stream.getAudioTracks()[0] || null;
      initSeg(); pump();
      var rb = document.getElementById('recBtn'); rb.disabled = false; rb.style.opacity = 1;
      setStatus(mode === 'frame' ? 'Camera on (framed-picture mode). Pick a set, then hit Record.' : 'Camera on — the virtual set is live. Pick a set, then hit Record.');
    } catch (e) { setStatus('The camera did not open — allow camera access for this site in your browser, then tap again.'); }
  }
  function flipCam() { facing = (facing === 'user') ? 'environment' : 'user'; if (stream) startCam(); }
  function fmtT(s) { var m = Math.floor(s / 60), r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
  function startRec() {
    if (!stream) { setStatus('Turn the camera on first.'); return; }
    chunks = [];
    var cs = canvas.captureStream(30);
    if (micTrack) cs.addTrack(micTrack);
    var mt = '';
    if (window.MediaRecorder) {
      if (MediaRecorder.isTypeSupported('video/mp4')) mt = 'video/mp4';
      else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) mt = 'video/webm;codecs=vp9,opus';
      else if (MediaRecorder.isTypeSupported('video/webm')) mt = 'video/webm';
    }
    try { recorder = new MediaRecorder(cs, mt ? { mimeType: mt } : undefined); }
    catch (e) { setStatus('This browser cannot record — try Chrome.'); return; }
    recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = onRecStop;
    recorder.start(500);
    recStart = Date.now();
    var tv = document.getElementById('vtimer');
    tv.textContent = '● REC 0:00';
    recTimer = setInterval(function () { tv.textContent = '● REC ' + fmtT(Math.floor((Date.now() - recStart) / 1000)); }, 500);
    document.getElementById('recBtn').disabled = true;
    var sb = document.getElementById('stopBtn'); sb.disabled = false; sb.style.opacity = 1;
    setStatus('Recording… talk away.');
  }
  function stopRec() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    clearInterval(recTimer); document.getElementById('vtimer').textContent = '';
    document.getElementById('recBtn').disabled = false;
    var sb = document.getElementById('stopBtn'); sb.disabled = true; sb.style.opacity = .55;
  }
  function onRecStop() {
    lastBlob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'video/webm' });
    var prev = document.getElementById('vprev');
    prev.src = URL.createObjectURL(lastBlob); prev.style.display = 'block';
    var pb = document.getElementById('postBtn'); pb.disabled = false; pb.style.opacity = 1;
    setStatus('Take saved on this phone — watch it back above, then post it.');
  }
  async function postEp() {
    var title = (document.getElementById('vtitle').value || '').trim();
    if (!title) { setStatus('Give the episode a title first.'); return; }
    if (!lastBlob) { setStatus('Record a take first.'); return; }
    var fd = new FormData();
    fd.append('video', lastBlob, 'viewcast' + (lastBlob.type.indexOf('mp4') >= 0 ? '.mp4' : '.webm'));
    fd.append('title', title); fd.append('backdrop', currentSet);
    var pb = document.getElementById('postBtn'); pb.disabled = true; pb.style.opacity = .55;
    setStatus('Posting your episode — this can take a moment for a long take…');
    try {
      var r = await fetch('/admin/viewcast/upload', { method: 'POST', body: fd });
      var j = await r.json();
      if (j.ok) { setStatus('Posted! Refreshing your episode list…'); setTimeout(function () { location.reload(); }, 900); }
      else { setStatus(j.error || 'Posting failed — try again.'); pb.disabled = false; pb.style.opacity = 1; }
    } catch (e) { setStatus('Posting failed — check your connection and try again.'); pb.disabled = false; pb.style.opacity = 1; }
  }
  </script>
  <script>
  // ---- Viewcast guest interviews (host side) + compositing v2 ----
  // The segmentation composite is painted onto an offscreen canvas so the
  // main canvas can place the host (full frame, or left in side-by-side),
  // lay the guest's camera in as a studio window, and keep the VIEWCAST
  // chrome on top. Recording picks up the mixed host+guest audio.
  var hostC = document.createElement('canvas'), hctx = hostC.getContext('2d');
  var roomCode = null, pc = null, guestStream = null, guestOn = false, layoutMode = 'split', offerOut = false, hostPollTimer = null;
  var mixCtx = null, mixDest = null;
  function sizeHostC() { if (hostC.width !== W || hostC.height !== H) { hostC.width = W; hostC.height = H; } }
  function drawCoverCtx(c, el, x, y, w, h) {
    var iw = el.videoWidth || el.naturalWidth || el.width, ih = el.videoHeight || el.naturalHeight || el.height;
    if (!iw || !ih) return;
    var sa = iw / ih, da = w / h, sw, sh, sx, sy;
    if (sa > da) { sh = ih; sw = ih * da; sx = (iw - sw) / 2; sy = 0; } else { sw = iw; sh = iw / da; sx = 0; sy = (ih - sh) / 2; }
    c.drawImage(el, sx, sy, sw, sh, x, y, w, h);
  }
  function paintHostFrame() {
    sizeHostC();
    hctx.save(); hctx.clearRect(0, 0, W, H);
    drawCoverCtx(hctx, backdropImg, 0, 0, W, H);
    var ar = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9;
    var ch = H * 0.84, cw = ch * ar;
    if (cw > W * 0.88) { cw = W * 0.88; ch = cw / ar; }
    var cx = (W - cw) / 2, cy = (H - ch) / 2;
    hctx.beginPath(); hctx.rect(cx, cy, cw, ch); hctx.clip();
    drawCoverCtx(hctx, video, cx, cy, cw, ch);
    hctx.restore();
    hctx.lineWidth = 6; hctx.strokeStyle = '#c9a227'; hctx.strokeRect(cx, cy, cw, ch);
  }
  function drawGuestWin() {
    if (!guestOn || layoutMode === 'solo') return;
    var gv = document.getElementById('gremote');
    if (!gv || gv.readyState < 2) return;
    var x, y, w, h;
    if (layoutMode === 'pip') { w = W * 0.30; h = w * 9 / 16; x = W - w - 36; y = H - h - 36; }
    else { w = W * 0.40; h = H * 0.60; x = W - w - 42; y = H * 0.15; }
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    drawCoverCtx(ctx, gv, x, y, w, h);
    ctx.restore();
    ctx.lineWidth = 5; ctx.strokeStyle = '#c9a227'; ctx.strokeRect(x, y, w, h);
    var bw = W * 0.085, bh = H * 0.045;
    ctx.fillStyle = 'rgba(2,6,18,.78)'; ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = '#f2c14e'; ctx.font = '800 ' + Math.round(H * 0.024) + 'px Arial'; ctx.textBaseline = 'middle';
    ctx.fillText('GUEST', x + 10, y + bh / 2 + 1);
  }
  // Scene depth (owner, Nov 1, REVISED same evening): Dale's phone test
  // killed the desk-in-front idea — a frozen desk in front of a moving
  // person reads fake. NOTHING sits in front of the person now; the
  // room is all behind them, and only a soft shadow at their feet
  // seats them into it.
  function drawFeetShadow() {
    var gy = H * 0.985, R = W * 0.26;
    var grd = ctx.createRadialGradient(W / 2, gy, 8, W / 2, gy, R);
    grd.addColorStop(0, 'rgba(0,0,0,.35)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(W / 2, gy); ctx.scale(1, 0.12); ctx.translate(-W / 2, -gy);
    ctx.fillStyle = grd;
    ctx.fillRect(W / 2 - R, gy - R, R * 2, R * 2);
    ctx.restore();
  }
  function drawHostInto(x, y, w, h) {
    // Step back shrinks the figure toward the floor line; Slim narrows
    // it. The camera picture is cover-cropped into the frame (never
    // stretched), bottom-anchored so the feet stay on the floor.
    var s = 1 - fxBack * 0.28;
    var dw = w * s * (1 - fxSlim * 0.14), dh = h * s;
    var iw = hostC.width, ih = hostC.height;
    if (!iw || !ih) return;
    var cs = Math.max(dw / iw, dh / ih), cw = dw / cs, ch = dh / cs;
    ctx.drawImage(hostC, (iw - cw) / 2, ih - ch, cw, ch, x + (w - dw) / 2, y + (h - dh), dw, dh);
  }
  function composeFrame() {
    ctx.save(); ctx.clearRect(0, 0, W, H);
    if (mode === 'frame') {
      ctx.drawImage(hostC, 0, 0, W, H);
    } else {
      drawCoverCtx(ctx, backdropImg, 0, 0, W, H);
      if (guestOn && layoutMode === 'split') drawCoverCtx(ctx, hostC, 30, 30, W * 0.52, H - 60);
      else { drawFeetShadow(); drawHostInto(0, 0, W, H); }
    }
    ctx.restore();
    drawGuestWin();
    drawChrome();
  }
  var VC_TINT = {
    graffiti: 'brightness(.97) saturate(1.06)', neon: 'brightness(.97) saturate(1.05)',
    led: 'brightness(.96) saturate(1.02)', rnb: 'brightness(.98) saturate(1.05)',
    radio: 'brightness(.97) sepia(.12)', teal: 'brightness(.98)',
    blue: 'brightness(.96) saturate(1.03)', leather: 'brightness(.97) sepia(.10)',
    soul: 'brightness(.97) sepia(.14)'
  };
  var maskC = document.createElement('canvas'), maskX = maskC.getContext('2d');
  var prevC = document.createElement('canvas'), prevX = prevC.getContext('2d');
  initSeg = function () {
    if (seg || mode === 'frame') return;
    try {
      if (typeof SelfieSegmentation === 'undefined') { mode = 'frame'; return; }
      seg = new SelfieSegmentation({ locateFile: function (f) { return 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/' + f; } });
      seg.setOptions({ modelSelection: 1 });
      seg.onResults(function (results) {
        sizeHostC();
        if (maskC.width !== W || maskC.height !== H) { maskC.width = W; maskC.height = H; prevC.width = W; prevC.height = H; }
        // Edge cleanup (owner, Nov 1): the raw mask leaves flaky scraps
        // around hair and shoulders. Blend in the previous frame's mask
        // behind this one (kills flicker and stray specks), then stamp it
        // through a soft blur so the cut edge feathers onto the set
        // instead of ending in a hard, scrapy line.
        maskX.save();
        maskX.globalCompositeOperation = 'copy';
        maskX.drawImage(results.segmentationMask, 0, 0, W, H);
        maskX.globalCompositeOperation = 'destination-over';
        maskX.globalAlpha = 0.6;
        maskX.drawImage(prevC, 0, 0, W, H);
        maskX.restore();
        prevX.save();
        prevX.globalCompositeOperation = 'copy';
        prevX.drawImage(maskC, 0, 0, W, H);
        prevX.restore();
        hctx.save(); hctx.clearRect(0, 0, W, H);
        try { hctx.filter = 'blur(2px)'; } catch (e) {}
        hctx.drawImage(maskC, 0, 0, W, H);
        try { hctx.filter = 'none'; } catch (e) {}
        hctx.globalCompositeOperation = 'source-in';
        // Light match + effects: grade the person with the room's own
        // light so they read as lit BY the set, not pasted onto it.
        // Smooth lays a soft blurred copy under the sharp one — the
        // mask keeps the cut edge crisp while skin softens. Brighten
        // lifts a dim room.
        var tintStr = VC_TINT[currentSet] || '';
        if (fxSmooth > 0) {
          try { hctx.filter = (tintStr + ' blur(3px) brightness(1.04)').trim() || 'none'; } catch (e) {}
          hctx.globalAlpha = 1;
          hctx.drawImage(results.image, 0, 0, W, H);
        }
        try { hctx.filter = (tintStr + (fxBright > 0 ? ' brightness(' + (1 + fxBright * 0.18).toFixed(3) + ')' : '')).trim() || 'none'; } catch (e) {}
        hctx.globalAlpha = fxSmooth > 0 ? 1 - 0.45 * fxSmooth : 1;
        hctx.drawImage(results.image, 0, 0, W, H);
        hctx.globalAlpha = 1;
        try { hctx.filter = 'none'; } catch (e) {}
        hctx.restore();
      });
    } catch (e) { seg = null; mode = 'frame'; }
  };
  pump = async function () {
    if (!stream) return;
    if (seg && !segBusy && video.readyState >= 2) {
      segBusy = true;
      try { await seg.send({ image: video }); } catch (e) { mode = 'frame'; }
      segBusy = false;
    }
    if (!seg || mode === 'frame') paintHostFrame();
    composeFrame();
    requestAnimationFrame(pump);
  };
  function recAudioTrack() {
    if (guestOn && guestStream && guestStream.getAudioTracks().length) {
      try {
        if (!mixCtx) {
          mixCtx = new (window.AudioContext || window.webkitAudioContext)();
          mixDest = mixCtx.createMediaStreamDestination();
          mixCtx.createMediaStreamSource(stream).connect(mixDest);
        }
        if (mixDest._wiredFor !== guestStream.id) {
          mixCtx.createMediaStreamSource(guestStream).connect(mixDest);
          mixDest._wiredFor = guestStream.id;
        }
        if (mixCtx.state === 'suspended') mixCtx.resume();
        return mixDest.stream.getAudioTracks()[0];
      } catch (e) {}
    }
    return micTrack;
  }
  startRec = function () {
    if (!stream) { setStatus('Turn the camera on first.'); return; }
    chunks = [];
    var cs = canvas.captureStream(30);
    var at = recAudioTrack();
    if (at) cs.addTrack(at);
    var mt = '';
    if (window.MediaRecorder) {
      if (MediaRecorder.isTypeSupported('video/mp4')) mt = 'video/mp4';
      else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) mt = 'video/webm;codecs=vp9,opus';
      else if (MediaRecorder.isTypeSupported('video/webm')) mt = 'video/webm';
    }
    try { recorder = new MediaRecorder(cs, mt ? { mimeType: mt } : undefined); }
    catch (e) { setStatus('This browser cannot record — try Chrome.'); return; }
    recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = onRecStop;
    recorder.start(500);
    recStart = Date.now();
    var tv = document.getElementById('vtimer');
    tv.textContent = '● REC 0:00';
    recTimer = setInterval(function () { tv.textContent = '● REC ' + fmtT(Math.floor((Date.now() - recStart) / 1000)); }, 500);
    document.getElementById('recBtn').disabled = true;
    var sb = document.getElementById('stopBtn'); sb.disabled = false; sb.style.opacity = 1;
    setStatus(guestOn ? 'Recording — you and your guest are both in this take.' : 'Recording… talk away.');
  };
  function invSet(t) { document.getElementById('invStatus').textContent = t; }
  async function makeInvite() {
    try {
      var r = await fetch('/admin/viewcast/room', { method: 'POST' });
      var j = await r.json();
      if (!j.ok) { invSet('The invite could not be made — try again.'); return; }
      roomCode = j.code;
      document.getElementById('invLink').value = location.origin + j.url;
      document.getElementById('invBox').style.display = 'block';
      document.getElementById('invBtn').textContent = '🔗 Make a fresh invite link';
      invSet(stream ? 'Send that link to your guest — waiting for them…' : 'Link ready — now turn your camera on above, then send the link.');
      if (hostPollTimer) clearInterval(hostPollTimer);
      hostPollTimer = setInterval(hostPoll, 900);
      hostPoll();
    } catch (e) { setStatus('The invite could not be made — check your connection.'); }
  }
  function copyInvite() {
    var inp = document.getElementById('invLink');
    inp.select(); inp.setSelectionRange(0, 9999);
    if (navigator.clipboard) navigator.clipboard.writeText(inp.value).then(function () { invSet('Link copied — send it to your guest.'); }, function () { document.execCommand('copy'); });
    else document.execCommand('copy');
  }
  async function hsend(msg) {
    if (!roomCode) return;
    try { await fetch('/api/viewcast/signal/' + roomCode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'host', msg: msg }) }); } catch (e) {}
  }
  async function hostPoll() {
    if (!roomCode) return;
    try {
      var r = await fetch('/api/viewcast/poll/' + roomCode + '/host');
      if (!r.ok) { invSet('This invite link expired — make a fresh one.'); clearInterval(hostPollTimer); return; }
      var j = await r.json();
      for (var i = 0; i < j.msgs.length; i++) await handleHostMsg(j.msgs[i]);
      if (j.peerJoined && !offerOut && !guestOn) startCall();
    } catch (e) {}
  }
  async function handleHostMsg(msg) {
    if (msg.type === 'hello') { if (!offerOut && !guestOn) startCall(); return; }
    if (!pc) return;
    try {
      if (msg.type === 'answer') await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
      else if (msg.type === 'ice') { if (msg.data) await pc.addIceCandidate(new RTCIceCandidate(msg.data)); }
      else if (msg.type === 'bye') guestGone('Your guest left the interview. The link still works if they come back.');
    } catch (e) {}
  }
  function startCall() {
    if (offerOut || guestOn) return;
    if (!stream) { invSet('Your guest is here — turn your camera on above and they come in.'); return; }
    offerOut = true;
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    var sendFeed = canvas.captureStream(30);
    sendFeed.getVideoTracks().forEach(function (t) { pc.addTrack(t, sendFeed); });
    if (micTrack) pc.addTrack(micTrack, stream);
    pc.ontrack = function (ev) {
      guestStream = ev.streams[0];
      document.getElementById('gremote').srcObject = guestStream;
    };
    pc.onicecandidate = function (ev) { if (ev.candidate) hsend({ type: 'ice', data: ev.candidate }); };
    pc.onconnectionstatechange = function () {
      if (!pc) return;
      if (pc.connectionState === 'connected') { guestOn = true; invSet('● Your guest is ON — pick how they sit in the picture, then record like normal.'); }
      else if (pc.connectionState === 'failed') { guestGone('The connection could not get through your guest\u2019s network. They can try different Wi-Fi or mobile data and tap the link again.'); }
      else if (pc.connectionState === 'disconnected' && guestOn) { guestGone('Your guest\u2019s connection dropped. The link still works if they come back.'); }
    };
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () { hsend({ type: 'offer', data: pc.localDescription }); }).catch(function () {});
    invSet('Your guest is here — bringing them in…');
  }
  function guestGone(note) {
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    guestStream = null; guestOn = false; offerOut = false;
    document.getElementById('gremote').srcObject = null;
    invSet(note);
  }
  function endGuest() { hsend({ type: 'bye' }); guestGone('Guest ended. Make a fresh link any time.'); }
  function setLayout(l) {
    layoutMode = l;
    var btns = document.querySelectorAll('.layBtn');
    for (var i = 0; i < btns.length; i++) btns[i].style.borderColor = (btns[i].getAttribute('data-lay') === l) ? '#f2c14e' : '#2c3a6e';
  }
  </script>`));
});

app.post("/admin/viewcast/upload", requireAdmin, viewcastUpload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "No video came through — record a take and try again." });
  const title = String(req.body.title || "").trim().slice(0, 120) || "Viewcast episode";
  const backdrop = VIEWCAST_KEYS.includes(req.body.backdrop) ? req.body.backdrop : "graffiti";
  const stamp = Date.now();
  const mp4Name = `episode-${stamp}.mp4`;
  const posterName = `episode-${stamp}.jpg`;
  const mp4Path = path.join(VIEWCAST_UP, mp4Name);
  const posterPath = path.join(VIEWCAST_UP, posterName);
  try {
    await buildEpisodeFiles(req.file.path, mp4Path, posterPath);
  } catch {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(500).json({ ok: false, error: "That take couldn't be processed — try a shorter one." });
  }
  try { fs.unlinkSync(req.file.path); } catch {}
  const info = db.prepare("INSERT INTO viewcast_episodes (title, backdrop, file_path, poster_path, duration_sec) VALUES (?, ?, ?, ?, ?)")
    .run(title, backdrop, `/uploads/viewcast/${mp4Name}`, `/uploads/viewcast/${posterName}`, episodeDuration(mp4Path));
  mirrorUpload(mp4Path);
  mirrorUpload(posterPath);
  snapshotDbSoon();
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.post("/admin/viewcast/toggle", requireAdmin, (req, res) => {
  const ep = db.prepare("SELECT * FROM viewcast_episodes WHERE id = ?").get(req.body.id);
  if (ep) db.prepare("UPDATE viewcast_episodes SET status = ? WHERE id = ?").run(ep.status === "live" ? "hidden" : "live", ep.id);
  res.redirect("/admin/viewcast");
});

app.post("/admin/viewcast/delete", requireAdmin, (req, res) => {
  const ep = db.prepare("SELECT * FROM viewcast_episodes WHERE id = ?").get(req.body.id);
  if (ep) {
    db.prepare("DELETE FROM viewcast_episodes WHERE id = ?").run(ep.id);
    for (const p of [ep.file_path, ep.poster_path]) {
      if (p) { try { fs.unlinkSync(path.join(PUBLIC_DIR, p)); } catch {} }
    }
    snapshotDbSoon();
  }
  res.redirect("/admin/viewcast");
});

app.get("/viewcast", (req, res) => {
  const eps = db.prepare("SELECT * FROM viewcast_episodes WHERE status = 'live' ORDER BY id DESC").all();
  const cards = eps.map((ep) => `
    <a class="panel" href="/viewcast/${ep.id}" style="display:block;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      ${ep.poster_path ? `<img src="${esc(ep.poster_path)}" alt="" style="width:100%;display:block;aspect-ratio:16/9;object-fit:cover">` : ""}
      <div style="padding:12px 14px"><strong>${esc(ep.title)}</strong><br>
      <span style="color:#8a8f99;font-size:12.5px">${esc(String(ep.created_at).slice(0, 10))}${ep.duration_sec ? " · " + Math.round(ep.duration_sec) + "s" : ""} · the ${esc(VIEWCAST_SETS[ep.backdrop] ? VIEWCAST_SETS[ep.backdrop].label : "Podcast Studio")} set</span></div>
    </a>`).join("");
  res.send(layout("Viewcast", "viewcast", `
  <h1>🎙️ Viewcast</h1>
  <p style="color:#c9cdd6">The talk of Top 20 — the uploads, the artists, and what's hot this week, filmed right here in the Viewcast studio.</p>
  ${eps.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px">${cards}</div>` : `<div class="panel"><p style="margin:4px 0">The first episode is on its way — check back soon.</p></div>`}`));
});

app.get("/viewcast/:id", (req, res) => {
  const ep = db.prepare("SELECT * FROM viewcast_episodes WHERE id = ? AND status = 'live'").get(req.params.id);
  if (!ep) return res.status(404).send(layout("Not found", "viewcast", `<div class="panel"><h2>That episode isn't up.</h2><p><a href="/viewcast" style="color:#f2c14e">Back to Viewcast</a></p></div>`));
  res.send(layout(ep.title, "viewcast", `
  <p><a href="/viewcast" style="color:#f2c14e">← All episodes</a></p>
  <h1 style="font-size:24px">${esc(ep.title)}</h1>
  <video controls playsinline preload="metadata" ${ep.poster_path ? `poster="${esc(ep.poster_path)}"` : ""} src="${esc(ep.file_path)}" style="width:100%;border-radius:12px;background:#000"></video>
  <p style="color:#8a8f99;font-size:13px">Filmed ${esc(String(ep.created_at).slice(0, 10))} in the ${esc(VIEWCAST_SETS[ep.backdrop] ? VIEWCAST_SETS[ep.backdrop].label : "Podcast Studio")} set on Viewcast.</p>`,
    { meta: { title: `${ep.title} — Viewcast`, description: "Watch this Viewcast episode on Top 20.", type: "video.other" } }));
});

/* ------------------- Viewcast guest interviews ---------------------------
   (Owner, Nov 1, 2026.) The free one-guest interview. The owner presses
   "Invite a guest" in the studio and gets a link; the guest opens it on
   any phone or computer — no account, no app — taps Join, and their
   camera connects straight to the studio, phone-to-phone (WebRTC). This
   server only introduces the two sides: a tiny in-memory signal relay
   (rooms live in RAM and expire after 2 hours; the video itself never
   passes through the site, so it costs nothing to run). Public STUN helps
   the phones find each other; a home network that blocks direct links
   entirely will show the guest a plain "couldn't connect" — the fix for
   those is a relay service, deliberately not wired in at $0 scope. */

const vcRooms = new Map();
function vcRoom(code) {
  const r = vcRooms.get(code);
  if (!r) return null;
  if (Date.now() - r.created > 2 * 3600 * 1000) { vcRooms.delete(code); return null; }
  return r;
}
setInterval(() => { for (const code of [...vcRooms.keys()]) vcRoom(code); }, 10 * 60 * 1000).unref();

app.post("/admin/viewcast/room", requireAdmin, (req, res) => {
  const code = crypto.randomBytes(4).toString("hex");
  vcRooms.set(code, { created: Date.now(), hostQ: [], guestQ: [], hostSeen: 0, guestSeen: 0, guestJoined: false });
  res.json({ ok: true, code, url: `/viewcast/join/${code}` });
});

app.post("/api/viewcast/signal/:code", (req, res) => {
  const room = vcRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false });
  const from = req.body && req.body.from === "host" ? "host" : "guest";
  const msg = req.body && req.body.msg;
  if (!msg || !msg.type) return res.status(400).json({ ok: false });
  if (from === "guest" && msg.type === "hello") room.guestJoined = true;
  (from === "host" ? room.guestQ : room.hostQ).push(msg);
  res.json({ ok: true });
});

app.get("/api/viewcast/poll/:code/:role", (req, res) => {
  const room = vcRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false });
  const role = req.params.role === "host" ? "host" : "guest";
  const now = Date.now();
  if (role === "host") room.hostSeen = now; else room.guestSeen = now;
  const q = role === "host" ? room.hostQ : room.guestQ;
  const msgs = q.splice(0, q.length);
  res.json({
    ok: true,
    msgs,
    peerSeen: (role === "host" ? room.guestSeen : room.hostSeen) > now - 6000,
    peerJoined: role === "host" ? room.guestJoined : true,
  });
});

app.get("/viewcast/join/:code", (req, res) => {
  const room = vcRoom(req.params.code);
  if (!room) {
    return res.status(404).send(layout("Link expired", "viewcast", `
    <div class="panel" style="text-align:center">
      <h2 style="margin-top:0">This interview link has expired</h2>
      <p style="color:#c9cdd6">Links last two hours. Ask the host to open the Viewcast studio and send you a fresh one.</p>
    </div>`));
  }
  res.send(layout("Join the interview", "viewcast", `
  <div style="text-align:center">
    <h1>🎙️ You're invited to Viewcast</h1>
    <p style="color:#c9cdd6">You've been invited to a live interview on Top 20. No account, no app — just tap Join, let your browser use your camera, and you're on.</p>
  </div>
  <div class="panel">
    <div style="position:relative">
      <video id="gfeed" autoplay playsinline style="width:100%;border-radius:10px;background:#000;display:block"></video>
      <video id="gself" autoplay playsinline muted style="position:absolute;right:10px;bottom:10px;width:26%;border-radius:8px;border:2px solid #c9a227;background:#000"></video>
    </div>
    <p id="gstatus" style="color:#f2c14e;margin:10px 0 4px">Tap Join when you're ready.</p>
    <p style="text-align:center;margin:10px 0 2px">
      <button type="button" id="gjoin" onclick="joinCall()" style="background:#f2c14e;color:#131313;border:0;border-radius:9px;padding:13px 22px;font-weight:800;font-size:16px;cursor:pointer">🎥 Join the interview</button>
      <button type="button" id="gleave" onclick="leaveCall()" disabled style="background:#1a2140;color:#e9ecf2;border:1px solid #2c3a6e;border-radius:9px;padding:13px 18px;font-weight:700;cursor:pointer;opacity:.55">Leave</button>
    </p>
    <p style="color:#8a8f99;font-size:12.5px;text-align:center">Good light on your face and a quiet spot make you look and sound your best. Your camera connects straight to the studio — nothing is recorded unless the host records it.</p>
  </div>
  <script>
  var CODE = ${JSON.stringify(req.params.code)};
  var pc = null, myStream = null, pollTimer = null, joined = false;
  function gset(t) { document.getElementById('gstatus').textContent = t; }
  async function gsend(msg) {
    try { await fetch('/api/viewcast/signal/' + CODE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'guest', msg: msg }) }); } catch (e) {}
  }
  async function gpoll() {
    try {
      var r = await fetch('/api/viewcast/poll/' + CODE + '/guest');
      if (!r.ok) { gset('This link has expired — ask the host for a fresh one.'); clearInterval(pollTimer); return; }
      var j = await r.json();
      for (var i = 0; i < j.msgs.length; i++) await ghandle(j.msgs[i]);
    } catch (e) {}
  }
  async function ghandle(msg) {
    if (!pc) return;
    try {
      if (msg.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
        var ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        gsend({ type: 'answer', data: ans });
        gset('Connecting…');
      } else if (msg.type === 'ice') {
        if (msg.data) await pc.addIceCandidate(new RTCIceCandidate(msg.data));
      } else if (msg.type === 'bye') {
        gset('The host ended the interview. Thanks for coming on!');
      }
    } catch (e) {}
  }
  async function joinCall() {
    if (joined) return;
    try {
      myStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
    } catch (e) { gset('The camera did not open — allow camera access for this site, then tap Join again.'); return; }
    document.getElementById('gself').srcObject = myStream;
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    myStream.getTracks().forEach(function (t) { pc.addTrack(t, myStream); });
    pc.ontrack = function (ev) { document.getElementById('gfeed').srcObject = ev.streams[0]; };
    pc.onicecandidate = function (ev) { if (ev.candidate) gsend({ type: 'ice', data: ev.candidate }); };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'connected') gset('You are ON — the studio sees and hears you. Say hello!');
      else if (pc.connectionState === 'failed') gset('The connection could not get through your network. Try a different Wi-Fi or mobile data, then rejoin.');
      else if (pc.connectionState === 'disconnected') gset('Connection dropped — tap Leave, then Join again.');
    };
    joined = true;
    await gsend({ type: 'hello' });
    pollTimer = setInterval(gpoll, 900);
    gpoll();
    document.getElementById('gjoin').disabled = true;
    var lv = document.getElementById('gleave'); lv.disabled = false; lv.style.opacity = 1;
    gset('Waiting for the host to bring you in…');
  }
  function leaveCall() {
    gsend({ type: 'bye' });
    if (pollTimer) clearInterval(pollTimer);
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (myStream) { myStream.getTracks().forEach(function (t) { t.stop(); }); myStream = null; }
    joined = false;
    document.getElementById('gjoin').disabled = false;
    var lv = document.getElementById('gleave'); lv.disabled = true; lv.style.opacity = .55;
    gset('You left the interview. Tap Join to come back in.');
  }
  </script>`));
});

/* --------------------- Storage phase 2: permanence ----------------------
   (Owner, Nov 1, 2026.) Render's disk is wiped on every deploy, so the
   bucket is the real home of everything an artist entrusts to the site:
   - every uploaded file (song audio, covers, photos, videos, ads) is
     mirrored into the bucket, and any /uploads file missing locally is
     served from the bucket by signed redirect (see the /uploads mount);
   - the record book (the whole database) is snapshotted into the bucket
     shortly after boot, every few minutes after, after artist activity,
     and on shutdown — and restore-db.js pulls it back before the app
     opens it (see the top of this file).
   When storage is not configured, all of this is a no-op. */

const MIRROR_DIRS = [AUDIO_UP, COVER_UP, PHOTO_UP, VIDEO_UP, AD_UP, VIEWCAST_UP];
const MIRRORED = new Set();
const MIRROR_TYPES = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".flac": "audio/flac", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime" };

function mirrorUpload(absPath) {
  if (!storage.configured() || !absPath) return;
  const key = path.relative(PUBLIC_DIR, absPath).split(path.sep).join("/");
  if (!key.startsWith("uploads/") || MIRRORED.has(key)) return;
  MIRRORED.add(key);
  const type = MIRROR_TYPES[path.extname(absPath).toLowerCase()] || "application/octet-stream";
  storage.putFile(key, absPath, type).catch((e) => { MIRRORED.delete(key); console.error("[storage] mirror failed:", key, e.message); });
}

function sweepUploads() {
  if (!storage.configured()) return;
  for (const dir of MIRROR_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) mirrorUpload(path.join(dir, name));
  }
}

let snapBusy = false;
async function snapshotDb(reason) {
  if (!storage.configured() || snapBusy) return;
  snapBusy = true;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    await storage.putFile("db/top20.db", DB_PATH, "application/octet-stream");
    console.log(`[storage] record book snapshotted (${reason})`);
  } catch (e) { console.error("[storage] snapshot failed:", e.message); }
  snapBusy = false;
}
let snapTimer = null;
function snapshotDbSoon() {
  if (!storage.configured() || snapTimer) return;
  snapTimer = setTimeout(() => { snapTimer = null; snapshotDb("activity"); }, 15000);
}

if (storage.configured()) {
  setTimeout(() => { sweepUploads(); snapshotDb("boot"); }, 20000);
  setInterval(() => { sweepUploads(); snapshotDb("interval"); }, 5 * 60 * 1000);
  process.on("SIGTERM", () => {
    // Render gives a short grace window on deploy/stop — use it to seal
    // the record book into the bucket before the process goes.
    Promise.race([snapshotDb("shutdown"), new Promise((r) => setTimeout(r, 8000))]).finally(() => process.exit(0));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TOP 20 v1 listening on http://0.0.0.0:${PORT}`);
  // The chart takes effect at midnight: deal today's chart on boot if the
  // stored one is stale, then check hourly for the date rolling over.
  const deal = () => {
    try {
      const dealt = ensureCurrent(db);
      if (dealt > 0) console.log(`daily chart: dealt ${dealt} new day(s); current chart date ${todayStr()}`);
    } catch (e) {
      console.error("daily chart deal failed:", e.message);
    }
  };
  deal();
  setInterval(deal, 3600000);
});
