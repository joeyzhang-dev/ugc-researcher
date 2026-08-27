import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { ResearchAppCreator, ResearchCreator, ResearchVideo } from "@/lib/types";
import { computeLifts, median, type VideoLift } from "@/lib/research";
import { addResearchCreator } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import {
  Avatar, Card, EmptyState, KpiCard, MiniBar, PageHeader, PlatformIcon, Segmented,
  StatusBadge, inputClass, secondaryButtonClass, table, tableWrap, td, th, trHover,
} from "@/components/ui";
import { formatCompact, formatDate } from "@/lib/format";
import { parseDays, withinWindow, RangePicker } from "@/components/range-picker";
import { compareValues, parseSort, SortHeader, type SortDir } from "@/components/sort-header";
import { ScrapeAllButton } from "@/components/scrape-all-button";
import { ResearchScoreChip, ResearchVideoPanel, type PanelSegment } from "@/components/research-panel";
import { ResearchVideoTile } from "@/components/research-video-tile";
import { ALL_APPS } from "@/lib/workspace";
import { getWorkspace } from "@/lib/workspace/server";
import { loadViewCurves, videoSelect } from "@/lib/video-metrics";

export const dynamic = "force-dynamic";
// The add-creator action runs a full profile scrape inline.
export const maxDuration = 300;

/** Label used for the filter value of videos with no detected format. */
const UNCATEGORIZED = "(uncategorized)";

const TOP_PRESETS = [24, 48, 96] as const;
const DEFAULT_TOP = 24;

const RANK_MODES = [
  ["lift", "Lift"],
  ["views", "Views"],
] as const;
type RankMode = (typeof RANK_MODES)[number][0];

/** Which side of the tool to analyse: outside creators we study, or ours. */
const POOLS = [
  ["research", "Research"],
  ["roster", "Our creators"],
] as const;
type Pool = (typeof POOLS)[number][0];

const SORT_KEYS = [
  "creator", "status", "followers", "videos", "views", "transcribed", "scraped", "added",
] as const;
type SortKey = (typeof SORT_KEYS)[number];

