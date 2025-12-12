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
    'insert-todo',
    'list-todos',
    'read-next-todo',
    'complete-todo',
    'delete-todo',
    'skip-todo',
    'clear-todo-list',
    'mark-todos-not-completed',
    'update-todo',
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
   * Get incomplete todos count (non-completed, non-skipped)
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

      // Parse the result to count incomplete todos
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
          // Look for todos with Status: Not completed (not Completed or Skipped)
          const lines = todosText.split('\n');
          let activeCount = 0;
          let currentStatus: string | null = null;
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].toLowerCase();
            
            // Check for Status line
            if (line.includes('status:')) {
              if (line.includes('not completed') || line.includes('not-completed')) {
                currentStatus = 'not completed';
              } else if (line.includes('completed')) {
                currentStatus = 'completed';
              } else if (line.includes('skipped')) {
                currentStatus = 'skipped';
              } else {
                // If status line exists but doesn't say completed or skipped, assume not completed
                currentStatus = 'not completed';
              }
              
              // If we found a not completed status, count it
              if (currentStatus === 'not completed') {
                activeCount++;
                currentStatus = null; // Reset for next todo
              }
            }
            
            // Also check for visual indicators (✗ for not completed)
            if (line.includes('✗') && !line.includes('✓') && !line.includes('⁉')) {
              // Found not completed indicator, check if we haven't already counted this todo
              // Look backwards for status
              let foundStatus = false;
              for (let j = Math.max(0, i - 5); j < i; j++) {
                if (lines[j].toLowerCase().includes('status:')) {
                  foundStatus = true;
                  break;
                }
              }
              if (!foundStatus) {
                activeCount++;
              }
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
   * Get all todos (including completed and skipped) as text
   */
  async getAllTodosList(): Promise<string> {
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
        `Failed to get all todos list: ${error}\n`,
        { type: 'warning' },
      );
      return `Error retrieving todos: ${error}`;
    }
  }

  /**
   * Check if any todos exist (including completed/skipped)
   */
  async hasTodos(): Promise<boolean> {
    if (!this.todoServerConnection) {
      return false;
    }

    try {
      const todosList = await this.getAllTodosList();
      // Check if the response indicates no todos
      if (todosList === 'No todos found' || todosList === 'No todo server connection') {
        return false;
      }
      // If we get a list, check if it's empty
      // Try to parse as JSON first
      try {
        const todos = JSON.parse(todosList);
        if (Array.isArray(todos)) {
          return todos.length > 0;
        }
      } catch {
        // Not JSON, check if there are any todo-like lines
        const lines = todosList.split('\n').filter(line => line.trim().length > 0);
        // Filter out empty lines and headers
        const todoLines = lines.filter(line => 
          !line.includes('No todos') && 
          !line.includes('Todo server') &&
          (line.match(/^\d+\./) || line.includes('✓') || line.includes('✗') || line.includes('⁉'))
        );
        return todoLines.length > 0;
      }
      return true;
    } catch (error) {
      this.logger.log(
        `Failed to check if todos exist: ${error}\n`,
        { type: 'warning' },
      );
      return false;
    }
  }

  /**
   * Get count of skipped todos
   */
  async getSkippedTodosCount(): Promise<number> {
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

      const content = result.content[0];
      if (content && content.type === 'text') {
        const todosText = content.text;
        
        // Try to parse as JSON first
        try {
          const todos = JSON.parse(todosText);
          if (Array.isArray(todos)) {
            return todos.filter((todo: any) => todo.skipped).length;
          }
        } catch {
          // If not JSON, parse text format to count skipped todos
          const lines = todosText.split('\n');
          let skippedCount = 0;
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].toLowerCase();
            
            // Check for Status line with skipped
            if (line.includes('status:') && line.includes('skipped')) {
              skippedCount++;
            }
            
            // Also check for visual indicator (⁉ for skipped)
            if (line.includes('⁉') || (line.includes('skipped') && !line.includes('status:'))) {
              skippedCount++;
            }
          }
          
          return skippedCount;
        }
      }

      return 0;
    } catch (error) {
      this.logger.log(
        `Failed to get skipped todos count: ${error}\n`,
        { type: 'warning' },
      );
      return 0;
    }
  }

  /**
   * Get active todo IDs (non-completed, non-skipped)
   */
  async getActiveTodoIds(): Promise<string[]> {
    if (!this.todoServerConnection) {
      return [];
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
        const todosText = content.text;
        
        // Try to parse as JSON first
        try {
          const todos = JSON.parse(todosText);
          if (Array.isArray(todos)) {
            return todos
              .filter((todo: any) => !todo.completed && !todo.skipped)
              .map((todo: any) => todo.id || todo.ID);
          }
        } catch {
          // If not JSON, parse text format to extract IDs
          // Format: ID: uuid-here followed by Status: Not completed/Completed/Skipped
          const ids: string[] = [];
          const lines = todosText.split('\n');
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Look for ID line
            const idMatch = line.match(/ID:\s*([a-f0-9-]+)/i);
            if (idMatch) {
              const id = idMatch[1];
              
              // Check the next few lines for status
              let isNotCompleted = false;
              for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                const statusLine = lines[j].toLowerCase();
                if (statusLine.includes('status:')) {
                  // Check if it's not completed (not completed or skipped)
                  if (statusLine.includes('not completed') || statusLine.includes('not-completed') ||
                      (!statusLine.includes('completed') && !statusLine.includes('skipped'))) {
                    isNotCompleted = true;
                  }
                  break;
                }
              }
              
              // Also check if the section has ✗ (not completed indicator) or no ✓ (completed indicator)
              const sectionStart = Math.max(0, i - 3);
              const sectionEnd = Math.min(lines.length, i + 10);
              const section = lines.slice(sectionStart, sectionEnd).join('\n');
              
              if (isNotCompleted || (section.includes('✗') && !section.includes('✓'))) {
                if (!ids.includes(id)) {
                  ids.push(id);
                }
              }
            }
          }
          
          return ids;
        }
      }

      return [];
    } catch (error) {
      this.logger.log(
        `Failed to get active todo IDs: ${error}\n`,
        { type: 'warning' },
      );
      return [];
    }
  }

  /**
   * Skip all active todos
   */
  async skipAllActiveTodos(): Promise<number> {
    if (!this.todoServerConnection) {
      return 0;
    }

    try {
      const activeIds = await this.getActiveTodoIds();
      
      if (activeIds.length === 0) {
        return 0;
      }

      // The skip-todo tool expects an array of IDs, so batch them all together
      try {
        const result = await this.todoServerConnection.client.request(
          {
            method: 'tools/call',
            params: {
              name: 'skip-todo',
              arguments: { ids: activeIds },
            },
          },
          CallToolResultSchema,
        );
        
        // Parse the result to get the count of skipped todos
        const content = result.content[0];
        if (content && content.type === 'text') {
          // The server returns a message like "⁉ 5 Todos Skipped:"
          // Try to extract the number, or just return the length of IDs we sent
          const text = content.text;
          const match = text.match(/(\d+)\s+Todos?\s+Skipped/i);
          if (match) {
            return parseInt(match[1], 10);
          }
          // If we can't parse, assume all were skipped if no error
          return activeIds.length;
        }
        
        return activeIds.length;
      } catch (error) {
        this.logger.log(
          `Failed to skip todos: ${error}\n`,
          { type: 'warning' },
        );
        return 0;
      }
    } catch (error) {
      this.logger.log(
        `Failed to skip active todos: ${error}\n`,
        { type: 'warning' },
      );
      return 0;
    }
  }

  /**
   * Get server name
   */
  getServerName(): string {
    return this.serverName;
  }
}

