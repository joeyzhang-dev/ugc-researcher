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

**Discord snowflakes must be read as text.** `discord_user_id` and
`channel_id` are bigints, and `JSON.parse` turns them into IEEE doubles —
`1335356398049038400` comes back as `…038300`. Live consequence
(2026-08-31): `scripts/merge-creators.mjs` read rows with `select=*`, wrote a
corrupted `discord_user_id`, and its channel PATCH matched zero rows while
still returning success, so it reported moving a channel it never moved. Any
query whose snowflake is written back or used as a filter must cast
`::text`.

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
  still parse) — the niche vocabulary is `research_niches`, managed from
  /settings and read through `worker/niches.py` (60s cache; falls back to the
  last good list, then to a hardcoded seed — never empty, because an empty
  vocabulary silently stops channel discovery rather than failing);
  categories are coach teams),
  `enrich` (creator discord ids, coach/launchpoint roles, re-attribution),
  `sync` (launchpoint `## Script N/M` messages → `research_scripts` +
  assignments, dedupe marker `[lp:<md5(body)[:10]>]`). The loop runs sync
  after every pull and discover every 15 min. (AI channel summaries were
  removed 2026-08-20 — the `research_discord_summaries` table still exists but
  nothing reads or writes it.)
- `worker/discord_bot/folk_links.py` — [CREATOR-PROVISION] mints the creator's
  folk tracking link during `/onboard`, via folk-web's create-only endpoint
  `POST /api/admin/creators/provision`. Needs **`FOLK_ADMIN_TOKEN`** (and
  optionally `FOLK_API_URL`, default `https://www.folk.com`) as Fly secrets on
  `bludgc-workers`; without the token it self-skips and onboarding reports a
  warning rather than failing. `/onboard` is the only hook early enough to
  matter: Launchpoint does not list a creator until after their first post
  (all 119 tracked accounts have >=1), and the link has to go IN that post.
  The endpoint is idempotent on the Discord snowflake, which is why the id is
  sent as a **string** - a JSON number is an IEEE double and silently corrupts
  the low digits, and a corrupted id deduplicates against nothing, so every
  re-onboard would mint a second link for the same person.
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

**Since 2026-09-04 an assignment can also be the OUTPUT of matching rather than
its input.** Scripts published to a channel under the `scripts / formats`
category (`research_script_posts`) are assigned to nobody. `buildVirtualAssignments`
synthesises (script, creator) candidates from niche scope — a script's niche
matching the creator's, or a **null niche, which makes it universal and is the
only thing that makes `#broad` work**. Confirming such a match INSERTs the
assignment row. Creators already holding a real assignment for that script are
skipped, so nothing is scored twice.

The candidate set is much wider than a creator's open assignments, so expect
/scripts/review to carry more. That is the designed failure mode —
`MATCH_AUTO_MIN` and `MATCH_AUTO_MARGIN` still gate on the words alone. Do not
lower the margin to drain the queue.

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
- **Six phases, deliberately separate.** `creators`, `socials`, `accounts` and
  `posts` are ~8 calls total (the first three share one accounts fetch) and
  finish in one tick. `insights` and `history` are **one call per
  post** — ~1,500 Instagram posts is close to half an hour against a 300s
  Vercel ceiling, so both walk `research_videos.launchpoint_synced_at`
  oldest-first and stop at a time budget. **That column is the resume cursor**;
  there is no queue table and a tick that dies mid-pass simply continues.
  `RESYNC_AFTER_MS` (6h) is the floor that stops the cursor rotating forever.
