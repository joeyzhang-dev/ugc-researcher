import { describe, expect, it } from "vitest";
import {
  badStreak,
  bucketFor,
  comparePerformance,
  cpmRead,
  creatorPerformance,
  delta,
  lastCompleteWeek,
  onboardingRead,
  parseWeek,
  previousWeek,
  projectedCpm,
  projectedEarnings,
  trueCpm,
  weekKey,
  weekStart,
  weekWindow,
  weeklyRead,
  weeksSinceJoined,
  type PerformanceVideo,
} from "@/lib/performance";

const DAY = 24 * 60 * 60 * 1000;

function video(
  postedAt: string,
  views: number,
  earnings: number | null = null,
  shortcode = `sc${views}`
): PerformanceVideo {
  return {
    shortcode,
    url: `https://www.instagram.com/reel/${shortcode}/`,
    posted_at: postedAt,
    view_count: views,
    earnings_usd: earnings,
  };
}

// 2026-08-24 is a Monday.
const WEEK = weekWindow(new Date("2026-08-26T15:00:00Z"));

describe("weeks", () => {
  it("floors to Monday 00:00 UTC whatever the weekday or hour", () => {
    expect(weekStart(new Date("2026-08-26T15:00:00Z")).toISOString()).toBe("2026-08-24T00:00:00.000Z");
    expect(weekStart(new Date("2026-08-24T00:00:00Z")).toISOString()).toBe("2026-08-24T00:00:00.000Z");
    // Sunday belongs to the week that started the previous Monday.
    expect(weekStart(new Date("2026-08-30T23:59:59Z")).toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  it("keys a week by its Monday and parses any day of it back to the same week", () => {
    expect(weekKey(WEEK)).toBe("2026-08-24");
    expect(parseWeek("2026-08-29")?.start.toISOString()).toBe(WEEK.start.toISOString());
    expect(parseWeek("garbage")).toBeNull();
    expect(parseWeek(undefined)).toBeNull();
  });

  it("last complete week excludes the week in progress", () => {
    const w = lastCompleteWeek(new Date("2026-08-29T10:00:00Z"));
    expect(weekKey(w)).toBe("2026-08-17");
    expect(w.end.toISOString()).toBe("2026-08-24T00:00:00.000Z");
    expect(weekKey(previousWeek(w))).toBe("2026-08-10");
  });
});

describe("trueCpm", () => {
  // Liam's eight paid posts as Launchpoint reported them on 2026-08-29 —
  // the API's paid-only summary said cpm 1.489, and that is the demo's $1.56.
  const liam = [
    video("2026-08-04T00:00:00Z", 1637, 41.63),
    video("2026-08-01T00:00:00Z", 5420, 45.38),
    video("2026-07-31T00:00:00Z", 455218, 406.54),
    video("2026-07-31T01:00:00Z", 4022, 43.99),
    video("2026-07-30T00:00:00Z", 1624, 41.6),
    video("2026-07-30T01:00:00Z", 1983, 41.97),
    video("2026-07-29T00:00:00Z", 1436, 41.38),
    video("2026-07-29T01:00:00Z", 1383, 41.36),
  ];

  it("reproduces Launchpoint's paid-only CPM", () => {
    expect(trueCpm(liam)).toBeCloseTo(1.489, 2);
  });

  it("ignores unpaid posts entirely — their views must not dilute the number", () => {
    // Launchpoint's per-account cpm makes exactly this mistake (0.30 for Liam).
    const withUnpaid = [...liam, video("2026-08-20T00:00:00Z", 1_360_131, null)];
    expect(trueCpm(withUnpaid)).toBeCloseTo(1.489, 2);
  });

  it("is a ratio of sums, not a mean of per-post CPMs", () => {
    const posts = [video("2026-08-01T00:00:00Z", 900, 40.9), video("2026-08-02T00:00:00Z", 400_000, 440)];
    // Mean of per-post CPMs would be (45.4 + 1.1) / 2 ≈ 23; the truth is ~1.2.
    expect(trueCpm(posts)).toBeCloseTo(1.2, 1);
  });

  it("is null, never $0, while nothing has been paid", () => {
    expect(trueCpm([video("2026-08-20T00:00:00Z", 50_000, null)])).toBeNull();
    expect(trueCpm([video("2026-08-20T00:00:00Z", 50_000, 0)])).toBeNull();
    expect(trueCpm([])).toBeNull();
  });
});

describe("payscale projection", () => {
  it("pays $40 flat past 1k views plus $1 per thousand", () => {
    expect(projectedEarnings(1637)).toBeCloseTo(41.64, 2);
    expect(projectedEarnings(455218)).toBeCloseTo(495.22, 2);
  });

  it("withholds the flat fee under 1k views — the $0-base cluster in the data", () => {
    expect(projectedEarnings(900)).toBeCloseTo(0.9, 2);
    expect(projectedEarnings(0)).toBe(0);
  });

  it("caps counted views at the program maximum", () => {
    expect(projectedEarnings(5_000_000)).toBe(1040);
  });

  it("uses real earnings where a post is paid and the formula elsewhere", () => {
    const posts = [
      video("2026-08-01T00:00:00Z", 10_000, 50.04), // settled at 10,040 views
      video("2026-08-20T00:00:00Z", 10_000, null), // projected: $50
    ];
    expect(projectedCpm(posts)).toBeCloseTo(((50.04 + 50) * 1000) / 20_000, 3);
    expect(projectedCpm([])).toBeNull();
  });
});

describe("bucketFor", () => {
  it("draws Joey's lines: under $2 good, over $25 bad", () => {
    expect(bucketFor(1.56)).toBe("good");
    expect(bucketFor(2)).toBe("decent");
    expect(bucketFor(13.5)).toBe("decent");
    expect(bucketFor(25)).toBe("decent");
    expect(bucketFor(27.7)).toBe("bad");
    expect(bucketFor(null)).toBeNull();
  });
});

describe("weeklyRead", () => {
  const posts = [
    video("2026-08-23T23:59:59Z", 999, null, "before"), // Sunday before — out
    video("2026-08-24T00:00:00Z", 1_500, null, "mon"),
    video("2026-08-26T12:00:00Z", 45_000, null, "spike"),
    video("2026-08-28T12:00:00Z", 2_000, null, "fri"),
    video("2026-08-31T00:00:00Z", 80_000, null, "next"), // next Monday — out
  ];

  it("counts posts inside the Monday→Monday window and flags the quota", () => {
    const r = weeklyRead(posts, WEEK);
    expect(r.posts).toBe(3);
    expect(r.quota).toBe(7);
    expect(r.belowQuota).toBe(true);
    expect(r.views).toBe(48_500);
    expect(r.avgViews).toBeCloseTo(48_500 / 3, 3);
  });

  it("names the spikes and the best post so the embed can link them", () => {
    const r = weeklyRead(posts, WEEK);
    expect(r.spikes.map((s) => s.shortcode)).toEqual(["spike"]);
    expect(r.bestPost?.shortcode).toBe("spike");
  });

  it("is empty, not broken, for a creator who posted nothing", () => {
    const r = weeklyRead([], WEEK);
    expect(r.posts).toBe(0);
    expect(r.avgViews).toBeNull();
    expect(r.bestPost).toBeNull();
    expect(r.belowQuota).toBe(true);
  });
});

describe("cpmRead / delta", () => {
  const asOf = WEEK.end; // 2026-08-31
  const posts = [
    video("2026-07-25T00:00:00Z", 2_000, 42), // 37 days back — outside 30d
    video("2026-08-05T00:00:00Z", 2_000, 42), // settled, inside
    video("2026-08-10T00:00:00Z", 6_000, 46), // settled, inside
    video("2026-08-27T00:00:00Z", 100_000, null), // too fresh to be paid
  ];

  it("takes the true CPM over paid posts of the trailing 30 days only", () => {
    const r = cpmRead(posts, asOf);
    expect(r.posts).toBe(3);
    expect(r.paidPosts).toBe(2);
    expect(r.cpm).toBeCloseTo((88 * 1000) / 8_000, 3);
  });

  it("projects the same window including the unpaid post", () => {
    const r = cpmRead(posts, asOf);
    // 42 + 46 + (40 + 100) over 108,000 views
    expect(r.projected).toBeCloseTo((228 * 1000) / 108_000, 3);
  });

  it("expresses change in both dollars and percent, null without both sides", () => {
    expect(delta(9, 10)).toEqual({ usd: -1, pct: -10 });
    expect(delta(null, 10)).toBeNull();
    expect(delta(10, null)).toBeNull();
    expect(delta(10, 0)).toBeNull();
  });
});

describe("onboardingRead", () => {
  const joined = new Date("2026-07-29T00:00:00Z");
  const firstWeek = [
    video("2026-07-29T10:00:00Z", 1_436, 41.38),
    video("2026-07-31T10:00:00Z", 455_218, 406.54),
    video("2026-08-04T10:00:00Z", 1_637, 41.63),
  ];
  const later = video("2026-08-20T10:00:00Z", 50_000, null);

  it("reads only the first seven days after joining", () => {
    const r = onboardingRead([...firstWeek, later], joined, new Date("2026-08-29T00:00:00Z"));
    expect(r.posts).toBe(3);
    expect(r.cpm).toBeCloseTo((489.55 * 1000) / 458_291, 3);
    expect(r.source).toBe("true");
    expect(r.bucket).toBe("good");
  });

  it("is final once every first-week post has been paid", () => {
    expect(onboardingRead(firstWeek, joined, new Date("2026-08-10T00:00:00Z")).final).toBe(true);
  });

  it("falls back to a labelled projection while payouts are pending, and is not final", () => {
    const unpaid = firstWeek.map((v) => ({ ...v, earnings_usd: null }));
    const r = onboardingRead(unpaid, joined, new Date("2026-08-10T00:00:00Z"));
    expect(r.cpm).toBeNull();
    expect(r.source).toBe("projected");
    expect(r.bucket).toBe("good");
    expect(r.final).toBe(false);
  });

  it("stops waiting once the settlement window plus grace has passed", () => {
    const unpaid = firstWeek.map((v) => ({ ...v, earnings_usd: null }));
    // joined 07-29 → first week ends 08-05 → +14 settle +7 grace = 08-26
    expect(onboardingRead(unpaid, joined, new Date("2026-08-25T00:00:00Z")).final).toBe(false);
    expect(onboardingRead(unpaid, joined, new Date("2026-08-26T00:00:00Z")).final).toBe(true);
  });

  it("knows nothing without a joining date", () => {
    const r = onboardingRead(firstWeek, null, new Date("2026-08-29T00:00:00Z"));
    expect(r.bucket).toBeNull();
    expect(r.final).toBe(false);
  });
});

describe("weeksSinceJoined", () => {
  it("counts whole weeks up to the end of the week being read", () => {
    expect(weeksSinceJoined(new Date("2026-07-29T00:00:00Z"), WEEK)).toBe(4);
    expect(weeksSinceJoined(new Date("2026-08-27T00:00:00Z"), WEEK)).toBe(0);
    expect(weeksSinceJoined(null, WEEK)).toBeNull();
  });
});

describe("badStreak", () => {
  // One bad post a week (1.5k views → ~$27.7 CPM) for five weeks.
  const badPosts = Array.from({ length: 5 }, (_, i) =>
    video(new Date(WEEK.start.getTime() - i * 7 * DAY + 2 * DAY).toISOString(), 1_500, null, `b${i}`)
  );

  it("counts consecutive bad weeks ending with the week read", () => {
    expect(badStreak(badPosts, WEEK, new Date("2026-06-01T00:00:00Z"))).toBe(5);
  });

  it("does not reach back before the creator joined", () => {
    const joined = new Date(WEEK.start.getTime() - 2 * 7 * DAY + DAY);
    expect(badStreak(badPosts, WEEK, joined)).toBe(3);
  });

  it("breaks on the first non-bad week", () => {
    const withSpike = [
      ...badPosts,
      video(new Date(WEEK.start.getTime() - 2 * 7 * DAY + 3 * DAY).toISOString(), 90_000, null, "spike"),
    ];
    // The spike sits inside the 30-day window of the current and previous
    // reads too, so it lifts every week it can see out of "bad".
    expect(badStreak(withSpike, WEEK, new Date("2026-06-01T00:00:00Z"))).toBe(0);
  });
});

describe("creatorPerformance", () => {
  it("judges the bucket on the true CPM when there is one, and says so", () => {
    const videos = [
      video("2026-08-05T00:00:00Z", 60_000, 100),
      video("2026-08-27T00:00:00Z", 500, null),
    ];
    const p = creatorPerformance({ videos, joinedAt: new Date("2026-07-01T00:00:00Z"), week: WEEK });
    expect(p.bucketSource).toBe("true");
    expect(p.bucket).toBe("good");
    expect(p.weekly.posts).toBe(1);
    expect(p.flagged).toBe(false);
  });

  it("flags three consecutive bad weeks for the coach", () => {
    const videos = Array.from({ length: 4 }, (_, i) =>
      video(new Date(WEEK.start.getTime() - i * 7 * DAY + DAY).toISOString(), 1_200, null, `w${i}`)
    );
    const p = creatorPerformance({ videos, joinedAt: new Date("2026-07-01T00:00:00Z"), week: WEEK });
    expect(p.bucketSource).toBe("projected");
    expect(p.bucket).toBe("bad");
    expect(p.badStreak).toBe(4);
    expect(p.flagged).toBe(true);
  });

  it("orders bad before decent before good, and the worst rise first within a bucket", () => {
    const mk = (views: number, prevViews: number) =>
      creatorPerformance({
        videos: [
          video("2026-08-05T00:00:00Z", prevViews, projectedEarningsFor(prevViews)),
          video("2026-08-10T00:00:00Z", views, projectedEarningsFor(views)),
        ],
        joinedAt: null,
        week: WEEK,
      });
    const good = mk(90_000, 90_000);
    const bad = mk(1_200, 1_200);
    const decent = mk(5_000, 5_000);
    const sorted = [good, decent, bad].sort(comparePerformance);
    expect(sorted.map((p) => p.bucket)).toEqual(["bad", "decent", "good"]);
  });
});

function projectedEarningsFor(views: number): number {
  return projectedEarnings(views);
}
