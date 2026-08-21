-- Social links per roster creator, managed from Discord via /socials and
-- readable by the webapp for internal tracking. One row per platform; the
-- platform set is deliberately just what the tracker scrapes today.

create table public.research_creator_socials (
  id uuid primary key default gen_random_uuid(),
  research_creator_id uuid not null
    references public.research_creators (id) on delete cascade,
  platform text not null check (platform in ('instagram', 'tiktok')),
  url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (research_creator_id, platform)
);

create index research_creator_socials_creator_idx
  on public.research_creator_socials (research_creator_id);

alter table public.research_creator_socials enable row level security;

create policy "research_creator_socials: read" on public.research_creator_socials
  for select to authenticated using (public.is_staff());
create policy "research_creator_socials: admin write" on public.research_creator_socials
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create trigger research_creator_socials_set_updated_at
  before update on public.research_creator_socials
  for each row execute function public.set_updated_at();
