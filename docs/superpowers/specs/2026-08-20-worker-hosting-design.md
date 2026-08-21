# Hosting the Discord workers on Fly.io

**Date:** 2026-08-20
**Status:** approved

## Problem

The Next.js app already deploys to Vercel (project `bludgc`,
`bludgc.vercel.app`). The three Python workers do not deploy anywhere — they
run from Joey's terminal on his Mac. Two of them need to be up 24/7:

- `worker/run_discord_bot.py` — the "mach ugc" gateway bot. Creators use its
  slash commands live, so downtime is user-visible.
- `worker/discord_pull_worker.py` — the 60s REST ingest loop plus scripts sync,
  with `discover` on a 15-minute cadence.

`worker/transcribe_worker.py` stays local: it wants a GPU, keeps a multi-GB
media cache in `worker/data/`, and only matters during active research.

This design reverses the "Localhost-only by design" line in CLAUDE.md, which is
deliberate and was explicitly requested.

## Constraints

1. **Exactly one gateway connection per bot token.** Two live connections make
   the bot fight itself over interactions and double-handle commands. This rules
   out any deploy strategy that overlaps old and new instances.
2. **Shared database.** Supabase is shared with `trace-ugc-tracker`. Destructive
   migrations are out of scope.
3. **No `claude` CLI in the container.** `summarize_channels()` shells out to
   `claude -p`, which does not exist in a slim Python image.

## Decisions

### Fly.io, one app, two process groups

App `bludgc-workers`, one Dockerfile, one secrets set, one `fly deploy`:

```toml
[processes]
  bot  = "python worker/run_discord_bot.py"
  pull = "python worker/discord_pull_worker.py"
```

Each group is pinned to one machine. Neither process serves HTTP, so the app
declares no `[[services]]` — no proxy, no health checks, no autostop semantics
to misconfigure. Fly restarts a machine when its process exits.

Rejected: two separate Fly apps (duplicate secrets and deploys for no
isolation benefit); Railway (its default zero-downtime deploy overlaps
containers, violating constraint 1); a VPS (most maintenance); staying on the
Mac (creator-facing commands break when the machine sleeps).

### `strategy = "immediate"` on the bot group

Fly's `bluegreen` and `canary` strategies boot a replacement machine *before*
retiring the old one. On a gateway bot that is two connections on one token.
`immediate` stops before starting — a few seconds of downtime per deploy, which
is the correct trade for this workload.

### A separate hosted requirements file

`worker/requirements.txt` pulls `whisperx`, `faster-whisper`, and `yt-dlp` —
i.e. torch — for the transcription worker. The hosted image needs none of it:
the pull worker is stdlib-only and the bot needs only `discord.py`. A new
`worker/requirements-hosted.txt` holds that single dependency;
`requirements.txt` is untouched for the local transcription venv.

### Summaries are removed, not ported

`summarize_channels()` is deleted rather than ported to the Anthropic API.
Joey's call: the feature is no longer wanted. Removal covers the worker
function, its `SUMMARY_*` constants, the `summarize` subcommand, the call in
`cmd_pull`'s maintenance block, and both UI readers (`/discord` channel cards
and the channel detail page). Deleting it also removes the pull worker's last
`subprocess` use, so nothing in the image shells out.

The `research_discord_summaries` **table is left in place**. Dropping it is an
irreversible migration against a shared database and buys nothing; it simply
goes unread.

### Config needs no code change

`load_env()` uses `os.environ.setdefault` and returns early when `.env.local` is
absent, so both workers already run on pure environment variables.

Shipped as Fly secrets: `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`.

Deliberately not shipped: `SUPABASE_ACCESS_TOKEN` (migrations only),
`SCRAPECREATORS_API_KEY` and `CRON_SECRET` (web app only).

## Local cleanup

Three launchd agents still fire against the retired `discord-creator-crm`
project — `com.user.discord-crm-pull` (60s), `-summarize` (15min), `-names`
(30min). They are unloaded and removed; otherwise they double-write alongside
Fly.

Once Fly is live, the bot and pull worker must not also run on the Mac. Two
gateways break slash commands; two pull loops waste Discord rate limit.

## Out of scope

- Hosting `transcribe_worker.py`.
- Dropping the `research_discord_summaries` table.
- Any change to the Vercel deployment beyond verifying it (env vars present,
  build green, `/c/<token>` portal links resolve against the URL hardcoded as
  `DEFAULT_APP_PUBLIC_URL` in `worker/discord_bot/config.py`).

## Verification

`npm run typecheck` · `npm test` ·
`python3 -m py_compile worker/discord_pull_worker.py` ·
`worker/.venv/bin/python -m py_compile worker/discord_bot/*.py worker/run_discord_bot.py`
· `fly logs` on both process groups: the bot logs its tracked-channel count at
startup, the pull loop logs a completed cycle.

## Cost

~$4/month: two `shared-cpu-1x` machines, 512MB for the bot and 256MB for pull.
