#!/usr/bin/env bash
# run_study.sh — headless single-study runner. REPLACES the tmux orchestrate_replays.sh.
#
# Drives a study to completion through the CLI's --headless path + the run.start
# {wait:true} agent action (added 2026-05-30). No tmux session, no agent-backdoor
# pane-scraping, no polling — one process, blocks until done, exits 0/1. Invocable
# in a single ssh call:
#
#   ssh aaugus11@a4500 'cd ~/Documents/mcp-client-example && scripts/run_study.sh verify_replay_fmb2_sim'
#
# Usage:  scripts/run_study.sh <study_name> [provider] [model]
# Env:    MCP_CLIENT_STRICT_TOOLS and ROS_DOMAIN_ID default to 1 and 7.
# Notes:  the study's own mcpConfigPath selects the server/mode (see ros-mcp-server/MODES.md);
#         dryRun studies (models: []) run with no LLM cost.
set -euo pipefail

STUDY="${1:?usage: run_study.sh <study_name> [provider] [model]}"
PROVIDER="${2:-anthropic}"
MODEL="${3:-claude-haiku-4-5}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RUNS="$ROOT/.mcp-client-data/ablations/runs/$STUDY"

SCRIPT="$(mktemp "/tmp/headless-${STUDY}-XXXXXX.txt")"
trap 'rm -f "$SCRIPT"' EXIT
printf '/agent-do run.start {"name":"%s","wait":true}\n' "$STUDY" > "$SCRIPT"

: "${MCP_CLIENT_STRICT_TOOLS:=1}"
: "${ROS_DOMAIN_ID:=7}"
export MCP_CLIENT_STRICT_TOOLS ROS_DOMAIN_ID

node dist/bin.js --all --provider "$PROVIDER" --model "$MODEL" --headless "$SCRIPT"

# Report the newest run dir + per-phase status from summary.json.
NEW="$(ls -t "$RUNS" 2>/dev/null | head -1 || true)"
if [ -n "$NEW" ] && [ -f "$RUNS/$NEW/summary.json" ]; then
  echo "=== run dir: $RUNS/$NEW ==="
  python3 - "$RUNS/$NEW/summary.json" <<'PY' || true
import json, sys
d = json.load(open(sys.argv[1]))
for r in d.get("results", []):
    print(f"  {r['phase']}: {r['status']} ({r.get('durationFormatted','')})")
PY
fi
