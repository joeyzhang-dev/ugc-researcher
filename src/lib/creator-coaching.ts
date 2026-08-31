/**
 * What to tell a creator about their week — in two voices.
 *
 * The same facts serve two readers with opposite needs. A coach is triaging a
 * roster and needs the diagnosis ("hook problem, not effort"); the creator is
 * reading about themselves and needs a next action they can take today. So the
 * case is detected ONCE and rendered twice: the numbers can never disagree
 * between the coach's `/stats` and the creator's `/my-stats`, only the wording.
 *
 * Every message is a template over measured values, never a generated
 * sentence: this text tells someone how their livelihood is going, and it has
 * to be reviewable, testable, and identical for identical input.
 *
 * Pure — no I/O, no dates of its own. `asOf` is passed in.
 */

import { CPM_GREAT_USD, cpmBand } from "@/lib/card-chrome";
import { GOOD_AVG_VIEWS, QUOTA_POSTS_PER_WEEK, SPIKE_VIEWS } from "@/lib/performance";
import type { CreatorStats } from "@/lib/creator-stats";

/** Ordered by priority: the first case that matches is the one worth saying.
 *  Silence beats a pile of caveats, so only one fires. */
export type CoachingCase =
  | "silent"            // posted nothing at all
  | "returning"         // posted after a silent week
  | "first-weeks"       // too new to judge
  | "spike"             // a 40k+ post this week
  | "breaking-out"      // views climbing hard vs their own baseline
  | "strong"            // clearing quota and views are good
  | "grinding"          // clearing quota, views are not landing
  | "slipping"          // was posting, now below quota
  | "below-quota"       // under quota, no other story
  | "steady";           // nothing notable — the honest default

export interface Coaching {
  case: CoachingCase;
  /** Diagnosis for the coach. */
  coach: string;
  /** Encouragement plus one concrete next step, for the creator. */
  creator: string;
  /** Drives the accent colour on the creator card. */
  tone: "good" | "warn" | "bad" | "neutral";
}

const pct = (a: number, b: number): number => (b > 0 ? (a - b) / b : 0);

