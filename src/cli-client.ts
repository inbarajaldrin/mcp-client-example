import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import readline from 'readline/promises';
import { MCPClient } from './index.js';
import { consoleStyles, Logger } from './logger.js';
import type { ModelProvider } from './model-provider.js';
import { AttachmentManager, type AttachmentInfo, type ContentBlock } from './attachment-manager.js';

const EXIT_COMMAND = 'exit';

export class MCPClientCLI {
  private rl: readline.Interface | null = null;
  private client: MCPClient;
  private logger: Logger;
  private isShuttingDown = false;
  private attachmentManager: AttachmentManager;
  private pendingAttachments: AttachmentInfo[] = [];

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
        // End chat session before shutdown (do this first to ensure it's saved)
        this.client.getChatHistoryManager().endSession('Chat session ended by user');
        
        // Close readline
        if (this.rl) {
          this.rl.close();
          this.rl = null;
        }
        
        // Close MCP client connection
        await this.client.stop();
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
      this.logger.log(`Type your queries or "${EXIT_COMMAND}" to exit\n`, {
        type: 'info',
      });
      this.logger.log(
        `\nTesting commands:\n` +
        `  /token-status or /tokens - Show current token usage\n` +
        `  /summarize or /summarize-now - Manually trigger summarization\n` +
        `  /test-mode [threshold] - Enable test mode (default: 5% threshold)\n` +
        `  /test-mode off - Disable test mode\n` +
        `  /todo-on - Enable todo mode (agent will track tasks)\n` +
        `  /todo-off - Disable todo mode\n` +
        `  /tools or /tools-list - List currently enabled tools\n` +
        `  /tools-manager or /tools-select - Interactive tool enable/disable selection\n` +
        `  /tools-enable-all - Enable all tools from all servers\n` +
        `  /tools-disable-all - Disable all tools from all servers\n` +
        `  /tools-enable-server <server-name> - Enable all tools from a server\n` +
        `  /tools-disable-server <server-name> - Disable all tools from a server\n` +
        `  /add-prompt - Add enabled prompts to conversation context\n` +
        `  /prompts or /prompts-list - List currently enabled prompts\n` +
        `  /prompts-manager or /prompts-select - Interactive prompt enable/disable selection\n` +
        `  /attachment-upload - Upload files by drag-and-drop\n` +
        `  /attachment-list - List available attachments\n` +
        `  /attachment-insert - Select attachments to send to agent\n` +
        `  /attachment-rename - Rename an attachment\n` +
        `  /attachment-clear - Delete one or more attachments\n` +
        `  /chat-list - List recent chat sessions\n` +
        `  /chat-search <keyword> - Search chats by keyword\n` +
        `  /chat-restore - Restore a past chat as context\n` +
        `  /chat-export - Export a chat to file\n` +
        `  /chat-rename - Rename a chat session file\n` +
        `  /chat-clear - Delete a chat session\n`,
        { type: 'info' },
      );
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
   * Ask user what to do with existing todos
   * Returns: 'clear' | 'skip' | 'leave'
   */
  private async askUserToClearTodos(todosList: string): Promise<'clear' | 'skip' | 'leave'> {
    if (!this.rl) {
      return 'leave';
    }

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

  private async chat_loop() {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }
    
    while (true) {
      try {
        if (this.isShuttingDown) {
          break;
        }
        
        const query = (await this.rl.question(consoleStyles.prompt)).trim();
        
        if (this.isShuttingDown) {
          break;
        }
        
        if (query.toLowerCase() === EXIT_COMMAND) {
          this.logger.log('\nGoodbye! 👋\n', { type: 'warning' });
          // End chat session before exiting
          this.client.getChatHistoryManager().endSession('Chat session ended by user');
          break;
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

        if (query.toLowerCase().startsWith('/test-mode')) {
          const parts = query.split(' ');
          if (parts.length > 1 && parts[1] === 'off') {
            this.client.setTestMode(false);
          } else {
            const threshold = parts.length > 1 ? parseFloat(parts[1]) : 5;
            this.client.setTestMode(true, threshold);
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

        // Handle tool management commands
        if (query.toLowerCase() === '/tools-enable-all') {
          try {
            await this.client.enableAllTools();
          } catch (error) {
            this.logger.log(
              `\nFailed to enable all tools: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase() === '/tools-disable-all') {
          try {
            await this.client.disableAllTools();
          } catch (error) {
            this.logger.log(
              `\nFailed to disable all tools: ${error}\n`,
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

        if (query.toLowerCase().startsWith('/tools-enable-server')) {
          try {
            const parts = query.split(' ');
            if (parts.length < 2) {
              this.logger.log(
                '\nUsage: /tools-enable-server <server-name>\n',
                { type: 'error' },
              );
              continue;
            }
            const serverName = parts.slice(1).join(' ');
            await this.client.enableServerTools(serverName);
          } catch (error) {
            this.logger.log(
              `\nFailed to enable server tools: ${error}\n`,
              { type: 'error' },
            );
          }
          continue;
        }

        if (query.toLowerCase().startsWith('/tools-disable-server')) {
          try {
            const parts = query.split(' ');
            if (parts.length < 2) {
              this.logger.log(
                '\nUsage: /tools-disable-server <server-name>\n',
                { type: 'error' },
              );
              continue;
            }
            const serverName = parts.slice(1).join(' ');
            await this.client.disableServerTools(serverName);
          } catch (error) {
            this.logger.log(
              `\nFailed to disable server tools: ${error}\n`,
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

        // Log user message to history (including attachment metadata)
        const attachmentMetadata = this.pendingAttachments.length > 0
          ? this.pendingAttachments.map(att => ({
              fileName: att.fileName,
              ext: att.ext,
              mediaType: att.mediaType,
            }))
          : undefined;
        this.client.getChatHistoryManager().addUserMessage(query, attachmentMetadata);

        // Get message count before processing to find the new assistant message
        const messagesBefore = (this.client as any).messages.length;
        
        // Process query with attachments if any are pending (use finalQuery which includes system prompt if needed)
        await this.client.processQuery(finalQuery, false, this.pendingAttachments.length > 0 ? this.pendingAttachments : undefined);
        
        // Clear pending attachments after they've been used
        this.pendingAttachments = [];
        
        // Extract assistant response from messages array
        const messages = (this.client as any).messages;
        const assistantMessages = messages.filter((msg: any) => msg.role === 'assistant');
        if (assistantMessages.length > 0) {
          const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
          if (lastAssistantMessage.content) {
            this.client.getChatHistoryManager().addAssistantMessage(lastAssistantMessage.content);
          }
        }
        
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
          this.logger.log('\n\nSaving chat session...\n', { type: 'info' });
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
              contentText = `[Resource: ${msg.content.resource.uri}]\n${msg.content.resource.text}`;
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
      if (chat.summary) {
        this.logger.log(`    → ${chat.summary}\n`, { type: 'info' });
      }
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
      if (chat.summary) {
        this.logger.log(`    → ${chat.summary}\n`, { type: 'info' });
      }
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
    
    this.logger.log('\n📖 Select a chat to restore as context:\n', { type: 'info' });
    
    for (let i = 0; i < Math.min(chats.length, 20); i++) {
      const chat = chats[i];
      const date = new Date(chat.startTime).toLocaleString();
      const summary = chat.summary ? ` - ${chat.summary}` : '';
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
    
    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= Math.min(chats.length, 20)) {
      this.logger.log('\nInvalid selection.\n', { type: 'error' });
      return;
    }
    
    const selectedChat = chats[index];
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
            msg.toolOutput
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
  }

  private async exportChat(): Promise<void> {
    if (!this.rl) {
      throw new Error('Readline interface not initialized');
    }
    
    const historyManager = this.client.getChatHistoryManager();
    const chats = historyManager.getAllChats();
    
    if (chats.length === 0) {
      this.logger.log('\nNo chat sessions available to export.\n', { type: 'warning' });
      return;
    }
    
    this.logger.log('\n💾 Select a chat to export:\n', { type: 'info' });
    
    for (let i = 0; i < Math.min(chats.length, 20); i++) {
      const chat = chats[i];
      const date = new Date(chat.startTime).toLocaleString();
      const summary = chat.summary ? ` - ${chat.summary}` : '';
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
    
    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= Math.min(chats.length, 20)) {
      this.logger.log('\nInvalid selection.\n', { type: 'error' });
      return;
    }
    
    const selectedChat = chats[index];
    
    const formatSelection = (await this.rl.question('\nExport format (json/md) [md]: ')).trim().toLowerCase();
    const format = formatSelection === 'json' ? 'json' : 'md';
    
    const pathSelection = (await this.rl.question('\nEnter file path (or press Enter for default): ')).trim();
    
    let exportPath: string;
    if (pathSelection) {
      exportPath = pathSelection;
    } else {
      const fs = await import('fs');
      const path = await import('path');
      const { fileURLToPath } = await import('url');
      const { dirname } = await import('path');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const defaultDir = path.join(__dirname, '..', '.mcp-client-data', 'exports');
      if (!fs.existsSync(defaultDir)) {
        fs.mkdirSync(defaultDir, { recursive: true });
      }
      const ext = format === 'json' ? 'json' : 'md';
      exportPath = path.join(defaultDir, `chat-${selectedChat.sessionId}.${ext}`);
    }
    
    let content: string | null;
    if (format === 'json') {
      content = historyManager.exportChatAsJson(selectedChat.sessionId);
    } else {
      content = historyManager.exportChatAsMarkdown(selectedChat.sessionId);
    }
    
    if (!content) {
      this.logger.log('\nFailed to export chat.\n', { type: 'error' });
      return;
    }
    
    const fs = await import('fs');
    fs.writeFileSync(exportPath, content, 'utf-8');
    
    this.logger.log(`\n✓ Chat exported to: ${exportPath}\n`, { type: 'success' });
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
    
    this.logger.log('\n📝 Select a chat to rename:\n', { type: 'info' });
    
    for (let i = 0; i < Math.min(chats.length, 20); i++) {
      const chat = chats[i];
      const date = new Date(chat.startTime).toLocaleString();
      // Extract current filename from path
      const currentFileName = chat.filePath.split('/').pop() || chat.filePath;
      this.logger.log(
        `  ${i + 1}. ${chat.sessionId} | ${date} | ${chat.messageCount} messages | ${currentFileName}\n`,
        { type: 'info' }
      );
    }
    
    const selection = await this.rl.question('\nEnter number (or "q" to cancel): ');
    
    if (selection.toLowerCase() === 'q' || selection.toLowerCase() === 'quit') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }
    
    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= Math.min(chats.length, 20)) {
      this.logger.log('\nInvalid selection.\n', { type: 'error' });
      return;
    }
    
    const selectedChat = chats[index];
    const currentFileName = selectedChat.filePath.split('/').pop() || selectedChat.filePath;
    const currentDir = selectedChat.filePath.split('/').slice(-2, -1)[0] || 'root';
    
    this.logger.log(`\nCurrent filename: ${currentFileName}`, { type: 'info' });
    this.logger.log(`Current folder: ${currentDir}\n`, { type: 'info' });
    
    const newName = (await this.rl.question('\nEnter new name for the file: ')).trim();
    
    if (!newName) {
      this.logger.log('\nName cannot be empty.\n', { type: 'error' });
      return;
    }
    
    // Ask if user wants to move to a folder
    const moveToFolder = (await this.rl.question('\nMove to a folder? (y/n, default: n): ')).trim().toLowerCase();
    let folderName: string | undefined;
    
    if (moveToFolder === 'y' || moveToFolder === 'yes') {
      // Get existing folders
      const existingFolders = historyManager.getExistingFolders();
      
      if (existingFolders.length > 0) {
        this.logger.log('\n📁 Existing folders:\n', { type: 'info' });
        existingFolders.forEach((folder: string, i: number) => {
          this.logger.log(`  ${i + 1}. ${folder}`, { type: 'info' });
        });
        this.logger.log(`  ${existingFolders.length + 1}. Create new folder\n`, { type: 'info' });
        
        const folderChoice = (await this.rl.question('Select folder number (or enter new folder name): ')).trim();
        
        // Check if it's a number
        const folderIndex = parseInt(folderChoice) - 1;
        if (!isNaN(folderIndex) && folderIndex >= 0 && folderIndex < existingFolders.length) {
          // Selected existing folder
          folderName = existingFolders[folderIndex];
          this.logger.log(`\nSelected folder: ${folderName}\n`, { type: 'info' });
        } else if (!isNaN(folderIndex) && folderIndex === existingFolders.length) {
          // User wants to create new folder
          const newFolderName = (await this.rl.question('Enter new folder name: ')).trim();
          if (newFolderName) {
            folderName = newFolderName;
          } else {
            this.logger.log('\nFolder name cannot be empty. Keeping chat in current folder.\n', { type: 'warning' });
          }
        } else {
          // User entered a folder name directly
          folderName = folderChoice;
        }
      } else {
        // No existing folders, just ask for new folder name
        const folderInput = (await this.rl.question('Enter folder name (will be created if it doesn\'t exist): ')).trim();
        if (folderInput) {
          folderName = folderInput;
        } else {
          this.logger.log('\nFolder name cannot be empty. Keeping chat in current folder.\n', { type: 'warning' });
        }
      }
    }
    
    const updated = historyManager.renameChat(selectedChat.sessionId, newName, folderName);
    
    if (updated) {
      const sanitizedName = newName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const sessionIdParts = selectedChat.sessionId.split('-');
      const sessionIdShort = sessionIdParts[sessionIdParts.length - 1];
      const locationMsg = folderName ? ` in folder "${folderName}"` : '';
      this.logger.log(`\n✓ Chat ${selectedChat.sessionId} renamed to: chat-${sessionIdShort}-${sanitizedName}.json${locationMsg}\n`, { type: 'success' });
    } else {
      this.logger.log(`\n✗ Failed to rename chat ${selectedChat.sessionId}.\n`, { type: 'error' });
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
      const summary = chat.summary ? ` - ${chat.summary}` : '';
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
          `   Please use Claude provider (--provider=claude) for PDF support.\n`,
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
}
