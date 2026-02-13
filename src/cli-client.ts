import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import readline from 'readline/promises';
import * as readlineSync from 'readline';
import { MCPClient } from './index.js';
import { consoleStyles, Logger } from './logger.js';
import type { ModelProvider } from './model-provider.js';
import { AttachmentManager, type AttachmentInfo } from './managers/attachment-manager.js';
import { PreferencesManager } from './managers/preferences-manager.js';
import { AblationManager } from './managers/ablation-manager.js';
import { SignalHandler } from './handlers/signal-handler.js';
import { KeyboardMonitor } from './cli/keyboard-monitor.js';
import { ToolCLI } from './cli/tool-cli.js';
import { AttachmentCLI } from './cli/attachment-cli.js';
import { ChatHistoryCLI } from './cli/chat-history-cli.js';
import { PromptCLI } from './cli/prompt-cli.js';
import { AblationCLI } from './cli/ablation-cli.js';
import { ToolReplayCLI } from './cli/tool-replay-cli.js';
import { HumanInTheLoopManager } from './managers/hil-manager.js';

// Command list for tab autocomplete
const CLI_COMMANDS = [
  '/help', '/exit', '/clear', '/clear-context',
  '/token-status', '/tokens', '/summarize', '/summarize-now',
  '/settings', '/refresh', '/refresh-servers',
  '/set-timeout', '/set-max-iterations',
  '/todo-on', '/todo-off',
  '/orchestrator-on', '/orchestrator-off',
  '/tools', '/tools-list', '/tools-manager', '/tools-select',
  '/prompts', '/prompts-list', '/prompts-manager', '/prompts-select', '/add-prompt',
  '/attachment-upload', '/attachment-list', '/attachment-insert', '/attachment-rename', '/attachment-clear',
  '/chat-list', '/chat-search', '/chat-restore', '/chat-export', '/chat-rename', '/chat-clear',
  '/ablation-create', '/ablation-list', '/ablation-edit', '/ablation-run', '/ablation-delete', '/ablation-results',
  '/tool-replay',
  '/hil',
];

export class MCPClientCLI {
  private rl: readline.Interface | null = null;
  private client: MCPClient;
  private logger: Logger;
  private isShuttingDown = false;
  private signalHandler: SignalHandler;
  private attachmentManager: AttachmentManager;
  private preferencesManager: PreferencesManager;
  private ablationManager: AblationManager;
  private pendingAttachments: AttachmentInfo[] = [];
  private pendingContextAdded = false; // Track if prompts were added via /add-prompt
  private keyboardMonitor: KeyboardMonitor;
  private toolCLI: ToolCLI;
  private attachmentCLI: AttachmentCLI;
  private chatHistoryCLI: ChatHistoryCLI;
  private promptCLI: PromptCLI;
  private ablationCLI: AblationCLI;
  private toolReplayCLI: ToolReplayCLI;
  private hilManager: HumanInTheLoopManager;
  private escapeKeyHandler: ((_str: string, key: { name?: string }) => void) | null = null;

