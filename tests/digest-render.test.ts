import { describe, expect, it } from "vitest";
import {
  EMBED_TOTAL_MAX,
  FIELD_VALUE_MAX,
  RECAP_COLOR,
  buildCoachDigest,
  buildOnboardingPing,
  chunkLines,
  comparePosting,
  cpmShort,
  creatorRef,
  postingLine,
  progressBar,
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

describe("progressBar", () => {
  it("fills proportionally and clamps", () => {
    expect(progressBar(0)).toBe("░".repeat(14));
    expect(progressBar(0.5)).toBe("█".repeat(7) + "░".repeat(7));
    expect(progressBar(2)).toBe("█".repeat(14));
  });
});

describe("postingLine", () => {
  it("leads with posts in bold, then avg views, the best link and a bare CPM", () => {
    const line = postingLine(row({ videos: settled(60_000) }));
    expect(line.startsWith("🟢 **4/7** <@187727571922714626>")).toBe(true);
    expect(line).toContain("60K avg views");
    expect(line).toContain("[best](https://www.instagram.com/reel/");
    expect(line).toContain("· $1.67");
    expect(line).toContain("🚀 4 spikes");
  });

  it("never explains what the dot means", () => {
    const line = postingLine(row({ videos: settled(1_200) }));
    expect(line.startsWith("🔴 ")).toBe(true);
    expect(line.toLowerCase()).not.toContain("bad");
    expect(line.toLowerCase()).not.toContain("bucket");
  });

  it("says who didn’t post at all", () => {
    expect(postingLine(row({ videos: [] }))).toContain("**0/7**");
    expect(postingLine(row({ videos: [] }))).toContain("didn’t post");
  });

  it("marks a creator in their first two weeks with a sprout", () => {
    const joinedAt = new Date(WEEK.start.getTime() - 10 * DAY);
    const line = postingLine(row({ videos: [video(3, 3_000)], joinedAt }));
    expect(line).toContain("🌱 wk 2");
  });
});

describe("cpmShort", () => {
  it("is a bare true number when the payout frontier has not moved", () => {
    expect(cpmShort(row({ videos: settled(5_000) }).performance)).toBe("$9.00");
  });

  it("marks a projection with ≈ and says nothing with no data", () => {
    const videos = Array.from({ length: 8 }, (_, i) => video(2 + i, 5_000, null));
    expect(cpmShort(row({ videos }).performance)).toBe("≈$9.00");
    expect(cpmShort(row({ videos: [] }).performance)).toBe("");
  });
});

describe("comparePosting", () => {
  it("ranks by posts, then avg views", () => {
    const many = row({ creatorId: "a", handle: "many", videos: settled(2_000, 6) });
    const few = row({ creatorId: "b", handle: "few", videos: settled(90_000, 2) });
    const fewLow = row({ creatorId: "c", handle: "fewlow", videos: settled(1_000, 2) });
    expect([fewLow, few, many].sort(comparePosting).map((r) => r.handle)).toEqual(["many", "few", "fewlow"]);
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
    row({ creatorId: "b", handle: "bb", videos: settled(5_000, 7) }),
    row({ creatorId: "c", handle: "cc", videos: settled(1_200) }),
    row({ creatorId: "d", handle: "dd", videos: [] }),
  ];

  it("headlines posting: bar, totals and quota in the description", () => {
    const [payload, ...rest] = buildCoachDigest({ coach: "Coach: Will's Team", week: WEEK, rows: team });
    expect(rest).toEqual([]);
    const [header] = payload.embeds;
    expect(header.author?.name).toBe("Coach: Will's Team");
    expect(header.title).toBe("📊 Here’s your weekly recap — Aug 24 – Aug 30");
    // 4+7+4+0 = 15 posts of 28 possible; one creator hit the quota.
    expect(header.description).toContain("**15** of 28 posts this week (54%)");
    expect(header.description).toContain("1 of 4 hit the 7-post quota");
    expect(header.description).toContain("█");
    expect(header.color).toBe(RECAP_COLOR);
  });

  it("shows the team stats as an inline grid and ranks everyone by posts", () => {
    const [payload] = buildCoachDigest({ coach: "x", week: WEEK, rows: team });
    const [header] = payload.embeds;
    const inline = header.fields!.filter((f) => f.inline);
    expect(inline.map((f) => f.name)).toEqual(["Avg views / post", "🚀 Spikes (40k+)", "Didn’t post"]);
    const list = header.fields!.find((f) => f.name === "Who posted what")!;
    const order = [...list.value.matchAll(/@(\w+)\]/g)].map((m) => m[1]);
    expect(order).toEqual(["bb", "aa", "cc", "dd"]);
    expect(list.value).toContain("didn’t post");
  });

  it("celebrates the best post and lists the flagged as decisions", () => {
    const [payload] = buildCoachDigest({ coach: "x", week: WEEK, rows: team });
    const names = payload.embeds[0].fields!.map((f) => f.name);
    expect(names).toContain("🏆 Best post of the week");
    expect(names).toContain("⚠️ Needs a decision");
    const best = payload.embeds[0].fields!.find((f) => f.name === "🏆 Best post of the week")!;
    expect(best.value).toContain("@aa — 60K views");
    const decisions = payload.embeds[0].fields!.find((f) => f.name === "⚠️ Needs a decision")!;
    expect(decisions.value).toContain("@cc");
    expect(decisions.value).toContain("→ call or offboard");
  });

  it("contains no bucket legend and no threshold talk", () => {
    const all = JSON.stringify(buildCoachDigest({ coach: "x", week: WEEK, rows: team }));
    expect(all).not.toContain("Buckets:");
    expect(all).not.toContain("40k avg views a post");
    expect(all).not.toContain("good ≥");
  });

  it("never pings: mentions live inside embeds and parse is empty", () => {
    const [payload] = buildCoachDigest({ coach: "x", week: WEEK, rows: team });
    expect(payload.content).toBeUndefined();
    expect(JSON.stringify(payload.embeds)).toContain("<@187727571922714626>");
    expect(payload.allowed_mentions.parse).toEqual([]);
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
          (e.author?.name.length ?? 0) +
          (e.footer?.text.length ?? 0) +
          (e.fields ?? []).reduce((s, f) => s + f.name.length + f.value.length, 0);
        expect(total).toBeLessThanOrEqual(EMBED_TOTAL_MAX);
        expect((e.fields ?? []).length).toBeLessThanOrEqual(25);
        for (const f of e.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(FIELD_VALUE_MAX);
      }
    }
    const all = JSON.stringify(payloads);
    for (const r of big) expect(all).toContain(`@${r.handle}`);
  });
});

describe("buildOnboardingPing", () => {
  it("recaps the first week without explaining the dot", () => {
    const joinedAt = new Date(WEEK.start.getTime() - 7 * DAY);
    const videos = [video(13, 50_000), video(12, 45_000), video(10, 40_000)];
    const ping = buildOnboardingPing(row({ videos, joinedAt }));
    const e = ping.embeds[0];
    expect(e.title).toBe("🌱 New creator — first week recap");
    expect(e.description).toContain("**3** posts in week one");
    expect(e.description).toContain("45K avg views");
    expect(e.description).toContain("CPM ≈");
    expect(e.description!.startsWith("🟢 ")).toBe(true);
    expect(ping.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("weekLabel", () => {
  it("prints the Monday and the Sunday", () => {
    expect(weekLabel(WEEK)).toBe("Aug 24 – Aug 30");
  });
});
