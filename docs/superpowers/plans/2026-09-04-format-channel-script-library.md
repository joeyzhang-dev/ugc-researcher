# Format-Channel Script Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish scripts once to a shared format channel instead of sending them to each creator's channel, and let the matcher find who made what by niche scope rather than by assignment.

**Architecture:** A new `research_script_posts` table records each (script, channel) publication. Matching is unchanged at its core — `resolveScriptMatches` stays byte-for-byte the same — and instead receives *synthetic* open assignments built from published scripts crossed with niche-matching creators. Confirming a synthetic match INSERTs the assignment row that a send used to create up front, so the assignment changes tense from "I told you to make this" to "you made this".

**Tech Stack:** Next.js 15 server actions, Supabase (PostgREST + service role), vitest, Discord REST v10.

**Spec:** `docs/superpowers/specs/2026-09-04-format-channel-script-library-design.md`

## Global Constraints

- Migration filename format is `YYYYMMDDHHMMSS_description.sql`. The apply script enforces it. Apply with `node scripts/apply-migration.mjs supabase/migrations/<file>.sql`.
- **Discord snowflakes must be read as text.** `discord_channel_id` and `discord_message_id` are `bigint`; any select that reads one back must cast `::text`, or `JSON.parse` rounds it past 2^53.
- **Never lower `MATCH_AUTO_MIN` (0.5) or `MATCH_AUTO_MARGIN` (0.12).** The margin is the only thing preventing two near-identical scripts being silently swapped.
- **Do not modify the body of `resolveScriptMatches`.** Its global best-first settling is load-bearing. This plan only changes what is passed *into* it.
- Every table read that can exceed 1,000 rows must page — PostgREST silently caps at `db-max-rows`. `match-scripts.ts` already has a `page()` helper; use it.
- Per-creator sending (`sendScripts`) is NOT removed. The channel path is added beside it.
- Verify with `npm run typecheck` and `npm test`.

---

### Task 1: `research_script_posts` table and type

**Files:**
- Create: `supabase/migrations/20260904120000_script_posts.sql`
- Modify: `src/lib/types.ts` (append after `ResearchScriptAssignment`, around line 300)

**Interfaces:**
- Consumes: nothing
- Produces: table `research_script_posts`; type `ResearchScriptPost` with fields `id: string`, `script_id: string`, `discord_channel_id: string`, `channel_label: string`, `discord_message_id: string`, `posted_at: string`, `created_at: string`

- [ ] **Step 1: Write the migration**

```sql
-- Scripts published to a shared format channel, rather than sent to one
-- creator. One row per (script, channel) publication. A script may appear in
-- more than one channel (#broad alongside #gym), which is why this is a table
-- and not columns on research_scripts.
create table if not exists public.research_script_posts (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references public.research_scripts(id) on delete cascade,
  discord_channel_id bigint not null,
  -- Denormalised on purpose: channels get renamed, and the history should
  -- still read correctly afterwards.
  channel_label text not null,
  discord_message_id bigint not null,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Re-posting the same script to the same channel is a no-op, not a second card.
create unique index if not exists research_script_posts_script_channel_key
  on public.research_script_posts (script_id, discord_channel_id);

create index if not exists research_script_posts_script_idx
  on public.research_script_posts (script_id);

alter table public.research_script_posts enable row level security;

-- Same shape as the other research tables: staff read, service role writes.
create policy "research_script_posts staff read"
  on public.research_script_posts for select
  using (public.is_staff());
```

- [ ] **Step 2: Apply the migration**

Run: `node scripts/apply-migration.mjs supabase/migrations/20260904120000_script_posts.sql`
Expected: success, and the version recorded in `supabase_migrations.schema_migrations`.

- [ ] **Step 3: Add the type**

In `src/lib/types.ts`, after the `ResearchScriptAssignment` interface:

```ts
/**
 * A script published to a shared format channel (the `scripts / formats`
 * category). Distinct from an assignment: nobody is on the hook for it, and
 * the earliest posting is what date-proximity measures a post against.
 */
export interface ResearchScriptPost {
  id: string;
  script_id: string;
  /** Snowflake — always selected as ::text. */
  discord_channel_id: string;
  /** The channel's name at the moment of posting, e.g. "christian-10ways". */
  channel_label: string;
  /** Snowflake — always selected as ::text. */
  discord_message_id: string;
  posted_at: string;
  created_at: string;
}
```

