# Scripts as a library in format channels

**Date:** 2026-09-04
**Status:** approved design, not yet implemented

## The change

Scripts stop being *handed to people* and become *published to channels*.

Today `sendScripts` loops over picked creators, resolves each one's coaching
channel, posts a card there, and writes a `research_script_assignments` row per
(script, creator). Tomorrow it posts one card to one channel under the
`scripts / formats` category — `#broad`, `#gym`, `#dating`, `#college`,
`#finance`, `#christian-4things`, `#christian-10ways` — and writes nothing
per-creator. Any creator can read any channel and film whatever they like.

Four decisions fix the shape, all made 2026-09-04:

- **Library, no assignments at send time.** Nobody is on the hook for a
  specific script.
- **Channels are open to everyone.** No roles, no membership table. Matching
  scopes by the creator's niche instead.
- **A channel is a bucket, not a schema.** Its name is free text stored on the
  posting. `research_niches` is not touched and no `format` column is added.
- **The app posts**, from the existing /scripts send bar, with a channel picker
  where the creator picker is now.

## The reframe that makes this cheap

The assignment row does not disappear. It changes tense.

Today an assignment is written when a script is **sent** and means *"I told you
to make this"*. It is the **input** to matching: `resolveScriptMatches` walks
open assignments and tries to find each one's video.

Under this design an assignment is written when a match is **confirmed** and
means *"you made this"*. It is the **output** of matching.

That single change is why the blast radius is small. Every consumer of
assignments that reports on *what happened* keeps working untouched:

- `/scripts` per-script post counts
- `/scripts/[id]`
- the public creator portal `/c/[token]` — a creator's scripts become the ones
  they actually made, which is a truer list than the one they were assigned
- the bot's `/creator` command and script pager
- the partial unique index (one video backs one assignment), which keeps doing
  exactly the job it does now

Only the three things that read assignments as a *to-do list* need work:
`resolveScriptMatches`'s candidate set, `applyMatches`'s write, and
`requeueMatchCandidates`'s scope.

The `sent_at` / `discord_channel_id` / `discord_message_id` columns on
assignments simply go unused for library-sourced rows. They are not dropped —
1,000 legacy rows still carry meaningful values there.

## Schema

One new table. Approach B from the brainstorm; a script can be posted to more
than one channel (`#broad` alongside `#gym`) and can be re-posted after an edit
without losing the first posting.

```sql
create table research_script_posts (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references research_scripts(id) on delete cascade,
  discord_channel_id bigint not null,
  channel_label text not null,      -- '#christian-10ways' as it read when posted
  discord_message_id bigint not null,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index research_script_posts_script_channel_key
  on research_script_posts (script_id, discord_channel_id);
```

`channel_label` is denormalised on purpose. Channels get renamed (see the niche
rename machinery); the label records what the channel was called at the moment
of posting, so the history stays readable afterwards.

The unique index is the dedupe: re-posting the same script to the same channel
is a no-op rather than a second card. Re-posting after an *edit* is a deliberate
delete-then-post, not an accident.

**Snowflakes are bigints and must be read as `::text`.** Both id columns here
are subject to the rule in CLAUDE.md — `JSON.parse` turns
`1335356398049038400` into `…038300`. Every select that reads them back for a
Discord call casts.

## Matching

`resolveScriptMatches` is pure, unit-tested, and its global best-first settling
is load-bearing — a partial unique index means one video backs one assignment,
so resolving assignments independently lets whichever runs first claim a video
the next one wanted more. **Do not touch the scoring core.**

Instead, feed it synthetic candidate pairs.

A *virtual assignment* is a (script, creator) pair the resolver treats exactly
like a real open assignment:

```ts
{
  id: `virtual:${scriptId}:${creatorId}`,
  script_id, research_creator_id,
  research_video_id: null,
  status: "Assigned",
  sent_at: <earliest posted_at across that script's research_script_posts>,
}
```

Built for every (script, creator) where:

- the script has at least one `research_script_posts` row (it was published),
- the script has no *real* assignment for that creator already (legacy rows win
  — no double-counting),
- and the creator is in scope by niche.

**Niche scope.** A creator is a candidate for a script when the script's
`niche` equals the creator's niche, **or the script's `niche` is null**. A
null-niche script is universal — that is how `#broad` works without a schema
for it. Creator niche resolves the way `buildSendTargets` already does it:
workspace membership niche, then any membership niche, then the channel's.

**This has a workflow consequence worth stating plainly: today exactly 1 of 146
scripts has a null niche.** The universal path has essentially no data behind it
yet. Publishing to `#broad` means *leaving the niche blank on the script* — that
is the only thing that makes it universal, and nothing validates it. A script
written for `#broad` but tagged `Christian` will only ever be a candidate for
Christian creators, and nothing will look broken.

If that proves to be a foot-gun in practice, the fix is a channel→niche default
applied at send time, not a schema change. Not building it now — it is
speculation until the workflow has been used.

