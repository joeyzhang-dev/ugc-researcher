import Link from "next/link";
import { getProfile, isCoach, isStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOwnCoachTeam } from "@/lib/coach-team";
import { loadPerformanceReport, type CoachGroup } from "@/lib/jobs/performance";
import {
  lastCompleteWeek,
  parseWeek,
  previousWeek,
  weekKey,
  type Window,
} from "@/lib/performance";
import { Card, EmptyState, KpiCard, PageHeader, tableWrap } from "@/components/ui";
import { compareValues, parseSort, SortHeader, type SortDir } from "@/components/sort-header";
import { BUCKET_ORDER, comparePerformance } from "@/lib/performance";
import type { PerformanceRow as PerformanceRowData } from "@/lib/jobs/performance";
import { BucketChip, PERFORMANCE_GRID as GRID, PerformanceRow as Row, signedPct, signedUsd } from "@/components/performance-rows";
import { formatCompact, formatDateUTC, formatUsd } from "@/lib/format";
import { comparePosting } from "@/lib/digest-render";
import { Avatar } from "@/components/ui";
import { QUOTA_POSTS_PER_WEEK, TOP_POSTS } from "@/lib/performance";

export const dynamic = "force-dynamic";

const SORT_KEYS = ["digest", "creator", "posts", "views", "cpm", "delta", "joined"] as const;
type SortKey = (typeof SORT_KEYS)[number];

/**
 * A coach's own team for one week: the pooled CPM, how the week went, and
 * one line per creator — the same lines /performance and the Monday digest
 * show, because all three read `loadPerformanceReport`.
 *
 * Reads with the service role: a coach is not staff, so RLS would return
 * nothing to their session. The scope is enforced here instead — the page
 * renders exactly one coach group, the one bound to the signed-in account.
 */
