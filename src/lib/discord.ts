/**
 * Minimal Discord REST client for outbound sends (bot token, server-only).
 *
 * The gateway bot (worker/) owns everything interactive; this is just enough
 * to post a message from a server action. Cloudflare rejects generic UAs with
 * a 403 that reads like a permissions error, so we always send a bot UA —
 * same lesson as worker/discord_pull_worker.py.
 */

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/joeyzhang-dev/ugc-researcher, 0.1)";

export function discordConfigured(): boolean {
  return !!process.env.DISCORD_BOT_TOKEN;
}

/** One authenticated call. One retry on rate limit, honouring `retry_after`. */
async function discordRequest<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  payload?: Record<string, unknown>
): Promise<T> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set in .env.local");

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (res.status === 429 && attempt === 0) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 1) * 1000)));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}

/** Post a message (JSON only — media rides as public URLs in V2 galleries,
 *  never as uploads); returns the created message id. */
export async function postChannelMessage(channelId: string, payload: object): Promise<string> {
  const message = await discordRequest<{ id: string }>(
    "POST",
    `/channels/${channelId}/messages`,
    payload as Record<string, unknown>
  );
  return message.id;
}

/* --- guild structure (for the coach digest) ------------------------------ */

export interface GuildChannel {
  id: string;
  /** 0 text, 4 category. */
  type: number;
  name: string;
  parent_id: string | null;
}

export interface GuildRole {
  id: string;
  name: string;
}

export interface PermissionOverwrite {
  id: string;
  /** 0 role, 1 member. */
  type: 0 | 1;
  /** Permission bitfields as decimal strings, the way Discord wants them. */
  allow: string;
  deny: string;
}

/** Discord permission bits used here. */
export const PERM = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
} as const;

export function listGuildChannels(guildId: string): Promise<GuildChannel[]> {
  return discordRequest<GuildChannel[]>("GET", `/guilds/${guildId}/channels`);
}

export function listGuildRoles(guildId: string): Promise<GuildRole[]> {
  return discordRequest<GuildRole[]>("GET", `/guilds/${guildId}/roles`);
}

/** The bot's own user — needed to grant itself access to a channel that
 *  denies @everyone, or it could create the channel and then not post in it. */
export function currentBotUser(): Promise<{ id: string }> {
  return discordRequest<{ id: string }>("GET", "/users/@me");
}

export function createTextChannel(
  guildId: string,
  channel: { name: string; parentId: string; topic?: string; overwrites: PermissionOverwrite[] }
): Promise<GuildChannel> {
  return discordRequest<GuildChannel>("POST", `/guilds/${guildId}/channels`, {
    name: channel.name,
    type: 0,
    parent_id: channel.parentId,
    topic: channel.topic,
    permission_overwrites: channel.overwrites,
  });
}

export interface GuildMember {
  user: { id: string; username: string; global_name: string | null };
  nick: string | null;
  roles: string[];
}

/** Guild members, for resolving which coach owns which team category.
 *  One page of 1,000 is the whole guild here and Discord's per-call maximum. */
export function listGuildMembers(guildId: string, limit = 1000): Promise<GuildMember[]> {
  return discordRequest<GuildMember[]>("GET", `/guilds/${guildId}/members?limit=${limit}`);
}
