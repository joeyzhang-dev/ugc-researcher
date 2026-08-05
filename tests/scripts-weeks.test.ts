import { describe, expect, it } from "vitest";
import { currentWeekKeyUTC, previousWeekKeyUTC, weekKeyUTC, weekLabel } from "@/app/(app)/scripts/cal";

describe("weekKeyUTC", () => {
  it("snaps every day of a week to that week's Monday", () => {
    // 2026-08-03 is a Monday; 2026-08-09 the Sunday that ends the same week.
    for (const d of ["2026-08-03","2026-08-04","2026-08-05","2026-08-06","2026-08-07","2026-08-08","2026-08-09"]) {
      expect(weekKeyUTC(d)).toBe("2026-08-03");
    }
  });
  it("puts Sunday with the week it ends, not the one it precedes", () => {
    expect(weekKeyUTC("2026-08-02")).toBe("2026-07-27");
    expect(weekKeyUTC("2026-08-10")).toBe("2026-08-10");
  });
  it("crosses month and year boundaries", () => {
    expect(weekKeyUTC("2026-01-01")).toBe("2025-12-29");
  });
});

describe("previousWeekKeyUTC", () => {
  it("steps back exactly one week", () => {
    expect(previousWeekKeyUTC("2026-08-03")).toBe("2026-07-27");
    expect(previousWeekKeyUTC("2026-01-05")).toBe("2025-12-29");
  });
});

describe("weekLabel", () => {
  const now = new Date("2026-08-05T12:00:00Z"); // Wednesday of the 08-03 week
  it("names the current and previous weeks", () => {
    expect(weekLabel("2026-08-03", "2026-08-04", now)).toBe("This week");
    expect(weekLabel("2026-07-27", "2026-07-29", now)).toBe("Last week");
  });
  it("labels older weeks by the real send-out day, with no year", () => {
    expect(weekLabel("2026-07-20", "2026-07-23", now)).toBe("Jul 23");
    expect(weekLabel("2026-07-20", "2026-07-23", now)).not.toContain("2026");
  });
  it("is stable regardless of the machine's timezone offset", () => {
    // A late-UTC send-out must not slide into the neighbouring week.
    expect(weekKeyUTC("2026-08-09")).toBe(weekKeyUTC("2026-08-03"));
  });
  it("current week key agrees with weekKeyUTC of today", () => {
    expect(currentWeekKeyUTC(now)).toBe(weekKeyUTC("2026-08-05"));
  });
});
