"use strict";
// Top 20 — the Analyzer (Judge v2 measurement engine, owner spec Oct 31, 2026).
// Pure measurement: NO opinion, NO AI listening. A song goes in, numbers come
// out — loudness (BS.1770 via ffmpeg's ebur128), true peak, loudness range,
// the spectrum in 7 bands, the per-second energy curve (structure + hook),
// onset/tempo strength (groove), vocal-band presence and melodic range.
// judge2.js turns these numbers into the 14 measured points by comparing
// them against the genre templates Dale approved (genre-bands-draft.md).
const { execFile } = require("node:child_process");

const SR = 44100;
const MAX_SECONDS = 360; // read at most the first 6 minutes

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function probe(absPath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-show_entries", "stream=sample_rate,channels",
    "-of", "json", absPath,
  ]);
  const j = JSON.parse(stdout);
  const st = (j.streams || [])[0] || {};
  return {
    duration: parseFloat(j.format && j.format.duration) || 0,
    sampleRate: parseInt(st.sample_rate, 10) || 0,
    channels: st.channels || 0,
  };
}

// BS.1770 loudness + true peak from ffmpeg's ebur128 summary block.
async function loudness(absPath) {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-i", absPath, "-af", "ebur128=peak=true", "-f", "null", "-",
  ]);
  const tail = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re) => { const m = tail.match(re); return m ? parseFloat(m[1]) : null; };
  return {
    lufs: num(/I:\s*(-?[\d.]+) LUFS/),
    lra: num(/LRA:\s*(-?[\d.]+) LU/),
    truePeak: num(/Peak:\s*(-?[\d.]+) dBFS/),
  };
}

// Decode to stereo float PCM (capped), straight from ffmpeg's stdout.
// The mono fold is derived here; the channel pair feeds the physical
// placement checks (width, mono fold-down safety).
async function decode(absPath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cap = SR * MAX_SECONDS * 4 * 2;
    const { spawn } = require("node:child_process");
    const p = spawn("ffmpeg", ["-v", "error", "-i", absPath, "-ac", "2", "-ar", String(SR), "-f", "f32le", "-"]);
    p.stdout.on("data", (d) => { if (size < cap) { chunks.push(d); size += d.length; } });
    p.stderr.on("data", () => {});
    p.on("error", reject);
    p.on("close", () => {
      const buf = Buffer.concat(chunks);
      const inter = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
      const n = Math.floor(inter.length / 2);
      const mono = new Float32Array(n);
      // One pass: the mono fold the measurements run on, plus every
      // left/right aggregate the physical checks need (means,
      // correlation, mid/side sums). The full left/right arrays are
      // never built — three extra copies of a six-minute song were
      // enough to push the studio's small server past its memory
      // and take the whole site down (owner incident, Nov 2, 2026).
      let meanL = 0, meanR = 0, meanM = 0, sLR = 0, sLL = 0, sRR = 0, sMid = 0, sSide = 0;
      for (let i = 0; i < n; i++) {
        const l = inter[2 * i], r = inter[2 * i + 1], m = (l + r) / 2;
        mono[i] = m;
        meanL += l; meanR += r; meanM += m;
        sLR += l * r; sLL += l * l; sRR += r * r;
        sMid += m * m; sSide += ((l - r) / 2) * ((l - r) / 2);
      }
      if (n > 0) { meanL /= n; meanR /= n; meanM /= n; }
      resolve({ mono, lr: { n, meanL, meanR, meanM, sLR, sLL, sRR, sMid, sSide } });
    });
  });
}

