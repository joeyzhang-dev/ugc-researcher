-- Weekly coach digests: where they go and which ones have been sent.
--
-- Coaches read the weekly creator performance in a `#📊weekly-report` text
-- channel inside their own "Coach: … Team" category, visible to the Coach,
-- Folk Team and dev roles and nobody else — the per-creator coaching channels
-- in that category are readable by the creator, and a good/decent/bad ranking
-- of the whole team is not for them. The channel is created by the app on
-- first send and remembered here, so a rename in Discord does not spawn a
-- second one.
--
-- `research_coach_digests` is the idempotency ledger. One row per message the
-- app has sent, keyed the way the Discord ingest keys messages: a dedupe
-- string the sender computes before posting. A retried cron tick, or a
-- manual re-run for the same week, finds the row and skips — the only way to
-- post the same week twice is to delete the row on purpose.

create table if not exists public.research_coach_channels (
  id uuid primary key default gen_random_uuid(),
  -- Discord snowflakes as text: a bigint would lose precision in JS.
  category_id text not null unique,
  category_name text not null,
  channel_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.research_coach_channels is
  'The #📊weekly-report channel inside each coach category, created by the app on first send.';

create table if not exists public.research_coach_digests (
  id uuid primary key default gen_random_uuid(),
  -- weekly:<category_id>:<week_start> | onboarding:<research_creator_id>
  dedupe_key text not null unique,
  kind text not null check (kind in ('weekly', 'onboarding')),
  category_id text,
  channel_id text not null,
  week_start date not null,
  research_creator_id uuid references public.research_creators (id) on delete set null,
  -- Discord message ids of what was posted (a long team can need more than one).
  message_ids text[] not null default '{}',
  sent_at timestamptz not null default now()
);

comment on table public.research_coach_digests is
  'Idempotency ledger for coach digests: one row per message sent, keyed so a retry cannot double-post.';

create index if not exists research_coach_digests_week_idx
  on public.research_coach_digests (week_start, kind);

alter table public.research_coach_channels enable row level security;
alter table public.research_coach_digests enable row level security;

create policy "research_coach_channels: read" on public.research_coach_channels
  for select to authenticated using (public.is_staff());
create policy "research_coach_digests: read" on public.research_coach_digests
  for select to authenticated using (public.is_staff());
