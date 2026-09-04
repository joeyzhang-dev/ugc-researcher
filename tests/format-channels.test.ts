/**
 * Which Discord category publishes scripts, and why it is matched by id.
 *
 * This category was renamed three times on 2026-09-04 — the last time from
 * "scripts / formats" to "SCRIPT / FORMATS", singular — and each rename
 * silently emptied the publish picker, because the match was on the name.
 */
import { describe, expect, it } from "vitest";
import { FORMAT_CATEGORY_ID, isFormatCategory } from "@/lib/format-channels";

const category = (id: string, name: string) => ({ id, type: 4, name });

describe("isFormatCategory", () => {
  it("matches on id, whatever the category has been renamed to", () => {
    // The rename that actually broke it, and then some.
    expect(isFormatCategory(category(FORMAT_CATEGORY_ID, "SCRIPT / FORMATS"))).toBe(true);
    expect(isFormatCategory(category(FORMAT_CATEGORY_ID, "scripts / formats"))).toBe(true);
    expect(isFormatCategory(category(FORMAT_CATEGORY_ID, "anything at all"))).toBe(true);
  });

  it("never matches a different category, however similarly named", () => {
    expect(isFormatCategory(category("999", "Coach: Will's Team"))).toBe(false);
    expect(isFormatCategory(category("999", "VIDEOS TO COPY"))).toBe(false);
  });

  it("falls back to a loose name match for a guild whose id we do not know", () => {
    // Singular/plural on either word, and any spacing round the slash — the
    // exact axis the live rename moved along.
    for (const name of [
      "SCRIPT / FORMATS",
      "scripts / formats",
      "Script / Format",
      "scripts/formats",
      "  scripts / formats  ",
    ]) {
      expect(isFormatCategory(category("999", name)), name).toBe(true);
    }
  });

  it("does not treat a merely similar name as the category", () => {
    expect(isFormatCategory(category("999", "scripts"))).toBe(false);
    expect(isFormatCategory(category("999", "formats"))).toBe(false);
    expect(isFormatCategory(category("999", "old scripts / formats"))).toBe(false);
  });

  it("ignores a text channel that happens to carry the name", () => {
    // type 0 is a text channel; only a category (type 4) can be the parent.
    expect(isFormatCategory({ id: FORMAT_CATEGORY_ID, type: 0, name: "SCRIPT / FORMATS" })).toBe(false);
  });
});
