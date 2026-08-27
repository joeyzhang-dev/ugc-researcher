# ugc-researcher

Standalone research pool, extracted from `trace-ugc-tracker` 2026-07-23. Study
outside creators: Scrape Creators profile scrapes → view-lift math → format buckets →
local transcription. See **Hosting** below for what runs where — the Next.js
app and the two Discord workers are deployed; transcription stays local.

## Database — standalone since 2026-08-26 (was shared with trace-ugc-tracker)

This app now has its **own Supabase project**: `yvbvcblqjlfhhvatijng`
(`bludgc-research`, us-east-1), under the `joey@nozomio.com` org.

It used to share `~/Developer/trace-ugc-tracker`'s project
(`zaoqousjswryyvxdnfha`). That ended when dashboard access to the shared
project was lost — no account reachable from here could run DDL on it, and a
blocked migration meant the app and its schema could no longer move together.
The research tables were forked into the new project on 2026-08-26.

What the fork means in practice:

- **The two databases diverge from 2026-08-26.** The tracker keeps its copy of
  `research_creators` / `research_videos` / `research_video_segments` and will
  not see anything written here. Nothing syncs them back.
- **`00000000000000_standalone_bootstrap.sql`** supplies what the tracker used
  to: `profiles`, `handle_new_user`, `is_staff()`, `is_admin()`,
  `set_updated_at()`. Those four are the *only* things the research schema
  ever borrowed — verified against every `references public.*` in this repo —
  so none of the tracker's own tables were recreated.
- **`0001_research.sql` is now applied, not reference-only.** Applying it to a
  dedicated database is exactly what it was kept for. It still must never be
  applied to the shared project.
- **Existing media still lives on the OLD project.** `thumbnails` and `videos`
  are public buckets there, so every stored `thumbnail_url` / `video_url` keeps
  resolving from `zaoqousjswryyvxdnfha` — 11.1GB that would not have fit in the
  new project's 1GB Free-tier storage. If the old project is ever paused or
  deleted, existing media 404s; `HoverVideo` guards on `src &&` so rows degrade
  to their thumbnail, and a re-scrape re-uploads into the new project.
  **Empty `thumbnails` and `videos` buckets were created on the new project**
  (both public, matching the old config) because a fork copies tables and not
  storage — without them the first scrape or inspo-media upload fails on a
  missing bucket rather than merely lacking a file. Those two are the only
  buckets this repo touches; `receipts`, `creator-contracts` and
  `warmup-proofs` are the tracker's and were deliberately left behind.
- **All 18 auth users were recreated with their original UUIDs**, and their
  profile roles restored (4 admin, 1 viewer, 13 creator). **Password hashes
  could not come across** — they live in `auth.users`, which is not reachable
  through PostgREST or the admin API. Everyone signs in via password reset the
  first time.
- **Production was cut over on 2026-08-26.** `.env.local`, the Vercel project
  `bludgc`, and both Fly apps (`bludgc-workers`, `bludgc-transcribe`) all point
  at the standalone project. Vercel also gained `LAUNCHPOINT_API_KEY`, without
  which the hourly cron's Launchpoint phase self-skips silently.
  **Vercel env vars only take effect on a new build** — `NEXT_PUBLIC_*` are
  baked in at build time — so changing them requires
  `vercel redeploy <deployment-url> --target production`, which rebuilds the
  existing deployment rather than shipping whatever branch is checked out.
  If this ever has to be redone, flip all three targets together and do the
  **workers first**: the writers moving first means new Discord messages land
  in the new database, whereas moving the web app first would write them to the
  old one and lose them.
- Pre-fork values are preserved in `.env.shared-project.bak` (gitignored), so
  rolling back is a copy-paste.

Schema changes are self-serve — never ask Joey to paste SQL into the dashboard:

- Preferred: the Supabase MCP tools (`apply_migration`, `execute_sql`) when the
  server is connected.
- Always available: `node scripts/apply-migration.mjs supabase/migrations/<file>.sql`
  — applies via the Supabase Management API using `SUPABASE_ACCESS_TOKEN` from
  `.env.local` and records the version in
  `supabase_migrations.schema_migrations`.

