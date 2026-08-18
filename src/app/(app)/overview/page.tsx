import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { ResearchAppCreator, ResearchCreator, ResearchVideo } from "@/lib/types";
import {
  consistencyLabel,
  dailySeries,
  formatCallouts,
  runningTotal,
  staleCreators,
  type Consistency,
} from "@/lib/overview-stats";
import {
  Avatar, Card, EmptyState, KpiCard, PageHeader, Segmented, ViewAllLink,
} from "@/components/ui";
import { OverviewChart } from "@/components/overview-chart";
import { formatCompact } from "@/lib/format";
import { parseDays, withinWindow, RangePicker } from "@/components/range-picker";
import { ALL_APPS } from "@/lib/workspace";
import { getWorkspace } from "@/lib/workspace/server";

export const dynamic = "force-dynamic";

const MODES = [
  ["daily", "Daily"],
  ["total", "Running total"],
] as const;
type Mode = (typeof MODES)[number][0];

const parseMode = (raw: string | undefined): Mode =>
  MODES.some(([k]) => k === raw) ? (raw as Mode) : "daily";

const CONSISTENCY_TONE: Record<Consistency, string> = {
  Consistent: "text-success",
  Sporadic: "text-warning",
  Quiet: "text-neutral-400",
};

/**
 * The roster's campaign dashboard (rebuilt 2026-08-17 after the lift overview
 * merged into /research): headline totals, a posting/performance time series,
 * the top content, and the two lists that drive action — who needs a nudge and
 * who's carrying the campaign. Scoped to the rail's workspace like /creators.
 *
 * Counters are scrape-time snapshots, so the series is attributed to upload
 * day — "what the videos posted that day have done", not a daily delta.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; mode?: string }>;
}) {
  const { days: daysParam, mode: modeParam } = await searchParams;
  const days = parseDays(daysParam);
  const mode = parseMode(modeParam);

  const hrefWith = (overrides: { days?: string | null; mode?: string | null }) => {
    const sp = new URLSearchParams();
    if (days) sp.set("days", String(days));
    if (modeParam) sp.set("mode", modeParam);
    for (const [k, v] of Object.entries(overrides)) {
      if (v == null) sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    return `/overview${qs ? `?${qs}` : ""}`;
  };

  const supabase = await createClient();
  const workspace = await getWorkspace();
  const appFilter = workspace.current === ALL_APPS ? null : workspace.current;

  const [{ data: creatorsData }, { data: videosData }, { data: membershipsData }] =
    await Promise.all([
      supabase.from("research_creators").select("*").eq("kind", "roster"),
      supabase
        .from("research_videos")
        .select(
          "id, research_creator_id, url, shortcode, caption, posted_at, view_count, like_count, comment_count, share_count, thumbnail_url, format_category"
        ),
      supabase.from("research_app_creators").select("*"),
    ]);

  const memberships = (membershipsData ?? []) as ResearchAppCreator[];
  const inWorkspace = new Set(
    memberships.filter((m) => !appFilter || m.app_id === appFilter).map((m) => m.research_creator_id)
  );
  const creators = ((creatorsData ?? []) as ResearchCreator[]).filter(
    (c) => (appFilter ? inWorkspace.has(c.id) : true)
  );
  const creatorById = new Map(creators.map((c) => [c.id, c]));

  const videos = ((videosData ?? []) as ResearchVideo[]).filter((v) =>
    creatorById.has(v.research_creator_id)
  );
  const videosByCreator = new Map<string, ResearchVideo[]>();
  for (const v of videos) {
    (videosByCreator.get(v.research_creator_id) ??
      videosByCreator.set(v.research_creator_id, []).get(v.research_creator_id)!).push(v);
  }

  const windowed = withinWindow(videos, days);
  const totals = windowed.reduce(
    (t, v) => {
      t.views += v.view_count ?? 0;
      t.likes += v.like_count ?? 0;
      t.comments += v.comment_count ?? 0;
      t.shares += v.share_count ?? 0;
      return t;
    },
    { views: 0, likes: 0, comments: 0, shares: 0 }
  );
  const engagement = totals.likes + totals.comments + totals.shares;
  const engagementRate = totals.views > 0 ? (engagement / totals.views) * 100 : null;

  const series = dailySeries(windowed, days);
  const charted = mode === "total" ? runningTotal(series) : series;

  const topContent = [...windowed]
    .filter((v) => v.view_count != null)
    .sort((a, b) => b.view_count! - a.view_count!)
    .slice(0, 5);

  const attention = staleCreators(creators, videosByCreator).slice(0, 6);
  const staleTotal = staleCreators(creators, videosByCreator).length;

  const creatorTotals = creators
    .map((c) => {
      const vids = videosByCreator.get(c.id) ?? [];
      return {
        creator: c,
        views: withinWindow(vids, days).reduce((s, v) => s + (v.view_count ?? 0), 0),
        consistency: consistencyLabel(vids),
      };
    })
    .filter((r) => r.views > 0)
    .sort((a, b) => b.views - a.views);
  const top5Share =
    totals.views > 0
      ? Math.round(
          (creatorTotals.slice(0, 5).reduce((s, r) => s + r.views, 0) / totals.views) * 100
        )
      : null;

  const callouts = formatCallouts(windowed);
  const stopRatio =
    callouts.working && callouts.stop && callouts.stop.medianViews > 0
      ? callouts.working.medianViews / callouts.stop.medianViews
      : null;

  const windowLabel = days == null ? "all time" : `last ${days} days`;
  const researchHref = days
    ? `/research?pool=roster&rank=views&days=${days}`
    : "/research?pool=roster&rank=views";

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          <>
            How the roster is performing — scoped to{" "}
            <span className="font-medium text-neutral-700">
              {workspace.app?.name ?? "all apps"}
            </span>
            . Metrics are attributed to each video&apos;s upload day.
          </>
        }
        action={
          <RangePicker days={days} hrefForDays={(d) => hrefWith({ days: d ? String(d) : null })} />
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 stagger-children lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Views" value={formatCompact(totals.views)} icon="eye" tone="sky" />
        <KpiCard
          label="Engagement"
          value={formatCompact(engagement)}
          sub={engagementRate != null ? `${engagementRate.toFixed(1)}% of views` : undefined}
          icon="trend"
          tone="emerald"
        />
        <KpiCard label="Likes" value={formatCompact(totals.likes)} icon="heart" tone="pink" />
        <KpiCard label="Comments" value={formatCompact(totals.comments)} icon="users" />
        <KpiCard label="Shares" value={formatCompact(totals.shares)} icon="play" tone="violet" />
        <KpiCard label="Posts" value={formatCompact(windowed.length)} icon="badge" tone="amber" />
      </div>

      <div className="space-y-5 stagger-children">
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <Card
              title="Performance"
              subtitle={`All metrics by upload day · ${windowLabel}`}
              action={
                <Segmented
                  size="sm"
                  aria-label="Chart mode"
                  value={mode}
                  items={MODES.map(([key, label]) => ({
                    value: key,
                    label,
                    href: hrefWith({ mode: key === "daily" ? null : key }),
                  }))}
                />
              }
            >
              {windowed.length === 0 ? (
                <EmptyState message="No roster videos in this range yet." />
              ) : (
                <OverviewChart points={charted} />
              )}
            </Card>
          </div>

          <Card
            title="Top content"
            subtitle={`By views · ${windowLabel}`}
            action={<ViewAllLink href={researchHref}>View all</ViewAllLink>}
          >
            {topContent.length === 0 ? (
              <EmptyState message="Nothing to rank yet." />
            ) : (
              <ol className="divide-y divide-black/[0.05]">
                {topContent.map((v, i) => {
                  const c = creatorById.get(v.research_creator_id);
                  const title =
                    v.format_category || v.caption?.split("\n")[0] || v.shortcode || "Untitled";
                  return (
                    <li key={v.id}>
                      <a
                        href={v.url}
                        target="_blank"
                        rel="noreferrer"
                        className="group flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                      >
                        <span className="w-4 shrink-0 font-mono text-xs tabular-nums text-neutral-400">
                          {i + 1}
                        </span>
                        {v.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={v.thumbnail_url}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                            className="h-[52px] w-10 shrink-0 rounded-lg object-cover ring-1 ring-hairline"
                          />
                        ) : (
                          <span className="h-[52px] w-10 shrink-0 rounded-lg bg-surface-sunken ring-1 ring-hairline" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-neutral-900 group-hover:underline">
                            {title}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-neutral-400">
                            @{c?.handle ?? "?"}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums text-neutral-900">
                          {formatCompact(v.view_count)}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
          <Card title="Summary" subtitle="Computed from format buckets">
            {!callouts.working ? (
              <EmptyState message="Not enough categorized videos yet — transcribe and categorize some first." />
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-success">
                    What&apos;s working · format
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium text-neutral-900">
                      {callouts.working.name}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-neutral-500">
                      {formatCompact(Math.round(callouts.working.medianViews))} median
                    </span>
                  </div>
                </div>
                {callouts.stop && (
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-warning">
                      What to stop · format
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium text-neutral-900">
                        {callouts.stop.name}
                      </span>
                      <span className="shrink-0 text-sm tabular-nums text-neutral-500">
                        {Math.round(callouts.stop.shareOfPosts * 100)}% of posts
                      </span>
                    </div>
                  </div>
                )}
                {stopRatio != null && stopRatio > 1 && (
                  <p className="border-t border-black/[0.05] pt-3 text-sm leading-relaxed text-neutral-500">
                    <span className="font-medium text-neutral-700">Action:</span> lean into{" "}
                    {callouts.working.name} — its median runs {stopRatio.toFixed(1)}× above{" "}
                    {callouts.stop!.name}, which still takes{" "}
                    {Math.round(callouts.stop!.shareOfPosts * 100)}% of output.
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card
            title="Needs attention"
            subtitle="Quiet for 4+ days"
            action={
              staleTotal > 0 ? (
                <span className="rounded-full bg-warning/[0.12] px-2 py-0.5 text-[11px] font-medium text-warning ring-1 ring-inset ring-warning/[0.24]">
                  {staleTotal} to nudge
                </span>
              ) : undefined
            }
          >
            {attention.length === 0 ? (
              <EmptyState message="Everyone has posted recently. 🎉" />
            ) : (
              <>
                <ul className="divide-y divide-black/[0.05]">
                  {attention.map(({ creator: c, daysSince, totalViews }) => (
                    <li key={c.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                      <Avatar name={c.handle} src={c.avatar_url} size={32} />
                      <span className="min-w-0 flex-1">
                        <Link
                          href={`/research/${c.id}`}
                          className="block truncate text-sm font-medium text-neutral-900 hover:underline"
                        >
                          {c.display_name || `@${c.handle}`}
                        </Link>
                        <span
                          className={`mt-0.5 block text-xs ${
                            daysSince == null ? "text-danger" : "text-warning"
                          }`}
                        >
                          {daysSince == null ? "No posts yet" : `Last posted ${daysSince} days ago`}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm tabular-nums text-neutral-500">
                        {formatCompact(totalViews)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 border-t border-black/[0.05] pt-3">
                  <ViewAllLink href="/creators">Reach out on Our creators</ViewAllLink>
                </div>
              </>
            )}
          </Card>

          <Card title="Top creators" subtitle={`By views · ${windowLabel}`}>
            {creatorTotals.length === 0 ? (
              <EmptyState message="No creator views in this range." />
            ) : (
              <>
                <ol className="divide-y divide-black/[0.05]">
                  {creatorTotals.slice(0, 6).map(({ creator: c, views, consistency }, i) => (
                    <li key={c.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="w-4 shrink-0 font-mono text-xs tabular-nums text-neutral-400">
                        {i + 1}
                      </span>
                      <Avatar name={c.handle} src={c.avatar_url} size={32} />
                      <span className="min-w-0 flex-1">
                        <Link
                          href={`/research/${c.id}`}
                          className="block truncate text-sm font-medium text-neutral-900 hover:underline"
                        >
                          {c.display_name || `@${c.handle}`}
                        </Link>
                        <span className={`mt-0.5 block text-xs ${CONSISTENCY_TONE[consistency]}`}>
                          {consistency}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-neutral-900">
                        {formatCompact(views)}
                      </span>
                    </li>
                  ))}
                </ol>
                {top5Share != null && (
                  <p className="mt-3 border-t border-black/[0.05] pt-3 text-xs text-neutral-400">
                    Top 5 drove {top5Share}% of views.
                  </p>
                )}
              </>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
