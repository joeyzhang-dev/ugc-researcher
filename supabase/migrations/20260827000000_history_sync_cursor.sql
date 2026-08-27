-- A resume cursor for the daily-curve phase.
--
-- syncLaunchpointHistory originally decided a post was "done" if it had a
-- metrics row dated today. That does not converge: Launchpoint's most recent
-- snapshot for a quiet post can be days old, so such a post never gets a
-- today-dated row, is never considered fresh, and is re-fetched on every pass
-- forever — burning the rate limit indefinitely. A live backfill showed the
-- remaining count going UP between passes, which is the tell.
--
-- The insights phase already had this shape via launchpoint_synced_at. This is
-- the same idea for history, kept as a separate column on purpose: the two
-- phases have very different costs and must be able to run at different rates
-- without either resetting the other's progress.
--
-- Stamped on EVERY outcome including an empty one, so a post Launchpoint holds
-- no history for stops blocking the queue behind it.

alter table public.research_videos
  add column if not exists launchpoint_history_synced_at timestamptz;

comment on column public.research_videos.launchpoint_history_synced_at is
  'Last daily-curve pull. Resume cursor for syncLaunchpointHistory — deliberately separate from launchpoint_synced_at, which is the insights cursor.';

create index if not exists research_videos_launchpoint_history_idx
  on public.research_videos (launchpoint_history_synced_at nulls first)
  where launchpoint_post_id is not null;