Rules for new migrations in this repo:

- Name them `YYYYMMDDHHMMSS_description.sql` (timestamp version). The apply
  script enforces this. The rule outlived the shared database it was written
  for — the tracker owned the short sequence (0001–0044+) and a short number
  here would have collided with its next migration — but keep it: the two
  histories still share filenames on disk, and `0001_research.sql` /
  `00000000000000_standalone_bootstrap.sql` are the only short-numbered files
  that legitimately exist here.
- `0001_research.sql` mirrors the tracker's `0027_research.sql`. It is applied
  on the standalone project (that is what it was kept for) and must never be
  applied to the shared one. A fresh project is bootstrapped by applying, in
  order: `00000000000000_standalone_bootstrap.sql`, `0001_research.sql`, then
  every `2026*.sql` in filename order.
- Keep every applied migration committed in `supabase/migrations/` so the
  schema history stays reconstructible.

## Layout

- `src/app/(app)/research/` — creator list + detail pages (server components,
  server actions in `actions.ts`).
- `src/lib/research.ts` — lift math + format detection (pure, unit-tested).
- `src/lib/scripts.ts` — per-script performance + transcript matching, incl.
  `resolveScriptMatches` (pure, unit-tested — see **Script matching** below).
- `src/lib/jobs/match-scripts.ts` — loads every script/assignment/video, resolves,
  writes the unambiguous links. `src/app/(app)/scripts/review/` is the queue for
  the rest.
- `src/lib/jobs/research.ts` — profile scrape → upsert → thumbnail capture.
- `src/lib/launchpoint.ts` + `src/lib/jobs/launchpoint.ts` — the Launchpoint
  Public API client and its four-phase sync (see **Launchpoint** below).
  `src/lib/retention.ts` holds the pure retention math (hold rate, skip rate,
  CPM, day-one share), `src/components/retention-view.tsx` its presentation.
- `src/app/api/jobs/research/route.ts` — CRON_SECRET- or admin-authorized
  scrape endpoint (no cron exists; scrapes are manual).
- `worker/transcribe_worker.py` — local transcription (yt-dlp / Scrape Creators / stored
  CDN URL → WhisperX or OpenAI Whisper); polls `research_videos.pending` every
  60s. Media stays in `worker/data/media/` (gitignored).
- `src/app/(app)/discord/` — the Folk UGC Discord CRM (consolidated from the
  retired standalone `discord-crm` project): per-channel cards with AI
  summaries, message feeds with Discord deep links, manual channel↔creator
  linking. Data lives in `research_discord_*` tables.
- `worker/discord_pull_worker.py` — stdlib-only 24/7 Discord ingester
  (REST pull every 60s → normalize → attribute roles → idempotent upsert),
  plus subcommands: `discover` (creator channels are `<track-emoji><name>`,
  e.g. `✝️jas-alcantara` (first-last verbatim from Launchpoint since
  2026-08-26; `✝️jas` and the `🤍anna🌸` disambiguator were the old form and
  still parse) — `TRACK_EMOJI_NICHES` is the emoji→niche source of truth;
  categories are coach teams),
  `enrich` (creator discord ids, coach/launchpoint roles, re-attribution),
  `sync` (launchpoint `## Script N/M` messages → `research_scripts` +
  assignments, dedupe marker `[lp:<md5(body)[:10]>]`). The loop runs sync
  after every pull and discover every 15 min. (AI channel summaries were
  removed 2026-08-20 — the `research_discord_summaries` table still exists but
  nothing reads or writes it.)
- `worker/discord_bot/` + `worker/run_discord_bot.py` — the "mach ugc"
  gateway bot (discord.py, lives in `worker/.venv`): slash commands
  `/onboard /offboard /link /creator /creators /health /help` + real-time
  ingestion sharing the pull worker's dedupe semantics. `/link` binds a
  creator's Instagram ↔ Discord profile ↔ coaching channel in one command.
  Run exactly ONE instance per bot token (the old discord-crm deployment
  must stay off).

## Hosting

Three deploy targets, deliberately different:

