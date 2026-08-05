import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type {
  ResearchCreator,
  ResearchDiscordChannel,
  ResearchDiscordMessage,
  ResearchDiscordUser,
} from "@/lib/types";
import {
  Avatar, Card, EmptyState, KpiCard, PageHeader, StatusBadge,
} from "@/components/ui";
import { formatCompact } from "@/lib/format";
import { NICHE_PALETTE } from "../scripts/cal";
import { DiscordLink } from "@/components/discord-link";
import { channelUrl, cleanSnippet, messageUrl, ROLE_CHIP, ROLE_SENDER } from "@/lib/discord-render";
import { linkChannelToCreator } from "./actions";

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
  const roleCounts: Record<string, number> = {};
  let attachmentCount = 0;
  for (const m of messages) {
    const s =
      statsByChannel.get(m.channel_id) ??
      statsByChannel.set(m.channel_id, { count: 0, recent: [], last: null }).get(m.channel_id)!;
    s.count += 1;
    if (s.recent.length < SNAPSHOT_MESSAGES) s.recent.push(m);
    if (!s.last) s.last = m.posted_at;
    roleCounts[m.author_role] = (roleCounts[m.author_role] ?? 0) + 1;
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
      <PageHeader title="Discord" />
      <p className="-mt-4 mb-5 max-w-3xl text-sm text-neutral-500">
        Every coaching channel on the Folk UGC server: an AI summary of where each creator&apos;s
        workflow stands and the last few messages. The local worker pulls every minute, re-summarizes
        what changed every 15, and syncs launchpoint scripts into Scripts automatically.
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="Creators"
          value={String(channels.length)}
          sub={`${creating} creating · ${channels.length - creating} not creating`}
          icon="users"
          tone="neutral"
        />
        <KpiCard
          label="Messages"
          value={formatCompact(messages.length)}
          sub={`${linked}/${channels.length} channels linked to roster`}
          icon="trend"
          tone="sky"
        />
        <KpiCard
          label="Drafts / media"
          value={formatCompact(attachmentCount)}
          sub="attachments shared in channels"
          icon="play"
          tone="violet"
        />
        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <span className="block text-xs font-medium text-neutral-500">Message roles</span>
          {(() => {
            // Stacked role bar + legend, same palette as the old dashboard
            // (creator blue, coach amber, launchpoint green, unknown gray).
            const total = Math.max(1, messages.length);
            const segs = [
              ["creator", "bg-blue-500"],
              ["coach", "bg-amber-500"],
              ["launchpoint", "bg-green-500"],
              ["unknown", "bg-[#cbd2e0]"],
            ] as const;
            return (
              <>
                <span className="mt-2 mb-1.5 flex h-3 overflow-hidden rounded-full bg-neutral-100">
                  {segs.map(([role, color]) => (
                    <span
                      key={role}
                      className={`block h-full ${color}`}
                      style={{ width: `${(((roleCounts[role] ?? 0) / total) * 100).toFixed(1)}%` }}
                      title={`${role}: ${roleCounts[role] ?? 0}`}
                    />
                  ))}
                </span>
                <span className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-neutral-500">
                  {segs.map(([role, color]) => (
                    <span key={role} className="flex items-center gap-1">
                      <span className={`inline-block h-2 w-2 rounded-sm ${color}`} />
                      {role}{" "}
                      <b className="font-semibold text-neutral-900">
                        {formatCompact(roleCounts[role] ?? 0)}
                      </b>
                    </span>
                  ))}
                </span>
              </>
            );
          })()}
        </div>
      </div>

      <Card
        title={`${rows.length} creator${rows.length === 1 ? "" : "s"}`}
        action={
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
              {(
                [
                  ["all", "All"],
                  ["creating", "Creating"],
                  ["paused", "Not creating"],
                ] as const
              ).map(([key, label]) => (
                <Link
                  key={key}
                  href={hrefWith(key)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    status === key
                      ? "bg-white font-semibold text-neutral-900 shadow-sm"
                      : "text-neutral-500 hover:text-neutral-900"
                  }`}
                >
                  {label}
                </Link>
              ))}
            </span>
            <form method="GET" action="/discord">
              {status !== "all" && <input type="hidden" name="status" value={status} />}
              <input
                name="q"
                defaultValue={q ?? ""}
                placeholder="Filter by creator, niche, or channel…"
                className="w-56 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs placeholder:text-neutral-300 focus:border-neutral-400 focus:outline-none"
              />
            </form>
          </span>
        }
      >
        {rows.length === 0 ? (
          <EmptyState message="No channels match — the worker's discover step fills this page." />
        ) : (
          <div className="hidden gap-4 border-b border-neutral-100 pb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400 lg:grid lg:grid-cols-[200px_minmax(0,5fr)_minmax(0,6fr)_70px]">
            <span>Creator</span>
            <span>Summary</span>
            <span>Recent</span>
            <span />
          </div>
        )}
        <ul className="divide-y divide-neutral-100">
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
                      className="block truncate text-[11px] text-neutral-400 underline-offset-2 hover:text-neutral-900 hover:underline"
                      title="Open their Instagram"
                    >
                      @{creator.handle}
                    </a>
                  )}
                  <p className="mt-1 flex flex-wrap items-center gap-1">
                    {ch.niche ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${nicheClass(ch.niche)}`}
                      >
                        {ch.niche}
                      </span>
                    ) : (
                      <StatusBadge status={paused ? "Not creating" : "Creating"} />
                    )}
                  </p>
                  {!creator && (
                    <form action={linkChannelToCreator} className="mt-1.5 flex items-center gap-1">
                      <input type="hidden" name="channelId" value={ch.channel_id} />
                      <input
                        name="creator"
                        list="roster-creator-handles"
                        required
                        placeholder="link @instagram…"
                        className="w-36 rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-xs text-neutral-700 placeholder:text-neutral-300 focus:border-neutral-400 focus:outline-none"
                        title="Type the creator's Instagram handle or profile URL — a new one is added to the roster and queued for scraping"
                      />
                      <button
                        type="submit"
                        className="text-xs text-neutral-400 hover:text-neutral-900"
                        title="Link this channel to the creator"
                      >
                        ✓
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
                  <p className="text-sm text-neutral-300">summary pending…</p>
                )}
              </div>

              <div className="min-w-0">
                {stats.recent.length === 0 ? (
                  <p className="text-xs text-neutral-300">no messages yet</p>
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
                            className={`max-w-24 shrink-0 truncate rounded px-1.5 py-px font-semibold ${
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

              <div className="text-right text-xs whitespace-nowrap text-neutral-400">
                <p>{relativeTime(stats.last)}</p>
                <Link
                  href={`/discord/${ch.channel_id}`}
                  className="mt-1 inline-block text-neutral-400 underline-offset-2 hover:text-neutral-900 hover:underline"
                >
                  feed →
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
