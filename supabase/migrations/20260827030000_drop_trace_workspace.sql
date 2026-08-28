-- Retire the seeded "Trace" workspace.
--
-- 20260724030704_roster_apps_campaigns.sql seeds research_apps with 'Trace',
-- which was the product this pool studied at the time. It is Folk now, and the
-- Trace row is an empty second workspace in the switcher.
--
-- Done as a corrective migration rather than by editing that seed, because the
-- seed is applied history — rewriting it would make the recorded version stop
-- matching the file, and every fresh bootstrap replays these in order.
--
-- Guarded: only removed when nothing points at it. If a workspace named 'Trace'
-- ever holds real memberships, scripts or campaigns, it stays and this is a
-- no-op, because losing that would be far worse than an extra row in a picker.

delete from public.research_apps a
where a.name = 'Trace'
  and not exists (select 1 from public.research_app_creators x where x.app_id = a.id)
  and not exists (select 1 from public.research_campaigns  x where x.app_id = a.id)
  and not exists (select 1 from public.research_scripts    x where x.app_id = a.id);
