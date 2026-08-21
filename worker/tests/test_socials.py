"""/socials pure helpers: input normalization and the view formatting."""
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

from discord_bot.socials import PLATFORMS, format_socials, normalize_social  # noqa: E402


class NormalizeSocial(unittest.TestCase):
    def test_full_urls_pass_through_trimmed(self):
        self.assertEqual(
            normalize_social("instagram", "  https://www.instagram.com/amrinrants/ "),
            "https://www.instagram.com/amrinrants/",
        )

    def test_handles_become_profile_urls(self):
        self.assertEqual(
            normalize_social("instagram", "@amrinrants"),
            "https://www.instagram.com/amrinrants/",
        )
        self.assertEqual(
            normalize_social("tiktok", "amrinrants"),
            "https://www.tiktok.com/@amrinrants",
        )

    def test_garbage_is_rejected(self):
        self.assertIsNone(normalize_social("instagram", "not a handle!!"))
        self.assertIsNone(normalize_social("instagram", ""))
        self.assertIsNone(normalize_social("instagram", "ftp://weird"))

    def test_url_must_belong_to_the_named_platform(self):
        # Otherwise /socials view renders an unrelated link under the
        # Instagram label and reading it gives no hint anything is wrong.
        self.assertIsNone(normalize_social("instagram", "https://example.com/amrinrants"))
        self.assertIsNone(
            normalize_social("instagram", "https://www.tiktok.com/@amrinrants")
        )
        self.assertIsNone(
            normalize_social("tiktok", "https://www.instagram.com/amrinrants/")
        )

    def test_platform_subdomains_still_pass(self):
        for url in (
            "https://instagram.com/amrinrants",
            "https://www.instagram.com/amrinrants/",
        ):
            self.assertEqual(normalize_social("instagram", url), url)
        self.assertEqual(
            normalize_social("tiktok", "https://vm.tiktok.com/ZMabc/"),
            "https://vm.tiktok.com/ZMabc/",
        )


class FormatSocials(unittest.TestCase):
    def test_lists_every_platform_with_missing_lines(self):
        text = format_socials("@amrinrants", {"instagram": "https://www.instagram.com/amrinrants/"})
        self.assertIn("@amrinrants", text)
        self.assertIn("Instagram", text)
        self.assertIn("https://www.instagram.com/amrinrants/", text)
        self.assertIn("TikTok", text)
        self.assertIn("missing", text)

    def test_covers_all_tracked_platforms(self):
        text = format_socials("x", {})
        for platform in PLATFORMS:
            self.assertIn(platform.capitalize() if platform != "tiktok" else "TikTok", text)


if __name__ == "__main__":
    unittest.main()
