# Trace Research

Standalone research pool, extracted from `trace-ugc-tracker` on 2026-07-23 so it
can evolve as a dedicated project. Study outside creators (not campaign
creators): scrape their reels via Apify, compute view lift, bucket formats, and
transcribe the winners locally.

## What's here

- `/research` — creator list + add form; `/research/[id]` — per-creator videos,
  lift analysis, format buckets, transcripts (staff login required, same
  Supabase auth + profiles as the tracker).
- `POST /api/jobs/research` — CRON_SECRET-authorized scrape / categorize
  endpoint (no cron is configured; scrapes are manual or API-triggered).
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

Tests / typecheck: `npm test`, `npm run typecheck`.

See `docs/research-plan.md` for the original design doc.
