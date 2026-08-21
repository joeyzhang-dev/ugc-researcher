"""Pager rendering must mirror src/lib/discord-send.ts exactly —
same V2 component shapes, same custom_id contract, same clamps."""
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

from discord_bot.script_pager import (  # noqa: E402
    MAX_V2_CHARS,
    collect_text,
    detect_platform,
    extract_video_url,
    parse_test_ids,
    render_page,
    target_bitrate_kbps,
    test_marker,
)


def script(**over):
    row = {
        "id": "s1",
        "hook": "4 things you should not be doing",
        "body": "Number one is cussing.",
        "inspo_url": "https://www.instagram.com/reel/x/",
        "demo": "Folk saving you $500",
        "songs": "Every living breathing moment",
    }
    row.update(over)
    return row


def container(page):
    return next(c for c in page["components"] if c["type"] == 17)


def buttons(page):
    row = next(c for c in container(page)["components"] if c["type"] == 1)
    return {b["label"]: b for b in row["components"]}


class RenderPage(unittest.TestCase):
    def test_v2_card_with_sections(self):
        page = render_page([script()], 0, video_url=None)
        self.assertEqual(page["flags"], 1 << 15)
        self.assertNotIn("content", page)
        self.assertNotIn("embeds", page)
        all_text = "\n".join(collect_text(page["components"]))
        self.assertIn("## 4 things you should not be doing", all_text)
        self.assertIn("### Script", all_text)
        self.assertIn("### Demo to use", all_text)
        self.assertIn("### Song(s) to use", all_text)
        self.assertIn("-# Script 1/1", all_text)

    def test_video_lives_inside_the_container_by_public_url(self):
        # External URL, not an upload — flips stay a pure JSON edit.
        page = render_page([script()], 0, video_url="https://store/x.mp4")
        gallery = next(c for c in container(page)["components"] if c["type"] == 12)
        self.assertEqual(gallery["items"][0]["media"]["url"], "https://store/x.mp4")

    def test_link_line_only_without_video_url(self):
        with_video = render_page([script()], 0, video_url="https://store/x.mp4")
        without = render_page([script()], 0, video_url=None)
        self.assertNotIn("Inspo video\nhttps", "\n".join(collect_text(with_video["components"])))
        self.assertIn("https://www.instagram.com/reel/x/", "\n".join(collect_text(without["components"])))

    def test_nav_contract_without_posted_button(self):
        scripts = [script(), script(id="s2"), script(id="s3")]
        b = buttons(render_page(scripts, 1, video_url=None))
        self.assertEqual(b["◀ Prev"]["custom_id"], "scrnav:0")
        self.assertEqual(b["Next ▶"]["custom_id"], "scrnav:2")
        # Tracking lives in the webapp; the self-report button is gone.
        self.assertNotIn("✅ I posted this", b)
        first = buttons(render_page(scripts, 0, video_url=None))
        self.assertTrue(first["◀ Prev"]["disabled"])

    def test_single_script_without_inspo_still_offers_the_note_button(self):
        b = buttons(render_page([script(inspo_url=None)], 0, video_url=None))
        self.assertEqual(list(b), ["📝 Note"])

    def test_single_script_with_inspo_keeps_the_link_and_the_note(self):
        b = buttons(render_page([script()], 0, video_url=None))
        self.assertEqual(list(b), ["Inspo video", "📝 Note"])

    def test_view_all_gets_its_own_row_with_the_green_book_emoji(self):
        page = render_page(
            [script()], 0, video_url=None,
            view_all_url="https://bludgc.vercel.app/c/abc123",
        )
        rows = [c for c in container(page)["components"] if c["type"] == 1]
        self.assertEqual(len(rows), 2)
        (view_all,) = rows[1]["components"]
        self.assertEqual(view_all["label"], "View all scripts")
        self.assertEqual(view_all["url"], "https://bludgc.vercel.app/c/abc123")
        self.assertEqual(view_all["emoji"], {"name": "📗"})
        self.assertNotIn("custom_id", view_all)

    def test_single_button_row_without_portal_url(self):
        page = render_page([script()], 0, video_url=None)
        rows = [c for c in container(page)["components"] if c["type"] == 1]
        self.assertEqual(len(rows), 1)
        self.assertNotIn("View all scripts", buttons(page))

    def test_canonical_number_lands_in_the_heading(self):
        page = render_page([script(number=5)], 0, video_url=None)
        texts = "\n".join(collect_text(page["components"]))
        self.assertIn("## #5 — 4 things you should not be doing", texts)

    def test_heading_stays_plain_without_a_number(self):
        page = render_page([script()], 0, video_url=None)
        texts = "\n".join(collect_text(page["components"]))
        self.assertIn("## 4 things", texts)
        self.assertNotIn("## #", texts)

    def test_unpaged_cards_keep_numbering_but_drop_nav(self):
        scripts = [script(), script(id="s2"), script(id="s3")]
        page = render_page(scripts, 1, video_url=None, paged=False)
        b = buttons(page)
        self.assertNotIn("◀ Prev", b)
        self.assertNotIn("Next ▶", b)
        self.assertIn("-# Script 2/3", "\n".join(collect_text(page["components"])))

    def test_leading_texts_re_render_verbatim_above_the_container(self):
        page = render_page(
            [script()], 0, video_url=None,
            leading=["**New scripts for Folk** — <@123>", "-# 🧪 marker"],
        )
        pre = [c["content"] for c in page["components"] if c["type"] == 10]
        self.assertEqual(pre, ["**New scripts for Folk** — <@123>", "-# 🧪 marker"])
        self.assertEqual(page["components"][-1]["type"], 17)

    def test_note_button_carries_the_script_id_not_the_page(self):
        scripts = [script(), script(id="s2"), script(id="s3")]
        b = buttons(render_page(scripts, 1, video_url=None))
        self.assertEqual(b["📝 Note"]["custom_id"], "scrnote:s2")

    def test_orders_video_right_above_demo(self):
        page = render_page([script()], 0, video_url="https://store/x.mp4")
        kids = container(page)["components"]
        i_script = next(i for i, c in enumerate(kids)
                        if c["type"] == 10 and c.get("content", "").startswith("### Script"))
        i_gallery = next(i for i, c in enumerate(kids) if c["type"] == 12)
        i_meta = next(i for i, c in enumerate(kids)
                      if c["type"] == 10 and c.get("content", "").startswith("### Demo"))
        self.assertGreater(i_gallery, i_script)
        self.assertGreater(i_meta, i_gallery)

    def test_marker_rides_as_text_display(self):
        page = render_page([script()], 0, video_url="https://store/x.mp4", marker=test_marker(["a", "b"]))
        self.assertIn("||scr:a,b||", "\n".join(collect_text(page["components"])))

    def test_total_text_stays_under_v2_budget(self):
        page = render_page(
            [script(body="x" * 6000, demo="y" * 2000, songs="z" * 2000)], 0, video_url=None
        )
        self.assertLessEqual(len("".join(collect_text(page["components"]))), 4000)


