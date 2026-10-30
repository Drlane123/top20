# TOP 20 — App v1

A working first version of the Top 20 music chart platform (see the full
product spec at `../top20-app-spec.md`). Independent artists upload songs,
every song is judged on **15 universal craft criteria — including the cover
art itself**, and songs are ranked on **Local / Regional / National Top 20
charts per genre — plus a cross-genre Overall Top 20 at every level**. Only
the Top 20 plays on **the Stage**, a 24/7 rotation player that runs the
chart in order, #1 through #20, and loops. Artists are emailed when they
chart — and never when they fall off.

**Standing rule:** the system only judges and charts songs that were
**uploaded to Top 20**. No outside music is imported, scraped, or judged.

## Run it

Requires Node 24 (uses the built-in `node:sqlite` — no native builds).

```bash
cd ~/workspace/top20/app
npm install     # express + multer (already installed in this checkout)
node seed.js    # reset + seed demo data (36 songs, profiles, charts, yesterday snapshot, DJ races)
node server.js  # http://localhost:8077  (binds 0.0.0.0:8077)
```

Open from a phone on the same network with the machine's LAN address,
e.g. `http://<this-machine>:8077` — the layout is mobile-first.

Re-running `node seed.js` wipes the database and all generated/uploaded
demo media and starts clean. `POST /admin/recalc` re-runs today's chart
calculation (also runs automatically after every upload and every song
removal). **In production the daily recalculation runs as a scheduled job
at 12:00 AM** — midnight is when the new chart takes effect, new entries
come into Stage rotation, and knocked-off songs leave it. The demo keeps
the manual admin recalc; no cron is needed here.

## Pages

