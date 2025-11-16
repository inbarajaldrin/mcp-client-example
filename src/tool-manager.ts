import type { Tool } from './model-provider.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(homedir(), '.mcp-client');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

interface ClientConfig {
  servers?: Record<string, { command: string; args: string[]; disabled?: boolean }>;
  defaultServer?: string;
  toolStates?: Record<string, boolean>;
}

export class ToolManager {
  private toolStates: Record<string, boolean> = {};
  private logger: Logger;
  private configFile: string;

  constructor(logger?: Logger, configFile?: string) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.configFile = configFile || CONFIG_FILE;
    this.loadState();
  }

  /**
   * Load tool states from config file
   */
  loadState(): void {
    try {
      if (!existsSync(this.configFile)) {
        this.toolStates = {};
        return;
      }

      const content = readFileSync(this.configFile, 'utf-8');
      const config: ClientConfig = JSON.parse(content);

      if (config.toolStates) {
        this.toolStates = { ...config.toolStates };
      } else {
        this.toolStates = {};
      }
    } catch (error) {
      this.logger.log(
        `Failed to load tool states from config: ${error}\n`,
        { type: 'warning' },
      );
      this.toolStates = {};
    }
  }

  /**
   * Save tool states to config file
   */
  saveState(): void {
    try {
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }

      let config: ClientConfig = {};
      if (existsSync(this.configFile)) {
        try {
          const content = readFileSync(this.configFile, 'utf-8');
          config = JSON.parse(content);
        } catch (error) {
          // If file exists but can't be parsed, start fresh
          config = {};
        }
      }

      config.toolStates = this.toolStates;

      writeFileSync(this.configFile, JSON.stringify(config, null, 2));
    } catch (error) {
      this.logger.log(
        `Failed to save tool states to config: ${error}\n`,
        { type: 'error' },
      );
    }
  }

  /**
   * Check if a tool is enabled
   */
  isToolEnabled(toolName: string): boolean {
    // Default to enabled if not in state (for new tools)
    return this.toolStates[toolName] !== false;
  }

  /**
   * Enable all tools from all servers
   */
  enableAllTools(tools: Tool[]): void {
    for (const tool of tools) {
      this.toolStates[tool.name] = true;
    }
    this.saveState();
  }

  /**
   * Disable all tools from all servers
   */
  disableAllTools(tools: Tool[]): void {
    for (const tool of tools) {
      this.toolStates[tool.name] = false;
    }
    this.saveState();
  }

  /**
   * Enable all tools from a specific server
   */
  enableServerTools(serverName: string, tools: Tool[]): void {
    const serverPrefix = `${serverName}__`;
    for (const tool of tools) {
      if (tool.name.startsWith(serverPrefix)) {
        this.toolStates[tool.name] = true;
      }
    }
    this.saveState();
  }

  /**
   * Disable all tools from a specific server
   */
  disableServerTools(serverName: string, tools: Tool[]): void {
    const serverPrefix = `${serverName}__`;
    for (const tool of tools) {
      if (tool.name.startsWith(serverPrefix)) {
        this.toolStates[tool.name] = false;
      }
    }
    this.saveState();
  }

  /**
   * Toggle a specific tool
   */
  toggleTool(toolName: string, saveImmediately: boolean = true): boolean {
    const newState = !this.isToolEnabled(toolName);
    this.toolStates[toolName] = newState;
    if (saveImmediately) {
      this.saveState();
    }
    return newState;
  }

  /**
   * Set the enabled state of a specific tool
   */
  setToolEnabled(toolName: string, enabled: boolean, saveImmediately: boolean = true): void {
    this.toolStates[toolName] = enabled;
    if (saveImmediately) {
      this.saveState();
    }
  }

  /**
   * Update state for new tools (not in saved state) - set them to enabled by default
   */
  updateStateForNewTools(tools: Tool[]): void {
    let hasNewTools = false;
    for (const tool of tools) {
      if (!(tool.name in this.toolStates)) {
        this.toolStates[tool.name] = true; // Default to enabled for new tools
        hasNewTools = true;
      }
    }
    if (hasNewTools) {
      this.saveState();
    }
  }

  /**
   * Filter tools based on enabled state
   */
  filterTools(tools: Tool[]): Tool[] {
    return tools.filter((tool) => this.isToolEnabled(tool.name));
  }

  /**
   * Get all tool states
   */
  getToolStates(): Record<string, boolean> {
    return { ...this.toolStates };
  }

  /**
   * Get enabled tools from a list
   */
  getEnabledTools(tools: Tool[]): Tool[] {
    return tools.filter((tool) => this.isToolEnabled(tool.name));
  }

  /**
   * Restore tool states from a saved state (for canceling changes)
   */
  restoreState(states: Record<string, boolean>): void {
    this.toolStates = { ...states };
    // Don't save - this is for reverting changes
  }
}

