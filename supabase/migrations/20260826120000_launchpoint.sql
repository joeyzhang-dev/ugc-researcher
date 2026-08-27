-- Launchpoint integration.
--
-- Launchpoint (launchpointhq.com) is the platform Folk actually runs its
-- creator program on: it holds the payouts, and — because creators authorize
-- their accounts to it — it holds *first-party* Instagram Reel metrics that no
-- public scrape can reach. Scrape Creators gives us views/likes/comments from
-- outside the account. Launchpoint gives us reach, saves, watch time and skip
-- rate from inside it.
--
-- That matters because this app already stores the transcript of nearly every
-- roster post. Transcript + retention is the pairing the research pool exists
-- to study: views tell you the algorithm pushed a reel, watch time tells you
-- the script held the person who saw it.
--
-- The join key is the Instagram shortcode. Launchpoint stores post URLs as
-- plain `instagram.com/reel/<code>/`, which is exactly what research_videos
-- already parses into `shortcode` — so no id mapping table is needed, and a
-- post scraped before Launchpoint ever saw it still lines up.

-- ---------------------------------------------------------------------------
-- research_videos: first-party insight columns
-- ---------------------------------------------------------------------------

alter table public.research_videos
  add column if not exists launchpoint_post_id text,
  add column if not exists launchpoint_title text,
  add column if not exists reach integer,
  add column if not exists saves integer,
  add column if not exists avg_watch_time_ms integer,
  add column if not exists total_watch_time_ms bigint,
  add column if not exists skip_rate numeric(6, 3),
  add column if not exists earnings_usd numeric(12, 2),
  add column if not exists paid boolean,
  add column if not exists launchpoint_synced_at timestamptz;

comment on column public.research_videos.launchpoint_post_id is
  'Launchpoint post uuid. Matched to our row by Instagram shortcode, not stored upstream.';
comment on column public.research_videos.launchpoint_title is
  'Launchpoint concept name for the post. ~78% of posts are the catch-all "Open-ended", so this corroborates a script match at best — it does not replace transcript matching.';
comment on column public.research_videos.reach is
  'Unique accounts reached (first-party). Always <= views; views counts replays.';
comment on column public.research_videos.skip_rate is
  'Percent of viewers who skipped, straight from Instagram. Lower is better.';
comment on column public.research_videos.avg_watch_time_ms is
  'Mean milliseconds watched. Divided by duration_seconds this is the hold rate — the closest thing we have to "did the script work".';
comment on column public.research_videos.launchpoint_synced_at is
  'Last successful insight pull. The sync job walks oldest-first, so this is also the resume cursor across cron ticks.';

-- Partial unique: one research_videos row per Launchpoint post. Partial so the
-- ~900 outside-creator videos Launchpoint never sees stay unconstrained.
create unique index if not exists research_videos_launchpoint_post_idx
  on public.research_videos (launchpoint_post_id)
  where launchpoint_post_id is not null;

-- The sync cursor: rows Launchpoint knows about, oldest sync first.
create index if not exists research_videos_launchpoint_sync_idx
  on public.research_videos (launchpoint_synced_at nulls first)
  where launchpoint_post_id is not null;

-- ---------------------------------------------------------------------------
-- research_creators: Launchpoint identity
-- ---------------------------------------------------------------------------

alter table public.research_creators
  add column if not exists launchpoint_creator_id text;

comment on column public.research_creators.launchpoint_creator_id is
  'Launchpoint contractor id (crt_...). Shared across a creator''s platform rows — one person, one Launchpoint id, one row here per platform+handle.';

create index if not exists research_creators_launchpoint_idx
  on public.research_creators (launchpoint_creator_id)
  where launchpoint_creator_id is not null;

-- ---------------------------------------------------------------------------
-- Daily metrics history
-- ---------------------------------------------------------------------------

-- research_videos holds ONE view_count, overwritten by every scrape, so the
-- lift math has never been able to tell a reel that is still climbing from one
-- that died in a day. Launchpoint keeps a daily snapshot per post; this table
-- mirrors it so the curve survives locally and can be charted without an API
-- round trip.
--
-- `date` is the calendar day Launchpoint stamped, kept as a date rather than a
-- timestamp because that is the actual granularity — pretending to more
-- precision would invite bogus intra-day math.
create table if not exists public.research_video_metrics_daily (
  id uuid primary key default gen_random_uuid(),
  research_video_id uuid not null
    references public.research_videos (id) on delete cascade,
  date date not null,
  views integer,
  likes integer,
  comments integer,
  shares integer,
  bookmarks integer,
  -- Upstream's own day-over-day deltas. Stored rather than derived so a gap in
  -- the series (a day Launchpoint did not snapshot) cannot silently turn into
  -- a fabricated jump when we subtract neighbouring rows.
  views_delta integer,
  likes_delta integer,
  comments_delta integer,
  shares_delta integer,
  bookmarks_delta integer,
  created_at timestamptz not null default now(),
  unique (research_video_id, date)
);

create index if not exists research_video_metrics_daily_video_idx
  on public.research_video_metrics_daily (research_video_id, date);

alter table public.research_video_metrics_daily enable row level security;

create policy "research_video_metrics_daily: read" on public.research_video_metrics_daily
  for select to authenticated using (public.is_staff());
create policy "research_video_metrics_daily: admin write" on public.research_video_metrics_daily
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Sync bookkeeping
-- ---------------------------------------------------------------------------

-- One row per phase, so a partial pass is resumable and the UI can say when
-- each half of the integration last completed. Phases are separate rows
-- because they have wildly different costs: posts/creators are a handful of
-- calls, insights and history are one call per video and span several cron
-- ticks.
create table if not exists public.research_launchpoint_syncs (
  phase text primary key
    check (phase in ('creators', 'posts', 'insights', 'history')),
  last_run_at timestamptz,
  last_status text check (last_status in ('succeeded', 'partial', 'failed')),
  last_detail text,
  updated_at timestamptz not null default now()
);

alter table public.research_launchpoint_syncs enable row level security;

create policy "research_launchpoint_syncs: read" on public.research_launchpoint_syncs
  for select to authenticated using (public.is_staff());
create policy "research_launchpoint_syncs: admin write" on public.research_launchpoint_syncs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create trigger research_launchpoint_syncs_set_updated_at
  before update on public.research_launchpoint_syncs
  for each row execute function public.set_updated_at();
