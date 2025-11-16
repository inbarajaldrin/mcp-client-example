import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from './model-provider.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_FILE = join(__dirname, '..', 'mcp_config.json');

interface TodoServerConfig {
  command: string;
  args: string[];
  disabled?: boolean;
  timeout?: number;
  type?: string;
}

interface MCPConfig {
  mcpServers: Record<string, TodoServerConfig>;
}

type ServerConnection = {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: Tool[];
  prompts: any[]; // Prompts are required to match MCPClient's ServerConnection
};

export class TodoManager {
  private todoServerConfig: StdioServerParameters | null = null;
  private todoServerConnection: ServerConnection | null = null;
  private todoModeEnabled: boolean = false;
  private isConfigDisabled: boolean = false;
  private allowedTools: string[] = [
    'create-todo',
    'list-todos',
    'complete-todo',
    'delete-todo',
    'skip-todo',
    'clear-todo-list',
  ];
  private logger: Logger;
  private serverName: string = 'todo';

  constructor(logger?: Logger) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.loadConfig();
  }

  /**
   * Load todo server configuration from mcp_config.json
   */
  loadConfig(): void {
    try {
      if (!existsSync(CONFIG_FILE)) {
        this.todoServerConfig = null;
        return;
      }

      const content = readFileSync(CONFIG_FILE, 'utf-8');
      const config: MCPConfig = JSON.parse(content);

      if (config.mcpServers && config.mcpServers[this.serverName]) {
        const todoConfig = config.mcpServers[this.serverName];
        
        // Store disabled status but still load config (so /todo-on can enable it)
        this.isConfigDisabled = todoConfig.disabled || false;

        // Always load config even if disabled - /todo-on will enable it
        this.todoServerConfig = {
          command: todoConfig.command,
          args: todoConfig.args || [],
        };
      } else {
        this.todoServerConfig = null;
        this.isConfigDisabled = false;
      }
    } catch (error) {
      this.logger.log(
        `Failed to load todo server config: ${error}\n`,
        { type: 'warning' },
      );
      this.todoServerConfig = null;
    }
  }

  /**
   * Check if todo server is configured
   */
  isConfigured(): boolean {
    return this.todoServerConfig !== null;
  }

  /**
   * Connect to todo server
   */
  async connect(): Promise<ServerConnection> {
    if (!this.todoServerConfig) {
      throw new Error('Todo server not configured');
    }

    if (this.todoServerConnection) {
      return this.todoServerConnection;
    }

    this.logger.log(`Connecting to todo server...\n`, { type: 'info' });

    const client = new Client(
      { name: 'cli-client', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport(this.todoServerConfig);

    await client.connect(transport);
    
    // Give the server process a moment to fully initialize
    await new Promise(resolve => setTimeout(resolve, 200));

    const connection: ServerConnection = {
      name: this.serverName,
      client,
      transport,
      tools: [],
      prompts: [],
    };

    // Load tools from the server
    try {
      const toolsResults = await client.request(
        { method: 'tools/list' },
        ListToolsResultSchema,
      );

      const serverTools = toolsResults.tools.map(
        ({ inputSchema, name, description }) => {
          const prefixedName = `${this.serverName}__${name}`;
          return {
            name: prefixedName,
            description: `[${this.serverName}] ${description}`,
            input_schema: inputSchema,
          };
        },
      );

      connection.tools = serverTools;
    } catch (error) {
      this.logger.log(
        `Failed to load tools from todo server: ${error}\n`,
        { type: 'warning' },
      );
    }

    this.todoServerConnection = connection;
    this.logger.log(`✓ Connected to todo server\n`, { type: 'info' });

    return connection;
  }

  /**
   * Disconnect from todo server
   */
  async disconnect(): Promise<void> {
    if (this.todoServerConnection) {
      try {
        await this.todoServerConnection.client.close();
      } catch (error) {
        // Ignore errors during cleanup
      }
      this.todoServerConnection = null;
      this.todoModeEnabled = false;
      this.logger.log(`✓ Disconnected from todo server\n`, { type: 'info' });
    }
  }

  /**
   * Filter tools to only include allowed todo tools
   */
  filterTools(tools: Array<{ name: string; description: string; input_schema: any }>): Array<{ name: string; description: string; input_schema: any }> {
    return tools.filter((tool) => {
      // Remove server prefix to check tool name
      const toolName = tool.name.includes('__')
        ? tool.name.split('__')[1]
        : tool.name;
      return this.allowedTools.includes(toolName);
    });
  }

  /**
   * Get the todo server connection
   */
  getConnection(): ServerConnection | null {
    return this.todoServerConnection;
  }

  /**
   * Set the todo server connection (used when server is already connected)
   */
  setConnection(connection: ServerConnection): void {
    this.todoServerConnection = connection;
  }

  /**
   * Check if todo mode is enabled
   */
  isEnabled(): boolean {
    return this.todoModeEnabled;
  }

  /**
   * Enable todo mode
   */
  enable(): void {
    this.todoModeEnabled = true;
  }

  /**
   * Disable todo mode
   */
  disable(): void {
    this.todoModeEnabled = false;
  }

  /**
   * Get active todos count (non-completed, non-skipped)
   */
  async getActiveTodosCount(): Promise<number> {
    if (!this.todoServerConnection) {
      return 0;
    }

    try {
      const result = await this.todoServerConnection.client.request(
        {
          method: 'tools/call',
          params: {
            name: 'list-todos',
            arguments: {},
          },
        },
        CallToolResultSchema,
      );

      // Parse the result to count active todos
      const content = result.content[0];
      if (content && content.type === 'text') {
        // The result is a text string, we need to parse it
        // For now, we'll call the tool and count todos that are not completed
        // This is a simplified approach - the actual implementation depends on the todo server's response format
        const todosText = content.text;
        
        // Try to extract todos from the response
        // If the server returns JSON, parse it; otherwise count lines or patterns
        try {
          const todos = JSON.parse(todosText);
          if (Array.isArray(todos)) {
            return todos.filter((todo: any) => !todo.completed && !todo.skipped).length;
          }
        } catch {
          // If not JSON, try to count based on text patterns
          // Count lines that don't contain "completed" or "skipped" markers
          const lines = todosText.split('\n');
          let activeCount = 0;
          for (const line of lines) {
            if (line.includes('✅') || line.includes('completed')) {
              continue;
            }
            if (line.includes('⏳') || line.includes('active') || line.match(/^\d+\./)) {
              activeCount++;
            }
          }
          return activeCount;
        }
      }

      return 0;
    } catch (error) {
      this.logger.log(
        `Failed to get active todos count: ${error}\n`,
        { type: 'warning' },
      );
      return 0;
    }
  }

  /**
   * Get list of active todos as text
   */
  async getActiveTodosList(): Promise<string> {
    if (!this.todoServerConnection) {
      return 'No todo server connection';
    }

    try {
      const result = await this.todoServerConnection.client.request(
        {
          method: 'tools/call',
          params: {
            name: 'list-todos',
            arguments: {},
          },
        },
        CallToolResultSchema,
      );

      const content = result.content[0];
      if (content && content.type === 'text') {
        return content.text;
      }

      return 'No todos found';
    } catch (error) {
      this.logger.log(
        `Failed to get active todos list: ${error}\n`,
        { type: 'warning' },
      );
      return `Error retrieving todos: ${error}`;
    }
  }

  /**
   * Check if all todos are completed or skipped
   */
  async checkTodosComplete(): Promise<boolean> {
    const activeCount = await this.getActiveTodosCount();
    return activeCount === 0;
  }

  /**
   * Get server name
   */
  getServerName(): string {
    return this.serverName;
  }
}

