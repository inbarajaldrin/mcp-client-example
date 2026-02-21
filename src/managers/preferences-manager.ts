import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';
import { Logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(__dirname, '../..', '.mcp-client-data');
const SETTINGS_FILE = join(CONFIG_DIR, 'settings.yaml');

export interface ClientPreferences {
  mcpTimeout?: number; // MCP tool call timeout in seconds
  maxIterations?: number; // Maximum iterations between agent calls
  hilEnabled?: boolean; // Human-in-the-loop confirmations (persistent per-tool prompts)
  approveAll?: boolean; // Approve all tools without prompting (persistent)
  thinkingEnabled?: boolean; // Enable thinking/reasoning mode for supported models
  thinkingLevel?: string; // Provider-specific thinking level (e.g. 'low'|'medium'|'high' for OpenAI)
}

export class PreferencesManager {
  private preferences: ClientPreferences = {};
  private logger: Logger;
  private settingsFile: string;

  constructor(logger?: Logger, settingsFile?: string) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.settingsFile = settingsFile || SETTINGS_FILE;
    this.loadPreferences();
  }

  private loadPreferences(): void {
    if (existsSync(this.settingsFile)) {
      try {
        const content = readFileSync(this.settingsFile, 'utf-8');
        const config = yaml.parse(content) || {};
        this.preferences = {
          mcpTimeout: config.mcpTimeout ?? 60,
          maxIterations: config.maxIterations ?? 100,
          hilEnabled: config.hilEnabled ?? false,
          approveAll: config.approveAll ?? false,
          thinkingEnabled: config.thinkingEnabled ?? false,
          thinkingLevel: config.thinkingLevel,
        };
        return;
      } catch (error) {
        this.logger.log(
          `Failed to load settings.yaml: ${error}. Trying legacy fallback.\n`,
          { type: 'warning' },
        );
      }
    }

    this.preferences = {
      mcpTimeout: 60,
      maxIterations: 100,
      hilEnabled: false,
      approveAll: false,
      thinkingEnabled: false,
      thinkingLevel: undefined,
    };
  }

  private savePreferences(): void {
    try {
      const dir = dirname(this.settingsFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.settingsFile, yaml.stringify(this.preferences), 'utf-8');
    } catch (error) {
      this.logger.log(
        `Failed to save settings: ${error}\n`,
        { type: 'error' },
      );
      throw error;
    }
  }

  getMCPTimeout(): number {
    return this.preferences.mcpTimeout ?? 60;
  }

  setMCPTimeout(timeout: number | string): void {
    let timeoutValue: number;

    if (typeof timeout === 'string') {
      const lower = timeout.toLowerCase().trim();
      if (lower === 'infinity' || lower === 'unlimited' || lower === 'inf' || lower === '-1' || lower === '0') {
        timeoutValue = -1;
      } else {
        timeoutValue = parseInt(timeout, 10);
        if (isNaN(timeoutValue)) {
          throw new Error('Invalid timeout value. Use a number (1-3600) or "infinity"/"unlimited"');
        }
      }
    } else {
      timeoutValue = timeout;
    }

    if (timeoutValue === -1 || timeoutValue === 0) {
      this.preferences.mcpTimeout = -1;
    } else if (timeoutValue < 1 || timeoutValue > 3600) {
      throw new Error('MCP tool timeout must be between 1 and 3600 seconds, or use "infinity"/"unlimited"');
    } else {
      this.preferences.mcpTimeout = timeoutValue;
    }
    this.savePreferences();
  }

  getMaxIterations(): number {
    return this.preferences.maxIterations ?? 100;
  }

  setMaxIterations(maxIterations: number | string): void {
    let maxIterationsValue: number;

    if (typeof maxIterations === 'string') {
      const lower = maxIterations.toLowerCase().trim();
      if (lower === 'infinity' || lower === 'unlimited' || lower === 'inf' || lower === '-1' || lower === '0') {
        maxIterationsValue = -1;
      } else {
        maxIterationsValue = parseInt(maxIterations, 10);
        if (isNaN(maxIterationsValue)) {
          throw new Error('Invalid max iterations value. Use a number (1-10000) or "infinity"/"unlimited"');
        }
      }
    } else {
      maxIterationsValue = maxIterations;
    }

    if (maxIterationsValue === -1 || maxIterationsValue === 0) {
      this.preferences.maxIterations = -1;
    } else if (maxIterationsValue < 1 || maxIterationsValue > 10000) {
      throw new Error('Max iterations must be between 1 and 10000, or use "infinity"/"unlimited"');
    } else {
      this.preferences.maxIterations = maxIterationsValue;
    }
    this.savePreferences();
  }

  getPreferences(): ClientPreferences {
    return { ...this.preferences };
  }

  getHILEnabled(): boolean {
    return this.preferences.hilEnabled ?? true;
  }

  setHILEnabled(enabled: boolean): void {
    this.preferences.hilEnabled = enabled;
    this.savePreferences();
  }

  getApproveAll(): boolean {
    return this.preferences.approveAll ?? false;
  }

  setApproveAll(value: boolean): void {
    this.preferences.approveAll = value;
    this.savePreferences();
  }

  getThinkingEnabled(): boolean {
    return this.preferences.thinkingEnabled ?? false;
  }

  setThinkingEnabled(enabled: boolean): void {
    this.preferences.thinkingEnabled = enabled;
    if (!enabled) {
      this.preferences.thinkingLevel = undefined;
    }
    this.savePreferences();
  }

  getThinkingLevel(): string | undefined {
    return this.preferences.thinkingLevel;
  }

  setThinkingLevel(level: string | undefined): void {
    this.preferences.thinkingLevel = level;
    this.savePreferences();
  }
}
