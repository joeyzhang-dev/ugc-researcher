-- Discord ingestion moves into this repo (consolidated from the standalone
-- discord-crm project, which had its own Supabase). Blank slate by design: no
-- history is imported — worker/discord_pull_worker.py fills these tables from
-- the live server going forward.
--
-- Same pipeline as discord-crm: REST pull → normalize (dedupe_key
-- guild/channel/message/edit_version) → attribute author_role → idempotent
-- upsert. Attribution is data-driven: the channel's creator comes from the
-- roster (research_creators.discord_user_id via research_discord_channels),
-- coaches and automation bots ("launchpoint") from research_discord_user_roles.
--
-- research_-prefixed like everything else this repo owns in the shared
-- database, so it cannot collide with the tracker's tables.

-- Roster identity: which Discord account is which roster creator. This is the
-- Discord↔Instagram consolidation point — the rest of the schema hangs off it.
alter table public.research_creators
  add column if not exists discord_user_id bigint,
  add column if not exists discord_username text;

create unique index research_creators_discord_user_idx
  on public.research_creators (discord_user_id)
  where discord_user_id is not null;

-- One row per tracked coaching-<name> channel. Discovered from the guild by
-- the worker (channels under the creator categories), then linked to a roster
-- creator; is_tracked=false parks a channel without losing the link.
create table public.research_discord_channels (
  channel_id bigint primary key,
  guild_id bigint not null,
  channel_name text,
  research_creator_id uuid references public.research_creators (id) on delete set null,
  is_tracked boolean not null default true,
  created_at timestamptz not null default now()
);

create index research_discord_channels_creator_idx
  on public.research_discord_channels (research_creator_id);

-- Directory of every Discord account seen in tracked channels (creators,
-- coaches, bots). Display fields are refreshed by the worker as it pulls.
create table public.research_discord_users (
  discord_user_id bigint primary key,
  username text,
  global_name text,
  nickname text,
  display_name text,
  is_bot boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Auditable source of truth for non-creator actors. Creators keep their id on
-- research_creators.discord_user_id; this table holds coaches + automation
-- bots. channel_id 0 means the mapping is guild-wide (it is part of the PK,
-- which forbids NULL, so 0 is the guild-wide sentinel).
create table public.research_discord_user_roles (
  discord_user_id bigint not null,
  channel_id bigint not null default 0,
  role text not null check (role in ('creator', 'coach', 'launchpoint')),
  is_bot boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  primary key (discord_user_id, channel_id)
);

-- Raw message log, append-mostly. author_role is resolved at ingest time
-- (first match wins: launchpoint-listed webhook/bot → launchpoint, any other
-- bot/webhook → unknown, channel's creator → creator, coach list → coach,
-- else unknown — unknowns surface new people to enroll).
create table public.research_discord_messages (
  id bigint generated always as identity primary key,
  guild_id bigint not null,
  channel_id bigint not null,
  message_id bigint not null,
  edit_version integer not null default 0,
  dedupe_key text not null unique,
  author_discord_user_id bigint,
  author_role text not null default 'unknown'
    check (author_role in ('creator', 'coach', 'launchpoint', 'unknown')),
  is_bot boolean not null default false,
  webhook_id bigint,
  content text not null,
  attachments jsonb not null default '[]'::jsonb,
  -- Discord's own message timestamp (the old CRM stored ingestion time here;
  -- the worker now carries the real one from the API).
  posted_at timestamptz,
  edited_at timestamptz,
  ingested_at timestamptz not null default now()
);

-- (channel_id, message_id desc) serves the per-channel watermark query the
-- worker runs every poll: MAX(message_id) per channel.
create index research_discord_messages_channel_idx
  on public.research_discord_messages (channel_id, message_id desc);
create index research_discord_messages_author_idx
  on public.research_discord_messages (author_discord_user_id);
create index research_discord_messages_role_idx
  on public.research_discord_messages (author_role);

-- Per-creator consolidation: messages joined to their channel + roster
-- creator, mirroring discord-crm's creator_messages view. security_invoker so
-- the underlying tables' RLS still applies to app reads.
create view public.research_discord_creator_messages
  with (security_invoker = true) as
select
  rc.id as research_creator_id,
  rc.handle,
  rc.display_name as creator_display_name,
  ch.channel_id,
  ch.channel_name,
  m.message_id,
  m.author_discord_user_id,
  m.author_role,
  m.content,
  m.attachments,
  jsonb_array_length(m.attachments) as attachment_count,
  m.posted_at,
  m.edited_at,
  m.is_bot,
  m.webhook_id
from public.research_discord_messages m
join public.research_discord_channels ch on ch.channel_id = m.channel_id
left join public.research_creators rc on rc.id = ch.research_creator_id;

alter table public.research_discord_channels enable row level security;
alter table public.research_discord_users enable row level security;
alter table public.research_discord_user_roles enable row level security;
alter table public.research_discord_messages enable row level security;

create policy "research_discord_channels: read" on public.research_discord_channels
  for select to authenticated using (public.is_staff());
create policy "research_discord_channels: admin write" on public.research_discord_channels
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "research_discord_users: read" on public.research_discord_users
  for select to authenticated using (public.is_staff());
create policy "research_discord_users: admin write" on public.research_discord_users
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "research_discord_user_roles: read" on public.research_discord_user_roles
  for select to authenticated using (public.is_staff());
create policy "research_discord_user_roles: admin write" on public.research_discord_user_roles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "research_discord_messages: read" on public.research_discord_messages
  for select to authenticated using (public.is_staff());
create policy "research_discord_messages: admin write" on public.research_discord_messages
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create trigger research_discord_users_set_updated_at
  before update on public.research_discord_users
  for each row execute function public.set_updated_at();
