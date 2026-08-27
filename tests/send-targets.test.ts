import { describe, expect, it } from "vitest";
import { buildSendTargets, isChannelTarget, type SendTargetInput } from "@/lib/send-targets";

const APP = "app-folk";
const base: SendTargetInput = { appId: APP, creators: [], memberships: [], channels: [] };
const chan = (over: Partial<SendTargetInput["channels"][number]>) => ({
  channel_id: "1",
  channel_name: "🌱someone",
  research_creator_id: null,
  niche: "General Motivation / Hustle",
  ...over,
});

describe("buildSendTargets", () => {
  it("makes a rostered creator with a linked channel sendable", () => {
    const [t] = buildSendTargets({
      ...base,
      creators: [{ id: "c1", handle: "ann" }],
      memberships: [{ app_id: APP, research_creator_id: "c1", niche: "Christian" }],
      channels: [chan({ channel_id: "10", research_creator_id: "c1", niche: "Christian" })],
    });
    expect(t).toMatchObject({ creatorId: "c1", handle: "ann", niche: "Christian", blocker: null });
  });

  // The bug this module exists for: a creator onboarded in Discord days before
  // they have an Instagram handle has no creator row, so the old list built
  // from research_creators alone omitted them with nothing on screen.
  it("lists a tracked creator channel that has no creator row yet", () => {
    const targets = buildSendTargets({
      ...base,
      channels: [chan({ channel_id: "77", channel_name: "🌱tearaibryers" })],
    });
    expect(targets).toEqual([
      {
        creatorId: "channel:77",
        handle: "tearaibryers",
        niche: "General Motivation / Hustle",
        blocker: "unlinked-channel",
      },
    ]);
    expect(isChannelTarget(targets[0].creatorId)).toBe(true);
  });

  it("keeps coach and dormant channels out — they carry no track-emoji niche", () => {
    expect(
      buildSendTargets({
        ...base,
        channels: [
          chan({ channel_id: "1", channel_name: "coaching-vara", niche: null }),
          chan({ channel_id: "2", channel_name: "influencer-breezy", niche: null }),
        ],
      })
    ).toEqual([]);
  });

  it("keeps a creator whose workspace membership is missing, rather than dropping them", () => {
    const [t] = buildSendTargets({
      ...base,
      creators: [{ id: "c1", handle: "kae" }],
      memberships: [],
      channels: [chan({ channel_id: "10", research_creator_id: "c1", niche: "Christian" })],
    });
    expect(t).toMatchObject({ handle: "kae", blocker: "outside-workspace", niche: "Christian" });
  });

  it("still omits a creator who is neither in the workspace nor reachable", () => {
    expect(
      buildSendTargets({ ...base, creators: [{ id: "c9", handle: "ghost" }] })
    ).toEqual([]);
  });

  it("reports a rostered creator with no channel as no-channel", () => {
    const [t] = buildSendTargets({
      ...base,
      creators: [{ id: "c1", handle: "cj" }],
      memberships: [{ app_id: APP, research_creator_id: "c1", niche: "Christian" }],
    });
    expect(t.blocker).toBe("no-channel");
  });

  it("falls back to the channel niche when the membership has none", () => {
    const [t] = buildSendTargets({
      ...base,
      creators: [{ id: "c1", handle: "vic" }],
      memberships: [{ app_id: APP, research_creator_id: "c1", niche: null }],
      channels: [chan({ channel_id: "10", research_creator_id: "c1", niche: "Christian" })],
    });
    expect(t.niche).toBe("Christian");
  });

  it("prefers the current workspace's niche over another app's", () => {
    const [t] = buildSendTargets({
      ...base,
      creators: [{ id: "c1", handle: "vic" }],
      memberships: [
        { app_id: "app-other", research_creator_id: "c1", niche: "Girly Finance" },
        { app_id: APP, research_creator_id: "c1", niche: "Christian" },
      ],
      channels: [chan({ channel_id: "10", research_creator_id: "c1" })],
    });
    expect(t.niche).toBe("Christian");
  });

  it("sorts by handle so the picker order is stable", () => {
    expect(
      buildSendTargets({
        ...base,
        appId: null,
        creators: [
          { id: "c1", handle: "zoe" },
          { id: "c2", handle: "abe" },
        ],
        channels: [
          chan({ channel_id: "1", research_creator_id: "c1" }),
          chan({ channel_id: "2", research_creator_id: "c2" }),
          chan({ channel_id: "3", channel_name: "🌱mid" }),
        ],
      }).map((t) => t.handle)
    ).toEqual(["abe", "mid", "zoe"]);
  });
});
