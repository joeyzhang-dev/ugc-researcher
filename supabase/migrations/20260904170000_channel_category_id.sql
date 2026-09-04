-- The Discord category a channel sits in, by ID.
--
-- research_discord_channels stored only `category`, the category's NAME. On
-- 2026-09-04 the paused category was renamed from "Not Creating 🚫" to
-- "🚫 Not Creating" — the same two words with the emoji moved to the front —
-- and everything keyed on that string silently stopped matching: /offboard
-- failed outright, and 22 parked channels stopped reading as paused.
--
-- A category's name belongs to whoever has Manage Channels. Its id does not
-- change. Storing the id is what lets every consumer stop guessing from a
-- string nobody promised to keep stable.
--
-- Nullable and backfilled by the pull worker's discover step rather than in
-- this migration: discover already holds `parent_id` for every channel it
-- upserts, so the column fills itself on the next run. Consumers must treat
-- NULL as "unknown, fall back to the name" until then.
alter table public.research_discord_channels
  add column if not exists category_id bigint;

comment on column public.research_discord_channels.category_id is
  'Discord category id. Prefer this over `category` (the name), which any '
  'Manage Channels holder can rename without telling us.';

create index if not exists research_discord_channels_category_id_idx
  on public.research_discord_channels (category_id);
