# Dynamic Niches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the niche track vocabulary out of the `TRACK_EMOJI_NICHES` dict in the pull worker into a `research_niches` table that Joey manages from /settings, read by both Python workers through a cached accessor that can go stale but never empty.

**Architecture:** One table (`research_niches`) plus one Postgres function (`rename_niche`) are the source of truth. Python reads it through a new `worker/niches.py` with a 60s TTL and a three-step fallback chain; `/onboard`'s track option moves from a startup-time `app_commands.choices` decorator to a runtime autocomplete so a new niche needs no bot restart. The web app reads the same table for its niche pills and for the settings CRUD, and performs gated Discord channel renames over REST (no gateway).

**Tech Stack:** Next.js 15 (App Router, server actions), Supabase/PostgREST, vitest, Python 3 stdlib + discord.py, unittest.

**Spec:** `docs/superpowers/specs/2026-09-02-dynamic-niches-design.md`

## Global Constraints

- **The vocabulary can never be empty.** `classify_creator_channels` returns `[]` for an unknown emoji and `cmd_discover` is upsert-only, so an empty niche list is a silent discovery stall, not a visible failure. Fallback chain is mandatory: live read → last good in-process list → hardcoded seed.
- **Archiving removes a niche from the picker, not from classification.** `track_bases()` is built from every row, archived included; only `/onboard`'s list filters on `is_active`.
- **Emoji uniqueness is enforced on the variation-selector-stripped base, across all rows** (active and archived), so `✝️` and `✝` collide.
- **Discord snowflakes must be read as text.** Any select of `discord_role_id` casts `::text`; `JSON.parse` turns a bigint into an IEEE double and corrupts the low digits.
- **Migrations are named `YYYYMMDDHHMMSS_description.sql`** and applied with `node scripts/apply-migration.mjs supabase/migrations/<file>.sql`.
- **Never run the bot in two places**, and nothing here may open a second gateway connection — web-app Discord calls go over REST via `src/lib/discord.ts`.
- Verify commands: `npm run typecheck` · `npm test` · `python3 -m unittest discover worker/tests` · `python3 -m py_compile worker/discord_pull_worker.py worker/niches.py` · `worker/.venv/bin/python -m py_compile worker/discord_bot/*.py`

---

### Task 1: The `research_niches` table

**Files:**
- Create: `supabase/migrations/20260903120000_research_niches.sql`

**Interfaces:**
- Produces: table `public.research_niches (id uuid, name text, emoji text, discord_role_id bigint, is_active boolean, created_at timestamptz, updated_at timestamptz)`; function `public.niche_emoji_base(text) returns text`; function `public.rename_niche(old_name text, new_name text) returns table (scripts int, memberships int, channels int)`.

- [ ] **Step 1: Write the migration**

```sql
-- The niche track vocabulary, as data.
--
-- Until now this lived in one dict in the pull worker
-- (TRACK_EMOJI_NICHES), so adding a niche meant a code edit, a fly deploy and
-- a Discord gateway reconnect. It had already drifted from the data: 61
-- scripts carry 'Finance General' / 'Girly Finance', which the dict has never
-- heard of.
--
-- This table is the TRACK vocabulary — niches that own an emoji and therefore
-- participate in channel naming and classification. It is deliberately not a
-- registry of every niche string ever written; free-text values keep
-- rendering, because the app derives its pill palette from observed values.

create table if not exists public.research_niches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  emoji text,
  discord_role_id bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.research_niches is
  'Niche tracks: the emoji that prefixes a creator channel, the name written '
  'verbatim into research_scripts.niche, and the Discord role /onboard grants.';
comment on column public.research_niches.emoji is
  'Channel prefix and classifier key. Null means the niche exists but does '
  'not participate in channel naming — /onboard falls back to coaching-.';
comment on column public.research_niches.is_active is
  'Archived niches drop out of /onboard''s picker but STILL classify existing '
  'channels: dropping them from classification would silently stop discovery '
  'for every channel on that emoji.';

-- Case-insensitive, so 'Christian' and 'christian' cannot both exist and
-- write two different strings into research_scripts.niche.
create unique index if not exists research_niches_name_key
  on public.research_niches (lower(name));

-- Emoji equality ignores the variation selector (U+FE0F) and ZWJ (U+200D),
-- which is exactly how _TRACK_BASES matches: ✝️ and ✝ classify identically,
-- so two rows holding them would make discovery non-deterministic with
-- nothing reporting an error.
create or replace function public.niche_emoji_base(emoji text)
returns text language sql immutable as $$
  select nullif(translate(coalesce(emoji, ''), chr(65039) || chr(8205), ''), '')
$$;

create unique index if not exists research_niches_emoji_base_key
  on public.research_niches (public.niche_emoji_base(emoji))
  where public.niche_emoji_base(emoji) is not null;

drop trigger if exists research_niches_set_updated_at on public.research_niches;
create trigger research_niches_set_updated_at
  before update on public.research_niches
  for each row execute function public.set_updated_at();

alter table public.research_niches enable row level security;

drop policy if exists research_niches_staff_read on public.research_niches;
create policy research_niches_staff_read on public.research_niches
  for select using (public.is_staff());

drop policy if exists research_niches_admin_write on public.research_niches;
create policy research_niches_admin_write on public.research_niches
  for all using (public.is_admin()) with check (public.is_admin());

-- A rename has to move the rows that carry the name, or it manufactures the
-- orphan that stranded Finance General. PostgREST cannot span three table
-- updates in one transaction; a function can. The research_niches update goes
-- last so a collision with an existing niche rolls the whole thing back
-- rather than merging two niches' history.
create or replace function public.rename_niche(old_name text, new_name text)
returns table (scripts int, memberships int, channels int)
language plpgsql security definer set search_path = public as $$
declare
  s int; m int; c int;
begin
  update research_scripts set niche = new_name where niche = old_name;
  get diagnostics s = row_count;

  update research_app_creators set niche = new_name where niche = old_name;
  get diagnostics m = row_count;

  update research_discord_channels set niche = new_name where niche = old_name;
  get diagnostics c = row_count;

  update research_niches set name = new_name where name = old_name;

  return query select s, m, c;
end $$;

-- Service role only. The web app authorizes with requireAdmin() before it
-- calls this, exactly as saveScrapeSettings does — and an in-function
-- is_admin() check would REJECT that call, because the admin client is the
-- service role and auth.uid() is null there. Granting to `authenticated`
-- instead would let any signed-in creator rewrite three tables.
revoke execute on function public.rename_niche(text, text) from public;
grant execute on function public.rename_niche(text, text) to service_role;

-- Seed: exactly the three live emoji tracks. Finance General, Girly Finance
-- and 'Toxic / gym motivation' are deliberately NOT seeded — they stop at
-- 2026-08-04 and read as retired. Giving one an emoji in /settings is how it
-- comes back.
insert into public.research_niches (name, emoji) values
  ('Christian', '✝️'),
  ('Female General Self-Improvement', '🤍'),
  ('General Motivation / Hustle', '🌱')
on conflict do nothing;
```

- [ ] **Step 2: Apply it**

Run: `node scripts/apply-migration.mjs supabase/migrations/20260903120000_research_niches.sql`
Expected: success, and the version recorded in `supabase_migrations.schema_migrations`.

