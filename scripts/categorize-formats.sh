#!/usr/bin/env bash
# Drain the research format-categorization queue using GitHub Copilot CLI,
# pinned to Claude Opus 4.8. Tokens are unlimited on Copilot — no cost concern.
#
# The "Categorize with AI" button in /research/[id] flips rows to
# format_llm_status='pending'; this runs Copilot headless to classify them and
# write results back. See docs/format-categorization.md for the full contract.
#
#   npm run categorize:formats           # or: bash scripts/categorize-formats.sh
#
# Overrides:
#   COPILOT_MODEL   model id            (default: claude-opus-4.8)
#   COPILOT_BIN     copilot binary path (default: /opt/homebrew/bin/copilot)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${COPILOT_MODEL:-claude-opus-4.8}"
# Call the real binary, not the interactive `copilot` shell alias (which wraps
# sessions in an Obsidian note). Aliases don't apply in scripts, but be explicit.
BIN="${COPILOT_BIN:-/opt/homebrew/bin/copilot}"

if [[ ! -x "$BIN" ]]; then
  echo "copilot binary not found at $BIN — set COPILOT_BIN" >&2
  exit 1
fi
if [[ ! -f "$REPO/.env.local" ]]; then
  echo "missing $REPO/.env.local (Supabase service key) — copy it from the tracker" >&2
  exit 1
fi

PROMPT="Drain the research video format-categorization queue for this repo.
Follow docs/format-categorization.md EXACTLY (also see AGENTS.md): source
.env.local, read research_videos where format_llm_status='pending' via
PostgREST, classify each from its transcript_text (fall back to caption),
reusing existing format_category names or coining concise new ones, and PATCH
each row with format_category, format_llm_reasoning, format_llm_model=
'copilot-cli/${MODEL}', format_categorized_at, and format_llm_status='done'
(or 'failed' when there's no usable text). Tokens are unlimited — read full
transcripts, don't truncate. End with a summary of counts and the distinct
formats, flagging any new buckets."

echo "→ Copilot ($MODEL) draining format-categorization queue…"
exec "$BIN" -C "$REPO" --model "$MODEL" --allow-all-tools --no-color -p "$PROMPT"
