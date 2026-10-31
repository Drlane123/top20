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

// Decode to mono float PCM (capped), straight from ffmpeg's stdout.
async function decode(absPath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cap = SR * MAX_SECONDS * 4;
    const { spawn } = require("node:child_process");
    const p = spawn("ffmpeg", ["-v", "error", "-i", absPath, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"]);
    p.stdout.on("data", (d) => { if (size < cap) { chunks.push(d); size += d.length; } });
    p.stderr.on("data", () => {});
    p.on("error", reject);
    p.on("close", () => {
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
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
  let prevMag = null, fluxSum = 0, fluxCount = 0;
  const fluxCurve = [];
  const domFreqs = [];
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
    const mags = fftMag(re, im);
    for (let i = 0; i < mags.length; i++) acc[i] += mags[i];
    if (prevMag) {
      let fl = 0;
      for (let i = 2; i < mags.length; i++) { const d = mags[i] - prevMag[i]; if (d > 0) fl += d; }
      fluxCurve.push(fl); fluxSum += fl; fluxCount++;
    }
    prevMag = mags;
    // dominant frequency in the melodic range 80..1200 Hz
    let bi = -1, bv = 0;
    const lo = Math.floor((80 * N) / SR), hi = Math.floor((1200 * N) / SR);
    for (let i = lo; i <= hi; i++) if (mags[i] > bv) { bv = mags[i]; bi = i; }
    if (bi > 0 && bv > 0.02) domFreqs.push((bi * SR) / N);
  }
  const binHz = SR / N;
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

  // Groove: autocorrelation of the onset-flux envelope at beat lags
  // (0.25s..1.5s -> 240..40 BPM); strength = how periodic the onsets are.
  // A steady tone has no onsets at all — if the flux is effectively zero
  // relative to the spectrum's size, there is no pulse to find.
  let tempoStrength = 0, bpm = 0;
  const avgMag = frames > 0 ? acc.reduce((a, b) => a + b, 0) / (acc.length * frames) : 0;
  const relFlux = avgMag > 0 && fluxCount > 0 ? (fluxSum / fluxCount) / (avgMag * (N / 2)) : 0;
  if (fluxCurve.length > 40 && relFlux >= 0.01) {
    const fps = SR / HOP;
    const mean = fluxSum / fluxCount;
    const fc = fluxCurve.map((v) => v - mean);
    const minLag = Math.floor(0.25 * fps), maxLag = Math.floor(1.5 * fps);
    let best = 0, bestLag = 0, zero = 0;
    for (let i = 0; i < fc.length; i++) zero += fc[i] * fc[i];
    for (let lag = minLag; lag <= maxLag && lag < fc.length / 2; lag++) {
      let s = 0; for (let i = 0; i + lag < fc.length; i++) s += fc[i] * fc[i + lag];
      const v = zero > 0 ? s / zero : 0;
      if (v > best) { best = v; bestLag = lag; }
    }
    tempoStrength = Math.round(Math.max(0, Math.min(1, best)) * 100) / 100;
    if (bestLag > 0) {
      bpm = Math.round((60 * fps) / bestLag);
      while (bpm > 0 && bpm < 70) bpm *= 2;   // fold sub-multiples into the musical range
      while (bpm > 180) bpm = Math.round(bpm / 2);
    }
  }

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

  return {
    durationSec: Math.round(durSec * 10) / 10,
    crestDb: Math.round(crestDb * 10) / 10,
    drProxy: Math.round(drProxy * 10) / 10,
    energyCurve: [...energy].map((v) => Math.round(v * 10) / 10),
    leadQuietSec: leadQuiet, tailQuietSec: tailQuiet,
    hook: { startSec: hookStart, levelDb: Math.round(hookLevel * 10) / 10, repeats: hookRepeats, liftDb: Math.round(hookLift * 10) / 10 },
    bands, lowEndDb: lowEnd, topEndDb: topEnd,
    tempoStrength, bpm, vocalShare: vShare, melodicRangeSemis: melodicRange,
  };
}

// Full measurement of one audio file. Returns null if the file can't be read.
async function analyzeAudio(absPath) {
  try {
    const meta = await probe(absPath);
    if (!meta.duration) return null;
    const loud = await loudness(absPath);
    const pcm = await decode(absPath);
    if (!pcm.length) return null;
    const body = analyzePcm(pcm);
    return { ...meta, ...loud, ...body };
  } catch {
    return null;
  }
}

module.exports = { analyzeAudio, BANDS };