- **Next.js app → Vercel**, project `bludgc` (`https://bludgc.vercel.app`).
  Linked via `.vercel/project.json`. `.vercelignore` keeps `worker/` out.
  `portal.ts` and `discord_bot/config.py` both default to that origin for
  `/c/<share_token>` links — keep them in sync.
- **The two always-on Discord workers → Fly.io**, app `bludgc-workers`, one
  app with two process groups (`bot`, `pull`), one machine each — plus a
  stopped standby machine per group that Fly adds automatically and boots only
  on host hardware failure (the primary's gateway dies with its host, so this
  cannot double-connect the token). See
  `fly.toml` + `worker/Dockerfile`, design record in
  `docs/superpowers/specs/2026-08-20-worker-hosting-design.md`.
- **`worker/transcribe_worker.py` → Fly**, its own app `bludgc-transcribe`
  (`fly.transcribe.toml` + `worker/Dockerfile.transcribe`), one machine.
  Separate app from `bludgc-workers` on purpose: it needs ffmpeg, which makes
  an 822MB image against the bot image's 265MB (both uncompressed; Fly's
  reported figure is the smaller compressed one), and the bot deploys with
  `strategy = "immediate"` — sharing an image would put that pull on Discord
  downtime. Separate apps also mean a transcription crash-loop cannot restart
  the bot. Deploy it with `fly deploy -c fly.transcribe.toml`.
  - Hosted transcription goes through the **OpenAI Whisper API**
    (`OPENAI_API_KEY`), not WhisperX — `transcribe_whisperx` returns None on
    `ImportError` and the code falls through. No torch in the image.
  - **A video with no working transcriber is PATCHed to
    `transcript_status = "failed"`.** Never start this worker without
    `OPENAI_API_KEY` set, or it will walk the pending queue marking every row
    failed. Those rows then need a manual reset to `pending`.
  - The local GPU path still works on Joey's Mac via `worker/.venv-transcribe`
    and `worker/requirements.txt`; media caches under `worker/data/`, which
    `.dockerignore` keeps out of every image.
  - **Storage policy — `MEDIA_RETENTION_DAYS = 90`.** Instagram encodes reels
    at a very high bitrate, so `shrink_for_storage()` re-encodes at the SAME
    720p resolution before upload (measured 23–29% of the original; growth
    ~17GB/mo → ~5GB/mo). `prune_old_media()` runs daily and deletes stored
    mp4s for rows ingested more than 90 days ago — transcript, metadata,
    thumbnail and permalink all stay, and `HoverVideo` guards on `src &&` so a
    pruned row degrades to its thumbnail.
  - `prune_old_media()` and `backfill_research_media()` MUST share
    `MEDIA_RETENTION_DAYS`. Backfill re-fetches any transcribed row whose
    `video_url` is not a storage URL, so a mismatched cutoff would re-upload
    everything the prune just deleted, in a loop, forever.
  - Retention cutoffs are formatted `...Z`, never `isoformat()`'s `+00:00` — a
    literal `+` in a query string decodes as a space and Postgres rejects it
    with `22007`.

Rules that matter:

- **Never run the bot in two places.** One gateway connection per token, or
  slash commands get double-handled. Fly's deploy `strategy = "immediate"`
  exists for exactly this — do not switch it to `bluegreen`/`canary`, which
  boot a replacement machine *before* retiring the old one. Likewise, don't run
  `run_discord_bot.py` locally while Fly is up.
- **The hosted image installs `worker/requirements-hosted.txt`, not
  `requirements.txt`.** The latter pulls whisperx/torch (multi-GB) for local
  transcription only. The image is ~48MB as Fly reports it (265MB
  uncompressed); keep it that way — the bot deploys with
  `strategy = "immediate"`, so image size is Discord downtime.
- Fly secrets: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `SCRAPECREATORS_API_KEY`. Not
  `SUPABASE_ACCESS_TOKEN` (migrations), not `CRON_SECRET` (web app).
  The first four are a loud `KeyError` at startup. `SCRAPECREATORS_API_KEY`
  is the exception and the trap: `discord_bot/script_pager.py` reads it with
  `os.environ.get`, so a missing key degrades *silently* — inspo videos stop
  rendering inside script cards and fall back to a bare link. It was left out
  of the original Fly secret set for exactly that reason.
