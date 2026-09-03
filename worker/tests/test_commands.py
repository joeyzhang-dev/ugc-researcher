"""/onboard's track autocomplete: the legacy escape hatch must survive the
Discord 25-choice cap.

Needs discord.py, which is only installed in worker/.venv (importing
discord_bot.commands pulls in discord.app_commands for Choice) -- so this
file skips itself outright under a plain `python3` that lacks it. Confirmed
empirically that a module-level `unittest.SkipTest` raised from a guarded
import surfaces to `unittest discover` as `ModuleSkipped` / OK, not an error
or a failure, so `python3 -m unittest discover worker/tests` still reports a
clean run; the real coverage only runs under the venv interpreter below.

Run: worker/.venv/bin/python -m unittest discover worker/tests -v
"""
import unittest

# Env vars, sys.path and a hermetic niche vocabulary. Import it before any
# worker module: it is what keeps the suite off the network.
import nichefixture  # noqa: F401

try:
    import discord  # noqa: F401
except ImportError:
    raise unittest.SkipTest(
        "discord.py not installed under this interpreter -- "
        "run with worker/.venv/bin/python"
    )

import inspect  # noqa: E402
import re  # noqa: E402

import niches  # noqa: E402
from discord_bot import commands as commands_module  # noqa: E402
from discord_bot.commands import MAX_CHOICES, build_track_choices  # noqa: E402


def fake_niches(count: int) -> tuple:
    return tuple(
        niches.Niche(name=f"Niche {i:02d}", emoji="🌱", discord_role_id=None, is_active=True)
        for i in range(count)
    )


class BuildTrackChoices(unittest.TestCase):
    """/settings can grow the active-niche roster arbitrarily large; the
    picker's own 25-choice ceiling must never be what deletes the `legacy`
    escape hatch that lets a creator be onboarded outside the tracked
    vocabulary."""

    def test_legacy_survives_when_active_niches_alone_reach_the_cap(self):
        result = build_track_choices(fake_niches(30), "", MAX_CHOICES)
        self.assertLessEqual(len(result), MAX_CHOICES)
        self.assertIn("legacy", [c.value for c in result])

    def test_the_cap_is_still_honoured(self):
        result = build_track_choices(fake_niches(30), "", MAX_CHOICES)
        self.assertEqual(len(result), MAX_CHOICES)

    def test_legacy_is_never_the_one_choice_truncation_drops(self):
        result = build_track_choices(fake_niches(30), "", MAX_CHOICES)
        self.assertEqual(result[-1].value, "legacy")

    def test_legacy_survives_a_short_list_too(self):
        result = build_track_choices(fake_niches(3), "", MAX_CHOICES)
        self.assertEqual(len(result), 4)
        self.assertIn("legacy", [c.value for c in result])

    def test_legacy_survives_when_the_needle_matches_nothing(self):
        result = build_track_choices(fake_niches(30), "no-such-niche-xyz", MAX_CHOICES)
        self.assertEqual([c.value for c in result], ["legacy"])


class NicheCachePrimedOffTheEventLoop(unittest.TestCase):
    """The niche cache is primed deliberately, not by accident.

    `build_channel_name()` -> `niche_channel_prefixes()` -> `load_niches()` is
    a SYNCHRONOUS https read on a cache miss, and both orchestrators call it
    from inside the gateway coroutine -- long enough to miss a heartbeat. It
    used to be safe only because `await asyncio.to_thread(niches.role_id_for,
    ...)` happened to be evaluated while building the call's arguments, so
    reordering or dropping that argument would silently have put the blocking
    read back on the loop. This pins the explicit prime instead.
    """

    def test_each_orchestrator_is_preceded_by_its_own_prime(self):
        src = inspect.getsource(commands_module)
        marks = [(m.start(), "prime") for m in re.finditer(r"await _prime_niches\(\)", src)]
        marks.append((src.index("await execute_onboarding("), "onboard"))
        marks.append((src.index("await execute_offboarding("), "offboard"))
        self.assertEqual(
            [kind for _, kind in sorted(marks)],
            ["prime", "onboard", "prime", "offboard"],
        )


if __name__ == "__main__":
    unittest.main()
