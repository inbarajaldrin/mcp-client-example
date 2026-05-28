# CLAUDE.md — mcp-client-example

Project memory for agents working in this repo. This is an MCP **client** (CLI + web + agent API)
that drives LLMs against MCP servers, and hosts the **ablation framework** used for the `mode2_*`
sim data-collection pipeline (robot assembly via Isaac Sim).

## Build & run

```bash
npx tsc && chmod 755 dist/bin.js dist/index.js      # build to dist/ (npm run build also builds the web frontend)
node dist/bin.js --all --provider anthropic --model claude-haiku-4-5   # CLI, all configured MCP servers
node dist/bin.js --all --web --web-port 8099 --provider anthropic --model <m>   # web UI + SSE API
```
- `--all` loads every MCP server from the active config. Provider/model are interactive if omitted
  (`--provider`/`--model` skip the prompt). API keys come from `.env` (dotenv): `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`.
- MCP server configs: `mcp_config.json` (default) + variants `mcp_config_mode2.json`,
  `mcp_config_real.json`, `mcp_config_ablation_quat.json`. An ablation pins one via
  `settings.mcpConfigPath`.

## Ablation framework

- **Definitions:** `.mcp-client-data/ablations/definitions/*.yaml` — phases, models (escalation chain),
  `escalation`, `runs`, hooks (`@complete-phase`/`@escalate`/`@switch`/`@abort`, gate replay),
  `onStart`/`onEnd`, tool filters.
- **Run outputs:** `.mcp-client-data/ablations/runs/<study>/<timestamp>/` — per-model/per-phase dirs,
  `chat.json`/`chat.md`, server logs, screenshots, videos, `summary.json`, `definition.yaml`.
- The `mode2_*_fmb{1,2,3}_sim` studies are the canonical pipeline: phase 1 disassembly discovery →
  phase 2 assembly discovery (with a gate-replay verify) → phase 3 assembly execution, with a
  model cascade (e.g. `claude-haiku-4-5` → `claude-sonnet-4-6`) on failure.

### Run engine — `AblationRunner` (Slice 3 Pass A, 2026-05-27)

The run engine lives **once** in `src/ablation-runner.ts` and is driven by **three surfaces**, so
behavior (escalation, `@switch`, abort, results) is identical by construction:

| Surface | Entry point | Run it via |
|---|---|---|
| CLI | `src/cli/ablation-cli.ts` `runSingleAblation` (thin wrapper) | `/ablation-run` → pick study → `Y`; `Ctrl+C` aborts |
| Web | `src/web/api.ts` `POST /api/ablations/:name/run` (SSE) | frontend, or `curl`; `POST /api/ablations/cancel` |
| Agent API | `src/agent-run-actions.ts` `run.start`/`run.abort`/`run.status` | `/agent-do run.start {"name":"…"}` (CLI) or `POST /api/agent/action` (web) |

- The seam: `RunControl` (abort/interrupt), `RunObserver` (events → console / SSE / `AgentRegistry`
  viewState), `RunHost` (CLI-backed: keyboard/readline/slash; web/agent: headless defaults via
  `normalizeHost`), `RunDeps` (client/logger/managers).
- **Agent API is env-gated:** set `MCP_CLIENT_AGENT_API=1`. `run.start` is non-blocking — poll
  `run.status` (reads `run.study/phase/model/index/lastGateVerdict/lastError` from viewState).
- History: the web used to re-implement the loop inline and silently skipped `@escalate`/`@switch`;
  that divergence is gone. Pass B (later): dedupe the duplicated shared helpers in `ablation-runner.ts`
  into a module, retire `RunHost` toward the pure ~6-field seam.

## Running against Isaac Sim (the mode2 sim pipeline)

The sim studies need two MCP servers (both in the configs): **`isaac-sim`** (→ the ur5e-dt extension
socket on port 8766, served by `~/Documents/isaac-sim-mcp`) and **`ros-mcp-server`** (robot motion in
`mode='sim'`). Bring the sim up FIRST, then launch this client on the **same `ROS_DOMAIN_ID`**:

```bash
# 1. Launch Isaac Sim + ur5e-dt — see ~/Documents/isaac-sim-mcp/CLAUDE.md for the authoritative steps:
bash -c 'source ~/env_isaaclab/bin/activate; export ROS_DOMAIN_ID=7 DISPLAY=:0; \
  bash ~/.claude/skills/isaac-sim-extension-dev/scripts/isaacsim_launch.sh launch ur5e-dt'
# 2. Launch this client on the SAME domain (sim + ros-mcp-server must share ROS_DOMAIN_ID):
ROS_DOMAIN_ID=7 node dist/bin.js --all --provider anthropic --model claude-haiku-4-5
```

### ⚠️ KNOWN GAP — ROS2 driver / pose publisher (blocks successful data collection)

The `ros-mcp-server` robot-motion tools (`move_home`/`move_to_grasp`/`control_gripper`/… in
`mode='sim'`) require the **ROS2 robot driver + object-pose publisher** to be running on the active
`ROS_DOMAIN_ID`. Observed 2026-05-27: with only the sim launch above, a `mode2_anthropic_fmb1_sim` run
had the agent fail with *"UR robot driver not running"* / *"cannot access object poses from
`/objects_poses_sim`"*. The `AblationRunner` handled it correctly (escalate → abort), but **no
successful run data is produced** until the driver/publisher are up. Bringing them up is currently a
manual, not-yet-terminal-only process. Tracked + to-be-automated in
**`~/Documents/isaac-sim-mcp/CLAUDE.md`** (goal: drive it from isaac-sim-mcp itself, then
`run.start` + the launch above = unattended end-to-end collection).

## Conventions

- No `Co-Authored-By` in commits (global rule). Commit directly to `main`.
- Only used on **a4500** — do not sync this repo to other hosts.
- `dist/` is gitignored; rebuild after pulling (`npx tsc && chmod 755 dist/bin.js dist/index.js`).
