-- Send tracking on assignments: the app now hands scripts out itself by
-- posting into each creator's Discord channel. The assignment row IS the
-- send record — these columns remember where the message landed so re-sends
-- are detectable and the bot's pager buttons can find the batch.
-- Snowflakes stored as text, same as the research_discord_* tables.

alter table public.research_script_assignments
  add column if not exists discord_channel_id text,
  add column if not exists discord_message_id text,
  add column if not exists sent_at timestamptz;

comment on column public.research_script_assignments.discord_message_id is
  'Discord message that delivered this script (one paged message per batch, shared by its assignments).';

create index if not exists research_script_assignments_message_idx
  on public.research_script_assignments (discord_message_id)
  where discord_message_id is not null;
