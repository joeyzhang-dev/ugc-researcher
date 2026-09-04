-- Scripts published to a shared format channel, rather than sent to one
-- creator. One row per (script, channel) publication. A script may appear in
-- more than one channel (#broad alongside #gym), which is why this is a table
-- and not columns on research_scripts.
create table if not exists public.research_script_posts (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references public.research_scripts(id) on delete cascade,
  discord_channel_id bigint not null,
  -- Denormalised on purpose: channels get renamed, and the history should
  -- still read correctly afterwards.
  channel_label text not null,
  discord_message_id bigint not null,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Re-posting the same script to the same channel is a no-op, not a second card.
create unique index if not exists research_script_posts_script_channel_key
  on public.research_script_posts (script_id, discord_channel_id);

create index if not exists research_script_posts_script_idx
  on public.research_script_posts (script_id);

alter table public.research_script_posts enable row level security;

-- Same shape as the other research tables: staff read, service role writes.
create policy research_script_posts_staff_read
  on public.research_script_posts for select
  using (public.is_staff());
