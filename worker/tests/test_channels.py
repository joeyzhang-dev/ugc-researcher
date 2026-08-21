"""Channel classification: emoji-only track names, with legacy fallbacks.

Run: python3 -m unittest discover worker/tests
"""
import os
import sys
import unittest
from pathlib import Path

# The worker module reads its env at import time; tests need none of it live.
for var, dummy in {
    "NEXT_PUBLIC_SUPABASE_URL": "http://localhost",
    "SUPABASE_SERVICE_ROLE_KEY": "test",
    "DISCORD_BOT_TOKEN": "test",
    "DISCORD_GUILD_ID": "1",
}.items():
    os.environ.setdefault(var, dummy)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from discord_pull_worker import (  # noqa: E402
    classify_creator_channels,
    derive_creator_name,
    split_track_channel,
)


def text_channel(cid, name, parent_id=None):
    return {"id": str(cid), "type": 0, "name": name, "parent_id": parent_id}


def category(cid, name):
    return {"id": str(cid), "type": 4, "name": name}


class SplitTrackChannel(unittest.TestCase):
    """The one parser behind classification, naming and renames."""

    def test_emoji_only_names(self):
        self.assertEqual(split_track_channel("✝️jas"), ("Christian", "jas"))
        self.assertEqual(
            split_track_channel("🤍emma"), ("Female General Self-Improvement", "emma")
        )
        self.assertEqual(
            split_track_channel("🌱austin-gavin"),
            ("General Motivation / Hustle", "austin-gavin"),
        )

    def test_variation_selector_is_optional(self):
        # ✝ without FE0F is the same track as ✝️ with it.
        self.assertEqual(split_track_channel("✝jas"), ("Christian", "jas"))

    def test_legacy_niche_word_is_dropped(self):
        self.assertEqual(split_track_channel("✝️christian-jas"), ("Christian", "jas"))
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
        self.assertEqual(split_track_channel("✝️christian"), ("Christian", "christian"))

    def test_non_track_names_return_none(self):
        self.assertIsNone(split_track_channel("coaching-ann"))
        self.assertIsNone(split_track_channel("🦄kim-lee"))
        self.assertIsNone(split_track_channel("folk-branding"))
        self.assertIsNone(split_track_channel("✝️"))  # bare emoji, no name

    def test_decorative_separator_after_the_emoji_is_not_a_creator_channel(self):
        # Server furniture puts punctuation after its emoji (🌱・guide);
        # creator names start right after the track emoji.
        self.assertIsNone(split_track_channel("🌱・getting-started"))


class EmojiOnlyConvention(unittest.TestCase):
    def classify(self, *channels):
        return classify_creator_channels(list(channels))

    def test_track_emoji_alone_carries_the_niche(self):
        rows = self.classify(
            text_channel(1, "✝️jas"),
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
            text_channel(1, "✝️christian-jas"),
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
        # A new track exists only once its emoji is in TRACK_EMOJI_NICHES —
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
            text_channel(3, "🗣️・app-feedback"),
        )
        self.assertEqual(rows, [])

    def test_coach_team_category_rides_along(self):
        rows = self.classify(
            category(9, "Coach: Will's Team"),
            text_channel(1, "✝️jas", parent_id="9"),
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
        self.assertEqual(derive_creator_name("✝️jas"), "jas")
        self.assertEqual(derive_creator_name("🤍anna🌸"), "anna")
        self.assertEqual(derive_creator_name("🌱ben-u"), "ben-u")

    def test_legacy_track_words(self):
        self.assertEqual(derive_creator_name("✝️christian-jas"), "jas")
        self.assertEqual(derive_creator_name("🌱improvement-austin-gavin"), "austin-gavin")

    def test_plain_names_pass_through(self):
        self.assertEqual(derive_creator_name("aidan-melograna"), "aidan-melograna")


if __name__ == "__main__":
    unittest.main()
