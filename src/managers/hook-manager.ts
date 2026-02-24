// Reference: Follows patterns from src/managers/preferences-manager.ts and src/managers/ablation-manager.ts

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import * as yaml from 'yaml';
import { Logger } from '../logger.js';
import type { PostToolHook, ConditionalGate } from './ablation-manager.js';
import { parseDirectToolCall, matchesWhenInputCondition, matchesWhenOutputCondition } from '../utils/hook-utils.js';
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
/** Minimal interface for hook logging — avoids circular import of ChatHistoryManager */
interface HookChatLogger {
  addHookToolExecution(
    toolName: string,
    toolInput: Record<string, any>,
    toolOutput: string,
    hookTrigger: {
      type: 'before' | 'after' | 'on-start';
      triggerTool?: string;
      action: 'tool-exec' | 'tool-inject';
      whenOutput?: Record<string, unknown>;
      whenInput?: Record<string, unknown>;
    },
  ): void;
  addPhaseEvent(
    type: 'phase-start' | 'phase-complete' | 'phase-abort',
    phaseName: string,
    trigger?: { after?: string; whenOutput?: Record<string, unknown> },
  ): void;
}

export class HookManager {
  private logger: Logger;
  private hooks: ClientHook[] = [];
  private executing: boolean = false;
  private suspended: boolean = false;
  private chatLogger?: HookChatLogger;

  // Ablation hook support: temporary hooks loaded from ablation YAML during agent-driven phases
  private ablationHooks: ClientHook[] = [];
  private currentPhaseName: string = '';
  private phaseCompleteRequested: boolean = false;
  private abortRunRequested: boolean = false;
  private pendingToolInjection: boolean = false;

