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

import niches  # noqa: E402


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



class BuildWelcomeMessage(unittest.TestCase):
    """The welcome post has to survive Discord's renderer.

    Everything referenced in it is an id, never a name: ``#some-channel``
    typed literally is inert text, and ``:tt:`` renders as nothing for anyone
    whose client cannot resolve the name. These tests pin that, because the
    failure is silent — the message posts fine and simply reads wrong.
    """

    def _links(self):
        from discord_bot import config as C
        from discord_bot.onboarding import WelcomeLinks

        return WelcomeLinks(
            post_tracking=C.DEFAULT_POST_TRACKING_CHANNEL_ID,
            warmup=C.DEFAULT_WARMUP_CHANNEL_ID,
            folk_access=C.DEFAULT_FOLK_ACCESS_CHANNEL_ID,
            setup_ig_dms=C.DEFAULT_SETUP_IG_DMS_CHANNEL_ID,
            demos=C.DEFAULT_DEMOS_CHANNEL_ID,
            demo_maker=C.DEFAULT_DEMO_MAKER_CHANNEL_ID,
            folk_domains=C.DEFAULT_FOLK_DOMAINS_CHANNEL_ID,
            trial_reel_tool=C.DEFAULT_TRIAL_REEL_TOOL_CHANNEL_ID,
            folk_branding=C.DEFAULT_FOLK_BRANDING_CHANNEL_ID,
            emoji_tiktok=C.DEFAULT_TIKTOK_EMOJI_ID,
            emoji_instagram=C.DEFAULT_INSTAGRAM_EMOJI_ID,
        )

    def test_the_greeting_pings_the_creator_and_stays_short(self):
        from discord_bot.onboarding import build_welcome_message

        msg = build_welcome_message(42, self._links())
        self.assertIn("<@42>", msg)
        # The greeting is the hello only — the tasks moved to the checklist.
        self.assertNotIn("## today", msg)
        self.assertLess(len(msg), 2000)

    def test_the_checklist_uses_id_mentions(self):
        from discord_bot.onboarding import build_onboarding_checklist_message

        msg = build_onboarding_checklist_message(self._links())
        # Nine distinct channels, every one as <#id>.
        self.assertEqual(msg.count("<#"), 9)
        self.assertNotIn("#\u30fb", msg)  # no literal "#emoji・name" text
        self.assertIn("## today", msg)
        self.assertIn("Payouts:", msg)

    def test_the_checklist_does_not_ping_again(self):
        from discord_bot.onboarding import build_onboarding_checklist_message

        # The greeting already pinged them a second earlier.
        self.assertNotIn("<@", build_onboarding_checklist_message(self._links()))

    def test_custom_emoji_carry_their_ids(self):
        from discord_bot.onboarding import build_onboarding_checklist_message

        msg = build_onboarding_checklist_message(self._links())
        self.assertIn("<:tt:", msg)
        self.assertIn("<:ig:", msg)
        # A bare :tt: would render as literal text.
        self.assertNotIn(" :tt:", msg)

    def test_both_messages_fit_in_a_single_discord_message(self):
        from discord_bot.onboarding import (
            build_onboarding_checklist_message,
            build_welcome_message,
        )

        self.assertLess(len(build_welcome_message(42, self._links())), 2000)
        self.assertLess(len(build_onboarding_checklist_message(self._links())), 2000)


if __name__ == "__main__":
    unittest.main()