export default async function CoachPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; team?: string; sort?: string; dir?: string }>;
}) {
  const { week: weekParam, team: teamParam, sort: sortParam, dir: dirParam } = await searchParams;
  const sort = parseSort<SortKey>(sortParam, dirParam, SORT_KEYS, { key: "digest", dir: "asc" });
  const profile = await getProfile();
  if (!profile) return null; // the layout already redirected
  const week: Window = parseWeek(weekParam) ?? lastCompleteWeek();

  // Which team: a coach's own binding, always. Staff may pick any team via
  // ?team= to see what that coach sees.
  let category: string | null = null;
  if (isCoach(profile)) {
    category = (await getOwnCoachTeam(profile.id))?.category ?? null;
    if (!category) {
      return (
        <EmptyState message="No team is assigned to this account yet — ask the Folk team to bind you to your coaching category." />
      );
    }
  }

  const report = await loadPerformanceReport(createAdminClient(), week);
  const teams = report.groups.filter((g) => g.coach != null);
  const group: CoachGroup | undefined = isCoach(profile)
    ? report.groups.find((g) => g.coach === category)
    : (teams.find((g) => g.coach === teamParam) ?? teams[0]);

  const hrefWith = (overrides: { week?: string; team?: string | null; sort?: string; dir?: string }) => {
    const sp = new URLSearchParams();
    sp.set("week", overrides.week ?? weekKey(week));
    const team = overrides.team === undefined ? (group?.coach ?? null) : overrides.team;
    if (isStaff(profile) && team) sp.set("team", team);
    const sortKey = overrides.sort ?? sortParam;
    const sortDir = overrides.dir ?? dirParam;
    if (sortKey) sp.set("sort", sortKey);
    if (sortDir) sp.set("dir", sortDir);
    return `/coach?${sp.toString()}`;
  };
  const sortHref = (key: SortKey, dir: SortDir) => hrefWith({ sort: key, dir });

  // Same recipe as /performance: bad → decent → good by default, and any
  // explicit sort applied to the whole table, nulls sinking either way.
  const value = (r: PerformanceRowData): string | number | null => {
    const p = r.performance;
    switch (sort.key) {
      case "digest": return p.bucket ? BUCKET_ORDER[p.bucket] : null;
      case "posts": return p.weekly.posts;
      case "views": return p.weekly.avgViews;
      case "cpm": return p.cpm30.cpm ?? p.cpm30.projected;
      case "delta": return (p.delta ?? p.projectedDelta)?.usd ?? null;
      case "joined": return p.weeksSinceJoined;
      default: return r.launchpointName || r.displayName || r.handle;
    }
  };
  const rows = [...(group?.rows ?? [])].sort(
    (a, b) =>
      compareValues(value(a), value(b), sort.dir) ||
      (sort.key === "digest" ? comparePerformance(a.performance, b.performance) : 0) ||
      a.handle.localeCompare(b.handle)
  );
  const nextWeek: Window = { start: week.end, end: new Date(week.end.getTime() + (week.end.getTime() - week.start.getTime())) };
  const canGoForward = nextWeek.end.getTime() <= lastCompleteWeek().end.getTime();
  const isLatest = weekKey(week) === weekKey(lastCompleteWeek());
  const teamName = (group?.coach ?? category ?? "Your team").replace(/^Coach:\s*/i, "");

  const t = group?.team;
  // The recap's own numbers, so the page and the Monday message agree.
  const members = group?.rows ?? [];
  const silent = members.filter((r) => r.performance.weekly.posts === 0);
  const flagged = members.filter((r) => r.performance.flagged);
  const posting = [...members].sort(comparePosting);
  const busiest = Math.max(QUOTA_POSTS_PER_WEEK, ...posting.map((r) => r.performance.weekly.posts));
  const topPosts = members
    .flatMap((r) => r.performance.weekly.topPosts.map((post) => ({ row: r, post })))
    .sort((a, b) => b.post.views - a.post.views)
    .slice(0, TOP_POSTS);
  const cpm = t ? (t.cpm30.cpm ?? t.cpm30.projected) : null;
  const cpmProjected = Boolean(t && t.cpm30.cpm == null && t.cpm30.projected != null);
  const d = t ? (t.delta ?? t.projectedDelta) : null;
  const dLabel = !t
    ? ""
    : t.delta != null
      ? `vs the 30 days before (to ${formatDateUTC(t.cpm30.priorWindow?.end.toISOString())}, ${t.cpm30.priorPaidPosts} paid)${t.cpm30.lowSample || t.cpm30.priorLowSample ? " · low sample" : ""}`
      : t.projectedDelta != null
        ? `this week's posts vs last week's (≈ ${formatUsd(t.projectedCpmPrev)}) · projected`
        : t.cpm30.cpm != null
          ? "no settled month before this one"
          : "no posts to compare";
  const cpmTone = !t?.bucket ? "neutral" : t.bucket === "good" ? "emerald" : t.bucket === "bad" ? "red" : "amber";

  return (
    <>
      <PageHeader
        title={teamName}
        action={
          <div className="flex items-center gap-1.5">
            <Link href={hrefWith({ week: weekKey(previousWeek(week)) })} className={weekNav} title="Previous week">‹</Link>
            <span className="rounded-lg bg-surface-sunken px-2.5 py-1 font-mono text-[12px] tabular-nums text-neutral-700">
              {formatDateUTC(week.start.toISOString())} – {formatDateUTC(new Date(week.end.getTime() - 1).toISOString())}
              {isLatest && <span className="ml-1.5 text-neutral-400">latest</span>}
            </span>
            {canGoForward ? (
              <Link href={hrefWith({ week: weekKey(nextWeek) })} className={weekNav} title="Next week">›</Link>
            ) : (
              <span className={`${weekNav} pointer-events-none opacity-30`}>›</span>
            )}
          </div>
        }
      />

      {isStaff(profile) && teams.length > 1 && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {teams.map((g) => (
            <Link key={g.coach!} href={hrefWith({ team: g.coach })} className={chip(g.coach === group?.coach)}>
              {g.coach!.replace(/^Coach:\s*/i, "")}
            </Link>
          ))}
          <span className="ml-auto font-mono text-[11px] text-neutral-400">staff preview — this is what the coach sees</span>
        </div>
      )}

      {!group || !t ? (
        <EmptyState message={`No creators are in ${teamName} yet.`} />
      ) : (
        <div className="stagger-children space-y-5">
          <p className="text-sm text-neutral-700">
            <b className="text-neutral-900">{formatCompact(t.posts)}</b> posts ·{" "}
            <b className="text-neutral-900">{t.avgViews == null ? "—" : formatCompact(Math.round(t.avgViews))}</b> avg views ·{" "}
            <b className="text-neutral-900">{t.creators - t.belowQuota}/{t.creators}</b> hit quota ·{" "}
            <b className="text-neutral-900">{t.spikes}</b> spike{t.spikes === 1 ? "" : "s"} ·{" "}
            <b className="text-neutral-900">{silent.length}</b> didn’t post
          </p>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              label="Team CPM · 30d"
              value={cpm == null ? "—" : formatUsd(cpm)}
              sub={
                cpm == null
                  ? "no posts in 30 days"
                  : cpmProjected
                    ? "≈ projected · nothing settled yet"
                    : `${t.cpm30.paidPosts} paid posts · to ${formatDateUTC(t.cpm30.settledWindow?.end.toISOString())}${t.cpm30.lowSample ? " · low sample" : ""}`
              }
              icon="dollar"
              tone={cpmTone}
            />
            <KpiCard
              label="CPM change · lower is better"
              value={d == null ? "—" : Math.abs(d.usd) < 0.005 ? "no change" : signedUsd(d.usd)}
              sub={d == null || Math.abs(d.usd) < 0.005 ? dLabel : `${signedPct(d.pct)} ${dLabel}`}
              icon="trend"
              tone={d == null || Math.abs(d.usd) < 0.005 ? "neutral" : d.usd < 0 ? "emerald" : "red"}
            />
            <KpiCard
              label="Posts this week"
              value={`${t.posts}/${t.quota}`}
              sub={`${t.belowQuota} of ${t.creators} below quota`}
              icon="play"
              tone={t.belowQuota > 0 ? "amber" : "emerald"}
            />
            <KpiCard
              label="Avg views · this week"
              value={formatCompact(t.avgViews == null ? null : Math.round(t.avgViews))}
              sub={
                <span className="flex items-center gap-2">
                  {t.projectedCpm != null && <span>≈ {formatUsd(t.projectedCpm)} CPM</span>}
                  {t.spikes > 0 && <span>{t.spikes} spike{t.spikes === 1 ? "" : "s"}</span>}
                  <BucketChip bucket={t.bucket} projected={t.bucketSource === "projected"} />
                </span>
              }
              icon="eye"
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <Card title="Posting this week" subtitle={`Reels shipped, against the quota of ${QUOTA_POSTS_PER_WEEK}. Busiest first.`}>
              <ul className="space-y-2">
                {posting.map((r) => {
                  const w = r.performance.weekly;
                  const width = `${Math.round((w.posts / busiest) * 100)}%`;
                  const tick = `${Math.round((QUOTA_POSTS_PER_WEEK / busiest) * 100)}%`;
                  const tone = w.posts === 0 ? "bg-neutral-300" : w.belowQuota ? "bg-warning/70" : "bg-success/80";
                  return (
                    <li key={r.creatorId} className="grid grid-cols-[minmax(150px,1fr)_3fr_minmax(88px,auto)] items-center gap-3 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar name={r.handle} src={r.avatarUrl} size={24} />
                        <span className="truncate text-neutral-900">{r.launchpointName || r.displayName || `@${r.handle}`}</span>
                      </span>
                      <span className="relative h-3 rounded-full bg-neutral-900/[0.05]">
                        <span className={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width }} />
                        <span className="absolute inset-y-[-3px] w-px bg-neutral-900/30" style={{ left: tick }} title={`quota: ${QUOTA_POSTS_PER_WEEK}`} />
                      </span>
                      <span className="text-right font-mono text-[12px] tabular-nums text-neutral-600">
                        {w.posts}
                        <span className="text-neutral-400">/{w.quota}</span>
                        {w.posts > 0 && <span className="ml-1.5 text-neutral-400">{formatCompact(Math.round(w.avgViews ?? 0))} avg</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <div className="space-y-5">
              <Card title="Top posts this week">
                {topPosts.length === 0 ? (
                  <EmptyState message="No posts this week." />
                ) : (
                  <ol className="space-y-2">
                    {topPosts.map(({ row, post }, i) => (
                      <li key={post.shortcode ?? post.url}>
                        <a href={post.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg p-1 transition hover:bg-neutral-900/[0.03]">
                          {post.thumbnail ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={post.thumbnail} alt="" className="h-14 w-10 shrink-0 rounded-md object-cover ring-1 ring-black/[0.06]" />
                          ) : (
                            <span className="h-14 w-10 shrink-0 rounded-md bg-neutral-900/[0.05]" />
                          )}
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-neutral-900">
                              {i + 1}. {row.launchpointName || row.displayName || `@${row.handle}`}
                            </span>
                            <span className="block font-mono text-[11px] text-neutral-400">
                              @{row.handle} · {formatCompact(post.views)} views
                            </span>
                          </span>
                        </a>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>

              {(flagged.length > 0 || silent.length > 0) && (
                <Card title="Needs your attention">
                  <ul className="space-y-1.5 text-sm">
                    {flagged.map((r) => (
                      <li key={r.creatorId} className="flex items-center gap-2">
                        <span className="rounded-full bg-danger/[0.1] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-danger ring-1 ring-inset ring-danger/[0.22]">
                          {r.performance.badStreak}w bad
                        </span>
                        <span className="text-neutral-900">{r.launchpointName || r.displayName || `@${r.handle}`}</span>
                        <span className="text-neutral-400">— call or offboard</span>
                      </li>
                    ))}
                    {silent.map((r) => (
                      <li key={r.creatorId} className="flex items-center gap-2">
                        <span className="rounded-full bg-neutral-900/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-neutral-500">
                          0 posts
                        </span>
                        <span className="text-neutral-900">{r.launchpointName || r.displayName || `@${r.handle}`}</span>
                        <span className="text-neutral-400">— didn’t post this week</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          </div>

          <Card
            title="Your creators"
            subtitle={`${t.buckets.good} good · ${t.buckets.decent} decent · ${t.buckets.bad} bad${t.buckets.unread ? ` · ${t.buckets.unread} no read yet` : ""}${t.flagged ? ` · ${t.flagged} flagged for a call` : ""}. Bad first.`}
          >
            <div className={tableWrap}>
              <div className="min-w-[1000px]">
                <div className={`${GRID} border-b border-black/[0.05] pb-1`}>
                  {(
                    [
                      ["Creator", "creator", "asc", ""],
                      ["Posts", "posts", "desc", "text-right"],
                      ["Avg views", "views", "desc", "text-right"],
                      ["30d CPM", "cpm", "asc", "text-right"],
                      ["Change", "delta", "desc", "text-right"],
                      ["Joined", "joined", "desc", "text-right"],
                      ["Bucket", "digest", "asc", "text-right"],
                    ] as const
                  ).map(([label, key, first, align]) => (
                    <SortHeader
                      key={key}
                      as="div"
                      label={label}
                      sortKey={key}
                      active={sort.key === key}
                      dir={sort.dir}
                      hrefFor={sortHref}
                      firstDir={first}
                      className={`!px-0 ${align}`}
                    />
                  ))}
                </div>
                <div className="divide-y divide-black/[0.05]">
                  {rows.map((r) => (
                    <Row key={r.creatorId} row={r} showCoach={false} creatorHref={() => null} />
                  ))}
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

const weekNav =
  "flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-900/[0.05] hover:text-neutral-900";

const chip = (active: boolean) =>
  `rounded-full px-3 py-1 text-xs font-medium transition-colors ${
    active ? "bg-neutral-900 text-white" : "bg-neutral-900/[0.04] text-neutral-600 hover:bg-neutral-900/[0.08]"
  }`;