// Physical placement: is everything where it should be in the file?
// Stereo width, mono fold-down correlation (phase safety), silent holes
// punched in the middle of the song, an ending chopped off mid-sound, DC.
function analyzePhysical(lr, mono, energyCurve, monoSource) {
  const n = mono.length;
  const { meanM, sLR, sLL, sRR, sMid, sSide } = lr;
  const corr = sLL > 0 && sRR > 0 ? sLR / Math.sqrt(sLL * sRR) : 1;
  const widthDb = sMid > 0 ? Math.round(10 * Math.log10((sSide + 1e-12) / sMid) * 10) / 10 : -60;
  // Dropouts: 100ms windows far below the song's body level, mid-song.
  const sortedE = [...energyCurve].sort((a, b) => a - b);
  const refDb = sortedE[Math.floor(sortedE.length / 2)] || -20;
  const winN = Math.floor(SR / 10);
  const dropouts = [];
  let runStart = -1;
  const totalWin = Math.floor(n / winN);
  for (let w = 0; w <= totalWin; w++) {
    let db = -80;
    if (w < totalWin) {
      let ss = 0; const off = w * winN;
      for (let i = 0; i < winN; i++) { const v = mono[off + i]; ss += v * v; }
      db = 10 * Math.log10(ss / winN + 1e-14);
    }
    const tSec = w / 10;
    const isHole = db < refDb - 30 && tSec >= 1.5 && tSec <= n / SR - 1.5;
    if (isHole && runStart < 0) runStart = tSec;
    if (!isHole && runStart >= 0) {
      if (tSec - runStart >= 0.4 && dropouts.length < 5) dropouts.push({ at: Math.round(runStart * 10) / 10, dur: Math.round((tSec - runStart) * 10) / 10 });
      runStart = -1;
    }
  }
  const tailQuiet = (() => { let q = 0; const fl = (sortedE[Math.floor(sortedE.length * 0.95)] || -20) - 14; for (let s = energyCurve.length - 1; s >= 0 && energyCurve[s] < fl; s--) q++; return q; })();
  const lastSec = energyCurve[energyCurve.length - 1];
  const abruptEnd = tailQuiet === 0 && lastSec != null && lastSec > refDb - 2.5;
  return {
    monoSource: !!monoSource,
    correlation: Math.round(corr * 1000) / 1000,
    widthDb,
    dropouts,
    abruptEnd,
    dcOffset: Math.round(Math.abs(meanM) * 10000) / 10000,
  };
}

// Iterative radix-2 FFT (magnitude spectrum of a real frame, Hann-windowed
// by the caller). Returns magnitudes for bins 0..n/2.
function fftMag(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
  const mags = new Float64Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
  return mags;
}

const BANDS = [
  ["sub", 20, 60], ["bass", 60, 250], ["lowmid", 250, 500], ["mid", 500, 2000],
  ["presence", 2000, 6000], ["brilliance", 6000, 12000], ["air", 12000, 18000],
];

