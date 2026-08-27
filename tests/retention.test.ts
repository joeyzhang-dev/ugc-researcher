import { describe, expect, it } from "vitest";
import {
  dayOneShare,
  holdRate,
  isStillClimbing,
  median,
  retentionMetrics,
  summarizeRetention,
  type RetentionInput,
} from "@/lib/retention";

const blank: RetentionInput = {
  avgWatchTimeMs: null,
  totalWatchTimeMs: null,
  durationSeconds: null,
  skipRate: null,
  reach: null,
  views: null,
  saves: null,
  shares: null,
  earningsUsd: null,
};

describe("holdRate", () => {
  it("expresses average watch time as a fraction of the video", () => {
    expect(holdRate(16682, 30)).toBeCloseTo(0.556, 3);
  });

  // Instagram counts a replay as continued watch time on the same impression,
  // so a short loopable reel genuinely averages more than its own duration.
  // Clamping to 1.0 would erase exactly the signal worth finding.
  it("does not clamp above 1 — replays are the good case", () => {
    expect(holdRate(21000, 15)).toBeCloseTo(1.4, 3);
  });

  // A 0-second duration (stale scrape, photo post) would otherwise produce
  // Infinity and poison every median downstream.
  it("refuses to divide by a zero or missing duration", () => {
    expect(holdRate(16682, 0)).toBeNull();
    expect(holdRate(16682, null)).toBeNull();
    expect(holdRate(null, 30)).toBeNull();
    expect(holdRate(-5, 30)).toBeNull();
  });
});

describe("retentionMetrics", () => {
  // Numbers lifted from a live post: 1.35M views, 1.13M reach.
  const post: RetentionInput = {
    ...blank,
    avgWatchTimeMs: 16682,
    totalWatchTimeMs: 18817022779,
    durationSeconds: 30,
    skipRate: 41,
    reach: 1132304,
    views: 1351963,
    saves: 27796,
    shares: 5565,
    earningsUsd: null,
  };

  it("derives replay, save and share rates against reach, not views", () => {
    const m = retentionMetrics(post);
    expect(m.replayRate).toBeCloseTo(0.194, 3);
    expect(m.saveRate).toBeCloseTo(0.02455, 4);
    expect(m.shareRate).toBeCloseTo(0.004915, 5);
    expect(m.skipRate).toBe(41);
  });

  // Launchpoint samples views and reach at different moments, so reach can
  // briefly exceed views. A negative replay rate is meaningless.
  it("floors the replay rate at zero when reach outruns views", () => {
    expect(retentionMetrics({ ...post, reach: 2_000_000 }).replayRate).toBe(0);
  });

  // $40 spread over 1.35M views is ~3 cents per thousand — the flat-fee pay
  // model means a hit post costs almost nothing per view, which is the whole
  // reason to look at CPM per script rather than per payout.
  it("computes CPM from earnings and views", () => {
    expect(retentionMetrics({ ...post, earningsUsd: 40 }).cpmUsd).toBeCloseTo(0.0296, 4);
  });

  // An unpaid post is not a $0.00 CPM — rendering it as one would read as
  // "this creator worked for free" rather than "not paid out yet".
  it("leaves CPM null for an unpaid post rather than reporting zero", () => {
    expect(retentionMetrics({ ...post, earningsUsd: 0 }).cpmUsd).toBeNull();
    expect(retentionMetrics({ ...post, earningsUsd: null }).cpmUsd).toBeNull();
  });

  it("returns all-null for a post with no insights yet", () => {
    const m = retentionMetrics(blank);
    expect(m).toEqual({
      holdRate: null,
      skipRate: null,
      replayRate: null,
      saveRate: null,
      shareRate: null,
      cpmUsd: null,
    });
  });
});

describe("median", () => {
  it("averages the middle pair on an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
  });

  it("returns null for an empty or non-finite set", () => {
    expect(median([])).toBeNull();
    expect(median([NaN, Infinity])).toBeNull();
  });
});

