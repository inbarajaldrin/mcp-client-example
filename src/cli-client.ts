import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import readline from 'readline/promises';
import chalk from 'chalk';
import { MCPClient } from './index.js';
import { consoleStyles, Logger } from './logger.js';
import type { ModelProvider } from './model-provider.js';
import { AttachmentManager, type AttachmentInfo, type ContentBlock } from './managers/attachment-manager.js';
import { PreferencesManager } from './managers/preferences-manager.js';
import { AblationManager, type AblationDefinition, type AblationPhase, type AblationModel, type AblationRun, type AblationRunResult } from './managers/ablation-manager.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { GeminiProvider } from './providers/gemini.js';
import { OllamaProvider } from './providers/ollama.js';
import type { ModelInfo, ModelProvider as IModelProvider } from './model-provider.js';

export class MCPClientCLI {
  private rl: readline.Interface | null = null;
  private client: MCPClient;
  private logger: Logger;
  private isShuttingDown = false;
  private attachmentManager: AttachmentManager;
  private preferencesManager: PreferencesManager;
  private ablationManager: AblationManager;
  private pendingAttachments: AttachmentInfo[] = [];
  private abortCurrentQuery = false;
  private keyboardMonitor: (() => void) | null = null;
  private isMonitoring = false;
  private pendingInput: string = ''; // Buffer for text typed during agent execution

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
    this.ablationManager = new AblationManager(this.logger);

