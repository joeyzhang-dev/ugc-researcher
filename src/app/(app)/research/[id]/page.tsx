import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { ResearchCreator, ResearchVideo } from "@/lib/types";
import { median, summarizeCreator, type VideoLift } from "@/lib/research";
import {
  autoCategorizeFormats,
  queueAiCategorization,
  rescrapeResearchCreator,
  retryFailedTranscripts,
} from "../actions";
import { SubmitButton } from "@/components/submit-button";
import {
  Avatar, Card, EmptyState, KpiCard, PageHeader, PlatformIcon, Segmented, StatusBadge,
  secondaryButtonClass, table, tableWrap, td, th, trHover,
} from "@/components/ui";
import { formatCompact, formatDate } from "@/lib/format";
import { parseDays, withinWindow, RangePicker } from "@/components/range-picker";
import { Thumb } from "@/components/hover-video";
import { ResearchVideoTile } from "@/components/research-video-tile";
import { loadViewCurves, videoSelect } from "@/lib/video-metrics";
import {
  FormatTag,
  ResearchScoreChip,
  ResearchSelectTrigger,
  ResearchVideoPanel,
  type PanelSegment,
} from "@/components/research-panel";

export const dynamic = "force-dynamic";
// Re-scrape runs a full profile pull inline.
export const maxDuration = 300;