// TEMPO (recalibrated, owner correction Nov 2, 2026): the first reader
// latched onto half-time and 3:2 aliases on real records — it read an
// up-tempo 143 BPM dance record at 72. The recalibrated reader tracks
// onset flux in TWO bands over a fine hop: the KICK band (40–160 Hz —
// the tempo backbone of dance/R&B/hip-hop) and the FULL spectrum.
// Each band's periodicity curve is peak-picked with a mild perceptual
// tempo prior; the kick band wins when it reads strong and the full
// band isn't sitting at exactly half its tempo (the ballad case, where
// the backbeat — not the sparse kick — defines the grid). Validated on
// known-tempo records (65/100/128/144 all exact) and on the record that
// exposed the flaw: kick band 143 at 0.89 strength, midrange alias 95.
function pickTempo(flux, fps) {
  const mean = flux.reduce((s, v) => s + v, 0) / Math.max(1, flux.length);
  const fc = flux.map((v) => v - mean);
  let zero = 0; for (const v of fc) zero += v * v;
  if (!zero || fc.length < 80) return { bpm: 0, strength: 0 };
  const minLag = Math.floor((60 * fps) / 240);
  const maxLag = Math.min(Math.ceil((60 * fps) / 40), Math.floor(fc.length / 2));
  const R = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0; for (let i = 0; i + lag < fc.length; i++) s += fc[i] * fc[i + lag];
    R[lag] = s / zero;
  }
  const prior = (bpm) => Math.exp(-Math.pow(Math.log2(bpm / 120), 2) / (2 * 0.75 * 0.75));
  // Smooth the periodicity curve before peak-picking: on dense real
  // mixes the raw curve wiggles lag-to-lag and the argmax jumps a full
  // lag (±3 BPM) off the true grid. Strength is still reported raw.
  const Rs = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) Rs[lag] = 0.25 * R[lag - 1] + 0.5 * R[lag] + 0.25 * R[lag + 1];
  let best = null;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (Rs[lag] >= Rs[lag - 1] && Rs[lag] >= Rs[lag + 1] && Rs[lag] > 0.04) {
      const den = Rs[lag - 1] - 2 * Rs[lag] + Rs[lag + 1];
      let d = den !== 0 ? (0.5 * (Rs[lag - 1] - Rs[lag + 1])) / den : 0;
      d = Math.max(-0.5, Math.min(0.5, d));
      const bpm = (60 * fps) / (lag + d);
      const w = Rs[lag] * prior(bpm);
      if (!best || w > best.w) best = { bpm, lag, w };
    }
  }
  if (!best) return { bpm: 0, strength: 0 };
  let bpm = best.bpm;
  while (bpm < 55) bpm *= 2;
  while (bpm > 185) bpm /= 2;
  return { bpm: Math.round(bpm), strength: Math.round(R[best.lag] * 100) / 100 };
}

function measureTempo(x) {
  const N = 2048, HOP = 512, fps = SR / HOP;
  const cap = Math.min(x.length, 150 * SR);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const loA = Math.max(1, Math.floor((40 * N) / SR)), loB = Math.min(N / 2, Math.ceil((160 * N) / SR));
  const re = new Float64Array(N), im = new Float64Array(N);
  let prev = null;
  const fluxLow = [], fluxFull = [];
  for (let off = 0; off + N <= cap; off += HOP) {
    for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
    const mags = fftMag(re, im);
    if (prev) {
      let fl = 0, ff = 0;
      for (let i = 2; i < mags.length; i++) {
        const d = mags[i] - prev[i];
        if (d > 0) { ff += d; if (i >= loA && i < loB) fl += d; }
      }
      fluxLow.push(fl); fluxFull.push(ff);
    }
    prev = mags;
  }
  const low = pickTempo(fluxLow, fps);
  const full = pickTempo(fluxFull, fps);
  const fullIsHalfOfLow = low.bpm > 0 && Math.abs(full.bpm - low.bpm / 2) <= low.bpm * 0.03 + 2;
  const chosen = low.bpm && low.strength >= 0.6 && !fullIsHalfOfLow ? low : full;
  // No confident pulse, no number: a beatless pad or ambient piece gets
  // NO tempo claim rather than an invented one (the screen only shows
  // what it really read).
  if (!chosen.bpm || chosen.strength < 0.22) return { bpm: 0, strength: chosen.strength };
  return chosen;
}

