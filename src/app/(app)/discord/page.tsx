import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type {
  ResearchCreator,
  ResearchDiscordChannel,
  ResearchDiscordMessage,
  ResearchDiscordUser,
} from "@/lib/types";
import {
  Avatar, Card, EmptyState, KpiCard, PageHeader, Segmented, StatusBadge,
} from "@/components/ui";
import { formatCompact } from "@/lib/format";
import { NICHE_PALETTE } from "../scripts/cal";
import { DiscordLink } from "@/components/discord-link";
import { channelUrl, cleanSnippet, messageUrl, ROLE_CHIP, ROLE_SENDER } from "@/lib/discord-render";
import { linkChannelToCreator } from "./actions";
import { DISCORD_DEPRECATED, DiscordDeprecatedNotice } from "./deprecated";

export const dynamic = "force-dynamic";

const NOT_CREATING = "Not Creating 🚫";
const SNAPSHOT_MESSAGES = 5;

interface ChannelSummary {
  channel_id: string;
  status: string | null;
  summary: string;
}

/** Consolidated view of the Folk UGC Discord (the old discord-crm dashboard):
 *  per-channel cards with an AI summary of where the workflow stands and a
 *  snapshot of the last few messages. The 24/7 worker keeps everything fresh;
 *  click a creator for the full feed. */
