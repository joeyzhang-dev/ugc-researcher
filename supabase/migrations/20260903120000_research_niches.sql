-- The niche track vocabulary, as data.
--
-- Until now this lived in one dict in the pull worker
-- (TRACK_EMOJI_NICHES), so adding a niche meant a code edit, a fly deploy and
-- a Discord gateway reconnect. It had already drifted from the data: 61
-- scripts carry 'Finance General' / 'Girly Finance', which the dict has never
-- heard of.
--
-- This table is the TRACK vocabulary — niches that own an emoji and therefore
-- participate in channel naming and classification. It is deliberately not a
-- registry of every niche string ever written; free-text values keep
-- rendering, because the app derives its pill palette from observed values.

create table if not exists public.research_niches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  emoji text,
  discord_role_id bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.research_niches is
  'Niche tracks: the emoji that prefixes a creator channel, the name written '
  'verbatim into research_scripts.niche, and the Discord role /onboard grants.';
comment on column public.research_niches.emoji is
  'Channel prefix and classifier key. Null means the niche exists but does '
  'not participate in channel naming — /onboard falls back to coaching-.';
comment on column public.research_niches.is_active is
  'Archived niches drop out of /onboard''s picker but STILL classify existing '
  'channels: dropping them from classification would silently stop discovery '
  'for every channel on that emoji.';

-- Case-insensitive, so 'Christian' and 'christian' cannot both exist and
-- write two different strings into research_scripts.niche.
create unique index if not exists research_niches_name_key
  on public.research_niches (lower(name));

-- Emoji equality ignores the variation selector (U+FE0F) and ZWJ (U+200D),
-- which is exactly how _TRACK_BASES matches: ✝️ and ✝ classify identically,
-- so two rows holding them would make discovery non-deterministic with
-- nothing reporting an error.
create or replace function public.niche_emoji_base(emoji text)
returns text language sql immutable as $$
  select nullif(translate(coalesce(emoji, ''), chr(65039) || chr(8205), ''), '')
$$;

create unique index if not exists research_niches_emoji_base_key
  on public.research_niches (public.niche_emoji_base(emoji))
  where public.niche_emoji_base(emoji) is not null;

drop trigger if exists research_niches_set_updated_at on public.research_niches;
create trigger research_niches_set_updated_at
  before update on public.research_niches
  for each row execute function public.set_updated_at();

alter table public.research_niches enable row level security;

drop policy if exists research_niches_staff_read on public.research_niches;
create policy research_niches_staff_read on public.research_niches
  for select using (public.is_staff());

drop policy if exists research_niches_admin_write on public.research_niches;
create policy research_niches_admin_write on public.research_niches
  for all using (public.is_admin()) with check (public.is_admin());

-- A rename has to move the rows that carry the name, or it manufactures the
-- orphan that stranded Finance General. PostgREST cannot span three table
-- updates in one transaction; a function can. The research_niches update goes
-- last so a collision with an existing niche rolls the whole thing back
-- rather than merging two niches' history.
create or replace function public.rename_niche(old_name text, new_name text)
returns table (scripts int, memberships int, channels int)
language plpgsql security definer set search_path = public as $$
declare
  s int; m int; c int;
begin
  update research_scripts set niche = new_name where niche = old_name;
  get diagnostics s = row_count;

  update research_app_creators set niche = new_name where niche = old_name;
  get diagnostics m = row_count;

  update research_discord_channels set niche = new_name where niche = old_name;
  get diagnostics c = row_count;

  update research_niches set name = new_name where name = old_name;

  return query select s, m, c;
end $$;

-- Service role only. The web app authorizes with requireAdmin() before it
-- calls this, exactly as saveScrapeSettings does — and an in-function
-- is_admin() check would REJECT that call, because the admin client is the
-- service role and auth.uid() is null there. Granting to `authenticated`
-- instead would let any signed-in creator rewrite three tables.
revoke execute on function public.rename_niche(text, text) from public;
grant execute on function public.rename_niche(text, text) to service_role;

-- Seed: exactly the three live emoji tracks. Finance General, Girly Finance
-- and 'Toxic / gym motivation' are deliberately NOT seeded — they stop at
-- 2026-08-04 and read as retired. Giving one an emoji in /settings is how it
-- comes back.
insert into public.research_niches (name, emoji) values
  ('Christian', '✝️'),
  ('Female General Self-Improvement', '🤍'),
  ('General Motivation / Hustle', '🌱')
on conflict do nothing;
