import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { ResearchCreator, ResearchVideo } from "@/lib/types";
import { median, summarizeCreator, type VideoLift } from "@/lib/research";
import {
  autoCategorizeFormats,
  rescrapeResearchCreator,
  retryFailedTranscripts,
} from "../actions";
import { SubmitButton } from "@/components/submit-button";
import {
  Avatar, Card, EmptyState, KpiCard, PageHeader, PlatformIcon, StatusBadge,
  secondaryButtonClass, table, tableWrap, td, th, trHover,
} from "@/components/ui";
import { formatCompact, formatDate } from "@/lib/format";
import { HoverVideo } from "@/components/hover-video";
import {
  ResearchSelectTrigger,
  ResearchVideoPanel,
  type PanelSegment,
} from "@/components/research-panel";

export const dynamic = "force-dynamic";
// Re-scrape runs a deep Apify pull inline.
export const maxDuration = 300;

function scoreStyle(score: number): string {
  if (score >= 8) return "bg-amber-100 text-amber-800";
  if (score >= 6.5) return "bg-emerald-50 text-emerald-700";
  if (score >= 4) return "bg-neutral-100 text-neutral-600";
  return "bg-red-50 text-red-600";
}

function ScoreChip({ score }: { score: number | null }) {
  if (score == null) return <span className="text-xs text-neutral-400">—</span>;
  return (
    <span
      className={`inline-flex min-w-9 items-center justify-center rounded-md px-1.5 py-0.5 text-xs font-bold tabular-nums ${scoreStyle(score)}`}
    >
      {score.toFixed(1)}
    </span>
  );
}

const TRANSCRIPT_STYLES: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700",
  fetching: "bg-sky-50 text-sky-700",
  transcribed: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  skipped: "bg-neutral-100 text-neutral-400",
};

