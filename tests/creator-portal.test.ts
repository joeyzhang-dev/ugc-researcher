import { describe, expect, it } from "vitest";
import { groupScriptsByWeek, portalUrl, type PortalScript } from "@/app/c/portal";

const script = (id: string, createdAt: string, over: Partial<PortalScript> = {}): PortalScript => ({
  id,
  hook: `hook ${id}`,
  body: `body ${id}`,
  inspoUrl: null,
  demo: null,
  songs: null,
  niche: "Christian",
  createdAt,
  ...over,
});

// Fixed "now" so week labels are deterministic: Tue Aug 18 2026 (week of Aug 17).
const NOW = new Date("2026-08-18T12:00:00Z");

describe("groupScriptsByWeek", () => {
  it("groups by UTC week, newest week first", () => {
    const weeks = groupScriptsByWeek(
      [
        script("old", "2026-08-04T09:00:00Z"),
        script("new", "2026-08-18T02:00:00Z"),
      ],
      NOW
    );
    expect(weeks.map((w) => w.key)).toEqual(["2026-08-17", "2026-08-03"]);
  });

  it("keeps doc order inside a week: oldest first, Script 1 leads", () => {
    const weeks = groupScriptsByWeek(
      [
        script("second", "2026-08-18T02:00:10Z"),
        script("first", "2026-08-18T02:00:00Z"),
      ],
      NOW
    );
    expect(weeks[0].scripts.map((s) => s.id)).toEqual(["first", "second"]);
  });

  it("labels the current and previous weeks in words, older ones by date", () => {
    const weeks = groupScriptsByWeek(
      [
        script("a", "2026-08-18T02:00:00Z"),
        script("b", "2026-08-11T02:00:00Z"),
        script("c", "2026-07-28T02:00:00Z"),
      ],
      NOW
    );
    expect(weeks.map((w) => w.label)).toEqual(["This week", "Last week", "Jul 28"]);
  });

  it("labels an old week by its latest send day, not its Monday", () => {
    const weeks = groupScriptsByWeek(
      [script("a", "2026-07-29T02:00:00Z"), script("b", "2026-07-31T02:00:00Z")],
      NOW
    );
    // Week starts Mon Jul 27, but the latest script in it landed Jul 31.
    expect(weeks[0].label).toBe("Jul 31");
  });

  it("returns nothing for no scripts", () => {
    expect(groupScriptsByWeek([], NOW)).toEqual([]);
  });
});

describe("portalUrl", () => {
  it("builds the creator's /c/ link on the app's public origin", () => {
    expect(portalUrl("abc123")).toMatch(/^https:\/\/.+\/c\/abc123$/);
  });
});