  constructor(
    serverConfig: StdioServerParameters | Array<{ name: string; config: StdioServerParameters }>,
    options?: { provider?: ModelProvider; model?: string },
  ) {
    if (Array.isArray(serverConfig)) {
      // Multiple servers
      this.client = MCPClient.createMultiServer(serverConfig, {
        provider: options?.provider,
        model: options?.model,
      });
    } else {
      // Single server (backward compatibility)
      this.client = new MCPClient(serverConfig, {
        provider: options?.provider,
        model: options?.model,
      });
    }
    this.logger = new Logger({ mode: 'verbose' });
    this.attachmentManager = new AttachmentManager(this.logger);
    this.preferencesManager = new PreferencesManager(this.logger);
    this.hilManager = new HumanInTheLoopManager(this.logger);
    this.hilManager.setEnabled(this.preferencesManager.getHILEnabled());
    this.ablationManager = new AblationManager(this.logger);

    // Set up keyboard monitor for abort detection
    this.keyboardMonitor = new KeyboardMonitor(this.logger, {
      onAbort: () => {
        // Abort callback - nothing extra needed, state is in keyboardMonitor
      },
      getReadline: () => this.rl,
      setReadline: (rl) => {
        this.rl = rl;
        this.client.setReadlineInterface(rl);
      },
      getIPCServer: () => this.client.getOrchestratorIPCServer(),
      getCompleter: () => this.completer.bind(this),
    });

    // Set up CLI modules
    this.toolCLI = new ToolCLI(this.client, this.logger, () => this.rl);
    this.attachmentCLI = new AttachmentCLI(this.attachmentManager, this.logger, {
      getReadline: () => this.rl,
      getPendingAttachments: () => this.pendingAttachments,
      setPendingAttachments: (attachments) => {
        this.pendingAttachments = attachments;
      },
      getProviderName: () => this.client.getProviderName(),
    });
    this.chatHistoryCLI = new ChatHistoryCLI(
      this.client.getChatHistoryManager(),
      this.logger,
      {
        getReadline: () => this.rl,
        getMessages: () => (this.client as any).messages,
        getTokenCounter: () => (this.client as any).tokenManager.getTokenCounter(),
        getCurrentTokenCount: () => (this.client as any).currentTokenCount,
        setCurrentTokenCount: (count) => {
          (this.client as any).currentTokenCount = count;
        },
        getProviderName: () => this.client.getProviderName(),
        getAttachmentManager: () => this.attachmentManager,
      },
    );
    this.promptCLI = new PromptCLI(this.client, this.logger, {
      getReadline: () => this.rl,
      getMessages: () => (this.client as any).messages,
      getTokenCounter: () => (this.client as any).tokenManager.getTokenCounter(),
      getCurrentTokenCount: () => (this.client as any).currentTokenCount,
      setCurrentTokenCount: (count) => {
        (this.client as any).currentTokenCount = count;
      },
      onPromptsAdded: () => {
        this.pendingContextAdded = true;
      },
    });
    this.ablationCLI = new AblationCLI(
      this.client,
      this.logger,
      this.ablationManager,
      this.attachmentManager,
      this.preferencesManager,
      {
        getReadline: () => this.rl,
        getPendingAttachments: () => this.pendingAttachments,
        setPendingAttachments: (attachments) => {
          this.pendingAttachments = attachments;
        },
        getToolCLI: () => this.toolCLI,
        getPromptCLI: () => this.promptCLI,
        getAttachmentCLI: () => this.attachmentCLI,
        displayHelp: () => this.displayHelp(),
        displaySettings: () => this.displaySettings(),
        // Check both keyboard monitor (Ctrl+A) and signal handler (Ctrl+C in abort mode)
        isAbortRequested: () => this.keyboardMonitor.abortRequested || this.signalHandler.abortRequested,
        resetAbort: () => {
          this.keyboardMonitor.abortRequested = false;
          this.signalHandler.resetAbort();
        },
        setAbortMode: (enabled: boolean) => this.signalHandler.setAbortMode(enabled),
        startKeyboardMonitor: () => this.keyboardMonitor.start(),
        stopKeyboardMonitor: () => this.keyboardMonitor.stop(),
      },
    );

    this.toolReplayCLI = new ToolReplayCLI(this.logger, {
      getReadline: () => this.rl,
      setReadline: (rl) => {
        this.rl = rl;
        this.client.setReadlineInterface(rl);
      },
      setupEscapeKeyHandler: () => this.setupEscapeKeyHandler(),
      getReplayableToolCalls: () => this.client.getChatHistoryManager().getReplayableToolCalls(),
      executeTool: (toolName, toolInput) => this.client.executeMCPTool(toolName, toolInput),
      startKeyboardMonitor: () => this.keyboardMonitor.start(),
      stopKeyboardMonitor: () => this.keyboardMonitor.stop(),
      resetAbortState: () => {
        this.keyboardMonitor.abortRequested = false;
        this.keyboardMonitor.clearPendingInput();
        // Also reset IPC server abort flag if running
        const ipcServer = this.client.getOrchestratorIPCServer();
        if (ipcServer) {
          ipcServer.setAborted(false);
        }
      },
      setDisableHistoryRecording: (disable) => {
        this.client.setDisableHistoryRecording(disable);
      },
      getCompleter: () => this.completer.bind(this),
    });

    // Set up signal handlers for graceful shutdown
    this.signalHandler = new SignalHandler(this.logger, async () => {
      this.isShuttingDown = true;

      // Stop video recording first (before saving chat so video paths can be included)
      await this.client.cleanupVideoRecording();

      // Close readline
      if (this.rl) {
        this.client.setReadlineInterface(null);
        this.rl.close();
        this.rl = null;
      }

      // Close MCP client connection
      await this.client.stop();

      // End chat session last so "Chat saved" is the final message
      this.client.getChatHistoryManager().endSession('Chat session ended by user');
    });
    this.signalHandler.setup();
  }

  /**
   * Tab autocomplete for CLI commands
   */
  private completer(line: string): [string[], string] {
    const hits = CLI_COMMANDS.filter(cmd => cmd.startsWith(line.toLowerCase()));
    return [hits.length ? hits : CLI_COMMANDS, line];
  }

  async start() {
    try {
      this.logger.log(consoleStyles.separator + '\n', { type: 'info' });
      this.logger.log('🤖 Interactive CLI\n', { type: 'info' });
      this.logger.log(`Type your queries, "/exit" or "exit" to exit\n`, {
        type: 'info',
      });
      this.logger.log(
        `💡 Tip: Press Ctrl+A during agent execution to abort the current query without exiting\n`,
        { type: 'info' },
      );
      this.logger.log(
        `💡 Tip: Press Escape to clear your current input and start fresh\n`,
        { type: 'info' },
      );
      this.logger.log(
        `\nTesting commands:\n`,
        { type: 'info' },
      );
      this.displayHelp();
      this.logger.log(consoleStyles.separator + '\n', { type: 'info' });
      
      // Wait for MCP client to fully connect before creating readline
      await this.client.start();
      
      // Create readline interface after MCP connection is established
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: this.completer.bind(this),
      });

      // Enable keypress events and handler for Escape key to clear input at the prompt
      this.setupEscapeKeyHandler();

      // Share readline with MCP client for elicitation handling
      this.client.setReadlineInterface(this.rl);

      // Set elicitation callbacks to pause/resume keyboard monitoring
      let wasMonitoring = false;
      this.client.setElicitationCallbacks(
        () => {
          wasMonitoring = this.keyboardMonitor.isMonitoring;
          if (wasMonitoring) {
            this.keyboardMonitor.stop();
          }
        },
        () => {
          if (wasMonitoring) {
            this.keyboardMonitor.start();
          }
        }
      );

      // Set abort check callback to detect when user presses Ctrl+A to abort
      this.client.setAbortRequestedCallback(() => {
        return this.keyboardMonitor.abortRequested;
      });

      // Set force stop callback to prompt user when tool calls take too long after abort
      this.client.setForceStopCallback(async (toolName, elapsedSeconds, abortSignal) => {
        return this.askForceStopPrompt(toolName, elapsedSeconds, abortSignal);
      });

      // Set human-in-the-loop approval callback
      this.client.setToolApprovalCallback(async (toolName, toolInput) => {
        return this.requestHILApproval(toolName, toolInput);
      });