function analyzePcm(x) {
  const durSec = x.length / SR;
  let peak = 0, sumSq = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; sumSq += x[i] * x[i]; }
  const rms = Math.sqrt(sumSq / Math.max(1, x.length));
  const crestDb = peak > 0 && rms > 0 ? 20 * Math.log10(peak / rms) : 0;

  // Per-second RMS energy curve (structure, dynamics, hook).
  const secs = Math.floor(durSec);
  const energy = new Float64Array(secs);
  for (let s = 0; s < secs; s++) {
    let ss = 0; const off = s * SR;
    for (let i = 0; i < SR; i++) { const v = x[off + i]; ss += v * v; }
    energy[s] = 20 * Math.log10(Math.sqrt(ss / SR) + 1e-9);
  }
  const sorted = [...energy].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(secs - 1, Math.max(0, Math.floor(p * secs)))] || -60;
  const drProxy = secs > 8 ? pct(0.95) - pct(0.10) : 0; // how much the song breathes

  // Leading/trailing quiet (intro/outro read).
  const floorRef = pct(0.95) - 14;
  let leadQuiet = 0; while (leadQuiet < secs && energy[leadQuiet] < floorRef) leadQuiet++;
  let tailQuiet = 0; while (tailQuiet < secs && energy[secs - 1 - tailQuiet] < floorRef) tailQuiet++;

  // Hook: the loudest 8-second window; how early it lands; how often its
  // level comes back (repeats = windows within 1.5 dB of its level).
  const W = 8;
  let hookStart = 0, hookLevel = -Infinity;
  const winLevels = [];
  for (let s = 0; s + W <= secs; s++) {
    let m = 0; for (let k = 0; k < W; k++) m += energy[s + k];
    const lvl = m / W; winLevels.push(lvl);
    if (lvl > hookLevel) { hookLevel = lvl; hookStart = s; }
  }
  const hookRepeats = winLevels.filter((l) => l >= hookLevel - 1.5).length;
  const medianWin = winLevels.length ? [...winLevels].sort((a, b) => a - b)[Math.floor(winLevels.length / 2)] : hookLevel;
  const hookLift = hookLevel - medianWin; // how far the hook stands above the body

  // Spectrum: averaged FFT magnitudes (4096 frames, 50% hop) -> band levels,
  // spectral flux (onsets/groove) and the dominant-melody track.
  const N = 4096, HOP = 4096;
  const frames = Math.max(1, Math.floor((x.length - N) / HOP));
  const acc = new Float64Array(N / 2 + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  let prevMag = null;
  const domFreqs = [];
  const secAcc = []; // per-second band magnitudes -> section fingerprints
  const binHz = SR / N;
  // KEY DETECTION (owner, Nov 2, 2026 — the screen must be FACTUAL):
  // a chromagram accumulated from the same FFT frames — every bin in the
  // musical range votes its energy into one of the 12 pitch classes.
  // After the pass, the chroma profile is correlated against the
  // Krumhansl key profiles (major + minor, all 12 tonics) and the best
  // match is the song's key. Pure measurement, same doctrine as the rest.
  const chroma = new Float64Array(12);
  const secChroma = []; // per-second chroma -> the hook-weighted key read
  const pcOfBin = new Int16Array(N / 2 + 1).fill(-1);
  for (let i = 1; i <= N / 2; i++) {
    const f = i * binHz;
    if (f < 55 || f > 4200) continue;
    const midi = Math.round(69 + 12 * Math.log2(f / 440));
    pcOfBin[i] = ((midi % 12) + 12) % 12;
  }
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
    const mags = fftMag(re, im);
    for (let i = 0; i < mags.length; i++) acc[i] += mags[i];
    for (let i = 1; i < mags.length; i++) {
      const pc = pcOfBin[i]; if (pc < 0) continue;
      const w = mags[i] * (i * binHz < 250 ? 1.5 : 1);
      chroma[pc] += w;
      const sec2 = Math.floor(off / SR);
      if (!secChroma[sec2]) secChroma[sec2] = new Float64Array(12);
      secChroma[sec2][pc] += w;
    }
    { // file this frame's band magnitudes under its second
      const sec = Math.floor(off / SR);
      if (!secAcc[sec]) secAcc[sec] = new Float64Array(BANDS.length);
      BANDS.forEach(([name, lo, hi], bi) => {
        const a = Math.max(1, Math.floor(lo / binHz)), b = Math.min(N / 2, Math.ceil(hi / binHz));
        let s = 0; for (let i = a; i < b; i++) s += mags[i];
        secAcc[sec][bi] += s;
      });
    }
    prevMag = mags;
    // dominant frequency in the melodic range 80..1200 Hz
    let bi = -1, bv = 0;
    const lo = Math.floor((80 * N) / SR), hi = Math.floor((1200 * N) / SR);
    for (let i = lo; i <= hi; i++) if (mags[i] > bv) { bv = mags[i]; bi = i; }
    if (bi > 0 && bv > 0.02) domFreqs.push((bi * SR) / N);
  }
  const bandRaw = {};
  for (const [name, lo, hi] of BANDS) {
    const a = Math.max(1, Math.floor(lo / binHz)), b = Math.min(N / 2, Math.ceil(hi / binHz));
    let s = 0; for (let i = a; i < b; i++) s += acc[i];
    bandRaw[name] = 20 * Math.log10(s / Math.max(1, b - a) + 1e-12);
  }
  const strongest = Math.max(...Object.values(bandRaw));
  const bands = {};
  for (const k of Object.keys(bandRaw)) bands[k] = Math.round((bandRaw[k] - strongest) * 10) / 10;
  const lowEnd = Math.round((((bandRaw.sub + bandRaw.bass) / 2) - bandRaw.mid) * 10) / 10;   // vs mid (template metric)
  const topEnd = Math.round((((bandRaw.presence + bandRaw.brilliance) / 2) - bandRaw.mid) * 10) / 10;

  // Tempo + groove strength from the recalibrated two-band reader
  // (measureTempo above — kick band vs full spectrum consensus).
  const { bpm, strength: tempoStrength } = measureTempo(x);

  // Vocal presence: share of energy in the 300Hz..3.4kHz voice band.
  let vShare = 0;
  {
    const a = Math.floor(300 / binHz), b = Math.ceil(3400 / binHz);
    let vs = 0, ts = 0;
    for (let i = 1; i < acc.length; i++) { ts += acc[i]; if (i >= a && i < b) vs += acc[i]; }
    vShare = ts > 0 ? Math.round((vs / ts) * 1000) / 1000 : 0;
  }

  // Melodic range: 10th..90th percentile span of the dominant track, in semitones.
  let melodicRange = 0;
  if (domFreqs.length > 30) {
    const ds = [...domFreqs].sort((a, b) => a - b);
    const lo = ds[Math.floor(0.1 * ds.length)], hi = ds[Math.floor(0.9 * ds.length)];
    if (lo > 0 && hi > lo) melodicRange = Math.round(12 * Math.log2(hi / lo) * 10) / 10;
  }

  // ---- Sections: hook vs verse fingerprints (owner request, part two) ----
  // Every second carries a spectral fingerprint (its 7 band shares). Loud
  // seconds group into hook blocks, body seconds into verse blocks. Reads:
  // hookMatch (do the hooks match each other), verseMatch (verses too),
  // blend (hook and verse — same record?), prominence (hook over verse, dB).
  function profileOf(list) {
    const v = new Float64Array(BANDS.length); let n = 0;
    for (const s of list) {
      const a = secAcc[s]; if (!a) continue;
      let tot = 0; for (let i = 0; i < a.length; i++) tot += a[i];
      if (tot <= 0) continue;
      for (let i = 0; i < a.length; i++) v[i] += a[i] / tot;
      n++;
    }
    if (!n) return null;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  }
  function cosine(a, b) {
    if (!a || !b) return null;
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : null;
  }
  function blocksOf(flags, minLen) {
    const blocks = []; let cur = [], gap = 0;
    flags.forEach((f, s) => {
      if (f) { if (gap && cur.length) for (let g = gap; g >= 1; g--) cur.push(s - g); gap = 0; cur.push(s); }
      else if (cur.length) { gap++; if (gap > 2) { blocks.push(cur); cur = []; gap = 0; } }
    });
    if (cur.length) blocks.push(cur);
    return blocks.filter((b) => b.length >= minLen);
  }
  const hookThresh = medianWin + Math.max(0.8, 0.55 * (hookLevel - medianWin));
  const hookFlags = [], verseFlags = [];
  for (let s = 0; s < secs; s++) {
    hookFlags.push(energy[s] >= hookThresh);
    verseFlags.push(energy[s] >= floorRef && energy[s] < hookThresh - 0.4);
  }
  const hookBlocks = blocksOf(hookFlags, 3);
  const verseBlocks = blocksOf(verseFlags, 4);
  function matchOf(blocks) {
    if (blocks.length < 2) return null;
    const first = profileOf(blocks[0]); if (!first) return null;
    const sims = blocks.slice(1).map((b) => cosine(first, profileOf(b))).filter((v) => v != null);
    return sims.length ? Math.round((sims.reduce((a, b) => a + b, 0) / sims.length) * 1000) / 1000 : null;
  }
  const allHookSecs = hookBlocks.flat(), allVerseSecs = verseBlocks.flat();
  const hookProf = profileOf(allHookSecs), verseProf = profileOf(allVerseSecs);
  const verseLevel = allVerseSecs.length ? allVerseSecs.reduce((a, s) => a + energy[s], 0) / allVerseSecs.length : null;
  const introBuildDb = leadQuiet >= 2 && leadQuiet < secs
    ? Math.round((((energy[leadQuiet - 1] + energy[leadQuiet - 2]) / 2) - ((energy[0] + energy[1]) / 2)) * 10) / 10
    : null;
  const intro = {
    lengthSec: leadQuiet,
    buildDb: introBuildDb,
    coldOpen: leadQuiet === 0 && secs > 0 && energy[0] >= medianWin - 3,
  };
  const blendCos = hookProf && verseProf ? cosine(hookProf, verseProf) : null;
  const sections = {
    hookMatch: matchOf(hookBlocks),
    verseMatch: matchOf(verseBlocks),
    blend: blendCos != null ? Math.round(blendCos * 1000) / 1000 : null,
    prominenceDb: verseLevel != null ? Math.round((hookLevel - verseLevel) * 10) / 10 : null,
    hookBlocks: hookBlocks.length, verseBlocks: verseBlocks.length,
  };


  // Key: correlate the song's chroma profile against the Krumhansl
  // major/minor key profiles for all 12 tonics; the strongest Pearson
  // correlation wins. TWO reads are taken (recalibration, Nov 2, 2026):
  // the whole song, and the 16 seconds where the hook lands. The hook
  // is where a record states its home key — verses can lean on the VII
  // chord or the relative major for minutes and drag a whole-song
  // average to the wrong tonic (a D minor dance record read C major
  // that way, while its hook alone read D minor at r=0.79). So: when
  // the hook's own read is strong (r >= 0.50) and clearly beats the
  // whole-song winner's fit inside the hook window (margin >= 0.08),
  // the hook's key is the record's key. Below r = 0.35 the record
  // doesn't sit in a clear key (drum loops, spoken word, atonal) and
  // we say so with null rather than guess — the screen only shows
  // what it read.
  let key = null;
  {
    const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const KMAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const KMIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    const rankKeys = (arr) => {
      const total = arr.reduce((a, b) => a + b, 0);
      if (!total) return [];
      const c = arr.map((v) => v / total);
      const cMean = c.reduce((a, b) => a + b, 0) / 12;
      const cDev = c.map((v) => v - cMean);
      const cNorm = Math.sqrt(cDev.reduce((a, v) => a + v * v, 0));
      if (!cNorm) return [];
      const out = [];
      for (const [mode, prof] of [["major", KMAJ], ["minor", KMIN]]) {
        const pMean = prof.reduce((a, b) => a + b, 0) / 12;
        const pDev = prof.map((v) => v - pMean);
        const pNorm = Math.sqrt(pDev.reduce((a, v) => a + v * v, 0));
        if (!pNorm) continue;
        for (let t = 0; t < 12; t++) {
          let dot = 0;
          for (let pc = 0; pc < 12; pc++) dot += cDev[pc] * pDev[(pc - t + 12) % 12];
          out.push({ r: dot / (cNorm * pNorm), tonic: t, mode });
        }
      }
      return out.sort((a, b) => b.r - a.r);
    };
    const wholeList = rankKeys([...chroma]);
    const winChroma = new Float64Array(12);
    let winSecs = 0;
    for (let s = hookStart; s < Math.min(secChroma.length, hookStart + 16); s++) {
      const sc = secChroma[s];
      if (sc) { for (let pc = 0; pc < 12; pc++) winChroma[pc] += sc[pc]; winSecs++; }
    }
    const winList = winSecs >= 6 ? rankKeys([...winChroma]) : [];
    let best = wholeList[0] || null;
    if (best && winList.length) {
      const hookBest = winList[0];
      const wholeInWin = winList.find((e) => e.tonic === best.tonic && e.mode === best.mode);
      if (
        hookBest && wholeInWin &&
        (hookBest.tonic !== best.tonic || hookBest.mode !== best.mode) &&
        hookBest.r >= 0.5 && hookBest.r - wholeInWin.r >= 0.08
      ) best = hookBest;
    }
    if (best && best.r >= 0.35) {
        key = {
          root: NOTE_NAMES[best.tonic],
          mode: best.mode,
          confidence: Math.round(best.r * 100) / 100,
        };
    }
  }

  return {
    durationSec: Math.round(durSec * 10) / 10,
    crestDb: Math.round(crestDb * 10) / 10,
    drProxy: Math.round(drProxy * 10) / 10,
    energyCurve: [...energy].map((v) => Math.round(v * 10) / 10),
    leadQuietSec: leadQuiet, tailQuietSec: tailQuiet,
    hook: { startSec: hookStart, levelDb: Math.round(hookLevel * 10) / 10, repeats: hookRepeats, liftDb: Math.round(hookLift * 10) / 10 },
    bands, lowEndDb: lowEnd, topEndDb: topEnd,
    tempoStrength, bpm, vocalShare: vShare, melodicRangeSemis: melodicRange,
    key,
    sections,
    intro,
  };
}

