# AI format categorization — canonical spec

The tool-agnostic contract for categorizing research videos with an LLM agent.
The **primary engine is GitHub Copilot CLI pinned to Claude Opus 4.8**; a Claude
Code skill (`/categorize-formats`) runs the same steps. Both write the same
columns with the same semantics, so provenance stays honest and the two are
interchangeable.

## Why this exists

`src/lib/research.ts`'s `detectFormatCategory` is a hardcoded regex that only
knows six buckets and breaks on WhisperX mishearings. It stays as the fast,
free, caption-only guess at scrape time. This LLM pass is the smart refinement:
it reads the **full transcript**, categorizes reliably, and — crucially for a
research pool — is allowed to **discover and name new formats** the regex could
never represent.

## Data model

Queue + provenance columns on `research_videos` (migration
`20260723225119_research_format_llm.sql`):

| Column | Meaning |
|---|---|
| `format_llm_status` | `pending` (queued) → `done` / `failed`. `null` = never queued. |
| `format_category` | The canonical bucket name. You OVERWRITE this with your call. |
| `format_llm_reasoning` | One sentence: why this format. |
| `format_llm_model` | Provenance, e.g. `copilot-cli/claude-opus-4.8`. |
| `format_categorized_at` | Timestamp you set when done. |

The "Categorize with AI" button (`queueAiCategorization` server action) sets
`format_llm_status='pending'` for a creator's videos. You drain that queue.

## Environment

Source `.env.local` (never print values). DB access via PostgREST:

```
BASE="$NEXT_PUBLIC_SUPABASE_URL/rest/v1"
AUTH=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")
```

The service role bypasses RLS. Use JSON request bodies — never interpolate
caption/transcript text into a SQL string.

## Model

Run on **Claude Opus 4.8** (`claude-opus-4.8`). Tokens are unlimited on Copilot,
so do not truncate transcripts or rush — read the whole thing. Record
`format_llm_model = "copilot-cli/claude-opus-4.8"` (or, from Claude Code,
`claude-code/claude-opus-4.8`) so engine performance stays comparable later.

## Procedure

1. **Read the existing taxonomy** so you reuse names instead of inventing
   near-duplicates:
   ```
   curl -s "${AUTH[@]}" \
     "$BASE/research_videos?select=format_category&format_category=not.is.null" \
     | jq -r '.[].format_category' | sort | uniq -c | sort -rn
   ```
   Known seed buckets from the regex: `10/10 list`, `S-tier list`,
   `Persona blueprint`, `What it looks like`, `Numbered list`, `How-to method`.

2. **Pull the queue** (transcript + caption for each pending row):
   ```
   curl -s "${AUTH[@]}" \
     "$BASE/research_videos?select=id,caption,transcript_text,transcript_status&format_llm_status=eq.pending&order=view_count.desc.nullslast"
   ```
   Process highest-view videos first (they define the winning formats).

3. **Classify each video.** Base the call on the spoken opening + overall
   structure from `transcript_text`; fall back to `caption` when the transcript
   is empty/failed. Rules:
   - Reuse an existing `format_category` name verbatim when the video clearly
     fits it. Match on *structure*, not surface words.
   - Coin a **new** concise Title Case name (2–4 words) only when no existing
     bucket fits — e.g. `Green-flag checklist`, `Day-in-the-life`,
     `Myth-busting`, `Story-time lesson`. Keep names reusable across creators,
     not video-specific.
   - When genuinely ambiguous or there's no usable text, set
     `format_llm_status='failed'` with a short reasoning rather than guessing.
   - One format per video — the dominant one.

4. **Write results back**, one PATCH per video:
   ```
   curl -s -X PATCH "${AUTH[@]}" -H "Content-Type: application/json" \
     -H "Prefer: return=minimal" \
     "$BASE/research_videos?id=eq.<ID>" \
     -d '{"format_category":"<name>","format_llm_reasoning":"<one sentence>","format_llm_model":"copilot-cli/claude-opus-4.8","format_categorized_at":"<ISO8601>","format_llm_status":"done","updated_at":"<ISO8601>"}'
   ```

5. **Report** a short summary: how many done/failed, and the distinct formats
   you ended with (flag any new buckets you introduced).

## Non-negotiables

- Idempotent: safe to re-run. Only rows still `pending` need work.
- Never set `format_category` to null — leave the prior value if you can't
  improve on it (use `failed` status instead).
- Don't touch transcription columns or any other table.