export default async function DiscordPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; error?: string }>;
}) {
  if (DISCORD_DEPRECATED) return <DiscordDeprecatedNotice />;
  const { status: statusParam, q, error } = await searchParams;
  const status = statusParam === "creating" || statusParam === "paused" ? statusParam : "all";
  const supabase = await createClient();

  const [
    { data: channelsData },
    { data: creatorsData },
    { data: usersData },
    { data: messagesData },
    { data: summariesData },
    { data: scriptNichesData },
    { data: membershipNichesData },
  ] = await Promise.all([
    supabase
      .from("research_discord_channels")
      .select("channel_id::text, guild_id::text, channel_name, research_creator_id, is_tracked, niche, category")
      .eq("is_tracked", true),
    supabase.from("research_creators").select("*").eq("kind", "roster"),
    supabase
      .from("research_discord_users")
      .select("discord_user_id::text, username, global_name, nickname, display_name, is_bot"),
    // Newest-first, so the first N we meet per channel are its latest.
    supabase
      .from("research_discord_messages")
      .select(
        "channel_id::text, message_id::text, author_discord_user_id::text, author_role, content, attachments, posted_at"
      )
      .order("posted_at", { ascending: false })
      .limit(10000),
    supabase.from("research_discord_summaries").select("channel_id::text, status, summary"),
    supabase.from("research_scripts").select("niche"),
    supabase.from("research_app_creators").select("niche"),
  ]);
  // Name-map inputs, same priority as the old dashboard: roster creator name
  // first, then the user's server display name, then the enrolled-role note.
  const [{ data: rosterIdsData }, { data: roleNotesData }] = await Promise.all([
    supabase
      .from("research_creators")
      .select("handle, discord_user_id::text")
      .eq("kind", "roster")
      .not("discord_user_id", "is", null),
    supabase.from("research_discord_user_roles").select("discord_user_id::text, role, note"),
  ]);
  const channels = (channelsData ?? []) as unknown as ResearchDiscordChannel[];
  const creators = (creatorsData ?? []) as ResearchCreator[];
  const users = (usersData ?? []) as unknown as ResearchDiscordUser[];
  const messages = (messagesData ?? []) as unknown as ResearchDiscordMessage[];
  const summaries = (summariesData ?? []) as unknown as ChannelSummary[];

  const creatorById = new Map(creators.map((c) => [c.id, c]));
  const summaryByChannel = new Map(summaries.map((s) => [s.channel_id, s]));

  // discord_user_id -> readable name (roster name > server display name > role
  // note), used for sender chips and for resolving <@id> mentions in text.
  const names = new Map<string, string>();
  for (const r of (rosterIdsData ?? []) as unknown as { handle: string; discord_user_id: string }[]) {
    names.set(r.discord_user_id, r.handle);
  }
  for (const u of users) {
    if (!names.has(u.discord_user_id)) {
      const label = u.nickname || u.global_name || u.display_name || u.username;
      if (label) names.set(u.discord_user_id, label);
    }
  }
  for (const r of (roleNotesData ?? []) as unknown as { discord_user_id: string; role: string; note: string | null }[]) {
    if (!names.has(r.discord_user_id)) names.set(r.discord_user_id, r.note ?? r.role);
  }
  const channelNames = new Map(channels.map((c) => [c.channel_id, c.channel_name ?? "channel"]));

  // Same color dealing as the scripts dashboard: palette keyed by position in
  // the sorted full known-niche list, so "Finance General" matches over there.
  const knownNiches = [
    ...new Set(
      [
        ...(scriptNichesData ?? []).map((r: { niche: string | null }) => r.niche),
        ...(membershipNichesData ?? []).map((r: { niche: string | null }) => r.niche),
      ].filter((n): n is string => !!n)
    ),
  ].sort();
  const nicheColorIndex = Object.fromEntries(knownNiches.map((n, i) => [n, i]));
  const nicheClass = (niche: string) =>
    NICHE_PALETTE[(nicheColorIndex[niche] ?? 0) % NICHE_PALETTE.length].row;

  // One pass over the newest-first message list: per-channel counts + the
  // first SNAPSHOT_MESSAGES become the card's recent feed.
  const statsByChannel = new Map<
    string,
    { count: number; recent: ResearchDiscordMessage[]; last: string | null }
  >();
  let attachmentCount = 0;
  for (const m of messages) {
    const s =
      statsByChannel.get(m.channel_id) ??
      statsByChannel.set(m.channel_id, { count: 0, recent: [], last: null }).get(m.channel_id)!;
    s.count += 1;
    if (s.recent.length < SNAPSHOT_MESSAGES) s.recent.push(m);
    if (!s.last) s.last = m.posted_at;
    attachmentCount += m.attachments?.length ?? 0;
  }

  const query = (q ?? "").trim().toLowerCase();
  const rows = channels
    .map((ch) => {
      const creator = ch.research_creator_id ? creatorById.get(ch.research_creator_id) : undefined;
      const stats = statsByChannel.get(ch.channel_id) ?? { count: 0, recent: [], last: null };
      const summary = summaryByChannel.get(ch.channel_id);
      const paused = ch.category === NOT_CREATING;
      const name = (ch.channel_name ?? "").replace(/^(coaching-|coachking-|influencer-)/, "");
      return { ch, creator, stats, summary, paused, name };
    })
    .filter((r) => (status === "creating" ? !r.paused : status === "paused" ? r.paused : true))
    .filter(
      (r) =>
        !query ||
        r.name.toLowerCase().includes(query) ||
        (r.ch.channel_name ?? "").toLowerCase().includes(query) ||
        (r.ch.niche ?? "").toLowerCase().includes(query) ||
        (r.creator?.handle ?? "").toLowerCase().includes(query) ||
        (r.creator?.discord_username ?? "").toLowerCase().includes(query)
    )
    .sort((a, b) => (b.stats.last ?? "").localeCompare(a.stats.last ?? ""));

  const creating = channels.filter((c) => c.category !== NOT_CREATING).length;
  const linked = channels.filter((c) => c.research_creator_id).length;
  const pausedCount = channels.length - creating;
  const unlinked = channels.length - linked;
  // Activity split across the creating channels: a creator who posted in the
  // last week reads as active, everyone else (quiet or never) as stalled.
  const nowMs = Date.now();
  const WEEK_MS = 7 * 86_400_000;
  let active = 0;
  let stalled = 0;
  for (const ch of channels) {
    if (ch.category === NOT_CREATING) continue;
    const last = statsByChannel.get(ch.channel_id)?.last ?? null;
    if (last && nowMs - new Date(last).getTime() < WEEK_MS) active += 1;
    else stalled += 1;
  }
  // Roster creators not yet claimed by a channel — the link dropdown's options.
  const linkedCreatorIds = new Set(
    channels.map((c) => c.research_creator_id).filter(Boolean)
  );
  const linkableCreators = creators
    .filter((c) => !linkedCreatorIds.has(c.id))
    .sort((a, b) => a.handle.localeCompare(b.handle));
  const hrefWith = (s: string) => {
    const sp = new URLSearchParams();
    if (s !== "all") sp.set("status", s);
    if (q) sp.set("q", q);
    const qs = sp.toString();
    return `/discord${qs ? `?${qs}` : ""}`;
  };

  return (
    <>
      <PageHeader
        title="Discord"
        subtitle="Every coaching channel on the Folk UGC server: the AI read on where each creator's workflow stands, plus their latest messages. The local worker pulls every minute, re-summarizes every 15, and syncs Launchpoint scripts into Scripts automatically."
      />

      {error && (
        <div className="mb-4 rounded-xl bg-danger/[0.1] px-3.5 py-2.5 text-sm text-danger ring-1 ring-inset ring-danger/[0.22]">
          {error}
        </div>
      )}

      <div className="stagger-children mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="Channels"
          value={String(channels.length)}
          sub={`${creating} creating · ${pausedCount} not creating`}
          icon="users"
          tone="neutral"
        />
        <KpiCard
          label="Active"
          value={String(active)}
          sub="creator messaged in the last 7 days"
          icon="check"
          tone="emerald"
        />
        <KpiCard
          label="Stalled"
          value={String(stalled)}
          sub="creating, but quiet 7+ days"
          icon="clock"
          tone={stalled ? "amber" : "neutral"}
        />
        <KpiCard
          label="Unlinked"
          value={String(unlinked)}
          sub="no roster creator linked yet"
          icon="alert"
          tone={unlinked ? "amber" : "neutral"}
        />
      </div>

      <Card
        title="Channels"
        subtitle={`${rows.length} of ${channels.length} shown · ${linked} linked · ${formatCompact(messages.length)} messages`}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Segmented
              size="sm"
              value={status}
              aria-label="Filter channels by state"
              items={[
                { value: "all", label: "All", href: hrefWith("all") },
                { value: "creating", label: "Creating", href: hrefWith("creating") },
                { value: "paused", label: "Not creating", href: hrefWith("paused") },
              ]}
            />
            <form method="GET" action="/discord">
              {status !== "all" && <input type="hidden" name="status" value={status} />}
              <input
                name="q"
                defaultValue={q ?? ""}
                placeholder="Filter by creator or niche…"
                className="w-52 rounded-lg bg-surface px-3 py-1.5 text-xs text-neutral-900 shadow-[inset_0_1px_2px_rgb(9_9_11/0.04)] ring-1 ring-hairline transition placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/45"
              />
            </form>
          </div>
        }
      >
        {rows.length === 0 ? (
          <EmptyState message="No channels match — the worker's discover step fills this page." />
        ) : (
          <div className="hidden gap-4 border-b border-hairline pb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-400 lg:grid lg:grid-cols-[200px_minmax(0,5fr)_minmax(0,6fr)_70px]">
            <span>Creator &amp; state</span>
            <span>Summary</span>
            <span>Recent</span>
            <span />
          </div>
        )}
        <ul className="divide-y divide-black/[0.05]">
          {rows.map(({ ch, creator, stats, summary, paused, name }) => (
            <li
              key={ch.channel_id}
              className="grid gap-x-4 gap-y-2 py-3.5 lg:grid-cols-[200px_minmax(0,5fr)_minmax(0,6fr)_70px]"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <DiscordLink
                  href={channelUrl(ch.guild_id, ch.channel_id)}
                  title={`Open #${ch.channel_name} in Discord`}
                  className="mt-0.5 shrink-0"
                >
                  <Avatar name={creator?.handle ?? name} src={creator?.avatar_url} size={28} />
                </DiscordLink>
                <div className="min-w-0">
                  <DiscordLink
                    href={channelUrl(ch.guild_id, ch.channel_id)}
                    title={`Open #${ch.channel_name} in Discord`}
                    className="block truncate font-medium text-neutral-900 hover:underline"
                  >
                    {name}
                  </DiscordLink>
                  {creator && (
                    <a
                      href={creator.profile_url ?? `https://www.instagram.com/${creator.handle}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate font-mono text-[11px] text-neutral-400 underline-offset-2 hover:text-neutral-900 hover:underline"
                      title="Open their Instagram"
                    >
                      @{creator.handle}
                    </a>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {!creator && <StatusBadge status="Unlinked" tone="warning" />}
                    {paused ? (
                      <StatusBadge status="Not creating" />
                    ) : (
                      creator && !ch.niche && <StatusBadge status="Creating" />
                    )}
                    {ch.niche && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${nicheClass(ch.niche)}`}
                      >
                        {ch.niche}
                      </span>
                    )}
                  </div>
                  {!creator && (
                    <form action={linkChannelToCreator} className="mt-2 flex items-center gap-1.5">
                      <input type="hidden" name="channelId" value={ch.channel_id} />
                      <input
                        name="creator"
                        list="roster-creator-handles"
                        required
                        placeholder="link @instagram…"
                        className="w-36 rounded-lg bg-surface px-2 py-1 font-mono text-xs text-neutral-700 shadow-[inset_0_1px_2px_rgb(9_9_11/0.04)] ring-1 ring-hairline transition placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/45"
                        title="Type the creator's Instagram handle or profile URL — a new one is added to the roster and queued for scraping"
                      />
                      <button
                        type="submit"
                        className="rounded-lg bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-neutral-800 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                        title="Link this channel to the creator"
                      >
                        Link
                      </button>
                    </form>
                  )}
                </div>
              </div>

              <div className="min-w-0">
                {summary ? (
                  <>
                    {summary.status && <StatusBadge status={summary.status} />}
                    <p className="mt-1 text-sm leading-snug text-neutral-600">{summary.summary}</p>
                  </>
                ) : (
                  <p className="text-sm text-neutral-400">summary pending…</p>
                )}
              </div>

              <div className="min-w-0">
                {stats.recent.length === 0 ? (
                  <p className="text-xs text-neutral-400">no messages yet</p>
                ) : (
                  <ul className="space-y-1">
                    {stats.recent.map((m, i) => {
                      const who =
                        (m.author_discord_user_id && names.get(m.author_discord_user_id)) ||
                        ROLE_SENDER[m.author_role] ||
                        "someone";
                      const text = cleanSnippet(m.content, names, channelNames);
                      return (
                        <li key={i} className="flex items-start gap-1.5 text-xs">
                          <span
                            className={`max-w-24 shrink-0 truncate rounded-md px-1.5 py-px font-semibold ${
                              ROLE_CHIP[m.author_role] ?? ROLE_CHIP.unknown
                            }`}
                            title={m.author_role}
                          >
                            {who}
                          </span>
                          <DiscordLink
                            href={messageUrl(ch.guild_id, ch.channel_id, m.message_id)}
                            title={`Open this message in Discord (${relativeTime(m.posted_at)})`}
                            className="min-w-0 truncate text-neutral-500 hover:text-neutral-900 hover:underline"
                          >
                            {text ||
                              (m.attachments?.length
                                ? `📎 ${m.attachments.length} video/attachment`
                                : "—")}
                          </DiscordLink>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="whitespace-nowrap text-right text-xs text-neutral-400">
                <p className="font-mono">{relativeTime(stats.last)}</p>
                <Link
                  href={`/discord/${ch.channel_id}`}
                  className="group mt-1 inline-flex items-center gap-0.5 font-medium text-neutral-500 transition-colors hover:text-neutral-900"
                >
                  feed
                  <span
                    aria-hidden
                    className="transition-transform duration-200 ease-fluid group-hover:translate-x-0.5"
                  >
                    →
                  </span>
                </Link>
              </div>
            </li>
          ))}
        </ul>
        {/* Suggestions for the link input: roster creators no channel claims yet. */}
        <datalist id="roster-creator-handles">
          {linkableCreators.map((c) => (
            <option key={c.id} value={`@${c.handle}`} />
          ))}
        </datalist>
      </Card>
    </>
  );
}

/** "just now" / "3h ago" / "2d ago" — the freshness read the old dashboard had. */
function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
