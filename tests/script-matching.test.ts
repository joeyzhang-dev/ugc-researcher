import { describe, expect, it } from "vitest";
import {
  buildVirtualAssignments,
  dateProximity,
  isVirtualAssignmentId,
  parseVirtualAssignmentId,
  MATCH_AUTO_MIN,
  resolveScriptMatches,
  virtualAssignmentId,
} from "@/lib/scripts";
import type {
  ResearchScript,
  ResearchScriptAssignment,
  ResearchTranscriptStatus,
  ResearchVideo,
} from "@/lib/types";

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
  postedAt: string | null = null,
  status: ResearchTranscriptStatus = transcript ? "transcribed" : "pending"
): ResearchVideo {
  return {
    id, research_creator_id: creatorId, url: `https://x/${id}`, shortcode: id,
    transcript_text: transcript, transcript_status: status,
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
  // The case the whole margin exists for, now proven across a real
  // assignment and a virtual (published-script) pair rather than two real
  // ones: two near-duplicate scripts both bid on the one post a creator
  // made, and global best-first settling has to pick a single winner without
  // ever letting a video back two assignments.
  it("settles global best-first when a real assignment and a virtual pair both bid on it", () => {
    const shared = "Number one, comparing your walk to somebody else's. Number two, skipping rest.";
    // s1 (real) overlaps `shared` almost completely but not quite — one word
    // ("Truly.") the transcript never says, the same one-word gap that
    // produced the live 0.97-vs-0.91 pair MATCH_AUTO_MARGIN was built for.
    const s1 = { ...nichedScript("s1", "Christian"), body: shared + " Truly." } as ResearchScript;
    // s2 (virtual, published to #christian-4things) is a perfect containment
    // match for the same transcript.
    const s2 = { ...nichedScript("s2", "Christian"), body: shared } as ResearchScript;
    const v = vid("v1", "c1", shared, "2026-09-02T00:00:00Z");

    const virtual = buildVirtualAssignments(
      [s2], [{ script_id: "s2", posted_at: "2026-09-01T00:00:00Z" }],
      [{ id: "c1", niche: "Christian" }], []
    );
    // a1 is sent close enough to the post that both pairs get full date
    // credit — the contest has to be decided on text, not timing.
    const out = resolveScriptMatches(
      [s1, s2],
      [asg("a1", "s1", "c1", "2026-08-25T00:00:00Z"), ...virtual],
      [v],
      new Set()
    );

    // The partial unique index means only one assignment can ever claim v1.
    // Resolution is global, so the loser (s1's real assignment) must not
    // survive anywhere — not in confirm, not in review — once the winner has
    // taken the video; it simply has nothing left to be matched against.
    const claims = [...out.confirm, ...out.review].filter((m) => m.videoId === "v1");
    expect(claims).toHaveLength(1);
    expect(claims[0].scriptId).toBe("s2");
    expect(claims[0].assignmentId).toBe(virtual[0].id);

    // s2's perfect score still isn't enough to auto-link: it beats s1's
    // near-identical pair by less than MATCH_AUTO_MARGIN, so a human has to
    // look — exactly the ambiguity the margin exists to catch, now shown to
    // hold when one side of the contest is a virtual pair.
    expect(claims[0].reason).toBe("contested");
    expect(out.confirm).toHaveLength(0);
  });

  // The spec's other named case: a virtual pair's own anchor date can be
  // impossible too, and that must route to review exactly like a real
  // assignment's does — never auto-link just because the text is a perfect
  // match.
  it("sends a virtual pair to review as posted-before-send when its anchor postdates the video", () => {
    const words =
      "morning routine peak male twenties edition cold shower journal gym protein sunlight";
    const s = { ...nichedScript("s1", "Christian"), body: words } as ResearchScript;
    // The script's earliest posting (its virtual sent_at) is AFTER the video
    // already existed — the video cannot be this publish's output.
    const virtual = buildVirtualAssignments(
      [s],
      [{ script_id: "s1", posted_at: "2026-09-10T00:00:00Z" }],
      [{ id: "c1", niche: "Christian" }],
      []
    );
    const v = vid("v1", "c1", words, "2026-08-01T00:00:00Z");
    const out = resolveScriptMatches([s], virtual, [v], new Set());

    expect(out.confirm).toHaveLength(0);
    expect(out.review).toHaveLength(1);
    expect(out.review[0]).toMatchObject({
      assignmentId: virtual[0].id,
      reason: "posted-before-send",
    });
  });
});

