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
import type {
  ModelProvider,
  TokenCounter,
  Tool,
  Message,
  SummarizationConfig,
  MessageStreamEvent,
} from './model-provider.js';
import { ClaudeProvider, type ToolExecutor } from './providers/claude.js';

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
  private tokenCounter: TokenCounter;
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

  constructor(
    serverConfigs: StdioServerParameters | StdioServerParameters[],
    options?: { 
      loggerOptions?: LoggerOptions; 
      summarizationConfig?: Partial<SummarizationConfig>; 
      model?: string;
      provider?: ModelProvider;
    },
  ) {
    // Use provided provider or default to Claude
    this.modelProvider = options?.provider || new ClaudeProvider();

    // Support both single server (backward compatibility) and multiple servers
    const configs = Array.isArray(serverConfigs) ? serverConfigs : [serverConfigs];
    this.serverConfigs = configs.map((config, index) => ({
      name: `server-${index}`,
      config,
    }));

    this.logger = new Logger(options?.loggerOptions ?? { mode: 'verbose' });
    
    // Initialize model (default to provider's default model)
    this.model = options?.model || this.modelProvider.getDefaultModel();
    
    // Initialize token counter from provider
    this.tokenCounter = this.modelProvider.createTokenCounter(this.model, options?.summarizationConfig);
    
    // Initialize todo manager
    this.todoManager = new TodoManager(this.logger);
    
    // Initialize tool manager
    this.toolManager = new ToolManager(this.logger);
    
    // Initialize prompt manager
    this.promptManager = new PromptManager(this.logger);
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
    // Use provided provider or default to Claude
    client.modelProvider = options?.provider || new ClaudeProvider();
    client.messages = [];
    client.servers = new Map();
    client.tools = [];
    client.logger = new Logger(options?.loggerOptions ?? { mode: 'verbose' });
    client.serverConfigs = servers;
    client.model = options?.model || client.modelProvider.getDefaultModel();
    client.currentTokenCount = 0;
    client.tokenCounter = client.modelProvider.createTokenCounter(client.model, options?.summarizationConfig);
    client.todoManager = new TodoManager(client.logger);
    client.toolManager = new ToolManager(client.logger);
    client.promptManager = new PromptManager(client.logger);
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

  /**
   * Execute a tool via MCP servers
   * This is the callback that the provider calls when Claude wants to use a tool
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

      this.logger.log(
        this.formatToolCall(toolName, toolInput) + '\n',
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

  private shouldSummarize(): boolean {
    return this.tokenCounter.shouldSummarize(this.currentTokenCount);
  }

  // Public method to get token usage status (for testing/debugging)
  getTokenUsage() {
    return this.tokenCounter.getUsage(this.currentTokenCount);
  }

  // Public method to manually trigger summarization (for testing)
  async manualSummarize(): Promise<void> {
    await this.autoSummarize();
  }

  // Public method to set test mode (lower threshold for easier testing)
  setTestMode(enabled: boolean = true, testThreshold: number = 5) {
    if (enabled) {
      this.tokenCounter.updateConfig({
        threshold: testThreshold, // Very low threshold for testing
        enabled: true,
      });
      this.logger.log(
        `\nTest mode enabled: Summarization will trigger at ${testThreshold}% (${Math.round(this.tokenCounter.getContextWindow() * testThreshold / 100)} tokens)\n`,
        { type: 'info' },
      );
    } else {
      this.tokenCounter.updateConfig({
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
    if (!this.tokenCounter.getConfig().enabled) {
      return;
    }

    const config = this.tokenCounter.getConfig();
    const recentCount = config.recentMessagesToKeep;

    // Need at least recentCount + 1 messages to summarize
    if (this.messages.length <= recentCount) {
      return;
    }

    this.logger.log(
      `\n⚠️ Context window approaching limit (${this.tokenCounter.getUsage(this.currentTokenCount).percentage}% used). Summarizing conversation...\n`,
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

      // Call API to summarize (using ClaudeProvider's createMessage for non-streaming)
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
        oldTokenCount += this.tokenCounter.countMessageTokens(msg);
      }

      // Count summary message
      const summaryMessage: Message = {
        role: 'user',
        content: `[Previous conversation summary: ${summaryText}]`,
      };
      const summaryTokenCount =
        this.tokenCounter.countMessageTokens(summaryMessage);

      // Update messages and token count
      this.messages = [summaryMessage, ...recentMessages];
      this.currentTokenCount =
        this.currentTokenCount - oldTokenCount + summaryTokenCount;

      this.logger.log(
        `✓ Conversation summarized. Context reduced from ${oldMessages.length} to 1 summary message. Token usage: ${this.tokenCounter.getUsage(this.currentTokenCount).percentage}%\n`,
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
   * Supports both Claude (complete response objects) and OpenAI (streaming events)
   */
  private async processToolUseStream(
    stream: AsyncIterable<any>,
  ): Promise<void> {
    this.logger.log(consoleStyles.assistant);
    
    let currentMessage = '';
    let messageStarted = false;
    
    for await (const chunk of stream) {
      // Handle tool_use_complete events (from provider)
      if (chunk.type === 'tool_use_complete') {
        // Tool was executed - provider already handled it
        // Log the tool execution
        this.logger.log(
          `\n[Tool executed: ${chunk.toolName}]\n`,
          { type: 'info' },
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
        currentMessage += chunk.delta.text;
        this.logger.log(chunk.delta.text);
        continue;
      }

      // Handle token usage from OpenAI (exact counts from API)
      if (chunk.type === 'token_usage' && chunk.input_tokens !== undefined) {
        this.currentTokenCount = chunk.input_tokens + chunk.output_tokens;
        continue;
      }

      if (chunk.type === 'message_stop') {
        // Message complete - add to history if we have content
        // Note: message_stop doesn't always mean we're done - it could be after tool calls
        // The provider will continue the loop if tools were called
        if (currentMessage.trim()) {
          const assistantMessage: Message = {
            role: 'assistant',
            content: currentMessage,
          };
          this.messages.push(assistantMessage);
          
          // Use official token counting for accurate counts
          if (this.modelProvider.getProviderName() === 'claude') {
            const provider = this.modelProvider as any;
            const exactCount = await provider.countTokensOfficial(
              this.messages,
              this.model,
              this.tools,
            );
            this.currentTokenCount = exactCount;
          }
          // OpenAI: token counts come from token_usage events (already handled above)
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

      // Handle complete response objects from Claude API
      // These come from Claude's createMessageStreamWithToolUse
      if (chunk.content && Array.isArray(chunk.content)) {
        // Extract and display text content
        const textBlocks = chunk.content.filter((block: any) => block.type === 'text');
        if (textBlocks.length > 0) {
          const textContent = textBlocks.map((block: any) => block.text).join('\n');
          this.logger.log(textContent);
          
          // Add assistant message to history (only if there's actual content)
          if (textContent.trim()) {
            const assistantMessage: Message = {
              role: 'assistant',
              content: textContent,
            };
            this.messages.push(assistantMessage);
            
            // Use official token counting for accurate counts
            if (this.modelProvider.getProviderName() === 'claude') {
              const provider = this.modelProvider as any;
              const exactCount = await provider.countTokensOfficial(
                this.messages,
                this.model,
                this.tools,
              );
              this.currentTokenCount = exactCount;
            }
            // OpenAI: token counts come from token_usage events (already handled above)
          }
        }

        // Check if we need to summarize after this response
        if (this.shouldSummarize()) {
          await this.autoSummarize();
        }

        // If stop_reason is 'end_turn', Claude is done
        if (chunk.stop_reason === 'end_turn') {
          break;
        }
      }
    }
  }

  async processQuery(query: string, isSystemPrompt: boolean = false) {
    try {
      // Check if we need to summarize before adding new message
      if (this.shouldSummarize()) {
        await this.autoSummarize();
      }

      // Track if this is the first message after enabling todo mode
      const isFirstTodoMessage = this.todoManager.isEnabled() && !isSystemPrompt && !this.todoModeInitialized;

      // If todo mode is enabled and this is a user query (not system prompt),
      // prepend the system prompt if not yet initialized
      if (isFirstTodoMessage) {
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
        
        // If todos were skipped, include the current todo state so agent can update it
        if (this.todosWereSkipped) {
          const todoStatus = await this.checkTodoStatus();
          const todosList = await this.todoManager.getAllTodosList();
          systemPrompt += `\n\nIMPORTANT: The previous incomplete todos have been skipped. Here is the current todo list state:\n\n${todosList}\n\nYou should review and update this todo list based on the user's new task. Use update-todo to modify existing todos or create-todo to add new ones as needed.`;
        }
        
        query = `${systemPrompt}\n\nUser: ${query}`;
        this.todoModeInitialized = true;
        this.todosLeftAsIs = false; // Reset after first message
        this.todosWereSkipped = false; // Reset after first message
      }

      // Add user message to history
      const userMessage: Message = { role: 'user', content: query };
      this.messages.push(userMessage);
      this.currentTokenCount += this.tokenCounter.countMessageTokens(userMessage);

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
      // - Sending messages to Claude
      // - Detecting tool use (stop_reason === 'tool_use')
      // - Executing tools via our callback
      // - Sending results back to Claude
      // - Repeating until Claude is done
      const stream = (this.modelProvider as any).createMessageStreamWithToolUse(
        this.messages,
        this.model,
        this.tools,
        8192,
        toolExecutor,
      );

      // Process the stream and collect final assistant message
      await this.processToolUseStream(stream);

      // Log token usage after agent response
      const usage = this.tokenCounter.getUsage(this.currentTokenCount);
      this.logger.log(
        `\n[Token usage: ${usage.current}/${usage.limit} (${usage.percentage}%)]\n`,
        { type: 'info' },
      );

      // Check todo status if todo mode is enabled and agent is trying to exit
      // Loop until all todos are completed or skipped
      if (this.todoManager.isEnabled()) {
        while (true) {
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
          this.currentTokenCount += this.tokenCounter.countMessageTokens(reminderMessage);
          
          this.logger.log(
            `\n⚠️ Agent attempted to exit with ${todoStatus.activeCount} incomplete todo(s). Prompting to complete or skip.\n`,
            { type: 'warning' },
          );
          
          // Continue conversation so agent can complete/skip todos
          const continueStream = (this.modelProvider as any).createMessageStreamWithToolUse(
            this.messages,
            this.model,
            this.tools,
            8192,
            toolExecutor,
          );
          await this.processToolUseStream(continueStream);
          
          // Log token usage after continue stream response
          const continueUsage = this.tokenCounter.getUsage(this.currentTokenCount);
          this.logger.log(
            `\n[Token usage: ${continueUsage.current}/${continueUsage.limit} (${continueUsage.percentage}%)]\n`,
            { type: 'info' },
          );
        }
      }

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