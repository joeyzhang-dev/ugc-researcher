-- Coach role + coach ↔ team binding.
--
-- A coach is a fourth kind of user: not staff (they must not see the research
-- pool, scripts or other coaches' teams), not a creator (they have no posts).
-- They get ONE surface, /coach, which shows their own team and nothing else.
--
-- The team is the Discord category of the creators' coaching channels
-- ("Coach: Will's Team") — the same key the coach digest groups by, so a
-- coach's dashboard and the Monday digest to that coach describe the same
-- creators by construction. Stored as the category name because that is the
-- only identity a team has anywhere in this schema.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('admin', 'viewer', 'creator', 'coach'));

-- is_staff() is deliberately NOT widened: every research RLS policy reads
-- through it, and a coach must not be able to select research_* directly.
-- The /coach page reads with the service role server-side and scopes to the
-- coach's own category in code.

create table if not exists public.research_coach_teams (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  -- Discord category name, e.g. "Coach: Will's Team".
  category text not null,
  -- The coach's Discord account, when known; the digest can ping it.
  discord_user_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists research_coach_teams_category_idx
  on public.research_coach_teams (category);

drop trigger if exists research_coach_teams_updated_at on public.research_coach_teams;
create trigger research_coach_teams_updated_at
  before update on public.research_coach_teams
  for each row execute function public.set_updated_at();

alter table public.research_coach_teams enable row level security;

-- A coach may read their own binding (it is what tells the page which team
-- to render); staff may read all of them; only admins write.
create policy "research_coach_teams: own or staff read" on public.research_coach_teams
  for select to authenticated using (profile_id = auth.uid() or public.is_staff());
create policy "research_coach_teams: admin write" on public.research_coach_teams
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