// ---------------------------------------------------------------------------
// Trial reels
//
// Joey's creators run Instagram Trials through a tool that uploads one reel
// fifteen-plus times in a sitting. A trial reel never graduates and never
// counts as a post, so no member of a batch may ever be linked to a script —
// and the moment that matters most is the one where the batch is invisible:
// transcription is asynchronous (the Fly worker takes one row per 60s poll),
// so for hours a burst reads as ONE transcribed video with no rivals at all,
// which is exactly the shape that auto-links.
// ---------------------------------------------------------------------------

const TRIAL_HOOK = "Four things you should not be doing if you want to lock in this year";
const TRIAL_BODY =
  "Number one, comparing your progress to somebody who started five years earlier. " +
  "Number two, skipping rest because you think exhaustion equals discipline. " +
  "Number three, chasing approval from strangers online instead of building something quietly.";
/** The creator said the script, so containment is a clean 1.0 — every gate
 *  below is therefore about the batch, never about a weak score. */
const TRIAL_TRANSCRIPT = `${TRIAL_HOOK}. ${TRIAL_BODY}`;
const OTHER_TRANSCRIPT =
  "The bible literally tells us how to turn poverty into generational wealth, and nobody teaches this anywhere.";

const TRIAL_SENT = "2026-08-30T00:00:00Z";
const BURST_START = Date.parse("2026-09-01T18:00:00Z");
const burstAt = (i: number, from = BURST_START) => new Date(from + i * 5 * 60_000).toISOString();

const trialScript = () => script("s1", TRIAL_HOOK, TRIAL_BODY);
const trialAsg = () => asg("a1", "s1", "c1", TRIAL_SENT);

/** A 15-upload trial burst, `transcribed` of which have come back from the
 *  worker; the rest are still queued. */
function burst(transcribed: number, size = 15, from = BURST_START): ResearchVideo[] {
  return Array.from({ length: size }, (_, i) =>
    i < transcribed
      ? vid(`v${i}`, "c1", TRIAL_TRANSCRIPT, burstAt(i, from))
      : vid(`v${i}`, "c1", null, burstAt(i, from), "pending")
  );
}

