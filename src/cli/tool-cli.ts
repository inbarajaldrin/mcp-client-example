/**
 * CLI operations for tool management.
 */

import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import readline from 'readline/promises';
import { MCPClient } from '../index.js';
import { Logger } from '../logger.js';

/**
 * Handles CLI operations for tool listing and selection.
 */
export class ToolCLI {
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
   * Display list of enabled tools.
   */
  async displayToolsList(): Promise<void> {
    const toolManager = this.client.getToolManager();
    const disabledServers = this.client.getDisabledServerNames();

    // Get all tools from all servers
    const allTools: Array<{ name: string; server: string; enabled: boolean }> =
      [];

    // Access private servers map through a workaround
    const servers = (this.client as any).servers as Map<string, any>;

    for (const [serverName, connection] of servers.entries()) {
      // Skip servers disabled in config — they are connected but not exposed to the agent
      if (disabledServers.has(serverName)) continue;

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
    const toolObjects = allTools.map((t) => ({
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
    const enabledTools = allTools.filter((t) => t.enabled);

    if (enabledTools.length === 0) {
      this.logger.log('\n📋 Enabled Tools:\n', { type: 'info' });
      this.logger.log('  No enabled tools.\n', { type: 'warning' });
      this.logger.log('  Use /tools-manager to enable tools.\n', {
        type: 'info',
      });
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
      this.logger.log(`\n[${serverName}] (${tools.length} enabled):\n`, {
        type: 'info',
      });

      for (const tool of tools) {
        this.logger.log(`  ✓ ${tool.name}\n`, { type: 'info' });
      }
    }

    this.logger.log('\n');
  }

  /**
   * Interactive tool selection interface.
   */
  async interactiveToolSelection(): Promise<void> {
    const rl = this.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const toolManager = this.client.getToolManager();

    // Save initial state to revert to on cancel
    const initialState = { ...toolManager.getToolStates() };

    // Collect all tools from all servers (excluding disabled servers)
    const disabledServers = this.client.getDisabledServerNames();
    const allTools: Array<{
      name: string;
      server: string;
      toolName: string;
      enabled: boolean;
    }> = [];
    const servers = (this.client as any).servers as Map<string, any>;
    const serverList: string[] = [];

    for (const [serverName, connection] of servers.entries()) {
      // Skip servers disabled in config — they are connected but not exposed to the agent
      if (disabledServers.has(serverName)) continue;

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
    const toolObjects = allTools.map((t) => ({
      name: t.toolName,
      description: `[${t.server}] ${t.name}`,
      input_schema: {},
    }));
    toolManager.updateStateForNewTools(toolObjects as any);

    // Create index mapping
    const indexToTool = new Map<number, (typeof allTools)[0]>();
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
      a[0].localeCompare(b[0]),
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
        const enabledCount = serverTools.filter((t) => t.enabled).length;
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

      displayText +=
        `\nCommands:\n` +
        `  Enter numbers separated by commas or ranges (e.g., 1,3,5-8) to toggle tools\n` +
        `  Enter S + number (e.g., S1, s2) to toggle all tools in a server\n` +
        `  a or all - Enable all tools\n` +
        `  n or none - Disable all tools\n` +
        `  s or save - Save changes and return\n` +
        `  q or quit - Cancel and return\n`;

      // Write everything at once to avoid duplication
      process.stdout.write(displayText);

      const selection = (await rl.question('> ')).trim().toLowerCase();

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
        this.logger.log('\n✗ Changes cancelled - reverted to original state\n', {
          type: 'warning',
        });
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
          const allEnabled = serverTools.every((t) => t.enabled);
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

      this.logger.log('\nInvalid selection. Please try again.\n', {
        type: 'error',
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