// Full measurement of one audio file. Returns null if the file can't be read.
async function analyzeAudio(absPath) {
  try {
    const meta = await probe(absPath);
    if (!meta.duration) return null;
    const loud = await loudness(absPath);
    const pcm = await decode(absPath);
    if (!pcm.mono.length) return null;
    const body = analyzePcm(pcm.mono);
    const physical = analyzePhysical(pcm.lr, pcm.mono, body.energyCurve, meta.channels < 2);
    return { ...meta, ...loud, ...body, physical };
  } catch {
    return null;
  }
}

// The scorecard's Quick Specs (owner + A&R feedback, Nov 2, 2026): the
// pure numbers a busy executive reads before the prose — pulled from one
// measurement so the song page, the upload result and any future report
// all show the same figures the judge scored from.
function quickSpecs(m) {
  if (!m) return null;
  const n = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 10) / 10 : null);
  return {
    lufs: n(m.lufs),
    lra: n(m.lra),
    truePeak: n(m.truePeak),
    crestDb: n(m.crestDb),
    bpm: m.bpm ? Math.round(m.bpm) : null,
    keyRoot: m.key && m.key.root ? m.key.root : null,
    keyMode: m.key && m.key.mode ? m.key.mode : null,
    keyConf: m.key && typeof m.key.confidence === "number" ? Math.round(m.key.confidence * 100) : null,
    hookStartSec: m.hook && typeof m.hook.startSec === "number" ? Math.round(m.hook.startSec) : null,
    hookLiftDb: m.hook ? n(m.hook.liftDb) : null,
    durationSec: n(m.durationSec),
  };
}

module.exports = { analyzeAudio, BANDS, quickSpecs };
