# Niches as data, not a Python constant

**Date:** 2026-09-02
**Status:** draft — awaiting review

## Problem

The niche vocabulary lives in one dict in the pull worker:

```python
# worker/discord_pull_worker.py:172
TRACK_EMOJI_NICHES: dict[str, str] = {
    "✝️": "Christian",
    "🤍": "Female General Self-Improvement",
    "🌱": "General Motivation / Hustle",
}
```

That dict is the whole vocabulary. It drives channel classification
(`split_track_channel` → `classify_creator_channels`), `/onboard`'s channel
naming (`NICHE_CHANNEL_PREFIXES`), and the bot's track picker. Its own comment
says adding a niche means "adding ONE line here … and restarting the bot/worker"
— a code edit, a `fly deploy`, and a Discord gateway reconnect for what is a
piece of program configuration.

Three consequences are already visible in live data:

1. **The vocabulary has drifted from the data.** `research_scripts` carries
   `Finance General` (34 scripts) and `Girly Finance` (27) with no emoji and no
   entry in the dict, alongside a stray `Toxic / gym motivation` on one channel.
   There are two vocabularies: the dict, and whatever strings got written.
2. **The niche→role mapping is dead.** `DEFAULT_NICHE_ROLE_ID_PAIRS`
   (`worker/discord_bot/config.py:41`) is keyed by *category id*, and since
   categories became coach teams, two of its three keys are now the Will and
   Luke team categories. All three target role ids return `Unknown Role` (404)
   from the live guild. `/onboard` into Will's or Luke's team currently reports
   "niche role not found"; into the new Joey category it skips silently.
3. **The emoji is invisible in the app.** Discord channel names carry it
   (`🌱ethan-lau`), but every niche pill in the web app renders the bare name.

## Constraints

1. **The vocabulary can never be empty.** `classify_creator_channels` returns
   `[]` for an unknown emoji, and `cmd_discover` is upsert-only — it never
   deletes or untracks. So an empty niche list is not data loss, it is a
   *silent stall*: new channels quietly stop being discovered and nothing
   reports an error.
2. **`name` is a foreign key in spirit, not in schema.** The string is written
   verbatim into `research_scripts.niche`, `research_app_creators.niche` and
   `research_discord_channels.niche`. Renaming without moving those rows
   manufactures exactly the orphan that stranded Finance General.
3. **Discord slash-command choices are registered at startup.**
   `app_commands.choices` is a decorator evaluated once when the bot builds its
   command tree. Any design that leaves it in place still needs a bot restart
   to show a new niche, which defeats the purpose.
4. **Discord rate-limits channel updates to 2 per 10 minutes per channel.**
   Bulk-renaming channels is slow by construction and a repeated rename stalls.
5. **One gateway connection per token** (CLAUDE.md). Nothing here may add a
   second place that connects the bot token.

## Decisions

### `research_niches` — a table for the track vocabulary

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `name` | text not null unique | written verbatim to `*.niche` columns |
| `emoji` | text null | channel prefix and classifier key; null means the niche exists but does not participate in channel naming, and `/onboard` falls back to the `coaching-` prefix |
| `discord_role_id` | bigint null | assigned on `/onboard`, removed on `/offboard` |
| `is_active` | boolean not null default true | archive; never delete |
| `created_at` / `updated_at` | timestamptz | `set_updated_at()` from the bootstrap |

RLS: staff read/write via `is_staff()`; the service role bypasses it for the
workers.

**Seeded with exactly the three live emoji tracks.** The table is the *track
vocabulary* — niches that have an emoji and therefore participate in channel
naming and classification. It is deliberately NOT a registry of every niche
string ever written. The 61 finance scripts keep their free-text labels and
keep rendering, because the web app already derives its pill palette from
observed values rather than a fixed list.

**Archiving removes a niche from the picker, not from classification.**
`/onboard`'s track list and the settings default view show active niches only,
but `track_bases()` is built from *every* row, archived included. The
alternative fails constraint 1: archiving `Christian` would make every `✝️`
channel unclassifiable, so `cmd_discover` would silently stop discovering new
ones while existing rows sat unchanged and nothing reported an error.

**Emoji uniqueness is checked on the variation-selector-stripped base, across
all rows** — active and archived alike, since all of them classify. So `✝️` and
`✝` collide rather than both existing. `_TRACK_BASES` already matches that way;
two rows that classify identically would make discovery non-deterministic in a
way no error would report.

