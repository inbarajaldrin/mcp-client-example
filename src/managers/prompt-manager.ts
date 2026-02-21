import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';
import { Logger } from '../logger.js';
import type { Prompt } from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(__dirname, '../..', '.mcp-client-data');
const PROMPT_STATES_FILE = join(CONFIG_DIR, 'prompt-states.yaml');
const LEGACY_JSON = join(CONFIG_DIR, 'preferences.json');

type PromptWithServer = {
  server: string;
  prompt: Prompt;
};

export class PromptManager {
  private promptStates: Record<string, boolean> = {};
  private logger: Logger;
  private statesFile: string;

  constructor(logger?: Logger, statesFile?: string) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.statesFile = statesFile || PROMPT_STATES_FILE;
    this.loadState();
  }

  loadState(): void {
    if (existsSync(this.statesFile)) {
      try {
        const content = readFileSync(this.statesFile, 'utf-8');
        const states = yaml.parse(content);
        this.promptStates = states && typeof states === 'object' ? { ...states } : {};
        return;
      } catch (error) {
        this.logger.log(
          `Failed to load prompt-states.yaml: ${error}. Trying legacy fallback.\n`,
          { type: 'warning' },
        );
      }
    }

    // Migration: read from legacy preferences.json
    if (existsSync(LEGACY_JSON)) {
      try {
        const content = readFileSync(LEGACY_JSON, 'utf-8');
        const config = JSON.parse(content);
        if (config.promptStates && typeof config.promptStates === 'object') {
          this.promptStates = { ...config.promptStates };
          this.saveState();
          return;
        }
      } catch {
        // Fall through to empty
      }
    }

    this.promptStates = {};
  }

  saveState(): void {
    try {
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }
      writeFileSync(this.statesFile, yaml.stringify(this.promptStates), 'utf-8');
    } catch (error) {
      this.logger.log(
        `Failed to save prompt states: ${error}\n`,
        { type: 'error' },
      );
    }
  }

  private getPromptKey(serverName: string, promptName: string): string {
    return `${serverName}__${promptName}`;
  }

  isPromptEnabled(serverName: string, promptName: string): boolean {
    const key = this.getPromptKey(serverName, promptName);
    return this.promptStates[key] !== false;
  }

  setPromptEnabled(serverName: string, promptName: string, enabled: boolean, saveImmediately: boolean = true): void {
    const key = this.getPromptKey(serverName, promptName);
    this.promptStates[key] = enabled;
    if (saveImmediately) {
      this.saveState();
    }
  }

  togglePrompt(serverName: string, promptName: string, saveImmediately: boolean = true): boolean {
    const newState = !this.isPromptEnabled(serverName, promptName);
    this.setPromptEnabled(serverName, promptName, newState, saveImmediately);
    return newState;
  }

  updateStateForNewPrompts(prompts: PromptWithServer[]): void {
    let hasNewPrompts = false;
    for (const { server, prompt } of prompts) {
      const key = this.getPromptKey(server, prompt.name);
      if (!(key in this.promptStates)) {
        this.promptStates[key] = true;
        hasNewPrompts = true;
      }
    }
    if (hasNewPrompts) {
      this.saveState();
    }
  }

  filterPrompts(prompts: PromptWithServer[]): PromptWithServer[] {
    return prompts.filter(({ server, prompt }) =>
      this.isPromptEnabled(server, prompt.name),
    );
  }

  getPromptStates(): Record<string, boolean> {
    return { ...this.promptStates };
  }

  restoreState(states: Record<string, boolean>): void {
    this.promptStates = { ...states };
  }
}
