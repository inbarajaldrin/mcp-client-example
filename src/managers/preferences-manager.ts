import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(__dirname, '../..', '.mcp-client-data');
const CONFIG_FILE = join(CONFIG_DIR, 'preferences.json');

export interface ClientPreferences {
  toolStates?: Record<string, boolean>;
  promptStates?: Record<string, boolean>;
  mcpTimeout?: number; // MCP tool call timeout in seconds
  maxIterations?: number; // Maximum iterations between agent calls
  hilEnabled?: boolean; // Human-in-the-loop confirmations
}

interface ClientConfig {
  servers?: Record<string, { command: string; args: string[]; disabled?: boolean }>;
  defaultServer?: string;
  toolStates?: Record<string, boolean>;
  promptStates?: Record<string, boolean>;
  mcpTimeout?: number;
  maxIterations?: number;
  hilEnabled?: boolean;
}

export class PreferencesManager {
  private preferences: ClientPreferences = {};
  private logger: Logger;
  private configFile: string;

  constructor(logger?: Logger, configFile?: string) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.configFile = configFile || CONFIG_FILE;
    this.loadPreferences();
  }

  /**
   * Load preferences from config file
   */
  private loadPreferences(): void {
    if (!existsSync(this.configFile)) {
      // Set defaults
      this.preferences = {
        mcpTimeout: 60, // Default: 60 seconds
        maxIterations: 100, // Default: 100 iterations
        hilEnabled: true, // Default: enabled
      };
      return;
    }

    try {
      const content = readFileSync(this.configFile, 'utf-8');
      const config: ClientConfig = JSON.parse(content);

      this.preferences = {
        toolStates: config.toolStates,
        promptStates: config.promptStates,
        mcpTimeout: config.mcpTimeout ?? 60,
        maxIterations: config.maxIterations ?? 100,
        hilEnabled: config.hilEnabled ?? true,
      };
    } catch (error) {
      this.logger.log(
        `Failed to load preferences: ${error}. Using defaults.\n`,
        { type: 'warning' },
      );
      this.preferences = {
        mcpTimeout: 60,
        maxIterations: 100,
        hilEnabled: true,
      };
    }
  }

  /**
   * Save preferences to config file
   */
  private savePreferences(): void {
    try {
      // Ensure directory exists
      const dir = dirname(this.configFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Load existing config to preserve other fields
      let existingConfig: ClientConfig = {};
      if (existsSync(this.configFile)) {
        try {
          const content = readFileSync(this.configFile, 'utf-8');
          existingConfig = JSON.parse(content);
        } catch {
          // If we can't read existing, start fresh
        }
      }

      // Merge preferences with existing config
      const config: ClientConfig = {
        ...existingConfig,
        toolStates: this.preferences.toolStates || existingConfig.toolStates,
        promptStates: this.preferences.promptStates || existingConfig.promptStates,
        mcpTimeout: this.preferences.mcpTimeout,
        maxIterations: this.preferences.maxIterations,
        hilEnabled: this.preferences.hilEnabled,
      };

      writeFileSync(this.configFile, JSON.stringify(config, null, 2));
    } catch (error) {
      this.logger.log(
        `Failed to save preferences: ${error}\n`,
        { type: 'error' },
      );
      throw error;
    }
  }

  /**
   * Get MCP tool timeout in seconds
   * Returns -1 for unlimited/infinity
   */
  getMCPTimeout(): number {
    return this.preferences.mcpTimeout ?? 60;
  }

  /**
   * Set MCP tool timeout in seconds
   * Use -1, 0, "infinity", or "unlimited" for no timeout
   */
  setMCPTimeout(timeout: number | string): void {
    let timeoutValue: number;
    
    if (typeof timeout === 'string') {
      const lower = timeout.toLowerCase().trim();
      if (lower === 'infinity' || lower === 'unlimited' || lower === 'inf' || lower === '-1' || lower === '0') {
        timeoutValue = -1; // -1 represents unlimited
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
      // Unlimited timeout
      this.preferences.mcpTimeout = -1;
    } else if (timeoutValue < 1 || timeoutValue > 3600) {
      throw new Error('MCP tool timeout must be between 1 and 3600 seconds, or use "infinity"/"unlimited"');
    } else {
      this.preferences.mcpTimeout = timeoutValue;
    }
    this.savePreferences();
  }

  /**
   * Get max iterations
   * Returns -1 for unlimited/infinity
   */
  getMaxIterations(): number {
    return this.preferences.maxIterations ?? 100;
  }

  /**
   * Set max iterations
   * Use -1, 0, "infinity", or "unlimited" for no limit
   */
  setMaxIterations(maxIterations: number | string): void {
    let maxIterationsValue: number;
    
    if (typeof maxIterations === 'string') {
      const lower = maxIterations.toLowerCase().trim();
      if (lower === 'infinity' || lower === 'unlimited' || lower === 'inf' || lower === '-1' || lower === '0') {
        maxIterationsValue = -1; // -1 represents unlimited
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
      // Unlimited iterations
      this.preferences.maxIterations = -1;
    } else if (maxIterationsValue < 1 || maxIterationsValue > 10000) {
      throw new Error('Max iterations must be between 1 and 10000, or use "infinity"/"unlimited"');
    } else {
      this.preferences.maxIterations = maxIterationsValue;
    }
    this.savePreferences();
  }

  /**
   * Get all preferences
   */
  getPreferences(): ClientPreferences {
    return { ...this.preferences };
  }

  /**
   * Update tool states (called by ToolManager)
   */
  updateToolStates(toolStates: Record<string, boolean>): void {
    this.preferences.toolStates = toolStates;
    this.savePreferences();
  }

  /**
   * Update prompt states (called by PromptManager)
   */
  updatePromptStates(promptStates: Record<string, boolean>): void {
    this.preferences.promptStates = promptStates;
    this.savePreferences();
  }

  /**
   * Get tool states
   */
  getToolStates(): Record<string, boolean> {
    return this.preferences.toolStates || {};
  }

  /**
   * Get prompt states
   */
  getPromptStates(): Record<string, boolean> {
    return this.preferences.promptStates || {};
  }

  getHILEnabled(): boolean {
    return this.preferences.hilEnabled ?? true;
  }

  setHILEnabled(enabled: boolean): void {
    this.preferences.hilEnabled = enabled;
    this.savePreferences();
  }
}

