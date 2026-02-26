import {
  StdioClientTransport,
  StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
  ListPromptsResultSchema,
  GetPromptResultSchema,
  ElicitRequestSchema,
  type Prompt,
  type GetPromptResult,
  type ElicitRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import chalk from 'chalk';
import { consoleStyles, Logger, LoggerOptions } from './logger.js';
import { TodoManager } from './managers/todo-manager.js';
import { ROS2VideoRecordingManager } from './managers/ros2-video-recording-manager.js';
import { ToolManager } from './managers/tool-manager.js';
import { PromptManager } from './managers/prompt-manager.js';
import { ChatHistoryManager, type ChatSession } from './managers/chat-history-manager.js';
import { AttachmentManager } from './managers/attachment-manager.js';
import { PreferencesManager } from './managers/preferences-manager.js';
import { HookManager } from './managers/hook-manager.js';
import type {
  ModelProvider,
  Tool,
  Message,
  SummarizationConfig,
  MessageStreamEvent,
} from './model-provider.js';

export type WebStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_start'; toolName: string; toolInput: Record<string, any>; toolId: string }
  | { type: 'tool_complete'; toolName: string; toolInput: Record<string, any>; result: string; toolId: string; cancelled?: boolean }
  | { type: 'token_usage'; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: 'warning'; message: string }
  | { type: 'info'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'approval_request'; toolName: string; toolInput: Record<string, any>; requestId: string }
  | { type: 'elicitation_request'; message: string; requestedSchema: any; requestId: string }
  | { type: 'ipc_tool_start'; toolName: string; args: Record<string, any> }
  | { type: 'ipc_tool_end'; toolName: string; args: Record<string, any>; result?: any; error?: string };

export type StreamObserver = (event: WebStreamEvent) => void;
import { AnthropicProvider, type ToolExecutor } from './providers/anthropic.js';
import { isReasoningModel } from './utils/model-capabilities.js';
import { initModelsDevCache, startModelsDevRefresh } from './utils/models-dev.js';
import { OrchestratorIPCServer } from './ipc-server.js';
import { ElicitationHandler } from './handlers/elicitation-handler.js';
import { formatToolCall, formatJSON, formatCompactJSON } from './utils/formatting.js';
import { TokenManager } from './core/token-manager.js';
import { MCPToolExecutor, type ToolExecutionResult } from './core/tool-executor.js';
import readline from 'readline/promises';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, '..', '.mcp-client-data');
const MCP_CONFIG_FILE = join(__dirname, '..', 'mcp_config.json');

type MCPClientOptions = StdioServerParameters & {
  loggerOptions?: LoggerOptions;
  summarizationConfig?: Partial<SummarizationConfig>;
  model?: string;
  enableOrchestratorIPC?: boolean; // Enable IPC server for mcp-tools-orchestrator
};

