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
