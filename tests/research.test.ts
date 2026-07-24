import { describe, expect, it } from "vitest";
import {
  computeLifts,
  detectFormatCategory,
  extractHashtags,
  median,
  scoreForLift,
  summarizeCreator,
} from "@/lib/research";
import type { ResearchVideo } from "@/lib/types";

/** Minimal video row: id, posted day offset, views, engagement counts. */
function vid(
  id: string,
  day: number,
  views: number | null,
  extra: Partial<ResearchVideo> = {}
): ResearchVideo {
  return {
    id,
    research_creator_id: "c1",
    url: `https://www.instagram.com/reel/${id}/`,
    shortcode: id,
    external_id: null,
    caption: null,
    hashtags: [],
    posted_at: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(),
    view_count: views,
    like_count: null,
    comment_count: null,
    share_count: null,
    duration_seconds: null,
    thumbnail_url: null,
    video_url: null,
    transcript_status: "pending",
    transcript_text: null,
    transcript_method: null,
    error_message: null,
    format_category: null,
    format_llm_status: null,
    format_llm_reasoning: null,
    format_llm_model: null,
    format_categorized_at: null,
    raw_metadata: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

describe("median", () => {
  it("handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("scoreForLift", () => {
  it("rates baseline performance 5.0 and each doubling +2", () => {
    expect(scoreForLift(1)).toBe(5);
    expect(scoreForLift(2)).toBe(7);
    expect(scoreForLift(4)).toBe(9);
    expect(scoreForLift(0.5)).toBe(3);
    expect(scoreForLift(0.25)).toBe(1);
  });

  it("clamps to 0–10 and rounds to one decimal", () => {
    expect(scoreForLift(104)).toBe(10);
    expect(scoreForLift(0.01)).toBe(0);
    expect(scoreForLift(3)).toBe(8.2); // 5 + 2*log2(3) = 8.1699…
  });

  it("returns null for missing or non-positive lift", () => {
    expect(scoreForLift(null)).toBeNull();
    expect(scoreForLift(0)).toBeNull();
  });
});

describe("detectFormatCategory", () => {
  it("detects the 10/10 format from caption or transcript", () => {
    expect(detectFormatCategory("10/10 male hobbies")).toBe("10/10 list");
    expect(
      detectFormatCategory("Rebuild yourself", "10 out of 10 ways to rebuild yourself from the ground up. Number one…")
    ).toBe("10/10 list");
  });

  it("detects the S-tier format, including WhisperX mishearings", () => {
    expect(detectFormatCategory("S-tier morning habits")).toBe("S-tier list");
    expect(detectFormatCategory("Top tier ways to rebuild yourself")).toBe("S-tier list");
    expect(
      detectFormatCategory("Get offensively hard to kill", "S to your habits to get offensively hard to kill, but it gets progressively more niche.")
    ).toBe("S-tier list");
    expect(
      detectFormatCategory("S-tier ways to rebuild your mind", "Ask your ways to rebuild your mind. If you feel like…")
    ).toBe("S-tier list");
  });

  it("prefers the transcript over a vague caption", () => {
    expect(
      detectFormatCategory(
        "Hold yourself to a high standard",
        "What it actually looks like to hold yourself to a higher standard in four simple steps."
      )
    ).toBe("What it looks like");
  });

  it("detects persona blueprints and numbered lists", () => {
    expect(detectFormatCategory("Live like James Bond")).toBe("Persona blueprint");
    expect(detectFormatCategory("Habits to be more like Bruce Wayne")).toBe("Persona blueprint");
    expect(detectFormatCategory("4 habits to become unrecognizable")).toBe("Numbered list");
  });

  it("returns null rather than guessing", () => {
    expect(detectFormatCategory("Become unstoppable")).toBeNull();
    expect(detectFormatCategory(null)).toBeNull();
  });
});

describe("computeLifts", () => {
  it("uses the trailing-10 median once 3+ prior posts exist", () => {
    // 4 steady posts at 1000 views, then a 5000-view spike.
    const videos = [
      vid("a", 0, 1000),
      vid("b", 1, 1000),
      vid("c", 2, 1000),
      vid("d", 3, 1000),
      vid("e", 4, 5000),
    ];
    const rows = computeLifts(videos);
    const spike = rows.find((r) => r.video.id === "e")!;
    expect(spike.liftBasis).toBe("trailing");
    expect(spike.trailingLift).toBe(5);
    expect(spike.lift).toBe(5);
    expect(spike.score).toBe(9.6); // 5 + 2*log2(5)
  });

  it("falls back to overall lift for the earliest posts", () => {
    const videos = [vid("a", 0, 3000), vid("b", 1, 1000), vid("c", 2, 1000), vid("d", 3, 1000)];
    const rows = computeLifts(videos);
    const first = rows.find((r) => r.video.id === "a")!;
    // Only 0 prior posts → trailing unavailable; overall = 3000 / median(1000,1000,1000).
    expect(first.trailingLift).toBeNull();
    expect(first.liftBasis).toBe("overall");
    expect(first.overallLift).toBe(3);
  });

  it("excludes the video itself from the overall baseline", () => {
    const videos = [vid("a", 0, 100), vid("b", 1, 100), vid("c", 2, 900)];
    const rows = computeLifts(videos);
    const c = rows.find((r) => r.video.id === "c")!;
    // Baseline is median(100, 100), not median(100, 100, 900).
    expect(c.overallLift).toBe(9);
  });

  it("only uses the 10 posts immediately before, not older ones", () => {
    // 5 old posts at 10k views, then 10 recent at 1000, then the subject at 2000.
    const videos = [
      ...Array.from({ length: 5 }, (_, i) => vid(`old${i}`, i, 10_000)),
      ...Array.from({ length: 10 }, (_, i) => vid(`recent${i}`, 10 + i, 1000)),
      vid("subject", 30, 2000),
    ];
    const rows = computeLifts(videos);
    const subject = rows.find((r) => r.video.id === "subject")!;
    // Trailing window = the 10 recent posts only → 2000/1000, not 2000/10000.
    expect(subject.trailingLift).toBe(2);
  });

  it("handles viewless/undated videos and sorts them last", () => {
    const videos = [vid("a", 0, 1000), vid("b", 1, 2000), vid("noviews", 2, null)];
    const rows = computeLifts(videos);
    expect(rows[rows.length - 1].video.id).toBe("noviews");
    expect(rows[rows.length - 1].lift).toBeNull();
    expect(rows[rows.length - 1].score).toBeNull();
  });

  it("computes engagement percent from likes+comments+shares", () => {
    const videos = [
      vid("a", 0, 1000, { like_count: 30, comment_count: 15, share_count: 5 }),
      vid("b", 1, 1000),
    ];
    const rows = computeLifts(videos);
    expect(rows.find((r) => r.video.id === "a")!.engagementPct).toBe(5);
  });
});

describe("summarizeCreator", () => {
  it("aggregates counts, medians and tier distribution", () => {
    const videos = [
      vid("a", 0, 1000),
      vid("b", 1, 1000),
      vid("c", 2, 1000),
      vid("d", 3, 1000),
      vid("e", 4, 5000),
    ];
    const s = summarizeCreator(videos);
    expect(s.videoCount).toBe(5);
    expect(s.withViews).toBe(5);
    expect(s.medianViews).toBe(1000);
    expect(s.totalViews).toBe(9000);
    expect(s.topRated).toBe(1); // the 5000-view spike scores 9.6
    expect(s.medianScore).not.toBeNull();
  });
});

describe("extractHashtags", () => {
  it("parses, lowercases and dedupes hashtags", () => {
    expect(extractHashtags("Big day #Gym #discipline #gym #self_improvement!")).toEqual([
      "gym",
      "discipline",
      "self_improvement",
    ]);
  });

  it("handles unicode and empty captions", () => {
    expect(extractHashtags("#日本語 ok")).toEqual(["日本語"]);
    expect(extractHashtags(null)).toEqual([]);
    expect(extractHashtags("no tags here")).toEqual([]);
  });
});
