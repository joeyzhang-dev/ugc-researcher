-- Allow a sixth Launchpoint sync phase: 'discord'.
--
-- Linking a Discord channel to a creator was a hand-typed dictionary
-- (VERIFIED_HANDLES in worker/discord_pull_worker.py, 53 entries): every new
-- creator meant editing Python and redeploying the Fly worker, and the data
-- being copied in by hand was already available from Launchpoint's API.
--
-- The chain closes without any of that. A creator channel is named
-- <track-emoji><first>-<last>, which is Launchpoint's contractorName; the
-- contractor id is already on research_creators.launchpoint_creator_id. So
-- channel name -> contractor -> creator, computed rather than remembered.

alter table public.research_launchpoint_syncs
  drop constraint if exists research_launchpoint_syncs_phase_check;

alter table public.research_launchpoint_syncs
  add constraint research_launchpoint_syncs_phase_check
  check (phase in ('creators', 'socials', 'posts', 'insights', 'history', 'discord'));
