"""Channel naming for /onboard under the live convention."""
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

from discord_bot.onboarding import build_channel_name  # noqa: E402


class BuildChannelName(unittest.TestCase):
    def test_track_niche_sets_the_emoji_prefix(self):
        self.assertEqual(build_channel_name("Nino", niche="Christian"), "✝️nino")
        self.assertEqual(
            build_channel_name("Sarah", niche="Female General Self-Improvement"),
            "🤍sarah",
        )
        self.assertEqual(
            build_channel_name("Cole", niche="General Motivation / Hustle"),
            "🌱cole",
        )

    def test_no_track_keeps_the_legacy_prefix(self):
        self.assertEqual(build_channel_name("Malik 💪"), "coaching-malik")

    def test_unknown_track_keeps_the_legacy_prefix(self):
        self.assertEqual(build_channel_name("Ann", niche="Knitting"), "coaching-ann")


if __name__ == "__main__":
    unittest.main()
