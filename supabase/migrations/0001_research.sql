-- Research: study outside creators (not campaign creators). One row per
-- studied account + one row per scraped reel. Lift is computed in app code
-- (src/lib/research.ts) — never stored, since it shifts as more videos land.
-- Transcription runs on the local worker (worker/transcribe_worker.py) via the
-- service role, same pattern as sources/source_segments (0022).

create table public.research_creators (
  id uuid primary key default gen_random_uuid(),
  platform text not null default 'instagram', -- instagram | tiktok
  handle text not null,
  display_name text,
  profile_url text,
  avatar_url text,
  follower_count bigint,
  -- pending → scraping → ready; failed keeps error_message for the UI.
  status text not null default 'pending', -- pending | scraping | ready | failed
  error_message text,
  last_scraped_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, handle)
);

create table public.research_videos (
  id uuid primary key default gen_random_uuid(),
  research_creator_id uuid not null references public.research_creators (id) on delete cascade,
  url text not null unique, -- canonical link to the original reel
  shortcode text,
  external_id text,
  caption text,
  hashtags text[] not null default '{}',
  posted_at timestamptz,
  view_count bigint,
  like_count bigint,
  comment_count bigint,
  share_count bigint,
  duration_seconds numeric,
  thumbnail_url text,
  -- Signed CDN URL from the scrape — expires within days; the worker downloads
  -- from it promptly, media never leaves the local machine.
  video_url text,
  transcript_status text not null default 'pending', -- pending | fetching | transcribed | failed | skipped
  transcript_text text,
  transcript_method text,
  error_message text,
  -- Phase 2: per-creator format buckets derived from transcripts.
  format_category text,
  raw_metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.research_video_segments (
  id uuid primary key default gen_random_uuid(),
  research_video_id uuid not null references public.research_videos (id) on delete cascade,
  position int not null,
  start_time numeric,
  end_time numeric,
  text text not null
);

create index research_videos_creator_idx on public.research_videos (research_creator_id, posted_at desc);
create index research_videos_transcript_idx on public.research_videos (transcript_status);
create index research_video_segments_video_idx on public.research_video_segments (research_video_id, position);

alter table public.research_creators enable row level security;
alter table public.research_videos enable row level security;
alter table public.research_video_segments enable row level security;

create policy "research_creators: read" on public.research_creators
  for select to authenticated using (public.is_staff());
create policy "research_creators: admin write" on public.research_creators
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "research_videos: read" on public.research_videos
  for select to authenticated using (public.is_staff());
create policy "research_videos: admin write" on public.research_videos
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "research_video_segments: read" on public.research_video_segments
  for select to authenticated using (public.is_staff());
create policy "research_video_segments: admin write" on public.research_video_segments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