- [ ] **Step 4: Verify the table exists and typechecks**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260904120000_script_posts.sql src/lib/types.ts
git commit -m "feat: research_script_posts — scripts published to format channels"
```

---

### Task 2: Niche-scoped virtual assignments (pure)

The heart of the change. Pure, unit-tested, no I/O.

**Files:**
- Modify: `src/lib/scripts.ts` (append; do not touch `resolveScriptMatches`)
- Test: `tests/script-matching.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `ResearchScript`, `ResearchScriptAssignment` from `@/lib/types`
- Produces:
  - `VIRTUAL_ASSIGNMENT_PREFIX = "virtual:"`
  - `virtualAssignmentId(scriptId: string, creatorId: string): string`
  - `isVirtualAssignmentId(id: string): boolean`
  - `parseVirtualAssignmentId(id: string): { scriptId: string; creatorId: string } | null`
  - `interface ScriptPosting { script_id: string; posted_at: string }`
  - `interface ScopedCreator { id: string; niche: string | null }`
  - `buildVirtualAssignments(scripts, postings, creators, existing): ResearchScriptAssignment[]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/script-matching.test.ts`. Note the file's existing `script()` helper takes `(id, hook, body)` and always sets `niche: null`; these tests need a niche, so build rows inline.

```ts
import {
  buildVirtualAssignments,
  isVirtualAssignmentId,
  parseVirtualAssignmentId,
  virtualAssignmentId,
} from "@/lib/scripts";

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- script-matching`
Expected: FAIL — `buildVirtualAssignments is not a function` (and the import errors).

- [ ] **Step 3: Implement in `src/lib/scripts.ts`**

Append to the end of the file:

```ts
/* --- library scripts: candidates without an assignment -------------------
 *
 * A script published to a format channel is not assigned to anyone. To keep
 * matching working we synthesise the pairs an assignment used to provide:
 * (published script) x (creator whose niche it fits). The resolver cannot
 * tell these from real open assignments, which is the point — its
 * best-first settling still arbitrates between them and the real ones.
 */

export const VIRTUAL_ASSIGNMENT_PREFIX = "virtual:";

/** uuids contain no colons, so this is unambiguous to parse back. */
export function virtualAssignmentId(scriptId: string, creatorId: string): string {
  return `${VIRTUAL_ASSIGNMENT_PREFIX}${scriptId}:${creatorId}`;
}

export function isVirtualAssignmentId(id: string): boolean {
  return id.startsWith(VIRTUAL_ASSIGNMENT_PREFIX);
}

export function parseVirtualAssignmentId(
  id: string
): { scriptId: string; creatorId: string } | null {
  if (!isVirtualAssignmentId(id)) return null;
  const [scriptId, creatorId] = id.slice(VIRTUAL_ASSIGNMENT_PREFIX.length).split(":");
  return scriptId && creatorId ? { scriptId, creatorId } : null;
}

/** One publication of a script to a channel — only what scoping needs. */
export interface ScriptPosting {
  script_id: string;
  posted_at: string;
}

/** A creator and the niche that decides which scripts they are a candidate for. */
export interface ScopedCreator {
  id: string;
  niche: string | null;
}

/**
 * Candidate (script, creator) pairs for every published script.
 *
 * A creator is a candidate when the script's niche matches theirs, or when the
 * script carries no niche at all — a null niche is what makes a script
 * universal, and is how #broad works without a schema for formats.
 *
 * `sent_at` is the EARLIEST posting: a script cross-posted to two channels was
 * available to the creator from the first one, and date proximity should
 * measure against when they could first have seen it.
 *
 * Creators who already hold a real assignment for a script are skipped, so a
 * script sent the old way and published the new way is never scored twice.
 */
export function buildVirtualAssignments(
  scripts: ResearchScript[],
  postings: ScriptPosting[],
  creators: ScopedCreator[],
  existing: ResearchScriptAssignment[]
): ResearchScriptAssignment[] {
  const firstPostingByScript = new Map<string, string>();
  for (const p of postings) {
    const seen = firstPostingByScript.get(p.script_id);
    if (!seen || p.posted_at < seen) firstPostingByScript.set(p.script_id, p.posted_at);
  }
  if (!firstPostingByScript.size) return [];

  const claimed = new Set(existing.map((a) => `${a.script_id}:${a.research_creator_id}`));
  const out: ResearchScriptAssignment[] = [];

  for (const s of scripts) {
    const sentAt = firstPostingByScript.get(s.id);
    if (!sentAt) continue;
    for (const c of creators) {
      if (s.niche !== null && s.niche !== c.niche) continue;
      if (claimed.has(`${s.id}:${c.id}`)) continue;
      out.push({
        id: virtualAssignmentId(s.id, c.id),
        script_id: s.id,
        research_creator_id: c.id,
        research_video_id: null,
        status: "Assigned",
        notes: null,
        assigned_at: sentAt,
        posted_at: null,
        discord_channel_id: null,
        discord_message_id: null,
        sent_at: sentAt,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- script-matching`
