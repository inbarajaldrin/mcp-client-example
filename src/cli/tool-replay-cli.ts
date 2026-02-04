/**
 * Tool Replay Mode - browse and re-execute past tool calls from the current session.
 * Results are shown to the user only and never affect the agent's conversation context.
 */

import readline from 'readline/promises';
import chalk from 'chalk';
import { Logger } from '../logger.js';
import { formatJSON } from '../utils/formatting.js';
import type { ToolExecutionResult } from '../core/tool-executor.js';

export interface ReplayableToolCall {
  toolName: string;
  toolInput: Record<string, any>;
  toolOutput: string;
  timestamp: string;
  orchestratorMode: boolean;
}

export interface ToolReplayCLICallbacks {
  getReadline: () => readline.Interface | null;
  setReadline: (rl: readline.Interface | null) => void;
  getReplayableToolCalls: () => ReplayableToolCall[];
  executeTool: (toolName: string, toolInput: Record<string, any>) => Promise<ToolExecutionResult>;
  startKeyboardMonitor: () => void;
  stopKeyboardMonitor: () => void;
  resetAbortState: () => void;
  setDisableHistoryRecording: (disable: boolean) => void;
  getCompleter?: () => ((line: string) => [string[], string]) | undefined;
  /** Re-setup Escape key handler after recreating readline */
  setupEscapeKeyHandler?: () => void;
}

const VISIBLE_WINDOW = 15;

export class ToolReplayCLI {
  private logger: Logger;
  private callbacks: ToolReplayCLICallbacks;
  private savedHistory: string[] = [];

  constructor(logger: Logger, callbacks: ToolReplayCLICallbacks) {
    this.logger = logger;
    this.callbacks = callbacks;
  }

  /**
   * Enter tool replay mode - interactive browser for past tool calls.
   */
  async enterReplayMode(): Promise<void> {
    const toolCalls = this.callbacks.getReplayableToolCalls();
    if (toolCalls.length === 0) {
      this.logger.log('\nNo tool calls to replay.\n', { type: 'warning' });
      return;
    }

    // Reset any leftover abort state from previous agent execution
    this.callbacks.resetAbortState();

    // Disable history recording during replay mode so IPC calls don't get logged
    this.callbacks.setDisableHistoryRecording(true);

    // Close readline fully to prevent it from intercepting arrow keys
    this.savedHistory = this.closeReadline();

    let selectedIndex = 0;

    while (true) {
      this.enterRawMode();
      this.renderToolList(toolCalls, selectedIndex);

      const action = await this.waitForListAction(toolCalls, selectedIndex);

      this.exitRawMode();

      if (action.type === 'exit') break;

      selectedIndex = action.index;

      // Recreate readline for tool execution (needed by force-stop prompt)
      this.recreateReadline();

      // Start keyboard monitor so Ctrl+A abort works during tool execution
      this.callbacks.startKeyboardMonitor();

      try {
        await this.replayTool(toolCalls[selectedIndex]);
      } finally {
        // Always stop keyboard monitor, even if tool execution was aborted/errored
        this.callbacks.stopKeyboardMonitor();
        // Reset abort state so next replay starts fresh
        this.callbacks.resetAbortState();
      }

      // Close readline again before going back to raw mode for "press any key"
      this.savedHistory = this.closeReadline();

      this.enterRawMode();
      this.logger.log(
        '\n' + chalk.dim('Press any key to return to tool list, or q to exit...') + '\n',
      );

      const key = await this.waitForAnyKey();
      this.exitRawMode();

      if (key === '\x03') {
        // Ctrl+C - emit SIGINT for normal shutdown
        this.callbacks.setDisableHistoryRecording(false);
        this.recreateReadline();
        process.emit('SIGINT', 'SIGINT');
        return;
      }
      if (key === 'q') break;
    }

    // Re-enable history recording before exiting
    this.callbacks.setDisableHistoryRecording(false);

    // Restore readline with history for normal chat
    this.recreateReadline();
    this.logger.log('\n', { type: 'info' });
  }

  /**
   * Close the current readline and return its saved history.
   */
  private closeReadline(): string[] {
    const rl = this.callbacks.getReadline();
    if (!rl) return this.savedHistory;

    const history = [...(rl as any).history];
    rl.close();
    this.callbacks.setReadline(null);

    // Ensure stdin is paused after closing readline
    process.stdin.pause();
    // Remove any leftover listeners that readline might have attached
    process.stdin.removeAllListeners('keypress');

    return history;
  }

