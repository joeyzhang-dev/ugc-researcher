-- AI (Copilot/agent) format categorization queue + provenance for
-- research_videos. The regex detector (src/lib/research.ts) stays as the fast
-- caption-only guess; this adds a queue that a Copilot CLI agent drains to
-- categorize from the full transcript AND coin new format buckets.
--
-- Shared database with trace-ugc-tracker: this migration ONLY adds columns to
-- research_videos (which the tracker no longer references), so it is additive
-- and safe. Timestamp version to avoid colliding with the tracker's 00xx
-- migration sequence in the shared schema_migrations table.

alter table public.research_videos
  -- Queue state for the AI pass: null = not queued, 'pending' = awaiting the
  -- agent, 'done' = categorized, 'failed' = agent could not classify it.
  add column if not exists format_llm_status text,
  -- One-line rationale the model gives — helps Joey trust/learn the call.
  add column if not exists format_llm_reasoning text,
  -- Provenance, e.g. 'copilot-cli/claude-opus-4.8'. Keeps engines comparable.
  add column if not exists format_llm_model text,
  add column if not exists format_categorized_at timestamptz;

-- Partial index so the agent's "drain the queue" read stays cheap.
create index if not exists research_videos_format_llm_pending_idx
  on public.research_videos (format_llm_status)
  where format_llm_status = 'pending';
