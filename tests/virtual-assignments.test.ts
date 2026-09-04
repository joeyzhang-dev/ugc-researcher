import { describe, expect, it } from "vitest";
import { isMissingRelation, scopeVirtualAssignments } from "@/lib/virtual-assignments";
import { virtualAssignmentId } from "@/lib/scripts";
import type { ResearchCreator, ResearchScript, ResearchScriptAssignment } from "@/lib/types";

/**
 * `scopeVirtualAssignments` is the post-I/O half of `loadVirtualAssignments`
 * (src/lib/jobs/match-scripts.ts), lifted out so /scripts can compute the same
 * candidate set from rows it already holds. These pin the judgement itself:
 * every case here is one the job's own docstrings call load-bearing, and a
 * divergence between the two would put a different number on the badge than
 * the queue it links to.
 */

function script(id: string, niche: string | null): ResearchScript {
  return {
    id, app_id: null, title: id, hook: id, body: `body of ${id}`, niche,
    inspo_url: null, demo: null, songs: null, status: "Sent",
    created_at: "2026-08-01T00:00:00Z",
  } as unknown as ResearchScript;
}

function creator(id: string, kind: "roster" | "research", archivedAt: string | null = null): ResearchCreator {
  return { id, kind, archived_at: archivedAt } as unknown as ResearchCreator;
}

function assignment(scriptId: string, creatorId: string): ResearchScriptAssignment {
  return {
    id: `a-${scriptId}-${creatorId}`,
    script_id: scriptId,
    research_creator_id: creatorId,
    research_video_id: null,
    status: "Assigned",
    assigned_at: "2026-08-20T00:00:00Z",
    sent_at: "2026-08-20T00:00:00Z",
  } as unknown as ResearchScriptAssignment;
}

const posting = (scriptId: string, postedAt = "2026-09-01T00:00:00Z") => ({
  script_id: scriptId,
  posted_at: postedAt,
});

/** Empty defaults, so each case names only the rows it is about. */
function scope(input: Partial<Parameters<typeof scopeVirtualAssignments>[0]>) {
  return scopeVirtualAssignments({
    scripts: [],
    creators: [],
    existing: [],
    postings: [],
    memberships: [],
    channels: [],
    ...input,
  });
}

// Mirrors C1 in tests/match-scripts.test.ts, one layer down: the same rule,
// asserted against the pure function the page will call.
describe("scopeVirtualAssignments — roster scope", () => {
  it("pairs an unarchived roster creator only, never a research-kind or archived one", () => {
    // A null-niche script (the #broad shape) is deliberately universal, so
    // this is the exact case that would otherwise leak: with no memberships
    // all three of these creators read niche: null and would qualify.
    const s1 = script("s1", null);

    const { virtual } = scope({
      scripts: [s1],
      creators: [
        creator("roster-active", "roster"),
        creator("roster-archived", "roster", "2026-01-01T00:00:00Z"),
        creator("outsider", "research"),
      ],
      postings: [posting("s1")],
    });

    expect(virtual.map((v) => v.id)).toEqual([virtualAssignmentId("s1", "roster-active")]);
  });

  it("generates nothing for a script that was never published", () => {
    const { virtual } = scope({
      scripts: [script("s1", null)],
      creators: [creator("c1", "roster")],
      postings: [],
    });

    expect(virtual).toEqual([]);
  });
});

