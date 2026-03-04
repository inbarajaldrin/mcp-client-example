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

  async addResourceToContext(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const allResources = this.client.listResources();
    const resourceManager = this.client.getResourceManager();
    const enabledResources = resourceManager.filterResources(allResources);

    if (enabledResources.length === 0) {
      this.logger.log(
        '\nNo enabled resources available. Use /resources-manager to enable resources.\n',
        { type: 'warning' },
      );
      return;
    }

    // Group resources by server
    const resourcesByServer = new Map<string, typeof enabledResources>();
    for (const resourceData of enabledResources) {
      if (!resourcesByServer.has(resourceData.server)) {
        resourcesByServer.set(resourceData.server, []);
      }
      resourcesByServer.get(resourceData.server)!.push(resourceData);
    }

    const sortedServers = Array.from(resourcesByServer.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    // Display resources
    this.logger.log('\n📦 Available Resources:\n', { type: 'info' });

    const indexToResource = new Map<number, (typeof enabledResources)[0]>();
    let resourceIndex = 1;

    for (const [serverName, serverResources] of sortedServers) {
      this.logger.log(`\n[${serverName}]:\n`, { type: 'info' });

      for (const resourceData of serverResources) {
        const resource = resourceData.resource;
        const mimeInfo = resource.mimeType ? ` (${resource.mimeType})` : '';
        this.logger.log(`  ${resourceIndex}. ${resource.name}${mimeInfo}\n`, {
          type: 'info',
        });
        this.logger.log(`     URI: ${resource.uri}\n`, { type: 'info' });
        if (resource.description) {
          this.logger.log(`     ${resource.description}\n`, { type: 'info' });
        }
        indexToResource.set(resourceIndex, resourceData);
        resourceIndex++;
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

    const selectedResources: Array<(typeof allResources)[0]> = [];
    for (const idx of selectedIndices) {
      if (indexToResource.has(idx)) {
        selectedResources.push(indexToResource.get(idx)!);
      }
    }

    if (selectedResources.length === 0) {
      this.logger.log('\n✗ No valid resources found\n', { type: 'warning' });
      return;
    }

    // Read and inject each selected resource
    for (const resourceData of selectedResources) {
      const resource = resourceData.resource;

      try {
        const result = await this.client.readResource(
          resourceData.server,
          resource.uri,
        );

        const messages = this.callbacks.getMessages();
        const historyManager = this.client.getChatHistoryManager();

        for (const content of result.contents) {
          let contentText = '';

          if ('text' in content && content.text) {
            contentText = `[Resource: ${content.uri}]\n\`\`\`\n${content.text}\n\`\`\``;
          } else if ('blob' in content && content.blob) {
            contentText = `[Resource: ${content.uri}]\n[Binary data, ${content.blob.length} bytes base64]`;
          } else {
            contentText = `[Resource: ${content.uri}]\n[Empty resource]`;
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
          `\n✓ Added resource "${resource.name}" to conversation context (${contentCount} content block${contentCount > 1 ? 's' : ''} added)\n`,
          { type: 'info' },
        );
      } catch (error) {
        this.logger.log(
          `\n✗ Failed to read resource "${resource.name}": ${error}\n`,
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
    const enabledResources = resourceManager.filterResources(allResources);

    if (enabledResources.length === 0) {
      this.logger.log('\n📦 Enabled Resources:\n', { type: 'info' });
      this.logger.log('  No enabled resources.\n', { type: 'warning' });
      this.logger.log('  Use /resources-manager to enable resources.\n', {
        type: 'info',
      });
      return;
    }

    // Group by server
    const resourcesByServer = new Map<string, Array<{ name: string; uri: string }>>();
    for (const resourceData of enabledResources) {
      if (!resourcesByServer.has(resourceData.server)) {
        resourcesByServer.set(resourceData.server, []);
      }
      resourcesByServer.get(resourceData.server)!.push({
        name: resourceData.resource.name,
        uri: resourceData.resource.uri,
      });
    }

    this.logger.log('\n📦 Enabled Resources:\n', { type: 'info' });

    for (const [serverName, resources] of resourcesByServer.entries()) {
      this.logger.log(`\n[${serverName}] (${resources.length} enabled):\n`, {
        type: 'info',
      });

      for (const resource of resources) {
        this.logger.log(`  ✓ ${resource.name}\n`, { type: 'info' });
        this.logger.log(`    ${resource.uri}\n`, { type: 'info' });
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

    if (allResources.length === 0) {
      this.logger.log('\nNo resources available from any server.\n', {
        type: 'warning',
      });
      return;
    }

    const indexToResource = new Map<number, (typeof allResources)[0]>();
    let resourceIndex = 1;

    // Group resources by server
    const resourcesByServer = new Map<string, typeof allResources>();
    for (const resourceData of allResources) {
      if (!resourcesByServer.has(resourceData.server)) {
        resourcesByServer.set(resourceData.server, []);
      }
      resourcesByServer.get(resourceData.server)!.push(resourceData);
    }

    const sortedServers = Array.from(resourcesByServer.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    process.stdout.write('\x1B[2J\x1B[0f');

    while (true) {
      process.stdout.write('\x1B[2J\x1B[0f');

      let displayText = '\n📦 Resource Manager\n';
      displayText += 'Available Servers and Resources:\n';

      resourceIndex = 1;
      indexToResource.clear();

      for (let serverIdx = 0; serverIdx < sortedServers.length; serverIdx++) {
        const [serverName, serverResources] = sortedServers[serverIdx];
        const enabledCount = serverResources.filter((r) =>
          resourceManager.isResourceEnabled(r.server, r.resource.name),
        ).length;
        const totalCount = serverResources.length;

        let serverStatus = '✓';
        if (enabledCount === 0) {
          serverStatus = '✗';
        } else if (enabledCount < totalCount) {
          serverStatus = '~';
        }

        displayText += `\nS${serverIdx + 1}. ${serverStatus} [${serverName}] (${enabledCount}/${totalCount} enabled):\n`;

        for (const resourceData of serverResources) {
          const enabled = resourceManager.isResourceEnabled(
            resourceData.server,
            resourceData.resource.name,
          );
          const status = enabled ? '✓' : '✗';
          displayText += `  ${resourceIndex}. ${status} ${resourceData.resource.name}\n`;
          displayText += `       ${resourceData.resource.uri}\n`;
          indexToResource.set(resourceIndex, resourceData);
          resourceIndex++;
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

      if (selection === 'a' || selection === 'all') {
        for (const resourceData of allResources) {
          resourceManager.setResourceEnabled(
            resourceData.server,
            resourceData.resource.name,
            true,
            false,
          );
        }
        continue;
      }

      if (selection === 'n' || selection === 'none') {
        for (const resourceData of allResources) {
          resourceManager.setResourceEnabled(
            resourceData.server,
            resourceData.resource.name,
            false,
            false,
          );
        }
        continue;
      }

      // Handle server toggle
      if (selection.match(/^s\d+$/i)) {
        const serverNum = parseInt(selection.slice(1)) - 1;
        if (serverNum >= 0 && serverNum < sortedServers.length) {
          const [, serverResources] = sortedServers[serverNum];
          const allEnabled = serverResources.every((r) =>
            resourceManager.isResourceEnabled(r.server, r.resource.name),
          );
          const newState = !allEnabled;

          for (const resourceData of serverResources) {
            resourceManager.setResourceEnabled(
              resourceData.server,
              resourceData.resource.name,
              newState,
              false,
            );
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
          if (indexToResource.has(idx)) {
            const resourceData = indexToResource.get(idx)!;
            resourceManager.toggleResource(
              resourceData.server,
              resourceData.resource.name,
              false,
            );
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
