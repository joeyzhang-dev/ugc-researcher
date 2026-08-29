import { Fragment } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { loadPerformanceReport, type PerformanceRow } from "@/lib/jobs/performance";
import {
  BAD_AVG_VIEWS,
  CPM_BAD_MIN_USD,
  CPM_GOOD_MAX_USD,
  DEFAULT_PAYSCALE,
  GOOD_AVG_VIEWS,
  QUOTA_POSTS_PER_WEEK,
  SPIKE_VIEWS,
  lastCompleteWeek,
  parseWeek,
  previousWeek,
  weekKey,
  type Bucket,
  type Delta,
  type Window,
} from "@/lib/performance";
import { Avatar, Card, DiscordIcon, EmptyState, PageHeader, tableWrap } from "@/components/ui";
import { formatCompact, formatDateUTC, formatUsd } from "@/lib/format";
import { compareValues, parseSort, SortHeader, type SortDir } from "@/components/sort-header";

const SORT_KEYS = ["digest", "creator", "posts", "views", "cpm", "delta", "joined"] as const;
type SortKey = (typeof SORT_KEYS)[number];

/** Header and rows share one column recipe. */
const GRID =
  "grid grid-cols-[minmax(220px,1.4fr)_minmax(90px,0.6fr)_minmax(110px,0.8fr)_minmax(120px,0.9fr)_minmax(120px,0.9fr)_minmax(90px,0.6fr)_minmax(120px,0.9fr)] items-center gap-x-3";

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
  const groups = report.groups
    .filter((g) => !coachParam || coachValue(g.coach) === coachParam)
    .map((g) => ({
      ...g,
      rows:
        sort.key === "digest"
          ? // Rows already arrive in digest order (bad → decent → good, worst
            // rise first); descending is simply that order reversed.
            sort.dir === "asc"
            ? g.rows
            : [...g.rows].reverse()
          : [...g.rows].sort((a, b) => {
              const value = (r: PerformanceRow): string | number | null => {
                const p = r.performance;
                switch (sort.key) {
                  case "posts": return p.weekly.posts;
                  case "views": return p.weekly.avgViews;
                  case "cpm": return p.cpm30.cpm ?? p.cpm30.projected;
                  case "delta": return (p.delta ?? p.projectedDelta)?.usd ?? null;
                  case "joined": return p.weeksSinceJoined;
                  default: return r.handle;
                }
              };
              return compareValues(value(a), value(b), sort.dir) || a.handle.localeCompare(b.handle);
            }),
    }));

  const nextWeek: Window = { start: week.end, end: new Date(week.end.getTime() + (week.end.getTime() - week.start.getTime())) };
  const canGoForward = nextWeek.end.getTime() <= lastCompleteWeek().end.getTime();
  const isLatest = weekKey(week) === weekKey(lastCompleteWeek());

  return (
    <>
      <PageHeader
        title="Performance"
        subtitle={`How each creator did in the week of ${formatDateUTC(week.start.toISOString())} — posts against the quota of ${QUOTA_POSTS_PER_WEEK}, views, and the rolling 30-day CPM with its change from the week before. Bad first, so the coach sees who needs the call.`}
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
              <div className="min-w-[1000px]">
                <div className={`${GRID} border-b border-black/[0.05] pb-1`}>
                  {(
                    [
                      ["Creator", "creator", "asc", ""],
                      ["Posts", "posts", "desc", "text-right"],
                      ["Avg views", "views", "desc", "text-right"],
                      ["30d CPM", "cpm", "asc", "text-right"],
                      ["vs last week", "delta", "desc", "text-right"],
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
                  {groups.map((group) => (
                    <Fragment key={group.coach ?? "none"}>
                      {!coachParam && (
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
                        <Row key={r.creatorId} row={r} />
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

function Row({ row }: { row: PerformanceRow }) {
  const p = row.performance;
  const cpm = p.cpm30.cpm ?? p.cpm30.projected;
  const projected = p.cpm30.cpm == null && p.cpm30.projected != null;
  const d = p.delta ?? p.projectedDelta;
  const dProjected = p.delta == null && p.projectedDelta != null;
  return (
    <div className={`${GRID} py-3 pr-1 transition-colors hover:bg-neutral-900/[0.03]`}>
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={row.handle} src={row.avatarUrl} size={34} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <Link
              href={`/research/${row.creatorId}`}
              className="truncate text-sm font-semibold tracking-[-0.01em] text-neutral-900 hover:underline"
            >
              {row.displayName || `@${row.handle}`}
            </Link>
            {p.flagged && (
              <span
                title={`${p.badStreak} consecutive bad weeks — coach call or offboard`}
                className="rounded-full bg-danger/[0.1] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-danger ring-1 ring-inset ring-danger/[0.22]"
              >
                {p.badStreak}w bad
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            {row.discordUserId && <DiscordIcon size={12} />}
            <a
              href={row.profileUrl ?? `https://www.instagram.com/${row.handle}/`}
              target="_blank"
              rel="noreferrer"
              className="truncate font-mono text-[11px] text-neutral-400 hover:text-neutral-700"
            >
              @{row.handle}
            </a>
          </span>
        </span>
      </div>

      <Cell
        value={`${p.weekly.posts}/${p.weekly.quota}`}
        sub={p.weekly.belowQuota ? "below quota" : "on quota"}
        tone={p.weekly.belowQuota ? "warn" : "ok"}
      />
      <Cell
        value={formatCompact(p.weekly.avgViews == null ? null : Math.round(p.weekly.avgViews))}
        sub={
          p.weekly.posts === 0
            ? "no posts"
            : (p.weekly.avgViews ?? 0) < DEFAULT_PAYSCALE.flatFeeMinViews
              ? `under ${formatCompact(DEFAULT_PAYSCALE.flatFeeMinViews)} · no flat fee`
              : `≈ ${formatUsd(p.weekly.projectedCpm)} CPM${
                  p.weekly.spikes.length > 0
                    ? ` · ${p.weekly.spikes.length} spike${p.weekly.spikes.length === 1 ? "" : "s"}`
                    : ""
                }`
        }
        href={p.weekly.bestPost?.url}
      />
      <Cell
        value={cpm == null ? "—" : formatUsd(cpm)}
        sub={
          cpm == null
            ? "no posts in 30d"
            : projected
              ? "≈ what Launchpoint will pay · nothing settled yet"
              : `${p.cpm30.paidPosts} paid · to ${formatDateUTC(p.cpm30.settledWindow?.end.toISOString())}${
                  p.cpm30.lowSample ? " · low sample" : ""
                }`
        }
        tone={projected || p.cpm30.lowSample ? "muted" : undefined}
      />
      {p.delta != null &&
      p.cpm30.settledWindow?.end.getTime() === p.cpm30Prev.settledWindow?.end.getTime() ? (
        // Same newest payout both weeks: the true number could not have
        // moved, and saying "→ $0.00" would read as a measured no-change.
        <Cell value="→" sub="no new payouts" />
      ) : (
        <DeltaCell delta={d} projected={dProjected} muted={p.cpm30.lowSample || p.cpm30Prev.lowSample} />
      )}
      <Cell
        value={p.weeksSinceJoined == null ? "—" : `${p.weeksSinceJoined}w`}
        sub={
          p.onboarding.bucket
            ? `start: ${p.onboarding.bucket}${p.onboarding.final ? "" : " (pending)"}`
            : p.onboarding.joinedAt
              ? "no first-week posts"
              : "not on Launchpoint"
        }
      />
      <div className="text-right">
        <BucketChip bucket={p.bucket} projected={p.bucketSource === "projected"} />
      </div>
    </div>
  );
}

function Cell({
  value,
  sub,
  tone,
  href,
}: {
  value: string;
  sub: string;
  tone?: "ok" | "warn" | "muted";
  href?: string;
}) {
  const subClass =
    tone === "warn" ? "text-warning" : tone === "ok" ? "text-success" : "text-neutral-400";
  return (
    <span className="text-right">
      <span
        className={`block text-[15px] font-semibold tracking-[-0.01em] tabular-nums ${
          tone === "muted" ? "text-neutral-500" : "text-neutral-900"
        }`}
      >
        {value}
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={`mt-0.5 block text-[11px] leading-tight hover:underline ${subClass}`}
        >
          {sub}
        </a>
      ) : (
        <span className={`mt-0.5 block text-[11px] leading-tight ${subClass}`}>{sub}</span>
      )}
    </span>
  );
}

/** For CPM, down is good: it costs less to reach a thousand people. A change
 *  read off fewer than three paid posts is shown but not coloured — one
 *  spike entering or leaving the sample is not a trend. */
function DeltaCell({
  delta,
  projected,
  muted,
}: {
  delta: Delta | null;
  projected: boolean;
  muted: boolean;
}) {
  if (!delta) return <Cell value="—" sub="no prior read" />;
  const flat = Math.abs(delta.usd) < 0.005;
  const tone =
    muted || flat ? "text-neutral-500" : delta.usd < 0 ? "text-success" : "text-danger";
  const arrow = flat ? "→" : delta.usd < 0 ? "▼" : "▲";
  return (
    <span className="text-right">
      <span className={`block text-[15px] font-semibold tracking-[-0.01em] tabular-nums ${tone}`}>
        {arrow} {formatUsd(Math.abs(delta.usd))}
      </span>
      <span className="mt-0.5 block text-[11px] leading-tight tabular-nums text-neutral-400">
        {delta.pct > 0 ? "+" : ""}
        {delta.pct.toFixed(1)}%{projected ? " · projected" : muted ? " · low sample" : ""}
      </span>
    </span>
  );
}

function BucketChip({ bucket, projected }: { bucket: Bucket | null; projected: boolean }) {
  if (!bucket) {
    return <span className="font-mono text-[11px] text-neutral-400">—</span>;
  }
  const tone =
    bucket === "good"
      ? "bg-success/[0.1] text-success ring-success/[0.22]"
      : bucket === "bad"
        ? "bg-danger/[0.1] text-danger ring-danger/[0.22]"
        : "bg-warning/[0.1] text-warning ring-warning/[0.22]";
  return (
    <span
      title={projected ? "From the projected CPM — nothing in the window is paid yet" : "From the true CPM"}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] ring-1 ring-inset ${tone}`}
    >
      {bucket}
      {projected && <span className="font-normal normal-case tracking-normal opacity-70">~</span>}
    </span>
  );
}
