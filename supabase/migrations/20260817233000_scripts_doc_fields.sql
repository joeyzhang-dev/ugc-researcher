-- Doc view fields: the three per-script lines Joey's weekly Google Doc always
-- carried above the hook. Nullable text, purely additive — the Discord sync
-- importer and every existing page keep working untouched.

alter table public.research_scripts add column if not exists inspo_url text;
alter table public.research_scripts add column if not exists demo text;
alter table public.research_scripts add column if not exists songs text;

comment on column public.research_scripts.inspo_url is
  'Link to the video that inspired this script (the doc''s INSPO VIDEO line).';
comment on column public.research_scripts.demo is
  'What to demo on screen while filming (the doc''s DEMO TO USE line).';
comment on column public.research_scripts.songs is
  'Track(s) to run under the video (the doc''s SONG(S) TO USE line).';
