-- Raw Discord category name per coaching channel ("Creators: 💸 Finance
-- General", "Not Creating 🚫", ...). niche is the cleaned content lane; the
-- category additionally tells creating vs not-creating, which the Discord UI
-- page splits on like the old discord-crm dashboard did.
alter table public.research_discord_channels
  add column if not exists category text;
