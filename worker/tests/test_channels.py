"""Channel classification: emoji-only track names, with legacy fallbacks.

Run: python3 -m unittest discover worker/tests
"""
import unittest

# Env vars, sys.path and a hermetic niche vocabulary. Import it before any
# worker module: it is what keeps the suite off the network.
import nichefixture  # noqa: F401

from discord_pull_worker import (  # noqa: E402
    VERIFIED_HANDLES,
    _identify_creator,
    _name_needles,
    classify_creator_channels,
    derive_creator_name,
    match_roster,
    split_track_channel,
)

from nichefixture import row, use_niches  # noqa: E402

CROSS = "\u271d"
CROSS_VS = "\u271d\ufe0f"

# The vocabulary comes from nichefixture, installed process-wide on import.
# This module deliberately does NOT configure or restore `niches` itself: the
# reader is a module global, so a tearDown here changes what every later test
# module sees, and restoring the real reader is what used to leave
# test_onboarding making a live Supabase call.


def text_channel(cid, name, parent_id=None):
    return {"id": str(cid), "type": 0, "name": name, "parent_id": parent_id}


def category(cid, name):
    return {"id": str(cid), "type": 4, "name": name}


class SplitTrackChannel(unittest.TestCase):
    """The one parser behind classification, naming and renames."""

    def test_emoji_only_names(self):
        self.assertEqual(split_track_channel(f"{CROSS_VS}jas"), ("Christian", "jas"))
        self.assertEqual(
            split_track_channel("🤍emma"), ("Female General Self-Improvement", "emma")
        )
        self.assertEqual(
            split_track_channel("🌱austin-gavin"),
            ("General Motivation / Hustle", "austin-gavin"),
        )

    def test_variation_selector_is_optional(self):
        # The cross without U+FE0F is the same track as the cross with it.
        self.assertEqual(split_track_channel(f"{CROSS}jas"), ("Christian", "jas"))

    def test_legacy_niche_word_is_dropped(self):
        self.assertEqual(split_track_channel(f"{CROSS_VS}christian-jas"), ("Christian", "jas"))
        self.assertEqual(
            split_track_channel("🤍improvement-anna🌸"),
            ("Female General Self-Improvement", "anna🌸"),
        )
        self.assertEqual(
            split_track_channel("🌱improvement-ben-u"),
            ("General Motivation / Hustle", "ben-u"),
        )

    def test_creator_actually_named_after_a_track_word(self):
        # No dash after the word means the word IS the creator's name.
        self.assertEqual(split_track_channel(f"{CROSS_VS}christian"), ("Christian", "christian"))

    def test_non_track_names_return_none(self):
        self.assertIsNone(split_track_channel("coaching-ann"))
        self.assertIsNone(split_track_channel("🦄kim-lee"))
        self.assertIsNone(split_track_channel("folk-branding"))
        self.assertIsNone(split_track_channel(CROSS_VS))  # bare emoji, no name

    def test_decorative_separator_after_the_emoji_is_not_a_creator_channel(self):
        # Server furniture puts punctuation after its emoji (🌱・guide);
        # creator names start right after the track emoji.
        self.assertIsNone(split_track_channel("🌱・getting-started"))


