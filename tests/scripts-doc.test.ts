import { describe, expect, it } from "vitest";
import { assignScriptNumbers, buildDocGrid, titleFromHook } from "@/app/(app)/scripts/doc";

describe("assignScriptNumbers", () => {
  it("numbers within a week + niche, oldest first — the Doc column numbers", () => {
    const numbers = assignScriptNumbers([
      { id: "b", niche: "Christian", createdAt: "2026-08-18T02:00:10Z" },
      { id: "a", niche: "Christian", createdAt: "2026-08-18T02:00:00Z" },
      { id: "c", niche: "Christian", createdAt: "2026-08-18T02:00:20Z" },
    ]);
    expect(numbers.get("a")).toBe(1);
    expect(numbers.get("b")).toBe(2);
    expect(numbers.get("c")).toBe(3);
  });

  it("restarts per niche and per week", () => {
    const numbers = assignScriptNumbers([
      { id: "chr1", niche: "Christian", createdAt: "2026-08-18T02:00:00Z" },
      { id: "gm1", niche: "General Motivation / Hustle", createdAt: "2026-08-18T03:00:00Z" },
      { id: "lastweek", niche: "Christian", createdAt: "2026-08-11T02:00:00Z" },
    ]);
    expect(numbers.get("chr1")).toBe(1);
    expect(numbers.get("gm1")).toBe(1);
    expect(numbers.get("lastweek")).toBe(1);
  });

  it("groups un-niched scripts together", () => {
    const numbers = assignScriptNumbers([
      { id: "x", niche: null, createdAt: "2026-08-18T02:00:00Z" },
      { id: "y", niche: null, createdAt: "2026-08-18T03:00:00Z" },
    ]);
    expect(numbers.get("y")).toBe(2);
  });
});

const row = (niche: string | null, createdAt: string, id = createdAt) => ({
  id,
  niche,
  createdAt,
});

describe("buildDocGrid", () => {
  it("groups one week's scripts into niche rows, alphabetical", () => {
    const grid = buildDocGrid([
      row("Finance", "2026-08-11"),
      row("Christian", "2026-08-10"),
      row("Finance", "2026-08-12"),
    ]);
    expect(grid.rows.map((r) => r.niche)).toEqual(["Christian", "Finance"]);
  });

  it("orders scripts within a niche by createdAt ascending (Script 1 = oldest)", () => {
    const grid = buildDocGrid([
      row("Finance", "2026-08-12T09:00:00Z", "b"),
      row("Finance", "2026-08-10T09:00:00Z", "a"),
      row("Finance", "2026-08-11T09:00:00Z", "c"),
    ]);
    expect(grid.rows[0].scripts.map((s) => s.id)).toEqual(["a", "c", "b"]);
  });

  it("sets columns to the largest batch across niches", () => {
    const grid = buildDocGrid([
      row("Christian", "2026-08-10"),
      row("Finance", "2026-08-10", "f1"),
      row("Finance", "2026-08-11", "f2"),
      row("Finance", "2026-08-12", "f3"),
    ]);
    expect(grid.columns).toBe(3);
  });

  it("puts unniched scripts in a trailing null row", () => {
    const grid = buildDocGrid([
      row(null, "2026-08-10"),
      row("Finance", "2026-08-11"),
    ]);
    expect(grid.rows.map((r) => r.niche)).toEqual(["Finance", null]);
  });

  it("returns an empty grid for no rows", () => {
    expect(buildDocGrid([])).toEqual({ columns: 0, rows: [] });
  });
});

describe("titleFromHook", () => {
  it("uses the hook's first non-empty line, trimmed", () => {
    expect(titleFromHook("  10/10 biblical ways to kill laziness  \nrest of it")).toBe(
      "10/10 biblical ways to kill laziness"
    );
  });

  it("skips leading blank lines", () => {
    expect(titleFromHook("\n\n7 MONEY habits keeping you BROKE")).toBe(
      "7 MONEY habits keeping you BROKE"
    );
  });

  it("caps very long hooks at 80 characters with an ellipsis", () => {
    const long = "x".repeat(120);
    const title = titleFromHook(long)!;
    expect(title.length).toBe(80);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("x".repeat(79))).toBe(true);
  });

  it("returns null when there is nothing usable", () => {
    expect(titleFromHook(null)).toBeNull();
    expect(titleFromHook("   \n  ")).toBeNull();
  });
});
