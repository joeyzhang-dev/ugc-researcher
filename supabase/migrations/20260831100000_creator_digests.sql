-- Scheduled creator recaps: the weekly and daily messages the bot posts into
-- each creator's own coaching channel.
--
-- Two changes, both small on purpose.
--
-- 1. The digest ledger gains two kinds. `research_coach_digests` already is
--    the "what have we posted, so a retry cannot double-post" ledger; creator
--    sends need exactly that guarantee and nothing else, so they reuse it
--    rather than growing a parallel table with the same columns and the same
--    bugs. The dedupe key namespaces them:
--      creator-weekly:<creator_id>:<week_start>
--      creator-daily:<creator_id>:<day>
--
-- 2. Two kill switches on research_settings, defaulting FALSE.
--
--    These default off deliberately. Turning them on means the bot pings ~40
--    real creators every morning and again on Mondays, and a deploy must never
--    be able to start doing that on its own — enabling it has to be a separate,
--    deliberate act after a dry run has been read.

alter table public.research_coach_digests
  drop constraint if exists research_coach_digests_kind_check;

alter table public.research_coach_digests
  add constraint research_coach_digests_kind_check
  check (kind in ('weekly', 'onboarding', 'creator-weekly', 'creator-daily'));

alter table public.research_settings
  add column if not exists creator_weekly_enabled boolean not null default false,
  add column if not exists creator_daily_enabled boolean not null default false;

comment on column public.research_settings.creator_weekly_enabled is
  'Post the weekly recap into each creator''s coaching channel on Mondays, '
  'pinging that creator. Off by default: it notifies real people at roster '
  'scale, so switching it on must be a deliberate act, never a side effect of '
  'a deploy.';

comment on column public.research_settings.creator_daily_enabled is
  'Post the daily recap into each creator''s coaching channel each morning '
  '(13:00 UTC / 9am ET), pinging that creator. Off by default, same reason.';

-- The ledger is read once per send pass with a `like` on the key prefix and a
-- week/day bound; without this every pass sequential-scans a table that grows
-- by ~40 rows a day forever.
create index if not exists research_coach_digests_kind_week_idx
  on public.research_coach_digests (kind, week_start desc);