class CollectText(unittest.TestCase):
    def test_walks_nested_containers(self):
        tree = [
            {"type": 17, "components": [{"type": 10, "content": "inner"}]},
            {"type": 10, "content": "outer"},
        ]
        self.assertEqual(collect_text(tree), ["inner", "outer"])


class ParseTestIds(unittest.TestCase):
    def test_round_trips_the_marker(self):
        self.assertEqual(parse_test_ids(test_marker(["aaa-1", "bbb-2"])), ["aaa-1", "bbb-2"])

    def test_returns_empty_for_ordinary_text(self):
        self.assertEqual(parse_test_ids("## Script 1/3\nsome text"), [])
        self.assertEqual(parse_test_ids(""), [])


class TestExtOverlay(unittest.TestCase):
    """Until the columns migration lands, test sends smuggle the dressed
    fields in an ||ext:json|| spoiler; the pager overlays them onto the
    DB rows so page flips keep their videos and sections."""

    def test_parse_and_merge(self):
        from discord_bot.script_pager import merge_ext, parse_test_ext

        ext = {"s1": {"inspo_url": "https://x/", "demo": "d"}}
        text = f"marker stuff ||ext:{__import__('json').dumps(ext)}||"
        self.assertEqual(parse_test_ext(text), ext)
        merged = merge_ext([{"id": "s1", "hook": "h"}, {"id": "s2"}], ext)
        self.assertEqual(merged[0]["inspo_url"], "https://x/")
        self.assertEqual(merged[0]["hook"], "h")
        self.assertNotIn("inspo_url", merged[1])

    def test_parse_returns_empty_without_ext(self):
        from discord_bot.script_pager import parse_test_ext

        self.assertEqual(parse_test_ext(test_marker(["a"])), {})

    def test_find_marker_text_returns_the_display_verbatim(self):
        from discord_bot.script_pager import find_marker_text

        marker = test_marker(["a"]) + '\n||ext:{"a":{"demo":"d"}}||'
        self.assertEqual(find_marker_text(["## title", marker, "-# foot"]), marker)
        self.assertIsNone(find_marker_text(["## title"]))


class SkipSentinel(unittest.TestCase):
    def test_expires_so_transient_failures_do_not_poison_forever(self):
        import os as _os
        import tempfile
        import time
        from pathlib import Path as _Path

        from discord_bot.script_pager import SKIP_TTL_SECONDS, _skip_active

        with tempfile.TemporaryDirectory() as d:
            skip = _Path(d) / "x.skip"
            skip.touch()
            self.assertTrue(_skip_active(skip))
            stale = time.time() - SKIP_TTL_SECONDS - 5
            _os.utime(skip, (stale, stale))
            self.assertFalse(_skip_active(skip))
            self.assertFalse(_skip_active(_Path(d) / "missing.skip"))


