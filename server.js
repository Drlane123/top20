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
html{-webkit-text-size-adjust:100%}
body{margin:0;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:#000;background-image:radial-gradient(900px 480px at 50% -8%,#26272e 0%,#070708 55%,#000 100%);
  background-attachment:fixed;-webkit-font-smoothing:antialiased;overflow-x:clip}
.app{max-width:430px;margin:0 auto;min-height:100vh;padding:0 14px 34px;
  background:radial-gradient(720px 360px at 50% -40px,rgba(43,92,255,.07),transparent 62%),linear-gradient(180deg,#101013 0,#080809 260px);
  border-left:1px solid #2c2e34;border-right:1px solid #2c2e34;
  box-shadow:0 0 70px rgba(255,255,255,.05)}
a{color:var(--ink)}
header.site{padding:20px 2px 2px;text-align:center}
.wm{display:inline-block;text-align:center;position:relative;isolation:isolate}
@keyframes shine{from{background-position:50% 0%}to{background-position:50% 100%}}
/* Futuristic wordmark (owner round 3): the ENTIRE mark leans right in
   italic + skew, stamped into the black surface — dark shadow pressed at
   the top/inner edge, thin bright highlight along the bottom edge. The
   blaze runs the full width of the mark, under TOP and the 20 both. */
.wordmark{font-size:46px;font-weight:900;letter-spacing:.5px;line-height:1;text-align:center;
  font-style:italic;transform:skewX(-12deg)}
@font-face{font-family:'Anton';font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,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) format('woff2')}
.wordmark .top{display:inline-block;color:var(--accent);font-size:62px;transform:skewX(-7deg);
  font-family:'Anton',sans-serif;letter-spacing:1px;padding-right:.16em;
  background:linear-gradient(180deg,#f4f9ff 0%,#bcd6ff 16%,#5f8dff 36%,#ffffff 46%,#2b5cff 58%,#0d2c86 84%,#7ea6ff 100%);
  background-size:100% 210%;
  animation:shine 4.5s ease-in-out infinite alternate;
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 -1px 1px rgba(0,0,0,.95)) drop-shadow(0 1px 0 rgba(210,228,255,.5)) drop-shadow(0 0 10px rgba(43,92,255,.4))}
.wordmark .twenty{display:inline-block;font-family:Impact,"Arial Narrow Bold","Franklin Gothic Medium Cond","Helvetica Neue Condensed Black",sans-serif;
  font-weight:900;font-style:italic;letter-spacing:0;padding-right:.1em;
  font-size:54px;position:relative;z-index:2;margin-left:.26em;
  background:linear-gradient(180deg,#ffffff 0%,#f4f8ff 20%,#aebdd2 38%,#ffffff 47%,#c3d0e2 58%,#7e8ea6 80%,#eef3fa 100%);
  background-size:100% 210%;
  animation:shine 4.5s ease-in-out infinite alternate;
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 -1px 1px rgba(0,0,0,.95)) drop-shadow(0 1px 0 rgba(255,255,255,.4)) drop-shadow(0 0 9px rgba(215,230,255,.3))}
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
.hotline{margin-top:5px;font-size:11px;font-weight:800;letter-spacing:3.5px;white-space:nowrap;overflow:hidden;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);
  mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}
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
.panel::before{content:"";position:absolute;left:0;right:0;top:0;height:48%;
  background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,0));pointer-events:none}
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
  ${opts.home ? `<div class="hotline"><span class="tick">— HOT 20 — TRENDING NOW — CHARTS BY CRAFT, NOT JUST CLOUT — NOBODY'S SAFE — NEW ENTRIES HIT AT MIDNIGHT — </span><span class="tick">— HOT 20 — TRENDING NOW — CHARTS BY CRAFT, NOT JUST CLOUT — NOBODY'S SAFE — NEW ENTRIES HIT AT MIDNIGHT — </span></div>` : ""}
  <div class="tagline">Charts by craft, not just clout</div>
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
    <span class="rankwrap"><span class="rank">${e.rank}</span>${rankPill(st, e.rank)}<span class="move">${moveHtml(prevMap.get(e.song_id), e.rank)}</span></span>
    <img class="thumb" src="${esc(e.cover_path)}" alt="">
    <span class="meta"><span class="t">${esc(e.title)}</span><br><a class="artistlink" href="/artist/${e.artist_id}">${esc(e.artist)}</a>${stats ? statsLine(st) : ""}</span>
    <span class="nums">Craft <b>${e.craft_score}</b><br>Chart <b>${e.chart_score}</b></span>
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
    <span class="meta"><span class="t">${esc(e.title)}</span><br><a class="artistlink" href="/artist/${e.artist_id}">${esc(e.artist)}</a></span>
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
           ce.rank, j.craft_score,
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
      days: dc.days, fresh: dc.days > 0 && dc.first === date,
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
  <div class="stagegrid">
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
    <div class="chips" style="margin-top:8px">
      <span class="chip">▶ <b id="npPlays">${fmtNum(first.plays || 0)}</b> plays</span>
      <span class="chip">♥ <b id="npLikes">${fmtNum(first.likes || 0)}</b> likes</span>
      <span class="chip">⤴ <b id="npShares">${fmtNum(first.shares || 0)}</b> shares</span>
      <span class="chip" id="npDays">${first.fresh ? "🔥 New entry · Day 1" : "Days charted · " + (first.days || 0)}</span>
    </div>
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
      '<div class="ct">#' + t.rank + ' ' + t.title + '</div><div class="ca">' + t.artist + '</div></div></div>').join('');
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
    if (anc) {
      const t = anc.list[anc.local];
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
    idx = i;
    audio.src = t.audio;
    $('npCover').src = t.cover; $('npTitle').textContent = t.title;
    $('npArtist').textContent = t.artist; $('npRank').textContent = '#' + t.rank;
    $('npCraft').textContent = t.craft; $('npChannel').textContent = LABELS[ch];
    $('npPlays').textContent = fmtN(t.plays); $('npLikes').textContent = fmtN(t.likes); $('npShares').textContent = fmtN(t.shares);
    $('npDays').textContent = t.fresh ? '🔥 New entry · Day 1' : 'Days charted · ' + (t.days || 0);
    $('barThumb').src = t.cover; $('barTitle').textContent = t.title; $('barArtist').textContent = t.artist;
    syncRings();
    if (autoplay) audio.play().catch(() => {});
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
  renderRings(); load(0, false); startShowcase();
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
  const dc = daysCharted(song.id);
  const dcNew = dc.days > 0 && dc.first === latestChartDate(db);
  const { ranks } = songRanks(song.id);
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
  ${removedNote}
  <audio controls preload="metadata" src="${esc(song.audio_path)}"></audio>
  <div class="flexbtns">
    <form method="post" action="/song/${song.id}/engage"><input type="hidden" name="type" value="like"><button class="btn" type="submit">♥ Like (${fmtNum(eng.like || 0)})</button></form>
    <form id="shareForm" method="post" action="/song/${song.id}/engage"><input type="hidden" name="type" value="share"><button class="btn" type="submit">⤴ Share (${fmtNum(eng.share || 0)})</button></form>
  </div>
  <p class="sub" id="shareMsg" style="margin-top:6px"></p>
  <div class="statstrip">
    <div class="stat"><b>${fmtNum(eng.play || 0)}</b><span>plays</span></div>
    <div class="stat"><b>${fmtNum(eng.share || 0)}</b><span>shares</span></div>
    <div class="stat"><b>${fmtNum(eng.like || 0)}</b><span>likes</span></div>
    <div class="stat"><b>${dcNew ? "Day 1" : dc.days > 0 ? dc.days : "—"}</b><span>${dcNew ? "🔥 new entry" : dc.days > 0 ? "days charted" : "not charted yet"}</span></div>
  </div>
  <script>
  (function(){
    var form = document.getElementById('shareForm');
    if (!form) return;
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var url = location.origin + '/song/${song.id}';
      var msg = document.getElementById('shareMsg');
      var counted = function(text){ msg.textContent = text; setTimeout(function(){ form.submit(); }, 350); };
      if (navigator.share) {
        navigator.share({ title: document.title, text: document.title, url: url }).then(function(){
          counted('Shared — that link points to this song\\'s Top 20 page.');
        }, function(){});
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function(){
          counted('Link copied — it points to this song\\'s Top 20 page. Paste it anywhere.');
        }, function(){ form.submit(); });
      } else { form.submit(); }
    });
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
