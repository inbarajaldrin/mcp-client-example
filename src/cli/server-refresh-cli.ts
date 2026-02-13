/**
 * CLI operations for server refresh management.
 */

import readline from 'readline/promises';
import { MCPClient } from '../index.js';
import { Logger } from '../logger.js';

/**
 * Handles CLI operations for server refresh selection.
 */
export class ServerRefreshCLI {
  private client: MCPClient;
  private logger: Logger;
  private getReadline: () => readline.Interface | null;

  constructor(
    client: MCPClient,
    logger: Logger,
    getReadline: () => readline.Interface | null,
  ) {
    this.client = client;
    this.logger = logger;
    this.getReadline = getReadline;
  }

  /**
   * Interactive server refresh selection interface.
   */
  async interactiveServerSelection(): Promise<void> {
    const rl = this.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    // Get all connected servers
    const servers = (this.client as any).servers as Map<string, any>;
    const serverList = Array.from(servers.keys()).sort();

    if (serverList.length === 0) {
      this.logger.log('\n❌ No servers connected\n', { type: 'error' });
      return;
    }

    // Create index mapping
    const indexToServer = new Map<number, string>();
    let serverIndex = 1;

    for (const serverName of serverList) {
      indexToServer.set(serverIndex, serverName);
      serverIndex++;
    }

    // Track selected servers
    const selectedServers = new Set<string>();

    // Clear screen before entering the loop
    process.stdout.write('\x1B[2J\x1B[0f');

    while (true) {
      // Clear and display
      process.stdout.write('\x1B[2J\x1B[0f'); // Clear screen

      let displayText = '\n🔄 Server Refresh Selection\n';
      displayText += 'Available Servers:\n\n';

      serverIndex = 1;
      for (const serverName of serverList) {
        const selected = selectedServers.has(serverName) ? '✓' : ' ';
        displayText += `  ${serverIndex}. [${selected}] ${serverName}\n`;
        serverIndex++;
      }

      displayText +=
        `\nCommands:\n` +
        `  Enter numbers separated by commas (e.g., 1,2,3) to toggle servers\n` +
        `  a or all - Select all servers\n` +
        `  n or none - Deselect all servers\n` +
        `  r or refresh - Refresh selected servers\n` +
        `  q or quit - Cancel and return\n`;

      // Write everything at once to avoid duplication
      process.stdout.write(displayText);

      const selection = (await rl.question('> ')).trim().toLowerCase();

      if (selection === 'q' || selection === 'quit') {
        this.logger.log('\nCancelled\n', { type: 'warning' });
        break;
      }

      if (selection === 'a' || selection === 'all') {
        // Select all servers
        for (const serverName of serverList) {
          selectedServers.add(serverName);
        }
        continue;
      }

      if (selection === 'n' || selection === 'none') {
        // Deselect all servers
        selectedServers.clear();
        continue;
      }

      if (selection === 'r' || selection === 'refresh') {
        // Refresh selected servers
        if (selectedServers.size === 0) {
          this.logger.log('\nNo servers selected\n', { type: 'warning' });
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        await this.refreshSelectedServers(Array.from(selectedServers));
        break;
      }

      // Handle server number selection
      if (selection.match(/^[\d,\s]+$/)) {
        const parts = selection.split(',').map((p) => p.trim());
        const indices: number[] = [];

        for (const part of parts) {
          const num = parseInt(part);
          if (!isNaN(num)) {
            indices.push(num);
          }
        }

        let toggledCount = 0;
        for (const idx of indices) {
          if (indexToServer.has(idx)) {
            const serverName = indexToServer.get(idx)!;
            if (selectedServers.has(serverName)) {
              selectedServers.delete(serverName);
            } else {
              selectedServers.add(serverName);
            }
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

  /**
   * Refresh selected servers.
   */
  private async refreshSelectedServers(serverNames: string[]): Promise<void> {
    this.logger.log('\n', { type: 'info' });

    // Preserve readline history before refresh (server stdio can affect terminal state)
    const rl = this.getReadline();
    const savedHistory = rl ? [...(rl as any).history] : [];

    // Refresh each selected server
    const results: Array<{ name: string; success: boolean; error?: any }> = [];

    for (const serverName of serverNames) {
      try {
        this.logger.log(`Refreshing "${serverName}"...`, { type: 'info' });
        await (this.client as any).refreshServer(serverName);
        this.logger.log(`✓ Refreshed "${serverName}"\n`, { type: 'success' });
        results.push({ name: serverName, success: true });
      } catch (error) {
        this.logger.log(`✗ Failed to refresh "${serverName}": ${error}\n`, {
          type: 'warning',
        });
        results.push({ name: serverName, success: false, error });
      }
    }

    // Restore readline history after refresh
    if (rl && savedHistory.length > 0) {
      (rl as any).history = savedHistory;
    }

    // Summary
    const successCount = results.filter((r) => r.success).length;
    const totalCount = results.length;

    if (successCount === totalCount) {
      this.logger.log(
        `✓ Successfully refreshed ${successCount}/${totalCount} server(s)\n`,
        { type: 'success' },
      );
    } else if (successCount > 0) {
      this.logger.log(
        `⚠️  Refreshed ${successCount}/${totalCount} server(s). ${totalCount - successCount} failed\n`,
        { type: 'warning' },
      );
    } else {
      this.logger.log(`✗ Failed to refresh any servers\n`, {
        type: 'error',
      });
    }
  }
}