class EmojiOnlyConvention(unittest.TestCase):
    def classify(self, *channels):
        return classify_creator_channels(list(channels))

    def test_track_emoji_alone_carries_the_niche(self):
        rows = self.classify(
            text_channel(1, f"{CROSS_VS}jas"),
            text_channel(2, "🤍emma"),
            text_channel(3, "🌱cole"),
        )
        self.assertEqual(
            [(r["niche"], r["creator_name"]) for r in rows],
            [
                ("Christian", "jas"),
                ("Female General Self-Improvement", "emma"),
                ("General Motivation / Hustle", "cole"),
            ],
        )

    def test_emoji_tail_stripped_from_creator_name(self):
        rows = self.classify(text_channel(1, "🤍anna🌸"))
        self.assertEqual(rows[0]["creator_name"], "anna")

    def test_multi_word_creator_names_survive(self):
        rows = self.classify(text_channel(1, "🌱austin-gavin"))
        self.assertEqual(rows[0]["creator_name"], "austin-gavin")

    def test_legacy_niche_word_still_parses_during_the_rename(self):
        rows = self.classify(
            text_channel(1, f"{CROSS_VS}christian-jas"),
            text_channel(2, "🤍improvement-anna🌸"),
            text_channel(3, "🌱improvement-terai"),
        )
        self.assertEqual(
            [(r["niche"], r["creator_name"]) for r in rows],
            [
                ("Christian", "jas"),
                ("Female General Self-Improvement", "anna"),
                ("General Motivation / Hustle", "terai"),
            ],
        )

    def test_unknown_emoji_does_not_classify(self):
        # A new track exists only once its emoji is in research_niches —
        # guessing from an unmapped emoji would misparse 🦄kim-lee. /health
        # flags these as untracked instead.
        self.assertEqual(self.classify(text_channel(1, "🦄kim-lee")), [])

    def test_wordy_names_without_an_emoji_do_not_classify(self):
        self.assertEqual(
            self.classify(
                text_channel(1, "christian-nino"),
                text_channel(2, "folk-branding"),
            ),
            [],
        )

    def test_decorative_emoji_channels_are_not_creator_channels(self):
        rows = self.classify(
            text_channel(1, "📃・creator-brief"),
            text_channel(2, "🙏-double-dip-method"),
            text_channel(3, "\U0001f5e3\ufe0f\u30fbapp-feedback"),
        )
        self.assertEqual(rows, [])

    def test_coach_team_category_rides_along(self):
        rows = self.classify(
            category(9, "Coach: Will's Team"),
            text_channel(1, f"{CROSS_VS}jas", parent_id="9"),
        )
        self.assertEqual(rows[0]["niche"], "Christian")
        self.assertEqual(rows[0]["category"], "Coach: Will's Team")


class LegacyCoachingConvention(unittest.TestCase):
    def test_coaching_prefix_with_category_niche(self):
        rows = classify_creator_channels(
            [
                category(9, "Creators: 💸 Finance General"),
                text_channel(1, "coaching-cole", parent_id="9"),
            ]
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["niche"], "Finance General")
        self.assertEqual(rows[0]["creator_name"], "cole")

    def test_coach_team_is_never_mistaken_for_a_niche(self):
        rows = classify_creator_channels(
            [
                category(9, "Coach: Luke's Team"),
                text_channel(1, "coaching-zoran", parent_id="9"),
            ]
        )
        self.assertIsNone(rows[0]["niche"])
        self.assertEqual(rows[0]["category"], "Coach: Luke's Team")


class DeriveCreatorName(unittest.TestCase):
    def test_legacy_prefixes(self):
        self.assertEqual(derive_creator_name("coaching-malik💪"), "malik")
        self.assertEqual(derive_creator_name("influencer-breezy"), "breezy")

    def test_emoji_only_names(self):
        self.assertEqual(derive_creator_name(f"{CROSS_VS}jas"), "jas")
        self.assertEqual(derive_creator_name("🤍anna🌸"), "anna")
        self.assertEqual(derive_creator_name("🌱ben-u"), "ben-u")

    def test_legacy_track_words(self):
        self.assertEqual(derive_creator_name(f"{CROSS_VS}christian-jas"), "jas")
        self.assertEqual(derive_creator_name("🌱improvement-austin-gavin"), "austin-gavin")

    def test_plain_names_pass_through(self):
        self.assertEqual(derive_creator_name("aidan-melograna"), "aidan-melograna")


