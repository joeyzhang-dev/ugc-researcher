-- "Our creators" roster: split research_creators into two kinds (outside
-- creators under study vs our own roster), and add apps → campaigns with
-- per-app niche tagging. A creator's niche is a property of the creator
-- WITHIN an app (the same creator can run different niches for different
-- apps), so niche lives on research_app_creators, not on the creator row.
--
-- Shared database with trace-ugc-tracker — everything here is additive and
-- research_-prefixed, so it cannot collide with the tracker's creators/
-- campaigns tables.

alter table public.research_creators
  -- 'research' = outside creator we study/steal from; 'roster' = ours.
  add column if not exists kind text not null default 'research'
    check (kind in ('research', 'roster'));

create table public.research_apps (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  notes text,
  created_at timestamptz not null default now()
);

create table public.research_campaigns (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.research_apps (id) on delete cascade,
  name text not null,
  status text not null default 'Active', -- Active | Paused | Completed
  notes text,
  created_at timestamptz not null default now(),
  unique (app_id, name)
);

-- App membership + the per-app niche tag.
create table public.research_app_creators (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.research_apps (id) on delete cascade,
  research_creator_id uuid not null references public.research_creators (id) on delete cascade,
  niche text,
  notes text,
  created_at timestamptz not null default now(),
  unique (app_id, research_creator_id)
);

-- Campaign membership (a creator can be in many campaigns).
create table public.research_campaign_creators (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.research_campaigns (id) on delete cascade,
  research_creator_id uuid not null references public.research_creators (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (campaign_id, research_creator_id)
);

create index research_campaigns_app_idx on public.research_campaigns (app_id);
create index research_app_creators_creator_idx on public.research_app_creators (research_creator_id);
create index research_campaign_creators_creator_idx on public.research_campaign_creators (research_creator_id);

alter table public.research_apps enable row level security;
alter table public.research_campaigns enable row level security;
alter table public.research_app_creators enable row level security;
alter table public.research_campaign_creators enable row level security;

create policy "research_apps: read" on public.research_apps
  for select to authenticated using (public.is_staff());
create policy "research_apps: admin write" on public.research_apps
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "research_campaigns: read" on public.research_campaigns
  for select to authenticated using (public.is_staff());
create policy "research_campaigns: admin write" on public.research_campaigns
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "research_app_creators: read" on public.research_app_creators
  for select to authenticated using (public.is_staff());
create policy "research_app_creators: admin write" on public.research_app_creators
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "research_campaign_creators: read" on public.research_campaign_creators
  for select to authenticated using (public.is_staff());
create policy "research_campaign_creators: admin write" on public.research_campaign_creators
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Trace is the app everything currently promotes — seed it.
insert into public.research_apps (name) values ('Trace') on conflict do nothing;