class FetchQueries(unittest.TestCase):
    def test_fetch_selects_star_so_missing_columns_cannot_400(self):
        import discord_bot.script_pager as sp

        captured = []
        original = sp.pull.sb
        sp.pull.sb = lambda method, path, *a, **k: (captured.append(path), [])[1]
        try:
            sp.fetch_scripts_by_ids(["abc"])
        finally:
            sp.pull.sb = original
        self.assertIn("select=*", captured[0])


class Notes(unittest.TestCase):
    def test_modal_note_value_walks_the_submit_payload(self):
        data = {
            "custom_id": "scrnotem:s1",
            "components": [
                {"type": 1, "components": [
                    {"type": 4, "custom_id": "note", "value": "  hook feels long  "},
                ]},
            ],
        }
        from discord_bot.script_pager import modal_note_value

        self.assertEqual(modal_note_value(data), "hook feels long")
        self.assertEqual(modal_note_value({}), "")

    def _run_append(self, existing, calls):
        import discord_bot.script_pager as sp

        def fake_sb(method, path, body=None, *a, **k):
            calls.append((method, path, body))
            if method == "GET":
                return [{"notes": existing}]
            return [{"id": "s1"}]

        original = sp.pull.sb
        sp.pull.sb = fake_sb
        try:
            return sp.append_note("s1", "joey", "hook feels long")
        finally:
            sp.pull.sb = original

    def test_append_note_appends_an_attributed_line(self):
        calls = []
        self.assertTrue(self._run_append("old line", calls))
        method, path, body = calls[-1]
        self.assertEqual(method, "PATCH")
        self.assertIn("id=eq.s1", path)
        # Existing notes survive: append, never overwrite — the modal never
        # shows the current notes, so a submit must not clobber them.
        self.assertTrue(body["notes"].startswith("old line\n["))
        self.assertTrue(body["notes"].endswith(" joey] hook feels long"))

    def test_append_note_starts_clean_without_existing_notes(self):
        calls = []
        self.assertTrue(self._run_append(None, calls))
        self.assertTrue(calls[-1][2]["notes"].startswith("["))

    def test_append_note_rejects_empty_text(self):
        import discord_bot.script_pager as sp

        original = sp.pull.sb
        sp.pull.sb = lambda *a, **k: self.fail("must not touch the DB for an empty note")
        try:
            self.assertFalse(sp.append_note("s1", "joey", "   "))
        finally:
            sp.pull.sb = original


class MediaResolution(unittest.TestCase):
    def test_detect_platform(self):
        self.assertEqual(detect_platform("https://www.instagram.com/reel/x/"), "instagram")
        self.assertEqual(detect_platform("https://www.tiktok.com/t/ZTAchq95u/"), "tiktok")
        self.assertEqual(detect_platform("https://cdn.example.com/a.mp4"), "file")
        self.assertIsNone(detect_platform("https://example.com/page"))

    def test_target_bitrate_fits_the_upload_cap(self):
        self.assertEqual(target_bitrate_kbps(60), 924)
        self.assertEqual(target_bitrate_kbps(3600), 200)

    def test_extract_video_url_mirrors_ts(self):
        self.assertEqual(
            extract_video_url("instagram", {"data": {"xdt_shortcode_media": {"video_url": "https://cdn/v.mp4"}}}),
            "https://cdn/v.mp4",
        )
        self.assertEqual(
            extract_video_url("tiktok", {"aweme_detail": {"video": {"play_addr": {"url_list": ["https://cdn/t.mp4"]}}}}),
            "https://cdn/t.mp4",
        )
        self.assertIsNone(extract_video_url("instagram", {}))


class LeadingTextBudget(unittest.TestCase):
    """A page flip re-renders the original header verbatim. Left unbudgeted,
    a long header plus a full-length script exceeds Discord's V2 character
    cap; the edit 400s, and _edit_original treats 4xx as non-retryable, so
    the button reports "Something went wrong" on every single click."""

    def _total_chars(self, page):
        def walk(components):
            n = 0
            for c in components:
                n += len(c.get("content") or "")
                n += walk(c.get("components") or [])
            return n

        return walk(page["components"])

    def test_long_leading_is_trimmed_to_fit(self):
        big = {"id": "s1", "hook": "H" * 200, "body": "B" * 2800,
               "demo": "D" * 400, "songs": "S" * 400}
        page = render_page([big], 0, leading=["L" * 3000])
        self.assertLessEqual(self._total_chars(page), MAX_V2_CHARS)

    def test_short_leading_survives_verbatim(self):
        header = "<@123> new scripts are up"
        page = render_page([{"id": "s1", "hook": "hi", "body": "there"}], 0,
                           leading=[header])
        self.assertEqual(page["components"][0]["content"], header)


if __name__ == "__main__":
    unittest.main()
