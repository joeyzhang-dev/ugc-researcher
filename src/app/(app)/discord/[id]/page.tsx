import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type {
  DiscordAuthorRole,
  ResearchCreator,
  ResearchDiscordChannel,
  ResearchDiscordMessage,
  ResearchDiscordUser,
} from "@/lib/types";
import { Avatar, Card, EmptyState, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { NICHE_PALETTE } from "../../scripts/cal";
import { DiscordLink } from "@/components/discord-link";
import { channelUrl, cleanSnippet, messageUrl, ROLE_CHIP, ROLE_SENDER } from "@/lib/discord-render";

export const dynamic = "force-dynamic";

const NOT_CREATING = "Not Creating 🚫";
const FEED_LIMIT = 300;

const ROLES: readonly DiscordAuthorRole[] = ["creator", "coach", "launchpoint", "unknown"];

/** One coaching channel's recent feed — the drilldown the old discord-crm
 *  dashboard had, minus the AI summary (that analysis lives in this app now). */
export default async function DiscordChannelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ role?: string }>;
}) {
  const { id } = await params;
  const { role: roleParam } = await searchParams;
  const role = ROLES.includes(roleParam as DiscordAuthorRole)
    ? (roleParam as DiscordAuthorRole)
    : null;
  if (!/^\d+$/.test(id)) notFound();
  const supabase = await createClient();

  const { data: channelData } = await supabase
    .from("research_discord_channels")
    .select("channel_id::text, guild_id::text, channel_name, research_creator_id, is_tracked, niche, category")
    .eq("channel_id", id)
    .maybeSingle();
  if (!channelData) notFound();
  const channel = channelData as unknown as ResearchDiscordChannel;

  let feedQuery = supabase
    .from("research_discord_messages")
    .select(
      "id, channel_id::text, message_id::text, author_discord_user_id::text, author_role, is_bot, content, attachments, posted_at"
    )
    .eq("channel_id", id)
    .order("posted_at", { ascending: false })
    .limit(FEED_LIMIT);
  if (role) feedQuery = feedQuery.eq("author_role", role);

  const [
    { data: creatorData },
    { data: usersData },
    { data: messagesData },
    roleCounts,
    { data: scriptNichesData },
    { data: membershipNichesData },
    { data: summaryData },
    { data: rosterIdsData },
    { data: roleNotesData },
    { data: allChannelsData },
  ] = await Promise.all([
      channel.research_creator_id
        ? supabase.from("research_creators").select("*").eq("id", channel.research_creator_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("research_discord_users")
        .select("discord_user_id::text, username, global_name, nickname, display_name, is_bot"),
      feedQuery,
      Promise.all(
        ROLES.map(async (r) => {
          const { count } = await supabase
            .from("research_discord_messages")
            .select("id", { count: "exact", head: true })
            .eq("channel_id", id)
            .eq("author_role", r);
          return [r, count ?? 0] as const;
        })
      ),
      supabase.from("research_scripts").select("niche"),
      supabase.from("research_app_creators").select("niche"),
      supabase
        .from("research_discord_summaries")
        .select("status, summary, updated_at")
        .eq("channel_id", id)
        .maybeSingle(),
      supabase
        .from("research_creators")
        .select("handle, discord_user_id::text")
        .eq("kind", "roster")
        .not("discord_user_id", "is", null),
      supabase.from("research_discord_user_roles").select("discord_user_id::text, role, note"),
      supabase.from("research_discord_channels").select("channel_id::text, channel_name"),
    ]);
  const creator = creatorData as ResearchCreator | null;
  const users = (usersData ?? []) as unknown as ResearchDiscordUser[];
  const messages = (messagesData ?? []) as unknown as ResearchDiscordMessage[];
  const total = roleCounts.reduce((sum, [, n]) => sum + n, 0);
  const summary = summaryData as { status: string | null; summary: string } | null;

  // Same name priority as the overview: roster name > server display > note.
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
  const channelNames = new Map(
    ((allChannelsData ?? []) as unknown as { channel_id: string; channel_name: string | null }[]).map(
      (c) => [c.channel_id, c.channel_name ?? "channel"]
    )
  );

  // Same palette dealing as the scripts dashboard, so the niche pill matches.
  const knownNiches = [
    ...new Set(
      [
        ...(scriptNichesData ?? []).map((r: { niche: string | null }) => r.niche),
        ...(membershipNichesData ?? []).map((r: { niche: string | null }) => r.niche),
      ].filter((n): n is string => !!n)
    ),
  ].sort();
  const nicheClass = (niche: string) =>
    NICHE_PALETTE[(knownNiches.indexOf(niche) < 0 ? 0 : knownNiches.indexOf(niche)) % NICHE_PALETTE.length].row;

  const hrefWith = (r: DiscordAuthorRole | null) =>
    r ? `/discord/${id}?role=${r}` : `/discord/${id}`;

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/discord"
            className="text-sm text-neutral-400 transition-colors hover:text-neutral-900"
          >
            ← Discord
          </Link>
          <span className="flex items-center gap-2.5">
            <Avatar name={creator?.handle ?? channel.channel_name ?? "?"} src={creator?.avatar_url} size={32} />
            <span>
              <span className="flex items-center gap-2 text-[20px] font-bold tracking-tight">
                <DiscordLink
                  href={channelUrl(channel.guild_id, channel.channel_id)}
                  title={`Open #${channel.channel_name} in Discord`}
                  className="hover:underline"
                >
                  {channel.channel_name}
                </DiscordLink>
                <StatusBadge status={channel.category === NOT_CREATING ? "Not creating" : "Creating"} />
                {channel.niche && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${nicheClass(channel.niche)}`}
                  >
                    {channel.niche}
                  </span>
                )}
              </span>
              <span className="block text-xs text-neutral-400">
                {creator ? (
                  <>
                    <Link href={`/research/${creator.id}`} className="hover:underline">
                      @{creator.handle}
                    </Link>
                    {creator.discord_username ? ` · ${creator.discord_username}` : ""}
                  </>
                ) : (
                  "not linked to a roster creator"
                )}
              </span>
            </span>
          </span>
        </div>
      </div>

      {summary && (
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4">
          {summary.status && <StatusBadge status={summary.status} />}
          <p className="text-sm leading-snug text-neutral-600">{summary.summary}</p>
        </div>
      )}

      <Card
        title={`Feed${messages.length === FEED_LIMIT ? ` — last ${FEED_LIMIT}` : ""}`}
        action={
          <span className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
            <Link
              href={hrefWith(null)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                !role ? "bg-white font-semibold text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-900"
              }`}
            >
              All · {total}
            </Link>
            {roleCounts.map(([r, n]) =>
              n > 0 ? (
                <Link
                  key={r}
                  href={hrefWith(r)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    role === r
                      ? "bg-white font-semibold text-neutral-900 shadow-sm"
                      : "text-neutral-500 hover:text-neutral-900"
                  }`}
                >
                  {r} · {n}
                </Link>
              ) : null
            )}
          </span>
        }
      >
        {messages.length === 0 ? (
          <EmptyState message="No messages here yet." />
        ) : (
          <ul className="divide-y divide-neutral-100">
            {messages.map((m) => {
              const name =
                (m.author_discord_user_id && names.get(m.author_discord_user_id)) ||
                ROLE_SENDER[m.author_role] ||
                "someone";
              const jump = messageUrl(channel.guild_id, channel.channel_id, m.message_id);
              const text = cleanSnippet(m.content, names, channelNames);
              return (
                <li key={m.id} className="flex gap-3 py-3">
                  <Avatar name={name} size={26} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-neutral-900">{name}</span>
                      <span
                        className={`rounded px-1.5 py-px font-medium ${
                          ROLE_CHIP[m.author_role] ?? ROLE_CHIP.unknown
                        }`}
                      >
                        {m.author_role}
                      </span>
                      <span className="text-neutral-400">{formatDateTime(m.posted_at)}</span>
                    </p>
                    {text && (
                      <DiscordLink
                        href={jump}
                        title="Open this message in Discord"
                        className="mt-1 block whitespace-pre-wrap break-words text-sm text-neutral-700 hover:text-neutral-900"
                      >
                        {text}
                      </DiscordLink>
                    )}
                    {m.attachments.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-2">
                        {m.attachments.map((a, i) => (
                          <DiscordLink
                            key={a.id ?? i}
                            href={jump}
                            title="Open this media in Discord"
                            className="rounded-md bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-200"
                          >
                            📎 {a.filename ?? "attachment"}
                          </DiscordLink>
                        ))}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
