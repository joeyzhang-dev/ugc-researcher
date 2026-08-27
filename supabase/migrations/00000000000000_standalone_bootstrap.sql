-- Standalone bootstrap — ONLY for a dedicated research database.
--
-- This repo normally shares `trace-ugc-tracker`'s Supabase project, where
-- `profiles`, `is_staff()`, `is_admin()` and `set_updated_at()` already exist
-- because the tracker's migrations created them. `0001_research.sql` has always
-- carried a note that it is reference-only "unless a dedicated database is ever
-- created (which would also need profiles + the staff helper functions first)".
--
-- This file is those prerequisites. Applied 2026-08-26 to project
-- `yvbvcblqjlfhhvatijng` (bludgc-research), which forked the research tables
-- away from the shared project after dashboard access to the latter was lost.
--
-- Scope is deliberately minimal. The research schema depends on exactly four
-- things from the tracker — verified by grepping every `references public.*`
-- and `public.is_*` in this repo's migrations — so none of the tracker's own
-- tables (campaigns, creators, contracts, warmup, onboarding) are recreated
-- here. Copying them would mean maintaining a second, drifting copy of another
-- product's schema.
--
-- Apply order for a fresh project:
--   1. this file
--   2. 0001_research.sql          (the mirror — legitimate here, never on the shared project)
--   3. every 2026*.sql in filename order

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles — internal users, mirroring auth.users
-- ---------------------------------------------------------------------------
-- Carries the tracker's post-0011 shape directly: the 'creator' role and the
-- 'creator' default, rather than 0001_init's admin-only form plus a later
-- alter. A fresh database has no history to preserve, and defaulting new
-- signups to 'admin' — even for the minutes before the alter ran — would be a
-- real privilege bug, not a cosmetic difference.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  name text,
  role text not null default 'creator' check (role in ('admin', 'viewer', 'creator')),
  created_at timestamptz not null default now()
);

-- Auto-create a profile whenever an auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Staff helpers — every research RLS policy is written against these
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Staff = admin or viewer. Creators (and any unknown user) are NOT staff.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'viewer')
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles RLS
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles: admin write" on public.profiles;
create policy "profiles: admin write" on public.profiles
  for update to authenticated using (public.is_admin());
