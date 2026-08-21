# ugc-researcher

Standalone research pool, extracted from `trace-ugc-tracker` 2026-07-23. Study
outside creators: Scrape Creators profile scrapes → view-lift math → format buckets →
local transcription. See **Hosting** below for what runs where — the Next.js
app and the two Discord workers are deployed; transcription stays local.

## Database — shared with trace-ugc-tracker (important)

This app points at the **same Supabase project** as
`~/Developer/trace-ugc-tracker`. The research tables (`research_creators`,
`research_videos`, `research_video_segments`) and their data live there, and
RLS depends on the tracker's `profiles` table + `is_staff()` / `is_admin()`
helpers. Sign-in uses the same staff accounts.

Schema changes are self-serve — never ask Joey to paste SQL into the dashboard:

- Preferred: the Supabase MCP tools (`apply_migration`, `execute_sql`) when the
  server is connected.
- Always available: `node scripts/apply-migration.mjs supabase/migrations/<file>.sql`
  — applies via the Supabase Management API using `SUPABASE_ACCESS_TOKEN` from
  `.env.local` and records the version in
  `supabase_migrations.schema_migrations`.

Rules for new migrations in this repo:

- Name them `YYYYMMDDHHMMSS_description.sql` (timestamp version). The tracker
  owns the short sequence (0001–0044+) in the shared
  `schema_migrations` table; short numbers here would collide with its next
  migration. The apply script enforces this.
- `0001_research.sql` is a reference mirror of the tracker's already-applied
  `0027_research.sql`. Never apply it; only needed if a dedicated database is
  ever created (which would also need `profiles` + the staff helper functions
  first).
- Keep every applied migration committed in `supabase/migrations/` so the
  schema history stays reconstructible.

## Layout

- `src/app/(app)/research/` — creator list + detail pages (server components,
  server actions in `actions.ts`).
- `src/lib/research.ts` — lift math + format detection (pure, unit-tested).
- `src/lib/jobs/research.ts` — profile scrape → upsert → thumbnail capture.
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
  e.g. `✝️jas` — `TRACK_EMOJI_NICHES` is the emoji→niche source of truth;
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

The cron is a no-op while `research_settings.auto_scrape_enabled` is false —
flip it in /settings to arm it. `scrapeAll` also self-skips when a run is not
due, and resumes an in-flight queue on the next tick, so hourly polling is
safe against a 12-hour schedule.

## Env

`.env.local` (gitignored) carries the same Supabase keys as the
tracker's `.env.local`, plus `SUPABASE_ACCESS_TOKEN` for migrations. If a key
is rotated, re-copy it from `~/Developer/trace-ugc-tracker/.env.local`.
Scraping: `SCRAPECREATORS_API_KEY` (this repo only — the tracker doesn't use it).
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