Expected: PASS, including all pre-existing `resolveScriptMatches` and `dateProximity` tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scripts.ts tests/script-matching.test.ts
git commit -m "feat: niche-scoped virtual assignments for published scripts"
```

---

### Task 3: Wire virtual pairs through the matcher

**Files:**
- Modify: `src/lib/jobs/match-scripts.ts` — `resolveOpenAssignments`, `applyMatches`, `requeueMatchCandidates`
- Modify: `src/app/(app)/scripts/actions.ts` — `linkAssignmentVideo` (manual confirm)
- Test: `tests/script-matching.test.ts` (one more case)

**Interfaces:**
- Consumes: `buildVirtualAssignments`, `isVirtualAssignmentId`, `parseVirtualAssignmentId`, `ScopedCreator`, `ScriptPosting` from Task 2; `ResearchScriptPost` from Task 1
- Produces: `applyMatches` handling both id kinds; `resolveOpenAssignments` returning a context whose `assignmentById` includes virtual rows

- [ ] **Step 1: Write the failing test for competing real and virtual pairs**

Append to `tests/script-matching.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- script-matching`
Expected: FAIL on the import of `buildVirtualAssignments` if Task 2 is not yet merged; otherwise PASS immediately (this test pins existing behaviour and may pass — that is acceptable, it is a regression guard).

- [ ] **Step 3: Load postings and creator niches in `resolveOpenAssignments`**

In `src/lib/jobs/match-scripts.ts`, add to the imports:

```ts
import {
  buildVirtualAssignments,
  isVirtualAssignmentId,
  parseVirtualAssignmentId,
  type ScopedCreator,
  type ScriptPosting,
} from "@/lib/scripts";
```

Inside `resolveOpenAssignments`, after the existing scripts/assignments/videos/creators loads, add:

```ts
  // Published scripts and the niche each creator is scoped by. Membership niche
  // wins, then any niche they hold — the same precedence buildSendTargets uses.
  const [postings, memberships] = await Promise.all([
    page<ScriptPosting>(db, "research_script_posts", "script_id, posted_at"),
    page<{ research_creator_id: string; niche: string | null }>(
      db,
      "research_app_creators",
      "research_creator_id, niche"
    ),
  ]);
  const nicheByCreator = new Map<string, string | null>();
  for (const m of memberships) {
    if (m.niche && !nicheByCreator.get(m.research_creator_id)) {
      nicheByCreator.set(m.research_creator_id, m.niche);
    }
  }
  const scoped: ScopedCreator[] = [...creatorById.values()].map((c) => ({
    id: c.id,
    niche: nicheByCreator.get(c.id) ?? null,
  }));
  const virtual = buildVirtualAssignments(scripts, postings, scoped, assignments);
