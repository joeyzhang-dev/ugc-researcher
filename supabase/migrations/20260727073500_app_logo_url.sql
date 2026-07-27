-- Workspace logos. The switcher and the left rail fall back to initials, but a
-- real mark is what makes the workspaces instantly distinguishable at 38px.
-- Files live in the existing public `thumbnails` bucket under apps/.

alter table public.research_apps
  add column if not exists logo_url text;