- **`accounts` persists the per-handle activity picture** into
  `research_launchpoint_accounts` (last post date, totals, engagement rate,
  earnings, cpm — one row per platform+handle, upserted). `last_post_at` is
  what makes "who's posting, who isn't" honest: ingested videos are Instagram
  only, so a creator active on TikTok would otherwise read as quiet. /overview
  and /creators join it to the *person* via `contractor_id` ↔
  `launchpoint_creator_id`, NOT via the per-handle `research_creator_id` link —
  a TikTok account resolves to no creator row by design. The phase is
  **non-fatal in the orchestrator** (caught, reported as `{failed}`): on a
  Vercel deploy the code arrives before anyone applies the migration, and a
  missing relation must not take down the phases behind it.
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
  **Two signals feed this**, and the second exists because the first missed a
  real case: a contractor id already bound to one of our creators, *and* a
  Launchpoint contractor whose real name matches an existing creator's
  `display_name` under a different handle. Name-matching caught Noah-andre
  Terry, whose old row carried no contractor id.

  **That case was NOT a rename, and the distinction matters.** Checked live
  2026-08-31: `@dresdistrict` (60,526 followers, IG account 48836876604) and
  `@morrismotivatesyou` (42 followers, account 14122842500) are two separate
  live Instagram accounts belonging to one person, with zero shared shortcodes
  and overlapping posting dates. Launchpoint pays for the small one; the big
  one is his personal account we had been scraping. A "rename" merge would
  have fused two real feeds and invented an average that never existed.
  Resolved by moving his Discord link, coaching channel, 37 script assignments
  and app membership onto `@morrismotivatesyou` and archiving `@dresdistrict`
  with its 64 posts intact — `scripts/merge-creators.mjs --keep-videos` exists
  for exactly this shape. **Before merging a reported pair, check whether the
  two handles are the same account**: same-account renames share reel
  shortcodes, two accounts share none.

  `@vicklockedin` vs `@lockinwithvick` is still unresolved and may be either
  shape — check the shortcodes before assuming.
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

## Performance + coach digests

`/performance` and the weekly Discord digest to coaches read one function,
`loadPerformanceReport` (`src/lib/jobs/performance.ts`) over the pure math in
`src/lib/performance.ts` — the page and the ping cannot disagree on a number.

- **The number is the true CPM**: dollars Launchpoint actually paid ÷ views of
  the posts it paid for (Joey's dashboard figure,
  `/analytics/videos?creator=<id>&paid=true` — the param is `creator`;
  `creatorId` is silently ignored there). Launchpoint's per-account `cpm`
  divides by every post's views, paid or not, and is never read.
- **Payscale** (`/pay-structures`): $40 flat once a post clears 1k views +
  $1 per 1k, settled on day-14 views; payouts land ~3 weeks after posting.
  Projected CPM from that formula fills the gap and is always labelled.
- **The true 30d window ends at the creator's newest payout**, not at now — a
  calendar window held one week of paid posts and swung Liam $1.49 → $12.33
  when a spike aged out. < 3 paid posts is a low sample: shown, not coloured,
  and the bad-streak defers to the month.
- **The trend is settled month vs the settled month before it**
  (`CpmRead.priorCpm`: the same 30 days ending where the settled window
  starts), never "the same read a week ago". Payouts lag posting by ~3
  weeks, so the newest paid post is always older than the reporting week
  and a read as of last Monday sees exactly the same paid posts as one as
  of this Monday — compared that way the true number could never move on
  the latest week, and the first coach dashboard read "no new payouts" on
  every row (2026-09-02). Where no true delta exists yet, the row shows
  this week's posts against last week's on the projection, labelled.
- **Buckets are judged on views, not CPM** (good ≥ 40k, bad ≤ 1,667 — the $2
  and $25 CPM lines for posts over 1k views). Sub-1k posts get no flat fee
  and read as a "good" $1 CPM; a 149-view creator must be bad, not best.
  **Two ratings since 2026-09-02:** `bucket` on the *mean* (the money view —
  it is what the CPM itself is made of) and `medianBucket` on the *median*
  of the same posts (the coaching view). Live reason: @stayfocusedevan's
  month had one 656k-view reel paid $66.81, so mean 52,928 → good while his
  typical post does 1,911 → decent. "Average" in the original rule was the
  author's word, not Joey's; he only set the 40k / 1.5k lines. The Discord
  digest still shows the mean one; adding the median there is pending.
