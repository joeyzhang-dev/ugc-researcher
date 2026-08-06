import { describe, expect, it } from "vitest";
import { MAX_DAYS, parseDays, windowStart, withinWindow } from "@/components/range-picker";
import type { ResearchVideo } from "@/lib/types";

const vid = (id: string, daysAgo: number | null): ResearchVideo =>
  ({
    id,
    posted_at: daysAgo == null ? null : new Date(Date.now() - daysAgo * 864e5).toISOString(),
  }) as ResearchVideo;

describe("parseDays", () => {
  it("accepts any positive day count, not just the inline presets", () => {
    expect(parseDays("1")).toBe(1);
    expect(parseDays("2")).toBe(2);
    expect(parseDays("45")).toBe(45);
    expect(parseDays("365")).toBe(365);
  });

  it("treats missing or unparseable values as all time", () => {
    for (const bad of [undefined, null, "", "abc", "NaN", "  "]) {
      expect(parseDays(bad)).toBeNull();
    }
  });

  it("rejects zero and negatives rather than inverting the window", () => {
    // These arrive straight from the URL, so a hand-edited ?days=-5 must not
    // produce a cutoff in the future and silently hide everything.
    expect(parseDays("0")).toBeNull();
    expect(parseDays("-5")).toBeNull();
  });

  it("clamps absurd values instead of overflowing the date maths", () => {
    expect(parseDays("999999")).toBe(MAX_DAYS);
  });

  it("rounds fractional input", () => {
    expect(parseDays("7.4")).toBe(7);
    expect(parseDays("7.6")).toBe(8);
  });

  it("takes the first value when the param is repeated", () => {
    expect(parseDays(["14", "30"])).toBe(14);
  });
});

describe("windowStart", () => {
  it("is null for all time", () => {
    expect(windowStart(null)).toBeNull();
  });

  it("moves further back as the window widens", () => {
    const a = windowStart(1)!;
    const b = windowStart(30)!;
    expect(b).toBeLessThan(a);
    expect(a).toBeLessThanOrEqual(Date.now());
  });
});

describe("withinWindow", () => {
  const videos = [vid("today", 0), vid("d2", 2), vid("d10", 10), vid("undated", null)];

  it("keeps everything for all time, including undated", () => {
    expect(withinWindow(videos, null)).toHaveLength(4);
  });

  it("filters to the window and drops undated videos", () => {
    // An undated video cannot be placed in time, so it belongs to no window.
    expect(withinWindow(videos, 3).map((v) => v.id)).toEqual(["today", "d2"]);
    expect(withinWindow(videos, 1).map((v) => v.id)).toEqual(["today"]);
  });

  it("supports a custom window that is not a preset", () => {
    expect(withinWindow(videos, 5).map((v) => v.id)).toEqual(["today", "d2"]);
    expect(withinWindow(videos, 45).map((v) => v.id)).toEqual(["today", "d2", "d10"]);
  });
});