| Route | What it is |
|---|---|
| `GET /` | **The Stage** — Main Stage channel (National **Overall** Top 20, default) + one channel per genre (R&B, Southern Soul, Hip-Hop, Trap, Country, Pop). Playlists run strictly in chart order #1→#20, then loop back to #1. New Entries section, the day's Top 20 list (first 5 + expand), a How It Works strip, the Stage rules (midnight swap), and a **Create Profile** button in the header |
| `GET /charts` | Level tabs (Local / Regional / National) × genre pills (**Overall** + 6 genres), region/city selector, Top 5 / Top 10 / Top 20 tier toggle, Billboard-style rows (LW · PEAK · WEEKS stats, NEW / RE-ENTRY pills, #1 hero card), New Entries strip, extended rankings to Top 100 |
| `GET /song/:id` | Player, big cover, all 15 category score bars with critique notes, craft score, the song's exact rank on each of its charts (genre + Overall), with "X pts from the Top 20" when ranked below 20; artist name links to the artist profile; Like / Save buttons |
| `GET /artist/:id` | **Public artist profile** — photo (or styled initial avatar), name, city/state, genre, years in the game, age **only if the artist set it**, bio, history, chart highlights, and their live songs with craft scores and current best ranks |
| `GET /profile` | Profile setup/edit (email-keyed, no passwords in v1): loads or creates the profile for an email and edits photo, bio, age, history, years in the game, genre, name/city/state. The **Rules of Top 20** panel sits right with the form |
| `GET /how-it-works` | How the algorithm works, in plain words: Part 1 — The Search (Facebook, Instagram, TikTok, YouTube, the music platforms, the open web), Part 2 — The Judging (all 15 points listed), the Stage/midnight rules, and THE RULES strip |
| `GET /upload` | Upload form. **A profile is required first** (the page checks your email), audio **and cover art are both required**, and the audio must be **radio quality** (below) |
| `POST /upload` | Gates in order: cover present → **radio-quality audio check** → profile on file → **2-live-songs cap** → judge (cover judged too) → recalc charts → craft breakdown + ranks + the chart-entry email if the song entered a Top 20 |
| `GET /dashboard` | Email lookup → profile completeness + public-profile link, **"Song slots: X of 2 used"**, every live song's exact ranks, and a **Remove** button per song |
| `POST /dashboard/remove` | Sets a song to `removed` and recalcs immediately — the song leaves the charts and the slot frees up for a replacement |
| `GET /djs` | **City DJs** — the DJ of the Month landing: a **Submit a DJ** button, a spotlight card per city with this month's current leader + vote count, the list of cities racing this month, and the **Past winners** archive |
| `GET /djs/city/:city?state=ST` | One city's board for the current month: DJs ranked by votes with a **👑 LEADING** marker on the leader, a **Vote** button per DJ, and last month's winner for that city shown under the board |
| `GET /djs/submit` · `POST /djs/submit` | Submit a DJ (name + city required; state, hood, how-they-support-independents, socials, your name optional). Anybody can submit — the DJ, an artist, or a fan. The DJ lands on the current month's board for their city |
| `POST /djs/:id/vote` | Cast a vote. Identity is a long-lived random `t20_voter` cookie; **one vote per person per DJ per month**, enforced by a `UNIQUE(dj_id, voter_key, month)` constraint — a repeat vote returns the board with *"You already voted for this DJ this month."* |
| `GET /admin/outbox` | The simulated email inbox: every chart-entry email ever "sent" |
| `POST /admin/recalc` | Manual chart recalculation (JSON response) |
| `POST /api/play/:id` | Counts one Stage play |

## The rules, as enforced in code

- **Recognition** — an artist needs a **profile page + at least one song
  uploaded** to get recognized. Upload with an email that has no profile
  (no artist name/city on file) is stopped and sent to `/profile` with the
  rule stated on-page: *"No profile, no recognition — you need a profile
  page and at least one song uploaded to get recognized."*
- **Two live songs max** — `songs.status` is `'live'` or `'removed'`;
  judging and chart computation only ever consider `live` songs. A third
  live upload is rejected with: *"You can only have two songs live at a
  time — those are the only songs that get judged. Remove one to put
  another up."* Removing a song from the Dashboard frees the slot.
- **Cover required — and judged** — no cover, no upload. The cover is
  criterion #15 (below).
- **Radio-quality audio gate** — uploads are probed with ffprobe:
  lossless WAV/FLAC passes at any bitrate; MP3 must be **320 kbps**
  (≥ 310 kbps accepted, to allow for VBR reporting); anything else is
  rejected with *"That file isn't radio quality. Top 20 only takes WAV
  or 320 kbps MP3 — the same quality radio stations accept."* Seeded
  demo audio is generated at 320 kbps so it passes its own gate.
- **Opens straight from Facebook/TikTok** — every page is fully
  server-rendered (no login, no JavaScript needed to read the content)
  and carries Open Graph + Twitter card meta tags; song pages point
  `og:image` at the cover, artist pages at the photo/avatar. A link
  pasted into Facebook or TikTok opens complete and readable.
- **DJ of the Month is recognition only** — the monthly city DJ vote
  (below) crowns and spotlights DJs who support independent artists.
  DJ votes live in their own tables (`dj_submissions` / `dj_votes`) and
  are never read by the judging or chart code — there is no path from a
  DJ vote to a song's score or rank.

## How the spec maps to this build

- **Judging (spec 3.3)** — `judge.js` + `config.js`. The same 15 criteria
  for every genre, each 1–10, total /150 → Craft Score 0–100. Every score
  comes with a written critique note (a "strong" note at 7+, a "fix-it"
  note below). Criterion 15, **Cover Art & Presentation**, is scored from
  the uploaded image itself: in v1, ffprobe reads the cover's resolution
  (≥1000×1000 scores near the top; small images score low), file size is
  a weak secondary signal, and a deterministic hash component adds
  variance within the band. It does **not** need a photo on it — polish
  and finish are what's judged; thrown-together artwork drags the song
  down, exactly like the other 14 points drag or lift.
- **Charts (spec 3.4)** — `charts.js`. `Chart Score = 0.6 × Craft + 0.4 × Engagement`;
  `Engagement = 0.75 × in-app (plays/likes/shares/saves, weighted and
  normalized against the chart's own max) + 0.25 × artist buzz` — so social
  buzz can be at most ~10% of a chart score. Charts exist for each genre
  **and** for **Overall** (all genres ranked together) at local
  ("City, ST"), regional (state→region map, default South) and national
  ("ALL") levels. The **full ranking** of every song is stored in
  `chart_entries` for every chart, every day — ranks below 20 are real and
  displayed with their distance to the Top 20 cut line.
- **The Stage (spec 3.5)** — the homepage. Rotation = the current National
  Top 20 of the selected channel, **played in chart order, #1 through #20,
  then looping**; the Main Stage plays the National **Overall** Top 20.
  When charts recalc (at midnight in production), rotation follows
  automatically.
- **Notifications (spec 3.9)** — after each recalc, every song that is
  **newly** in a Top 20 (vs the previous chart date) creates exactly one
  `chart_entry` notification — the chart-entry email, shown in the Outbox
  and on the upload result page. **There is no fall-off notification type
  in the schema at all** (the `notifications.type` column is constrained to
  `'chart_entry'`): dropping out is silent by design, and the Dashboard is
  where artists come to check.
- **Profiles (Phase 2)** — `users` carries `photo_path, bio, age, history,
  years_in_game, genre`. Age is shown publicly **only when set** (blank =
  private). No uploaded photo → a styled initial avatar. The seed gives
  all 36 demo artists plausible profiles with deliberately varied
  completeness (some age-private, some without history, some initial
  avatars instead of photos).
- **Profile video (one per artist)** — every artist gets exactly **one**
  video on their profile page, attached to one of their own live songs:
  either the song's **music video** or a **video bio** — the artist
  telling that song's story. It shows on the artist's profile and on the
  attached song's page. Uploading a new video **replaces** the old one
  (old file and row are deleted in the handler, so the one-video rule
  can't drift). MP4 / WebM / MOV, capped at 200 MB, managed from the
  Profile edit view and the Dashboard. In the owner's pricing model the
  video upload is the **paid add-on at launch** (Stripe), but **the demo
  does not charge** — payment is production scope. The seed gives Amara
  Cole a generated ~10s video_bio card for "Velvet Hours" (title card +
  her demo song's audio).
- **DJ of the Month (owner feature)** — DJs who support independent
  artists get their flowers too. **Anybody can submit a DJ** (the DJ, an
  artist, or a fan) at `/djs/submit`; the DJ lands on the current
  month's board for their city (`/djs/city/:city`). Visitors vote with a
  **Vote** button — one vote per person per DJ per month, where a
  "person" is a long-lived random `t20_voter` cookie (issued on first
  vote) backed by a `UNIQUE(dj_id, voter_key, month)` constraint; a
  repeat vote is turned back with a plain message. The leader of each
  city wears a **👑 LEADING** marker while the race runs; when a month
  closes, its top DJ is that city's **DJ of the Month** — spotlighted on
  `/djs`, shown under the city board, and kept in the **Past winners**
  archive. The home page carries a slim **CITY DJs** strip under Top
  Risers naming the current Dallas leader. **Recognition only** — DJ
  votes never touch song scores or charts. The seed runs this month's
  races for Dallas (3 DJs), Houston (2) and Atlanta (2) with seeded vote
  rows, plus last month's finished Dallas race (a clear winner) for the
  archive — all invented demo DJs.
- **Craft can't be bought (section 9)** — there is no code path that edits
  a score or rank by hand; ranks come only from the formula.

## What is simulated in v1

- **Email** — chart-entry "emails" are rows in the `notifications` table,
  rendered on `/admin/outbox` (and on the upload result page). No real mail
  is sent.
- **Judging** — heuristic: ffprobe duration + a SHA-256 hash of the audio
  file deterministically produce 14 of the scores (~4–10 per category) and
  the template critique notes; the 15th (cover art) comes from the cover
  image heuristics described above. Same files → same scores. A production
  engine would do real audio analysis + an AI rubric call; the interfaces
  (`judgeAudioFile`) are shaped for that swap.
- **Social buzz** — a seeded per-artist `buzz_score` (0–100) instead of live
  Facebook/Instagram/TikTok measurement. (The How It Works page describes
  the product design — the 24/7 search; in v1 the buzz input is this
  seeded score.) Profile-created artists get a deterministic buzz from
  their email hash.
- **Seed media** — covers are PIL-generated gradients (title + artist),
  avatars are PIL initial medallions; audio is ~15s ffmpeg sine-melody
  loops at 320 kbps, a different root note per song.
- **Seed catalog** — 36 invented demo songs/artists (6 per genre) across
  Dallas TX, Mesquite TX, Houston, Atlanta, Memphis, Nashville, Chicago,
  Los Angeles, New York and more — **all demo content, uploaded to this
  system like any other song**; nothing external is judged or charted.
- **"Yesterday"** — the seed writes a slightly jittered chart snapshot for
  yesterday so movement arrows and first-day chart-entry emails are real.
- Not in v1 (per spec phasing): accounts/passwords or social login, video
  payments (the profile-video upload itself ships in v1 — see above),
  share cards, search, listener library, admin UI
  for config. Formula weights and the rubric live in `config.js`.

## Look

Mobile-first (single ~430px column, big touch targets, sticky bottom
player). Black gloss + white/pearl base with **thin (1–2px) chrome trim**,
royal blue primary accent (`--accent` in `server.js`, owner-swappable),
green ▲ / red ▼ movement markers, and fiery orange/red reserved for the
blaze and New Entries. The wordmark is futuristic and stamped: the whole
**TOP 20** leans right in heavy condensed italic — blue gradient for TOP,
platinum for the 20 — pressed into the surface with layered shadows, and
the fiery blaze runs its full width underneath. It's a CSS approximation
of the final logo (true slash-cut letterforms need artwork) — **final
logo art can replace the CSS wordmark later** without touching the pages.

## Files

```
server.js          pages, upload handling, API endpoints, theme CSS
config.js          genres, the 15 criteria, formula weights, state→region map
db.js              SQLite schema (auto-created): users (+ profile fields),
                   songs (status live/removed), judge_scores, engagements,
                   chart_entries, notifications, videos (one profile video
                   per artist, attached to a song), dj_submissions +
                   dj_votes (the monthly city DJ of the Month vote)
judge.js           judging v1 (audio scores + critique notes + cover-art scoring)
charts.js          ranking computation, recalc, chart-entry notifications
seed.js            demo catalog + profiles + asset generation + yesterday snapshot
tools/gen_covers.py   PIL cover generator used by the seed
tools/gen_avatars.py  PIL avatar generator used by the seed
public/            covers/, audio/, avatars/ (seeded media), uploads/ (user media)
data/top20.db      SQLite database (created by seed/server)
```
