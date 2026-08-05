-- The niche of a coaching channel is its Discord category ("Creators: 💸
-- Finance General" -> "Finance General"). The worker's discover step stores
-- the cleaned value here and forward-fills research_app_creators.niche (only
-- where it is still null), which is what the scripts sync reads.
alter table public.research_discord_channels
  add column if not exists niche text;