describe("scopeVirtualAssignments — niche resolution", () => {
  const memberships = [
    { app_id: "app-b", research_creator_id: "c1", niche: "Finance" },
    { app_id: "app-a", research_creator_id: "c1", niche: "Christian" },
  ];
  const channels = [{ research_creator_id: "c1", niche: "Fitness" }];
  const scripts = [script("s-christian", "Christian"), script("s-finance", "Finance"), script("s-fitness", "Fitness")];
  const postings = [posting("s-christian"), posting("s-finance"), posting("s-fitness")];

  // A membership niche is the workspace's own answer; the coaching channel's
  // is a fallback for a creator who has no membership niche at all.
  it("prefers a membership niche over the coaching channel's", () => {
    const { virtual } = scope({
      scripts,
      creators: [creator("c1", "roster")],
      memberships,
      channels,
      postings,
    });

    expect(virtual.map((v) => v.script_id)).toEqual(["s-christian"]);
  });

  // There is no workspace to scope to here, so the fold takes the first
  // non-null membership niche — which is only well defined because the rows
  // are sorted by app_id (then research_creator_id) first. Read order from
  // Postgres is not guaranteed, and an unsorted fold would silently answer
  // "Christian" or "Finance" depending on the day.
  it("is deterministic under the app_id ordering, whatever order the rows arrive in", () => {
    const forward = scope({
      scripts, creators: [creator("c1", "roster")], memberships, channels, postings,
    });
    const reversed = scope({
      scripts,
      creators: [creator("c1", "roster")],
      memberships: [...memberships].reverse(),
      channels,
      postings,
    });

    // app-a sorts first, so its niche wins from either input order.
    expect(forward.virtual.map((v) => v.id)).toEqual([virtualAssignmentId("s-christian", "c1")]);
    expect(reversed.virtual.map((v) => v.id)).toEqual(forward.virtual.map((v) => v.id));
  });

  it("falls back to the coaching channel's niche when no membership carries one", () => {
    const { virtual } = scope({
      scripts,
      creators: [creator("c1", "roster")],
      // A membership with a null niche must not shadow the channel: it is an
      // absent answer, not an answer of "none".
      memberships: [{ app_id: "app-a", research_creator_id: "c1", niche: null }],
      channels,
      postings,
    });

    expect(virtual.map((v) => v.script_id)).toEqual(["s-fitness"]);
  });

  // The only thing that makes #broad work: a script with no niche is a
  // candidate for everyone on the roster, whatever niche they hold.
  it("treats a null-niche script as universal", () => {
    const { virtual } = scope({
      scripts: [script("s-broad", null)],
      creators: [creator("c1", "roster"), creator("c2", "roster")],
      memberships: [{ app_id: "app-a", research_creator_id: "c1", niche: "Christian" }],
      channels: [{ research_creator_id: "c2", niche: "Fitness" }],
      postings: [posting("s-broad")],
    });

    expect(virtual.map((v) => v.id).sort()).toEqual(
      [virtualAssignmentId("s-broad", "c1"), virtualAssignmentId("s-broad", "c2")].sort()
    );
  });
});

// A script sent the old way and published the new way must not be scored
// twice against the same creator — the real row already stands for that pair.
describe("scopeVirtualAssignments — an existing assignment suppresses its pair", () => {
  it("drops only the claimed (script, creator) pair, never the others", () => {
    const { virtual } = scope({
      scripts: [script("s1", null)],
      creators: [creator("c1", "roster"), creator("c2", "roster")],
      existing: [assignment("s1", "c1")],
      postings: [posting("s1")],
    });

    expect(virtual.map((v) => v.id)).toEqual([virtualAssignmentId("s1", "c2")]);
  });
});

/**
 * deadPublishes answers "this publish reached nobody", and it is judged on
 * niche coverage rather than on how many candidates came out. Counting
 * candidates would report a script whose every candidate already holds a real
 * assignment — a success — as a failure.
 */
describe("scopeVirtualAssignments — deadPublishes", () => {
  it("reports a published script whose niche no roster creator holds", () => {
    const { virtual, deadPublishes } = scope({
      scripts: [script("s-finance", "Finance General")],
      creators: [creator("c1", "roster")],
      memberships: [{ app_id: "app-a", research_creator_id: "c1", niche: "Christian" }],
      postings: [posting("s-finance")],
    });

    expect(virtual).toEqual([]);
    expect(deadPublishes).toEqual(["s-finance"]);
  });

  it("does not report a script whose every candidate already holds a real assignment", () => {
    const { virtual, deadPublishes } = scope({
      scripts: [script("s-christian", "Christian")],
      creators: [creator("c1", "roster")],
      memberships: [{ app_id: "app-a", research_creator_id: "c1", niche: "Christian" }],
      existing: [assignment("s-christian", "c1")],
      postings: [posting("s-christian")],
    });

    // Zero candidates, same as the dead case above — the difference is that
    // the niche IS covered, and that is the whole distinction.
    expect(virtual).toEqual([]);
    expect(deadPublishes).toEqual([]);
  });

  it("ignores a script with an uncovered niche that was never published", () => {
    const { deadPublishes } = scope({
      scripts: [script("s-finance", "Finance General")],
      creators: [creator("c1", "roster")],
      postings: [],
    });

    expect(deadPublishes).toEqual([]);
  });

  // A roster creator with no niche at all covers the null-niche scripts, and
  // a null-niche script is universal anyway — never dead.
  it("never reports a null-niche script", () => {
    const { deadPublishes } = scope({
      scripts: [script("s-broad", null)],
      creators: [],
      postings: [posting("s-broad")],
    });

    expect(deadPublishes).toEqual([]);
  });
});

// The page and the job both degrade an absent research_script_posts to [],
// because the table's migration ships separately from the code that reads it.
describe("isMissingRelation", () => {
  it("recognises PostgREST's schema-cache 404 and Postgres' undefined_table", () => {
    expect(isMissingRelation({ code: "PGRST205" })).toBe(true);
    expect(isMissingRelation({ code: "42P01" })).toBe(true);
  });

  it("does not swallow any other error", () => {
    expect(isMissingRelation({ code: "42501" })).toBe(false);
    expect(isMissingRelation({})).toBe(false);
    expect(isMissingRelation(null)).toBe(false);
    expect(isMissingRelation(undefined)).toBe(false);
  });
});
