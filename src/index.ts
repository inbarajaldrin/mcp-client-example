import { Anthropic } from '@anthropic-ai/sdk';

import {
  StdioClientTransport,
  StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import chalk from 'chalk';
import { Tool } from '@anthropic-ai/sdk/resources/index.mjs';
import { Stream } from '@anthropic-ai/sdk/streaming.mjs';
import { consoleStyles, Logger, LoggerOptions } from './logger.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

type MCPClientOptions = StdioServerParameters & {
  loggerOptions?: LoggerOptions;
};

type MultiServerConfig = {
  name: string;
  config: StdioServerParameters;
};

type ServerConnection = {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: Tool[];
};

export class MCPClient {
  private anthropicClient: Anthropic;
  private messages: Message[] = [];
  private servers: Map<string, ServerConnection> = new Map();
  private tools: Tool[] = [];
  private logger: Logger;
  private serverConfigs: MultiServerConfig[];

  constructor(
    serverConfigs: StdioServerParameters | StdioServerParameters[],
    options?: { loggerOptions?: LoggerOptions },
  ) {
    this.anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Support both single server (backward compatibility) and multiple servers
    const configs = Array.isArray(serverConfigs) ? serverConfigs : [serverConfigs];
    this.serverConfigs = configs.map((config, index) => ({
      name: `server-${index}`,
      config,
    }));

    this.logger = new Logger(options?.loggerOptions ?? { mode: 'verbose' });
  }

  // Constructor for multiple named servers
  static createMultiServer(
    servers: Array<{ name: string; config: StdioServerParameters }>,
    options?: { loggerOptions?: LoggerOptions },
  ): MCPClient {
    const client = Object.create(MCPClient.prototype);
    client.anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    client.messages = [];
    client.servers = new Map();
    client.tools = [];
    client.logger = new Logger(options?.loggerOptions ?? { mode: 'verbose' });
    client.serverConfigs = servers;
    return client;
  }

  async start() {
    const connectionErrors: Array<{ name: string; error: any }> = [];

    // Connect to all servers with individual error handling
    for (const serverConfig of this.serverConfigs) {
      try {
        this.logger.log(`Connecting to server "${serverConfig.name}"...\n`, {
          type: 'info',
        });

        const client = new Client(
          { name: 'cli-client', version: '1.0.0' },
          { capabilities: {} },
        );
        const transport = new StdioClientTransport(serverConfig.config);

        await client.connect(transport);
        
        // Give the server process a moment to fully initialize
        await new Promise(resolve => setTimeout(resolve, 200));

        const connection: ServerConnection = {
          name: serverConfig.name,
          client,
          transport,
          tools: [],
        };

        this.servers.set(serverConfig.name, connection);
        this.logger.log(`✓ Connected to "${serverConfig.name}"\n`, {
          type: 'info',
        });
      } catch (error) {
        connectionErrors.push({ name: serverConfig.name, error });
        this.logger.log(
          `✗ Failed to connect to "${serverConfig.name}": ${error}\n`,
          { type: 'warning' },
        );
        // Continue with other servers
      }
    }

    // Check if we have at least one successful connection
    if (this.servers.size === 0) {
      this.logger.log(
        'Failed to connect to any servers. Please check your server configurations.\n',
        { type: 'error' },
      );
      if (connectionErrors.length > 0) {
        this.logger.log('Connection errors:\n', { type: 'error' });
        connectionErrors.forEach(({ name, error }) => {
          this.logger.log(`  ${name}: ${error}\n`, { type: 'error' });
        });
      }
      process.exit(1);
    }

    // Log warnings for failed connections
    if (connectionErrors.length > 0) {
      this.logger.log(
        `Warning: ${connectionErrors.length} server(s) failed to connect, continuing with ${this.servers.size} server(s)\n`,
        { type: 'warning' },
      );
    }

    // Initialize tools from all successfully connected servers
    await this.initMCPTools();
    
    this.logger.log(
      `Connected to ${this.servers.size} server(s): ${Array.from(this.servers.keys()).join(', ')}\n`,
      { type: 'info' },
    );
  }

  async stop() {
    const closePromises = Array.from(this.servers.values()).map((connection) =>
      connection.client.close().catch(() => {
        // Ignore errors during cleanup
      }),
    );
    await Promise.all(closePromises);
    this.servers.clear();
  }

  private async initMCPTools() {
    const allTools: Tool[] = [];

    // Load tools from each server and prefix with server name
    for (const [serverName, connection] of this.servers.entries()) {
      try {
        const toolsResults = await connection.client.request(
          { method: 'tools/list' },
          ListToolsResultSchema,
        );

        const serverTools = toolsResults.tools.map(
          ({ inputSchema, name, description }) => {
            // Prefix tool name with server name to avoid conflicts
            // Use double underscore as separator (colon not allowed in Anthropic tool names)
            const prefixedName = `${serverName}__${name}`;
            return {
              name: prefixedName,
              description: `[${serverName}] ${description}`,
              input_schema: inputSchema,
            };
          },
        );

        connection.tools = serverTools;
        allTools.push(...serverTools);
      } catch (error) {
        this.logger.log(
          `Failed to load tools from server "${serverName}": ${error}\n`,
          { type: 'warning' },
        );
      }
    }

    this.tools = allTools;
    this.logger.log(
      `Loaded ${allTools.length} tool(s) from ${this.servers.size} server(s)\n`,
      { type: 'info' },
    );
  }

  private formatToolCall(toolName: string, args: any): string {
    return (
      '\n' +
      consoleStyles.tool.bracket('[') +
      consoleStyles.tool.name(toolName) +
      consoleStyles.tool.bracket('] ') +
      consoleStyles.tool.args(JSON.stringify(args, null, 2)) +
      '\n'
    );
  }

  private formatJSON(json: string): string {
    return json
      .replace(/"([^"]+)":/g, chalk.blue('"$1":'))
      .replace(/: "([^"]+)"/g, ': ' + chalk.green('"$1"'));
  }

  private async processStream(
    stream: Stream<Anthropic.Messages.RawMessageStreamEvent>,
  ): Promise<void> {
    let currentMessage = '';
    let currentToolName = '';
    let currentToolInputString = '';

    this.logger.log(consoleStyles.assistant);
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'message_start':
        case 'content_block_stop':
          continue;

        case 'content_block_start':
          if (chunk.content_block?.type === 'tool_use') {
            currentToolName = chunk.content_block.name;
          }
          break;

        case 'content_block_delta':
          if (chunk.delta.type === 'text_delta') {
            this.logger.log(chunk.delta.text);
            currentMessage += chunk.delta.text;
          } else if (chunk.delta.type === 'input_json_delta') {
            if (currentToolName && chunk.delta.partial_json) {
              currentToolInputString += chunk.delta.partial_json;
            }
          }
          break;

        case 'message_delta':
          if (currentMessage) {
            this.messages.push({
              role: 'assistant',
              content: currentMessage,
            });
          }

          if (chunk.delta.stop_reason === 'tool_use') {
            const toolArgs = currentToolInputString
              ? JSON.parse(currentToolInputString)
              : {};

            this.logger.log(
              this.formatToolCall(currentToolName, toolArgs) + '\n',
            );

            // Extract server name and actual tool name from prefixed name
            // Format: "server-name__tool-name" (double underscore separator)
            const [serverName, actualToolName] = currentToolName.includes('__')
              ? currentToolName.split('__', 2)
              : [null, currentToolName];

            let toolResult;
            if (serverName && this.servers.has(serverName)) {
              // Route to the specific server
              const connection = this.servers.get(serverName)!;
              toolResult = await connection.client.request(
                {
                  method: 'tools/call',
                  params: {
                    name: actualToolName,
                    arguments: toolArgs,
                  },
                },
                CallToolResultSchema,
              );
            } else {
              // Fallback: try to find the tool in any server (backward compatibility)
              let found = false;
              for (const [name, connection] of this.servers.entries()) {
                const tool = connection.tools.find((t) => t.name === currentToolName || t.name.endsWith(`__${currentToolName}`));
                if (tool) {
                  const actualName = tool.name.includes('__') ? tool.name.split('__')[1] : tool.name;
                  toolResult = await connection.client.request(
                    {
                      method: 'tools/call',
                      params: {
                        name: actualName,
                        arguments: toolArgs,
                      },
                    },
                    CallToolResultSchema,
                  );
                  found = true;
                  break;
                }
              }
              if (!found || !toolResult) {
                throw new Error(`Tool "${currentToolName}" not found in any server`);
              }
            }

            const formattedResult = this.formatJSON(
              JSON.stringify(toolResult.content.flatMap((c) => c.text)),
            );

            this.messages.push({
              role: 'user',
              content: formattedResult,
            });

            const nextStream = await this.anthropicClient.messages.create({
              messages: this.messages,
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 8192,
              tools: this.tools,
              stream: true,
            });
            await this.processStream(nextStream);
          }
          break;

        case 'message_stop':
          break;

        default:
          this.logger.log(`Unknown event type: ${JSON.stringify(chunk)}\n`, {
            type: 'warning',
          });
      }
    }
  }

  async processQuery(query: string) {
    try {
      this.messages.push({ role: 'user', content: query });

      const stream = await this.anthropicClient.messages.create({
        messages: this.messages,
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        tools: this.tools,
        stream: true,
      });
      await this.processStream(stream);

      return this.messages;
    } catch (error) {
      this.logger.log('\nError during query processing: ' + error + '\n', {
        type: 'error',
      });
      if (error instanceof Error) {
        this.logger.log(
          consoleStyles.assistant +
            'I apologize, but I encountered an error: ' +
            error.message +
            '\n',
        );
      }
    }
  }
}
