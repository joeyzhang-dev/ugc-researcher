import { describe, expect, it } from "vitest";
import { summarizeScripts, suggestMatches, transcriptMatchScore } from "@/lib/scripts";
import type {
  ResearchScript,
  ResearchScriptAssignment,
  ResearchVideo,
} from "@/lib/types";

function video(id: string, day: number, views: number, transcript?: string): ResearchVideo {
  return {
    id,
    research_creator_id: "c1",
    url: `https://www.instagram.com/reel/${id}/`,
    shortcode: id,
    external_id: null,
    caption: null,
    hashtags: [],
    posted_at: new Date(Date.UTC(2026, 0, day)).toISOString(),
    view_count: views,
    like_count: 0,
    comment_count: 0,
    share_count: 0,
    thumbnail_url: null,
    video_url: null,
    duration_seconds: null,
    transcript_status: transcript ? "transcribed" : "pending",
    transcript_method: null,
    transcript_text: transcript ?? null,
    format_category: null,
    format_llm_status: null,
    format_llm_reasoning: null,
    format_llm_model: null,
    format_categorized_at: null,
    error_message: null,
    raw_metadata: null,
    scrape_queued_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as ResearchVideo;
}

const script = (over: Partial<ResearchScript> = {}): ResearchScript => ({
  id: "s1",
  app_id: null,
  title: "Test script",
  hook: null,
  body: null,
  niche: null,
  notes: null,
  status: "Active",
  created_at: "",
  updated_at: "",
  ...over,
});

const assign = (over: Partial<ResearchScriptAssignment> = {}): ResearchScriptAssignment => ({
  id: crypto.randomUUID(),
  script_id: "s1",
  research_creator_id: "c1",
  research_video_id: null,
  status: "Assigned",
  notes: null,
  assigned_at: "",
  posted_at: null,
  ...over,
});

describe("transcriptMatchScore", () => {
  const body = "Here are three habits that will make you unstoppable every single morning";

  it("scores a faithful delivery highly", () => {
    const spoken =
      "okay so here are three habits that will make you absolutely unstoppable every single morning let me explain";
    expect(transcriptMatchScore(body, spoken)).toBeGreaterThan(0.8);
  });

  it("is not fooled by an unrelated transcript", () => {
    const spoken = "today I want to talk about my favourite pasta recipe and why it works";
    expect(transcriptMatchScore(body, spoken)).toBeLessThan(0.25);
  });

  it("stays high when the creator rambles well past the script", () => {
    // Containment, not Jaccard: length alone must not tank the score, or a
    // faithful long take would rank below a short unrelated clip.
    const spoken =
      "here are three habits that will make you unstoppable every single morning " +
      "and honestly I could talk about this for hours ".repeat(20);
    expect(transcriptMatchScore(body, spoken)).toBeGreaterThan(0.8);
  });

  it("does not let a repeated word inflate the score", () => {
    expect(transcriptMatchScore("locked locked locked locked", "locked")).toBeLessThan(0.3);
  });

  it("returns 0 for empty input on either side", () => {
    expect(transcriptMatchScore("", "anything at all here")).toBe(0);
    expect(transcriptMatchScore("anything at all here", "")).toBe(0);
  });

  it("ignores stopwords and punctuation", () => {
    expect(transcriptMatchScore("The, and: of! to?", "completely different words")).toBe(0);
  });
});

describe("suggestMatches", () => {
  const body = "three habits that will make you unstoppable every morning";

  it("ranks the real match first and drops the noise", () => {
    const vids = [
      video("v1", 1, 100, "my favourite pasta recipe and why it works so well"),
      video("v2", 2, 100, "three habits that will make you unstoppable every morning"),
      video("v3", 3, 100, "reviewing the new phone camera in detail today"),
    ];
    const out = suggestMatches(body, vids);
    expect(out[0]?.video.id).toBe("v2");
    expect(out.map((c) => c.video.id)).not.toContain("v1");
  });

  it("skips videos with no transcript", () => {
    expect(suggestMatches(body, [video("v1", 1, 100)])).toEqual([]);
  });

  it("returns nothing for an empty script body", () => {
    expect(suggestMatches("", [video("v1", 1, 100, "three habits unstoppable morning")])).toEqual([]);
  });
});

describe("summarizeScripts", () => {
  // c1 normally does ~100 views; the scripted post did 400 => 4x lift.
  const c1 = [video("a", 1, 100), video("b", 2, 100), video("c", 3, 100), video("d", 4, 400)];
  const byCreator = new Map([["c1", c1]]);

  it("measures the post against the creator's whole library, not just scripted posts", () => {
    const perf = summarizeScripts(
      [script()],
      [assign({ research_video_id: "d", status: "Posted" })],
      byCreator
    )[0];
    expect(perf.posts).toBe(1);
    expect(perf.medianLift).toBeGreaterThan(3);
    expect(perf.totalViews).toBe(400);
  });

  it("counts pending and skipped without treating them as posts", () => {
    const perf = summarizeScripts(
      [script()],
      [
        assign({ research_video_id: "d", status: "Posted" }),
        assign({ research_creator_id: "c2", status: "Assigned" }),
        assign({ research_creator_id: "c3", status: "Skipped" }),
      ],
      byCreator
    )[0];
    expect(perf.posts).toBe(1);
    expect(perf.pending).toBe(1);
    expect(perf.skipped).toBe(1);
    expect(perf.creators).toBe(3);
  });

  it("reports nulls rather than zero for a script with no posts yet", () => {
    const perf = summarizeScripts([script()], [], byCreator)[0];
    expect(perf.posts).toBe(0);
    expect(perf.medianLift).toBeNull();
    expect(perf.medianScore).toBeNull();
    expect(perf.best).toBeNull();
  });

  it("sorts unposted scripts last instead of ranking them as zero", () => {
    const out = summarizeScripts(
      [script({ id: "empty", title: "No posts" }), script({ id: "s1" })],
      [assign({ script_id: "s1", research_video_id: "d", status: "Posted" })],
      byCreator
    );
    expect(out[0].script.id).toBe("s1");
    expect(out[1].script.id).toBe("empty");
  });
});
