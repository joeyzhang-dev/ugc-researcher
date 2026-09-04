-- Trial reels, flagged on the row rather than inferred at read time.
--
-- A trial reel is one of ~35 near-identical takes the Trial Reels Batcher
-- uploads to find a winner. Joey confirmed 2026-09-04 that a trial NEVER
-- graduates to a normal reel and NEVER counts toward a paid deliverable, so a
-- trial is not a post in any sense this app cares about.
--
-- Until now the only detector was `collapseTrialUploads`, which runs at read
-- time over transcripts. That leaves every other consumer blind, and the
-- damage is worst where nobody was looking:
--
--   * The script matcher scores transcript containment, and a batch is the
--     same words filmed 35 times — so every member scores almost identically
--     against the script. That manufactures exactly the near-tie
--     MATCH_AUTO_MARGIN (0.12) refuses to auto-link, filling /scripts/review
--     with N-way pileups of one reel. Lowering the margin is NOT the fix; the
--     margin is the only thing stopping two near-identical scripts being
--     silently swapped.
--   * requeueMatchCandidates spends a Whisper call reviving trials.
--   * 47% of transcribed videos since 2026-08-09 are known trials
--     (@lockedin.lin 88%, @wisdomwjas 83%).
--
-- So the answer is stamped, once, and every consumer reads the same column.

alter table public.research_videos
  add column if not exists is_trial_upload boolean not null default false,
  add column if not exists trial_batch_id text,
  add column if not exists trial_source text;

comment on column public.research_videos.is_trial_upload is
  'True when this post is a trial upload: not a deliverable, excluded from the '
  'script matcher''s candidate pool, never requeued for transcription, and '
  'dropped whole by collapseTrialUploads. The row is never deleted.';

comment on column public.research_videos.trial_batch_id is
  'The batcher''s publish_jobs.batch_id where we have it. Null for rows the '
  'transcript heuristic flagged, so nothing may key on it being present.';

comment on column public.research_videos.trial_source is
  '''batcher'' = ground truth from the Trial Reels Batcher''s publish_jobs. '
  '''heuristic'' = the transcript-similarity detector, measured at 0.976 '
  'precision. Both are authoritative for exclusion; only heuristic rows may be '
  're-evaluated, or a re-run would trample ground truth.';

-- Partial: consumers ask "which rows are trials", and after the backfill that
-- is a large minority, not the whole table. Everything else asks for the
-- complement, which the planner reads off the same index.
create index if not exists research_videos_trial_upload_idx
  on public.research_videos (is_trial_upload)
  where is_trial_upload;
