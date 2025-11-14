<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://neon.com/brand/neon-logo-dark-color.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://neon.com/brand/neon-logo-light-color.svg">
  <img width="250px" alt="Neon Logo fallback" src="https://neon.com/brand/neon-logo-dark-color.svg">
</picture>

## MCP Client CLI

> **Note:** This project is based on the MCP client from [neondatabase/mcp-server-neon](https://github.com/neondatabase/mcp-server-neon). Original work by Neon, Inc.

This is a CLI client that can be used to interact with any MCP server and its tools. For more, see [Building a CLI Client For Model Context Protocol Servers](https://neon.tech/blog/building-a-cli-client-for-model-context-protocol-servers).

## Requirements

- **ANTHROPIC_API_KEY** - Get one from [Anthropic](https://console.anthropic.com/) (required for Claude)
- Node.js >= v18.0.0

> **Note:** You do NOT need a Neon API key to use this client. The client works with any MCP server. Neon API keys are only required if you specifically want to use the Neon MCP server.

## How to use

### Quick Start (Single Server)

Use the client with any MCP server:

```bash
export ANTHROPIC_API_KEY=your_anthropic_key_here

# Use any MCP server directly
npx @neondatabase/mcp-client-cli \
  --server-command="npx" \
  --server-args="-y @yourorg/mcp-server start"

# Or use a local server
npx @neondatabase/mcp-client-cli \
  --server-command="node" \
  --server-args="/path/to/your-server.js start"
```

### Managing Multiple Servers

The client supports managing multiple MCP servers through a configuration file. This allows you to easily switch between different servers without specifying the command and arguments each time.

#### Add a Server

Add your custom servers to the configuration:

```bash
# Add your first custom server
npx @neondatabase/mcp-client-cli \
  --add-server="my-server" \
  --server-command="npx" \
  --server-args="-y @yourorg/mcp-server start"

# Add another custom server
npx @neondatabase/mcp-client-cli \
  --add-server="another-server" \
  --server-command="node" \
  --server-args="/path/to/server.js start"

# Add a local development server
npx @neondatabase/mcp-client-cli \
  --add-server="local-dev" \
  --server-command="node" \
  --server-args="./dist/index.js start"
```

> **Note:** If you want to use the Neon MCP server (optional), you would add it like this:
> ```bash
> npx @neondatabase/mcp-client-cli \
>   --add-server="neon" \
>   --server-command="npx" \
>   --server-args="-y @neondatabase/mcp-server-neon start <neon-api-key>"
> ```

#### List Configured Servers

```bash
npx @neondatabase/mcp-client-cli --list-servers
```

#### Use a Specific Server

```bash
# Use a configured server by name
npx @neondatabase/mcp-client-cli --server="my-server"

# Or use the short form
npx @neondatabase/mcp-client-cli -s "another-server"
```

#### Set Default Server

Set a default server so you don't need to specify `--server` each time:

```bash
npx @neondatabase/mcp-client-cli --set-default="my-server"
```

After setting a default, you can simply run:

```bash
npx @neondatabase/mcp-client-cli
```

#### Remove a Server

```bash
npx @neondatabase/mcp-client-cli --remove-server="my-server"
```

#### Run Multiple Servers Simultaneously

The client supports running multiple MCP servers at the same time, allowing you to use tools from all connected servers in a single session:

```bash
# Run all enabled servers from your configuration
npx @neondatabase/mcp-client-cli --all

# Run specific servers by name
npx @neondatabase/mcp-client-cli --servers server1 server2 server3
```

**How it works:**
- All tools from connected servers are aggregated and available to the AI
- Tool names are prefixed with the server name (e.g., `server-name__tool-name`) to avoid conflicts
- If some servers fail to connect, the client continues with the ones that succeed
- Tool calls are automatically routed to the correct server based on the tool name prefix

#### Configuration File Location

The configuration file is stored at: `~/.mcp-client/config.json`

You can also edit this file directly if you prefer:

```json
{
  "servers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@yourorg/mcp-server", "start"]
    },
    "local-dev": {
      "command": "node",
      "args": ["./dist/index.js", "start"]
    },
    "another-server": {
      "command": "node",
      "args": ["/path/to/server.js", "start"]
    }
  },
  "defaultServer": "my-server"
}
```

## How to develop

1. Clone the repository
2. Setup a `.env` file based on the `.env.example` file
3. Run `npm install`
4. Run `npm run start:mcp-server-neon`
