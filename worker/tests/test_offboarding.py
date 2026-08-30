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

from discord_bot.command_ui import build_offboard_message_embed  # noqa: E402
from discord_bot.offboarding import (  # noqa: E402
    build_offboard_message,
    coach_from_category,
    execute_offboarding,
    find_member_channel,
)


class Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def overwrite(view=True):
    return Obj(view_channel=view)


def member(mid, display="TearaiBryers"):
    m = Obj(id=mid, display_name=display, name=display)
    # No .roles attribute on purpose: the role path short-circuits in tests.
    return m


def channel(cid, name, overwrites=None, category=None):
    return Obj(id=cid, name=name, overwrites=overwrites or {}, category=category)


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


class RetainsCreatorAccess(unittest.TestCase):
    """The move syncs permissions, which wipes the creator's own overwrite.
    /offboard has to put exactly that one back."""

    def _guild_and_member(self):
        terai = member(42)
        terai.roles = []  # a real Member, still in the guild
        target = channel(2, "🌱improvement-terai", {terai: overwrite()})
        paused = Obj(name="Not Creating 🚫", overwrites={}, overwrites_for=lambda r: None)
        guild = Obj(
            text_channels=[target],
            categories=[paused],
            me=None,
            default_role=Obj(id=99),
        )
        return guild, terai

    def test_grants_the_creator_read_and_post_after_the_move(self):
        guild, terai = self._guild_and_member()
        calls = []

        async def move_channel(**kw):
            calls.append(("move", kw["channel"].id))

        async def grant_channel_access(*, channel, member, permissions, reason):
            calls.append(("grant", channel.id, member.id, permissions))

        outcome = asyncio.run(execute_offboarding(
            guild=guild,
            member=terai,
            kick=False,
            creator_role_name="Folk Creator",
            move_channel=move_channel,
            grant_channel_access=grant_channel_access,
        ))
        self.assertTrue(outcome.ok, outcome.error)
        self.assertTrue(outcome.access_retained)
        self.assertIsNone(outcome.access_error)
        # Order matters: syncing permissions first would wipe the grant.
        self.assertEqual(
            calls,
            [
                ("move", 2),
                ("grant", 2, 42, {
                    "view_channel": True,
                    "send_messages": True,
                    "read_message_history": True,
                }),
            ],
        )

    def test_skips_the_grant_when_the_member_is_kicked(self):
        guild, terai = self._guild_and_member()
        terai.top_role = Obj(position=1, name="Folk Creator")
        guild.me = Obj(
            top_role=Obj(position=5, name="mach ugc"),
            roles=[Obj(position=5, name="mach ugc")],
            guild_permissions=Obj(kick_members=True),
        )
        granted = []

        async def move_channel(**kw):
            pass

        async def grant_channel_access(**kw):  # pragma: no cover - must not run
            granted.append(kw)

        async def kick_member(*, member, reason):
            pass

        outcome = asyncio.run(execute_offboarding(
            guild=guild,
            member=terai,
            kick=True,
            creator_role_name="Folk Creator",
            move_channel=move_channel,
            grant_channel_access=grant_channel_access,
            kick_member=kick_member,
        ))
        self.assertTrue(outcome.ok, outcome.error)
        self.assertTrue(outcome.kicked)
        self.assertFalse(outcome.access_retained)
        self.assertEqual(granted, [])

    def test_a_failed_grant_is_reported_and_does_not_undo_the_move(self):
        guild, terai = self._guild_and_member()

        async def move_channel(**kw):
            pass

        async def grant_channel_access(**kw):
            raise RuntimeError("403 Forbidden")

        outcome = asyncio.run(execute_offboarding(
            guild=guild,
            member=terai,
            kick=False,
            creator_role_name="Folk Creator",
            move_channel=move_channel,
            grant_channel_access=grant_channel_access,
        ))
        self.assertTrue(outcome.ok)
        self.assertTrue(outcome.channel_moved)
        self.assertFalse(outcome.access_retained)
        self.assertIn("403 Forbidden", outcome.access_error)

    def test_a_member_who_already_left_is_not_granted_anything(self):
        guild, terai = self._guild_and_member()
        del terai.roles  # a bare User: they are gone, an overwrite grants nothing
        granted = []

        async def move_channel(**kw):
            pass

        async def grant_channel_access(**kw):  # pragma: no cover - must not run
            granted.append(kw)

        outcome = asyncio.run(execute_offboarding(
            guild=guild,
            member=terai,
            kick=False,
            creator_role_name="Folk Creator",
            move_channel=move_channel,
            grant_channel_access=grant_channel_access,
        ))
        self.assertTrue(outcome.ok, outcome.error)
        self.assertFalse(outcome.access_retained)
        self.assertEqual(granted, [])


