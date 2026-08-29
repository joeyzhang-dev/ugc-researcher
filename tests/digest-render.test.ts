import { describe, expect, it } from "vitest";
import {
  EMBED_TOTAL_MAX,
  FIELD_VALUE_MAX,
  buildCoachDigest,
  buildOnboardingPing,
  chunkLines,
  cpmPhrase,
  creatorLine,
  creatorRef,
  weekLabel,
} from "@/lib/digest-render";
import type { PerformanceRow } from "@/lib/jobs/performance";
import { creatorPerformance, weekWindow, type PerformanceVideo } from "@/lib/performance";

const WEEK = weekWindow(new Date("2026-08-26T00:00:00Z")); // Aug 24 – Aug 30
const DAY = 24 * 60 * 60 * 1000;

function video(daysBeforeWeekEnd: number, views: number, earnings: number | null = null): PerformanceVideo {
  const sc = `v${daysBeforeWeekEnd}-${views}`;
  return {
    shortcode: sc,
    url: `https://www.instagram.com/reel/${sc}/`,
    posted_at: new Date(WEEK.end.getTime() - daysBeforeWeekEnd * DAY).toISOString(),
    view_count: views,
    earnings_usd: earnings,
  };
}

function row(over: Partial<PerformanceRow> & { videos?: PerformanceVideo[]; joinedAt?: Date | null } = {}): PerformanceRow {
  const { videos = [], joinedAt = new Date("2026-06-01T00:00:00Z"), ...rest } = over;
  return {
    creatorId: "c1",
    handle: "lockedwliam",
    displayName: "Liam",
    avatarUrl: null,
    profileUrl: "https://www.instagram.com/lockedwliam/",
    discordUserId: "187727571922714626",
    coach: "Coach: Will's Team",
    discordChannelId: "1",
    performance: creatorPerformance({ videos, joinedAt, week: WEEK }),
    ...rest,
  };
}

// A month of settled posts at a given view level, plus a week of fresh ones.
const settled = (views: number, weekly = 4) => [
  ...Array.from({ length: 12 }, (_, i) => video(20 + i, views, 40 + views / 1000)),
  ...Array.from({ length: weekly }, (_, i) => video(1 + i, views, null)),
];

describe("creatorRef", () => {
  it("mentions by id when we have one, links the profile otherwise", () => {
    expect(creatorRef({ handle: "a", discordUserId: "42", profileUrl: null })).toBe(
      "<@42> [@a](https://www.instagram.com/a/)"
    );
    expect(creatorRef({ handle: "a", discordUserId: null, profileUrl: "https://x/a" })).toBe("**[@a](https://x/a)**");
  });
});

describe("creatorLine", () => {
  it("reads posts vs quota, views with the projected cost, and the true 30d CPM", () => {
    const line = creatorLine(row({ videos: settled(60_000) }));
    expect(line).toContain("4/7 posts ⚠");
    expect(line).toContain("60K avg (≈$1.67)");
    expect(line).toContain("[best](https://www.instagram.com/reel/");
    expect(line).toContain("30d CPM **$1.67**");
    expect(line).not.toContain("weeks bad");
  });

  it("does not quote a cost for sub-1k posts, where the flat fee is withheld", () => {
    const line = creatorLine(row({ videos: settled(149) }));
    expect(line).toContain("149 avg ·");
    expect(line).not.toContain("≈$");
  });

  it("flags a creator at the streak bar with the coach's decision", () => {
    const line = creatorLine(row({ videos: settled(1_200) }));
    expect(line).toMatch(/⚠️ \*\*\d+ weeks bad\*\* — coach call or offboard/);
  });

  it("says 'no posts' rather than inventing zeros", () => {
    const line = creatorLine(row({ videos: [] }));
    expect(line).toContain("0/7 posts ⚠ · no posts · no CPM yet");
  });

  it("shows week-N and the start bucket for a creator in their first month", () => {
    const joinedAt = new Date(WEEK.start.getTime() - 10 * DAY);
    const videos = [video(12, 2_000), video(11, 2_500), video(3, 3_000)];
    const line = creatorLine(row({ videos, joinedAt }));
    expect(line).toContain("wk 2, started decent");
  });
});

