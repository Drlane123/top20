"use strict";
// Top 20 — Judge v2 (measured). Owner spec Oct 31, 2026: "mathematically
// look at the spectrum" — no ears, no AI listening. analyze.js measures the
// song; this module compares the measurements against the genre templates
// Dale approved (~/workspace/top20/genre-bands-draft.md) and turns the
// distances into 14 of the 15 points. Point 15 (cover art) reuses judge.js.
// Family rulings (Dale): Southern Soul judges on the R&B template, Trap on
// Hip-Hop, Dance/Techno/House on Pop. Country stands on its own.
// Honest proxies (settled in the v2 spec): lyrics is read from vocal
// presence/clarity, emotion from dynamic contrast + hook lift, originality
// from how far the song's fingerprint sits from the template center —
// each note says what was actually measured.
const { analyzeAudio } = require("./analyze");
const { coverArtScore } = require("./judge");
const { CATEGORIES } = require("./config");

const TEMPLATES = {
  rb:      { label: "R&B",     lufs: [-11, -8.5], dr: [9, 13],  low: [4, 10], top: [-2, 4] },
  hiphop:  { label: "Hip-Hop", lufs: [-10, -7.5], dr: [8, 12],  low: [8, 15], top: [-2, 4] },
  pop:     { label: "Pop",     lufs: [-10, -7.5], dr: [7, 11],  low: [3, 8],  top: [1, 6] },
  country: { label: "Country", lufs: [-12, -9.5], dr: [10, 14], low: [1, 6],  top: [0, 5] },
};
const TEMPLATE_FOR = {
  "R&B": TEMPLATES.rb, "Southern Soul": TEMPLATES.rb,
  "Hip-Hop": TEMPLATES.hiphop, "Trap": TEMPLATES.hiphop,
  "Pop": TEMPLATES.pop, "Dance/Techno/House": TEMPLATES.pop,
  "Country": TEMPLATES.country,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round5 = (v) => Math.round(clamp(v, 1, 10) * 2) / 2;
// Inside the band: full marks. Outside: taper by distance.
const bandScore = (v, [lo, hi], slope) =>
  v == null ? 5.5 : round5(v >= lo && v <= hi ? 10 : 10 - (v < lo ? lo - v : v - hi) * slope);
const fmt = (v, d = 1) => (v == null ? "—" : Number(v).toFixed(d));

function judgeMeasured(m, genre, coverAbsPath) {
  const T = TEMPLATE_FOR[genre];
  const g = genre; // the song's own genre name, used in its notes
  const S = {}; // raw (unrounded) sub-scores
  const out = {}; // final per-category scores
  const notes = {};

  // ---- Mastering & Sound Quality: loudness in the pocket, peak discipline, LRA sanity
  const lufsScore = bandScore(m.lufs, T.lufs, 0.9);
  const peakScore = m.truePeak == null ? 6 : m.truePeak <= -1 ? 10 : m.truePeak <= -0.3 ? 8.5 : m.truePeak <= 0 ? 7 : m.truePeak <= 0.5 ? 4.5 : 2.5;
  const lraScore = m.lra == null ? 6 : m.lra >= 2 && m.lra <= T.dr[1] ? 9 : m.lra < 2 ? 5.5 : clamp(9 - (m.lra - T.dr[1]) * 0.3, 5, 9);
  out.mastering = round5(0.55 * lufsScore + 0.30 * peakScore + 0.15 * lraScore);
  // A master that clips cannot be a strong master, whatever its loudness.
  if (m.truePeak != null && m.truePeak > 0) out.mastering = Math.min(out.mastering, 6.5);
  notes.mastering = m.truePeak != null && m.truePeak > 0
    ? `The master runs hot — true peak reads ${fmt(m.truePeak)} dBTP, over the 0 ceiling. Loudness is ${fmt(m.lufs)} LUFS against a ${g} pocket of ${T.lufs[0]} to ${T.lufs[1]}; pull the limiter back and give it headroom.`
    : out.mastering >= 7
      ? `Reads ${fmt(m.lufs)} LUFS with true peak at ${fmt(m.truePeak)} — inside the ${g} pocket (${T.lufs[0]} to ${T.lufs[1]} LUFS) with clean headroom. Measured, not opinion.`
      : `Reads ${fmt(m.lufs)} LUFS against a ${g} pocket of ${T.lufs[0]} to ${T.lufs[1]} LUFS, true peak ${fmt(m.truePeak)}. The loudness isn't sitting where ${g} records compete yet.`;

  // ---- Mix Quality: low end and top end against the template, mids alive
  const lowScore = bandScore(m.lowEndDb, T.low, 0.55);
  const topScore = bandScore(m.topEndDb, T.top, 0.55);
  const midRel = m.bands.mid;
  const midHealth = midRel >= -16 && midRel <= -3 ? 9.5 : round5(9.5 - (midRel < -16 ? (-16 - midRel) * 0.35 : (midRel + 3) * 0.5));
  // The weakest leg drags the blend — a balance with one leg off the
  // template is not a balanced mix, however strong the other legs read.
  out.mix = round5(0.55 * (0.40 * lowScore + 0.35 * topScore + 0.25 * midHealth) + 0.45 * Math.min(lowScore, topScore, midHealth));
  notes.mix = out.mix >= 7
    ? `The spectrum balances like a ${g} record — low end ${fmt(m.lowEndDb)} dB over the mids (band: ${T.low[0]} to ${T.low[1]}), top end ${fmt(m.topEndDb)} (band: ${T.top[0]} to ${T.top[1]}). Everything has its space.`
    : `The balance is off the ${g} template — low end reads ${fmt(m.lowEndDb)} dB over the mids (band: ${T.low[0]} to ${T.low[1]}) and the top reads ${fmt(m.topEndDb)} (band: ${T.top[0]} to ${T.top[1]}). Rebalance toward those numbers.`;

  // ---- Dynamics & Energy: crest (the DR-style read) vs the genre band + breathing
  const breath = m.drProxy < 1.5 ? 4.5 : m.drProxy < 2.5 ? 7 : m.drProxy <= 9 ? 9.5 : m.drProxy <= 13 ? 7.5 : 6;
  const crestScore = bandScore(m.crestDb, T.dr, 0.8);
  out.dynamics = round5(0.55 * (0.65 * crestScore + 0.35 * breath) + 0.45 * Math.min(crestScore, breath));
  notes.dynamics = out.dynamics >= 7
    ? `Dynamics read ${fmt(m.crestDb)} dB peak-to-average — inside the ${g} band (${T.dr[0]} to ${T.dr[1]}) — and the song breathes ${fmt(m.drProxy)} dB across its sections. Big moments feel big.`
    : `Dynamics read ${fmt(m.crestDb)} dB peak-to-average against a ${g} band of ${T.dr[0]} to ${T.dr[1]}, with ${fmt(m.drProxy)} dB of movement between sections. ${m.crestDb < T.dr[0] ? "It is squeezed flat — ease off the compression and let it breathe." : "It swings wider than the genre's records — tighten the loudest peaks."}`;

  // ---- Groove & Rhythm: onset periodicity (tempo strength) + pocket steadiness
  const tempoMap = clamp(3 + m.tempoStrength * 13, 3, 9.8);
  const crestZone = m.crestDb >= 8 && m.crestDb <= 16 ? 8.5 : round5(8.5 - Math.max(0, Math.abs(m.crestDb - 12) - 4) * 0.4);
  out.groove = round5(0.70 * tempoMap + 0.30 * crestZone);
  notes.groove = out.groove >= 7
    ? `The pulse locks — the beat pattern repeats with ${Math.round(m.tempoStrength * 100)}% periodic strength around ${m.bpm} BPM. That's pocket a body can move to.`
    : `The pulse doesn't fully lock — beat periodicity measures ${Math.round(m.tempoStrength * 100)}%. Tighten the drum grid and let the bass and kick agree on where the beat lives.`;

  // ---- Structure + Hook (shared reads)
  const introScore = m.leadQuietSec <= 6 ? 9.5 : m.leadQuietSec <= 12 ? 7.5 : m.leadQuietSec <= 20 ? 5.5 : 4;
  const arrAbs = m.hook.startSec <= 20 ? 10 : m.hook.startSec <= 35 ? 9 : m.hook.startSec <= 50 ? 7.5 : m.hook.startSec <= 70 ? 6 : 4.5;
  const arrRel = m.durationSec > 0 ? m.hook.startSec / m.durationSec : 1;
  const arrRelScore = arrRel <= 0.15 ? 10 : arrRel <= 0.3 ? 8.5 : arrRel <= 0.45 ? 7 : arrRel <= 0.6 ? 5.5 : 4;
  const arrival = 0.6 * arrAbs + 0.4 * arrRelScore;
  const liftMap = m.hook.liftDb >= 2 ? 9.5 : m.hook.liftDb >= 1 ? 8 : m.hook.liftDb >= 0.3 ? 6.5 : 4.5;
  // Section reads (part two): hook-to-hook and verse-to-verse fingerprint
  // match, hook/verse blend, and how far the hook stands over the verse.
  const sec = m.sections || {};
  const matchMap = (v) => v == null ? null : v >= 0.99 ? 10 : v >= 0.97 ? 9 : v >= 0.95 ? 7.5 : v >= 0.92 ? 6 : v >= 0.88 ? 5 : 4;
  const hookMatchScore = matchMap(sec.hookMatch);
  const verseMatchScore = matchMap(sec.verseMatch);
  const promMap = sec.prominenceDb == null ? null : sec.prominenceDb >= 2.5 ? 9.5 : sec.prominenceDb >= 1.5 ? 8 : sec.prominenceDb >= 0.8 ? 6.5 : 4.5;
  const effLift = promMap == null ? liftMap : 0.6 * promMap + 0.4 * liftMap;
  const matchParts = [hookMatchScore, verseMatchScore].filter((v) => v != null);
  const consistency = matchParts.length ? matchParts.reduce((a, b) => a + b, 0) / matchParts.length : 7;
  const blendScore = sec.blend == null ? 7 : sec.blend > 0.995 ? 6.5 : sec.blend >= 0.8 ? 9 : sec.blend >= 0.7 ? 7 : 4.5;
  out.structure = round5(0.22 * introScore + 0.28 * arrival + 0.22 * (0.5 * effLift + 0.5 * breath) + 0.28 * (0.6 * consistency + 0.4 * blendScore));
  notes.structure = out.structure >= 7
    ? `Built right — the body is moving by second ${m.leadQuietSec}, the hook lands at ${m.hook.startSec}s${sec.prominenceDb != null ? ` standing ${fmt(sec.prominenceDb)} dB over the verse` : ""}${sec.verseMatch != null ? `, the verses match each other at ${Math.round(sec.verseMatch * 100)}%` : ""}${sec.blend != null ? `, and hook and verse blend at ${Math.round(sec.blend * 100)}% — one record, sections working together` : ""}.`
    : `The shape needs work — ${m.leadQuietSec > 12 ? `the song takes ${m.leadQuietSec}s to get going and ` : ""}the hook arrives at ${m.hook.startSec}s${sec.prominenceDb != null ? ` with only ${fmt(sec.prominenceDb)} dB over the verse` : ""}${sec.verseMatch != null && sec.verseMatch < 0.92 ? `, and the verses don't match each other (${Math.round(sec.verseMatch * 100)}%)` : ""}${sec.blend != null && sec.blend < 0.7 ? `; hook and verse barely blend (${Math.round(sec.blend * 100)}%) — they sound like different records` : ""}.`;

  const winCount = Math.max(1, Math.floor(m.durationSec / 8));
  const repRatio = m.hook.repeats / winCount;
  let repScore = repRatio >= 0.45 ? 9.5 : repRatio >= 0.3 ? 8 : repRatio >= 0.18 ? 6.5 : 5;
  // Repeats only count when the hook actually stands above the body —
  // a level that never changes has nothing repeating, just sameness.
  if (m.hook.liftDb < 1) repScore = Math.min(repScore, 5);
  out.hook = round5(0.28 * arrival + 0.22 * repScore + 0.20 * effLift + 0.30 * (hookMatchScore == null ? 7 : hookMatchScore));
  // Flatline rule: a song whose level never moves has no structure, hook
  // or vocal performance to judge — cap the shape-based points.
  const flatline = m.drProxy < 1 && m.hook.liftDb < 0.5;
  if (flatline) {
    out.hook = Math.min(out.hook, 5);
    out.structure = Math.min(out.structure, 5.5);
  }
  notes.hook = out.hook >= 7
    ? `The hook lands at ${m.hook.startSec}s, lifts ${fmt(m.hook.liftDb)} dB over the verses, and its level comes back ${m.hook.repeats} times${sec.hookMatch != null ? ` — and the hooks match each other at ${Math.round(sec.hookMatch * 100)}%, so every chorus hits the same way` : ""}. That's the part a listener walks away singing.`
    : `The hook is late or light — it arrives at ${m.hook.startSec}s with ${fmt(m.hook.liftDb)} dB of lift and ${m.hook.repeats} returns at full level${sec.hookMatch != null && sec.hookMatch < 0.92 ? `, and the hooks don't match each other (${Math.round(sec.hookMatch * 100)}%) — every chorus should hit like the same chorus` : ""}. Earlier, bigger, and more often is what makes a hook stick.`;

  // ---- Vocals (presence of the voice band + how it cuts through)
  const vs = m.vocalShare;
  const vocalZone = vs >= 0.26 && vs <= 0.5 ? 9.5 : vs >= 0.5 && vs <= 0.6 ? 7.5 : vs >= 0.18 ? 7 : vs > 0.6 ? 6 : round5(3.5 + vs * 20);
  const presRel = m.bands.presence;
  const presenceCut = round5(clamp(9 - Math.max(0, -14 - presRel) * 0.45, 3, 9.5));
  out.vocals = round5(0.60 * vocalZone + 0.40 * presenceCut);
  if (flatline) out.vocals = Math.min(out.vocals, 4.5);
  notes.vocals = out.vocals >= 7
    ? `The voice owns its band — ${Math.round(vs * 100)}% of the song's energy sits in the vocal range and the presence cuts through. The performance reads clear and up front.`
    : `The voice isn't owning the record — only ${Math.round(vs * 100)}% of the energy sits in the vocal band. Push the vocal forward and clear the instruments out of its way.`;

  // ---- Lyrics (proxy: vocal clarity — the words can only land if they're heard)
  out.lyrics = round5(0.65 * out.vocals + 0.35 * presenceCut);
  notes.lyrics = out.lyrics >= 7
    ? `The words come through intelligible and present — every line can be heard the first time, which is what lets writing land.`
    : `The words are fighting the track — vocal clarity measures low, so lines get lost. A clearer, more forward vocal gives the writing its chance.`;

  // ---- Melody (range + presence of the melodic line)
  const rangeScore = m.melodicRangeSemis >= 5 && m.melodicRangeSemis <= 15 ? 9.5 : m.melodicRangeSemis >= 3 ? 7.5 : m.melodicRangeSemis > 15 && m.melodicRangeSemis <= 20 ? 7.5 : m.melodicRangeSemis < 3 ? 4.5 : 5.5;
  const midPresence = m.bands.mid >= -18 ? 8.5 : round5(8.5 - (-18 - m.bands.mid) * 0.3);
  out.melody = round5(0.65 * rangeScore + 0.35 * midPresence);
  notes.melody = out.melody >= 7
    ? `The melodic line travels ${fmt(m.melodicRangeSemis)} semitones — enough contour to remember, not so much it wanders. It pulls the ear forward.`
    : `The melody ${m.melodicRangeSemis < 3 ? `barely moves — ${fmt(m.melodicRangeSemis)} semitones of range reads static` : `sprawls across ${fmt(m.melodicRangeSemis)} semitones without a shape to hold onto`}. Give it a contour people can carry.`;

  // ---- Production & Instrumentation: completeness of the spectrum + balance + organization
  const rel = m.bands;
  const alive = ["sub", "bass", "lowmid", "mid", "presence", "brilliance"].filter((k) => rel[k] >= -32).length + (rel.air >= -45 ? 1 : 0);
  const completeness = 3 + 7 * (alive / 7);
  out.production = round5(0.35 * completeness + 0.35 * ((lowScore + topScore) / 2) + 0.30 * tempoMap);
  notes.production = out.production >= 7
    ? `A full-spectrum production — ${alive} of 7 frequency bands are alive and working, balanced on the ${g} template. The record sounds finished.`
    : `The production has holes — only ${alive} of 7 frequency bands are really alive. Fill the spectrum: a record should have something working from the sub to the air.`;

  // ---- Emotional Impact (proxy: dynamic contrast + the big moment landing)
  out.emotion = round5(0.55 * out.dynamics + 0.45 * liftMap);
  notes.emotion = out.emotion >= 7
    ? `The feeling is in the movement — ${fmt(m.drProxy)} dB of dynamic travel and a hook that lifts ${fmt(m.hook.liftDb)} dB over the body. The record makes you feel the turn.`
    : `The emotion is blunted by flatness — only ${fmt(m.drProxy)} dB of movement and ${fmt(m.hook.liftDb)} dB of hook lift. Feeling lives in contrast: quieter quiets, bigger bigs.`;

  // ---- Originality (proxy: distance of the fingerprint from the template center)
  const cLow = (T.low[0] + T.low[1]) / 2, cTop = (T.top[0] + T.top[1]) / 2, cLufs = (T.lufs[0] + T.lufs[1]) / 2;
  const dist = (Math.abs(m.lowEndDb - cLow) + Math.abs(m.topEndDb - cTop) + Math.abs((m.lufs || cLufs) - cLufs)) / 3;
  out.originality = round5(dist >= 1.2 && dist <= 3.2 ? 9.5 : dist < 0.6 ? 5.5 : dist < 1.2 ? 7.5 : dist <= 5 ? 7 : 5);
  notes.originality = out.originality >= 7
    ? `Its fingerprint sits ${fmt(dist)} dB off the dead center of the ${g} template — in the family, but with its own sound. You can tell whose record this is.`
    : dist < 0.6
      ? `Its fingerprint sits almost exactly on the generic center of the ${g} template — competent, but interchangeable. Push one element that's unmistakably this artist.`
      : `Its fingerprint sits ${fmt(dist)} dB off the ${g} template center — outside the family reads as off, not original. Keep the identity, fix the balance.`;

  // ---- Replay Value + Radio Readiness (composites of measured reads)
  out.replay = round5(0.50 * out.hook + 0.30 * out.groove + 0.20 * out.dynamics);
  notes.replay = out.replay >= 7
    ? `Hook at ${m.hook.startSec}s, groove locked at ${Math.round(m.tempoStrength * 100)}% — when it ends, the shape of it makes you run it back.`
    : `One pass doesn't yet demand a second — the hook and groove reads aren't strong enough together. Strengthen the moment people would rewind for.`;
  out.radio_readiness = round5(0.45 * out.mastering + 0.30 * out.mix + 0.25 * arrival);
  notes.radio_readiness = out.radio_readiness >= 7
    ? `Radio-legal and radio-shaped: ${fmt(m.lufs)} LUFS, true peak ${fmt(m.truePeak)}, hook by ${m.hook.startSec}s. This can sit next to signed records and belong.`
    : `Not at radio standard yet — the loudness, balance and hook timing measure short of the ${g} marks above. Fix the mastering and the hook arrival first.`;

  // ---- Cover art (point 15): the existing real inspection of the image file.
  const scores = {};
  let total = 0;
  for (const cat of CATEGORIES) {
    if (cat.key === "cover_art") continue;
    scores[cat.key] = out[cat.key];
    total += out[cat.key];
  }
  if (coverAbsPath) {
    const seedInt = ((Math.round(m.durationSec * 100) ^ Math.round(((m.lufs || 0) + 40) * 1000) ^ Math.round(m.crestDb * 77)) >>> 0);
    const cover = coverArtScore(coverAbsPath, seedInt);
    scores.cover_art = cover.score;
    notes.cover_art = cover.note;
    total += cover.score;
  } else {
    scores.cover_art = 5;
    notes.cover_art = "No cover was measured.";
    total += 5;
  }
  return {
    scores, notes,
    totalScore: Math.round(total * 10) / 10,
    craftScore: Math.round((total / 150) * 1000) / 10,
    durationSeconds: Math.round(m.durationSec),
    measurements: m,
    engine: "v2-measured",
  };
}

// Measured judging of one uploaded file. Returns null when the file can't
// be measured — the caller falls back to Judge v1 for that song.
async function judgeMeasuredFile(absPath, genre, coverAbsPath = null) {
  if (!TEMPLATE_FOR[genre]) return null;
  const m = await analyzeAudio(absPath);
  if (!m || m.lufs == null) return null;
  return judgeMeasured(m, genre, coverAbsPath);
}

module.exports = { judgeMeasuredFile, judgeMeasured, TEMPLATES, TEMPLATE_FOR };
