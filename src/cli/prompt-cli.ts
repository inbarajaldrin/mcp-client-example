/**
 * CLI operations for prompt management.
 */

import readline from 'readline/promises';
import { MCPClient } from '../index.js';
import { Logger } from '../logger.js';

/**
 * Callbacks for PromptCLI to interact with parent component.
 */
export interface PromptCLICallbacks {
  /** Get current readline interface */
  getReadline: () => readline.Interface | null;
  /** Get messages array to modify for addPromptToContext */
  getMessages: () => any[];
  /** Get token counter for addPromptToContext */
  getTokenCounter: () => { countMessageTokens: (msg: any) => number } | null;
  /** Get current token count */
  getCurrentTokenCount: () => number;
  /** Set current token count */
  setCurrentTokenCount: (count: number) => void;
  /** Notify that prompts were added to context */
  onPromptsAdded?: () => void;
}

/**
 * Handles CLI operations for prompt listing, selection, and context management.
 */
export class PromptCLI {
  private client: MCPClient;
  private logger: Logger;
  private callbacks: PromptCLICallbacks;

  constructor(
    client: MCPClient,
    logger: Logger,
    callbacks: PromptCLICallbacks,
  ) {
    this.client = client;
    this.logger = logger;
    this.callbacks = callbacks;
  }

  /**
   * Add prompts to conversation context.
   */
  async addPromptToContext(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    // Get all prompts from all servers
    const allPrompts = this.client.listPrompts();

    // Filter to only enabled prompts
    const promptManager = this.client.getPromptManager();
    const enabledPrompts = promptManager.filterPrompts(allPrompts);

    if (enabledPrompts.length === 0) {
      this.logger.log(
        '\nNo enabled prompts available. Use /prompts-manager to enable prompts.\n',
        { type: 'warning' },
      );
      return;
    }

    // Create index mapping
    const indexToPrompt = new Map<number, (typeof enabledPrompts)[0]>();
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
      a[0].localeCompare(b[0]),
    );

    // Display prompts
    this.logger.log('\n📝 Available Prompts:\n', { type: 'info' });

    promptIndex = 1;
    indexToPrompt.clear();

