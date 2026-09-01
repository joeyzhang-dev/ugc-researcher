-- Retiring a creator: an explicit archive flag on research_creators.
--
-- Until now nothing in the schema could say "we stopped working with this
-- person". The two columns that look like they might don't:
--
--   status  — scrape health (pending / ready / failed). A creator who left the
--             program a month ago still reads 'ready', because her last scrape
--             worked fine.
--   kind    — 'roster' (ours) vs 'research' (outside creators we study).
--
-- So every creator ever added stays on /creators forever, keeps consuming
-- scrape budget, and dilutes the roster. Measured 2026-08-30: 28 of 59 roster
-- creators had not posted in over 30 days.
--
-- Why an explicit flag rather than deriving "inactive" from the last post
-- date: a creator on a two-week break is not retired, and silently hiding a
-- row is precisely the failure the /creators "Unassigned" band was built to
-- prevent (6547bae). Dormancy is shown as a derived chip so the candidates are
-- obvious; the decision to retire stays a human one, recorded here.
--
-- Launchpoint cannot supply this either — checked live against
-- GET /analytics/accounts: all 117 tracked accounts report programCount = 1
-- and contractCount = 0, dormant ones included. There is no upstream
-- lifecycle signal to sync, so this flag has to be ours.

alter table public.research_creators
  add column if not exists archived_at timestamptz,
  add column if not exists archived_reason text;

comment on column public.research_creators.archived_at is
  'Set when we stop working with a creator. Hides the row from the default '
  '/creators view and excludes it from bulk scrape enqueues. Their videos, '
  'transcripts, scripts and Launchpoint history are all retained — archiving '
  'is a visibility and cost decision, never a delete.';

comment on column public.research_creators.archived_reason is
  'Optional free-text note for why, shown beside the archived badge.';

-- Partial: the default roster view asks for "not archived", and the archived
-- set is the small minority, so only the archived rows are worth indexing.
create index if not exists research_creators_archived_at_idx
  on public.research_creators (archived_at)
  where archived_at is not null;
