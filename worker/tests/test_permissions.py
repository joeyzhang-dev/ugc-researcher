"""Who may run the bot's slash commands."""
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

from discord_bot.permissions import (  # noqa: E402
    OPEN_COMMANDS,
    command_is_open,
    may_run_commands,
    staff_only_message,
)
from discord_bot.config import DEFAULT_STAFF_ROLE_IDS  # noqa: E402

COACH, DEV, FOLK_TEAM = DEFAULT_STAFF_ROLE_IDS


class Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def member(*role_ids, administrator=False):
    return Obj(
        roles=[Obj(id=r) for r in role_ids],
        guild_permissions=Obj(administrator=administrator),
    )


class MayRunCommands(unittest.TestCase):
    def test_each_staff_role_passes(self):
        for role in (COACH, DEV, FOLK_TEAM):
            self.assertTrue(may_run_commands(member(role), DEFAULT_STAFF_ROLE_IDS), role)

    def test_a_creator_is_refused(self):
        # The role every onboarded creator holds. They can see their channel;
        # they must not be able to pull anyone's earnings.
        creator_role = 1507900545359282308
        self.assertFalse(may_run_commands(member(creator_role), DEFAULT_STAFF_ROLE_IDS))

    def test_no_roles_at_all_is_refused(self):
        self.assertFalse(may_run_commands(member(), DEFAULT_STAFF_ROLE_IDS))

    def test_administrator_passes_without_a_staff_role(self):
        # The deliberate escape hatch: a role-id allowlist the server owner can
        # fall outside of is an unrecoverable lockout.
        self.assertTrue(may_run_commands(member(administrator=True), DEFAULT_STAFF_ROLE_IDS))

    def test_manage_channels_alone_no_longer_passes(self):
        # The old gate was `default_permissions(manage_channels=True)`, so
        # anyone granted channel management inherited the bot by accident.
        m = member()
        m.guild_permissions = Obj(administrator=False, manage_channels=True)
        self.assertFalse(may_run_commands(m, DEFAULT_STAFF_ROLE_IDS))

    def test_a_dm_has_no_roles_and_is_refused(self):
        self.assertFalse(may_run_commands(Obj(), DEFAULT_STAFF_ROLE_IDS))

    def test_an_empty_allowlist_refuses_rather_than_opening_up(self):
        # Fail closed: a misconfigured STAFF_ROLE_IDS must not hand the bot to
        # the whole server.
        self.assertFalse(may_run_commands(member(COACH), ()))
        self.assertTrue(may_run_commands(member(COACH, administrator=True), ()))

    def test_string_role_ids_still_match(self):
        # Discord ids arrive as strings from env config often enough to matter.
        self.assertTrue(may_run_commands(member(str(COACH)), (str(COACH),)))

    def test_the_refusal_names_the_roles_to_ask_for(self):
        msg = staff_only_message()
        for name in ("Coach", "dev", "Folk Team"):
            self.assertIn(name, msg)


class OpenCommands(unittest.TestCase):
    def test_my_stats_is_open_because_creators_need_it(self):
        # Creators hold none of the staff roles; gating /my-stats would make it
        # unusable by exactly the people it exists for.
        self.assertTrue(command_is_open("my-stats"))

    def test_every_other_command_stays_staff_only(self):
        for name in ("stats", "onboard", "offboard", "link", "creators", "creator", "health", "socials"):
            self.assertFalse(command_is_open(name), name)

    def test_the_open_list_stays_deliberately_tiny(self):
        # A guard on scope creep: anything added here is readable by the whole
        # server, so it must be a conscious change with a test to match.
        self.assertEqual(OPEN_COMMANDS, frozenset({"my-stats"}))

    def test_an_unknown_or_missing_command_is_not_open(self):
        self.assertFalse(command_is_open(None))
        self.assertFalse(command_is_open(""))
        self.assertFalse(command_is_open("my-stats-secret"))


if __name__ == "__main__":
    unittest.main()