// transcript_status → semantic tone for the shared StatusBadge pill.
const TRANSCRIPT_TONE: Record<string, "warning" | "info" | "success" | "danger" | "muted"> = {
  pending: "warning",
  fetching: "info",
  transcribed: "success",
  failed: "danger",
  skipped: "muted",
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
  searchParams: Promise<{ format?: string; view?: string; days?: string }>;
}) {
  const { id } = await params;
  const { format: formatFilter, view, days: daysParam } = await searchParams;
  const days = parseDays(daysParam);
  const isGrid = view === "grid";
  const supabase = await createClient();
  // Falls back to the base column list when the Launchpoint migration has
  // not been applied yet, so a lagging schema hides chips instead of 400ing
  // the whole page.
  const VIDEO_SELECT = await videoSelect(
    supabase,
    "id, research_creator_id, url, shortcode, caption, hashtags, posted_at, view_count, like_count, comment_count, share_count, thumbnail_url, video_url, transcript_status, transcript_method, transcript_text, format_category, format_llm_status, format_llm_reasoning, format_llm_model, format_categorized_at, error_message"
  );

  const hrefWith = (overrides: {
    format?: string | null;
    view?: string | null;
    days?: string | null;
  }) => {
    const sp = new URLSearchParams();
    if (formatFilter) sp.set("format", formatFilter);
    if (view) sp.set("view", view);
    if (days) sp.set("days", String(days));
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
        VIDEO_SELECT
      )
      .eq("research_creator_id", id),
  ]);
  const creator = creatorData as ResearchCreator | null;
  if (!creator) notFound();

  // Recency filter: every metric below (lift, KPIs, format rollup, list) is
  // computed on just the videos posted within the selected window.
  // Through `unknown`: the select list is built at runtime (the Launchpoint
  // columns are only named when the schema has them), so supabase-js cannot
  // infer a row type from it. The rows are ResearchVideo either way — the
  // Launchpoint fields are simply absent before the migration, and every
  // reader already treats them as nullable.
  const videos = withinWindow((videosData ?? []) as unknown as ResearchVideo[], days);

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
  const curvesByVideo = await loadViewCurves(supabase, videos.map((v) => v.id));
  const summary = summarizeCreator(videos);
  const transcribed = videos.filter((v) => v.transcript_status === "transcribed").length;
  const failedTranscripts = videos.filter((v) => v.transcript_status === "failed").length;
  const aiQueued = videos.filter((v) => v.format_llm_status === "pending").length;

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
            <RangePicker
              days={days}
              hrefForDays={(d) => hrefWith({ days: d ? String(d) : null })}
            />
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
            {creator.kind === "roster" ? (
              <Link href="/creators" className={secondaryButtonClass}>
                ← Our creators
              </Link>
            ) : (
              <Link href="/research" className={secondaryButtonClass}>
                ← Research
              </Link>
            )}
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
        <p className="mb-4 rounded-xl bg-danger/[0.08] p-2.5 text-sm text-danger ring-1 ring-inset ring-danger/[0.22]">
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
            <span className="flex items-center gap-2">
              <form action={autoCategorizeFormats.bind(null, creator.id)}>
                <SubmitButton pendingLabel="Categorizing…" className={secondaryButtonClass}>
                  Quick regex
                </SubmitButton>
              </form>
              <form action={queueAiCategorization.bind(null, creator.id)}>
                <SubmitButton pendingLabel="Queueing…" className={secondaryButtonClass}>
                  Categorize with AI ✦
                </SubmitButton>
              </form>
            </span>
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
                <tbody className="divide-y divide-black/[0.05]">
                  {formatRollup.map((f) => {
                    const active = formatFilter === f.name;
                    return (
                      <tr key={f.name} className={active ? "bg-violet-500/[0.05]" : trHover}>
                        <td className={`${td} font-medium`}>
                          <Link
                            href={hrefWith({ format: active ? null : f.name })}
                            className="inline-flex max-w-full items-center gap-1.5 transition hover:opacity-80"
                            title={active ? "Clear filter" : `Show only ${f.name} videos`}
                          >
                            <FormatTag name={f.name} active={active} muted={f.name === UNCATEGORIZED} />
                            {active && <span className="text-[10px] font-semibold text-violet-600">✕</span>}
                          </Link>
                        </td>
                        <td className={`${td} tabular-nums`}>{f.count}</td>
                        <td className={td}>
                          <ResearchScoreChip score={f.medianScore} />
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
          {aiQueued > 0 ? (
            <p className="mt-3 text-xs font-medium text-warning">
              {aiQueued} video{aiQueued === 1 ? "" : "s"} queued for AI categorization — run{" "}
              <code className="rounded bg-warning/[0.1] px-1 font-mono">npm run categorize:formats</code> to
              classify them with Copilot (Opus 4.8), then refresh.
            </p>
          ) : (
            <p className="mt-3 text-xs text-neutral-400">
              Click a format to filter the videos below. <strong>Quick regex</strong> is an instant
              caption/transcript heuristic; <strong>Categorize with AI ✦</strong> queues the videos
              for Copilot (Opus 4.8) to read full transcripts and name new formats.
            </p>
          )}
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
            <span className="inline-flex shrink-0 items-center">
              <Segmented
                size="sm"
                aria-label="View mode"
                value={isGrid ? "grid" : "table"}
                items={[
                  { value: "table", label: "Table", href: hrefWith({ view: null }) },
                  { value: "grid", label: "Grid", href: hrefWith({ view: "grid" }) },
                ]}
              />
            </span>
          </span>
        }
      >
        <p className="mb-3 text-xs leading-relaxed text-neutral-500">
          Score = 0–10 rating of a video&apos;s lift vs the creator&apos;s own baseline (median
          views of the ~10 prior posts; account-wide median for the earliest). 5.0 = performed at
          baseline, +2 per doubling: 7.0 = 2×, 8.0 ≈ 2.8×, 10 ≥ 5.7×.
        </p>
        {videos.length === 0 ? (
          <EmptyState
            message={
              days != null
                ? `No videos posted in the last ${days} days. Try a wider range.`
                : "No videos scraped yet."
            }
          />
        ) : visibleVideos.length === 0 ? (
          <EmptyState message={`No videos in "${formatFilter}".`} />
        ) : isGrid ? (
          <div className="grid [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
            {visibleVideos.map((row) => (
              <ResearchVideoTile key={row.video.id} row={row} />
            ))}
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
              <tbody className="divide-y divide-black/[0.05]">
                {visibleVideos.map((row: VideoLift) => {
                  const v = row.video;
                  return (
                    <tr key={v.id} className={trHover}>
                      <td className={td}>
                        <ResearchScoreChip score={row.score} />
                      </td>
                      <td className={`${td} max-w-80`}>
                        <span className="flex items-center gap-1.5">
                          <ResearchSelectTrigger
                            row={row}
                            className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                          >
                            <Thumb src={v.thumbnail_url} className="h-11 w-8 shrink-0 rounded-md" />
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
                        <span title={v.error_message ?? v.transcript_method ?? undefined}>
                          <StatusBadge
                            status={v.transcript_status}
                            tone={TRANSCRIPT_TONE[v.transcript_status]}
                          />
                        </span>
                      </td>
                      <td className={td}>
                        {v.format_category ? (
                          <Link
                            href={hrefWith({
                              format:
                                formatFilter === v.format_category ? null : v.format_category,
                            })}
                            className="inline-flex max-w-full transition hover:opacity-80"
                            title={
                              formatFilter === v.format_category
                                ? "Clear filter"
                                : `Show only ${v.format_category} videos`
                            }
                          >
                            <FormatTag
                              name={v.format_category}
                              active={formatFilter === v.format_category}
                            />
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

      <ResearchVideoPanel segmentsByVideo={segmentsByVideo} curvesByVideo={curvesByVideo} />
      </div>
    </>
  );
}
