import { describe, expect, it } from "vitest";
import { creatorNameFromChannel } from "@/lib/discord-channels";

describe("creatorNameFromChannel", () => {
  it("strips legacy prefixes", () => {
    expect(creatorNameFromChannel("coaching-ann")).toBe("ann");
    expect(creatorNameFromChannel("coachking-malik💪")).toBe("malik");
    expect(creatorNameFromChannel("influencer-breezy")).toBe("breezy");
  });

  it("derives names from emoji-only channels", () => {
    expect(creatorNameFromChannel("✝️jas")).toBe("jas");
    expect(creatorNameFromChannel("🤍anna🌸")).toBe("anna");
    expect(creatorNameFromChannel("🌱austin-gavin")).toBe("austin-gavin");
  });

  it("still strips the 2026-08-19 interim niche words", () => {
    expect(creatorNameFromChannel("✝️christian-jas")).toBe("jas");
    expect(creatorNameFromChannel("🤍improvement-anna🌸")).toBe("anna");
    expect(creatorNameFromChannel("🌱improvement-austin-gavin")).toBe("austin-gavin");
    expect(creatorNameFromChannel("✝️christian")).toBe("christian");
  });

  it("passes plain names through", () => {
    expect(creatorNameFromChannel("aidan-melograna")).toBe("aidan-melograna");
  });
});
