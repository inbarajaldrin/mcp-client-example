# External Integrations

**Analysis Date:** 2026-05-02

## APIs & External LLM Services

**Anthropic Claude:**
- Service: Anthropic API (https://console.anthropic.com/)
- SDK: @anthropic-ai/sdk 0.32.1
- Implementation: `src/providers/anthropic.ts`
- Auth: `ANTHROPIC_API_KEY` environment variable (required for Anthropic provider)
- Models supported: claude-haiku-4-5-20251001, claude-sonnet-4-20250514, claude-opus-4-20250514
- Features: Extended thinking (reasoning models), cache control, cost reporting via API

**OpenAI GPT:**
- Service: OpenAI API (https://platform.openai.com/api-keys)
- SDK: openai 6.9.0
- Implementation: `src/providers/openai.ts`
- Auth: `OPENAI_API_KEY` environment variable (required for OpenAI provider)
- Models supported: gpt-5, gpt-5-mini, gpt-4o, gpt-4o-mini
- Features: Context window 128k-200k tokens, o1 reasoning models, GPT-4 vision
- Token counting: tiktoken 1.0.22 (cl100k_base encoding)

**Google Gemini:**
- Service: Google Generative AI API (https://aistudio.google.com/app/apikey)
- SDK: @google/genai 1.34.0
- Implementation: `src/providers/google.ts`
- Auth: `GEMINI_API_KEY` environment variable (required for Gemini provider)
- Features: Server-Sent Events (SSE) streaming with raw fetch interception for pipeline inspection
- Raw HTTP capture: Custom fetch interceptor for debugging (`installFetchInterceptor()`)

**xAI Grok:**
- Service: xAI API (https://console.x.ai/)
- SDK: openai 6.9.0 (compatible client)
- Implementation: `src/providers/xai.ts`
- Auth: `XAI_API_KEY` environment variable (required for xAI provider)
- Features: Uses OpenAI SDK for client compatibility

**Ollama (Local LLMs):**
- Service: Local Ollama instance (default: http://localhost:11434)
- SDK: ollama 0.6.3
- Implementation: `src/providers/ollama.ts`
- Auth: None (local service)
- Env var: `OLLAMA_HOST` (optional, defaults to localhost:11434)
- Models supported: qwen3:8b (default)
- Features: Context window limits configurable via `OLLAMA_MAX_CONTEXT` (default 16384 tokens)
- Metrics: Ollama-specific metrics (totalDuration, evalDuration, tokenization rates)

## Model Context Protocol (MCP) Servers

**SDK:**
- @modelcontextprotocol/sdk 1.25.2 - MCP protocol implementation
- Transport: Stdio-based (child processes)
- Configuration: JSON files (`mcp_config.json`, `mcp_config_*.json`)

**Configured MCP Servers (from mcp_config.json):**

1. **isaac-sim** - NVIDIA Isaac Simulation
   - Type: stdio
   - Command: Python (`isaac-sim-mcp/isaac_mcp/server.py`)
   - Env: `ISAAC_SIM_PORT=8766`
   - Disabled: false
   - Purpose: Robotic simulation and environment control

2. **ros-mcp-server** - ROS2 Robot Operating System Integration
   - Type: stdio
   - Setup: Sources ROS Humble and local workspace setup
   - Env: `ROS_DOMAIN_ID=0`, `ROS_LOCALHOST_ONLY=1`
   - Disabled: false
   - Purpose: Robot task execution, assembly operations

3. **Prompts** - MCP Prompts Server
   - Type: stdio
   - Command: Python (`ros-mcp-server/prompt.py`)
   - Disabled: false
   - Purpose: Reusable prompt templates and task specifications

4. **Resources** - MCP Resources Server
   - Type: stdio
   - Command: Python (`ros-mcp-server/resource.py`)
   - Disabled: false
   - Purpose: Resource discovery and management

5. **ros2-video-recorder** - ROS2 Video Recording
   - Type: stdio
   - Disabled: true (disabled by default)
   - Env: `ROS_DOMAIN_ID=0`, `ROS_LOCALHOST_ONLY=1`
   - Purpose: Video recording during robot operations (managed by VideoRecordingManager)

6. **mcp-tools-orchestrator** - MCP Tools Orchestrator
   - Type: stdio
   - Disabled: false
   - Env: `ROS_MCP_SERVER_DIR` pointing to ros-mcp-server
   - Purpose: Coordinate multi-tool execution across MCP servers

7. **todo** - Todo List MCP Server
   - Type: stdio
   - Disabled: true
   - Purpose: Task management during ablation studies

## Web Framework Stack

**Backend:**
- express 5.2.1 - HTTP server and REST API
- Location: `src/web/server.ts` (startWebServer function)
- Location: `src/web/api.ts` (createApiRouter function)

**Frontend:**
- React 19.2.4 - UI framework
- Vite 7.3.1 - Build tool and dev server
- Location: `src/web/frontend/` (separate Vite project)
- Config: `src/web/frontend/vite.config.ts`
- Build output: `dist/web/frontend/dist/`

**File Upload:**
- multer 2.0.2 - Multipart form data handling
- Temp directory: OS tmpdir (`/tmp` on Linux)
- Used by `/api` routes for file attachments

## Data Storage & State Management

**Chat History:**
- Manager: `src/managers/chat-history-manager.ts`
- Storage: File-based (`.mcp-client-data/chat-history/`)
- Format: JSON sessions with message history
- Features: Chat sessions, message persistence, automatic summarization

**Ablation Studies:**
- Manager: `src/managers/ablation-manager.ts`
- Storage: YAML-based definition files and run outputs
- Location: `.mcp-client-data/ablations/`
- Subdirectories: `definitions/`, `runs/`, plus outputs per run
- Purpose: A/B testing framework for robotic assembly with multi-provider evaluation

**Attachment Management:**
- Manager: `src/managers/attachment-manager.ts`
- Storage: `.mcp-client-data/attachments/`
- Formats: Images, PDFs, and other file types
- Used by: Chat and tool execution contexts

**Server Logs:**
- Manager: `src/managers/server-log-manager.ts`
- Storage: `.mcp-client-data/` directory
- Purpose: MCP server stdio capture and debugging

**Preferences:**
- Manager: `src/managers/preferences-manager.ts`
- Storage: JSON file
- Purpose: User settings and configuration persistence

## Token Management & Billing

**Token Counting:**
- tiktoken 1.0.22 - Token encoding/decoding (cl100k_base for OpenAI/Anthropic models)
- Implementation: Per-provider TokenCounter classes in `src/providers/`
- Manager: `src/core/token-manager.ts`
- Features: Automatic context window tracking, summarization triggers

**Cost Tracking (Anthropic-specific):**
- Anthropic Cost Report API integrated in `src/providers/anthropic.ts`
- Supports: Time-bucketed cost aggregation, model/context-window filtering
- API endpoint: Uses internal Anthropic API for cost reporting

## Environment Configuration

**Required Environment Variables:**
- `ANTHROPIC_API_KEY` - Anthropic Claude API key
- `OPENAI_API_KEY` - OpenAI GPT API key
- `GEMINI_API_KEY` - Google Gemini API key
- `XAI_API_KEY` - xAI Grok API key

**Optional Environment Variables:**
- `OLLAMA_HOST` - Ollama server URL (default: http://localhost:11434)
- `OLLAMA_MAX_CONTEXT` - Context window limit in tokens (default: 16384)
- `NODE_ENV` - Set to 'production' to skip Vite dev server
- `ROS_DOMAIN_ID` - ROS2 domain ID (set to 0 in MCP config)
- `ROS_LOCALHOST_ONLY` - ROS2 localhost-only mode (set to 1 in MCP config)

**Configuration Files:**
- `.env` - Local environment variables (loaded by dotenv, not committed)
- `.env.example` - Template with all required keys
- `mcp_config.json` - MCP server definitions
- `mcp_config_*.json` - Alternative MCP configs (mode2, real, ablation variants)
- `tsconfig.json` - TypeScript compiler options

## Webhooks & Callbacks

**Incoming:**
- `/api/chat` - POST endpoint for sending chat messages with MCP tool access
- `/api/chat/cancel` - POST endpoint for canceling active chat requests
- `/api/approve` - POST endpoint for tool execution approval/rejection
- `/api/elicit` - POST endpoint for elicitation (multi-turn approval flows)

**Outgoing:**
- None detected. System calls MCP servers via stdio (process-based), not webhooks.

## Tool Execution Framework

**Local Tool Execution:**
- Implementation: `src/core/tool-executor.ts` (MCPToolExecutor class)
- Features: Tool definition loading, argument validation, execution sandboxing
- Output handling: Support for text results and content blocks (images, code)
- ANSI stripping: Text output cleaned of terminal escape codes for API consumption

## Logging & Observability

**Logging:**
- Custom Logger: `src/logger.ts`
- Modes: verbose, quiet, interactive
- Output: Console with colored chalk-based formatting
- Server stderr handling: Suppressed in web mode (set to 'ignore') to prevent buffer deadlocks

**No external monitoring detected** - Logging is console-only, no Sentry, DataDog, or cloud observability.

## External Dependencies for Robotic Research

**Isaac Sim Integration:**
- Server: isaac-sim-mcp (custom Python MCP server)
- Purpose: Physics simulation, virtual environment control
- Config: Timeout 60s, ISAAC_SIM_PORT env var

**ROS2 Integration:**
- Server: ros-mcp-server (custom Python MCP server)
- Workspace: ~/Desktop/ros2_ws (assumed by config sourcing)
- ROS Version: Humble
- Domain ID: 0 (localhost-only communication)

---

*Integration audit: 2026-05-02*
