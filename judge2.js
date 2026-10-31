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

// Lyrical Quality from the words themselves, when the artist submits them
// with the upload — pure text mathematics, no machine listening: rhyme
// density on line endings, vocabulary richness, hook-line recurrence and
// line-length flow. Returns null when there isn't enough text to judge.
function rhymeKey(word) {
  const w = String(word || "").toLowerCase().replace(/[^a-z]/g, "");
  if (w.length < 2) return w;
  const m = w.match(/[aeiouy]+[^aeiouy]*$/);
  return m ? m[0] : w.slice(-2);
}
function scoreLyricsText(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 1);
  const words = String(text).toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
  if (lines.length < 8 || words.length < 50) return null;
  const unique = new Set(words).size;
  const uniqueRatio = unique / words.length;
  const vocabScore = uniqueRatio >= 0.55 ? 9 : uniqueRatio >= 0.45 ? 8 : uniqueRatio >= 0.35 ? 6.5 : 5;
  const endKeys = lines.map((l) => rhymeKey(l.split(/\s+/).pop()));
  const keyCounts = {};
  for (const k of endKeys) if (k) keyCounts[k] = (keyCounts[k] || 0) + 1;
  const rhymed = endKeys.filter((k) => k && keyCounts[k] >= 2).length;
  const rhymePct = Math.round((rhymed / Math.max(1, endKeys.length)) * 100);
  const rhymeScore = rhymePct >= 60 ? 9.5 : rhymePct >= 45 ? 8 : rhymePct >= 30 ? 6.5 : 5;
  const lineCounts = {};
  for (const l of lines) { const k = l.toLowerCase(); lineCounts[k] = (lineCounts[k] || 0) + 1; }
  const hookLineCount = Math.max(...Object.values(lineCounts));
  const recurScore = hookLineCount >= 3 ? 8.5 : hookLineCount === 2 ? 7 : 5.5;
  const lens = lines.map((l) => l.split(/\s+/).length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
  const cv = mean > 0 ? sd / mean : 1;
  const flowScore = cv <= 0.35 ? 8.5 : cv <= 0.55 ? 7 : 5.5;
  return {
    score: round5(0.35 * rhymeScore + 0.30 * vocabScore + 0.20 * recurScore + 0.15 * flowScore),
    lines: lines.length, rhymePct, hookLineCount, uniqueWords: unique,
  };
}

// Radio's clean-language law (Dale, A&R/music-director doctrine): a record
// with profanity is not radio ready, and a profane TITLE gets no radio
// approval at all — a DJ can't even say the name on air. Pure text
// scanning of the words the artist sends in; nothing listens.
const PROFANITY_HARD = new Set(("fuck fucking fucked fucker fuckers motherfucker motherfuckers shit shitting bullshit bitch bitches nigga niggas nigger niggers dick dicks pussy cunt cock cocks whore whores slut sluts hoe hoes tits titty faggot").split(" "));
const PROFANITY_MILD = new Set(("damn damned hell ass bastard bastards piss pissed").split(" "));
function scanProfanity(text) {
  const toks = String(text || "").toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
  const hard = new Set(), mild = new Set();
  let hardHits = 0, mildHits = 0;
  for (const t of toks) {
    if (PROFANITY_HARD.has(t)) { hard.add(t); hardHits++; }
    else if (PROFANITY_MILD.has(t)) { mild.add(t); mildHits++; }
  }
  return { hardHits, hardWords: [...hard], mildHits, mildWords: [...mild] };
}