describe("resolveScriptMatches — trial bursts still transcribing", () => {
  // THE failure. One transcribed upload of fifteen has no rival, clears
  // MATCH_AUTO_MIN at 1.0 and beats a runner-up of 0.000 — so the old
  // resolver linked a trial upload with no human in the loop, permanently,
  // and /scripts then carried it as a real post.
  it("holds a lone transcribed upload whose fourteen siblings are still queued, instead of linking it", () => {
    const out = resolveScriptMatches([trialScript()], [trialAsg()], burst(1), new Set());
    expect(out.confirm).toHaveLength(0);
    expect(out.review).toHaveLength(1);
    expect(out.review[0]).toMatchObject({
      assignmentId: "a1",
      videoId: "v0",
      reason: "awaiting-siblings",
      pendingSiblings: 14,
    });
  });

  // Two transcribed siblings already contest each other, so the old code
  // called this "contested" — true but misleading: nothing here needs a human
  // to choose between two scripts, it needs the other thirteen transcripts.
  it("calls a two-of-fifteen burst awaiting siblings rather than contested", () => {
    const out = resolveScriptMatches([trialScript()], [trialAsg()], burst(2), new Set());
    expect(out.confirm).toHaveLength(0);
    expect(out.review.map((r) => r.reason)).toEqual(["awaiting-siblings"]);
  });

  // At TRIAL_MIN_BATCH the detector can finally see the batch, and every
  // member drops out of the candidate pool entirely — there is no pair left
  // to hold, confirm or review.
  it("excludes every member once three of the fifteen have transcripts", () => {
    const out = resolveScriptMatches([trialScript()], [trialAsg()], burst(3), new Set());
    expect([...out.trialVideoIds].sort()).toEqual(["v0", "v1", "v2"]);
    expect(out.confirm).toHaveLength(0);
    expect(out.review).toHaveLength(0);
  });

  it("excludes all fifteen once the whole burst is transcribed", () => {
    const out = resolveScriptMatches([trialScript()], [trialAsg()], burst(15), new Set());
    expect(out.trialVideoIds.size).toBe(15);
    expect(out.confirm).toHaveLength(0);
    expect(out.review).toHaveLength(0);
  });

  // A batch counts a claimed sibling as evidence: it is still an upload the
  // trial tool made, and dropping it from the count is what would let a
  // three-upload batch read as a two-upload pair.
  it("counts an already-claimed sibling when deciding a burst is a batch", () => {
    const videos = [
      vid("v0", "c1", TRIAL_TRANSCRIPT, burstAt(0)),
      vid("v1", "c1", TRIAL_TRANSCRIPT, burstAt(1)),
      vid("taken", "c1", TRIAL_TRANSCRIPT, burstAt(2)),
    ];
    const out = resolveScriptMatches([trialScript()], [trialAsg()], videos, new Set(["taken"]));
    expect(out.trialVideoIds.has("v0")).toBe(true);
    expect(out.trialVideoIds.has("v1")).toBe(true);
    expect(out.confirm).toHaveLength(0);
    expect(out.review).toHaveLength(0);
  });

  // 8pm US Eastern is 00:00 UTC. Bucketed by calendar day this burst splits
  // 1/14, the lone member on the sparse side sees no siblings, and the
  // permanent wrong link is back. The window rolls on instants for this.
  it("sees a burst that straddles midnight UTC — held while transcribing", () => {
    const late = vid("late", "c1", TRIAL_TRANSCRIPT, "2026-09-01T23:58:00Z");
    const early = Array.from({ length: 14 }, (_, i) =>
      vid(`early${i}`, "c1", null, burstAt(i, Date.parse("2026-09-02T00:05:00Z")), "pending")
    );
    const out = resolveScriptMatches([trialScript()], [trialAsg()], [late, ...early], new Set());
    expect(out.confirm).toHaveLength(0);
    expect(out.review.map((r) => r.reason)).toEqual(["awaiting-siblings"]);
  });

  it("sees the same straddling burst as one batch once every member is transcribed", () => {
    const late = vid("late", "c1", TRIAL_TRANSCRIPT, "2026-09-01T23:58:00Z");
    const early = Array.from({ length: 14 }, (_, i) =>
      vid(`early${i}`, "c1", TRIAL_TRANSCRIPT, burstAt(i, Date.parse("2026-09-02T00:05:00Z")))
    );
    const out = resolveScriptMatches([trialScript()], [trialAsg()], [late, ...early], new Set());
    expect(out.trialVideoIds.size).toBe(15);
    expect(out.confirm).toHaveLength(0);
    expect(out.review).toHaveLength(0);
  });

  // A pair is not a trial run — creators hand-post the same reel twice — so
  // TRIAL_MIN_BATCH leaves it alone and it lands where it always did.
  it("still calls a hand-posted identical pair contested, not a batch", () => {
    const videos = [
      vid("v0", "c1", TRIAL_TRANSCRIPT, burstAt(0)),
      vid("v1", "c1", TRIAL_TRANSCRIPT, burstAt(1)),
    ];
    const out = resolveScriptMatches([trialScript()], [trialAsg()], videos, new Set());
    expect(out.trialVideoIds.size).toBe(0);
    expect(out.confirm).toHaveLength(0);
    expect(out.review.map((r) => r.reason)).toEqual(["contested"]);
  });
});

