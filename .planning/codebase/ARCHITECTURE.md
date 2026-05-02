# Architecture

**Analysis Date:** 2026-05-02

## Pattern Overview

**Overall:** Monolithic multi-interface MCP client with tightly-coupled god objects.

**Key Characteristics:**
- Single MCPClient class (`src/index.ts`, 4057 lines) acts as central hub for all functionality — manages servers, tools, messages, chat history, hooks, ablations, and IPC
- Three interface layers (CLI, Web, Headless) all consume the same MCPClient
- Provider abstraction (`src/model-provider.ts`) enables multiple LLM backends (Anthropic, OpenAI, Google, xAI, Ollama)
- Manager pattern used for cross-cutting concerns (chat history, hooks, ablations, preferences, attachments) but managers are tightly coupled to MCPClient
- Hook system (client-side and ablation-driven) for reactive tool automation
- Ablation orchestration layer for controlled multi-model, multi-phase experimentation

## Layers

**MCP Transport Layer:**
- Purpose: Communicate with MCP servers via stdio protocol
- Location: `src/index.ts:260-650` (MCPClient.connect methods)
- Contains: Server connection setup, tool/prompt/resource fetching, error handling
- Depends on: MCP SDK (`@modelcontextprotocol/sdk`), shell spawning via Node
- Used by: MCPClient public methods for tool execution, server refresh

**CLI Interface Layer:**
- Purpose: Interactive terminal UI for chat, tool management, ablations
- Location: `src/cli-client.ts` (1973 lines), `src/bin.ts` (716 lines), `src/cli/` directory
- Contains: Command parsing, readline interaction, signal handling, multi-menu navigation
- Depends on: MCPClient, various CLI subcommands, readline-promises, chalk
- Used by: Entry point `bin.ts`, spawned via `npm start` or direct execution

**Web Interface Layer:**
- Purpose: HTTP API and frontend UI for web-based MCP interaction
- Location: `src/web/api.ts` (62KB), `src/web/server.ts`, `src/web/frontend/`
- Contains: Express routes for chat, approvals, attachments, server management, streaming
- Depends on: MCPClient, Express, Server-Sent Events (SSE)
- Used by: Web browser via HTTP, frontend React app

**Headless/Batch Layer:**
- Purpose: Scripted agent execution without user interaction
- Location: `src/cli/headless-runner.ts`
- Contains: Script-driven tool execution, phase automation
- Depends on: MCPClient, AblationCLI
- Used by: Ablation system for unattended phase execution

**Model Provider Layer:**
- Purpose: Abstraction for different LLM backends
- Location: `src/providers/` (Anthropic, OpenAI, Google, xAI, Ollama)
- Contains: API communication, token counting, message formatting, thinking/reasoning config
- Depends on: Provider-specific SDKs (e.g., `@anthropic-ai/sdk`, `openai`)
- Used by: MCPClient for all LLM interactions

**Tool Execution Core:**
- Purpose: Route tool calls to MCP servers, manage execution lifecycle
- Location: `src/core/tool-executor.ts` (MCPToolExecutor class), `src/index.ts:2100-2800` (processToolUseStream)
- Contains: Tool coercion, error handling, force stop, tool approval, hook triggering
- Depends on: MCP SDK, HookManager, PreferencesManager
- Used by: MCPClient.processQuery for agent loops

**Management Layer:**
- Purpose: Persistent state and domain-specific logic
- Location: `src/managers/` (12 manager classes)
- Key managers:
  - `ablation-manager.ts`: YAML-based multi-phase experimentation definitions and runs
  - `chat-history-manager.ts`: Session persistence, chat restore, export
  - `hook-manager.ts`: Client-side post-tool hooks and ablation hook loading
  - `attachment-manager.ts`: File attachment lifecycle
  - `preferences-manager.ts`: User settings (approval, thinking level, etc.)
  - `tool-manager.ts`: Tool enable/disable state
  - `token-manager.ts`: Token counting and auto-summarization
- Depends on: YAML, filesystem, Logger
- Used by: MCPClient initialization and throughout execution

## Data Flow

**Regular Chat Query (CLI):**

1. User enters query in CLI readline loop (`src/cli-client.ts:550+`)
2. CLI calls `MCPClient.processQuery(query, false, attachments)`
3. MCPClient adds query to messages array, ensures token counter ready
4. MCPClient calls `modelProvider.createMessageStream()` → streaming LLM events
5. For each event:
   - text_delta: Display to terminal, accumulate text
   - tool_start: Log tool name/input, emit to observer
   - tool_use_complete: Execute tool via `MCPToolExecutor.executeTool()`, trigger hooks
   - message_stop: Build assistant message, add to messages
