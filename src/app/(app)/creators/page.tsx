import { Fragment } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type {
  ResearchApp,
  ResearchAppCreator,
  ResearchCampaign,
  ResearchCampaignCreator,
  ResearchCreator,
  ResearchVideo,
} from "@/lib/types";
import { summarizeCreator } from "@/lib/research";
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
  Avatar, AvatarStack, Card, EmptyState, PageHeader, PlatformIcon, StatusBadge,
  inputClass, labelClass, secondaryButtonClass, table, tableWrap, td, th, trHover,
} from "@/components/ui";
import { formatCompact, formatDate } from "@/lib/format";
import { parseDays, withinWindow, RangePicker } from "@/components/range-picker";
import { compareValues, parseSort, SortHeader, type SortDir } from "@/components/sort-header";
import { ScrapeAllButton } from "@/components/scrape-all-button";

const SORT_KEYS = [
  "creator", "app", "niche", "status", "followers", "videos", "views", "top", "scraped",
] as const;
type SortKey = (typeof SORT_KEYS)[number];

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
    key: "creator",
    dir: "asc",
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
  const rows = memberships
    .filter((m) => creatorById.has(m.research_creator_id))
    .filter((m) => !appFilter || m.app_id === appFilter)
    .map((m) => {
      const c = creatorById.get(m.research_creator_id)!;
      const app = apps.find((a) => a.id === m.app_id);
      const summary = summarizeCreator(withinWindow(videosByCreator.get(c.id) ?? [], days));
      const joined = (campaignsByCreator.get(c.id) ?? []).filter(
        (cm) => campaignById.get(cm.campaign_id)?.app_id === m.app_id
      );
      const joinedIds = new Set(joined.map((cm) => cm.campaign_id));
      const available = campaigns.filter(
        (cp) => cp.app_id === m.app_id && !joinedIds.has(cp.id)
      );
      return { m, c, app, summary, joined, available };
    })
    .sort((a, b) => {
      const value = (r: (typeof rows)[number]): string | number | null => {
        switch (sort.key) {
          case "app": return r.app?.name ?? null;
          case "niche": return r.m.niche;
          case "status": return r.c.status;
          case "followers": return r.c.follower_count;
          case "videos": return r.summary.videoCount;
          case "views": return r.summary.medianViews;
          case "top": return r.summary.topRated;
          case "scraped":
            return r.c.last_scraped_at ? new Date(r.c.last_scraped_at).getTime() : null;
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
  const orderedGroups: { app: ResearchApp | undefined; groupRows: typeof rows }[] = [];
  for (const app of apps) {
    const groupRows = rowsByApp.get(app.id);
    if (groupRows?.length) orderedGroups.push({ app, groupRows });
  }
  for (const [appId, groupRows] of rowsByApp) {
    if (!apps.some((a) => a.id === appId)) orderedGroups.push({ app: undefined, groupRows });
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
              <table className={table}>
                <thead>
                  <tr>
                    {(
                      [
                        ["Creator", "creator", "asc"],
                        ["Niche", "niche", "asc"],
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
                    <th className={th}>Campaigns</th>
                    {(
                      [
                        ["Status", "status", "asc"],
                        ["Followers", "followers", "desc"],
                        ["Videos", "videos", "desc"],
                        ["Median views", "views", "desc"],
                        ["Rated 8.0+", "top", "desc"],
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
                  {orderedGroups.map((group) => {
                    const totalFollowers = group.groupRows.reduce(
                      (sum, r) => sum + (r.c.follower_count ?? 0),
                      0
                    );
                    return (
                      <Fragment key={group.app?.id ?? "unknown"}>
                        {/* App band: the grouping IS the structure, so the app name
                            stops repeating down an "App" column. */}
                        <tr className="bg-surface-sunken">
                          <td colSpan={9} className="px-3 py-2">
                            <div className="flex items-center gap-2.5">
                              <Avatar name={group.app?.name ?? "?"} src={group.app?.logo_url} size={22} />
                              <span className="text-sm font-semibold tracking-[-0.01em] text-neutral-900">
                                {group.app?.name ?? "Unknown app"}
                              </span>
                              <span className="font-mono text-[11px] text-neutral-400">
                                {group.groupRows.length} creator{group.groupRows.length === 1 ? "" : "s"} · {formatCompact(totalFollowers)} followers
                              </span>
                            </div>
                          </td>
                        </tr>
                        {group.groupRows.map(({ m, c, summary, joined, available }) => (
                          <tr key={m.id} className={trHover}>
                            <td className={td}>
                              <Link
                                href={`/research/${c.id}`}
                                className="group/creator flex items-center gap-2.5"
                              >
                                <Avatar name={c.handle} src={c.avatar_url} size={32} />
                                <span className="flex items-center gap-1.5 font-mono text-[13px] font-medium text-neutral-900 group-hover/creator:underline">
                                  <PlatformIcon platform={c.platform} size={13} />@{c.handle}
                                </span>
                              </Link>
                            </td>
                            <td className={td}>
                              <form action={setNiche} className="flex items-center gap-1">
                                <input type="hidden" name="membershipId" value={m.id} />
                                <input
                                  name="niche"
                                  defaultValue={m.niche ?? ""}
                                  placeholder="niche…"
                                  className="w-28 rounded-md bg-transparent px-1.5 py-0.5 text-sm text-neutral-700 transition placeholder:text-neutral-400 hover:bg-surface-sunken focus:bg-surface focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/45"
                                />
                                <button
                                  type="submit"
                                  className="text-xs text-neutral-300 transition-colors hover:text-neutral-900"
                                  title="Save niche"
                                >
                                  ✓
                                </button>
                              </form>
                            </td>
                            <td className={td}>
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
                            </td>
                            <td className={td}>
                              <StatusBadge status={c.status} />
                            </td>
                            <td className={`${td} tabular-nums`}>{formatCompact(c.follower_count)}</td>
                            <td className={`${td} tabular-nums`}>{summary.videoCount}</td>
                            <td className={`${td} tabular-nums`}>{formatCompact(summary.medianViews)}</td>
                            <td className={`${td} tabular-nums`}>{summary.topRated}</td>
                            <td className={`${td} font-mono text-neutral-500`}>{formatDate(c.last_scraped_at)}</td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

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
      </div>
    </>
  );
}
