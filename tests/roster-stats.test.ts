import { describe, expect, it } from "vitest";
import { rosterRowStats } from "@/lib/roster-stats";
import type { ResearchVideo } from "@/lib/types";

/** Minimal video row — only the fields the stats read. */
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
    ...over,
  }) as ResearchVideo;

/** Local-time ISO for `daysAgo` days before `now`, at the given hour. */
const NOW = new Date(2026, 7, 17, 12, 0, 0); // Monday, Aug 17 2026, local noon
const postedDaysAgo = (daysAgo: number, hour = 9) => {
  const d = new Date(2026, 7, 17 - daysAgo, hour, 0, 0);
  return d.toISOString();
};

describe("rosterRowStats day strip", () => {
  it("renders 7 cells, oldest first, ending today, labeled by weekday initial", () => {
    const { days } = rosterRowStats([], null, NOW);
    expect(days).toHaveLength(7);
    // Aug 11–17 2026 is Tue..Mon.
    expect(days.map((d) => d.label)).toEqual(["T", "W", "T", "F", "S", "S", "M"]);
  });

  it("buckets videos into their local calendar day", () => {
    const videos = [
      video({ posted_at: postedDaysAgo(6) }), // oldest visible day
      video({ posted_at: postedDaysAgo(0) }), // today
      video({ posted_at: postedDaysAgo(0, 22) }), // also today, late evening
    ];
    const { days, postsLast7 } = rosterRowStats(videos, null, NOW);
    expect(days[0].count).toBe(1);
    expect(days[6].count).toBe(2);
    expect(postsLast7).toBe(3);
  });

  it("ignores videos older than 7 days and undated videos", () => {
    const videos = [
      video({ posted_at: postedDaysAgo(8) }),
      video({ posted_at: null }),
    ];
    const { days, postsLast7 } = rosterRowStats(videos, null, NOW);
    expect(days.every((d) => d.count === 0)).toBe(true);
    expect(postsLast7).toBe(0);
  });
});

describe("rosterRowStats metrics", () => {
  const inWindow = video({
    posted_at: postedDaysAgo(2),
    view_count: 1000,
    like_count: 80,
    comment_count: 15,
    share_count: 5,
  });
  const older = video({
    posted_at: postedDaysAgo(30),
    view_count: 3000,
    like_count: 30,
    comment_count: 0,
    share_count: 0,
  });

  it("splits window metrics from all-time metrics", () => {
    const s = rosterRowStats([inWindow, older], 7, NOW);
    expect(s.views).toBe(1000);
    expect(s.allViews).toBe(4000);
    expect(s.avgViews).toBe(1000);
    expect(s.allAvgViews).toBe(2000);
  });

  it("computes engagement as total interactions over total views", () => {
    const s = rosterRowStats([inWindow, older], 7, NOW);
    expect(s.engPct).toBeCloseTo(10); // (80+15+5)/1000
    expect(s.allEngPct).toBeCloseTo((130 / 4000) * 100);
  });

  it("equals all-time when the window is All time", () => {
    const s = rosterRowStats([inWindow, older], null, NOW);
    expect(s.views).toBe(s.allViews);
    expect(s.avgViews).toBe(s.allAvgViews);
    expect(s.engPct).toBe(s.allEngPct);
  });

  it("returns nulls, not NaN, when there is nothing to average", () => {
    const s = rosterRowStats([], 7, NOW);
    expect(s.avgViews).toBeNull();
    expect(s.engPct).toBeNull();
    expect(s.views).toBe(0);
  });

  it("excludes viewless videos from averages but keeps engagement sane", () => {
    const s = rosterRowStats([inWindow, video({ posted_at: postedDaysAgo(1) })], 7, NOW);
    expect(s.avgViews).toBe(1000);
    expect(s.engPct).toBeCloseTo(10);
  });
});