- [ ] **Step 3: Verify the seed and the constraints landed**

```bash
node -e '
const fs=require("fs");
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,"")];}));
const H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
(async()=>{
  const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/research_niches?select=name,emoji,is_active&order=name`,{headers:H});
  console.log(await r.text());
})();
'
```
Expected: three rows — Christian ✝️, Female General Self-Improvement 🤍, General Motivation / Hustle 🌱, all `is_active: true`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260903120000_research_niches.sql
git commit -m "feat: research_niches table, emoji-base uniqueness and rename_niche()"
```

---

### Task 2: `worker/niches.py` — cached, never empty

**Files:**
- Create: `worker/niches.py`
- Test: `worker/tests/test_niches.py`

**Interfaces:**
- Produces:
  - `class Niche` — frozen dataclass `(name: str, emoji: Optional[str], discord_role_id: Optional[int], is_active: bool)`
  - `load_niches(force: bool = False) -> tuple[Niche, ...]`
  - `active_niches() -> tuple[Niche, ...]`
  - `track_bases() -> tuple[tuple[str, str], ...]` — `(stripped_emoji, niche_name)`, longest base first
  - `emoji_for(name: str) -> Optional[str]`
  - `role_id_for(name: Optional[str]) -> Optional[int]`
  - `strip_emoji_base(emoji: Optional[str]) -> str`
  - `configure(fetch=None, clock=None) -> None` and `reset_cache() -> None` — test seams
  - `CACHE_TTL_SECONDS = 60`, `FALLBACK_NICHES`

- [ ] **Step 1: Write the failing tests**

```python
"""The niche vocabulary: cached, and never empty.

Run: python3 -m unittest discover worker/tests
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import niches  # noqa: E402


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


def row(name, emoji=None, role=None, active=True):
    return {"name": name, "emoji": emoji, "discord_role_id": role, "is_active": active}


class NicheCache(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.calls = []
        niches.reset_cache()

    def tearDown(self):
        niches.configure(fetch=None, clock=None)
        niches.reset_cache()

    def use(self, rows_or_error):
        def fetch():
            self.calls.append(1)
            if isinstance(rows_or_error, Exception):
                raise rows_or_error
            return rows_or_error
        niches.configure(fetch=fetch, clock=self.clock)

    def test_reads_once_inside_the_ttl(self):
        self.use([row("Christian", "✝️")])
        niches.load_niches()
        self.clock.advance(niches.CACHE_TTL_SECONDS - 1)
        niches.load_niches()
        self.assertEqual(len(self.calls), 1)

    def test_refetches_after_the_ttl(self):
        self.use([row("Christian", "✝️")])
        niches.load_niches()
        self.clock.advance(niches.CACHE_TTL_SECONDS + 1)
        niches.load_niches()
        self.assertEqual(len(self.calls), 2)

    def test_a_failed_read_keeps_the_last_good_list(self):
        self.use([row("Christian", "✝️"), row("Hustle", "🌱")])
        good = niches.load_niches()
        self.assertEqual([n.name for n in good], ["Christian", "Hustle"])

        self.use(RuntimeError("supabase down"))
        self.clock.advance(niches.CACHE_TTL_SECONDS + 1)
        self.assertEqual([n.name for n in niches.load_niches()], ["Christian", "Hustle"])

    def test_an_empty_read_keeps_the_last_good_list(self):
        # An empty vocabulary is a silent discovery stall, not a valid answer.
        self.use([row("Christian", "✝️")])
        niches.load_niches()
        self.use([])
        self.clock.advance(niches.CACHE_TTL_SECONDS + 1)
        self.assertEqual([n.name for n in niches.load_niches()], ["Christian"])

    def test_a_cold_start_failure_falls_back_to_the_seed(self):
        self.use(RuntimeError("supabase down"))
        names = [n.name for n in niches.load_niches()]
        self.assertEqual(names, [name for name, _ in niches.FALLBACK_NICHES])

    def test_a_cold_start_failure_does_not_refetch_every_call(self):
        self.use(RuntimeError("supabase down"))
        niches.load_niches()
        niches.load_niches()
        self.assertEqual(len(self.calls), 1)


class TrackBases(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        niches.reset_cache()

    def tearDown(self):
        niches.configure(fetch=None, clock=None)
        niches.reset_cache()

    def use(self, rows):
        niches.configure(fetch=lambda: rows, clock=self.clock)

    def test_strips_variation_selectors_so_the_two_crosses_are_one_track(self):
        self.assertEqual(niches.strip_emoji_base("✝️"), niches.strip_emoji_base("✝"))

    def test_longest_base_first_so_a_short_emoji_cannot_shadow_a_long_one(self):
        self.use([row("Short", "🌱"), row("Long", "🏳️‍🌈")])
        bases = [base for base, _ in niches.track_bases()]
        self.assertEqual(bases, sorted(bases, key=len, reverse=True))

    def test_archived_niches_still_classify(self):
        # Archiving must not make every channel on that emoji unclassifiable.
        self.use([row("Retired", "🌱", active=False)])
        self.assertEqual(niches.track_bases(), (("🌱", "Retired"),))

    def test_archived_niches_leave_the_picker(self):
        self.use([row("Live", "✝️"), row("Retired", "🌱", active=False)])
        self.assertEqual([n.name for n in niches.active_niches()], ["Live"])

    def test_a_niche_without_an_emoji_is_not_a_track(self):
        self.use([row("Finance General", None)])
        self.assertEqual(niches.track_bases(), ())

    def test_role_id_for_reads_the_record(self):
        self.use([row("Christian", "✝️", role=123)])
        self.assertEqual(niches.role_id_for("Christian"), 123)
        self.assertIsNone(niches.role_id_for("Nope"))
        self.assertIsNone(niches.role_id_for(None))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest worker.tests.test_niches -v` (or `cd worker && python3 -m unittest discover tests -k Niche -v`)
Expected: FAIL — `ModuleNotFoundError: No module named 'niches'`

- [ ] **Step 3: Write `worker/niches.py`**