function fmtLift(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(2)}×`;
}

/** Label used for the filter value of videos with no detected format. */
const UNCATEGORIZED = "(uncategorized)";

export default async function ResearchCreatorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ format?: string; view?: string }>;
}) {
  const { id } = await params;
  const { format: formatFilter, view } = await searchParams;
  const isGrid = view === "grid";
  const supabase = await createClient();

  const hrefWith = (overrides: { format?: string | null; view?: string | null }) => {
    const sp = new URLSearchParams();
    if (formatFilter) sp.set("format", formatFilter);
    if (view) sp.set("view", view);
    for (const [k, v] of Object.entries(overrides)) {
      if (v == null) sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    return `/research/${id}${qs ? `?${qs}` : ""}`;
  };

  const [{ data: creatorData }, { data: videosData }] = await Promise.all([
    supabase.from("research_creators").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("research_videos")
      .select(
        "id, research_creator_id, url, shortcode, caption, hashtags, posted_at, view_count, like_count, comment_count, share_count, thumbnail_url, video_url, transcript_status, transcript_method, transcript_text, format_category, error_message"
      )
      .eq("research_creator_id", id),
  ]);
  const creator = creatorData as ResearchCreator | null;
  if (!creator) notFound();

  const videos = (videosData ?? []) as ResearchVideo[];

  // Timestamped transcript lines for the panel (WhisperX segments).
  const { data: segmentsData } = await supabase
    .from("research_video_segments")
    .select("research_video_id, position, start_time, text")
    .in("research_video_id", videos.map((v) => v.id))
    .order("position", { ascending: true });
  const segmentsByVideo: Record<string, PanelSegment[]> = {};
  for (const s of (segmentsData ?? []) as (PanelSegment & { research_video_id: string })[]) {
    (segmentsByVideo[s.research_video_id] ??= []).push({
      position: s.position,
      start_time: s.start_time,
      text: s.text,
    });
  }
  const summary = summarizeCreator(videos);
  const transcribed = videos.filter((v) => v.transcript_status === "transcribed").length;
  const failedTranscripts = videos.filter((v) => v.transcript_status === "failed").length;

  // Format rollup: median score/lift per format, best first; uncategorized
  // videos get their own trailing bucket so the filter covers every video.
  const formatOf = (row: VideoLift) => row.video.format_category ?? UNCATEGORIZED;
  const byFormat = new Map<string, VideoLift[]>();
  for (const row of summary.videos) {
    const key = formatOf(row);
    (byFormat.get(key) ?? byFormat.set(key, []).get(key)!).push(row);
  }
  const formatRollup = [...byFormat.entries()]
    .map(([name, rows]) => ({
      name,
      count: rows.length,
      medianScore: median(rows.map((r) => r.score).filter((n): n is number => n != null)),
      medianLift: median(rows.map((r) => r.lift).filter((n): n is number => n != null)),
      medianViews: median(
        rows.map((r) => r.video.view_count).filter((n): n is number => n != null)
      ),
      best: rows.reduce<VideoLift | null>(
        (best, r) => (r.lift != null && (best?.lift == null || r.lift > best.lift) ? r : best),
        null
      ),
    }))
    .sort((a, b) => {
      if ((a.name === UNCATEGORIZED) !== (b.name === UNCATEGORIZED)) {
        return a.name === UNCATEGORIZED ? 1 : -1;
      }
      return (b.medianScore ?? -1) - (a.medianScore ?? -1);
    });

  const visibleVideos = formatFilter
    ? summary.videos.filter((r) => formatOf(r) === formatFilter)
    : summary.videos;

  return (
    <>
      <PageHeader
        title={`@${creator.handle}`}
        action={
          <span className="flex items-center gap-2">
            <form action={retryFailedTranscripts.bind(null, creator.id)}>
              <SubmitButton pendingLabel="Requeueing…" className={secondaryButtonClass}>
                Retry failed transcripts{failedTranscripts > 0 ? ` (${failedTranscripts})` : ""}
              </SubmitButton>
            </form>
            <form action={rescrapeResearchCreator.bind(null, creator.id)}>
              <SubmitButton pendingLabel="Scraping…" className={secondaryButtonClass}>
                Re-scrape
              </SubmitButton>
            </form>
            <Link href="/research" className={secondaryButtonClass}>
              ← Research
            </Link>
          </span>
        }
      />

      <div className="-mt-4 mb-5 flex items-center gap-3">
        <Avatar name={creator.handle} src={creator.avatar_url} size={40} />
        <span>
          <span className="flex items-center gap-2 text-sm font-medium text-neutral-800">
            {creator.display_name ?? `@${creator.handle}`}
            <PlatformIcon platform={creator.platform} size={14} />
            <StatusBadge status={creator.status} />
          </span>
          <span className="mt-0.5 block text-xs text-neutral-500">
            {creator.profile_url && (
              <a
                href={creator.profile_url}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {creator.profile_url}
              </a>
            )}
            {creator.last_scraped_at && ` · last scraped ${formatDate(creator.last_scraped_at)}`}
          </span>
        </span>
      </div>

      {creator.status === "failed" && creator.error_message && (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm text-red-700">
          Last scrape failed: {creator.error_message}
        </p>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-6">
        <KpiCard label="Followers" value={formatCompact(creator.follower_count)} icon="users" />
        <KpiCard label="Videos" value={String(summary.videoCount)} icon="play" />
        <KpiCard
          label="Median views"
          value={formatCompact(summary.medianViews)}
          sub={summary.meanViews != null ? `mean ${formatCompact(Math.round(summary.meanViews))}` : undefined}
          icon="eye"
        />
        <KpiCard
          label="Rated 8.0+"
          value={String(summary.topRated)}
          sub={summary.medianScore != null ? `median ${summary.medianScore.toFixed(1)}` : undefined}
          tone="amber"
          icon="trend"
        />
        <KpiCard
          label="Median engagement"
          value={
            summary.medianEngagementPct != null
              ? `${summary.medianEngagementPct.toFixed(1)}%`
              : "—"
          }
          icon="heart"
        />
        <KpiCard
          label="Transcribed"
          value={`${transcribed}/${summary.videoCount}`}
          sub={failedTranscripts > 0 ? `${failedTranscripts} failed` : undefined}
          tone={transcribed === summary.videoCount && summary.videoCount > 0 ? "emerald" : "neutral"}
          icon="check"
        />
      </div>

      <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
      <div className="mb-5">
        <Card
          title="Formats by median score"
          action={
            <form action={autoCategorizeFormats.bind(null, creator.id)}>
              <SubmitButton pendingLabel="Categorizing…" className={secondaryButtonClass}>
                Auto-categorize
              </SubmitButton>
            </form>
          }
        >
          {formatRollup.length === 0 ? (
            <EmptyState message="No formats detected yet — run Auto-categorize (works best once transcripts are in)." />
          ) : (
            <div className={tableWrap}>
              <table className={table}>
                <thead>
                  <tr>
                    <th className={th}>Format</th>
                    <th className={th}>Videos</th>
                    <th className={th}>Median score</th>
                    <th className={th}>Median lift</th>
                    <th className={th}>Median views</th>
                    <th className={th}>Best video</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {formatRollup.map((f) => {
                    const active = formatFilter === f.name;
                    return (
                      <tr key={f.name} className={active ? "bg-amber-50/60" : trHover}>
                        <td className={`${td} font-medium`}>
                          <Link
                            href={hrefWith({ format: active ? null : f.name })}
                            className={`inline-flex items-center gap-1.5 underline-offset-2 hover:underline ${
                              f.name === UNCATEGORIZED ? "text-neutral-400" : "text-neutral-900"
                            }`}
                            title={active ? "Clear filter" : `Show only ${f.name} videos`}
                          >
                            {f.name}
                            {active && (
                              <span className="rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-800">
                                filtering ✕
                              </span>
                            )}
                          </Link>
                        </td>
                        <td className={`${td} tabular-nums`}>{f.count}</td>
                        <td className={td}>
                          <ScoreChip score={f.medianScore} />
                        </td>
                        <td className={`${td} tabular-nums`}>{fmtLift(f.medianLift)}</td>
                        <td className={`${td} tabular-nums`}>{formatCompact(f.medianViews)}</td>
                        <td className={`${td} max-w-72`}>
                          {f.best && (
                            <a
                              href={f.best.video.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block truncate text-xs text-neutral-500 underline-offset-2 hover:underline"
                            >
                              {f.best.video.caption?.split("\n")[0] || f.best.video.url}{" "}
                              ({fmtLift(f.best.lift)})
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-neutral-400">
            Click a format to filter the videos below. Detection improves as transcripts land —
            hit Auto-categorize after the worker finishes.
          </p>
        </Card>
      </div>

      <Card
        title={formatFilter ? `Videos by score — ${formatFilter}` : "Videos by score"}
        action={
          <span className="flex items-center gap-3">
            {formatFilter && (
              <Link
                href={hrefWith({ format: null })}
                className="text-xs font-medium text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline"
              >
                Clear filter ({visibleVideos.length} of {summary.videos.length}) ✕
              </Link>
            )}
            <span className="inline-flex shrink-0 rounded-lg border border-neutral-200 bg-white p-0.5 text-xs">
              <Link
                href={hrefWith({ view: null })}
                scroll={false}
                className={`rounded-md px-2.5 py-1 transition-colors ${!isGrid ? "bg-neutral-900 font-medium text-white" : "text-neutral-500 hover:text-neutral-900"}`}
              >
                Table
              </Link>
              <Link
                href={hrefWith({ view: "grid" })}
                scroll={false}
                className={`rounded-md px-2.5 py-1 transition-colors ${isGrid ? "bg-neutral-900 font-medium text-white" : "text-neutral-500 hover:text-neutral-900"}`}
              >
                Grid
              </Link>
            </span>
          </span>
        }
      >
        <p className="-mt-1 mb-3 text-xs text-neutral-500">
          Score = 0–10 rating of a video&apos;s lift vs the creator&apos;s own baseline (median
          views of the ~10 prior posts; account-wide median for the earliest). 5.0 = performed at
          baseline, +2 per doubling: 7.0 = 2×, 8.0 ≈ 2.8×, 10 ≥ 5.7×.
        </p>
        {videos.length === 0 ? (
          <EmptyState message="No videos scraped yet." />
        ) : visibleVideos.length === 0 ? (
          <EmptyState message={`No videos in "${formatFilter}".`} />
        ) : isGrid ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
            {visibleVideos.map((row) => {
              const v = row.video;
              return (
                <ResearchSelectTrigger
                  key={v.id}
                  row={row}
                  className="group flex h-full w-full flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white text-left transition hover:border-neutral-300 hover:shadow-sm"
                  selectedClassName="!border-neutral-900 ring-2 ring-neutral-900 ring-offset-2"
                >
                  <div className="relative aspect-[3/4] w-full bg-neutral-100">
                    <HoverVideo src={v.video_url} poster={v.thumbnail_url} />
                    {/* Scrim + info fade out while the hover preview plays. */}
                    <span className="pointer-events-none absolute inset-0 bg-black/35 transition-opacity duration-200 group-hover:opacity-0" />
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1 p-3 text-white transition-opacity duration-200 group-hover:opacity-0">
                      <span className="flex items-center justify-between text-base font-semibold tabular-nums drop-shadow">
                        <span className="inline-flex items-center gap-1">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                          {formatCompact(v.view_count)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 21C7 16.5 3 13.3 3 9.3 3 6.4 5.2 4 8 4c1.6 0 3.1.8 4 2 1-1.2 2.4-2 4-2 2.8 0 5 2.4 5 5.3 0 4-4 7.2-9 11.7Z" /></svg>
                          {formatCompact(v.like_count)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a8 8 0 0 1-8 8H4l2.5-2.5A8 8 0 1 1 21 12Z" /></svg>
                          {formatCompact(v.comment_count)}
                        </span>
                      </span>
                      <span className="text-[11px] font-semibold text-sky-200 drop-shadow">
                        {formatDate(v.posted_at)}
                      </span>
                      <span className="line-clamp-2 text-xs leading-snug text-white/95 drop-shadow">
                        {v.caption?.split("\n")[0] || v.shortcode || "—"}
                      </span>
                    </span>
                    <span className="absolute right-2 top-2 shadow-sm">
                      <ScoreChip score={row.score} />
                    </span>
                    {v.format_category && (
                      <span className="absolute left-2 top-2 max-w-[70%] truncate rounded-md bg-white/95 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 shadow-sm">
                        {v.format_category}
                      </span>
                    )}
                  </div>
                </ResearchSelectTrigger>
              );
            })}
          </div>
        ) : (
          <div className={tableWrap}>
            <table className={table}>
              <thead>
                <tr>
                  <th className={th}>Score</th>
                  <th className={th}>Video</th>
                  <th className={th}>Posted</th>
                  <th className={th}>Views</th>
                  <th className={th}>Lift</th>
                  <th className={th}>±45d</th>
                  <th className={th}>Eng %</th>
                  <th className={th}>Likes</th>
                  <th className={th}>Comments</th>
                  <th className={th}>Shares</th>
                  <th className={th}>Hashtags</th>
                  <th className={th}>Transcript</th>
                  <th className={th}>Format</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {visibleVideos.map((row: VideoLift) => {
                  const v = row.video;
                  return (
                    <tr key={v.id} className={trHover}>
                      <td className={td}>
                        <ScoreChip score={row.score} />
                      </td>
                      <td className={`${td} max-w-80`}>
                        <span className="flex items-center gap-1.5">
                          <ResearchSelectTrigger
                            row={row}
                            className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                          >
                            {v.thumbnail_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={v.thumbnail_url} alt="" className="h-11 w-8 shrink-0 rounded-md object-cover" />
                            ) : (
                              <span className="flex h-11 w-8 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-300">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m10 9 5 3-5 3V9Z" /></svg>
                              </span>
                            )}
                            <span
                              className="min-w-0 truncate text-sm font-medium text-neutral-900 hover:underline"
                              title={v.caption ?? v.url}
                            >
                              {v.caption?.split("\n")[0] || v.shortcode || v.url}
                            </span>
                          </ResearchSelectTrigger>
                          <a
                            href={v.url}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 text-xs text-neutral-400 hover:text-neutral-700"
                            title="Open original reel"
                          >
                            ↗
                          </a>
                        </span>
                      </td>
                      <td className={`${td} whitespace-nowrap`}>{formatDate(v.posted_at)}</td>
                      <td className={`${td} tabular-nums font-medium`}>
                        {formatCompact(v.view_count)}
                      </td>
                      <td className={`${td} tabular-nums font-semibold`}>
                        {fmtLift(row.lift)}
                        {row.liftBasis === "overall" && (
                          <span className="ml-1 text-[10px] font-normal text-neutral-400" title="Not enough prior posts — lift vs account-wide median">
                            (overall)
                          </span>
                        )}
                      </td>
                      <td className={`${td} tabular-nums text-neutral-500`}>
                        {fmtLift(row.windowLift)}
                      </td>
                      <td className={`${td} tabular-nums`}>
                        {row.engagementPct != null ? `${row.engagementPct.toFixed(1)}%` : "—"}
                      </td>
                      <td className={`${td} tabular-nums`}>{formatCompact(v.like_count)}</td>
                      <td className={`${td} tabular-nums`}>{formatCompact(v.comment_count)}</td>
                      <td className={`${td} tabular-nums`}>{formatCompact(v.share_count)}</td>
                      <td className={`${td} max-w-56`}>
                        <span className="block truncate text-xs text-neutral-500" title={v.hashtags.join(" ")}>
                          {v.hashtags.length > 0
                            ? v.hashtags.slice(0, 4).map((h) => `#${h}`).join(" ") +
                              (v.hashtags.length > 4 ? ` +${v.hashtags.length - 4}` : "")
                            : "—"}
                        </span>
                      </td>
                      <td className={td}>
                        <span
                          className={`inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${
                            TRANSCRIPT_STYLES[v.transcript_status] ?? "bg-neutral-100 text-neutral-600"
                          }`}
                          title={v.error_message ?? v.transcript_method ?? undefined}
                        >
                          {v.transcript_status}
                        </span>
                      </td>
                      <td className={td}>
                        {v.format_category ? (
                          <Link
                            href={hrefWith({
                              format:
                                formatFilter === v.format_category ? null : v.format_category,
                            })}
                            className="inline-block whitespace-nowrap rounded-md bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 hover:bg-violet-100"
                            title={
                              formatFilter === v.format_category
                                ? "Clear filter"
                                : `Show only ${v.format_category} videos`
                            }
                          >
                            {v.format_category}
                          </Link>
                        ) : (
                          <span className="text-xs text-neutral-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      </div>

      <ResearchVideoPanel segmentsByVideo={segmentsByVideo} />
      </div>
    </>
  );
}