```

Then pass `[...assignments, ...virtual]` where `assignments` is currently passed to `resolveScriptMatches`, and include the virtual rows in `assignmentById` so the review page can render them.

- [ ] **Step 4: Branch `applyMatches` on the id kind**

Replace the body of the `for (const m of matches)` loop in `applyMatches` (currently `src/lib/jobs/match-scripts.ts:165-185`) with:

```ts
  for (const m of matches) {
    const postedAt = videoById.get(m.videoId)?.posted_at ?? new Date().toISOString();
    const virtual = parseVirtualAssignmentId(m.assignmentId);

    // A published script has no assignment row until someone is shown to have
    // made it — the row is the OUTPUT of matching here, not its input.
    const { error } = virtual
      ? await db.from("research_script_assignments").insert({
          script_id: virtual.scriptId,
          research_creator_id: virtual.creatorId,
          research_video_id: m.videoId,
          status: "Posted",
          assigned_at: postedAt,
          posted_at: postedAt,
        })
      : await db
          .from("research_script_assignments")
          .update({ research_video_id: m.videoId, status: "Posted", posted_at: postedAt })
          .eq("id", m.assignmentId)
          // Never overwrite a link a human already made.
          .is("research_video_id", null);

    if (error) {
      // The partial unique index (one video backs one assignment) is what stops
      // two confirmations claiming one video. A wider candidate set makes this
      // collision MORE likely, not less — count it, never throw.
      if (error.code === "23505") conflicts++;
      else throw new Error(error.message);
      continue;
    }
    linked++;
  }
```

- [ ] **Step 5: Extend `requeueMatchCandidates` to virtual pairs**

In `requeueMatchCandidates`, build the same virtual pairs and concatenate them with the real assignments before the existing "which videos could settle this" scan. The date radius must stay applied — this is the one place a wider candidate set spends real money on Whisper calls.

```ts
  // Same scope the resolver uses, so requeueing and matching agree on what is
  // still open. MATCH_DATE_RADIUS_DAYS stays applied: without it a wider
  // candidate set would requeue the entire back catalogue for transcription.
  const open = [...assignments, ...virtual].filter((a) => !a.research_video_id);
```

- [ ] **Step 6: Fix the manual confirm path — it silently no-ops on a virtual id**

`linkAssignmentVideo` in `src/app/(app)/scripts/actions.ts:112` links by
`.eq("id", assignmentId)`. Given a `virtual:` id that UPDATE matches **zero rows
and returns no error**, so the button on /scripts/review would appear to work
and change nothing. This is the hand-confirm path for exactly the contested
pairs the auto-matcher refused, so it cannot be left broken.

Add near the top of the function, after `const db = createAdminClient();`:

```ts
  // A published script has no assignment row until someone is shown to have
  // made it. An UPDATE by id would match nothing here and report success.
  const virtual = parseVirtualAssignmentId(assignmentId);
  if (virtual) {
    if (!videoId) redirect("/scripts/review"); // nothing to unlink yet
    const { error: insertError } = await db.from("research_script_assignments").insert({
      script_id: virtual.scriptId,
      research_creator_id: virtual.creatorId,
      research_video_id: videoId,
      status: "Posted",
      assigned_at: postedAt,
      posted_at: postedAt,
    });
    if (insertError) {
      fail(
        insertError.code === "23505"
          ? "That post is already linked to another script."
          : insertError.message
      );
    }
    revalidatePath("/scripts");
    revalidatePath("/scripts/review");
    redirect("/scripts/review?status=Linked");
  }
