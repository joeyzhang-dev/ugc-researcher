-- The creator's real name, from Launchpoint, in its own column.
--
-- research_creators.display_name already has a writer: the profile scrape
-- (src/lib/jobs/research.ts) sets it from Instagram on every run. That value is
-- the creator's IG persona — 'D1 man hater', 'jake 👨‍💻🏋️📈', 'Lin' — while
-- Launchpoint's contractorName is the person — 'Sarah Jiang', 'Jacob Kyle',
-- 'Vinh Vu'. Both are correct, and they are not the same fact.
--
-- Pointing the Launchpoint sync at display_name was the obvious move and is the
-- wrong one: the two writers would overwrite each other forever (Launchpoint
-- hourly, the scraper every 12h), so the column's value would depend on which
-- job ran last. A second column lets both facts coexist.
--
-- Measured live 2026-08-31 across 54 linked, unarchived creators: 6 had no
-- display_name at all, and 24 held an IG persona that differs from the real
-- name. Those 30 rows are why this is worth a column rather than a report.
--
-- What it unblocks, beyond display:
--
--   Rename detection. syncLaunchpointCreators builds a real-name → rows map to
--   catch a creator who changed handles without carrying their contractor id
--   (the @dresdistrict → @morrismotivatesyou split). That map currently keys on
--   display_name, which the scraper can change out from under it, and the 6
--   NULLs are invisible to it entirely. Keying on a column Launchpoint owns
--   makes the check deterministic.
--
--   Discord channel names. The live convention is <track-emoji><first>-<last>
--   taken verbatim from Launchpoint, so the real name is the value that
--   convention actually needs.
--
-- No new API calls: contractorName already rides along in the /analytics/
-- accounts payload the creators/socials/accounts phases share each tick.

alter table public.research_creators
  add column if not exists launchpoint_name text;

comment on column public.research_creators.launchpoint_name is
  'The creator''s real name as Launchpoint records it (contractorName), synced '
  'by the Launchpoint creators phase. Deliberately separate from display_name, '
  'which the Instagram scrape owns and which holds their IG persona — the two '
  'are different facts and would otherwise overwrite each other every cycle.';

-- Rename detection looks creators up by this name, so index it. Partial: only
-- linked creators ever have one.
create index if not exists research_creators_launchpoint_name_idx
  on public.research_creators (lower(launchpoint_name))
  where launchpoint_name is not null;
