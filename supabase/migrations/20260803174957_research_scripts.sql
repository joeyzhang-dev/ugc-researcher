-- Scripts we write for our own roster, and the videos they produced.
--
-- The research pool answers "what formats work"; this answers "did the brief
-- we handed a creator actually perform". A script is written once and handed
-- to several creators, so the interesting number is per-script performance
-- aggregated across everyone who ran it.
--
-- Scoped by app (Trace / Folk / Personal) the same way the roster is, so the
-- workspace switcher narrows scripts too.
--
-- Deliberately separate from the tracker's `scripts` / `assignments` tables in
-- this shared database: those point at the tracker's `creators` and `videos`,
-- while these point at `research_creators` / `research_videos`. Same idea, two
-- different creator universes, so they cannot share a foreign key.

create table public.research_scripts (
  id uuid primary key default gen_random_uuid(),
  app_id uuid references public.research_apps (id) on delete set null,
  -- Short human label, e.g. "F12". Optional, unique per app when present.
  code text,
  title text not null,
  -- The script itself, as handed to the creator. This is what gets compared
  -- against a video's transcript when matching.
  body text,
  hook text,
  angle text,
  notes text,
  status text not null default 'Active'
    check (status in ('Draft', 'Active', 'Archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index research_scripts_app_code_idx
  on public.research_scripts (app_id, code)
  where code is not null;
create index research_scripts_app_idx on public.research_scripts (app_id);

-- One script handed to one creator. research_video_id is filled in once we
-- know which post came out of it — that link is what makes per-script stats
-- possible, and it stays null while the post is still pending.
create table public.research_script_assignments (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references public.research_scripts (id) on delete cascade,
  research_creator_id uuid not null references public.research_creators (id) on delete cascade,
  research_video_id uuid references public.research_videos (id) on delete set null,
  status text not null default 'Assigned'
    check (status in ('Assigned', 'Posted', 'Skipped')),
  notes text,
  assigned_at timestamptz not null default now(),
  posted_at timestamptz,
  -- A creator runs a given script at most once.
  unique (script_id, research_creator_id)
);

create index research_script_assignments_script_idx
  on public.research_script_assignments (script_id);
create index research_script_assignments_creator_idx
  on public.research_script_assignments (research_creator_id);
-- Partial unique: one video can only be the output of a single script, but
-- many assignments are legitimately still waiting with no video at all.
create unique index research_script_assignments_video_idx
  on public.research_script_assignments (research_video_id)
  where research_video_id is not null;

alter table public.research_scripts enable row level security;
alter table public.research_script_assignments enable row level security;

create policy "research_scripts: read" on public.research_scripts
  for select to authenticated using (public.is_staff());
create policy "research_scripts: admin write" on public.research_scripts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "research_script_assignments: read" on public.research_script_assignments
  for select to authenticated using (public.is_staff());
create policy "research_script_assignments: admin write" on public.research_script_assignments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create trigger research_scripts_set_updated_at
  before update on public.research_scripts
  for each row execute function public.set_updated_at();
