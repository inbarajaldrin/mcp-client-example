## MCP Client CLI

> **Note:** This project is based on the MCP client from [neondatabase/mcp-server-neon](https://github.com/neondatabase/mcp-server-neon). Original work by Neon, Inc.

This is a CLI client that can be used to interact with any MCP server and its tools.

## Requirements

- **Node.js >= v18.0.0** - Required to run the CLI client
- **Python 3.x** - Required for Python-based MCP servers (most common)
- **ANTHROPIC_API_KEY** - Get one from [Anthropic](https://console.anthropic.com/) (required for Anthropic provider)
- **OPENAI_API_KEY** - Get one from [OpenAI](https://platform.openai.com/api-keys) (required for OpenAI provider)
- **GEMINI_API_KEY** - Get one from [Google AI Studio](https://aistudio.google.com/apikey) (required for Gemini provider)
- **Ollama** - Install from [ollama.ai](https://ollama.ai/) (required for Ollama provider - local LLMs, no API key needed)

> **Note:** The client works with any MCP server (Python, Node.js, or other). You only need API keys for cloud providers (Anthropic, OpenAI, or Gemini). For local LLMs, use the Ollama provider with no API key required.

## How to use

### Command-Line Flags

**Server Selection:**
- `--server <name>` or `-s <name>` - Use a specific server by name
- `--servers <name1> <name2> ...` - Use multiple specific servers
- `--all` - Use all enabled servers from `mcp_config.json`
- `--list-servers` - List all configured servers

**Model Selection:**
- `--provider <name>` - Select AI provider (`anthropic`, `openai`, `gemini`, or `ollama`, default: `anthropic`)
- `--model <model-id>` - Specify a specific model (e.g., `gpt-4o`, `claude-sonnet-4-20250514`, `gemini-2.5-flash`, `qwen2.5:7b`)
- `--select-model` - Interactive model selection
- `--list-models` - List available models for a provider

**Examples:**
```bash
# List configured servers
npx mcp-client --list-servers

# Use Anthropic (default) with all servers
npx mcp-client --all

# Use OpenAI with a specific server
npx mcp-client --server="my-server" --provider=openai

# Use a specific model
npx mcp-client --server="my-server" --provider=openai --model="gpt-4o"

# Use Gemini for AI inference
npx mcp-client --all --provider=gemini --model=gemini-2.5-flash

# Use Ollama for local LLM inference
npx mcp-client --all --provider=ollama --model=qwen2.5:7b

# Use multiple servers
npx mcp-client --servers server1 server2 --provider=anthropic
```

### Ollama Provider (Local LLMs)

For local LLM inference, use the Ollama provider.

```bash
# Start Ollama server (default: http://localhost:11434)
ollama serve

# Use with MCP client
npx mcp-client --all --provider=ollama --model=llama3.2:3b

# List available Ollama models
npx mcp-client --provider=ollama --list-models
```

**Custom Ollama Host:**

By default, the client connects to `http://localhost:11434`. To use a remote Ollama server or a different port, set the `OLLAMA_HOST` environment variable:

```bash
# Connect to Ollama on a different machine
export OLLAMA_HOST=http://192.168.1.100:11434
npx mcp-client --all --provider=ollama --model=qwen2.5:7b

# Or inline for a single command
OLLAMA_HOST=http://my-server:11434 npx mcp-client --all --provider=ollama
```

> **Note:** Ensure the remote Ollama server allows connections from your machine. You may need to start Ollama with `OLLAMA_HOST=0.0.0.0 ollama serve` on the remote machine to accept external connections.

**Context Window Configuration:**

To prevent out-of-memory errors, the client caps context windows at 16K tokens by default (even if models support more). You can customize this with the `OLLAMA_MAX_CONTEXT` environment variable:

```bash
# Use 8K context window (safer for systems with limited memory)
export OLLAMA_MAX_CONTEXT=8192
npx mcp-client --all --provider=ollama --model=llama3.2:3b

# Use 32K context window (for systems with more memory)
export OLLAMA_MAX_CONTEXT=32768
npx mcp-client --all --provider=ollama --model=llama3.2:3b

# Use unlimited context (use model's full capacity - requires sufficient RAM)
export OLLAMA_MAX_CONTEXT=unlimited
npx mcp-client --all --provider=ollama --model=qwen3-vl:30b

# Or inline for a single command
OLLAMA_MAX_CONTEXT=16384 npx mcp-client --all --provider=ollama --model=llama3.2:3b
```

**Context Window Defaults:**
- Default cap: **16K tokens** (conservative default to avoid OOM with larger models)
- qwen2.5:14b: 16K (capped from 32K)
- llama3.2:3b: 16K (capped from 128K)
- qwen3-vl:30b: 16K (capped from 256K)

> **Tip:** If you encounter "llama runner process has terminated" errors, try lowering `OLLAMA_MAX_CONTEXT` to 8192. If you have sufficient VRAM/RAM, you can increase it to 32768 or set to `unlimited`.

### Configuration File

The client uses a `mcp_config.json` file in your project root to configure MCP servers. This file defines all available servers and their connection settings.

#### Configuration File Format

Create a `mcp_config.json` file in your project root:

```json
{
  "mcpServers": {
    "server-name": {
      "disabled": false,
      "timeout": 60,
      "type": "stdio",
      "command": "/path/to/python",
      "args": [
        "/path/to/server.py"
      ]
    }
  }
}
```

#### Python Server Examples

Here are common Python server configurations:

**Simple Python Server:**
```json
{
  "mcpServers": {
    "my-server": {
      "disabled": false,
      "timeout": 60,
      "type": "stdio",
      "command": "python3",
      "args": [
        "/path/to/my-server/server.py"
      ]
    }
  }
}
```

**Python Server with Virtual Environment:**
```json
{
  "mcpServers": {
    "isaac-sim": {
      "disabled": false,
      "timeout": 60,
      "type": "stdio",
      "command": "/path/to/venv/bin/python",
      "args": [
        "/path/to/isaac-sim-mcp/isaac_mcp/server.py"
      ]
    }
  }
}
```

**Python Server with Environment Setup (ROS example):**
```json
{
  "mcpServers": {
    "ros-mcp-server": {
      "disabled": false,
      "timeout": 60,
      "type": "stdio",
      "command": "bash",
      "args": [
        "-c",
        "source /opt/ros/humble/setup.bash && /path/to/venv/bin/python /path/to/ros-mcp-server/server.py"
      ]
    }
  }
}
```

### Quick Start

1. **Set up your API keys:**
```bash
# For Anthropic provider
export ANTHROPIC_API_KEY=your_anthropic_key_here

# For OpenAI provider
export OPENAI_API_KEY=your_openai_key_here

# For Gemini provider
export GEMINI_API_KEY=your_gemini_key_here
```

2. **Create `mcp_config.json`** with your server configurations (see examples above)

3. **Run the client:**

For local development (after `npm run build`):
```bash
# Using npm script (recommended for local development)
# Note: The double dash (--) is required to pass arguments to npm scripts
npm start -- --all

# Or run directly
node ./dist/bin.js --all

# Run a specific server
npm start -- --server="my-server"

# Run specific servers
npm start -- --servers server1 server2

# Use OpenAI provider
npm start -- --all --provider=openai

# Use a specific model
npm start -- --server="my-server" --provider=openai --model="gpt-4o"
```

> **Important:** When using `npm start`, you must use the double dash (`--`) to pass arguments to your script. This tells npm to pass everything after `--` to your script. Without it, `npm start --all` will not work correctly because npm treats `--all` as an npm argument, not a script argument.

For published package (when installed via npm):
```bash
# Run all enabled servers (with Anthropic, default)
npx mcp-client --all

# Run a specific server
npx mcp-client --server="my-server"

# Run specific servers
npx mcp-client --servers server1 server2

# Use OpenAI provider
npx mcp-client --all --provider=openai

# Use a specific model
npx mcp-client --server="my-server" --provider=openai --model="gpt-4o"
```

#### Run Multiple Servers Simultaneously

The client supports running multiple MCP servers at the same time, allowing you to use tools from all connected servers in a single session:

```bash
# Run all enabled servers from your configuration (with Anthropic, default)
npx mcp-client --all

# Run all servers with OpenAI provider
npx mcp-client --all --provider=openai

# Run specific servers by name
npx mcp-client --servers server1 server2 server3

# Run specific servers with a provider and model
npx mcp-client --servers server1 server2 --provider=openai --model="gpt-4o"
```

**How it works:**
- All tools from connected servers are aggregated and available to the AI
- Tool names are prefixed with the server name (e.g., `server-name__tool-name`) to avoid conflicts
- If some servers fail to connect, the client continues with the ones that succeed
- Tool calls are automatically routed to the correct server based on the tool name prefix

#### Server Configuration Options

- **`disabled`**: Set to `true` to exclude a server from `--all` mode (server can still be used with `--server` or `/todo-on`)
- **`timeout`**: Connection timeout in seconds (default: 60)
- **`type`**: Connection type, typically `"stdio"` for standard input/output
- **`command`**: The command to run (e.g., `python3`, `/path/to/venv/bin/python`, `bash`)
- **`args`**: Array of arguments to pass to the command

**Example with multiple servers:**
```json
{
  "mcpServers": {
    "isaac-sim": {
      "disabled": false,
      "timeout": 60,
      "type": "stdio",
      "command": "/path/to/isaac-sim-mcp/venv/bin/python",
      "args": ["/path/to/isaac-sim-mcp/isaac_mcp/server.py"]
    },
    "ros-mcp-server": {
      "disabled": false,
      "timeout": 60,
      "type": "stdio",
      "command": "bash",
      "args": [
        "-c",
        "source /opt/ros/humble/setup.bash && /path/to/venv/bin/python /path/to/ros-mcp-server/server.py"
      ]
    },
    "mcp-tools-orchestrator": {
      "disabled": true,
      "timeout": 60,
      "type": "stdio",
      "command": "/path/to/mcp-tools-orchestrator/.venv/bin/python",
      "args": [
        "/path/to/mcp-tools-orchestrator/server.py"
      ]
    },
    "todo": {
      "disabled": true,
      "timeout": 60,
      "type": "stdio",
      "command": "python3",
      "args": ["/path/to/todo-list-mcp/server.py"]
    }
  }
}
```

### Automatic Context Summarization

The client automatically manages conversation context to prevent hitting token limits during long conversations. When the context window approaches 80% capacity, the client will:

- Automatically summarize older conversation history
- Preserve the most recent messages (default: last 10 messages)
- Compress old messages into a concise summary
- Continue the conversation seamlessly

**Features:**
- Real-time token tracking using `tiktoken`
- Model-specific context windows:
  - Anthropic models: 200k tokens (default)
  - OpenAI models: Varies by model (e.g., GPT-5: 200k tokens, GPT-4o: 128k tokens)
- Configurable summarization threshold (default: 80%)
- Automatic token counting for all messages (user, assistant, tool results)
- Provider-specific token counting algorithms

**System Commands:**

While in the interactive CLI, you can use these special commands:

- `/clear` or `/clear-context` - Clear current chat and start fresh (servers stay connected, discarded chat is not saved)
- `/token-status` or `/tokens` - Show current token usage statistics
- `/summarize` or `/summarize-now` - Manually trigger summarization (useful for testing)
- `/settings` - View and modify client preferences (timeout, max iterations)
- `/refresh` or `/refresh-servers` - Refresh MCP server connections without restarting the client
- `/set-timeout <seconds>` - Set MCP tool timeout (1-3600, or "infinity"/"unlimited", default: 60)
- `/set-max-iterations <number>` - Set max iterations between agent calls (1-10000, or "infinity"/"unlimited", default: 100)

**Example:**
```bash
You: /token-status
Token Usage Status:
  Current: 23309 tokens
  Limit: 200000 tokens
  Usage: 11.65%
  Status: continue
  Messages: 15

You: /summarize
Manually triggering summarization...
Conversation summarized. Context reduced from 12 to 1 summary message.

You: /clear
Discarded chat session: session-abc123
✓ Chat context cleared. Starting fresh session.
Started chat session: session-xyz789
```

### Todo Mode

Enable task tracking mode where the agent automatically decomposes tasks into todos and cannot exit until all are completed or skipped.

**Commands:**
- `/todo-on` - Enable todo mode (requires todo server in `mcp_config.json`)
- `/todo-off` - Disable todo mode

**Features:**
- Automatic todo clearing when enabling todo mode and before each user query
- Agent decomposes tasks into actionable todos using `create-todo`
- Agent marks todos as complete using `complete-todo` as it works
- Exit prevention: agent cannot exit until all todos are completed or skipped
- Tool filtering: only essential todo tools available (`create-todo`, `list-todos`, `complete-todo`, `delete-todo`, `skip-todo`, `clear-todo-list`)

**Example:**
```bash
You: /todo-on
Todo mode enabled

You: Assemble 4 line_red objects
[Client automatically clears existing todos]
[Agent creates 4 todos and starts working through them]

You: Now assemble 3 line_blue objects
[Client automatically clears previous todos]
[Agent creates 3 new todos for the new task]
```

**Note:** Todo server can be disabled in `mcp_config.json` and will be excluded from `--all` servers, but `/todo-on` will still connect to it on-demand.

### Orchestrator Mode

Enable orchestrator mode to use the `mcp-tools-orchestrator` server, which acts as an intelligent agent that can orchestrate tool calls across all your MCP servers. When orchestrator mode is enabled, only the orchestrator's tools are visible to the LLM, while all other servers remain connected and accessible via an IPC (Inter-Process Communication) server.

**How it works:**

1. **IPC Server**: When orchestrator mode is enabled (or when `mcp-tools-orchestrator` is enabled in config), the client automatically starts an HTTP IPC server on a random local port. This server exposes all connected MCP server tools to the orchestrator.

2. **Tool Routing**: The `mcp-tools-orchestrator` server can call tools from other servers via the IPC server, avoiding duplicate server processes. The orchestrator receives the IPC URL via the `MCP_CLIENT_IPC_URL` environment variable.

3. **Tool Filtering**: In orchestrator mode, only `mcp-tools-orchestrator` tools are visible to the LLM. All other server tools are hidden from direct LLM access but remain available for the orchestrator to call via IPC.

4. **Automatic Connection**: If `mcp-tools-orchestrator` is enabled in `mcp_config.json`, the IPC server starts automatically when you launch the client with `--all`. If the orchestrator server is disabled, you can connect it on-demand using `/orchestrator-on`.

**Commands:**
- `/orchestrator-on` - Enable orchestrator mode (requires `mcp-tools-orchestrator` server in `mcp_config.json`)
- `/orchestrator-off` - Disable orchestrator mode (restore all enabled server tools)

**Configuration:**

Add `mcp-tools-orchestrator` to your `mcp_config.json`:

```json
{
  "mcpServers": {
    "mcp-tools-orchestrator": {
      "disabled": false,
      "timeout": 60,
      "type": "stdio",
      "command": "/path/to/mcp-tools-orchestrator/.venv/bin/python",
      "args": [
        "/path/to/mcp-tools-orchestrator/server.py"
      ]
    }
  }
}
```

**Example Usage:**

```bash
# Start client with all servers (including orchestrator if enabled)
npx mcp-client --all

# In the interactive CLI, enable orchestrator mode
You: /orchestrator-on
Orchestrator IPC enabled: http://localhost:54321
Connecting to mcp-tools-orchestrator server...
✓ Connected to "mcp-tools-orchestrator"
✓ Orchestrator mode enabled

# Now only orchestrator tools are visible to the LLM
# The orchestrator can call tools from other servers via IPC
You: Write a script that uses tools from multiple servers

# Disable orchestrator mode to restore direct tool access
You: /orchestrator-off
✓ Orchestrator mode disabled
```

**Features:**

- **IPC Server**: Automatically starts an HTTP server that exposes all connected MCP server tools
- **Tool Discovery**: The orchestrator can discover available tools via the `/list_tools` IPC endpoint
- **Tool Execution**: The orchestrator calls tools via the `/call_tool` IPC endpoint, which routes to the appropriate server
- **On-Demand Connection**: If `mcp-tools-orchestrator` is disabled in config, `/orchestrator-on` will connect it on-demand
- **Visual Feedback**: IPC tool calls are displayed with distinct styling (magenta/pink) to differentiate them from direct tool calls
- **Abort Support**: IPC tool calls respect user abort signals (Ctrl+C)

**IPC Server Endpoints:**

The orchestrator IPC server exposes the following endpoints:

- `GET /health` - Health check endpoint
- `GET /list_tools` - Returns all available tools grouped by server
- `POST /call_tool` - Executes a tool call on a specific server (body: `{ server, tool, arguments }`)

**Note:** The orchestrator server can be disabled in `mcp_config.json` and will be excluded from `--all` servers, but `/orchestrator-on` will still connect to it on-demand. The IPC server automatically starts when orchestrator mode is enabled, even if the orchestrator server was initially disabled.

### Tool Selection Management

Selectively enable or disable tools from all connected servers with persistent state across sessions.

**Commands:**
- `/tools` or `/tools-list` - List currently enabled tools
- `/tools-manager` or `/tools-select` - Interactive tool enable/disable selection

**Features:**
- **Persistent state**: Tool selections are saved to `.mcp-client-data/preferences.json` and persist across sessions
- **Works with all launch modes**: Tool states are applied whether using `--all`, `--servers`, or single server mode
- **New tools default to enabled**: When a new server is added, all its tools are enabled by default
- **Interactive selection**: Visual interface to toggle individual tools or entire servers
- **Real-time updates**: Display refreshes immediately after toggling tools

**Interactive Tool Manager:**

When you run `/tools-manager`, you'll see an interactive interface:

```
🔧 Tool Selection
Available Servers and Tools:

S1. ✓ [isaac-sim] (5/5 enabled):
  1. ✓ tool1
  2. ✓ tool2
  3. ✓ tool3
  4. ✓ tool4
  5. ✓ tool5

S2. ~ [ros-mcp-server] (2/5 enabled):
  6. ✓ tool1
  7. ✗ tool2
  8. ✗ tool3
  9. ✓ tool4
  10. ✗ tool5

Commands:
  Enter numbers separated by commas or ranges (e.g., 1,3,5-8) to toggle tools
  Enter S + number (e.g., S1, s2) to toggle all tools in a server
  a or all - Enable all tools
  n or none - Disable all tools
  s or save - Save changes and return
  q or quit - Cancel and return
```

**Usage Examples:**

```bash
# List all tools and their status
You: /tools or /tools-list

# Interactive selection mode
You: /tools-manager
> 1,3,5-8        # Toggle tools 1, 3, and 5 through 8
> S1             # Toggle all tools in server 1
> a              # Enable all tools
> n              # Disable all tools
> s              # Save and exit
> q              # Cancel and revert changes
```

**Configuration:**

Tool states are stored in `.mcp-client-data/preferences.json`:

```json
{
  "toolStates": {
    "isaac-sim__tool1": true,
    "isaac-sim__tool2": false,
    "ros-mcp-server__tool1": true
  }
}
```

**Note:** Tool states persist across all launch modes. If you disable tools using `--all` mode, those same tools will be disabled when you launch with `--servers` or single server mode.

### Prompt Management

Selectively enable or disable prompts from all connected servers and add enabled prompts to your conversation context.

**Commands:**
- `/add-prompt` - Add enabled prompts to conversation context (interactive selection)
- `/prompts` or `/prompts-list` - List currently enabled prompts
- `/prompts-manager` or `/prompts-select` - Interactive prompt enable/disable selection

**Features:**
- Persistent state saved to `.mcp-client-data/preferences.json`
- `/add-prompt` only shows enabled prompts
- Interactive argument collection for prompts with arguments
- Selected prompts are added to conversation context (not sent automatically)

**Usage:**

```bash
# List all prompts
You: /prompts-list

# Add enabled prompts to context
You: /add-prompt
> 1,3,5        # Select prompts (enter arguments if prompted)

# Manage prompt states (same interface as tools)
You: /prompts-manager
> 1,3,5-8      # Toggle prompts
> S1            # Toggle all in server 1
> a/n           # Enable/disable all
> s/q           # Save/cancel
```

**Note:** Prompt states persist across all launch modes, similar to tool states.

### Client Preferences

The client stores user preferences in `.mcp-client-data/preferences.json`. This includes tool states, prompt states, and client settings.

**Preferences stored:**
- `toolStates` - Which tools are enabled/disabled
- `promptStates` - Which prompts are enabled/disabled
- `mcpTimeout` - MCP tool call timeout in seconds (default: 60)
- `maxIterations` - Maximum iterations between agent calls (default: 100)

**CLI Commands:**
- `/settings` - View current preferences
- `/set-timeout <seconds>` - Set MCP tool timeout (1-3600 seconds, or "infinity"/"unlimited")
- `/set-max-iterations <number>` - Set max iterations (1-10000)

**Example:**
```bash
You: /settings
⚙️  Client Settings:
  MCP Tool Timeout: 60 seconds
  Max Iterations: 100

You: /set-timeout 120
✓ MCP tool timeout set to 120 seconds

You: /set-max-iterations 200
✓ Max iterations set to 200
```

**Note:** Preferences are saved automatically and persist across sessions. Edit `mcp_config.json` directly to add/remove servers.

### Ablation Studies

Run automated tests across multiple AI models using the same set of commands. Ablation studies allow you to compare how different models perform on identical tasks.

**Commands:**
- `/ablation-create` - Create a new ablation study interactively
- `/ablation-list` - List all ablation studies
- `/ablation-edit <name>` - Edit an existing ablation study
- `/ablation-run <name>` - Run an ablation study
- `/ablation-delete <name>` - Delete an ablation study
- `/ablation-results <name>` - View results of past ablation runs

**Key Concepts:**

- **Phases**: Named groups of commands that execute sequentially. Each phase can contain multiple commands (prompts, tool calls, queries).
- **Models**: Provider + model combinations to test (e.g., `anthropic/claude-sonnet-4-20250514`, `openai/gpt-4o`, `ollama/qwen2.5:7b`).
- **Runs**: Each phase × model combination runs as an isolated chat session. Results are saved for comparison.

**Creating an Ablation Study:**

```bash
You: /ablation-create
Enter ablation name: model-comparison-test
Enter description: Compare coding task performance across models

Adding phases (enter 'done' when finished):

Phase name: coding-task
Enter commands for phase 'coding-task' (enter 'done' when finished):
> /add-prompt 1
> Write a fibonacci function in Python
> done

Phase name: done

Select models to include:
  1. anthropic/claude-sonnet-4-20250514
  2. openai/gpt-4o
  3. gemini/gemini-2.5-flash
  4. ollama/qwen2.5:7b
> 1,2,3

Configure settings:
  Max iterations per run [100]: 50

✓ Created ablation: model-comparison-test
  Phases: 1
  Models: 3
  Total runs: 3
```

**Running an Ablation:**

```bash
You: /ablation-run model-comparison-test

Running ablation: model-comparison-test
Phase: coding-task (1/1)
  [1/3] anthropic/claude-sonnet-4-20250514... ✓ (12.3s, 1,245 tokens)
  [2/3] openai/gpt-4o... ✓ (8.7s, 987 tokens)
  [3/3] gemini/gemini-2.5-flash... ✓ (5.2s, 756 tokens)

Ablation complete!
  Total time: 26.2s
  Total tokens: 2,988
  Results saved to: .mcp-client-data/ablations/runs/model-comparison-test/2025-01-12-143052/
```

**Viewing Results:**

```bash
You: /ablation-results model-comparison-test

Available runs for 'model-comparison-test':
  1. 2025-01-12-143052 (3 runs, 2,988 tokens, 26.2s)
  2. 2025-01-11-091530 (3 runs, 3,102 tokens, 28.1s)

Select run number: 1

Results for run 2025-01-12-143052:
Phase: coding-task
  anthropic/claude-sonnet-4-20250514: completed (12.3s, 1,245 tokens)
  openai/gpt-4o: completed (8.7s, 987 tokens)
  gemini/gemini-2.5-flash: completed (5.2s, 756 tokens)
```

**Features:**

- **Isolated sessions**: Each run starts with a fresh chat context, ensuring fair comparison
- **Error handling**: If a run fails, the error is logged and the study continues with remaining runs
- **State preservation**: Your current chat session is preserved when running an ablation mid-conversation
- **Prompt arguments**: MCP prompts with required arguments are collected during ablation creation
- **Token tracking**: Total tokens used per run are recorded for cost comparison
- **Persistent storage**: Ablation definitions (YAML) and run results (JSON) are saved to `.mcp-client-data/ablations/`

**Configuration:**

Ablation definitions are stored as YAML files in `.mcp-client-data/ablations/`:

```yaml
name: model-comparison-test
description: Compare coding task performance across models
created: '2025-01-12T14:30:00.000Z'
phases:
  - name: coding-task
    commands:
      - '/add-prompt 1'
      - 'Write a fibonacci function in Python'
models:
  - provider: anthropic
    model: claude-sonnet-4-20250514
  - provider: openai
    model: gpt-4o
  - provider: gemini
    model: gemini-2.5-flash
settings:
  maxIterations: 50
```

**Note:** Ablation studies require the respective API keys for each provider you include. Ensure `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` are set as needed, or have Ollama running for local models.

### Model Providers

The client supports multiple AI model providers, each with their own characteristics:

#### Anthropic Provider (Default)

- **Provider name:** `anthropic`
- **Default model:** `claude-haiku-4-5-20251001`
- **Context window:** 200,000 tokens
- **Tool format:** Uses Anthropic's native tool format
- **Tool results:** Uses `user` role messages for tool results

**Environment Variable:**
```bash
export ANTHROPIC_API_KEY=your_anthropic_key_here
```

#### OpenAI Provider

- **Provider name:** `openai`
- **Default model:** `gpt-5`
- **Context window:** Varies by model (GPT-5: 200k, GPT-4o: 128k)
- **Tool format:** Uses OpenAI's function calling format
- **Tool results:** Uses `tool` role messages with `tool_call_id`

**Environment Variable:**
```bash
export OPENAI_API_KEY=your_openai_key_here
```

#### Gemini Provider

- **Provider name:** `gemini`
- **Default model:** `gemini-2.5-flash`
- **Context window:** Varies by model (2.5-flash: 1M, 2.5-pro: 2M tokens)
- **Tool format:** Uses Gemini's function declaration format
- **Tool results:** Uses `functionResponse` parts in user messages

**Environment Variable:**
```bash
export GEMINI_API_KEY=your_gemini_key_here
```

**Usage:**
```bash
# Use OpenAI with default model (gpt-5) - all enabled servers
npx mcp-client --all --provider=openai

# Use OpenAI with a specific model - single server
npx mcp-client --server="my-server" --provider=openai --model="gpt-4o"

# Use Gemini with default model
npx mcp-client --all --provider=gemini

# Use Gemini with a specific model
npx mcp-client --server="my-server" --provider=gemini --model="gemini-2.5-pro"

# Use Anthropic with a specific model
npx mcp-client --server="my-server" --provider=anthropic --model="claude-sonnet-4-20250514"
```

**Note:** The provider abstraction layer automatically handles differences in API formats, tool calling conventions, and message structures between providers.

## How to develop

1. Clone the repository
2. Copy `.env.example` to `.env` and fill in your API keys:
   ```bash
   cp .env.example .env
   # Edit .env and add your ANTHROPIC_API_KEY, OPENAI_API_KEY, and/or GEMINI_API_KEY
   ```
3. Run `npm install`
4. Run `npm run build` to build the project
5. Create `mcp_config.json` with your MCP server configurations (see Configuration File section above)
6. Run the client:
   ```bash
   # Using npm script (recommended)
   # Note: The double dash (--) is required to pass arguments to npm scripts
   npm start -- --all
   
   # Or run directly (no double dash needed when running node directly)
   node ./dist/bin.js --all
   ```

**Note:** For local development, use `npm start` or `node ./dist/bin.js` instead of `npx mcp-client`. The `npx` command only works when the package is installed globally or published to npm.