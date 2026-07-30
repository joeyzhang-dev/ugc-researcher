import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { ResearchCreator, ResearchVideo } from "@/lib/types";
import { summarizeCreator } from "@/lib/research";
import { addResearchCreator } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import {
  Avatar, Card, EmptyState, PageHeader, PlatformIcon, StatusBadge,
  inputClass, table, tableWrap, td, th, trHover,
} from "@/components/ui";
import { formatCompact, formatDate } from "@/lib/format";
import { parseDays, withinWindow, RangePicker } from "@/components/range-picker";
import { compareValues, parseSort, SortHeader, type SortDir } from "@/components/sort-header";
import { ScrapeAllButton } from "@/components/scrape-all-button";

const SORT_KEYS = [
  "creator", "status", "followers", "videos", "views", "top", "transcribed", "scraped", "added",
] as const;
type SortKey = (typeof SORT_KEYS)[number];

export const dynamic = "force-dynamic";
// The add-creator action runs a deep Apify scrape inline.
export const maxDuration = 300;

/** Outside-creator research: scrape a profile, study which videos lift above
 *  the account's own baseline, transcribe them, derive format categories. */
export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; days?: string; sort?: string; dir?: string }>;
}) {
  const { error, days: daysParam, sort: sortParam, dir: dirParam } = await searchParams;
  const days = parseDays(daysParam);
  const sort = parseSort<SortKey>(sortParam, dirParam, SORT_KEYS, {
    key: "added",
    dir: "desc",
  });
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
    return `/research${qs ? `?${qs}` : ""}`;
  };
  const sortHref = (key: SortKey, dir: SortDir) => hrefWith({ sort: key, dir });
  const supabase = await createClient();

  const [{ data: creatorsData }, { data: videosData }] = await Promise.all([
    // This tab is the outside creators we study — our own roster lives on /creators.
    supabase
      .from("research_creators")
      .select("*")
      .eq("kind", "research")
      .order("created_at", { ascending: false }),
    supabase
      .from("research_videos")
      .select(
        "id, research_creator_id, url, posted_at, view_count, like_count, comment_count, share_count, transcript_status"
      ),
  ]);
  const creators = (creatorsData ?? []) as ResearchCreator[];
  const videos = (videosData ?? []) as ResearchVideo[];
  const queuedCount = creators.filter((c) => c.scrape_queued_at != null).length;

  const videosByCreator = new Map<string, ResearchVideo[]>();
  for (const v of videos) {
    (videosByCreator.get(v.research_creator_id) ??
      videosByCreator.set(v.research_creator_id, []).get(v.research_creator_id)!).push(v);
  }

  const rows = creators
    .map((c) => {
      const vids = withinWindow(videosByCreator.get(c.id) ?? [], days);
      return {
        c,
        summary: summarizeCreator(vids),
        transcribed: vids.filter((v) => v.transcript_status === "transcribed").length,
      };
    })
    .sort((a, b) => {
      const value = (r: (typeof rows)[number]): string | number | null => {
        switch (sort.key) {
          case "creator": return r.c.handle;
          case "status": return r.c.status;
          case "followers": return r.c.follower_count;
          case "videos": return r.summary.videoCount;
          case "views": return r.summary.medianViews;
          case "top": return r.summary.topRated;
          case "transcribed": return r.transcribed;
          case "scraped":
            return r.c.last_scraped_at ? new Date(r.c.last_scraped_at).getTime() : null;
          default: return new Date(r.c.created_at).getTime();
        }
      };
      return compareValues(value(a), value(b), sort.dir) || a.c.handle.localeCompare(b.c.handle);
    });

  return (
    <>
      <PageHeader title="Research" />
      <p className="-mt-4 mb-5 max-w-3xl text-sm text-neutral-500">
        Study outside creators: scrape their recent reels, find which videos <em>lift</em> above
        the account&apos;s own baseline, transcribe them (local worker), and derive the formats
        worth copying.
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      <Card title="Add a creator">
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
          <SubmitButton pendingLabel="Scraping… (takes a minute)">Scrape profile</SubmitButton>
        </form>
      </Card>

      <div className="mt-5">
        <Card
          title="Creators under study"
          action={
            <span className="flex items-center gap-2 text-xs text-neutral-500">
              <ScrapeAllButton kinds={["research"]} queued={queuedCount} />
              <span className="hidden sm:inline">
                {days == null ? "All time" : `Posted in last ${days} days`}
              </span>
              <RangePicker
                days={days}
                hrefForDays={(d) => hrefWith({ days: d ? String(d) : null })}
              />
            </span>
          }
        >
          {creators.length === 0 ? (
            <EmptyState message="No research creators yet — paste a profile URL above." />
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
                        ["Rated 8.0+", "top", "desc"],
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
                <tbody className="divide-y divide-neutral-100">
                  {rows.map(({ c, summary, transcribed }) => {
                    return (
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
                            <span className="ml-2 text-xs text-red-600">{c.error_message}</span>
                          )}
                        </td>
                        <td className={`${td} tabular-nums`}>{formatCompact(c.follower_count)}</td>
                        <td className={`${td} tabular-nums`}>{summary.videoCount}</td>
                        <td className={`${td} tabular-nums`}>
                          {formatCompact(summary.medianViews)}
                        </td>
                        <td className={`${td} tabular-nums`}>{summary.topRated}</td>
                        <td className={`${td} tabular-nums`}>
                          {transcribed}/{summary.videoCount}
                        </td>
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
