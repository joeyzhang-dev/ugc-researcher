# Trace Research

Standalone research pool, extracted from `trace-ugc-tracker` on 2026-07-23 so it
can evolve as a dedicated project. Study outside creators (not campaign
creators): scrape their reels via Apify, compute view lift, bucket formats, and
transcribe the winners locally.

## What's here

- `/research` — creator list + add form; `/research/[id]` — per-creator videos,
  lift analysis, format buckets, transcripts (staff login required, same
  Supabase auth + profiles as the tracker).
- `/overview` — cross-creator leaderboard of the highest lifts, switchable
  between the research pool and our roster.
- `/settings` — scrape schedule, per-scrape reel count, and manual "Scrape all".
- `POST /api/jobs/research` — CRON_SECRET-authorized scrape / categorize
  endpoint. `{"action":"scrape-all"}` runs the scheduled pass and is the hook to
  point a cron or launchd job at (see Automatic scraping below).
- `src/lib/research.ts` — lift math (trailing-10 median baseline, overall,
  ±45-day window) and caption/transcript format detection.
- `src/lib/jobs/research.ts` — Apify profile scrape → upsert → thumbnail capture.
- `worker/transcribe_worker.py` — local transcription worker: polls
  `research_videos.pending` every 60s, downloads media (yt-dlp / Apify / stored
  CDN URL, DASH muxing via ffmpeg), transcribes with WhisperX or OpenAI
  Whisper, uploads a playable mp4 to the `videos` storage bucket.

## Database

Points at the **same Supabase project as trace-ugc-tracker** — that's where the
`research_creators`, `research_videos`, and `research_video_segments` tables
and all scraped data already live. `supabase/migrations/0001_research.sql` is a
copy of the tracker's migration 0027 for reference / a future dedicated
database. Note the RLS policies depend on `public.is_staff()` /
`public.is_admin()` and the `profiles` table from the tracker's earlier
migrations, so a standalone database needs those first.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in Supabase + Apify + CRON_SECRET
npm run dev
```

Worker (transcription runs on your machine, media stays local):

```bash
pip install -r worker/requirements.txt   # yt-dlp
pip install whisperx                     # + ffmpeg, recommended
python3 worker/transcribe_worker.py --once
```

Maintenance:

```bash
npm run backfill:media                        # CDN thumbnails -> Supabase Storage
node scripts/backfill-media.mjs --videos      # ...and the mp4 files too
npm run rechunk:segments                      # re-split stored transcripts into script lines
```

Apify hands back signed CDN URLs that expire within days and are hotlink-blocked
in the browser, so scraped media has to be copied into the `thumbnails` /
`videos` storage buckets to keep rendering. `backfill:media` catches anything the
scrape missed; video URLs expire fastest, and rows that 403 recover on the next
scrape or when the worker re-downloads them with yt-dlp.

## Scraping

"Scrape all" on `/research`, `/creators` and `/settings` queues every creator in
scope and works through them one at a time — a pull takes about a minute per
creator, far longer than a single request can live, so the browser tab drives
the loop and has to stay open. On the roster the button honours the workspace
you're in; the research pool is always global.

### Automatic scraping

`/settings` stores the schedule (every N hours, or a time of day), how many
reels each scrape pulls, and the pause between creators. Nothing fires it on its
own, because this app only runs on your machine. To automate it, point a cron or
launchd job at the endpoint — it no-ops unless the schedule says a run is due,
so polling often is safe:

```bash
curl -sX POST http://localhost:3000/api/jobs/research \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"action":"scrape-all"}'
```

Each call drains for up to 4 minutes and returns `remaining`; repeat until it
reports `0` to finish a long queue. Add `"force": true` to ignore the schedule.

Tests / typecheck: `npm test`, `npm run typecheck`.

See `docs/research-plan.md` for the original design doc.
