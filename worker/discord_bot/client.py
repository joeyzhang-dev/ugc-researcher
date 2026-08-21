"""Gateway client: slash commands + real-time ingestion into research_discord_*.

The REST pull loop (discord_pull_worker.py) stays the source of catch-up truth;
this client adds live capture through the exact same normalize → attribute →
upsert semantics (shared dedupe_key format), so running both is idempotent.
Edits update the same row (edit_version stays 0) rather than minting a second
one — the pull path only ever sees version 0, and two rows for one message
would double-count it everywhere.
"""
from __future__ import annotations

import asyncio
import logging

import aiohttp
import discord

import discord_pull_worker as pull
from discord_bot import script_pager
from discord_bot.commands import BotState, fetch_niche_categories, register_commands
from discord_bot.config import BotConfig

logger = logging.getLogger(__name__)

# Message types that carry real authored content (default, reply).
_CONTENT_TYPES = {discord.MessageType.default, discord.MessageType.reply}


def _leading_texts(components) -> list[str]:
    """Top-level text displays ABOVE the V2 container — the notification
    header (with the creator's ping) and/or the test marker. Page flips pass
    them back verbatim so nothing above the card is lost or re-pinged."""
    out: list[str] = []
    for c in components or []:
        content = getattr(c, "content", None)
        if not isinstance(content, str):
            break  # the container ends the prefix
        out.append(content)
    return out


def _component_text(components) -> list[str]:
    """Text-display strings in a V2 component tree, duck-typed so any
    discord.py component class (Container, Section, TextDisplay) walks."""
    out: list[str] = []
    for c in components or []:
        content = getattr(c, "content", None)
        if isinstance(content, str):
            out.append(content)
        out.extend(_component_text(getattr(c, "children", None) or []))
        out.extend(_component_text(getattr(c, "components", None) or []))
    return out


def _serialize_attachments(attachments) -> list[dict]:
    return [
        {
            "id": str(a.id),
            "filename": a.filename,
            "url": a.url,
            "content_type": a.content_type,
            "size": a.size,
        }
        for a in attachments or []
    ]