- The image has **no ffmpeg** (~100MB, deliberately omitted), so
  `script_pager._fit_video` can never transcode an oversize inspo video —
  those are dropped rather than shrunk. `yt-dlp` IS installed and resolved via
  PATH. Both fallbacks sit behind the Scrape Creators lookup.
- The retired `discord-creator-crm` project's launchd agents were unloaded
  2026-08-20 and parked in
  `~/Library/LaunchAgents/.disabled-discord-crm-2026-08-20/`. They were a live
  duplicate ingester. Don't reload them.

## Script matching

Every number on /scripts comes from `research_script_assignments.research_video_id`
— the link between a script and the post it produced. That link used to be set
only by hand, one assignment at a time, so 1,036 of 1,073 assignments were
unlinked and nearly every script read "0 posts" while the posts sat in the
database, scraped and transcribed. A 2026-08-22 backfill linked 350 of them.

`resolveScriptMatches` scores each open assignment's script against its
creator's transcripts (containment, via `transcriptMatchScore`) and settles all
pairs **globally, best-first** — never per assignment. That is load-bearing: a
partial unique index means one video can back only one assignment, so resolving
each assignment independently lets whichever runs first claim a video the next
one wanted more.

Since 2026-08-27 the score is also **date-aware**. `dateProximity` compares an
assignment's `sent_at` (falling back to `assigned_at`) against the video's
`posted_at`: full credit inside `MATCH_DATE_RADIUS_DAYS` (21), decaying to a
0.2 floor after, and **0 for a post that predates its own script** — a script
cannot have produced a video that already existed when it was written. `rank =
score * (1 - W + W * proximity)` with `MATCH_DATE_WEIGHT` 0.35.

Three rules keep this from becoming a new way to guess wrong:

- **Confidence is still judged on the words alone.** `MATCH_AUTO_MIN` gates on
  the raw text score, so good timing can never promote a weak textual match.
  Date only reorders candidates and widens margins between rivals the words
  could not separate — which is exactly the 0.97-vs-0.91 case the margin
  exists for.
- **A missing date is neutral (proximity 1), never a penalty.** Absent data is
  not evidence against a pair, and penalising it would silently punish every
  assignment made before send tracking existed.
- **`posted-before-send` goes to review, never to auto-link**, and has its own
  section on /scripts/review — a reason with no home on that page would make
  the resolver's decision vanish from the only queue that can settle it.

On the live queue this scored 173 pairs: 27 auto-link, 47 contested, 92
low-confidence, and **7 caught as posted-before-send** — pairings the old
matcher had no way to see were impossible. Timing moved the score on 62 of them.

A pair is linked automatically only when it is BOTH strong (`MATCH_AUTO_MIN`,
0.5) AND beats its nearest rival by `MATCH_AUTO_MARGIN` (0.12) **on rank**. The margin is
the whole safety story — the original design kept linking manual precisely
because two near-identical scripts would otherwise get silently swapped, and
that is real here: a live pair scored 0.97 and 0.91 for the same post. Anything
doubtful goes to /scripts/review instead of being guessed at. Don't lower the
margin without re-checking the contested count.

The review queue recomputes candidates from transcripts on every load rather
than storing them, which is why it needs no "reject" and no extra table: it
self-drains. Confirming one side of a contested pair claims that video, so the
rival's claim disappears on the next pass. Because of that the job converges
over a few runs rather than in one (350 links took 3 passes) — this is expected,
not drift; it goes quiet once stable.

Low-confidence leftovers are usually just creators who have not posted yet.
Leave them: when they post, the strong match links itself.

**Before tuning the scorer, check whether the transcript exists.** Measured
2026-08-27 against 415 confirmed links, plain containment ranked the true video
first 413 times with a median margin of 0.517 over the runner-up — it is not
the bottleneck. Of 879 open assignments, 683 had a best available score of 0.17
against a median of 0.86 for true pairs; that gap is a script that was never
posted, not a scoring failure, and no amount of IDF or n-grams will close it.
(Caveat worth keeping: most confirmed links were themselves made by
containment, so that 413 is partly self-fulfilling.)

