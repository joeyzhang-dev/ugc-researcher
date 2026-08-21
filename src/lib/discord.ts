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

/** Post a message (JSON only — media rides as public URLs in V2 galleries,
 *  never as uploads); returns the created message id. One retry on rate limit. */
export async function postChannelMessage(
  channelId: string,
  payload: Record<string, unknown>
): Promise<string> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set in .env.local");

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 429 && attempt === 0) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 1) * 1000)));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord ${res.status}: ${text.slice(0, 300)}`);
    }
    const message = (await res.json()) as { id: string };
    return message.id;
  }
}