- **Weeks are Monday→Monday UTC**, passed explicitly, so a re-run reproduces
  the same digest. Quota is 7 posts/week (the program's ceiling is 21).
- **A trial batch is dropped whole — no representative is kept.** It used to
  keep the highest-view upload, justified as "the one that won the trial and
  got published". Joey confirmed 2026-09-04 that the premise is false: a trial
  reel never graduates to a normal reel and never counts toward a paid
  deliverable, so nothing in a batch was ever published and the max of ~35
  draws is badly upward-biased. Measured against the Trial Reels Batcher's own
  `publish_jobs` ground truth: of 15 detected batches, **12 kept a post that
  was itself a trial**; a single 104,179-view trial was being carried as
  `@lockedin.lin`'s best post (average overstated 3.5x); three trials cleared
  the 40k spike line; and `bestPost` could name one in a Discord digest.
  `moneyRead` reads the same collapse for "awaiting payout", so the inflation
  reached the payout view too — which is why this is **one rule everywhere**,
  not a split between reach and pay. Expect the visible consequence: several
  creator-weeks that read as on-quota now read as missed, correctly — one week
  goes from 119 posts to 0. `trialUploads` is reported alongside precisely so a
  zero explains itself.
- **Trial-reel collapse only sees posts the loader fetched transcripts for**
  (`collapseTrialUploads`; a post without a transcript stands alone). Both
  loaders must therefore fetch `transcriptHorizon(week)` — 8 weeks, shared
  with `/stats`'s `TREND_WEEKS` — because `creatorPerformance` collapses
  30-day windows ending at this week *and* the previous one, plus one per
  bad-streak step. When the digest loader fetched the reporting week only
  (2026-08-31 → 09-02), `cpm30` was one-quarter collapsed, the previous
  week's read not at all, and every trial-running creator showed a projected-CPM
  "improvement" that was the mismatch. The onboarding week is fetched
  separately for creators who joined before the horizon. Measured: 8 weeks
  is ~1,600 rows / ~1.6MB against ~420 for one week.
- **Coach = the Discord category of the creator's coaching channel**
  (`Coach: Will's Team`, `Coach: Luke's Team`). `Not Creating 🚫` is skipped.
  TikTok is ignored throughout.
- **Digests post from the web app over REST** (`src/lib/discord.ts`, bot
  token, no gateway — cannot double-connect the token), into a
  `#📊weekly-report` channel the app creates inside each coach category,
  visible to the `Coach`, `Folk Team` and `dev` roles only. Creators are
  mentioned (`<@id>` renders blue anywhere) but never pinged: mentions sit in
  embeds and `allowed_mentions` is empty. `research_coach_digests` is the
  idempotency ledger — a week already keyed there is skipped, so a retry
  cannot double-post. Sent by the hourly cron on the Monday 09:00 UTC tick;
  `GET /api/jobs/coach-digest?week=&dry=1&to=<channel>` previews (`to` posts
  everything to one test channel without touching the ledger). Needs
  `DISCORD_BOT_TOKEN` + `DISCORD_GUILD_ID` on Vercel.
## Coach role

`profiles.role = 'coach'` (since 2026-09-02) is a fourth kind of account:
**not staff, not creator, one page.** A coach signs in like anyone else and
sees `/coach` and nothing else — the `(app)` layout redirects the role there,
and `/coach` has its own layout with no rail and no workspace switcher.

- **The team is the Discord category** of the creators' coaching channels
  (`Coach: Will's Team`), bound to the account in `research_coach_teams`.
  That is the same key the coach digest and /performance group by, so the
  dashboard and the Monday digest describe the same creators by
  construction. Bind coaches from /settings → Coaches (admin only): an
  unknown email is invited through Supabase auth, a creator-role account is
  promoted, a staff account is refused — demoting staff to one page should
  be a deliberate step, not a side effect of a form.
- **`is_staff()` is deliberately not widened.** Every research RLS policy
  reads through it, and a coach must not be able to select `research_*` from
  the browser. `/coach` reads with the **service role** and scopes to the
  coach's own category in code — the page renders exactly one `CoachGroup`.
  Staff may open `/coach?team=<category>` to see what a coach sees.
- **The team's number is `teamPerformance`** (`src/lib/performance.ts`),
  built from the same per-creator reads as the digest: a pooled true CPM
  (ratio of sums — a mean of member CPMs would count a 149-view creator's
  "$1.00" as much as a 400k-view one's), settled window ending at the
  *team's* newest payout, bucket on average views. Trial batches collapse
  **per creator, never across creators**: one script goes to several
  creators, and pooling before collapsing folds one creator's reel into
  another's (pinned by a test). `CoachGroup.team` carries it for every
  group, so /performance can show it too.
- Table rows are shared with /performance via
  `src/components/performance-rows.tsx`; `creatorHref` is what keeps a coach
  from being linked into `/research/<id>`, which they cannot open.

Not built yet (next steps agreed with Joey 2026-08-31): a per-coach CPM goal
with month-over-month attribution, and a mass ping to the team's channels.

## Roster lifecycle

`research_creators.archived_at` is the only thing that means "we stopped
working with this creator". Nothing else does, and the two columns that look
like they might are both something else: `status` is scrape health
(`pending`/`ready`/`failed`) — a creator who left a month ago still reads
`ready` because her last scrape worked — and `kind` is `roster` vs `research`.

Before it existed, every creator ever added stayed on /creators forever and
kept costing a scrape. Measured 2026-08-30: **28 of 59 roster creators had not
posted in over 30 days.**

- **Archiving hides and de-queues; it never deletes.** Videos, transcripts,
  script assignments and Launchpoint history all stay — the roster is a working
  list, and a departed creator's posts are still the corpus this pool studies.
  `creatorsInScope` filters `archived_at is null` in the query rather than at
  the call site, so every bulk enqueue path is covered at once.
- **/overview filters them too.** A retired creator is permanently "not
  posting", so leaving them in would let them dominate the stale-creator card
  by construction.
- **Dormancy informs, the flag decides.** `quietDays` (in
  `src/lib/roster-archive.ts`) derives days-since-last-post from Launchpoint's
  cross-platform recency and renders a `quiet Nd` chip past
  `QUIET_AFTER_DAYS` (30), escalating at `DORMANT_AFTER_DAYS` (60). It never
  hides anything on its own: a creator on a two-week break is not retired, and
  a row vanishing without anyone choosing it is the exact failure the
  "Unassigned" band was added to prevent (6547bae). Launchpoint's stamp can run
  hours ahead of our clock, so the count floors at 0.
- **Two things mean "we stopped working with this creator", and every send
  must honour both.** `archived_at` is written by the app; the
  `Not Creating 🚫` Discord category is written by `/offboard` moving the
  channel. Neither implied the other, and the recap sender gated only on the
  flag — so on 2026-09-01 six offboarded creators got a daily recap pinged at
  them in the channel they had been moved out of (ledgered, and again the day
  before; 12 parked creators were live targets in total). `isRetired` in
  `src/lib/roster-archive.ts` is now the single test, and `/offboard` writes
  BOTH: `store.offboard_creator_channel` PATCHes the channel category and then
  archives the linked creator with `archived_at=is.null` so a re-run cannot
  move the original date. The channel move is visible to a human, which is why
  the missing half went unnoticed for so long — it looked done.
  **A creator holding both a parked channel and a live team channel is not
  retired**: the team channel is the current one. `sendEligibility`
  (`src/lib/jobs/creator-digest.ts`, pure and unit-tested) and
  `loadPerformanceReport` read it the same way. The archive flag has no such
  escape hatch — it is a decision someone recorded, so it parks the creator
  whatever their channel still says.
- **Launchpoint cannot supply this.** Checked live against
  `GET /analytics/accounts`: all 117 tracked accounts report `programCount: 1`
  and `contractCount: 0`, dormant ones included. There is no upstream lifecycle
  signal to sync, which is why the flag has to be ours.

Not solved by this: the unmerged rename duplicates. `@dresdistrict` (dead
handle, no Launchpoint link, still scraped) holds the app membership while
`@morrismotivatesyou` — same person, posting — sits in the Unassigned band;
same for `@vicklockedin` vs `@lockinwithvick`. Archiving the dead row hides it
but does not move its videos or assignments. See the rename note under
**Launchpoint**.

## Niches

The niche track vocabulary is `research_niches`, managed from /settings and
read through `worker/niches.py` (see **Layout** above for the cache and
fallback chain).

- **The table is the track vocabulary, not a registry of every niche
  string.** 61 scripts carry `Finance General` / `Girly Finance`, neither of
  which has a row, and they render fine — the app derives its pill palette
  from observed values rather than requiring a match. A niche only needs a
  row once it should own an emoji, prefix channel names, and grant a Discord
  role.
- **Archiving leaves the /onboard picker but keeps classifying.** An
  archived niche drops out of `active_niches()`, so nobody can select it for
  a new creator, but `track_bases()` reads every row, archived included —
  otherwise the existing channels on that emoji would go unclassifiable the
  moment someone archived it.
- **Emoji uniqueness is on the variation-selector-stripped base, and there
  are THREE implementations of that rule.** `niche_emoji_base()` (the
  migration), `strip_emoji_base()` (`worker/niches.py`) and `emojiBase()`
  (`src/lib/niche-channel-rename.ts`) all drop U+FE0F and U+200D before
  comparing, so a cross with the U+FE0F variation selector and one without
  it collide as one track in the unique index, in
  `discord_pull_worker.py`'s `split_track_channel`, and in the channel-rename
  plan alike. Letting them diverge would make channel discovery
  non-deterministic with nothing reporting an error. The SQL one is the odd
  member: it does not trim whitespace, while the other two do — so
  `createNiche`/`updateNiche` run the emoji through `normalizeNicheEmoji()`
  (all whitespace removed, not merely trimmed) and a padded emoji can never
  be stored.
- **Pills render through `nicheLabel`** (`src/lib/niches.ts`) on /discord,
  /discord/[id], /scripts (table, gallery, Doc, filter row and the send /
  announce pickers) and the public creator portal. The emoji map is a plain
  record dealt by the server component, because half those pills live in
  client components that cannot call `loadNiches` themselves; the portal can,
  since it already renders with the service-role client. A niche with no row
  renders bare.
- **A rename cascades through `rename_niche()`.** PostgREST cannot span
  `research_scripts`, `research_app_creators`, `research_discord_channels`
  and `research_niches` in one transaction, so the function does — a rename
  applied to only some of those tables is exactly what stranded Finance
  General as an orphan nothing pointed back to.
- **Channel renames are previewed and confirmed, never automatic.** Discord
  rate-limits channel updates to 2 per 10 minutes per channel, and a rename
  is visible to every creator in the channel, so `planNicheChannelRenames`
  (`src/lib/niche-channel-rename.ts`) only produces the plan — /settings
  renders every old→new name and a human confirms it.
- **The rename controls are keyed on live Discord, never on the niche row.**
  `liveEmojiBases()` groups the guild's creator channels by their leading
  emoji and marks the niche claiming each one, so an emoji that no niche
  claims gets its own row and a warning. That case is exactly what editing a
  niche's emoji creates, and it is otherwise silent: `track_bases()` stops
  mapping the old base, `split_track_channel` returns None, and `discover`
  (upsert-only) skips those channels without raising. A control keyed on the
  niche's *stored* emoji disappeared at precisely that moment, leaving no way
  back short of remembering the old emoji.

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
Admin sign-in: `ADMIN_LOGIN_EMAIL` + `ADMIN_PASSWORD` power the "Sign in as
admin" button on /login — one shared secret, no email typed. The password is
compared constant-time, then the server mints a **real** Supabase session for
`ADMIN_LOGIN_EMAIL` by generating a single-use link and redeeming it, so RLS,
`is_staff()` and the MFA gate all behave exactly as for a normal sign-in.
`ADMIN_PASSWORD` must be >= 24 chars or the button refuses to render: a shared
secret has no account to lock out and a server action has no natural rate limit
on serverless, so length is the only guard that holds. The trade is no
per-person attribution — every use is recorded as `ADMIN_LOGIN_EMAIL`.
Discord: `DISCORD_BOT_TOKEN` (the mach ugc bot) + `DISCORD_GUILD_ID`; the
`ONBOARD_*` / `CREATOR_ROLE_*` overrides default to the live Folk ids in
`worker/discord_bot/config.py`.

## Verify

`npm run typecheck` · `npm test` ·
`python3 -m unittest discover worker/tests` ·
`python3 -m py_compile worker/transcribe_worker.py worker/discord_pull_worker.py worker/niches.py` ·
`worker/.venv/bin/python -m py_compile worker/discord_bot/*.py worker/run_discord_bot.py`

The worker suite is hermetic and must stay that way — `worker/tests/nichefixture.py`
installs the niche vocabulary process-wide and replaces `niches._default_fetch`
with a guard, because a test that reaches the real reader hits production and
still passes (the seed answers the same three tracks). Check it by pointing
`NEXT_PUBLIC_SUPABASE_URL` at an unroutable address: the run must stay under a
second.

Hosted image: `docker build -f worker/Dockerfile -t bludgc-workers:test .` then
`docker run --rm -e NEXT_PUBLIC_SUPABASE_URL=x -e SUPABASE_SERVICE_ROLE_KEY=x
-e DISCORD_BOT_TOKEN=x -e DISCORD_GUILD_ID=1 bludgc-workers:test python -c
"import sys; sys.path.insert(0,'worker'); import discord_pull_worker, discord_bot.client"`.
Deployed: `fly logs -a bludgc-workers` — the bot logs its tracked-channel count
at startup, the pull loop logs a completed cycle within 60s.
