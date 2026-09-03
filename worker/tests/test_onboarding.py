"""Channel naming for /onboard under the live convention."""
import unittest

# Env vars, sys.path and a hermetic niche vocabulary. Import it before any
# worker module: it is what keeps the suite off the network.
import nichefixture  # noqa: F401

from discord_bot.onboarding import build_channel_name  # noqa: E402

from nichefixture import row, use_niches  # noqa: E402

CROSS_VS = "\u271d\ufe0f"


class BuildChannelName(unittest.TestCase):
    """The prefix comes from research_niches, and these tests can tell.

    Every niche name here that the fixture also seeds into
    ``niches.FALLBACK_NICHES`` would answer identically if ``build_channel_name``
    stopped reading the table altogether -- which is how this class used to pass
    while silently making a live Supabase call. ``Fixture Fitness`` exists to
    close that: it has no seed entry, so only a real read produces its emoji.
    """

    def test_the_prefix_comes_from_the_table_not_the_seed(self):
        self.assertEqual(
            build_channel_name("Malik Jones", niche="Fixture Fitness"), "💪malik-jones"
        )

    def test_a_seeded_niche_missing_from_the_table_gets_no_emoji(self):
        # The other direction: a niche that IS in FALLBACK_NICHES but not in
        # the vocabulary must fall back to coaching-, or the code is answering
        # from the hardcoded seed rather than the table.
        with use_niches([row("Fixture Fitness", "💪")]):
            self.assertEqual(
                build_channel_name("Sarah", niche="Female General Self-Improvement"),
                "coaching-sarah",
            )

    def test_track_niche_sets_the_emoji_prefix(self):
        self.assertEqual(build_channel_name("Nino", niche="Christian"), f"{CROSS_VS}nino")
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
    """Adding a niche in /settings must name channels without a code change."""

    def test_a_new_niche_names_the_channel_with_its_emoji(self):
        with use_niches([row("Knitting", "🧶")]):
            self.assertEqual(build_channel_name("Ann Lee", niche="Knitting"), "🧶ann-lee")

    def test_an_archived_niche_leaves_the_naming_picker(self):
        # active_niches() drives /onboard; track_bases() (classification) still
        # reads every row, which test_niches pins separately.
        with use_niches([row("Knitting", "🧶", active=False)]):
            self.assertEqual(build_channel_name("Ann Lee", niche="Knitting"), "coaching-ann-lee")

    def test_an_unknown_niche_falls_back_to_the_legacy_prefix(self):
        with use_niches([row("Knitting", "🧶")]):
            self.assertEqual(
                build_channel_name("Malik Jones", niche="Nope"), "coaching-malik-jones"
            )



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
