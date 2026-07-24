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
  Avatar, Card, EmptyState, PageHeader, PlatformIcon, StatusBadge,
  inputClass, labelClass, table, tableWrap, td, th, trHover,
} from "@/components/ui";
import { formatCompact, formatDate } from "@/lib/format";
import { parseDays, withinWindow, RangePicker } from "@/components/range-picker";

export const dynamic = "force-dynamic";
// Adding a roster creator runs a deep Apify scrape inline.
export const maxDuration = 300;

/** Our creators, organised per app: which niche each runs for that app, which
 *  campaigns they're in, and the same scrape/lift stats as the research pool. */
export default async function OurCreatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; app?: string; days?: string }>;
}) {
  const { error, app: appFilter, days: daysParam } = await searchParams;
  const days = parseDays(daysParam);
  const supabase = await createClient();

  const hrefWith = (overrides: { app?: string | null; days?: string | null }) => {
    const sp = new URLSearchParams();
    if (appFilter) sp.set("app", appFilter);
    if (days) sp.set("days", String(days));
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
    .sort((a, b) => {
      const ca = creatorById.get(a.research_creator_id)!;
      const cb = creatorById.get(b.research_creator_id)!;
      return ca.handle.localeCompare(cb.handle);
    });

  return (
    <>
      <PageHeader
        title="Our creators"
        action={
          <RangePicker days={days} hrefForDays={(d) => hrefWith({ days: d ? String(d) : null })} />
        }
      />
      <p className="-mt-4 mb-5 max-w-3xl text-sm text-neutral-500">
        The creators posting for us, organised per app. Each creator carries a niche tag per app
        (their content lane for that product) and can sit in multiple campaigns. Scraping, lift
        scores and transcripts work exactly like the research pool.
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card title="Add a creator">
          <form action={addRosterCreator} className="flex flex-wrap items-end gap-3">
            <label className="min-w-56 flex-1">
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
            <SubmitButton pendingLabel="Scraping… (takes a minute)">Add &amp; scrape</SubmitButton>
          </form>
        </Card>

        <Card title="Apps & campaigns">
          <div className="space-y-3">
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
        </Card>
      </div>

      <div className="mt-5">
        <Card
          title="Roster"
          action={
            <span className="flex items-center gap-1 text-xs">
              <Link
                href={hrefWith({ app: null })}
                className={`rounded-md px-2.5 py-1 transition-colors ${!appFilter ? "bg-neutral-900 font-medium text-white" : "text-neutral-500 hover:text-neutral-900"}`}
              >
                All apps
              </Link>
              {apps.map((a) => (
                <Link
                  key={a.id}
                  href={hrefWith({ app: appFilter === a.id ? null : a.id })}
                  className={`rounded-md px-2.5 py-1 transition-colors ${appFilter === a.id ? "bg-neutral-900 font-medium text-white" : "text-neutral-500 hover:text-neutral-900"}`}
                >
                  {a.name}
                </Link>
              ))}
            </span>
          }
        >
          {rows.length === 0 ? (
            <EmptyState message="No roster creators yet — add one above (pick the app they promote and tag their niche)." />
          ) : (
            <div className={tableWrap}>
              <table className={table}>
                <thead>
                  <tr>
                    <th className={th}>Creator</th>
                    <th className={th}>App</th>
                    <th className={th}>Niche</th>
                    <th className={th}>Campaigns</th>
                    <th className={th}>Status</th>
                    <th className={th}>Followers</th>
                    <th className={th}>Videos</th>
                    <th className={th}>Median views</th>
                    <th className={th}>Rated 8.0+</th>
                    <th className={th}>Last scraped</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {rows.map((m) => {
                    const c = creatorById.get(m.research_creator_id)!;
                    const app = apps.find((a) => a.id === m.app_id);
                    const vids = withinWindow(videosByCreator.get(c.id) ?? [], days);
                    const summary = summarizeCreator(vids);
                    const joined = (campaignsByCreator.get(c.id) ?? []).filter(
                      (cm) => campaignById.get(cm.campaign_id)?.app_id === m.app_id
                    );
                    const joinedIds = new Set(joined.map((cm) => cm.campaign_id));
                    const available = campaigns.filter(
                      (cp) => cp.app_id === m.app_id && !joinedIds.has(cp.id)
                    );
                    return (
                      <tr key={m.id} className={trHover}>
                        <td className={td}>
                          <Link
                            href={`/research/${c.id}`}
                            className="flex items-center gap-2.5 font-medium text-neutral-900 hover:underline"
                          >
                            <Avatar name={c.handle} src={c.avatar_url} size={28} />
                            <span className="flex items-center gap-1.5">
                              <PlatformIcon platform={c.platform} size={13} />@{c.handle}
                            </span>
                          </Link>
                        </td>
                        <td className={`${td} font-medium`}>{app?.name ?? "—"}</td>
                        <td className={td}>
                          <form action={setNiche} className="flex items-center gap-1">
                            <input type="hidden" name="membershipId" value={m.id} />
                            <input
                              name="niche"
                              defaultValue={m.niche ?? ""}
                              placeholder="niche…"
                              className="w-28 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm hover:border-neutral-200 focus:border-neutral-300 focus:bg-white focus:outline-none"
                            />
                            <button
                              type="submit"
                              className="text-xs text-neutral-300 hover:text-neutral-700"
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
                                  className="group inline-flex items-center gap-1 rounded-md bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 hover:bg-red-50 hover:text-red-600"
                                  title="Remove from campaign"
                                >
                                  {campaignById.get(cm.campaign_id)?.name}
                                  <span className="text-sky-300 group-hover:text-red-400">✕</span>
                                </button>
                              </form>
                            ))}
                            {available.length > 0 && (
                              <form action={assignToCampaign} className="inline-flex items-center gap-1">
                                <input type="hidden" name="creatorId" value={c.id} />
                                <input type="hidden" name="appId" value={m.app_id} />
                                <select
                                  name="campaignId"
                                  className="rounded-md border border-neutral-200 bg-white px-1 py-0.5 text-xs text-neutral-600"
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
                                  className="text-xs text-neutral-400 hover:text-neutral-800"
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
                        <td className={td}>{formatDate(c.last_scraped_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
