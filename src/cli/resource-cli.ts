// Reference: src/cli/prompt-cli.ts (mirrored pattern for resource management)
import readline from 'readline/promises';
import { MCPClient } from '../index.js';
import { Logger } from '../logger.js';

export interface ResourceCLICallbacks {
  getReadline: () => readline.Interface | null;
  getMessages: () => any[];
  getTokenCounter: () => { countMessageTokens: (msg: any) => number } | null;
  getCurrentTokenCount: () => number;
  setCurrentTokenCount: (count: number) => void;
  onResourcesAdded?: () => void;
}

export class ResourceCLI {
  private client: MCPClient;
  private logger: Logger;
  private callbacks: ResourceCLICallbacks;

  constructor(
    client: MCPClient,
    logger: Logger,
    callbacks: ResourceCLICallbacks,
  ) {
    this.client = client;
    this.logger = logger;
    this.callbacks = callbacks;
  }

  /**
   * Extract {param} placeholders from a URI template string.
   */
  private extractTemplateParams(uriTemplate: string): string[] {
    const params: string[] = [];
    const regex = /\{([^}]+)\}/g;
    let match;
    while ((match = regex.exec(uriTemplate)) !== null) {
      params.push(match[1]);
    }
    return params;
  }

  async addResourceToContext(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const allResources = this.client.listResources();
    const allTemplates = this.client.listResourceTemplates();
    const resourceManager = this.client.getResourceManager();
    const enabledResources = resourceManager.filterResources(allResources);
    const enabledTemplates = allTemplates.filter(({ server, template }) =>
      resourceManager.isResourceEnabled(server, template.name),
    );

    if (enabledResources.length === 0 && enabledTemplates.length === 0) {
      this.logger.log(
        '\nNo enabled resources available. Use /resources-manager to enable resources.\n',
        { type: 'warning' },
      );
      return;
    }

    // Unified item type for the selection list
    type ResourceItem =
      | { kind: 'concrete'; server: string; resource: (typeof enabledResources)[0]['resource'] }
      | { kind: 'template'; server: string; template: (typeof enabledTemplates)[0]['template'] };

    // Group all items by server
    const itemsByServer = new Map<string, ResourceItem[]>();
    for (const r of enabledResources) {
      if (!itemsByServer.has(r.server)) itemsByServer.set(r.server, []);
      itemsByServer.get(r.server)!.push({ kind: 'concrete', server: r.server, resource: r.resource });
    }
    for (const t of enabledTemplates) {
      if (!itemsByServer.has(t.server)) itemsByServer.set(t.server, []);
      itemsByServer.get(t.server)!.push({ kind: 'template', server: t.server, template: t.template });
    }

    const sortedServers = Array.from(itemsByServer.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    // Display resources and templates
    this.logger.log('\n📦 Available Resources:\n', { type: 'info' });

    const indexToItem = new Map<number, ResourceItem>();
    let itemIndex = 1;

    for (const [serverName, items] of sortedServers) {
      this.logger.log(`\n[${serverName}]:\n`, { type: 'info' });

      for (const item of items) {
        if (item.kind === 'concrete') {
          const mimeInfo = item.resource.mimeType ? ` (${item.resource.mimeType})` : '';
          this.logger.log(`  ${itemIndex}. ${item.resource.name}${mimeInfo}\n`, { type: 'info' });
          this.logger.log(`     URI: ${item.resource.uri}\n`, { type: 'info' });
          if (item.resource.description) {
            this.logger.log(`     ${item.resource.description}\n`, { type: 'info' });
          }
        } else {
          const params = this.extractTemplateParams(item.template.uriTemplate);
          const paramsHint = params.length > 0 ? ` (${params.length} param${params.length > 1 ? 's' : ''}: ${params.join(', ')})` : '';
          this.logger.log(`  ${itemIndex}. ${item.template.name}${paramsHint}\n`, { type: 'info' });
          this.logger.log(`     Template: ${item.template.uriTemplate}\n`, { type: 'info' });
          if (item.template.description) {
            this.logger.log(`     ${item.template.description}\n`, { type: 'info' });
          }
        }
        indexToItem.set(itemIndex, item);
        itemIndex++;
      }
    }

    this.logger.log(
      `\nEnter resource number(s) separated by commas (e.g., 1,3,5) or 'q' to cancel:\n`,
      { type: 'info' },
    );

    const selection = (await rl.question('> ')).trim();

    if (
      selection.toLowerCase() === 'q' ||
      selection.toLowerCase() === 'quit'
    ) {
      this.logger.log('\n✗ Resource selection cancelled\n', { type: 'warning' });
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
      this.logger.log('\n✗ No valid resources selected\n', { type: 'warning' });
      return;
    }

    const selectedItems: ResourceItem[] = [];
    for (const idx of selectedIndices) {
      if (indexToItem.has(idx)) {
        selectedItems.push(indexToItem.get(idx)!);
      }
    }

    if (selectedItems.length === 0) {
      this.logger.log('\n✗ No valid resources found\n', { type: 'warning' });
      return;
    }

    // Resolve and inject each selected item
    for (const item of selectedItems) {
      let server: string;
      let uri: string;
      let description: string | undefined;
      let displayName: string;

      if (item.kind === 'concrete') {
        server = item.server;
        uri = item.resource.uri;
        description = item.resource.description;
        displayName = item.resource.name;
      } else {
        // Template — collect arguments
        server = item.server;
        description = item.template.description;
        displayName = item.template.name;
        const params = this.extractTemplateParams(item.template.uriTemplate);

        if (params.length > 0) {
          this.logger.log(
            `\n📦 Entering parameters for: ${item.template.name}\n`,
            { type: 'info' },
          );

          uri = item.template.uriTemplate;
          let skipped = false;
          for (const param of params) {
            this.logger.log(`  ${param}:\n`, { type: 'info' });
            const value = (await rl.question('  > ')).trim();
            if (!value) {
              this.logger.log(
                `\n⚠️ Parameter "${param}" is required. Skipping this resource.\n`,
                { type: 'warning' },
              );
              skipped = true;
              break;
            }
            uri = uri.replace(`{${param}}`, value);
          }
          if (skipped) continue;
        } else {
          uri = item.template.uriTemplate;
        }
      }

      try {
        const result = await this.client.readResource(server, uri);

        const messages = this.callbacks.getMessages();
        const historyManager = this.client.getChatHistoryManager();

        const descLine = description ? `\n${description}\n` : '\n';

        for (const content of result.contents) {
          let contentText = '';

          if ('text' in content && content.text) {
            contentText = `[Resource: ${content.uri}]${descLine}\`\`\`\n${content.text}\n\`\`\``;
          } else if ('blob' in content && content.blob) {
            contentText = `[Resource: ${content.uri}]${descLine}[Binary data, ${content.blob.length} bytes base64]`;
          } else {
            contentText = `[Resource: ${content.uri}]${descLine}[Empty resource]`;
          }

          messages.push({
            role: 'user',
            content: contentText,
          });

          historyManager.addUserMessage(contentText);

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

        const contentCount = result.contents.length;
        this.logger.log(
          `\n✓ Added resource "${displayName}" to conversation context (${contentCount} content block${contentCount > 1 ? 's' : ''} added)\n`,
          { type: 'info' },
        );
      } catch (error) {
        this.logger.log(
          `\n✗ Failed to read resource "${displayName}": ${error}\n`,
          { type: 'error' },
        );
      }
    }

    const totalMessages = this.callbacks.getMessages().length;
    this.logger.log(
      `\n✓ Resource selection complete. ${totalMessages} message(s) in context.\n`,
      { type: 'info' },
    );

    if (this.callbacks.onResourcesAdded) {
      this.callbacks.onResourcesAdded();
    }
  }

  async displayResourcesList(): Promise<void> {
    const resourceManager = this.client.getResourceManager();
    const allResources = this.client.listResources();
    const allTemplates = this.client.listResourceTemplates();
    const enabledResources = resourceManager.filterResources(allResources);
    const enabledTemplates = allTemplates.filter(({ server, template }) =>
      resourceManager.isResourceEnabled(server, template.name),
    );

    if (enabledResources.length === 0 && enabledTemplates.length === 0) {
      this.logger.log('\n📦 Enabled Resources:\n', { type: 'info' });
      this.logger.log('  No enabled resources.\n', { type: 'warning' });
      this.logger.log('  Use /resources-manager to enable resources.\n', {
        type: 'info',
      });
      return;
    }

    // Group by server
    const itemsByServer = new Map<string, Array<{ name: string; uri: string }>>();
    for (const r of enabledResources) {
      if (!itemsByServer.has(r.server)) itemsByServer.set(r.server, []);
      itemsByServer.get(r.server)!.push({ name: r.resource.name, uri: r.resource.uri });
    }
    for (const t of enabledTemplates) {
      if (!itemsByServer.has(t.server)) itemsByServer.set(t.server, []);
      itemsByServer.get(t.server)!.push({ name: t.template.name, uri: t.template.uriTemplate });
    }

    this.logger.log('\n📦 Enabled Resources:\n', { type: 'info' });

    for (const [serverName, items] of itemsByServer.entries()) {
      this.logger.log(`\n[${serverName}] (${items.length} enabled):\n`, {
        type: 'info',
      });

      for (const item of items) {
        this.logger.log(`  ✓ ${item.name}\n`, { type: 'info' });
        this.logger.log(`    ${item.uri}\n`, { type: 'info' });
      }
    }

    this.logger.log('\n');
  }

  async interactiveResourceManager(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const resourceManager = this.client.getResourceManager();
    const initialState = { ...resourceManager.getResourceStates() };

    const allResources = this.client.listResources();
    const allTemplates = this.client.listResourceTemplates();

    // Unified item type for the manager list
    type ManagerItem =
      | { kind: 'concrete'; server: string; name: string; uri: string }
      | { kind: 'template'; server: string; name: string; uri: string };

    if (allResources.length === 0 && allTemplates.length === 0) {
      this.logger.log('\nNo resources available from any server.\n', {
        type: 'warning',
      });
      return;
    }

    // Group all items by server
    const itemsByServer = new Map<string, ManagerItem[]>();
    for (const r of allResources) {
      if (!itemsByServer.has(r.server)) itemsByServer.set(r.server, []);
      itemsByServer.get(r.server)!.push({ kind: 'concrete', server: r.server, name: r.resource.name, uri: r.resource.uri });
    }
    for (const t of allTemplates) {
      if (!itemsByServer.has(t.server)) itemsByServer.set(t.server, []);
      itemsByServer.get(t.server)!.push({ kind: 'template', server: t.server, name: t.template.name, uri: t.template.uriTemplate });
    }

    const indexToItem = new Map<number, ManagerItem>();
    let itemIndex = 1;

    const sortedServers = Array.from(itemsByServer.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    process.stdout.write('\x1B[2J\x1B[0f');

    while (true) {
      process.stdout.write('\x1B[2J\x1B[0f');

      let displayText = '\n📦 Resource Manager\n';
      displayText += 'Available Servers and Resources:\n';

      itemIndex = 1;
      indexToItem.clear();

      for (let serverIdx = 0; serverIdx < sortedServers.length; serverIdx++) {
        const [serverName, serverItems] = sortedServers[serverIdx];
        const enabledCount = serverItems.filter((item) =>
          resourceManager.isResourceEnabled(item.server, item.name),
        ).length;
        const totalCount = serverItems.length;

        let serverStatus = '✓';
        if (enabledCount === 0) {
          serverStatus = '✗';
        } else if (enabledCount < totalCount) {
          serverStatus = '~';
        }

        displayText += `\nS${serverIdx + 1}. ${serverStatus} [${serverName}] (${enabledCount}/${totalCount} enabled):\n`;

        for (const item of serverItems) {
          const enabled = resourceManager.isResourceEnabled(item.server, item.name);
          const status = enabled ? '✓' : '✗';
          displayText += `  ${itemIndex}. ${status} ${item.name}\n`;
          displayText += `       ${item.uri}\n`;
          indexToItem.set(itemIndex, item);
          itemIndex++;
        }
      }

      displayText +=
        `\nCommands:\n` +
        `  Enter numbers separated by commas or ranges (e.g., 1,3,5-8) to toggle resources\n` +
        `  Enter S + number (e.g., S1, s2) to toggle all resources in a server\n` +
        `  a or all - Enable all resources\n` +
        `  n or none - Disable all resources\n` +
        `  s or save - Save changes and return\n` +
        `  q or quit - Cancel and return\n`;

      process.stdout.write(displayText);

      const selection = (await rl.question('> ')).trim().toLowerCase();

      if (selection === 's' || selection === 'save') {
        resourceManager.saveState();
        this.logger.log('\n✓ Changes saved\n', { type: 'info' });
        break;
      }

      if (selection === 'q' || selection === 'quit') {
        resourceManager.restoreState(initialState);
        this.logger.log('\n✗ Changes cancelled - reverted to original state\n', {
          type: 'warning',
        });
        break;
      }

      const allItems = Array.from(itemsByServer.values()).flat();

      if (selection === 'a' || selection === 'all') {
        for (const item of allItems) {
          resourceManager.setResourceEnabled(item.server, item.name, true, false);
        }
        continue;
      }

      if (selection === 'n' || selection === 'none') {
        for (const item of allItems) {
          resourceManager.setResourceEnabled(item.server, item.name, false, false);
        }
        continue;
      }

      // Handle server toggle
      if (selection.match(/^s\d+$/i)) {
        const serverNum = parseInt(selection.slice(1)) - 1;
        if (serverNum >= 0 && serverNum < sortedServers.length) {
          const [, serverItems] = sortedServers[serverNum];
          const allEnabled = serverItems.every((item) =>
            resourceManager.isResourceEnabled(item.server, item.name),
          );
          const newState = !allEnabled;

          for (const item of serverItems) {
            resourceManager.setResourceEnabled(item.server, item.name, newState, false);
          }
          continue;
        }
      }

      // Handle resource number selection
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
          if (indexToItem.has(idx)) {
            const item = indexToItem.get(idx)!;
            resourceManager.toggleResource(item.server, item.name, false);
            toggledCount++;
          }
        }

        if (toggledCount > 0) {
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
