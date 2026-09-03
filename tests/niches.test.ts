import { describe, expect, it } from "vitest";
import { nicheEmojis, nicheLabel, type Niche } from "@/lib/niches";

const niche = (name: string, emoji: string | null): Niche => ({
  name,
  emoji,
  discordRoleId: null,
  isActive: true,
});

describe("nicheLabel", () => {
  it("prefixes the emoji when the niche has one", () => {
    const emojis = nicheEmojis([niche("General Motivation / Hustle", "🌱")]);
    expect(nicheLabel("General Motivation / Hustle", emojis)).toBe("🌱 General Motivation / Hustle");
  });

  it("renders a free-text niche unchanged", () => {
    // 61 finance scripts carry a niche with no row in research_niches. The
    // table is the track vocabulary, not a registry of every string ever
    // written, so these must keep rendering exactly as before.
    const emojis = nicheEmojis([niche("Christian", "\u271D\uFE0F")]);
    expect(nicheLabel("Finance General", emojis)).toBe("Finance General");
  });

  it("ignores a niche row that has no emoji", () => {
    const emojis = nicheEmojis([niche("Finance General", null)]);
    expect(nicheLabel("Finance General", emojis)).toBe("Finance General");
  });
});