```python
#!/usr/bin/env python3
"""The niche track vocabulary, read from research_niches.

This used to be TRACK_EMOJI_NICHES, a dict in discord_pull_worker.py, which
made adding a niche a code edit plus a gateway reconnect. It lives here rather
than in the pull worker because three consumers share it — the pull worker's
classifier, the bot's /onboard, and the web app — and until now the bot
imported the *pull worker* to read its own configuration.

The one rule that matters: **the vocabulary is never empty**. An unknown emoji
makes classify_creator_channels skip a channel, and cmd_discover only ever
upserts, so an empty list does not raise or delete anything — it silently
stops new channels being discovered. So a read failure degrades to the last
good list, and a cold-start failure degrades to FALLBACK_NICHES.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Optional, Sequence

CACHE_TTL_SECONDS = 60

# Last-resort vocabulary, used only when the very first read fails. Keeping it
# in sync with the table is not required for correctness — it only has to keep
# a cold-started worker classifying something sane until Supabase answers.
FALLBACK_NICHES: tuple[tuple[str, str], ...] = (
    ("Christian", "✝️"),
    ("Female General Self-Improvement", "🤍"),
    ("General Motivation / Hustle", "🌱"),
)

# Variation selector and zero-width joiner, written as escapes because they
# are invisible in a source file. Mirrors niche_emoji_base() in the migration,
# so Python and Postgres agree on when two emojis are one track.
_DECORATIONS = ("\ufe0f", "\u200d")


@dataclass(frozen=True)
class Niche:
    name: str
    emoji: Optional[str]
    discord_role_id: Optional[int]
    is_active: bool


def strip_emoji_base(emoji: Optional[str]) -> str:
    """``✝️`` and ``✝`` are the same track."""
    if not emoji:
        return ""
    stripped = emoji
    for ch in _DECORATIONS:
        stripped = stripped.replace(ch, "")
    return stripped.strip()


def _default_fetch() -> list[dict]:
    # Local import: discord_pull_worker imports this module, so a top-level
    # import here would be circular.
    from discord_pull_worker import sb_all

    return sb_all(
        "research_niches?select=name,emoji,discord_role_id,is_active&order=name"
    )


_fetch: Callable[[], Sequence[dict]] = _default_fetch
_clock: Callable[[], float] = time.monotonic
_cache: Optional[tuple[Niche, ...]] = None
_last_attempt: float = 0.0


def configure(fetch=None, clock=None) -> None:
    """Test seam. Passing None restores the real reader / clock."""
    global _fetch, _clock
    _fetch = fetch or _default_fetch
    _clock = clock or time.monotonic


def reset_cache() -> None:
    global _cache, _last_attempt
    _cache = None
    _last_attempt = 0.0


def _parse(rows: Sequence[dict]) -> tuple[Niche, ...]:
    out = []
    for r in rows or ():
        name = (r.get("name") or "").strip()
        if not name:
            continue
        role = r.get("discord_role_id")
        out.append(
            Niche(
                name=name,
                emoji=(r.get("emoji") or None),
                discord_role_id=int(role) if role not in (None, "") else None,
                is_active=bool(r.get("is_active", True)),
            )
        )
    return tuple(out)


def load_niches(force: bool = False) -> tuple[Niche, ...]:
    """Every niche, archived included. Cached for CACHE_TTL_SECONDS.

    The TTL throttles failures as well as successes: without that, an outage
    would make /onboard's autocomplete hit Supabase on every keystroke.
    """
    global _cache, _last_attempt
    now = _clock()
    if not force and _last_attempt and (now - _last_attempt) < CACHE_TTL_SECONDS:
        return _cache if _cache is not None else _fallback()

    _last_attempt = now
    try:
        parsed = _parse(_fetch())
    except Exception:  # noqa: BLE001 - a stale vocabulary beats an empty one
        parsed = ()
    if parsed:
        _cache = parsed
    return _cache if _cache is not None else _fallback()


def _fallback() -> tuple[Niche, ...]:
    return tuple(
        Niche(name=name, emoji=emoji, discord_role_id=None, is_active=True)
        for name, emoji in FALLBACK_NICHES
    )


def active_niches() -> tuple[Niche, ...]:
    """What /onboard offers. Archived niches are gone from here but still
    classify — see track_bases."""
    return tuple(n for n in load_niches() if n.is_active)


def track_bases() -> tuple[tuple[str, str], ...]:
    """``(stripped emoji, niche name)``, longest base first.

    Built from EVERY niche, archived included: archiving must not make the
    existing channels on that emoji unclassifiable. Longest first so a
    multi-codepoint emoji can never be shadowed by a shorter one.
    """
    pairs = [
        (strip_emoji_base(n.emoji), n.name)
        for n in load_niches()
        if strip_emoji_base(n.emoji)
    ]
    return tuple(sorted(pairs, key=lambda pair: len(pair[0]), reverse=True))


def emoji_for(name: Optional[str]) -> Optional[str]:
    for n in load_niches():
        if n.name == name:
            return n.emoji
    return None


def role_id_for(name: Optional[str]) -> Optional[int]:
    if not name:
        return None
    for n in load_niches():
        if n.name == name:
            return n.discord_role_id
    return None
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest discover worker/tests -v`
Expected: PASS, including the pre-existing suites.

- [ ] **Step 5: Commit**

```bash
git add worker/niches.py worker/tests/test_niches.py
git commit -m "feat: worker/niches.py reads the vocabulary from research_niches"
```

---

### Task 3: Point the pull worker's classifier at `niches.py`

**Files:**
- Modify: `worker/discord_pull_worker.py:170-193` (delete `TRACK_EMOJI_NICHES` and `_TRACK_BASES`), `worker/discord_pull_worker.py:299-320` (`split_track_channel`)
- Modify: `worker/tests/test_channels.py`

**Interfaces:**
- Consumes: `niches.track_bases()` from Task 2.
- Produces: `split_track_channel` and `classify_creator_channels` keep their existing signatures and behaviour; `TRACK_EMOJI_NICHES` and `_TRACK_BASES` no longer exist.

- [ ] **Step 1: Write the failing test**

Add to `worker/tests/test_channels.py`:

```python
import niches  # noqa: E402


class ClassificationFollowsTheTable(unittest.TestCase):
    """Adding a niche in /settings must classify without a code change."""

    def tearDown(self):
        niches.configure(fetch=None, clock=None)
        niches.reset_cache()

    def use(self, rows):
        niches.reset_cache()
        niches.configure(fetch=lambda: rows, clock=None)

    def test_a_niche_added_to_the_table_classifies_immediately(self):
        self.use([
            {"name": "Fitness", "emoji": "💪", "discord_role_id": None, "is_active": True},
        ])
        self.assertEqual(split_track_channel("💪malik-jones"), ("Fitness", "malik-jones"))

    def test_a_niche_absent_from_the_table_does_not_classify(self):
        self.use([
            {"name": "Fitness", "emoji": "💪", "discord_role_id": None, "is_active": True},
        ])
        self.assertIsNone(split_track_channel("✝️jas-alcantara"))

    def test_an_archived_niche_still_classifies(self):
        self.use([
            {"name": "Retired", "emoji": "🌱", "discord_role_id": None, "is_active": False},
        ])
        rows = classify_creator_channels([text_channel(1, "🌱ethan-lau", parent_id="9"),
                                          category(9, "Coach: Joey's Team")])
        self.assertEqual(rows[0]["niche"], "Retired")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m unittest discover worker/tests -k ClassificationFollowsTheTable -v`
Expected: FAIL — `split_track_channel` still reads the module constant, so `💪malik-jones` returns None.

- [ ] **Step 3: Replace the constant with the accessor**

In `worker/discord_pull_worker.py`, delete the `TRACK_EMOJI_NICHES` dict and the `_TRACK_BASES` tuple (lines 170-193, keeping `LEGACY_TRACK_WORDS`), and add to the imports:

```python
import niches
```

Then change the loop head in `split_track_channel`:

```python
    lowered = channel_name.strip().lower()
    for base, niche in niches.track_bases():
```

Update the two docstrings that name `TRACK_EMOJI_NICHES` (in `classify_creator_channels` and the module header) to say the vocabulary comes from `research_niches` via `niches.track_bases()`, and that a new track needs a row in /settings rather than a code edit.

- [ ] **Step 4: Fix the existing tests that imported the constant**

`worker/tests/test_channels.py` imports `split_track_channel` and friends, and the existing cases assume the three live tracks. Add a module-level fixture so the suite is deterministic instead of hitting Supabase:

