#!/usr/bin/env bash
# orchestrate_replays.sh — drive dryRun verify_replay studies through the live CLI
# session via the agent backdoor (/agent-do run.start | run.status). FREE (no LLM).
# Each run automatically gets the tool-manifest preflight (#1) + provenance stamp (#2).
#
# Polling: confirm running:true first (guards against stale idle-false in scrollback),
# then poll the LAST "running" token until it reads false. tail -1 = current state.
#
# Usage: scripts/orchestrate_replays.sh [tmux_session] [study ...]
set -uo pipefail
SESSION="${1:-drv}"; shift || true
STUDIES=("$@")
[ ${#STUDIES[@]} -eq 0 ] && STUDIES=(verify_replay_fmb1_sim verify_replay_fmb2_sim verify_replay_fmb3_sim)
ROOT="$HOME/Documents/mcp-client-example"; RUNS="$ROOT/.mcp-client-data/ablations/runs"
LOG="$ROOT/.mcp-client-data/orchestrate-$(date +%Y%m%d-%H%M%S).log"
POLL=8; MAX_WAIT=1200; START_TRIES=15

send() { tmux send-keys -t "$SESSION" "$1" Enter; }
pane() { tmux capture-pane -t "$SESSION" -p -S -300 | sed "s/\x1b\[[0-9;]*m//g"; }
last_running() { pane | grep -oE "\"running\":[[:space:]]*(true|false)" | tail -1; }
log()  { echo -e "$1" | tee -a "$LOG"; }

tmux has-session -t "$SESSION" 2>/dev/null || { echo "ERROR: tmux session $SESSION not found"; exit 1; }
log "orchestrate_replays: session=$SESSION  studies=${STUDIES[*]}"
log "log: $LOG"
PASS=0; FAIL=0
for study in "${STUDIES[@]}"; do
  log "\n========== $study =========="
  before=$(ls -t "$RUNS/$study" 2>/dev/null | head -1 || true)
  send "/agent-do run.start {\"name\":\"$study\"}"; sleep 5
  # phase 1: confirm running:true (or detect preflight refusal)
  started=0
  for i in $(seq 1 $START_TRIES); do
    send "/agent-do run.status"; sleep 3
    if echo "$(pane)" | grep -qiE "TOOL-MANIFEST DRIFT|preflight failed"; then
      log "  ✗ PREFLIGHT REFUSED — tool surface drifted; not collecting."; break; fi
    echo "$(last_running)" | grep -q true && { started=1; break; }
  done
  if [ "$started" -ne 1 ]; then log "  ✗ never confirmed running:true (preflight refusal or start failure)"; FAIL=$((FAIL+1)); continue; fi
  log "  started; polling for completion..."
  # phase 2: poll latest "running" until false
  waited=0; done=0
  while [ $waited -lt $MAX_WAIT ]; do
    send "/agent-do run.status"; sleep $POLL; waited=$((waited+POLL))
    echo "$(last_running)" | grep -q false && { done=1; break; }
  done
  after=$(ls -t "$RUNS/$study" 2>/dev/null | head -1 || true)
  rundir="$RUNS/$study/$after"
  if [ "$done" -eq 1 ] && [ -n "$after" ] && [ "$after" != "$before" ]; then
    log "  ✓ completed in ~${waited}s -> $after"
    if [ -f "$rundir/summary.json" ]; then
      "$HOME/env_isaaclab/bin/python" - "$rundir/summary.json" <<PYJSON
import json,sys
s=json.load(open(sys.argv[1])); p=s.get("provenance",{}); st=p.get("stack",{}); ts=p.get("tool_surface",{})
print(f"    provenance: isaac={st.get('isaac_sim_mcp',{}).get('sha','?')} ros={st.get('ros_mcp_server',{}).get('sha','?')} client={st.get('mcp_client_example',{}).get('sha','?')} | enabled_tools={ts.get('enabled_count','?')} states_hash={ts.get('tool_states_sha256_12','?')}")
PYJSON
    else log "    (no summary.json — checking replay logs for seat result)"; fi
    seat=$(grep -rohiE "seated [0-9]+/[0-9]+|[0-9]+/[0-9]+ (parts )?(seated|assembled|inserted)|verify_assembly.*success|replay (complete|success|pass)" "$rundir" 2>/dev/null | sort -u | head -3)
    [ -n "$seat" ] && log "    seat: $(echo "$seat" | tr "\n" "|")" || log "    seat: (inspect $rundir)"
    PASS=$((PASS+1))
  else
    log "  ✗ TIMED OUT / no new run dir after ${waited}s"; FAIL=$((FAIL+1)); fi
done
log "\n========== DONE: $PASS ok, $FAIL failed =========="