type MultiServerConfig = {
  name: string;
  config: StdioServerParameters;
  disabledInConfig?: boolean; // If true, server was disabled in config but loaded for IPC routing
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
  private tokenManager: TokenManager;
  private currentTokenCount: number = 0;
  private model: string;
  private todoManager: TodoManager;
  private ros2VideoRecordingManager: ROS2VideoRecordingManager;
  private todoModeInitialized: boolean = false;
  private todoClearUserCallback?: (todosList: string) => Promise<'clear' | 'skip' | 'leave'>;
  private todoCompletionUserCallback?: (todosList: string) => Promise<'clear' | 'leave'>;
  private todosLeftAsIs: boolean = false; // Track if todos were left as-is (not skipped)
  private todosWereSkipped: boolean = false; // Track if todos were skipped
  private orchestratorModeEnabled: boolean = false; // Track if orchestrator mode is enabled
  private toolManager: ToolManager;
  private promptManager: PromptManager;
  private chatHistoryManager: ChatHistoryManager;
  private attachmentManager: AttachmentManager;
  private preferencesManager: PreferencesManager;
  private orchestratorIPCServer: OrchestratorIPCServer | null = null;
  private enableOrchestratorIPC: boolean = false;
  private ipcListenersSetup: boolean = false; // Track if IPC listeners are already set up
  private _disableHistoryRecording: boolean = false; // Flag to disable chat history recording (for replay mode)
  private toolInputTimes: Map<string, string> = new Map(); // Track tool input times by tool name/id
  private elicitationHandler: ElicitationHandler;
  private toolExecutor: MCPToolExecutor;
  private hookManager: HookManager;
  private forceStopCallback?: (toolName: string, elapsedSeconds: number, abortSignal?: AbortSignal) => Promise<boolean>;
  private isAbortRequestedCallback?: () => boolean;
  private toolApprovalCallback?: (toolName: string, toolInput: Record<string, any>) => Promise<'execute' | { decision: 'reject'; message?: string }>;
  private webElicitationCallback?: (request: ElicitRequest) => Promise<import('@modelcontextprotocol/sdk/types.js').ElicitResult>;

  constructor(
    serverConfigs: StdioServerParameters | StdioServerParameters[],
    options?: {
      loggerOptions?: LoggerOptions;
      summarizationConfig?: Partial<SummarizationConfig>;
      model?: string;
      provider?: ModelProvider;
      enableOrchestratorIPC?: boolean;
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

    // Check if IPC should be enabled
    this.enableOrchestratorIPC = options?.enableOrchestratorIPC ?? false;

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
    
    // Initialize token manager with callbacks
    this.tokenManager = new TokenManager(this.logger, {
      getMessages: () => this.messages,
      setMessages: (messages) => { this.messages = messages; },
      getCurrentTokenCount: () => this.currentTokenCount,
      setCurrentTokenCount: (count) => { this.currentTokenCount = count; },
      getModelProvider: () => this.modelProvider,
      getModel: () => this.model,
    });
    
    // Initialize todo manager
    this.todoManager = new TodoManager(this.logger);

    // Initialize ROS2 video recording manager
    this.ros2VideoRecordingManager = new ROS2VideoRecordingManager(this.logger);

    // Initialize tool manager
    this.preferencesManager = new PreferencesManager(this.logger);
    this.toolManager = new ToolManager(this.logger);

    // Initialize hook manager (client-side hooks for regular chat)
    this.hookManager = new HookManager(this.logger);

    // Initialize tool executor
    this.toolExecutor = new MCPToolExecutor(this.logger, {
      getServers: () => this.servers,
      getPreferencesManager: () => this.preferencesManager,
      getHookManager: () => this.hookManager,
      cancelPendingElicitation: () => this.elicitationHandler.cancelPending(),
      setElicitationAutoDecline: (value: boolean) => this.elicitationHandler.setAutoDecline(value),
      isAbortRequested: () => {
        if (this.isAbortRequestedCallback) {
          return this.isAbortRequestedCallback();
        }
        return false; // Default: not aborted
      },
      askForceStop: (toolName, elapsedSeconds, abortSignal) => {
        if (this.forceStopCallback) {
          return this.forceStopCallback(toolName, elapsedSeconds, abortSignal);
        }
        return Promise.resolve(false); // Default: don't force stop
      },
      killAndRestartServer: (serverName) => this.killAndRestartServer(serverName),
      requestToolApproval: (toolName, toolInput) => {
        if (this.toolApprovalCallback) {
          return this.toolApprovalCallback(toolName, toolInput);
        }
        return Promise.resolve('execute' as const);
      },
    });

    // Initialize prompt manager
    this.promptManager = new PromptManager(this.logger);
    
    // Initialize chat history manager
    this.chatHistoryManager = new ChatHistoryManager(this.logger);
    this.chatHistoryManager.setProviderName(this.modelProvider.getProviderName());
    this.hookManager.setChatLogger(this.chatHistoryManager);

    // Initialize attachment manager
    this.attachmentManager = new AttachmentManager(this.logger);

    // Initialize elicitation handler
    this.elicitationHandler = new ElicitationHandler(this.logger, () =>
      readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    );
    this.elicitationHandler.setChatLogger(this.chatHistoryManager);
  }

  // Constructor for multiple named servers
  static createMultiServer(
    servers: Array<{ name: string; config: StdioServerParameters }>,
    options?: {
      loggerOptions?: LoggerOptions;
      summarizationConfig?: Partial<SummarizationConfig>;
      model?: string;
      provider?: ModelProvider;
      enableOrchestratorIPC?: boolean;
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
    // Initialize token manager with callbacks
    client.tokenManager = new TokenManager(client.logger, {
      getMessages: () => client.messages,
      setMessages: (messages) => { client.messages = messages; },
      getCurrentTokenCount: () => client.currentTokenCount,
      setCurrentTokenCount: (count) => { client.currentTokenCount = count; },
      getModelProvider: () => client.modelProvider,
      getModel: () => client.model,
    });
    client.todoManager = new TodoManager(client.logger);
    client.ros2VideoRecordingManager = new ROS2VideoRecordingManager(client.logger);
    client.preferencesManager = new PreferencesManager(client.logger);
    client.toolManager = new ToolManager(client.logger);
    client.hookManager = new HookManager(client.logger);
    client.toolExecutor = new MCPToolExecutor(client.logger, {
      getServers: () => client.servers,
      getPreferencesManager: () => client.preferencesManager,
      getHookManager: () => client.hookManager,
      isAbortRequested: () => {
        if (client.isAbortRequestedCallback) {
          return client.isAbortRequestedCallback();
        }
        return false; // Default: not aborted
      },
      askForceStop: (toolName, elapsedSeconds, abortSignal) => {
        if (client.forceStopCallback) {
          return client.forceStopCallback(toolName, elapsedSeconds, abortSignal);
        }
        return Promise.resolve(false); // Default: don't force stop
      },
      killAndRestartServer: (serverName) => client.killAndRestartServer(serverName),
      requestToolApproval: (toolName, toolInput) => {
        if (client.toolApprovalCallback) {
          return client.toolApprovalCallback(toolName, toolInput);
        }
        return Promise.resolve('execute' as const);
      },
    });
    client.promptManager = new PromptManager(client.logger);
    client.chatHistoryManager = new ChatHistoryManager(client.logger);
    client.chatHistoryManager.setProviderName(client.modelProvider.getProviderName());
    client.hookManager.setChatLogger(client.chatHistoryManager);
    client.attachmentManager = new AttachmentManager(client.logger);
    client.orchestratorIPCServer = null;
    client.enableOrchestratorIPC = options?.enableOrchestratorIPC ?? false;
    client.ipcListenersSetup = false;
    client.toolInputTimes = new Map(); // Track tool input times by tool name/id
    client.elicitationHandler = new ElicitationHandler(client.logger, () =>
      readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    );
    client.elicitationHandler.setChatLogger(client.chatHistoryManager);
    return client;
  }

  async start() {
    // Initialize token counter from provider (async, fetches context window from API)
    await this.tokenManager.ensureTokenCounter();

    // Auto-detect if mcp-tools-orchestrator is in the server list AND enabled (not disabled)
    const hasMcpOrchestratorEnabled = this.serverConfigs.some(
      (config) => config.name === 'mcp-tools-orchestrator' && !config.disabledInConfig
    );

    // Start orchestrator IPC server BEFORE connecting to servers if mcp-tools-orchestrator is enabled
    // This ensures MCP_CLIENT_IPC_URL is available when mcp-tools-orchestrator starts
    if (hasMcpOrchestratorEnabled || this.enableOrchestratorIPC) {
      this.orchestratorIPCServer = new OrchestratorIPCServer(this, this.logger);
      try {
        const port = await this.orchestratorIPCServer.start();
        // Export IPC URL via environment variable for mcp-tools-orchestrator to discover
        process.env.MCP_CLIENT_IPC_URL = `http://localhost:${port}`;
        this.logger.log(
          `Orchestrator IPC enabled: ${process.env.MCP_CLIENT_IPC_URL}\n`,
          { type: 'info' },
        );
        // Setup event listeners to log IPC tool calls
        this.setupIPCEventListeners();
      } catch (error) {
        this.logger.log(
          `Failed to start Orchestrator IPC server: ${error}\n`,
          { type: 'warning' },
        );
      }
    }

    // Load models.dev data (pricing + capabilities) in parallel with server connections
    const modelsDevReady = initModelsDevCache().catch(() => {});

    const connectionErrors: Array<{ name: string; error: any }> = [];

    for (const serverConfig of this.serverConfigs) {
      // Connect ALL servers regardless of disabled status — disabled servers
      // are still available for direct tool execution (e.g. @tool-exec: in ablation).
      // The disabledInConfig flag only controls agent-level tool visibility
      // (filtered in initMCPTools).

      try {
        const label = serverConfig.disabledInConfig ? ' (disabled)' : '';
        this.logger.log(`Connecting to server "${serverConfig.name}"${label}...\n`, {
          type: 'info',
        });

        // Inject IPC URL into mcp-tools-orchestrator's environment
        const config = { ...serverConfig.config };
        if (serverConfig.name === 'mcp-tools-orchestrator' && process.env.MCP_CLIENT_IPC_URL) {
          config.env = {
            ...config.env,
            MCP_CLIENT_IPC_URL: process.env.MCP_CLIENT_IPC_URL,
          };
        }

        const client = new Client(
          { name: 'cli-client', version: '1.0.0' },
          { capabilities: { elicitation: { form: {} } } },
        );
        const transport = new StdioClientTransport(config);

        await client.connect(transport);

        // Register elicitation request handler
        client.setRequestHandler(ElicitRequestSchema, async (request: ElicitRequest) => {
          if (this.webElicitationCallback) return this.webElicitationCallback(request);
          return this.elicitationHandler.handleElicitation(request);
        });

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

    // Ensure models.dev data is loaded before first API call (for cost calculation)
    await modelsDevReady;
    startModelsDevRefresh();

    // Initialize tools from all successfully connected servers
    await this.initMCPTools();

    // Initialize prompts from all successfully connected servers
    await this.initMCPPrompts();

    // Start chat session after servers are connected
    const serverNames = Array.from(this.servers.keys());
    // Get enabled tools for the session
    const enabledTools = this.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }));
    this.chatHistoryManager.startSession(this.model, serverNames, enabledTools);

    // Log connected servers (only enabled servers should be connected now)
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

  /**
   * Cleanup video recording - stop any active recordings
   * Call this before ending the chat session so video paths can be included in history
   */
  async cleanupVideoRecording(): Promise<void> {
    if (this.servers.has(this.ros2VideoRecordingManager.getServerName())) {
      const connection = this.servers.get(this.ros2VideoRecordingManager.getServerName())!;
      this.ros2VideoRecordingManager.setConnection(connection);
      try {
        await this.ros2VideoRecordingManager.cleanup();
      } catch (error) {
        // Ignore errors during cleanup
      }
    }
  }

  /**
   * Kill and restart an MCP server to forcefully stop its running operations.
   * This kills the server process (and its child processes) then reconnects.
   * @param serverName - Name of the server to restart
   */
  async killAndRestartServer(serverName: string): Promise<void> {
    const connection = this.servers.get(serverName);
    if (!connection) {
      throw new Error(`Server "${serverName}" not found`);
    }

    // Get the server config for reconnection
    const serverConfig = this.serverConfigs.find(s => s.name === serverName);
    if (!serverConfig) {
      throw new Error(`Server config for "${serverName}" not found`);
    }

    // Get the PID from the transport
    const pid = connection.transport.pid;
    if (pid) {
      this.logger.log(`Killing server process (PID: ${pid})...\n`, { type: 'warning' });
      try {
        // Kill the process and its children
        process.kill(pid, 'SIGTERM');
        // Give it a moment to terminate
        await new Promise(resolve => setTimeout(resolve, 500));
        // Force kill if still running
        try {
          process.kill(pid, 0); // Check if process exists
          process.kill(pid, 'SIGKILL'); // Force kill
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch {
          // Process already terminated
        }
      } catch (error) {
        // Process may have already exited
        this.logger.log(`Process already terminated or kill failed: ${error}\n`, { type: 'info' });
      }
    }

    // Close the client connection
    try {
      await connection.client.close();
    } catch {
      // Ignore errors during cleanup
    }

    // Remove from servers map
    this.servers.delete(serverName);

    // Remove tools from this server
    this.tools = this.tools.filter(t => !t.name.startsWith(`${serverName}__`));

    // Reconnect to the server
    this.logger.log(`Reconnecting to "${serverName}"...\n`, { type: 'info' });

    // Inject IPC URL into mcp-tools-orchestrator's environment
    const config = { ...serverConfig.config };
    if (serverName === 'mcp-tools-orchestrator' && process.env.MCP_CLIENT_IPC_URL) {
      config.env = {
        ...config.env,
        MCP_CLIENT_IPC_URL: process.env.MCP_CLIENT_IPC_URL,
      };
    }

    const client = new Client(
      { name: 'cli-client', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    const transport = new StdioClientTransport(config);

    await client.connect(transport);

    // Register elicitation request handler
    client.setRequestHandler(ElicitRequestSchema, async (request: ElicitRequest) => {
      if (this.webElicitationCallback) return this.webElicitationCallback(request);
      return this.elicitationHandler.handleElicitation(request);
    });

    // Give the server process a moment to fully initialize
    await new Promise(resolve => setTimeout(resolve, 500));

    const newConnection: ServerConnection = {
      name: serverName,
      client,
      transport,
      tools: [],
      prompts: [],
    };

    this.servers.set(serverName, newConnection);

    // Refresh tools from this server
    const toolsResult = await client.listTools();
    for (const tool of toolsResult.tools) {
      const prefixedName = `${serverName}__${tool.name}`;
      const prefixedTool = {
        name: prefixedName,
        description: tool.description || '',
        input_schema: tool.inputSchema,
      };
      newConnection.tools.push(prefixedTool);
      this.tools.push(prefixedTool);
    }

    this.logger.log(`✓ Server "${serverName}" reconnected with ${newConnection.tools.length} tools\n`, { type: 'info' });
  }

  async stop() {
    // Stop orchestrator IPC server if running
    if (this.orchestratorIPCServer) {
      try {
        await this.orchestratorIPCServer.stop();
      } catch (error) {
        // Ignore errors during cleanup
      }
      this.orchestratorIPCServer = null;
      delete process.env.MCP_CLIENT_IPC_URL;
    }

    // Unload model from memory if provider supports it (e.g., Ollama)
    if (this.modelProvider.unloadModel) {
      try {
        await this.modelProvider.unloadModel(this.model);
      } catch {
        // Best-effort during shutdown
      }
    }

    // Cleanup ROS2 video recording (in case it wasn't called earlier)
    await this.cleanupVideoRecording();

    const closePromises = Array.from(this.servers.values()).map((connection) =>
      connection.client.close().catch(() => {
        // Ignore errors during cleanup
      }),
    );
    await Promise.all(closePromises);
    this.servers.clear();
  }

  /**
   * Execute an MCP tool by name.
   * This is the public interface for tool execution, used by IPC server and other callers.
   *
   * @param toolName - The prefixed tool name (server-name__tool-name)
   * @param toolInput - The arguments to pass to the tool
   * @param fromIPC - Whether this call came from IPC (skip logging if true)
   * @returns The tool result with display text and full content blocks
   */
  async executeMCPTool(
    toolName: string,
    toolInput: Record<string, any>,
    fromIPC: boolean = false,
  ) {
    return await this.toolExecutor.executeMCPTool(toolName, toolInput, fromIPC);
  }

  /**
   * Inject a tool result directly into the conversation context.
   * This creates a synthetic tool_use/tool_result pair so the agent sees
   * the tool result without having called the tool itself.
   *
   * Useful for ablation studies where you want to inject tool results
   * from disabled tools or pre-computed results.
   *
   * @param toolName - Name of the tool (server__tool format)
   * @param toolInput - The arguments that were passed to the tool
   * @param result - The tool execution result to inject
   */
  injectToolResult(
    toolName: string,
    toolInput: Record<string, unknown>,
    result: { displayText: string; contentBlocks: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
  ): void {
    const textContent = result.contentBlocks
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n') || result.displayText;

    const argsStr = Object.keys(toolInput).length > 0 ? ` with args ${JSON.stringify(toolInput)}` : '';
    const message: Message = {
      role: 'user',
      content: `[Client hook executed ${toolName}${argsStr}]\nResult: ${textContent}`,
    };

    this.messages.push(message);

    // Log injected hook result to chat history
    this.chatHistoryManager.addUserMessage(message.content as string);
  }

  /**
   * Merges custom environment variables with default safe environment variables.
   */
  private mergeEnvironment(customEnv?: Record<string, string>): Record<string, string> {
    const defaultEnvVars = process.platform === 'win32'
      ? ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE']
      : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

    const mergedEnv: Record<string, string> = {};
    for (const key of defaultEnvVars) {
      const value = process.env[key];
      if (value !== undefined && !value.startsWith('()')) {
        mergedEnv[key] = value;
      }
    }

    // Add MCP_CLIENT_OUTPUT_DIR pointing to .mcp-client-data/outputs
    const outputsDir = join(CONFIG_DIR, 'outputs');
    if (!existsSync(outputsDir)) {
      mkdirSync(outputsDir, { recursive: true });
    }
    mergedEnv['MCP_CLIENT_OUTPUT_DIR'] = outputsDir;

    if (customEnv) {
      Object.assign(mergedEnv, customEnv);
    }

    return mergedEnv;
  }

  /**
   * Reloads the server configuration from mcp_config.json.
   * Updates this.serverConfigs with fresh values from disk.
   */
  private reloadConfigFromDisk(): boolean {
    if (!existsSync(MCP_CONFIG_FILE)) {
      this.logger.log('No mcp_config.json found, keeping existing config\n', { type: 'warning' });
      return false;
    }

    try {
      const content = readFileSync(MCP_CONFIG_FILE, 'utf-8');
      const config = JSON.parse(content);

      if (!config.mcpServers) {
        this.logger.log('Invalid config format: missing mcpServers\n', { type: 'warning' });
        return false;
      }

      // Build new server configs from file
      const newConfigs: MultiServerConfig[] = [];
      for (const [name, server] of Object.entries(config.mcpServers) as [string, any][]) {
        newConfigs.push({
          name,
          config: {
            command: server.command,
            args: server.args || [],
            env: this.mergeEnvironment(server.env),
          },
          disabledInConfig: server.disabled || false,
        });
      }

      this.serverConfigs = newConfigs;
      this.logger.log(`Reloaded config: ${newConfigs.length} server(s) found\n`, { type: 'info' });
      return true;
    } catch (error) {
      this.logger.log(`Error reading mcp_config.json: ${error}\n`, { type: 'error' });
      return false;
    }
  }

  /**
   * Reloads the server configuration from a specific config file path.
   * Updates this.serverConfigs with values from the specified file.
   * Used by ablation runs with custom MCP config paths.
   * @param configPath Absolute path to the MCP config file
   * @returns true if successful, false otherwise
   */
  reloadConfigFromPath(configPath: string): boolean {
    if (!existsSync(configPath)) {
      this.logger.log(`Config file not found: ${configPath}\n`, { type: 'warning' });
      return false;
    }

    try {
      const content = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);

      if (!config.mcpServers) {
        this.logger.log('Invalid config format: missing mcpServers\n', { type: 'warning' });
        return false;
      }

      // Build new server configs from file
      const newConfigs: MultiServerConfig[] = [];
      for (const [name, server] of Object.entries(config.mcpServers) as [string, any][]) {
        newConfigs.push({
          name,
          config: {
            command: server.command,
            args: server.args || [],
            env: this.mergeEnvironment(server.env),
          },
          disabledInConfig: server.disabled || false,
        });
      }

      this.serverConfigs = newConfigs;
      this.logger.log(`Reloaded config from ${configPath}: ${newConfigs.length} server(s) found\n`, { type: 'info' });
      return true;
    } catch (error) {
      this.logger.log(`Error reading config file ${configPath}: ${error}\n`, { type: 'error' });
      return false;
    }
  }

  async refreshServers() {
    // Reload config from disk to pick up any changes
    this.reloadConfigFromDisk();

    this.logger.log('Refreshing server connections...\n', { type: 'info' });

    // Close all existing server connections (keep IPC server running)
    const closePromises = Array.from(this.servers.values()).map((connection) =>
      connection.client.close().catch(() => {
        // Ignore errors during cleanup
      }),
    );
    await Promise.all(closePromises);
    this.servers.clear();

    const connectionErrors: Array<{ name: string; error: any }> = [];

    // Reconnect to ALL servers (disabled servers stay connected for direct
    // tool execution; agent visibility is controlled by initMCPTools filtering)
    for (const serverConfig of this.serverConfigs) {
      try {
        const label = serverConfig.disabledInConfig ? ' (disabled)' : '';
        this.logger.log(`Connecting to server "${serverConfig.name}"${label}...\n`, {
          type: 'info',
        });

        // Inject IPC URL into mcp-tools-orchestrator's environment
        const config = { ...serverConfig.config };
        if (serverConfig.name === 'mcp-tools-orchestrator' && process.env.MCP_CLIENT_IPC_URL) {
          config.env = {
            ...config.env,
            MCP_CLIENT_IPC_URL: process.env.MCP_CLIENT_IPC_URL,
          };
        }

        const client = new Client(
          { name: 'cli-client', version: '1.0.0' },
          { capabilities: { elicitation: { form: {} } } },
        );
        const transport = new StdioClientTransport(config);

        await client.connect(transport);

        // Register elicitation request handler
        client.setRequestHandler(ElicitRequestSchema, async (request: ElicitRequest) => {
          if (this.webElicitationCallback) return this.webElicitationCallback(request);
          return this.elicitationHandler.handleElicitation(request);
        });

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
      return;
    }

    // Log warnings for failed connections
    if (connectionErrors.length > 0) {
      this.logger.log(
        `Warning: ${connectionErrors.length} server(s) failed to connect, continuing with ${this.servers.size} server(s)\n`,
        { type: 'warning' },
      );
    }

    // Reinitialize tools and prompts from all successfully connected servers
    await this.initMCPTools();
    await this.initMCPPrompts();

    this.logger.log(
      `✓ Refreshed ${this.servers.size} server(s): ${Array.from(this.servers.keys()).join(', ')}\n`,
      { type: 'success' },
    );
  }

  /**
   * Refresh a specific server by name.
   */
  async refreshServer(serverName: string) {
    // Find the server config
    const serverConfig = this.serverConfigs.find((c) => c.name === serverName);
    if (!serverConfig) {
      throw new Error(`Server "${serverName}" not found in configuration`);
    }

    // Close the existing connection
    const existingConnection = this.servers.get(serverName);
    if (existingConnection) {
      try {
        await existingConnection.client.close().catch(() => {
          // Ignore errors during cleanup
        });
      } catch (error) {
        // Ignore
      }
      this.servers.delete(serverName);
    }

    // Reconnect to the server
    try {
      // Inject IPC URL into mcp-tools-orchestrator's environment
      const config = { ...serverConfig.config };
      if (serverName === 'mcp-tools-orchestrator' && process.env.MCP_CLIENT_IPC_URL) {
        config.env = {
          ...config.env,
          MCP_CLIENT_IPC_URL: process.env.MCP_CLIENT_IPC_URL,
        };
      }

      const client = new Client(
        { name: 'cli-client', version: '1.0.0' },
        { capabilities: { elicitation: { form: {} } } },
      );
      const transport = new StdioClientTransport(config);

      await client.connect(transport);

      // Register elicitation request handler
      client.setRequestHandler(ElicitRequestSchema, async (request: ElicitRequest) => {
        if (this.webElicitationCallback) return this.webElicitationCallback(request);
        return this.elicitationHandler.handleElicitation(request);
      });

      // Give the server process a moment to fully initialize
      await new Promise(resolve => setTimeout(resolve, 200));

      const connection: ServerConnection = {
        name: serverName,
        client,
        transport,
        tools: [],
        prompts: [],
      };

      this.servers.set(serverName, connection);

      // Reinitialize tools and prompts for just this server
      await this.initMCPTools();
      await this.initMCPPrompts();
    } catch (error) {
      throw new Error(`Failed to refresh server "${serverName}": ${error}`);
    }
  }

  private async initMCPTools() {
    const allTools: Tool[] = [];
    const allKnownToolNames = new Set<string>(); // Track ALL tool names across all servers (including disabled) for pruning
    const failedServerPrefixes = new Set<string>(); // Track servers that failed to load tools
    const serversWithTools = new Set<string>();

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

        // Track all tool names from all servers (including disabled) for pruning stale entries
        for (const tool of serverTools) {
          allKnownToolNames.add(tool.name);
        }

        // Check if this server was disabled in config
        const serverConfig = this.serverConfigs.find(cfg => cfg.name === serverName);
        const wasDisabledInConfig = serverConfig?.disabledInConfig || false;

        // Only expose tools if:
        // 1. Server was not disabled in config, OR
        // 2. Orchestrator mode is enabled and this is the mcp-tools-orchestrator server, OR
        // 3. Todo mode is enabled and this is the todo server
        const shouldExposeTool = !wasDisabledInConfig ||
          (this.orchestratorModeEnabled && serverName === 'mcp-tools-orchestrator') ||
          (this.todoManager.isEnabled() && serverName === this.todoManager.getServerName());

        // If orchestrator mode is enabled, only expose mcp-tools-orchestrator tools
        const shouldExposeInOrchestratorMode = !this.orchestratorModeEnabled || serverName === 'mcp-tools-orchestrator';

        if (serverTools.length > 0 && shouldExposeTool && shouldExposeInOrchestratorMode) {
          serversWithTools.add(serverName);
          allTools.push(...serverTools);
        }
      } catch (error) {
        failedServerPrefixes.add(`${serverName}__`);
        this.logger.log(
          `Failed to load tools from server "${serverName}": ${error}\n`,
          { type: 'warning' },
        );
      }
    }

    // Update state for new tools (set them to enabled by default)
    this.toolManager.updateStateForNewTools(allTools);

    // Prune stale tools that no longer exist on any connected server,
    // but skip tools belonging to servers that failed to load (preserve their states)
    this.toolManager.pruneStaleTools(allKnownToolNames, failedServerPrefixes);

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
        `Loaded ${enabledTools.length} enabled tool(s) from ${allTools.length} total tool(s) across ${serversWithTools.size} server(s)\n`,
        { type: 'info' },
      );
    }
  }

  private async initMCPPrompts() {
    let totalPrompts = 0;
    const allPrompts: Array<{ server: string; prompt: Prompt }> = [];
    const serversWithPrompts = new Set<string>();

    // Load prompts from each server
    for (const [serverName, connection] of this.servers.entries()) {
      try {
        const promptsResults = await connection.client.request(
          { method: 'prompts/list' },
          ListPromptsResultSchema,
        );

        connection.prompts = promptsResults.prompts || [];
        if (connection.prompts.length > 0) {
          serversWithPrompts.add(serverName);
          totalPrompts += connection.prompts.length;
          
          // Collect prompts for state management
          for (const prompt of connection.prompts) {
            allPrompts.push({ server: serverName, prompt });
          }
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

    // Prune stale prompts that no longer exist on any connected server
    const allKnownPromptKeys = new Set(allPrompts.map(p => `${p.server}__${p.prompt.name}`));
    this.promptManager.pruneStalePrompts(allKnownPromptKeys);

    if (totalPrompts > 0) {
      this.logger.log(
        `Loaded ${totalPrompts} prompt(s) across ${serversWithPrompts.size} server(s)\n`,
        { type: 'info' },
      );
    }
  }

  // Public method to get token usage status (for testing/debugging)
  getTokenUsage() {
    return this.tokenManager.getTokenUsage();
  }

  // Public method to manually trigger summarization (for testing)
  async manualSummarize(): Promise<void> {
    await this.tokenManager.manualSummarize();
  }

  // Public method to set test mode (lower threshold for easier testing)
  async setTestMode(enabled: boolean = true, testThreshold: number = 5) {
    await this.tokenManager.setTestMode(enabled, testThreshold);
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
    const todoServerName = this.todoManager.getServerName();

    // Check if todo server is configured in serverConfigs
    const todoConfig = this.serverConfigs.find(cfg => cfg.name === todoServerName);
    if (!todoConfig) {
      throw new Error('Todo server not configured. Please add "todo" server to mcp_config.json');
    }

    try {
      // Check if todo server is already connected (from initial start)
      if (this.servers.has(todoServerName)) {
        // Use existing connection
        const existingConnection = this.servers.get(todoServerName)!;
        this.todoManager.setConnection(existingConnection);
        this.todoManager.enable();
      } else {
        // Connect to todo server on-demand (even if it was disabled in config)
        this.logger.log(`Connecting to todo server...\n`, { type: 'info' });

        const client = new Client(
          { name: 'cli-client', version: '1.0.0' },
          { capabilities: { elicitation: { form: {} } } },
        );
        const transport = new StdioClientTransport(todoConfig.config);
        await client.connect(transport);

        // Register elicitation request handler
        client.setRequestHandler(ElicitRequestSchema, async (request: ElicitRequest) => {
          if (this.webElicitationCallback) return this.webElicitationCallback(request);
          return this.elicitationHandler.handleElicitation(request);
        });

        // Give the server process a moment to fully initialize
        await new Promise(resolve => setTimeout(resolve, 200));

        const connection: ServerConnection = {
          name: todoServerName,
          client,
          transport,
          tools: [],
          prompts: [],
        };

        this.servers.set(todoServerName, connection);
        this.todoManager.setConnection(connection);
        this.todoManager.enable();

        this.logger.log(`✓ Connected to todo server\n`, { type: 'info' });
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
   * Get the set of server names that are disabled in config.
   * These servers are connected (for direct tool execution) but their tools
   * are not exposed to the agent.
   */
  getDisabledServerNames(): Set<string> {
    const disabled = new Set<string>();
    for (const cfg of this.serverConfigs) {
      if (cfg.disabledInConfig) {
        disabled.add(cfg.name);
      }
    }
    return disabled;
  }

  /**
   * Get the prompt manager instance
   */
  getPromptManager(): PromptManager {
    return this.promptManager;
  }

  getPreferencesManager(): PreferencesManager {
    return this.preferencesManager;
  }

  getChatHistoryManager(): ChatHistoryManager {
    return this.chatHistoryManager;
  }

  getAttachmentManager(): AttachmentManager {
    return this.attachmentManager;
  }

  getHookManager(): HookManager {
    return this.hookManager;
  }

  /**
   * Get user turns from the conversation for rewind functionality.
   * Returns user messages from both the in-memory messages array and chat history.
   */
  getUserTurns(): Array<{ turnNumber: number; messageIndex: number; historyIndex: number; content: string; timestamp: string }> {
    const historyTurns = this.chatHistoryManager.getUserTurns();
    const messageTurns: Array<{ index: number; content: string }> = [];
    this.messages.forEach((msg, idx) => {
      if (msg.role === 'user') {
        messageTurns.push({ index: idx, content: msg.content });
      }
    });

    // Match user turns between messages array and history by order
    const turns: Array<{ turnNumber: number; messageIndex: number; historyIndex: number; content: string; timestamp: string }> = [];
    const count = Math.min(messageTurns.length, historyTurns.length);
    for (let i = 0; i < count; i++) {
      turns.push({
        turnNumber: i + 1,
        messageIndex: messageTurns[i].index,
        historyIndex: historyTurns[i].index,
        content: messageTurns[i].content,
        timestamp: historyTurns[i].timestamp,
      });
    }
    return turns;
  }

  /**
   * Rewind conversation to just before a specific user turn.
   * Removes the user message and everything after it from both
   * the in-memory messages array and the chat history session.
   */
  rewindToTurn(turn: { messageIndex: number; historyIndex: number }): void {
    // Truncate in-memory messages
    this.messages = this.messages.slice(0, turn.messageIndex);

    // Truncate chat history session
    this.chatHistoryManager.rewindToIndex(turn.historyIndex);

    // Reset token count (will be recalculated on next API call)
    this.currentTokenCount = 0;
  }

  /**
   * Save the current chat session and start a new one with empty context.
   * The current session is saved to disk (via endSession) before clearing.
   */
  clearContext(): void {
    // Save the current session if it has messages, otherwise discard
    if (this.messages.length > 0) {
      this.chatHistoryManager.endSession('context-cleared');
    } else {
      this.chatHistoryManager.discardSession();
    }

    // Clear all messages
    this.messages = [];

    // Reset token count
    this.currentTokenCount = 0;

    // Start a new session with the same model and servers
    const serverNames = Array.from(this.servers.keys());
    const enabledTools = this.toolManager.getEnabledTools(this.tools).map(t => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.input_schema,
    }));
    this.chatHistoryManager.startSession(this.model, serverNames, enabledTools);
  }

  /**
   * Switch the model provider and model for ablation studies
   * This clears the context and reinitializes the token counter
   */
  async switchProviderAndModel(provider: ModelProvider, model: string): Promise<void> {
    // Unload previous model from memory if provider supports it (e.g., Ollama)
    if (this.modelProvider.unloadModel) {
      await this.modelProvider.unloadModel(this.model);
    }

    // Update provider and model
    this.modelProvider = provider;
    this.model = model;
    this.chatHistoryManager.setProviderName(provider.getProviderName());

    // Reinitialize token counter for new model
    await this.tokenManager.reinitializeTokenCounter();

    // Clear context for fresh conversation
    this.clearContext();

    this.logger.log(`Switched to ${provider.getProviderName()}/${model}\n`, { type: 'info' });
  }

  /**
   * Switch the model provider and model while preserving conversation context.
   * Unlike switchProviderAndModel(), this does NOT clear messages.
   * Records the switch as a client event in chat history.
   */
  async switchModel(provider: ModelProvider, model: string): Promise<void> {
    // Unload previous model from memory if provider supports it (e.g., Ollama)
    if (this.modelProvider.unloadModel) {
      await this.modelProvider.unloadModel(this.model);
    }

    const prevProvider = this.modelProvider.getProviderName();
    const prevModel = this.model;

    // Update provider and model
    this.modelProvider = provider;
    this.model = model;
    this.chatHistoryManager.setProviderName(provider.getProviderName());
    this.chatHistoryManager.setActiveModel(model);

    // Reinitialize token counter for new model's context window
    await this.tokenManager.reinitializeTokenCounter();

    // Record the switch as a client event in the conversation (no context clear)
    this.chatHistoryManager.addClientMessage(
      `[Model switched from ${prevProvider}/${prevModel} to ${provider.getProviderName()}/${model}]`
    );

    this.logger.log(`Switched to ${provider.getProviderName()}/${model}\n`, { type: 'info' });
  }

  /**
   * Get the current model name
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Set the readline interface for elicitation handling.
   * This prevents double input capture when CLI already has a readline active.
   */
  setReadlineInterface(rl: readline.Interface | null): void {
    this.elicitationHandler.setExternalReadline(rl);
  }

  /**
   * Set callbacks for elicitation start/end events.
   * Used by CLI to pause keyboard monitoring during elicitation.
   */
  setElicitationCallbacks(onStart: () => void, onEnd: () => void): void {
    this.elicitationHandler.setElicitationCallbacks(onStart, onEnd);
  }

  /**
   * Set callback for force stop prompts.
   * Called when a tool call exceeds the force stop timeout (15 seconds after abort is requested).
   * The callback should prompt the user and return true to force stop, false to continue waiting.
   * @param callback - Receives toolName, elapsedSeconds, and optional abortSignal (fires when tool completes)
   */
  setForceStopCallback(callback: (toolName: string, elapsedSeconds: number, abortSignal?: AbortSignal) => Promise<boolean>): void {
    this.forceStopCallback = callback;
  }

  /**
   * Set callback to check if abort has been requested.
   * The force stop timer only starts AFTER abort is requested.
   */
  setAbortRequestedCallback(callback: () => boolean): void {
    this.isAbortRequestedCallback = callback;
  }

  /**
   * Set callback for tool approval before execution.
   * Called before first tool, and before each tool if persistent mode enabled.
   * Returns 'execute' to proceed, or rejection with optional message.
   */
  setToolApprovalCallback(callback: (toolName: string, toolInput: Record<string, any>) => Promise<'execute' | { decision: 'reject'; message?: string }>): void {
    this.toolApprovalCallback = callback;
  }

  /**
   * Set callback for web-mode elicitation handling.
   * When set, MCP elicitation requests are routed to this callback instead of readline.
   */
  setWebElicitationCallback(callback: (request: ElicitRequest) => Promise<import('@modelcontextprotocol/sdk/types.js').ElicitResult>): void {
    this.webElicitationCallback = callback;
  }

  /**
   * Set whether to disable chat history recording.
   * Used during tool replay mode to prevent IPC calls from being recorded.
   */
  setDisableHistoryRecording(disable: boolean): void {
    this._disableHistoryRecording = disable;
  }

  /**
   * Save current chat state (messages and session) for later restoration
   * Used by ablation to preserve the original chat while running tests
   */
  saveState(): { messages: Message[]; tokenCount: number; chatSession: { session: ChatSession; startTime: Date; toolUseCount: number } | null } {
    // Pause the chat history session (preserves state in memory without saving to disk)
    const chatSession = this.chatHistoryManager.pauseSession();

    return {
      messages: [...this.messages],
      tokenCount: this.currentTokenCount,
      chatSession,
    };
  }

  /**
   * Restore chat state after ablation completes
   * Optionally accepts provider/model to restore to original configuration
   */
  async restoreState(
    state: { messages: Message[]; tokenCount: number; chatSession: { session: ChatSession; startTime: Date; toolUseCount: number } | null },
    provider?: ModelProvider,
    model?: string
  ): Promise<void> {
    // Restore provider and model if provided
    if (provider && model) {
      this.modelProvider = provider;
      this.model = model;
      this.chatHistoryManager.setProviderName(provider.getProviderName());
      // Reinitialize token counter for restored model
      await this.tokenManager.reinitializeTokenCounter();
    }

    // Restore messages
    this.messages = state.messages;
    this.currentTokenCount = state.tokenCount;

    // Resume the original chat history session (preserves all pre-ablation messages)
    if (state.chatSession) {
      this.chatHistoryManager.resumeSession(state.chatSession);
    }

    if (this.messages.length > 0) {
      this.logger.log(`Restored chat with ${this.messages.length} messages\n`, { type: 'info' });
    }
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
   * Enable orchestrator mode - only expose mcp-tools-orchestrator tools, hide all others
   */
  async enableOrchestratorMode(): Promise<void> {
    // Check if mcp-tools-orchestrator is configured
    const orchestratorConfig = this.serverConfigs.find(cfg => cfg.name === 'mcp-tools-orchestrator');
    if (!orchestratorConfig) {
      throw new Error('mcp-tools-orchestrator server not found in configuration. Cannot enable orchestrator mode.');
    }

    // Start IPC server if not already started (required for mcp-tools-orchestrator)
    if (!this.orchestratorIPCServer) {
      this.orchestratorIPCServer = new OrchestratorIPCServer(this, this.logger);
      try {
        const port = await this.orchestratorIPCServer.start();
        // Export IPC URL via environment variable for mcp-tools-orchestrator to discover
        process.env.MCP_CLIENT_IPC_URL = `http://localhost:${port}`;
        this.logger.log(
          `Orchestrator IPC enabled: ${process.env.MCP_CLIENT_IPC_URL}\n`,
          { type: 'info' },
        );
        // Setup event listeners to log IPC tool calls
        this.setupIPCEventListeners();
      } catch (error) {
        this.logger.log(
          `Failed to start Orchestrator IPC server: ${error}\n`,
          { type: 'warning' },
        );
        throw new Error(`Failed to start Orchestrator IPC server: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Connect to mcp-tools-orchestrator if not already connected (e.g., if it was disabled)
    if (!this.servers.has('mcp-tools-orchestrator')) {
      try {
        this.logger.log(`Connecting to mcp-tools-orchestrator server...\n`, { type: 'info' });
        
        // Inject IPC URL into mcp-tools-orchestrator's environment
        const config = { ...orchestratorConfig.config };
        if (process.env.MCP_CLIENT_IPC_URL) {
          config.env = {
            ...config.env,
            MCP_CLIENT_IPC_URL: process.env.MCP_CLIENT_IPC_URL,
          };
        }
        
        const client = new Client(
          { name: 'cli-client', version: '1.0.0' },
          { capabilities: { elicitation: { form: {} } } },
        );
        const transport = new StdioClientTransport(config);
        await client.connect(transport);

        // Register elicitation request handler
        client.setRequestHandler(ElicitRequestSchema, async (request: ElicitRequest) => {
          if (this.webElicitationCallback) return this.webElicitationCallback(request);
          return this.elicitationHandler.handleElicitation(request);
        });

        // Give the server process a moment to fully initialize
        await new Promise(resolve => setTimeout(resolve, 200));

        const connection: ServerConnection = {
          name: 'mcp-tools-orchestrator',
          client,
          transport,
          tools: [],
          prompts: [],
        };

        this.servers.set('mcp-tools-orchestrator', connection);
        this.logger.log(`✓ Connected to "mcp-tools-orchestrator"\n`, { type: 'info' });
        
        // Initialize tools from the newly connected server
        await this.initMCPTools();
      } catch (error) {
        throw new Error(`Failed to connect to mcp-tools-orchestrator server: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.orchestratorModeEnabled = true;

    // Reload tools with orchestrator mode filtering
    await this.initMCPTools();

    this.logger.log('\n✓ Orchestrator mode enabled\n', { type: 'info' });
  }

  /**
   * Disable orchestrator mode - restore all enabled server tools
   */
  async disableOrchestratorMode(): Promise<void> {
    this.orchestratorModeEnabled = false;

    // Reload tools without orchestrator mode filtering
    await this.initMCPTools();

    this.logger.log('\n✓ Orchestrator mode disabled\n', { type: 'info' });
  }

  /**
   * Check if orchestrator mode is enabled
   */
  isOrchestratorModeEnabled(): boolean {
    return this.orchestratorModeEnabled;
  }

  /**
   * Check if mcp-tools-orchestrator server is configured
   */
  isOrchestratorServerConfigured(): boolean {
    return this.serverConfigs.some(cfg => cfg.name === 'mcp-tools-orchestrator');
  }

  /**
   * Get the orchestrator IPC server instance
   */
  getOrchestratorIPCServer(): OrchestratorIPCServer | null {
    return this.orchestratorIPCServer;
  }

  /**
   * Setup event listeners for IPC server to log tool calls
   */
  private setupIPCEventListeners(): void {
    if (!this.orchestratorIPCServer) return;

    // Prevent duplicate listener registration
    if (this.ipcListenersSetup) {
      return;
    }

    // Remove any existing listeners to prevent duplicates
    this.orchestratorIPCServer.removeAllListeners('toolCallStart');
    this.orchestratorIPCServer.removeAllListeners('toolCallEnd');

    // Listen for IPC tool calls starting
    this.orchestratorIPCServer.on('toolCallStart', (event: any) => {
      // Display tool call in terminal with magenta/pink colors
      const formattedCall = formatToolCall(event.toolName, event.args, true);
      this.logger.log(formattedCall);
      
      // Track tool input time for IPC calls
      // Use tool name + timestamp as key, and store input time
      // We'll match it in toolCallEnd by finding the most recent unused entry
      const inputTime = new Date().toISOString();
      const toolKey = `ipc_${event.toolName}_${Date.now()}`;
      this.toolInputTimes.set(toolKey, inputTime);
    });

    // Listen for IPC tool calls ending
    this.orchestratorIPCServer.on('toolCallEnd', (event: any) => {
      // Format result for display and logging (convert objects to JSON)
      const resultStr = typeof event.result === 'string'
        ? event.result
        : formatCompactJSON(event.result);

      // Display result in terminal
      if (event.error) {
        this.logger.log(`Error: ${event.error}\n`, { type: 'error' });
      } else {
        // Display result with indentation
        const lines = resultStr.split('\n');
        for (const line of lines) {
          const indented = '  ' + line;
          this.logger.log(indented + '\n', { type: 'success' });
        }
      }

      // Retrieve tool input time - find the most recent entry for this tool name
      let toolInputTime: string | undefined;
      const toolPrefix = `ipc_${event.toolName}_`;
      let latestKey: string | undefined;
      let latestTime = 0;
      
      for (const [key, time] of this.toolInputTimes.entries()) {
        if (key.startsWith(toolPrefix)) {
          const timestamp = parseInt(key.split('_').pop() || '0');
          if (timestamp > latestTime) {
            latestTime = timestamp;
            latestKey = key;
            toolInputTime = time;
          }
        }
      }
      
      // Clean up the used entry
      if (latestKey) {
        this.toolInputTimes.delete(latestKey);
      }

      // Log to chat history (use stringified result to avoid [object Object])
      // Skip recording if history recording is disabled (e.g., during tool replay)
      if (!this._disableHistoryRecording) {
        this.chatHistoryManager.addToolExecution(
          event.toolName,
          event.args || {},
          event.error || resultStr || '',
          true, // orchestratorMode - IPC calls are in orchestrator mode
          true, // isIPCCall - this is an automatic IPC call
          toolInputTime, // Pass the input time
        );
      }
    });

    // Mark listeners as set up
    this.ipcListenersSetup = true;
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
    observer?: StreamObserver,
  ): Promise<{
    pendingToolResults: Array<{ toolUseId?: string; toolCallId?: string; content: string }>;
    lastTokenUsage: {
      inputTokens: number;
      outputTokens: number;
      regularInputTokens?: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
      ollamaMetrics?: {
        totalDuration?: number;
        loadDuration?: number;
        evalDuration?: number;
        promptEvalDuration?: number;
        evalRate?: number;
        promptEvalRate?: number;
      };
    } | null;
    deferredHookData: Array<{ toolName: string; result: string; toolInput?: Record<string, unknown> }>;
  }> {
    this.logger.log(consoleStyles.assistant);

    let currentMessage = '';
    let currentThinking = '';
    let thinkingStarted = false;
    let messageStarted = false;
    let hasOutputContent = false; // Track if we've output any content after "Assistant:"
    // Collect tool completions for deferred hook processing after agent response
    const deferredHookData: Array<{ toolName: string; result: string; toolInput?: Record<string, unknown> }> = [];

    // Track tool results to add to messages
    const pendingToolResults: Array<{
      toolUseId?: string;
      toolCallId?: string;
      content: string;
    }> = [];

    const isAnthropic = this.modelProvider.getProviderName() === 'anthropic';

    // Track pending tool calls for OpenAI (to build tool_calls array for assistant message)
    // OpenAI requires assistant messages to have tool_calls before tool role messages
    const pendingToolCalls = new Map<string, { id: string; name: string; arguments: string }>();

    // Track token usage per callback
    let tokenCountBeforeCallback = initialTokenCount !== undefined ? initialTokenCount : this.currentTokenCount;
    let lastTokenUsage: {
      inputTokens: number;
      outputTokens: number;
      regularInputTokens?: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
      // Ollama-specific metrics
      ollamaMetrics?: {
        totalDuration?: number;
        loadDuration?: number;
        evalDuration?: number;
        promptEvalDuration?: number;
        evalRate?: number;
        promptEvalRate?: number;
      };
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
        observer?.({ type: 'warning', message: `Maximum iterations reached (${chunk.iterations}/${chunk.maxIterations}). Stopping agent loop.` });
        continue;
      }

      // Handle client_info events (provider-generated messages for user)
      if (chunk.type === 'client_info') {
        // Display with distinct styling to differentiate from model output
        const provider = chunk.provider ? `[${chunk.provider}] ` : '';
        this.logger.log(`\nℹ️  ${provider}${chunk.message}\n`, { type: 'info' });
        observer?.({ type: 'info', message: `${provider}${chunk.message}` });
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

        const isCancelledTool = chunk.result === '[Tool execution cancelled by user]'
          || chunk.result === '[Tool execution cancelled - abort requested]';
        observer?.({
          type: 'tool_complete',
          toolName: chunk.toolName,
          toolInput: (chunk as any).toolInput || {},
          result: chunk.result || '',
          toolId: (chunk as any).toolUseId || (chunk as any).toolCallId || '',
          ...(isCancelledTool && { cancelled: true }),
        });

        // Track tool result to add to messages
        // For Anthropic: Tool results will be added when we see the next assistant message or end_turn
        // For OpenAI: Add tool message immediately (assistant message with tool_calls was already added at message_stop)
        if (isAnthropic && chunk.toolUseId) {
          pendingToolResults.push({
            toolUseId: chunk.toolUseId,
            content: chunk.result || '',
          });
        } else if (!isAnthropic && chunk.toolCallId) {
          // Non-Anthropic: add tool message immediately after tool_use_complete
          // The assistant message with tool_calls was already added at message_stop
          const toolMessage: Message = {
            role: 'tool',
            tool_call_id: chunk.toolCallId,
            tool_name: chunk.toolName, // Include tool_name for Gemini (uses name-based matching)
            content: chunk.result || '',
          };
          this.messages.push(toolMessage);
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
                const formatted = formatCompactJSON(parsed);
                const colored = formatJSON(formatted);
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
              const formatted = formatCompactJSON(parsed);
              // Apply color formatting and truncate if needed (increased limit to 10000)
              const colored = formatJSON(formatted);
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
        // Retrieve tool input time if available (from tool_use start event)
        const toolId = (chunk as any).toolUseId || (chunk as any).toolCallId;
        const toolInputTime = toolId ? this.toolInputTimes.get(toolId) : undefined;
        if (toolId) {
          this.toolInputTimes.delete(toolId); // Clean up
        }
        
        // Log tool execution to history
        // TODO: Persist tool result images for chat restore.
        // Currently, image base64 data from tool results (chunk.hasImages) is lost on save.
        this.chatHistoryManager.addToolExecution(
          chunk.toolName,
          chunk.toolInput || {},
          chunk.result || '',
          this.orchestratorModeEnabled, // Track if tool was called in orchestrator mode
          false, // isIPCCall - regular tool calls
          toolInputTime, // Pass the input time
          toolId, // Pass the tool_use_id for pairing with assistant's tool_use block
        );

        // Collect tool completion data for deferred hook processing after agent response.
        // Conditional hooks and @tool: hooks fire after the agent's full response ends,
        // not mid-stream (providers copy messages, so mid-stream injection is invisible).
        if (this.hookManager) {
          deferredHookData.push({
            toolName: chunk.toolName,
            result: chunk.result || '',
            toolInput: (chunk as any).toolInput,
          });
        }

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
        // Track tool input time when tool_use starts
        if (chunk.content_block?.type === 'tool_use' && chunk.content_block?.id) {
          const toolId = chunk.content_block.id;
          this.toolInputTimes.set(toolId, new Date().toISOString());

          // For Anthropic: emit tool_start immediately so the web UI can show the
          // tool card while it's still executing. The tool name and id are available
          // at content_block_start time; input will be empty (filled by input_json_delta
          // later) but the UI just needs to know a tool is running.
          if (isAnthropic && observer) {
            const inputArgs = chunk.content_block.input;
            let parsedInput: Record<string, any> = {};
            if (inputArgs) {
              parsedInput = typeof inputArgs === 'object' ? inputArgs as Record<string, any> : {};
            }
            observer({
              type: 'tool_start',
              toolName: chunk.content_block.name || '',
              toolInput: parsedInput,
              toolId,
            });
          }

          // For non-Anthropic providers: track tool calls to include in assistant message
          // OpenAI requires assistant messages to have tool_calls before tool role messages
          // Gemini provides args upfront in content_block_start (not via streaming deltas)
          if (!isAnthropic) {
            const inputArgs = chunk.content_block.input;
            pendingToolCalls.set(toolId, {
              id: toolId,
              name: chunk.content_block.name || '',
              arguments: inputArgs
                ? (typeof inputArgs === 'string' ? inputArgs : JSON.stringify(inputArgs))
                : '',
            });
          }
        }
        continue;
      }

      // Handle thinking/reasoning content from all providers
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'thinking_delta') {
        const thinkingText = chunk.delta.thinking;
        currentThinking += thinkingText;
        if (!thinkingStarted) {
          thinkingStarted = true;
        }
        this.logger.log(chalk.dim(thinkingText));
        observer?.({ type: 'thinking_delta', text: thinkingText });
        hasOutputContent = true;
        continue;
      }

      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        // Separator between thinking and regular text
        if (thinkingStarted && currentMessage === '') {
          this.logger.log('\n');
          thinkingStarted = false;
        }
        // Accumulate text from OpenAI streaming
        // Text will appear on the same line as "Assistant:" if it's the first content
        currentMessage += chunk.delta.text;
        if (process.env.VERBOSE_LOGGING && chunk.delta.text.length > 10) {
          this.logger.log(`\n[DEBUG] Text delta: "${chunk.delta.text.substring(0, 20)}..."\n`, { type: 'info' });
        }
        this.logger.log(chunk.delta.text);
        observer?.({ type: 'text_delta', text: chunk.delta.text });
        hasOutputContent = true;
        continue;
      }

      // Handle tool argument deltas for OpenAI
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'input_json_delta') {
        // For OpenAI: accumulate tool arguments
        // The tool_call_id comes from the content_block_start event
        // Find the most recently added pending tool call and append arguments
        if (!isAnthropic && pendingToolCalls.size > 0) {
          // Get the last added tool call (Map maintains insertion order)
          const lastToolCall = Array.from(pendingToolCalls.values()).pop();
          if (lastToolCall) {
            lastToolCall.arguments += chunk.delta.partial_json || '';
          }
        }
        continue;
      }

      // Handle token usage from OpenAI, Anthropic, and Ollama (exact counts from API)
      if (chunk.type === 'token_usage' && chunk.input_tokens !== undefined) {
        // Store token usage for this callback
        lastTokenUsage = {
          inputTokens: chunk.input_tokens,
          outputTokens: chunk.output_tokens,
        };

        // Extract cache token breakdown if available (from Anthropic/OpenAI)
        if ((chunk as any).input_tokens_breakdown) {
          const breakdown = (chunk as any).input_tokens_breakdown;
          lastTokenUsage.regularInputTokens = breakdown.input_tokens || 0;
          lastTokenUsage.cacheCreationTokens = breakdown.cache_creation_input_tokens || 0;
          lastTokenUsage.cacheReadTokens = breakdown.cache_read_input_tokens || 0;
        } else if (this.modelProvider.getProviderName() === 'google') {
          // Fallback for Gemini when breakdown not provided (e.g. createMessageStream path)
          lastTokenUsage.regularInputTokens = chunk.input_tokens;
          lastTokenUsage.cacheCreationTokens = 0;
          lastTokenUsage.cacheReadTokens = 0;
        }

        // Extract Ollama-specific metrics if available
        if ((chunk as any).ollama_metrics) {
          lastTokenUsage.ollamaMetrics = (chunk as any).ollama_metrics;
        }

        // Update cumulative token count by REPLACING (not adding)
        // For Anthropic, input_tokens already includes the full conversation history
        // input_tokens = all messages sent to API, output_tokens = tokens generated in this response
        this.currentTokenCount = chunk.input_tokens + chunk.output_tokens;
        observer?.({
          type: 'token_usage',
          inputTokens: chunk.input_tokens,
          outputTokens: chunk.output_tokens,
          totalTokens: chunk.input_tokens + chunk.output_tokens,
        });
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

        // For Anthropic: Skip creating message here UNLESS we're aborting
        // When aborting, we need to save currentMessage because complete response might not arrive
        // For OpenAI: Always create the message since there's no separate complete response
        // Also create message if there are pending tool calls (assistant may call tools without text)
        const isAborting = cancellationCheck && cancellationCheck();
        const hasToolCalls = !isAnthropic && pendingToolCalls.size > 0;
        if ((currentMessage.trim() || hasToolCalls) && (!isAnthropic || isAborting)) {
          // Build tool_calls array for OpenAI from pending tool calls
          const toolCallsArray = hasToolCalls
            ? Array.from(pendingToolCalls.values()).map(tc => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
              }))
            : undefined;

          // Emit tool_start for non-Anthropic tool calls (args are now finalized)
          if (observer && toolCallsArray) {
            for (const tc of toolCallsArray) {
              let parsedInput: Record<string, any> = {};
              try { parsedInput = JSON.parse(tc.arguments); } catch { /* ignore */ }
              observer({
                type: 'tool_start',
                toolName: tc.name,
                toolInput: parsedInput,
                toolId: tc.id,
              });
            }
          }

          // Build content_blocks for providers that need them (Gemini uses function_call format)
          // This also serves as the canonical format for chat history storage
          let contentBlocks: Array<{ type: string; [key: string]: any }> | undefined;
          if (hasToolCalls && toolCallsArray) {
            contentBlocks = [];
            if (currentMessage.trim()) {
              contentBlocks.push({ type: 'text', text: currentMessage });
            }
            const isGemini = this.modelProvider.getProviderName() === 'google';
            for (const tc of toolCallsArray) {
              let parsedInput: any = {};
              if (typeof tc.arguments === 'string' && tc.arguments.trim()) {
                try {
                  parsedInput = JSON.parse(tc.arguments);
                } catch {
                  // Arguments may be incomplete or malformed during streaming
                  parsedInput = { _raw: tc.arguments };
                }
              } else if (typeof tc.arguments === 'object') {
                parsedInput = tc.arguments;
              }
              // Use function_call type for Gemini (matches convertMessagesToGeminiFormat),
              // tool_use type for others (canonical format)
              contentBlocks.push(isGemini
                ? { type: 'function_call', name: tc.name, args: parsedInput, id: tc.id }
                : { type: 'tool_use', id: tc.id, name: tc.name, input: parsedInput }
              );
            }
          }

          const assistantMessage: Message = {
            role: 'assistant',
            content: currentMessage,
            ...(currentThinking && { thinking: currentThinking }),
            // Include tool_calls for OpenAI (required before tool role messages)
            tool_calls: toolCallsArray,
            // Include content_blocks for Gemini (convertMessagesToGeminiFormat reads function_call blocks)
            // and for general context preservation across turns
            content_blocks: contentBlocks,
          };
          // For Anthropic end_turn, the complete response handler (below) pushes
          // the richer assistantMessage built from chunk.content. Only push here
          // for non-Anthropic providers (always) and Anthropic tool_use (where
          // the complete response handler doesn't fire).
          if (!isAnthropic || hasToolCalls) {
            this.messages.push(assistantMessage);
          }

          // Save assistant messages to chat history
          // For non-Anthropic providers, this is the only place messages get persisted
          // (Anthropic saves via the complete response handler at chunk.content path below)
          if (!isAnthropic) {
            if (hasToolCalls && contentBlocks) {
              this.chatHistoryManager.addAssistantMessage(currentMessage, contentBlocks, currentThinking || undefined);
            } else if (currentMessage.trim()) {
              // Also log text-only responses (no tool calls) so they appear in chat history
              this.chatHistoryManager.addAssistantMessage(currentMessage, undefined, currentThinking || undefined);
            }
          }

          // Clear pending tool calls after adding to message
          if (hasToolCalls) {
            pendingToolCalls.clear();
          }

          // Note: For OpenAI, tool results are added immediately at tool_use_complete events
          // (tools execute AFTER message_stop, so pendingToolResults would be empty here)

          // Token counts come from token_usage events (line ~2469) for all providers

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
          } else if (this.modelProvider.getProviderName() === 'ollama' && lastTokenUsage) {
            // Ollama: use exact counts from API with Ollama-specific metrics
            const totalTokens = lastTokenUsage.inputTokens + lastTokenUsage.outputTokens;
            this.chatHistoryManager.addTokenUsagePerCallback(
              lastTokenUsage.inputTokens,
              lastTokenUsage.outputTokens,
              totalTokens,
              undefined, // regularInputTokens - not applicable for Ollama
              undefined, // cacheCreationTokens - not applicable for Ollama
              undefined, // cacheReadTokens - not applicable for Ollama
              lastTokenUsage.ollamaMetrics
            );
            lastTokenUsage = null; // Reset after logging
            tokenCountBeforeCallback = this.currentTokenCount; // Update for next callback
          } else if (this.modelProvider.getProviderName() === 'google' && lastTokenUsage) {
            // Google (Gemini): use exact counts from API (output includes thinking tokens)
            const totalTokens = lastTokenUsage.inputTokens + lastTokenUsage.outputTokens;
            this.chatHistoryManager.addTokenUsagePerCallback(
              lastTokenUsage.inputTokens,
              lastTokenUsage.outputTokens,
              totalTokens,
              lastTokenUsage.regularInputTokens,
              lastTokenUsage.cacheCreationTokens,
              lastTokenUsage.cacheReadTokens,
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
        if (this.tokenManager.shouldSummarize()) {
          await this.tokenManager.autoSummarize();
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

        // tool_start for Anthropic is now emitted at content_block_start time
        // (during streaming, before tool execution) so the web UI shows tools
        // as running immediately rather than after they complete.

        // Extract text content (but don't display it - it was already streamed in real-time)
        const textBlocks = chunk.content.filter((block: any) => block.type === 'text');
        const textContent = textBlocks.length > 0
          ? textBlocks.map((block: any) => block.text).join('\n')
          : '';

        // Debug: Check if this is being called (should NOT log text here)
        if (textContent && process.env.VERBOSE_LOGGING) {
          this.logger.log(`\n[DEBUG] Complete response received, NOT logging text (length: ${textContent.length})\n`, { type: 'info' });
        }
        
        // Extract thinking content from Anthropic response
        const anthropicThinking = (chunk.content as any[])
          .filter((block: any) => block.type === 'thinking')
          .map((block: any) => block.thinking)
          .join('\n') || undefined;

        // Add assistant message to messages (with tool_use blocks if present)
        // This ensures tool calls are preserved in conversation context
        const assistantMessage: Message = {
          role: 'assistant',
          content: textContent,
          ...(anthropicThinking && { thinking: anthropicThinking }),
          content_blocks: chunk.content, // Preserve full content including tool_use blocks
        };
        this.messages.push(assistantMessage);

        // Save assistant message to chat history (preserving content_blocks for proper restore)
        this.chatHistoryManager.addAssistantMessage(textContent, chunk.content, anthropicThinking);
        
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
            // OpenAI: add tool role messages (must follow assistant message with matching tool_calls)
            // Find the last assistant message with tool_calls
            let lastAssistantIdx = this.messages.length - 1;
            while (lastAssistantIdx >= 0) {
              const msg = this.messages[lastAssistantIdx];
              if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                const toolCallIds = new Set(msg.tool_calls.map((tc: any) => tc.id));
                const validToolResults = pendingToolResults.filter(tr =>
                  tr.toolCallId && toolCallIds.has(tr.toolCallId)
                );

                for (const tr of validToolResults) {
                  const toolMessage: Message = {
                    role: 'tool',
                    tool_call_id: tr.toolCallId!,
                    content: tr.content,
                  };
                  this.messages.push(toolMessage);
                }
                break;
              }
              lastAssistantIdx--;
            }
            // Clear pending results after adding them
            pendingToolResults.length = 0;
          }
        }
        
        // Token counts come from token_usage events (line ~2469) for all providers

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
        } else if (this.modelProvider.getProviderName() === 'ollama' && lastTokenUsage) {
          // Ollama: use exact counts from API with Ollama-specific metrics
          const totalTokens = lastTokenUsage.inputTokens + lastTokenUsage.outputTokens;
          this.chatHistoryManager.addTokenUsagePerCallback(
            lastTokenUsage.inputTokens,
            lastTokenUsage.outputTokens,
            totalTokens,
            undefined,
            undefined,
            undefined,
            lastTokenUsage.ollamaMetrics
          );
          lastTokenUsage = null; // Reset after logging
          tokenCountBeforeCallback = this.currentTokenCount; // Update for next callback
        }

        // Note: hooks are executed by the caller after the agent's response completes.

        // Check if we need to summarize after this response
        if (this.tokenManager.shouldSummarize()) {
          await this.tokenManager.autoSummarize();
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
              // OpenAI: add tool role messages (must follow assistant message with matching tool_calls)
              let lastAssistantIdx = this.messages.length - 1;
              while (lastAssistantIdx >= 0) {
                const msg = this.messages[lastAssistantIdx];
                if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                  const toolCallIds = new Set(msg.tool_calls.map((tc: any) => tc.id));
                  const validToolResults = pendingToolResults.filter(tr =>
                    tr.toolCallId && toolCallIds.has(tr.toolCallId)
                  );

                  for (const tr of validToolResults) {
                    const toolMessage: Message = {
                      role: 'tool',
                      tool_call_id: tr.toolCallId!,
                      content: tr.content,
                    };
                    this.messages.push(toolMessage);
                  }
                  break;
                }
                lastAssistantIdx--;
              }
            }
            pendingToolResults.length = 0;
          }
          break;
        }
      }
    }

    // Return remaining state so caller can flush/log appropriately
    return { pendingToolResults, lastTokenUsage, deferredHookData };
  }

  async processQuery(query: string, isSystemPrompt: boolean = false, attachments?: Array<{ path: string; fileName: string; ext: string; mediaType: string }>, cancellationCheck?: () => boolean, observer?: StreamObserver) {
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
      if (this.tokenManager.shouldSummarize()) {
        await this.tokenManager.autoSummarize();
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
      await this.tokenManager.ensureTokenCounter();
      this.currentTokenCount += this.tokenManager.getTokenCounter()!.countMessageTokens(userMessage);

      // Check again after adding message
      if (this.tokenManager.shouldSummarize()) {
        await this.tokenManager.autoSummarize();
      }

      // Define how to execute MCP tools (callback for the provider)
      const toolExecutor: ToolExecutor = async (
        toolName: string,
        toolInput: Record<string, any>,
      ) => {
        return await this.toolExecutor.executeMCPTool(toolName, toolInput);
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

      // Set thinking config on provider before streaming
      if (this.modelProvider.setThinkingConfig) {
        const thinkingEnabled = this.preferencesManager.getThinkingEnabled();
        const modelSupportsThinking = isReasoningModel(this.model, this.modelProvider.getProviderName());
        const thinkingLevel = this.preferencesManager.getThinkingLevel();
        this.modelProvider.setThinkingConfig({
          enabled: thinkingEnabled && modelSupportsThinking,
          model: this.model,
          level: thinkingLevel,
        });
      }

      // Helper: create stream and process it
      const createAndProcessStream = async () => {
        // Ensure max_tokens exceeds thinking budget (Anthropic requires budget_tokens < max_tokens)
        let maxTokens = 8192;
        const providerName = this.modelProvider.getProviderName();
        if (providerName === 'anthropic' && this.preferencesManager.getThinkingEnabled()) {
          const level = this.preferencesManager.getThinkingLevel() as string;
          const budgetMap: Record<string, number> = { small: 5000, medium: 10000, large: 25000 };
          const budget = budgetMap[level] || budgetMap.medium;
          if (maxTokens <= budget) {
            maxTokens = budget + 4096; // Ensure room for the actual response
          }
        }

        const s = (this.modelProvider as any).createMessageStreamWithToolUse(
          this.messages,
          this.model,
          this.tools,
          maxTokens,
          toolExecutor,
          (() => {
            const maxIter = this.preferencesManager.getMaxIterations();
            // -1 means unlimited, use a very large number
            return maxIter === -1 ? 999999 : maxIter;
          })(), // maxIterations
          cancellationCheck, // Pass cancellation check to provider
        );
        return await this.processToolUseStream(s, cancellationCheck, tokenCountBeforeStream, observer);
      };

      // Detect thinking-related API errors (model rejects thinking/reasoning parameters)
      const isThinkingError = (err: any): boolean => {
        const msg = (err?.message || String(err)).toLowerCase();
        const patterns = ['budget_tokens', 'thinking', 'reasoning', 'extended_thinking', 'thinkingbudget', 'includethoughts'];
        const triggers = ['not supported', 'invalid_request', 'invalid', 'unsupported', 'unknown'];
        return patterns.some(p => msg.includes(p)) && triggers.some(t => msg.includes(t));
      };

      // Process the stream with thinking error fallback
      // If the model rejects thinking parameters, auto-disable thinking and retry once
      let streamResult: { pendingToolResults: any; lastTokenUsage: any; deferredHookData: any };
      try {
        streamResult = await createAndProcessStream();
      } catch (thinkingErr: any) {
        if (isThinkingError(thinkingErr) && this.preferencesManager.getThinkingEnabled()) {
          // Auto-disable thinking and retry
          this.preferencesManager.setThinkingEnabled(false);
          this.logger.log(
            '\n⚠️  Thinking mode disabled — model rejected thinking parameters. Retrying...\n',
            { type: 'warning' },
          );
          observer?.({ type: 'warning', message: 'Thinking mode disabled — model rejected thinking parameters. Retrying...' });
          if (this.modelProvider.setThinkingConfig) {
            this.modelProvider.setThinkingConfig({ enabled: false, model: this.model, level: undefined });
          }
          // Strip thinking blocks from conversation history so the retry doesn't send
          // empty/invalid thinking blocks back to the API
          for (const msg of this.messages) {
            if (msg.role === 'assistant' && msg.content_blocks) {
              msg.content_blocks = msg.content_blocks.filter(
                (block: any) => block.type !== 'thinking' && block.type !== 'redacted_thinking'
              );
            }
            if (msg.thinking) delete msg.thinking;
          }
          streamResult = await createAndProcessStream();
        } else {
          throw thinkingErr; // Not a thinking error or thinking already off — rethrow
        }
      }
      const { pendingToolResults, lastTokenUsage, deferredHookData } = streamResult;

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
                const validToolResults = pendingToolResults.filter((tr: any) =>
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
                      tool_results: validToolResults.map((tr: any) => ({
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
          // OpenAI: add tool role messages (must follow assistant message with matching tool_calls)
          // Find the last assistant message with tool_calls
          let lastAssistantIndex = this.messages.length - 1;
          while (lastAssistantIndex >= 0) {
            const msg = this.messages[lastAssistantIndex];
            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
              // Verify that pending tool results have matching tool_call_ids
              const toolCallIds = new Set(msg.tool_calls.map((tc: any) => tc.id));
              const validToolResults = pendingToolResults.filter((tr: any) =>
                tr.toolCallId && toolCallIds.has(tr.toolCallId)
              );

              if (validToolResults.length > 0) {
                // Add tool messages after this assistant message
                for (const tr of validToolResults) {
                  const toolMessage: Message = {
                    role: 'tool',
                    tool_call_id: tr.toolCallId!,
                    content: tr.content,
                  };
                  this.messages.push(toolMessage);
                }
              }
              break;
            }
            lastAssistantIndex--;
          }
        }
      }
      
      // Check if query was cancelled - messages are kept visible even when aborted.
      // Don't early-return for pending tool injection — deferred hooks still need to fire.
      const hasPendingInjection = this.hookManager?.hasPendingInjection?.() || false;
      if (cancellationCheck && cancellationCheck() && !hasPendingInjection) {
        // SAFETY CHECK for OpenAI: Ensure all tool_calls have corresponding tool messages
        // This prevents "tool_call_id did not have response messages" errors on the next query
        if (this.modelProvider.getProviderName() === 'openai') {
          for (let i = 0; i < this.messages.length; i++) {
            const msg = this.messages[i];
            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
              // Find all tool_call_ids in this assistant message
              const toolCallIds = new Set(msg.tool_calls.map((tc: any) => tc.id));

              // Check subsequent messages for tool responses
              for (let j = i + 1; j < this.messages.length; j++) {
                const nextMsg = this.messages[j];
                if (nextMsg.role === 'tool' && nextMsg.tool_call_id) {
                  toolCallIds.delete(nextMsg.tool_call_id);
                } else if (nextMsg.role === 'assistant') {
                  // Reached next assistant message, stop searching
                  break;
                }
              }

              // Add placeholder tool messages for any missing tool_call_ids
              for (const missingId of toolCallIds) {
                const toolMessage: Message = {
                  role: 'tool',
                  tool_call_id: missingId,
                  content: '[Tool execution cancelled - abort requested]',
                };
                // Insert after the assistant message
                this.messages.splice(i + 1, 0, toolMessage);
              }
            }
          }
        }

        // Keep messages and token count as-is so user can see the partial response
        // Note: IPC server already logs abort message when orchestrator mode is active
        observer?.({ type: 'done' });
        return this.messages;
      }

      // Execute deferred hooks (conditional @tool-exec: and all @tool: hooks) now that
      // the agent's response is complete. These fire after the response so the agent
      // doesn't interfere, and a follow-up stream lets the agent react to injected results.
      // Loop: follow-up streams may produce more deferred hooks (e.g., another @tool: injection).
      let currentDeferredData = deferredHookData;
      while (currentDeferredData.length > 0 && this.hookManager) {
        // Fire deferred hooks unless a hard cancellation (abort/interrupt/phaseComplete) is active.
        // Pending injection is NOT a hard cancellation — it's the reason we stopped.
        const pendingInj = this.hookManager.hasPendingInjection?.() || false;
        const isHardCancelled = cancellationCheck && cancellationCheck() && !pendingInj;
        if (isHardCancelled) break;

        if (pendingInj) this.hookManager.resetPendingInjection();

        const hasInjections = await this.hookManager.executeDeferredAfterHooks(
          currentDeferredData,
          (name, args) => this.toolExecutor.executeMCPTool(name, args, true),
          (name, args, result) => this.injectToolResult(name, args, result),
        );

        // If @tool: hooks injected messages, start a follow-up stream so the agent
        // can see and react to them (e.g., scene was randomized, now continue).
        if (!hasInjections || (cancellationCheck && cancellationCheck())) break;

        const hookFollowUpStream = (this.modelProvider as any).createMessageStreamWithToolUse(
          this.messages,
          this.model,
          this.tools,
          8192,
          toolExecutor,
          (() => {
            const maxIter = this.preferencesManager.getMaxIterations();
            return maxIter === -1 ? 999999 : maxIter;
          })(),
          cancellationCheck,
        );
        const followUpResult = await this.processToolUseStream(hookFollowUpStream, cancellationCheck, this.currentTokenCount, observer);
        currentDeferredData = followUpResult.deferredHookData;
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
          lastTokenUsage.cacheReadTokens,
          lastTokenUsage.ollamaMetrics
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
          this.currentTokenCount += this.tokenManager.getTokenCounter()!.countMessageTokens(reminderMessage);
          
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
            (() => {
          const maxIter = this.preferencesManager.getMaxIterations();
          // -1 means unlimited, use a very large number
          return maxIter === -1 ? 999999 : maxIter;
        })(), // maxIterations
            cancellationCheck, // Pass cancellation check to provider
          );
          const { pendingToolResults: continuePendingToolResults, lastTokenUsage: continueLastTokenUsage, deferredHookData: continueDeferredHookData } = await this.processToolUseStream(continueStream, cancellationCheck, continueTokenCountBeforeStream, observer);

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
              // OpenAI: add tool role messages (must follow assistant message with matching tool_calls)
              let lastAssistantIdx = this.messages.length - 1;
              while (lastAssistantIdx >= 0) {
                const msg = this.messages[lastAssistantIdx];
                if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                  const toolCallIds = new Set(msg.tool_calls.map((tc: any) => tc.id));
                  const validToolResults = continuePendingToolResults.filter(tr =>
                    tr.toolCallId && toolCallIds.has(tr.toolCallId)
                  );

                  for (const tr of validToolResults) {
                    const toolMessage: Message = {
                      role: 'tool',
                      tool_call_id: tr.toolCallId!,
                      content: tr.content,
                    };
                    this.messages.push(toolMessage);
                  }
                  break;
                }
                lastAssistantIdx--;
              }
            }
          }

          // Execute deferred hooks from the continue stream (same loop pattern as main query)
          let contDeferredData = continueDeferredHookData;
          while (contDeferredData.length > 0 && this.hookManager) {
            const contPendingInj = this.hookManager.hasPendingInjection?.() || false;
            const contIsHardCancelled = cancellationCheck && cancellationCheck() && !contPendingInj;
            if (contIsHardCancelled) break;

            if (contPendingInj) this.hookManager.resetPendingInjection();

            const hasInjections = await this.hookManager.executeDeferredAfterHooks(
              contDeferredData,
              (name, args) => this.toolExecutor.executeMCPTool(name, args, true),
              (name, args, result) => this.injectToolResult(name, args, result),
            );

            if (!hasInjections || (cancellationCheck && cancellationCheck())) break;

            const hookFollowUpStream = (this.modelProvider as any).createMessageStreamWithToolUse(
              this.messages,
              this.model,
              this.tools,
              8192,
              toolExecutor,
              (() => {
                const maxIter = this.preferencesManager.getMaxIterations();
                return maxIter === -1 ? 999999 : maxIter;
              })(),
              cancellationCheck,
            );
            const contFollowUpResult = await this.processToolUseStream(hookFollowUpStream, cancellationCheck, this.currentTokenCount, observer);
            contDeferredData = contFollowUpResult.deferredHookData;
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
            if (lastAssistantMessage.content || lastAssistantMessage.content_blocks) {
              this.chatHistoryManager.addAssistantMessage(
                lastAssistantMessage.content || '',
                lastAssistantMessage.content_blocks,
                lastAssistantMessage.thinking
              );
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
              continueLastTokenUsage.cacheReadTokens,
              continueLastTokenUsage.ollamaMetrics
            );
          }
        }
      }

      observer?.({ type: 'done' });
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
      observer?.({ type: 'error', message: cleanErrorMessage });

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

  /**
   * Get info about connected servers and their enabled tools (for web UI)
   * Only includes servers that have at least one enabled tool.
   */
  getServersInfo(): Array<{ name: string; tools: Array<{ name: string; description: string }> }> {
    const result: Array<{ name: string; tools: Array<{ name: string; description: string }> }> = [];
    for (const [name, connection] of this.servers) {
      const enabledTools = connection.tools
        .filter(t => this.toolManager.isToolEnabled(t.name))
        .map(t => ({
          name: t.name,
          description: t.description || '',
        }));
      if (enabledTools.length > 0) {
        result.push({ name, tools: enabledTools });
      }
    }
    return result;
  }

  /**
   * Get conversation messages (for web UI history)
   */
  getMessages(): Message[] {
    return this.messages;
  }

  /**
   * Re-filter tools based on current toolManager state without re-querying servers.
   * Used after toggling tools on/off via the web UI.
   * Excludes tools from servers disabled in config.
   */
  reapplyToolFilter(): void {
    const disabledServers = this.getDisabledServerNames();
    const allTools: Tool[] = [];
    for (const [serverName, connection] of this.servers) {
      if (disabledServers.has(serverName)) continue;
      allTools.push(...connection.tools);
    }
    this.tools = this.toolManager.filterTools(allTools);
  }

  /**
   * Get all tools across all servers with their enabled/disabled state (for web UI tool management).
   * Excludes tools from servers that are disabled in config (they are connected but not exposed to the agent).
   */
  getAllToolsWithState(): Array<{ name: string; server: string; description: string; enabled: boolean }> {
    const disabledServers = this.getDisabledServerNames();
    const result: Array<{ name: string; server: string; description: string; enabled: boolean }> = [];
    for (const [serverName, connection] of this.servers) {
      if (disabledServers.has(serverName)) continue;
      for (const tool of connection.tools) {
        result.push({
          name: tool.name,
          server: serverName,
          description: tool.description || '',
          enabled: this.toolManager.isToolEnabled(tool.name),
        });
      }
    }
    return result;
  }

  /**
   * Restore a chat session by loading its messages into the current conversation.
   */
  restoreChat(sessionId: string): boolean {
    const chatData = this.chatHistoryManager.loadChat(sessionId);
    if (!chatData) return false;

    // Clear current context first
    this.clearContext();

    // Convert chat history messages to conversation messages
    // Also replay into chat history manager so getUserTurns()/rewind work
    const histMgr = this.chatHistoryManager;
    for (const msg of chatData.messages) {
      if (msg.role === 'user') {
        this.messages.push({ role: 'user', content: msg.content });
        histMgr.addUserMessage(msg.content);
      } else if (msg.role === 'assistant') {
        if (msg.content_blocks) {
          this.messages.push({ role: 'assistant', content: msg.content, ...(msg.thinking && { thinking: msg.thinking }), content_blocks: msg.content_blocks });
          histMgr.addAssistantMessage(msg.content, msg.content_blocks, msg.thinking);
        } else {
          this.messages.push({ role: 'assistant', content: msg.content, ...(msg.thinking && { thinking: msg.thinking }) });
          histMgr.addAssistantMessage(msg.content, undefined, msg.thinking);
        }
      } else if (msg.role === 'tool' && msg.tool_use_id) {
        this.messages.push({ role: 'tool', content: msg.content, tool_call_id: msg.tool_use_id });
      }
    }
    return true;
  }

}