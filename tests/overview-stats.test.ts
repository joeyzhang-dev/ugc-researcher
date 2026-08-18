import { describe, expect, it } from "vitest";
import {
  dailySeries,
  runningTotal,
  staleCreators,
  consistencyLabel,
  formatCallouts,
} from "@/lib/overview-stats";
import type { ResearchCreator, ResearchVideo } from "@/lib/types";

const NOW = new Date(2026, 7, 17, 12, 0, 0); // Monday, Aug 17 2026, local noon

const video = (over: Partial<ResearchVideo>): ResearchVideo =>
  ({
    id: Math.random().toString(36).slice(2),
    research_creator_id: "c1",
    url: "https://example.com",
    posted_at: null,
    view_count: null,
    like_count: null,
    comment_count: null,
    share_count: null,
    format_category: null,
    ...over,
  }) as ResearchVideo;

const creator = (over: Partial<ResearchCreator>): ResearchCreator =>
  ({ id: "c1", handle: "one", platform: "instagram", ...over }) as ResearchCreator;

const onDay = (daysAgo: number, hour = 9) =>
  new Date(2026, 7, 17 - daysAgo, hour).toISOString();

describe("dailySeries", () => {
  it("spans the picked window, one point per day, ending today", () => {
    const days = dailySeries([], 7, NOW);
    expect(days).toHaveLength(7);
    expect(days[6].date).toBe("2026-08-17");
    expect(days[0].date).toBe("2026-08-11");
  });

  it("buckets metrics by upload day", () => {
    const vids = [
      video({ posted_at: onDay(1), view_count: 100, like_count: 10, comment_count: 2, share_count: 3 }),
      video({ posted_at: onDay(1, 22), view_count: 50 }),
      video({ posted_at: onDay(0), view_count: 7 }),
    ];
    const days = dailySeries(vids, 3, NOW);
    expect(days[1]).toMatchObject({ views: 150, likes: 10, comments: 2, shares: 5 - 2, posts: 2 });
    expect(days[1].engagement).toBe(15);
    expect(days[2]).toMatchObject({ views: 7, posts: 1 });
  });

  it("spans from the earliest video when the window is All time", () => {
    const days = dailySeries([video({ posted_at: onDay(9), view_count: 1 })], null, NOW);
    expect(days).toHaveLength(10);
    expect(days[0].views).toBe(1);
  });

  it("gives All time with no dated videos a single empty day instead of crashing", () => {
    expect(dailySeries([], null, NOW)).toHaveLength(1);
  });
});

describe("runningTotal", () => {
  it("accumulates values in order", () => {
    const days = dailySeries(
      [
        video({ posted_at: onDay(2), view_count: 5 }),
        video({ posted_at: onDay(0), view_count: 10 }),
      ],
      3,
      NOW
    );
    expect(runningTotal(days).map((d) => d.views)).toEqual([5, 5, 15]);
  });
});

describe("staleCreators", () => {
  it("keeps only creators quiet for more than 3 days, never-posted pinned first, then by views at stake", () => {
    const rows = staleCreators(
      [
        creator({ id: "fresh", handle: "fresh" }),
        creator({ id: "small", handle: "small" }),
        creator({ id: "big", handle: "big" }),
        creator({ id: "never", handle: "never" }),
      ],
      new Map([
        ["fresh", [video({ posted_at: onDay(1), view_count: 9 })]],
        ["small", [video({ posted_at: onDay(10), view_count: 100 })]],
        ["big", [video({ posted_at: onDay(5), view_count: 900 })]],
        ["never", []],
      ]),
      NOW
    );
    expect(rows.map((r) => r.creator.id)).toEqual(["never", "big", "small"]);
    expect(rows[1].daysSince).toBe(5);
    expect(rows[1].totalViews).toBe(900);
    expect(rows[0].daysSince).toBeNull();
  });
});

describe("consistencyLabel", () => {
  it("calls 3+ of the last 4 weeks Consistent", () => {
    expect(
      consistencyLabel([onDay(2), onDay(9), onDay(16)].map((d) => video({ posted_at: d })), NOW)
    ).toBe("Consistent");
  });

  it("calls 1-2 active weeks Sporadic and none Quiet", () => {
    expect(consistencyLabel([video({ posted_at: onDay(2) })], NOW)).toBe("Sporadic");
    expect(consistencyLabel([video({ posted_at: onDay(40) })], NOW)).toBe("Quiet");
  });
});

describe("formatCallouts", () => {
  const bucket = (name: string, views: number[], daysAgo = 5) =>
    views.map((v) => video({ format_category: name, view_count: v, posted_at: onDay(daysAgo) }));

  it("picks the strongest and weakest format with enough volume", () => {
    const { working, stop } = formatCallouts([
      ...bucket("S-tier list", [900, 1000, 1100]),
      ...bucket("Daily routine", [10, 20, 30]),
      ...bucket("Rare gem", [99999]), // only one video — not enough volume
    ]);
    expect(working?.name).toBe("S-tier list");
    expect(working?.medianViews).toBe(1000);
    expect(stop?.name).toBe("Daily routine");
    expect(stop?.shareOfPosts).toBeCloseTo(3 / 7);
  });

  it("never calls the same format both working and stop", () => {
    const { working, stop } = formatCallouts(bucket("Only one", [1, 2, 3]));
    expect(working?.name).toBe("Only one");
    expect(stop).toBeNull();
  });

  it("ignores uncategorized videos", () => {
    const { working } = formatCallouts(bucket(null as unknown as string, [5, 6, 7]));
    expect(working).toBeNull();
  });
});