function fmtLift(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(2)}×`;
}

function parseTop(raw: string | undefined): number {
  const n = Number(raw);
  return (TOP_PRESETS as readonly number[]).includes(n) ? n : DEFAULT_TOP;
}

function parseRank(raw: string | undefined): RankMode {
  return RANK_MODES.some(([k]) => k === raw) ? (raw as RankMode) : "lift";
}

function parsePool(raw: string | undefined): Pool {
  return POOLS.some(([k]) => k === raw) ? (raw as Pool) : "research";
}

/**
 * The research home (absorbed the old /overview, 2026-08-17): one page that
 * reads top-down from insight to operations.
 *
 *   1. Pool-wide KPIs and the highest-lifting videos — lift is measured against
 *      each creator's OWN baseline, which is what makes a pool-wide ranking
 *      meaningful (a 3× from 20k views and a 3× from 2M views both mean "this
 *      beat what the account normally does").
 *   2. Which formats and creators produce those lifts.
 *   3. Research pool only: the operational roster — add a profile, scrape
 *      state, transcription progress.
 *
 * The pool toggle swaps between the outside creators we study and our own
 * roster; the roster additionally honours the workspace picked in the rail
 * (matching /creators) and keeps its management on that page.
 */
export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string; days?: string; sort?: string; dir?: string;
    format?: string; creator?: string; top?: string; rank?: string; pool?: string;
  }>;
}) {
  const {
    error,
    days: daysParam,
    sort: sortParam,
    dir: dirParam,
    format: formatFilter,
    creator: creatorFilter,
    top: topParam,
    rank: rankParam,
    pool: poolParam,
  } = await searchParams;
  const days = parseDays(daysParam);
  const top = parseTop(topParam);
  const rank = parseRank(rankParam);
  const poolKind = parsePool(poolParam);
  const isRoster = poolKind === "roster";
  const sort = parseSort<SortKey>(sortParam, dirParam, SORT_KEYS, {
    key: "added",
    dir: "desc",
  });

  const hrefWith = (overrides: {
    days?: string | null; format?: string | null; creator?: string | null;
    top?: string | null; rank?: string | null; pool?: string | null;
    sort?: string | null; dir?: string | null;
  }) => {
    const sp = new URLSearchParams();
    if (days) sp.set("days", String(days));
    if (formatFilter) sp.set("format", formatFilter);
    if (creatorFilter) sp.set("creator", creatorFilter);
    if (topParam) sp.set("top", topParam);
    if (rankParam) sp.set("rank", rankParam);
    if (poolParam) sp.set("pool", poolParam);
    if (sortParam) sp.set("sort", sortParam);
    if (dirParam) sp.set("dir", dirParam);
    for (const [k, v] of Object.entries(overrides)) {
      if (v == null) sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    return `/research${qs ? `?${qs}` : ""}`;
  };
  const sortHref = (key: SortKey, dir: SortDir) => hrefWith({ sort: key, dir });

  const supabase = await createClient();
  // Falls back to the base column list when the Launchpoint migration has
  // not been applied yet, so a lagging schema hides chips instead of 400ing
  // the whole page.
  const VIDEO_SELECT = await videoSelect(
    supabase,
    "id, research_creator_id, url, shortcode, caption, hashtags, posted_at, view_count, like_count, comment_count, share_count, thumbnail_url, video_url, transcript_status, transcript_method, transcript_text, format_category"
  );
  const workspace = await getWorkspace();
  const appFilter = workspace.current === ALL_APPS ? null : workspace.current;

  const [{ data: creatorsData }, { data: videosData }, { data: membershipsData }] =
    await Promise.all([
      supabase.from("research_creators").select("*").eq("kind", poolKind),
      supabase
        .from("research_videos")
        .select(
          VIDEO_SELECT
        ),
      // Only the roster is scoped by app; skip the join entirely otherwise.
      isRoster
        ? supabase.from("research_app_creators").select("*")
        : Promise.resolve({ data: [] as ResearchAppCreator[] }),
    ]);

  const memberships = (membershipsData ?? []) as ResearchAppCreator[];
  const inWorkspace = new Set(
    memberships.filter((m) => !appFilter || m.app_id === appFilter).map((m) => m.research_creator_id)
  );
  const creators = ((creatorsData ?? []) as ResearchCreator[]).filter(
    // A roster creator with no membership row belongs to no app, so it can only
    // appear in the unscoped "All apps" view.
    (c) => !isRoster || (appFilter ? inWorkspace.has(c.id) : true)
  );
  const creatorById = new Map(creators.map((c) => [c.id, c]));
  // Through `unknown`: the select list is built at runtime (the Launchpoint
  // columns are only named when the schema has them), so supabase-js cannot
  // infer a row type from it. The rows are ResearchVideo either way — the
  // Launchpoint fields are simply absent before the migration, and every
  // reader already treats them as nullable.
  const allVideos = (videosData ?? []) as unknown as ResearchVideo[];
  const queuedCount = creators.filter((c) => c.scrape_queued_at != null).length;

  const byCreator = new Map<string, ResearchVideo[]>();
  for (const v of allVideos) {
    // Both pools share the videos table — keep only this pool's creators.
    if (!creatorById.has(v.research_creator_id)) continue;
    (byCreator.get(v.research_creator_id) ??
      byCreator.set(v.research_creator_id, []).get(v.research_creator_id)!).push(v);
  }

  // Lift must be computed per creator (the baseline is the creator's own median)
  // and only then pooled — computing it across the merged list would compare
  // every video against a meaningless cross-account median.
  const perCreator = creators.map((c) => {
    const vids = withinWindow(byCreator.get(c.id) ?? [], days);
    const rows = computeLifts(vids);
    const scores = rows.map((r) => r.score).filter((n): n is number => n != null);
    return {
      creator: c,
      rows,
      videoCount: rows.length,
      medianViews: median(
        vids.map((v) => v.view_count).filter((n): n is number => n != null)
      ),
      transcribed: vids.filter((v) => v.transcript_status === "transcribed").length,
      medianScore: median(scores),
      topRated: scores.filter((s) => s >= 8).length,
      best: rows.find((r) => r.lift != null) ?? null, // computeLifts sorts by lift desc
    };
  });

  const pool = perCreator.flatMap(({ creator, rows }) =>
    rows.map((row) => ({ row, creator }))
  );

  const formatOf = (row: VideoLift) => row.video.format_category ?? UNCATEGORIZED;

  // Format rollup is computed over the unfiltered pool so the leaderboard keeps
  // its full context while the grid below is filtered.
  const byFormat = new Map<string, VideoLift[]>();
  for (const { row } of pool) {
    const key = formatOf(row);
    (byFormat.get(key) ?? byFormat.set(key, []).get(key)!).push(row);
  }
  const formatRollup = [...byFormat.entries()]
    .map(([name, rows]) => {
      const scores = rows.map((r) => r.score).filter((n): n is number => n != null);
      return {
        name,
        count: rows.length,
        medianScore: median(scores),
        medianLift: median(rows.map((r) => r.lift).filter((n): n is number => n != null)),
        topRated: scores.filter((s) => s >= 8).length,
      };
    })
    .sort((a, b) => {
      if ((a.name === UNCATEGORIZED) !== (b.name === UNCATEGORIZED)) {
        return a.name === UNCATEGORIZED ? 1 : -1;
      }
      return (b.medianScore ?? -1) - (a.medianScore ?? -1);
    });

  const filtered = pool
    .filter(({ row }) => !formatFilter || formatOf(row) === formatFilter)
    .filter(({ creator }) => !creatorFilter || creator.id === creatorFilter)
    .filter(({ row }) => row.lift != null)
    .sort((a, b) =>
      rank === "views"
        ? (b.row.video.view_count ?? 0) - (a.row.video.view_count ?? 0)
        : (b.row.lift ?? -1) - (a.row.lift ?? -1)
    );

  const visible = filtered.slice(0, top);

  // Only the visible tiles need transcripts — the side panel reads them lazily
  // from this map, so fetching the whole pool's segments would be wasted work.
  const visibleIds = visible.map(({ row }) => row.video.id);
  const { data: segmentsData } = visibleIds.length
    ? await supabase
        .from("research_video_segments")
        .select("research_video_id, position, start_time, text")
        .in("research_video_id", visibleIds)
        .order("position", { ascending: true })
    : { data: [] };
  const segmentsByVideo: Record<string, PanelSegment[]> = {};
  for (const s of (segmentsData ?? []) as (PanelSegment & { research_video_id: string })[]) {
    (segmentsByVideo[s.research_video_id] ??= []).push({
      position: s.position,
      start_time: s.start_time,
      text: s.text,
    });
  }
  // Daily curves for the same visible set — only roster posts Launchpoint
  // tracks have one, so this is usually a subset of `visibleIds`.
  const curvesByVideo = await loadViewCurves(supabase, visibleIds);

  const allScores = pool.map(({ row }) => row.score).filter((n): n is number => n != null);
  const allLifts = pool.map(({ row }) => row.lift).filter((n): n is number => n != null);
  const totalViews = pool.reduce((sum, { row }) => sum + (row.video.view_count ?? 0), 0);
  const eightPlus = allScores.filter((s) => s >= 8).length;

  const leaderboard = [...perCreator]
    .filter((r) => r.videoCount > 0)
    .sort((a, b) => (b.medianScore ?? -1) - (a.medianScore ?? -1));

  // The operational table sorts independently of the leaderboard.
  const studyRows = [...perCreator].sort((a, b) => {
    const value = (r: (typeof perCreator)[number]): string | number | null => {
      switch (sort.key) {
        case "creator": return r.creator.handle;
        case "status": return r.creator.status;
        case "followers": return r.creator.follower_count;
        case "videos": return r.videoCount;
        case "views": return r.medianViews;
        case "transcribed": return r.transcribed;
        case "scraped":
          return r.creator.last_scraped_at
            ? new Date(r.creator.last_scraped_at).getTime()
            : null;
        default: return new Date(r.creator.created_at).getTime();
      }
    };
    return (
      compareValues(value(a), value(b), sort.dir) ||
      a.creator.handle.localeCompare(b.creator.handle)
    );
  });

  const windowLabel = days == null ? "all time" : `last ${days} days`;
  const activeFilter =
    formatFilter || (creatorFilter ? `@${creatorById.get(creatorFilter)?.handle ?? ""}` : null);

  return (
    <>
      <PageHeader
        title="Research"
        subtitle={
          isRoster ? (
            <>
              Our roster&apos;s best work, ranked by <em>lift</em> — how far each video beat its
              own creator&apos;s baseline. Scoped to{" "}
              <span className="font-medium text-neutral-700">
                {workspace.app?.name ?? "all apps"}
              </span>
              ; manage the roster on{" "}
              <Link href="/creators" className="font-medium text-neutral-700 underline-offset-2 hover:underline">
                Our creators
              </Link>
              .
            </>
          ) : (
            <>
              Study outside creators: scrape their reels, find which videos <em>lift</em> above
              the account&apos;s own baseline, transcribe them, and derive the formats worth
              copying.
            </>
          )
        }
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Segmented
              aria-label="Creator pool"
              value={poolKind}
              items={POOLS.map(([key, label]) => ({
                value: key,
                label,
                // Creator/format filters belong to one pool — carrying them
                // across would silently match nothing.
                href: hrefWith({
                  pool: key === "research" ? null : key,
                  creator: null,
                  format: null,
                }),
              }))}
            />
            <RangePicker days={days} hrefForDays={(d) => hrefWith({ days: d ? String(d) : null })} />
          </div>
        }
      />

      {error && (
        <p className="mb-5 rounded-xl bg-danger/[0.1] px-3.5 py-2.5 text-sm text-danger ring-1 ring-inset ring-danger/[0.22]">
          {error}
        </p>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 stagger-children lg:grid-cols-5">
        <KpiCard
          label={isRoster ? "Roster creators" : "Creators studied"}
          value={String(leaderboard.length)}
          icon="users"
        />
        <KpiCard label="Videos analysed" value={formatCompact(pool.length)} icon="play" />
        <KpiCard
          label="Rated 8.0+"
          value={String(eightPlus)}
          sub={
            allScores.length
              ? `${Math.round((eightPlus / allScores.length) * 100)}% of scored`
              : undefined
          }
          icon="badge"
          tone="amber"
        />
        <KpiCard
          label="Median lift"
          value={fmtLift(median(allLifts))}
          sub={`across ${windowLabel}`}
          icon="trend"
          tone="emerald"
        />
        <KpiCard label="Total views" value={formatCompact(totalViews)} icon="eye" tone="sky" />
      </div>

      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 space-y-5 stagger-children">
          <Card
            title={`${rank === "views" ? "Biggest reach" : "Highest lifts"}${activeFilter ? ` — ${activeFilter}` : ""}`}
            subtitle={`${visible.length} of ${filtered.length} shown · ${windowLabel}`}
            action={
              <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
                {activeFilter && (
                  <Link
                    href={hrefWith({ format: null, creator: null })}
                    className="rounded-lg px-2 py-1 text-neutral-500 ring-1 ring-hairline transition hover:text-neutral-900"
                  >
                    Clear filter ✕
                  </Link>
                )}
                <Segmented
                  size="sm"
                  aria-label="Rank videos by"
                  value={rank}
                  items={RANK_MODES.map(([key, label]) => ({
                    value: key,
                    label,
                    href: hrefWith({ rank: key === "lift" ? null : key }),
                  }))}
                />
                <Segmented
                  size="sm"
                  aria-label="Number of videos shown"
                  value={String(top)}
                  items={TOP_PRESETS.map((n) => ({
                    value: String(n),
                    label: String(n),
                    href: hrefWith({ top: n === DEFAULT_TOP ? null : String(n) }),
                  }))}
                />
              </div>
            }
          >
            {visible.length === 0 ? (
              <EmptyState
                message={
                  pool.length > 0
                    ? "No videos match this filter in the selected range."
                    : isRoster
                      ? appFilter
                        ? `No roster videos for ${workspace.app?.name ?? "this app"} yet — add a creator on the Our creators tab, or switch workspace.`
                        : "No roster videos scraped yet — add a creator on the Our creators tab."
                      : "No research videos scraped yet — add a creator below."
                }
              />
            ) : (
              <div className="grid [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
                {visible.map(({ row, creator }) => (
                  <ResearchVideoTile
                    key={row.video.id}
                    row={row}
                    creatorHandle={creator.handle}
                    showLift
                  />
                ))}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
            <div className="xl:col-span-2">
              <Card title="Top formats" subtitle="Which buckets clear their baseline most">
                {formatRollup.length === 0 ? (
                  <EmptyState message="No formats detected yet — transcribe and categorize some videos." />
                ) : (
                  <div className={tableWrap}>
                    <table className={table}>
                      <thead>
                        <tr>
                          <th className={`${th} w-8`}>#</th>
                          <th className={th}>Format</th>
                          <th className={th}>Videos</th>
                          <th className={th}>8.0+</th>
                          <th className={th}>Median score</th>
                          <th className={th}>Median lift</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-black/[0.05]">
                        {formatRollup.map((f, i) => {
                          const active = formatFilter === f.name;
                          return (
                            <tr key={f.name} className={trHover}>
                              <td className={td}>
                                <span className="font-mono text-xs tabular-nums text-neutral-400">
                                  {i + 1}
                                </span>
                              </td>
                              <td className={`${td} font-medium`}>
                                <Link
                                  href={hrefWith({ format: active ? null : f.name })}
                                  className={`underline-offset-2 hover:underline ${
                                    f.name === UNCATEGORIZED ? "text-neutral-400" : "text-neutral-900"
                                  }`}
                                  title={active ? "Clear filter" : `Show only ${f.name}`}
                                >
                                  {f.name}
                                </Link>
                              </td>
                              <td className={`${td} tabular-nums`}>{f.count}</td>
                              <td className={`${td} tabular-nums`}>{f.topRated}</td>
                              <td className={td}>
                                <span className="flex items-center gap-2">
                                  <ResearchScoreChip score={f.medianScore} />
                                  <span className="w-14 shrink-0">
                                    <MiniBar ratio={(f.medianScore ?? 0) / 10} />
                                  </span>
                                </span>
                              </td>
                              <td className={`${td} tabular-nums`}>{fmtLift(f.medianLift)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>

            <div className="xl:col-span-3">
              <Card title="Top creators" subtitle="Best median lift score across their videos">
                {leaderboard.length === 0 ? (
                  <EmptyState message="No creators with videos in this range." />
                ) : (
                  <div className={tableWrap}>
                    <table className={table}>
                      <thead>
                        <tr>
                          <th className={`${th} w-8`}>#</th>
                          <th className={th}>Creator</th>
                          <th className={th}>Videos</th>
                          <th className={th}>8.0+</th>
                          <th className={th}>Median score</th>
                          <th className={th}>Best video</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-black/[0.05]">
                        {leaderboard.map((r, i) => {
                          const active = creatorFilter === r.creator.id;
                          return (
                            <tr key={r.creator.id} className={trHover}>
                              <td className={td}>
                                <span className="font-mono text-xs tabular-nums text-neutral-400">
                                  {i + 1}
                                </span>
                              </td>
                              <td className={td}>
                                <span className="flex items-center gap-2">
                                  <Link
                                    href={hrefWith({ creator: active ? null : r.creator.id })}
                                    className="flex items-center gap-2.5 font-medium text-neutral-900 hover:underline"
                                    title={active ? "Clear filter" : `Show only @${r.creator.handle}`}
                                  >
                                    <Avatar name={r.creator.handle} src={r.creator.avatar_url} size={26} />
                                    <span className="flex items-center gap-1.5">
                                      <PlatformIcon platform={r.creator.platform} size={13} />@
                                      {r.creator.handle}
                                    </span>
                                  </Link>
                                  <Link
                                    href={
                                      days
                                        ? `/research/${r.creator.id}?days=${days}`
                                        : `/research/${r.creator.id}`
                                    }
                                    className="shrink-0 text-xs text-neutral-400 hover:text-neutral-700"
                                    title="Open creator page"
                                  >
                                    ↗
                                  </Link>
                                </span>
                              </td>
                              <td className={`${td} tabular-nums`}>{r.videoCount}</td>
                              <td className={`${td} tabular-nums`}>{r.topRated}</td>
                              <td className={td}>
                                <span className="flex items-center gap-2">
                                  <ResearchScoreChip score={r.medianScore} />
                                  <span className="w-14 shrink-0">
                                    <MiniBar ratio={(r.medianScore ?? 0) / 10} />
                                  </span>
                                </span>
                              </td>
                              <td className={`${td} max-w-72`}>
                                {r.best ? (
                                  <span className="flex items-center gap-2">
                                    <ResearchScoreChip score={r.best.score} />
                                    <span className="min-w-0 truncate text-sm text-neutral-600">
                                      {r.best.video.caption?.split("\n")[0] ||
                                        r.best.video.shortcode ||
                                        "—"}
                                    </span>
                                    <span className="shrink-0 text-xs text-neutral-400">
                                      {formatDate(r.best.video.posted_at)}
                                    </span>
                                  </span>
                                ) : (
                                  <span className="text-sm text-neutral-400">—</span>
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
          </div>

          {/* The operational half — scrape state, transcription progress and
              intake. Research pool only: roster ops live on /creators. */}
          {!isRoster && (
            <>
              <details className="group">
                <summary
                  className={`${secondaryButtonClass} w-fit cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden`}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    className="transition-transform duration-200 ease-fluid group-open:rotate-45"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add a creator
                </summary>
                <div className="mt-3">
                  <Card
                    title="Add a creator"
                    subtitle="Runs a full profile scrape inline — takes about a minute."
                  >
                    <form action={addResearchCreator} className="flex flex-wrap items-end gap-3">
                      <label className="min-w-72 flex-1">
                        <span className="mb-1 block text-sm font-medium text-neutral-700">
                          Profile URL or handle
                        </span>
                        <input
                          name="handle"
                          placeholder="https://www.instagram.com/levelup.withliam/"
                          className={inputClass}
                          required
                        />
                      </label>
                      <SubmitButton pendingLabel="Scraping… (takes a minute)">
                        Scrape profile
                      </SubmitButton>
                    </form>
                  </Card>
                </div>
              </details>

              <Card
                title="Under study"
                subtitle={`${creators.length} creator${creators.length === 1 ? "" : "s"} in the research pool`}
                action={<ScrapeAllButton kinds={["research"]} queued={queuedCount} />}
              >
                {creators.length === 0 ? (
                  <EmptyState message="No research creators yet — add one above." />
                ) : (
                  <div className={tableWrap}>
                    <table className={table}>
                      <thead>
                        <tr>
                          {(
                            [
                              ["Creator", "creator", "asc"],
                              ["Status", "status", "asc"],
                              ["Followers", "followers", "desc"],
                              ["Videos", "videos", "desc"],
                              ["Median views", "views", "desc"],
                              ["Transcribed", "transcribed", "desc"],
                              ["Last scraped", "scraped", "desc"],
                            ] as const
                          ).map(([label, key, first]) => (
                            <SortHeader
                              key={key}
                              label={label}
                              sortKey={key}
                              active={sort.key === key}
                              dir={sort.dir}
                              hrefFor={sortHref}
                              firstDir={first}
                            />
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-black/[0.05]">
                        {studyRows.map(({ creator: c, videoCount, medianViews, transcribed }) => (
                          <tr key={c.id} className={trHover}>
                            <td className={td}>
                              <Link
                                href={days ? `/research/${c.id}?days=${days}` : `/research/${c.id}`}
                                className="flex items-center gap-2.5 font-medium text-neutral-900 hover:underline"
                              >
                                <Avatar name={c.handle} src={c.avatar_url} size={28} />
                                <span className="flex items-center gap-1.5">
                                  <PlatformIcon platform={c.platform} size={13} />@{c.handle}
                                </span>
                              </Link>
                            </td>
                            <td className={td}>
                              <StatusBadge status={c.status} />
                              {c.status === "failed" && c.error_message && (
                                <span className="ml-2 text-xs text-danger">{c.error_message}</span>
                              )}
                            </td>
                            <td className={`${td} tabular-nums`}>{formatCompact(c.follower_count)}</td>
                            <td className={`${td} tabular-nums`}>{videoCount}</td>
                            <td className={`${td} tabular-nums`}>{formatCompact(medianViews)}</td>
                            <td className={`${td} tabular-nums`}>
                              {transcribed}/{videoCount}
                            </td>
                            <td className={td}>{formatDate(c.last_scraped_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>

        <ResearchVideoPanel segmentsByVideo={segmentsByVideo} curvesByVideo={curvesByVideo} />
      </div>
    </>
  );
}