  // Pending @ directive commands from hooks — consumed by ablation-cli after processQuery returns
  private pendingPromptInsertion: string | null = null;
  private pendingAttachmentInsertions: string[] = [];
  private pendingClearAttachments: boolean = false;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.loadHooks();
  }

  /** Set the chat history logger for recording hook executions */
  setChatLogger(chatLogger: HookChatLogger): void {
    this.chatLogger = chatLogger;
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

  /** Remove temporary ablation hooks and reset all pending directive state */
  clearAblationHooks(): void {
    this.ablationHooks = [];
    this.pendingPromptInsertion = null;
    this.pendingAttachmentInsertions = [];
    this.pendingClearAttachments = false;
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
  resetPhaseComplete(): void { this.phaseCompleteRequested = false; this.pendingToolInjection = false; }

  // ==================== Abort Run Signaling ====================

  /** Signal that the current ablation run should abort */
  requestAbortRun(): void { this.abortRunRequested = true; }

  /** Check if abort run has been requested */
  isAbortRunRequested(): boolean { return this.abortRunRequested; }

  /** Reset abort run flag */
  resetAbortRun(): void { this.abortRunRequested = false; }

  // ==================== Pending Tool Injection Signaling ====================

  /** Check if a @tool: hook matched and is pending injection */
  hasPendingInjection(): boolean { return this.pendingToolInjection; }

  /** Reset pending injection flag after deferred hooks have fired */
  resetPendingInjection(): void { this.pendingToolInjection = false; }

  // ==================== Pending Directive Signaling ====================

  /** Get pending @insert-prompt: command (full command string) */
  getPendingPromptInsertion(): string | null { return this.pendingPromptInsertion; }

  /** Reset pending prompt insertion after it's been consumed */
  resetPendingPromptInsertion(): void { this.pendingPromptInsertion = null; }

  /** Get pending @insert-attachment: references */
  getPendingAttachmentInsertions(): string[] { return [...this.pendingAttachmentInsertions]; }

  /** Reset pending attachment insertions after they've been consumed */
  resetPendingAttachmentInsertions(): void { this.pendingAttachmentInsertions = []; }

  /** Check if @clear-attachments was requested */
  isPendingClearAttachments(): boolean { return this.pendingClearAttachments; }

  /** Reset pending clear attachments flag */
  resetPendingClearAttachments(): void { this.pendingClearAttachments = false; }

  /** Check if any pending directives need to be consumed */
  hasPendingDirectives(): boolean {
    return this.pendingPromptInsertion !== null
      || this.pendingAttachmentInsertions.length > 0
      || this.pendingClearAttachments;
  }

  // ==================== Runtime Hook Execution ====================

  /** Whether hook execution is currently in progress (recursion guard) */
  isExecuting(): boolean { return this.executing; }

  /**
   * Process a hook's run command. Handles special commands (@complete-phase, @abort)
   * and regular tool execution hooks.
   * Returns true if the hook was a special command (no tool execution needed).
   */
  private handleSpecialCommand(
    run: string,
    triggerTool?: string,
    whenOutput?: Record<string, unknown>,
    whenInput?: Record<string, unknown>,
  ): boolean {
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
      this.chatLogger?.addPhaseEvent('phase-complete', label, {
        after: triggerTool,
        whenOutput,
      });
      return true;
    }

    // @abort — signal that the current ablation run should abort
    if (trimmed === '@abort') {
      this.logger.log(`[Hook abort: skipping remaining phases for current model]\n`, { type: 'warning' });
      this.abortRunRequested = true;
      this.chatLogger?.addPhaseEvent('phase-abort', this.currentPhaseName || 'unknown', {
        after: triggerTool,
        whenOutput,
      });
      return true;
    }

    // @insert-prompt:<server__promptName> — store for ablation-cli to execute after processQuery returns
    if (trimmed.startsWith('@insert-prompt:')) {
      this.logger.log(`[Hook insert-prompt: ${trimmed.slice('@insert-prompt:'.length).split(/[\s(]/)[0]}]\n`, { type: 'info' });
      this.pendingPromptInsertion = trimmed;
      return true;
    }

    // @insert-attachment:<filename|index> — store for ablation-cli to queue
    if (trimmed.startsWith('@insert-attachment:')) {
      const ref = trimmed.slice('@insert-attachment:'.length).trim();
      this.logger.log(`[Hook insert-attachment: ${ref}]\n`, { type: 'info' });
      this.pendingAttachmentInsertions.push(trimmed);
      return true;
    }

    // @clear-attachments — store flag for ablation-cli to clear pending queue
    if (trimmed === '@clear-attachments') {
      this.logger.log(`[Hook clear-attachments]\n`, { type: 'info' });
      this.pendingClearAttachments = true;
      return true;
    }

    return false;
  }

  /**
   * Pre-evaluate whenInput after-hooks for @complete-phase/@abort BEFORE tool execution.
   * Since whenInput conditions only depend on tool input args (known before the call),
   * we can fire special commands early. This allows auto-declining elicitations
   * that arrive during the tool call when the phase is already complete.
   *
   * KEY DISTINCTION — elicitation behavior:
   *   whenInput hooks CAN auto-decline elicitations: input args are known before the
   *     tool executes, so @complete-phase/@abort fires early and sets the auto-decline
   *     flag, causing any elicitation from the MCP server to be declined without human input.
   *   whenOutput hooks CANNOT auto-decline elicitations: the tool output isn't available
   *     until the tool finishes, and if the tool sends an elicitation, the human must
   *     attend to it before the tool returns. whenOutput hooks only evaluate afterward.
   *
   * Returns true if a special command (@complete-phase or @abort) was triggered.
   */
  preEvaluateWhenInput(toolName: string, toolInput: Record<string, unknown>): boolean {
    const hooksToCheck: ClientHook[] = [];
    if (!this.suspended) {
      hooksToCheck.push(...this.hooks);
    }
    hooksToCheck.push(...this.ablationHooks);

    let triggered = false;
    for (const hook of hooksToCheck) {
      if (!hook.enabled) continue;
      if (hook.after !== toolName) continue;
      // Gate hooks are always deferred
      if (hook.gate) continue;
      // Only evaluate hooks that have a whenInput condition (no whenOutput — we don't have output yet)
      if (!hook.whenInput) continue;
      if (!matchesWhenInputCondition(hook.whenInput, toolInput)) continue;
      // Only fire special commands early; regular tool-exec hooks still wait for completion
      if (hook.run && this.handleSpecialCommand(hook.run, toolName, undefined, hook.whenInput as Record<string, unknown>)) {
        triggered = true;
      }
    }
    return triggered;
  }

  /**
   * Execute immediate after-hooks for a completed tool call.
   * Fires ONLY:
   *   - Special commands (@complete-phase, @abort) — always immediate for cancellation
   *   - Unconditional @tool-exec: hooks (no whenInput/whenOutput)
   *
   * Conditional hooks (whenInput/whenOutput) and all @tool: hooks are deferred
   * to executeDeferredAfterHooks(), which runs after the agent's full response.
   *
   * Called from tool-executor.ts right after each MCP tool completes.
   */
  async executeImmediateAfterHooks(
    toolName: string,
    toolResult: ToolExecutionResult & { toolInput?: Record<string, unknown> },
    executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>,
  ): Promise<void> {
    if (this.executing) return;

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
        if (hook.after !== toolName) continue;

        // Gate hooks are always deferred — they need tool execution + condition checking
        if (hook.gate) continue;

        if (hook.whenInput && !matchesWhenInputCondition(hook.whenInput, toolResult.toolInput)) {
          continue;
        }
        if (hook.whenOutput && !matchesWhenOutputCondition(hook.whenOutput, toolResult.displayText)) {
          continue;
        }

        // Special commands (@complete-phase, @abort) always fire immediately for cancellation
        if (hook.run && this.handleSpecialCommand(hook.run, toolName, hook.whenOutput as Record<string, unknown>, hook.whenInput as Record<string, unknown>)) {
          continue;
        }

        const parsed = hook.run ? parseDirectToolCall(hook.run) : null;
        if (!parsed) {
          this.logger.log(`[Hook invalid command: ${hook.run}]\n`, { type: 'warning' });
          continue;
        }

        // Defer @tool: hooks (injecting) — signal provider to stop so injection
        // can happen before the model continues its response.
        if (parsed.injectResult) {
          this.pendingToolInjection = true;
          continue;
        }

        // Defer conditional @tool-exec: hooks — fire after agent response for consistency
        if (hook.whenInput || hook.whenOutput) continue;

        this.logger.log(`[Hook triggered: ${parsed.toolName}]\n`, { type: 'info' });

        try {
          const hookResult = await executeTool(parsed.toolName, parsed.args);
          this.logger.log(`[Hook completed: ${parsed.toolName}]\n`, { type: 'info' });
          this.chatLogger?.addHookToolExecution(parsed.toolName, parsed.args, hookResult.displayText, {
            type: 'after',
            triggerTool: toolName,
            action: 'tool-exec',
          });
        } catch (error: any) {
          this.logger.log(`[Hook failed: ${error.message}]\n`, { type: 'warning' });
        }
      }
    } finally {
      this.executing = false;
    }
  }

  /**
   * Execute deferred after-hooks for all tool calls made during the agent's response.
   * Fires:
   *   - All @tool: hooks (injecting — always deferred since providers copy messages)
   *   - Conditional @tool-exec: hooks (whenInput/whenOutput)
   *
   * Special commands and unconditional @tool-exec: hooks already fired inline
   * via executeImmediateAfterHooks.
   *
   * Called from processQuery after the agent's full response stream ends.
   * Returns true if any @tool: hooks injected messages into conversation context.
   */
  async executeDeferredAfterHooks(
    toolCompletions: Array<{ toolName: string; result: string; toolInput?: Record<string, unknown> }>,
    executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>,
    injectToolResult?: (
      name: string,
      args: Record<string, unknown>,
      result: { displayText: string; contentBlocks: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
    ) => void,
  ): Promise<boolean> {
    if (this.executing) return false;
    if (toolCompletions.length === 0) return false;

    const hooksToCheck: ClientHook[] = [];
    if (!this.suspended) {
      hooksToCheck.push(...this.hooks);
    }
    hooksToCheck.push(...this.ablationHooks);

    if (hooksToCheck.length === 0) return false;

    let hasInjections = false;
    this.executing = true;
    try {
      for (const completion of toolCompletions) {
        for (const hook of hooksToCheck) {
          if (!hook.enabled) continue;
          if (hook.after !== completion.toolName) continue;

          if (hook.whenInput && !matchesWhenInputCondition(hook.whenInput, completion.toolInput)) {
            continue;
          }
          if (hook.whenOutput && !matchesWhenOutputCondition(hook.whenOutput, completion.result)) {
            continue;
          }

          // ---- Gate hooks: evaluate gate tool, branch on result ----
          if (hook.gate) {
            await this.executeGate(hook.gate, completion.toolName, executeTool);
            continue;
          }

          // Skip hooks without run command (shouldn't happen after gate check, but be safe)
          if (!hook.run) continue;

          // Special commands were already handled inline — skip
          const trimmed = hook.run.trim();
          if (trimmed === '@complete-phase' || trimmed.startsWith('@complete-phase:') || trimmed === '@abort') {
            continue;
          }

          const parsed = parseDirectToolCall(hook.run);
          if (!parsed) {
            this.logger.log(`[Hook invalid command: ${hook.run}]\n`, { type: 'warning' });
            continue;
          }

          // Skip unconditional @tool-exec: hooks — already fired inline
          if (!parsed.injectResult && !hook.whenInput && !hook.whenOutput) continue;

          this.logger.log(`[Hook triggered (deferred): ${parsed.toolName}]\n`, { type: 'info' });

          try {
            const hookToolResult = await executeTool(parsed.toolName, parsed.args);
            const isInjection = parsed.injectResult &&
              injectToolResult &&
              hookToolResult.contentBlocks &&
              hookToolResult.contentBlocks.length > 0;
            if (isInjection) {
              injectToolResult(parsed.toolName, parsed.args, hookToolResult);
              hasInjections = true;
              this.logger.log(`[Hook result injected into context]\n`, { type: 'info' });
            }
            this.logger.log(`[Hook completed: ${parsed.toolName}]\n`, { type: 'info' });
            this.chatLogger?.addHookToolExecution(parsed.toolName, parsed.args, hookToolResult.displayText, {
              type: 'after',
              triggerTool: completion.toolName,
              action: isInjection ? 'tool-inject' : 'tool-exec',
              ...(hook.whenOutput && { whenOutput: hook.whenOutput as Record<string, unknown> }),
              ...(hook.whenInput && { whenInput: hook.whenInput as Record<string, unknown> }),
            });
          } catch (error: any) {
            this.logger.log(`[Hook failed: ${error.message}]\n`, { type: 'warning' });
          }
        }
      }
    } finally {
      this.executing = false;
    }
    return hasInjections;
  }

  /**
   * Execute a conditional gate: run the gate tool, check its output, then
   * execute the appropriate command list (onPass or onFail).
   */
  private async executeGate(
    gate: ConditionalGate,
    triggerTool: string,
    executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>,
  ): Promise<void> {
    // 1. Parse & execute the gate tool
    const gateParsed = parseDirectToolCall(gate.run);
    if (!gateParsed) {
      this.logger.log(`[Gate invalid command: ${gate.run}]\n`, { type: 'warning' });
      return;
    }

    this.logger.log(`[Gate evaluating: ${gateParsed.toolName}]\n`, { type: 'info' });

    let gateResult: ToolExecutionResult;
    try {
      gateResult = await executeTool(gateParsed.toolName, gateParsed.args);
    } catch (error: any) {
      this.logger.log(`[Gate tool failed: ${error.message} — running onFail commands]\n`, { type: 'warning' });
      await this.executeGateCommands(gate.onFail, triggerTool, executeTool);
      return;
    }

    // 2. Check gate result against whenOutput condition
    const gateMatches = matchesWhenOutputCondition(gate.whenOutput, gateResult.displayText);
    const branch = gateMatches ? 'PASS' : 'FAIL';
    const commands = gateMatches ? gate.onPass : gate.onFail;

    this.logger.log(`[Gate ${branch}: ${gateParsed.toolName} — executing ${commands.length} command(s)]\n`, { type: 'info' });

    this.chatLogger?.addHookToolExecution(gateParsed.toolName, gateParsed.args, gateResult.displayText, {
      type: 'after',
      triggerTool,
      action: 'tool-exec',
      whenOutput: gate.whenOutput,
    });

    // 3. Execute the chosen command list
    await this.executeGateCommands(commands, triggerTool, executeTool);
  }

  /**
   * Execute a list of commands from a gate's onPass or onFail array.
   * Supports: @tool-exec, special commands (@insert-prompt, @complete-phase, etc.),
   * and plain text (treated as @insert-prompt with inline text).
   */
  private async executeGateCommands(
    commands: string[],
    triggerTool: string,
    executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>,
  ): Promise<void> {
    for (const cmd of commands) {
      const trimmed = cmd.trim();

      // Special commands (@insert-prompt, @complete-phase, @abort, etc.)
      if (this.handleSpecialCommand(trimmed, triggerTool)) {
        continue;
      }

      // @tool-exec or @tool commands
      const parsed = parseDirectToolCall(trimmed);
      if (parsed) {
        this.logger.log(`[Gate command: ${parsed.toolName}]\n`, { type: 'info' });
        try {
          const result = await executeTool(parsed.toolName, parsed.args);
          this.logger.log(`[Gate command completed: ${parsed.toolName}]\n`, { type: 'info' });
          this.chatLogger?.addHookToolExecution(parsed.toolName, parsed.args, result.displayText, {
            type: 'after',
            triggerTool,
            action: 'tool-exec',
          });
        } catch (error: any) {
          this.logger.log(`[Gate command failed: ${error.message}]\n`, { type: 'warning' });
        }
        continue;
      }

      // Plain text (no @ prefix) — treat as inline @insert-prompt
      if (!trimmed.startsWith('@')) {
        this.logger.log(`[Gate insert-prompt (inline): ${trimmed.slice(0, 60)}...]\n`, { type: 'info' });
        this.pendingPromptInsertion = `@insert-prompt:${trimmed}`;
        continue;
      }

      this.logger.log(`[Gate unknown command: ${trimmed}]\n`, { type: 'warning' });
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
        if (!hook.run) continue;

        // Handle special commands
        if (this.handleSpecialCommand(hook.run, toolName)) {
          continue;
        }

        const parsed = parseDirectToolCall(hook.run);
        if (!parsed) {
          this.logger.log(`[Hook invalid command: ${hook.run}]\n`, { type: 'warning' });
          continue;
        }

        this.logger.log(`[Hook before-trigger: ${parsed.toolName}]\n`, { type: 'info' });

        try {
          const hookResult = await executeTool(parsed.toolName, parsed.args);
          this.logger.log(`[Hook before-completed: ${parsed.toolName}]\n`, { type: 'info' });
          this.chatLogger?.addHookToolExecution(parsed.toolName, parsed.args, hookResult.displayText, {
            type: 'before',
            triggerTool: toolName,
            action: 'tool-exec',
          });
        } catch (error: any) {
          this.logger.log(`[Hook before-failed: ${error.message}]\n`, { type: 'warning' });
        }
      }
    } finally {
      this.executing = false;
    }
  }
}
