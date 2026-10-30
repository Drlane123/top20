// Judging Engine v1 (spec 3.3) — deterministic heuristics.
// Real version: audio feature analysis + an AI rubric call. v1 derives the
// 15 category scores from a hash of the audio file + its duration, so the
// same file always gets the same scores, spread realistically across songs.
// The 15th criterion, Cover Art & Presentation, is scored from the uploaded
// cover image itself (resolution + file-size heuristics via ffprobe) —
// quality artwork scores high, thrown-together artwork drags the song down.
const crypto = require("node:crypto");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { CATEGORIES } = require("./config");

// Small deterministic PRNG.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One critique-note template per category: a "strong" read (score >= 7)
// and a "fix-it" read (score < 7). 1-2 sentences each (spec 3.3).
const NOTES = {
  mix: {
    strong: "The mix is balanced and clear — the vocal sits right on top and every part has its own space.",
    weak: "The mix feels crowded and the vocal gets buried in places. Pull back the competing parts and give the lead room to breathe.",
  },
  mastering: {
    strong: "Mastering is loud, polished and even — this sounds like a finished record next to released music.",
    weak: "The master is quieter and duller than released records. More loudness polish and top-end sheen would help it compete.",
  },
  hook: {
    strong: "The hook lands fast and sticks — it's the part a listener walks away singing.",
    weak: "The hook doesn't separate itself from the verses yet. Make the chorus melody and title line bigger and easier to remember.",
  },
  melody: {
    strong: "The melody is strong and original, with a contour that keeps pulling the ear forward.",
    weak: "The melody wanders without a memorable shape. Simplify it around a few notes people can hold onto.",
  },
  lyrics: {
    strong: "The writing has lines that land — specific, visual, and true to the song's message.",
    weak: "The lyrics lean on general phrases. Sharper details and one or two standout lines would raise the whole record.",
  },
  structure: {
    strong: "The structure builds with intent — verses set up the chorus and nothing overstays its welcome.",
    weak: "The arrangement drags in spots and the payoff arrives late. Trim the fat and get to the hook sooner.",
  },
  vocals: {
    strong: "The vocal performance is convincing — emotion, timing and presence are all there.",
    weak: "The delivery feels held back in places. Commit harder to the emotion of the lyric and ride the beat with more confidence.",
  },
  production: {
    strong: "Production choices serve the song — the beat and instrumentation are high quality and well arranged.",
    weak: "The production sounds generic next to the song's ambition. Stronger sound selection and arrangement changes would lift it.",
  },
  groove: {
    strong: "The groove has real pocket — it makes you nod and move without forcing it.",
    weak: "The rhythm feels stiff and the pocket never fully locks. Loosen the drums and let the bass and kick talk to each other.",
  },
  emotion: {
    strong: "The record makes you feel something — the emotion comes through clearly from start to finish.",
    weak: "The emotional core isn't landing yet. The performance and arrangement need to sell the feeling, not just the notes.",
  },
  dynamics: {
    strong: "Dynamics build and release well — the song breathes and holds attention all the way through.",
    weak: "The song stays at one energy level for too long. Add lifts, drops and space so the big moments feel big.",
  },
  originality: {
    strong: "This sounds like its own record — you can tell whose song it is within seconds.",
    weak: "It borrows heavily from records already out. Push harder on the one thing only this artist would do.",
  },
  replay: {
    strong: "Instant replay value — when it ends, you want to run it straight back.",
    weak: "One listen doesn't yet demand a second. A stronger hook moment or a surprise late in the song would earn the replay.",
  },
  radio_readiness: {
    strong: "This could sit on radio or a major playlist next to signed artists and belong there.",
    weak: "Not quite at radio standard yet — the mix polish and hook size need to come up before it sits next to signed records.",
  },
  cover_art: {
    strong: "The artwork is polished and readable at thumbnail size — finished, professional presentation that looks like a real release.",
    weak: "The artwork looks thrown together — low resolution and unfinished; quality artwork is part of the score.",
  },
};

