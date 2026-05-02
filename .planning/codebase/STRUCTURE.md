# Codebase Structure

**Analysis Date:** 2026-05-02

## Directory Layout

```
mcp-client-example/
├── src/                          # Main application source
│   ├── index.ts                  # MCPClient class (4057 lines) — god object
│   ├── bin.ts                    # CLI entry point & config parsing (716 lines)
│   ├── cli-client.ts             # CLI interactive interface (1973 lines)
│   ├── model-provider.ts          # LLM provider abstraction (interface definitions)
│   ├── logger.ts                 # Simple logging wrapper
│   ├── ipc-server.ts             # Orchestrator IPC HTTP server
│   │
│   ├── cli/                       # CLI subcommands (interactive menus)
│   │   ├── ablation-cli.ts       # Ablation study management (7897 lines) — god object #2
│   │   ├── chat-history-cli.ts   # Chat restore/search/export (1279 lines)
│   │   ├── tool-cli.ts           # Tool enable/disable management
│   │   ├── prompt-cli.ts         # Prompt CRUD (646 lines)
│   │   ├── resource-cli.ts       # MCP resource management
│   │   ├── attachment-cli.ts     # File attachment UI (520 lines)
│   │   ├── hooks-cli.ts          # Hook enable/disable
│   │   ├── headless-runner.ts    # Unattended script execution
│   │   ├── keyboard-monitor.ts   # Raw input capture (Ctrl+A/C handling)
│   │   ├── tool-replay-cli.ts    # Re-execute past tool calls
│   │   └── server-refresh-cli.ts # Server connection management
│   │
│   ├── managers/                  # Domain-specific state managers (12 total)
│   │   ├── ablation-manager.ts   # Ablation YAML I/O & run orchestration (1466 lines)
│   │   ├── chat-history-manager.ts # Chat session persistence (1957 lines)
│   │   ├── hook-manager.ts       # Client-side & ablation hook lifecycle (794 lines)
│   │   ├── attachment-manager.ts # File attachment handling (436 lines)
│   │   ├── preferences-manager.ts # User settings persistence (196 lines)
│   │   ├── tool-manager.ts       # Tool state (enable/disable) (169 lines)
│   │   ├── prompt-manager.ts     # Prompt persistence (127 lines)
│   │   ├── resource-manager.ts   # MCP resource caching (125 lines)
│   │   ├── todo-manager.ts       # ROS2 todo tracking (678 lines)
│   │   ├── video-recording-manager.ts # ROS2 video control (232 lines)
│   │   ├── hil-manager.ts        # Human-in-the-loop approval workflow (162 lines)
│   │   └── server-log-manager.ts # Server stderr/stdout capture (175 lines)
│   │
│   ├── providers/                 # LLM backend implementations
│   │   ├── anthropic.ts          # Anthropic Claude (47KB) — largest provider
│   │   ├── openai.ts            # OpenAI GPT (40KB)
│   │   ├── google.ts            # Google Gemini (39KB)
│   │   ├── xai.ts               # xAI Grok (35KB)
│   │   └── ollama.ts            # Ollama local LLM (38KB)
│   │
│   ├── core/                      # Core execution engines
│   │   ├── tool-executor.ts      # MCPToolExecutor — route tools to MCP servers
│   │   └── token-manager.ts      # TokenManager — token counting & summarization
│   │
│   ├── handlers/                  # Event handlers
│   │   ├── base-handler.ts       # Base class for handlers
│   │   ├── signal-handler.ts     # OS signal handling (SIGINT, SIGTERM)
│   │   └── elicitation-handler.ts # MCP elicitation request handling
│   │
│   ├── utils/                     # Utility functions
│   │   ├── hook-utils.ts         # Hook parsing & condition matching (200 lines)
│   │   ├── formatting.ts         # Terminal output formatting (170 lines)
│   │   ├── model-capabilities.ts # Thinking level, context window queries (114 lines)
│   │   ├── models-dev.ts         # Development model cache refresh (203 lines)
│   │   ├── file-ops.ts           # File read/write helpers (139 lines)
│   │   ├── mime-types.ts         # MIME type mapping (26 lines)
│   │   └── path-utils.ts         # Path sanitization (20 lines)
│   │
│   └── web/                       # Web interface
│       ├── api.ts                # Express API routes (62KB) — streaming, chat, tools, approvals
│       ├── server.ts             # Express app setup & static serving
│       └── frontend/              # React/Vite frontend (not detailed here)
│           ├── src/
│           │   ├── App.tsx
│           │   ├── components/
│           │   ├── hooks/          # React hooks (useChat, useAblations, etc.)
│           │   └── styles/
│           └── vite.config.ts
│
├── .mcp-client-data/              # Runtime state directory (user data)
│   ├── settings.yaml              # User preferences (approval, thinking, etc.)
│   ├── hooks.yaml                 # Persistent client-side hooks
│   ├── tool-states.yaml           # Tool enable/disable state
│   ├── chats/                     # Chat session storage
│   │   ├── index.json             # Chat index
│   │   └── {sessionId}/           # Individual session directories
│   │       ├── messages.jsonl     # Messages in JSONL format
│   │       ├── metadata.json      # Session metadata
│   │       └── server-logs/       # Captured MCP server output
│   ├── ablations/                 # Ablation experiment storage
│   │   ├── definitions/           # Ablation YAML definitions
│   │   │   └── {ablation-name}.yaml
│   │   └── runs/                  # Run results
│   │       └── {timestamp}/       # Timestamped run directories
│   │           ├── {phase-name}/  # Per-phase subdirs
│   │           │   ├── messages.jsonl
│   │           │   └── metadata.json
│   │           └── results.json   # Aggregated results
│   ├── attachments/               # User-uploaded files
│   ├── cache/                     # Provider model cache
│   │   └── models-dev.json        # Development model list (refreshed periodically)
│   └── outputs/                   # Tool output directory (MCP_CLIENT_OUTPUT_DIR)
│
├── schemas/                       # JSON Schema definitions (IDE type hints)
│   ├── mcp-config.schema.json
│   ├── ablation-definition.schema.json
│   ├── settings.schema.json
│   ├── hooks.schema.json
│   └── ... (7 more)
│
├── mcp_config.json                # MCP server definitions (stdio commands)
├── mcp_config_ablation_*.json     # Variant configs for different ablations
├── package.json                   # npm dependencies & build scripts
├── tsconfig.json                  # TypeScript compilation config
├── dist/                          # Compiled output (JS)
│
├── scripts/                       # Utility scripts (not part of main build)
│   ├── test-provider-cache.ts
│   ├── analyze-openai-cache.ts
│   └── analyze-ablation-cost.ts
│
└── reference-repos/               # Cloned reference implementations
    ├── mcp-chat/
    ├── chatmcp/
    ├── open-mcp-client/
    └── multi-llm-ts/
```

