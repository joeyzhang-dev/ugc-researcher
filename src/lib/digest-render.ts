/**
 * Renders a coach's weekly recap as Discord embeds. Pure — takes the rows
 * `loadPerformanceReport` produces, returns message payloads — so the exact
 * text a coach sees is unit-tested, and the page and the ping can never
 * disagree on a number because neither computes one.
 *
 * Format follows Joey's ask (2026-08-30): "here's your weekly recap", posts
 * are the headline metric, avg views next, and no legend explaining what
 * good/bad means — the bucket shows as a coloured dot, not a lecture. The
 * layout steals from his Daily Recap example: a progress bar in the
 * description, a 3-up grid of inline stat fields, ranked lists.
 *
 * Creators are *mentioned*, never pinged: a `<@id>` renders as the blue name
 * in any channel (Discord resolves it by id), notifies only members who can
 * see the channel, and inside an embed notifies nobody at all. The payload
 * still carries `allowed_mentions: { parse: [] }` so no ping can leak even
 * if a creator is ever added to the channel.
 *
 * Discord limits that shape the chunking below: embed description ≤ 4096,
 * field value ≤ 1024, field name ≤ 256, ≤ 25 fields, ≤ 6000 characters per
 * embed, ≤ 10 embeds per message.
 */

import type { PerformanceRow } from "@/lib/jobs/performance";
import {
  QUOTA_POSTS_PER_WEEK,
  TOP_POSTS,
  type Bucket,
  type CreatorPerformance,
  type Window,
} from "@/lib/performance";
import { formatCompact, formatUsd } from "@/lib/format";

export const FIELD_VALUE_MAX = 1024;
export const EMBED_TOTAL_MAX = 6000;
export const EMBEDS_PER_MESSAGE_MAX = 10;
export const FIELDS_PER_EMBED_MAX = 25;

/** The calm blue of Joey's recap example. */
export const RECAP_COLOR = 363775;

/** The bucket as a dot. Deliberately unexplained anywhere in the message. */
export const BUCKET_DOT: Record<Bucket, string> = { bad: "🔴", decent: "🟡", good: "🟢" };

export interface Embed {
  title?: string;
  description?: string;
  color?: number;
  author?: { name: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
}

export interface MessagePayload {
  content?: string;
  embeds: Embed[];
  allowed_mentions: { parse: [] };
}

const monthDay = (d: Date): string =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Aug 24 – Aug 30" for a Monday→Monday window. */
export function weekLabel(week: Window): string {
  return `${monthDay(week.start)} – ${monthDay(new Date(week.end.getTime() - 1))}`;
}

/** Joey-style bar: `███░░░░░░░░░░░`. */
export function progressBar(ratio: number, width = 14): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** The creator's name as the coach should read it: a mention (blue, no
 *  ping) when we know the Discord id, a profile link otherwise. */
export function creatorRef(row: Pick<PerformanceRow, "handle" | "discordUserId" | "profileUrl">): string {
  const profile = row.profileUrl ?? `https://www.instagram.com/${row.handle}/`;
  return row.discordUserId
    ? `<@${row.discordUserId}> [@${row.handle}](${profile})`
    : `**[@${row.handle}](${profile})**`;
}

/** The 30d CPM, shortened to a number with an arrow only when it truly
 *  moved. `≈` marks a projection; blank when there is nothing to say. */
export function cpmShort(p: CreatorPerformance): string {
  const k = p.cpm30;
  if (k.cpm != null) {
    const frontierMoved =
      k.settledWindow != null &&
      p.cpm30Prev.settledWindow != null &&
      k.settledWindow.end.getTime() !== p.cpm30Prev.settledWindow.end.getTime();
    let move = "";
    if (p.delta != null && frontierMoved && !k.lowSample && !p.cpm30Prev.lowSample && Math.abs(p.delta.usd) >= 0.005) {
      move = ` ${p.delta.usd < 0 ? "▼" : "▲"}${formatUsd(Math.abs(p.delta.usd))}`;
    }
    return `${formatUsd(k.cpm)}${move}`;
  }
  if (k.projected != null) return `≈${formatUsd(k.projected)}`;
  return "";
}

/**
 * One creator in the "who posted what" ranking. Posts first and bold — the
 * headline metric — then avg views, the best post, and the CPM as a bare
 * number. The dot carries the bucket without a legend.
 */
