import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { Logger } from './logger.js';
import type { Prompt } from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(homedir(), '.mcp-client');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

interface ClientConfig {
  servers?: Record<string, { command: string; args: string[]; disabled?: boolean }>;
  defaultServer?: string;
  toolStates?: Record<string, boolean>;
  promptStates?: Record<string, boolean>;
}

type PromptWithServer = {
  server: string;
  prompt: Prompt;
};

export class PromptManager {
  private promptStates: Record<string, boolean> = {};
  private logger: Logger;
  private configFile: string;

  constructor(logger?: Logger, configFile?: string) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.configFile = configFile || CONFIG_FILE;
    this.loadState();
  }

  /**
   * Load prompt states from config file
   */
  loadState(): void {
    try {
      if (!existsSync(this.configFile)) {
        this.promptStates = {};
        return;
      }

      const content = readFileSync(this.configFile, 'utf-8');
      const config: ClientConfig = JSON.parse(content);

      if (config.promptStates) {
        this.promptStates = { ...config.promptStates };
      } else {
        this.promptStates = {};
      }
    } catch (error) {
      this.logger.log(
        `Failed to load prompt states from config: ${error}\n`,
        { type: 'warning' },
      );
      this.promptStates = {};
    }
  }

  /**
   * Save prompt states to config file
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

      config.promptStates = this.promptStates;

      writeFileSync(this.configFile, JSON.stringify(config, null, 2));
    } catch (error) {
      this.logger.log(
        `Failed to save prompt states to config: ${error}\n`,
        { type: 'error' },
      );
    }
  }

  /**
   * Get the key for a prompt (serverName__promptName)
   */
  private getPromptKey(serverName: string, promptName: string): string {
    return `${serverName}__${promptName}`;
  }

  /**
   * Check if a prompt is enabled
   */
  isPromptEnabled(serverName: string, promptName: string): boolean {
    const key = this.getPromptKey(serverName, promptName);
    // Default to enabled if not in state (for new prompts)
    return this.promptStates[key] !== false;
  }

  /**
   * Set the enabled state of a specific prompt
   */
  setPromptEnabled(serverName: string, promptName: string, enabled: boolean, saveImmediately: boolean = true): void {
    const key = this.getPromptKey(serverName, promptName);
    this.promptStates[key] = enabled;
    if (saveImmediately) {
      this.saveState();
    }
  }

  /**
   * Toggle a specific prompt
   */
  togglePrompt(serverName: string, promptName: string, saveImmediately: boolean = true): boolean {
    const newState = !this.isPromptEnabled(serverName, promptName);
    this.setPromptEnabled(serverName, promptName, newState, saveImmediately);
    return newState;
  }

  /**
   * Update state for new prompts (not in saved state) - set them to enabled by default
   */
  updateStateForNewPrompts(prompts: PromptWithServer[]): void {
    let hasNewPrompts = false;
    for (const { server, prompt } of prompts) {
      const key = this.getPromptKey(server, prompt.name);
      if (!(key in this.promptStates)) {
        this.promptStates[key] = true; // Default to enabled for new prompts
        hasNewPrompts = true;
      }
    }
    if (hasNewPrompts) {
      this.saveState();
    }
  }

  /**
   * Filter prompts based on enabled state
   */
  filterPrompts(prompts: PromptWithServer[]): PromptWithServer[] {
    return prompts.filter(({ server, prompt }) =>
      this.isPromptEnabled(server, prompt.name),
    );
  }

  /**
   * Get all prompt states
   */
  getPromptStates(): Record<string, boolean> {
    return { ...this.promptStates };
  }

  /**
   * Restore prompt states from a saved state (for canceling changes)
   */
  restoreState(states: Record<string, boolean>): void {
    this.promptStates = { ...states };
    // Don't save - this is for reverting changes
  }
}

