import { describe, expect, it } from "vitest";
import {
  DORMANT_AFTER_DAYS,
  QUIET_AFTER_DAYS,
  isArchived,
  quietBand,
  quietDays,
  splitArchived,
} from "@/lib/roster-archive";

const NOW = new Date("2026-08-30T12:00:00Z");
/** ISO timestamp for `n` days before NOW. */
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe("quietDays", () => {
  it("counts whole days since the last post", () => {
    expect(quietDays(daysAgo(42), NOW)).toBe(42);
    expect(quietDays(daysAgo(0), NOW)).toBe(0);
  });

  it("is null when there is no last-post date", () => {
    expect(quietDays(null, NOW)).toBeNull();
    expect(quietDays(undefined, NOW)).toBeNull();
  });

  it("is null for an unparseable date rather than NaN", () => {
    expect(quietDays("not a date", NOW)).toBeNull();
  });

  // Launchpoint's lastPostDate can sit a few hours ahead of our clock — live
  // data had two accounts reading -1 days. A negative "days quiet" is
  // meaningless; floor it at 0 so the chip says "posted today".
  it("clamps a future last-post date to 0", () => {
    expect(quietDays(new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toISOString(), NOW)).toBe(0);
  });
});

describe("quietBand", () => {
  it("is unknown without a date", () => {
    expect(quietBand(null)).toBe("unknown");
  });

  it("is fresh below the quiet threshold", () => {
    expect(quietBand(0)).toBe("fresh");
    expect(quietBand(QUIET_AFTER_DAYS - 1)).toBe("fresh");
  });

  it("is quiet from the threshold up to dormant", () => {
    expect(quietBand(QUIET_AFTER_DAYS)).toBe("quiet");
    expect(quietBand(DORMANT_AFTER_DAYS - 1)).toBe("quiet");
  });

  it("is dormant at and beyond the dormant threshold", () => {
    expect(quietBand(DORMANT_AFTER_DAYS)).toBe("dormant");
    expect(quietBand(365)).toBe("dormant");
  });
});

describe("isArchived", () => {
  it("reads the timestamp, not the scrape status", () => {
    expect(isArchived({ archived_at: null })).toBe(false);
    expect(isArchived({ archived_at: daysAgo(1) })).toBe(true);
  });

  // A row selected before the migration landed simply has no key.
  it("treats a missing column as not archived", () => {
    expect(isArchived({} as { archived_at: string | null })).toBe(false);
  });
});

describe("splitArchived", () => {
  const rows = [
    { c: { archived_at: null }, id: "a" },
    { c: { archived_at: daysAgo(2) }, id: "b" },
    { c: { archived_at: null }, id: "c" },
  ];

  it("hides archived rows by default and reports how many were hidden", () => {
    const { visible, archivedCount } = splitArchived(rows, false, (r) => r.c);
    expect(visible.map((r) => r.id)).toEqual(["a", "c"]);
    expect(archivedCount).toBe(1);
  });

  it("keeps every row when showing archived, still reporting the count", () => {
    const { visible, archivedCount } = splitArchived(rows, true, (r) => r.c);
    expect(visible.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(archivedCount).toBe(1);
  });

  it("counts nothing when no row is archived", () => {
    const { visible, archivedCount } = splitArchived(
      [{ c: { archived_at: null }, id: "a" }],
      false,
      (r) => r.c
    );
    expect(visible).toHaveLength(1);
    expect(archivedCount).toBe(0);
  });
});
