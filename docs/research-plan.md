# Research page — plan

_Created 2026-07-13. Status: living document — check boxes as phases land._

## Goal

A new **Research** section of the app for studying outside creators (not our
campaign creators). Given an Instagram account, scrape their recent reels and
figure out **which videos over- or under-perform relative to that creator's own
baseline** ("lift"), transcribe every video with WhisperX, and — phase 2 —
derive basic **format categories** for the creator from the transcripts,
tiering formats by lift (S-tier / "10 out of 10" formats first).

First subject: https://www.instagram.com/levelup.withliam/ (`levelup.withliam`).

## What happens to the old flow

The **Scripts → Sources** page (paste one reel link → local worker scrapes +
transcribes it) is **deprecated, not deleted**. It stays in the codebase and UI
as reference; a banner on the page points at Research. No functional changes.

## Architecture (reuses existing infrastructure)

| Piece | Reused from |
|---|---|
| Scrape Creators profile scrape (`fetchProfile`, `fetchProfileVideos`, `normalizeInstagramItem`) | `src/lib/scrapecreators.ts` |
| Lift concept (views vs creator's median) | `src/lib/script-performance.ts` |
| Local WhisperX worker (yt-dlp → WhisperX → Supabase) | `worker/transcribe_worker.py` |
| CRON_SECRET-guarded job route pattern | `src/app/api/jobs/*` |
| RLS pattern (staff read, admin write) | migration `0022_sources.sql` |

## Data model — migration `0027_research.sql`

- **`research_creators`** — one row per studied account: `handle` (unique per
  platform), `platform`, `display_name`, `profile_url`, `follower_count`,
  `avatar_url`, `status` (`pending | scraping | ready | failed`),
  `error_message`, `last_scraped_at`, `notes`.
- **`research_videos`** — one row per scraped reel: FK to creator, `url`
  (canonical, unique), `shortcode`, `external_id`, `caption`, `hashtags text[]`
  (parsed from caption), `posted_at`, `view_count`, `like_count`,
  `comment_count`, `share_count`, `duration_seconds`, `thumbnail_url`,
  `video_url` (signed CDN, expires — used promptly by the worker),
  `transcript_status` (`pending | fetching | transcribed | failed | skipped`),
  `transcript_text`, `transcript_method`, `error_message`,
  `format_category` (phase 2, nullable), `raw_metadata jsonb`.
- **`research_video_segments`** — timestamped transcript segments, same shape
  as `source_segments` so the worker logic carries over.

Lift is **computed, not stored** — it changes as more videos land.

## Lift math (`src/lib/research.ts`)

A video's lift = its views ÷ a baseline of the creator's *other* videos.
Raw account average misleads (accounts grow/decay over time), so we compute
three baselines and lead with the time-local one:

1. **Trailing lift (headline)** — baseline = median views of the up-to-10
   videos posted *before* this one (min 3 required, else fall back to overall).
   Captures "did this beat what the account was doing at the time".
2. **Overall lift** — baseline = median views of all other videos. Stable,
   comparable across the whole page.
3. **Recency-window lift** — baseline = median of other videos posted within
   ±45 days. Shown for context on old vs new posts.

Median, not mean — one viral outlier must not poison the baseline (same
reasoning as `script-performance.ts`).

**Score (0–10, one decimal)** from headline lift, log-scaled so each doubling
of lift is one +2 step: `score = clamp(5 + 2·log₂(lift), 0, 10)`. Performing at
the creator's baseline (1×) = **5.0**, 2× = 7.0, ≈2.8× = **8.0** ("top rated"),
≥5.7× = 10. Symmetric downward (0.5× = 3.0). Log scale because lift is a
ratio — 1× vs 2× matters far more than 10× vs 20×.
Engagement rate = (likes + comments + shares) / views, shown alongside.

## Format categories (automatic)

`detectFormatCategory(caption, transcript)` in `src/lib/research.ts` buckets
videos into basic formats from the **spoken opening line first** (captions often
hide the format: caption "Rebuild yourself" opens as "10 out of 10 ways to
rebuild yourself…"), caption as fallback. Current buckets: **10/10 list**,
**S-tier list** (incl. "top-tier" and WhisperX mishearings like "ask your"),
**Persona blueprint** (James Bond / Batman / Captain America), **What it looks
like**, **Numbered list**, **How-to method**; null when unsure. Runs at scrape
time (caption-only), via the Auto-categorize button on `/research/[id]`, and via
`POST /api/jobs/research {action:"categorize"}` after transcripts land. The
detail page rolls formats up by median score.

## Pages

- **`/research`** — list of researched creators (KPIs: videos, median views,
  followers, S-tier count) + "Add creator" form (paste profile URL or handle →
  server-side scrape).
- **`/research/[id]`** — creator detail: header stats, lift distribution, and
  the video table sorted by lift (tier chip, views, lift ×, engagement %,
  hashtags, posted date, link to the reel, transcript status, format
  category). Actions: re-scrape, retry failed transcripts.
- **`/api/jobs/research`** — CRON_SECRET-guarded POST `{handle}` that runs the
  scrape job server-side (also lets us trigger scrapes from the CLI without
  the UI).

Scrape depth: the newest 35 reels per creator (`DEFAULT_RESULTS_LIMIT`).
Count-based, not date-based — Instagram scrapes request `resultsType: "reels"`,
so there are no non-video posts to skip.

## Transcription (WhisperX, local worker)

Extend `worker/transcribe_worker.py` with a second queue: `research_videos`
where `transcript_status = 'pending'`, processed **highest view count first**
(so likely S-tier videos get transcripts soonest). Per video:

1. Try the stored signed `video_url` from the scrape (fresh, no rate limits).
2. Fall back to yt-dlp captions / download, then a Scrape Creators re-fetch (existing code).
3. Transcribe with WhisperX (large-v3, local), fall back to OpenAI Whisper.
4. Write `transcript_text` + segments, mark `transcribed`.

Run: `~/Developer/ugc-ops/.venv/bin/python worker/transcribe_worker.py --once`

## Phase 2 — format categories (after transcripts land)

For **this creator only**: read the S/A-tier transcripts, cluster into a small
set (≈4–8) of plain-language format categories (e.g. "listicle tips to camera",
"POV skit", "screen-record walkthrough"), write them to
`research_videos.format_category`, and rank categories by median lift. The
S-tier ("10/10") format writeup goes in the findings doc. Categorization runs
as a Claude pass over transcripts — no new infra needed; a later migration can
formalize a `research_formats` table if this sticks.

## Execution checklist

- [x] Plan doc (this file), session log, findings doc skeleton
- [x] Deprecation banner on Scripts → Sources
- [x] Migration 0027 written + applied to remote Supabase
- [x] `src/lib/research.ts` (lift + hashtag parsing + tiers)
- [x] `src/lib/jobs/research.ts` (scrape job) + `/api/jobs/research`
- [x] `/research` + `/research/[id]` pages + sidebar link
- [x] Typecheck + build green
- [x] Scrape `levelup.withliam` (real run — 100 reels, 2026-07-13)
- [x] Lift results written to findings doc
- [x] Worker extended for `research_videos` + transcription running
- [x] Phase 2: format categories for levelup.withliam — 100/100 transcribed,
      89 categorized, S-tier format anatomy written up in the findings doc
