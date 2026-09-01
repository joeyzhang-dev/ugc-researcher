import { Fragment } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { loadPerformanceReport, type PerformanceRow } from "@/lib/jobs/performance";
import {
  BAD_AVG_VIEWS,
  BUCKET_ORDER,
  CPM_BAD_MIN_USD,
  CPM_GOOD_MAX_USD,
  comparePerformance,
  DEFAULT_PAYSCALE,
  GOOD_AVG_VIEWS,
  QUOTA_POSTS_PER_WEEK,
  SPIKE_VIEWS,
  lastCompleteWeek,
  parseWeek,
  previousWeek,
  weekKey,
  type Window,
} from "@/lib/performance";
import { Card, EmptyState, PageHeader, tableWrap } from "@/components/ui";
import { formatCompact, formatDateUTC, formatUsd } from "@/lib/format";
import { compareValues, parseSort, SortHeader, type SortDir } from "@/components/sort-header";
import { PERFORMANCE_GRID as GRID, PerformanceRow as Row } from "@/components/performance-rows";

const SORT_KEYS = ["digest", "median", "creator", "posts", "views", "cpm", "delta", "joined"] as const;
type SortKey = (typeof SORT_KEYS)[number];


export const dynamic = "force-dynamic";

/** The weekly coach view: who posted, who got views, whose CPM is moving.
 *  Same numbers the Discord digest sends — both read
 *  `loadPerformanceReport`. */