export function diagnose(stats: CreatorStats, weeksSinceJoined: number | null = null): Coaching {
  const cur = stats.current;
  const trend = stats.trend;
  const prev = trend.length >= 2 ? trend[trend.length - 2].read : null;
  const posts = cur.posts;
  const avg = cur.avgViews ?? 0;
  const quota = QUOTA_POSTS_PER_WEEK;

  // Their own baseline: the mean of the weeks before this one that had posts.
  const priorWeeks = trend.slice(0, -1).filter((p) => p.read.posts > 0);
  const baseline =
    priorWeeks.length > 0
      ? priorWeeks.reduce((s, p) => s + (p.read.avgViews ?? 0), 0) / priorWeeks.length
      : 0;
  const lift = baseline > 0 ? pct(avg, baseline) : 0;
  const shortBy = Math.max(quota - posts, 0);

  if (posts === 0) {
    return {
      case: "silent",
      coach: `No posts this week. Last week was ${prev?.posts ?? 0}. Worth a direct check-in before the streak sets.`,
      creator:
        "You didn't post this week — no judgement, but let's not let it become a habit. " +
        `Getting ${quota} up next week is the single fastest way to turn this around.`,
      tone: "bad",
    };
  }

  if (weeksSinceJoined != null && weeksSinceJoined <= 2) {
    return {
      case: "first-weeks",
      coach: `Week ${Math.max(weeksSinceJoined, 1)} — too early to judge views. Watch consistency, not CPM.`,
      creator:
        `You're ${Math.max(weeksSinceJoined, 1)} week${weeksSinceJoined === 1 ? "" : "s"} in — this is the ` +
        "learning stretch, so volume beats perfection. Keep shipping and the views follow.",
      tone: "neutral",
    };
  }

  if (cur.spikes.length > 0) {
    const best = cur.spikes[0];
    return {
      case: "spike",
      coach:
        `${cur.spikes.length} post${cur.spikes.length === 1 ? "" : "s"} over ${fmt(SPIKE_VIEWS)} views this week. ` +
        "Worth pulling apart what worked and asking for more of it.",
      creator:
        `🔥 You hit ${fmt(best.views)} views this week — that's a spike. ` +
        "Look at what that one did differently and make three more like it.",
      tone: "good",
    };
  }

  if (prev && prev.posts === 0) {
    return {
      case: "returning",
      coach: `Back to ${posts} post${posts === 1 ? "" : "s"} after a silent week. Worth reinforcing now.`,
      creator:
        `Good to see you back — ${posts} post${posts === 1 ? "" : "s"} after a quiet week. ` +
        `Stack another ${quota} next week and you're properly rolling again.`,
      tone: "good",
    };
  }

  if (baseline > 0 && lift >= 0.5 && posts >= quota) {
    return {
      case: "breaking-out",
      coach: `Avg views up ${Math.round(lift * 100)}% on their own baseline, at quota. Something is working — find out what.`,
      creator:
        `Your views are up ${Math.round(lift * 100)}% on your own average — whatever you changed, it's working. ` +
        "Do more of exactly that.",
      tone: "good",
    };
  }

  if (posts >= quota && avg >= GOOD_AVG_VIEWS) {
    return {
      case: "strong",
      coach: `${posts} posts at ${fmt(avg)} avg. Performing — leave them alone and protect the routine.`,
      creator:
        `${posts} posts at ${fmt(avg)} avg views — this is what a strong week looks like. ` +
        "Hold this rhythm and the payouts follow it up.",
      tone: "good",
    };
  }

  if (posts >= quota) {
    return {
      case: "grinding",
      coach:
        `Effort is there (${posts} posts) but views are not (${fmt(avg)} avg). ` +
        "This is a hook/topic conversation, not a consistency one.",
      creator:
        `You're putting in the work — ${posts} posts — but they're averaging ${fmt(avg)} views. ` +
        "The volume is right; now let's sharpen the first three seconds.",
      tone: "warn",
    };
  }

  if (prev && prev.posts >= quota) {
    return {
      case: "slipping",
      coach: `Dropped from ${prev.posts} to ${posts} posts. Catch it now, while it is one week.`,
      creator:
        `You went from ${prev.posts} posts to ${posts} this week. ` +
        `Nothing's broken — just ${shortBy} more next week puts you back on track.`,
      tone: "warn",
    };
  }

  if (posts < quota) {
    return {
      case: "below-quota",
      coach: `${posts}/${quota} posts. Volume is the constraint before anything else is worth discussing.`,
      creator:
        `You're ${shortBy} post${shortBy === 1 ? "" : "s"} short of ${quota} this week. ` +
        "That gap is the easiest win on this card — everything else gets better once volume is there.",
      tone: "warn",
    };
  }

  return {
    case: "steady",
    coach: `${posts} posts at ${fmt(avg)} avg. Nothing urgent.`,
    creator: `${posts} posts at ${fmt(avg)} avg views this week — steady. Keep it up.`,
    tone: "neutral",
  };
}

/** A separate line about the money, when there is something true to say. It is
 *  appended rather than folded in, so the performance read never gets
 *  distorted by a payout that has not settled yet. */
export function cpmNote(cpm: number | null, projected: number | null): string | null {
  const band = cpmBand(cpm);
  if (band === "great") return `Your CPM is $${cpm!.toFixed(2)} — well under the $${CPM_GREAT_USD} line. That is exactly where you want it.`;
  if (band === "poor") return `Your CPM is $${cpm!.toFixed(2)}. Views are what pulls that number down — nothing else does.`;
  if (band === "ok") return `Your CPM is $${cpm!.toFixed(2)}. Under $${CPM_GREAT_USD} is the target.`;
  if (cpm == null && projected != null) {
    return `No settled payouts yet, so this is tracking at about $${projected.toFixed(2)} — payouts land ~3 weeks after posting.`;
  }
  return null;
}

function fmt(n: number): string {
  const v = Math.round(n);
  if (v < 10_000) return v.toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}
