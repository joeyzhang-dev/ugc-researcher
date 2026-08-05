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

import discord

import discord_pull_worker as pull
from discord_bot.commands import BotState, fetch_niche_categories, register_commands
from discord_bot.config import BotConfig

logger = logging.getLogger(__name__)

# Message types that carry real authored content (default, reply).
_CONTENT_TYPES = {discord.MessageType.default, discord.MessageType.reply}


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
