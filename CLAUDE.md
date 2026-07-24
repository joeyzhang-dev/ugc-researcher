# trace-research

Standalone research pool, extracted from `trace-ugc-tracker` 2026-07-23. Study
outside creators: Apify profile scrapes → view-lift math → format buckets →
local transcription. **Localhost-only by design** — Joey runs it with
`npm run dev` for his own use; do not add deployment/CI/Vercel infrastructure
unless he asks.

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
- `src/lib/jobs/research.ts` — Apify scrape → upsert → thumbnail capture.
- `src/app/api/jobs/research/route.ts` — CRON_SECRET- or admin-authorized
  scrape endpoint (no cron exists; scrapes are manual).
- `worker/transcribe_worker.py` — local transcription (yt-dlp / Apify / stored
  CDN URL → WhisperX or OpenAI Whisper); polls `research_videos.pending` every
  60s. Media stays in `worker/data/media/` (gitignored).

## Env

`.env.local` (gitignored) carries the same Supabase + Apify keys as the
tracker's `.env.local`, plus `SUPABASE_ACCESS_TOKEN` for migrations. If a key
is rotated, re-copy it from `~/Developer/trace-ugc-tracker/.env.local`.

## Verify

`npm run typecheck` · `npm test` · `python3 -m py_compile worker/transcribe_worker.py`
