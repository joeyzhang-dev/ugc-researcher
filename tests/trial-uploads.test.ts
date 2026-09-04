import { describe, expect, it } from "vitest";
import { TRIAL_BURST_WINDOW_MS, groupTrialUploads, trialUploadIds } from "@/lib/scripts";

/**
 * The trial-batch heuristic itself, pinned once for both readers of it:
 * `collapseTrialUploads` (which drops the batch out of every performance
 * figure) and `resolveScriptMatches` (which must never link one to a script).
 * They share this code precisely so they cannot disagree about which uploads
 * are real posts.
 */

const SCRIPT =
  "four things you should not be doing if you claim to be a christian number one is judging people";
const OTHER =
  "the bible literally tells us how to turn poverty into generational wealth";

const clip = (id: string, views: number, transcript: string | null) => ({
  id,
  view_count: views,
  transcript_text: transcript,
});

describe("groupTrialUploads", () => {
  it("groups repeats of one reel, keeps a different reel apart, and orders both by views", () => {
    // Creation order follows the most-viewed-first walk, and each group's own
    // members stay in that order — collapseTrialUploads' `kept` reads group[0]
    // as the batch winner, so this ordering is load-bearing there.
    const groups = groupTrialUploads([
      clip("a", 5000, SCRIPT),
      clip("b", 4000, OTHER),
      clip("c", 9000, SCRIPT),
    ]);
    expect(groups.map((g) => g.map((v) => v.id))).toEqual([["c", "a"], ["b"]]);
  });

  it("does not mutate the array it was handed", () => {
    const input = [clip("a", 5000, SCRIPT), clip("b", 9000, SCRIPT)];
    const before = input.map((v) => v.id);
    groupTrialUploads(input);
    expect(input.map((v) => v.id)).toEqual(before);
  });

  it("honours an optional similarity function, so a caller can memoize it", () => {
    // The resolver runs this thousands of times over one creator's burst and
    // passes a pre-tokenized, memoized comparison. Injecting it must change
    // nothing but the cost — which is only true if the parameter is actually
    // the comparison the grouping uses.
    const all = [clip("a", 3, SCRIPT), clip("b", 2, OTHER), clip("c", 1, SCRIPT)];
    expect(groupTrialUploads(all, () => 1).map((g) => g.map((v) => v.id))).toEqual([
      ["a", "b", "c"],
    ]);
    expect(groupTrialUploads(all, () => 0).map((g) => g.map((v) => v.id))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });
});

const upload = (id: string, postedAt: string | null, transcript: string | null = SCRIPT) => ({
  id,
  posted_at: postedAt,
  view_count: 2000,
  transcript_text: transcript,
});

describe("trialUploadIds", () => {
  it("calls a same-day burst of three what it is", () => {
    const ids = trialUploadIds([
      upload("v0", "2026-09-01T18:00:00Z"),
      upload("v1", "2026-09-01T18:05:00Z"),
      upload("v2", "2026-09-01T18:10:00Z"),
    ]);
    expect([...ids].sort()).toEqual(["v0", "v1", "v2"]);
  });

  it("leaves a hand-posted identical pair alone", () => {
    // Posting the same reel twice is something creators do by hand;
    // TRIAL_MIN_BATCH is what keeps that from reading as a trial run.
    const ids = trialUploadIds([
      upload("v0", "2026-09-01T18:00:00Z"),
      upload("v1", "2026-09-01T18:05:00Z"),
    ]);
    expect(ids.size).toBe(0);
  });

  it("never counts an undated upload as a batch member", () => {
    // A null posted_at has no burst to belong to, and the resolver's existing
    // fixtures are full of them — treating one as a sibling would quietly
    // change matches that have nothing to do with trials.
    const ids = trialUploadIds([
      upload("v0", "2026-09-01T18:00:00Z"),
      upload("v1", "2026-09-01T18:05:00Z"),
      upload("undated", null),
    ]);
    expect(ids.size).toBe(0);
  });

  it("ignores an untranscribed upload — absent words are not evidence of duplication", () => {
    const ids = trialUploadIds([
      upload("v0", "2026-09-01T18:00:00Z"),
      upload("v1", "2026-09-01T18:05:00Z"),
      upload("v2", "2026-09-01T18:10:00Z", null),
    ]);
    expect(ids.size).toBe(0);
  });

  it("sees a burst that straddles midnight UTC, because the window rolls on instants", () => {
    // 8pm US Eastern is 00:00 UTC. Bucketed by calendar day, the lone member
    // on the sparse side of midnight would have no visible siblings and no
    // detectable batch — reopening the exact hole this guard exists to close.
    const ids = trialUploadIds([
      upload("late", "2026-09-01T23:58:00Z"),
      upload("early1", "2026-09-02T00:05:00Z"),
      upload("early2", "2026-09-02T00:10:00Z"),
    ]);
    expect([...ids].sort()).toEqual(["early1", "early2", "late"]);
  });

  it("does not fuse two pairs posted further apart than the window", () => {
    const ids = trialUploadIds([
      upload("v0", "2026-09-01T18:00:00Z"),
      upload("v1", "2026-09-01T18:05:00Z"),
      upload("v2", "2026-09-05T18:00:00Z"),
      upload("v3", "2026-09-05T18:05:00Z"),
    ]);
    expect(ids.size).toBe(0);
  });

  it("rolls the window around each upload rather than slicing fixed buckets", () => {
    // v1 sits inside the window of both v0 and v2 while v0 and v2 are further
    // apart than the window: the neighbourhood is per-upload, so all three are
    // one batch as seen from v1.
    const w = TRIAL_BURST_WINDOW_MS;
    const at = (ms: number) => new Date(ms).toISOString();
    const base = Date.parse("2026-09-01T00:00:00Z");
    const ids = trialUploadIds([
      upload("v0", at(base)),
      upload("v1", at(base + w)),
      upload("v2", at(base + 2 * w)),
    ]);
    expect(ids.has("v1")).toBe(true);
  });
});
