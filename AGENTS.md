# ugc-researcher — agent guide

Standalone research pool (extracted from `trace-ugc-tracker` 2026-07-23). Study
outside UGC creators: Scrape Creators profile scrapes → view-lift math → format buckets →
local transcription. **Localhost-only** — Joey runs `npm run dev` for his own
use. Do not add deploy/CI/Vercel infrastructure unless asked.

Stack: Next.js 15 (App Router, server components + server actions) + Supabase
(Postgres, Storage, RLS) + Tailwind v4. Python transcription worker under
`worker/`.

## Commands

- `npm run dev` — dev server (Joey usually already has one running on :3000;
  don't start a second)
- `npx tsc --noEmit` — typecheck (run before claiming done)
- `npm test` — vitest (lift math + format detection)
- `npm run categorize:formats` — drain the AI format-categorization queue with
  Copilot (see below)

## Ground rules

- Secrets are in `.env.local` — source them, never print values.
- Shared Supabase project with `trace-ugc-tracker`. New migrations go in
  `supabase/migrations/` with **timestamp versions** (`YYYYMMDDHHMMSS_name.sql`)
  and are applied with `node scripts/apply-migration.mjs <file>` — short numeric
  versions collide with the tracker's sequence. Never run destructive SQL.
- DB access from scripts/agents: **PostgREST**, not hand-assembled SQL.
  `{NEXT_PUBLIC_SUPABASE_URL}/rest/v1/<table>`, headers `apikey` +
  `Authorization: Bearer {SUPABASE_SERVICE_ROLE_KEY}` (service role bypasses
  RLS), `Prefer: return=representation`. Never build SQL strings that embed
  transcript/caption text — use PostgREST JSON bodies with proper filters.
- Match existing style: minimal client JS, server actions for mutations, custom
  components in `src/components/` (no component library).

## AI format categorization (the main agent task)

Canonical spec: **`docs/format-categorization.md`**. Follow it exactly. Summary:
the `/research/[id]` "Categorize with AI" button flips
`research_videos.format_llm_status = 'pending'`; you drain that queue, classify
each video from its transcript + caption (reusing existing format names or
coining new ones), and write the result back.

**Model:** run on **Claude Opus 4.8** (`claude-opus-4.8`). Record provenance
`copilot-cli/claude-opus-4.8` in `format_llm_model`. Tokens are unlimited on
Copilot — favor thoroughness over brevity.

## Key map

- `src/app/(app)/research/` — creator list + detail pages, `actions.ts`
- `src/lib/research.ts` — lift math + regex `detectFormatCategory`
- `src/lib/jobs/research.ts` — profile scrape → upsert → thumbnails
- `scripts/categorize-formats.sh` — Copilot drainer (model-pinned)
- `worker/transcribe_worker.py` — local WhisperX/Whisper transcription
