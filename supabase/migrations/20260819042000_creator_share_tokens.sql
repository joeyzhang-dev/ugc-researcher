-- Creator portal access: a stable unguessable token per creator. The Discord
-- batch card links to /c/<share_token>, which the middleware already treats
-- as a public creator surface (src/lib/routing.ts LEGACY_PORTAL_RE) — no
-- login, the token IS the credential, so it must never appear in staff URLs
-- or logs. 32 hex chars via md5(uuid) keeps it inside /c/[A-Za-z0-9]+ without
-- needing pgcrypto.

alter table public.research_creators
  add column if not exists share_token text
    unique
    default md5(gen_random_uuid()::text);

update public.research_creators
  set share_token = md5(gen_random_uuid()::text)
  where share_token is null;

alter table public.research_creators
  alter column share_token set not null;

comment on column public.research_creators.share_token is
  'Unguessable token for the public creator portal (/c/<token>). Rotating it revokes every previously shared link.';
