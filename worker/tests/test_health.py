"""Tracking-drift checks in /health — the process guardrail that keeps every
creator channel classified, linked, and pingable."""
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

from discord_bot.command_ui import evaluate_health  # noqa: E402


def health(**overrides):
    base = dict(
        is_admin=True,
        can_manage_channels=True,
        can_manage_roles=True,
        can_send_messages=True,
        creator_role_name="Folk Creator",
        creator_role_position=1,
        bot_top_role_name="bot",
        bot_top_role_position=9,
    )
    base.update(overrides)
    return evaluate_health(**base)


def check(report, name):
    return next(c for c in report.checks if c.name == name)


class TrackingDrift(unittest.TestCase):
    def test_all_clear_reports_ok(self):
        report = health()
        self.assertEqual(check(report, "Channel coverage").status, "ok")
        self.assertEqual(check(report, "Creator links").status, "ok")
        self.assertEqual(check(report, "Ping readiness").status, "ok")

    def test_untracked_coach_channels_fail(self):
        report = health(untracked_channels=["aidan-melograna"])
        c = check(report, "Channel coverage")
        self.assertEqual(c.status, "fail")
        self.assertIn("aidan-melograna", c.detail)

    def test_unlinked_channels_warn(self):
        report = health(unlinked_channels=["🌱improvement-austin-gavin"])
        c = check(report, "Creator links")
        self.assertEqual(c.status, "warn")
        self.assertIn("austin-gavin", c.detail)
        self.assertIn("/link", c.detail)

    def test_unpingable_creators_warn(self):
        report = health(unpingable_creators=["🤍improvement-leah (@lockedinwleah)"])
        c = check(report, "Ping readiness")
        self.assertEqual(c.status, "warn")
        self.assertIn("lockedinwleah", c.detail)


if __name__ == "__main__":
    unittest.main()
