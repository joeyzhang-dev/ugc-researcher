import { describe, expect, it } from "vitest";
import { bestStreak, dailyRecap, paceRead, reportedDay, streak } from "@/lib/daily-recap";
import { QUOTA_POSTS_PER_WEEK } from "@/lib/performance";

// Wednesday of the week starting Mon 2026-08-24.
const WED = new Date("2026-08-26T09:00:00Z");

const post = (shortcode: string, posted: string, transcript: string | null = null) => ({
  shortcode,
  url: `https://www.instagram.com/reel/${shortcode}/`,
  posted_at: posted,
  view_count: 0,
  earnings_usd: 0,
  transcript_text: transcript,
});

describe("reportedDay", () => {
  it("reports yesterday, because today is still moving", () => {
    // A same-day recap would read as a collapse every morning: the day is half
    // over and Launchpoint's snapshot lags behind it.
    expect(reportedDay(WED).toISOString().slice(0, 10)).toBe("2026-08-25");
  });

  it("crosses a month boundary correctly", () => {
    expect(reportedDay(new Date("2026-09-01T02:00:00Z")).toISOString().slice(0, 10)).toBe("2026-08-31");
  });
});

describe("paceRead", () => {
  it("counts the week still in progress, not the one that closed", () => {
    const p = paceRead([post("a", "2026-08-24T10:00:00Z").posted_at, post("b", "2026-08-25T10:00:00Z").posted_at], WED);
    expect(p.postsThisWeek).toBe(2);
    expect(p.week.start.toISOString().slice(0, 10)).toBe("2026-08-24");
  });

  it("counts today as a day they can still post", () => {
    // Wednesday: Wed, Thu, Fri, Sat, Sun = 5.
    expect(paceRead([], WED).daysLeft).toBe(5);
  });

  it("says how many a day it takes to still finish on target", () => {
    const p = paceRead(["2026-08-24T10:00:00Z"], WED); // 1 done, 6 to go, 5 days
    expect(p.perDayNeeded).toBe(2);
    expect(p.onTrack).toBe(false);
  });

  it("is on track once the quota is already met", () => {
    const many = Array.from({ length: QUOTA_POSTS_PER_WEEK }, (_, i) => `2026-08-24T0${i}:00:00Z`);
    const p = paceRead(many, WED);
    expect(p.onTrack).toBe(true);
    expect(p.perDayNeeded).toBe(0);
  });

  it("ignores posts from other weeks", () => {
    expect(paceRead(["2026-08-17T10:00:00Z", "2026-09-02T10:00:00Z"], WED).postsThisWeek).toBe(0);
  });
});

describe("streak", () => {
  it("counts consecutive days ending on the reported day", () => {
    const dates = ["2026-08-23T10:00:00Z", "2026-08-24T10:00:00Z", "2026-08-25T10:00:00Z"];
    expect(streak(dates, new Date("2026-08-25T00:00:00Z"))).toBe(3);
  });

  it("reads zero once the streak has broken, rather than finding an older one", () => {
    // A streak has to mean "right now" or it is trivia.
    const dates = ["2026-08-10T10:00:00Z", "2026-08-11T10:00:00Z", "2026-08-12T10:00:00Z"];
    expect(streak(dates, new Date("2026-08-25T00:00:00Z"))).toBe(0);
  });

  it("counts a day once however many times they posted", () => {
    const dates = ["2026-08-25T01:00:00Z", "2026-08-25T09:00:00Z", "2026-08-25T20:00:00Z"];
    expect(streak(dates, new Date("2026-08-25T00:00:00Z"))).toBe(1);
  });

  it("finds the best run anywhere in the history", () => {
    const dates = [
      "2026-08-01T10:00:00Z", "2026-08-02T10:00:00Z", "2026-08-03T10:00:00Z", "2026-08-04T10:00:00Z",
      "2026-08-20T10:00:00Z",
    ];
    expect(bestStreak(dates)).toBe(4);
  });
});