      await this.chat_loop();
    } catch (error) {
      if (!this.isShuttingDown) {
        this.logger.log('Failed to initialize tools: ' + error + '\n', {
          type: 'error',
        });
      }
    } finally {
      await this.cleanup();
    }
  }

  private async cleanup() {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    try {
      // Stop keyboard monitoring if active
      this.keyboardMonitor.stop();

      if (this.rl) {
        this.client.setReadlineInterface(null);
        this.rl.close();
        this.rl = null;
      }

      await this.client.stop();
    } catch (error) {
      // Ignore errors during cleanup
    }
  }

  /**
   * Setup Escape key handler for clearing input at the prompt.
   * This must be called after creating or recreating the readline interface.
   * It re-adds the keypress listener since tool-replay removes all keypress listeners.
   */
  private setupEscapeKeyHandler(): void {
    if (!this.rl || !process.stdin.isTTY) {
      return;
    }

    // Enable keypress events for Escape key handling at the prompt
    readlineSync.emitKeypressEvents(process.stdin, this.rl as unknown as readlineSync.Interface);
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }

    // Create the handler if not already created
    if (!this.escapeKeyHandler) {
      this.escapeKeyHandler = (_str: string, key: { name?: string }) => {
        // Only handle Escape when not in keyboard monitoring mode (i.e., at the prompt)
        if (key && key.name === 'escape' && this.rl && !this.keyboardMonitor.isMonitoring) {
          // Clear the current input line using Ctrl+U simulation
          // This clears from cursor to start of line
          this.rl.write(null, { ctrl: true, name: 'u' });
          // Also clear from cursor to end (in case cursor wasn't at end)
          this.rl.write(null, { ctrl: true, name: 'k' });
        }
      };
    }

    // Remove existing listener (if any) to avoid duplicates, then add it
    process.stdin.removeListener('keypress', this.escapeKeyHandler);
    process.stdin.on('keypress', this.escapeKeyHandler);
  }

  /**
   * Prompt user to force stop a long-running tool call.
   * Returns true if user wants to force stop, false to continue waiting.
   * If abortSignal is triggered (tool completed), returns false immediately.
   */
  private async askForceStopPrompt(toolName: string, elapsedSeconds: number, abortSignal?: AbortSignal): Promise<boolean> {
    // If already aborted (tool completed), return immediately
    if (abortSignal?.aborted) {
      return false;
    }

    // Stop keyboard monitoring to allow readline to work
    // Save abort state since start() will reset it
    const wasMonitoring = this.keyboardMonitor.isMonitoring;
    const wasAbortRequested = this.keyboardMonitor.abortRequested;
    if (wasMonitoring) {
      this.keyboardMonitor.stop();
    }

    // Clear any pending input to avoid it interfering with the prompt
    this.keyboardMonitor.clearPendingInput();

    // Create a temporary readline if needed
    let tempRl: readline.Interface | null = null;
    let rlToUse = this.rl;

    if (!rlToUse) {
      tempRl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rlToUse = tempRl;
    }

    try {
      // Extract server name from tool name (format: "server-name__tool-name")
      const serverName = toolName.includes('__') ? toolName.split('__')[0] : 'the server';
      console.log(`\nTool "${toolName}" has been running for ${elapsedSeconds} seconds.`);
      console.log(`⚠️  Force stopping will kill and restart "${serverName}" server.`);
      console.log('Do you want to force stop this tool call? (y/n, Enter to skip)');

      // Race between user input and tool completion (abort signal)
      const response = await new Promise<string>((resolve) => {
        let resolved = false;

        // Listen for abort signal (tool completed)
        const onAbort = () => {
          if (!resolved) {
            resolved = true;
            // Clear the prompt line and show message
            process.stdout.write('\r\x1b[K'); // Clear current line
            console.log('(Tool completed, prompt dismissed)');
            resolve(''); // Treat as "no"
          }
        };

        if (abortSignal) {
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        // Wait for user input - handle Ctrl+C gracefully
        rlToUse!.question('> ').then((answer) => {
          if (!resolved) {
            resolved = true;
            if (abortSignal) {
              abortSignal.removeEventListener('abort', onAbort);
            }
            resolve(answer);
          }
        }).catch(() => {
          // Handle Ctrl+C (AbortError) during readline prompt
          if (!resolved) {
            resolved = true;
            if (abortSignal) {
              abortSignal.removeEventListener('abort', onAbort);
            }
            // Return empty to signal no action (cleanup will handle shutdown)
            resolve('');
          }
        });
      });

      const answer = response.trim().toLowerCase();

      // Empty input or anything other than y/yes means continue waiting
      const shouldStop = answer === 'y' || answer === 'yes';

      if (shouldStop) {
        this.logger.log(`\nForce stopping tool call and restarting "${serverName}" server...\n`, { type: 'warning' });
      } else if (answer === '') {
        // User pressed Enter without input or tool completed - return control silently
        // (message already shown if tool completed)
      } else {
        this.logger.log('\nContinuing to wait for tool result...\n', { type: 'info' });
      }

      return shouldStop;
    } finally {
      // Clean up temporary readline if we created one
      if (tempRl) {
        tempRl.close();
      }

      // Restart keyboard monitoring if it was active
      if (wasMonitoring) {
        this.keyboardMonitor.start();
        // Restore abort state (start() resets it to false)
        if (wasAbortRequested) {
          this.keyboardMonitor.abortRequested = true;
        }
      }
    }
  }

  private async requestHILApproval(toolName: string, toolInput: Record<string, any>): Promise<'execute' | 'skip'> {
    if (!this.hilManager.isEnabled()) {
      return 'execute';
    }

    // Pause keyboard monitoring for readline prompt
    const wasMonitoring = this.keyboardMonitor.isMonitoring;
    if (wasMonitoring) {
      this.keyboardMonitor.stop();
    }
    this.keyboardMonitor.clearPendingInput();

    let tempRl: readline.Interface | null = null;
    let rlToUse = this.rl;

    if (!rlToUse) {
      tempRl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rlToUse = tempRl;
    }

    try {
      const decision = await this.hilManager.requestToolConfirmation(toolName, toolInput, rlToUse);
      return decision;
    } finally {
      if (tempRl) {
        tempRl.close();
      }
      if (wasMonitoring) {
        this.keyboardMonitor.start();
      }
    }
  }

  /**
   * Ask user what to do with existing todos
   * Returns: 'clear' | 'skip' | 'leave'
   */
  private async askUserToClearTodos(todosList: string): Promise<'clear' | 'skip' | 'leave'> {
    if (!this.rl) {
      return 'leave';
    }

    // Stop keyboard monitoring to prevent input from being captured twice
    // and clear any pending input that was buffered during agent execution
    this.keyboardMonitor.stop();
    this.keyboardMonitor.clearPendingInput();

    // Get active todos count from the client
    const todoStatus = await this.client.checkTodoStatus();
    // Get skipped todos count
    const skippedCount = await this.client.getSkippedTodosCount();
    
    // Display the menu
    let statusMessage = '';
    if (todoStatus.activeCount > 0 && skippedCount > 0) {
      statusMessage = `${todoStatus.activeCount} incomplete todo(s) and ${skippedCount} skipped todo(s)`;
    } else if (todoStatus.activeCount > 0) {
      statusMessage = `${todoStatus.activeCount} incomplete todo(s)`;
    } else if (skippedCount > 0) {
      statusMessage = `${skippedCount} skipped todo(s)`;
    } else {
      statusMessage = '0 todos';
    }
    
    console.log(`\n⚠️  Found ${statusMessage}. What would you like to do?`);
    console.log('  1. View todos');
    if (todoStatus.activeCount > 0) {
      console.log('  2. Skip incomplete todos');
    }
    console.log('  3. Leave todos as is');
    console.log('  4. Clear all todos');
    if (todoStatus.activeCount > 0) {
      console.log(`\n   Note:`);
      console.log(`   - Option 2: The agent will skip these ${todoStatus.activeCount} incomplete todo(s). The current todo list state will be added to the context so the agent can review and update it.`);
      console.log(`   - Option 3: The agent will resume and complete these ${todoStatus.activeCount} existing incomplete todo(s) before starting any new tasks. The current todo list will be added to the context.`);
    }
    console.log('');
    
    while (true) {
      const response = (await this.rl.question('> ')).trim().toLowerCase();
      
      if (response === '1' || response === 'view' || response === 'v') {
        // Show the todos list
        console.log('\n' + todosList);
        // Add separator
        console.log('\n' + '─'.repeat(50) + '\n');
        // Ask again - get fresh counts
        const freshTodoStatus = await this.client.checkTodoStatus();
        const freshSkippedCount = await this.client.getSkippedTodosCount();
        
        let freshStatusMessage = '';
        if (freshTodoStatus.activeCount > 0 && freshSkippedCount > 0) {
          freshStatusMessage = `${freshTodoStatus.activeCount} incomplete todo(s) and ${freshSkippedCount} skipped todo(s)`;
        } else if (freshTodoStatus.activeCount > 0) {
          freshStatusMessage = `${freshTodoStatus.activeCount} incomplete todo(s)`;
        } else if (freshSkippedCount > 0) {
          freshStatusMessage = `${freshSkippedCount} skipped todo(s)`;
        }
        
        console.log('What would you like to do?');
        console.log('  1. View todos');
        if (freshTodoStatus.activeCount > 0) {
          console.log('  2. Skip incomplete todos');
        }
        console.log('  3. Leave todos as is');
        console.log('  4. Clear all todos');
        if (freshTodoStatus.activeCount > 0) {
          console.log(`\n   Note:`);
          console.log(`   - Option 2: The agent will skip these ${freshTodoStatus.activeCount} incomplete todo(s). The current todo list state will be added to the context so the agent can review and update it.`);
          console.log(`   - Option 3: The agent will resume and complete these ${freshTodoStatus.activeCount} existing incomplete todo(s) before starting any new tasks. The current todo list will be added to the context.`);
        }
        console.log('');
        continue;
      } else if ((response === '2' || response === 'skip' || response === 's') && todoStatus.activeCount > 0) {
        return 'skip';
      } else if (response === '3' || response === 'leave' || response === 'l') {
        return 'leave';
      } else if (response === '4' || response === 'clear' || response === 'c') {
        return 'clear';
      } else {
        const validOptions = todoStatus.activeCount > 0 ? '1, 2, 3, or 4' : '1, 3, or 4';
        const validWords = todoStatus.activeCount > 0 ? '(or view/skip/leave/clear)' : '(or view/leave/clear)';
        console.log(`Please enter ${validOptions} ${validWords}: `);
      }
    }
  }

  /**
   * Ask user what to do with completed todos
   * Returns: 'clear' | 'leave'
   */
  private async askUserAboutCompletedTodos(todosList: string): Promise<'clear' | 'leave'> {
    if (!this.rl) {
      return 'leave';
    }

    // Stop keyboard monitoring to prevent input from being captured twice
    // and clear any pending input that was buffered during agent execution
    this.keyboardMonitor.stop();
    this.keyboardMonitor.clearPendingInput();

    console.log(`\n✓ All todos have been completed!`);
    console.log('\n' + '─'.repeat(50));
    console.log('\nWhat would you like to do with the completed todos?');
    console.log('  1. View todos');
    console.log('  2. Leave todos as is');
    console.log('  3. Clear all todos');
    console.log('');
    
    while (true) {
      const response = (await this.rl.question('> ')).trim().toLowerCase();
      
      if (response === '1' || response === 'view' || response === 'v') {
        // Show the todos list
        console.log('\n' + todosList);
        // Add separator
        console.log('\n' + '─'.repeat(50) + '\n');
        // Ask again
        console.log('What would you like to do?');
        console.log('  1. View todos');
        console.log('  2. Leave todos as is');
        console.log('  3. Clear all todos');
        console.log('');
        continue;
      } else if (response === '2' || response === 'leave' || response === 'l') {
        return 'leave';
      } else if (response === '3' || response === 'clear' || response === 'c') {
        return 'clear';
      } else {
        console.log('Please enter 1, 2, or 3 (or view/leave/clear): ');
      }
    }
  }

  private async displaySettings(): Promise<void> {
    const timeout = this.preferencesManager.getMCPTimeout();
    const maxIterations = this.preferencesManager.getMaxIterations();

    const timeoutDisplay = timeout === -1 ? 'unlimited' : `${timeout} seconds`;
    const maxIterationsDisplay = maxIterations === -1 ? 'unlimited' : maxIterations.toString();

    this.logger.log('\n⚙️  Client Settings:\n', { type: 'info' });
    this.logger.log(
      `  MCP Tool Timeout: ${timeoutDisplay}\n` +
      `  Max Iterations: ${maxIterationsDisplay}\n`,
      { type: 'info' },
    );
    this.logger.log(
      `\nCommands:\n` +
      `  /set-timeout <seconds> - Change MCP tool timeout (1-3600, or "infinity"/"unlimited")\n` +
      `  /set-max-iterations <number> - Change max iterations (1-10000, or "infinity"/"unlimited")\n`,
      { type: 'info' },
    );
  }

  private displayHelp(): void {
    this.logger.log(
      `\nAvailable commands:\n` +
      `  /help - Show this help message\n` +
      `  /exit or exit - Exit the application\n` +
      `  /clear or /clear-context - Clear current chat and start fresh (servers stay connected)\n` +
      `\n` +
      `System & Status:\n` +
      `  /token-status or /tokens - Show current token usage\n` +
      `  /summarize or /summarize-now - Manually trigger summarization\n` +
      `  /settings - View and modify client preferences\n` +
      `  /refresh or /refresh-servers - Refresh MCP server connections without restarting\n` +
      `  /set-timeout <seconds> - Set MCP tool timeout (1-3600, or "infinity"/"unlimited")\n` +
      `  /set-max-iterations <number> - Set max iterations between agent calls (1-10000, or "infinity"/"unlimited")\n` +
      `  /hil - Toggle human-in-the-loop tool approval\n` +
      `\n` +
      `Todo Management:\n` +
      `  /todo-on - Enable todo mode (agent will track tasks)\n` +
      `  /todo-off - Disable todo mode\n` +
      `\n` +
      `Orchestrator Mode:\n` +
      `  /orchestrator-on - Enable orchestrator mode (only mcp-tools-orchestrator tools visible, all servers stay connected for IPC)\n` +
      `  /orchestrator-off - Disable orchestrator mode (restore all enabled server tools)\n` +
      `\n` +
      `Tool Management:\n` +
      `  /tools or /tools-list - List currently enabled tools\n` +
      `  /tools-manager or /tools-select - Interactive tool enable/disable selection\n` +
      `\n` +
      `Prompt Management:\n` +
      `  /prompts or /prompts-list - List currently enabled prompts\n` +
      `  /prompts-manager or /prompts-select - Interactive prompt enable/disable selection\n` +
      `  /add-prompt - Add enabled prompts to conversation context\n` +
      `\n` +
      `Attachments:\n` +
      `  /attachment-upload - Upload files by drag-and-drop\n` +
      `  /attachment-list - List available attachments\n` +
      `  /attachment-insert - Select attachments to send to agent\n` +
      `  /attachment-rename - Rename an attachment\n` +
      `  /attachment-clear - Delete one or more attachments\n` +
      `\n` +
      `Chat History:\n` +
      `  /chat-list - List recent chat sessions\n` +
      `  /chat-search <keyword> - Search chats by keyword\n` +
      `  /chat-restore - Restore a past chat as context\n` +
      `  /chat-export - Export a chat to file\n` +
      `  /chat-rename - Move a chat session to a folder (named folder will be created)\n` +
      `  /chat-clear - Delete a chat session\n` +
      `\n` +
      `Tool Replay:\n` +
      `  /tool-replay - Browse and re-execute past tool calls (results not sent to agent)\n` +
      `\n` +
      `Ablation Studies:\n` +
      `  /ablation-create - Create a new ablation study (interactive wizard)\n` +
      `  /ablation-list - List all saved ablation studies\n` +
      `  /ablation-edit - Edit an existing ablation study\n` +
      `  /ablation-run - Run an ablation study\n` +
      `  /ablation-delete - Delete an ablation study\n` +
      `  /ablation-results - View results from past ablation runs\n`,
      { type: 'info' },
    );
  }

  private async chat_loop() {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }
    
    while (true) {
      try {
        if (this.isShuttingDown) {
          break;
        }
        
        // Reset abort flag before reading next query to ensure clean state
        this.keyboardMonitor.abortRequested = false;

        // Pre-fill prompt with any text typed during agent execution
        const pendingText = this.keyboardMonitor.pendingInput;
        this.keyboardMonitor.clearPendingInput();
        if (pendingText) {
          // Use setImmediate to write after the prompt is displayed
          setImmediate(() => {
            if (this.rl) {
              this.rl.write(pendingText);
            }
          });
        }

        if (!this.rl) {
          break;
        }
        let query = (await this.rl.question(consoleStyles.prompt)).trim();
        
        if (this.isShuttingDown) {
          break;
        }
        
        // Safety check: Remove leading 'a' if it leaked from keyboard monitoring
        // This can happen if 'a' was pressed during monitoring and got buffered into next input
        // Only remove if query starts with 'a' followed immediately by other chars (not 'a ' or standalone 'a')
        if (query.length > 1 && query.toLowerCase().startsWith('a') && query[1] !== ' ') {
          const withoutA = query.substring(1).trim();
          // Only use the cleaned version if it's not empty and looks like a valid command
          if (withoutA && withoutA.length > 0) {
            query = withoutA;
          }
        }
        
        // Handle empty queries - check for pending context
        if (!query) {
          const hasPendingAttachments = this.pendingAttachments.length > 0;
          const hasPendingContext = this.pendingContextAdded;

          if (hasPendingAttachments || hasPendingContext) {
            // Build description of pending items
            const pendingItems: string[] = [];
            if (hasPendingAttachments) {
              pendingItems.push(`${this.pendingAttachments.length} attachment(s)`);
            }
            if (hasPendingContext) {
              pendingItems.push('prompt(s) added to context');
            }

            console.log(`\nYou have ${pendingItems.join(' and ')} pending.`);
            const response = (await this.rl!.question('Send without additional input? (Y/n): ')).trim().toLowerCase();

            if (response === '' || response === 'y' || response === 'yes') {
              // User confirmed - proceed with empty query to send pending context
              query = ' '; // Use a space so the query passes through, will be trimmed later
            } else {
              // User declined - continue loop to let them type more
              continue;
            }
          } else {
            // No pending context, just skip empty queries
            continue;
          }
        }
        
        // Check for exit command (trim and lowercase to handle any edge cases)
        // Do this check BEFORE any other processing to ensure exit always works
        // Support both "/exit" and "exit"
        const trimmedQuery = query.trim().toLowerCase();
        if (trimmedQuery === 'exit' || trimmedQuery === '/exit') {
          this.logger.log('\nGoodbye! 👋\n', { type: 'warning' });
          // Mark as shutting down to prevent duplicate cleanup in finally block
          this.isShuttingDown = true;
          // Stop video recording first (before saving chat so video paths can be included)
          await this.client.cleanupVideoRecording();
          // Close readline
          if (this.rl) {
            this.rl.close();
            this.rl = null;
          }
          // Stop MCP connections (so "Orchestrator IPC server stopped" appears before chat saved)
          await this.client.stop();
          // End chat session last so "Chat saved" is the final message
          this.client.getChatHistoryManager().endSession('Chat session ended by user');
          process.exit(0);
        }

        // Handle incomplete/unknown commands - detect partial command matches
        if (query.startsWith('/')) {
          const lowerQuery = query.toLowerCase();
          const baseCommand = lowerQuery.split(' ')[0]; // Get just the command part, not arguments

          // Check if this is an exact match for any known command (including commands with args)
          const isExactMatch = CLI_COMMANDS.some(cmd =>
            lowerQuery === cmd || lowerQuery.startsWith(cmd + ' ')
          );

          if (!isExactMatch) {
            // Find commands that start with what the user typed
            const suggestions = CLI_COMMANDS.filter(cmd => cmd.startsWith(baseCommand));

            if (suggestions.length > 0) {
              // Partial match - show suggestions and re-prompt with their input pre-filled
              console.log(`\nDid you mean one of these commands?`);
              suggestions.forEach(cmd => console.log(`  ${cmd}`));
              console.log('');

              // Pre-fill the next prompt with their partial input
              setImmediate(() => {
                if (this.rl) {
                  this.rl.write(query);
                }
              });
              continue;
            } else {
              // Unknown command - not a prefix of any known command
              console.log(`\nUnknown command: ${baseCommand}`);
              console.log('Type /help for a list of available commands.\n');
              continue;
            }
          }
        }

        // Handle help command
        if (query.toLowerCase() === '/help') {
          this.displayHelp();
          continue;
        }

        // Handle special commands for testing
        if (query.toLowerCase() === '/token-status' || query.toLowerCase() === '/tokens') {
          const usage = this.client.getTokenUsage();
          this.logger.log(
            `\n📊 Token Usage Status:\n` +
            `  Current: ${usage.current} tokens\n` +
            `  Limit: ${usage.limit} tokens\n` +
            `  Usage: ${usage.percentage}%\n` +
            `  Status: ${usage.suggestion}\n` +
            `  Messages: ${this.client['messages'].length}\n`,
            { type: 'info' },
          );
          continue;
        }

        if (query.toLowerCase() === '/summarize' || query.toLowerCase() === '/summarize-now') {
          this.logger.log('\n🔧 Manually triggering summarization...\n', { type: 'info' });
          await this.client.manualSummarize();
          const usage = this.client.getTokenUsage();
          this.logger.log(
            `\n📊 Token Usage After Summarization:\n` +
            `  Current: ${usage.current} tokens\n` +
            `  Usage: ${usage.percentage}%\n`,
            { type: 'info' },
          );
          continue;
        }

        if (query.toLowerCase() === '/settings') {
          try {
            await this.displaySettings();
          } catch (error) {
            this.logger.log(
              `\nFailed to display settings: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/refresh-servers' || query.toLowerCase() === '/refresh') {
          try {
            // Preserve readline history before refresh (server stdio can affect terminal state)
            const savedHistory = this.rl ? [...(this.rl as any).history] : [];

            await this.client.refreshServers();

            // Restore readline history after refresh
            if (this.rl && savedHistory.length > 0) {
              (this.rl as any).history = savedHistory;
            }
          } catch (error) {
            this.logger.log(
              `\nFailed to refresh servers: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase().startsWith('/set-timeout')) {
          try {
            const parts = query.split(' ');
            if (parts.length < 2) {
              this.logger.log(
                '\nUsage: /set-timeout <seconds> or /set-timeout infinity\n',
                { type: 'error' },
              );
              continue;
            }
            const timeoutValue = parts.slice(1).join(' '); // Join in case user types "infinity" or "unlimited"
            this.preferencesManager.setMCPTimeout(timeoutValue);
            const newTimeout = this.preferencesManager.getMCPTimeout();
            const timeoutDisplay = newTimeout === -1 ? 'unlimited' : `${newTimeout} seconds`;
            this.logger.log(
              `\n✓ MCP tool timeout set to ${timeoutDisplay}\n`,
              { type: 'success' },
            );
          } catch (error) {
            this.logger.log(
              `\nFailed to set timeout: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase().startsWith('/set-max-iterations')) {
          try {
            const parts = query.split(' ');
            if (parts.length < 2) {
              this.logger.log(
                '\nUsage: /set-max-iterations <number> or /set-max-iterations infinity\n',
                { type: 'error' },
              );
              continue;
            }
            const maxIterationsValue = parts.slice(1).join(' '); // Join in case user types "infinity" or "unlimited"
            this.preferencesManager.setMaxIterations(maxIterationsValue);
            const newMaxIterations = this.preferencesManager.getMaxIterations();
            const maxIterationsDisplay = newMaxIterations === -1 ? 'unlimited' : newMaxIterations.toString();
            this.logger.log(
              `\n✓ Max iterations set to ${maxIterationsDisplay}\n`,
              { type: 'success' },
            );
          } catch (error) {
            this.logger.log(
              `\nFailed to set max iterations: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/hil') {
          this.hilManager.toggle();
          const enabled = this.hilManager.isEnabled();
          this.preferencesManager.setHILEnabled(enabled);
          const status = enabled ? 'enabled' : 'disabled';
          this.logger.log(
            `\nHuman-in-the-loop tool approval ${status}\n`,
            { type: enabled ? 'success' : 'warning' },
          );
          continue;
        }

        if (query.toLowerCase() === '/todo-on') {
          try {
            if (!this.client.isTodoServerConfigured()) {
              this.logger.log(
                '\nTodo server not configured. Please add "todo" server to mcp_config.json before using this feature.\n',
                { type: 'error' },
              );
              continue;
            }
            
            // Pass the callbacks to ask user about clearing todos and completed todos
            await this.client.enableTodoMode(
              (todosList) => this.askUserToClearTodos(todosList),
              (todosList) => this.askUserAboutCompletedTodos(todosList)
            );
            // Don't send prompt immediately - it will be sent with the first user message
          } catch (error) {
            this.logger.log(
              `\nFailed to enable todo mode: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/todo-off') {
          try {
            await this.client.disableTodoMode();
          } catch (error) {
            this.logger.log(
              `\nFailed to disable todo mode: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/orchestrator-on') {
          try {
            if (!this.client.isOrchestratorServerConfigured()) {
              this.logger.log(
                '\nmcp-tools-orchestrator server not configured. Please add "mcp-tools-orchestrator" to mcp_config.json and start with --all.\n',
                { type: 'error' },
              );
              continue;
            }

            await this.client.enableOrchestratorMode();
          } catch (error) {
            this.logger.log(
              `\nFailed to enable orchestrator mode: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/orchestrator-off') {
          try {
            await this.client.disableOrchestratorMode();
          } catch (error) {
            this.logger.log(
              `\nFailed to disable orchestrator mode: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/tools-list') {
          try {
            await this.toolCLI.displayToolsList();
          } catch (error) {
            this.logger.log(
              `\nFailed to list tools: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/tools') {
          try {
            await this.toolCLI.displayToolsList();
          } catch (error) {
            this.logger.log(
              `\nFailed to list tools: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/tools-manager' || query.toLowerCase() === '/tools-select') {
          try {
            await this.toolCLI.interactiveToolSelection();
          } catch (error) {
            this.logger.log(
              `\nFailed to open tool manager: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/add-prompt') {
          try {
            await this.promptCLI.addPromptToContext();
          } catch (error) {
            this.logger.log(
              `\nFailed to add prompt: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/prompts' || query.toLowerCase() === '/prompts-list') {
          try {
            await this.promptCLI.displayPromptsList();
          } catch (error) {
            this.logger.log(
              `\nFailed to list prompts: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/prompts-manager' || query.toLowerCase() === '/prompts-select') {
          try {
            await this.promptCLI.interactivePromptManager();
          } catch (error) {
            this.logger.log(
              `\nFailed to open prompt manager: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        // Chat history commands
        if (query.toLowerCase() === '/chat-list') {
          try {
            await this.chatHistoryCLI.displayChatList();
          } catch (error) {
            this.logger.log(
              `\nFailed to list chats: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase().startsWith('/chat-search ')) {
          try {
            const keyword = query.substring('/chat-search '.length).trim();
            if (!keyword) {
              this.logger.log('\nUsage: /chat-search <keyword>\n', { type: 'error' });
              continue;
            }
            await this.chatHistoryCLI.searchChats(keyword);
          } catch (error) {
            this.logger.log(
              `\nFailed to search chats: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/chat-restore') {
          try {
            await this.chatHistoryCLI.restoreChat();
          } catch (error) {
            this.logger.log(
              `\nFailed to restore chat: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/chat-export') {
          try {
            await this.chatHistoryCLI.exportChat();
          } catch (error) {
            this.logger.log(
              `\nFailed to export chat: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/chat-rename') {
          try {
            await this.chatHistoryCLI.renameChat();
          } catch (error) {
            this.logger.log(
              `\nFailed to rename chat: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/chat-clear') {
          try {
            await this.chatHistoryCLI.clearChat();
          } catch (error) {
            this.logger.log(
              `\nFailed to clear chat: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        // Tool replay
        if (query.toLowerCase() === '/tool-replay') {
          try {
            await this.toolReplayCLI.enterReplayMode();
          } catch (error) {
            this.logger.log(
              `\nFailed to enter tool replay mode: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        // Ablation study commands
        if (query.toLowerCase() === '/ablation-create') {
          try {
            await this.ablationCLI.handleAblationCreate();
          } catch (error) {
            this.logger.log(
              `\nFailed to create ablation: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/ablation-list') {
          try {
            await this.ablationCLI.handleAblationList();
          } catch (error) {
            this.logger.log(
              `\nFailed to list ablations: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/ablation-edit') {
          try {
            await this.ablationCLI.handleAblationEdit();
          } catch (error) {
            this.logger.log(
              `\nFailed to edit ablation: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/ablation-run') {
          try {
            await this.ablationCLI.handleAblationRun();
          } catch (error) {
            this.logger.log(
              `\nFailed to run ablation: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/ablation-delete') {
          try {
            await this.ablationCLI.handleAblationDelete();
          } catch (error) {
            this.logger.log(
              `\nFailed to delete ablation: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/ablation-results') {
          try {
            await this.ablationCLI.handleAblationResults();
          } catch (error) {
            this.logger.log(
              `\nFailed to show ablation results: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/clear' || query.toLowerCase() === '/clear-context') {
          try {
            this.client.clearContext();
            this.logger.log(
              '\n✓ Chat context cleared. Starting fresh session.\n',
              { type: 'success' },
            );
          } catch (error) {
            this.logger.log(
              `\nFailed to clear context: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/attachment-upload') {
          try {
            await this.attachmentCLI.handleAttachmentCommand();
          } catch (error) {
            this.logger.log(
              `\nFailed to handle attachment: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/attachment-list') {
          try {
            await this.attachmentCLI.handleAttachmentListCommand();
          } catch (error) {
            this.logger.log(
              `\nFailed to list attachments: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/attachment-insert') {
          try {
            await this.attachmentCLI.handleAttachmentSelectCommand();
          } catch (error) {
            this.logger.log(
              `\nFailed to select attachments: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/attachment-rename') {
          try {
            await this.attachmentCLI.handleAttachmentRenameCommand();
          } catch (error) {
            this.logger.log(
              `\nFailed to rename attachment: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/attachment-clear') {
          try {
            await this.attachmentCLI.handleAttachmentClearCommand();
          } catch (error) {
            this.logger.log(
              `\nFailed to clear attachments: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        // Check if system prompt needs to be logged and log it FIRST (before user message)
        const systemPrompt = await (this.client as any).prepareAndLogSystemPrompt();
        const finalQuery = systemPrompt ? `${systemPrompt}\n\nUser: ${query}` : query;

        // Reset abort flag and start keyboard monitoring
        this.keyboardMonitor.abortRequested = false;

        // Also reset IPC server abort flag if it's running (regardless of orchestrator mode)
        const ipcServer = this.client.getOrchestratorIPCServer();
        if (ipcServer) {
          ipcServer.setAborted(false);
        }

        this.keyboardMonitor.start();

        // Save pending attachments before processing (they may be cleared on abort)
        const attachmentsForHistory = [...this.pendingAttachments];

        // Log user message to history BEFORE processing (to maintain correct chronological order)
        const attachmentMetadata = attachmentsForHistory.length > 0
          ? attachmentsForHistory.map(att => ({
              fileName: att.fileName,
              ext: att.ext,
              mediaType: att.mediaType,
            }))
          : undefined;
        this.client.getChatHistoryManager().addUserMessage(query, attachmentMetadata);

        try {
          // Reset HIL session state for each new query
          this.hilManager.resetSession();
          // Process query with attachments if any are pending (use finalQuery which includes system prompt if needed)
          // Pass cancellation check function
          await this.client.processQuery(
            finalQuery,
            false,
            this.pendingAttachments.length > 0 ? this.pendingAttachments : undefined,
            () => this.keyboardMonitor.abortRequested
          );
        } catch (error: any) {
          // If aborted, log message but continue to save history
          // Also handle errors from orchestrator mode IPC when abort is triggered
          if (this.keyboardMonitor.abortRequested) {
            // Stop monitoring
            this.keyboardMonitor.stop();
            // Wait a bit longer to ensure readline state is fully restored
            // This helps prevent duplicate echo after abort
            await new Promise(resolve => setTimeout(resolve, 100));
            // Continue to save history even when aborted
            // Don't throw - we want to continue the loop and prompt for next query
          } else {
            throw error;
          }
        } finally {
          // Stop keyboard monitoring
          this.keyboardMonitor.stop();
        }

        // If query was aborted, wait to ensure readline state is fully restored
        if (this.keyboardMonitor.abortRequested) {
          // Wait a bit longer to ensure readline state is fully restored
          // This helps prevent duplicate echo after abort
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Log assistant response to history (even if aborted)
        {
          // Extract assistant response from messages array
          const messages = (this.client as any).messages;
          const assistantMessages = messages.filter((msg: any) => msg.role === 'assistant');
          if (assistantMessages.length > 0) {
            const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
            if (lastAssistantMessage.content) {
              this.client.getChatHistoryManager().addAssistantMessage(lastAssistantMessage.content);
            }
          }
        }
        
        // Clear pending attachments and context flag after they've been used
        this.pendingAttachments = [];
        this.pendingContextAdded = false;
        
        this.logger.log('\n' + consoleStyles.separator + '\n');
      } catch (error: any) {
        // Check if readline was closed (happens during shutdown)
        if (error?.code === 'ERR_USE_AFTER_CLOSE' || this.isShuttingDown) {
          // Save session before breaking if it was a shutdown
          if (this.isShuttingDown) {
            this.client.getChatHistoryManager().endSession('Chat session ended by user');
          }
          break;
        }
        
        // Handle Ctrl+C (AbortError) - save session before exiting
        if (error?.name === 'AbortError' || error?.message?.includes('Aborted')) {
          this.client.getChatHistoryManager().endSession('Chat session ended by Ctrl+C');
          break;
        }
        
        this.logger.log('\nError: ' + error + '\n', { type: 'error' });
      }
    }
    
    // Ensure session is saved when loop exits (safety net)
    if (!this.isShuttingDown) {
      try {
        this.client.getChatHistoryManager().endSession('Chat session ended');
      } catch (error) {
        // Ignore errors if session was already saved
      }
    }
  }
}