class CoachFromCategory(unittest.TestCase):
    def test_reads_the_coach_off_a_team_category(self):
        self.assertEqual(coach_from_category("Coach: Will's Team"), "Will")
        self.assertEqual(coach_from_category("🏀 Luke's Team"), "Luke")
        self.assertEqual(coach_from_category("Vincent Team"), "Vincent")

    def test_generic_buckets_name_nobody(self):
        # Guessing here would put the wrong person's name in a message about
        # cutting someone.
        for bucket in ("FOLK TEAM", "Not Creating 🚫", "Creators: 💸 Finance General", None, ""):
            self.assertIsNone(coach_from_category(bucket), bucket)


class OffboardMessage(unittest.TestCase):
    def test_fills_in_the_creator_and_the_coach(self):
        msg = build_offboard_message(username="jasalcantara", coach_name="Will")
        self.assertTrue(msg.startswith("hey @jasalcantara , after some long thought with "))
        self.assertIn("@_willwilson. and @lukeugc", msg)
        self.assertIn("Will and I appreciate the time", msg)
        self.assertIn("**this** specific campaign", msg)
        self.assertIn(":heart:", msg)

    def test_missing_values_leave_a_visible_placeholder(self):
        msg = build_offboard_message(username=None, coach_name=None)
        self.assertIn("@[creator]", msg)
        self.assertIn("[coach] and I appreciate", msg)

    def test_the_embed_wraps_it_in_a_code_block(self):
        spec = build_offboard_message_embed(
            build_offboard_message(username="jas", coach_name="Will"), coach_name="Will"
        )
        self.assertTrue(spec.description.startswith("```\nhey @jas"))
        self.assertTrue(spec.description.endswith("```"))
        self.assertIsNone(spec.footer)
        # The emphasis is meant to survive into the sent message, unescaped.
        self.assertIn("**this**", spec.description)

    def test_the_embed_flags_an_unknown_coach(self):
        spec = build_offboard_message_embed(
            build_offboard_message(username="jas", coach_name=None), coach_name=None
        )
        self.assertIn("[coach]", spec.footer)

    def test_the_coach_comes_from_the_category_before_the_move(self):
        terai = member(42)
        terai.name = "teraibryers"
        target = channel(
            2, "🌱improvement-terai", {terai: overwrite()},
            category=Obj(name="Coach: Will's Team"),
        )
        paused = Obj(name="Not Creating 🚫", overwrites={}, overwrites_for=lambda r: None)
        guild = Obj(
            text_channels=[target], categories=[paused], me=None, default_role=Obj(id=99),
        )

        async def move_channel(*, channel, category, sync_permissions, reason):
            channel.category = category  # the move destroys the coach record

        outcome = asyncio.run(execute_offboarding(
            guild=guild,
            member=terai,
            kick=False,
            creator_role_name="Folk Creator",
            move_channel=move_channel,
        ))
        self.assertTrue(outcome.ok, outcome.error)
        self.assertEqual(outcome.coach_name, "Will")
        self.assertIn("hey @teraibryers ,", outcome.offboard_message)
        self.assertIn("Will and I appreciate", outcome.offboard_message)


if __name__ == "__main__":
    unittest.main()
