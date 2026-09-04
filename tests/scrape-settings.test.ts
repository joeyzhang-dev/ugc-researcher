import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRAPE_SETTINGS,
  clampInt,
  describeSchedule,
  enabledKinds,
  isRunDue,
  nextRunAt,
  parseTimeOfDay,
  type ScrapeSettings,
  scrapeDepth,
  FIRST_SCRAPE_LIMIT,
} from "@/lib/scrape-settings";

const at = (iso: string) => new Date(iso);

function settings(overrides: Partial<ScrapeSettings> = {}): ScrapeSettings {
  return { ...DEFAULT_SCRAPE_SETTINGS, auto_scrape_enabled: true, ...overrides };
}

describe("parseTimeOfDay", () => {
  it("parses valid times", () => {
    expect(parseTimeOfDay("00:00")).toBe(0);
    expect(parseTimeOfDay("03:30")).toBe(210);
    expect(parseTimeOfDay("23:59")).toBe(1439);
  });

  it("rejects malformed or out-of-range times", () => {
    for (const bad of ["24:00", "3:00", "12:60", "", "abc", "12-30"]) {
      expect(parseTimeOfDay(bad)).toBeNull();
    }
  });
});

describe("nextRunAt — interval mode", () => {
  it("is null while automation is disabled", () => {
    expect(nextRunAt(settings({ auto_scrape_enabled: false }))).toBeNull();
  });

  it("is due immediately when nothing has run yet", () => {
    const now = at("2026-07-30T10:00:00Z");
    expect(nextRunAt(settings({ last_run_at: null }), now)).toEqual(now);
    expect(isRunDue(settings({ last_run_at: null }), now)).toBe(true);
  });

  it("counts forward from the last run", () => {
    const s = settings({ interval_hours: 12, last_run_at: "2026-07-30T00:00:00Z" });
    expect(nextRunAt(s, at("2026-07-30T06:00:00Z"))).toEqual(at("2026-07-30T12:00:00Z"));
    expect(isRunDue(s, at("2026-07-30T06:00:00Z"))).toBe(false);
    expect(isRunDue(s, at("2026-07-30T12:00:00Z"))).toBe(true);
    expect(isRunDue(s, at("2026-07-31T09:00:00Z"))).toBe(true);
  });

  it("ignores an unparseable last_run_at rather than never firing", () => {
    const now = at("2026-07-30T10:00:00Z");
    expect(isRunDue(settings({ last_run_at: "not-a-date" }), now)).toBe(true);
  });
});

describe("nextRunAt — time of day mode", () => {
  const base = { schedule_mode: "time_of_day" as const, time_of_day: "03:00" };

  it("returns today's slot when it is still ahead", () => {
    // Local-time construction: the slot is compared in the machine's zone.
    const now = new Date(2026, 6, 30, 1, 0, 0);
    const next = nextRunAt(settings({ ...base, last_run_at: null }), now)!;
    expect(next.getHours()).toBe(3);
    expect(next.getDate()).toBe(30);
    expect(isRunDue(settings({ ...base }), now)).toBe(false);
  });

  it("keeps a missed slot due instead of skipping it", () => {
    // Machine asleep through 03:00; at 09:00 the run should still fire.
    const now = new Date(2026, 6, 30, 9, 0, 0);
    const s = settings({ ...base, last_run_at: new Date(2026, 6, 29, 3, 0, 0).toISOString() });
    expect(isRunDue(s, now)).toBe(true);
  });

  it("rolls to tomorrow once today's slot has run", () => {
    const now = new Date(2026, 6, 30, 9, 0, 0);
    const s = settings({ ...base, last_run_at: new Date(2026, 6, 30, 3, 5, 0).toISOString() });
    const next = nextRunAt(s, now)!;
    expect(next.getDate()).toBe(31);
    expect(next.getHours()).toBe(3);
    expect(isRunDue(s, now)).toBe(false);
  });

  it("is null when the stored time is malformed", () => {
    expect(nextRunAt(settings({ ...base, time_of_day: "nope" }))).toBeNull();
  });
});

describe("describeSchedule", () => {
  it("describes both modes", () => {
    expect(describeSchedule(settings({ interval_hours: 1 }))).toBe("every 1 hour");
    expect(describeSchedule(settings({ interval_hours: 12 }))).toBe("every 12 hours");
    expect(describeSchedule(settings({ interval_hours: 24 }))).toBe("every 24 hours (daily)");
    expect(
      describeSchedule(settings({ schedule_mode: "time_of_day", time_of_day: "03:00" }))
    ).toBe("daily at 03:00");
  });
});

describe("enabledKinds", () => {
  it("reflects the pool toggles", () => {
    expect(enabledKinds(settings())).toEqual(["research", "roster"]);
    expect(enabledKinds(settings({ scrape_roster: false }))).toEqual(["research"]);
    expect(enabledKinds(settings({ scrape_research: false }))).toEqual(["roster"]);
    expect(enabledKinds(settings({ scrape_research: false, scrape_roster: false }))).toEqual([]);
  });
});

describe("clampInt", () => {
  it("clamps into range and falls back on junk", () => {
    expect(clampInt("50", 1, 200, 35)).toBe(50);
    expect(clampInt("500", 1, 200, 35)).toBe(200);
    expect(clampInt("0", 1, 200, 35)).toBe(1);
    expect(clampInt("abc", 1, 200, 35)).toBe(35);
    expect(clampInt(null, 1, 200, 35)).toBe(35);
    expect(clampInt("", 1, 200, 35)).toBe(35);
    expect(clampInt("   ", 1, 200, 35)).toBe(35);
    expect(clampInt("12.6", 1, 200, 35)).toBe(13);
  });
});

describe("scrapeDepth", () => {
  it("pulls a deep history the first time it ever sees a creator", () => {
    // A profile fetch returns newest-first, so a shallow FIRST scrape is a
    // permanent hole: posts older than the slice can never be recovered by
    // scraping more often, only by scraping deeper. Measured 2026-09-04,
    // 19 of 45 research creators held 3 posts covering under a week —
    // @dylonpboone's three reached back 2.8 days.
    expect(scrapeDepth({ lastScrapedAt: null, configuredLimit: 3 })).toBe(FIRST_SCRAPE_LIMIT);
  });

  it("pulls only the configured slice on every later scrape", () => {
    // A re-scrape only has to catch what is new since last time, and depth is
    // billed per request — that is what the setting is for.
    expect(scrapeDepth({ lastScrapedAt: "2026-09-01T00:00:00Z", configuredLimit: 3 })).toBe(3);
  });

  it("never goes shallower than the configured limit on a first scrape", () => {
    // If someone deliberately sets a deeper limit than the first-scrape
    // default, honour it rather than quietly capping them.
    expect(scrapeDepth({ lastScrapedAt: null, configuredLimit: 120 })).toBe(120);
  });
});
