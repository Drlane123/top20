// Top 20 — v1 server. Express + node:sqlite. Mobile-first, black gloss +
// chrome theme. Pages: Stage (/), Charts, Song, Upload, Dashboard, Outbox.
const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { openDb } = require("./db");
const { GENRES, OVERALL, CATEGORIES, regionForState, localKey } = require("./config");
const { judgeAudioFile } = require("./judge");
const { recalc, latestChartDate, previousChartDate } = require("./charts");

const PORT = process.env.PORT || 8077;
const PUBLIC_DIR = path.join(__dirname, "public");
const AUDIO_UP = path.join(PUBLIC_DIR, "uploads", "audio");
const COVER_UP = path.join(PUBLIC_DIR, "uploads", "covers");
const VIDEO_UP = path.join(PUBLIC_DIR, "uploads", "videos");
fs.mkdirSync(AUDIO_UP, { recursive: true });
fs.mkdirSync(COVER_UP, { recursive: true });
fs.mkdirSync(VIDEO_UP, { recursive: true });

const db = openDb();
const app = express();
app.use(express.urlencoded({ extended: true }));
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
html{-webkit-text-size-adjust:100%}
body{margin:0;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:#000;background-image:radial-gradient(900px 480px at 50% -8%,#26272e 0%,#070708 55%,#000 100%);
  background-attachment:fixed;-webkit-font-smoothing:antialiased}