function judgeMeasured(m, genre, coverAbsPath, lyricsText, titleText) {
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

  // ---- Mix Quality: low end and top end against the template, mids alive,
  // and the stereo physically in place (mono fold-down safety).
  const lowScore = bandScore(m.lowEndDb, T.low, 0.55);
  const topScore = bandScore(m.topEndDb, T.top, 0.55);
  const midRel = m.bands.mid;
  const midHealth = midRel >= -16 && midRel <= -3 ? 9.5 : round5(9.5 - (midRel < -16 ? (-16 - midRel) * 0.35 : (midRel + 3) * 0.5));
  const phys = m.physical || {};
  const physScore = phys.monoSource ? 7
    : phys.correlation == null ? 7
    : phys.correlation >= 0.5 ? 9.5 : phys.correlation >= 0.3 ? 7.5 : phys.correlation >= 0 ? 5 : 3;
  // The weakest leg drags the blend — a balance with one leg off the
  // template is not a balanced mix, however strong the other legs read.
  out.mix = round5(0.55 * (0.32 * lowScore + 0.28 * topScore + 0.16 * midHealth + 0.24 * physScore) + 0.45 * Math.min(lowScore, topScore, midHealth));
  if (!phys.monoSource && phys.correlation != null && phys.correlation < 0) out.mix = Math.min(out.mix, 6); // phase-broken: folds down broken
  notes.mix = out.mix >= 7
    ? `The spectrum balances like a ${g} record — low end ${fmt(m.lowEndDb)} dB over the mids (band: ${T.low[0]} to ${T.low[1]}), top end ${fmt(m.topEndDb)} (band: ${T.top[0]} to ${T.top[1]})${phys.monoSource ? "" : `, and the stereo folds down clean at ${Math.round((phys.correlation || 0) * 100)}% correlation`}. Everything has its space.`
    : `The balance is off the ${g} template — low end reads ${fmt(m.lowEndDb)} dB over the mids (band: ${T.low[0]} to ${T.low[1]}) and the top reads ${fmt(m.topEndDb)} (band: ${T.top[0]} to ${T.top[1]})${!phys.monoSource && phys.correlation != null && phys.correlation < 0.3 ? `. Worse, the stereo folds to mono at ${Math.round(phys.correlation * 100)}% correlation — parts cancel on phone speakers and mono radios; check the phase` : ""}. Rebalance toward those numbers.`;

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
  const introLenScore = m.leadQuietSec <= 6 ? 9.5 : m.leadQuietSec <= 12 ? 7.5 : m.leadQuietSec <= 20 ? 5.5 : 4;
  const introRead = m.intro || {};
  const introBuildScore = introRead.coldOpen ? 9 : introRead.buildDb == null ? 7.5 : introRead.buildDb >= 3 ? 9.5 : introRead.buildDb >= 1 ? 8 : introRead.buildDb >= -1 ? 6 : 5;
  const introScore = 0.55 * introLenScore + 0.45 * introBuildScore;
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
  if (phys.abruptEnd) out.structure = Math.min(out.structure, 7); // chopped ending = unfinished form
  notes.structure = out.structure >= 7
    ? `Built right — ${introRead.coldOpen ? "it opens cold, straight in" : introRead.buildDb != null && introRead.buildDb >= 1 ? `the intro builds ${fmt(introRead.buildDb)} dB into the song` : `the body is moving by second ${m.leadQuietSec}`}, the hook lands at ${m.hook.startSec}s${sec.prominenceDb != null ? ` standing ${fmt(sec.prominenceDb)} dB over the verse` : ""}${sec.verseMatch != null ? `, the verses match each other at ${Math.round(sec.verseMatch * 100)}%` : ""}${sec.blend != null ? `, and hook and verse blend at ${Math.round(sec.blend * 100)}% — one record, sections working together` : ""}${phys.abruptEnd ? " — but the ending is chopped off mid-sound: no fade, no ring-out, the record just stops" : ""}.`
    : `The shape needs work — ${m.leadQuietSec > 12 ? `the song takes ${m.leadQuietSec}s to get going and ` : ""}the hook arrives at ${m.hook.startSec}s${sec.prominenceDb != null ? ` with only ${fmt(sec.prominenceDb)} dB over the verse` : ""}${sec.verseMatch != null && sec.verseMatch < 0.92 ? `, and the verses don't match each other (${Math.round(sec.verseMatch * 100)}%)` : ""}${sec.blend != null && sec.blend < 0.7 ? `; hook and verse barely blend (${Math.round(sec.blend * 100)}%) — they sound like different records` : ""}${phys.abruptEnd ? "; and the ending is chopped off mid-sound — no fade, no ring-out, the record just stops" : ""}.`;

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

  // ---- Lyrics. When the artist sent the words in with the upload, the
  // words themselves are read (pure text math: rhyme, vocabulary,
  // recurrence, flow). Without them, the honest fallback is the vocal
  // clarity proxy — a spectrum cannot hear words.
  const lyricRead = lyricsText ? scoreLyricsText(lyricsText) : null;
  if (lyricRead) {
    out.lyrics = lyricRead.score;
    notes.lyrics = lyricRead.score >= 7
      ? `Read from the words you sent in: ${lyricRead.lines} lines, rhyme lands on ${lyricRead.rhymePct}% of the line endings, the hook line comes back ${lyricRead.hookLineCount} times, and the vocabulary runs ${lyricRead.uniqueWords} distinct words. The writing has structure and a hook of its own.`
      : `Read from the words you sent in: ${lyricRead.lines} lines with rhyme on ${lyricRead.rhymePct}% of line endings and ${lyricRead.uniqueWords} distinct words. ${lyricRead.rhymePct < 30 ? "The line endings rarely rhyme — give the ear something to hold. " : ""}${lyricRead.hookLineCount < 2 ? "No line comes back — a hook line that repeats is what sticks. " : ""}Sharper, more musical writing raises this.`;
  } else {
    out.lyrics = round5(0.65 * out.vocals + 0.35 * presenceCut);
    notes.lyrics = out.lyrics >= 7
      ? `The words come through intelligible and present — every line can be heard the first time, which is what lets writing land. (No lyrics were sent in with this upload, so this point rides on vocal clarity.)`
      : `The words are fighting the track — vocal clarity measures low, so lines get lost. A clearer, more forward vocal gives the writing its chance. (No lyrics were sent in with this upload, so this point rides on vocal clarity.)`;
  }

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
  const drops = (phys.dropouts || []);
  if (drops.length) out.production = Math.min(out.production, 6); // a hole in the audio is a production fault
  notes.production = drops.length
    ? `There's a hole in the record — ${fmt(drops[0].dur, 1)} seconds of silence at ${Math.floor(drops[0].at / 60)}:${String(Math.floor(drops[0].at % 60)).padStart(2, "0")} where the music should be${drops.length > 1 ? `, and ${drops.length - 1} more` : ""}. A dropout like that reads as a broken file, not a breakdown. Fix the export and re-upload.`
    : out.production >= 7
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
  // ---- Radio Readiness — judged the music-director way (Dale): a song is
  // radio ready when its MIX measures close to the radio formats — Pop,
  // R&B and Hip-Hop — no matter what chart it sits on, and when the record
  // is clean: profanity in the words caps it, profanity in the TITLE gets
  // no radio approval at all.
  const formatMatch = (T) => (bandScore(m.lufs, T.lufs, 0.5) + bandScore(m.drProxy, T.dr, 0.5) + bandScore(m.lowEndDb, T.low, 0.5) + bandScore(m.topEndDb, T.top, 0.5)) / 4;
  const radioFam = [TEMPLATES.pop, TEMPLATES.rb, TEMPLATES.hiphop].map((T) => ({ name: T.label, score: formatMatch(T) })).sort((a, b) => b.score - a.score);
  const famMean = radioFam.reduce((a, f) => a + f.score, 0) / radioFam.length;
  let radioBase = round5(0.6 * radioFam[0].score + 0.4 * famMean);
  if (m.truePeak > -0.3) radioBase = Math.min(radioBase, 7); // broadcast ceiling
  const titleScan = scanProfanity(titleText);
  const lyricScan = lyricsText ? scanProfanity(lyricsText) : null;
  const titleProfane = titleScan.hardHits + titleScan.mildHits > 0;
  if (titleProfane) {
    out.radio_readiness = 1;
    notes.radio_readiness = `No radio approval — the title itself carries profanity ("${[...titleScan.hardWords, ...titleScan.mildWords][0]}"). A DJ can't even say this record's name on air, so it doesn't get judged for radio at all, no matter how the mix measures. Retitle it clean and the radio read opens up.`;
  } else if (lyricScan && lyricScan.hardHits > 0) {
    out.radio_readiness = Math.min(radioBase, 3);
    notes.radio_readiness = `Not radio ready — the lyrics sent in carry ${lyricScan.hardHits} explicit hit${lyricScan.hardHits > 1 ? "s" : ""} (${lyricScan.hardWords.slice(0, 3).join(", ")}${lyricScan.hardWords.length > 3 ? "…" : ""}). Radio can't play it as-is no matter how the mix measures — and the mix itself sits closest to the ${radioFam[0].name} radio profile. Upload a clean edit and this point is judged on the sound.`;
  } else {
    out.radio_readiness = lyricScan && lyricScan.mildHits > 0 ? Math.min(radioBase, 7.5) : radioBase;
    notes.radio_readiness = out.radio_readiness >= 7
      ? `Radio shaped the way music directors hear it — the mix measures closest to the ${radioFam[0].name} radio profile (${fmt(m.lufs)} LUFS integrated, low end ${fmt(m.lowEndDb)} dB, top ${fmt(m.topEndDb)}), with ${radioFam[1].name} not far behind${lyricScan ? ", and the words sent in check clean" : ""}. This can sit next to signed records and belong.`
      : `Not at radio standard yet — measured against the radio formats, the mix sits closest to ${radioFam[0].name} but still off the mark (${fmt(m.lufs)} LUFS, low end ${fmt(m.lowEndDb)} dB vs the radio bands, top ${fmt(m.topEndDb)}). Radio ready is a sound: match the Pop / R&B / Hip-Hop profiles above${lyricScan ? "" : " — and send the lyrics in with the upload so the clean-language check can run too"}.`;
  }

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
async function judgeMeasuredFile(absPath, genre, coverAbsPath = null, lyricsText = null, titleText = null) {
  if (!TEMPLATE_FOR[genre]) return null;
  const m = await analyzeAudio(absPath);
  if (!m || m.lufs == null) return null;
  return judgeMeasured(m, genre, coverAbsPath, lyricsText, titleText);
}

module.exports = { judgeMeasuredFile, judgeMeasured, scoreLyricsText, scanProfanity, TEMPLATES, TEMPLATE_FOR };