```

Import `parseVirtualAssignmentId` from `@/lib/scripts`. Move the `postedAt`
lookup above this block so both paths share it.

- [ ] **Step 7: Confirm one virtual pair by hand in the browser**

Open `/scripts/review`, find an item whose assignment id starts with `virtual:`,
click its link button, and verify a new `research_script_assignments` row exists
for that (script, creator, video). Re-clicking must report the already-linked
error, not create a second row.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 9: Dry-run the matcher against live data and read the counts**

Run: `curl -s localhost:3005/api/jobs/research -X POST -H "authorization: Bearer $(grep '^CRON_SECRET=' .env.local | cut -d= -f2-)" -H 'content-type: application/json' -d '{"action":"match-scripts"}'`
Expected: a JSON result. **Check `review` and `contested` against the pre-change baseline** — the spec predicts the queue grows. If `linked` jumps by hundreds, stop and investigate before committing: that would mean the margin is not holding.

- [ ] **Step 10: Commit**

```bash
git add src/lib/jobs/match-scripts.ts "src/app/(app)/scripts/actions.ts" tests/script-matching.test.ts
git commit -m "feat: match published scripts by niche scope, insert on confirm"
```

---

### Task 4: List the format channels from Discord

**Files:**
- Modify: `src/lib/discord.ts` (add `position` to `GuildChannel`, around line 62)
- Create: `src/lib/format-channels.ts`

**Interfaces:**
- Consumes: `listGuildChannels`, `GuildChannel` from `@/lib/discord`
- Produces: `FORMAT_CATEGORY = "scripts / formats"`; `listFormatChannels(): Promise<FormatChannel[]>` where `interface FormatChannel { id: string; name: string }`

- [ ] **Step 1: Add `position` to `GuildChannel`**

In `src/lib/discord.ts`:

```ts
export interface GuildChannel {
  id: string;
  /** 0 text, 4 category. */
  type: number;
  name: string;
  parent_id: string | null;
  /** Discord's display order within the category. */
  position?: number;
}
```

- [ ] **Step 2: Create `src/lib/format-channels.ts`**

```ts
/* The `scripts / formats` category: where published scripts land.
 *
 * Read live from Discord rather than from a stored id, for the same reason the
 * niche rename controls do — a category that was renamed or recreated must not
 * silently stop resolving, leaving a picker that looks fine and posts nowhere.
 */
import { listGuildChannels } from "@/lib/discord";

export const FORMAT_CATEGORY = "scripts / formats";

export interface FormatChannel {
  id: string;
  name: string;
}

/** Text channels under the format category, in Discord's own display order. */
export async function listFormatChannels(): Promise<FormatChannel[]> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return [];
  const all = await listGuildChannels(guildId);
  const category = all.find(
    (c) => c.type === 4 && c.name.trim().toLowerCase() === FORMAT_CATEGORY
  );
  if (!category) return [];
  return all
    .filter((c) => c.type === 0 && c.parent_id === category.id)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name))
    .map((c) => ({ id: c.id, name: c.name }));
}
```

- [ ] **Step 3: Verify against the live guild**

Run:
```bash
npx tsx -e "import('./src/lib/format-channels.ts').then(async m => console.log(await m.listFormatChannels()))"
```
Expected: the seven channels from the category — `broad`, `gym`, `dating`, `college`, `finance`, `christian-4things`, `christian-10ways`. If the array is empty, the category name does not match `FORMAT_CATEGORY` — print `listGuildChannels` output and correct the constant rather than loosening the match.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/discord.ts src/lib/format-channels.ts
git commit -m "feat: list text channels under the scripts / formats category"
```

---

### Task 5: `sendScriptsToChannel` server action

**Files:**
- Modify: `src/app/(app)/scripts/send-actions.ts` (append; leave `sendScripts` untouched)

**Interfaces:**
- Consumes: `listFormatChannels` (Task 4); existing `scriptNumbering`, `inspoCache`, `postPage`, `toSendable` in the same file
- Produces: `interface ChannelSendReport { channel: string; posted: number; alreadyPosted: number; error?: string }`; `sendScriptsToChannel(input: { scriptIds: string[]; channelId: string }): Promise<ChannelSendReport>`

- [ ] **Step 1: Append the action**

