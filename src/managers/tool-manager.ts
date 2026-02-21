import type { Tool } from '../model-provider.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';
import { Logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(__dirname, '../..', '.mcp-client-data');
const TOOL_STATES_FILE = join(CONFIG_DIR, 'tool-states.yaml');
const LEGACY_JSON = join(CONFIG_DIR, 'preferences.json');

export class ToolManager {
  private toolStates: Record<string, boolean> = {};
  private logger: Logger;
  private statesFile: string;

  constructor(logger?: Logger, statesFile?: string) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.statesFile = statesFile || TOOL_STATES_FILE;
    this.loadState();
  }

  loadState(): void {
    if (existsSync(this.statesFile)) {
      try {
        const content = readFileSync(this.statesFile, 'utf-8');
        const states = yaml.parse(content);
        this.toolStates = states && typeof states === 'object' ? { ...states } : {};
        return;
      } catch (error) {
        this.logger.log(
          `Failed to load tool-states.yaml: ${error}. Trying legacy fallback.\n`,
          { type: 'warning' },
        );
      }
    }

    // Migration: read from legacy preferences.json
    if (existsSync(LEGACY_JSON)) {
      try {
        const content = readFileSync(LEGACY_JSON, 'utf-8');
        const config = JSON.parse(content);
        if (config.toolStates && typeof config.toolStates === 'object') {
          this.toolStates = { ...config.toolStates };
          this.saveState();
          return;
        }
      } catch {
        // Fall through to empty
      }
    }

    this.toolStates = {};
  }

  saveState(): void {
    try {
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }
      writeFileSync(this.statesFile, yaml.stringify(this.toolStates), 'utf-8');
    } catch (error) {
      this.logger.log(
        `Failed to save tool states: ${error}\n`,
        { type: 'error' },
      );
    }
  }

  isToolEnabled(toolName: string): boolean {
    return this.toolStates[toolName] !== false;
  }

  enableAllTools(tools: Tool[]): void {
    for (const tool of tools) {
      this.toolStates[tool.name] = true;
    }
    this.saveState();
  }

  disableAllTools(tools: Tool[]): void {
    for (const tool of tools) {
      this.toolStates[tool.name] = false;
    }
    this.saveState();
  }

  enableServerTools(serverName: string, tools: Tool[]): void {
    const serverPrefix = `${serverName}__`;
    for (const tool of tools) {
      if (tool.name.startsWith(serverPrefix)) {
        this.toolStates[tool.name] = true;
      }
    }
    this.saveState();
  }

  disableServerTools(serverName: string, tools: Tool[]): void {
    const serverPrefix = `${serverName}__`;
    for (const tool of tools) {
      if (tool.name.startsWith(serverPrefix)) {
        this.toolStates[tool.name] = false;
      }
    }
    this.saveState();
  }

  toggleTool(toolName: string, saveImmediately: boolean = true): boolean {
    const newState = !this.isToolEnabled(toolName);
    this.toolStates[toolName] = newState;
    if (saveImmediately) {
      this.saveState();
    }
    return newState;
  }

  setToolEnabled(toolName: string, enabled: boolean, saveImmediately: boolean = true): void {
    this.toolStates[toolName] = enabled;
    if (saveImmediately) {
      this.saveState();
    }
  }

  updateStateForNewTools(tools: Tool[]): boolean {
    let hasNewTools = false;
    for (const tool of tools) {
      if (!(tool.name in this.toolStates)) {
        this.toolStates[tool.name] = true;
        hasNewTools = true;
      }
    }
    if (hasNewTools) {
      this.saveState();
    }
    return hasNewTools;
  }

  filterTools(tools: Tool[]): Tool[] {
    return tools.filter((tool) => this.isToolEnabled(tool.name));
  }

  getToolStates(): Record<string, boolean> {
    return { ...this.toolStates };
  }

  getEnabledTools(tools: Tool[]): Tool[] {
    return tools.filter((tool) => this.isToolEnabled(tool.name));
  }

  restoreState(states: Record<string, boolean>): void {
    this.toolStates = { ...states };
  }
}
