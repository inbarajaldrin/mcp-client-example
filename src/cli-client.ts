import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import readline from 'readline/promises';
import { MCPClient } from './index.js';
import { consoleStyles, Logger } from './logger.js';

const EXIT_COMMAND = 'exit';

export class MCPClientCLI {
  private rl: readline.Interface | null = null;
  private client: MCPClient;
  private logger: Logger;
  private isShuttingDown = false;

  constructor(
    serverConfig: StdioServerParameters | Array<{ name: string; config: StdioServerParameters }>,
  ) {
    if (Array.isArray(serverConfig)) {
      // Multiple servers
      this.client = MCPClient.createMultiServer(serverConfig);
    } else {
      // Single server (backward compatibility)
      this.client = new MCPClient(serverConfig);
    }
    this.logger = new Logger({ mode: 'verbose' });
    
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
        // Close readline first
        if (this.rl) {
          this.rl.close();
          this.rl = null;
        }
        
        // Close MCP client connection
        await this.client.stop();
      } catch (error) {
        // Ignore errors during cleanup
      }
      
      process.exit(0);
    };

    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      void cleanup();
    });

    // Handle SIGTERM
    process.on('SIGTERM', () => {
      void cleanup();
    });
  }

  async start() {
    try {
      this.logger.log(consoleStyles.separator + '\n', { type: 'info' });
      this.logger.log('🤖 Interactive Claude CLI\n', { type: 'info' });
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
        `  /todo-off - Disable todo mode\n`,
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
            
            await this.client.enableTodoMode();
            
            // Send system prompt to agent (marked as system prompt so it doesn't trigger clear)
            const systemPrompt = 'You are now in todo mode. When the user provides a task, you must: 1) Decompose the task into actionable todos using create-todo, 2) As you complete each task, mark it complete using complete-todo. You cannot exit until all todos are completed or skipped using skip-todo.';
            await this.client.processQuery(systemPrompt, true);
            
            // Mark todo mode as initialized so future user queries will auto-clear
            this.client.setTodoModeInitialized(true);
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

        await this.client.processQuery(query);
        this.logger.log('\n' + consoleStyles.separator + '\n');
      } catch (error: any) {
        // Check if readline was closed (happens during shutdown)
        if (error?.code === 'ERR_USE_AFTER_CLOSE' || this.isShuttingDown) {
          break;
        }
        this.logger.log('\nError: ' + error + '\n', { type: 'error' });
      }
    }
  }
}