export function postingLine(row: PerformanceRow): string {
  const p = row.performance;
  const w = p.weekly;
  const dot = p.bucket ? BUCKET_DOT[p.bucket] : "⚪";
  const posts = `**${w.posts}/${w.quota}**`;
  const rest =
    w.posts === 0
      ? "didn’t post"
      : `${formatCompact(Math.round(w.avgViews ?? 0))} avg views` +
        (w.spikes.length ? ` · 🚀 ${w.spikes.length} spike${w.spikes.length === 1 ? "" : "s"}` : "") +
        (w.bestPost ? ` · [best](${w.bestPost.url})` : "");
  const cpm = cpmShort(p);
  const fresh =
    p.weeksSinceJoined != null && p.weeksSinceJoined <= 2 ? ` · 🌱 wk ${Math.max(p.weeksSinceJoined, 1)}` : "";
  return `${dot} ${posts} ${creatorRef(row)} — ${rest}${cpm ? ` · ${cpm}` : ""}${fresh}`;
}

/** Rank for the posting list: most posts first, then most avg views. */
export function comparePosting(a: PerformanceRow, b: PerformanceRow): number {
  return (
    b.performance.weekly.posts - a.performance.weekly.posts ||
    (b.performance.weekly.avgViews ?? 0) - (a.performance.weekly.avgViews ?? 0) ||
    a.handle.localeCompare(b.handle)
  );
}

/** Split lines into field values under the 1,024-char cap, never inside a line. */
export function chunkLines(lines: string[], max: number = FIELD_VALUE_MAX): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const embedLength = (e: Embed): number =>
  (e.title?.length ?? 0) +
  (e.description?.length ?? 0) +
  (e.author?.name.length ?? 0) +
  (e.footer?.text.length ?? 0) +
  (e.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);

/**
 * The weekly recap for one coach.
 *
 * Shape: author = the team, title = "Here's your weekly recap", a posting
 * progress bar in the description, a 3-up grid of team stats, then the full
 * roster ranked by posts (the metric Joey cares about most), a decisions
 * field for the flagged, and the best post of the week. Long lists overflow
 * into continuation fields, embeds into more embeds, embeds into more
 * messages.
 */
export function buildCoachDigest(input: {
  coach: string;
  week: Window;
  rows: PerformanceRow[];
  /** Where the same numbers live on the web, for the footer. */
  appUrl?: string | null;
}): MessagePayload[] {
  const { coach, week, rows } = input;
  const quota = rows.length * QUOTA_POSTS_PER_WEEK;
  const posts = rows.reduce((sum, r) => sum + r.performance.weekly.posts, 0);
  const hitQuota = rows.filter((r) => !r.performance.weekly.belowQuota).length;
  const silent = rows.filter((r) => r.performance.weekly.posts === 0);
  const views = rows.reduce((sum, r) => sum + r.performance.weekly.views, 0);
  const postedRows = rows.filter((r) => r.performance.weekly.posts > 0);
  const avgViews = posts > 0 ? views / posts : null;
  const spikes = rows.flatMap((r) =>
    r.performance.weekly.spikes.map((s) => ({ handle: r.handle, ...s }))
  );
  const best = postedRows
    .map((r) => ({ handle: r.handle, post: r.performance.weekly.bestPost! }))
    .sort((a, b) => b.post.views - a.post.views)[0];
  const flagged = rows.filter((r) => r.performance.flagged);

  const header: Embed = {
    author: { name: coach },
    title: `📊 Here’s your weekly recap — ${weekLabel(week)}`,
    description:
      `**${progressBar(quota > 0 ? posts / quota : 0)}**\n` +
      `**${posts}** of ${quota} posts this week (${quota > 0 ? Math.round((posts / quota) * 100) : 0}%) • ` +
      `${hitQuota} of ${rows.length} hit the ${QUOTA_POSTS_PER_WEEK}-post quota`,
    color: RECAP_COLOR,
    fields: [
      { name: "Avg views / post", value: avgViews != null ? `**${formatCompact(Math.round(avgViews))}**` : "—", inline: true },
      { name: "🚀 Spikes (40k+)", value: `**${spikes.length}**`, inline: true },
      { name: "Didn’t post", value: `**${silent.length}** creator${silent.length === 1 ? "" : "s"}`, inline: true },
    ],
    footer: input.appUrl
      ? { text: `Full table: ${input.appUrl}/performance?week=${week.start.toISOString().slice(0, 10)}` }
      : undefined,
  };

  const fields: { name: string; value: string; inline?: boolean }[] = [];

  // The headline list: everyone, ranked by how much they posted.
  const ranked = [...rows].sort(comparePosting);
  chunkLines(ranked.map(postingLine)).forEach((value, i) => {
    fields.push({ name: i === 0 ? "Who posted what" : "​", value });
  });

  if (best) {
    fields.push({
      name: "🏆 Best post of the week",
      value: `[@${best.handle} — ${formatCompact(best.post.views)} views](${best.post.url})`,
    });
  }

  if (flagged.length) {
    chunkLines(
      flagged.map(
        (r) => `${creatorRef(r)} — **${r.performance.badStreak} weeks** without traction → call or offboard`
      )
    ).forEach((value, i) => {
      fields.push({ name: i === 0 ? "⚠️ Needs a decision" : "​", value });
    });
  }

  const embeds: Embed[] = [header];
  for (const field of fields) {
    const last = embeds[embeds.length - 1];
    const fits =
      (last.fields?.length ?? 0) < FIELDS_PER_EMBED_MAX &&
      embedLength(last) + field.name.length + field.value.length <= EMBED_TOTAL_MAX;
    if (fits) last.fields!.push(field);
    else embeds.push({ color: RECAP_COLOR, fields: [field] });
  }

  const payloads: MessagePayload[] = [];
  for (let i = 0; i < embeds.length; i += EMBEDS_PER_MESSAGE_MAX) {
    payloads.push({ embeds: embeds.slice(i, i + EMBEDS_PER_MESSAGE_MAX), allowed_mentions: { parse: [] } });
  }
  return payloads;
}

