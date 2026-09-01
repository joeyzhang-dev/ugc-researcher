/**
 * Who a scheduled creator recap is allowed to reach.
 *
 * Written against a live failure: on 2026-09-01 six creators sitting in the
 * "Not Creating 🚫" category were pinged with a daily recap, and again the day
 * before. `/offboard` had moved their channels but never touched
 * research_creators, and the send gated only on archived_at — so the two
 * halves of "we cut this person" never met.
 */
import { describe, expect, it } from "vitest";
import { sendEligibility, type EligibilityInput } from "@/lib/jobs/creator-digest";

const base: EligibilityInput = { creators: [], channels: [], memberIds: null };

const creator = (over: Partial<EligibilityInput["creators"][number]> = {}) => ({
  id: "c1",
  handle: "ann",
  discord_user_id: "555",
  archived_at: null,
  ...over,
});

const channel = (over: Partial<EligibilityInput["channels"][number]> = {}) => ({
  channel_id: "10",
  research_creator_id: "c1",
  category: "Coach: Will's Team",
  ...over,
});

describe("sendEligibility", () => {
  it("sends to a rostered creator with a linked account and a team channel", () => {
    const { targets, skipped } = sendEligibility({
      ...base,
      creators: [creator()],
      channels: [channel()],
    });
    expect(skipped).toEqual([]);
    expect(targets).toEqual([
      { creatorId: "c1", handle: "ann", discordUserId: "555", channelId: "10" },
    ]);
  });

  it("skips a creator whose channel sits in Not Creating", () => {
    const { targets, skipped } = sendEligibility({
      ...base,
      creators: [creator()],
      channels: [channel({ category: "Not Creating 🚫" })],
    });
    expect(targets).toEqual([]);
    expect(skipped).toEqual([{ handle: "ann", reason: "parked in Not Creating" }]);
  });

  it("still skips a parked creator who was never archived in the app", () => {
    const { targets } = sendEligibility({
      ...base,
      creators: [creator({ archived_at: null })],
      channels: [channel({ category: "not creating 🚫" })],
    });
    expect(targets).toEqual([]);
  });

  // Mirrors loadPerformanceReport: a creator with both an old parked channel
  // and a live team channel is still on the roster — the team channel is the
  // live one. Skipping them would be the opposite bug.
  it("keeps a creator who has a live team channel alongside an old parked one", () => {
    const { targets } = sendEligibility({
      ...base,
      creators: [creator()],
      channels: [
        channel({ channel_id: "9", category: "Not Creating 🚫" }),
        channel({ channel_id: "10", category: "Coach: Will's Team" }),
      ],
    });
    expect(targets).toEqual([
      { creatorId: "c1", handle: "ann", discordUserId: "555", channelId: "10" },
    ]);
  });

  it("skips an archived creator even when their channel is still in a team", () => {
    const { targets, skipped } = sendEligibility({
      ...base,
      creators: [creator({ archived_at: "2026-08-30T00:00:00Z" })],
      channels: [channel()],
    });
    expect(targets).toEqual([]);
    expect(skipped).toEqual([{ handle: "ann", reason: "archived" }]);
  });

  it("skips a creator with no linked Discord account", () => {
    const { skipped } = sendEligibility({
      ...base,
      creators: [creator({ discord_user_id: null })],
      channels: [channel()],
    });
    expect(skipped).toEqual([{ handle: "ann", reason: "no linked Discord account" }]);
  });

  it("skips a creator with no tracked channel to post into", () => {
    const { skipped } = sendEligibility({ ...base, creators: [creator()] });
    expect(skipped).toEqual([{ handle: "ann", reason: "no tracked coaching channel" }]);
  });

  it("skips a creator who has left the server", () => {
    const { skipped } = sendEligibility({
      ...base,
      creators: [creator()],
      channels: [channel()],
      memberIds: new Set(["999"]),
    });
    expect(skipped).toEqual([{ handle: "ann", reason: "no longer in the server" }]);
  });

  // A Discord outage must not silently reclassify the whole roster as gone.
  it("sends to everyone when the membership lookup failed", () => {
    const { targets } = sendEligibility({
      ...base,
      creators: [creator()],
      channels: [channel()],
      memberIds: null,
    });
    expect(targets).toHaveLength(1);
  });
});