```ts
export interface ChannelSendReport {
  channel: string;
  /** Cards actually posted in this run. */
  posted: number;
  /** Skipped because this script is already in this channel. */
  alreadyPosted: number;
  error?: string;
}

/**
 * Publish a batch of scripts to one format channel.
 *
 * No creator loop, no assignments, no ping: the card is a library entry, and
 * whoever wants it takes it. The research_script_posts row is the record, and
 * its unique index is the dedupe — re-running is a no-op per script.
 */
export async function sendScriptsToChannel(input: {
  scriptIds: string[];
  channelId: string;
}): Promise<ChannelSendReport> {
  await requireAdmin();
  if (!discordConfigured()) {
    return { channel: input.channelId, posted: 0, alreadyPosted: 0,
      error: "DISCORD_BOT_TOKEN is not set in .env.local — add it and retry." };
  }
  const scriptIds = [...new Set(input.scriptIds)].filter(Boolean);
  if (!scriptIds.length || !input.channelId) {
    return { channel: input.channelId, posted: 0, alreadyPosted: 0,
      error: "Pick at least one script and a channel." };
  }

  const channels = await listFormatChannels();
  const channel = channels.find((c) => c.id === input.channelId);
  if (!channel) {
    return { channel: input.channelId, posted: 0, alreadyPosted: 0,
      error: "That channel isn't under the scripts / formats category any more." };
  }

  const db = createAdminClient();
  const [{ data: scriptsData }, { data: postedData }] = await Promise.all([
    db.from("research_scripts").select("*").in("id", scriptIds),
    // ::text — a snowflake read as a JS number rounds past 2^53 and would
    // compare unequal to the id we are about to post to.
    db
      .from("research_script_posts")
      .select("script_id, discord_channel_id::text")
      .in("script_id", scriptIds),
  ]);

  const already = new Set(
    ((postedData ?? []) as { script_id: string; discord_channel_id: string }[])
      .filter((p) => String(p.discord_channel_id) === input.channelId)
      .map((p) => p.script_id)
  );
  const scripts = ((scriptsData ?? []) as ResearchScript[])
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const batch = scripts.filter((s) => !already.has(s.id));
  if (!batch.length) {
    return { channel: channel.name, posted: 0, alreadyPosted: scripts.length };
  }

  const numbering = await scriptNumbering(db);
  const sendable: SendableScript[] = batch.map((s) => ({
    ...toSendable(s),
    number: numbering.get(s.id) ?? null,
  }));

  const inspoFor = inspoCache();
  let posted = 0;
  try {
    for (let i = 0; i < sendable.length; i++) {
      // No header and no mention: a library entry pings nobody.
      const messageId = await postPage(input.channelId, sendable, i, {
        videoUrl: await inspoFor(sendable[i]),
        paged: false,
        header: null,
        mentionUserId: null,
      });
      const { error } = await db.from("research_script_posts").insert({
        script_id: batch[i].id,
        discord_channel_id: input.channelId,
        channel_label: channel.name,
        discord_message_id: messageId,
        posted_at: new Date().toISOString(),
      });
      // 23505 means it was already published here — the card is a duplicate we
      // just posted, but the record stands; do not fail the batch over it.
      if (error && error.code !== "23505") {
        throw new Error(`posted, but recording it failed: ${error.message}`);
      }
      posted++;
    }
  } catch (e) {
    return {
      channel: channel.name, posted, alreadyPosted: already.size,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  revalidatePath("/scripts");
  return { channel: channel.name, posted, alreadyPosted: already.size };
}
```

Add to the file's imports: `import { listFormatChannels } from "@/lib/format-channels";`

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Verify against the test channel first**

Post one script to `DISCORD_TEST_CHANNEL_ID` before touching a real format channel. Confirm the card renders, then confirm a second run reports `posted: 0, alreadyPosted: 1` and posts no duplicate.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/scripts/send-actions.ts"
git commit -m "feat: publish scripts to a format channel with no assignments"
```

---

### Task 6: Channel picker in the send bar

**Files:**
- Modify: `src/app/(app)/scripts/send-bar.tsx`
- Modify: `src/app/(app)/scripts/page.tsx` (pass `formatChannels` down)

**Interfaces:**
- Consumes: `sendScriptsToChannel`, `ChannelSendReport` (Task 5); `FormatChannel`, `listFormatChannels` (Task 4)
- Produces: `SendBar` accepting an added prop `formatChannels: FormatChannel[]`

- [ ] **Step 1: Load channels in the page server component**

In `src/app/(app)/scripts/page.tsx`, alongside the existing send-target load:

```tsx
import { listFormatChannels } from "@/lib/format-channels";
// ...
const formatChannels = await listFormatChannels().catch(() => []);
```

Pass `formatChannels={formatChannels}` to `SendBar`. The `.catch(() => [])` matters: Discord being unreachable must degrade the picker, never take `/scripts` down.

- [ ] **Step 2: Add the mode toggle to `SendBar`**

Both send paths stay. Add to the component's state:

```tsx
const [mode, setMode] = useState<"creators" | "channel">("channel");
const [channelId, setChannelId] = useState<string>("");
const [channelReport, setChannelReport] = useState<ChannelSendReport | null>(null);
```

Render a two-button toggle above the picker. When `mode === "creators"` render the existing `CreatorPicker` and Send button unchanged. When `mode === "channel"` render a `<select>` of `formatChannels` and a Publish button calling:

```tsx
startTransition(async () => {
  setChannelReport(await sendScriptsToChannel({ scriptIds, channelId }));
});
```

Report line: `Posted {posted} to #{channel}` plus `{alreadyPosted} already there` when non-zero, and the error string when present.

