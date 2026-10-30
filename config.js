// Top 20 — owner-tunable config (spec section 9: rubric, weights and
// formula splits live in one owner-controlled place).

const GENRES = ["R&B", "Southern Soul", "Hip-Hop", "Trap", "Country", "Pop"];
const OVERALL = "Overall"; // cross-genre chart key (spec refinement)

// The 15 universal judging criteria (spec 3.3). Same 15 for every genre.
// key = judge_scores column name, label = display name.
const CATEGORIES = [
  { key: "mix",            label: "Mix Quality" },
  { key: "mastering",      label: "Mastering & Sound Quality" },
  { key: "hook",           label: "Hook Strength" },
  { key: "melody",         label: "Melody" },
  { key: "lyrics",         label: "Lyrical Quality" },
  { key: "structure",      label: "Song Structure" },
  { key: "vocals",         label: "Vocal Delivery & Performance" },
  { key: "production",     label: "Production & Instrumentation" },
  { key: "groove",         label: "Groove & Rhythm" },
  { key: "emotion",        label: "Emotional Impact" },
  { key: "dynamics",       label: "Dynamics & Energy" },
  { key: "originality",    label: "Originality & Identity" },
  { key: "replay",         label: "Replay Value" },
  { key: "radio_readiness", label: "Radio & Commercial Readiness" },
  { key: "cover_art",      label: "Cover Art & Presentation" },
];

// Chart formula (spec 3.4): Chart = 60% craft + 40% engagement.
// Engagement = 75% in-app + 25% social buzz (buzz max ~10% of chart score).
const FORMULA = {
  craftWeight: 0.6,
  engagementWeight: 0.4,
  inAppShare: 0.75,
  buzzShare: 0.25,
};

// Raw in-app engagement weighting: one like is worth more than one play, etc.
const ENGAGEMENT_WEIGHTS = { play: 1, like: 4, share: 6, save: 5 };

// US state -> region (spec 3.4). Default: South.
const STATE_REGION = {
  TX: "South", LA: "South", MS: "South", AL: "South", GA: "South",
  FL: "South", TN: "South", SC: "South", NC: "South", AR: "South",
  OK: "South", KY: "South", VA: "South", WV: "South",
  IL: "Midwest", IN: "Midwest", OH: "Midwest", MI: "Midwest",
  WI: "Midwest", MN: "Midwest", IA: "Midwest", MO: "Midwest",
  KS: "Midwest", NE: "Midwest", SD: "Midwest", ND: "Midwest",
  NY: "Northeast", NJ: "Northeast", PA: "Northeast", MA: "Northeast",
  CT: "Northeast", VT: "Northeast", NH: "Northeast", ME: "Northeast",
  RI: "Northeast", MD: "Northeast", DE: "Northeast",
  CA: "West", OR: "West", WA: "West", NV: "West", AZ: "West",
  UT: "West", CO: "West", ID: "West", MT: "West", WY: "West", NM: "West",
};

function regionForState(state) {
  if (!state) return "South";
  return STATE_REGION[String(state).trim().toUpperCase()] || "South";
}

function localKey(city, state) {
  return `${String(city || "").trim()}, ${String(state || "").trim().toUpperCase()}`;
}

module.exports = { GENRES, OVERALL, CATEGORIES, FORMULA, ENGAGEMENT_WEIGHTS, regionForState, localKey };
