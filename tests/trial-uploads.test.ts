import { describe, expect, it } from "vitest";
import { trialFlagsFromJobs } from "@/lib/trial-batcher";
import { groupTrialUploads, trialUploadShortcodes } from "@/lib/performance";

const job = (o: Partial<Record<string, unknown>>) => ({
  batch_id: "b1",
  status: "done",
  permalink: "https://www.instagram.com/reel/DckYLoDCfjn/",
  ...o,
});

describe("trialFlagsFromJobs", () => {
  it("maps a published job to its shortcode and batch", () => {
    expect(trialFlagsFromJobs([job({})])).toEqual([
      { shortcode: "DckYLoDCfjn", batchId: "b1" },
    ]);
  });

  it("ignores jobs that never published", () => {
    // 14 of 1,000 live rows are status=failed, and one done row has no
    // permalink. Neither reached Instagram, so neither can be a post here.
    expect(
      trialFlagsFromJobs([
        job({ status: "failed" }),
        job({ permalink: null }),
        job({ status: "queued", permalink: null }),
      ])
    ).toEqual([]);
  });

  it("drops a permalink it cannot parse rather than guessing", () => {
    // A wrong shortcode would flag another creator's real post as a trial and
    // delete it from every figure they are judged on. Fail closed.
    expect(trialFlagsFromJobs([job({ permalink: "https://example.com/nope" })])).toEqual([]);
  });

  it("keeps one entry per shortcode when a batch retried the same reel", () => {
    expect(
      trialFlagsFromJobs([job({}), job({ batch_id: "b2" })]).map((f) => f.shortcode)
    ).toEqual(["DckYLoDCfjn"]);
  });
});

describe("trialUploadShortcodes", () => {
  const SCRIPT = "four things you should not be doing if you claim to be a christian today";
  const vid = (shortcode: string, views: number, transcript: string | null) => ({
    shortcode,
    url: `https://www.instagram.com/reel/${shortcode}/`,
    posted_at: "2026-08-26T12:00:00Z",
    view_count: views,
    earnings_usd: 0,
    transcript_text: transcript,
  });

  it("names every member of a batch, the top draw included", () => {
    // The flag has to cover the whole batch. Leaving the highest-view member
    // unflagged is exactly the bug collapseTrialUploads had: it is a trial
    // like the rest, and the matcher must not be able to link a script to it.
    const batch = [
      vid("topDraw", 104179, SCRIPT),
      ...Array.from({ length: 10 }, (_, i) => vid(`t${i}`, 2000 + i, SCRIPT)),
    ];
    const flagged = trialUploadShortcodes(batch);
    expect(flagged).toHaveLength(11);
    expect(flagged).toContain("topDraw");
  });

  it("names nothing when there is no batch", () => {
    const other = "the bible tells us how to turn poverty into generational wealth";
    expect(trialUploadShortcodes([vid("a", 5000, SCRIPT), vid("b", 4000, other)])).toEqual([]);
  });

  it("never names a post without a transcript", () => {
    // A missing transcript is not evidence of duplication, and a wrong flag
    // deletes a real post from every figure the creator is judged on.
    expect(trialUploadShortcodes([vid("a", 1, null), vid("b", 2, ""), vid("c", 3, null)])).toEqual([]);
  });

  it("never names a post that was actually paid", () => {
    // Joey's rule: a trial never counts toward a paid deliverable. So earnings
    // are positive evidence AGAINST a post being a trial, and the heuristic
    // must not flag one — a wrong flag deletes real money from trueCpm.
    // Found live: the first backfill flagged 10 paid posts, all heuristic,
    // none from the batcher's ground truth.
    const batch = [
      { ...vid("paidReal", 40000, SCRIPT), earnings_usd: 148.68 },
      ...Array.from({ length: 10 }, (_, i) => vid(`t${i}`, 2000 + i, SCRIPT)),
    ];
    const flagged = trialUploadShortcodes(batch);
    expect(flagged).not.toContain("paidReal");
    expect(flagged).toHaveLength(10);
  });

  it("groups the same way the collapse does", () => {
    // One heuristic, two consumers. If these ever disagree, /performance and
    // /scripts disagree about which uploads are real posts.
    const batch = Array.from({ length: 5 }, (_, i) => vid(`t${i}`, 2000 + i, SCRIPT));
    expect(groupTrialUploads(batch)).toHaveLength(1);
    expect(groupTrialUploads(batch)[0]).toHaveLength(5);
  });
});