Default `mode` to `"channel"` — that is the new workflow — but leave the creator path one click away.

- [ ] **Step 3: Verify in the browser**

Use `preview_start` (the dev server may already be running on :3005), select two scripts on `/scripts`, and confirm: the toggle switches pickers, the channel list shows the seven channels, publishing reports counts, and re-publishing the same pair reports `alreadyPosted: 2` and `posted: 0`.

- [ ] **Step 4: Typecheck, test, commit**

```bash
npm run typecheck && npm test
git add "src/app/(app)/scripts/send-bar.tsx" "src/app/(app)/scripts/page.tsx"
git commit -m "feat: publish-to-channel mode in the scripts send bar"
```

---

### Task 7: Document the new model in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the **Script matching** section)

- [ ] **Step 1: Rewrite the opening of Script matching**

The section currently opens by asserting every number on /scripts comes from `research_script_assignments.research_video_id` set by a send. That is still true of the *column*, but no longer of how the row is born. Add, after the existing first paragraph:

```markdown
**Since 2026-09-04 an assignment can also be the OUTPUT of matching rather than
its input.** Scripts published to a channel under the `scripts / formats`
category (`research_script_posts`) are assigned to nobody. `buildVirtualAssignments`
synthesises (script, creator) candidates from niche scope — a script's niche
matching the creator's, or a **null niche, which makes it universal and is the
only thing that makes `#broad` work**. Confirming such a match INSERTs the
assignment row. Creators already holding a real assignment for that script are
skipped, so nothing is scored twice.

The candidate set is much wider than a creator's open assignments, so expect
/scripts/review to carry more. That is the designed failure mode —
`MATCH_AUTO_MIN` and `MATCH_AUTO_MARGIN` still gate on the words alone. Do not
lower the margin to drain the queue.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record scripts-as-library in the Script matching section"
```

---

## Self-Review

**Spec coverage:** table (T1), virtual pairs + niche scope + earliest-posting anchor (T2), resolver wiring + insert-on-confirm + requeue scope (T3), channel listing (T4), send path with no ping and unique-index dedupe (T5), send UI (T6), CLAUDE.md (T7). Coexistence is covered by T2's "no double-scoring" test and T3 passing real and virtual assignments together. The deferred notification question is explicitly out of scope in the spec and has no task, correctly.

**Type consistency:** `buildVirtualAssignments` / `virtualAssignmentId` / `isVirtualAssignmentId` / `parseVirtualAssignmentId` / `ScriptPosting` / `ScopedCreator` are defined in T2 and used with the same names in T3. `FormatChannel` / `listFormatChannels` / `FORMAT_CATEGORY` defined in T4, used in T5 and T6. `ChannelSendReport` defined in T5, used in T6. `ResearchScriptPost` (T1) is the row shape T5 inserts.

**Review-queue path, verified not assumed:** `/scripts/review` renders candidates from `assignmentById` (virtual rows are put there in T3 step 3), but its per-item button calls `linkAssignmentVideo`, which links with `.eq("id", assignmentId)`. Checked against the source: given a `virtual:` id that UPDATE matches zero rows **and returns no error**, so the button would silently do nothing. T3 steps 6-7 fix and verify it. This is the hand-confirm path for precisely the contested pairs the auto-matcher refuses, so it is load-bearing rather than cosmetic.

**Files touched by T3** are therefore `src/lib/jobs/match-scripts.ts` AND `src/app/(app)/scripts/actions.ts`.
