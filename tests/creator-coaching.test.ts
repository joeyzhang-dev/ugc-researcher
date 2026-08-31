import { describe, expect, it } from "vitest";
import { cpmNote, diagnose, type CoachingCase } from "@/lib/creator-coaching";
import { cpmBand } from "@/lib/card-chrome";
import { creatorStats } from "@/lib/creator-stats";
import { QUOTA_POSTS_PER_WEEK } from "@/lib/performance";

const ASOF = new Date("2026-08-24T00:00:00Z");
const THIS_WEEK = "2026-08-25T12:00:00Z";
const LAST_WEEK = "2026-08-18T12:00:00Z";
const OLDER = "2026-08-11T12:00:00Z";

const vid = (id: string, posted: string, views: number) => ({
  shortcode: id,
  url: `https://www.instagram.com/reel/${id}/`,
  posted_at: posted,
  view_count: views,
  earnings_usd: 0,
});

/** n posts in a given week, each at `views`. */
const week = (prefix: string, posted: string, n: number, views: number) =>
  Array.from({ length: n }, (_, i) => vid(`${prefix}${i}`, posted, views));

const caseOf = (videos: ReturnType<typeof vid>[], weeksSinceJoined: number | null = null): CoachingCase =>
  diagnose(creatorStats({ videos, asOf: ASOF }), weeksSinceJoined).case;

describe("diagnose", () => {
  it("calls out a silent week above everything else", () => {
    expect(caseOf(week("p", LAST_WEEK, 9, 5000))).toBe("silent");
  });

  it("celebrates a return after silence", () => {
    // Posts two weeks ago, nothing last week, posting again now.
    expect(caseOf([...week("o", OLDER, 8, 5000), ...week("n", THIS_WEEK, 3, 5000)])).toBe("returning");
  });

  it("holds judgement on a brand-new creator", () => {
    // No history at all — and crucially this must not read as "welcome back".
    expect(caseOf(week("n", THIS_WEEK, 2, 300), 1)).toBe("first-weeks");
  });

  it("never greets a brand-new creator as a returner", () => {
    // Their previous week is empty because they had not joined yet.
    const d = diagnose(creatorStats({ videos: week("n", THIS_WEEK, 3, 900), asOf: ASOF }), 1);
    expect(d.case).not.toBe("returning");
    expect(d.creator.toLowerCase()).not.toContain("back");
  });

  it("leads with a spike when one landed", () => {
    const history = [...week("a", OLDER, 5, 900), ...week("b", LAST_WEEK, 5, 900)];
    expect(caseOf([...history, ...week("p", THIS_WEEK, 6, 900), vid("hit", THIS_WEEK, 90000)])).toBe("spike");
  });

  it("prefers the spike over the return when both are true", () => {
    // A spike is the more actionable fact, and the more motivating one.
    const history = week("a", OLDER, 5, 900);
    expect(caseOf([...history, ...week("p", THIS_WEEK, 4, 900), vid("hit", THIS_WEEK, 90000)])).toBe("spike");
  });

  it("names a breakout against the creator's own baseline", () => {
    // Baseline ~2k for weeks past, then a quota week at 10k with no spike.
    const past = [...week("a", OLDER, 8, 2000), ...week("b", LAST_WEEK, 8, 2000)];
    expect(caseOf([...past, ...week("c", THIS_WEEK, 8, 10000)])).toBe("breaking-out");
  });

  it("separates effort from results when volume is there but views are not", () => {
    const flat = [...week("a", OLDER, 8, 1200), ...week("b", LAST_WEEK, 8, 1200)];
    const c = caseOf([...flat, ...week("c", THIS_WEEK, 8, 1200)]);
    expect(c).toBe("grinding");
  });

  it("catches a drop from a quota week to a short one", () => {
    expect(caseOf([...week("a", LAST_WEEK, 9, 3000), ...week("b", THIS_WEEK, 2, 3000)])).toBe("slipping");
  });

  it("falls back to the volume gap when nothing else is the story", () => {
    const c = caseOf([...week("a", OLDER, 3, 3000), ...week("b", LAST_WEEK, 3, 3000), ...week("c", THIS_WEEK, 3, 3000)]);
    expect(c).toBe("below-quota");
  });

  it("gives both voices for every case, and never an empty one", () => {
    const samples: ReturnType<typeof vid>[][] = [
      week("p", LAST_WEEK, 9, 5000),
      [...week("o", OLDER, 8, 5000), ...week("n", THIS_WEEK, 3, 5000)],
      [...week("p", THIS_WEEK, 6, 900), vid("hit", THIS_WEEK, 90000)],
      week("c", THIS_WEEK, 8, 60000),
      [...week("a", LAST_WEEK, 9, 3000), ...week("b", THIS_WEEK, 2, 3000)],
      week("x", THIS_WEEK, 3, 3000),
    ];
    for (const videos of samples) {
      const d = diagnose(creatorStats({ videos, asOf: ASOF }));
      expect(d.coach.length).toBeGreaterThan(10);
      expect(d.creator.length).toBeGreaterThan(10);
      // The creator voice must never contain the coach's disposal language.
      expect(d.creator.toLowerCase()).not.toContain("offboard");
      expect(d.creator.toLowerCase()).not.toContain("cut");
    }
  });

  it("tells the creator exactly how many posts they are short", () => {
    const history = [...week("a", OLDER, 3, 3000), ...week("b", LAST_WEEK, 3, 3000)];
    const d = diagnose(creatorStats({ videos: [...history, ...week("x", THIS_WEEK, 4, 3000)], asOf: ASOF }));
    expect(d.creator).toContain(`${QUOTA_POSTS_PER_WEEK - 4} post`);
  });
});

describe("cpmBand", () => {
  it("treats lower as better, which is the opposite of every other number", () => {
    expect(cpmBand(1.32)).toBe("great");
    expect(cpmBand(2.99)).toBe("great");
    expect(cpmBand(3)).toBe("ok");
    expect(cpmBand(24.99)).toBe("ok");
    expect(cpmBand(25)).toBe("poor");
    expect(cpmBand(null)).toBeNull();
  });
});

describe("cpmNote", () => {
  it("says the number is where it should be when it is", () => {
    expect(cpmNote(1.32, null)).toContain("well under");
  });

  it("points at views as the lever when CPM is poor", () => {
    expect(cpmNote(31, null)).toContain("Views are what pulls that number down");
  });

  it("explains the payout lag rather than showing a bare blank", () => {
    const note = cpmNote(null, 4.2);
    expect(note).toContain("~3 weeks");
  });

  it("says nothing when there is nothing true to say", () => {
    expect(cpmNote(null, null)).toBeNull();
  });
});