What *was* the bottleneck: 42 untranscribed posts stood between 170 open
assignments and a match. `requeueMatchCandidates` runs at the top of
`matchScriptPosts` and flips exactly those rows back to `pending` — a video
belonging to the assignment's creator, unclaimed, untranscribed, and posted
within `MATCH_DATE_RADIUS_DAYS` of the send. It is the deliberate exception to
`TRANSCRIBE_WINDOW_DAYS`: an old reel's transcript answers nothing in general,
but if it is the likely output of an assignment still waiting, it is the only
thing that can close it. Transcripts arrive asynchronously, so the pass that
requeues is never the pass that matches — which is why this runs on a schedule
rather than once.

## Launchpoint

`launchpointhq.com` is where the Folk creator program actually runs — contracts,
payouts, and the review loop the `launchpoint` Discord bot narrates into each
coaching channel. As of 2026-08-26 we also read its **Public API** (private
preview; `LAUNCHPOINT_API_KEY`, header `x-api-key`, base
`https://dashboard.launchpointhq.com/api/v1`, **100 requests/minute**,
timestamps in epoch **milliseconds**, docs at `docs.launchpointhq.com/llms.txt`).

Why it matters: creators authorize their own Instagram accounts to Launchpoint,
so it holds **first-party** metrics no scrape can reach — `reach`, `saves`,
`totalWatchTimeMs`, `avgWatchTimeMs`, `skipRate` — plus daily metric curves and
what each post was paid. We already store the transcript of nearly every roster
post; transcript + watch time is the pairing this whole research pool exists to
study. Views say the algorithm pushed a reel, watch time says the script held
the person who saw it.

- **The join key is the Instagram shortcode.** Launchpoint stores clean
  `instagram.com/reel/<code>/` URLs and `research_videos.shortcode` already
  holds the same value, so no id-mapping table is needed and a post scraped
  long before Launchpoint was connected still lines up. `shortcodeFromUrl`
  fails closed: an unrecognized URL yields null and the post goes unmatched,
  because a wrong shortcode would attach one creator's retention numbers to
  another creator's post.
- **Four phases, deliberately separate.** `creators` and `posts` are ~8 calls
  total and finish in one tick. `insights` and `history` are **one call per
  post** — ~1,500 Instagram posts is close to half an hour against a 300s
  Vercel ceiling, so both walk `research_videos.launchpoint_synced_at`
  oldest-first and stop at a time budget. **That column is the resume cursor**;
  there is no queue table and a tick that dies mid-pass simply continues.
  `RESYNC_AFTER_MS` (6h) is the floor that stops the cursor rotating forever.
- **Each drain phase has its own cursor, and both are stamped on every
  outcome — empty included.** Insights use `launchpoint_synced_at`, curves use
  `launchpoint_history_synced_at`. Separate because the phases cost very
  different amounts and must run at different rates without resetting each
  other. Stamping only on success would leave a post Launchpoint has nothing
  for parked at the head of the queue forever.
- **A cursor, not a content check.** The history phase first decided a post was
  done if it had a metrics row *dated today*. That does not converge:
  Launchpoint's latest snapshot for a quiet post can be days old, so it never
  earns a today-dated row and is re-fetched on every pass, indefinitely. The
  live tell was `remaining` going **up** between passes (911 → 932). If a phase
  ever stops going quiet, suspect the freshness test before the queue.
- **Creator rows are created for Instagram only** (`CREATE_PLATFORMS`).
  Launchpoint tracks 51 TikTok accounts for the same people; since
  `research_creators` is keyed on (platform, handle), accepting them would add
  a second row per creator, push all 51 into the scrape queue, and fill the
  roster views with accounts that have no scripts or sends behind them. An
  existing TikTok row still gets its `launchpoint_creator_id` stamped — only
  creation is gated. A numeric "handle" (`27419857611005344`, from a
  Facebook-linked account) is rejected too. Both are reported in `notCreated`
  and shown in the /settings note, never dropped silently.
