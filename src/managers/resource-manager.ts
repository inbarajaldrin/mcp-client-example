// Reference: /tmp/mcp-typescript-sdk (official MCP SDK resource types)
// Reference: /tmp/mcp-use-ts (mcp-use framework resource patterns)
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';
import { Logger } from '../logger.js';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(__dirname, '../..', '.mcp-client-data');
const RESOURCE_STATES_FILE = join(CONFIG_DIR, 'resource-states.yaml');

type ResourceWithServer = {
  server: string;
  resource: Resource;
};

export class ResourceManager {
  private resourceStates: Record<string, boolean> = {};
  private logger: Logger;
  private statesFile: string;

  constructor(logger?: Logger, statesFile?: string) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.statesFile = statesFile || RESOURCE_STATES_FILE;
    this.loadState();
  }

  loadState(): void {
    if (existsSync(this.statesFile)) {
      try {
        const content = readFileSync(this.statesFile, 'utf-8');
        const states = yaml.parse(content);
        this.resourceStates = states && typeof states === 'object' ? { ...states } : {};
        return;
      } catch (error) {
        this.logger.log(
          `Failed to load resource-states.yaml: ${error}\n`,
          { type: 'warning' },
        );
      }
    }

    this.resourceStates = {};
  }

  saveState(): void {
    try {
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }
      writeFileSync(this.statesFile, yaml.stringify(this.resourceStates), 'utf-8');
    } catch (error) {
      this.logger.log(
        `Failed to save resource states: ${error}\n`,
        { type: 'error' },
      );
    }
  }

  private getResourceKey(serverName: string, resourceName: string): string {
    return `${serverName}__${resourceName}`;
  }

  isResourceEnabled(serverName: string, resourceName: string): boolean {
    const key = this.getResourceKey(serverName, resourceName);
    return this.resourceStates[key] !== false;
  }

  setResourceEnabled(serverName: string, resourceName: string, enabled: boolean, saveImmediately: boolean = true): void {
    const key = this.getResourceKey(serverName, resourceName);
    this.resourceStates[key] = enabled;
    if (saveImmediately) {
      this.saveState();
    }
  }

  toggleResource(serverName: string, resourceName: string, saveImmediately: boolean = true): boolean {
    const newState = !this.isResourceEnabled(serverName, resourceName);
    this.setResourceEnabled(serverName, resourceName, newState, saveImmediately);
    return newState;
  }

  updateStateForNewResources(resources: ResourceWithServer[]): void {
    let hasNewResources = false;
    for (const { server, resource } of resources) {
      const key = this.getResourceKey(server, resource.name);
      if (!(key in this.resourceStates)) {
        this.resourceStates[key] = true;
        hasNewResources = true;
      }
    }
    if (hasNewResources) {
      this.saveState();
    }
  }

  pruneStaleResources(knownResourceKeys: Set<string>): void {
    const staleKeys = Object.keys(this.resourceStates).filter(key => !knownResourceKeys.has(key));
    if (staleKeys.length === 0) return;

    for (const key of staleKeys) {
      delete this.resourceStates[key];
    }
    this.saveState();
    this.logger.log(`Pruned ${staleKeys.length} stale resource(s) from resource-states.yaml\n`, { type: 'info' });
  }

  filterResources(resources: ResourceWithServer[]): ResourceWithServer[] {
    return resources.filter(({ server, resource }) =>
      this.isResourceEnabled(server, resource.name),
    );
  }

  getResourceStates(): Record<string, boolean> {
    return { ...this.resourceStates };
  }

  restoreState(states: Record<string, boolean>): void {
    this.resourceStates = { ...states };
  }
}
