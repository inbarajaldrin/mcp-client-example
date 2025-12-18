import {
  StdioClientTransport,
  StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
  ListPromptsResultSchema,
  GetPromptResultSchema,
  type Prompt,
  type GetPromptResult,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import chalk from 'chalk';
import { consoleStyles, Logger, LoggerOptions } from './logger.js';
import { TodoManager } from './todo.js';
import { ToolManager } from './tool-manager.js';
import { PromptManager } from './prompt-manager.js';
import { ChatHistoryManager } from './chat-history-manager.js';
import { AttachmentManager } from './attachment-manager.js';
import type {
  ModelProvider,
  TokenCounter,
  Tool,
  Message,
  SummarizationConfig,
  MessageStreamEvent,
} from './model-provider.js';
import { AnthropicProvider, type ToolExecutor } from './providers/anthropic.js';

type MCPClientOptions = StdioServerParameters & {
  loggerOptions?: LoggerOptions;
  summarizationConfig?: Partial<SummarizationConfig>;
  model?: string;
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
  prompts: Prompt[];
};

export class MCPClient {
  private modelProvider: ModelProvider;
  private messages: Message[] = [];
  private servers: Map<string, ServerConnection> = new Map();
  private tools: Tool[] = [];
  private logger: Logger;
  private serverConfigs: MultiServerConfig[];
  private tokenCounter: TokenCounter | null = null;
  private currentTokenCount: number = 0;
  private model: string;
  private todoManager: TodoManager;
  private todoModeInitialized: boolean = false;
  private todoClearUserCallback?: (todosList: string) => Promise<'clear' | 'skip' | 'leave'>;
  private todoCompletionUserCallback?: (todosList: string) => Promise<'clear' | 'leave'>;
  private todosLeftAsIs: boolean = false; // Track if todos were left as-is (not skipped)
  private todosWereSkipped: boolean = false; // Track if todos were skipped
  private toolManager: ToolManager;
  private promptManager: PromptManager;
  private chatHistoryManager: ChatHistoryManager;
  private attachmentManager: AttachmentManager;

  constructor(
    serverConfigs: StdioServerParameters | StdioServerParameters[],
    options?: { 
      loggerOptions?: LoggerOptions; 
      summarizationConfig?: Partial<SummarizationConfig>; 
      model?: string;
      provider?: ModelProvider;
    },
  ) {
    // Use provided provider or default to Anthropic
    this.modelProvider = options?.provider || new AnthropicProvider();

    // Support both single server (backward compatibility) and multiple servers
    const configs = Array.isArray(serverConfigs) ? serverConfigs : [serverConfigs];
    this.serverConfigs = configs.map((config, index) => ({
      name: `server-${index}`,
      config,
    }));

    this.logger = new Logger(options?.loggerOptions ?? { mode: 'verbose' });
    
    // Initialize model - require explicit model specification
    if (!options?.model) {
      try {
        this.model = this.modelProvider.getDefaultModel();
      } catch (error) {
        throw new Error(
          'Model must be specified. Please provide a model using --model=<model-id> or --select-model.'
        );
      }
    } else {
      this.model = options.model;
    }
    
    // Token counter will be initialized asynchronously in start() method
    // We can't initialize it here because createTokenCounter is now async
    // and we need to fetch context window from API
    this.tokenCounter = null as any; // Will be set in start()
    
    // Initialize todo manager
    this.todoManager = new TodoManager(this.logger);
    
    // Initialize tool manager
    this.toolManager = new ToolManager(this.logger);
    
    // Initialize prompt manager
    this.promptManager = new PromptManager(this.logger);
    
    // Initialize chat history manager
    this.chatHistoryManager = new ChatHistoryManager(this.logger);
    
    // Initialize attachment manager
    this.attachmentManager = new AttachmentManager(this.logger);
  }

  // Constructor for multiple named servers
  static createMultiServer(
    servers: Array<{ name: string; config: StdioServerParameters }>,
    options?: { 
      loggerOptions?: LoggerOptions; 
      summarizationConfig?: Partial<SummarizationConfig>; 
      model?: string;
      provider?: ModelProvider;
    },
  ): MCPClient {
    const client = Object.create(MCPClient.prototype);
    // Use provided provider or default to Anthropic
    client.modelProvider = options?.provider || new AnthropicProvider();
    client.messages = [];
    client.servers = new Map();
    client.tools = [];
    client.logger = new Logger(options?.loggerOptions ?? { mode: 'verbose' });
    client.serverConfigs = servers;
    if (!options?.model) {
      try {
        client.model = client.modelProvider.getDefaultModel();
      } catch (error) {
        throw new Error(
          'Model must be specified. Please provide a model using --model=<model-id> or --select-model.'
        );
      }
    } else {
      client.model = options.model;
    }
    client.currentTokenCount = 0;
    // Token counter will be initialized asynchronously - set to null for now
    client.tokenCounter = null as any;
    client.todoManager = new TodoManager(client.logger);
    client.toolManager = new ToolManager(client.logger);
    client.promptManager = new PromptManager(client.logger);
    client.chatHistoryManager = new ChatHistoryManager(client.logger);
    client.attachmentManager = new AttachmentManager(client.logger);
    return client;
  }

  async start() {
    // Initialize token counter from provider (async, fetches context window from API)
    if (!this.tokenCounter) {
      this.tokenCounter = await this.modelProvider.createTokenCounter(this.model, undefined);
    }
    
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
          prompts: [],
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
    
    // Initialize prompts from all successfully connected servers
    await this.initMCPPrompts();
    
    // Start chat session after servers are connected
    const serverNames = Array.from(this.servers.keys());
    this.chatHistoryManager.startSession(this.model, serverNames);
    
    this.logger.log(
      `Connected to ${this.servers.size} server(s): ${Array.from(this.servers.keys()).join(', ')}\n`,
      { type: 'info' },
    );
    
    this.logger.log(
      `Chat session started: ${this.chatHistoryManager.getCurrentSessionId()}\n`,
      { type: 'info' },
    );
    
    this.logger.log(
      `Using model: ${this.model}\n`,
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

        let serverTools = toolsResults.tools.map(
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

        // Filter todo server tools if todo mode is enabled
        if (serverName === this.todoManager.getServerName() && this.todoManager.isEnabled()) {
          serverTools = this.todoManager.filterTools(serverTools);
        }

        connection.tools = serverTools;
        allTools.push(...serverTools);
      } catch (error) {
        this.logger.log(
          `Failed to load tools from server "${serverName}": ${error}\n`,
          { type: 'warning' },
        );
      }
    }

    // Update state for new tools (set them to enabled by default)
    this.toolManager.updateStateForNewTools(allTools);

    // Filter tools based on enabled state
    const enabledTools = this.toolManager.filterTools(allTools);

    this.tools = enabledTools;
    
    // If todo mode is enabled, only show todo tools in the log message
    if (this.todoManager.isEnabled()) {
      const todoServerName = this.todoManager.getServerName();
      const todoTools = enabledTools.filter(tool => tool.name.startsWith(`${todoServerName}__`));
      this.logger.log(
        `Loaded ${todoTools.length} todo tool(s) (todo mode active)\n`,
        { type: 'info' },
      );
    } else {
      this.logger.log(
        `Loaded ${enabledTools.length} enabled tool(s) from ${allTools.length} total tool(s) across ${this.servers.size} server(s)\n`,
        { type: 'info' },
      );
    }
  }

  private async initMCPPrompts() {
    let totalPrompts = 0;
    const allPrompts: Array<{ server: string; prompt: Prompt }> = [];

    // Load prompts from each server
    for (const [serverName, connection] of this.servers.entries()) {
      try {
        const promptsResults = await connection.client.request(
          { method: 'prompts/list' },
          ListPromptsResultSchema,
        );

        connection.prompts = promptsResults.prompts || [];
        totalPrompts += connection.prompts.length;
        
        // Collect prompts for state management
        for (const prompt of connection.prompts) {
          allPrompts.push({ server: serverName, prompt });
        }
      } catch (error) {
        // Some servers may not support prompts, so we handle errors gracefully
        connection.prompts = [];
        // Only log if it's not a method not found error
        if (!(error instanceof Error && error.message.includes('not found'))) {
          this.logger.log(
            `Failed to load prompts from server "${serverName}": ${error}\n`,
            { type: 'warning' },
          );
        }
      }
    }

    // Update state for new prompts (set them to enabled by default)
    if (allPrompts.length > 0) {
      this.promptManager.updateStateForNewPrompts(allPrompts);
    }

    if (totalPrompts > 0) {
      this.logger.log(
        `Loaded ${totalPrompts} prompt(s) across ${this.servers.size} server(s)\n`,
        { type: 'info' },
      );
    }
  }

  private formatToolCall(toolName: string, args: any): string {
    // Custom formatter that handles multiline strings nicely
    const formatValue = (value: any, indent: string = ''): string => {
      if (typeof value === 'string' && value.includes('\n')) {
        // Multiline string - display with actual newlines
        const lines = value.split('\n');
        const isCode = lines.some(line => 
          line.trim().match(/^(import|from|def|class|if|for|while|#|print|return|const|let|var|function)/)
        );
        if (isCode) {
          // Format as code block
          return '```\n' + value + '\n```';
        }
        // Format with triple quotes
        return '"""\n' + value + '\n"""';
      }
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const items = value.map((item, i) => 
          indent + '  ' + formatValue(item, indent + '  ') + (i < value.length - 1 ? ',' : '')
        );
        return '[\n' + items.join('\n') + '\n' + indent + ']';
      }
      if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length === 0) return '{}';
        const formatted = entries.map(([key, val], i) => {
          const formattedVal = formatValue(val, indent + '  ');
          return indent + '  ' + JSON.stringify(key) + ': ' + formattedVal + (i < entries.length - 1 ? ',' : '');
        });
        return '{\n' + formatted.join('\n') + '\n' + indent + '}';
      }
      return JSON.stringify(value);
    };

    const formattedArgs = formatValue(args);

    // If formatted args starts with '{', put the bracket on a new line
    let argsDisplay = formattedArgs;
    if (formattedArgs.startsWith('{')) {
      argsDisplay = '\n' + formattedArgs;
    }

    return (
      '\n' +
      consoleStyles.tool.bracket('[') +
      consoleStyles.tool.name(toolName) +
      consoleStyles.tool.bracket(']') +
      consoleStyles.tool.args(argsDisplay) +
      '\n'
    );
  }

  private formatJSON(json: string): string {
    return json
      .replace(/"([^"]+)":/g, chalk.blue('"$1":'))
      .replace(/: "([^"]+)"/g, ': ' + chalk.green('"$1"'));
  }

  /**
   * Execute a tool via MCP servers
   * This is the callback that the provider calls when Anthropic wants to use a tool
   * 
   * Extracts server name, routes to correct MCP server, and returns result
   */
  private async executeMCPTool(
    toolName: string,
    toolInput: Record<string, any>,
  ): Promise<string> {
    // Extract server name and actual tool name from prefixed name
    // Format: "server-name__tool-name"
    const [serverName, actualToolName] = toolName.includes('__')
      ? toolName.split('__', 2)
      : [null, toolName];

    // Log the tool call BEFORE execution
    this.logger.log(
      this.formatToolCall(toolName, toolInput) + '\n',
    );

    let toolResult;

    try {
      if (serverName && this.servers.has(serverName)) {
        // Route to the specific server
        const connection = this.servers.get(serverName)!;
        toolResult = await connection.client.request(
          {
            method: 'tools/call',
            params: {
              name: actualToolName,
              arguments: toolInput,
            },
          },
          CallToolResultSchema,
        );
      } else {
        // Fallback: try to find the tool in any server (backward compatibility)
        let found = false;
        for (const [name, connection] of this.servers.entries()) {
          const tool = connection.tools.find(
            (t) =>
              t.name === toolName || t.name.endsWith(`__${toolName}`),
          );
          if (tool) {
            const actualName = tool.name.includes('__')
              ? tool.name.split('__')[1]
              : tool.name;
            toolResult = await connection.client.request(
              {
                method: 'tools/call',
                params: {
                  name: actualName,
                  arguments: toolInput,
                },
              },
              CallToolResultSchema,
            );
            found = true;
            break;
          }
        }
        if (!found || !toolResult) {
          throw new Error(
            `Tool "${toolName}" not found in any server`,
          );
        }
      }

      // Format and return result
      const formattedResult = this.formatJSON(
        JSON.stringify(toolResult.content.flatMap((c) => c.text)),
      );

      return formattedResult;
    } catch (toolError) {
      const errorMessage = `Error executing tool "${toolName}": ${
        toolError instanceof Error ? toolError.message : String(toolError)
      }`;

      this.logger.log(`\n⚠️ ${errorMessage}\n`, {
        type: 'error',
      });

      throw new Error(errorMessage);
    }
  }

  private async ensureTokenCounter(): Promise<void> {
    if (!this.tokenCounter) {
      this.tokenCounter = await this.modelProvider.createTokenCounter(this.model, undefined);
    }
  }

  private shouldSummarize(): boolean {
    if (!this.tokenCounter) {
      throw new Error('Token counter not initialized. Please call start() first.');
    }
    return this.tokenCounter.shouldSummarize(this.currentTokenCount);
  }

  // Public method to get token usage status (for testing/debugging)
  getTokenUsage() {
    if (!this.tokenCounter) {
      throw new Error('Token counter not initialized. Please call start() first.');
    }
    return this.tokenCounter.getUsage(this.currentTokenCount);
  }

  // Public method to manually trigger summarization (for testing)
  async manualSummarize(): Promise<void> {
    await this.ensureTokenCounter();
    await this.autoSummarize();
  }

  // Public method to set test mode (lower threshold for easier testing)
  async setTestMode(enabled: boolean = true, testThreshold: number = 5) {
    await this.ensureTokenCounter();
    if (enabled) {
      this.tokenCounter!.updateConfig({
        threshold: testThreshold, // Very low threshold for testing
        enabled: true,
      });
      this.logger.log(
        `\nTest mode enabled: Summarization will trigger at ${testThreshold}% (${Math.round(this.tokenCounter!.getContextWindow() * testThreshold / 100)} tokens)\n`,
        { type: 'info' },
      );
    } else {
      this.tokenCounter!.updateConfig({
        threshold: 80, // Back to normal
      });
      this.logger.log('\nTest mode disabled: Summarization threshold reset to 80%\n', {
        type: 'info',
      });
    }
  }

  /**
   * Enable todo mode - connect to todo server and filter tools
   * @param askUserCallback Optional callback to ask user what to do with incomplete todos
   * @param completionCallback Optional callback to ask user what to do when all todos are completed
   */
  async enableTodoMode(
    askUserCallback?: (todosList: string) => Promise<'clear' | 'skip' | 'leave'>,
    completionCallback?: (todosList: string) => Promise<'clear' | 'leave'>
  ): Promise<void> {
    if (!this.todoManager.isConfigured()) {
      throw new Error('Todo server not configured. Please add "todo" server to mcp_config.json');
    }

    try {
      const todoServerName = this.todoManager.getServerName();
      
      // Check if todo server is already connected (from initial start)
      if (this.servers.has(todoServerName)) {
        // Use existing connection
        const existingConnection = this.servers.get(todoServerName)!;
        this.todoManager.setConnection(existingConnection);
        this.todoManager.enable();
      } else {
        // Connect to todo server
        const connection = await this.todoManager.connect();
        this.todoManager.enable();
        
        // Add todo server to servers map
        this.servers.set(todoServerName, connection);
      }
      
      // Reload tools to apply filtering
      await this.initMCPTools();
      
      // Store the callbacks for use in processQuery
      this.todoClearUserCallback = askUserCallback;
      this.todoCompletionUserCallback = completionCallback;
      
      // Check if todos exist and handle clearing
      const result = await this.clearTodosIfNeeded(askUserCallback);
      
      // Track if todos were left as-is (not skipped or cleared)
      this.todosLeftAsIs = (result === 'left');
      // Track if todos were skipped
      this.todosWereSkipped = (result === 'skipped');
      
      // Reset initialization flag - will be set after system prompt is sent with first user message
      this.todoModeInitialized = false;
      
      this.logger.log('\n✓ Todo mode enabled\n', { type: 'info' });
    } catch (error) {
      this.logger.log(
        `Failed to enable todo mode: ${error}\n`,
        { type: 'error' },
      );
      throw error;
    }
  }

  /**
   * Disable todo mode - disconnect from todo server
   */
  async disableTodoMode(): Promise<void> {
    this.todoManager.disable();
    this.todoModeInitialized = false;
    this.todoClearUserCallback = undefined;
    this.todoCompletionUserCallback = undefined;
    this.todosLeftAsIs = false;
    this.todosWereSkipped = false;
    
    // Note: We don't disconnect the server or remove it from servers map
    // because it might be needed by other parts of the system
    // We just disable todo mode filtering and exit prevention
    
    // Reload tools to remove filtering
    await this.initMCPTools();
    
    this.logger.log('\n✓ Todo mode disabled\n', { type: 'info' });
  }

  /**
   * Check todo status - returns active todos count and list
   */
  async checkTodoStatus(): Promise<{ activeCount: number; todosList: string }> {
    if (!this.todoManager.isEnabled()) {
      return { activeCount: 0, todosList: '' };
    }

    const activeCount = await this.todoManager.getActiveTodosCount();
    const todosList = await this.todoManager.getActiveTodosList();
    
    return { activeCount, todosList };
  }

  /**
   * Get skipped todos count
   */
  async getSkippedTodosCount(): Promise<number> {
    if (!this.todoManager.isEnabled()) {
      return 0;
    }
    return await this.todoManager.getSkippedTodosCount();
  }

  /**
   * Check if todo mode is enabled
   */
  isTodoModeEnabled(): boolean {
    return this.todoManager.isEnabled();
  }

  /**
   * Check if todo server is configured
   */
  isTodoServerConfigured(): boolean {
    return this.todoManager.isConfigured();
  }

  /**
   * Get the tool manager instance
   */
  getToolManager(): ToolManager {
    return this.toolManager;
  }

  /**
   * Get the prompt manager instance
   */
  getPromptManager(): PromptManager {
    return this.promptManager;
  }

  getChatHistoryManager(): ChatHistoryManager {
    return this.chatHistoryManager;
  }

  /**
   * List all available prompts from all servers or a specific server
   */
  listPrompts(serverName?: string): Array<{ server: string; prompt: Prompt }> {
    const allPrompts: Array<{ server: string; prompt: Prompt }> = [];

    if (serverName) {
      const connection = this.servers.get(serverName);
      if (connection) {
        for (const prompt of connection.prompts) {
          allPrompts.push({ server: serverName, prompt });
        }
      }
    } else {
      for (const [name, connection] of this.servers.entries()) {
        for (const prompt of connection.prompts) {
          allPrompts.push({ server: name, prompt });
        }
      }
    }

    return allPrompts;
  }

  /**
   * Get a prompt from a server and return its messages
   */
  async getPrompt(
    serverName: string,
    promptName: string,
    promptArguments?: Record<string, string>,
  ): Promise<GetPromptResult> {
    const connection = this.servers.get(serverName);
    if (!connection) {
      throw new Error(`Server "${serverName}" not found`);
    }

    try {
      const result = await connection.client.request(
        {
          method: 'prompts/get',
          params: {
            name: promptName,
            arguments: promptArguments || {},
          },
        },
        GetPromptResultSchema,
      );

      return result;
    } catch (error) {
      throw new Error(
        `Failed to get prompt "${promptName}" from server "${serverName}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Enable all tools from all servers
   */
  async enableAllTools(): Promise<void> {
    // Collect all tools from all servers (re-query to get complete list)
    const allTools: Tool[] = [];
    for (const [serverName, connection] of this.servers.entries()) {
      try {
        const toolsResults = await connection.client.request(
          { method: 'tools/list' },
          ListToolsResultSchema,
        );
        
        const serverTools = toolsResults.tools.map(
          ({ inputSchema, name, description }) => {
            const prefixedName = `${serverName}__${name}`;
            return {
              name: prefixedName,
              description: `[${serverName}] ${description}`,
              input_schema: inputSchema,
            };
          },
        );
        
        allTools.push(...serverTools);
      } catch (error) {
        // Ignore errors for individual servers
      }
    }
    
    this.toolManager.enableAllTools(allTools);
    
    // Reload tools to apply changes
    await this.initMCPTools();
    
    this.logger.log('\n✓ All tools enabled\n', { type: 'info' });
  }

  /**
   * Disable all tools from all servers
   */
  async disableAllTools(): Promise<void> {
    // Collect all tools from all servers (re-query to get complete list)
    const allTools: Tool[] = [];
    for (const [serverName, connection] of this.servers.entries()) {
      try {
        const toolsResults = await connection.client.request(
          { method: 'tools/list' },
          ListToolsResultSchema,
        );
        
        const serverTools = toolsResults.tools.map(
          ({ inputSchema, name, description }) => {
            const prefixedName = `${serverName}__${name}`;
            return {
              name: prefixedName,
              description: `[${serverName}] ${description}`,
              input_schema: inputSchema,
            };
          },
        );
        
        allTools.push(...serverTools);
      } catch (error) {
        // Ignore errors for individual servers
      }
    }
    
    this.toolManager.disableAllTools(allTools);
    
    // Reload tools to apply changes
    await this.initMCPTools();
    
    this.logger.log('\n✓ All tools disabled\n', { type: 'info' });
  }

  /**
   * Enable all tools from a specific server
   */
  async enableServerTools(serverName: string): Promise<void> {
    if (!this.servers.has(serverName)) {
      throw new Error(`Server "${serverName}" not found`);
    }
    
    const connection = this.servers.get(serverName)!;
    this.toolManager.enableServerTools(serverName, connection.tools);
    
    // Reload tools to apply changes
    await this.initMCPTools();
    
    this.logger.log(`\n✓ All tools from server "${serverName}" enabled\n`, { type: 'info' });
  }

  /**
   * Disable all tools from a specific server
   */
  async disableServerTools(serverName: string): Promise<void> {
    if (!this.servers.has(serverName)) {
      throw new Error(`Server "${serverName}" not found`);
    }
    
    const connection = this.servers.get(serverName)!;
    this.toolManager.disableServerTools(serverName, connection.tools);
    
    // Reload tools to apply changes
    await this.initMCPTools();
    
    this.logger.log(`\n✓ All tools from server "${serverName}" disabled\n`, { type: 'info' });
  }

  /**
   * Mark todo mode as initialized (called after system prompt is sent)
   */
  setTodoModeInitialized(initialized: boolean = true): void {
    this.todoModeInitialized = initialized;
  }

  /**
   * Check if system prompt needs to be logged and log it if needed
   * Returns the system prompt text if it was logged, null otherwise
   * This should be called BEFORE logging the user message to ensure correct chronological order
   */
  async prepareAndLogSystemPrompt(): Promise<string | null> {
    // Check if this is the first message after enabling todo mode
    const isFirstTodoMessage = this.todoManager.isEnabled() && !this.todoModeInitialized;

    if (!isFirstTodoMessage) {
      return null;
    }

    let systemPrompt = 'You are now in todo mode. When the user provides a task, you must: 1) Decompose the task into actionable todos using create-todo, 2) As you complete each task, mark it complete using complete-todo. You cannot exit until all todos are completed or skipped using skip-todo.';
    
    // If todos were left as-is, include the current todo list in context
    if (this.todosLeftAsIs) {
      const todoStatus = await this.checkTodoStatus();
      const skippedCount = await this.getSkippedTodosCount();
      const todosList = await this.todoManager.getAllTodosList();
      
      if (todoStatus.activeCount > 0 || skippedCount > 0) {
        let message = '';
        if (todoStatus.activeCount > 0 && skippedCount > 0) {
          message = `There are ${todoStatus.activeCount} existing incomplete todo(s) and ${skippedCount} skipped todo(s) in the todo list. You must resume and complete the incomplete tasks before starting any new tasks.`;
        } else if (todoStatus.activeCount > 0) {
          message = `There are ${todoStatus.activeCount} existing incomplete todo(s) in the todo list. You must resume and complete these existing tasks before starting any new tasks.`;
        } else if (skippedCount > 0) {
          message = `There are ${skippedCount} skipped todo(s) in the todo list.`;
        }
        
        systemPrompt += `\n\nIMPORTANT: ${message} Here is the current todo list:\n\n${todosList}\n\nContinue working on these todos or create new ones as needed.`;
      }
    }
    
    // Log the system prompt to chat history (as client message) BEFORE user message
    this.chatHistoryManager.addClientMessage(systemPrompt);
    
    // Mark as initialized
    this.todoModeInitialized = true;
    this.todosLeftAsIs = false; // Reset after first message
    this.todosWereSkipped = false; // Reset after first message
    
    return systemPrompt;
  }

  /**
   * Clear all todos (client-side call)
   */
  /**
   * Check todo status and determine if clearing is needed
   * Returns: { shouldClear: boolean, needsUserConfirmation: boolean, todosList: string }
   */
  async checkTodoClearStatus(): Promise<{ shouldClear: boolean; needsUserConfirmation: boolean; todosList: string }> {
    if (!this.todoManager.isEnabled() || !this.todoManager.getConnection()) {
      return { shouldClear: false, needsUserConfirmation: false, todosList: '' };
    }

    try {
      // Check if any todos exist
      const hasTodos = await this.todoManager.hasTodos();
      if (!hasTodos) {
        return { shouldClear: false, needsUserConfirmation: false, todosList: '' };
      }

      // Get all todos list
      const todosList = await this.todoManager.getAllTodosList();
      
      // Check if there are any active (incomplete) todos
      const activeCount = await this.todoManager.getActiveTodosCount();
      
      // Check if there are any skipped todos
      const skippedCount = await this.todoManager.getSkippedTodosCount();
      
      if (activeCount === 0 && skippedCount === 0) {
        // No active todos and no skipped todos (all are completed), safe to clear automatically
        return { shouldClear: true, needsUserConfirmation: false, todosList };
      } else if (activeCount === 0 && skippedCount > 0) {
        // No active todos but there are skipped todos, need user confirmation
        return { shouldClear: false, needsUserConfirmation: true, todosList };
      } else {
        // There are active/incomplete todos, need user confirmation
        return { shouldClear: false, needsUserConfirmation: true, todosList };
      }
    } catch (error) {
      this.logger.log(
        `Failed to check todo status: ${error}\n`,
        { type: 'warning' },
      );
      return { shouldClear: false, needsUserConfirmation: false, todosList: '' };
    }
  }

  /**
   * Clear todos with user confirmation if needed
   * Returns: 'cleared' | 'skipped' | 'left'
   */
  async clearTodosIfNeeded(askUserCallback?: (todosList: string) => Promise<'clear' | 'skip' | 'leave'>): Promise<'cleared' | 'skipped' | 'left'> {
    const status = await this.checkTodoClearStatus();
    
    if (!status.shouldClear && !status.needsUserConfirmation) {
      // No todos or already handled
      return 'left';
    }

    if (status.shouldClear) {
      // All completed, clear automatically (don't log)
      await this.clearAllTodos(false);
      return 'cleared';
    }

    if (status.needsUserConfirmation && askUserCallback) {
      // Ask user what to do
      const userChoice = await askUserCallback(status.todosList);
      if (userChoice === 'clear') {
        // User explicitly chose to clear, so log it
        await this.clearAllTodos(true);
        return 'cleared';
      } else if (userChoice === 'skip') {
        // Automatically skip all incomplete todos
        const skippedCount = await this.todoManager.skipAllActiveTodos();
        if (skippedCount > 0) {
          this.logger.log(`\n✓ Skipped ${skippedCount} incomplete todo(s)\n`, { type: 'info' });
        }
        return 'skipped';
      } else {
        // Leave todos as is
        return 'left';
      }
    }

    return 'left';
  }

  private async clearAllTodos(shouldLog: boolean = true): Promise<void> {
    if (!this.todoManager.isEnabled() || !this.todoManager.getConnection()) {
      return;
    }

    try {
      const connection = this.todoManager.getConnection()!;
      await connection.client.request(
        {
          method: 'tools/call',
          params: {
            name: 'clear-todo-list',
            arguments: {},
          },
        },
        CallToolResultSchema,
      );
      if (shouldLog) {
        this.logger.log('\n✓ Cleared existing todos\n', { type: 'info' });
      }
    } catch (error) {
      this.logger.log(
        `Failed to clear todos: ${error}\n`,
        { type: 'warning' },
      );
      // Continue anyway - don't block the query
    }
  }

  private async autoSummarize(): Promise<void> {
    await this.ensureTokenCounter();
    if (!this.tokenCounter!.getConfig().enabled) {
      return;
    }

    const config = this.tokenCounter!.getConfig();
    const recentCount = config.recentMessagesToKeep;

    // Need at least recentCount + 1 messages to summarize
    if (this.messages.length <= recentCount) {
      return;
    }

      this.logger.log(
        `\n⚠️ Context window approaching limit (${this.tokenCounter!.getUsage(this.currentTokenCount).percentage}% used). Summarizing conversation...\n`,
        { type: 'warning' },
      );

    try {
      // Keep recent messages
      const recentMessages = this.messages.slice(-recentCount);
      const oldMessages = this.messages.slice(0, -recentCount);

      // Create summarization prompt
      const messagesToSummarize = oldMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // Call API to summarize (using AnthropicProvider's createMessage for non-streaming)
      const summaryMessages: Message[] = [
        ...messagesToSummarize,
        {
          role: 'user',
          content:
            'Summarize the above conversation concisely, preserving key decisions, context, important information, and any tool usage patterns. Focus on what was accomplished and what context is needed to continue the conversation.',
        },
      ];
      
      // Use provider's createMessage if available, otherwise use stream
      let summaryText: string;
      if ((this.modelProvider as any).createMessage) {
        const summaryResponse = await (this.modelProvider as any).createMessage(
          summaryMessages,
          this.model,
          2000,
        );
        summaryText =
          summaryResponse.content[0]?.type === 'text'
            ? summaryResponse.content[0].text
            : JSON.stringify(summaryResponse.content);
      } else {
        // Fallback: use streaming and collect text
        let collectedText = '';
        const summaryStream = this.modelProvider.createMessageStream(
          summaryMessages,
          this.model,
          [],
          2000,
        );
        for await (const chunk of summaryStream) {
          if (chunk.type === 'content_block_delta' && (chunk as any).delta?.type === 'text_delta') {
            collectedText += (chunk as any).delta.text;
          }
        }
        summaryText = collectedText || 'Summary unavailable';
      }

      // Recalculate token count
      // Remove old messages from count
      let oldTokenCount = 0;
      for (const msg of oldMessages) {
        oldTokenCount += this.tokenCounter!.countMessageTokens(msg);
      }

      // Count summary message
      const summaryMessage: Message = {
        role: 'user',
        content: `[Previous conversation summary: ${summaryText}]`,
      };
      const summaryTokenCount =
        this.tokenCounter!.countMessageTokens(summaryMessage);

      // Update messages and token count
      this.messages = [summaryMessage, ...recentMessages];
      this.currentTokenCount =
        this.currentTokenCount - oldTokenCount + summaryTokenCount;

      this.logger.log(
        `✓ Conversation summarized. Context reduced from ${oldMessages.length} to 1 summary message. Token usage: ${this.tokenCounter!.getUsage(this.currentTokenCount).percentage}%\n`,
        { type: 'info' },
      );
    } catch (error) {
      this.logger.log(
        `Failed to summarize conversation: ${error}\n`,
        { type: 'error' },
      );
      // Continue without summarization - let API handle the limit
    }
  }

  /**
   * Simplified stream processor for tool use loop
   * Handles text output and final message collection
   * 
   * The provider handles:
   * - Tool detection (stop_reason === 'tool_use')
   * - Tool execution (via our callback)
   * - Tool result feedback
   * - Looping
   * 
   * We just need to display text and collect assistant messages
   * Supports both Anthropic (complete response objects) and OpenAI (streaming events)
   */
  private async processToolUseStream(
    stream: AsyncIterable<any>,
    cancellationCheck?: () => boolean,
    initialTokenCount?: number,
  ): Promise<{
    pendingToolResults: Array<{ toolUseId?: string; toolCallId?: string; content: string }>;
    lastTokenUsage: {
      inputTokens: number;
      outputTokens: number;
      regularInputTokens?: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    } | null;
  }> {
    this.logger.log(consoleStyles.assistant);

    let currentMessage = '';
    let messageStarted = false;
    let hasOutputContent = false; // Track if we've output any content after "Assistant:"

    // Track tool results to add to messages
    const pendingToolResults: Array<{
      toolUseId?: string;
      toolCallId?: string;
      content: string;
    }> = [];
    const isAnthropic = this.modelProvider.getProviderName() === 'anthropic';

    // Track token usage per callback
    let tokenCountBeforeCallback = initialTokenCount !== undefined ? initialTokenCount : this.currentTokenCount;
    let lastTokenUsage: {
      inputTokens: number;
      outputTokens: number;
      regularInputTokens?: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    } | null = null;
    
    for await (const chunk of stream) {
      // Don't break immediately - let current chunk finish processing
      // Cancellation will be checked in provider loops to stop further iterations
      
      // Handle max_iterations_reached event (from provider)
      if (chunk.type === 'max_iterations_reached') {
        this.logger.log(
          `\n⚠️  Maximum iterations reached (${chunk.iterations}/${chunk.maxIterations}). Stopping agent loop.\n`,
          { type: 'warning' },
        );
        continue;
      }
      
      // Handle tool_use_complete events (from provider)
      if (chunk.type === 'tool_use_complete') {
        // Tool was executed - provider already handled it
        // Always ensure tool execution log starts on a new line
        // This prevents server logs or previous content from appearing on the same line
        if (!hasOutputContent || !currentMessage.endsWith('\n')) {
          this.logger.log('\n');
        }
        // Log the tool execution and its result (always on its own line)
        this.logger.log(
          `[Tool executed: ${chunk.toolName}]\n`,
          { type: 'info' },
        );
        hasOutputContent = true;
        
        // Track tool result to add to messages
        // Tool results will be added when we see the next assistant message or end_turn
        if (isAnthropic && chunk.toolUseId) {
          pendingToolResults.push({
            toolUseId: chunk.toolUseId,
            content: chunk.result || '',
          });
        } else if (!isAnthropic && chunk.toolCallId) {
          pendingToolResults.push({
            toolCallId: chunk.toolCallId,
            content: chunk.result || '',
          });
        }
        // Pretty-print JSON if applicable
        if (chunk.result) {
          try {
            // Strip ANSI color codes before parsing (from formatJSON)
            const cleanResult = chunk.result.replace(/\u001b\[[0-9;]*m/g, '');
            let parsed = JSON.parse(cleanResult);
            // Handle double-encoded JSON (array with single JSON string element)
            if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string') {
              try {
                parsed = JSON.parse(parsed[0]);
                // If inner string was valid JSON, format it normally
                const formatted = JSON.stringify(parsed, null, 2);
                const colored = this.formatJSON(formatted);
                const truncated = colored.length > 10000 
                  ? colored.substring(0, 10000) + '\n     ...(truncated)'
                  : colored;
                // JSON.stringify already handles indentation, just display as-is
                this.logger.log(truncated + '\n', { type: 'success' });
              } catch {
                // Inner string is not JSON - display it directly to preserve newlines
                const stringValue = parsed[0];
                const truncated = stringValue.length > 10000 
                  ? stringValue.substring(0, 10000) + '\n     ...(truncated)'
                  : stringValue;
                // Indent the content
                const indented = truncated.split('\n').map((line: string) => '  ' + line).join('\n');
                this.logger.log(indented + '\n', { type: 'success' });
              }
            } else {
              // Not an array with single string - format normally
              const formatted = JSON.stringify(parsed, null, 2);
              // Apply color formatting and truncate if needed (increased limit to 10000)
              const colored = this.formatJSON(formatted);
              const truncated = colored.length > 10000 
                ? colored.substring(0, 10000) + '\n     ...(truncated)'
                : colored;
              // JSON.stringify already handles indentation, just display as-is
              this.logger.log(truncated + '\n', { type: 'success' });
            }
          } catch {
            // Non-JSON fallback - indent the content
            const indented = chunk.result.split('\n').map((line: string) => '  ' + line).join('\n');
            this.logger.log(indented + '\n', { type: 'success' });
          }
        }
        // Log tool execution to history
        this.chatHistoryManager.addToolExecution(
          chunk.toolName,
          chunk.toolInput || {},
          chunk.result || '',
        );
        continue;
      }

      // Handle OpenAI streaming events
      if (chunk.type === 'message_start') {
        messageStarted = true;
        currentMessage = '';
        continue;
      }

      if (chunk.type === 'content_block_start') {
        // Content block starting - reset message if it's a new text block
        if (chunk.content_block?.type === 'text') {
          currentMessage = '';
        }
        continue;
      }

      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        // Accumulate text from OpenAI streaming
        // Text will appear on the same line as "Assistant:" if it's the first content
        currentMessage += chunk.delta.text;
        this.logger.log(chunk.delta.text);
        hasOutputContent = true;
        continue;
      }

      // Handle token usage from both OpenAI and Anthropic (exact counts from API)
      if (chunk.type === 'token_usage' && chunk.input_tokens !== undefined) {
        // Store token usage for this callback
        lastTokenUsage = {
          inputTokens: chunk.input_tokens,
          outputTokens: chunk.output_tokens,
        };

        // Extract cache token breakdown if available (from Anthropic)
        if ((chunk as any).input_tokens_breakdown) {
          const breakdown = (chunk as any).input_tokens_breakdown;
          lastTokenUsage.regularInputTokens = breakdown.input_tokens || 0;
          lastTokenUsage.cacheCreationTokens = breakdown.cache_creation_input_tokens || 0;
          lastTokenUsage.cacheReadTokens = breakdown.cache_read_input_tokens || 0;
        }

        // Update cumulative token count by REPLACING (not adding)
        // For Anthropic, input_tokens already includes the full conversation history
        // input_tokens = all messages sent to API, output_tokens = tokens generated in this response
        this.currentTokenCount = chunk.input_tokens + chunk.output_tokens;
        continue;
      }

      if (chunk.type === 'message_stop') {
        // Message complete - add to history if we have content
        // Note: message_stop doesn't always mean we're done - it could be after tool calls
        // The provider will continue the loop if tools were called
        // If no content has been output yet, tools are likely about to be executed
        // Add a newline now to prevent server logs from appearing on the same line as "Assistant:"
        if (!hasOutputContent) {
          this.logger.log('\n');
          hasOutputContent = true;
        }
        
        if (currentMessage.trim()) {
          const assistantMessage: Message = {
            role: 'assistant',
            content: currentMessage,
          };
          this.messages.push(assistantMessage);
          
          // Add any pending tool results (for OpenAI, tools complete after message_stop)
          if (pendingToolResults.length > 0 && !isAnthropic) {
            for (const tr of pendingToolResults) {
              const toolMessage: Message = {
                role: 'tool',
                tool_call_id: tr.toolCallId!,
                content: tr.content,
              };
              this.messages.push(toolMessage);
            }
            pendingToolResults.length = 0;
          }
          
          // Use official token counting for accurate counts
          if (this.modelProvider.getProviderName() === 'anthropic') {
            const provider = this.modelProvider as any;
            const exactCount = await provider.countTokensOfficial(
              this.messages,
              this.model,
              this.tools,
            );
            this.currentTokenCount = exactCount;
          }
          // OpenAI: token counts come from token_usage events (already handled above)
          
          // Log token usage per callback to chat history (not terminal)
          if (this.modelProvider.getProviderName() === 'openai' && lastTokenUsage) {
            // OpenAI: use exact counts from API
            const totalTokens = lastTokenUsage.inputTokens + lastTokenUsage.outputTokens;
            this.chatHistoryManager.addTokenUsagePerCallback(
              lastTokenUsage.inputTokens,
              lastTokenUsage.outputTokens,
              totalTokens,
              lastTokenUsage.regularInputTokens,
              lastTokenUsage.cacheCreationTokens,
              lastTokenUsage.cacheReadTokens
            );
            lastTokenUsage = null; // Reset after logging
            tokenCountBeforeCallback = this.currentTokenCount; // Update for next callback
          } else if (this.modelProvider.getProviderName() === 'anthropic' && lastTokenUsage) {
            // Anthropic: use exact counts from API (provided via token_usage events)
            const totalTokens = lastTokenUsage.inputTokens + lastTokenUsage.outputTokens;
            this.chatHistoryManager.addTokenUsagePerCallback(
              lastTokenUsage.inputTokens,
              lastTokenUsage.outputTokens,
              totalTokens,
              lastTokenUsage.regularInputTokens,
              lastTokenUsage.cacheCreationTokens,
              lastTokenUsage.cacheReadTokens
            );
            lastTokenUsage = null; // Reset after logging
            tokenCountBeforeCallback = this.currentTokenCount; // Update for next callback
          }
          
          // Add newline after assistant message to ensure tool execution logs appear on new line
          if (currentMessage && !currentMessage.endsWith('\n')) {
            this.logger.log('\n');
          }
        }

        // Check if we need to summarize after this response
        if (this.shouldSummarize()) {
          await this.autoSummarize();
        }

        // Reset for next message (if loop continues)
        currentMessage = '';
        messageStarted = false;
        continue;
      }

      // Handle complete response objects from Anthropic API
      // These come from Anthropic's createMessageStreamWithToolUse
      if (chunk.content && Array.isArray(chunk.content)) {
        // Check if response has tool_use blocks (tools are about to be executed)
        const toolUseBlocks = chunk.content.filter((block: any) => block.type === 'tool_use');
        // If tools are about to be executed and no content has been output yet,
        // add a newline to prevent server logs from appearing on the same line as "Assistant:"
        if (toolUseBlocks.length > 0 && !hasOutputContent) {
          this.logger.log('\n');
          hasOutputContent = true;
        }
        
        // Extract and display text content
        const textBlocks = chunk.content.filter((block: any) => block.type === 'text');
        const textContent = textBlocks.length > 0 
          ? textBlocks.map((block: any) => block.text).join('\n')
          : '';
        
        if (textContent) {
          // Text will appear on the same line as "Assistant:" if it's the first content
          this.logger.log(textContent);
          hasOutputContent = true;
          
          // Add newline after text content to ensure tool execution logs appear on new line
          // This prevents server logs from appearing on the same line as assistant text
          if (textContent && !textContent.endsWith('\n')) {
            this.logger.log('\n');
          }
        }
        
        // Add assistant message to messages (with tool_use blocks if present)
        // This ensures tool calls are preserved in conversation context
        const assistantMessage: Message = {
          role: 'assistant',
          content: textContent,
          content_blocks: chunk.content, // Preserve full content including tool_use blocks
        };
        this.messages.push(assistantMessage);
        
        // If we have pending tool results, add them now (after the assistant message with tool_use blocks)
        if (pendingToolResults.length > 0) {
          if (isAnthropic) {
            // Verify that the assistant message has tool_use blocks that match our tool results
            const toolUseBlocks = chunk.content.filter((block: any) => block.type === 'tool_use');
            const toolUseIds = new Set(toolUseBlocks.map((block: any) => block.id));
            
            // Only add tool results that have matching tool_use blocks
            const validToolResults = pendingToolResults.filter(tr => 
              tr.toolUseId && toolUseIds.has(tr.toolUseId)
            );
            
            if (validToolResults.length > 0) {
              // Anthropic: add user message with tool_results
              const toolResultsMessage: Message = {
                role: 'user',
                content: '',
                tool_results: validToolResults.map(tr => ({
                  type: 'tool_result',
                  tool_use_id: tr.toolUseId!,
                  content: tr.content,
                })),
              };
              this.messages.push(toolResultsMessage);
            }
            
            // Remove valid results from pending (keep invalid ones for potential later matching)
            for (const tr of validToolResults) {
              const index = pendingToolResults.findIndex(p => p.toolUseId === tr.toolUseId);
              if (index >= 0) {
                pendingToolResults.splice(index, 1);
              }
            }
          } else {
            // OpenAI: add tool role messages
            for (const tr of pendingToolResults) {
              if (tr.toolCallId) {
                const toolMessage: Message = {
                  role: 'tool',
                  tool_call_id: tr.toolCallId,
                  content: tr.content,
                };
                this.messages.push(toolMessage);
              }
            }
            // Clear pending results after adding them
            pendingToolResults.length = 0;
          }
        }
        
        // Use official token counting for accurate counts
        if (this.modelProvider.getProviderName() === 'anthropic') {
          const provider = this.modelProvider as any;
          const exactCount = await provider.countTokensOfficial(
            this.messages,
            this.model,
            this.tools,
          );
          this.currentTokenCount = exactCount;
        }
        // OpenAI: token counts come from token_usage events (already handled above)

        // Log token usage per callback to chat history (not terminal)
        if (this.modelProvider.getProviderName() === 'openai' && lastTokenUsage) {
          // OpenAI: use exact counts from API
          const totalTokens = lastTokenUsage.inputTokens + lastTokenUsage.outputTokens;
          this.chatHistoryManager.addTokenUsagePerCallback(
            lastTokenUsage.inputTokens,
            lastTokenUsage.outputTokens,
            totalTokens,
            lastTokenUsage.regularInputTokens,
            lastTokenUsage.cacheCreationTokens,
            lastTokenUsage.cacheReadTokens
          );
          lastTokenUsage = null; // Reset after logging
          tokenCountBeforeCallback = this.currentTokenCount; // Update for next callback
        } else if (this.modelProvider.getProviderName() === 'anthropic' && lastTokenUsage) {
          // Anthropic: use exact counts from API (provided via token_usage events)
          const totalTokens = lastTokenUsage.inputTokens + lastTokenUsage.outputTokens;
          this.chatHistoryManager.addTokenUsagePerCallback(
            lastTokenUsage.inputTokens,
            lastTokenUsage.outputTokens,
            totalTokens,
            lastTokenUsage.regularInputTokens,
            lastTokenUsage.cacheCreationTokens,
            lastTokenUsage.cacheReadTokens
          );
          lastTokenUsage = null; // Reset after logging
          tokenCountBeforeCallback = this.currentTokenCount; // Update for next callback
        }

        // Check if we need to summarize after this response
        if (this.shouldSummarize()) {
          await this.autoSummarize();
        }

        // If stop_reason is 'end_turn', Anthropic is done
        if (chunk.stop_reason === 'end_turn') {
          // Add any remaining pending tool results before breaking
          if (pendingToolResults.length > 0) {
            if (isAnthropic) {
              // Verify that the last assistant message has tool_use blocks that match our tool results
              // Find the last assistant message with content_blocks
              let lastAssistantIndex = this.messages.length - 1;
              while (lastAssistantIndex >= 0) {
                const msg = this.messages[lastAssistantIndex];
                if (msg.role === 'assistant' && msg.content_blocks) {
                  const toolUseBlocks = msg.content_blocks.filter((block: any) => block.type === 'tool_use');
                  if (toolUseBlocks.length > 0) {
                    const toolUseIds = new Set(toolUseBlocks.map((block: any) => block.id));
                    
                    // Only add tool results that have matching tool_use blocks
                    const validToolResults = pendingToolResults.filter(tr => 
                      tr.toolUseId && toolUseIds.has(tr.toolUseId)
                    );
                    
                    if (validToolResults.length > 0) {
                      const toolResultsMessage: Message = {
                        role: 'user',
                        content: '',
                        tool_results: validToolResults.map(tr => ({
                          type: 'tool_result',
                          tool_use_id: tr.toolUseId!,
                          content: tr.content,
                        })),
                      };
                      this.messages.push(toolResultsMessage);
                    }
                    break;
                  }
                }
                lastAssistantIndex--;
              }
            } else {
              for (const tr of pendingToolResults) {
                if (tr.toolCallId) {
                  const toolMessage: Message = {
                    role: 'tool',
                    tool_call_id: tr.toolCallId,
                    content: tr.content,
                  };
                  this.messages.push(toolMessage);
                }
              }
            }
            pendingToolResults.length = 0;
          }
          break;
        }
      }
    }

    // Return any remaining pending tool results and last token usage so they can be flushed/logged by caller
    return { pendingToolResults, lastTokenUsage };
  }

  async processQuery(query: string, isSystemPrompt: boolean = false, attachments?: Array<{ path: string; fileName: string; ext: string; mediaType: string }>, cancellationCheck?: () => boolean) {
    // Track message count before adding new message (for cleanup on abort)
    const messagesBeforeQuery = this.messages.length;
    const tokenCountBeforeQuery = this.currentTokenCount;
    
    // Reset token tracking for this query
    // This ensures we track tokens per callback correctly
    if (this.modelProvider.getProviderName() === 'anthropic') {
      // For Anthropic, we'll track from the current count
      // The processToolUseStream will handle per-callback tracking
    }
    
    try {
      // Check if we need to summarize before adding new message
      if (this.shouldSummarize()) {
        await this.autoSummarize();
      }

      // Note: System prompt is now logged BEFORE the user message in cli-client.ts
      // to ensure correct chronological order. The query passed here may already
      // include the system prompt prepended.

      // Handle attachments if provided
      let userMessage: Message;
      if (attachments && attachments.length > 0) {
        // Create content blocks from attachments and query text
        const contentBlocks = this.attachmentManager.createContentBlocks(attachments, query);
        
        // Create message with content_blocks for Anthropic API
        userMessage = {
          role: 'user',
          content: query, // Keep text content for compatibility
          content_blocks: contentBlocks, // Add content blocks for Anthropic
        };
      } else {
        // Standard text message
        userMessage = { role: 'user', content: query };
      }
      
      this.messages.push(userMessage);
      // Token counting for messages with attachments is approximate
      // Anthropic API will provide accurate counts during streaming
      await this.ensureTokenCounter();
      this.currentTokenCount += this.tokenCounter!.countMessageTokens(userMessage);

      // Check again after adding message
      if (this.shouldSummarize()) {
        await this.autoSummarize();
      }

      // Define how to execute MCP tools (callback for the provider)
      const toolExecutor: ToolExecutor = async (
        toolName: string,
        toolInput: Record<string, any>,
      ) => {
        return await this.executeMCPTool(toolName, toolInput);
      };

      // Use the provider's agentic loop instead of manual processing
      // This handles:
      // - Sending messages to Anthropic
      // - Detecting tool use (stop_reason === 'tool_use')
      // - Executing tools via our callback
      // - Sending results back to Anthropic
      // - Repeating until Anthropic is done
      
      // Track token count before starting the stream (for per-callback tracking)
      const tokenCountBeforeStream = this.currentTokenCount;
      
      const stream = (this.modelProvider as any).createMessageStreamWithToolUse(
        this.messages,
        this.model,
        this.tools,
        8192,
        toolExecutor,
        100, // maxIterations
        cancellationCheck, // Pass cancellation check to provider
      );

      // Process the stream and collect final assistant message
      // Don't break immediately on cancellation - let current chunk finish
      // Pass initial token count for tracking
      const { pendingToolResults, lastTokenUsage } = await this.processToolUseStream(stream, cancellationCheck, tokenCountBeforeStream);

      // Flush any remaining pending tool results (in case we aborted before they were added)
      if (pendingToolResults && pendingToolResults.length > 0) {
        const isAnthropic = this.modelProvider.getProviderName() === 'anthropic';
        if (isAnthropic) {
          // Find the last assistant message with tool_use blocks
          let lastAssistantIndex = this.messages.length - 1;
          while (lastAssistantIndex >= 0) {
            const msg = this.messages[lastAssistantIndex];
            if (msg.role === 'assistant' && msg.content_blocks) {
              // Check if this assistant message has tool_use blocks
              const toolUseBlocks = msg.content_blocks.filter((block: any) => block.type === 'tool_use');
              if (toolUseBlocks.length > 0) {
                // Verify that all pending tool results have matching tool_use_ids
                const toolUseIds = new Set(toolUseBlocks.map((block: any) => block.id));
                const validToolResults = pendingToolResults.filter(tr => 
                  tr.toolUseId && toolUseIds.has(tr.toolUseId)
                );
                
                if (validToolResults.length > 0) {
                  // Check if we already have a tool_results message after this assistant
                  let toolResultsIndex = lastAssistantIndex + 1;
                  if (toolResultsIndex < this.messages.length && 
                      this.messages[toolResultsIndex].role === 'user' && 
                      this.messages[toolResultsIndex].tool_results) {
                    // Add to existing tool_results message
                    for (const tr of validToolResults) {
                      this.messages[toolResultsIndex].tool_results!.push({
                        type: 'tool_result',
                        tool_use_id: tr.toolUseId!,
                        content: tr.content,
                      });
                    }
                  } else {
                    // Create new tool_results message
                    const toolResultsMessage: Message = {
                      role: 'user',
                      content: '',
                      tool_results: validToolResults.map(tr => ({
                        type: 'tool_result',
                        tool_use_id: tr.toolUseId!,
                        content: tr.content,
                      })),
                    };
                    this.messages.splice(toolResultsIndex, 0, toolResultsMessage);
                  }
                }
                break;
              }
            }
            lastAssistantIndex--;
          }
        } else {
          // OpenAI: add tool role messages
          for (const tr of pendingToolResults) {
            if (tr.toolCallId) {
              const toolMessage: Message = {
                role: 'tool',
                tool_call_id: tr.toolCallId,
                content: tr.content,
              };
              this.messages.push(toolMessage);
            }
          }
        }
      }
      
      // Check if query was cancelled - messages are kept visible even when aborted
      if (cancellationCheck && cancellationCheck()) {
        // Keep messages and token count as-is so user can see the partial response
        return this.messages;
      }

      // Always update token count using official API after stream completes
      // This ensures accurate counts including images/attachments
      if (this.modelProvider.getProviderName() === 'anthropic') {
        const provider = this.modelProvider as any;
        try {
          const exactCount = await provider.countTokensOfficial(
            this.messages,
            this.model,
            this.tools,
          );
          this.currentTokenCount = exactCount;
        } catch (error) {
          // If token counting fails, log warning but continue
          this.logger.log(
            `\n⚠️  Failed to get exact token count: ${error}\n`,
            { type: 'warning' },
          );
        }
      }

      // Log final token usage if there's one remaining from the stream
      // This happens because token_usage events come AFTER message_stop events in the Anthropic stream
      // So the last iteration's token usage doesn't get logged during the stream
      if (lastTokenUsage) {
        const totalTokens = lastTokenUsage.inputTokens + lastTokenUsage.outputTokens;

        this.chatHistoryManager.addTokenUsagePerCallback(
          lastTokenUsage.inputTokens,
          lastTokenUsage.outputTokens,
          totalTokens,
          lastTokenUsage.regularInputTokens,
          lastTokenUsage.cacheCreationTokens,
          lastTokenUsage.cacheReadTokens
        );
      }

      // Check todo status if todo mode is enabled and agent is trying to exit
      // Loop until all todos are completed or skipped
      if (this.todoManager.isEnabled()) {
        while (true) {
          // Check for cancellation before continuing todo loop
          if (cancellationCheck && cancellationCheck()) {
            break;
          }
          
          const todoStatus = await this.checkTodoStatus();
          if (todoStatus.activeCount === 0) {
            // All todos are complete, ask user what to do
            if (this.todoCompletionUserCallback) {
              const todosList = await this.todoManager.getAllTodosList();
              const userChoice = await this.todoCompletionUserCallback(todosList);
              if (userChoice === 'clear') {
                await this.clearAllTodos(true);
              }
              // If 'leave', todos remain as is
            }
            // All todos are complete, we can exit
            break;
          }
          
          // Agent is trying to exit but has incomplete todos
          const reminderMessage: Message = {
            role: 'user',
            content: `You have ${todoStatus.activeCount} incomplete todo(s). Please complete them using complete-todo. Only skip them using skip-todo if you cannot perform these tasks. Before executing the next action, first update the previous action you completed (mark it as complete using complete-todo), then read the next todo using read-next-todo.\n\nActive todos:\n${todoStatus.todosList}\n\nYou cannot exit until all todos are completed or skipped.`,
          };
          this.messages.push(reminderMessage);
          this.currentTokenCount += this.tokenCounter!.countMessageTokens(reminderMessage);
          
          // Log the reminder message to chat history (as client message)
          this.chatHistoryManager.addClientMessage(reminderMessage.content);
          
          this.logger.log(
            `\n⚠️ Agent attempted to exit with ${todoStatus.activeCount} incomplete todo(s). Prompting to complete or skip.\n`,
            { type: 'warning' },
          );
          
          // Get message count before processing to find the new assistant message
          const messagesBeforeReminder = this.messages.length;
          
          // Continue conversation so agent can complete/skip todos
          const continueTokenCountBeforeStream = this.currentTokenCount;
          const continueStream = (this.modelProvider as any).createMessageStreamWithToolUse(
            this.messages,
            this.model,
            this.tools,
            8192,
            toolExecutor,
            100, // maxIterations
            cancellationCheck, // Pass cancellation check to provider
          );
          const { pendingToolResults: continuePendingToolResults, lastTokenUsage: continueLastTokenUsage } = await this.processToolUseStream(continueStream, cancellationCheck, continueTokenCountBeforeStream);

          // Flush any remaining pending tool results
          if (continuePendingToolResults && continuePendingToolResults.length > 0) {
            const isAnthropic = this.modelProvider.getProviderName() === 'anthropic';
            if (isAnthropic) {
              // Find the last assistant message with tool_use blocks
              let lastAssistantIndex = this.messages.length - 1;
              while (lastAssistantIndex >= 0) {
                const msg = this.messages[lastAssistantIndex];
                if (msg.role === 'assistant' && msg.content_blocks) {
                  // Check if this assistant message has tool_use blocks
                  const toolUseBlocks = msg.content_blocks.filter((block: any) => block.type === 'tool_use');
                  if (toolUseBlocks.length > 0) {
                    // Verify that all pending tool results have matching tool_use_ids
                    const toolUseIds = new Set(toolUseBlocks.map((block: any) => block.id));
                    const validToolResults = continuePendingToolResults.filter(tr =>
                      tr.toolUseId && toolUseIds.has(tr.toolUseId)
                    );
                    
                    if (validToolResults.length > 0) {
                      // Check if we already have a tool_results message after this assistant
                      let toolResultsIndex = lastAssistantIndex + 1;
                      if (toolResultsIndex < this.messages.length && 
                          this.messages[toolResultsIndex].role === 'user' && 
                          this.messages[toolResultsIndex].tool_results) {
                        // Add to existing tool_results message
                        for (const tr of validToolResults) {
                          this.messages[toolResultsIndex].tool_results!.push({
                            type: 'tool_result',
                            tool_use_id: tr.toolUseId!,
                            content: tr.content,
                          });
                        }
                      } else {
                        // Create new tool_results message
                        const toolResultsMessage: Message = {
                          role: 'user',
                          content: '',
                          tool_results: validToolResults.map(tr => ({
                            type: 'tool_result',
                            tool_use_id: tr.toolUseId!,
                            content: tr.content,
                          })),
                        };
                        this.messages.splice(toolResultsIndex, 0, toolResultsMessage);
                      }
                    }
                    break;
                  }
                }
                lastAssistantIndex--;
              }
            } else {
              for (const tr of continuePendingToolResults) {
                if (tr.toolCallId) {
                  const toolMessage: Message = {
                    role: 'tool',
                    tool_call_id: tr.toolCallId,
                    content: tr.content,
                  };
                  this.messages.push(toolMessage);
                }
              }
            }
          }

          // Check if query was cancelled
          if (cancellationCheck && cancellationCheck()) {
            break;
          }

          // Extract and log assistant response to reminder message
          const messagesAfterReminder = this.messages;
          const assistantMessagesAfterReminder = messagesAfterReminder
            .slice(messagesBeforeReminder)
            .filter((msg: any) => msg.role === 'assistant');
          if (assistantMessagesAfterReminder.length > 0) {
            const lastAssistantMessage = assistantMessagesAfterReminder[assistantMessagesAfterReminder.length - 1];
            if (lastAssistantMessage.content) {
              this.chatHistoryManager.addAssistantMessage(lastAssistantMessage.content);
            }
          }

          // Log final token usage if there's one remaining from the stream
          if (continueLastTokenUsage) {
            const totalTokens = continueLastTokenUsage.inputTokens + continueLastTokenUsage.outputTokens;

            this.chatHistoryManager.addTokenUsagePerCallback(
              continueLastTokenUsage.inputTokens,
              continueLastTokenUsage.outputTokens,
              totalTokens,
              continueLastTokenUsage.regularInputTokens,
              continueLastTokenUsage.cacheCreationTokens,
              continueLastTokenUsage.cacheReadTokens
            );
          }
        }
      }

      return this.messages;
    } catch (error) {
      // Extract clean error message
      let cleanErrorMessage = 'An unknown error occurred';
      
      if (error instanceof Error) {
        let errorMessage = error.message;
        
        // Check if error message contains HTML (like Cloudflare error pages)
        if (errorMessage.includes('<!DOCTYPE html>') || errorMessage.includes('<html')) {
          // Extract HTTP status code if present
          const statusMatch = errorMessage.match(/(\d{3})\s*<!DOCTYPE/i);
          if (statusMatch) {
            const statusCode = statusMatch[1];
            if (statusCode === '520') {
              cleanErrorMessage = 'OpenAI API error 520: Connection issue between Cloudflare and the origin server. Please try again in a few minutes.';
            } else {
              cleanErrorMessage = `OpenAI API error ${statusCode}: Server connection issue. Please try again.`;
            }
          } else {
            // Try to extract error code from title tag
            const titleMatch = errorMessage.match(/<title>.*?(\d{3}):\s*([^<]+)<\/title>/i);
            if (titleMatch) {
              cleanErrorMessage = `OpenAI API error ${titleMatch[1]}: ${titleMatch[2].trim()}`;
            } else {
              cleanErrorMessage = 'OpenAI API error: Server connection issue. Please try again.';
            }
          }
        } else {
          cleanErrorMessage = errorMessage;
        }
        
        // Check for HTTP status codes in error message
        const httpStatusMatch = errorMessage.match(/\b(\d{3})\b/);
        if (httpStatusMatch && !cleanErrorMessage.includes('error')) {
          const statusCode = httpStatusMatch[1];
          if (statusCode.startsWith('5')) {
            cleanErrorMessage = `OpenAI API error ${statusCode}: Server error. Please try again.`;
          } else if (statusCode.startsWith('4')) {
            cleanErrorMessage = `OpenAI API error ${statusCode}: Client error. ${cleanErrorMessage}`;
          }
        }
      }
      
      this.logger.log('\nError during query processing: ' + cleanErrorMessage + '\n', {
        type: 'error',
      });
      
      if (error instanceof Error) {
        // Check if it's a PDF-related error for OpenAI
        if (
          this.modelProvider.getProviderName() === 'openai' &&
          (error.message.includes('Invalid MIME type') ||
            error.message.includes('Only image types are supported'))
        ) {
          this.logger.log(
            consoleStyles.assistant +
              'I apologize, but I encountered an error processing the PDF attachment.\n' +
              'PDF support requires a vision-capable model like GPT-4o or GPT-4o-mini.\n' +
              'Please try using: --model=gpt-4o or --model=gpt-4o-mini\n' +
              'Error details: ' +
              cleanErrorMessage +
              '\n',
          );
        } else {
          this.logger.log(
            consoleStyles.assistant +
              'I apologize, but I encountered an error: ' +
              cleanErrorMessage +
              '\n',
          );
        }
      }
    }
  }

  /**
   * Get the model provider name
   */
  getProviderName(): string {
    return this.modelProvider.getProviderName();
  }
}