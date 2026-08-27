-- Allow a fifth Launchpoint sync phase: 'socials'.
--
-- Launchpoint knows every platform account a creator has linked — 117 accounts
-- across 54 contractors on the live program — while research_creator_socials
-- was empty, because the only way to fill it was the Discord bot's /socials
-- command, one creator at a time, by hand.
--
-- This is the one place the app can learn a creator's TikTok handle at all:
-- research_creators is keyed on (platform, handle) and we deliberately only
-- create Instagram rows, so without this table a creator's TikTok presence is
-- invisible to the app even though Launchpoint has been tracking it all along.

alter table public.research_launchpoint_syncs
  drop constraint if exists research_launchpoint_syncs_phase_check;

alter table public.research_launchpoint_syncs
  add constraint research_launchpoint_syncs_phase_check
  check (phase in ('creators', 'posts', 'insights', 'history', 'socials'));
