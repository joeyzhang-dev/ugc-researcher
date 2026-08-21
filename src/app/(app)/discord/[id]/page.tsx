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
import { Avatar, Card, EmptyState, Segmented, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { NICHE_PALETTE } from "../../scripts/cal";
import { DiscordLink } from "@/components/discord-link";
import { channelUrl, cleanSnippet, messageUrl, ROLE_CHIP, ROLE_SENDER } from "@/lib/discord-render";
import { DISCORD_DEPRECATED, DiscordDeprecatedNotice } from "../deprecated";

export const dynamic = "force-dynamic";

const NOT_CREATING = "Not Creating 🚫";
const FEED_LIMIT = 300;

const ROLES: readonly DiscordAuthorRole[] = ["creator", "coach", "launchpoint", "unknown"];

/** One coaching channel's recent feed — the drilldown the old discord-crm
 *  dashboard had. */
export default async function DiscordChannelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ role?: string }>;
}) {
  if (DISCORD_DEPRECATED) return <DiscordDeprecatedNotice />;
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
      <div className="mb-5">
        <Link
          href="/discord"
          className="group inline-flex items-center gap-1 text-xs font-medium text-neutral-500 transition-colors hover:text-neutral-900"
        >
          <span
            aria-hidden
            className="transition-transform duration-200 ease-fluid group-hover:-translate-x-0.5"
          >
            ←
          </span>
          Discord
        </Link>
        <div className="mt-2.5 flex items-start gap-3.5">
          <Avatar
            name={creator?.handle ?? channel.channel_name ?? "?"}
            src={creator?.avatar_url}
            size={44}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <DiscordLink
                href={channelUrl(channel.guild_id, channel.channel_id)}
                title={`Open #${channel.channel_name} in Discord`}
                className="truncate font-mono text-[20px] font-semibold tracking-tight text-neutral-900 hover:underline"
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
            </div>
            <p className="mt-1 text-sm">
              {creator ? (
                <>
                  <Link
                    href={`/research/${creator.id}`}
                    className="font-mono text-neutral-600 underline-offset-2 hover:text-neutral-900 hover:underline"
                  >
                    @{creator.handle}
                  </Link>
                  {creator.discord_username ? (
                    <span className="font-mono text-neutral-400"> · {creator.discord_username}</span>
                  ) : null}
                </>
              ) : (
                <span className="text-neutral-400">not linked to a roster creator</span>
              )}
            </p>
          </div>
        </div>
      </div>

      <Card
        title={`Feed${messages.length === FEED_LIMIT ? ` — last ${FEED_LIMIT}` : ""}`}
        subtitle={`${total} message${total === 1 ? "" : "s"} across all roles`}
        action={
          <Segmented
            size="sm"
            value={role ?? "all"}
            aria-label="Filter feed by author role"
            items={[
              { value: "all", label: `All · ${total}`, href: hrefWith(null) },
              ...roleCounts
                .filter(([, n]) => n > 0)
                .map(([r, n]) => ({ value: r, label: `${r} · ${n}`, href: hrefWith(r) })),
            ]}
          />
        }
      >
        {messages.length === 0 ? (
          <EmptyState message="No messages here yet." />
        ) : (
          <ul className="divide-y divide-black/[0.05]">
            {messages.map((m) => {
              const name =
                (m.author_discord_user_id && names.get(m.author_discord_user_id)) ||
                ROLE_SENDER[m.author_role] ||
                "someone";
              const jump = messageUrl(channel.guild_id, channel.channel_id, m.message_id);
              const text = cleanSnippet(m.content, names, channelNames);
              return (
                <li key={m.id} className="flex gap-3.5 py-4">
                  <Avatar name={name} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold text-neutral-900">{name}</span>
                      <span
                        className={`rounded-md px-1.5 py-px text-[11px] font-medium ${
                          ROLE_CHIP[m.author_role] ?? ROLE_CHIP.unknown
                        }`}
                      >
                        {m.author_role}
                      </span>
                      <span className="font-mono text-[11px] text-neutral-400">
                        {formatDateTime(m.posted_at)}
                      </span>
                    </div>
                    {text && (
                      <DiscordLink
                        href={jump}
                        title="Open this message in Discord"
                        className="mt-1 block break-words whitespace-pre-wrap text-sm leading-relaxed text-neutral-700 transition-colors hover:text-neutral-900"
                      >
                        {text}
                      </DiscordLink>
                    )}
                    {m.attachments.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {m.attachments.map((a, i) => (
                          <DiscordLink
                            key={a.id ?? i}
                            href={jump}
                            title="Open this media in Discord"
                            className="inline-flex items-center gap-1 rounded-lg bg-surface-sunken px-2 py-1 text-xs text-neutral-600 ring-1 ring-inset ring-hairline transition hover:bg-surface-muted hover:text-neutral-900"
                          >
                            📎 {a.filename ?? "attachment"}
                          </DiscordLink>
                        ))}
                      </div>
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
