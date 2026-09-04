import { describe, expect, it } from "vitest";
import {
  BAD_AVG_VIEWS,
  BAD_STREAK_FLAG,
  CPM_WINDOW_DAYS,
  GOOD_AVG_VIEWS,
  WEEK_MS,
  medianBucket,
  medianViews,
  teamCpmRead,
  teamPerformance,
  trailingWindow,
  transcriptHorizon,
  badStreak,
  bucketBasis,
  bucketForViews,
  collapseTrialUploads,
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
  type PerformanceVideo,
  weekKey,
  weekStart,
  weekWindow,
  weeklyRead,
  weeksSinceJoined,
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

describe("bucketForViews", () => {
  it("translates Joey's CPM lines into views: $2 is 40k, $25 is 1,667", () => {
    expect(GOOD_AVG_VIEWS).toBe(40_000);
    expect(BAD_AVG_VIEWS).toBeCloseTo(1_666.67, 1);
  });

  it("buckets on average views per post", () => {
    expect(bucketForViews(71_000)).toBe("good"); // Liam: $1.56
    expect(bucketForViews(40_000)).toBe("good");
    expect(bucketForViews(5_000)).toBe("decent");
    expect(bucketForViews(1_667)).toBe("decent");
    expect(bucketForViews(1_500)).toBe("bad"); // "super bad"
    expect(bucketForViews(null)).toBeNull();
  });

  // Under 1,000 views the flat fee is withheld and a post costs cents, so
  // its CPM reads as a "good" $1.00. A creator averaging 149 views is the
  // worst case, not the best — the bucket must not follow the price there.
  it("does not let a sub-1k creator look good because he is cheap", () => {
    expect(projectedCpm([video("2026-08-25T00:00:00Z", 149, null)])).toBeCloseTo(1, 3);
    expect(bucketForViews(149)).toBe("bad");
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

  it("projects what the week's posts will cost — the leading indicator", () => {
    const r = weeklyRead(posts, WEEK);
    // (40+1.5) + (40+45) + (40+2) over 48,500 views
    expect(r.projectedCpm).toBeCloseTo((168.5 * 1000) / 48_500, 3);
    expect(weeklyRead([], WEEK).projectedCpm).toBeNull();
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
    video("2026-07-05T00:00:00Z", 2_000, 42), // 36 days before the frontier — out
    video("2026-07-25T00:00:00Z", 2_000, 42), // settled; outside the calendar 30d, inside the settled 30d
    video("2026-08-05T00:00:00Z", 2_000, 42), // settled
    video("2026-08-10T00:00:00Z", 6_000, 46), // settled — the payout frontier
    video("2026-08-27T00:00:00Z", 100_000, null), // too fresh to be paid
  ];

  it("takes the true CPM over 30 days of settled posts ending at the newest payout", () => {
    const r = cpmRead(posts, asOf);
    expect(r.settledWindow?.end.toISOString()).toBe("2026-08-10T00:00:00.001Z");
    expect(r.paidPosts).toBe(3);
    expect(r.cpm).toBeCloseTo((130 * 1000) / 10_000, 3);
    expect(r.lowSample).toBe(false);
  });

  it("projects the calendar window including the unpaid post", () => {
    const r = cpmRead(posts, asOf);
    expect(r.posts).toBe(3); // 08-05, 08-10, 08-27
    // 42 + 46 + (40 + 100) over 108,000 views
    expect(r.projected).toBeCloseTo((228 * 1000) / 108_000, 3);
  });

  // Liam, 2026-08-29: the calendar window held 2 paid posts and said $12.33;
  // the settled window holds all 8 and says $1.49, which is what Launchpoint's
  // own paid-only summary shows. The number must not jump when a big post
  // ages out of the calendar while nothing about the creator changed.
  it("does not lose the month's big post just because the calendar moved on", () => {
    const liam = [
      video("2026-07-31T00:00:00Z", 455_218, 406.54),
      video("2026-08-01T00:00:00Z", 5_420, 45.38),
      video("2026-08-04T00:00:00Z", 1_637, 41.63),
      ...Array.from({ length: 10 }, (_, i) => video(`2026-08-${String(10 + i).padStart(2, "0")}T00:00:00Z`, 2_000, null, `u${i}`)),
    ];
    const r = cpmRead(liam, new Date("2026-08-31T00:00:00Z"));
    expect(r.paidPosts).toBe(3);
    expect(r.cpm).toBeCloseTo(1.07, 2);
    expect(r.lowSample).toBe(false);
  });

  it("marks fewer than three paid posts as a low sample", () => {
    const r = cpmRead(posts.slice(2), asOf); // 08-05 and 08-10 paid
    expect(r.paidPosts).toBe(2);
    expect(r.lowSample).toBe(true);
  });

  it("has no true CPM once the newest payout is older than the settle lag", () => {
    const stale = [video("2026-06-01T00:00:00Z", 50_000, 90)];
    const r = cpmRead(stale, asOf);
    expect(r.cpm).toBeNull();
    expect(r.settledWindow).toBeNull();
    expect(r.projected).toBeNull(); // nothing in the calendar window either
  });

  it("only looks at payouts before asOf, so last week's read is reproducible", () => {
    const r = cpmRead(posts, new Date("2026-08-08T00:00:00Z"));
    expect(r.settledWindow?.end.toISOString()).toBe("2026-08-05T00:00:00.001Z");
    expect(r.paidPosts).toBe(2); // 07-25 and 08-05; 07-05 is 31 days before the frontier
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
    expect(r.avgViews).toBeCloseTo(458_291 / 3, 0);
    expect(r.cpm).toBeCloseTo((489.55 * 1000) / 458_291, 3);
    expect(r.source).toBe("true");
    expect(r.bucket).toBe("good");
  });

  it("buckets on views the moment the first week closes — payouts only confirm the CPM", () => {
    const unpaid = firstWeek.map((v) => ({ ...v, earnings_usd: null }));
    const r = onboardingRead(unpaid, joined, new Date("2026-08-10T00:00:00Z"));
    expect(r.cpm).toBeNull();
    expect(r.source).toBe("projected");
    expect(r.bucket).toBe("good");
    expect(r.final).toBe(true);
  });

  it("is not final while the first week is still running, and sees only posts so far", () => {
    // joined 07-29 → first week ends 08-05
    const r = onboardingRead(firstWeek, joined, new Date("2026-08-01T00:00:00Z"));
    expect(r.posts).toBe(2);
    expect(r.final).toBe(false);
    expect(onboardingRead(firstWeek, joined, new Date("2026-08-05T00:00:00Z")).final).toBe(true);
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

  it("does not count a week whose true read is a low sample — the projection decides", () => {
    // One paid spike five weeks back is the newest payout, so the true read
    // is "good" on a sample of one — while every post of the last month is
    // bad. The streak must judge the month, not the one post.
    const withOnePaidSpike = [
      ...badPosts,
      video(new Date(WEEK.end.getTime() - 35 * DAY).toISOString(), 90_000, 130, "paid-spike"),
    ];
    const read = cpmRead(withOnePaidSpike, WEEK.end);
    expect(read.lowSample).toBe(true);
    expect(bucketForViews(read.settledAvgViews)).toBe("good");
    expect(bucketBasis(read)).toEqual({ avgViews: 1_500, source: "projected" });
    expect(badStreak(withOnePaidSpike, WEEK, new Date("2026-06-01T00:00:00Z"))).toBeGreaterThan(0);
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
  it("judges the bucket on the settled posts when the true read is usable, and says so", () => {
    const videos = [
      video("2026-08-03T00:00:00Z", 60_000, 100, "a"),
      video("2026-08-04T00:00:00Z", 55_000, 95, "b"),
      video("2026-08-05T00:00:00Z", 60_000, 100, "c"),
      video("2026-08-27T00:00:00Z", 500, null, "fresh"),
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

describe("collapseTrialUploads", () => {
  const vid = (shortcode: string, views: number, transcript: string | null) => ({
    shortcode,
    url: `https://www.instagram.com/reel/${shortcode}/`,
    posted_at: "2026-08-26T12:00:00Z",
    view_count: views,
    earnings_usd: 0,
    transcript_text: transcript,
  });

  const SCRIPT =
    "four things you should not be doing if you claim to be a christian number one is judging people";

  it("drops the whole trial batch, keeping no representative", () => {
    // This used to keep the highest-view member, justified as "the one that
    // won the trial and got published". Joey confirmed 2026-09-04 that the
    // premise is false: a trial reel never graduates to a normal reel, and
    // never counts toward a paid deliverable. Nothing in a batch is published,
    // so keeping the max kept a trial and counted it as a real post — and the
    // max of ~35 draws is badly upward-biased.
    //
    // Measured against the batcher's own publish_jobs ground truth: 12 of 15
    // batches kept a post that was itself a trial, and a single 104,179-view
    // trial was being carried as @lockedin.lin's best post, overstating their
    // average 3.5x.
    const batch = [
      vid("topDraw", 104179, SCRIPT),
      ...Array.from({ length: 10 }, (_, i) => vid(`trial${i}`, 2000 + i, SCRIPT)),
    ];
    const { kept, suppressed } = collapseTrialUploads(batch);
    expect(kept).toEqual([]);
    expect(suppressed).toBe(11);
  });

  it("does not merge two genuinely different reels", () => {
    const other = "the bible literally tells us how to turn poverty into generational wealth";
    const { kept, suppressed } = collapseTrialUploads([
      vid("a", 5000, SCRIPT),
      vid("b", 4000, other),
    ]);
    expect(kept).toHaveLength(2);
    expect(suppressed).toBe(0);
  });

  it("leaves a hand-posted pair alone", () => {
    // Posting the same reel twice is something creators do deliberately;
    // TRIAL_MIN_BATCH keeps that from reading as a trial run.
    const { kept, suppressed } = collapseTrialUploads([
      vid("a", 5000, SCRIPT),
      vid("b", 400, SCRIPT),
    ]);
    expect(kept).toHaveLength(2);
    expect(suppressed).toBe(0);
  });

  it("never drops a post that has no transcript", () => {
    // A missing transcript is not evidence of duplication — guessing would
    // silently delete real posts.
    const { kept, suppressed } = collapseTrialUploads([
      vid("a", 100, null),
      vid("b", 200, ""),
      vid("c", 300, null),
    ]);
    expect(kept).toHaveLength(3);
    expect(suppressed).toBe(0);
  });

  it("a week of nothing but trials reads as zero posts, not one", () => {
    // The consequence coaches will see. A 21-upload trial week used to read as
    // one 80k post comfortably on quota; it is now what it actually is — no
    // deliverables. The trialUploads count is what explains the zero, which is
    // why it is reported rather than silently dropped.
    const week = { start: new Date("2026-08-24T00:00:00Z"), end: new Date("2026-08-31T00:00:00Z") };
    const read = weeklyRead(
      [
        vid("topDraw", 80000, SCRIPT),
        ...Array.from({ length: 20 }, (_, i) => vid(`t${i}`, 2000, SCRIPT)),
      ],
      week
    );
    expect(read.posts).toBe(0);
    expect(read.trialUploads).toBe(21);
    // Null, not 0: there is no post to average, which is a different fact
    // from "their posts averaged nothing".
    expect(read.avgViews).toBeNull();
    // The 80k draw must not register as a spike — it never reached anyone as
    // a published reel.
    expect(read.spikes).toHaveLength(0);
  });

  it("still counts a real post posted in the same week as a trial batch", () => {
    // Dropping batches must not drop the creator's actual work alongside them.
    const other = "the bible literally tells us how to turn poverty into generational wealth";
    const week = { start: new Date("2026-08-24T00:00:00Z"), end: new Date("2026-08-31T00:00:00Z") };
    const read = weeklyRead(
      [
        vid("real", 12000, other),
        ...Array.from({ length: 12 }, (_, i) => vid(`t${i}`, 2000, SCRIPT)),
      ],
      week
    );
    expect(read.posts).toBe(1);
    expect(read.trialUploads).toBe(12);
    expect(read.avgViews).toBe(12000);
  });
});

describe("transcriptHorizon", () => {
  it("covers every window creatorPerformance collapses, including a flag-length streak", () => {
    const horizon = transcriptHorizon(WEEK);
    expect(horizon.end.getTime()).toBe(WEEK.end.getTime());
    // cpm30 this week, cpm30Prev, and one 30-day window per streak step up
    // to the flag: the deepest one is what the horizon must still reach.
    const deepest = trailingWindow(
      new Date(WEEK.end.getTime() - BAD_STREAK_FLAG * WEEK_MS),
      CPM_WINDOW_DAYS
    );
    expect(horizon.start.getTime()).toBeLessThanOrEqual(deepest.start.getTime());
  });

  it("with transcripts across the horizon, identical trial weeks show no projected change", () => {
    // Two weeks that are the same: one genuine reel that did 30k, plus a
    // 12-copy trial batch at ~2k each. Only the transcripts tell the batch
    // apart from the real post — and only if the loader attached them to BOTH
    // weeks. Different words each week, or the 30-day window folds them
    // into one.
    //
    // The real post is what makes this test able to say anything: a week of
    // nothing but trials now has no deliverables and therefore no projected
    // CPM, so two such weeks would be trivially equal and would pin nothing.
    const trialWeek = (monday: Date, tag: string, words: string): PerformanceVideo[] => [
      { ...video(new Date(monday.getTime()).toISOString(), 30_000, null, `${tag}real`),
        transcript_text: `${words} and here is the part only the real cut has` },
      ...Array.from({ length: 12 }, (_, i) => ({
        ...video(new Date(monday.getTime() + (i + 1) * 3_600_000).toISOString(), 2_000 + i, null, `${tag}${i}`),
        transcript_text: words,
      })),
    ];
    const prev = previousWeek(WEEK);
    const videos = [
      ...trialWeek(WEEK.start, "cur", "morning routine that fixed my focus in seven days flat"),
      ...trialWeek(prev.start, "prev", "three apps i deleted and why my sleep came back overnight"),
    ];
    const p = creatorPerformance({ videos, joinedAt: null, week: WEEK });
    // The batch drops whole; the real reel survives in each week.
    expect(p.weekly.posts).toBe(1);
    expect(p.weekly.trialUploads).toBe(12);
    expect(p.weeklyPrev.posts).toBe(1);
    expect(p.cpm30.posts).toBe(2);
    // Identical weeks, so nothing should read as a change.
    expect(p.projectedDelta?.usd).toBeCloseTo(0, 6);

    // The bug this pins: drop the previous week's transcripts — what a
    // week-only loader did — and the same creator "improves" by a few
    // dollars of CPM while nothing changed.
    const halfBlind = videos.map((v) => (v.shortcode?.startsWith("prev") ? { ...v, transcript_text: null } : v));
    const q = creatorPerformance({ videos: halfBlind, joinedAt: null, week: WEEK });
    expect(q.weeklyPrev.posts).toBe(13);
    expect(q.projectedDelta!.usd).toBeLessThan(-1);
  });
});

describe("team reads", () => {
  it("pools a team's CPM as a ratio of sums, not a mean of member CPMs", () => {
    // A 400k-view star paid $440 ($1.10) and a 1,000-view creator paid $41
    // ($41.00). The mean of the two CPMs is $21; the money says $1.20.
    const star = [video("2026-08-10T10:00:00Z", 400_000, 440, "star")];
    const small = [video("2026-08-11T10:00:00Z", 1_000, 41, "small")];
    const read = teamCpmRead([star, small], WEEK.end);
    expect(read.paidPosts).toBe(2);
    expect(read.cpm).toBeCloseTo((481 * 1000) / 401_000, 6);
  });

  it("collapses trial batches per creator, never across creators sharing a script", () => {
    const words = "the one script both of them were handed this week";
    const at = (i: number) => new Date(WEEK.start.getTime() + i * 3_600_000).toISOString();
    // Creator A ran a trial: three uploads of one reel. Creator B posted the
    // same script once. That is two reels, not one.
    const a = [0, 1, 2].map((i) => ({ ...video(at(i), 2_000 + i, null, `a${i}`), transcript_text: words }));
    const b = [{ ...video(at(5), 9_000, null, "b0"), transcript_text: words }];
    // A's batch drops whole; B's single real post survives.
    expect(teamCpmRead([a, b], WEEK.end).posts).toBe(1);
    // Pooled first, the same words fold B's reel into A's batch — and now that
    // a batch is dropped entirely, B's genuine post disappears with it.
    expect(teamCpmRead([[...a, ...b]], WEEK.end).posts).toBe(0);
  });

  it("sums the week and counts buckets from the members' own reads", () => {
    const at = (i: number) => new Date(WEEK.start.getTime() + i * 3_600_000).toISOString();
    const good = Array.from({ length: 7 }, (_, i) => video(at(i), 50_000, null, `g${i}`));
    const quiet = [video(at(1), 800, null, "q0")];
    const members = [good, quiet].map((videos) => ({
      videos,
      performance: creatorPerformance({ videos, joinedAt: null, week: WEEK }),
    }));
    const team = teamPerformance({ members, week: WEEK });
    expect(team.creators).toBe(2);
    expect(team.posts).toBe(8);
    expect(team.quota).toBe(14);
    expect(team.belowQuota).toBe(1);
    expect(team.spikes).toBe(7);
    expect(team.buckets).toEqual({ good: 1, decent: 0, bad: 1, unread: 0 });
    // Nothing is paid, so the team is read on its projection, on average
    // views — and the star carries it.
    expect(team.cpm30.cpm).toBeNull();
    expect(team.bucketSource).toBe("projected");
    expect(team.bucket).toBe("good");
  });
});

describe("trend: settled month vs the settled month before", () => {
  it("compares the two settled months, so the latest week can still show a move", () => {
    // Newest payout Aug 17; the settled month is Jul 18–Aug 17, the prior one
    // Jun 18–Jul 18. Cheaper this month ($1.10) than last ($5.00).
    const videos = [
      video("2026-08-17T10:00:00Z", 100_000, 110, "n1"),
      video("2026-08-01T10:00:00Z", 100_000, 110, "n2"),
      video("2026-07-25T10:00:00Z", 100_000, 110, "n3"),
      video("2026-07-10T10:00:00Z", 10_000, 50, "o1"),
      video("2026-07-01T10:00:00Z", 10_000, 50, "o2"),
      video("2026-06-25T10:00:00Z", 10_000, 50, "o3"),
    ];
    const p = creatorPerformance({ videos, joinedAt: null, week: WEEK });
    expect(p.cpm30.cpm).toBeCloseTo(1.1, 6);
    expect(p.cpm30.priorCpm).toBeCloseTo(5, 6);
    expect(p.cpm30.priorPaidPosts).toBe(3);
    expect(p.delta?.usd).toBeCloseTo(-3.9, 6);
    // The old week-over-week comparison could not see this: nothing posted
    // in the reporting week is paid yet, so both reads shared one frontier.
    const asOfPrev = cpmRead(videos, previousWeek(WEEK).end);
    expect(asOfPrev.settledWindow?.end.getTime()).toBe(p.cpm30.settledWindow?.end.getTime());
  });

  it("has no true delta until a second settled month exists, and falls back to the weekly projection", () => {
    const at = (d: string) => `${d}T10:00:00Z`;
    const videos = [
      video(at("2026-08-10"), 50_000, 90, "p1"),
      video(at("2026-08-08"), 50_000, 90, "p2"),
      video(at("2026-08-05"), 50_000, 90, "p3"),
      video(at("2026-08-26"), 30_000, null, "w1"),
      video(at("2026-08-19"), 3_000, null, "v1"),
    ];
    const p = creatorPerformance({ videos, joinedAt: null, week: WEEK });
    expect(p.cpm30.cpm).not.toBeNull();
    expect(p.cpm30.priorPaidPosts).toBe(0);
    expect(p.delta).toBeNull();
    // This week's 30k post projects cheaper than last week's 3k one.
    expect(p.projectedDelta!.usd).toBeLessThan(0);
  });
});

describe("median rating", () => {
  it("is not moved by one viral reel the way the mean is", () => {
    // @stayfocusedevan, settled month to 2026-08-07: one 656k reel, one 158k,
    // fourteen at ~1.5–2.8k. Mean 52,928 → good; median 1,911 → decent.
    const at = (d: string) => `${d}T10:00:00Z`;
    const videos = [
      video(at("2026-08-05"), 656_546, 66.81, "viral"),
      video(at("2026-07-25"), 158_049, 151.75, "big"),
      ...[8279, 2818, 2570, 2056, 2022, 1912, 1861, 1658, 1590, 1541, 1534, 1484, 1475, 1458].map((views, i) =>
        video(at(`2026-07-${String(10 + i).padStart(2, "0")}`), views, 41 + views / 1000, `s${i}`)
      ),
    ];
    const p = creatorPerformance({ videos, joinedAt: null, week: WEEK });
    expect(p.bucketSource).toBe("true");
    expect(p.bucket).toBe("good");
    expect(p.medianBucket).toBe("decent");
    // 16 posts: the median is the mean of the 8th and 9th by views.
    expect(p.cpm30.settledMedianViews).toBeCloseTo((1861 + 1912) / 2, 6);
    expect(medianBucket(p.cpm30)).toBe(p.medianBucket);
  });

  it("median of an odd and an even set", () => {
    expect(medianViews([video("2026-08-25T00:00:00Z", 1, null, "a"), video("2026-08-25T00:00:00Z", 100, null, "b"), video("2026-08-25T00:00:00Z", 3, null, "c")])).toBe(3);
    expect(medianViews([video("2026-08-25T00:00:00Z", 1, null, "a"), video("2026-08-25T00:00:00Z", 3, null, "b")])).toBe(2);
    expect(medianViews([])).toBeNull();
  });
});
