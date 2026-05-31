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

---

# 2026-05-29 — tool-surface fix + 4 codebase guards + SIM RE-WEDGE finding (READ THIS FIRST)

> **STATE: Isaac is currently WEDGED on a4500** (socket 8766 dead). Next session MUST restart it — ideally with the `GLIBC_TUNABLES` fix below — before any run. The "sim stack verified 2026-05-28" claim above still holds for a *fresh* Isaac, but the sim **re-wedges under sustained replay load** (see below).

## Tool-surface contamination — FOUND + FIXED
- isaac-sim registry grew **13 (paper appendix) → 22 tools**. The agent was being exposed undocumented ones; `runs/verify_fmb1_sim/2026-05-28-050349/.../chat.json` shows the agent **invoked `isaac-sim__start_ros_driver`** (NOT in that run's onStart) — corrupting the logged tool sequence the gate replays + the paper reports.
- **Fix:** `.mcp-client-data/tool-states.yaml` — agent-facing isaac-sim now = exactly `save_scene_state` + `restore_scene_state` (matches appendix). `start_ros_driver`→false (still host-callable via onStart `@tool-exec`, which bypasses tool-states). Added the 4 workstation/room tools (`load_workstation`, `quick_start_with_workstation`, `load_simple_room`, `quick_start_with_workstation_and_simple_room`) as `false` — explicit false is immune to `updateStateForNewTools` auto-enable + `pruneStaleTools`. Backup: `tool-states.yaml.bak.20260529-124744`.
- **Verified live:** `/tools` → isaac-sim = 2 enabled; 20 enabled of 45 total; contamination scan clean.

## 4 codebase guards built — UNCOMMITTED (git dirty on src/), compiled into dist/ via `npx tsc`
1. **#3 strict-tools footgun** (`src/managers/tool-manager.ts`): `MCP_CLIENT_STRICT_TOOLS=1` → new tools default DISABLED + warn (env unset = prior enable-by-default). **Launch collection with this env.**
2. **#1 manifest preflight** (`src/ablation-runner.ts` + `.mcp-client-data/paper-tool-manifest.json`): every `run.start` asserts live enabled toolset == the 20-tool manifest; **REFUSES to run on drift**. Bypass `MCP_CLIENT_SKIP_TOOL_PREFLIGHT=1`; disarm by removing the manifest file.
3. **#2 provenance stamp** (`src/managers/ablation-manager.ts`): every `summary.json` now carries `provenance` = git SHAs (+dirty) of mcp-client / isaac-sim / ros-mcp-server + tool-states hash + enabled-tool list + `collected_at`. Kills run-dating-by-archaeology.
4. **#4 orchestration driver** (`scripts/orchestrate_replays.sh`): drives dryRun studies via `/agent-do run.start` → poll `run.status`. Usage: `bash scripts/orchestrate_replays.sh [tmux_session] [study...]` (default `drv` + the 3 `verify_replay`). Polling parses the CLI pane: confirms `running:true` then waits for the LAST `running:false` token (an earlier stale-scrollback bug was fixed).
- New dryRun YAMLs: `verify_replay_fmb2_sim.yaml`, `verify_replay_fmb3_sim.yaml` (adapted from fmb1; regular `Assembly_fmb_assembly_{2,3}_results.json`, base2/base3, phase=2).
- **TODO: commit these on a4500** (decide: apply GLIBC_TUNABLES + render-off first, then one commit).

## SIM RE-WEDGE — the real data-collection blocker (deeper than the May-28 physics fix)
- Watched live: replay **seating inaccuracy**. Root cause is NOT the primitives — it's **Isaac degrading under load**.
- **Before restart:** 33h uptime, 16GB RSS, 214% CPU, **socket unresponsive >15s**, render FPS unreadable.
- **Restart** (skill scripts — note the real path: `~/.claude/skills/isaac-sim-extension-dev/scripts/isaacsim_launch.sh kill|launch ur5e-dt`; the `~/Documents/isaac-sim-mcp/scripts/` paths cited above are stale) → fresh: socket READY 5s, **render FPS 118.7 idle**.
- **BUT** re-ran the 3 dryRuns → **fmb1 failed fast** (u_brown @ first `control_gripper`, 0 seated), **fmb2 hung 20min**, fmb3 didn't start, **Isaac re-wedged within 28min**. A stale-session restart does NOT durably fix it. ROS driver (`ur_robot_driver` PIDs) stayed alive → Isaac-side, not driver death.

## Missing optimizations (vs NVIDIA Perf Optimization Handbook) — apply BEFORE re-collecting
- 🔴 **`GLIBC_TUNABLES=glibc.malloc.arena_max=1:glibc.malloc.mmap_max=0:glibc.malloc.mmap_threshold=2147483647`** in the Isaac launch env — NVIDIA's explicit mitigation for *"memory leaks in long-running sessions with repeated stage loading/unloading"* = our exact symptom (33h × many new_stage cycles → 16GB → wedge). Our launcher currently sets NONE of the handbook knobs.
- 🟠 **render-off collection mode** (`disable_viewport_updates=True` headless / `viewport.updates_enabled=False`): render-off RTF ≈0.91 vs 0.38 render-on → 2.4× physics throughput + far less load. Keep render-on only when watching.
- ✓ CPU governor already `performance`. Thread caps low-priority (wedge is malloc-thrash, not thread-saturation).

## Designed-but-not-built: sequence-order hook (author requested)
- Evidence: GPT burns runs assembling OUT OF ORDER. fmb2 ground-truth `u_green→inverted_u_brown→hex_red→hex_blue`; a gpt-5-mini run did u_green×4 → moved on to later objects → came back to u_green×5 (thrash). Interlocking geometry makes order a hard precondition.
- Design: `whenInput` hook on `translate_object(action='insert', object_name=X)` → read `assembly_order` + verified-assembled set → if X's predecessor (order N-1) not seated, reject with structured diagnostic (route like `@return`). Host-enforced, agent can't bypass.
- OPEN: hard-block vs soft-warn? End-to-End only, or also Isolated P2 (where ordering-discovery is the measured thing)? Build after sim is stable.

## Next actions (in order)
1. Restart Isaac WITH `GLIBC_TUNABLES` in the launch env; add render-off collection mode to the launcher.
2. Re-run the 3 dryRuns; confirm RSS stays flat + socket survives + fmb1/2/3 seat 4/4 (= validates the malloc-fragmentation diagnosis).
3. Commit the 4 guards on a4500.
4. Start real collection (9 studies, runs:3) with `MCP_CLIENT_STRICT_TOOLS=1` + render-off, driven by `orchestrate_replays.sh`.
5. Build the sequence-order hook.
