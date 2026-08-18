import { Fragment } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type {
  ResearchApp,
  ResearchAppCreator,
  ResearchCampaign,
  ResearchCampaignCreator,
  ResearchCreator,
  ResearchCreatorStatus,
  ResearchVideo,
} from "@/lib/types";
import { rosterRowStats, type DayCell } from "@/lib/roster-stats";
import { ALL_APPS } from "@/lib/workspace";
import { getWorkspace } from "@/lib/workspace/server";
import {
  addRosterCreator,
  assignToCampaign,
  createApp,
  createCampaign,
  removeFromCampaign,
  setNiche,
} from "./actions";
import { SubmitButton } from "@/components/submit-button";
import {
  Avatar, AvatarStack, Card, DiscordIcon, EmptyState, PageHeader, PlatformIcon, StatusBadge,
  inputClass, labelClass, secondaryButtonClass, tableWrap,
} from "@/components/ui";
import { formatCompact, formatDate } from "@/lib/format";
import { parseDays, RangePicker } from "@/components/range-picker";
import { compareValues, parseSort, SortHeader, type SortDir } from "@/components/sort-header";
import { ScrapeAllButton } from "@/components/scrape-all-button";

const SORT_KEYS = ["creator", "last7", "avg", "views", "eng"] as const;
type SortKey = (typeof SORT_KEYS)[number];

/** Shared column recipe for the roster grid — header and rows must agree. */
const GRID =
  "grid grid-cols-[minmax(230px,1.5fr)_250px_minmax(110px,0.8fr)_minmax(110px,0.8fr)_minmax(110px,0.8fr)] items-center gap-x-3";

/** Sentinel app id for roster creators that belong to no app yet. Not a real
 *  app row — it only exists to give them a band to render in. */
const UNASSIGNED_APP = "__unassigned__";

export const dynamic = "force-dynamic";
// Adding a roster creator runs a full profile scrape inline.
export const maxDuration = 300;

/** Our creators, organised per app: which niche each runs for that app, which
 *  campaigns they're in, and the same scrape/lift stats as the research pool. */