    // Set up signal handlers for graceful shutdown
    this.setupSignalHandlers();
  }

  private setupSignalHandlers() {
    const cleanup = async () => {
      if (this.isShuttingDown) {
        return;
      }
      this.isShuttingDown = true;
      
      this.logger.log('\n\nShutting down gracefully...\n', { type: 'info' });

      try {
        // Stop video recording first (before saving chat so video paths can be included)
        await this.client.cleanupVideoRecording();

        // Close readline
        if (this.rl) {
          this.rl.close();
          this.rl = null;
        }

        // Close MCP client connection
        await this.client.stop();

        // End chat session last so "Chat saved" is the final message
        this.client.getChatHistoryManager().endSession('Chat session ended by user');
      } catch (error) {
        this.logger.log(`Error during cleanup: ${error}\n`, { type: 'error' });
      }
      
      process.exit(0);
    };

    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', async () => {
      // Prevent default behavior (immediate exit)
      // The cleanup will handle saving and exiting
      await cleanup();
    });

    // Handle SIGTERM
    process.on('SIGTERM', async () => {
      await cleanup();
    });
    
    // Also handle uncaught exceptions to save session
    process.on('uncaughtException', async (error) => {
      if (!this.isShuttingDown) {
        this.logger.log(`\nUncaught exception: ${error}\n`, { type: 'error' });
        await cleanup();
      }
    });
  }

  async start() {
    try {
      this.logger.log(consoleStyles.separator + '\n', { type: 'info' });
      this.logger.log('🤖 Interactive CLI\n', { type: 'info' });
      this.logger.log(`Type your queries, "/exit" or "exit" to exit\n`, {
        type: 'info',
      });
      this.logger.log(
        `💡 Tip: Press 'a' during agent execution to abort the current query without exiting\n`,
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
      this.stopKeyboardMonitoring();

      if (this.rl) {
        this.rl.close();
        this.rl = null;
      }
      
      await this.client.stop();
    } catch (error) {
      // Ignore errors during cleanup
    }
  }

  /**
   * Start monitoring keyboard input for 'a' key to abort current query
   */
  private async startKeyboardMonitoring(): Promise<void> {
    if (!process.stdin.isTTY) {
      return;
    }

    // Always clean up any existing monitoring before starting fresh
    if (this.isMonitoring) {
      this.stopKeyboardMonitoring();
    }

    this.isMonitoring = true;
    this.abortCurrentQuery = false;

    // Pause readline to allow raw mode
    if (this.rl) {
      this.rl.pause();
    }

    const stdin = process.stdin;
    
    // Enable raw mode to read individual key presses
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding('utf8');

    // Listen for key presses
    const keyHandler = (key: string) => {
      if (!this.isMonitoring) {
        return;
      }

      // Handle special keys
      const keyLower = key.toLowerCase();

      // 'a' triggers abort only if not already aborted
      if (keyLower === 'a' && !this.abortCurrentQuery) {
        this.logger.log('\n' + chalk.bold.red('🛑 Abort requested - will finish current response then stop...') + '\n', { type: 'error' });
        this.abortCurrentQuery = true;

        // Also abort IPC server if it's running (regardless of orchestrator mode)
        const ipcServer = this.client.getOrchestratorIPCServer();
        if (ipcServer) {
          ipcServer.setAborted(true);
        }
        return;
      }

      // Handle Ctrl+C (exit)
      if (key === '\x03') {
        return;
      }

      // Handle backspace (delete last character from buffer)
      if (key === '\x7f' || key === '\b') {
        if (this.pendingInput.length > 0) {
          this.pendingInput = this.pendingInput.slice(0, -1);
        }
        return;
      }

      // Ignore Enter and other control characters
      if (key === '\r' || key === '\n' || key.charCodeAt(0) < 32) {
        return;
      }

      // Buffer printable characters for next prompt
      this.pendingInput += key;
    };

    stdin.on('data', keyHandler);

    // Store cleanup function
    this.keyboardMonitor = () => {
      if (!this.isMonitoring) {
        return;
      }

      this.isMonitoring = false;
      stdin.removeListener('data', keyHandler);

      // Restore normal mode
      if (stdin.setRawMode) {
        stdin.setRawMode(false);
      }

      // Flush stdin buffer to prevent raw mode input from interfering with readline
      // Note: User input is already captured in this.pendingInput by the keyHandler
      if (stdin.readable) {
        let chunk;
        while ((chunk = stdin.read()) !== null) {
          // Discard - already captured in pendingInput
        }
      }

      // Close and recreate readline interface to ensure clean terminal state
      // This prevents double-echo issues after restoring from raw mode
      if (this.rl) {
        // Preserve history before recreating readline
        const savedHistory = [...(this.rl as any).history];

        this.rl.close();
        this.rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        // Restore history after recreating readline
        if (savedHistory.length > 0) {
          (this.rl as any).history = savedHistory;
        }
      }
    };
  }

  /**
   * Stop keyboard monitoring and restore terminal settings
   */
  private stopKeyboardMonitoring(): void {
    if (this.keyboardMonitor) {
      this.keyboardMonitor();
      this.keyboardMonitor = null;
    }
    this.isMonitoring = false;
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
    this.stopKeyboardMonitoring();
    this.pendingInput = '';

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
    this.stopKeyboardMonitoring();
    this.pendingInput = '';

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
        this.abortCurrentQuery = false;

        // Pre-fill prompt with any text typed during agent execution
        const pendingText = this.pendingInput;
        this.pendingInput = '';
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
        
        // Skip empty queries
        if (!query) {
          continue;
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
            await this.displayToolsList();
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
            await this.displayToolsList();
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
            await this.interactiveToolSelection();
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
            await this.addPromptToContext();
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
            await this.displayPromptsList();
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
            await this.interactivePromptManager();
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
            await this.displayChatList();
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
            await this.searchChats(keyword);
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
            await this.restoreChat();
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
            await this.exportChat();
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
            await this.renameChat();
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
            await this.clearChat();
          } catch (error) {
            this.logger.log(
              `\nFailed to clear chat: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        // Ablation study commands
        if (query.toLowerCase() === '/ablation-create') {
          try {
            await this.handleAblationCreate();
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
            await this.handleAblationList();
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
            await this.handleAblationEdit();
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
            await this.handleAblationRun();
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
            await this.handleAblationDelete();
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
            await this.handleAblationResults();
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
            await this.handleAttachmentCommand();
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
            await this.handleAttachmentListCommand();
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
            await this.handleAttachmentSelectCommand();
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
            await this.handleAttachmentRenameCommand();
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
            await this.handleAttachmentClearCommand();
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
        this.abortCurrentQuery = false;

        // Also reset IPC server abort flag if it's running (regardless of orchestrator mode)
        const ipcServer = this.client.getOrchestratorIPCServer();
        if (ipcServer) {
          ipcServer.setAborted(false);
        }

        await this.startKeyboardMonitoring();

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
          // Process query with attachments if any are pending (use finalQuery which includes system prompt if needed)
          // Pass cancellation check function
          await this.client.processQuery(
            finalQuery,
            false,
            this.pendingAttachments.length > 0 ? this.pendingAttachments : undefined,
            () => this.abortCurrentQuery
          );
        } catch (error: any) {
          // If aborted, log message but continue to save history
          // Also handle errors from orchestrator mode IPC when abort is triggered
          if (this.abortCurrentQuery) {
            // Stop monitoring
            this.stopKeyboardMonitoring();
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
          this.stopKeyboardMonitoring();
        }

        // If query was aborted, wait to ensure readline state is fully restored
        if (this.abortCurrentQuery) {
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
        
        // Clear pending attachments after they've been used
        this.pendingAttachments = [];
        
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

  private async displayToolsList(): Promise<void> {
    const toolManager = this.client.getToolManager();
    
    // Get all tools from all servers
    const allTools: Array<{ name: string; server: string; enabled: boolean }> = [];
    
    // Access private servers map through a workaround
    const servers = (this.client as any).servers as Map<string, any>;
    
    for (const [serverName, connection] of servers.entries()) {
      // Get all tools from server (including disabled ones)
      try {
        const toolsResults = await connection.client.request(
          { method: 'tools/list' },
          ListToolsResultSchema,
        );
        
        for (const tool of toolsResults.tools) {
          const prefixedName = `${serverName}__${tool.name}`;
          const enabled = toolManager.isToolEnabled(prefixedName);
          allTools.push({
            name: tool.name,
            server: serverName,
            enabled,
          });
        }
      } catch (error) {
        // Ignore errors for individual servers
      }
    }
    
    // Update state for new tools (enable them by default)
    const toolObjects = allTools.map(t => ({
      name: `${t.server}__${t.name}`,
      description: `[${t.server}] ${t.name}`,
      input_schema: {},
    }));
    const hadNewTools = toolManager.updateStateForNewTools(toolObjects as any);
    
    // If new tools were detected and enabled, reload tools to make them available
    if (hadNewTools) {
      await (this.client as any).initMCPTools();
      // Re-check enabled status after reload
      for (const tool of allTools) {
        const prefixedName = `${tool.server}__${tool.name}`;
        tool.enabled = toolManager.isToolEnabled(prefixedName);
      }
    }
    
    // Filter to only enabled tools
    const enabledTools = allTools.filter(t => t.enabled);
    
    if (enabledTools.length === 0) {
      this.logger.log('\n📋 Enabled Tools:\n', { type: 'info' });
      this.logger.log('  No enabled tools.\n', { type: 'warning' });
      this.logger.log('  Use /tools-manager to enable tools.\n', { type: 'info' });
      return;
    }
    
    // Group by server
    const toolsByServer = new Map<string, Array<{ name: string }>>();
    for (const tool of enabledTools) {
      if (!toolsByServer.has(tool.server)) {
        toolsByServer.set(tool.server, []);
      }
      toolsByServer.get(tool.server)!.push({ name: tool.name });
    }
    
    this.logger.log('\n📋 Enabled Tools:\n', { type: 'info' });
    
    for (const [serverName, tools] of toolsByServer.entries()) {
      this.logger.log(
        `\n[${serverName}] (${tools.length} enabled):\n`,
        { type: 'info' },
      );
      
      for (const tool of tools) {
        this.logger.log(
          `  ✓ ${tool.name}\n`,
          { type: 'info' },
        );
      }
    }
    
    this.logger.log('\n');
  }

  private async interactiveToolSelection(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }
    
    const toolManager = this.client.getToolManager();
    
    // Save initial state to revert to on cancel
    const initialState = { ...toolManager.getToolStates() };
    
    // Collect all tools from all servers
    const allTools: Array<{ name: string; server: string; toolName: string; enabled: boolean }> = [];
    const servers = (this.client as any).servers as Map<string, any>;
    const serverList: string[] = [];
    
    for (const [serverName, connection] of servers.entries()) {
      serverList.push(serverName);
      try {
        const toolsResults = await connection.client.request(
          { method: 'tools/list' },
          ListToolsResultSchema,
        );
        
        for (const tool of toolsResults.tools) {
          const prefixedName = `${serverName}__${tool.name}`;
          const enabled = toolManager.isToolEnabled(prefixedName);
          allTools.push({
            name: tool.name,
            server: serverName,
            toolName: prefixedName,
            enabled,
          });
        }
      } catch (error) {
        // Ignore errors
      }
    }
    
    // Update state for new tools
    const toolObjects = allTools.map(t => ({
      name: t.toolName,
      description: `[${t.server}] ${t.name}`,
      input_schema: {},
    }));
    toolManager.updateStateForNewTools(toolObjects as any);
    
    // Create index mapping
    const indexToTool = new Map<number, typeof allTools[0]>();
    let toolIndex = 1;
    
    // Group tools by server
    const toolsByServer = new Map<string, typeof allTools>();
    for (const tool of allTools) {
      if (!toolsByServer.has(tool.server)) {
        toolsByServer.set(tool.server, []);
      }
      toolsByServer.get(tool.server)!.push(tool);
    }
    
    const sortedServers = Array.from(toolsByServer.entries()).sort((a, b) => 
      a[0].localeCompare(b[0])
    );
    
    // Clear screen before entering the loop
    process.stdout.write('\x1B[2J\x1B[0f');
    
    while (true) {
      // Clear and display
      process.stdout.write('\x1B[2J\x1B[0f'); // Clear screen
      
      // Use a single write to avoid duplication issues
      let displayText = '\n🔧 Tool Selection\n';
      displayText += 'Available Servers and Tools:\n';
      
      toolIndex = 1;
      indexToTool.clear();
      
      for (let serverIdx = 0; serverIdx < sortedServers.length; serverIdx++) {
        const [serverName, serverTools] = sortedServers[serverIdx];
        const enabledCount = serverTools.filter(t => t.enabled).length;
        const totalCount = serverTools.length;
        
        let serverStatus = '✓';
        if (enabledCount === 0) {
          serverStatus = '✗';
        } else if (enabledCount < totalCount) {
          serverStatus = '~';
        }
        
        displayText += `\nS${serverIdx + 1}. ${serverStatus} [${serverName}] (${enabledCount}/${totalCount} enabled):\n`;
        
        for (const tool of serverTools) {
          const status = tool.enabled ? '✓' : '✗';
          displayText += `  ${toolIndex}. ${status} ${tool.name}\n`;
          indexToTool.set(toolIndex, tool);
          toolIndex++;
        }
      }
      
      displayText += `\nCommands:\n` +
        `  Enter numbers separated by commas or ranges (e.g., 1,3,5-8) to toggle tools\n` +
        `  Enter S + number (e.g., S1, s2) to toggle all tools in a server\n` +
        `  a or all - Enable all tools\n` +
        `  n or none - Disable all tools\n` +
        `  s or save - Save changes and return\n` +
        `  q or quit - Cancel and return\n`;
      
      // Write everything at once to avoid duplication
      process.stdout.write(displayText);
      
      const selection = (await this.rl.question('> ')).trim().toLowerCase();
      
      if (selection === 's' || selection === 'save') {
        // Save all changes to disk
        toolManager.saveState();
        // Reload tools to apply changes
        await (this.client as any).initMCPTools();
        this.logger.log('\n✓ Changes saved\n', { type: 'info' });
        break;
      }
      
      if (selection === 'q' || selection === 'quit') {
        // Restore original state (revert all changes)
        toolManager.restoreState(initialState);
        this.logger.log('\n✗ Changes cancelled - reverted to original state\n', { type: 'warning' });
        break;
      }
      
      if (selection === 'a' || selection === 'all') {
        // Enable all tools (don't save yet)
        for (const tool of allTools) {
          toolManager.setToolEnabled(tool.toolName, true, false);
          tool.enabled = true;
        }
        continue;
      }
      
      if (selection === 'n' || selection === 'none') {
        // Disable all tools (don't save yet)
        for (const tool of allTools) {
          toolManager.setToolEnabled(tool.toolName, false, false);
          tool.enabled = false;
        }
        continue;
      }
      
      // Handle server toggle (S1, s2, etc.)
      if (selection.match(/^s\d+$/i)) {
        const serverNum = parseInt(selection.slice(1)) - 1;
        if (serverNum >= 0 && serverNum < sortedServers.length) {
          const [serverName, serverTools] = sortedServers[serverNum];
          const allEnabled = serverTools.every(t => t.enabled);
          const newState = !allEnabled;
          
          for (const tool of serverTools) {
            toolManager.setToolEnabled(tool.toolName, newState, false);
            // Update the enabled status in allTools array
            tool.enabled = newState;
          }
          
          // Continue loop to refresh display immediately
          continue;
        }
      }
      
      // Handle tool number selection
      if (selection.match(/^[\d,\-\s]+$/)) {
        const parts = selection.split(',').map(p => p.trim());
        const indices: number[] = [];
        
        for (const part of parts) {
          if (part.includes('-')) {
            const [start, end] = part.split('-').map(n => parseInt(n.trim()));
            if (!isNaN(start) && !isNaN(end)) {
              for (let i = start; i <= end; i++) {
                indices.push(i);
              }
            }
          } else {
            const num = parseInt(part);
            if (!isNaN(num)) {
              indices.push(num);
            }
          }
        }
        
        let toggledCount = 0;
        for (const idx of indices) {
          if (indexToTool.has(idx)) {
            const tool = indexToTool.get(idx)!;
            toolManager.toggleTool(tool.toolName, false);
            // Update the enabled status in allTools array
            tool.enabled = toolManager.isToolEnabled(tool.toolName);
            toggledCount++;
          }
        }
        
        if (toggledCount > 0) {
          // Continue loop to refresh display immediately
          continue;
        }
      }
      
      this.logger.log('\nInvalid selection. Please try again.\n', { type: 'error' });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async addPromptToContext(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }
    
    // Get all prompts from all servers
    const allPrompts = this.client.listPrompts();
    
    // Filter to only enabled prompts
    const promptManager = this.client.getPromptManager();
    const enabledPrompts = promptManager.filterPrompts(allPrompts);
    
    if (enabledPrompts.length === 0) {
      this.logger.log('\nNo enabled prompts available. Use /prompts-manager to enable prompts.\n', { type: 'warning' });
      return;
    }
    
    // Create index mapping
    const indexToPrompt = new Map<number, typeof enabledPrompts[0]>();
    let promptIndex = 1;
    
    // Group prompts by server
    const promptsByServer = new Map<string, typeof enabledPrompts>();
    for (const promptData of enabledPrompts) {
      if (!promptsByServer.has(promptData.server)) {
        promptsByServer.set(promptData.server, []);
      }
      promptsByServer.get(promptData.server)!.push(promptData);
    }
    
    const sortedServers = Array.from(promptsByServer.entries()).sort((a, b) => 
      a[0].localeCompare(b[0])
    );
    
    // Display prompts
    this.logger.log('\n📝 Available Prompts:\n', { type: 'info' });
    
    promptIndex = 1;
    indexToPrompt.clear();
    
    for (const [serverName, serverPrompts] of sortedServers) {
      this.logger.log(`\n[${serverName}]:\n`, { type: 'info' });
      
      for (const promptData of serverPrompts) {
        const prompt = promptData.prompt;
        const argsInfo = prompt.arguments && prompt.arguments.length > 0
          ? ` (${prompt.arguments.length} argument${prompt.arguments.length > 1 ? 's' : ''})`
          : '';
        this.logger.log(
          `  ${promptIndex}. ${prompt.name}${argsInfo}\n`,
          { type: 'info' },
        );
        if (prompt.description) {
          this.logger.log(
            `     ${prompt.description}\n`,
            { type: 'info' },
          );
        }
        if (prompt.arguments && prompt.arguments.length > 0) {
          for (const arg of prompt.arguments) {
            const required = arg.required ? ' (required)' : ' (optional)';
            this.logger.log(
              `     - ${arg.name}${required}: ${arg.description || 'No description'}\n`,
              { type: 'info' },
            );
          }
        }
        indexToPrompt.set(promptIndex, promptData);
        promptIndex++;
      }
    }
    
    this.logger.log(
      `\nEnter prompt number(s) separated by commas (e.g., 1,3,5) or 'q' to cancel:\n`,
      { type: 'info' },
    );
    
    const selection = (await this.rl.question('> ')).trim();
    
    if (selection.toLowerCase() === 'q' || selection.toLowerCase() === 'quit') {
      this.logger.log('\n✗ Prompt selection cancelled\n', { type: 'warning' });
      return;
    }
    
    // Parse selection
    const parts = selection.split(',').map(p => p.trim());
    const selectedIndices: number[] = [];
    
    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(n => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            selectedIndices.push(i);
          }
        }
      } else {
        const num = parseInt(part);
        if (!isNaN(num)) {
          selectedIndices.push(num);
        }
      }
    }
    
    if (selectedIndices.length === 0) {
      this.logger.log('\n✗ No valid prompts selected\n', { type: 'warning' });
      return;
    }
    
    // Process each selected prompt
    const selectedPrompts: Array<typeof allPrompts[0]> = [];
    for (const idx of selectedIndices) {
      if (indexToPrompt.has(idx)) {
        selectedPrompts.push(indexToPrompt.get(idx)!);
      }
    }
    
    if (selectedPrompts.length === 0) {
      this.logger.log('\n✗ No valid prompts found\n', { type: 'warning' });
      return;
    }
    
    // For each selected prompt, collect arguments and get messages
    for (const promptData of selectedPrompts) {
      const prompt = promptData.prompt;
      let promptArgs: Record<string, string> = {};
      
      // Collect arguments if the prompt has any
      if (prompt.arguments && prompt.arguments.length > 0) {
        this.logger.log(
          `\n📝 Entering arguments for prompt: ${prompt.name}\n`,
          { type: 'info' },
        );
        
        for (const arg of prompt.arguments) {
          const required = arg.required !== false; // Default to required if not specified
          const defaultValue = required ? '' : ' (optional, press Enter to skip)';
          
          this.logger.log(
            `  ${arg.name}${arg.description ? ` - ${arg.description}` : ''}${defaultValue}:\n`,
            { type: 'info' },
          );
          
          const value = (await this.rl.question('  > ')).trim();
          
          if (required && !value) {
            this.logger.log(
              `\n⚠️ Required argument "${arg.name}" is missing. Skipping this prompt.\n`,
              { type: 'warning' },
            );
            promptArgs = {}; // Clear args to skip this prompt
            break;
          }
          
          if (value) {
            promptArgs[arg.name] = value;
          }
        }
      }
      
      // Get prompt messages if we have all required arguments
      if (prompt.arguments && prompt.arguments.length > 0) {
        const requiredArgs = prompt.arguments.filter(a => a.required !== false);
        const hasAllRequired = requiredArgs.every(a => promptArgs[a.name]);
        
        if (!hasAllRequired) {
          this.logger.log(
            `\n⚠️ Missing required arguments for prompt "${prompt.name}". Skipping.\n`,
            { type: 'warning' },
          );
          continue;
        }
      }
      
      try {
        // Get the prompt messages
        const promptResult = await this.client.getPrompt(
          promptData.server,
          prompt.name,
          Object.keys(promptArgs).length > 0 ? promptArgs : undefined,
        );
        
        // Add prompt messages to conversation context
        // Convert PromptMessage format to our Message format
        for (const msg of promptResult.messages) {
          if (msg.role === 'user' && msg.content) {
            let contentText = '';
            
            if (msg.content.type === 'text') {
              contentText = msg.content.text;
            } else if (msg.content.type === 'resource') {
              // Handle resource content
              const resourceText = 'text' in msg.content.resource 
                ? msg.content.resource.text 
                : '[Binary resource]';
              contentText = `[Resource: ${msg.content.resource.uri}]\n${resourceText}`;
            } else {
              // Fallback for other content types
              contentText = JSON.stringify(msg.content);
            }
            
            // Add to messages array (but don't send automatically)
            (this.client as any).messages.push({
              role: 'user',
              content: contentText,
            });
            
            // Log prompt message to chat history
            this.client.getChatHistoryManager().addUserMessage(contentText);
            
            // Update token count
            const tokenCounter = (this.client as any).tokenCounter;
            if (tokenCounter) {
              const messageTokenCount = tokenCounter.countMessageTokens({
                role: 'user',
                content: contentText,
              });
              (this.client as any).currentTokenCount += messageTokenCount;
            }
          }
        }
        
        const messageCount = promptResult.messages.length;
        this.logger.log(
          `\n✓ Added prompt "${prompt.name}" to conversation context (${messageCount} message${messageCount > 1 ? 's' : ''} added)\n`,
          { type: 'info' },
        );
      } catch (error) {
        this.logger.log(
          `\n✗ Failed to get prompt "${prompt.name}": ${error}\n`,
          { type: 'error' },
        );
      }
    }
    
    const totalMessages = (this.client as any).messages.length;
    this.logger.log(
      `\n✓ Prompt selection complete. ${totalMessages} message(s) in context.\n`,
      { type: 'info' },
    );
  }

  private async displayPromptsList(): Promise<void> {
    const promptManager = this.client.getPromptManager();
    
    // Get all prompts from all servers
    const allPrompts = this.client.listPrompts();
    
    // Filter to only enabled prompts
    const enabledPrompts = promptManager.filterPrompts(allPrompts);
    
    if (enabledPrompts.length === 0) {
      this.logger.log('\n📋 Enabled Prompts:\n', { type: 'info' });
      this.logger.log('  No enabled prompts.\n', { type: 'warning' });
      this.logger.log('  Use /prompts-manager to enable prompts.\n', { type: 'info' });
      return;
    }
    
    // Group by server
    const promptsByServer = new Map<string, Array<{ name: string }>>();
    for (const promptData of enabledPrompts) {
      if (!promptsByServer.has(promptData.server)) {
        promptsByServer.set(promptData.server, []);
      }
      promptsByServer.get(promptData.server)!.push({ 
        name: promptData.prompt.name
      });
    }
    
    this.logger.log('\n📋 Enabled Prompts:\n', { type: 'info' });
    
    for (const [serverName, prompts] of promptsByServer.entries()) {
      this.logger.log(
        `\n[${serverName}] (${prompts.length} enabled):\n`,
        { type: 'info' },
      );
      
      for (const prompt of prompts) {
        this.logger.log(
          `  ✓ ${prompt.name}\n`,
          { type: 'info' },
        );
      }
    }
    
    this.logger.log('\n');
  }

  private async interactivePromptManager(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }
    
    const promptManager = this.client.getPromptManager();
    
    // Save initial state to revert to on cancel
    const initialState = { ...promptManager.getPromptStates() };
    
    // Collect all prompts from all servers
    const allPrompts = this.client.listPrompts();
    
    if (allPrompts.length === 0) {
      this.logger.log('\nNo prompts available from any server.\n', { type: 'warning' });
      return;
    }
    
    // Create index mapping
    const indexToPrompt = new Map<number, typeof allPrompts[0]>();
    let promptIndex = 1;
    
    // Group prompts by server
    const promptsByServer = new Map<string, typeof allPrompts>();
    for (const promptData of allPrompts) {
      if (!promptsByServer.has(promptData.server)) {
        promptsByServer.set(promptData.server, []);
      }
      promptsByServer.get(promptData.server)!.push(promptData);
    }
    
    const sortedServers = Array.from(promptsByServer.entries()).sort((a, b) => 
      a[0].localeCompare(b[0])
    );
    
    // Clear screen before entering the loop
    process.stdout.write('\x1B[2J\x1B[0f');
    
    while (true) {
      // Clear and display
      process.stdout.write('\x1B[2J\x1B[0f'); // Clear screen
      
      // Use a single write to avoid duplication issues
      let displayText = '\n📝 Prompt Manager\n';
      displayText += 'Available Servers and Prompts:\n';
      
      promptIndex = 1;
      indexToPrompt.clear();
      
      for (let serverIdx = 0; serverIdx < sortedServers.length; serverIdx++) {
        const [serverName, serverPrompts] = sortedServers[serverIdx];
        const enabledCount = serverPrompts.filter(p => 
          promptManager.isPromptEnabled(p.server, p.prompt.name)
        ).length;
        const totalCount = serverPrompts.length;
        
        let serverStatus = '✓';
        if (enabledCount === 0) {
          serverStatus = '✗';
        } else if (enabledCount < totalCount) {
          serverStatus = '~';
        }
        
        displayText += `\nS${serverIdx + 1}. ${serverStatus} [${serverName}] (${enabledCount}/${totalCount} enabled):\n`;
        
        for (const promptData of serverPrompts) {
          const enabled = promptManager.isPromptEnabled(promptData.server, promptData.prompt.name);
          const status = enabled ? '✓' : '✗';
          displayText += `  ${promptIndex}. ${status} ${promptData.prompt.name}\n`;
          indexToPrompt.set(promptIndex, promptData);
          promptIndex++;
        }
      }
      
      displayText += `\nCommands:\n` +
        `  Enter numbers separated by commas or ranges (e.g., 1,3,5-8) to toggle prompts\n` +
        `  Enter S + number (e.g., S1, s2) to toggle all prompts in a server\n` +
        `  a or all - Enable all prompts\n` +
        `  n or none - Disable all prompts\n` +
        `  s or save - Save changes and return\n` +
        `  q or quit - Cancel and return\n`;
      
      // Write everything at once to avoid duplication
      process.stdout.write(displayText);
      
      const selection = (await this.rl.question('> ')).trim().toLowerCase();
      
      if (selection === 's' || selection === 'save') {
        // Save all changes to disk
        promptManager.saveState();
        this.logger.log('\n✓ Changes saved\n', { type: 'info' });
        break;
      }
      
      if (selection === 'q' || selection === 'quit') {
        // Restore original state (revert all changes)
        promptManager.restoreState(initialState);
        this.logger.log('\n✗ Changes cancelled - reverted to original state\n', { type: 'warning' });
        break;
      }
      
      if (selection === 'a' || selection === 'all') {
        // Enable all prompts (don't save yet)
        for (const promptData of allPrompts) {
          promptManager.setPromptEnabled(promptData.server, promptData.prompt.name, true, false);
        }
        continue;
      }
      
      if (selection === 'n' || selection === 'none') {
        // Disable all prompts (don't save yet)
        for (const promptData of allPrompts) {
          promptManager.setPromptEnabled(promptData.server, promptData.prompt.name, false, false);
        }
        continue;
      }
      
      // Handle server toggle (S1, s2, etc.)
      if (selection.match(/^s\d+$/i)) {
        const serverNum = parseInt(selection.slice(1)) - 1;
        if (serverNum >= 0 && serverNum < sortedServers.length) {
          const [serverName, serverPrompts] = sortedServers[serverNum];
          const allEnabled = serverPrompts.every(p => 
            promptManager.isPromptEnabled(p.server, p.prompt.name)
          );
          const newState = !allEnabled;
          
          for (const promptData of serverPrompts) {
            promptManager.setPromptEnabled(promptData.server, promptData.prompt.name, newState, false);
          }
          
          // Continue loop to refresh display immediately
          continue;
        }
      }
      
      // Handle prompt number selection
      if (selection.match(/^[\d,\-\s]+$/)) {
        const parts = selection.split(',').map(p => p.trim());
        const indices: number[] = [];
        
        for (const part of parts) {
          if (part.includes('-')) {
            const [start, end] = part.split('-').map(n => parseInt(n.trim()));
            if (!isNaN(start) && !isNaN(end)) {
              for (let i = start; i <= end; i++) {
                indices.push(i);
              }
            }
          } else {
            const num = parseInt(part);
            if (!isNaN(num)) {
              indices.push(num);
            }
          }
        }
        
        let toggledCount = 0;
        for (const idx of indices) {
          if (indexToPrompt.has(idx)) {
            const promptData = indexToPrompt.get(idx)!;
            promptManager.togglePrompt(promptData.server, promptData.prompt.name, false);
            toggledCount++;
          }
        }
        
        if (toggledCount > 0) {
          // Continue loop to refresh display immediately
          continue;
        }
      }
      
      this.logger.log('\nInvalid selection. Please try again.\n', { type: 'error' });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async displayChatList(): Promise<void> {
    const historyManager = this.client.getChatHistoryManager();
    const chats = historyManager.getAllChats();
    
    this.logger.log('\n📚 Recent chat sessions:\n', { type: 'info' });
    
    if (chats.length === 0) {
      this.logger.log('  No chat sessions found.\n', { type: 'info' });
      return;
    }
    
    for (const chat of chats.slice(0, 10)) {
      const duration = chat.duration ? `${Math.round(chat.duration / 1000)}s` : '∞';
      const date = new Date(chat.startTime).toLocaleString();
      this.logger.log(
        `  ${chat.sessionId} | ${date} | ${chat.messageCount} messages | ${duration}\n`,
        { type: 'info' }
      );
      // TODO: Fix summary creation logic - re-enable summary display when summary is properly implemented
      // if (chat.summary) {
      //   this.logger.log(`    → ${chat.summary}\n`, { type: 'info' });
      // }
      if (chat.tags && chat.tags.length > 0) {
        this.logger.log(`    Tags: ${chat.tags.join(', ')}\n`, { type: 'info' });
      }
    }
    
    if (chats.length > 10) {
      this.logger.log(`\n  ... and ${chats.length - 10} more sessions\n`, { type: 'info' });
    }
  }

  private async searchChats(keyword: string): Promise<void> {
    const historyManager = this.client.getChatHistoryManager();
    const results = historyManager.searchChats(keyword);
    
    this.logger.log(`\n📍 Found ${results.length} matching chat(s):\n`, { type: 'info' });
    
    if (results.length === 0) {
      this.logger.log('  No chats found matching your search.\n', { type: 'info' });
      return;
    }
    
    for (const chat of results) {
      const date = new Date(chat.startTime).toLocaleString();
      this.logger.log(
        `  ${chat.sessionId} | ${date} | ${chat.messageCount} messages\n`,
        { type: 'info' }
      );
      // TODO: Fix summary creation logic - re-enable summary display when summary is properly implemented
      // if (chat.summary) {
      //   this.logger.log(`    → ${chat.summary}\n`, { type: 'info' });
      // }
    }
  }

  private async restoreChat(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }
    
    const historyManager = this.client.getChatHistoryManager();
    const chats = historyManager.getAllChats();
    
    if (chats.length === 0) {
      this.logger.log('\nNo chat sessions available to restore.\n', { type: 'warning' });
      return;
    }
    
    const path = await import('path');
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const pageSize = 10;
    let offset = 0;
    
    while (true) {
      const endIndex = Math.min(offset + pageSize, chats.length);
      const pageChats = chats.slice(offset, endIndex);
      
      this.logger.log('\n📖 Select a chat to restore as context:\n', { type: 'info' });
      
      for (let i = 0; i < pageChats.length; i++) {
        const chat = pageChats[i];
        const date = new Date(chat.startTime).toLocaleString();
        // TODO: Fix summary creation logic - re-enable summary display when summary is properly implemented
        // const summary = chat.summary ? ` - ${chat.summary}` : '';
        const summary = '';
        
        // Extract short session ID (last part after last hyphen)
        const shortSessionId = chat.sessionId.split('-').pop() || chat.sessionId;
        
        // Extract folder name from filePath
        const chatDir = path.basename(path.dirname(chat.filePath));
        // If folder is a date folder (YYYY-MM-DD), consider it as root
        const folderName = datePattern.test(chatDir) ? 'root' : chatDir;
        const folderDisplay = folderName !== 'root' ? ` | Folder: ${folderName}` : '';
        
        // Display number relative to current page (1-10)
        const displayNumber = i + 1;
        this.logger.log(
          `  ${displayNumber}. ${shortSessionId} | ${date} | ${chat.messageCount} messages${folderDisplay}${summary}\n`,
          { type: 'info' }
        );
      }
      
      // Show pagination info
      const pageInfo = `\nPage ${Math.floor(offset / pageSize) + 1} of ${Math.ceil(chats.length / pageSize)} (Showing ${offset + 1}-${endIndex} of ${chats.length})\n`;
      this.logger.log(pageInfo, { type: 'info' });
      
      // Build navigation prompt
      let prompt = '\nEnter number to select, ';
      if (offset + pageSize < chats.length) {
        prompt += '"n" for next page, ';
      }
      if (offset > 0) {
        prompt += '"p" for previous page, ';
      }
      prompt += 'or "q" to cancel: ';
      
      const selection = (await this.rl.question(prompt)).trim().toLowerCase();
      
      if (selection === 'q' || selection === 'quit') {
        this.logger.log('\nCancelled.\n', { type: 'info' });
        return;
      }
      
      // Handle pagination
      if (selection === 'n' || selection === 'next') {
        if (offset + pageSize < chats.length) {
          offset += pageSize;
          continue;
        } else {
          this.logger.log('\nAlready on the last page.\n', { type: 'warning' });
          continue;
        }
      }
      
      if (selection === 'p' || selection === 'prev' || selection === 'previous') {
        if (offset > 0) {
          offset = Math.max(0, offset - pageSize);
          continue;
        } else {
          this.logger.log('\nAlready on the first page.\n', { type: 'warning' });
          continue;
        }
      }
      
      // Handle number selection
      const index = parseInt(selection) - 1;
      if (isNaN(index) || index < 0 || index >= pageChats.length) {
        this.logger.log('\nInvalid selection. Please enter a valid number, "n", "p", or "q".\n', { type: 'error' });
        continue;
      }
      
      // Get the actual chat from the full list using the offset
      const selectedChat = chats[offset + index];
      const fullChat = historyManager.loadChat(selectedChat.sessionId);
      
      if (!fullChat) {
        this.logger.log('\nFailed to load chat session.\n', { type: 'error' });
        return;
      }
      
      // Load messages into current conversation context
      const messages = (this.client as any).messages;
      const newMessages: any[] = [];
      let restoredCount = 0;
      
      // Restore messages in reverse order (oldest first) so they appear in correct order when prepended
      for (const msg of fullChat.messages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          const messageObj = {
            role: msg.role,
            content: msg.content,
          };
          newMessages.push(messageObj);
          
          // Also add to ChatHistoryManager so they're saved with the current session
          if (msg.role === 'user') {
            historyManager.addUserMessage(msg.content);
          } else if (msg.role === 'assistant') {
            historyManager.addAssistantMessage(msg.content);
          }
          restoredCount++;
        } else if (msg.role === 'tool') {
          // Also restore tool executions
          if (msg.toolName && msg.toolInput !== undefined && msg.toolOutput !== undefined) {
            historyManager.addToolExecution(
              msg.toolName,
              msg.toolInput,
              msg.toolOutput,
              msg.orchestratorMode || false,
              msg.isIPCCall || false,
              msg.toolInputTime // Preserve original input time if available
            );
            restoredCount++;
          }
        }
      }
      
      // Prepend restored messages to current conversation (for the model context)
      messages.unshift(...newMessages);
      
      // Update token count (approximate)
      const tokenCounter = (this.client as any).tokenCounter;
      for (const msg of newMessages) {
        (this.client as any).currentTokenCount += tokenCounter.countMessageTokens(msg);
      }
      
      this.logger.log(
        `\n✓ Restored ${restoredCount} messages from chat session ${selectedChat.sessionId}\n`,
        { type: 'success' }
      );
      break; // Exit the pagination loop after successful selection
    }
  }

  /**
   * Shared function to handle parent folder selection UI
   * Returns the selected parent folder name, or undefined if none selected
   */
  private async selectParentFolder(historyManager: any): Promise<string | undefined> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }

    const moveToFolder = (await this.rl.question('\nMove to a parent folder? (y/n, default: n): ')).trim().toLowerCase();
    
    if (moveToFolder !== 'y' && moveToFolder !== 'yes') {
      return undefined;
    }

    // Get existing folders
    const allFolders = historyManager.getExistingFolders();
    
    // Filter out folders with date names (YYYY-MM-DD format)
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const existingFolders = allFolders.filter((folder: string) => !datePattern.test(folder));
    
    if (existingFolders.length > 0) {
      this.logger.log('\n📁 Existing parent folders:\n', { type: 'info' });
      existingFolders.forEach((folder: string, i: number) => {
        this.logger.log(`  ${i + 1}. ${folder}`, { type: 'info' });
      });
      this.logger.log(`  ${existingFolders.length + 1}. Create new parent folder\n`, { type: 'info' });
      
      const folderChoice = (await this.rl.question('Select folder number (or enter new folder name): ')).trim();
      
      // Check if it's a number
      const folderIndex = parseInt(folderChoice) - 1;
      if (!isNaN(folderIndex) && folderIndex >= 0 && folderIndex < existingFolders.length) {
        // Selected existing folder
        const selectedFolder = existingFolders[folderIndex];
        this.logger.log(`\nSelected parent folder: ${selectedFolder}\n`, { type: 'info' });
        return selectedFolder;
      } else if (!isNaN(folderIndex) && folderIndex === existingFolders.length) {
        // User wants to create new folder
        const newFolderName = (await this.rl.question('Enter new parent folder name: ')).trim();
        if (newFolderName) {
          return newFolderName;
        } else {
          this.logger.log('\nFolder name cannot be empty. Will be in root chats directory.\n', { type: 'warning' });
          return undefined;
        }
      } else {
        // User entered a folder name directly
        return folderChoice;
      }
    } else {
      // No existing folders (excluding date folders), just ask for folder name
      const folderInput = (await this.rl.question('Enter parent folder name (will be created if it doesn\'t exist): ')).trim();
      if (folderInput) {
        return folderInput;
      } else {
        this.logger.log('\nFolder name cannot be empty. Will be in root chats directory.\n', { type: 'warning' });
        return undefined;
      }
    }
  }

  private async exportChat(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }
    
    const historyManager = this.client.getChatHistoryManager();
    const currentSessionId = historyManager.getCurrentSessionId();
    
    if (!currentSessionId) {
      this.logger.log('\nNo active chat session to export.\n', { type: 'warning' });
      return;
    }
    
    // Get current session metadata to show info
    const currentChat = historyManager.getAllChats().find(chat => chat.sessionId === currentSessionId);
    if (currentChat) {
      const path = await import('path');
      const currentFileName = path.basename(currentChat.filePath);
      const currentDir = path.basename(path.dirname(currentChat.filePath)) || 'root';
      this.logger.log(`\nCurrent filename: ${currentFileName}\nCurrent folder: ${currentDir}\n`, { type: 'info' });
    }

    const folderName = (await this.rl.question('\nEnter name for the export folder (will create a folder with this name): ')).trim();
    
    if (!folderName) {
      this.logger.log('\nName cannot be empty.\n', { type: 'error' });
      return;
    }
    
    // Ask if user wants to move to a parent folder (using shared function)
    const parentFolderName = await this.selectParentFolder(historyManager);
    
    // Ask user about attachments
    const attachmentsAction = (await this.rl.question('\nAttachments: Copy, Move, or Skip? (c/m/s, default: s): ')).trim().toLowerCase();
    let copyAttachments: boolean | null = null;
    if (!attachmentsAction || attachmentsAction === 's' || attachmentsAction === 'skip' || attachmentsAction === 'n' || attachmentsAction === 'none') {
      copyAttachments = null; // Skip (default)
    } else {
      copyAttachments = attachmentsAction !== 'm' && attachmentsAction !== 'move';
    }
    
    // Ask user about outputs
    const outputsAction = (await this.rl.question('Outputs: Copy, Move, or Skip? (c/m/s, default: s): ')).trim().toLowerCase();
    let copyOutputs: boolean | null = null;
    if (!outputsAction || outputsAction === 's' || outputsAction === 'skip' || outputsAction === 'n' || outputsAction === 'none') {
      copyOutputs = null; // Skip (default)
    } else {
      copyOutputs = outputsAction === 'c' || outputsAction === 'copy';
    }
    
    const success = historyManager.exportChat(
      currentSessionId,
      folderName,
      parentFolderName,
      copyAttachments,
      copyOutputs
    );
    
    if (success) {
      const sanitizedName = folderName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const locationMsg = parentFolderName ? ` in "${parentFolderName}/${sanitizedName}/"` : ` in "${sanitizedName}/"`;
      this.logger.log(`\n✓ Chat exported to folder${locationMsg}\n`, { type: 'success' });
    } else {
      this.logger.log(`\n✗ Failed to export chat to folder.\n`, { type: 'error' });
    }
  }

  private async renameChat(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }
    
    const historyManager = this.client.getChatHistoryManager();
    const chats = historyManager.getAllChats();
    
    if (chats.length === 0) {
      this.logger.log('\nNo chat sessions available to rename.\n', { type: 'warning' });
      return;
    }
    
    const path = await import('path');
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const pageSize = 10;
    let offset = 0;

    while (true) {
      const endIndex = Math.min(offset + pageSize, chats.length);
      const pageChats = chats.slice(offset, endIndex);

      this.logger.log('\n📝 Select a chat to rename:\n', { type: 'info' });

      for (let i = 0; i < pageChats.length; i++) {
        const chat = pageChats[i];
        const date = new Date(chat.startTime).toLocaleString();

        // Extract short session ID (last part after last hyphen)
        const shortSessionId = chat.sessionId.split('-').pop() || chat.sessionId;

        // Extract folder name from filePath
        const chatDir = path.basename(path.dirname(chat.filePath));
        // If folder is a date folder (YYYY-MM-DD), consider it as root
        const folderName = datePattern.test(chatDir) ? 'root' : chatDir;
        const folderDisplay = folderName !== 'root' ? ` | Folder: ${folderName}` : '';

        this.logger.log(
          `  ${i + 1}. ${shortSessionId} | ${date} | ${chat.messageCount} messages${folderDisplay}\n`,
          { type: 'info' }
        );
      }
      
      // Show pagination info
      const pageInfo = `\nPage ${Math.floor(offset / pageSize) + 1} of ${Math.ceil(chats.length / pageSize)} (Showing ${offset + 1}-${endIndex} of ${chats.length})\n`;
      this.logger.log(pageInfo, { type: 'info' });
      
      // Build navigation prompt
      let prompt = '\nEnter number to select, ';
      if (offset + pageSize < chats.length) {
        prompt += '"n" for next page, ';
      }
      if (offset > 0) {
        prompt += '"p" for previous page, ';
      }
      prompt += 'or "q" to cancel: ';
      
      const selection = (await this.rl.question(prompt)).trim().toLowerCase();
      
      if (selection === 'q' || selection === 'quit') {
        this.logger.log('\nCancelled.\n', { type: 'info' });
        return;
      }
      
      // Handle pagination
      if (selection === 'n' || selection === 'next') {
        if (offset + pageSize < chats.length) {
          offset += pageSize;
          continue;
        } else {
          this.logger.log('\nAlready on the last page.\n', { type: 'warning' });
          continue;
        }
      }
      
      if (selection === 'p' || selection === 'prev' || selection === 'previous') {
        if (offset > 0) {
          offset = Math.max(0, offset - pageSize);
          continue;
        } else {
          this.logger.log('\nAlready on the first page.\n', { type: 'warning' });
          continue;
        }
      }
      
      // Handle number selection
      const index = parseInt(selection) - 1;
      if (isNaN(index) || index < 0 || index >= pageChats.length) {
        this.logger.log('\nInvalid selection. Please enter a valid number, "n", "p", or "q".\n', { type: 'error' });
        continue;
      }
      
      // Get the actual chat from the full list using the offset
      const selectedChat = chats[offset + index];
      const currentFileName = path.basename(selectedChat.filePath);
      const currentDir = path.basename(path.dirname(selectedChat.filePath)) || 'root';
      
      this.logger.log(`\nCurrent filename: ${currentFileName}\nCurrent folder: ${currentDir}\n`, { type: 'info' });

      const newName = (await this.rl.question('\nEnter name for the chat (will create a folder with this name): ')).trim();
      
      if (!newName) {
        this.logger.log('\nName cannot be empty.\n', { type: 'error' });
        return;
      }
      
      // Ask if user wants to move to a parent folder (using shared function)
      const folderName = await this.selectParentFolder(historyManager);
      
      // Ask user about attachments
      const attachmentsAction = (await this.rl.question('\nAttachments: Copy, Move, or Skip? (c/m/s, default: s): ')).trim().toLowerCase();
      let copyAttachments: boolean | null = null;
      if (!attachmentsAction || attachmentsAction === 's' || attachmentsAction === 'skip' || attachmentsAction === 'n' || attachmentsAction === 'none') {
        copyAttachments = null; // Skip (default)
      } else {
        copyAttachments = attachmentsAction !== 'm' && attachmentsAction !== 'move';
      }
      
      // Ask user about outputs
      const outputsAction = (await this.rl.question('Outputs: Copy, Move, or Skip? (c/m/s, default: s): ')).trim().toLowerCase();
      let copyOutputs: boolean | null = null;
      if (!outputsAction || outputsAction === 's' || outputsAction === 'skip' || outputsAction === 'n' || outputsAction === 'none') {
        copyOutputs = null; // Skip (default)
      } else {
        copyOutputs = outputsAction === 'c' || outputsAction === 'copy';
      }
      
      const updated = historyManager.renameChat(selectedChat.sessionId, newName, folderName, copyAttachments, copyOutputs);
      
      if (updated) {
        const sanitizedName = newName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const locationMsg = folderName ? ` in "${folderName}/${sanitizedName}/"` : ` in "${sanitizedName}/"`;
        this.logger.log(`\n✓ Chat ${selectedChat.sessionId} moved to folder${locationMsg}\n`, { type: 'success' });
      } else {
        this.logger.log(`\n✗ Failed to rename chat ${selectedChat.sessionId}.\n`, { type: 'error' });
      }
      break; // Exit the pagination loop after successful selection
    }
  }

  private async clearChat(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }
    
    const historyManager = this.client.getChatHistoryManager();
    const chats = historyManager.getAllChats();
    
    if (chats.length === 0) {
      this.logger.log('\nNo chat sessions available to clear.\n', { type: 'warning' });
      return;
    }
    
    this.logger.log('\n🗑️  Select a chat to delete:\n', { type: 'info' });
    this.logger.log(`  0. Delete ALL chats (${chats.length} total)\n`, { type: 'warning' });
    
    for (let i = 0; i < Math.min(chats.length, 20); i++) {
      const chat = chats[i];
      const date = new Date(chat.startTime).toLocaleString();
      // TODO: Fix summary creation logic - re-enable summary display when summary is properly implemented
      // const summary = chat.summary ? ` - ${chat.summary}` : '';
      const summary = '';
      this.logger.log(
        `  ${i + 1}. ${chat.sessionId} | ${date} | ${chat.messageCount} messages${summary}\n`,
        { type: 'info' }
      );
    }
    
    const selection = await this.rl.question('\nEnter number (or "q" to cancel): ');
    
    if (selection.toLowerCase() === 'q' || selection.toLowerCase() === 'quit') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }
    
    // Handle "delete all" option
    if (selection === '0') {
      const confirm = (await this.rl.question(`\n⚠️  Are you sure you want to delete ALL ${chats.length} chat(s)? This cannot be undone! (yes/no): `)).trim().toLowerCase();
      
      if (confirm !== 'yes' && confirm !== 'y') {
        this.logger.log('\nCancelled.\n', { type: 'info' });
        return;
      }
      
      const deletedCount = historyManager.deleteAllChats();
      
      if (deletedCount > 0) {
        this.logger.log(`\n✓ Successfully deleted ${deletedCount} chat(s).\n`, { type: 'success' });
      } else {
        this.logger.log(`\n✗ Failed to delete chats.\n`, { type: 'error' });
      }
      return;
    }
    
    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= Math.min(chats.length, 20)) {
      this.logger.log('\nInvalid selection.\n', { type: 'error' });
      return;
    }
    
    const selectedChat = chats[index];
    
    const confirm = (await this.rl.question(`\nAre you sure you want to delete chat ${selectedChat.sessionId}? (yes/no): `)).trim().toLowerCase();
    
    if (confirm !== 'yes' && confirm !== 'y') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }
    
    const deleted = historyManager.deleteChat(selectedChat.sessionId);
    
    if (deleted) {
      this.logger.log(`\n✓ Chat ${selectedChat.sessionId} deleted successfully.\n`, { type: 'success' });
    } else {
      this.logger.log(`\n✗ Failed to delete chat ${selectedChat.sessionId}.\n`, { type: 'error' });
    }
  }

  private async handleAttachmentCommand(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }

    this.logger.log('\n📎 Attachment Mode\n', { type: 'info' });
    this.logger.log('Drag and drop files into the terminal, or type file paths (one per line).\n', { type: 'info' });
    this.logger.log('Type "done" when finished, or "cancel" to abort.\n', { type: 'info' });

    const attachments: AttachmentInfo[] = [];

    while (true) {
      const input = (await this.rl.question('> ')).trim();

      if (input.toLowerCase() === 'done' || input.toLowerCase() === 'd') {
        if (attachments.length === 0) {
          this.logger.log('No files attached. Cancelling.\n', { type: 'warning' });
          return;
        }
        break;
      }

      if (input.toLowerCase() === 'cancel' || input.toLowerCase() === 'c') {
        this.logger.log('Attachment cancelled.\n', { type: 'warning' });
        return;
      }

      if (!input) {
        continue;
      }

      // Handle file path (could be from drag-and-drop or typed)
      // Remove quotes if present (some terminals add them)
      const filePath = input.replace(/^["']|["']$/g, '');

      const attachment = this.attachmentManager.copyFileToAttachments(filePath);
      if (attachment) {
        attachments.push(attachment);
        this.logger.log(
          `  (${attachments.length} file${attachments.length > 1 ? 's' : ''} attached)\n`,
          { type: 'info' },
        );
      }
    }

    // Store attachments to be used with the next user message
    this.pendingAttachments = attachments;
    this.logger.log(
      `\n✓ ${attachments.length} file${attachments.length > 1 ? 's' : ''} attached. They will be included with your next message.\n`,
      { type: 'success' },
    );
    this.logger.log('You can now type your question or prompt.\n', { type: 'info' });
  }

  private async handleAttachmentListCommand(): Promise<void> {
    const attachments = this.attachmentManager.listAttachments();

    if (attachments.length === 0) {
      this.logger.log('\n📎 No attachments found.\n', { type: 'info' });
      this.logger.log('Use /attachment-upload to add attachments.\n', { type: 'info' });
      return;
    }

    this.logger.log(`\n📎 Available Attachments (${attachments.length}):\n`, { type: 'info' });

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const fs = await import('fs');
      const stats = fs.statSync(att.path);
      const sizeKB = (stats.size / 1024).toFixed(2);
      const date = new Date(stats.mtime).toLocaleString();
      
      this.logger.log(
        `  ${i + 1}. ${att.fileName}\n`,
        { type: 'info' },
      );
      this.logger.log(
        `     Type: ${att.mediaType} | Size: ${sizeKB} KB | Modified: ${date}\n`,
        { type: 'info' },
      );
    }
    this.logger.log('\n');
  }

  private async handleAttachmentSelectCommand(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }

    const attachments = this.attachmentManager.listAttachments();

    if (attachments.length === 0) {
      this.logger.log('\n📎 No attachments available to select.\n', { type: 'warning' });
      this.logger.log('Use /attachment-upload to add attachments.\n', { type: 'info' });
      return;
    }

    this.logger.log('\n📎 Select Attachments:\n', { type: 'info' });
    this.logger.log('Enter numbers separated by commas or ranges (e.g., 1,3,5-8) to select attachments.\n', { type: 'info' });

    // Display attachments with indices
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const fs = await import('fs');
      const stats = fs.statSync(att.path);
      const sizeKB = (stats.size / 1024).toFixed(2);
      
      this.logger.log(
        `  ${i + 1}. ${att.fileName} (${att.mediaType}, ${sizeKB} KB)\n`,
        { type: 'info' },
      );
    }

    this.logger.log('\nEnter selection (or "q" to cancel):\n', { type: 'info' });
    const selection = (await this.rl.question('> ')).trim();

    if (selection.toLowerCase() === 'q' || selection.toLowerCase() === 'quit') {
      this.logger.log('\nSelection cancelled.\n', { type: 'warning' });
      return;
    }

    // Parse selection
    const parts = selection.split(',').map(p => p.trim());
    const selectedIndices: number[] = [];

    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(n => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            selectedIndices.push(i);
          }
        }
      } else {
        const num = parseInt(part);
        if (!isNaN(num)) {
          selectedIndices.push(num);
        }
      }
    }

    // Remove duplicates and sort
    const uniqueIndices = [...new Set(selectedIndices)].sort((a, b) => a - b);

    // Validate indices
    const validIndices = uniqueIndices.filter(idx => idx >= 1 && idx <= attachments.length);
    
    if (validIndices.length === 0) {
      this.logger.log('\n✗ No valid attachments selected.\n', { type: 'error' });
      return;
    }

    // Get selected attachments
    const selectedAttachments = validIndices.map(idx => attachments[idx - 1]);

    // Check if OpenAI is being used and filter out PDFs
    const providerName = this.client.getProviderName();
    let finalAttachments = selectedAttachments;
    
    if (providerName === 'openai') {
      const pdfAttachments = selectedAttachments.filter(att => att.mediaType === 'application/pdf');
      const nonPdfAttachments = selectedAttachments.filter(att => att.mediaType !== 'application/pdf');
      
      if (pdfAttachments.length > 0) {
        this.logger.log(
          `\n⚠️  Warning: PDF attachments are not supported by OpenAI.\n`,
          { type: 'warning' },
        );
        this.logger.log(
          `   ${pdfAttachments.length} PDF file(s) excluded: ${pdfAttachments.map(a => a.fileName).join(', ')}\n`,
          { type: 'warning' },
        );
        this.logger.log(
          `   Please use Anthropic provider (--provider=anthropic) for PDF support.\n`,
          { type: 'info' },
        );
        
        if (nonPdfAttachments.length === 0) {
          this.logger.log(
            `\n✗ No valid attachments selected (all were PDFs).\n`,
            { type: 'error' },
          );
          return;
        }
      }
      
      finalAttachments = nonPdfAttachments;
    }

    // Store as pending attachments (only non-PDFs for OpenAI)
    this.pendingAttachments = finalAttachments;

    this.logger.log(
      `\n✓ ${finalAttachments.length} attachment(s) selected. They will be included with your next message.\n`,
      { type: 'success' },
    );
    this.logger.log('You can now type your question or prompt.\n', { type: 'info' });
  }

  private async handleAttachmentRenameCommand(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }

    const attachments = this.attachmentManager.listAttachments();

    if (attachments.length === 0) {
      this.logger.log('\n📎 No attachments available to rename.\n', { type: 'warning' });
      this.logger.log('Use /attachment-upload to add attachments.\n', { type: 'info' });
      return;
    }

    this.logger.log('\n📎 Select Attachment to Rename:\n', { type: 'info' });

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      this.logger.log(
        `  ${i + 1}. ${att.fileName}\n`,
        { type: 'info' },
      );
    }

    const selection = (await this.rl.question('\nEnter number (or "q" to cancel): ')).trim();

    if (selection.toLowerCase() === 'q' || selection.toLowerCase() === 'quit') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= attachments.length) {
      this.logger.log('\nInvalid selection.\n', { type: 'error' });
      return;
    }

    const selectedAttachment = attachments[index];
    this.logger.log(`\nCurrent name: ${selectedAttachment.fileName}\n`, { type: 'info' });

    const newName = (await this.rl.question('Enter new name: ')).trim();

    if (!newName) {
      this.logger.log('\nName cannot be empty.\n', { type: 'error' });
      return;
    }

    // Validate new name (basic validation)
    if (newName.includes('/') || newName.includes('\\')) {
      this.logger.log('\nName cannot contain path separators.\n', { type: 'error' });
      return;
    }

    const success = this.attachmentManager.renameAttachment(selectedAttachment.fileName, newName);

    if (success) {
      // If this attachment was in pending attachments, update it
      const pendingIndex = this.pendingAttachments.findIndex(
        att => att.fileName === selectedAttachment.fileName
      );
      if (pendingIndex !== -1) {
        const updatedInfo = this.attachmentManager.getAttachmentInfo(newName);
        if (updatedInfo) {
          this.pendingAttachments[pendingIndex] = updatedInfo;
        }
      }
    }
  }

  private async handleAttachmentClearCommand(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }

    const attachments = this.attachmentManager.listAttachments();

    if (attachments.length === 0) {
      this.logger.log('\n📎 No attachments available to delete.\n', { type: 'warning' });
      return;
    }

    this.logger.log('\n🗑️  Select Attachments to Delete:\n', { type: 'info' });
    this.logger.log('Enter numbers separated by commas or ranges (e.g., 1,3,5-8) to select attachments.\n', { type: 'info' });
    this.logger.log(`  0. Delete ALL attachments (${attachments.length} total)\n`, { type: 'warning' });

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const fs = await import('fs');
      const stats = fs.statSync(att.path);
      const sizeKB = (stats.size / 1024).toFixed(2);
      
      this.logger.log(
        `  ${i + 1}. ${att.fileName} (${att.mediaType}, ${sizeKB} KB)\n`,
        { type: 'info' },
      );
    }

    const selection = (await this.rl.question('\nEnter selection (or "q" to cancel): ')).trim();

    if (selection.toLowerCase() === 'q' || selection.toLowerCase() === 'quit') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    // Handle "delete all" option
    if (selection === '0') {
      const confirm = (await this.rl.question(`\n⚠️  Are you sure you want to delete ALL ${attachments.length} attachment(s)? This cannot be undone! (yes/no): `)).trim().toLowerCase();
      
      if (confirm !== 'yes' && confirm !== 'y') {
        this.logger.log('\nCancelled.\n', { type: 'info' });
        return;
      }

      const fileNames = attachments.map(att => att.fileName);
      const result = this.attachmentManager.deleteAttachments(fileNames);

      if (result.deleted.length > 0) {
        // Remove deleted attachments from pending list
        this.pendingAttachments = this.pendingAttachments.filter(
          att => !result.deleted.includes(att.fileName)
        );
      }
      return;
    }

    // Parse selection
    const parts = selection.split(',').map(p => p.trim());
    const selectedIndices: number[] = [];

    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(n => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            selectedIndices.push(i);
          }
        }
      } else {
        const num = parseInt(part);
        if (!isNaN(num)) {
          selectedIndices.push(num);
        }
      }
    }

    // Remove duplicates and sort
    const uniqueIndices = [...new Set(selectedIndices)].sort((a, b) => a - b);

    // Validate indices
    const validIndices = uniqueIndices.filter(idx => idx >= 1 && idx <= attachments.length);
    
    if (validIndices.length === 0) {
      this.logger.log('\n✗ No valid attachments selected.\n', { type: 'error' });
      return;
    }

    // Get selected attachments
    const selectedAttachments = validIndices.map(idx => attachments[idx - 1]);
    const fileNames = selectedAttachments.map(att => att.fileName);

    const confirm = (await this.rl.question(`\n⚠️  Are you sure you want to delete ${fileNames.length} attachment(s)? This cannot be undone! (yes/no): `)).trim().toLowerCase();
    
    if (confirm !== 'yes' && confirm !== 'y') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const result = this.attachmentManager.deleteAttachments(fileNames);

    if (result.deleted.length > 0) {
      // Remove deleted attachments from pending list
      this.pendingAttachments = this.pendingAttachments.filter(
        att => !result.deleted.includes(att.fileName)
      );
    }

    if (result.failed.length > 0) {
      this.logger.log(
        `\n⚠️  Failed to delete ${result.failed.length} attachment(s): ${result.failed.join(', ')}\n`,
        { type: 'warning' },
      );
    }
  }

  // ==================== Ablation Study Handlers ====================

  /**
   * Handle /ablation-create command - Interactive wizard to create ablation study
   */
  private async handleAblationCreate(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }

    this.logger.log('\n┌─────────────────────────────────────────────────────────────┐\n', { type: 'info' });
    this.logger.log('│  ABLATION STUDY CREATOR                                     │\n', { type: 'info' });
    this.logger.log('└─────────────────────────────────────────────────────────────┘\n', { type: 'info' });

    // Step 1: Basic Info
    this.logger.log('\nStep 1: Basic Info\n', { type: 'info' });

    const name = (await this.rl.question('  Ablation name: ')).trim();
    if (!name) {
      this.logger.log('\n✗ Ablation name is required.\n', { type: 'error' });
      return;
    }

    // Check if already exists
    const existing = this.ablationManager.load(name);
    if (existing) {
      this.logger.log(`\n✗ Ablation "${name}" already exists. Use /ablation-edit to modify it.\n`, { type: 'error' });
      return;
    }

    const description = (await this.rl.question('  Description (optional): ')).trim();

    // Step 2: Define Phases
    this.logger.log('\nStep 2: Define Phases (command sequences)\n', { type: 'info' });
    const phases: AblationPhase[] = [];

    while (true) {
      this.logger.log(`\n── Phase ${phases.length + 1} ──────────────────────────────────────────────\n`, { type: 'info' });

      const phaseName = (await this.rl.question('  Phase name: ')).trim();
      if (!phaseName) {
        if (phases.length === 0) {
          this.logger.log('\n✗ At least one phase is required.\n', { type: 'error' });
          continue;
        }
        break;
      }

      // Check for duplicate phase name
      if (phases.some(p => p.name === phaseName)) {
        this.logger.log('\n✗ Phase name already exists. Please use a unique name.\n', { type: 'error' });
        continue;
      }

      this.logger.log('  Enter commands (empty line to finish):\n', { type: 'info' });
      this.logger.log('  Commands starting with "/" will execute to show their output.\n', { type: 'info' });
      this.logger.log('  Type "done" to finish the phase.\n', { type: 'info' });
      const commands: string[] = [];
      let pendingCommand: string | null = null; // Track commands waiting for an argument

      while (true) {
        const input = (await this.rl.question('    > ')).trim();

        if (!input || input.toLowerCase() === 'done') {
          // If there's a pending command without argument, warn the user
          if (pendingCommand) {
            this.logger.log(`    ⚠ Warning: "${pendingCommand}" was not recorded (missing argument)\n`, { type: 'warning' });
            pendingCommand = null;
          }
          break;
        }

        // Check if there's a pending command waiting for an argument
        if (pendingCommand) {
          // Combine the pending command with this input as the argument
          let fullCommand = `${pendingCommand} ${input}`;

          // Check if this is /add-prompt and the selected prompt has arguments
          if (pendingCommand.toLowerCase() === '/add-prompt') {
            const promptArgs = await this.collectPromptArgumentsForAblation(input);
            if (promptArgs) {
              fullCommand = `${fullCommand} ${JSON.stringify(promptArgs)}`;
            }
          }

          commands.push(fullCommand);
          this.logger.log(`    ✓ Recorded: ${fullCommand}\n`, { type: 'success' });
          pendingCommand = null;
          continue;
        }

        // Check if this is a command that needs an argument
        const needsArgument = this.commandNeedsArgument(input);

        if (needsArgument) {
          // Show preview and wait for argument
          pendingCommand = input;
          await this.executeAblationPreviewCommand(input);
          this.logger.log(`    ↳ Enter selection for ${input}:\n`, { type: 'info' });
        } else {
          // Record the input directly
          commands.push(input);
          this.logger.log(`    ✓ Recorded: ${input}\n`, { type: 'success' });

          // If it's a command, execute it to show the output
          if (input.startsWith('/')) {
            await this.executeAblationPreviewCommand(input);
          }
        }
      }

      if (commands.length === 0) {
        this.logger.log('\n✗ At least one command is required for a phase.\n', { type: 'error' });
        continue;
      }

      // Show recorded commands
      this.logger.log(`\n  Recorded ${commands.length} command(s):\n`, { type: 'info' });
      for (let i = 0; i < commands.length; i++) {
        this.logger.log(`    ${i + 1}. ${commands[i]}\n`, { type: 'info' });
      }

      phases.push({ name: phaseName, commands });

      const addAnother = (await this.rl.question('\n  Add another phase? (Y/n): ')).trim().toLowerCase();
      if (addAnother === 'n' || addAnother === 'no') {
        break;
      }
    }

    // Step 3: Select Models
    this.logger.log('\nStep 3: Select Models (multi-select)\n', { type: 'info' });
    const models: AblationModel[] = [];

    const providers = [
      { name: 'anthropic', label: 'Anthropic (Claude)', models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'] },
      { name: 'openai', label: 'OpenAI (GPT)', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-mini'] },
      { name: 'gemini', label: 'Google Gemini', models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'] },
      { name: 'ollama', label: 'Ollama (Local)', models: ['llama3.2:3b', 'llama3.1:8b', 'mistral:7b'] },
    ];

    this.logger.log('  Available providers:\n', { type: 'info' });
    for (let i = 0; i < providers.length; i++) {
      this.logger.log(`    ${i + 1}. ${providers[i].label}\n`, { type: 'info' });
    }

    const providerSelection = (await this.rl.question('\n  Select providers (e.g., 1,2 or 1-3): ')).trim();
    const selectedProviderIndices = this.parseSelection(providerSelection, providers.length);

    for (const providerIdx of selectedProviderIndices) {
      const provider = providers[providerIdx - 1];
      this.logger.log(`\n  Select ${provider.label} models:\n`, { type: 'info' });

      for (let i = 0; i < provider.models.length; i++) {
        this.logger.log(`    ${i + 1}. ${provider.models[i]}\n`, { type: 'info' });
      }
      this.logger.log(`    ${provider.models.length + 1}. Enter custom model name\n`, { type: 'info' });
      this.logger.log(`    ${provider.models.length + 2}. Discover models from API\n`, { type: 'info' });

      const modelSelection = (await this.rl.question('\n  Select models (e.g., 1,2 or 1-3): ')).trim();
      const selectedModelIndices = this.parseSelection(modelSelection, provider.models.length + 2);

      for (const modelIdx of selectedModelIndices) {
        if (modelIdx === provider.models.length + 2) {
          // Discover from API
          const discoveredModels = await this.discoverModelsFromAPI(provider.name);
          if (discoveredModels.length > 0) {
            this.logger.log(`\n  Discovered ${discoveredModels.length} models from ${provider.label}:\n`, { type: 'info' });
            for (let i = 0; i < discoveredModels.length; i++) {
              const m = discoveredModels[i];
              const contextInfo = m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}K)` : '';
              this.logger.log(`    ${i + 1}. ${m.id}${contextInfo}\n`, { type: 'info' });
            }
            const discoverSelection = (await this.rl.question('\n  Select discovered models (e.g., 1,2 or 1-3): ')).trim();
            const discoverIndices = this.parseSelection(discoverSelection, discoveredModels.length);
            for (const idx of discoverIndices) {
              models.push({ provider: provider.name, model: discoveredModels[idx - 1].id });
            }
          }
        } else if (modelIdx === provider.models.length + 1) {
          // Custom model
          const customModel = (await this.rl.question('  Enter custom model name: ')).trim();
          if (customModel) {
            models.push({ provider: provider.name, model: customModel });
          }
        } else {
          models.push({ provider: provider.name, model: provider.models[modelIdx - 1] });
        }
      }
    }

    if (models.length === 0) {
      this.logger.log('\n✗ At least one model is required.\n', { type: 'error' });
      return;
    }

    // Step 4: Settings
    this.logger.log('\nStep 4: Settings\n', { type: 'info' });

    const defaultMaxIterations = this.preferencesManager.getMaxIterations();
    const maxIterationsStr = (await this.rl.question(`  Max iterations per run (default ${defaultMaxIterations}): `)).trim();
    const maxIterations = maxIterationsStr ? parseInt(maxIterationsStr) || defaultMaxIterations : defaultMaxIterations;

    // Create the ablation
    try {
      const ablation = this.ablationManager.create({
        name,
        description,
        phases,
        models,
        settings: {
          maxIterations,
        },
      });

      // Display summary
      this.logger.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n', { type: 'info' });
      this.logger.log('\n  ABLATION SUMMARY: ' + ablation.name + '\n', { type: 'info' });
      this.logger.log(`\n  Phases: ${ablation.phases.length}\n`, { type: 'info' });
      for (const phase of ablation.phases) {
        this.logger.log(`    • ${phase.name} (${phase.commands.length} commands)\n`, { type: 'info' });
      }
      this.logger.log(`\n  Models: ${ablation.models.length}\n`, { type: 'info' });
      for (const model of ablation.models) {
        this.logger.log(`    • ${model.provider}/${model.model}\n`, { type: 'info' });
      }
      this.logger.log(`\n  Total runs: ${this.ablationManager.getTotalRuns(ablation)} (${ablation.phases.length} phases × ${ablation.models.length} models)\n`, { type: 'info' });

      this.logger.log(`\n✓ Saved to .mcp-client-data/ablations/${ablation.name}.yaml\n`, { type: 'success' });
    } catch (error) {
      this.logger.log(`\n✗ Failed to create ablation: ${error}\n`, { type: 'error' });
    }
  }

  /**
   * Handle /ablation-list command - List all ablation studies
   */
  private async handleAblationList(): Promise<void> {
    const ablations = this.ablationManager.list();

    if (ablations.length === 0) {
      this.logger.log('\n📊 No ablation studies found.\n', { type: 'warning' });
      this.logger.log('Use /ablation-create to create a new ablation study.\n', { type: 'info' });
      return;
    }

    this.logger.log('\n┌─────────────────────────────────────────────────────────────┐\n', { type: 'info' });
    this.logger.log('│  SAVED ABLATION STUDIES                                     │\n', { type: 'info' });
    this.logger.log('└─────────────────────────────────────────────────────────────┘\n', { type: 'info' });

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      const providers = this.ablationManager.getProviders(ablation);
      const createdDate = new Date(ablation.created).toLocaleDateString();
      const totalRuns = this.ablationManager.getTotalRuns(ablation);

      this.logger.log(`\n  ${i + 1}. ${ablation.name}\n`, { type: 'info' });
      if (ablation.description) {
        this.logger.log(`     ${ablation.description}\n`, { type: 'info' });
      }
      this.logger.log(`     └─ ${ablation.phases.length} phases × ${ablation.models.length} models = ${totalRuns} runs │ ${providers.join(', ')} │ Created: ${createdDate}\n`, { type: 'info' });
    }

    this.logger.log('\n', { type: 'info' });
  }

  /**
   * Handle /ablation-edit command - Edit an existing ablation study
   */
  private async handleAblationEdit(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }

    const ablations = this.ablationManager.list();

    if (ablations.length === 0) {
      this.logger.log('\n📊 No ablation studies found to edit.\n', { type: 'warning' });
      return;
    }

    // Display ablations for selection
    this.logger.log('\n┌─────────────────────────────────────────────────────────────┐\n', { type: 'info' });
    this.logger.log('│  EDIT ABLATION STUDY                                        │\n', { type: 'info' });
    this.logger.log('└─────────────────────────────────────────────────────────────┘\n', { type: 'info' });

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      this.logger.log(`  ${i + 1}. ${ablation.name} (${ablation.phases.length} phases, ${ablation.models.length} models)\n`, { type: 'info' });
    }

    const selection = (await this.rl.question('\nSelect ablation to edit (or "q" to cancel): ')).trim();

    if (selection.toLowerCase() === 'q') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= ablations.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const ablation = ablations[index];

    // Edit menu loop
    while (true) {
      this.logger.log(`\n  Editing: ${ablation.name}\n`, { type: 'info' });
      this.logger.log('\n  What do you want to edit?\n', { type: 'info' });
      this.logger.log('    1. Add phase\n', { type: 'info' });
      this.logger.log('    2. Edit phase\n', { type: 'info' });
      this.logger.log('    3. Remove phase\n', { type: 'info' });
      this.logger.log('    4. Add models\n', { type: 'info' });
      this.logger.log('    5. Remove models\n', { type: 'info' });
      this.logger.log('    6. Edit settings\n', { type: 'info' });
      this.logger.log('    7. Edit description\n', { type: 'info' });
      this.logger.log('    8. Done\n', { type: 'info' });

      const choice = (await this.rl.question('\n  Select option: ')).trim();

      switch (choice) {
        case '1': // Add phase
          await this.handleAddPhase(ablation.name);
          break;
        case '2': // Edit phase
          await this.handleEditPhase(ablation.name);
          break;
        case '3': // Remove phase
          await this.handleRemovePhase(ablation.name);
          break;
        case '4': // Add models
          await this.handleAddModels(ablation.name);
          break;
        case '5': // Remove models
          await this.handleRemoveModels(ablation.name);
          break;
        case '6': // Edit settings
          await this.handleEditSettings(ablation.name);
          break;
        case '7': // Edit description
          await this.handleEditDescription(ablation.name);
          break;
        case '8': // Done
        case 'q':
          const updated = this.ablationManager.load(ablation.name);
          if (updated) {
            this.logger.log(`\n  Updated ablation:\n`, { type: 'info' });
            this.logger.log(`  Phases: ${updated.phases.length}, Models: ${updated.models.length}, Total runs: ${this.ablationManager.getTotalRuns(updated)}\n`, { type: 'info' });
          }
          this.logger.log('\n✓ Changes saved.\n', { type: 'success' });
          return;
        default:
          this.logger.log('\n✗ Invalid option.\n', { type: 'error' });
      }
    }
  }

  /**
   * Create a provider instance from a provider name string
   */
  private createProviderInstance(providerName: string): ModelProvider {
    switch (providerName.toLowerCase()) {
      case 'anthropic':
        return new AnthropicProvider();
      case 'openai':
        return new OpenAIProvider();
      case 'gemini':
        return new GeminiProvider();
      case 'ollama':
        return new OllamaProvider(process.env.OLLAMA_HOST);
      default:
        throw new Error(`Unknown provider: ${providerName}`);
    }
  }

  /**
   * Execute a command during ablation run
   * Handles both slash commands and regular queries to the model
   */
  private async executeAblationCommand(command: string, maxIterations: number): Promise<void> {
    const trimmedCommand = command.trim();

    // Handle slash commands
    if (trimmedCommand.startsWith('/')) {
      // Parse the command
      const parts = trimmedCommand.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      switch (cmd) {
        case '/add-prompt': {
          // /add-prompt <index> [{"arg":"value"}]
          if (args.length === 0) {
            throw new Error('Usage: /add-prompt <index>');
          }
          const promptIndex = parseInt(args[0]) - 1;
          const prompts = this.client.listPrompts();
          if (promptIndex < 0 || promptIndex >= prompts.length) {
            throw new Error(`Invalid prompt index: ${args[0]}`);
          }
          const promptInfo = prompts[promptIndex];

          // Check for JSON arguments (remaining args joined)
          let promptArgs: Record<string, string> | undefined;
          if (args.length > 1) {
            const jsonStr = args.slice(1).join(' ');
            try {
              promptArgs = JSON.parse(jsonStr);
            } catch {
              // Not JSON, ignore
            }
          }

          const promptResult = await this.client.getPrompt(
            promptInfo.server,
            promptInfo.prompt.name,
            promptArgs
          );
          if (promptResult?.messages) {
            for (const msg of promptResult.messages) {
              if (msg.content.type === 'text') {
                // Process the prompt text as a query
                await this.client.processQuery(msg.content.text, false, undefined, () => false);
              }
            }
          }
          break;
        }
        case '/add-attachment': {
          // /add-attachment <index>
          if (args.length === 0) {
            throw new Error('Usage: /add-attachment <index>');
          }
          const attachmentIndex = parseInt(args[0]) - 1;
          const attachments = this.attachmentManager.listAttachments();
          if (attachmentIndex < 0 || attachmentIndex >= attachments.length) {
            throw new Error(`Invalid attachment index: ${args[0]}`);
          }
          const attachment = attachments[attachmentIndex];
          this.pendingAttachments.push(attachment);
          break;
        }
        case '/clear-attachments':
          this.pendingAttachments = [];
          break;
        default:
          // Unknown slash command - log warning but continue
          this.logger.log(`  Warning: Unknown command "${cmd}", skipping\n`, { type: 'warning' });
      }
    } else {
      // Regular query - send to model
      await this.client.processQuery(trimmedCommand, false,
        this.pendingAttachments.length > 0 ? this.pendingAttachments : undefined,
        () => false
      );
      // Clear attachments after use
      this.pendingAttachments = [];
    }
  }

  /**
   * Handle /ablation-run command - Run an ablation study
   */
  private async handleAblationRun(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }

    const ablations = this.ablationManager.list();

    if (ablations.length === 0) {
      this.logger.log('\n📊 No ablation studies found to run.\n', { type: 'warning' });
      return;
    }

    // Display ablations for selection
    this.logger.log('\n┌─────────────────────────────────────────────────────────────┐\n', { type: 'info' });
    this.logger.log('│  RUN ABLATION STUDY                                         │\n', { type: 'info' });
    this.logger.log('└─────────────────────────────────────────────────────────────┘\n', { type: 'info' });

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      const totalRuns = this.ablationManager.getTotalRuns(ablation);
      this.logger.log(`  ${i + 1}. ${ablation.name} (${totalRuns} runs)\n`, { type: 'info' });
    }

    const selection = (await this.rl.question('\nSelect ablation to run (or "q" to cancel): ')).trim();

    if (selection.toLowerCase() === 'q') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= ablations.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const ablation = ablations[index];
    const totalRuns = this.ablationManager.getTotalRuns(ablation);

    // Display run details
    this.logger.log(`\n┌─────────────────────────────────────────────────────────────┐\n`, { type: 'info' });
    this.logger.log(`│  ABLATION: ${ablation.name.padEnd(48)}│\n`, { type: 'info' });
    if (ablation.description) {
      this.logger.log(`│  ${ablation.description.substring(0, 57).padEnd(58)}│\n`, { type: 'info' });
    }
    this.logger.log(`└─────────────────────────────────────────────────────────────┘\n`, { type: 'info' });

    this.logger.log(`\n  Matrix: ${ablation.phases.length} phases × ${ablation.models.length} models = ${totalRuns} runs\n`, { type: 'info' });

    // Display matrix header
    const modelHeaders = ablation.models.map(m => this.ablationManager.getModelShortName(m));
    this.logger.log('\n  ┌─────────────────────', { type: 'info' });
    for (const _ of modelHeaders) {
      this.logger.log('┬─────────────', { type: 'info' });
    }
    this.logger.log('┐\n', { type: 'info' });

    this.logger.log('  │                     ', { type: 'info' });
    for (const header of modelHeaders) {
      this.logger.log(`│ ${header.padEnd(12)}`, { type: 'info' });
    }
    this.logger.log('│\n', { type: 'info' });

    this.logger.log('  ├─────────────────────', { type: 'info' });
    for (const _ of modelHeaders) {
      this.logger.log('┼─────────────', { type: 'info' });
    }
    this.logger.log('┤\n', { type: 'info' });

    for (const phase of ablation.phases) {
      this.logger.log(`  │ ${phase.name.padEnd(19).substring(0, 19)} `, { type: 'info' });
      for (const _ of ablation.models) {
        this.logger.log(`│ ${'pending'.padEnd(12)}`, { type: 'info' });
      }
      this.logger.log('│\n', { type: 'info' });
    }

    this.logger.log('  └─────────────────────', { type: 'info' });
    for (const _ of modelHeaders) {
      this.logger.log('┴─────────────', { type: 'info' });
    }
    this.logger.log('┘\n', { type: 'info' });

    const confirm = (await this.rl.question('\nStart ablation? (Y/n): ')).trim().toLowerCase();
    if (confirm === 'n' || confirm === 'no') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    // Save original provider/model and chat state to restore after ablation
    const originalProviderName = this.client.getProviderName();
    const originalModel = this.client.getModel();
    const savedState = this.client.saveState();
    this.logger.log('\n  Original chat saved. Starting ablation...\n', { type: 'info' });

    // Create run directory
    const { runDir, timestamp } = this.ablationManager.createRunDirectory(ablation.name);

    // Initialize run results
    const run: AblationRun = {
      ablationName: ablation.name,
      startedAt: new Date().toISOString(),
      results: [],
    };

    let runNumber = 0;
    const totalStartTime = Date.now();

    // Execute each phase × model combination
    for (const phase of ablation.phases) {
      const phaseDir = this.ablationManager.createPhaseDirectory(runDir, phase.name);

      for (const model of ablation.models) {
        runNumber++;
        const modelShortName = this.ablationManager.getModelShortName(model);

        this.logger.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`, { type: 'info' });
        this.logger.log(`  RUN ${runNumber}/${totalRuns}: ${phase.name} + ${modelShortName}\n`, { type: 'info' });
        this.logger.log(`  Provider: ${model.provider} │ Model: ${model.model}\n`, { type: 'info' });
        this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`, { type: 'info' });

        const result: AblationRunResult = {
          phase: phase.name,
          model,
          status: 'running',
        };

        const startTime = Date.now();

        try {
          // Create provider instance and switch to this model
          const provider = this.createProviderInstance(model.provider);
          await this.client.switchProviderAndModel(provider, model.model);

          // Execute commands for this phase
          for (let i = 0; i < phase.commands.length; i++) {
            const command = phase.commands[i];
            this.logger.log(`  [${i + 1}/${phase.commands.length}] Executing: ${command}\n`, { type: 'info' });
            await this.executeAblationCommand(command, ablation.settings.maxIterations);
          }

          // Get token usage
          const tokenUsage = this.client.getTokenUsage();
          result.tokens = tokenUsage.current;

          result.status = 'completed';
          result.duration = Date.now() - startTime;
          result.chatFile = `chats/${phase.name}/${this.ablationManager.getChatFileName(model)}`;

          // Save chat history to phase directory
          const chatHistoryManager = this.client.getChatHistoryManager();
          chatHistoryManager.endSession(`Ablation run: ${phase.name} with ${model.provider}/${model.model}`);

          this.logger.log(`\n  ✓ Scenario complete │ Duration: ${(result.duration / 1000).toFixed(1)}s │ Tokens: ${result.tokens}\n`, { type: 'success' });

        } catch (error: any) {
          result.status = 'failed';
          result.error = error.message;
          result.duration = Date.now() - startTime;
          this.logger.log(`\n  ✗ Scenario failed: ${error.message}\n`, { type: 'error' });
        }

        run.results.push(result);

        // Always stop on error
        if (result.status === 'failed') {
          this.logger.log(`\nAblation stopped due to error: ${result.error}\n`, { type: 'error' });
          this.logger.log('Partial results saved.\n', { type: 'warning' });
          break;
        }
      }
    }

    // Finalize run
    run.completedAt = new Date().toISOString();
    run.totalDuration = Date.now() - totalStartTime;
    run.totalTokens = run.results.reduce((sum, r) => sum + (r.tokens || 0), 0);

    // Save results
    this.ablationManager.saveRunResults(runDir, run);

    // Display summary
    this.logger.log(`\n┌─────────────────────────────────────────────────────────────┐\n`, { type: 'info' });
    this.logger.log(`│  ABLATION COMPLETE: ${ablation.name.padEnd(38)}│\n`, { type: 'info' });
    this.logger.log(`└─────────────────────────────────────────────────────────────┘\n`, { type: 'info' });

    this.logger.log(`\n  Results:\n`, { type: 'info' });
    const completedRuns = run.results.filter(r => r.status === 'completed').length;
    const failedRuns = run.results.filter(r => r.status === 'failed').length;
    this.logger.log(`    Completed: ${completedRuns}/${totalRuns}\n`, { type: 'info' });
    if (failedRuns > 0) {
      this.logger.log(`    Failed: ${failedRuns}\n`, { type: 'warning' });
    }
    this.logger.log(`    Total time: ${(run.totalDuration / 1000).toFixed(1)}s\n`, { type: 'info' });
    this.logger.log(`\n  Outputs saved to:\n`, { type: 'info' });
    this.logger.log(`    ${runDir}\n`, { type: 'info' });

    // Restore original provider/model and chat state
    this.logger.log('\n  Restoring original session...\n', { type: 'info' });
    const originalProvider = this.createProviderInstance(originalProviderName);
    await this.client.restoreState(savedState, originalProvider, originalModel);
    this.logger.log(`  ✓ Restored to ${originalProviderName}/${originalModel}\n`, { type: 'success' });
  }

  /**
   * Handle /ablation-delete command - Delete an ablation study
   */
  private async handleAblationDelete(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }

    const ablations = this.ablationManager.list();

    if (ablations.length === 0) {
      this.logger.log('\n📊 No ablation studies found to delete.\n', { type: 'warning' });
      return;
    }

    this.logger.log('\n🗑️  Select ablation to delete:\n', { type: 'info' });

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      this.logger.log(`  ${i + 1}. ${ablation.name}\n`, { type: 'info' });
    }

    const selection = (await this.rl.question('\nSelect ablation (or "q" to cancel): ')).trim();

    if (selection.toLowerCase() === 'q') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= ablations.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const ablation = ablations[index];

    const confirm = (await this.rl.question(`\n⚠️  Delete "${ablation.name}"? This cannot be undone! (yes/no): `)).trim().toLowerCase();

    if (confirm !== 'yes' && confirm !== 'y') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    if (this.ablationManager.delete(ablation.name)) {
      this.logger.log(`\n✓ Deleted ablation "${ablation.name}"\n`, { type: 'success' });
    } else {
      this.logger.log(`\n✗ Failed to delete ablation.\n`, { type: 'error' });
    }
  }

  /**
   * Handle /ablation-results command - View past ablation run results
   */
  private async handleAblationResults(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }

    const ablations = this.ablationManager.list();

    if (ablations.length === 0) {
      this.logger.log('\n📊 No ablation studies found.\n', { type: 'warning' });
      return;
    }

    this.logger.log('\n📊 Select ablation to view results:\n', { type: 'info' });

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      const runs = this.ablationManager.listRuns(ablation.name);
      this.logger.log(`  ${i + 1}. ${ablation.name} (${runs.length} past runs)\n`, { type: 'info' });
    }

    const selection = (await this.rl.question('\nSelect ablation (or "q" to cancel): ')).trim();

    if (selection.toLowerCase() === 'q') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= ablations.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const ablation = ablations[index];
    const runs = this.ablationManager.listRuns(ablation.name);

    if (runs.length === 0) {
      this.logger.log(`\n📊 No runs found for "${ablation.name}".\n`, { type: 'warning' });
      this.logger.log('Use /ablation-run to run this ablation study.\n', { type: 'info' });
      return;
    }

    this.logger.log(`\n📊 Runs for "${ablation.name}":\n`, { type: 'info' });

    for (let i = 0; i < runs.length; i++) {
      const { timestamp, run } = runs[i];
      const completedCount = run.results.filter(r => r.status === 'completed').length;
      const totalCount = run.results.length;
      const duration = run.totalDuration ? `${(run.totalDuration / 1000).toFixed(1)}s` : 'N/A';

      this.logger.log(`  ${i + 1}. ${timestamp}\n`, { type: 'info' });
      this.logger.log(`     └─ ${completedCount}/${totalCount} completed │ Duration: ${duration}\n`, { type: 'info' });
    }

    const runSelection = (await this.rl.question('\nSelect run to view details (or "q" to cancel): ')).trim();

    if (runSelection.toLowerCase() === 'q') {
      return;
    }

    const runIndex = parseInt(runSelection) - 1;
    if (isNaN(runIndex) || runIndex < 0 || runIndex >= runs.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const { run } = runs[runIndex];

    // Display detailed results
    this.logger.log(`\n┌─────────────────────────────────────────────────────────────┐\n`, { type: 'info' });
    this.logger.log(`│  RUN RESULTS                                                │\n`, { type: 'info' });
    this.logger.log(`└─────────────────────────────────────────────────────────────┘\n`, { type: 'info' });

    this.logger.log(`\n  Started: ${run.startedAt}\n`, { type: 'info' });
    this.logger.log(`  Completed: ${run.completedAt || 'N/A'}\n`, { type: 'info' });
    this.logger.log(`  Total Duration: ${run.totalDuration ? (run.totalDuration / 1000).toFixed(1) + 's' : 'N/A'}\n`, { type: 'info' });

    this.logger.log(`\n  Individual Results:\n`, { type: 'info' });

    for (const result of run.results) {
      const status = result.status === 'completed' ? '✓' : result.status === 'failed' ? '✗' : '○';
      const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}s` : 'N/A';
      const modelShort = this.ablationManager.getModelShortName(result.model);

      this.logger.log(`    ${status} ${result.phase} + ${modelShort} │ ${duration}\n`, { type: result.status === 'failed' ? 'error' : 'info' });

      if (result.error) {
        this.logger.log(`      Error: ${result.error}\n`, { type: 'error' });
      }
    }
  }

  // ==================== Ablation Edit Helpers ====================

  private async handleAddPhase(ablationName: string): Promise<void> {
    if (!this.rl) return;

    const phaseName = (await this.rl.question('\n  Phase name: ')).trim();
    if (!phaseName) {
      this.logger.log('\n✗ Phase name required.\n', { type: 'error' });
      return;
    }

    this.logger.log('  Enter commands (empty line to finish):\n', { type: 'info' });
    const commands: string[] = [];

    while (true) {
      const command = (await this.rl.question('    > ')).trim();
      if (!command) break;
      commands.push(command);
    }

    if (commands.length === 0) {
      this.logger.log('\n✗ At least one command required.\n', { type: 'error' });
      return;
    }

    try {
      this.ablationManager.addPhase(ablationName, { name: phaseName, commands });
      this.logger.log('\n✓ Phase added.\n', { type: 'success' });
    } catch (error: any) {
      this.logger.log(`\n✗ ${error.message}\n`, { type: 'error' });
    }
  }

  private async handleEditPhase(ablationName: string): Promise<void> {
    if (!this.rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation || ablation.phases.length === 0) {
      this.logger.log('\n✗ No phases to edit.\n', { type: 'error' });
      return;
    }

    this.logger.log('\n  Select phase to edit:\n', { type: 'info' });
    for (let i = 0; i < ablation.phases.length; i++) {
      this.logger.log(`    ${i + 1}. ${ablation.phases[i].name} (${ablation.phases[i].commands.length} commands)\n`, { type: 'info' });
    }

    const selection = (await this.rl.question('\n  Select phase: ')).trim();
    const index = parseInt(selection) - 1;

    if (isNaN(index) || index < 0 || index >= ablation.phases.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const phase = ablation.phases[index];
    this.logger.log(`\n  Current commands for "${phase.name}":\n`, { type: 'info' });
    for (let i = 0; i < phase.commands.length; i++) {
      this.logger.log(`    ${i + 1}. ${phase.commands[i]}\n`, { type: 'info' });
    }

    this.logger.log('\n  Enter new commands (empty line to finish):\n', { type: 'info' });
    const commands: string[] = [];

    while (true) {
      const command = (await this.rl.question('    > ')).trim();
      if (!command) break;
      commands.push(command);
    }

    if (commands.length === 0) {
      this.logger.log('\n✗ At least one command required. Phase unchanged.\n', { type: 'warning' });
      return;
    }

    try {
      this.ablationManager.updatePhase(ablationName, phase.name, { commands });
      this.logger.log('\n✓ Phase updated.\n', { type: 'success' });
    } catch (error: any) {
      this.logger.log(`\n✗ ${error.message}\n`, { type: 'error' });
    }
  }

  private async handleRemovePhase(ablationName: string): Promise<void> {
    if (!this.rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation || ablation.phases.length === 0) {
      this.logger.log('\n✗ No phases to remove.\n', { type: 'error' });
      return;
    }

    if (ablation.phases.length === 1) {
      this.logger.log('\n✗ Cannot remove the only phase.\n', { type: 'error' });
      return;
    }

    this.logger.log('\n  Select phase to remove:\n', { type: 'info' });
    for (let i = 0; i < ablation.phases.length; i++) {
      this.logger.log(`    ${i + 1}. ${ablation.phases[i].name}\n`, { type: 'info' });
    }

    const selection = (await this.rl.question('\n  Select phase: ')).trim();
    const index = parseInt(selection) - 1;

    if (isNaN(index) || index < 0 || index >= ablation.phases.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    try {
      this.ablationManager.removePhase(ablationName, ablation.phases[index].name);
      this.logger.log('\n✓ Phase removed.\n', { type: 'success' });
    } catch (error: any) {
      this.logger.log(`\n✗ ${error.message}\n`, { type: 'error' });
    }
  }

  private async handleAddModels(ablationName: string): Promise<void> {
    if (!this.rl) return;

    const providers = [
      { name: 'anthropic', label: 'Anthropic', models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'] },
      { name: 'openai', label: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-mini'] },
      { name: 'gemini', label: 'Gemini', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
      { name: 'ollama', label: 'Ollama', models: ['llama3.2:3b', 'llama3.1:8b'] },
    ];

    this.logger.log('\n  Select provider:\n', { type: 'info' });
    for (let i = 0; i < providers.length; i++) {
      this.logger.log(`    ${i + 1}. ${providers[i].label}\n`, { type: 'info' });
    }

    const providerSelection = (await this.rl.question('\n  Select provider: ')).trim();
    const providerIndex = parseInt(providerSelection) - 1;

    if (isNaN(providerIndex) || providerIndex < 0 || providerIndex >= providers.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const provider = providers[providerIndex];
    this.logger.log(`\n  Select ${provider.label} models:\n`, { type: 'info' });
    for (let i = 0; i < provider.models.length; i++) {
      this.logger.log(`    ${i + 1}. ${provider.models[i]}\n`, { type: 'info' });
    }
    this.logger.log(`    ${provider.models.length + 1}. Custom model\n`, { type: 'info' });

    const modelSelection = (await this.rl.question('\n  Select models (e.g., 1,2): ')).trim();
    const selectedIndices = this.parseSelection(modelSelection, provider.models.length + 1);

    const modelsToAdd: AblationModel[] = [];
    for (const idx of selectedIndices) {
      if (idx === provider.models.length + 1) {
        const customModel = (await this.rl.question('  Enter custom model: ')).trim();
        if (customModel) {
          modelsToAdd.push({ provider: provider.name, model: customModel });
        }
      } else {
        modelsToAdd.push({ provider: provider.name, model: provider.models[idx - 1] });
      }
    }

    if (modelsToAdd.length > 0) {
      this.ablationManager.addModels(ablationName, modelsToAdd);
      this.logger.log(`\n✓ Added ${modelsToAdd.length} model(s).\n`, { type: 'success' });
    }
  }

  private async handleRemoveModels(ablationName: string): Promise<void> {
    if (!this.rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation || ablation.models.length === 0) {
      this.logger.log('\n✗ No models to remove.\n', { type: 'error' });
      return;
    }

    if (ablation.models.length === 1) {
      this.logger.log('\n✗ Cannot remove the only model.\n', { type: 'error' });
      return;
    }

    this.logger.log('\n  Select models to remove:\n', { type: 'info' });
    for (let i = 0; i < ablation.models.length; i++) {
      const m = ablation.models[i];
      this.logger.log(`    ${i + 1}. ${m.provider}/${m.model}\n`, { type: 'info' });
    }

    const selection = (await this.rl.question('\n  Select models (e.g., 1,2): ')).trim();
    const selectedIndices = this.parseSelection(selection, ablation.models.length);

    const modelsToRemove = selectedIndices.map(idx => ablation.models[idx - 1]);

    if (modelsToRemove.length > 0 && modelsToRemove.length < ablation.models.length) {
      this.ablationManager.removeModels(ablationName, modelsToRemove);
      this.logger.log(`\n✓ Removed ${modelsToRemove.length} model(s).\n`, { type: 'success' });
    } else if (modelsToRemove.length >= ablation.models.length) {
      this.logger.log('\n✗ Cannot remove all models.\n', { type: 'error' });
    }
  }

  private async handleEditSettings(ablationName: string): Promise<void> {
    if (!this.rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation) return;

    this.logger.log('\n  Current settings:\n', { type: 'info' });
    this.logger.log(`    Max iterations: ${ablation.settings.maxIterations}\n`, { type: 'info' });

    const maxIterStr = (await this.rl.question('\n  Max iterations (Enter to keep): ')).trim();

    const newSettings = { ...ablation.settings };

    if (maxIterStr) {
      const maxIter = parseInt(maxIterStr);
      if (!isNaN(maxIter) && maxIter > 0) newSettings.maxIterations = maxIter;
    }

    this.ablationManager.update(ablationName, { settings: newSettings });
    this.logger.log('\n✓ Settings updated.\n', { type: 'success' });
  }

  private async handleEditDescription(ablationName: string): Promise<void> {
    if (!this.rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation) return;

    this.logger.log(`\n  Current description: ${ablation.description || '(none)'}\n`, { type: 'info' });

    const newDescription = (await this.rl.question('  New description: ')).trim();

    this.ablationManager.update(ablationName, { description: newDescription });
    this.logger.log('\n✓ Description updated.\n', { type: 'success' });
  }

  /**
   * Parse selection string like "1,2,3" or "1-3" into array of indices
   */
  private parseSelection(selection: string, max: number): number[] {
    const parts = selection.split(',').map(p => p.trim());
    const indices: number[] = [];

    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(n => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end && i <= max; i++) {
            if (i >= 1) indices.push(i);
          }
        }
      } else {
        const num = parseInt(part);
        if (!isNaN(num) && num >= 1 && num <= max) {
          indices.push(num);
        }
      }
    }

    return [...new Set(indices)].sort((a, b) => a - b);
  }

  /**
   * Collect prompt arguments during ablation creation
   * Returns the collected arguments as an object, or null if no arguments needed
   */
  private async collectPromptArgumentsForAblation(promptIndexStr: string): Promise<Record<string, string> | null> {
    if (!this.rl) return null;

    const promptIndex = parseInt(promptIndexStr) - 1;
    const prompts = this.client.listPrompts();

    if (promptIndex < 0 || promptIndex >= prompts.length) {
      return null;
    }

    const promptInfo = prompts[promptIndex];
    const prompt = promptInfo.prompt;

    // Check if prompt has arguments
    if (!prompt.arguments || prompt.arguments.length === 0) {
      return null;
    }

    this.logger.log(`    📝 Prompt "${prompt.name}" requires ${prompt.arguments.length} argument(s):\n`, { type: 'info' });

    const args: Record<string, string> = {};

    for (const arg of prompt.arguments) {
      const required = arg.required !== false;
      const optionalText = required ? '' : ' (optional, Enter to skip)';

      this.logger.log(`      ${arg.name}${arg.description ? ` - ${arg.description}` : ''}${optionalText}:\n`, { type: 'info' });

      const value = (await this.rl.question('      > ')).trim();

      if (required && !value) {
        this.logger.log(`      ⚠ Required argument "${arg.name}" is empty\n`, { type: 'warning' });
      }

      if (value) {
        args[arg.name] = value;
      }
    }

    return Object.keys(args).length > 0 ? args : null;
  }

  /**
   * Check if a command needs an argument that should be provided in the next input
   * Returns true for commands like /add-prompt, /add-attachment that need a selection
   */
  private commandNeedsArgument(command: string): boolean {
    const lowerCommand = command.toLowerCase().trim();

    // Commands that need an index/argument
    const commandsNeedingArgs = [
      '/add-prompt',
      '/add-attachment',
      '/attachment-insert',
    ];

    // Check if the command is one that needs an argument AND doesn't already have one
    for (const cmd of commandsNeedingArgs) {
      if (lowerCommand === cmd) {
        // Command without argument
        return true;
      }
      if (lowerCommand.startsWith(cmd + ' ')) {
        // Command already has an argument
        return false;
      }
    }

    return false;
  }

  /**
   * Execute a command in preview mode during ablation creation
   * Shows the command output so user can see what inputs are expected
   */
  private async executeAblationPreviewCommand(command: string): Promise<void> {
    const lowerCommand = command.toLowerCase();

    try {
      // Handle read-only/display commands that help user understand what to input
      if (lowerCommand === '/add-prompt') {
        await this.showPromptListForPreview();
      } else if (lowerCommand === '/prompts' || lowerCommand === '/prompts-list') {
        await this.displayPromptsList();
      } else if (lowerCommand === '/attachment-list') {
        await this.handleAttachmentListCommand();
      } else if (lowerCommand === '/attachment-insert') {
        await this.showAttachmentListForPreview();
      } else if (lowerCommand === '/tools' || lowerCommand === '/tools-list') {
        await this.displayToolsList();
      } else if (lowerCommand === '/help') {
        this.displayHelp();
      } else if (lowerCommand === '/token-status' || lowerCommand === '/tokens') {
        const usage = this.client.getTokenUsage();
        this.logger.log(
          `\n📊 Token Usage Status:\n` +
          `  Current: ${usage.current} tokens\n` +
          `  Limit: ${usage.limit} tokens\n` +
          `  Usage: ${usage.percentage}%\n`,
          { type: 'info' },
        );
      } else if (lowerCommand === '/settings') {
        await this.displaySettings();
      } else {
        // For unrecognized commands, just note it will be executed during the run
        this.logger.log(`    ℹ️  Command will be executed during ablation run\n`, { type: 'info' });
      }
    } catch (error) {
      this.logger.log(`    ⚠️  Preview error: ${error}\n`, { type: 'warning' });
    }
  }

  /**
   * Show prompt list for preview (without asking for selection)
   */
  private async showPromptListForPreview(): Promise<void> {
    const allPrompts = this.client.listPrompts();
    const promptManager = this.client.getPromptManager();
    const enabledPrompts = promptManager.filterPrompts(allPrompts);

    if (enabledPrompts.length === 0) {
      this.logger.log('\n    No enabled prompts available.\n', { type: 'warning' });
      return;
    }

    // Group prompts by server
    const promptsByServer = new Map<string, typeof enabledPrompts>();
    for (const promptData of enabledPrompts) {
      if (!promptsByServer.has(promptData.server)) {
        promptsByServer.set(promptData.server, []);
      }
      promptsByServer.get(promptData.server)!.push(promptData);
    }

    const sortedServers = Array.from(promptsByServer.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );

    this.logger.log('\n    📝 Available Prompts:\n', { type: 'info' });

    let promptIndex = 1;
    for (const [serverName, serverPrompts] of sortedServers) {
      this.logger.log(`\n    [${serverName}]:\n`, { type: 'info' });

      for (const promptData of serverPrompts) {
        const prompt = promptData.prompt;
        const argsInfo = prompt.arguments && prompt.arguments.length > 0
          ? ` (${prompt.arguments.length} arg${prompt.arguments.length > 1 ? 's' : ''})`
          : '';
        this.logger.log(`      ${promptIndex}. ${prompt.name}${argsInfo}\n`, { type: 'info' });
        if (prompt.description) {
          this.logger.log(`         ${prompt.description}\n`, { type: 'info' });
        }
        promptIndex++;
      }
    }

    this.logger.log(`\n    Enter prompt number(s) as next input (e.g., "3" or "1,3,5")\n`, { type: 'info' });
  }

  /**
   * Show attachment list for preview (without asking for selection)
   */
  private async showAttachmentListForPreview(): Promise<void> {
    const attachments = this.attachmentManager.listAttachments();

    if (attachments.length === 0) {
      this.logger.log('\n    📎 No attachments available.\n', { type: 'warning' });
      return;
    }

    this.logger.log('\n    📎 Available Attachments:\n', { type: 'info' });

    const fs = await import('fs');
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const stats = fs.statSync(att.path);
      const sizeKB = (stats.size / 1024).toFixed(2);
      this.logger.log(`      ${i + 1}. ${att.fileName} (${att.mediaType}, ${sizeKB} KB)\n`, { type: 'info' });
    }

    this.logger.log(`\n    Enter attachment number(s) as next input (e.g., "4" or "1,3")\n`, { type: 'info' });
  }

  /**
   * Discover models from provider API
   */
  private async discoverModelsFromAPI(providerName: string): Promise<ModelInfo[]> {
    try {
      this.logger.log(`\n    Fetching models from ${providerName} API...\n`, { type: 'info' });

      let provider: IModelProvider;
      switch (providerName.toLowerCase()) {
        case 'anthropic':
          provider = new AnthropicProvider();
          break;
        case 'openai':
          provider = new OpenAIProvider();
          break;
        case 'gemini':
          provider = new GeminiProvider();
          break;
        case 'ollama':
          provider = new OllamaProvider(process.env.OLLAMA_HOST);
          break;
        default:
          this.logger.log(`    ✗ Unknown provider: ${providerName}\n`, { type: 'error' });
          return [];
      }

      const models = await provider.listAvailableModels();
      return models;
    } catch (error: any) {
      if (error.message && error.message.includes('does not provide')) {
        this.logger.log(`    ⚠️  ${providerName} does not support model discovery.\n`, { type: 'warning' });
        this.logger.log(`    Use "Enter custom model name" instead.\n`, { type: 'info' });
      } else {
        this.logger.log(`    ✗ Failed to discover models: ${error.message}\n`, { type: 'error' });
      }
      return [];
    }
  }
}