```python
LIVE_TRACKS = [
    {"name": "Christian", "emoji": "✝️", "discord_role_id": None, "is_active": True},
    {"name": "Female General Self-Improvement", "emoji": "🤍", "discord_role_id": None, "is_active": True},
    {"name": "General Motivation / Hustle", "emoji": "🌱", "discord_role_id": None, "is_active": True},
]


def setUpModule():
    niches.reset_cache()
    niches.configure(fetch=lambda: list(LIVE_TRACKS), clock=None)


def tearDownModule():
    niches.configure(fetch=None, clock=None)
    niches.reset_cache()
```

Note the `ClassificationFollowsTheTable` cases call `self.use(...)` which re-configures, and its `tearDown` restores the real reader — so add `niches.configure(fetch=lambda: list(LIVE_TRACKS), clock=None)` to that class's `tearDown` instead of `fetch=None`, or the later tests in the module lose the fixture.

- [ ] **Step 5: Run the full Python suite**

Run: `python3 -m unittest discover worker/tests -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/discord_pull_worker.py worker/tests/test_channels.py
git commit -m "refactor: classify channels from research_niches, not a module constant"
```

---

### Task 4: The bot — live track picker, niche role from the record

**Files:**
- Modify: `worker/discord_bot/onboarding.py:24-30` (`NICHE_CHANNEL_PREFIXES`), `:140-148` (`build_channel_name`), `:380-395` + `:513-540` (niche role block)
- Modify: `worker/discord_bot/commands.py:40` (import), `:305-325` (onboard call), `:351-370` (choices → autocomplete), `:425-436` (offboard call)
- Modify: `worker/discord_bot/config.py:41-46, 78-79, 101, 133-146, 160` (delete the dead map)
- Modify: `worker/discord_bot/offboarding.py:257` (`niche_role_ids` param)
- Test: `worker/tests/test_onboarding.py`, `worker/tests/test_offboarding.py`

**Interfaces:**
- Consumes: `niches.active_niches()`, `niches.role_id_for(name)`, `niches.emoji_for(name)` from Task 2.
- Produces: `onboarding.niche_channel_prefixes() -> dict[str, str]` (niche name → emoji) replacing the `NICHE_CHANNEL_PREFIXES` constant; `execute_onboarding(..., niche_role_id: Optional[int] = None)` replacing `niche_role_ids`; `execute_offboarding(..., niche_role_ids: Optional[Iterable[int]] = None)` now taking plain role ids.

- [ ] **Step 1: Write the failing tests**

Add to `worker/tests/test_onboarding.py`:

```python
class ChannelNameFollowsTheTable(unittest.TestCase):
    def tearDown(self):
        niches.configure(fetch=None, clock=None)
        niches.reset_cache()

    def test_a_new_niche_names_the_channel_with_its_emoji(self):
        niches.reset_cache()
        niches.configure(fetch=lambda: [
            {"name": "Fitness", "emoji": "💪", "discord_role_id": None, "is_active": True},
        ], clock=None)
        self.assertEqual(build_channel_name("Malik Jones", niche="Fitness"), "💪malik-jones")

    def test_an_unknown_niche_falls_back_to_the_legacy_prefix(self):
        niches.reset_cache()
        niches.configure(fetch=lambda: [], clock=None)
        self.assertEqual(build_channel_name("Malik Jones", niche="Nope"), "coaching-malik-jones")
```

- [ ] **Step 2: Run to verify it fails**

Run: `worker/.venv/bin/python -m unittest discover worker/tests -k ChannelNameFollowsTheTable -v`
Expected: FAIL — `NICHE_CHANNEL_PREFIXES` is a module constant built at import, so `Fitness` is unknown.

- [ ] **Step 3: Make the prefixes an accessor**

In `worker/discord_bot/onboarding.py`, replace the constant:

```python
import niches


def niche_channel_prefixes() -> dict[str, str]:
    """Niche name -> channel-name emoji, live from research_niches.

    Only active niches: this drives what /onboard offers and how it names a
    NEW channel. Classification of existing channels reads every niche
    (niches.track_bases), archived included.
    """
    return {n.name: n.emoji for n in niches.active_niches() if n.emoji}
```

and in `build_channel_name`:

```python
    prefix = niche_channel_prefixes().get(niche or "", CHANNEL_PREFIX)
```

- [ ] **Step 4: Swap the niche-role parameter for a resolved id**

In `worker/discord_bot/onboarding.py`, change the `execute_onboarding` signature from `niche_role_ids: Optional[Mapping[int, int]] = None` to:

```python
    niche_role_id: Optional[int] = None,
```

and delete the two lines that derived it from the category:

```python
    category_id = int(getattr(category, "id", 0))
    niche_role_id = (niche_role_ids or {}).get(category_id)
```

The rest of the block (`if niche_role_id is not None:` onward) is unchanged — it already takes an id.

In `worker/discord_bot/offboarding.py`, add `Iterable` to the `typing` import (the file currently imports `Mapping`, which becomes unused — remove it if nothing else uses it), then change the parameter to plain ids:

```python
    niche_role_ids: Optional[Iterable[int]] = None,
```

and the set comprehension that consumed the mapping:

```python
    configured_niche_role_ids = {
        int(role_id) for role_id in (niche_role_ids or ()) if role_id is not None
    }
```

- [ ] **Step 5: Wire the bot's call sites**

In `worker/discord_bot/commands.py`, replace the `NICHE_CHANNEL_PREFIXES` import with `niche_channel_prefixes`, add `import niches`, and pass the resolved id at the onboard call:

```python
            niche_role_id=await asyncio.to_thread(
                niches.role_id_for, None if track == "legacy" else track
            ),
```

and at the offboard call:

```python
            niche_role_ids=[
                n.discord_role_id
                for n in await asyncio.to_thread(niches.load_niches)
                if n.discord_role_id
            ],
```

- [ ] **Step 6: Replace the static track choices with an autocomplete**

Delete this block entirely (`worker/discord_bot/commands.py:357-365`):

```python
    onboard = app_commands.choices(
        track=[
            *(
                app_commands.Choice(name=f"{emoji} {niche_name}"[:100], value=niche_name)
                for niche_name, emoji in NICHE_CHANNEL_PREFIXES.items()
            ),
            app_commands.Choice(name="coaching- (legacy, niche set later)", value="legacy"),
        ]
    )(onboard)
```

and change the `describe` line that used the same constant:

```python
    onboard = app_commands.describe(
        username="The creator to onboard",
        niche="Which coach team category their channel goes in",
        track="Niche track — names their channel and sets their niche everywhere",
    )(onboard)
```

Then add an autocomplete beside the existing `niche` one, after `onboard_command` is created:

```python
    @onboard_command.autocomplete("track")
    async def track_autocomplete(
        interaction: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        # Runtime, not the app_commands.choices decorator: choices are
        # registered with Discord once at startup, so a niche added in
        # /settings would need a bot restart to appear. This does not.
        entries = await asyncio.to_thread(niches.active_niches)
        needle = (current or "").strip().lower()
        if needle:
            entries = [n for n in entries if needle in n.name.lower()]
        choices = [
            app_commands.Choice(name=f"{n.emoji or ''} {n.name}".strip()[:100], value=n.name)
            for n in entries
        ]
        choices.append(
            app_commands.Choice(name="coaching- (legacy, niche set later)", value="legacy")
        )
        return choices[:MAX_CHOICES]
```

