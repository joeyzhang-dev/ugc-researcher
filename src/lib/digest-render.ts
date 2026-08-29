/**
 * Renders a coach's weekly digest as Discord embeds. Pure — takes the rows
 * `loadPerformanceReport` produces, returns message payloads — so the exact
 * text a coach sees is unit-tested, and the page and the ping can never
 * disagree on a number because neither computes one.
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
  BAD_STREAK_FLAG,
  QUOTA_POSTS_PER_WEEK,
  type Bucket,
  type CreatorPerformance,
  type Window,
} from "@/lib/performance";
import { formatCompact, formatUsd } from "@/lib/format";

export const FIELD_VALUE_MAX = 1024;
export const EMBED_TOTAL_MAX = 6000;
export const EMBEDS_PER_MESSAGE_MAX = 10;
export const FIELDS_PER_EMBED_MAX = 25;

/** Embed colours: bad red, decent amber, good green, neutral slate. */
export const BUCKET_COLOR: Record<Bucket, number> = {
  bad: 0xef4444,
  decent: 0xf59e0b,
  good: 0x22c55e,
};
const NEUTRAL_COLOR = 0x64748b;

export const BUCKET_LABEL: Record<Bucket, string> = {
  bad: "🔴 Bad",
  decent: "🟡 Decent",
  good: "🟢 Good",
};

