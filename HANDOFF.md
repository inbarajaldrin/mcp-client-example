# HANDOFF — extend the mcp-client (ablation framework) work

**Date:** 2026-05-28. Everything runs on **a4500** only (do NOT sync repos to the Mac).

## The sim stack is now SELF-CONTAINED and VERIFIED — do not re-debug it
The driver / physics / sim-real-parity work that blocked ablations is DONE and committed in
the other two repos (each documents its own fixes in its CLAUDE.md "2026-05-28" section):
- **isaac-sim-mcp**: launch via `scripts/launch_sim.sh` (sources `config/ros_dds.env` → DDS
  parity); `add_objects` rebuilds PhysX tensor views; `ROBOT_BASE_Z=0.0`.
- **ros-mcp-server**: mode-aware `config.py` (`ROS_MCP_MODE` → sim/real `ROBOT_BASE_Z`,
  `GRIPPER_CENTER_TOOL_OFFSET`, base-offset gating, `SAFE_HEIGHT`); `server_mode2.py` injects
  `ROS_MCP_MODE` per `--mode`.

**Verified 2026-05-28:** ground-truth FMB1 replay seats 4/4 in sim; a live 3-phase
`verify_fmb1_sim` (= runs:1 copy of `mode2_anthropic_fmb1_sim`) had **claude-haiku-4-5 pass all
3 phases on attempt 1** (4/4 assembled, no Sonnet escalation, 25m52s, 67k tokens). A GPT run
(`mode2_openai_fmb1_sim`) was started then stopped at the user's request.

## How to run an ablation (current, working)
1. Sim stack up (a4500):
   - Isaac: `bash ~/Documents/isaac-sim-mcp/scripts/launch_sim.sh`  (DDS parity baked in)
   - Driver: `ROS_DOMAIN_ID=7 bash ~/Documents/isaac-sim-mcp/scripts/sim_bringup.sh up sim`
2. CLI (tmux): `cd ~/Documents/mcp-client-example && ROS_DOMAIN_ID=7 node dist/bin.js --all --provider anthropic --model claude-haiku-4-5`
3. In the CLI: `/ablation-run` → study number → `Y`. (`dryRun` studies skip the LLM.)
   - `verify_replay_fmb1_sim` = dryRun ground-truth replay (no LLM) — cheap pre-flight, seats 4/4.
   - `verify_fmb1_sim` = anthropic runs:1 (full 3-phase).
   - `mcp_config.json` is on ROS_DOMAIN_ID=7 (matches sim). `mcp_config_{mode2,real}.json` are
     the user's (still domain 0 — user handles).

## What's LEFT on the mcp-client work
1. **Collect the paper's data** — the pipeline works end-to-end now. Drive the real studies
   `mode2_{anthropic,google,openai}_fmb{1,2,3}_sim` (runs:3). Run `verify_replay_*` (dryRun) first
   as the cheap sim sanity-check before spending LLM tokens.
2. **`start_ros_driver` in onStart (optional, hands-free):** the `mode2_*` YAMLs do NOT call
   `@tool-exec:isaac-sim__start_ros_driver` in onStart — the driver must be up first
   (sim_bringup.sh). Add it for fully unattended runs (pattern in `drivertest_fmb1_sim.yaml`).
3. **Pass B refactor** (SLICE3-PASS-A-EXECUTION.md, deferred): dedupe the shared helpers
   duplicated into `src/ablation-runner.ts` into a shared module; retire `RunHost` toward the
   pure ~6-field seam.
4. **Pass A verification checklist** (SLICE3 lines 163-168, still unchecked): CLI multi-model
   `@escalate` fires; web SAME-study escalates identically; abort on both surfaces; batch
   continuation advances once; chat.json/run-output shapes identical; resolved run-plan identical
   web-vs-CLI. NOTE: the Claude run exercised CLI 3-phase but haiku did NOT need to escalate, so
   `@escalate` is still unverified end-to-end — a study where the first model fails would prove it.

## Notes
- Build CLI: `cd ~/Documents/mcp-client-example && npx tsc && chmod 755 dist/bin.js dist/index.js`
- Abort a running ablation: Ctrl+A (pause) then `exit`/`/exit` at the pause prompt (may close the CLI).
- Cleanup when done: `.mcp-client-data/ablations/definitions/verify_*.yaml`,
  `ros-mcp-server/ablations/ground_truth_resources/Assembly_fmb_assembly_1_results.simverify.json`.
- Secrets: a4500 `.env` files hold live ANTHROPIC/OPENAI keys — reference by location only.