    for (const [serverName, serverPrompts] of sortedServers) {
      this.logger.log(`\n[${serverName}]:\n`, { type: 'info' });

      for (const promptData of serverPrompts) {
        const prompt = promptData.prompt;
        const argsInfo =
          prompt.arguments && prompt.arguments.length > 0
            ? ` (${prompt.arguments.length} argument${prompt.arguments.length > 1 ? 's' : ''})`
            : '';
        this.logger.log(`  ${promptIndex}. ${prompt.name}${argsInfo}\n`, {
          type: 'info',
        });
        if (prompt.description) {
          this.logger.log(`     ${prompt.description}\n`, { type: 'info' });
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

    const selection = (await rl.question('> ')).trim();

    if (
      selection.toLowerCase() === 'q' ||
      selection.toLowerCase() === 'quit'
    ) {
      this.logger.log('\n✗ Prompt selection cancelled\n', { type: 'warning' });
      return;
    }

    // Parse selection
    const parts = selection.split(',').map((p) => p.trim());
    const selectedIndices: number[] = [];

    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map((n) => parseInt(n.trim()));
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
    const selectedPrompts: Array<(typeof allPrompts)[0]> = [];
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
          const defaultValue = required
            ? ''
            : ' (optional, press Enter to skip)';

          this.logger.log(
            `  ${arg.name}${arg.description ? ` - ${arg.description}` : ''}${defaultValue}:\n`,
            { type: 'info' },
          );

          const value = (await rl.question('  > ')).trim();

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
        const requiredArgs = prompt.arguments.filter(
          (a) => a.required !== false,
        );
        const hasAllRequired = requiredArgs.every((a) => promptArgs[a.name]);

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

        const messages = this.callbacks.getMessages();
        const historyManager = this.client.getChatHistoryManager();

        // Add prompt messages to conversation context
        // Convert PromptMessage format to our Message format
        for (const msg of promptResult.messages) {
          if (msg.role === 'user' && msg.content) {
            let contentText = '';

            if (msg.content.type === 'text') {
              contentText = msg.content.text;
            } else if (msg.content.type === 'resource') {
              // Handle resource content
              const resourceText =
                'text' in msg.content.resource
                  ? msg.content.resource.text
                  : '[Binary resource]';
              contentText = `[Resource: ${msg.content.resource.uri}]\n${resourceText}`;
            } else {
              // Fallback for other content types
              contentText = JSON.stringify(msg.content);
            }

            // Add to messages array (but don't send automatically)
            messages.push({
              role: 'user',
              content: contentText,
            });

            // Log prompt message to chat history
            historyManager.addUserMessage(contentText);

            // Update token count
            const tokenCounter = this.callbacks.getTokenCounter();
            if (tokenCounter) {
              const messageTokenCount = tokenCounter.countMessageTokens({
                role: 'user',
                content: contentText,
              });
              this.callbacks.setCurrentTokenCount(
                this.callbacks.getCurrentTokenCount() + messageTokenCount,
              );
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

    const totalMessages = this.callbacks.getMessages().length;
    this.logger.log(
      `\n✓ Prompt selection complete. ${totalMessages} message(s) in context.\n`,
      { type: 'info' },
    );

    // Notify that prompts were added to context
    if (this.callbacks.onPromptsAdded) {
      this.callbacks.onPromptsAdded();
    }
  }

  /**
   * Display list of enabled prompts.
   */
  async displayPromptsList(): Promise<void> {
    const promptManager = this.client.getPromptManager();

    // Get all prompts from all servers
    const allPrompts = this.client.listPrompts();

    // Filter to only enabled prompts
    const enabledPrompts = promptManager.filterPrompts(allPrompts);

    if (enabledPrompts.length === 0) {
      this.logger.log('\n📋 Enabled Prompts:\n', { type: 'info' });
      this.logger.log('  No enabled prompts.\n', { type: 'warning' });
      this.logger.log('  Use /prompts-manager to enable prompts.\n', {
        type: 'info',
      });
      return;
    }

    // Group by server
    const promptsByServer = new Map<string, Array<{ name: string }>>();
    for (const promptData of enabledPrompts) {
      if (!promptsByServer.has(promptData.server)) {
        promptsByServer.set(promptData.server, []);
      }
      promptsByServer.get(promptData.server)!.push({
        name: promptData.prompt.name,
      });
    }

    this.logger.log('\n📋 Enabled Prompts:\n', { type: 'info' });

    for (const [serverName, prompts] of promptsByServer.entries()) {
      this.logger.log(`\n[${serverName}] (${prompts.length} enabled):\n`, {
        type: 'info',
      });

      for (const prompt of prompts) {
        this.logger.log(`  ✓ ${prompt.name}\n`, { type: 'info' });
      }
    }

    this.logger.log('\n');
  }

  /**
   * Interactive prompt selection interface.
   */
  async interactivePromptManager(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const promptManager = this.client.getPromptManager();

    // Save initial state to revert to on cancel
    const initialState = { ...promptManager.getPromptStates() };

    // Collect all prompts from all servers
    const allPrompts = this.client.listPrompts();

    if (allPrompts.length === 0) {
      this.logger.log('\nNo prompts available from any server.\n', {
        type: 'warning',
      });
      return;
    }

    // Create index mapping
    const indexToPrompt = new Map<number, (typeof allPrompts)[0]>();
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
      a[0].localeCompare(b[0]),
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
        const enabledCount = serverPrompts.filter((p) =>
          promptManager.isPromptEnabled(p.server, p.prompt.name),
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
          const enabled = promptManager.isPromptEnabled(
            promptData.server,
            promptData.prompt.name,
          );
          const status = enabled ? '✓' : '✗';
          displayText += `  ${promptIndex}. ${status} ${promptData.prompt.name}\n`;
          indexToPrompt.set(promptIndex, promptData);
          promptIndex++;
        }
      }

      displayText +=
        `\nCommands:\n` +
        `  Enter numbers separated by commas or ranges (e.g., 1,3,5-8) to toggle prompts\n` +
        `  Enter S + number (e.g., S1, s2) to toggle all prompts in a server\n` +
        `  a or all - Enable all prompts\n` +
        `  n or none - Disable all prompts\n` +
        `  s or save - Save changes and return\n` +
        `  q or quit - Cancel and return\n`;

      // Write everything at once to avoid duplication
      process.stdout.write(displayText);

      const selection = (await rl.question('> ')).trim().toLowerCase();

      if (selection === 's' || selection === 'save') {
        // Save all changes to disk
        promptManager.saveState();
        this.logger.log('\n✓ Changes saved\n', { type: 'info' });
        break;
      }

      if (selection === 'q' || selection === 'quit') {
        // Restore original state (revert all changes)
        promptManager.restoreState(initialState);
        this.logger.log('\n✗ Changes cancelled - reverted to original state\n', {
          type: 'warning',
        });
        break;
      }

      if (selection === 'a' || selection === 'all') {
        // Enable all prompts (don't save yet)
        for (const promptData of allPrompts) {
          promptManager.setPromptEnabled(
            promptData.server,
            promptData.prompt.name,
            true,
            false,
          );
        }
        continue;
      }

      if (selection === 'n' || selection === 'none') {
        // Disable all prompts (don't save yet)
        for (const promptData of allPrompts) {
          promptManager.setPromptEnabled(
            promptData.server,
            promptData.prompt.name,
            false,
            false,
          );
        }
        continue;
      }

      // Handle server toggle (S1, s2, etc.)
      if (selection.match(/^s\d+$/i)) {
        const serverNum = parseInt(selection.slice(1)) - 1;
        if (serverNum >= 0 && serverNum < sortedServers.length) {
          const [, serverPrompts] = sortedServers[serverNum];
          const allEnabled = serverPrompts.every((p) =>
            promptManager.isPromptEnabled(p.server, p.prompt.name),
          );
          const newState = !allEnabled;

          for (const promptData of serverPrompts) {
            promptManager.setPromptEnabled(
              promptData.server,
              promptData.prompt.name,
              newState,
              false,
            );
          }

          // Continue loop to refresh display immediately
          continue;
        }
      }

      // Handle prompt number selection
      if (selection.match(/^[\d,\-\s]+$/)) {
        const parts = selection.split(',').map((p) => p.trim());
        const indices: number[] = [];

        for (const part of parts) {
          if (part.includes('-')) {
            const [start, end] = part.split('-').map((n) => parseInt(n.trim()));
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
            promptManager.togglePrompt(
              promptData.server,
              promptData.prompt.name,
              false,
            );
            toggledCount++;
          }
        }

        if (toggledCount > 0) {
          // Continue loop to refresh display immediately
          continue;
        }
      }

      this.logger.log('\nInvalid selection. Please try again.\n', {
        type: 'error',
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