- [ ] **Step 7: Delete the dead niche-role config**

In `worker/discord_bot/config.py` remove, in this order: the `DEFAULT_NICHE_ROLE_ID_PAIRS` tuple (lines 41-46), `_default_niche_role_ids()` (78-79), the `niche_role_ids` field on `BotConfig` (101), `_env_id_pair_map()` (133-146), and the `niche_role_ids=...` line in `load_bot_config()` (160).

Add a short note where the tuple was:

```python
# Niche -> Discord role now lives in research_niches.discord_role_id, managed
# from /settings. The old map here was keyed by CATEGORY id, and once
# categories became coach teams two of its three keys pointed at Will's and
# Luke's team categories while all three target roles 404'd — so /onboard has
# been reporting "niche role not found" rather than assigning anything.
```

- [ ] **Step 8: Update the existing tests that pass the old parameters**

`worker/tests/test_onboarding.py` and `worker/tests/test_offboarding.py` construct calls with `niche_role_ids={...}`. Change the onboarding ones to `niche_role_id=<int or None>` and the offboarding ones to `niche_role_ids=[<int>]`. `worker/tests/test_offboarding.py:257` (`coach_from_category`) is unrelated and stays.

- [ ] **Step 9: Run the Python suite and compile the bot**

Run:
```bash
python3 -m unittest discover worker/tests -v
worker/.venv/bin/python -m py_compile worker/discord_bot/*.py worker/run_discord_bot.py
python3 -m py_compile worker/discord_pull_worker.py worker/niches.py
```
Expected: all PASS, no output from py_compile.

- [ ] **Step 10: Commit**

```bash
git add worker/discord_bot worker/tests
git commit -m "feat: live /onboard track picker, niche role from research_niches"
```

---

### Task 5: `src/lib/niches.ts` and the emoji on every pill

**Files:**
- Create: `src/lib/niches.ts`
- Test: `tests/niches.test.ts`
- Modify: `src/app/(app)/discord/page.tsx:63-112, 303-308`, `src/app/(app)/discord/[id]/page.tsx:89-134, 170-176`

**Interfaces:**
- Produces:
  - `interface Niche { name: string; emoji: string | null; discordRoleId: string | null; isActive: boolean }`
  - `loadNiches(client: SupabaseClient): Promise<Niche[]>`
  - `nicheEmojiMap(niches: Niche[]): Map<string, string>`
  - `nicheLabel(name: string, emojis: Map<string, string>): string`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { nicheEmojiMap, nicheLabel, type Niche } from "@/lib/niches";

const niche = (name: string, emoji: string | null): Niche => ({
  name,
  emoji,
  discordRoleId: null,
  isActive: true,
});

