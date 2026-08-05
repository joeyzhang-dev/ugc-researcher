-- Per-channel AI summary of where the coaching conversation stands (ported
-- from discord-crm's creator_summaries, keyed by channel since unlinked
-- channels deserve summaries too). Incremental: based_on_message_id records
-- the newest message the summary saw, so only channels with fresh activity
-- get re-summarized. Generated locally by the worker via `claude -p`.
create table public.research_discord_summaries (
  channel_id bigint primary key
    references public.research_discord_channels (channel_id) on delete cascade,
  summary text not null,
  -- Short workflow label ("Awaiting videos", "Needs video review", ...).
  status text,
  based_on_message_id bigint,
  model text,
  updated_at timestamptz not null default now()
);

alter table public.research_discord_summaries enable row level security;

create policy "research_discord_summaries: read" on public.research_discord_summaries
  for select to authenticated using (public.is_staff());
create policy "research_discord_summaries: admin write" on public.research_discord_summaries
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