export default async function OurCreatorsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string; days?: string; sort?: string; dir?: string;
  }>;
}) {
  const { error, days: daysParam, sort: sortParam, dir: dirParam } = await searchParams;
  const days = parseDays(daysParam);
  const sort = parseSort<SortKey>(sortParam, dirParam, SORT_KEYS, {
    key: "views",
    dir: "desc",
  });
  const supabase = await createClient();
  // The roster is scoped by the workspace picked in the header/rail rather than
  // a per-page filter, so the choice follows you across the tool.
  const { current: workspace } = await getWorkspace();
  const appFilter = workspace === ALL_APPS ? null : workspace;

  const hrefWith = (overrides: {
    days?: string | null; sort?: string | null; dir?: string | null;
  }) => {
    const sp = new URLSearchParams();
    if (days) sp.set("days", String(days));
    if (sortParam) sp.set("sort", sortParam);
    if (dirParam) sp.set("dir", dirParam);
    for (const [k, v] of Object.entries(overrides)) {
      if (v == null) sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    return `/creators${qs ? `?${qs}` : ""}`;
  };

  const [
    { data: appsData },
    { data: campaignsData },
    { data: membershipsData },
    { data: campaignMembersData },
    { data: creatorsData },
  ] = await Promise.all([
    supabase.from("research_apps").select("*").order("created_at"),
    supabase.from("research_campaigns").select("*").order("created_at"),
    supabase.from("research_app_creators").select("*"),
    supabase.from("research_campaign_creators").select("*"),
    supabase.from("research_creators").select("*").eq("kind", "roster"),
  ]);
  const apps = (appsData ?? []) as ResearchApp[];
  const campaigns = (campaignsData ?? []) as ResearchCampaign[];
  const memberships = (membershipsData ?? []) as ResearchAppCreator[];
  const campaignMembers = (campaignMembersData ?? []) as ResearchCampaignCreator[];
  const creators = (creatorsData ?? []) as ResearchCreator[];

  // Queue depth for the creators actually visible in this workspace.
  const scopedCreatorIds = new Set(
    memberships
      .filter((m) => !appFilter || m.app_id === appFilter)
      .map((m) => m.research_creator_id)
  );
  const queuedCount = creators.filter(
    (c) => c.scrape_queued_at != null && (!appFilter || scopedCreatorIds.has(c.id))
  ).length;

  const creatorIds = creators.map((c) => c.id);
  const { data: videosData } = creatorIds.length
    ? await supabase
        .from("research_videos")
        .select(
          "id, research_creator_id, url, posted_at, view_count, like_count, comment_count, share_count, transcript_status"
        )
        .in("research_creator_id", creatorIds)
    : { data: [] };
  const videos = (videosData ?? []) as ResearchVideo[];

  const creatorById = new Map(creators.map((c) => [c.id, c]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const videosByCreator = new Map<string, ResearchVideo[]>();
  for (const v of videos) {
    (videosByCreator.get(v.research_creator_id) ??
      videosByCreator.set(v.research_creator_id, []).get(v.research_creator_id)!).push(v);
  }
  const campaignsByCreator = new Map<string, ResearchCampaignCreator[]>();
  for (const m of campaignMembers) {
    (campaignsByCreator.get(m.research_creator_id) ??
      campaignsByCreator.set(m.research_creator_id, []).get(m.research_creator_id)!).push(m);
  }

  // One row per app↔creator membership (a creator promoting two apps appears
  // under each, with its per-app niche). App filter narrows to one app.
  //
  // A roster creator with no membership row has no app to appear under, so it
  // used to drop out of this page entirely — scraped, collecting videos, and
  // visible on /overview, but absent here with nothing to hint it existed.
  // Synthesize a membership-shaped row for those in the unfiltered view so
  // they surface (in an "Unassigned" band) instead of vanishing.
  const unassigned: typeof memberships = appFilter
    ? []
    : creators
        .filter((c) => !memberships.some((m) => m.research_creator_id === c.id))
        .map((c) => ({
          id: `unassigned:${c.id}`,
          app_id: UNASSIGNED_APP,
          research_creator_id: c.id,
          niche: null,
          notes: null,
          created_at: c.created_at,
        }));

  const rows = [...memberships, ...unassigned]
    .filter((m) => creatorById.has(m.research_creator_id))
    .filter((m) => !appFilter || m.app_id === appFilter)
    .map((m) => {
      const c = creatorById.get(m.research_creator_id)!;
      const app = apps.find((a) => a.id === m.app_id);
      const creatorVideos = videosByCreator.get(c.id) ?? [];
      const stats = rosterRowStats(creatorVideos, days);
      const joined = (campaignsByCreator.get(c.id) ?? []).filter(
        (cm) => campaignById.get(cm.campaign_id)?.app_id === m.app_id
      );
      const joinedIds = new Set(joined.map((cm) => cm.campaign_id));
      const available = campaigns.filter(
        (cp) => cp.app_id === m.app_id && !joinedIds.has(cp.id)
      );
      return { m, c, app, stats, videoCount: creatorVideos.length, joined, available };
    })
    .sort((a, b) => {
      const value = (r: (typeof rows)[number]): string | number | null => {
        switch (sort.key) {
          case "last7": return r.stats.postsLast7;
          case "avg": return r.stats.avgViews;
          case "views": return r.stats.views;
          case "eng": return r.stats.engPct;
          default: return r.c.handle;
        }
      };
      // Handle is the tiebreaker so equal values keep a stable, readable order.
      return compareValues(value(a), value(b), sort.dir) || a.c.handle.localeCompare(b.c.handle);
    });

  const sortHref = (key: SortKey, dir: SortDir) => hrefWith({ sort: key, dir });

  // Group the (already-sorted) rows by app so each app reads as its own band
  // rather than repeating an "App" column on every line. Groups follow the app
  // list order; a membership whose app was deleted lands in an "unknown" band.
  const rowsByApp = new Map<string, typeof rows>();
  for (const r of rows) {
    (rowsByApp.get(r.m.app_id) ??
      rowsByApp.set(r.m.app_id, []).get(r.m.app_id)!).push(r);
  }
  const orderedGroups: { appId: string; app: ResearchApp | undefined; groupRows: typeof rows }[] = [];
  for (const app of apps) {
    const groupRows = rowsByApp.get(app.id);
    if (groupRows?.length) orderedGroups.push({ appId: app.id, app, groupRows });
  }
  for (const [appId, groupRows] of rowsByApp) {
    if (!apps.some((a) => a.id === appId)) {
      orderedGroups.push({ appId, app: undefined, groupRows });
    }
  }
  const creatorCount = new Set(rows.map((r) => r.c.id)).size;

  return (
    <>
      <PageHeader
        title="Our creators"
        subtitle="The creators posting for us, grouped by app. Each carries a per-app niche — their content lane — and can sit in multiple campaigns; scraping, lift and transcripts work exactly like the research pool."
        action={
          <RangePicker days={days} hrefForDays={(d) => hrefWith({ days: d ? String(d) : null })} />
        }
      />

      {error && (
        <p className="mb-5 rounded-xl bg-danger/[0.1] px-3.5 py-2.5 text-sm text-danger ring-1 ring-inset ring-danger/[0.22]">
          {error}
        </p>
      )}

      <div className="stagger-children space-y-5">
        {/* Adding a creator is an occasional action, so it folds behind a button
            near the header rather than crowding the roster. */}
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
              <form action={addRosterCreator} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="sm:col-span-2 lg:col-span-1">
                  <span className={labelClass}>Profile URL or handle</span>
                  <input name="handle" placeholder="@handle or profile URL" className={inputClass} required />
                </label>
                <label>
                  <span className={labelClass}>App</span>
                  <select name="appId" className={inputClass} required defaultValue={appFilter || apps[0]?.id}>
                    {apps.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className={labelClass}>Niche</span>
                  <input name="niche" placeholder="e.g. fitness, looksmaxing" className={inputClass} />
                </label>
                <label>
                  <span className={labelClass}>Campaign (optional)</span>
                  <select name="campaignId" className={inputClass} defaultValue="">
                    <option value="">—</option>
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {apps.find((a) => a.id === c.app_id)?.name} — {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-end sm:col-span-2 lg:col-span-4">
                  <SubmitButton pendingLabel="Scraping… (takes a minute)">Add &amp; scrape</SubmitButton>
                </div>
              </form>
            </Card>
          </div>
        </details>

        <Card
          title="Roster"
          subtitle={
            appFilter
              ? "Scoped to the current workspace"
              : `${creatorCount} creator${creatorCount === 1 ? "" : "s"} across ${orderedGroups.length} app${orderedGroups.length === 1 ? "" : "s"}`
          }
          action={
            <ScrapeAllButton
              kinds={["roster"]}
              appId={appFilter}
              queued={queuedCount}
              label={appFilter ? "Scrape this workspace" : "Scrape all"}
            />
          }
        >
          {rows.length === 0 ? (
            <EmptyState message="No roster creators yet — add one above (pick the app they promote and tag their niche)." />
          ) : (
            <div className={tableWrap}>
              <div className="min-w-[880px]">
                {/* Grid, not <table> — each row is a <details> so the metrics
                    stay a calm five columns and everything operational (niche,
                    campaigns, scrape state) folds underneath the disclosure. */}
                <div className={`${GRID} border-b border-black/[0.05] pb-1`}>
                  {(
                    [
                      ["Creator", "creator", "asc", ""],
                      ["Last 7 days", "last7", "desc", ""],
                      ["Avg views", "avg", "desc", "text-right"],
                      ["Views", "views", "desc", "text-right"],
                      ["Eng %", "eng", "desc", "text-right"],
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
                  {orderedGroups.map((group) => {
                    const totalFollowers = group.groupRows.reduce(
                      (sum, r) => sum + (r.c.follower_count ?? 0),
                      0
                    );
                    const unassignedBand = group.appId === UNASSIGNED_APP;
                    return (
                      <Fragment key={group.appId}>
                        {/* App band: the grouping IS the structure, so the app name
                            stops repeating down an "App" column. Hidden when the
                            whole page is already scoped to one workspace. */}
                        {!appFilter && (
                          <div className="flex items-center gap-2.5 bg-surface-sunken px-1 py-2">
                            {!unassignedBand && (
                              <Avatar name={group.app?.name ?? "?"} src={group.app?.logo_url} size={22} />
                            )}
                            <span className="text-sm font-semibold tracking-[-0.01em] text-neutral-900">
                              {unassignedBand ? "Unassigned" : (group.app?.name ?? "Unknown app")}
                            </span>
                            <span className="font-mono text-[11px] text-neutral-400">
                              {group.groupRows.length} creator{group.groupRows.length === 1 ? "" : "s"} · {formatCompact(totalFollowers)} followers
                            </span>
                            {unassignedBand && (
                              <span className="rounded-full bg-warning/[0.1] px-2 py-0.5 text-[11px] font-medium text-warning ring-1 ring-inset ring-warning/[0.22]">
                                No app yet — pick one below to file them
                              </span>
                            )}
                          </div>
                        )}
                        {group.groupRows.map(({ m, c, stats, videoCount, joined, available }) => (
                          <details key={m.id} className="group/row">
                            <summary
                              className={`${GRID} cursor-pointer select-none list-none py-3 pr-1 transition-colors hover:bg-neutral-900/[0.03] [&::-webkit-details-marker]:hidden`}
                            >
                              {/* Creator: identity reads top-down — face, name +
                                  health dot, then handle with platform marks. */}
                              <div className="flex min-w-0 items-center gap-2.5">
                                <svg
                                  aria-hidden
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  className="shrink-0 text-neutral-300 transition-transform duration-200 ease-fluid group-open/row:rotate-90"
                                >
                                  <path d="m9 6 6 6-6 6" />
                                </svg>
                                <Avatar name={c.handle} src={c.avatar_url} size={36} />
                                <span className="min-w-0">
                                  <span className="flex items-center gap-1.5">
                                    <Link
                                      href={`/research/${c.id}`}
                                      className="truncate text-sm font-semibold tracking-[-0.01em] text-neutral-900 hover:underline"
                                    >
                                      {c.display_name || `@${c.handle}`}
                                    </Link>
                                    <StatusDot status={c.status} error={c.error_message} />
                                  </span>
                                  <span className="mt-0.5 flex items-center gap-1.5">
                                    <PlatformIcon platform={c.platform} size={13} />
                                    {c.discord_username && <DiscordIcon size={13} />}
                                    <span className="truncate font-mono text-[11px] text-neutral-400">
                                      @{c.handle}
                                    </span>
                                  </span>
                                </span>
                              </div>

                              <DayStrip days={stats.days} />

                              <MetricCell
                                value={formatCompact(roundOrNull(stats.avgViews))}
                                all={`${formatCompact(roundOrNull(stats.allAvgViews))} all-time`}
                                windowed={days != null}
                              />
                              <MetricCell
                                value={formatCompact(stats.views)}
                                all={`${formatCompact(stats.allViews)} all-time`}
                                windowed={days != null}
                              />
                              <MetricCell
                                value={stats.engPct != null ? `${stats.engPct.toFixed(1)}%` : "—"}
                                all={`${stats.allEngPct != null ? `${stats.allEngPct.toFixed(1)}%` : "—"} all-time`}
                                windowed={days != null}
                              />
                            </summary>

                            {/* Fold-out: the operational half of the old table. */}
                            <div className="border-t border-black/[0.04] bg-surface-sunken px-1 pb-3.5 pt-3">
                              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pl-[52px]">
                                <StatusBadge status={c.status} />
                                <RowFact label="Followers" value={formatCompact(c.follower_count)} />
                                <RowFact label="Videos" value={String(videoCount)} />
                                <RowFact label="Last scraped" value={formatDate(c.last_scraped_at)} />
                                <form action={setNiche} className="flex items-center gap-1">
                                  <input type="hidden" name="membershipId" value={m.id} />
                                  <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-400">
                                    Niche
                                  </span>
                                  <input
                                    name="niche"
                                    defaultValue={m.niche ?? ""}
                                    placeholder="niche…"
                                    className="w-28 rounded-md bg-transparent px-1.5 py-0.5 text-sm text-neutral-700 transition placeholder:text-neutral-400 hover:bg-surface focus:bg-surface focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/45"
                                  />
                                  <button
                                    type="submit"
                                    className="text-xs text-neutral-300 transition-colors hover:text-neutral-900"
                                    title="Save niche"
                                  >
                                    ✓
                                  </button>
                                </form>
                                <span className="flex flex-wrap items-center gap-1">
                                  {joined.map((cm) => (
                                    <form key={cm.id} action={removeFromCampaign.bind(null, cm.id)}>
                                      <button
                                        type="submit"
                                        className="group/chip inline-flex items-center gap-1 rounded-md bg-info/[0.1] px-2 py-0.5 text-xs font-medium text-info ring-1 ring-inset ring-info/[0.22] transition hover:bg-danger/[0.1] hover:text-danger hover:ring-danger/[0.22]"
                                        title="Remove from campaign"
                                      >
                                        {campaignById.get(cm.campaign_id)?.name}
                                        <span className="text-info/50 group-hover/chip:text-danger">✕</span>
                                      </button>
                                    </form>
                                  ))}
                                  {available.length > 0 && (
                                    <form action={assignToCampaign} className="inline-flex items-center gap-1">
                                      <input type="hidden" name="creatorId" value={c.id} />
                                      <input type="hidden" name="appId" value={m.app_id} />
                                      <select
                                        name="campaignId"
                                        className="rounded-md bg-surface px-1.5 py-0.5 text-xs text-neutral-600 ring-1 ring-inset ring-hairline transition focus:outline-none focus:ring-2 focus:ring-accent/45"
                                        defaultValue=""
                                        required
                                      >
                                        <option value="" disabled>+ campaign</option>
                                        {available.map((cp) => (
                                          <option key={cp.id} value={cp.id}>{cp.name}</option>
                                        ))}
                                      </select>
                                      <button
                                        type="submit"
                                        className="text-xs text-neutral-400 transition-colors hover:text-neutral-900"
                                        title="Assign"
                                      >
                                        +
                                      </button>
                                    </form>
                                  )}
                                </span>
                              </div>
                              {c.status === "failed" && c.error_message && (
                                <p className="mt-2 break-words pl-[52px] text-xs text-danger">
                                  {c.error_message}
                                </p>
                              )}
                            </div>
                          </details>
                        ))}
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </Card>

        <AppsCampaignsCard
          apps={apps}
          campaigns={campaigns}
          memberships={memberships}
          creatorById={creatorById}
        />
      </div>
    </>
  );
}

const roundOrNull = (n: number | null) => (n == null ? null : Math.round(n));

/** Creator health at a glance: green ready, amber queued/scraping, red failed. */
function StatusDot({
  status,
  error,
}: {
  status: ResearchCreatorStatus;
  error?: string | null;
}) {
  const tone =
    status === "ready" ? "bg-success" : status === "failed" ? "bg-danger" : "bg-warning";
  return (
    <span
      title={status === "failed" && error ? `failed — ${error}` : status}
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${tone} ${
        status === "scraping" ? "animate-pulse" : ""
      }`}
    />
  );
}

/** The 7-day posting rhythm: a chip per day, lit when something went out. */
function DayStrip({ days }: { days: DayCell[] }) {
  return (
    <span className="flex items-center gap-1.5">
      {days.map((d, i) => (
        <span key={i} className="flex flex-col items-center gap-1">
          <span className="text-[9px] font-medium uppercase leading-none tracking-[0.08em] text-neutral-400">
            {d.label}
          </span>
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-[9px] text-xs font-semibold tabular-nums ${
              d.count > 0
                ? "bg-neutral-900 text-white inset-shadow-highlight"
                : "bg-neutral-900/[0.04] text-neutral-300 ring-1 ring-inset ring-hairline"
            }`}
          >
            {d.count}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Right-aligned figure with its all-time baseline underneath. When the page is
 *  on All time the two are the same number, so the caption drops the "vs". */
function MetricCell({
  value,
  all,
  windowed,
}: {
  value: string;
  all: string;
  windowed: boolean;
}) {
  return (
    <span className="text-right">
      <span className="block text-[15px] font-semibold tracking-[-0.01em] tabular-nums text-neutral-900">
        {value}
      </span>
      <span className="mt-0.5 block text-[11px] leading-tight text-neutral-400">
        {windowed ? `vs ${all}` : "all-time"}
      </span>
    </span>
  );
}

/** Label/value pair inside the fold-out. */
function RowFact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-400">
        {label}
      </span>
      <span className="text-sm tabular-nums text-neutral-700">{value}</span>
    </span>
  );
}

/** The apps & campaigns management card, unchanged — split out so the page
 *  component stays about the roster. */
function AppsCampaignsCard({
  apps,
  campaigns,
  memberships,
  creatorById,
}: {
  apps: ResearchApp[];
  campaigns: ResearchCampaign[];
  memberships: ResearchAppCreator[];
  creatorById: Map<string, ResearchCreator>;
}) {
  return (
        <Card
          title="Apps &amp; campaigns"
          id="apps"
          subtitle="The workspaces you scope the roster by, and the campaigns inside each."
        >
          <div className="space-y-4">
            {apps.length > 0 && (
              <ul className="stagger-children divide-y divide-black/[0.05]">
                {apps.map((a) => {
                  const appCampaigns = campaigns.filter((cp) => cp.app_id === a.id);
                  const appCreators = memberships
                    .filter((mem) => mem.app_id === a.id)
                    .map((mem) => creatorById.get(mem.research_creator_id))
                    .filter((cr): cr is ResearchCreator => !!cr);
                  return (
                    <li
                      key={a.id}
                      className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={a.name} src={a.logo_url} size={28} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-neutral-900">{a.name}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {appCampaigns.length === 0 ? (
                              <span className="text-xs text-neutral-400">No campaigns yet</span>
                            ) : (
                              appCampaigns.map((cp) => (
                                <span
                                  key={cp.id}
                                  className="rounded-md bg-neutral-500/[0.1] px-1.5 py-0.5 text-[11px] font-medium text-neutral-600 ring-1 ring-inset ring-neutral-500/[0.14]"
                                >
                                  {cp.name}
                                </span>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2.5">
                        <AvatarStack
                          people={appCreators.map((cr) => ({ handle: cr.handle, avatarUrl: cr.avatar_url }))}
                          size={20}
                        />
                        <span className="w-16 text-right font-mono text-[11px] text-neutral-400">
                          {appCreators.length} creator{appCreators.length === 1 ? "" : "s"}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="grid gap-3 border-t border-black/[0.05] pt-4 sm:grid-cols-2">
              <form action={createApp} className="flex items-end gap-2">
                <label className="flex-1">
                  <span className={labelClass}>New app</span>
                  <input name="name" placeholder="e.g. Trace" className={inputClass} required />
                </label>
                <SubmitButton pendingLabel="Adding…">Add</SubmitButton>
              </form>
              <form action={createCampaign} className="flex items-end gap-2">
                <label>
                  <span className={labelClass}>App</span>
                  <select name="appId" className={inputClass} required>
                    {apps.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex-1">
                  <span className={labelClass}>New campaign</span>
                  <input name="name" placeholder="e.g. IG Reels July" className={inputClass} required />
                </label>
                <SubmitButton pendingLabel="Adding…">Add</SubmitButton>
              </form>
            </div>
          </div>
        </Card>
  );
}
