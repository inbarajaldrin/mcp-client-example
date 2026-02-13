import readline from 'readline/promises';
import chalk from 'chalk';
import { Logger } from '../logger.js';

export type HILDecision = 'execute' | 'reject';

export interface ToolRejection {
  decision: 'reject';
  message?: string;
}

export class HumanInTheLoopManager {
  private enabled: boolean = false; // Off by default
  private firstToolOfSession: boolean = true;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  toggle(): void {
    this.enabled = !this.enabled;
  }

  resetSession(): void {
    this.firstToolOfSession = true;
  }

  /**
   * Request user confirmation before executing a tool.
   * - First tool of session: show y/n/p options
   * - Subsequent tools: prompt only if persistent mode enabled
   * Returns execution decision and optional rejection message
   */
  async requestToolConfirmation(
    toolName: string,
    toolArgs: Record<string, any>,
    rl: readline.Interface,
  ): Promise<'execute' | ToolRejection> {
    const isFirstTool = this.firstToolOfSession;

    // Not first tool, and not in persistent mode
    if (!isFirstTool && !this.enabled) {
      return 'execute';
    }

    // Display tool info
    this.logger.log(
      '\n' + chalk.yellow.bold('  Tool Confirmation') + '\n',
    );
    this.logger.log(
      chalk.cyan('  Tool: ') + chalk.bold(toolName) + '\n',
    );

    // Show args (truncated)
    const argEntries = Object.entries(toolArgs);
    if (argEntries.length > 0) {
      this.logger.log(chalk.cyan('  Arguments:\n'));
      for (const [key, value] of argEntries) {
        let display = String(value);
        if (display.length > 80) {
          display = display.substring(0, 77) + '...';
        }
        this.logger.log(`    ${key}: ${display}\n`);
      }
    }

    this.logger.log('\n');
    this.logger.log(chalk.cyan.bold('  Options:\n'));
    this.logger.log(chalk.green('    y/yes') + ' - Execute this tool\n');
    this.logger.log(chalk.red('    n/no') + ' - Reject this tool\n');

    if (isFirstTool) {
      this.logger.log(chalk.magenta('    p/persistent') + ' - Enable persistent approval mode\n');
      this.logger.log(chalk.blue('    msg <text>') + ' - Reject with a message\n');
    }

    this.logger.log('\n');

    const prompt = isFirstTool
      ? 'Action? [y/n/p/msg] '
      : 'Action? [y/n] ';
    const answer = (await rl.question(chalk.bold(`  ${prompt}`))).trim();

    // Mark first tool as processed
    if (isFirstTool) {
      this.firstToolOfSession = false;
    }

    // Handle message/rejection with custom message
    if (answer.toLowerCase().startsWith('msg ')) {
      const message = answer.slice(4).trim();
      this.logger.log(chalk.yellow(`  Tool rejected: ${message}\n`));
      return { decision: 'reject', message };
    }

    const lowerAnswer = answer.toLowerCase();
    switch (lowerAnswer) {
      case 'n':
      case 'no':
        this.logger.log(chalk.yellow('  Tool call rejected\n'));
        return { decision: 'reject' };

      case 'p':
      case 'persistent':
        if (!isFirstTool) {
          // Not first tool, treat as execute
          return 'execute';
        }
        this.enabled = true;
        this.logger.log(chalk.magenta('  Persistent approval enabled for this session\n'));
        return 'execute';

      default: // y, yes, or anything else → execute
        return 'execute';
    }
  }
}
