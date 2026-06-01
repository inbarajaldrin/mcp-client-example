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

# Resolve the run-dir name = the yaml `name:` field, which differs from the file stem
# (e.g. stem 'openai_fmb1_sim' -> name 'mode2_openai_fmb1_sim'). The old code used $STUDY
# (the stem) for RUNS, so the freshness check looked in a dir that never exists and reported
# a fully-successful run as "did not persist" (false negative, 2026-05-31 on a 3/3 fmb1 run).
DEF_FILE="$ROOT/.mcp-client-data/ablations/definitions/$STUDY.yaml"
STUDY_NAME="$(awk -F: '/^[[:space:]]*name:/{sub(/^[[:space:]]*name:[[:space:]]*/,"");gsub(/["'"'"']/,"");print;exit}' "$DEF_FILE" 2>/dev/null)"
[ -n "$STUDY_NAME" ] || STUDY_NAME="$STUDY"
RUNS="$ROOT/.mcp-client-data/ablations/runs/$STUDY_NAME"

SCRIPT="$(mktemp "/tmp/headless-${STUDY}-XXXXXX.txt")"
trap 'rm -f "$SCRIPT"' EXIT
printf '/agent-do run.start {"name":"%s","wait":true}\n' "$STUDY" > "$SCRIPT"

: "${MCP_CLIENT_STRICT_TOOLS:=1}"
: "${ROS_DOMAIN_ID:=7}"
export MCP_CLIENT_STRICT_TOOLS ROS_DOMAIN_ID

# Marker so we can tell whether THIS run actually persisted a fresh run dir
# (vs. silently falling back to a stale pre-existing one — the bug that caused
# hours of confusion 2026-05-30: a preflight refusal / connect failure left the
# run un-persisted, and this script used to echo the newest STALE dir as success).
# fast-fail >> silent fallback.
PRE_MARKER=$(date +%s)
RUN_LOG="$(mktemp "/tmp/run_study-${STUDY}-XXXXXX.log")"

# --enable-orchestrator-ipc: start the orchestrator IPC server at init so a study whose
# config enables mcp-tools-orchestrator (verify_replay's execute_composed_code ->
# setup_and_replay) actually works headless. Additive — does NOT change the agent tool surface.
set +e
node dist/bin.js --all --enable-orchestrator-ipc --provider "$PROVIDER" --model "$MODEL" --headless "$SCRIPT" 2>&1 | tee "$RUN_LOG"
NODE_RC=${PIPESTATUS[0]}
set -e

# FAST-FAIL: did THIS run create a fresh run dir? (mtime newer than the pre-run marker)
FRESH="$(find "$RUNS" -mindepth 1 -maxdepth 1 -type d -newermt "@$PRE_MARKER" 2>/dev/null | head -1 || true)"
if [ -z "$FRESH" ] || [ ! -f "$FRESH/summary.json" ]; then
  echo "=== run_study FAILED: '$STUDY' produced NO fresh run dir — the run did not persist (node exit=$NODE_RC) ==="
  echo "    NOT a valid result. This script no longer reports a stale dir as success. Likely cause:"
  grep -iE "TOOL-MANIFEST DRIFT|MISSING \(manifest|refusing to run|failed to connect|timed out|preflight failed|Error:" "$RUN_LOG" | sed 's/^/      /' | head -10 \
    || echo "      (no recognized error pattern — inspect $RUN_LOG)"
  rm -f "$RUN_LOG"
  exit 3
fi
rm -f "$RUN_LOG"
echo "=== run dir: $FRESH ==="
python3 - "$FRESH/summary.json" <<'PY' || true
import json, sys
d = json.load(open(sys.argv[1]))
for r in d.get("results", []):
    print(f"  {r['phase']}: {r['status']} ({r.get('durationFormatted','')})")
PY