class UgcCrmClient(discord.Client):
    def __init__(self, cfg: BotConfig, state: BotState):
        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds = True
        intents.messages = True
        super().__init__(intents=intents)
        self.cfg = cfg
        self.state = state
        self.tree = discord.app_commands.CommandTree(self)

    async def setup_hook(self) -> None:
        """Register + sync commands before the gateway connects. Failures are
        logged, not raised — no slash commands must never mean no ingestion."""
        niche_options = []
        try:
            niche_options = await fetch_niche_categories(
                self, self.cfg.discord_guild_id, self.cfg.excluded_category_ids
            )
        except Exception:  # noqa: BLE001
            logger.exception("couldn't fetch niche categories; /onboard falls back to autocomplete")
        try:
            register_commands(self.tree, self.cfg, self.state, niche_options=niche_options)
            synced = await self.tree.sync(guild=discord.Object(id=self.cfg.discord_guild_id))
            logger.info("synced %d slash commands", len(synced))
        except Exception:  # noqa: BLE001
            logger.exception("slash command sync failed; ingestion continues without commands")
        # Self-healing tracking: the pull worker owns discover/enrich but is
        # not always running, and manual channel renames/moves used to drift
        # silently until someone noticed a creator missing. The always-on bot
        # re-runs both on a slow loop; every write is an idempotent upsert, so
        # overlapping with a running pull worker is harmless.
        self._crm_sync_task = self.loop.create_task(self._crm_sync_loop())

    async def _crm_sync_loop(self) -> None:
        await asyncio.sleep(120)  # let the gateway settle before the first pass
        while True:
            try:
                await asyncio.to_thread(pull.cmd_discover)
                await asyncio.to_thread(pull.cmd_enrich, False)
                logger.info("periodic discover+enrich pass done")
            except Exception:  # noqa: BLE001 - the loop must survive any pass
                logger.exception("periodic discover/enrich failed; retrying next cycle")
            await asyncio.sleep(1800)

    async def on_ready(self) -> None:
        logger.info("connected as %s (guild %s)", self.user, self.cfg.discord_guild_id)

    def _should_skip(self, message: discord.Message) -> bool:
        if message.guild is None:
            return True
        if self.user is not None and getattr(message.author, "id", None) == self.user.id:
            return True
        if message.type not in _CONTENT_TYPES:
            return True
        if message.channel.id not in self.state.allowlisted_channel_ids:
            return True
        return False

    async def _ingest(self, message: discord.Message) -> None:
        author = message.author
        author_id = getattr(author, "id", None)
        is_bot = bool(getattr(author, "bot", False))
        webhook_id = message.webhook_id
        channel_id = message.channel.id
        role = pull.resolve_author_role(
            channel_id, author_id, is_bot, webhook_id, self.state.role_map
        )
        row = {
            "guild_id": message.guild.id,
            "channel_id": channel_id,
            "message_id": message.id,
            "edit_version": 0,
            "dedupe_key": f"{message.guild.id}/{channel_id}/{message.id}/0",
            "author_discord_user_id": author_id,
            "author_role": role,
            "is_bot": is_bot,
            "webhook_id": webhook_id,
            "content": message.content or "",
            "attachments": _serialize_attachments(message.attachments),
            "posted_at": message.created_at.isoformat(),
            "edited_at": message.edited_at.isoformat() if message.edited_at else None,
        }

        def write() -> None:
            pull.sb(
                "POST",
                "research_discord_messages?on_conflict=dedupe_key",
                [row],
                prefer="resolution=merge-duplicates,return=minimal",
            )
            if author_id is not None and webhook_id is None:
                pull.sb(
                    "POST",
                    "research_discord_users?on_conflict=discord_user_id",
                    [{
                        "discord_user_id": author_id,
                        "username": getattr(author, "name", None),
                        "global_name": getattr(author, "global_name", None),
                        "display_name": getattr(author, "global_name", None) or getattr(author, "name", None),
                        "is_bot": is_bot,
                    }],
                    prefer="resolution=merge-duplicates,return=minimal",
                )

        # urllib is blocking; keep the gateway loop free.
        await asyncio.to_thread(write)

    async def on_message(self, message: discord.Message) -> None:
        if self._should_skip(message):
            return
        try:
            await self._ingest(message)
        except Exception:  # noqa: BLE001 - one bad message must not kill the bot
            logger.exception("failed to ingest message %s", message.id)

    async def on_message_edit(self, before: discord.Message, after: discord.Message) -> None:
        if self._should_skip(after):
            return
        try:
            await self._ingest(after)
        except Exception:  # noqa: BLE001
            logger.exception("failed to ingest edit of message %s", after.id)

    # --- script pager buttons ------------------------------------------------
    # The app posts paged script batches over plain REST (no View registered),
    # so their clicks arrive here as raw component interactions. custom_id
    # contract lives in script_pager.py / src/lib/discord-send.ts.

    async def on_interaction(self, interaction: discord.Interaction) -> None:
        logger.info(
            "interaction received: type=%s data=%s",
            interaction.type,
            (interaction.data or {}).get("custom_id") or (interaction.data or {}).get("name"),
        )
        custom_id = str((interaction.data or {}).get("custom_id", ""))
        # Note-modal submits arrive raw (no Modal instance survives a restart
        # between open and submit, so the instance is never relied on).
        if interaction.type == discord.InteractionType.modal_submit:
            if custom_id.startswith("scrnotem:"):
                try:
                    await self._handle_script_note(interaction, custom_id.partition(":")[2])
                except Exception:  # noqa: BLE001 - a bad submit must not kill the bot
                    logger.exception("script note submit failed (%s)", custom_id)
            return
        if interaction.type != discord.InteractionType.component:
            return
        if not custom_id.startswith(("scrnav:", "scrpost:", "scrnote:")):
            return
        try:
            if custom_id.startswith("scrnote:"):
                await self._open_note_modal(interaction, custom_id.partition(":")[2])
                return
            await self._handle_script_button(interaction, custom_id)
        except Exception:  # noqa: BLE001 - a bad click must not kill the bot
            logger.exception("script pager interaction failed (%s)", custom_id)
            # After defer() the response is "done" — errors must go out as a
            # followup or the click dies silently.
            try:
                if interaction.response.is_done():
                    await interaction.followup.send(
                        "Something went wrong — try that again.", ephemeral=True
                    )
                else:
                    await interaction.response.send_message(
                        "Something went wrong — try that again.", ephemeral=True
                    )
            except Exception:  # noqa: BLE001
                pass

    async def _open_note_modal(
        self, interaction: discord.Interaction, script_id: str
    ) -> None:
        """The 📝 Note button: a one-field modal, sent as the immediate
        response (a modal cannot follow a defer). Deliberately NOT pre-filled
        with the existing notes — the card lives in creator-facing channels
        and notes are internal, so the modal only ever appends."""
        modal = discord.ui.Modal(
            title="Add a note to this script",
            custom_id=f"scrnotem:{script_id}",
            timeout=None,
        )
        modal.add_item(
            discord.ui.TextInput(
                label="Note",
                style=discord.TextStyle.paragraph,
                custom_id="note",
                placeholder="Anything worth remembering about this script",
                max_length=1000,
            )
        )
        await interaction.response.send_modal(modal)

    async def _handle_script_note(
        self, interaction: discord.Interaction, script_id: str
    ) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)
        note = script_pager.modal_note_value(interaction.data or {})
        author = getattr(interaction.user, "display_name", None) or str(interaction.user)
        ok = note and await asyncio.to_thread(
            script_pager.append_note, script_id, author, note
        )
        await interaction.followup.send(
            "Note added to the script ✅" if ok else "Couldn't save that note — try again.",
            ephemeral=True,
        )

    async def _handle_script_button(
        self, interaction: discord.Interaction, custom_id: str
    ) -> None:
        action, _, raw_index = custom_id.partition(":")
        message = interaction.message
        if message is None:
            return
        # DB reads and media downloads can blow the 3s interaction window —
        # always acknowledge first, then edit/follow up at leisure.
        if action == "scrpost":
            await interaction.response.defer(ephemeral=True, thinking=True)
        else:
            await interaction.response.defer()

        # Test sends carry their batch in the marker text display instead of
        # assignment rows — they exist only to preview, nothing is tracked.
        # (V2 messages have no .content; the marker lives in the components.)
        all_text = "\n".join([message.content or "", *_component_text(message.components)])
        test_ids = script_pager.parse_test_ids(all_text)
        if test_ids:
            scripts = await asyncio.to_thread(script_pager.fetch_scripts_by_ids, test_ids)
            # Overlay any smuggled fields the DB can't hold pre-migration.
            scripts = script_pager.merge_ext(scripts, script_pager.parse_test_ext(all_text))
        else:
            scripts = await asyncio.to_thread(script_pager.fetch_batch, message.id)
        if not scripts:
            await interaction.followup.send(
                "This batch isn't in the tracker anymore.", ephemeral=True
            )
            return
        index = max(0, min(int(raw_index), len(scripts) - 1))

        if action == "scrpost":
            if test_ids:
                await interaction.followup.send(
                    "Test send — nothing gets tracked here. ✅", ephemeral=True
                )
                return
            ok = await asyncio.to_thread(
                script_pager.mark_posted, message.id, scripts[index]["id"]
            )
            await interaction.followup.send(
                "Marked as posted ✅" if ok else "Couldn't find that assignment in the tracker.",
                ephemeral=True,
            )
            return

        # The page's video renders inside the V2 card by PUBLIC storage URL —
        # nothing uploads to Discord, so the flip is a small JSON edit. The
        # one-time resolve/upload per video is cached in the pager's sidecar.
        inspo_url = str(scripts[index].get("inspo_url") or "").strip()
        video_url = (
            await asyncio.to_thread(script_pager.resolve_inspo_public_url, inspo_url)
            if inspo_url
            else None
        )
        # Every flip re-links the channel's creator portal — including test
        # sends: #script-send-test is linked to the 🧪 test creator, so the
        # button stays testable end-to-end. Unlinked channels resolve None
        # and simply drop the button.
        share_token = await asyncio.to_thread(
            script_pager.fetch_share_token_for_channel, interaction.channel_id
        )
        payload = script_pager.render_page(
            scripts,
            index,
            video_url=video_url,
            # Everything above the card re-renders verbatim: the notification
            # header + ping on real sends, the ids spoiler on test sends.
            leading=_leading_texts(message.components),
            view_all_url=f"{self.cfg.app_public_url}/c/{share_token}" if share_token else None,
        )
        # Edits never push a notification, but be explicit that the header's
        # mention must not re-ping on a page flip.
        payload["allowed_mentions"] = {"parse": []}
        # Raw REST edit: the V2 payload shape is shared with the TS builder,
        # so no discord.py component objects to keep in sync.
        await self._edit_original(interaction, payload)

    async def _edit_original(self, interaction: discord.Interaction, payload: dict) -> None:
        """PATCH the deferred interaction's original message (JSON-only) via
        aiohttp with retries. urllib's naive streaming hit Cloudflare
        broken-pipes — the original cause of 'the button does nothing'."""
        url = (
            "https://discord.com/api/v10/webhooks/"
            f"{interaction.application_id}/{interaction.token}/messages/@original"
        )
        last: Exception | None = None
        for attempt in range(3):
            try:
                async with aiohttp.ClientSession(
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as session:
                    async with session.patch(
                        url,
                        json={**payload, "attachments": []},
                        headers={"User-Agent": pull.USER_AGENT},
                    ) as resp:
                        if resp.status < 300:
                            return
                        text = await resp.text()
                        if 400 <= resp.status < 500:
                            # Payload problem — retrying cannot help.
                            raise RuntimeError(f"edit rejected {resp.status}: {text[:200]}")
                        raise OSError(f"edit failed {resp.status}: {text[:200]}")
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as e:
                last = e
                logger.warning("edit attempt %d failed: %s", attempt + 1, e)
                await asyncio.sleep(1.5 * (attempt + 1))
        raise last if last else RuntimeError("edit failed")