describe("nicheLabel", () => {
  it("prefixes the emoji when the niche has one", () => {
    const emojis = nicheEmojiMap([niche("General Motivation / Hustle", "🌱")]);
    expect(nicheLabel("General Motivation / Hustle", emojis)).toBe("🌱 General Motivation / Hustle");
  });

  it("renders a free-text niche unchanged", () => {
    // 61 finance scripts carry a niche with no row in research_niches. The
    // table is the track vocabulary, not a registry of every string ever
    // written, so these must keep rendering exactly as before.
    const emojis = nicheEmojiMap([niche("Christian", "✝️")]);
    expect(nicheLabel("Finance General", emojis)).toBe("Finance General");
  });

  it("ignores a niche row that has no emoji", () => {
    const emojis = nicheEmojiMap([niche("Finance General", null)]);
    expect(nicheLabel("Finance General", emojis)).toBe("Finance General");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/niches.test.ts`
Expected: FAIL — cannot resolve `@/lib/niches`.

- [ ] **Step 3: Write `src/lib/niches.ts`**

```typescript
/**
 * The niche track vocabulary, shared by the pages that render niche pills and
 * by /settings, which manages it.
 *
 * Mirrors worker/niches.py. The table is the TRACK vocabulary — niches that
 * own an emoji — not a registry of every niche string ever written, so
 * `nicheLabel` has to render an unknown niche unchanged rather than hiding it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface Niche {
  name: string;
  emoji: string | null;
  /** Snowflake as text — a bigint through JSON.parse loses its low digits. */
  discordRoleId: string | null;
  isActive: boolean;
}

interface NicheRow {
  name: string;
  emoji: string | null;
  discord_role_id: string | null;
  is_active: boolean;
}

export async function loadNiches(client: SupabaseClient): Promise<Niche[]> {
  const { data, error } = await client
    .from("research_niches")
    .select("name, emoji, discord_role_id::text, is_active")
    .order("name");
  // A missing table must not take a page down — same reasoning as
  // videoSelect()'s probe: the code can reach Vercel before the migration
  // lands, and a select naming a missing relation is a hard PostgREST 400.
  if (error) return [];
  return ((data ?? []) as NicheRow[]).map((r) => ({
    name: r.name,
    emoji: r.emoji,
    discordRoleId: r.discord_role_id,
    isActive: r.is_active,
  }));
}

export function nicheEmojiMap(niches: Niche[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of niches) if (n.emoji) map.set(n.name, n.emoji);
  return map;
}

export function nicheLabel(name: string, emojis: Map<string, string>): string {
  const emoji = emojis.get(name);
  return emoji ? `${emoji} ${name}` : name;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/niches.test.ts`
Expected: PASS

- [ ] **Step 5: Use it on both Discord pages**

In `src/app/(app)/discord/page.tsx`, add `loadNiches` / `nicheEmojiMap` / `nicheLabel` to the imports, load alongside the existing niche queries:

```typescript
  const nicheEmojis = nicheEmojiMap(await loadNiches(supabase));
```

and render the pill through it:

```tsx
                    {ch.niche && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${nicheClass(ch.niche)}`}
                      >
                        {nicheLabel(ch.niche, nicheEmojis)}
                      </span>
                    )}
```

Make the identical change in `src/app/(app)/discord/[id]/page.tsx` (the pill at `:170-176`). The `nicheClass` palette lookup keeps using the bare `ch.niche`, so colours do not shift.

- [ ] **Step 6: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/niches.ts tests/niches.test.ts "src/app/(app)/discord"
git commit -m "feat: render niche pills with their emoji from research_niches"
```

---

### Task 6: The Niches card in /settings

**Files:**
- Create: `src/app/(app)/settings/niche-actions.ts`
- Create: `src/components/niche-manager.tsx`
- Modify: `src/app/(app)/settings/page.tsx` (load niches, render the card)

**Interfaces:**
- Consumes: `loadNiches`, `Niche` from Task 5; `rename_niche` RPC from Task 1.
- Produces: server actions `createNiche(formData: FormData)`, `updateNiche(formData: FormData)`, `setNicheActive(formData: FormData)` — all `Promise<void>`, all revalidating `/settings`, `/discord` and `/scripts`.

> **On testing:** the spec listed "a TS test for the rename-cascade payload".
> There is no payload left to test — the cascade is one `rename_niche()` RPC,
> and its atomicity is the database's guarantee, not shaping logic. The
> behaviour is covered instead by Step 4's browser check (rename a niche, see
> the pill change on /discord) and by the repo's existing convention of
> testing pure functions rather than server actions. Task 7's planner IS pure,
> and is tested.

- [ ] **Step 1: Write the server actions**

`src/app/(app)/settings/niche-actions.ts`:

```typescript
"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

/** Pages that render a niche pill or the manager itself. */
const NICHE_PATHS = ["/settings", "/discord", "/scripts"];
const revalidateNichePaths = () => NICHE_PATHS.forEach((p) => revalidatePath(p));

const clean = (v: FormDataEntryValue | null) => String(v ?? "").trim();

export async function createNiche(formData: FormData) {
  await requireAdmin();
  const name = clean(formData.get("name"));
  if (!name) return;
  const emoji = clean(formData.get("emoji")) || null;
  const roleId = clean(formData.get("discordRoleId")) || null;

  const { error } = await createAdminClient().from("research_niches").insert({
    name,
    emoji,
    discord_role_id: roleId,
  });
  if (error) throw new Error(`adding niche: ${error.message}`);
  revalidateNichePaths();
}

export async function updateNiche(formData: FormData) {
  await requireAdmin();
  const id = clean(formData.get("id"));
  const originalName = clean(formData.get("originalName"));
  const name = clean(formData.get("name"));
  if (!id || !name) return;
  const admin = createAdminClient();

  // A rename has to move the rows carrying the old string too, or it
  // manufactures the orphan that stranded Finance General. rename_niche does
  // all four updates in one transaction and renames the niche row itself, so
  // it is the whole write when the name changed.
  if (name !== originalName) {
    const { error } = await admin.rpc("rename_niche", {
      old_name: originalName,
      new_name: name,
    });
    if (error) throw new Error(`renaming niche: ${error.message}`);
  }

  const { error } = await admin
    .from("research_niches")
    .update({
      emoji: clean(formData.get("emoji")) || null,
      discord_role_id: clean(formData.get("discordRoleId")) || null,
    })
    .eq("id", id);
  if (error) throw new Error(`updating niche: ${error.message}`);
  revalidateNichePaths();
}

export async function setNicheActive(formData: FormData) {
  await requireAdmin();
  const id = clean(formData.get("id"));
  if (!id) return;
  // Archive, never delete: the name is still written across three tables, and
  // an archived niche keeps classifying its existing channels.
  const { error } = await createAdminClient()
    .from("research_niches")
    .update({ is_active: clean(formData.get("active")) === "true" })
    .eq("id", id);
  if (error) throw new Error(`archiving niche: ${error.message}`);
  revalidateNichePaths();
}
```

- [ ] **Step 2: Write the manager component**

`src/components/niche-manager.tsx` — a server component rendering one row per niche plus an add form. It uses the existing UI kit (`table`, `tableWrap`, `th`, `td`, `trHover`, `inputClass`, `SubmitButton`, `StatusBadge`) so it matches the rest of /settings.

```tsx
import { SubmitButton } from "@/components/submit-button";
import { StatusBadge, inputClass, table, tableWrap, td, th, trHover } from "@/components/ui";
import { createNiche, setNicheActive, updateNiche } from "@/app/(app)/settings/niche-actions";
import type { Niche } from "@/lib/niches";

export function NicheManager({
  niches,
  channelCounts,
}: {
  niches: (Niche & { id: string })[];
  /** Live Discord channels currently named with each niche's emoji. */
  channelCounts: Map<string, number>;
}) {
  return (
    <div className={tableWrap}>
      <table className={table}>
        <thead>
          <tr>
            <th className={th}>Emoji</th>
            <th className={th}>Niche</th>
            <th className={th}>Discord role id</th>
            <th className={th}>Channels</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody>
          {niches.map((n) => (
            <tr key={n.id} className={trHover}>
              <td className={td} colSpan={4}>
                <form action={updateNiche} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={n.id} />
                  <input type="hidden" name="originalName" value={n.name} />
                  <input
                    name="emoji"
                    defaultValue={n.emoji ?? ""}
                    className={`${inputClass} w-16 text-center`}
                    aria-label={`Emoji for ${n.name}`}
                  />
                  <input
                    name="name"
                    defaultValue={n.name}
                    required
                    className={`${inputClass} w-64`}
                    aria-label={`Name for ${n.name}`}
                  />
                  <input
                    name="discordRoleId"
                    defaultValue={n.discordRoleId ?? ""}
                    placeholder="role id (optional)"
                    className={`${inputClass} w-48 font-mono text-xs`}
                    aria-label={`Discord role for ${n.name}`}
                  />
                  <span className="text-xs text-neutral-400">
                    {channelCounts.get(n.name) ?? 0} channels
                  </span>
                  {!n.isActive && <StatusBadge status="Archived" />}
                  <SubmitButton>Save</SubmitButton>
                </form>
              </td>
              <td className={td}>
                <form action={setNicheActive}>
                  <input type="hidden" name="id" value={n.id} />
                  <input type="hidden" name="active" value={n.isActive ? "false" : "true"} />
                  <SubmitButton>{n.isActive ? "Archive" : "Restore"}</SubmitButton>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form action={createNiche} className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
        <input name="emoji" placeholder="🌱" className={`${inputClass} w-16 text-center`} aria-label="New niche emoji" />
        <input name="name" required placeholder="New niche name" className={`${inputClass} w-64`} aria-label="New niche name" />
        <input
          name="discordRoleId"
          placeholder="role id (optional)"
          className={`${inputClass} w-48 font-mono text-xs`}
          aria-label="New niche Discord role id"
        />
        <SubmitButton>Add niche</SubmitButton>
      </form>

      <p className="mt-3 text-xs text-neutral-400">
        Archiving keeps a niche classifying its existing channels — it only leaves
        /onboard&rsquo;s picker. The workers pick up a change within a minute; no restart.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Render it on /settings**

In `src/app/(app)/settings/page.tsx`, add the imports and load the data beside the existing queries:

```typescript
import { NicheManager } from "@/components/niche-manager";
```

```typescript
  const { data: nicheRows } = await supabase
    .from("research_niches")
    .select("id, name, emoji, discord_role_id::text, is_active")
    .order("name");
  const nicheList = ((nicheRows ?? []) as {
    id: string; name: string; emoji: string | null; discord_role_id: string | null; is_active: boolean;
  }[]).map((r) => ({
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    discordRoleId: r.discord_role_id,
    isActive: r.is_active,
  }));

  const { data: nicheChannelRows } = await supabase
    .from("research_discord_channels")
    .select("niche");
  const channelCounts = new Map<string, number>();
  for (const r of (nicheChannelRows ?? []) as { niche: string | null }[]) {
    if (r.niche) channelCounts.set(r.niche, (channelCounts.get(r.niche) ?? 0) + 1);
  }
```

and add the card after the scrape configuration card:

```tsx
        <Card
          title="Niches"
          subtitle="The track vocabulary: the emoji that prefixes a creator's channel, the niche written on their scripts, and the Discord role /onboard grants."
        >
          {!isAdmin ? (
            <EmptyState message="Only admins can change niches." />
          ) : (
            <NicheManager niches={nicheList} channelCounts={channelCounts} />
          )}
        </Card>
```

- [ ] **Step 4: Verify in the browser**

The dev server runs on port 3005 (`.claude/launch.json`). Sign in as admin, open `/settings`, and confirm: three niche rows render with their emoji; adding a niche with a duplicate emoji is rejected with the unique-index error; archiving flips the row to "Archived" and the button to "Restore".

- [ ] **Step 5: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/settings" src/components/niche-manager.tsx
git commit -m "feat: manage niches from /settings"
```

---

### Task 7: Gated Discord channel renames

**Files:**
- Create: `src/lib/niche-channel-rename.ts`
- Test: `tests/niche-channel-rename.test.ts`
- Modify: `src/lib/discord.ts` (add `renameChannel`)
- Modify: `src/app/(app)/settings/niche-actions.ts` (add `renameNicheChannels`)
- Modify: `src/components/niche-manager.tsx` (the preview + confirm control)

**Interfaces:**
- Consumes: `listGuildChannels` from `src/lib/discord.ts`.
- Produces:
  - `renameChannel(channelId: string, name: string): Promise<void>` in `src/lib/discord.ts`
  - `planNicheChannelRenames(channels: { id: string; name: string; type: number }[], fromEmoji: string, toEmoji: string): { channelId: string; from: string; to: string }[]`
  - `countNicheChannels(channels: { id: string; name: string; type: number }[], emoji: string): number`
  - `emojiBase(emoji: string): string`
  - server action `renameNicheChannels(formData: FormData): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { countNicheChannels, planNicheChannelRenames } from "@/lib/niche-channel-rename";

const ch = (id: string, name: string, type = 0) => ({ id, name, type });

describe("planNicheChannelRenames", () => {
  it("renames only the channels carrying the old emoji", () => {
    const plan = planNicheChannelRenames(
      [ch("1", "🌱ethan-lau"), ch("2", "✝️nino-aguilar"), ch("3", "folk-branding")],
      "🌱",
      "💪"
    );
    expect(plan).toEqual([{ channelId: "1", from: "🌱ethan-lau", to: "💪ethan-lau" }]);
  });

  it("matches a channel written without the variation selector", () => {
    // ✝️ and ✝ are one track everywhere else; a rename that missed the bare
    // form would leave channels stranded on an emoji no niche claims.
    const plan = planNicheChannelRenames([ch("1", "✝jas-alcantara")], "✝️", "🙏");
    expect(plan).toEqual([{ channelId: "1", from: "✝jas-alcantara", to: "🙏jas-alcantara" }]);
  });

  it("skips categories and voice channels", () => {
    expect(planNicheChannelRenames([ch("1", "🌱Team", 4), ch("2", "🌱voice", 2)], "🌱", "💪")).toEqual([]);
  });

  it("is a no-op when the emoji did not change", () => {
    expect(planNicheChannelRenames([ch("1", "🌱ethan-lau")], "🌱", "🌱")).toEqual([]);
  });
});

describe("countNicheChannels", () => {
  it("counts exactly what the rename would touch", () => {
    // The number on the button and the work the button does must agree, or
    // the confirm step is describing something other than what it will do.
    const channels = [ch("1", "🌱ethan-lau"), ch("2", "🌱ally-li"), ch("3", "✝️nino"), ch("4", "🌱Team", 4)];
    expect(countNicheChannels(channels, "🌱")).toBe(2);
    expect(countNicheChannels(channels, "🌱")).toBe(
      planNicheChannelRenames(channels, "🌱", "💪").length
    );
  });

  it("is zero for a niche with no emoji", () => {
    expect(countNicheChannels([ch("1", "🌱ethan-lau")], "")).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/niche-channel-rename.test.ts`
Expected: FAIL — cannot resolve `@/lib/niche-channel-rename`.

- [ ] **Step 3: Write the planner**

```typescript
/**
 * Which live Discord channels a niche's emoji change would rename.
 *
 * Pure and previewable on purpose. Renaming is visible to every creator in
 * the channel, and Discord rate-limits channel updates to 2 per 10 minutes
 * per channel — so this is never automatic on an emoji edit. It produces a
 * plan someone confirms.
 */

// Variation selector and ZWJ as escapes — invisible in a source file, and
// this has to agree with niche_emoji_base() in SQL and strip_emoji_base() in
// Python or the three disagree about when two emojis are one track.
const DECORATIONS = /[\uFE0F\u200D]/g;

/** Mirrors niche_emoji_base() in SQL and strip_emoji_base() in Python. */
export const emojiBase = (emoji: string): string => emoji.replace(DECORATIONS, "").trim();

/** Text channels only (0 = text, 5 = announcement) — never categories. */
const TEXT_TYPES = new Set([0, 5]);

/** How many live channels currently carry this emoji. Same matching as the
 *  rename plan, so the count on the button and the work it does agree. */
export function countNicheChannels(
  channels: { id: string; name: string; type: number }[],
  emoji: string
): number {
  const base = emojiBase(emoji);
  if (!base) return 0;
  return channels.filter(
    (c) => TEXT_TYPES.has(c.type) && c.name.replace(DECORATIONS, "").startsWith(base)
  ).length;
}

export function planNicheChannelRenames(
  channels: { id: string; name: string; type: number }[],
  fromEmoji: string,
  toEmoji: string
): { channelId: string; from: string; to: string }[] {
  const from = emojiBase(fromEmoji);
  const to = toEmoji.trim();
  if (!from || !to || from === emojiBase(to)) return [];

  const plan: { channelId: string; from: string; to: string }[] = [];
  for (const c of channels) {
    if (!TEXT_TYPES.has(c.type)) continue;
    const bare = c.name.replace(DECORATIONS, "");
    if (!bare.startsWith(from)) continue;
    plan.push({ channelId: c.id, from: c.name, to: `${to}${bare.slice(from.length)}` });
  }
  return plan;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/niche-channel-rename.test.ts`
Expected: PASS

- [ ] **Step 5: Add `renameChannel` to the Discord client**

In `src/lib/discord.ts`, after `createTextChannel`:

```typescript
/** Rename one channel. Discord allows 2 channel updates per 10 minutes per
 *  channel, so callers rename deliberately and never in a retry loop. */
export async function renameChannel(channelId: string, name: string): Promise<void> {
  await discordRequest<GuildChannel>("PATCH", `/channels/${channelId}`, { name });
}
```

- [ ] **Step 6: Add the server action**

In `src/app/(app)/settings/niche-actions.ts`:

```typescript
import { discordConfigured, listGuildChannels, renameChannel } from "@/lib/discord";
import { planNicheChannelRenames } from "@/lib/niche-channel-rename";

/**
 * Rename every live channel on a niche's old emoji to its new one.
 *
 * Explicit and confirmed, never a side effect of editing the emoji: it is
 * visible to every creator in those channels, and Discord's 2-updates-per-
 * 10-minutes-per-channel limit makes a bulk rename slow and a repeat rename a
 * stall. Failures are reported per channel and never retried in a loop.
 */
export async function renameNicheChannels(formData: FormData) {
  await requireAdmin();
  const fromEmoji = clean(formData.get("fromEmoji"));
  const toEmoji = clean(formData.get("toEmoji"));
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!fromEmoji || !toEmoji || !guildId || !discordConfigured()) return;

  const plan = planNicheChannelRenames(await listGuildChannels(guildId), fromEmoji, toEmoji);
  const failed: string[] = [];
  for (const step of plan) {
    try {
      await renameChannel(step.channelId, step.to);
    } catch (err) {
      failed.push(`${step.from}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed.length) throw new Error(`renamed ${plan.length - failed.length}/${plan.length}; failed: ${failed.join("; ")}`);
  revalidateNichePaths();
}
```

- [ ] **Step 7: Add the control to the manager**

In `src/components/niche-manager.tsx`, give `NicheManager` a `liveEmojiCounts: Map<string, number>` prop (live Discord channel names starting with each emoji base, computed on the settings page from `listGuildChannels`), and render a second form per row, shown only when the stored emoji has live channels:

```tsx
              {n.emoji && (liveEmojiCounts.get(n.emoji) ?? 0) > 0 && (
                <form action={renameNicheChannels} className="mt-2 flex items-center gap-2">
                  <input type="hidden" name="fromEmoji" value={n.emoji} />
                  <input
                    name="toEmoji"
                    placeholder="new emoji"
                    required
                    className={`${inputClass} w-16 text-center`}
                    aria-label={`Rename ${n.name} channels to a new emoji`}
                  />
                  <span className="text-xs text-neutral-400">
                    renames {liveEmojiCounts.get(n.emoji)} live Discord channels
                  </span>
                  <SubmitButton>Rename in Discord</SubmitButton>
                </form>
              )}
```

On the settings page, build `liveEmojiCounts` from `listGuildChannels(process.env.DISCORD_GUILD_ID)` wrapped in try/catch — a Discord outage must not take /settings down:

```typescript
  const liveEmojiCounts = new Map<string, number>();
  if (discordConfigured() && process.env.DISCORD_GUILD_ID) {
    try {
      const guildChannels = await listGuildChannels(process.env.DISCORD_GUILD_ID);
      for (const n of nicheList) {
        if (!n.emoji) continue;
        liveEmojiCounts.set(n.emoji, countNicheChannels(guildChannels, n.emoji));
      }
    } catch {
      // Leave the counts empty; the rename control simply does not render.
    }
  }
```

- [ ] **Step 8: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/lib/niche-channel-rename.ts tests/niche-channel-rename.test.ts src/lib/discord.ts "src/app/(app)/settings" src/components/niche-manager.tsx
git commit -m "feat: previewed, confirmed Discord channel renames on an emoji change"
```

---

### Task 8: Link the three orphaned channels, and update CLAUDE.md

**Files:**
- Create: `scripts/link-channels.mjs`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing from earlier tasks; this is a data fix plus documentation.

- [ ] **Step 1: Write the linking script**

`scripts/link-channels.mjs` — takes `<channel_name> <handle>` pairs, resolves each handle to a creator id, and PATCHes only when the channel currently has no link.

```javascript
#!/usr/bin/env node
/**
 * Link a Discord channel to a roster creator, the way /link does.
 *
 * Refuses to overwrite an existing link: a human link must survive, and
 * cmd_discover already treats a stored link as authoritative over its own
 * name-matching.
 *
 * Usage: node scripts/link-channels.mjs "🌱lucas-graham=lucasisdialed" ...
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    })
);
const URL_BASE = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1`;
const H = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

const pairs = process.argv.slice(2).map((a) => {
  const [channelName, handle] = a.split("=");
  return { channelName, handle };
});
if (!pairs.length) {
  console.error("usage: node scripts/link-channels.mjs '<channel>=<handle>' ...");
  process.exit(1);
}

for (const { channelName, handle } of pairs) {
  const creators = await (
    await fetch(`${URL_BASE}/research_creators?select=id,handle&handle=eq.${encodeURIComponent(handle)}`, { headers: H })
  ).json();
  if (creators.length !== 1) {
    console.log(`skip ${channelName}: ${creators.length} creators match @${handle}`);
    continue;
  }
  // channel_name is text, so no snowflake casting is needed for the filter —
  // but the PATCH must not touch a channel someone already linked.
  const res = await fetch(
    `${URL_BASE}/research_discord_channels?channel_name=eq.${encodeURIComponent(channelName)}&research_creator_id=is.null`,
    {
      method: "PATCH",
      headers: { ...H, Prefer: "return=representation" },
      body: JSON.stringify({ research_creator_id: creators[0].id }),
    }
  );
  const updated = await res.json();
  console.log(`${channelName} -> @${handle}: ${updated.length} row(s) updated`);
}
```

- [ ] **Step 2: Run it for the three channels**

```bash
node scripts/link-channels.mjs "🌱lucas-graham=lucasisdialed" "🌱adam-ngyuen=lifeofabga" "🌱lyonel-concepcion=lockedwithlyonel"
```
Expected: `1 row(s) updated` for each. A `0` means someone linked it in the meantime — check /discord before forcing anything.

- [ ] **Step 3: Verify they now group under the coach**

Open `/performance` on the dev server and confirm Lucas Graham, Adam Nguyen and Lyonel Concepcion appear under `Coach: Joey's Team` rather than in the coachless group.

- [ ] **Step 4: Update CLAUDE.md**

Replace the parenthetical in the Layout section that names `TRACK_EMOJI_NICHES` as the niche source of truth:

> `TRACK_EMOJI_NICHES` is the emoji→niche source of truth

with:

> the niche vocabulary is `research_niches`, managed from /settings and read through `worker/niches.py` (60s cache; falls back to the last good list, then to a hardcoded seed — never empty, because an empty vocabulary silently stops channel discovery rather than failing)

and add a short **Niches** section after **Roster lifecycle** recording: the table is the track vocabulary and not a registry of every niche string (61 finance scripts have no row and render fine); archiving leaves the /onboard picker but keeps classifying; emoji uniqueness is on the variation-selector-stripped base in both SQL and Python; a rename cascades through `rename_niche()` because a half-applied rename is what stranded Finance General; and channel renames are previewed and confirmed because Discord allows 2 channel updates per 10 minutes per channel.

- [ ] **Step 5: Full verification**

Run:
```bash
npm run typecheck && npm test
python3 -m unittest discover worker/tests
python3 -m py_compile worker/discord_pull_worker.py worker/niches.py
worker/.venv/bin/python -m py_compile worker/discord_bot/*.py worker/run_discord_bot.py
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/link-channels.mjs CLAUDE.md
git commit -m "fix: link three Joey's Team channels; document niches as data"
```

---

## Deployment notes

Not part of any task — these are the steps after the branch merges.

1. **Migration first, then Vercel, then Fly.** `loadNiches` returns `[]` on a missing relation and `worker/niches.py` falls back to the seed, so any order *works*, but applying the migration first means nothing runs on the fallback.
2. **`fly deploy` for `bludgc-workers`** picks up `worker/niches.py`. `strategy = "immediate"` stays as it is — do not switch to bluegreen/canary, which would briefly run two gateway connections on one token.
3. **No new Fly secrets.** `worker/niches.py` reads Supabase through the pull worker's existing `sb_all`, which uses `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — both already set.
4. After the bot restarts, run `/onboard` in Discord and confirm the **track** option autocompletes from the table. Add a throwaway niche in /settings, confirm it appears within a minute without a restart, then archive it.