**Renaming cascades through a Postgres function.** `rename_niche(old, new)`
updates the three tables and returns the row counts. PostgREST cannot span
three table updates in one transaction, and a half-applied rename is the
failure this whole design exists to stop. A rename onto a name another niche
already holds is rejected by the unique constraint rather than silently merging
two niches' history.

### `worker/niches.py` — one module, cached, never empty

A new module rather than converting the constant in place. Today
`discord_bot/onboarding.py` does `import discord_pull_worker as pull` purely to
reach `TRACK_EMOJI_NICHES`: the bot imports the *pull worker* to read its own
configuration. A module with one job is testable on its own and ends that.

It exposes `load_niches()` (60s TTL), `track_bases()` (variation selectors
stripped, longest base first, so a multi-codepoint emoji can never be shadowed
by a shorter one), and `emoji_for(name)`.

**Fallback chain: live read → last good in-process list → hardcoded seed of
today's three.** Constraint 1 makes this non-negotiable — a Supabase blip must
degrade to a stale vocabulary, never to an empty one.

`split_track_channel` and `NICHE_CHANNEL_PREFIXES` become accessors over it.

### `/onboard`'s track becomes an autocomplete

The change that actually removes the restart. `track` moves off the
`app_commands.choices` decorator and onto an autocomplete callback, evaluated
per keystroke against the cached list. The `legacy` escape hatch stays.

`niche_role_ids` is deleted from `execute_onboarding` and the offboarding path;
the role is read off the niche record. `DEFAULT_NICHE_ROLE_ID_PAIRS` and the
`ONBOARD_NICHE_ROLE_IDS` override go with it.

### Web: a Niches card in /settings, emoji on every pill

`src/lib/niches.ts` owns one loader and one `name → emoji` map. `/settings`
gains a Niches card — emoji, name, role, active — with add, edit and archive
server actions. Niche pills on `/discord`, `/discord/[id]` and `/scripts`
render `🌱 General Motivation / Hustle`; a niche with no row renders exactly as
it does today.

### Discord channel renames are gated, never automatic

Changing an emoji in settings does **not** rewrite live channel names. It
surfaces "12 channels use `🌱` → Rename in Discord", previews every old→new
name, and renames only on confirm. It renames only channels whose current name
starts with the old emoji, reports per-channel success and failure, and never
retries in a loop.

Two reasons for the gate: constraint 4 makes a bulk rename slow and a repeat
rename a stall, and renaming 34 channels is visible to 34 creators.

It runs **from the web app over REST** (`src/lib/discord.ts` gains
`renameChannel`), not from the bot — the same reasoning CLAUDE.md already
records for coach digests: bot token, no gateway, so it cannot double-connect,
and a change ships with a Vercel deploy instead of a Discord reconnect.

## Data flow

```
/settings write ──► research_niches ──┬─► web pages read directly (pills)
                                      ├─► workers, cached 60s (classification)
                                      └─► /onboard autocomplete, live per keystroke
```

## Testing

- `worker/tests/test_niches.py` — TTL, fallback on read error, fallback on
  empty result, longest-base-first shadowing, variation-selector equivalence.
- `worker/tests/test_channels.py` — extended to drive `classify_creator_channels`
  off an injected niche list instead of the module constant.
- A TS test for the rename-cascade payload shaping.
- `npm run typecheck` · `npm test` · `py_compile` per CLAUDE.md's Verify section.

## Fixed alongside

- Three Joey's-Team channels have roster creators but no link, so they group
  under "no coach": `🌱lucas-graham`→`@lucasisdialed`,
  `🌱adam-ngyuen`→`@lifeofabga`, `🌱lyonel-concepcion`→`@lockedwithlyonel`.
- `DEFAULT_NICHE_ROLE_ID_PAIRS` / `ONBOARD_NICHE_ROLE_IDS` deleted as superseded.

## Out of scope

- **Coach categories.** Already fully dynamic — matched by `\bteam\b`, with the
  coach resolved by name from the live guild. `Coach: Joey's Team` was picked up
  with no code change; nothing to do.
- **Migrating the finance niches.** They stop at 2026-08-04 and look retired.
  Giving one an emoji in settings is how it comes back.
