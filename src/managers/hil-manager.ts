import readline from 'readline/promises';
import chalk from 'chalk';
import { Logger } from '../logger.js';

export type HILDecision = 'execute' | 'skip';

export class HumanInTheLoopManager {
  private enabled: boolean = true;
  private sessionAutoExecute: boolean = false;
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
    this.sessionAutoExecute = false;
  }

  /**
   * Request user confirmation before executing a tool.
   * Must be called with keyboard monitor paused and a working readline.
   */
  async requestToolConfirmation(
    toolName: string,
    toolArgs: Record<string, any>,
    rl: readline.Interface,
  ): Promise<HILDecision> {
    if (!this.enabled || this.sessionAutoExecute) {
      return 'execute';
    }

    // Display tool info
    this.logger.log(
      '\n' + chalk.yellow.bold('  Human-in-the-Loop Confirmation') + '\n',
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

    // Show options
    this.logger.log('\n');
    this.logger.log(chalk.cyan.bold('  Options:\n'));
    this.logger.log(chalk.green('    y/yes') + ' - Execute this tool call\n');
    this.logger.log(chalk.red('    n/no') + ' - Skip this tool call\n');
    this.logger.log(chalk.magenta('    s/session') + ' - Auto-approve remaining tools this session\n');
    this.logger.log('\n');

    const answer = (await rl.question(chalk.bold('  Approve? [y/n/s] '))).trim().toLowerCase();

    switch (answer) {
      case 'n':
      case 'no':
        this.logger.log(chalk.yellow('  Tool call skipped\n'));
        return 'skip';

      case 's':
      case 'session':
        this.sessionAutoExecute = true;
        this.logger.log(chalk.magenta('  Auto-approving remaining tools this session\n'));
        return 'execute';

      default: // y, yes, or anything else → execute
        return 'execute';
    }
  }
}