## Directory Purposes

**src/:**
- Purpose: All application source code
- Contains: TypeScript files for CLI, web, providers, managers
- Key files: `index.ts` (MCPClient entry), `bin.ts` (CLI entry)

**.mcp-client-data/:**
- Purpose: User-facing runtime and configuration state
- Contains: Chat sessions, ablation definitions/runs, preferences, tool states
- Persisted: YAML, JSON, JSONL files
- Generated: True — populated at runtime
- Committed: False — git-ignored

**src/managers/:**
- Purpose: Domain-specific state management, isolated from MCPClient core
- Contains: File I/O, YAML parsing, CRUD operations for own domain
- Pattern: Each manager owns one logical concern (chat history, hooks, ablations, etc.)
- Coupling: All created and owned by MCPClient, passed to CLI/Web via getters

**src/cli/:**
- Purpose: Interactive menu-driven CLI subcommands
- Contains: User prompts, formatting, state display
- Pattern: Each file handles one command domain (chat, tools, prompts, ablations)
- Coupling: All instantiated by MCPClientCLI, share manager references

**src/providers/:**
- Purpose: LLM backend implementations
- Contains: API communication, token counting, model listing, thinking config
- Pattern: Each provider implements `ModelProvider` interface from `model-provider.ts`
- Coupling: Loosely coupled via interface; swapped at runtime

**src/utils/:**
- Purpose: Shared utility functions (no state)
- Contains: String formatting, file ops, parsing (hooks, tool calls)
- Pattern: Pure functions or utilities
- Coupling: Low; imported by various modules as needed

**src/web/:**
- Purpose: Web interface (Express API + React frontend)
- Contains: HTTP route handlers, SSE streaming, API contract
- Coupling: Tight to MCPClient (same instance shared); React frontend makes HTTP calls

**schemas/:**
- Purpose: JSON Schema for IDE type hints and validation
- Contains: Schema definitions for mcp_config.json, ablation YAML, settings.yaml
- Usage: Imported by IDEs for autocomplete/validation; not used at runtime
- Committed: True — part of source

## Key File Locations

**Entry Points:**
- CLI: `src/bin.ts` (executable, parses args/config, creates MCPClient, runs MCPClientCLI)
- Web: `src/web/server.ts` (creates Express app with API routes)
- Headless: `src/cli/headless-runner.ts` (runHeadless function, called by ablation)

**Configuration:**
- mcp_config.json: MCP server definitions (stdio command + args)
- .env: Environment variables (API keys)
- .mcp-client-data/settings.yaml: User preferences
- .mcp-client-data/hooks.yaml: Persistent client-side hooks
- .mcp-client-data/tool-states.yaml: Tool enable/disable

**Core Logic:**
- MCPClient class: `src/index.ts:99-4057` (servers, tools, messages, processQuery)
- ToolExecutor: `src/core/tool-executor.ts` (tool coercion, execution, error handling)
- TokenManager: `src/core/token-manager.ts` (token counting, summarization)
- AblationManager: `src/managers/ablation-manager.ts` (YAML I/O, run coordination)
- HookManager: `src/managers/hook-manager.ts` (hook loading, matching, execution)