6. Hook system (HookManager) fires post-tool hooks, may inject new tool calls
7. Loop continues until done event
8. Chat history saved to `~/.mcp-client-data/chats/{sessionId}/`

**Web Query (Browser):**

1. Browser sends POST `/api/chat` with query, model, attachments
2. Web API router (`src/web/api.ts:150+`) calls `MCPClient.processQuery()` with StreamObserver
3. Observer pushes events to SSE stream via push-to-pull bridge
4. Browser receives server-sent events, updates UI in real-time
5. Same tool execution and hook flow as CLI

**Ablation Run (Agent-Driven Phase Execution):**

1. User creates/edits ablation YAML in `AblationCLI` (defines phases, models, hooks, tools filter)
2. Ablation stored at `~/.mcp-client-data/ablations/definitions/{name}.yaml`
3. Run started via `/ablation-run` → `AblationCLI.runAblation()`
4. For each phase:
   - HookManager loads phase hooks from YAML
   - Tool filter applied via tool-states.yaml override
   - Inject onStart commands (tool calls)
   - Call `MCPClient.processQuery()` with currentModel, phase systemPrompt
   - Inject onEnd commands after phase completes
   - Save phase results to `~/.mcp-client-data/ablations/runs/{timestamp}/`
5. Agent loop in each phase continues until user approves phase completion or max iterations
6. Between phases: optionally clear context (conversation reset) or carry forward
7. Results aggregated by AblationCLI, displayed as table/export

**State Management:**

- **Conversation state:** `MCPClient.messages[]` in-memory, persisted to chat history
- **Server connections:** `MCPClient.servers: Map<string, ServerConnection>` holds stdio transports and tool caches
- **Tool state:** `tool-states.yaml` (enabled/disabled), loaded by ToolManager
- **Preferences:** `settings.yaml` (approval, thinking level, hooks, etc.)
- **Hooks:** `hooks.yaml` (persistent client-side hooks), `AblationManager` loads phase hooks from YAML
- **Chat history:** Filesystem under `.mcp-client-data/chats/{sessionId}/`
- **Ablation definitions/runs:** Filesystem YAML under `.mcp-client-data/ablations/`

## Key Abstractions

**MCPClient (God Object):**
- Purpose: Central command and control for MCP interactions
- Examples: `src/index.ts:99-4057`
- Pattern: Monolithic class with ~40+ private fields and 100+ methods
- **Architectural smell:** Violates single responsibility — manages servers, messages, tools, hooks, chat history, token counting, todo tracking, video recording, ablations via IPC, all at once
- Public methods: `connect()`, `processQuery()`, `executeTool()`, `addHook()`, `runAblationPhase()`, etc.

**ModelProvider (Provider Abstraction):**
- Purpose: Support multiple LLM backends with consistent interface
- Examples: `src/model-provider.ts` (interface), `src/providers/anthropic.ts` (47KB)
- Pattern: Interface defines `createMessageStream()`, `listAvailableModels()`, token counting; each provider implements
- Enables: Provider swapping at runtime, capability queries per model, thinking/reasoning config

**ServerConnection (MCP Transport):**
- Purpose: Encapsulate a single MCP server's stdio transport and tool cache
- Examples: `src/index.ts:89-97` (type definition)
- Pattern: Maps server name → MCP Client instance, tool list, prompts, resources
- Lifetime: Created on first `connect()`, persisted for tool execution, killed/restarted on server crash

**Manager Pattern (Specialized State Managers):**
- Purpose: Isolate domain logic (chat history, hooks, ablations, etc.) from MCPClient core
- Examples: `ChatHistoryManager`, `HookManager`, `AblationManager`
- Pattern: Each manager owns its YAML/filesystem state, provides CRUD and query methods
- **Limitation:** Managers created and owned by MCPClient, tightly coupled via getters/setters

**Hook System (Reactive Automation):**
- Purpose: Trigger tool calls in response to other tool completions (client-side or ablation-driven)
- Examples: `src/managers/hook-manager.ts`, `src/utils/hook-utils.ts`
- Pattern:
  - Client hooks: Persistent in `hooks.yaml`, loaded at startup
  - Ablation hooks: Temporary, loaded from phase YAML during ablation execution
  - Post-tool: Fires after a tool completes, checks `when` conditions on input/output
  - Pre-tool: Fires before a tool executes (ablation only)
  - Actions: @tool-exec (auto-call), @prompt (inject prompt), @gate (conditional branch), @complete-phase (advance to next phase)
- Data: `PostToolHook` interface defined in `src/managers/ablation-manager.ts:33-41`

**Ablation System (Multi-Model Orchestration):**
- Purpose: Define and execute controlled experiments with multiple models, phases, and conditional gates
- Examples: `src/managers/ablation-manager.ts`, `src/cli/ablation-cli.ts` (7897 lines)
- Pattern:
  - Definition: YAML file with models, phases, hooks, tool filters, system/user prompts per phase
  - Run: Execute definition against MCPClient, swap models, inject tools, conditionally gate phases
  - Result: Aggregated tokens/duration per model/phase, chat history per phase