`sent_at` from the earliest posting is what keeps date proximity working, and
it gets *stronger* here than it is today: a channel posting is a real publish
moment, so the `posted-before-send` rule ("a script cannot have produced a video
that already existed when it was written") has a firmer anchor than a per-creator
send stamp.

### `applyMatches` branches on the id

```
real id      → UPDATE the assignment (today's path, unchanged)
virtual:...  → INSERT a new assignment carrying script, creator, video,
               status 'Posted', posted_at from the video
```

The insert must tolerate `23505` the same way the update does — the partial
unique index is what stops two confirmations claiming one video, and under a
wider candidate set that collision gets *more* likely, not less. Count it as a
conflict, do not throw.

### `requeueMatchCandidates`

Currently finds untranscribed videos that could settle an open assignment,
scoped by the assignment's creator and `MATCH_DATE_RADIUS_DAYS` around
`sent_at`. It gains the virtual pairs on the same terms. Watch the volume: this
is the one place a wider candidate set costs real money (Whisper calls), so the
date radius must stay applied, not widened.

## What gets worse, deliberately

**The review queue gets busier.** Today a creator's transcripts are scored
against roughly 15 open assignments. Under niche scope it is every script in
their niche plus every null-niche one — 60–80 of the current 146.

This is the accepted cost. The failure mode is *more rows in `/scripts/review`*,
not silent mislabeling, because `MATCH_AUTO_MIN` (0.5) still gates on raw text
score and `MATCH_AUTO_MARGIN` (0.12) still requires beating the nearest rival.

**Do not lower the margin to drain the queue.** It is the whole safety story;
CLAUDE.md records a live pair scoring 0.97 and 0.91 for the same post. If the
queue is unmanageable the answer is tightening niche scope, not loosening the
guard.

**You lose "did Jas do the script I gave her?"** Inherent to the library model,
not a defect. The replacement accountability signal is the quota the coach
digest already tracks (7 posts/week), which does not care which script was used.

## What is explicitly untouched

Verified by grep, 2026-09-04: `src/lib/performance.ts`,
`src/lib/jobs/performance.ts`, `src/lib/jobs/coach-digest.ts` and
`src/lib/jobs/creator-digest.ts` contain **no** reference to assignments. The
CPM math, `/performance`, `/coach`, the Monday coach digest and the daily
creator recap are unaffected by everything in this document.

## Coexistence

No migration, no backfill, no cutover.

The 1,311 existing assignments (805 Assigned, 506 Posted, 0 Skipped; 423 carry
`sent_at`, 506 are linked to a video) stay exactly as they are. Note that 805
open assignments across only 146 scripts means the "no real assignment already"
test suppresses a large share of virtual pairs on day one — the candidate set
grows gradually as new library-only scripts are published, rather than jumping
the moment this ships.

The matcher reads both sources: real open assignments
keep resolving on today's rules, published scripts additionally generate virtual
pairs. A script that was sent the old way and published the new way is covered
by its real assignments first — the "no real assignment already" test above is
what prevents a creator being scored twice against the same script.

Per-creator sending is **not removed**. `sendScripts` keeps working for the
cases that still want it; the channel send is a second path beside it, not a
replacement. Deleting the old path is a later decision to make once the new one
has run for a few weeks.

## Send UI

`/scripts` send bar: the creator picker becomes a channel picker listing text
channels under the `scripts / formats` category, read live from Discord the way
the niche rename controls read live channels rather than trusting a stored
value.

No ping. `allowed_mentions` stays empty. Cards render exactly as they do now —
`buildScriptPage` is unchanged, and the inspo video still resolves to a public
storage URL rather than a Discord upload.

**Open, deferred:** with no ping, how does a creator learn a script landed?
v1 ships with nothing — they browse. The cheapest follow-up is a line in the
daily recap that already posts to their own channel. Deferred rather than
decided, because it is reversible and independent of everything above.

## Testing

`src/lib/scripts.ts` is pure and already has `tests/script-matching.test.ts`;
the new logic belongs there, not in integration tests.

- virtual pairs are generated only for published scripts
- a script with a real assignment for a creator generates no virtual pair for
  that creator (no double-scoring)
- a null-niche script is a candidate for every creator; a niched one only for
  matching creators
- `sent_at` comes from the earliest posting when a script sits in two channels
- `posted-before-send` still fires against a virtual pair's anchor
- global best-first settling still holds when real and virtual pairs compete
  for one video — the case the margin exists for
- `applyMatches` inserts for a virtual id, updates for a real one, and counts
  `23505` as a conflict on both paths

## Files

| File | Change |
|---|---|
| `supabase/migrations/2026*_script_posts.sql` | new table + index |
| `src/lib/types.ts` | `ResearchScriptPost` |
| `src/lib/scripts.ts` | virtual pair construction, niche scope |
| `src/lib/jobs/match-scripts.ts` | load postings, build pairs, branch `applyMatches` |
| `src/app/(app)/scripts/send-actions.ts` | `sendScriptsToChannel` beside `sendScripts` |
| `src/app/(app)/scripts/send-bar.tsx` | channel picker |
| `src/lib/discord-channels.ts` | list channels under a category |
| `tests/script-matching.test.ts` | the cases above |
