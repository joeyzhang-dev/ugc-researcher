"""What /offboard writes to the CRM.

The gap this covers: offboarding moved the Discord channel into
"Not Creating 🚫" and PATCHed the channel row's category, and stopped there.
research_creators kept a null archived_at, so every app-side gate that asks
"are we still working with this person" — the scrape queue, the roster view,
and the daily/weekly creator recaps — answered yes. On 2026-09-01 that pinged
six cut creators with a recap in the channel they had been moved out of.
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

import discord_pull_worker as pull  # noqa: E402
from discord_bot import store  # noqa: E402


class FakeSb:
    """Records every PostgREST call and replays canned answers."""

    def __init__(self, channel_rows, creator_rows=None):
        self.channel_rows = channel_rows
        self.creator_rows = creator_rows if creator_rows is not None else [{"id": "c1"}]
        self.calls = []

    def __call__(self, method, path, body=None, prefer=None):
        self.calls.append((method, path, body))
        if path.startswith("research_discord_channels"):
            return self.channel_rows
        if path.startswith("research_creators"):
            return self.creator_rows
        return []

    def patches(self, table):
        return [c for c in self.calls if c[0] == "PATCH" and c[1].startswith(table)]


class OffboardCreatorChannel(unittest.TestCase):
    def setUp(self):
        self._real = pull.sb
        self.addCleanup(lambda: setattr(pull, "sb", self._real))

    def use(self, fake):
        pull.sb = fake
        return fake

    def test_moves_the_channel_to_the_paused_category(self):
        fake = self.use(FakeSb([{"channel_id": "10", "research_creator_id": "c1"}]))
        self.assertTrue(store.offboard_creator_channel(10))
        (_, path, body), = fake.patches("research_discord_channels")
        self.assertIn("channel_id=eq.10", path)
        self.assertEqual(body, {"category": store.PAUSED_CATEGORY})

    def test_archives_the_linked_creator(self):
        fake = self.use(FakeSb([{"channel_id": "10", "research_creator_id": "c1"}]))
        store.offboard_creator_channel(10)
        patches = fake.patches("research_creators")
        self.assertEqual(len(patches), 1, "the creator row must be archived too")
        _, path, body = patches[0]
        self.assertIn("id=eq.c1", path)
        self.assertTrue(body["archived_at"].endswith("Z"))
        self.assertIn("offboard", body["archived_reason"].lower())

    def test_does_not_move_an_existing_archive_date(self):
        """A re-run of /offboard must not restamp when they actually left."""
        fake = self.use(FakeSb([{"channel_id": "10", "research_creator_id": "c1"}]))
        store.offboard_creator_channel(10)
        _, path, _ = fake.patches("research_creators")[0]
        self.assertIn("archived_at=is.null", path)

    def test_archives_nothing_when_the_channel_has_no_creator(self):
        fake = self.use(FakeSb([{"channel_id": "10", "research_creator_id": None}]))
        self.assertTrue(store.offboard_creator_channel(10))
        self.assertEqual(fake.patches("research_creators"), [])

    def test_reports_failure_when_the_channel_patch_matched_nothing(self):
        fake = self.use(FakeSb([]))
        self.assertFalse(store.offboard_creator_channel(10))
        self.assertEqual(fake.patches("research_creators"), [])


if __name__ == "__main__":
    unittest.main()
