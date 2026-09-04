import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { matchScriptPosts, resolveOpenAssignments } from "@/lib/jobs/match-scripts";
import { virtualAssignmentId } from "@/lib/scripts";
import type {
  ResearchCreator,
  ResearchScript,
  ResearchScriptAssignment,
  ResearchVideo,
} from "@/lib/types";

/** One write the job attempted, in the order it attempted it. */
type Write = { table: string; op: "insert" | "update"; payload: unknown };

/**
 * A minimal stand-in for the Supabase client, covering exactly the
 * `.from(table).select(cols).range(from, to)` shape `page()`/`pageOptional()`
 * use in src/lib/jobs/match-scripts.ts. Every table not listed answers empty.
 *
 * Writes are recorded rather than performed, so a test can assert what the job
 * would have done to the database — the interesting assertion for a matcher
 * whose whole job is to not link the wrong thing. `update()` returns a
 * thenable that swallows `.eq()` / `.is()`, matching both call sites.
 */
function fakeDb(
  tables: Record<string, unknown[] | { error: { code: string; message: string } }>,
  writes: Write[] = []
): SupabaseClient {
  return {
    from(table: string) {
      return {
        select() {
          return {
            async range() {
              const t = tables[table];
              if (t && !Array.isArray(t)) return { data: null, error: t.error };
              return { data: t ?? [], error: null };
            },
          };
        },
        insert(payload: unknown) {
          writes.push({ table, op: "insert", payload });
          return Promise.resolve({ error: null });
        },
        update(payload: unknown) {
          writes.push({ table, op: "update", payload });
          const chain = {
            eq: () => chain,
            is: () => chain,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
          };
          return chain;
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

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

// C1: virtual pairs must never reach a creator outside our own active roster.
describe("resolveOpenAssignments — virtual pair scope", () => {
  it("only generates a virtual candidate for an unarchived roster creator, never a research or archived one", async () => {
    // A null-niche script (the #broad shape) is deliberately universal, so
    // this is the exact case that would otherwise leak: without a scope
    // filter every one of these three creators reads niche: null (no
    // memberships exist) and would qualify.
    const s1 = script("s1", null);
    const rosterActive = creator("roster-active", "roster");
    const rosterArchived = creator("roster-archived", "roster", "2026-01-01T00:00:00Z");
    const outsider = creator("outsider", "research");

    const db = fakeDb({
      research_scripts: [s1],
      research_script_assignments: [],
      research_videos: [],
      research_creators: [rosterActive, rosterArchived, outsider],
      research_script_posts: [{ script_id: "s1", posted_at: "2026-09-01T00:00:00Z" }],
      research_app_creators: [],
      research_discord_channels: [],
    });

    const ctx = await resolveOpenAssignments(db);
    const ids = [...ctx.assignmentById.keys()];

    expect(ids).toContain(virtualAssignmentId("s1", "roster-active"));
    expect(ids).not.toContain(virtualAssignmentId("s1", "roster-archived"));
    expect(ids).not.toContain(virtualAssignmentId("s1", "outsider"));
  });
});

// C2: the code ships ahead of its own migration — a missing
// research_script_posts relation must degrade, not take the page down.
describe("resolveOpenAssignments — research_script_posts not yet migrated", () => {
  it("returns no virtual candidates instead of throwing when the table is absent", async () => {
    const s1 = script("s1", null);
    const rosterActive = creator("roster-active", "roster");

    const db = fakeDb({
      research_scripts: [s1],
      research_script_assignments: [],
      research_videos: [],
      research_creators: [rosterActive],
      // PostgREST's "not in my schema cache" response for a relation that
      // does not exist yet — exactly what production sees today, since this
      // migration is applied separately from the code that reads it.
      research_script_posts: { error: { code: "PGRST205", message: "Could not find the table" } },
      research_app_creators: [],
      research_discord_channels: [],
    });

    await expect(resolveOpenAssignments(db)).resolves.toBeDefined();
    const ctx = await resolveOpenAssignments(db);
    expect([...ctx.assignmentById.keys()]).toHaveLength(0);
    expect(ctx.deadPublishes).toHaveLength(0);
  });

  it("still throws on an unrelated error against the same table", async () => {
    const db = fakeDb({
      research_scripts: [script("s1", null)],
      research_script_assignments: [],
      research_videos: [],
      research_creators: [creator("roster-active", "roster")],
      research_script_posts: { error: { code: "42501", message: "permission denied" } },
      research_app_creators: [],
      research_discord_channels: [],
    });

    await expect(resolveOpenAssignments(db)).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------
// Trial bursts, at the loader and the job
// ---------------------------------------------------------------------------

const HOOK = "Four things you should not be doing if you want to lock in this year";
const BODY =
  "Number one, comparing your progress to somebody who started five years earlier. " +
  "Number two, skipping rest because you think exhaustion equals discipline. " +
  "Number three, chasing approval from strangers online instead of building something quietly.";
const SPOKEN = `${HOOK}. ${BODY}`;

const burstScript = {
  id: "s1", app_id: null, title: HOOK, hook: HOOK, body: BODY, niche: null,
  inspo_url: null, demo: null, songs: null, status: "Sent",
  created_at: "2026-08-01T00:00:00Z",
} as unknown as ResearchScript;

const burstAsg: ResearchScriptAssignment = {
  id: "a1", script_id: "s1", research_creator_id: "c1", research_video_id: null,
  status: "Assigned", notes: null, assigned_at: "2026-08-30T00:00:00Z", posted_at: null,
  discord_channel_id: null, discord_message_id: null, sent_at: "2026-08-30T00:00:00Z",
};

/** The live shape: one reel uploaded fifteen times in a sitting, of which
 *  `transcribed` have come back from the worker's one-row-per-60s poll. */
function burstVideos(transcribed: number): ResearchVideo[] {
  const start = Date.parse("2026-09-01T18:00:00Z");
  return Array.from({ length: 15 }, (_, i) => ({
    id: `v${i}`,
    research_creator_id: "c1",
    url: `https://x/v${i}`,
    shortcode: `v${i}`,
    posted_at: new Date(start + i * 5 * 60_000).toISOString(),
    transcript_text: i < transcribed ? SPOKEN : null,
    transcript_status: i < transcribed ? "transcribed" : "pending",
  })) as unknown as ResearchVideo[];
}

const burstTables = (transcribed: number) => ({
  research_scripts: [burstScript],
  research_script_assignments: [burstAsg],
  research_videos: burstVideos(transcribed),
  research_creators: [creator("c1", "roster")],
  research_script_posts: [],
  research_app_creators: [],
  research_discord_channels: [],
});

describe("resolveOpenAssignments — a burst still transcribing", () => {
  it("holds the one transcribed upload rather than confirming it", async () => {
    const ctx = await resolveOpenAssignments(fakeDb(burstTables(1)));
    expect(ctx.confirm).toHaveLength(0);
    expect(ctx.review.map((r) => r.reason)).toEqual(["awaiting-siblings"]);
    expect(ctx.review[0].pendingSiblings).toBe(14);
    // Nothing is excluded yet — three transcripts are needed before the batch
    // is even visible, which is precisely why the hold has to exist.
    expect(ctx.trialVideoIds.size).toBe(0);
  });

  it("excludes the whole batch once it becomes visible", async () => {
    const ctx = await resolveOpenAssignments(fakeDb(burstTables(3)));
    expect(ctx.trialVideoIds.size).toBe(3);
    expect(ctx.confirm).toHaveLength(0);
    expect(ctx.review).toHaveLength(0);
  });
});

describe("matchScriptPosts — a burst still transcribing", () => {
  it("writes no assignment at all, and says why in the result", async () => {
    const writes: Write[] = [];
    const result = await matchScriptPosts(fakeDb(burstTables(1), writes));

    // The whole point: this state used to link a trial upload permanently.
    expect(writes.filter((w) => w.table === "research_script_assignments")).toEqual([]);
    expect(result.linked).toBe(0);
    expect(result.awaitingSiblings).toBe(1);
    expect(result.contested).toBe(0);
    expect(result.trialUploads).toBe(0);
    // The requeue still runs and still asks for the fourteen missing
    // transcripts — the hold is what buys the time for them to land.
    expect(result.requeuedForTranscription).toBe(14);
  });

  it("reports the excluded uploads once the batch is visible", async () => {
    const writes: Write[] = [];
    const result = await matchScriptPosts(fakeDb(burstTables(3), writes));
    expect(writes.filter((w) => w.table === "research_script_assignments")).toEqual([]);
    expect(result.linked).toBe(0);
    expect(result.review).toBe(0);
    expect(result.trialUploads).toBe(3);
  });
});