class FullNameConvention(unittest.TestCase):
    """2026-08-26: ``<emoji><first>-<last>``, verbatim from Launchpoint.

    The rename exists to separate people a first name cannot: two Annas, two
    Madisons, three Jacobs. Every lookup keyed on the derived name has to keep
    working on the full form.
    """

    def test_full_names_parse_like_first_names(self):
        self.assertEqual(
            split_track_channel("🤍anna-lyashenko"),
            ("Female General Self-Improvement", "anna-lyashenko"),
        )
        self.assertEqual(derive_creator_name(f"{CROSS_VS}jas-alcantara"), "jas-alcantara")
        self.assertEqual(derive_creator_name("🌱noah-andre-terry"), "noah-andre-terry")

    def test_same_first_name_resolves_to_different_creators(self):
        # The whole point of the rename: 🤍anna vs 🤍anna🌸 used to differ only
        # by a decorative emoji, and 🌱jacob vs 🌱jake by a nickname.
        roster = {
            "floyaps_": "id-florek",
            "annalockedinn": "id-lyashenko",
            "aheadwithjacob": "id-kebede",
            "jakelocks.in": "id-kyle",
        }
        self.assertEqual(match_roster("anna-florek", roster), "id-florek")
        self.assertEqual(match_roster("anna-lyashenko", roster), "id-lyashenko")
        self.assertEqual(match_roster("jacob-kebede", roster), "id-kebede")
        self.assertEqual(match_roster("jacob-kyle", roster), "id-kyle")

    def test_every_renamed_channel_has_a_verified_handle(self):
        # A missing entry does not break an existing link (DB links win in
        # cmd_discover) but it does silently stop re-linking, so pin the set.
        for name in ("jas-alcantara", "anna-florek", "anna-lyashenko",
                     "madison-moon", "madison-pier", "jacob-kebede",
                     "jacob-kyle", "noah-andre-terry", "ben-uncanin",
                     "daeglan-oshea"):
            self.assertIn(name, VERIFIED_HANDLES, name)

    def test_needles_fall_back_to_name_tokens(self):
        # No Discord username contains "richky-lim", so identification has to
        # try the tokens or it drops to the volume tiebreaker (i.e. the coach).
        self.assertEqual(_name_needles("richky-lim"), ("richky-lim", "richky", "lim"))
        self.assertEqual(_name_needles("jas"), ("jas",))
        self.assertEqual(_name_needles("ben-u"), ("ben-u", "ben"))

    def test_creator_beats_a_louder_coach_after_the_rename(self):
        authors = [
            {"author_id": 1, "username": "coachwill", "global_name": "Will",
             "is_bot": False, "webhook_id": None, "count": 400},
            {"author_id": 2, "username": "richkylim", "global_name": "Richky",
             "is_bot": False, "webhook_id": None, "count": 12},
        ]
        self.assertEqual(_identify_creator("🌱richky-lim", authors, set()), 2)


class ClassificationFollowsTheTable(unittest.TestCase):
    """Adding a niche in /settings must classify without a code change.

    `use_niches` restores the shared fixture on exit, never the real reader --
    the vocabulary is a process global, so what this class leaves behind is
    what every later test in the run sees.
    """

    def test_a_niche_added_to_the_table_classifies_immediately(self):
        with use_niches([row("Knitting", "\U0001f9f6")]):
            self.assertEqual(split_track_channel("\U0001f9f6ann-lee"), ("Knitting", "ann-lee"))

    def test_a_niche_absent_from_the_table_does_not_classify(self):
        with use_niches([row("Knitting", "\U0001f9f6")]):
            self.assertIsNone(split_track_channel(f"{CROSS_VS}jas-alcantara"))

    def test_an_archived_niche_still_classifies(self):
        with use_niches([row("Retired", "\U0001f331", active=False)]):
            rows = classify_creator_channels([
                text_channel(1, "\U0001f331ethan-lau", parent_id="9"),
                category(9, "Coach: Joey's Team"),
            ])
            self.assertEqual(rows[0]["niche"], "Retired")

    def test_the_fixture_is_restored_afterwards(self):
        # The guard on the rule above: if a context manager ever stopped
        # restoring, the next test module in the run would go looking for a
        # live reader instead.
        with use_niches([row("Knitting", "\U0001f9f6")]):
            pass
        self.assertEqual(split_track_channel(f"{CROSS_VS}jas"), ("Christian", "jas"))


if __name__ == "__main__":
    unittest.main()
