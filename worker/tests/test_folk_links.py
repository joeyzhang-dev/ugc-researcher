"""[CREATOR-PROVISION] folk tracking-link provisioning from /onboard.

The behaviours worth pinning are the ones that silently corrupt data rather
than raising: a snowflake that becomes a float, and an onboarding that fails
because folk-web happened to be down.
"""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

for var, dummy in {
    "NEXT_PUBLIC_SUPABASE_URL": "http://localhost",
    "SUPABASE_SERVICE_ROLE_KEY": "test",
    "DISCORD_BOT_TOKEN": "test",
    "DISCORD_GUILD_ID": "1",
}.items():
    os.environ.setdefault(var, dummy)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from discord_bot.folk_links import provision_folk_link  # noqa: E402


class _Response:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def _capture(payload):
    """Patch urlopen, returning (result, the request that was sent)."""
    sent = {}

    def fake_urlopen(request, timeout=None):
        sent["url"] = request.full_url
        sent["headers"] = dict(request.headers)
        sent["body"] = json.loads(request.data.decode())
        return _Response(payload)

    return fake_urlopen, sent


class ProvisionFolkLink(unittest.TestCase):
    def setUp(self):
        os.environ["FOLK_PROVISION_TOKEN"] = "provision-token"
        os.environ["FOLK_API_URL"] = "https://www.folk.com"

    def test_snowflake_is_sent_as_a_string_never_a_number(self):
        # A JSON number would already be through IEEE-754 by the time
        # folk-web parsed it: ...038400 arrives as ...038300, and a corrupted
        # id deduplicates against nothing, so every re-onboard mints another
        # link for the same person.
        fake, sent = _capture(
            {"status": "created", "creator": {"username": "jas", "link_domain": None}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            provision_folk_link(discord_user_id=1335356398049038400, display_name="Jas")
        self.assertIsInstance(sent["body"]["discord_user_id"], str)
        self.assertEqual(sent["body"]["discord_user_id"], "1335356398049038400")
        self.assertNotIn("1335356398049038300", json.dumps(sent["body"]))

    def test_builds_the_default_folk_link(self):
        fake, _ = _capture(
            {"status": "created", "creator": {"username": "jas", "link_domain": None}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            result = provision_folk_link(discord_user_id="1" * 18, display_name="Jas")
        self.assertEqual(result.status, "created")
        self.assertEqual(result.url, "https://folk.com/u/jas")

    def test_uses_an_assigned_vanity_domain_when_present(self):
        fake, _ = _capture(
            {
                "status": "existing",
                "creator": {"username": "jas", "link_domain": "openyourbiblegirl.com"},
            }
        )
        with mock.patch("urllib.request.urlopen", fake):
            result = provision_folk_link(discord_user_id="1" * 18, display_name="Jas")
        self.assertEqual(result.url, "https://openyourbiblegirl.com/jas")
        self.assertEqual(result.status, "existing")

    def test_sends_the_token_as_a_header_and_never_in_the_url(self):
        fake, sent = _capture(
            {"status": "created", "creator": {"username": "jas"}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            provision_folk_link(discord_user_id="1" * 18, display_name="Jas")
        self.assertEqual(sent["headers"].get("X-admin-token"), "provision-token")
        self.assertNotIn("provision-token", sent["url"])

    def test_it_never_reaches_for_folks_shared_admin_token(self):
        # The shared token also opens sandbox deletion and release activation.
        # This worker must not fall back to it under any circumstance.
        os.environ.pop("FOLK_PROVISION_TOKEN")
        os.environ["FOLK_ADMIN_TOKEN"] = "the-powerful-shared-token"
        called = []
        try:
            with mock.patch("urllib.request.urlopen", lambda *a, **k: called.append(1)):
                result = provision_folk_link(discord_user_id="1" * 18, display_name="Jas")
        finally:
            os.environ.pop("FOLK_ADMIN_TOKEN", None)
        self.assertEqual(result.status, "skipped")
        self.assertEqual(called, [], "must not call folk-web with the shared token")

    def test_a_missing_token_is_skipped_not_an_unauthenticated_call(self):
        os.environ.pop("FOLK_PROVISION_TOKEN")
        called = []
        with mock.patch("urllib.request.urlopen", lambda *a, **k: called.append(1)):
            result = provision_folk_link(discord_user_id="1" * 18, display_name="Jas")
        self.assertEqual(result.status, "skipped")
        self.assertEqual(called, [], "must not call folk-web without a credential")

    def test_a_conflict_asks_a_human_to_link_rather_than_duplicating(self):
        import urllib.error

        err = urllib.error.HTTPError(
            "u", 409, "conflict", {},
            io_wrapper := __import__("io").BytesIO(
                json.dumps(
                    {"status": "needs_link", "conflicts": [{"username": "jas"}]}
                ).encode()
            ),
        )
        del io_wrapper
        with mock.patch("urllib.request.urlopen", mock.Mock(side_effect=err)):
            result = provision_folk_link(discord_user_id="9" * 18, display_name="Jas")
        self.assertEqual(result.status, "needs_link")
        self.assertIsNone(result.url)
        self.assertIn("jas", result.detail)

    def test_folk_web_being_down_never_raises(self):
        # Onboarding must still create the channel, role and welcome message.
        import urllib.error

        with mock.patch(
            "urllib.request.urlopen",
            mock.Mock(side_effect=urllib.error.URLError("connection refused")),
        ):
            result = provision_folk_link(discord_user_id="1" * 18, display_name="Jas")
        self.assertEqual(result.status, "error")
        self.assertIsNone(result.url)

    def test_an_upstream_error_body_is_not_echoed_to_discord(self):
        import io
        import urllib.error

        err = urllib.error.HTTPError(
            "u", 500, "boom", {}, io.BytesIO(b'{"error":"secret internal detail"}')
        )
        with mock.patch("urllib.request.urlopen", mock.Mock(side_effect=err)):
            result = provision_folk_link(discord_user_id="1" * 18, display_name="Jas")
        self.assertEqual(result.status, "error")
        self.assertNotIn("secret internal detail", result.detail)


if __name__ == "__main__":
    unittest.main()
