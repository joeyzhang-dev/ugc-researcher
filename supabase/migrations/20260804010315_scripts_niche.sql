-- Scripts: drop the code label, and replace `angle` with `niche`.
--
-- `code` was carried over from the tracker's script model, where scripts are
-- referenced by short label in briefs. Nothing here does that — the title is
-- the identifier — so it was a field to fill in for no downstream use.
--
-- `angle` and `niche` were trying to be the same thing. Niche is the one that
-- matches how the roster is already organised (research_app_creators.niche),
-- so scripts and creators can be reasoned about in the same vocabulary:
-- "which niche is this script for" lines up with "which niche does this
-- creator run".
--
-- Safe as a straight drop: research_scripts is empty at time of writing.

alter table public.research_scripts drop column if exists code;
alter table public.research_scripts drop column if exists angle;
alter table public.research_scripts add column if not exists niche text;

create index if not exists research_scripts_niche_idx
  on public.research_scripts (niche)
  where niche is not null;
