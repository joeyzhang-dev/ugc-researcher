---
name: categorize-formats
description: Drain the research video AI format-categorization queue — classify pending research_videos from their transcripts (reusing or coining format buckets) and write results back to Supabase. Use when Joey asks to AI-categorize research formats, or after clicking "Categorize with AI" / after transcripts land. Mirrors the Copilot CLI drainer.
---

# Categorize research formats (Claude Code engine)

Same task as `scripts/categorize-formats.sh`, run in-session instead of via
Copilot CLI. Follow **`docs/format-categorization.md`** exactly — it is the
canonical contract.

## Steps

1. Read `docs/format-categorization.md` in this repo and follow it end to end.
2. Source `.env.local` for `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
   (never print the values). Access the DB via PostgREST, not raw SQL.
3. Read the existing `format_category` taxonomy first, then pull all
   `research_videos` where `format_llm_status='pending'` (transcript_text +
   caption), highest view count first.
4. Classify each from the transcript (caption fallback): reuse an existing
   bucket when it fits, else coin a concise reusable Title Case name; set
   `failed` when there's no usable text rather than guessing.
5. PATCH each row: `format_category`, `format_llm_reasoning`,
   `format_llm_model` = `claude-code/<model-id>`, `format_categorized_at`,
   `format_llm_status='done'`.
6. Report counts (done/failed) and the distinct formats, flagging new buckets.

## Notes

- Provenance model prefix is `claude-code/` here (Copilot uses `copilot-cli/`),
  so runs stay comparable by engine.
- Idempotent — only `pending` rows need work; safe to re-run.
- Never null out `format_category`; never touch other tables/columns.
