#!/usr/bin/env python3
"""
Run the Folk UGC CRM bot (consolidated here from the discord-crm project).

Slash commands: /onboard /offboard /creator /creators /health /help — plus
real-time message ingestion into research_discord_*, sharing semantics with
the REST pull loop (discord_pull_worker.py), which keeps running for catch-up.

⚠ Run exactly ONE instance per bot token. If the old discord-crm deployment of
"mach ugc" is still up somewhere, stop it first — two gateways on one app fight
over interactions and double-handle commands.

Setup:  worker/.venv/bin/pip install -r worker/requirements.txt
Run:    worker/.venv/bin/python worker/run_discord_bot.py

Env (read from ../.env.local automatically): DISCORD_BOT_TOKEN,
DISCORD_GUILD_ID, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
plus the optional ONBOARD_* / CREATOR_ROLE_* overrides in discord_bot/config.py.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import discord_pull_worker as pull  # noqa: E402 - loads .env.local on import
from discord_bot.client import UgcCrmClient  # noqa: E402
from discord_bot.commands import BotState  # noqa: E402
from discord_bot.config import load_bot_config  # noqa: E402


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    cfg = load_bot_config()
    channels = pull.tracked_channels()
    state = BotState(
        allowlisted_channel_ids={c["channel_id"] for c in channels},
        role_map=pull.load_role_map(channels),
    )
    logging.info(
        "starting bot: %d tracked channels, %d creator links",
        len(state.allowlisted_channel_ids), len(state.channel_creator),
    )
    UgcCrmClient(cfg, state).run(cfg.discord_bot_token)


if __name__ == "__main__":
    main()