.app{max-width:430px;margin:0 auto;min-height:100vh;padding:0 14px 34px;
  background:linear-gradient(180deg,#101013 0,#080809 260px);
  border-left:1px solid #2c2e34;border-right:1px solid #2c2e34;
  box-shadow:0 0 70px rgba(255,255,255,.05)}
a{color:var(--ink)}
header.site{padding:20px 2px 2px;text-align:center}
.wm{display:inline-block;text-align:center}
/* Futuristic wordmark (owner round 3): the ENTIRE mark leans right in
   italic + skew, stamped into the black surface — dark shadow pressed at
   the top/inner edge, thin bright highlight along the bottom edge. The
   blaze runs the full width of the mark, under TOP and the 20 both. */
.wordmark{font-size:44px;font-weight:900;letter-spacing:.5px;line-height:1;text-align:center;
  font-style:italic;transform:skewX(-8deg)}
.wordmark .top{display:inline-block;color:var(--accent);
  background:linear-gradient(180deg,#9db9ff 0%,#2b5cff 45%,#123a9e 78%,#6f97ff 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 -1px 1px rgba(0,0,0,.95)) drop-shadow(0 1px 0 rgba(190,214,255,.35)) drop-shadow(0 0 16px rgba(43,92,255,.35))}
.wordmark .twenty{display:inline-block;font-family:Impact,"Arial Narrow Bold","Franklin Gothic Medium Cond","Helvetica Neue Condensed Black",sans-serif;
  font-weight:900;font-style:italic;letter-spacing:0;padding-right:.1em;
  background:linear-gradient(180deg,#ffffff 0%,#e8ebf1 30%,#aeb5c2 48%,#f4f6fa 55%,#c3c9d4 76%,#ffffff 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 -1px 1px rgba(0,0,0,.95)) drop-shadow(0 1px 0 rgba(255,255,255,.4))}
.blaze{height:11px;width:100%;margin:3px auto 0;position:relative;
  background:
   radial-gradient(16px 11px at 16% 100%,rgba(255,45,0,.85),transparent 70%),
   radial-gradient(22px 13px at 33% 100%,rgba(255,90,0,.95),transparent 70%),
   radial-gradient(18px 12px at 50% 100%,rgba(255,179,0,.9),transparent 70%),
   radial-gradient(24px 13px at 67% 100%,rgba(255,90,0,.95),transparent 70%),
   radial-gradient(16px 11px at 84% 100%,rgba(255,45,0,.85),transparent 70%);
  filter:blur(.3px)}
.blaze-line{height:2px;width:100%;margin:1px auto 0;border-radius:2px;
  background:linear-gradient(90deg,transparent,var(--fire3) 25%,var(--fire2) 50%,var(--fire3) 75%,transparent)}
.hotline{text-align:center;margin-top:5px;font-size:11px;font-weight:800;letter-spacing:3.5px;
  background:linear-gradient(90deg,#ff7a18,#ffc933,#ff7a18);-webkit-background-clip:text;background-clip:text;color:transparent}
.tagline{color:var(--dim);font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-top:5px}
nav.main{display:flex;gap:8px;overflow-x:auto;padding:14px 0 4px;scrollbar-width:none}
nav.main::-webkit-scrollbar{display:none}
nav.main a{flex:0 0 auto;text-decoration:none;color:var(--ink);padding:9px 15px;border-radius:999px;
  border:1px solid var(--line);background:linear-gradient(180deg,#1e1e21,#121214);font-size:14px}
nav.main a.active{background:var(--chrome);color:#0b0b0d;border-color:#7d828d;font-weight:700}
.panel{position:relative;background:linear-gradient(180deg,#141416,#0c0c0e);border:1px solid #33363d;border-radius:16px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 6px 16px rgba(0,0,0,.45);
  padding:16px;margin:14px 0;overflow:hidden}
.panel::before{content:"";position:absolute;left:0;right:0;top:0;height:38%;
  background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,0));pointer-events:none}
.chrome-frame{border:1px solid transparent;border-radius:20px;padding:2px;
  background:linear-gradient(#101013,#0a0a0c) padding-box,var(--chrome) border-box;
  box-shadow:0 8px 22px rgba(0,0,0,.55)}
.chrome-frame .panel{margin:0;border-color:#232429;border-radius:18px;box-shadow:none}
.chrome-frame .panel::before{display:none}
h1{font-size:24px;margin:10px 0 4px} h2{font-size:19px;margin:4px 0 10px} h3{font-size:16px;margin:14px 0 6px}
.sub{color:var(--dim);font-size:14px;line-height:1.5}
.tabs{display:flex;gap:8px;overflow-x:auto;padding:6px 0 2px;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs a,.tabs button{flex:0 0 auto;text-decoration:none;cursor:pointer;color:var(--ink);padding:9px 14px;border-radius:999px;
  border:1px solid var(--line);background:linear-gradient(180deg,#1e1e21,#121214);font-size:14px;font-family:inherit}
.tabs a.active,.tabs button.active{background:var(--chrome);color:#0b0b0d;border-color:#7d828d;font-weight:700}
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
.cover{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:14px;border:1px solid #43464e;display:block}
.row{display:flex;gap:11px;align-items:center;padding:10px 4px;border-bottom:1px solid #232429;text-decoration:none;color:var(--ink)}
.row:last-child{border-bottom:none}
.row .rank{font-size:20px;font-weight:800;width:32px;text-align:center;flex:0 0 auto}
.row .thumb{width:46px;height:46px;border-radius:10px;border:1px solid #43464e;object-fit:cover;flex:0 0 auto}
.row .meta{flex:1;min-width:0}
.row .t{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .a{color:var(--dim);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .nums{text-align:right;font-size:12.5px;color:var(--dim);flex:0 0 auto}
.row .nums b{color:var(--ink);font-size:15px}
.row.playing{background:linear-gradient(90deg,rgba(43,92,255,.14),transparent);border-radius:10px}
.move{width:52px;text-align:right;font-size:12.5px;flex:0 0 auto;font-weight:700}
.move .up{color:var(--up)}
.move .down{color:var(--down)}
.move .flat{color:var(--flat)}
.move .new{color:var(--newgreen)}
.rankwrap{display:flex;flex-direction:column;align-items:center;gap:3px;width:38px;flex:0 0 auto}
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
.stats{display:block;margin-top:3px;font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stats b{color:#eceef1;font-weight:800}
.chartdate{text-align:center;font-size:12.5px;font-weight:800;letter-spacing:2.5px;color:#dfe3ea;margin:12px 0 2px;text-transform:uppercase}
.hero{display:flex;gap:13px;align-items:center;padding:13px 10px;margin-bottom:6px;border-radius:14px;text-decoration:none;color:var(--ink);
  border:1px solid transparent;
  background:linear-gradient(180deg,#17171b,#0d0d0f) padding-box,linear-gradient(180deg,#f2f4f8,#9aa1ae 50%,#e8ebf0) border-box;
  box-shadow:0 0 22px rgba(210,218,232,.13),inset 0 1px 0 rgba(255,255,255,.15)}
.hero .rank{font-size:36px;font-weight:900;line-height:1;
  background:linear-gradient(180deg,#ffffff,#c9cedb 55%,#f4f6fa);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero .cover-lg{width:96px;height:96px;border-radius:12px;border:1px solid #565b66;object-fit:cover;flex:0 0 auto}
.hero .meta{flex:1;min-width:0}
.hero .t{font-size:19px;font-weight:800}
.hero .a{color:var(--dim);font-size:13.5px}
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
.playbtn{flex:0 0 auto;width:62px;height:62px;border-radius:50%;cursor:pointer;border:1px solid #84888f;
  background:var(--chrome);box-shadow:inset 0 1px 0 #fff,0 6px 14px rgba(0,0,0,.55);
  color:var(--accent);font-size:24px;line-height:1;display:flex;align-items:center;justify-content:center;font-family:inherit}
.playbtn:active{transform:translateY(1px)}
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

const DEFAULT_OG_DESC = "TOP 20 — the first-of-its-kind chart algorithm for independent artists. Every uploaded song is judged on 15 points of craft and ranked daily. Only songs uploaded to TOP 20 are ever judged.";

function layout(title, active, body, opts = {}) {
  const nav = [
    ["/", "stage", "The Stage"],
    ["/charts", "charts", "Charts"],
    ["/upload", "upload", "Upload"],
    ["/profile", "profile", "Profile"],
    ["/dashboard", "dashboard", "Dashboard"],
    ["/djs", "djs", "DJs"],
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
<meta property="og:image" content="${esc(meta.image)}">` : ""}
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
<header class="site">
  <div class="wm">
    <div class="wordmark"><span class="top">TOP</span> <span class="twenty">20</span></div>
    <div class="blaze"></div><div class="blaze-line"></div>
  </div>
  ${opts.home ? `<div class="hotline">— HOT 20 — TRENDING NOW —</div>` : ""}
  <div class="tagline">Charts by craft, not just clout</div>
  ${opts.home ? `<div style="margin-top:9px"><a class="btn" href="/profile" style="min-height:38px;padding:8px 20px;font-size:13.5px">Create Profile</a></div>` : ""}
  <nav class="main">${nav}</nav>
</header>
${body}
<footer class="site">TOP 20 — the Stage plays only the Top 20, 24/7.<br>
Fall off the chart and the rotation moves on. Check your rank on the Dashboard.<br>
<a href="/how-it-works" style="color:var(--accent);font-weight:700;text-decoration:none">How it works →</a></footer>
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
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) return;
  try { if (localStorage.getItem(DISMISS_KEY)) return; } catch (e) {}
  var bar = document.getElementById('installBar');
  if (!bar) return;
  var deferred = null;
  var isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  function showBar() {
    try {
      if (sessionStorage.getItem(SHOWN_KEY)) return;
      sessionStorage.setItem(SHOWN_KEY, '1');
    } catch (e) {}
    if (isIOS && !deferred) {
      document.getElementById('installHint').textContent = 'Tap Share, then \u201CAdd to Home Screen\u201D — Top 20 lives on your phone like an app.';
      document.getElementById('installGo').style.display = 'none';
    }
    bar.classList.add('show');
  }
  function schedule() { setTimeout(function () { if (deferred || isIOS) showBar(); }, 3500); }
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
  window.addEventListener('appinstalled', function () { bar.classList.remove('show'); });
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
];
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
        weekDates.add(r.chart_date);
        if (r.rank === 1) at1Dates.add(r.chart_date);
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
    <div class="row rowlink">
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
  <div class="row rowlink">
    <a class="stretch" href="/song/${e.song_id}" aria-label="${esc(e.title)}"></a>
    <span class="rankwrap"><span class="rank">${e.rank}</span>${rankPill(st, e.rank)}</span>
    <img class="thumb" src="${esc(e.cover_path)}" alt="">
    <span class="meta"><span class="t">${esc(e.title)}</span><br><a class="artistlink" href="/artist/${e.artist_id}">${esc(e.artist)}</a>${stats ? statsLine(st) : ""}</span>
    <span class="nums">Craft <b>${e.craft_score}</b><br>Chart <b>${e.chart_score}</b></span>
    <span class="move">${moveHtml(prevMap.get(e.song_id), e.rank)}</span>
  </div>`;
}

// #1 gets the hero treatment (unlike Billboard): bigger cover, bigger rank,
// thin platinum-tinted border — with the full stats line.
function heroRow(e, ctx, prevMap) {
  const st = ctx.stats.get(e.song_id);
  return `
  <div class="hero rowlink">
    <a class="stretch" href="/song/${e.song_id}" aria-label="${esc(e.title)}"></a>
    <span class="rankwrap"><span class="rank">${e.rank}</span>${rankPill(st, e.rank)}</span>
    <img class="cover-lg" src="${esc(e.cover_path)}" alt="">
    <span class="meta"><span class="t">${esc(e.title)}</span><br><a class="artistlink" href="/artist/${e.artist_id}">${esc(e.artist)}</a>${statsLine(st)}</span>
    <span class="nums">Craft <b>${e.craft_score}</b><br>Chart <b>${e.chart_score}</b></span>
    <span class="move">${moveHtml(prevMap.get(e.song_id), e.rank)}</span>
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
    SELECT ce.rank, ce.song_id, s.title, s.cover_path, u.id AS artist_id, u.name AS artist
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
    <div class="row rowlink">
      <a class="stretch" href="/song/${e.song_id}" aria-label="${esc(e.title)}"></a>
      <span class="rankbadge">#${e.rank}</span>
      <img class="thumb" src="${esc(e.cover_path)}" alt="">
      <span class="meta"><span class="t">${esc(e.title)}</span><br><a class="artistlink" href="/artist/${e.artist_id}">${esc(e.artist)}</a></span>
      <span class="gainchip">▲ ${e.gain}</span>
    </div>`).join("");
  return `<div class="panel">
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
    <video controls preload="metadata" playsinline src="${esc(v.video_path)}" style="width:100%;border-radius:12px;margin-top:10px;background:#000"></video>
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
    <video controls preload="metadata" playsinline src="${esc(v.video_path)}" style="width:100%;border-radius:12px;margin-top:8px;background:#000"></video>
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
           ce.rank, j.craft_score
    FROM chart_entries ce
    JOIN songs s ON s.id = ce.song_id
    JOIN users u ON u.id = s.artist_id
    JOIN judge_scores j ON j.song_id = s.id
    WHERE ce.chart_date = ? AND ce.level = 'national' AND ce.genre = ? AND ce.region_key = 'ALL' AND ce.rank <= 20
    ORDER BY ce.rank
  `).all(date, genreKey).map((r) => ({
    id: r.id, title: r.title, artist: r.artist, cover: r.cover_path,
    audio: r.audio_path, rank: r.rank, craft: r.craft_score,
  }));
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
    <p class="sub"><b style="color:#fff">Part 2 — The Judging.</b> Every song uploaded here is scored on 15 points of craft, 1–10 each, fitted genre by genre — then the charts recalculate daily.</p>
    <p style="margin:10px 0 2px"><a href="/how-it-works" style="color:var(--accent);font-weight:700;text-decoration:none">See how it works →</a></p>
  </div>`;
  const stageRules = `
  <div class="panel">
    <h2 style="margin-top:0">How the Stage runs</h2>
    <p class="sub">The rotation plays the Top 20 in order, 1 through 20, 24 hours a day.</p>
    <p class="sub">You're being critiqued 24 hours a day — the algorithm never sleeps.</p>
    <p class="sub">New entries come into play at 12:00 midnight, every night — that's when the new chart takes effect and knocked-off songs leave the rotation.</p>
    <p class="sub"><b style="color:#fff">Nobody's safe.</b> A new entry can hit at midnight any night — you have to keep putting out great material to stay in the Top 20.</p>
  </div>`;

  const tabs = channels.map((c, i) =>
    `<button type="button" data-ch="${i}" class="${i === 0 ? "active" : ""}">${esc(c.label)}</button>`).join("");
  const body = `
  <div class="tabs" id="channelTabs">${tabs}</div>
  ${first ? `
  <div class="chrome-frame"><div class="panel">
    <div class="sub" style="letter-spacing:2px;text-transform:uppercase;font-size:11px">Now playing — <span id="npChannel">Main Stage</span></div>
    <img class="cover" id="npCover" src="${esc(first.cover)}" alt="cover" style="margin-top:10px">
    <h1 id="npTitle">${esc(first.title)}</h1>
    <div class="sub" id="npArtist">${esc(first.artist)}</div>
    <div class="chips">
      <span class="chip">National rank <b id="npRank">#${first.rank}</b></span>
      <span class="chip">Craft score <b id="npCraft">${first.craft}</b></span>
      <span class="chip">Only the Top 20 plays — 24/7</span>
    </div>
  </div></div>
  ${homeNewHtml}
  ${homeChartHtml}
  ${homeRisersHtml}
  ${homeDjHtml}
  ${howStrip}
  <div class="panel">
    <h2 style="margin-top:0">In rotation</h2>
    <div id="rotList"></div>
  </div>
  ${stageRules}
  <div class="playerbar"><div class="panel">
    <img id="barThumb" src="${esc(first.cover)}" alt="">
    <div class="meta"><div class="t" id="barTitle">${esc(first.title)}</div><div class="a" id="barArtist">${esc(first.artist)}</div></div>
    <button type="button" class="playbtn" id="playBtn" aria-label="Play or pause">▶</button>
    <audio id="stageAudio" preload="none"></audio>
  </div></div>
  <script>
  const PLAYLISTS = ${JSON.stringify(channels.map((c) => c.list)).replace(/</g, "\\u003c")};
  const LABELS = ${JSON.stringify(channels.map((c) => c.label))};
  let ch = 0, idx = 0, lastCounted = "";
  const audio = document.getElementById('stageAudio');
  const $ = (id) => document.getElementById(id);
  function renderList(){
    $('rotList').innerHTML = PLAYLISTS[ch].map((t,i) =>
      '<a class="row' + (i===idx?' playing':'') + '" href="#" data-i="' + i + '">' +
      '<span class="rank">' + t.rank + '</span>' +
      '<img class="thumb" src="' + t.cover + '" alt="">' +
      '<span class="meta"><span class="t">' + t.title + '</span><br><span class="a">' + t.artist + '</span></span>' +
      '<span class="nums">Craft<br><b>' + t.craft + '</b></span></a>').join('') ||
      '<p class="sub">No songs in this channel yet.</p>';
    document.querySelectorAll('#rotList .row').forEach((el) => {
      el.addEventListener('click', (e) => { e.preventDefault(); load(parseInt(el.dataset.i, 10), true); });
    });
  }
  function load(i, autoplay){
    const t = PLAYLISTS[ch][i]; if (!t) return;
    idx = i;
    audio.src = t.audio;
    $('npCover').src = t.cover; $('npTitle').textContent = t.title;
    $('npArtist').textContent = t.artist; $('npRank').textContent = '#' + t.rank;
    $('npCraft').textContent = t.craft; $('npChannel').textContent = LABELS[ch];
    $('barThumb').src = t.cover; $('barTitle').textContent = t.title; $('barArtist').textContent = t.artist;
    renderList();
    if (autoplay) audio.play().catch(() => {});
  }
  document.querySelectorAll('#channelTabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#channelTabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      ch = parseInt(b.dataset.ch, 10);
      load(0, false);
    });
  });
  $('playBtn').addEventListener('click', () => { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); });
  audio.addEventListener('play', () => {
    $('playBtn').textContent = '❚❚';
    if (audio.currentSrc !== lastCounted) {
      lastCounted = audio.currentSrc;
      const t = PLAYLISTS[ch][idx];
      if (t) fetch('/api/play/' + t.id, { method: 'POST' }).catch(() => {});
    }
  });
  audio.addEventListener('pause', () => { $('playBtn').textContent = '▶'; });
  audio.addEventListener('ended', () => load((idx + 1) % PLAYLISTS[ch].length, true));
  renderList(); load(0, false);
  </script>` : `<div class="panel"><h2>No songs yet</h2><p class="sub">Run the seed or upload the first song.</p></div>`}`;
  res.send(layout("The Stage", "stage", body, {
    home: true,
    meta: first ? {
      title: "TOP 20 — The Stage",
      description: `Now playing the National Overall Top 20. #1 today: "${first.title}" by ${first.artist}. The rotation plays the Top 20 in order, 1 through 20, 24 hours a day.`,
      image: absUrl(req, first.cover),
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
    ${entries.slice(20, 100).map((e) => billboardRow(e, ctx, prevMap)).join("")}</div>` : ""}`;
  res.send(layout("Charts", "charts", body, {
    meta: {
      title: `${cap(level)} ${genre} Top 20 — TOP 20`,
      description: `Today's ${cap(level)} ${genre} Top 20 on TOP 20 — ranked by craft first, recalculated daily. Only songs uploaded to TOP 20 are ever judged.`,
      image: entries.length ? absUrl(req, entries[0].cover_path) : "",
    },
  }));
});

/* ---------------------------------- Song ---------------------------------- */

app.get("/song/:id", (req, res) => {
  const song = db.prepare(`
    SELECT s.*, u.name AS artist, u.city, u.state, u.email
    FROM songs s JOIN users u ON u.id = s.artist_id WHERE s.id = ?
  `).get(req.params.id);
  if (!song) return res.status(404).send(layout("Not found", "", `<div class="panel"><h2>Song not found</h2></div>`));
  const judge = db.prepare("SELECT * FROM judge_scores WHERE song_id = ?").get(song.id);
  const eng = {};
  for (const r of db.prepare("SELECT type, count FROM engagements WHERE song_id = ?").all(song.id)) eng[r.type] = r.count;
  const { ranks } = songRanks(song.id);
  const songVideo = db.prepare(`
    SELECT v.*, s.title AS song_title FROM videos v
    JOIN songs s ON s.id = v.song_id WHERE v.song_id = ? ORDER BY v.id DESC LIMIT 1
  `).get(song.id);
  const removedNote = song.status !== "live"
    ? `<div class="panel"><p class="sub" style="margin:0">This song has been removed by the artist — only live songs are judged and charted.</p></div>` : "";
  const body = `
  <div class="chrome-frame"><div class="panel" style="padding:10px">
    <img class="cover" src="${esc(song.cover_path)}" alt="cover">
  </div></div>
  <h1>${esc(song.title)}</h1>
  <p class="sub"><a href="/artist/${song.artist_id}" style="color:var(--accent);font-weight:700;text-decoration:none">${esc(song.artist)}</a> · ${esc(song.genre)} · ${esc(song.city)}, ${esc(song.state)}</p>
  ${removedNote}
  <audio controls preload="metadata" src="${esc(song.audio_path)}"></audio>
  <div class="flexbtns">
    <form method="post" action="/song/${song.id}/engage"><input type="hidden" name="type" value="like"><button class="btn" type="submit">♥ Like (${eng.like || 0})</button></form>
    <form method="post" action="/song/${song.id}/engage"><input type="hidden" name="type" value="save"><button class="btn" type="submit">Save (${eng.save || 0})</button></form>
  </div>
  <p class="sub" style="margin-top:8px">${eng.play || 0} plays · ${eng.share || 0} shares</p>
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
      description: `${song.artist} · ${song.genre} · ${song.city}, ${song.state}. Craft score ${judge.craft_score}/100 across the 15 judges on TOP 20 — judged only because it was uploaded here.`,
      type: "music.song",
      image: absUrl(req, song.cover_path),
    },
  }));
});

app.post("/song/:id/engage", (req, res) => {
  const type = ["like", "save", "share"].includes(req.body.type) ? req.body.type : "like";
  db.prepare(
    `INSERT INTO engagements (song_id, type, count) VALUES (?, ?, 1)
     ON CONFLICT(song_id, type) DO UPDATE SET count = count + 1`
  ).run(req.params.id, type);
  res.redirect(`/song/${req.params.id}`);
});

/* --------------------------------- Upload --------------------------------- */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === "audio" ? AUDIO_UP : COVER_UP),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || "").toLowerCase().replace(/[^.a-z0-9]/g, "")
      || (file.fieldname === "audio" ? ".mp3" : ".png");
    cb(null, `${file.fieldname}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 40 * 1024 * 1024 } });

app.get("/upload", (req, res) => {
  const checkEmail = String(req.query.email || "").trim().toLowerCase();
  let profileStatus = "";
  if (checkEmail) {
    const u = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(checkEmail);
    profileStatus = hasProfile(u)
      ? `<p class="note" style="color:#9fe8b6">✔ Profile found: <b style="color:#fff">${esc(u.name)}</b> · ${esc(u.city)}, ${esc(u.state)} — your uploads will post under this profile.</p>`
      : `<p class="note" style="color:#ffb3b3">No profile on file for ${esc(checkEmail)} yet. <a href="/profile?email=${encodeURIComponent(checkEmail)}" style="color:var(--accent);font-weight:700">Set up your profile first →</a></p>`;
  }
  const body = `
  <h1>Upload your song</h1>
  <p class="sub">Song uploads are <b style="color:#fff">FREE during the 6-month launch window</b>. Your song is judged on the 15 craft criteria the moment it lands, then ranked on your Local, Regional, National and Overall charts. Only songs uploaded to TOP 20 are ever judged or charted — nothing is imported from outside.</p>
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
      <p class="note">Radio quality only: WAV, FLAC, or 320 kbps MP3 — the same quality radio stations accept. Lower-quality files are turned away.</p>
      <label>Cover art — REQUIRED<input name="cover" type="file" accept="image/*" required></label>
      <p class="note">No cover, no upload, no judging, no chart. Every song must have its CD-style cover.</p>
      <p class="note">Your cover is judged too — it's one of the 15 points. Artists who believe in themselves put in the work: quality artwork helps your score; anything slapped together will hurt it.</p>
      <p class="note">You can only have two songs live at a time — those are the only songs that get judged. Remove one from your Dashboard to put another up.</p>
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

// Radio-quality gate: TOP 20 takes what radio takes — lossless WAV/FLAC
// at any bitrate, or MP3 at 320 kbps (>= 310 kbps allows for VBR reporting).
function probeAudioQuality(absPath) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,bit_rate",
      "-of", "json", absPath,
    ], { encoding: "utf8" });
    const stream = (JSON.parse(out).streams || [])[0] || {};
    return {
      codec: String(stream.codec_name || "").toLowerCase(),
      bitRate: parseInt(stream.bit_rate, 10) || 0,
    };
  } catch {
    return { codec: "", bitRate: 0 };
  }
}

const LOSSLESS_CODECS = ["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_f64le", "pcm_u8", "flac", "alac"];
function isRadioQuality(q) {
  if (LOSSLESS_CODECS.includes(q.codec)) return true;
  if (q.codec === "mp3") return q.bitRate >= 310000;
  return false;
}

app.post("/upload", upload.fields([{ name: "audio", maxCount: 1 }, { name: "cover", maxCount: 1 }]), (req, res) => {
  const audioFile = req.files?.audio?.[0];
  const coverFile = req.files?.cover?.[0];
  const cleanup = () => {
    for (const f of [audioFile, coverFile]) if (f) fs.unlink(f.path, () => {});
  };
  if (!coverFile) { cleanup(); return uploadError(res, "Cover art is required — no cover, no upload, no judging, no chart."); }
  if (!audioFile) { cleanup(); return uploadError(res, "An audio file is required to upload a song."); }
  if (!isRadioQuality(probeAudioQuality(audioFile.path))) {
    cleanup();
    return uploadError(res, "That file isn't radio quality. Top 20 only takes WAV or 320 kbps MP3 — the same quality radio stations accept.");
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
    "INSERT INTO songs (artist_id, title, genre, audio_path, cover_path, lyrics, status) VALUES (?, ?, ?, ?, ?, ?, 'live')"
  ).run(user.id, title.trim(), genre, audioWeb, coverWeb, lyrics ? String(lyrics) : null);
  const songId = Number(songInfo.lastInsertRowid);

  const judged = judgeAudioFile(audioFile.path, coverFile.path);
  const catCols = CATEGORIES.map((c) => c.key).join(", ");
  const placeholders = CATEGORIES.map(() => "?").join(", ");
  db.prepare(
    `INSERT INTO judge_scores (song_id, ${catCols}, total_score, craft_score, notes) VALUES (?, ${placeholders}, ?, ?, ?)`
  ).run(songId, ...CATEGORIES.map((c) => judged.scores[c.key]), judged.totalScore, judged.craftScore, JSON.stringify(judged.notes));
  db.prepare("INSERT INTO engagements (song_id, type, count) VALUES (?, 'play', 0), (?, 'like', 0), (?, 'share', 0), (?, 'save', 0)")
    .run(songId, songId, songId, songId);

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
      <li><b>Two live songs max</b> — those are the only songs that get judged. Remove one to put another up.</li>
      <li>Every song needs its <b>cover — and the cover is judged too</b>, one of the 15 points.</li>
      <li>Every uploaded song is judged on the <b>same 15 points</b>, 1–10 each.</li>
      <li>Audio must be <b>radio quality</b> — WAV, FLAC, or 320 kbps MP3, the same quality radio stations accept.</li>
      <li>New charts land at <b>12:00 midnight</b>, every night.</li>
      <li>The only chart email is the <b>entry email</b> — when you enter a Top 20. Falling off is never emailed.</li>
      <li><b>No pay, no labels, no hand-picks</b> can move a song. The algorithm decides — and artists who believe in themselves put in the work.</li>
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
  db.prepare(
    `UPDATE users SET name = ?, city = ?, state = ?, region = ?, genre = ?, bio = ?,
       age = ?, years_in_game = ?, history = ?, photo_path = ? WHERE id = ?`
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
    user.id
  );
  res.redirect(`/artist/${user.id}`);
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
  const songCards = songs.map((s) => {
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
      <div class="chips">${standing}</div>
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
  <div class="panel">
    <div style="display:flex;gap:14px;align-items:center">
      ${avatarHtml(user)}
      <div style="min-width:0">
        <h1 style="margin:0">${esc(user.name)}</h1>
        <p class="sub" style="margin:4px 0 0">${metaBits}</p>
      </div>
    </div>
    ${highlightsLine}
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
    <p class="sub">The algorithm searches Facebook, Instagram, TikTok, YouTube, the music platforms where independents promote, and the open web — gathering everything it can find about you and your songs: the posts, the buzz, the conversation around your music. You're being critiqued 24 hours a day — the algorithm never sleeps.</p>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">Part 2 — The Judging</h2>
    <p class="sub">Every song uploaded to TOP 20 is scored on <b style="color:#fff">15 points, 1–10 each</b> (total /150) — the same 15 for every song, fitted genre by genre:</p>
    <ul class="rules">${CATEGORIES.map((c, i) => `<li><b>${i + 1}. ${esc(c.label)}</b></li>`).join("")}</ul>
    <p class="sub">Yes — the cover is one of the points. Quality artwork helps your score; anything slapped together will hurt it. The craft score is then blended with real engagement (60% craft / 40% engagement, social buzz capped at about 10% of the total) to set the charts — chart position is never popularity alone, and the craft score can't be bought.</p>
    <p class="sub">Launch genres: <b style="color:#fff">${GENRES.join(" · ")}</b> — plus a cross-genre Overall chart at every level.</p>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">The Stage</h2>
    <p class="sub">The rotation plays the Top 20 in order, 1 through 20, 24 hours a day. New entries come into play at 12:00 midnight, every night — that's when the new chart takes effect and knocked-off songs leave the rotation.</p>
    <p class="sub"><b style="color:#fff">Nobody's safe.</b> A new entry can hit at midnight any night — you have to keep putting out great material to stay in the Top 20.</p>
  </div>
  <div class="ne">
    <div class="ne-banner">THE RULES</div>
    <ul class="rules" style="margin-bottom:2px">
      <li>Only songs <b>uploaded to TOP 20</b> are ever judged — if it isn't uploaded here, it isn't looked at.</li>
      <li><b>Two live songs per artist, max</b> — those are the only songs that get judged. Remove one to put another up.</li>
      <li>A <b>profile page + at least one song uploaded</b> is how you get recognized.</li>
      <li><b>No labels, no pay, no hand-picks</b> can move a song. The algorithm decides.</li>
      <li>Audio must be <b>radio quality</b> — WAV, FLAC, or 320 kbps MP3, the same quality radio stations accept.</li>
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
      description: "The first-of-its-kind algorithm for independent artists: a 24/7 search across Facebook, Instagram, TikTok, YouTube and the web, then every uploaded song judged on 15 points of craft and ranked daily.",
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

  const body = `
  <h1>City DJs</h1>
  <p class="sub">The DJs who spin independent artists get their flowers too. Every month, every city picks its <b style="color:#fff">DJ of the Month</b> — submit the DJ who's been holding independents down in your city, and vote. Anybody can submit: the DJ, an artist, a fan.</p>
  <p><a class="btn btn-blue btn-block" href="/djs/submit">Submit a DJ</a></p>
  ${djMsgHtml(req)}
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TOP 20 v1 listening on http://0.0.0.0:${PORT}`);
});
