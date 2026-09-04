import { describe, expect, it } from "vitest";
import { TREND_WEEKS, creatorStats, moneyRead, trendWindows } from "@/lib/creator-stats";
import { QUOTA_POSTS_PER_WEEK, weekKey } from "@/lib/performance";

const ASOF = new Date("2026-08-24T00:00:00Z");

const vid = (
  shortcode: string,
  posted: string,
  views: number,
  earnings = 0,
  transcript: string | null = null
) => ({
  shortcode,
  url: `https://www.instagram.com/reel/${shortcode}/`,
  posted_at: posted,
  view_count: views,
  earnings_usd: earnings,
  transcript_text: transcript,
});

describe("trendWindows", () => {
  it("ends on the week containing asOf and runs oldest first", () => {
    const w = trendWindows(ASOF);
    expect(w).toHaveLength(TREND_WEEKS);
    expect(weekKey(w[w.length - 1])).toBe("2026-08-24");
    expect(weekKey(w[0])).toBe("2026-07-06");
    // Contiguous, no gaps or overlaps.
    for (let i = 1; i < w.length; i++) {
      expect(w[i].start.getTime()).toBe(w[i - 1].end.getTime());
    }
  });
});

describe("creatorStats", () => {
  it("places each post in its own week", () => {
    const s = creatorStats({
      videos: [
        vid("a", "2026-08-25T12:00:00Z", 1000),
        vid("b", "2026-08-26T12:00:00Z", 3000),
        vid("c", "2026-08-18T12:00:00Z", 500),
      ],
      asOf: ASOF,
    });
    expect(s.current.posts).toBe(2);
    expect(s.current.avgViews).toBe(2000);
    const prior = s.trend[s.trend.length - 2];
    expect(prior.read.posts).toBe(1);
  });

  it("drops trial batches whole, in the trend as well as the week", () => {
    // The same rule the weekly recap applies — a creator must not read 21
    // posts here and 0 in the digest.
    const script = "four things you should not be doing if you claim to be a christian today";
    const s = creatorStats({
      videos: [
        vid("topDraw", "2026-08-25T12:00:00Z", 80000, 0, script),
        ...Array.from({ length: 20 }, (_, i) =>
          vid(`t${i}`, "2026-08-25T13:00:00Z", 2000, 0, script)
        ),
      ],
      asOf: ASOF,
    });
    expect(s.current.posts).toBe(0);
    expect(s.totals.posts).toBe(0);
    expect(s.totals.trialUploads).toBe(21);
    // The 80k draw is the batch's best draw, not a published reel, so it must
    // not be celebrated as a top post — this is the bestPost bug.
    expect(s.topPosts).toHaveLength(0);
  });

  it("ranks top posts across the whole window, not per week", () => {
    const s = creatorStats({
      videos: [
        vid("small", "2026-08-25T12:00:00Z", 100),
        vid("huge", "2026-07-07T12:00:00Z", 900000),
        vid("mid", "2026-08-04T12:00:00Z", 5000),
      ],
      asOf: ASOF,
    });
    expect(s.topPosts.map((t) => t.post.shortcode)).toEqual(["huge", "mid", "small"]);
  });

  it("sums totals over the trend window only", () => {
    const s = creatorStats({
      videos: [
        vid("inside", "2026-08-25T12:00:00Z", 1000),
        // Well before the 8-week window opens on 2026-07-06.
        vid("ancient", "2026-01-01T12:00:00Z", 999999),
      ],
      asOf: ASOF,
    });
    expect(s.totals.posts).toBe(1);
    expect(s.totals.views).toBe(1000);
  });

  it("keeps the quota meaning what it means everywhere else", () => {
    expect(creatorStats({ videos: [], asOf: ASOF }).current.quota).toBe(QUOTA_POSTS_PER_WEEK);
  });
});