- **A rename is reported, never merged.** Launchpoint tracks `lockinwithvick`
  while the roster still says `vicklockedin`. A contractor id already bound to
  one of our creators under a different handle is genuine ambiguity, so
  `syncLaunchpointCreators` returns it in `possibleRenames` and does nothing —
  same call `resolveScriptMatches` makes on a too-close pair. Auto-merging
  would move one creator's posts onto another creator's row.
- **Ingested posts are queued for transcription only if posted within
  `TRANSCRIBE_WINDOW_DAYS` (30).** Recent ones land `transcript_status:
  'pending'` and the Fly worker picks them up on its next 60s poll; older ones
  land `'skipped'`. Transcription exists to match a post back to the script
  that produced it, and scripts are handed out and posted within days — a
  four-month-old reel has no open assignment waiting for it, so the transcript
  answers nothing while costing a media fetch and a Whisper call. Skipped posts
  keep everything that does not need audio: views, retention, curves, earnings.
  An undated post is treated as out of window; guessing "recent" would queue an
  unbounded tail. The backlog was reconciled to this rule on 2026-08-27
  (187 pending + 33 stale failures → `skipped`).
- **A `failed` transcript is usually a deleted post.** Checked live: the
  failures return a clean 404 from Scrape Creators ("Post not found") with
  credits to spare — the creator removed the reel and the media is simply gone.
  A sample of 20 in-window pending posts found 19 still live, so this is a tail
  phenomenon, not a pipeline fault. Do not chase it.
- **Insights are Instagram-only.** TikTok answers HTTP 200 with
  `status: "no_data", reason: "unsupported_platform"` — a successful empty
  answer, not a failure.
- **`posts.title` is a concept name but mostly noise** — 2,265 of 2,905 live
  posts are the catch-all `Open-ended`. It corroborates a script match on ~22%
  of posts and must never replace transcript matching.
- **Retention thresholds are measured, not invented.** `holdRateBand` /
  `skipRateBand` in `retention-view.tsx` are the quartiles of a 178-post sample
  of the live corpus (2026-08-26): hold rate p25 0.26 / median 0.32 / p90 0.49;
  skip rate p10 30 / median 42 / p75 49. Re-measure before changing them.
- **Hold rate is not clamped at 100%.** Instagram counts a replay as continued
  watch time, so a short loopable reel genuinely averages more than its own
  duration; clamping would erase the best signal there is. `duration_seconds`
  must be in any `research_videos` select that renders retention — hold rate
  divides by it — which is what `LAUNCHPOINT_VIDEO_COLUMNS` exists to
  guarantee. Splice it with a **template literal**, not `+`: supabase-js infers
  the row type from the select string as a literal, and concatenation widens it
  to `string` and silently degrades the query to `GenericStringError[]`.
- **Three things make the drain phases actually finish.** (1) Every table read
  in the job pages with `readAllRows` — PostgREST silently caps a select at
  `db-max-rows` (1,000), and an unpaged read of `research_videos` left every
  video past the first 1,000 invisible, so their posts looked new, were
  re-inserted, and collided on `research_videos_url_key`. (2) A 429 sleeps for
  the server's `x-ratelimit-reset`, not the generic backoff — a per-minute
  window does not care about a 1-second curve, and honouring it took the live
  failure rate from ~14% to ~0. (3) Posts are drained `DRAIN_CONCURRENCY` at a
  time: each costs two round trips, which serially ran at ~18 posts/minute
  against a key allowed 90, so the limit was latency, not the rate limit.
  Concurrency is safe because `pace()` is one rolling window shared per API
  key, not per caller.
- Only two write routes exist upstream (`POST /posts/export`,
  `POST /programs/{id}/invite`) and **neither is in the client** — an export
  creates a file and an invite creates a shareable link; a sync job should do
  neither on its own.
- `/creators` and `/contracts` both answer `total: 0` on this account (pay is
  `canvas_payscale` with `contractId: null`), which is why the creator identity
  map comes from `/analytics/accounts` instead.

