import { describe, expect, it } from "vitest";
import { countNicheChannels, planNicheChannelRenames } from "@/lib/niche-channel-rename";

const ch = (id: string, name: string, type = 0) => ({ id, name, type });

describe("planNicheChannelRenames", () => {
  it("renames only the channels carrying the old emoji", () => {
    const plan = planNicheChannelRenames(
      [ch("1", "🌱ethan-lau"), ch("2", "✝️nino-aguilar"), ch("3", "folk-branding")],
      "🌱",
      "💪"
    );
    expect(plan).toEqual([{ channelId: "1", from: "🌱ethan-lau", to: "💪ethan-lau" }]);
  });

  it("matches a channel written without the variation selector", () => {
    // ✝️ and ✝ are one track everywhere else; a rename that missed the bare
    // form would leave channels stranded on an emoji no niche claims.
    const plan = planNicheChannelRenames([ch("1", "✝jas-alcantara")], "✝️", "🙏");
    expect(plan).toEqual([{ channelId: "1", from: "✝jas-alcantara", to: "🙏jas-alcantara" }]);
  });

  it("skips categories and voice channels", () => {
    expect(planNicheChannelRenames([ch("1", "🌱Team", 4), ch("2", "🌱voice", 2)], "🌱", "💪")).toEqual([]);
  });

  it("is a no-op when the emoji did not change", () => {
    expect(planNicheChannelRenames([ch("1", "🌱ethan-lau")], "🌱", "🌱")).toEqual([]);
  });
});

describe("countNicheChannels", () => {
  it("counts exactly what the rename would touch", () => {
    // The number on the button and the work the button does must agree, or
    // the confirm step is describing something other than what it will do.
    const channels = [ch("1", "🌱ethan-lau"), ch("2", "🌱ally-li"), ch("3", "✝️nino"), ch("4", "🌱Team", 4)];
    expect(countNicheChannels(channels, "🌱")).toBe(2);
    expect(countNicheChannels(channels, "🌱")).toBe(
      planNicheChannelRenames(channels, "🌱", "💪").length
    );
  });

  it("is zero for a niche with no emoji", () => {
    expect(countNicheChannels([ch("1", "🌱ethan-lau")], "")).toBe(0);
  });
});