describe("summarizeRetention", () => {
  const post = (views: number, avgMs: number, earnings: number | null): RetentionInput => ({
    ...blank,
    views,
    reach: Math.round(views * 0.8),
    avgWatchTimeMs: avgMs,
    durationSeconds: 30,
    skipRate: 40,
    saves: 10,
    earningsUsd: earnings,
  });

  // View counts across a roster span three orders of magnitude. A mean hold
  // rate is dominated by whichever post went viral; the median describes the
  // typical post, which is what comparing two scripts actually needs.
  it("uses the median so one viral outlier cannot define the script", () => {
    const s = summarizeRetention([post(2000, 6000, null), post(2100, 6000, null), post(1351963, 24000, null)]);
    expect(s.medianHoldRate).toBeCloseTo(0.2, 3);
    expect(s.sampleSize).toBe(3);
  });

  // Averaging per-post CPMs would weight a $40 flat fee on a 200-view post the
  // same as one on a 300k-view post. Blended spend over blended views is the
  // number a buyer actually cares about.
  it("blends CPM over totals instead of averaging ratios", () => {
    const s = summarizeRetention([post(1000, 6000, 40), post(1_000_000, 6000, 40)]);
    expect(s.totalEarningsUsd).toBe(80);
    expect(s.blendedCpmUsd).toBeCloseTo(0.0799, 4);
  });

  // A median over 2 posts must never be presentable as a median over 200.
  it("counts only posts that carry insights in the sample size", () => {
    const s = summarizeRetention([blank, blank, post(1000, 6000, null)]);
    expect(s.sampleSize).toBe(1);
  });

  it("handles an empty set", () => {
    const s = summarizeRetention([]);
    expect(s).toMatchObject({ sampleSize: 0, medianHoldRate: null, blendedCpmUsd: null });
  });
});

describe("dayOneShare", () => {
  // The live curve of a 1.35M post: over half its lifetime views on day one.
  const curve = [
    { date: "2026-08-17", views: 715218 },
    { date: "2026-08-18", views: 1141156 },
    { date: "2026-08-26", views: 1351966 },
  ];

  it("measures how front-loaded a post's distribution was", () => {
    expect(dayOneShare(curve)).toBeCloseTo(0.529, 3);
  });

  it("sorts by date rather than trusting input order", () => {
    expect(dayOneShare([...curve].reverse())).toBeCloseTo(0.529, 3);
  });

  // A post Launchpoint first saw yesterday is trivially 100% day-one and would
  // drag any average toward a conclusion about nothing.
  it("returns null for a single-point series", () => {
    expect(dayOneShare([{ date: "2026-08-26", views: 296 }])).toBeNull();
    expect(dayOneShare([])).toBeNull();
  });
});

describe("isStillClimbing", () => {
  // The state the old point-in-time scrape could never detect. It changes what
  // you do: a rising post is worth copying now, a flat one is safe to judge.
  it("is true while the latest day still adds a meaningful share", () => {
    expect(
      isStillClimbing([
        { date: "2026-08-25", views: 900_000, viewsDelta: 200_000 },
        { date: "2026-08-26", views: 1_000_000, viewsDelta: 100_000 },
      ])
    ).toBe(true);
  });

  it("is false once the post has flattened out", () => {
    expect(
      isStillClimbing([
        { date: "2026-08-25", views: 1_349_270, viewsDelta: 12_101 },
        { date: "2026-08-26", views: 1_351_966, viewsDelta: 2_696 },
      ])
    ).toBe(false);
  });

  // Threshold is a share of total, not an absolute count, so it means the same
  // thing for a 2k post and a 1.3M one.
  it("scales with post size rather than using a flat view count", () => {
    const small = [
      { date: "2026-08-25", views: 1_800, viewsDelta: 300 },
      { date: "2026-08-26", views: 2_000, viewsDelta: 200 },
    ];
    expect(isStillClimbing(small)).toBe(true);
  });

  it("is false without at least two points", () => {
    expect(isStillClimbing([{ date: "2026-08-26", views: 100, viewsDelta: 100 }])).toBe(false);
  });
});
