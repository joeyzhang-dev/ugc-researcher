-- Scrape scheduling settings + a queue marker on creators.
--
-- Scraping 30+ creators takes far longer than one request can live, so the
-- "Scrape all" button marks creators as queued and a drainer works through
-- them one at a time. scrape_queued_at doubles as the queue and its ordering;
-- it deliberately does NOT overload research_creators.status, so a queued
-- creator still shows whether its last real scrape succeeded.

alter table public.research_creators
  add column if not exists scrape_queued_at timestamptz;

create index if not exists research_creators_scrape_queue_idx
  on public.research_creators (scrape_queued_at)
  where scrape_queued_at is not null;

-- Singleton settings row: `id` is a boolean fixed to true, so the primary key
-- makes a second row impossible.
create table if not exists public.research_settings (
  id boolean primary key default true check (id),
  auto_scrape_enabled boolean not null default false,
  schedule_mode text not null default 'interval'
    check (schedule_mode in ('interval', 'time_of_day')),
  -- interval mode: hours since the last completed run.
  interval_hours integer not null default 12
    check (interval_hours between 1 and 168),
  -- time_of_day mode: "HH:MM" in the machine's local timezone.
  time_of_day text not null default '03:00'
    check (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- Reels pulled per creator per scrape (runResearchScrape caps at 200).
  results_limit integer not null default 35
    check (results_limit between 1 and 200),
  -- Pause between creators. Apify bills per run and Instagram rate-limits, so
  -- a full pass back-to-back is a burst worth spacing out.
  stagger_seconds integer not null default 5
    check (stagger_seconds between 0 and 300),
  scrape_research boolean not null default true,
  scrape_roster boolean not null default true,
  last_run_at timestamptz,
  last_run_status text check (last_run_status in ('succeeded', 'partial', 'failed')),
  last_run_summary text,
  updated_at timestamptz not null default now()
);

insert into public.research_settings (id) values (true) on conflict do nothing;

alter table public.research_settings enable row level security;

create policy "research_settings: read" on public.research_settings
  for select to authenticated using (public.is_staff());
create policy "research_settings: admin write" on public.research_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