- Conditional gates: Evaluate a tool, branch onPass/onFail with different commands
- Context management: `clearContextBetweenPhases` controls whether conversation resets
- **Architectural smell:** `ablation-cli.ts` is 7897 lines (tied with or exceeds MCPClient complexity) — handles CLI UX, phase orchestration, result aggregation, model switching, hook management, all tightly coupled

**Hook Lifecycle (Complex State Machine):**
- Client-side hooks: Fire post-tool during regular chat (HookManager.execute)
- Ablation hooks: Override/extend during phase execution (HookManager.setAblationHooks)
- Temporary directives (@prompt, @attachment) collected in HookManager, consumed by CLI after query
- Phase events (@complete-phase, @escalate, @switch-model) set flags on HookManager, checked by AblationCLI

## Entry Points

**CLI (Interactive Terminal):**
- Location: `src/bin.ts` (entry point executable)
- Triggers: User runs `npm start` or `npx mcp-client`
- Responsibilities:
  - Parse .env and mcp_config.json
  - Create MCPClient with provider/model
  - Instantiate MCPClientCLI
  - Run command loop with readline
  - Handle Ctrl+C, Ctrl+A (abort/interrupt)
- Key methods: `src/bin.ts:180-400` (main CLI loop)

**Web (Express API):**
- Location: `src/web/server.ts`
- Triggers: `npm run web` or imported by orchestrator
- Responsibilities:
  - Create MCPClient with provider/model
  - Create Express app with `/api/` routes from `web/api.ts`
  - Attach CLI static frontend or custom UI
  - Expose SSE stream for `/chat` queries
- Key routes: `/api/chat` (POST), `/api/providers` (GET), `/api/tools` (GET), `/api/approve` (POST)

**Headless/Batch:**
- Location: `src/cli/headless-runner.ts`
- Triggers: Called by AblationCLI for unattended phase execution
- Responsibilities:
  - Take a script (tool calls or prompts), run without user input
  - Manage max iterations, output capture
  - Report success/failure
- Key methods: `runHeadless(client, script, maxIterations)`

**Orchestrator IPC Server:**
- Location: `src/ipc-server.ts`
- Triggers: MCPClient initialized with `enableOrchestratorIPC: true`
- Responsibilities:
  - Expose HTTP server on ephemeral port
  - Listen for `/call_tool` requests from mcp-tools-orchestrator
  - Route tool calls through MCPClient
  - Enforce tool-states.yaml and IPC call limits
- Key route: `POST /call_tool` (src/ipc-server.ts:50+)

## Cross-Cutting Concerns

**Logging:**
- Framework: `src/logger.ts` (simple wrapper around console)
- Pattern: Logger instance passed to all managers, MCPClient
- Modes: 'verbose' (full output), 'quiet' (errors only), 'json' (structured)
- Usage: `this.logger.log(message, { type: 'info' | 'warning' | 'error' })`

**Validation:**
- Input validation: Minimal — relies on schema matching (tools, messages)
- Output validation: Tool results coerced by `MCPToolExecutor.coerceToolArguments()`
- Config validation: JSON schemas in `schemas/` directory, used only for IDE hints

**Authentication:**
- Handled by each provider (Anthropic API key, OpenAI API key, etc.)
- Loaded from environment variables (`.env` or process.env)
- No session management — stateless per provider

**Error Handling:**
- Strategy: Try-catch with logging, user-friendly error messages to terminal
- Tool execution errors: Captured as tool result, sent to model for recovery
- Server connection errors: Logged, server marked unavailable, user prompted to retry
- API errors: Logged with error codes, displayed to user as "Error from [provider]: [message]"
- **Fragility:** No structured error recovery for cascade failures (e.g., server dies mid-tool call)

**Token Management:**
- Framework: TokenManager (`src/core/token-manager.ts`) tracks per-provider token counting
- Summarization: Automatic when threshold exceeded (configurable via /set-thinking)
- Per-callback tracking: Logs token usage per LLM call in chat history
- **Coupling:** TokenManager holds callbacks to MCPClient to get/set messages and token count

**Interrupt & Abort:**
- CLI: Ctrl+C triggers abort (sets isAbortRequested flag), Ctrl+A triggers interrupt (pause for input)
- Web: POST `/api/chat/cancel` signals abort
- Downstream: MCPToolExecutor checks isAbortRequested before/after tool calls, cancels execution on flag
- Force stop: After abort, user can force-terminate long-running tool (asks for confirmation after N seconds)

---

*Architecture analysis: 2026-05-02*
