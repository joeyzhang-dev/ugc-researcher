import { describe, expect, it } from "vitest";
import { resolveScriptMatches } from "@/lib/scripts";
import type { ResearchScript, ResearchScriptAssignment, ResearchVideo } from "@/lib/types";

function script(id: string, hook: string, body: string): ResearchScript {
  return {
    id, app_id: null, title: hook, hook, body, niche: null, inspo_url: null,
    demo: null, songs: null, status: "Sent", created_at: "2026-08-01T00:00:00Z",
  } as unknown as ResearchScript;
}

function asg(id: string, scriptId: string, creatorId: string): ResearchScriptAssignment {
  return {
    id, script_id: scriptId, research_creator_id: creatorId, research_video_id: null,
    status: "Assigned", notes: null, assigned_at: "2026-08-01T00:00:00Z", posted_at: null,
  };
}

function vid(id: string, creatorId: string, transcript: string | null): ResearchVideo {
  return {
    id, research_creator_id: creatorId, url: `https://x/${id}`, shortcode: id,
    transcript_text: transcript, transcript_status: transcript ? "transcribed" : "pending",
  } as unknown as ResearchVideo;
}

describe("resolveScriptMatches", () => {
  it("auto-confirms an unambiguous strong match", () => {
    const s = script("s1", "Four things you should not be doing",
      "Number one, comparing your walk to somebody else's. Number two, skipping rest. Number three, chasing approval from strangers online.");
    const v = vid("v1", "c1",
      "Four things you should not be doing right now. Number one, comparing your walk to somebody else's. Number two, skipping rest. Number three, chasing approval from strangers online.");
    const out = resolveScriptMatches([s], [asg("a1", "s1", "c1")], [v, vid("v2", "c1", "totally unrelated cooking pasta recipe video")], new Set());
    expect(out.confirm).toHaveLength(1);
    expect(out.confirm[0]).toMatchObject({ assignmentId: "a1", videoId: "v1" });
    expect(out.review).toHaveLength(0);
  });

  it("sends near-duplicate scripts competing for one video to review, never auto-linking either", () => {
    const body = "Number one, a good fragrance. Number two, a fitted cap. Number three, clean white sneakers.";
    const a = script("s1", "10/10 male essentials", body);
    // A single extra word apart — the real contested pair scored 0.97 vs 0.91.
    const b = script("s2", "10/10 male essentials", body + " Belt.");
    const v = vid("v1", "c1", "10/10 male essentials. " + body);
    const out = resolveScriptMatches([a, b], [asg("a1", "s1", "c1"), asg("a2", "s2", "c1")], [v], new Set());
    expect(out.confirm).toHaveLength(0);
    expect(out.review.length).toBeGreaterThan(0);
    expect(out.review.every((r) => r.reason === "contested")).toBe(true);
  });

  it("never proposes a video already linked to another assignment", () => {
    const s = script("s1", "Four things", "Number one, comparing your walk to somebody else's every single morning.");
    const v = vid("v1", "c1", "Four things. Number one, comparing your walk to somebody else's every single morning.");
    const out = resolveScriptMatches([s], [asg("a1", "s1", "c1")], [v], new Set(["v1"]));
    expect(out.confirm).toHaveLength(0);
    expect(out.review).toHaveLength(0);
  });

  it("never gives one video to two assignments", () => {
    const s1 = script("s1", "Alpha hook", "Discipline beats motivation every single morning without exception.");
    const s2 = script("s2", "Beta hook", "Consistency outlasts intensity across every single season of building.");
    const v = vid("v1", "c1", "Discipline beats motivation every single morning without exception. Consistency outlasts intensity across every single season of building.");
    const out = resolveScriptMatches([s1, s2], [asg("a1", "s1", "c1"), asg("a2", "s2", "c1")], [v], new Set());
    const claimed = [...out.confirm, ...out.review].map((r) => r.videoId);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("ignores videos belonging to a different creator", () => {
    const s = script("s1", "Four things", "Number one, comparing your walk to somebody else's every single morning.");
    const v = vid("v1", "c2", "Four things. Number one, comparing your walk to somebody else's every single morning.");
    const out = resolveScriptMatches([s], [asg("a1", "s1", "c1")], [v], new Set());
    expect(out.confirm).toHaveLength(0);
    expect(out.review).toHaveLength(0);
  });

  it("skips untranscribed videos rather than guessing", () => {
    const s = script("s1", "Four things", "Number one, comparing your walk to somebody else's every single morning.");
    const out = resolveScriptMatches([s], [asg("a1", "s1", "c1")], [vid("v1", "c1", null)], new Set());
    expect(out.confirm).toHaveLength(0);
    expect(out.review).toHaveLength(0);
  });

  it("routes a merely-decent match to review instead of confirming it", () => {
    const s = script("s1", "Five habits", "Wake up early, drink water, read ten pages, walk outside, sleep by ten.");
    const v = vid("v1", "c1", "So today I wanted to talk about how I drink water and walk outside sometimes, anyway that is all I have for you people today, bye now.");
    const out = resolveScriptMatches([s], [asg("a1", "s1", "c1")], [v], new Set());
    expect(out.confirm).toHaveLength(0);
    expect(out.review.map((r) => r.reason)).toEqual(["low-confidence"]);
  });

  it("leaves already-linked assignments completely alone", () => {
    const s = script("s1", "Four things", "Number one, comparing your walk to somebody else's every single morning.");
    const linked = { ...asg("a1", "s1", "c1"), research_video_id: "v9", status: "Posted" as const };
    const v = vid("v1", "c1", "Four things. Number one, comparing your walk to somebody else's every single morning.");
    const out = resolveScriptMatches([s], [linked], [v], new Set(["v9"]));
    expect(out.confirm).toHaveLength(0);
    expect(out.review).toHaveLength(0);
  });
});
