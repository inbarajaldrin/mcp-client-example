// Reference: Follows patterns from src/managers/preferences-manager.ts and src/managers/ablation-manager.ts

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import * as yaml from 'yaml';
import { Logger } from '../logger.js';
import type { PostToolHook } from './ablation-manager.js';
import { parseDirectToolCall, matchesWhenCondition } from '../utils/hook-utils.js';
import type { ToolExecutionResult } from '../core/tool-executor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(__dirname, '../..', '.mcp-client-data');
const HOOKS_FILE = join(CONFIG_DIR, 'hooks.yaml');

/**
 * Client-side hook that extends PostToolHook with management metadata.
 */
export interface ClientHook extends PostToolHook {
  id: string;
  enabled: boolean;
  description?: string;
}

interface HooksConfig {
  hooks: ClientHook[];
}

/**
 * Manages client-side hooks that fire during regular chat sessions.
 * Hooks trigger automatic tool calls in response to other tool completions.
 *
 * Also supports temporary ablation hooks loaded during agent-driven ablation phases.
 * Ablation hooks fire even when client hooks are suspended.
 */
export class HookManager {
  private logger: Logger;
  private hooks: ClientHook[] = [];
  private executing: boolean = false;
  private suspended: boolean = false;

  // Ablation hook support: temporary hooks loaded from ablation YAML during agent-driven phases
  private ablationHooks: ClientHook[] = [];
  private currentPhaseName: string = '';
  private phaseCompleteRequested: boolean = false;
  private abortRunRequested: boolean = false;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.loadHooks();
  }

  // ==================== Config CRUD ====================

  loadHooks(): void {
    if (!existsSync(HOOKS_FILE)) {
      this.hooks = [];
      return;
    }

    try {
      const content = readFileSync(HOOKS_FILE, 'utf-8');
      const config: HooksConfig = yaml.parse(content);
      this.hooks = (config.hooks || []).map(h => ({
        ...h,
        id: h.id || randomUUID().slice(0, 8),
        enabled: h.enabled !== false,
      }));
    } catch (error) {
      this.logger.log(
        `Failed to load hooks: ${error}. Starting with empty hooks.\n`,
        { type: 'warning' },
      );
      this.hooks = [];
    }
  }

  saveHooks(): void {
    try {
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }
      const config: HooksConfig = { hooks: this.hooks };
      writeFileSync(HOOKS_FILE, yaml.stringify(config), 'utf-8');
    } catch (error) {
      this.logger.log(
        `Failed to save hooks: ${error}\n`,
        { type: 'error' },
      );
    }
  }

  listHooks(): ClientHook[] {
    return [...this.hooks];
  }

  addHook(hook: Omit<ClientHook, 'id'>): ClientHook {
    const newHook: ClientHook = {
      ...hook,
      id: randomUUID().slice(0, 8),
      enabled: hook.enabled !== false,
    };
    this.hooks.push(newHook);
    this.saveHooks();
    return newHook;
  }

  removeHook(id: string): boolean {
    const index = this.hooks.findIndex(h => h.id === id || h.id.startsWith(id));
    if (index === -1) return false;
    this.hooks.splice(index, 1);
    this.saveHooks();
    return true;
  }

  enableHook(id: string): boolean {
    const hook = this.hooks.find(h => h.id === id || h.id.startsWith(id));
    if (!hook) return false;
    hook.enabled = true;
    this.saveHooks();
    return true;
  }

  disableHook(id: string): boolean {
    const hook = this.hooks.find(h => h.id === id || h.id.startsWith(id));
    if (!hook) return false;
    hook.enabled = false;
    this.saveHooks();
    return true;
  }

  getHook(id: string): ClientHook | undefined {
    return this.hooks.find(h => h.id === id || h.id.startsWith(id));
  }

  // ==================== Ablation Suspension ====================

  /** Suspend client hooks during ablation runs to prevent double-triggering */
  suspend(): void { this.suspended = true; }

  /** Resume client hooks after ablation completes */
  resume(): void { this.suspended = false; }

  // ==================== Ablation Hook Loading ====================

  /**
   * Load ablation hooks temporarily for agent-driven phases.
   * These hooks fire even when client hooks are suspended.
   */
  loadAblationHooks(hooks: PostToolHook[]): void {
    this.ablationHooks = hooks.map((h, i) => ({
      ...h,
      id: `_ablation_${i}`,
      enabled: true,
    }));
  }

  /** Remove temporary ablation hooks */
  clearAblationHooks(): void {
    this.ablationHooks = [];
  }

  /** Set the current phase name for @complete-phase:name matching */
  setCurrentPhaseName(name: string): void { this.currentPhaseName = name; }

  /** Get the current phase name */
  getCurrentPhaseName(): string { return this.currentPhaseName; }

  // ==================== Phase Complete Signaling ====================

  /** Signal that the current phase should complete */
  requestPhaseComplete(): void { this.phaseCompleteRequested = true; }

  /** Check if phase completion has been requested */
  isPhaseCompleteRequested(): boolean { return this.phaseCompleteRequested; }

  /** Reset phase complete flag for the next phase */
  resetPhaseComplete(): void { this.phaseCompleteRequested = false; }

  // ==================== Abort Run Signaling ====================

  /** Signal that the current ablation run should abort */
  requestAbortRun(): void { this.abortRunRequested = true; }

  /** Check if abort run has been requested */
  isAbortRunRequested(): boolean { return this.abortRunRequested; }

  /** Reset abort run flag */
  resetAbortRun(): void { this.abortRunRequested = false; }

  // ==================== Runtime Hook Execution ====================

  /** Whether hook execution is currently in progress (recursion guard) */
  isExecuting(): boolean { return this.executing; }

  /**
   * Process a hook's run command. Handles special commands (@complete-phase, @abort)
   * and regular tool execution hooks.
   * Returns true if the hook was a special command (no tool execution needed).
   */
  private handleSpecialCommand(run: string): boolean {
    const trimmed = run.trim();

    // @complete-phase or @complete-phase:phase_name
    if (trimmed === '@complete-phase' || trimmed.startsWith('@complete-phase:')) {
      const phaseName = trimmed.includes(':') ? trimmed.slice('@complete-phase:'.length) : '';
      if (phaseName && phaseName !== this.currentPhaseName) {
        // Phase name doesn't match current phase — skip
        return true;
      }
      const label = phaseName || this.currentPhaseName || 'current';
      this.logger.log(`[Hook complete-phase: ending phase "${label}"]\n`, { type: 'info' });
      this.phaseCompleteRequested = true;
      return true;
    }

    // @abort — signal that the current ablation run should abort
    if (trimmed === '@abort') {
      this.logger.log(`[Hook abort: skipping remaining phases for current model]\n`, { type: 'warning' });
      this.abortRunRequested = true;
      return true;
    }

    return false;
  }

  /**
   * Execute matching after-hooks for a completed tool call.
   * When a hook uses @tool: (inject) and injectToolResult is provided, the hook
   * result is injected into the conversation so the agent sees it as context.
   *
   * Client hooks only fire when not suspended.
   * Ablation hooks always fire when loaded (even when suspended).
   */
  async executeAfterHooks(
    toolName: string,
    toolResult: ToolExecutionResult & { toolInput?: Record<string, unknown> },
    executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>,
    injectToolResult?: (
      name: string,
      args: Record<string, unknown>,
      result: { displayText: string; contentBlocks: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
    ) => void,
  ): Promise<void> {
    if (this.executing) return;

    // Determine which hooks to check
    const hooksToCheck: ClientHook[] = [];
    if (!this.suspended) {
      hooksToCheck.push(...this.hooks);
    }
    // Ablation hooks always fire when loaded (they're purpose-loaded for agent-driven phases)
    hooksToCheck.push(...this.ablationHooks);

    if (hooksToCheck.length === 0) return;

    this.executing = true;
    try {
      for (const hook of hooksToCheck) {
        if (!hook.enabled) continue;
        if (hook.after !== toolName) continue;

        if (hook.when && !matchesWhenCondition(hook.when, toolResult.displayText, toolResult.toolInput)) {
          continue;
        }

        // Handle special commands (@complete-phase, @abort)
        if (this.handleSpecialCommand(hook.run)) {
          continue;
        }

        const parsed = parseDirectToolCall(hook.run);
        if (!parsed) {
          this.logger.log(`[Hook invalid command: ${hook.run}]\n`, { type: 'warning' });
          continue;
        }

        this.logger.log(`[Hook triggered: ${parsed.toolName}]\n`, { type: 'info' });

        try {
          const hookToolResult = await executeTool(parsed.toolName, parsed.args);
          if (
            parsed.injectResult &&
            injectToolResult &&
            hookToolResult.contentBlocks &&
            hookToolResult.contentBlocks.length > 0
          ) {
            injectToolResult(parsed.toolName, parsed.args, hookToolResult);
            this.logger.log(`[Hook result injected into context]\n`, { type: 'info' });
          }
          this.logger.log(`[Hook completed: ${parsed.toolName}]\n`, { type: 'info' });
        } catch (error: any) {
          this.logger.log(`[Hook failed: ${error.message}]\n`, { type: 'warning' });
        }
      }
    } finally {
      this.executing = false;
    }
  }

  /**
   * Execute matching before-hooks for a tool about to run.
   * Hook results are NOT injected into LLM conversation.
   */
  async executeBeforeHooks(
    toolName: string,
    executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>,
  ): Promise<void> {
    if (this.executing) return;

    // Determine which hooks to check
    const hooksToCheck: ClientHook[] = [];
    if (!this.suspended) {
      hooksToCheck.push(...this.hooks);
    }
    hooksToCheck.push(...this.ablationHooks);

    if (hooksToCheck.length === 0) return;

    this.executing = true;
    try {
      for (const hook of hooksToCheck) {
        if (!hook.enabled) continue;
        if (hook.before !== toolName) continue;

        // Handle special commands
        if (this.handleSpecialCommand(hook.run)) {
          continue;
        }

        const parsed = parseDirectToolCall(hook.run);
        if (!parsed) {
          this.logger.log(`[Hook invalid command: ${hook.run}]\n`, { type: 'warning' });
          continue;
        }

        this.logger.log(`[Hook before-trigger: ${parsed.toolName}]\n`, { type: 'info' });

        try {
          await executeTool(parsed.toolName, parsed.args);
          this.logger.log(`[Hook before-completed: ${parsed.toolName}]\n`, { type: 'info' });
        } catch (error: any) {
          this.logger.log(`[Hook before-failed: ${error.message}]\n`, { type: 'warning' });
        }
      }
    } finally {
      this.executing = false;
    }
  }
}
