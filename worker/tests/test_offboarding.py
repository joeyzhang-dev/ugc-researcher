"""Finding the creator channel for /offboard across naming generations."""
import asyncio
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

from discord_bot.offboarding import execute_offboarding, find_member_channel  # noqa: E402


class Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def overwrite(view=True):
    return Obj(view_channel=view)


def member(mid, display="TearaiBryers"):
    m = Obj(id=mid, display_name=display, name=display)
    # No .roles attribute on purpose: the role path short-circuits in tests.
    return m


def channel(cid, name, overwrites=None):
    return Obj(id=cid, name=name, overwrites=overwrites or {})


class FindMemberChannel(unittest.TestCase):
    def test_finds_the_channel_by_member_overwrite(self):
        terai = member(42)
        chans = [
            channel(1, "🌱improvement-cole", {member(7): overwrite()}),
            channel(2, "🌱improvement-terai", {terai: overwrite()}),
        ]
        self.assertEqual([c.id for c in find_member_channel(chans, terai)], [2])

    def test_ignores_view_denied_and_role_overwrites(self):
        terai = member(42)
        role = Obj(id=42, name="Coach")  # same id as a role target must not match a member scan
        chans = [
            channel(1, "old-channel", {terai: overwrite(view=False)}),
            channel(2, "role-channel", {role: overwrite()}),
        ]
        # The denied overwrite is not access; the role hit is filtered by type
        # duck-check (roles have a .name and no .display_name).
        self.assertEqual(find_member_channel(chans, terai), [])

    def test_multiple_matches_are_all_returned(self):
        terai = member(42)
        chans = [
            channel(1, "a", {terai: overwrite()}),
            channel(2, "b", {terai: overwrite()}),
        ]
        self.assertEqual(len(find_member_channel(chans, terai)), 2)


class OffboardFindsRenamedChannel(unittest.TestCase):
    def test_offboards_via_overwrite_when_name_and_crm_both_miss(self):
        terai = member(42, display="TearaiBryers")
        target = channel(2, "🌱improvement-terai", {terai: overwrite()})
        paused = Obj(name="Not Creating 🚫", overwrites={}, overwrites_for=lambda r: None)
        guild = Obj(
            text_channels=[channel(1, "🌱improvement-cole"), target],
            categories=[paused],
            me=None,
            default_role=Obj(id=99),
        )
        moved = []

        async def move_channel(*, channel, category, sync_permissions, reason):
            moved.append((channel.id, category.name))

        outcome = asyncio.run(execute_offboarding(
            guild=guild,
            member=terai,
            kick=False,
            creator_role_name="Folk Creator",
            move_channel=move_channel,
        ))
        self.assertTrue(outcome.ok, outcome.error)
        self.assertEqual(moved, [(2, "Not Creating 🚫")])
        self.assertEqual(outcome.channel_name, "🌱improvement-terai")

    def test_miss_everywhere_reports_the_member_not_a_made_up_name(self):
        ghost = member(42, display="TearaiBryers")
        guild = Obj(
            text_channels=[channel(1, "🌱improvement-cole")],
            categories=[Obj(name="Not Creating 🚫", overwrites={}, overwrites_for=lambda r: None)],
            me=None,
            default_role=Obj(id=99),
        )

        async def move_channel(**kw):  # pragma: no cover - must not be reached
            raise AssertionError("should not move anything")

        outcome = asyncio.run(execute_offboarding(
            guild=guild,
            member=ghost,
            kick=False,
            creator_role_name="Folk Creator",
            move_channel=move_channel,
        ))
        self.assertFalse(outcome.ok)
        self.assertIn("<@42>", outcome.error)
        self.assertNotIn("couldn't find `#", outcome.error)


if __name__ == "__main__":
    unittest.main()