describe("dailyRecap trial collapse", () => {
  it("counts a trial batch as one post, matching the weekly card", () => {
    // Seen live: a raw daily said "10 posted yesterday" for a creator whose
    // whole WEEK collapses to 16. The two commands must not disagree.
    const script = "four things you should not be doing if you claim to be a christian today";
    const batch = Array.from({ length: 10 }, (_, i) => post(`t${i}`, "2026-08-25T10:00:00Z".replace("10", "10"), script));
    const r = dailyRecap({ posts: batch, metrics: [], today: WED });
    expect(r.pace.postsThisWeek).toBe(1);
    expect(r.trialUploads).toBe(9);
  });

  it("leaves genuinely different posts alone", () => {
    const r = dailyRecap({
      posts: [
        post("a", "2026-08-25T10:00:00Z", "the bible tells us how to turn poverty into wealth"),
        post("b", "2026-08-25T12:00:00Z", "three things to let go of if you want peace this year"),
      ],
      metrics: [],
      today: WED,
    });
    expect(r.pace.postsThisWeek).toBe(2);
    expect(r.trialUploads).toBe(0);
  });

  it("collapses per day, not across days", () => {
    // The same reel genuinely re-posted a week later is two posts.
    const script = "four things you should not be doing if you claim to be a christian today";
    const r = dailyRecap({
      posts: [post("a", "2026-08-24T10:00:00Z", script), post("b", "2026-08-25T10:00:00Z", script)],
      metrics: [],
      today: WED,
    });
    expect(r.pace.postsThisWeek).toBe(2);
  });
});

describe("dailyRecap", () => {
  const posts = [
    post("old", "2026-08-20T10:00:00Z"),
    post("fresh", "2026-08-25T10:00:00Z"),
  ];

  it("sums the day's movement and ranks the movers", () => {
    const r = dailyRecap({
      posts,
      metrics: [
        { shortcode: "old", views: 50000, viewsDelta: 12000 },
        { shortcode: "fresh", views: 3000, viewsDelta: 3000 },
      ],
      today: WED,
    });
    expect(r.viewsAdded).toBe(15000);
    expect(r.movers.map((m) => m.shortcode)).toEqual(["old", "fresh"]);
  });

  it("shows an older post still climbing — the thing a weekly card cannot", () => {
    const r = dailyRecap({
      posts,
      metrics: [{ shortcode: "old", views: 50000, viewsDelta: 12000 }],
      today: WED,
    });
    expect(r.movers[0].shortcode).toBe("old");
    expect(r.postedThatDay).toHaveLength(0);
  });

  it("separates what they published that day from what merely moved", () => {
    const r = dailyRecap({
      posts,
      metrics: [
        { shortcode: "old", views: 50000, viewsDelta: 100 },
        { shortcode: "fresh", views: 3000, viewsDelta: 3000 },
      ],
      today: WED,
    });
    expect(r.postedThatDay.map((m) => m.shortcode)).toEqual(["fresh"]);
  });

  it("ignores posts that did not move", () => {
    const r = dailyRecap({
      posts,
      metrics: [{ shortcode: "old", views: 50000, viewsDelta: 0 }],
      today: WED,
    });
    expect(r.movers).toHaveLength(0);
    expect(r.viewsAdded).toBe(0);
  });

  it("survives a metrics row for a post we do not hold", () => {
    const r = dailyRecap({
      posts: [],
      metrics: [{ shortcode: "ghost", views: 10, viewsDelta: 10 }],
      today: WED,
    });
    expect(r.movers[0].url).toContain("ghost");
  });
});

describe("the week strip", () => {
  it("describes the CURRENT week, not the day being reported", () => {
    // The bug this pins: the strip was derived from yesterday's movers, so on
    // a Monday it described last week and marked today as missed while a post
    // was sitting in it.
    const monday = new Date("2026-08-31T09:00:00Z");
    const r = dailyRecap({
      posts: [post("today", "2026-08-31T08:00:00Z"), post("lastweek", "2026-08-25T08:00:00Z")],
      metrics: [],
      today: monday,
    });
    expect(r.weekPostDays[0]).toBe(true); // Monday, posted
    expect(r.weekPostDays.slice(1).some(Boolean)).toBe(false);
    expect(r.todayIndex).toBe(0);
    expect(r.pace.postsThisWeek).toBe(1);
  });

  it("indexes the week Monday-first", () => {
    const sunday = new Date("2026-08-30T09:00:00Z");
    const r = dailyRecap({ posts: [post("s", "2026-08-30T08:00:00Z")], metrics: [], today: sunday });
    expect(r.todayIndex).toBe(6);
    expect(r.weekPostDays[6]).toBe(true);
  });
});
