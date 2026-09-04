import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveOpenAssignments } from "@/lib/jobs/match-scripts";
import { virtualAssignmentId } from "@/lib/scripts";
import type { ResearchCreator, ResearchScript } from "@/lib/types";

/**
 * A minimal stand-in for the Supabase client, covering exactly the
 * `.from(table).select(cols).range(from, to)` shape `page()`/`pageOptional()`
 * use in src/lib/jobs/match-scripts.ts. Every table not listed answers empty.
 */
function fakeDb(tables: Record<string, unknown[] | { error: { code: string; message: string } }>): SupabaseClient {
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