**Testing:**
- No test directory found — testing infrastructure not present in codebase
- Ad-hoc testing via scripts/ (test-provider-cache.ts, etc.)

## Naming Conventions

**Files:**
- kebab-case: `src/cli/chat-history-cli.ts`, `src/managers/ablation-manager.ts`
- .ts extension: All source files are TypeScript
- CLI files: Suffix with `-cli` (ablation-cli.ts, chat-history-cli.ts, etc.)
- Manager files: Suffix with `-manager` (chat-history-manager.ts, tool-manager.ts)
- Entry points: lowercase (bin.ts, index.ts, logger.ts)

**Classes/Interfaces:**
- PascalCase: `MCPClient`, `MCPClientCLI`, `MCPToolExecutor`, `TokenManager`, `HookManager`
- Interfaces: `ModelProvider`, `Message`, `Tool`, `ServerConnection`
- Types: `WebStreamEvent`, `ChatSession`, `AblationDefinition`

**Variables/Functions:**
- camelCase: `processQuery()`, `executeTool()`, `addHook()`, `runAblationPhase()`
- Private fields: `private messages: Message[]`, `private modelProvider: ModelProvider`
- Callbacks: `todoClearUserCallback`, `toolApprovalCallback`, `forceStopCallback`

**Directories:**
- kebab-case: `src/cli/`, `.mcp-client-data/`, `server-logs-staging/`
- Short names: `core/`, `utils/`, `handlers/`, `managers/`, `providers/`
- Domain grouping: All CLI commands under `cli/`, all managers under `managers/`

## Where to Add New Code

**New Feature (Domain Logic):**
- Primary code: Create manager at `src/managers/{feature}-manager.ts` for state/CRUD; add CLI subcommand at `src/cli/{feature}-cli.ts`
- Tests: No test infrastructure — ad-hoc testing via scripts/
- Integration: Register manager in MCPClient constructor, expose via getter

**New CLI Command:**
- Implementation: Add new file at `src/cli/{command}-cli.ts`, implement command-specific class/functions
- Routing: Register in MCPClientCLI.processCommand() switch statement (`src/cli-client.ts:600+`)
- Callbacks: Accept callbacks interface for parent CLI interaction (see AblationCLI for pattern)

**New LLM Provider:**
- Implementation: `src/providers/{provider-name}.ts`, implement `ModelProvider` interface
- Token counting: Provide `createTokenCounter()` implementation
- API integration: Use provider's official SDK
- Registration: Add to PROVIDERS list in `src/bin.ts`, add factory case in createProvider()

**New Web API Route:**
- Implementation: Add route handler in `src/web/api.ts` (router.get/post/etc.)
- Pattern: Use `createStreamBridge<T>()` for SSE streaming endpoints
- MCPClient access: Route handlers have client instance reference

**New Utility:**
- Implementation: Add function to appropriate file in `src/utils/` (or create new utils file)
- Naming: kebab-case filename, camelCase function names
- Exports: Named exports, not default

**New Manager:**
- Implementation: Create class at `src/managers/{domain}-manager.ts`
- Pattern: Extend from manager base or standalone; owns its YAML/filesystem state
- Constructor: Accept Logger, load initial state from filesystem
- Methods: CRUD + query operations, persistence on mutation
- Integration: Instantiate in MCPClient constructor, expose via getter

## Special Directories

**.mcp-client-data/:**
- Purpose: User-facing runtime state (chats, ablations, preferences)
- Generated: True — MCPClient and managers create structure at startup
- Committed: False — .gitignored (contains user data)
- Subdirectories: chats/, ablations/definitions/, ablations/runs/, attachments/, cache/, outputs/

**dist/:**
- Purpose: Compiled JavaScript output
- Generated: True — produced by TypeScript compiler (`npm run build`)
- Committed: False — ignored (build artifact)
- Structure: Mirrors src/ layout

**schemas/:**
- Purpose: JSON Schema definitions for IDE autocomplete
- Generated: False — hand-written or generated once
- Committed: True — part of source
- Usage: IDEs load for validation; not used at runtime (optional)

**scripts/:**
- Purpose: Utility scripts for development/testing
- Examples: test-provider-cache.ts (model caching), analyze-openai-cache.ts (billing)
- Generated: False — hand-written
- Committed: True — source
- Executed: Manually via `npx ts-node scripts/{script}.ts`

**reference-repos/:**
- Purpose: Cloned reference implementations for design inspiration
- Contents: mcp-chat, chatmcp, open-mcp-client, multi-llm-ts
- Generated: True — cloned via git clone
- Committed: False — .gitignored

## Module Resolution

- **Absolute imports:** `src/` based (e.g., `import { MCPClient } from 'src/index.js'`)
- **Relative imports:** Used within directories (e.g., `import { Logger } from '../logger.js'`)
- **Extensions:** All imports include `.js` extension (TypeScript → JavaScript at runtime)
- **Aliases:** No path aliases configured in tsconfig.json (direct paths used)

---

*Structure analysis: 2026-05-02*
