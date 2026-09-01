import Link from "next/link";
import { getProfile, isCoach, isStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOwnCoachTeam } from "@/lib/coach-team";
import { loadPerformanceReport, type CoachGroup } from "@/lib/jobs/performance";
import {
  CPM_GOOD_MAX_USD,
  CPM_BAD_MIN_USD,
  GOOD_AVG_VIEWS,
  BAD_AVG_VIEWS,
  lastCompleteWeek,
  parseWeek,
  previousWeek,
  weekKey,
  type Window,
} from "@/lib/performance";
import { Card, EmptyState, KpiCard, PageHeader, tableWrap } from "@/components/ui";
import { BucketChip, PERFORMANCE_GRID as GRID, PerformanceRow as Row } from "@/components/performance-rows";
import { formatCompact, formatDateUTC, formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

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
  searchParams: Promise<{ week?: string; team?: string }>;
}) {
  const { week: weekParam, team: teamParam } = await searchParams;
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

  const hrefWith = (overrides: { week?: string; team?: string | null }) => {
    const sp = new URLSearchParams();
    sp.set("week", overrides.week ?? weekKey(week));
    const team = overrides.team === undefined ? (group?.coach ?? null) : overrides.team;
    if (isStaff(profile) && team) sp.set("team", team);
    return `/coach?${sp.toString()}`;
  };
  const nextWeek: Window = { start: week.end, end: new Date(week.end.getTime() + (week.end.getTime() - week.start.getTime())) };
  const canGoForward = nextWeek.end.getTime() <= lastCompleteWeek().end.getTime();
  const isLatest = weekKey(week) === weekKey(lastCompleteWeek());
  const teamName = (group?.coach ?? category ?? "Your team").replace(/^Coach:\s*/i, "");

  const t = group?.team;
  const cpm = t ? (t.cpm30.cpm ?? t.cpm30.projected) : null;
  const cpmProjected = Boolean(t && t.cpm30.cpm == null && t.cpm30.projected != null);
  const d = t ? (t.delta ?? t.projectedDelta) : null;
  const dProjected = Boolean(t && t.delta == null && t.projectedDelta != null);
  const cpmTone = !t?.bucket ? "neutral" : t.bucket === "good" ? "emerald" : t.bucket === "bad" ? "red" : "amber";

  return (
    <>
      <PageHeader
        title={teamName}
        subtitle={`Week of ${formatDateUTC(week.start.toISOString())}. Your team's CPM is the money number — dollars Launchpoint paid your creators over the views those posts got — and the bucket is judged on average views: good from ${formatCompact(GOOD_AVG_VIEWS)} a post (under ${formatUsd(CPM_GOOD_MAX_USD)}), bad at ${formatCompact(Math.round(BAD_AVG_VIEWS))} and under (over ${formatUsd(CPM_BAD_MIN_USD)}).`}
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
              label="vs last week"
              value={d == null ? "—" : `${Math.abs(d.usd) < 0.005 ? "→" : d.usd < 0 ? "▼" : "▲"} ${formatUsd(Math.abs(d.usd))}`}
              sub={d == null ? "no prior read" : `${d.pct > 0 ? "+" : ""}${d.pct.toFixed(1)}%${dProjected ? " · projected" : ""} — down is good`}
              icon="trend"
              tone={d == null || Math.abs(d.usd) < 0.005 ? "neutral" : d.usd < 0 ? "emerald" : "red"}
            />
            <KpiCard
              label="Posts this week"
              value={`${t.posts}/${t.quota}`}
              sub={`${t.belowQuota} of ${t.creators} below quota${t.trialUploads ? ` · ${t.trialUploads} trial uploads folded` : ""}`}
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

          <Card
            title="Your creators"
            subtitle={`${t.buckets.good} good · ${t.buckets.decent} decent · ${t.buckets.bad} bad${t.buckets.unread ? ` · ${t.buckets.unread} no read yet` : ""}${t.flagged ? ` · ${t.flagged} flagged for a call` : ""}. Bad first.`}
          >
            <div className={tableWrap}>
              <div className="min-w-[1000px]">
                <div className={`${GRID} border-b border-black/[0.05] pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-neutral-400`}>
                  <span>Creator</span>
                  <span className="text-right">Posts</span>
                  <span className="text-right">Avg views</span>
                  <span className="text-right">30d CPM</span>
                  <span className="text-right">vs last week</span>
                  <span className="text-right">Joined</span>
                  <span className="text-right">Bucket</span>
                </div>
                <div className="divide-y divide-black/[0.05]">
                  {group.rows.map((r) => (
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
