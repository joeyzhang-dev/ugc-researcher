"""One niche vocabulary for the whole worker test suite, and no network.

Importing this module does three things, in this order: fills in the env vars
the worker modules read at import time, puts ``worker/`` on ``sys.path``, and
points :mod:`niches` at a fixed vocabulary.

Why it is shared rather than per-module. ``niches`` keeps its reader in a
module global, so configuring it is a process-wide act: a module that restores
``fetch=None`` in its own ``tearDown`` re-arms the real reader for every test
that runs after it, in every module. That is not hypothetical -- it is what
``test_channels`` used to do, which left ``test_onboarding``'s
``build_channel_name`` tests falling through ``niche_channel_prefixes()`` to a
live ``GET /rest/v1/research_niches``. They still passed, because the answer
they asserted also happens to be ``niches.FALLBACK_NICHES``. So the leak was
invisible: non-hermetic and vacuous at the same time.

Hence two rules, both enforced here rather than by convention:

* ``install()`` and :func:`use_niches` restore the FIXTURE, never the real
  reader. ``test_niches`` is the only module that configures ``niches``
  directly -- it is the unit under test -- and it still restores the fixture.
* ``niches._default_fetch`` is replaced by a guard, so even a stray
  ``configure(fetch=None)`` raises instead of opening a socket.

The fixture vocabulary deliberately differs from ``niches.FALLBACK_NICHES``:
``FIXTURE_ONLY_TRACK`` has no seed entry, so an assertion about it can only
pass if the code under test really read the table.
"""
from __future__ import annotations

import contextlib
import os
import sys
from pathlib import Path

for _var, _dummy in {
    "NEXT_PUBLIC_SUPABASE_URL": "http://localhost",
    "SUPABASE_SERVICE_ROLE_KEY": "test",
    "DISCORD_BOT_TOKEN": "test",
    "DISCORD_GUILD_ID": "1",
}.items():
    os.environ.setdefault(_var, _dummy)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import niches  # noqa: E402


class NicheNetworkAccess(BaseException):
    """Raised in place of a live research_niches read.

    A BaseException on purpose: ``load_niches`` catches ``Exception`` and
    degrades to its fallback vocabulary, so an ordinary error here would be
    swallowed and the leaked read would show up as a passing test. This has to
    reach the runner.
    """


def _forbidden() -> list[dict]:
    raise NicheNetworkAccess(
        "worker tests must not read research_niches over the network -- "
        "use nichefixture.install() or nichefixture.use_niches()"
    )


# configure(fetch=None) resolves _default_fetch at call time, so patching the
# module global covers every restore path, including ones written later.
niches._default_fetch = _forbidden  # type: ignore[assignment]


def row(name: str, emoji: str | None, role: int | None = None, active: bool = True) -> dict:
    return {"name": name, "emoji": emoji, "discord_role_id": role, "is_active": active}


# The three tracks the live guild actually uses. U+FE0F written as an escape:
# a literal variation selector is invisible in a source file, and this branch
# has already shipped two defects from exactly that.
LIVE_TRACKS: tuple[dict, ...] = (
    row("Christian", "\u271d\ufe0f"),
    row("Female General Self-Improvement", "🤍"),
    row("General Motivation / Hustle", "🌱"),
)

# Absent from niches.FALLBACK_NICHES on purpose. Anything asserted about this
# niche fails the moment the code stops reading the table and answers from the
# hardcoded seed instead.
FIXTURE_ONLY_TRACK = row("Fixture Fitness", "💪")

NICHES: tuple[dict, ...] = LIVE_TRACKS + (FIXTURE_ONLY_TRACK,)


def install() -> None:
    """Point ``niches`` at the fixture vocabulary and drop any cached list."""
    niches.reset_cache()
    niches.configure(fetch=lambda: [dict(r) for r in NICHES], clock=None)


@contextlib.contextmanager
def use_niches(rows, clock=None):
    """Run one test against a different vocabulary, then restore the fixture.

    Never restores the real reader -- see the module docstring. ``rows`` may be
    a list of dicts or a zero-arg callable (for the read-failure cases).
    """
    niches.reset_cache()
    fetch = rows if callable(rows) else (lambda: [dict(r) for r in rows])
    niches.configure(fetch=fetch, clock=clock)
    try:
        yield
    finally:
        install()


install()
