-- Per-account activity stats from Launchpoint's GET /analytics/accounts.
--
-- The accounts endpoint is already fetched every sync tick for the creator and
-- socials phases, but only identity fields were kept. The rest of the payload
-- is exactly the "who's posting, who isn't" view Joey asks Instagram for by
-- hand: last post date, per-account averages, engagement, earnings — and it
-- covers TikTok, which the app never ingests posts for, so a creator active
-- only on TikTok currently looks quiet everywhere.
--
-- One row per (platform, handle), refreshed by upsert. `research_creator_id`
-- is resolved by exact (platform, handle) match against research_creators and
-- stays null for accounts we hold no row for (all of TikTok, by design —
-- the creator phase deliberately creates Instagram rows only).

create table if not exists public.research_launchpoint_accounts (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('instagram', 'tiktok')),
  handle text not null,
  research_creator_id uuid
    references public.research_creators (id) on delete set null,
  contractor_id text not null,
  contractor_name text,
  is_ghost_handle boolean not null default false,
  total_posts integer,
  total_views bigint,
  total_likes bigint,
  total_comments bigint,
  total_shares bigint,
  -- Percent, as Launchpoint computes it (interactions / views * 100).
  engagement_rate numeric,
  average_views_per_post integer,
  -- Dollars.
  total_earnings numeric,
  -- Dollars per 1,000 views; null until money is paid.
  cpm numeric,
  paid_posts integer,
  unpaid_posts integer,
  first_post_at timestamptz,
  last_post_at timestamptz,
  -- Refresh stamp. A row whose synced_at stops advancing is an account
  -- Launchpoint no longer returns (untracked or renamed) — kept, not deleted,
  -- so its history of existing stays visible.
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, handle)
);

comment on table public.research_launchpoint_accounts is
  'Launchpoint /analytics/accounts snapshot: per-handle activity and earnings. Upserted by the accounts sync phase.';
comment on column public.research_launchpoint_accounts.last_post_at is
  'Launchpoint''s lastPostDate — authoritative recency per handle, including platforms whose posts the app never ingests.';

create index if not exists research_launchpoint_accounts_creator_idx
  on public.research_launchpoint_accounts (research_creator_id);

alter table public.research_launchpoint_accounts enable row level security;

create policy "research_launchpoint_accounts: read" on public.research_launchpoint_accounts
  for select to authenticated using (public.is_staff());
create policy "research_launchpoint_accounts: admin write" on public.research_launchpoint_accounts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create trigger research_launchpoint_accounts_set_updated_at
  before update on public.research_launchpoint_accounts
  for each row execute function public.set_updated_at();

-- Seventh sync phase: 'accounts' ('discord' arrived in 20260827020000 and its
-- row already exists, so it must stay in the list or the constraint fails to
-- validate existing rows).
alter table public.research_launchpoint_syncs
  drop constraint if exists research_launchpoint_syncs_phase_check;

alter table public.research_launchpoint_syncs
  add constraint research_launchpoint_syncs_phase_check
  check (phase in ('creators', 'posts', 'insights', 'history', 'socials', 'discord', 'accounts'));