function buildScores(rng, baseQuality, cover = null) {
  const scores = {};
  const notes = {};
  let total = 0;
  for (const cat of CATEGORIES) {
    if (cat.key === "cover_art" && cover) {
      // The cover is judged from the image itself, not the audio base.
      scores[cat.key] = cover.score;
      total += cover.score;
      notes[cat.key] = cover.note;
      continue;
    }
    // Per-category jitter around the song's base quality, clamped to 4..10.
    const raw = baseQuality + (rng() * 2 - 1) * 1.6;
    const score = Math.max(4, Math.min(10, Math.round(raw * 2) / 2));
    scores[cat.key] = score;
    total += score;
    notes[cat.key] = score >= 7 ? NOTES[cat.key].strong : NOTES[cat.key].weak;
  }
  return { scores, notes, totalScore: total, craftScore: Math.round((total / 150) * 1000) / 10 };
}

// Cover Art & Presentation (criterion 15) — deterministic heuristics on the
// uploaded image: ffprobe reads width/height; proper release resolution
// (>=1000x1000) scores near the top, small images score low. File size is a
// weak secondary signal (a near-empty file at a given size reads as flat /
// unfinished). A hash-seeded jitter keeps variance inside the band.
// The cover does NOT need a photo on it — polish and finish are what's judged.
function probeImageSize(absPath) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0", absPath,
    ], { encoding: "utf8" });
    const [w, h] = out.trim().split(",").map((n) => parseInt(n, 10));
    return { width: w || 0, height: h || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

function coverArtScore(absPath, seedInt) {
  const rng = mulberry32((seedInt ^ 0x9e3779b9) >>> 0);
  const { width, height } = probeImageSize(absPath);
  const d = Math.min(width, height);
  let base;
  if (!d) base = 3.0;                    // unreadable image
  else if (d >= 3000) base = 9.6;        // full store-grade artwork
  else if (d >= 2000) base = 9.2;
  else if (d >= 1500) base = 8.8;
  else if (d >= 1000) base = 8.4;        // proper release resolution
  else if (d >= 700) base = 7.8;
  else if (d >= 500) base = 7.2;
  else if (d >= 300) base = 6.2;
  else if (d >= 200) base = 5.2;
  else if (d >= 120) base = 4.2;
  else base = 3.2;                       // thumbnail-sized / thrown together
  try {
    const bytes = fs.statSync(absPath).size;
    if (d && width && height) {
      const bytesPerPixel = bytes / (width * height);
      if (bytesPerPixel < 0.05) base -= 0.5;       // suspiciously flat/empty
      else if (bytesPerPixel > 0.5) base += 0.3;   // rich, detailed artwork
    }
    if (bytes < 4000) base -= 0.4;
  } catch { /* size is a weak signal; ignore failures */ }
  const jitter = (rng() * 2 - 1) * 0.7;
  const score = Math.max(1, Math.min(10, Math.round((base + jitter) * 2) / 2));
  return { score, note: score >= 7 ? NOTES.cover_art.strong : NOTES.cover_art.weak };
}

// Seed path: scores around a chosen base quality, deterministic per seed int.
// coverAbsPath (optional) scores criterion 15 from the actual cover file.
function scoreFromBase(seedInt, baseQuality, coverAbsPath = null) {
  const cover = coverAbsPath ? coverArtScore(coverAbsPath, seedInt) : null;
  return buildScores(mulberry32(seedInt), baseQuality, cover);
}

function probeDurationSeconds(absPath) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", absPath,
    ], { encoding: "utf8" });
    const d = parseFloat(out.trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

// Upload path: deterministic from the files themselves (hash + duration
// for the audio; image heuristics for the cover, criterion 15).
function judgeAudioFile(absPath, coverAbsPath = null) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(absPath));
  const digest = hash.digest();
  const seedInt = digest.readUInt32BE(0);
  const duration = probeDurationSeconds(absPath);
  // Base quality 5.0..9.3 from the hash; slightly longer, complete-feeling
  // files nudge up (a real engine would analyse the audio itself).
  let base = 5.0 + (digest[4] / 255) * 4.3;
  if (duration >= 120) base += 0.3;
  if (duration > 0 && duration < 30) base -= 0.4;
  base = Math.max(4.6, Math.min(9.6, base));
  const cover = coverAbsPath ? coverArtScore(coverAbsPath, seedInt) : null;
  const result = buildScores(mulberry32(seedInt), base, cover);
  return { ...result, durationSeconds: Math.round(duration) };
}

module.exports = { mulberry32, scoreFromBase, judgeAudioFile, coverArtScore, NOTES };
