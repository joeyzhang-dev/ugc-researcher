import { describe, expect, it } from "vitest";
import {
  buildVirtualAssignments,
  dateProximity,
  isVirtualAssignmentId,
  parseVirtualAssignmentId,
  resolveScriptMatches,
  virtualAssignmentId,
} from "@/lib/scripts";
import type { ResearchScript, ResearchScriptAssignment, ResearchVideo } from "@/lib/types";

function script(id: string, hook: string, body: string): ResearchScript {
  return {
    id, app_id: null, title: hook, hook, body, niche: null, inspo_url: null,
    demo: null, songs: null, status: "Sent", created_at: "2026-08-01T00:00:00Z",
  } as unknown as ResearchScript;
}

function asg(
  id: string,
  scriptId: string,
  creatorId: string,
  sentAt: string | null = null
): ResearchScriptAssignment {
  return {
    id, script_id: scriptId, research_creator_id: creatorId, research_video_id: null,
    status: "Assigned", notes: null, assigned_at: "2026-08-01T00:00:00Z", posted_at: null,
    discord_channel_id: null, discord_message_id: null, sent_at: sentAt,
  };
}

function vid(
  id: string,
  creatorId: string,
  transcript: string | null,
  postedAt: string | null = null
): ResearchVideo {
  return {
    id, research_creator_id: creatorId, url: `https://x/${id}`, shortcode: id,
    transcript_text: transcript, transcript_status: transcript ? "transcribed" : "pending",
    posted_at: postedAt,
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

// ---------------------------------------------------------------------------
// Date proximity
// ---------------------------------------------------------------------------

describe("dateProximity", () => {
  const sent = "2026-08-01T00:00:00Z";
  const plus = (days: number) =>
    new Date(Date.parse(sent) + days * 86_400_000).toISOString();

  it("gives full credit inside the radius", () => {
    expect(dateProximity(sent, plus(0))).toBe(1);
    expect(dateProximity(sent, plus(20))).toBe(1);
  });

  it("decays past the radius but never to nothing — a late post is unlikely, not impossible", () => {
    const near = dateProximity(sent, plus(30));
    const far = dateProximity(sent, plus(80));
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(0.2);
  });

  // A script cannot have produced a video that already existed when it was
  // written. One day of slack absorbs timezone skew and same-day sends.
  it("zeroes a post that predates its own script", () => {
    expect(dateProximity(sent, plus(-5))).toBe(0);
    expect(dateProximity(sent, plus(-0.5))).toBe(1);
  });

  // Absent data is not evidence against a pair. Penalising it would quietly
  // punish every assignment sent before send tracking existed.
  it("stays neutral when either date is missing", () => {
    expect(dateProximity(null, plus(3))).toBe(1);
    expect(dateProximity(sent, null)).toBe(1);
    expect(dateProximity("nonsense", plus(3))).toBe(1);
  });
});

describe("resolveScriptMatches with timing", () => {
  const WORDS =
    "morning routine peak male twenties edition cold shower journal gym protein sunlight";

  // The case the margin was built for: two scripts the words cannot separate.
  // Before timing this went to review; now the one actually sent near the post
  // wins outright.
  it("breaks a textual tie in favour of the script sent near the post", () => {
    const scripts = [script("s1", "A", WORDS), script("s2", "B", WORDS)];
    const assignments = [
      asg("a1", "s1", "c1", "2026-08-01T00:00:00Z"), // 2 days before the post
      asg("a2", "s2", "c1", "2026-05-01T00:00:00Z"), // three months earlier
    ];
    const videos = [vid("v1", "c1", WORDS, "2026-08-03T00:00:00Z")];

    const { confirm, review } = resolveScriptMatches(scripts, assignments, videos, new Set());
    expect(confirm).toHaveLength(1);
    expect(confirm[0].assignmentId).toBe("a1");
    expect(review).toHaveLength(0);
  });

  // Timing must never manufacture confidence the words do not support.
  it("still refuses a weak textual match no matter how good the timing", () => {
    const scripts = [script("s1", "A", "completely unrelated wording about taxes")];
    const assignments = [asg("a1", "s1", "c1", "2026-08-01T00:00:00Z")];
    const videos = [vid("v1", "c1", WORDS, "2026-08-01T06:00:00Z")];

    const { confirm } = resolveScriptMatches(scripts, assignments, videos, new Set());
    expect(confirm).toHaveLength(0);
  });

  it("sends a post that predates its script to review rather than linking it", () => {
    const scripts = [script("s1", "A", WORDS)];
    const assignments = [asg("a1", "s1", "c1", "2026-08-01T00:00:00Z")];
    const videos = [vid("v1", "c1", WORDS, "2026-06-01T00:00:00Z")];

    const { confirm, review } = resolveScriptMatches(scripts, assignments, videos, new Set());
    expect(confirm).toHaveLength(0);
    expect(review[0].reason).toBe("posted-before-send");
  });

  // Everything sent before send tracking existed has a null sent_at, and must
  // behave exactly as it did before this feature.
  it("is unchanged when timing data is absent", () => {
    const scripts = [script("s1", "A", WORDS)];
    const assignments = [asg("a1", "s1", "c1", null)];
    const videos = [vid("v1", "c1", WORDS, null)];

    const { confirm } = resolveScriptMatches(scripts, assignments, videos, new Set());
    expect(confirm).toHaveLength(1);
    expect(confirm[0].proximity).toBe(1);
  });
});

function nichedScript(id: string, niche: string | null): ResearchScript {
  return {
    id, app_id: null, title: id, hook: id, body: `body of ${id}`, niche,
    inspo_url: null, demo: null, songs: null, status: "Sent",
    created_at: "2026-08-01T00:00:00Z",
  } as unknown as ResearchScript;
}

describe("virtual assignment ids", () => {
  it("round-trips a script and creator through an id", () => {
    const id = virtualAssignmentId("s1", "c1");
    expect(isVirtualAssignmentId(id)).toBe(true);
    expect(parseVirtualAssignmentId(id)).toEqual({ scriptId: "s1", creatorId: "c1" });
  });

  it("does not mistake a real uuid for a virtual id", () => {
    const real = "8f14e45f-ceea-467a-9f38-1b2c3d4e5f60";
    expect(isVirtualAssignmentId(real)).toBe(false);
    expect(parseVirtualAssignmentId(real)).toBeNull();
  });
});

describe("buildVirtualAssignments", () => {
  const postings = [{ script_id: "s1", posted_at: "2026-09-01T00:00:00Z" }];

  it("generates no pair for a script that was never published", () => {
    const out = buildVirtualAssignments(
      [nichedScript("s1", "Christian")], [], [{ id: "c1", niche: "Christian" }], []
    );
    expect(out).toHaveLength(0);
  });

  it("pairs a published script with creators in its niche only", () => {
    const out = buildVirtualAssignments(
      [nichedScript("s1", "Christian")],
      postings,
      [{ id: "c1", niche: "Christian" }, { id: "c2", niche: "Girly Finance" }],
      []
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      script_id: "s1",
      research_creator_id: "c1",
      research_video_id: null,
      status: "Assigned",
      sent_at: "2026-09-01T00:00:00Z",
    });
  });

  it("treats a null-niche script as universal — this is how #broad works", () => {
    const out = buildVirtualAssignments(
      [nichedScript("s1", null)],
      postings,
      [{ id: "c1", niche: "Christian" }, { id: "c2", niche: null }],
      []
    );
    expect(out.map((a) => a.research_creator_id).sort()).toEqual(["c1", "c2"]);
  });

  it("never double-scores a creator who already has a real assignment", () => {
    const out = buildVirtualAssignments(
      [nichedScript("s1", "Christian")],
      postings,
      [{ id: "c1", niche: "Christian" }, { id: "c2", niche: "Christian" }],
      [asg("a1", "s1", "c1")]
    );
    expect(out).toHaveLength(1);
    expect(out[0].research_creator_id).toBe("c2");
  });

  it("anchors sent_at to the EARLIEST posting when a script sits in two channels", () => {
    const out = buildVirtualAssignments(
      [nichedScript("s1", "Christian")],
      [
        { script_id: "s1", posted_at: "2026-09-03T00:00:00Z" },
        { script_id: "s1", posted_at: "2026-09-01T00:00:00Z" },
      ],
      [{ id: "c1", niche: "Christian" }],
      []
    );
    expect(out[0].sent_at).toBe("2026-09-01T00:00:00Z");
  });
});

describe("real and virtual pairs competing for one video", () => {
  it("still gives the video to exactly one of them, best-first", () => {
    const shared = "Number one, comparing your walk to somebody else's. Number two, skipping rest.";
    const s1 = nichedScript("s1", "Christian");
    const s2 = { ...nichedScript("s2", "Christian"), body: shared } as ResearchScript;
    const v = vid("v1", "c1", shared, "2026-09-02T00:00:00Z");

    const virtual = buildVirtualAssignments(
      [s2], [{ script_id: "s2", posted_at: "2026-09-01T00:00:00Z" }],
      [{ id: "c1", niche: "Christian" }], []
    );
    const out = resolveScriptMatches([s1, s2], [asg("a1", "s1", "c1"), ...virtual], [v], new Set());

    const claims = [...out.confirm, ...out.review].filter((m) => m.videoId === "v1");
    expect(claims.length).toBeGreaterThan(0);
    expect(out.confirm.filter((m) => m.videoId === "v1")).toHaveLength(
      out.confirm.some((m) => m.videoId === "v1") ? 1 : 0
    );
  });
});