**The pages tolerate a schema that has not caught up.** `videoSelect()` probes
once per minute per process for `launchpoint_post_id` and drops the Launchpoint
columns from the select when they are absent; `loadViewCurves()` answers `{}`
if `research_video_metrics_daily` does not exist. This is not defensive
padding — the integration was written against a database nobody could run DDL
on, and a select naming a missing column is a hard PostgREST 400 that takes
/research and /scripts down entirely. With the probe, an un-migrated database
just hides the retention chips, and the pages light up on their own within a
minute of the migration landing — no redeploy. The cost is that the select list
is built at runtime, so supabase-js cannot infer a row type from it and the
four call sites cast through `unknown`.

Run it from /settings (browser-driven 45s slices, same shape as "Scrape all"),
or `POST /api/jobs/research {"action":"launchpoint-sync"}`. Repeat until
`{ remaining: 0 }`.

## Scheduled work

`vercel.json` runs `/api/jobs/cron` hourly. Vercel Cron issues a **GET**,
which is why that route exists instead of pointing the cron at
`/api/jobs/research` (POST-only — a cron would 405 forever). Vercel attaches
`Authorization: Bearer $CRON_SECRET` automatically because `CRON_SECRET` is set
on the project. Both routes share `src/lib/jobs/scrape-all.ts`.

**The `/api/jobs` prefix is load-bearing.** `isPublicPath()` in
`src/lib/routing.ts` lets that prefix past the staff-session gate because those
routes authorize themselves. A cron route anywhere else gets 307'd to `/login`
by the middleware and never runs — the request carries a bearer token, not a
session cookie. `tests/routing.test.ts` pins this.

The hourly tick also runs `matchScriptPosts` and then `syncLaunchpoint`, but
only when the scrape queue is empty (`remaining === 0`) so a mid-drain tick
keeps its 300s budget. Launchpoint takes whatever is left of the tick and
reports `remaining` on the same contract as the scrape. It runs on
idle ticks on purpose: transcription is asynchronous on a separate Fly app, so
tying matching to the 12-hourly scrape would leave a new post unlinked for half
a day. `POST /api/jobs/research {"action":"match-scripts"}` runs it on demand.

The cron is a no-op while `research_settings.auto_scrape_enabled` is false —
flip it in /settings to arm it. `scrapeAll` also self-skips when a run is not
due, and resumes an in-flight queue on the next tick, so hourly polling is
safe against a 12-hour schedule.

## Env

`.env.local` (gitignored) carries the **standalone** project's Supabase keys
(`yvbvcblqjlfhhvatijng`) plus `SUPABASE_ACCESS_TOKEN` for migrations and
`SUPABASE_DB_PASSWORD`. These are no longer the tracker's keys — do not
re-copy from `~/Developer/trace-ugc-tracker/.env.local`, which still points at
the shared project. Pre-fork values are in `.env.shared-project.bak`.
Scraping: `SCRAPECREATORS_API_KEY` (this repo only — the tracker doesn't use it).
Launchpoint: `LAUNCHPOINT_API_KEY` (`lp_pk_…`, Dashboard → Settings → API).
Server-only, and needed on Vercel too or the hourly cron's Launchpoint phase
self-skips — silently, by design, so a missing key degrades rather than breaks.
Discord: `DISCORD_BOT_TOKEN` (the mach ugc bot) + `DISCORD_GUILD_ID`; the
`ONBOARD_*` / `CREATOR_ROLE_*` overrides default to the live Folk ids in
`worker/discord_bot/config.py`.

## Verify

`npm run typecheck` · `npm test` ·
`python3 -m py_compile worker/transcribe_worker.py worker/discord_pull_worker.py` ·
`worker/.venv/bin/python -m py_compile worker/discord_bot/*.py worker/run_discord_bot.py`

Hosted image: `docker build -f worker/Dockerfile -t bludgc-workers:test .` then
`docker run --rm -e NEXT_PUBLIC_SUPABASE_URL=x -e SUPABASE_SERVICE_ROLE_KEY=x
-e DISCORD_BOT_TOKEN=x -e DISCORD_GUILD_ID=1 bludgc-workers:test python -c
"import sys; sys.path.insert(0,'worker'); import discord_pull_worker, discord_bot.client"`.
Deployed: `fly logs -a bludgc-workers` — the bot logs its tracked-channel count
at startup, the pull loop logs a completed cycle within 60s.