/** The one-off ping when a new creator's first week has closed. */
export function buildOnboardingPing(row: PerformanceRow): MessagePayload {
  const o = row.performance.onboarding;
  const dot = o.bucket ? BUCKET_DOT[o.bucket] : "⚪";
  const cpm =
    o.cpm != null
      ? `CPM ${formatUsd(o.cpm)}`
      : o.projected != null
        ? `CPM ≈${formatUsd(o.projected)}`
        : "no CPM yet";
  const joined = o.joinedAt ? monthDay(o.joinedAt) : "?";
  return {
    embeds: [
      {
        title: "🌱 New creator — first week recap",
        description:
          `${dot} ${creatorRef(row)} joined ${joined}\n` +
          `**${o.posts}** post${o.posts === 1 ? "" : "s"} in week one • ` +
          `${formatCompact(Math.round(o.avgViews ?? 0))} avg views • ${cpm}`,
        color: RECAP_COLOR,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

/* --- Components V2 ------------------------------------------------------- */

/** `IS_COMPONENTS_V2` (1 << 15). A message sent with this flag cannot use
 *  `content` or `embeds` at all, and the flag can never be removed from it. */
export const FLAG_IS_COMPONENTS_V2 = 32768;

/** Discord caps a V2 message at 40 components, counting nested ones. */
export const COMPONENTS_PER_MESSAGE_MAX = 40;

export type V2Component = Record<string, unknown>;

export interface V2MessagePayload {
  flags: number;
  components: V2Component[];
  /** `parse: []` blocks every implicit mention; `users` opts exactly one id
   *  back in. A roster-derived message must never be able to fire @everyone
   *  because a creator's display name contains it. */
  allowed_mentions: { parse: []; users?: string[] };
}

const textDisplay = (content: string): V2Component => ({ type: 10, content });
/** Separator spacing is an INT in the API (1 = small, 2 = large) even though
 *  the docs render it as a string — sending "small" is a 400. */
export const SEPARATOR_SMALL = 1;
export const SEPARATOR_LARGE = 2;

const separator = (divider = true, spacing: number = SEPARATOR_SMALL): V2Component => ({
  type: 14,
  divider,
  spacing,
});

/**
 * The weekly recap as a Components V2 message.
 *
 * The old embed put sixteen creators into embed *fields*, which Discord lays
 * out as a dense two-column grid with no control over wrapping — the source
 * of the cramped block this replaces. V2 drops fields entirely: the per-
 * creator detail becomes one rendered card (`/api/jobs/recap-image`), and the
 * message keeps only what a coach must read as text — the headline, the best
 * post, and who needs a decision.
 *
 * `imageUrl` is nullable on purpose. It needs both an app origin and
 * CRON_SECRET to sign, and neither is guaranteed on every deploy; without it
 * the message falls back to the ranked text list rather than posting a recap
 * with a hole where the numbers were.
 */
export function buildCoachRecapV2(input: {
  coach: string;
  week: Window;
  rows: PerformanceRow[];
  imageUrl?: string | null;
  appUrl?: string | null;
  /** The coach who owns this team, pinged at the top. Null when it could not
   *  be settled confidently — see coach-mention: no ping beats a wrong one. */
  coachUserId?: string | null;
}): V2MessagePayload {
  const { coach, week, rows, imageUrl, coachUserId } = input;
  const quota = rows.length * QUOTA_POSTS_PER_WEEK;
  const posts = rows.reduce((sum, r) => sum + r.performance.weekly.posts, 0);
  const hitQuota = rows.filter((r) => !r.performance.weekly.belowQuota).length;
  const silent = rows.filter((r) => r.performance.weekly.posts === 0);
  const views = rows.reduce((sum, r) => sum + r.performance.weekly.views, 0);
  const avgViews = posts > 0 ? views / posts : null;
  const spikes = rows.reduce((sum, r) => sum + r.performance.weekly.spikes.length, 0);
  const trials = rows.reduce((sum, r) => sum + r.performance.weekly.trialUploads, 0);
  const flagged = rows.filter((r) => r.performance.flagged);

  const body: V2Component[] = [
    textDisplay(
      `## 📊 ${coach} — weekly recap\n` +
        (coachUserId ? `<@${coachUserId}> ` : "") +
        `**${weekLabel(week)}** · ${rows.length} creator${rows.length === 1 ? "" : "s"}`
    ),
    // The numbers a coach quotes, on one line. Everything per-creator lives
    // in the card below, where a bar makes it comparable.
    textDisplay(
      `**${formatCompact(posts)}** posts · ` +
        `**${avgViews != null ? formatCompact(Math.round(avgViews)) : "—"}** avg views · ` +
        `**${hitQuota}/${rows.length}** hit quota · ` +
        `**${spikes}** spike${spikes === 1 ? "" : "s"} · ` +
        `**${silent.length}** didn’t post` +
        (trials > 0
          ? `\n-# ${formatCompact(trials)} trial-reel uploads excluded — posts and views count published reels only`
          : "")
    ),
  ];

  if (imageUrl) {
    body.push({
      type: 12,
      items: [
        {
          media: { url: imageUrl },
          description: `Weekly posting chart for ${coach}, ${weekLabel(week)}`,
        },
      ],
    });
  } else {
    // No signed card: fall back to the ranked list so the recap still carries
    // its numbers. Chunked to stay under the 4,000-char text display cap.
    const ranked = [...rows].sort(comparePosting);
    for (const chunk of chunkLines(ranked.map(postingLine), 3800)) {
      body.push(textDisplay(chunk));
    }
  }

  // Top five, not one. A single post can be luck; five is a pattern a coach
  // can act on ("her hooks are landing", "his all came from one concept").
  const top = rows
    .flatMap((r) => r.performance.weekly.topPosts.map((post) => ({ handle: r.handle, post })))
    .sort((a, b) => b.post.views - a.post.views)
    .slice(0, TOP_POSTS);
  if (top.length) {
    body.push(separator());
    body.push(
      textDisplay(
        `🏆 **Top posts this week**\n` +
          top
            .map(
              ({ handle, post }, i) =>
                `${i + 1}. [@${handle} — ${formatCompact(post.views)} views](${post.url})`
            )
            .join("\n")
      )
    );
  }

  if (flagged.length) {
    body.push(separator());
    body.push(
      textDisplay(
        `⚠️ **Needs a decision**\n` +
          flagged
            .map(
              (r) =>
                `${creatorRef(r)} — **${r.performance.badStreak} weeks** without traction → call or offboard`
            )
            .join("\n")
      )
    );
  }

  // The link to the full table rides as a button rather than footer text, so
  // it is tappable on mobile instead of a URL to select and paste.
  if (input.appUrl) {
    const href = `${input.appUrl.replace(/\/$/, "")}/performance?week=${week.start
      .toISOString()
      .slice(0, 10)}`;
    body.push({
      type: 1,
      components: [{ type: 2, style: 5, label: "Open the full table", url: href }],
    });
  }

  return {
    flags: FLAG_IS_COMPONENTS_V2,
    components: [{ type: 17, accent_color: RECAP_COLOR, components: body }],
    allowed_mentions: coachUserId ? { parse: [], users: [coachUserId] } : { parse: [] },
  };
}