describe("cpmPhrase", () => {
  it("says 'no new payouts' when the settled window has not moved", () => {
    expect(cpmPhrase(row({ videos: settled(5_000) }).performance)).toContain("no new payouts");
  });

  it("labels a projection as unpaid", () => {
    const videos = Array.from({ length: 8 }, (_, i) => video(2 + i, 5_000, null));
    expect(cpmPhrase(row({ videos }).performance)).toBe("30d CPM ≈ $9.00 (projected, unpaid)");
  });
});

describe("chunkLines", () => {
  it("packs lines under the cap without ever splitting one", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(90)}`);
    const chunks = chunkLines(lines, FIELD_VALUE_MAX);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(FIELD_VALUE_MAX);
    expect(chunks.join("\n").split("\n")).toEqual(lines);
  });
});

describe("buildCoachDigest", () => {
  const team = [
    row({ creatorId: "a", handle: "aa", videos: settled(60_000) }),
    row({ creatorId: "b", handle: "bb", videos: settled(5_000) }),
    row({ creatorId: "c", handle: "cc", videos: settled(1_200) }),
    row({ creatorId: "d", handle: "dd", videos: [] }),
  ];

  it("is one message: a header with the totals, then bad → decent → good → no read", () => {
    const [payload, ...rest] = buildCoachDigest({ coach: "Coach: Will's Team", week: WEEK, rows: team });
    expect(rest).toEqual([]);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    const [header] = payload.embeds;
    expect(header.title).toBe("Weekly read — Coach: Will's Team · Aug 24 – Aug 30");
    expect(header.description).toContain("4 creators · **1 bad**");
    expect(header.fields!.map((f) => f.name)).toEqual(["🔴 Bad (1)", "🟡 Decent (1)", "🟢 Good (1)", "⚪ No read (1)"]);
    expect(header.fields![0].value).toContain("@cc");
  });

  it("never pings: mentions live inside embeds and parse is empty", () => {
    const [payload] = buildCoachDigest({ coach: "x", week: WEEK, rows: team });
    expect(payload.content).toBeUndefined();
    expect(JSON.stringify(payload.embeds)).toContain("<@187727571922714626>");
    expect(payload.allowed_mentions.parse).toEqual([]);
  });

  it("links the web table in the footer when an app url is given", () => {
    const [payload] = buildCoachDigest({ coach: "x", week: WEEK, rows: team, appUrl: "https://app" });
    expect(payload.embeds[0].footer?.text).toBe("Full table: https://app/performance?week=2026-08-24");
  });

  it("stays under Discord's limits for a very large team", () => {
    const big = Array.from({ length: 60 }, (_, i) =>
      row({ creatorId: `c${i}`, handle: `creator_${i}_with_a_long_handle`, videos: settled(1_200) })
    );
    const payloads = buildCoachDigest({ coach: "x", week: WEEK, rows: big });
    for (const p of payloads) {
      expect(p.embeds.length).toBeLessThanOrEqual(10);
      for (const e of p.embeds) {
        const total =
          (e.title?.length ?? 0) +
          (e.description?.length ?? 0) +
          (e.footer?.text.length ?? 0) +
          (e.fields ?? []).reduce((s, f) => s + f.name.length + f.value.length, 0);
        expect(total).toBeLessThanOrEqual(EMBED_TOTAL_MAX);
        expect((e.fields ?? []).length).toBeLessThanOrEqual(25);
        for (const f of e.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(FIELD_VALUE_MAX);
      }
    }
    // Every creator made it into some field.
    const all = JSON.stringify(payloads);
    for (const r of big) expect(all).toContain(`@${r.handle}`);
  });
});

describe("buildOnboardingPing", () => {
  it("states the start bucket from the first week's views", () => {
    const joinedAt = new Date(WEEK.start.getTime() - 7 * DAY);
    const videos = [video(13, 50_000), video(12, 45_000), video(10, 40_000)];
    const ping = buildOnboardingPing(row({ videos, joinedAt }));
    const e = ping.embeds[0];
    expect(e.title).toBe("New creator — first week closed");
    expect(e.description).toContain("3 posts in week one");
    expect(e.description).toContain("**Start: 🟢 Good**");
    expect(e.description).toContain("(projected)");
    expect(ping.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("weekLabel", () => {
  it("prints the Monday and the Sunday", () => {
    expect(weekLabel(WEEK)).toBe("Aug 24 – Aug 30");
  });
});
