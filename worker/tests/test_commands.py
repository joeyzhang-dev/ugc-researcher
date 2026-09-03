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
import os
import sys
import unittest
from pathlib import Path

for var, dummy in {
    "NEXT_PUBLIC_SUPABASE_URL": "http://localhost",
    "SUPABASE_SERVICE_ROLE_KEY": "test",
    "DISCORD_BOT_TOKEN": "test",
    "DISCORD_GUILD_ID": "1",
}.items():
    os.environ.setdefault(var, dummy)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import discord  # noqa: F401
except ImportError:
    raise unittest.SkipTest(
        "discord.py not installed under this interpreter -- "
        "run with worker/.venv/bin/python"
    )

import niches  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