export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; coach?: string; sort?: string; dir?: string }>;
}) {
  const { week: weekParam, coach: coachParam, sort: sortParam, dir: dirParam } = await searchParams;
  const week: Window = parseWeek(weekParam) ?? lastCompleteWeek();
  const sort = parseSort<SortKey>(sortParam, dirParam, SORT_KEYS, { key: "digest", dir: "asc" });
  const supabase = await createClient();
  const report = await loadPerformanceReport(supabase, week);

  const hrefWith = (overrides: { week?: string | null; coach?: string | null; sort?: string | null; dir?: string | null }) => {
    const sp = new URLSearchParams();
    sp.set("week", weekKey(week));
    if (coachParam) sp.set("coach", coachParam);
    if (sortParam) sp.set("sort", sortParam);
    if (dirParam) sp.set("dir", dirParam);
    for (const [k, v] of Object.entries(overrides)) {
      if (v == null) sp.delete(k);
      else sp.set(k, v);
    }
    return `/performance?${sp.toString()}`;
  };
  const sortHref = (key: SortKey, dir: SortDir) => hrefWith({ sort: key, dir });

  // "No coach" needs a real value in the URL — an empty string reads as
  // "no filter", so the coachless group gets a sentinel.
  const NO_COACH = "none";
  const coachValue = (coach: string | null) => coach ?? NO_COACH;
  const coaches = report.groups.map((g) => g.coach);
  const visible = report.groups.filter((g) => !coachParam || coachValue(g.coach) === coachParam);

  // Rows arrive in digest order (bad → decent → good → no read, worst rise
  // first inside a bucket). Any explicit sort is applied to the WHOLE table:
  // sorting inside each coach band looked broken, because a coach's good
  // creators stayed under that coach's heading instead of rising to the top.
  // So the bands only show in the default order; a sorted table is flat and
  // names the coach on each row instead.
  const sorted = Boolean(sortParam);
  const value = (r: PerformanceRow): string | number | null => {
    const p = r.performance;
    switch (sort.key) {
      case "digest": return p.bucket ? BUCKET_ORDER[p.bucket] : null;
      case "median": return p.medianBucket ? BUCKET_ORDER[p.medianBucket] : null;
    case "median": return p.medianBucket ? BUCKET_ORDER[p.medianBucket] : null;
      case "posts": return p.weekly.posts;
      case "views": return p.weekly.avgViews;
      case "cpm": return p.cpm30.cpm ?? p.cpm30.projected;
      case "delta": return (p.delta ?? p.projectedDelta)?.usd ?? null;
      case "joined": return p.weeksSinceJoined;
      default: return r.handle;
    }
  };
  const groups = sorted
    ? [
        {
          coach: null as string | null,
          rows: visible
            .flatMap((g) => g.rows)
            .sort(
              (a, b) =>
                // Nulls always sink, whichever direction — compareValues does that.
                compareValues(value(a), value(b), sort.dir) ||
                // Inside a bucket keep the digest's "worst rise first".
                (sort.key === "digest" ? comparePerformance(a.performance, b.performance) : 0) ||
                a.handle.localeCompare(b.handle)
            ),
        },
      ]
    : visible;

  const nextWeek: Window = { start: week.end, end: new Date(week.end.getTime() + (week.end.getTime() - week.start.getTime())) };
  const canGoForward = nextWeek.end.getTime() <= lastCompleteWeek().end.getTime();
  const isLatest = weekKey(week) === weekKey(lastCompleteWeek());

  return (
    <>
      <PageHeader
        title="Performance"
        subtitle={`How each creator did in the week of ${formatDateUTC(week.start.toISOString())} — posts against the quota of ${QUOTA_POSTS_PER_WEEK}, views, and the rolling 30-day CPM with how it moved against the settled month before (or this week's posts against last week's, where nothing is paid yet). Bad first, so the coach sees who needs the call.`}
        action={
          <div className="flex items-center gap-1.5">
            <Link href={hrefWith({ week: weekKey(previousWeek(week)) })} className={weekNav} title="Previous week">
              ‹
            </Link>
            <span className="rounded-lg bg-surface-sunken px-2.5 py-1 font-mono text-[12px] tabular-nums text-neutral-700">
              {formatDateUTC(week.start.toISOString())} – {formatDateUTC(new Date(week.end.getTime() - 1).toISOString())}
              {isLatest && <span className="ml-1.5 text-neutral-400">latest</span>}
            </span>
            {canGoForward ? (
              <Link href={hrefWith({ week: weekKey(nextWeek) })} className={weekNav} title="Next week">
                ›
              </Link>
            ) : (
              <span className={`${weekNav} pointer-events-none opacity-30`}>›</span>
            )}
          </div>
        }
      />

      <div className="stagger-children space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={hrefWith({ coach: null })} className={chip(!coachParam)}>
            All coaches
          </Link>
          {coaches.map((c) => (
            <Link key={coachValue(c)} href={hrefWith({ coach: coachValue(c) })} className={chip(coachParam === coachValue(c))}>
              {c ?? "No coach"}
            </Link>
          ))}
          <span className="ml-auto font-mono text-[11px] text-neutral-400">
            {report.totals.creators} creators · {report.totals.belowQuota} below quota · {report.totals.flagged} flagged
          </span>
        </div>

        <Card
          title="Weekly read"
          subtitle={`Good from ${formatCompact(GOOD_AVG_VIEWS)} avg views a post (CPM under ${formatUsd(CPM_GOOD_MAX_USD)}), bad at ${formatCompact(Math.round(BAD_AVG_VIEWS))} and under (CPM over ${formatUsd(CPM_BAD_MIN_USD)}). A spike is a post at ${formatCompact(SPIKE_VIEWS)}+ views. 30d CPM is true (paid ÷ views of paid posts) over the 30 days ending at the creator's newest payout; ≈ figures are what Launchpoint will pay once it settles (about 3 weeks after posting). With a $${DEFAULT_PAYSCALE.flatFeeUsd} flat fee per post, a CPM under ${formatUsd(CPM_GOOD_MAX_USD)} means ${formatCompact(GOOD_AVG_VIEWS)}+ views on every post — a 1.5k-view post costs ~$28 per 1k no matter what.`}
        >
          {groups.every((g) => g.rows.length === 0) ? (
            <EmptyState message="No roster creators to read." />
          ) : (
            <div className={tableWrap}>
              <div className="min-w-[1100px]">
                <div className={`${GRID} border-b border-black/[0.05] pb-1`}>
                  {(
                    [
                      ["Creator", "creator", "asc", ""],
                      ["Posts", "posts", "desc", "text-right"],
                      ["Avg views", "views", "desc", "text-right"],
                      ["30d CPM", "cpm", "asc", "text-right"],
                      ["Trend", "delta", "desc", "text-right"],
                      ["Joined", "joined", "desc", "text-right"],
                      ["30d rating", "digest", "asc", "text-right"],
                      ["Median rating", "median", "asc", "text-right"],
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
                  {groups.map((group) => (
                    <Fragment key={group.coach ?? "none"}>
                      {!coachParam && !sorted && (
                        <div className="flex items-center gap-2.5 bg-surface-sunken px-1 py-2">
                          <span className="text-sm font-semibold tracking-[-0.01em] text-neutral-900">
                            {group.coach ?? "No coach"}
                          </span>
                          <span className="font-mono text-[11px] text-neutral-400">
                            {group.rows.length} creator{group.rows.length === 1 ? "" : "s"}
                            {" · "}
                            {group.rows.filter((r) => r.performance.bucket === "bad").length} bad
                          </span>
                        </div>
                      )}
                      {group.rows.map((r) => (
                        <Row key={r.creatorId} row={r} showCoach={sorted && !coachParam} creatorHref={(row) => `/research/${row.creatorId}`} />
                      ))}
                    </Fragment>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>

        {report.parked.length > 0 && (
          <p className="text-xs text-neutral-400">
            Skipped {report.parked.length} parked in “Not Creating”:{" "}
            {report.parked.map((p) => `@${p.handle}`).join(", ")}
          </p>
        )}
      </div>
    </>
  );
}

const weekNav =
  "flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-900/[0.05] hover:text-neutral-900";

const chip = (active: boolean) =>
  `rounded-full px-3 py-1 text-xs font-medium transition-colors ${
    active
      ? "bg-neutral-900 text-white"
      : "bg-neutral-900/[0.04] text-neutral-600 hover:bg-neutral-900/[0.08]"
  }`;