describe("resolveScriptMatches — what the hold must NOT catch", () => {
  it("auto-links a lone post with nothing else in its window", () => {
    const out = resolveScriptMatches(
      [trialScript()],
      [trialAsg()],
      [vid("v0", "c1", TRIAL_TRANSCRIPT, burstAt(0))],
      new Set()
    );
    expect(out.confirm).toHaveLength(1);
    expect(out.confirm[0]).toMatchObject({ videoId: "v0", pendingSiblings: 0 });
    expect(out.review).toHaveLength(0);
  });

  // "failed" is terminal on this read. A failed transcript is usually a
  // deleted post, and requeueMatchCandidates has already flipped every
  // in-radius failed/skipped row to "pending" earlier in the same
  // matchScriptPosts call — so a row still reading "failed" here is one
  // nothing is coming for. Treating it as in flight would hold a real post
  // forever, since the requeue would re-arm it on every tick.
  it("does not hold for a same-day sibling whose transcription failed", () => {
    const videos = [
      vid("v0", "c1", TRIAL_TRANSCRIPT, burstAt(0)),
      vid("dead", "c1", null, burstAt(1), "failed"),
    ];
    const out = resolveScriptMatches([trialScript()], [trialAsg()], videos, new Set());
    expect(out.confirm).toHaveLength(1);
    expect(out.confirm[0].videoId).toBe("v0");
  });

  it("does not hold for a pending upload three days outside the window", () => {
    const videos = [
      vid("v0", "c1", TRIAL_TRANSCRIPT, burstAt(0)),
      vid("far", "c1", null, "2026-09-04T18:00:00Z", "pending"),
    ];
    const out = resolveScriptMatches([trialScript()], [trialAsg()], videos, new Set());
    expect(out.confirm).toHaveLength(1);
    expect(out.confirm[0].videoId).toBe("v0");
  });

  // Two different reels the same day is a normal posting day, not a trial —
  // but while one of them is still transcribing we cannot tell which is which,
  // so the pair waits.
  it("holds while a genuinely different same-day upload is still transcribing", () => {
    const videos = [
      vid("v0", "c1", TRIAL_TRANSCRIPT, burstAt(0)),
      vid("v1", "c1", null, burstAt(1), "pending"),
    ];
    const out = resolveScriptMatches([trialScript()], [trialAsg()], videos, new Set());
    expect(out.confirm).toHaveLength(0);
    expect(out.review.map((r) => r.reason)).toEqual(["awaiting-siblings"]);
  });

  it("links the matching one once both same-day uploads are transcribed", () => {
    const videos = [
      vid("v0", "c1", TRIAL_TRANSCRIPT, burstAt(0)),
      vid("v1", "c1", OTHER_TRANSCRIPT, burstAt(1)),
    ];
    const out = resolveScriptMatches([trialScript()], [trialAsg()], videos, new Set());
    expect(out.trialVideoIds.size).toBe(0);
    expect(out.confirm).toHaveLength(1);
    expect(out.confirm[0].videoId).toBe("v0");
    expect(out.confirm[0].runnerUp).toBeLessThan(MATCH_AUTO_MIN);
    expect(out.review).toHaveLength(0);
  });

  // The existing fixtures build untranscribed videos with a null posted_at.
  // Those have no burst to belong to and must never read as siblings, or this
  // guard would silently change matches that have nothing to do with trials.
  it("never treats an undated untranscribed video as a sibling", () => {
    const videos = [
      vid("v0", "c1", TRIAL_TRANSCRIPT, burstAt(0)),
      vid("undated", "c1", null),
    ];
    const out = resolveScriptMatches([trialScript()], [trialAsg()], videos, new Set());
    expect(out.confirm).toHaveLength(1);
  });

  it("never scans a creator with no open assignment", () => {
    // c2's burst is real, but nobody is waiting on it — the detector must not
    // walk it at all, and nothing about c1's lone post may change.
    const videos = [
      vid("v0", "c1", TRIAL_TRANSCRIPT, burstAt(0)),
      ...Array.from({ length: 5 }, (_, i) =>
        vid(`o${i}`, "c2", TRIAL_TRANSCRIPT, burstAt(i))
      ),
    ];
    const out = resolveScriptMatches([trialScript()], [trialAsg()], videos, new Set());
    expect(out.confirm).toHaveLength(1);
    expect([...out.trialVideoIds]).toEqual([]);
  });
});