export interface Embed {
  title?: string;
  description?: string;
  color?: number;
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

/** The creator's name as the coach should read it: a mention (blue, no
 *  ping) when we know the Discord id, a profile link otherwise. */
export function creatorRef(row: Pick<PerformanceRow, "handle" | "discordUserId" | "profileUrl">): string {
  const profile = row.profileUrl ?? `https://www.instagram.com/${row.handle}/`;
  return row.discordUserId
    ? `<@${row.discordUserId}> [@${row.handle}](${profile})`
    : `**[@${row.handle}](${profile})**`;
}

const signed = (n: number, digits = 1): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`;

/** The CPM half of a line: the true 30d number with its move, or the
 *  projection, or nothing. */
export function cpmPhrase(p: CreatorPerformance): string {
  const k = p.cpm30;
  if (k.cpm != null) {
    const frontierUnchanged =
      k.settledWindow != null &&
      p.cpm30Prev.settledWindow != null &&
      k.settledWindow.end.getTime() === p.cpm30Prev.settledWindow.end.getTime();
    let move: string;
    if (p.delta == null) move = "";
    else if (frontierUnchanged) move = " · no new payouts";
    else if (k.lowSample || p.cpm30Prev.lowSample) move = ` · ${signed(p.delta.usd, 2)} (low sample)`;
    else {
      const arrow = Math.abs(p.delta.usd) < 0.005 ? "→" : p.delta.usd < 0 ? "▼" : "▲";
      move = ` ${arrow} ${formatUsd(Math.abs(p.delta.usd))} (${signed(p.delta.pct)}%)`;
    }
    const sample = k.lowSample ? ` · ${k.paidPosts} paid` : "";
    return `30d CPM **${formatUsd(k.cpm)}**${move}${sample}`;
  }
  if (k.projected != null) return `30d CPM ≈ ${formatUsd(k.projected)} (projected, unpaid)`;
  return "no CPM yet";
}

/** One creator, one line (plus a flag line when the streak has hit the bar). */
export function creatorLine(row: PerformanceRow): string {
  const p = row.performance;
  const w = p.weekly;
  const posts = `${w.posts}/${QUOTA_POSTS_PER_WEEK} posts${w.belowQuota ? " ⚠" : ""}`;
  const views =
    w.posts === 0
      ? "no posts"
      : `${formatCompact(Math.round(w.avgViews ?? 0))} avg` +
        (w.projectedCpm != null && (w.avgViews ?? 0) >= 1000 ? ` (≈${formatUsd(w.projectedCpm)})` : "") +
        (w.spikes.length ? ` · ${w.spikes.length} spike${w.spikes.length === 1 ? "" : "s"}` : "") +
        (w.bestPost ? ` · [best](${w.bestPost.url})` : "");
  const joined =
    p.weeksSinceJoined != null && p.weeksSinceJoined <= 4
      ? ` · wk ${p.weeksSinceJoined}${p.onboarding.bucket ? `, started ${p.onboarding.bucket}` : ""}`
      : "";
  let line = `${creatorRef(row)} — ${posts} · ${views} · ${cpmPhrase(p)}${joined}`;
  if (p.flagged) {
    line += `\n╰ ⚠️ **${p.badStreak} weeks bad** — coach call or offboard`;
  }
  return line;
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
  (e.footer?.text.length ?? 0) +
  (e.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);

const ORDER: (Bucket | null)[] = ["bad", "decent", "good", null];

/**
 * The digest for one coach: a header embed with the team's totals, then one
 * field per bucket (bad first) listing creators in the report's order —
 * worst rise first inside a bucket. Fields overflow into continuation fields,
 * embeds overflow into more embeds, embeds overflow into more messages.
 */
export function buildCoachDigest(input: {
  coach: string;
  week: Window;
  rows: PerformanceRow[];
  /** Where the same numbers live on the web, for the footer. */
  appUrl?: string | null;
}): MessagePayload[] {
  const { coach, week, rows } = input;
  const bad = rows.filter((r) => r.performance.bucket === "bad").length;
  const belowQuota = rows.filter((r) => r.performance.weekly.belowQuota).length;
  const flagged = rows.filter((r) => r.performance.flagged).length;

  const header: Embed = {
    title: `Weekly read — ${coach} · ${weekLabel(week)}`,
    description:
      `${rows.length} creator${rows.length === 1 ? "" : "s"} · **${bad} bad** · ` +
      `${belowQuota} below the ${QUOTA_POSTS_PER_WEEK}-post quota · ${flagged} at ${BAD_STREAK_FLAG}+ weeks bad\n` +
      `-# Buckets: good ≥ 40k avg views a post (CPM under $2), bad ≤ 1.7k (over $25). ` +
      `30d CPM is what Launchpoint actually paid ÷ views of the posts it paid for, over the month ending at the newest payout. ` +
      `≈ figures are projected from the payscale and not yet paid.`,
    color: bad > 0 ? BUCKET_COLOR.bad : belowQuota > 0 ? BUCKET_COLOR.decent : BUCKET_COLOR.good,
    fields: [],
    footer: input.appUrl ? { text: `Full table: ${input.appUrl}/performance?week=${week.start.toISOString().slice(0, 10)}` } : undefined,
  };

  // Build the bucket fields, then pack them into embeds under the caps.
  const fields: { name: string; value: string }[] = [];
  for (const bucket of ORDER) {
    const group = rows.filter((r) => r.performance.bucket === bucket);
    if (group.length === 0) continue;
    const label = bucket ? BUCKET_LABEL[bucket] : "⚪ No read";
    const chunks = chunkLines(group.map(creatorLine));
    chunks.forEach((value, i) => {
      fields.push({ name: i === 0 ? `${label} (${group.length})` : "​", value });
    });
  }

  const embeds: Embed[] = [header];
  for (const field of fields) {
    const last = embeds[embeds.length - 1];
    const fits =
      (last.fields?.length ?? 0) < FIELDS_PER_EMBED_MAX &&
      embedLength(last) + field.name.length + field.value.length <= EMBED_TOTAL_MAX;
    if (fits) last.fields!.push(field);
    else embeds.push({ color: NEUTRAL_COLOR, fields: [field] });
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
  const bucket = o.bucket ? BUCKET_LABEL[o.bucket] : "⚪ no posts";
  const cpm =
    o.cpm != null
      ? `first-week CPM **${formatUsd(o.cpm)}**`
      : o.projected != null
        ? `first-week CPM ≈ ${formatUsd(o.projected)} (projected)`
        : "no first-week CPM";
  const joined = o.joinedAt ? monthDay(o.joinedAt) : "?";
  return {
    embeds: [
      {
        title: "New creator — first week closed",
        description:
          `${creatorRef(row)} joined ${joined} · ${o.posts} post${o.posts === 1 ? "" : "s"} in week one · ` +
          `${formatCompact(Math.round(o.avgViews ?? 0))} avg views · ${cpm}\n**Start: ${bucket}**`,
        color: o.bucket ? BUCKET_COLOR[o.bucket] : NEUTRAL_COLOR,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}
