#!/usr/bin/env bash
# One-time Fly.io bootstrap for the two always-on Discord workers.
#
# Prereq:  flyctl auth login
# Usage:   bash scripts/fly-bootstrap.sh
#
# Design record: docs/superpowers/specs/2026-08-20-worker-hosting-design.md
set -euo pipefail

APP="bludgc-workers"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! flyctl auth whoami >/dev/null 2>&1; then
  echo "Not logged in. Run:  flyctl auth login" >&2
  exit 1
fi
echo "==> authenticated as $(flyctl auth whoami)"

if [ ! -f .env.local ]; then
  echo ".env.local not found — secrets come from there." >&2
  exit 1
fi

if flyctl apps list 2>/dev/null | grep -qE "^\s*${APP}\s"; then
  echo "==> app ${APP} already exists"
else
  echo "==> creating app ${APP}"
  flyctl apps create "$APP"
fi

# Exactly the four the workers read. Piped via `secrets import` (stdin) rather
# than `secrets set` (argv) so values never appear in the process table.
echo "==> importing secrets"
grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|DISCORD_BOT_TOKEN|DISCORD_GUILD_ID)=' .env.local \
  | flyctl secrets import -a "$APP" --stage

echo "==> secrets staged:"
flyctl secrets list -a "$APP"

cat <<'NEXT'

==> Next, in order:

  1. Stop the LOCAL bot first — two gateway connections on one token break
     slash commands:

       pkill -f 'worker/run_discord_bot.py'

  2. Deploy:

       flyctl deploy -a bludgc-workers

  3. Watch both process groups come up:

       flyctl logs -a bludgc-workers

     Expect: the bot logging "starting bot: N tracked channels, M creator
     links", and within 60s the pull loop logging a "pulled ... messages
     across ... channels" line.

  4. Confirm exactly one machine per group:

       flyctl status -a bludgc-workers
NEXT