  /**
   * Recreate the readline interface with saved history.
   */
  private recreateReadline(): void {
    // Close existing if any
    const existing = this.callbacks.getReadline();
    if (existing) {
      const hist = [...(existing as any).history];
      if (hist.length > 0) this.savedHistory = hist;
      existing.close();
    }

    const completer = this.callbacks.getCompleter?.();
    const newRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      ...(completer && { completer }),
    });

    this.callbacks.setReadline(newRl);

    if (this.savedHistory.length > 0) {
      (newRl as any).history = [...this.savedHistory];
    }

    // Re-setup Escape key handler for the new readline interface
    this.callbacks.setupEscapeKeyHandler?.();
  }

  /**
   * Enter raw mode on stdin.
   */
  private enterRawMode(): void {
    const stdin = process.stdin;
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding('utf8');
  }

  /**
   * Exit raw mode and flush stdin.
   */
  private exitRawMode(): void {
    const stdin = process.stdin;
    if (stdin.setRawMode) {
      stdin.setRawMode(false);
    }
    // Flush stdin buffer
    if (stdin.readable) {
      let chunk;
      while ((chunk = stdin.read()) !== null) {
        // Discard
      }
    }
  }

  /**
   * Wait for a list navigation action (arrow keys, Enter, or exit key).
   * Returns the action the user chose.
   */
  private waitForListAction(
    toolCalls: ReplayableToolCall[],
    startIndex: number,
  ): Promise<{ type: 'exit' } | { type: 'replay'; index: number }> {
    let selectedIndex = startIndex;
    let escapeBuffer = '';
    let escapeTimeout: ReturnType<typeof setTimeout> | null = null;

    return new Promise((resolve) => {
      const stdin = process.stdin;

      const cleanup = () => {
        if (escapeTimeout) {
          clearTimeout(escapeTimeout);
          escapeTimeout = null;
        }
        escapeBuffer = '';
        stdin.removeListener('data', keyHandler);
      };

      const keyHandler = (key: string) => {
        // Arrow keys may come as complete sequences in utf8 mode
        if (key === '\x1B[A') {
          // Up arrow (complete sequence)
          if (escapeTimeout) clearTimeout(escapeTimeout);
          escapeBuffer = '';
          if (selectedIndex > 0) {
            selectedIndex--;
            this.renderToolList(toolCalls, selectedIndex);
          }
          return;
        }
        if (key === '\x1B[B') {
          // Down arrow (complete sequence)
          if (escapeTimeout) clearTimeout(escapeTimeout);
          escapeBuffer = '';
          if (selectedIndex < toolCalls.length - 1) {
            selectedIndex++;
            this.renderToolList(toolCalls, selectedIndex);
          }
          return;
        }

        // Handle escape sequence buffering (for byte-by-byte input)
        if (escapeBuffer.length > 0) {
          escapeBuffer += key;
          if (escapeTimeout) clearTimeout(escapeTimeout);

          if (escapeBuffer === '\x1B[A') {
            // Up arrow
            escapeBuffer = '';
            if (selectedIndex > 0) {
              selectedIndex--;
              this.renderToolList(toolCalls, selectedIndex);
            }
            return;
          }
          if (escapeBuffer === '\x1B[B') {
            // Down arrow
            escapeBuffer = '';
            if (selectedIndex < toolCalls.length - 1) {
              selectedIndex++;
              this.renderToolList(toolCalls, selectedIndex);
            }
            return;
          }
          // Unknown sequence or too long, discard
          if (escapeBuffer.length >= 3) {
            escapeBuffer = '';
          }
          return;
        }

        // Start of escape sequence (single ESC byte)
        if (key === '\x1B') {
          escapeBuffer = '\x1B';
          escapeTimeout = setTimeout(() => {
            // Standalone Escape - exit
            escapeBuffer = '';
            cleanup();
            resolve({ type: 'exit' });
          }, 50);
          return;
        }

        // Enter - replay selected tool
        if (key === '\r' || key === '\n') {
          cleanup();
          resolve({ type: 'replay', index: selectedIndex });
          return;
        }

        // q - exit replay mode
        if (key === 'q') {
          cleanup();
          resolve({ type: 'exit' });
          return;
        }

        // Ctrl+C - emit SIGINT for normal shutdown (raw mode prevents normal signal)
        if (key === '\x03') {
          cleanup();
          process.emit('SIGINT', 'SIGINT');
          return;
        }
      };

      stdin.on('data', keyHandler);
    });
  }

  /**
   * Wait for any single keypress. Returns the key pressed.
   */
  private waitForAnyKey(): Promise<string> {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      const handler = (key: string) => {
        stdin.removeListener('data', handler);
        resolve(key);
      };
      stdin.on('data', handler);
    });
  }

  /**
   * Render the tool call list with the selected item highlighted.
   * Uses console.log directly for proper line breaks.
   */
  private renderToolList(toolCalls: ReplayableToolCall[], selectedIndex: number): void {
    // Clear screen and move cursor to top
    process.stdout.write('\x1B[2J\x1B[H');

    console.log(
      chalk.bold.white('Tool Replay Mode') +
      chalk.dim(' - Browse and re-execute past tool calls'),
    );
    console.log(chalk.dim('  Up/Down: navigate  |  Enter: replay  |  q/Esc: exit'));
    console.log();

    // Calculate scrollable window
    const windowStart = Math.max(0, Math.min(
      selectedIndex - Math.floor(VISIBLE_WINDOW / 2),
      toolCalls.length - VISIBLE_WINDOW,
    ));
    const windowEnd = Math.min(toolCalls.length, windowStart + VISIBLE_WINDOW);

    // Show scroll indicators
    if (windowStart > 0) {
      console.log(chalk.dim(`  ... ${windowStart} more above`));
    }

    for (let i = windowStart; i < windowEnd; i++) {
      const call = toolCalls[i];
      const isSelected = i === selectedIndex;
      const inputPreview = this.truncate(JSON.stringify(call.toolInput), 60);
      const time = this.formatTimestamp(call.timestamp);

      if (isSelected) {
        // Selected: use bold white on colored background, no conflicting colors
        const bgColor = call.orchestratorMode ? chalk.bgMagenta : chalk.bgCyan;
        console.log(bgColor.black.bold(`> ${call.toolName} ${inputPreview} ${time}`));
      } else {
        // Not selected: use normal colors
        const nameColor = call.orchestratorMode ? chalk.magenta : chalk.cyan;
        console.log(`  ${nameColor(call.toolName)} ${chalk.dim(inputPreview)} ${chalk.dim(time)}`);
      }
    }

    if (windowEnd < toolCalls.length) {
      console.log(chalk.dim(`  ... ${toolCalls.length - windowEnd} more below`));
    }

    // Show details of selected tool call
    const selected = toolCalls[selectedIndex];
    console.log();
    console.log(chalk.bold.white('Selected Tool Details:'));
    console.log(chalk.dim('─'.repeat(60)));
    console.log(chalk.bold('Name: ') + (selected.orchestratorMode ? chalk.magenta(selected.toolName) : chalk.cyan(selected.toolName)));
    console.log(chalk.bold('Time: ') + selected.timestamp);
    console.log(chalk.bold('Mode: ') + (selected.orchestratorMode ? chalk.magenta('Orchestrator') : 'Direct'));
    console.log(chalk.bold('Input:'));
    console.log(this.formatJson(selected.toolInput));
    console.log();
    console.log(chalk.dim(`[${selectedIndex + 1}/${toolCalls.length}]`));
  }

  /**
   * Replay a single tool call and display the result.
   */
  private async replayTool(toolCall: ReplayableToolCall): Promise<void> {
    this.logger.log(
      '\n' + chalk.bold.yellow('Replaying: ') +
      (toolCall.orchestratorMode ? chalk.magenta(toolCall.toolName) : chalk.cyan(toolCall.toolName)) +
      '\n' + chalk.dim('─'.repeat(60)) + '\n',
      { type: 'info' },
    );

    try {
      const result = await this.callbacks.executeTool(toolCall.toolName, toolCall.toolInput);

      // Format the result the same way the regular agent loop does
      console.log();
      console.log(chalk.bold.green('Result:'));
      console.log(chalk.dim('─'.repeat(60)));

      // Get raw result text from displayText by stripping ANSI codes
      const rawResult = result.displayText.replace(/\u001b\[[0-9;]*m/g, '');

      try {
        let parsed = JSON.parse(rawResult);
        // Handle double-encoded JSON (array with single JSON string element)
        if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string') {
          try {
            parsed = JSON.parse(parsed[0]);
            // If inner string was valid JSON, format it normally
            const formatted = JSON.stringify(parsed, null, 2);
            const colored = formatJSON(formatted);
            const truncated = colored.length > 10000
              ? colored.substring(0, 10000) + '\n...(truncated)'
              : colored;
            console.log(truncated);
          } catch {
            // Inner string is not JSON - display it directly to preserve newlines
            const stringValue = parsed[0];
            const truncated = stringValue.length > 10000
              ? stringValue.substring(0, 10000) + '\n...(truncated)'
              : stringValue;
            const indented = truncated.split('\n').map((line: string) => '  ' + line).join('\n');
            console.log(indented);
          }
        } else {
          // Not an array with single string - format normally
          const formatted = JSON.stringify(parsed, null, 2);
          const colored = formatJSON(formatted);
          const truncated = colored.length > 10000
            ? colored.substring(0, 10000) + '\n...(truncated)'
            : colored;
          console.log(truncated);
        }
      } catch {
        // Non-JSON fallback - indent the content
        const indented = rawResult.split('\n').map((line: string) => '  ' + line).join('\n');
        console.log(indented);
      }
      console.log();
    } catch (error) {
      this.logger.log(
        '\n' + chalk.bold.red('Error: ') + String(error) + '\n',
        { type: 'error' },
      );
    }
  }

  /**
   * Truncate a string to a maximum length.
   */
  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
  }

  /**
   * Format a timestamp for display (show just time portion).
   */
  private formatTimestamp(timestamp: string): string {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString();
    } catch {
      return timestamp;
    }
  }

  /**
   * Format a JSON object for display with indentation.
   */
  private formatJson(obj: Record<string, any>): string {
    try {
      return JSON.stringify(obj, null, 2)
        .split('\n')
        .map(line => '  ' + line)
        .join('\n');
    } catch {
      return '  ' + String(obj);
    }
  }
}