describe("moneyRead", () => {
  it("counts lifetime earnings, not just the trend window", () => {
    const m = moneyRead(
      [
        vid("old", "2026-02-01T12:00:00Z", 50000, 90),
        vid("new", "2026-08-10T12:00:00Z", 20000, 60),
      ],
      ASOF
    );
    expect(m.earnedUsd).toBe(150);
    expect(m.paidPosts).toBe(2);
  });

  it("treats a viewed but unpaid post as pipeline, not shortfall", () => {
    // Payouts settle on day-14 views and land ~3 weeks later, so recent posts
    // being unpaid is the normal state, not a problem to flag.
    const m = moneyRead(
      [vid("paid", "2026-06-01T12:00:00Z", 10000, 50), vid("fresh", "2026-08-23T12:00:00Z", 8000, 0)],
      ASOF
    );
    expect(m.paidPosts).toBe(1);
    expect(m.unpaidPosts).toBe(1);
  });

  it("does not count a zero-view post as awaiting payout", () => {
    const m = moneyRead([vid("dud", "2026-08-20T12:00:00Z", 0, 0)], ASOF);
    expect(m.unpaidPosts).toBe(0);
  });

  it("reports no CPM rather than $0 when nothing has been paid", () => {
    const m = moneyRead([vid("a", "2026-08-20T12:00:00Z", 5000, 0)], ASOF);
    expect(m.cpm30.cpm).toBeNull();
    expect(m.earnedUsd).toBe(0);
  });
});

describe("trial uploads never reach a posts or views figure", () => {
  const SCRIPT = "four things you should not be doing if you claim to be a christian number one";

  it("keeps trial uploads out of the projected CPM and its averages", () => {
    // Each trial upload over 1k views would otherwise be handed its own $40
    // flat-fee projection, and drag avg views toward the trial noise floor.
    const batch = [
      vid("topDraw", "2026-08-10T12:00:00Z", 80000, 0, SCRIPT),
      ...Array.from({ length: 12 }, (_, i) => vid(`t${i}`, "2026-08-10T13:00:00Z", 2000, 0, SCRIPT)),
    ];
    const m = moneyRead(batch, ASOF);
    expect(m.cpm30.posts).toBe(0);
    expect(m.cpm30.avgViews).toBeNull();
  });

  it("does not count trial uploads as awaiting payout", () => {
    // Shipped as 166 for a creator with 57 paid posts — nearly all trials.
    const batch = [
      vid("topDraw", "2026-08-10T12:00:00Z", 80000, 0, SCRIPT),
      ...Array.from({ length: 20 }, (_, i) => vid(`t${i}`, "2026-08-10T13:00:00Z", 2000, 0, SCRIPT)),
    ];
    // Trials never count as deliverables, so none of them is awaiting payout.
    expect(moneyRead(batch, ASOF).unpaidPosts).toBe(0);
  });

  it("still counts money a creator actually received on a trial upload", () => {
    // Deliberate exception: trueCpm is dollars paid over the views those
    // dollars were paid for. Dropping a PAID trial would delete real earnings.
    const m = moneyRead(
      [
        vid("win", "2026-07-20T12:00:00Z", 80000, 100, SCRIPT),
        vid("t0", "2026-07-20T13:00:00Z", 2000, 42.93, SCRIPT),
      ],
      ASOF
    );
    expect(m.earnedUsd).toBeCloseTo(142.93, 2);
    expect(m.paidPosts).toBe(2);
  });
});

describe("onboardingRead", () => {
  it("counts a first-week trial batch as no posts", async () => {
    const { onboardingRead } = await import("@/lib/performance");
    const SCRIPT = "welcome to my page here is what i do every single morning without fail";
    const joined = new Date("2026-08-03T00:00:00Z");
    const videos = [
      vid("topDraw", "2026-08-04T12:00:00Z", 40000, 0, SCRIPT),
      ...Array.from({ length: 15 }, (_, i) => vid(`t${i}`, "2026-08-04T13:00:00Z", 1500, 0, SCRIPT)),
    ];
    const o = onboardingRead(videos, joined, ASOF);
    // A first week of nothing but trials is a first week with no reel shipped.
    expect(o.posts).toBe(0);
    expect(o.avgViews).toBeNull();
  });
});
