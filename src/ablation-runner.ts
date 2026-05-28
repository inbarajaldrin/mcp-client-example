// AblationRunner — the surface-agnostic ablation run engine.
//
// Slice 3 of the agent-automation work: the experiment loop (phase x model cascade with
// @escalate/@switch recovery) used to live as private methods on the readline-centric
// AblationCLI class, reachable only through a 26-field callback interface. The web server
// could not satisfy that interface, so it re-implemented the loop inline and DIVERGED
// (its copy silently skipped @escalate/@switch). This module is the single engine both the
// CLI and the web call, so the divergence becomes structurally impossible.
//
// Pass A: the loop is relocated here verbatim + mechanically rewritten
// (this.callbacks.<x> -> this.control.<x> / this.host.<x>; this.<collaborator> -> this.deps.<x>).
// Residual CLI-only behavior is routed through a normalized RunHost (CLI supplies real impls;
// the web supplies headless defaults). Pass B will retire RunHost toward the pure ~6-field seam.

import chalk from 'chalk';
import { cpSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { MCPClient } from './index.js';
import type { Logger } from './logger.js';
import {
  type AblationManager,
  type AblationDefinition,
  type AblationModel,
  type AblationPhase,
  type AblationRun,
  type AblationRunResult,
  type AblationCommandResult,
} from './managers/ablation-manager.js';
import type { PreferencesManager } from './managers/preferences-manager.js';
import type { AttachmentManager, AttachmentInfo } from './managers/attachment-manager.js';
import type { HookManager } from './managers/hook-manager.js';
import type { Message, ModelProvider } from './model-provider.js';
import { createProvider, PROVIDERS } from './bin.js';
import { parseDirectToolCall, parsePythonArgs, matchesWhenInputCondition, matchesWhenOutputCondition } from './utils/hook-utils.js';
import { sanitizeFolderName } from './utils/path-utils.js';
import { isReasoningModel, getDefaultThinkingLevel } from './utils/model-capabilities.js';

/** Format milliseconds as human-readable duration (e.g. "4m 5s"). Mirror of the CLI helper. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Run control — surface -> engine. The dominant slice of the old 26-field interface
 * (isAbortRequested alone was used 34x in the loop). Both surfaces implement these.
 */
export interface RunControl {
  isAbortRequested(): boolean;
  isInterruptRequested(): boolean;
  resetAbort(): void;
  resetInterrupt(): void;
  setAbortMode(enabled: boolean): void;
}

/** Structured run events — engine -> surface. Rendered by the CLI, streamed by the web (SSE). */
export type RunEvent =
  | { type: 'run-start'; ablation: string; totalRuns: number; totalScenarios: number }
  | { type: 'phase-start'; phase: string; model: string; runIndex: number; totalRuns: number }
  | { type: 'command'; command: string; phase?: string }
  | { type: 'result'; result: AblationRunResult; phase?: string }
  | { type: 'escalate'; fromModel: string; toModel: string; phase: string }
  | { type: 'switch-model'; fromModel: string; toModel: string; phase: string }
  | { type: 'phase-complete'; phase: string; model: string }
  | { type: 'abort'; reason: string }
  | { type: 'continuation' }
  | { type: 'progress'; message: string }
  | { type: 'done'; success: boolean }
  | { type: 'error'; error: string };

export interface RunObserver {
  on(event: RunEvent): void;
}

/**
 * RunHost — TRANSITIONAL (Pass A). The residual CLI-only callbacks the loop still calls:
 * keyboard monitor, interrupt-input collection, stale-reference readline prompts, slash-command
 * routing during a pause, iteration-limit restore, and attachment carry-over. The CLI provides
 * real implementations; the web omits them and gets headless defaults (see normalizeHost).
 * NOTE (Pass A deviation, evidence-based): the runbook proposed folding getReadline into
 * collectInput, but getReadline also drives stale @insert-prompt/@insert-resource recovery
 * prompts whose null-guards already give correct headless behavior, so it is kept as an
 * optional host method here and removed in Pass B.
 */
export interface RunHost {
  startKeyboardMonitor?(): void;
  stopKeyboardMonitor?(): void;
  collectInput?(prompt: string): Promise<string | null>;
  getReadline?(): import('readline/promises').Interface | null;
  routeSlashCommand?(command: string): Promise<boolean>;
  restoreIterationLimitCallback?(): void;
  getPendingAttachments?(): AttachmentInfo[];
  setPendingAttachments?(attachments: AttachmentInfo[]): void;
}

/** All-required host the engine calls unconditionally; built from RunHost at run() entry. */
interface NormalizedHost {
  startKeyboardMonitor(): void;
  stopKeyboardMonitor(): void;
  collectInput(prompt: string): Promise<string | null>;
  getReadline(): import('readline/promises').Interface | null;
  routeSlashCommand(command: string): Promise<boolean>;
  restoreIterationLimitCallback(): void;
  getPendingAttachments(): AttachmentInfo[];
  setPendingAttachments(attachments: AttachmentInfo[]): void;
}

/** Collaborators the engine genuinely needs (injected, not reached-through). */
export interface RunDeps {
  client: MCPClient;
  logger: Logger;
  ablationManager: AblationManager;
  preferencesManager: PreferencesManager;
  attachmentManager: AttachmentManager;
}

export interface RunOptions {
  control: RunControl;
  observer: RunObserver;
  host?: RunHost;
}

export class AblationRunner {
  private control!: RunControl;
  private observer!: RunObserver;
  private host!: NormalizedHost;
  /** Cross-run state: last custom MCP config path loaded, to skip redundant server refreshes. */
  private lastAblationMcpConfigPath: string | null = null;
  /** Total scheduled runs for the active study (set at run() entry; used by phase-start events). */
  private totalRuns = 0;
  /** Visible window size for the dry-run rewind picker (mirror of the CLI constant). */
  private static readonly REWIND_VISIBLE_WINDOW = 15;

  constructor(private readonly deps: RunDeps) {}

  /** Record a finished phase result and surface it to the observer (SSE/console/registry). */
  private emitResult(run: AblationRun, result: AblationRunResult): void {
    run.results.push(result);
    this.observer.on({ type: 'result', result, phase: result.phase });
  }

  /** Build an all-required host from the optional RunHost, supplying headless defaults. */
  private normalizeHost(h?: RunHost): NormalizedHost {
    return {
      startKeyboardMonitor: h?.startKeyboardMonitor ? h.startKeyboardMonitor.bind(h) : () => {},
      stopKeyboardMonitor: h?.stopKeyboardMonitor ? h.stopKeyboardMonitor.bind(h) : () => {},
      collectInput: h?.collectInput ? h.collectInput.bind(h) : async () => null,
      getReadline: h?.getReadline ? h.getReadline.bind(h) : () => null,
      routeSlashCommand: h?.routeSlashCommand ? h.routeSlashCommand.bind(h) : async () => false,
      restoreIterationLimitCallback: h?.restoreIterationLimitCallback ? h.restoreIterationLimitCallback.bind(h) : () => {},
      getPendingAttachments: h?.getPendingAttachments ? h.getPendingAttachments.bind(h) : () => [],
      setPendingAttachments: h?.setPendingAttachments ? h.setPendingAttachments.bind(h) : () => {},
    };
  }

  /**
   * Execute a full ablation study (every model x phase, with escalation). Returns true if the
   * run was aborted/broken early, false if it completed all scenarios — identical to the old
   * AblationCLI.runSingleAblation contract (the caller names it `aborted`). Behavior is identical
   * regardless of surface; that identity is the whole point of this module.
   */
  async run(
    ablation: AblationDefinition,
    resolvedArguments: Record<string, string> | undefined,
    opts: RunOptions,
  ): Promise<boolean> {
    this.control = opts.control;
    this.observer = opts.observer;
    this.host = this.normalizeHost(opts.host);
    this.totalRuns = this.deps.ablationManager.getTotalRuns(ablation);
    this.observer.on({
      type: 'run-start',
      ablation: ablation.name,
      totalRuns: this.totalRuns,
      totalScenarios: this.deps.ablationManager.getTotalScenarios(ablation),
    });
    try {
      const aborted = await this.runSingleAblation(ablation, resolvedArguments);
      this.observer.on({ type: 'done', success: !aborted });
      return aborted;
    } catch (err: any) {
      this.observer.on({ type: 'error', error: err?.message ?? String(err) });
      throw err;
    }
  }

  // ───────── moved from AblationCLI.runSingleAblation (Slice 3 Pass A) ─────────
  private async runSingleAblation(ablation: AblationDefinition, resolvedArguments?: Record<string, string>): Promise<boolean> {
    const totalRuns = this.deps.ablationManager.getTotalRuns(ablation);
    const totalScenarios = this.deps.ablationManager.getTotalScenarios(ablation);

    // All servers (including disabled) are connected at startup.
    // Only refresh if this ablation uses a custom MCP config path.
    const defaultMcpConfigPath = this.deps.ablationManager.getDefaultMcpConfigPath();
    const effectiveConfigPath = (ablation.settings.mcpConfigPath && ablation.settings.mcpConfigPath !== defaultMcpConfigPath)
      ? ablation.settings.mcpConfigPath
      : defaultMcpConfigPath;

    // TODO: Hard-exit (not warn-and-continue) when the MCP config path is invalid,
    // missing, or fails to load — same for required ablation settings. Today we fall
    // through to the default config (lines below), silently changing run semantics.
    if (effectiveConfigPath !== defaultMcpConfigPath) {
      if (this.lastAblationMcpConfigPath !== effectiveConfigPath) {
        const resolvedPath = this.deps.ablationManager.resolveMcpConfigPath(ablation);
        if (resolvedPath) {
          const validation = this.deps.ablationManager.validateMcpConfigPath(ablation.settings.mcpConfigPath!);
          if (validation.valid) {
            this.deps.logger.log(`  Loading custom MCP config: ${ablation.settings.mcpConfigPath}\n`, { type: 'info' });
            if (!this.deps.client.reloadConfigFromPath(resolvedPath)) {
              this.deps.logger.log(`  ⚠ Failed to load custom MCP config, using default\n`, { type: 'warning' });
            }
          } else {
            this.deps.logger.log(`  ⚠ Invalid MCP config: ${validation.error}\n`, { type: 'warning' });
          }
        }

        this.deps.logger.log(`  Connecting servers for custom config...\n`, { type: 'info' });
        await this.deps.client.refreshServers(true);
        this.lastAblationMcpConfigPath = effectiveConfigPath;
        this.deps.logger.log(`  ✓ Servers connected\n`, { type: 'success' });
      } else {
        this.deps.logger.log(`  Servers already connected for this config, skipping refresh\n`, { type: 'info' });
      }
    }

    // Create run directory
    const { runDir, timestamp } = this.deps.ablationManager.createRunDirectory(
      ablation.name,
    );

    // Save a frozen copy of the ablation definition for provenance
    this.deps.ablationManager.saveDefinitionSnapshot(runDir, ablation);

    // Copy attachments to run directory (same for all runs)
    // Pass resolved arguments so dynamically-named attachments are detected
    this.deps.ablationManager.copyAttachmentsToRun(runDir, ablation, resolvedArguments);

    // Stash current outputs so each model run starts with a clean folder
    this.deps.logger.log('  Stashing outputs folder...\n', { type: 'info' });
    this.deps.ablationManager.stashOutputs(runDir);

    // Initialize run results
    const run: AblationRun = {
      ablationName: ablation.name,
      startedAt: new Date().toISOString(),
      ...(resolvedArguments && Object.keys(resolvedArguments).length > 0
        ? { resolvedArguments }
        : {}),
      results: [],
    };

    let runNumber = 0;
    let scenarioNumber = 0;
    const totalStartTime = Date.now();
    let shouldBreak = false;

    // Enable abort mode - Ctrl+C will set abort flag instead of exiting
    this.control.setAbortMode(true);

    // Reset abort/interrupt state and start keyboard monitor for Ctrl+A support
    this.control.resetAbort();
    this.control.resetInterrupt();
    this.host.startKeyboardMonitor();

    // Wire up force-stop for stuck tools during ablation runs.
    // During ablation, both Ctrl+C (signal handler abort) and Ctrl+A (keyboard interrupt)
    // should trigger the force-stop timer for in-flight tools. The CLI's default callback
    // only checks keyboard monitor (Ctrl+A), so we override it to also check the signal
    // handler's abort flag (Ctrl+C in abort mode).
    this.deps.client.setAbortRequestedCallback(() =>
      this.control.isAbortRequested() || this.control.isInterruptRequested()
    );
    this.deps.client.setForceStopCallback(async (toolName, elapsedSeconds, abortSignal) => {
      return this.askForceStopPrompt(toolName, elapsedSeconds, abortSignal);
    });

    // Suspend client-side hooks during ablation runs (ablation manages its own hooks)
    const hookManager = this.deps.client.getHookManager();
    hookManager.suspend();

    // Apply ablation settings overrides (maxIterations, mcpTimeout, maxIpcCalls)
    this.deps.preferencesManager.setMaxIterations(ablation.settings.maxIterations);
    if (ablation.settings.mcpTimeout !== undefined) {
      this.deps.preferencesManager.setMCPTimeout(ablation.settings.mcpTimeout);
    }
    const ipcServer = this.deps.client.getOrchestratorIPCServer();
    if (ablation.settings.maxIpcCalls !== undefined) {
      this.deps.preferencesManager.setMaxIpcCalls(ablation.settings.maxIpcCalls);
      if (ipcServer) {
        ipcServer.setMaxIpcCalls(ablation.settings.maxIpcCalls);
      }
    }
    // Disable pause-and-ask for IPC limits during ablation — hard stop only
    if (ipcServer) {
      ipcServer.setOnIpcLimitReached(undefined);
    }
    // Disable pause-and-ask for iteration limits during ablation — hard stop only
    this.deps.client.setOnIterationLimitCallback(undefined);

    try {
    // Determine models to iterate over
    // In dry run mode, use a single placeholder model (no model switching needed)
    const dryRunModel: AblationModel = { provider: 'none', model: 'dry-run' };
    const modelsToRun = ablation.dryRun ? [dryRunModel] : ablation.models;
    const iterations = ablation.runs ?? 1;
    const hasMultipleIterations = iterations > 1;
    // runIteration passed to directory helpers: undefined when iterations=1 (preserves old paths)
    const getRunIter = (iter: number) => hasMultipleIterations ? iter : undefined;

    if (ablation.escalation && !ablation.dryRun) {
      // ==================== Escalation Mode ====================
      // Phase-outer, model-inner: try models in order per phase
      await this.runEscalationLoop(ablation, run, runDir, resolvedArguments, iterations, hasMultipleIterations, () => shouldBreak, (v: boolean) => { shouldBreak = v; });
    } else {

    // Execute: iteration > model > phase
    for (let iteration = 1; iteration <= iterations; iteration++) {
      if (shouldBreak) break;

      if (hasMultipleIterations) {
        const iterLine = `ITERATION ${iteration}/${iterations}`;
        const iterWidth = Math.max(iterLine.length, 59);
        this.deps.logger.log(
          `\n╔══${'═'.repeat(iterWidth)}══╗\n`,
          { type: 'info' },
        );
        this.deps.logger.log(
          `║  ${iterLine.padEnd(iterWidth)}  ║\n`,
          { type: 'info' },
        );
        this.deps.logger.log(
          `╚══${'═'.repeat(iterWidth)}══╝\n`,
          { type: 'info' },
        );
      }

      for (const model of modelsToRun) {
        if (shouldBreak) break;

        // Check for abort (Ctrl+A or Ctrl+C) — early exit before model switch
        if (this.control.isAbortRequested()) {
          this.deps.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
          shouldBreak = true;
          break;
        }

        const modelKey = `${model.provider}/${model.model}`;

        // Clear outputs per model (each model starts with clean outputs)
        this.deps.ablationManager.clearOutputs();

        // Create provider instance and switch to this model once (skip in dry run)
        if (!ablation.dryRun) {
          try {
            const provider = this.createProviderInstance(model.provider);
            await this.deps.client.switchProviderAndModel(provider, model.model);
          } catch (error: any) {
            this.deps.logger.log(
              `\n  ✗ Skipping ${modelKey}: failed to initialize model — ${error.message}\n`,
              { type: 'error' },
            );
            // Record all phases as skipped for this model
            for (const phase of ablation.phases) {
              if (phase.enabled !== false) {
                this.emitResult(run, { phase: phase.name, model, status: 'skipped', error: error.message });
              }
            }
            runNumber++;
            continue; // Skip to next model
          }

          // Log abort event now that a session is active (Ctrl+C may have been pressed during model switch)
          if (this.control.isAbortRequested()) {
            this.deps.client.getChatHistoryManager().addUserInteractionEvent('abort', 'ctrl-c');
            this.deps.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
            shouldBreak = true;
            break;
          }

          // Apply per-model thinking config
          // If thinking is explicitly set, use that level.
          // If omitted but model supports reasoning, apply provider default.
          // If explicitly set to 'off', disable thinking.
          if (model.thinking === 'off') {
            // Do nothing — provider will get null thinkingConfig from index.ts
          } else if (model.thinking) {
            this.deps.preferencesManager.setThinkingLevel(model.provider, model.thinking);
          } else {
            // No thinking field — apply provider default if model supports reasoning
            const defaultLevel = isReasoningModel(model.model, model.provider)
              ? getDefaultThinkingLevel(model.provider)
              : undefined;
            if (defaultLevel) {
              this.deps.preferencesManager.setThinkingLevel(model.provider, defaultLevel);
            }
            // Non-reasoning model without thinking field — do nothing
          }
        }

        let modelAborted = false;
        runNumber++;

        // Display model-level header
        const modelShortName = ablation.dryRun ? 'dry-run' : this.deps.ablationManager.getModelShortName(model);
        const iterationSuffix = hasMultipleIterations ? ` (iteration ${iteration}/${iterations})` : '';

        if (!ablation.dryRun) {
          this.deps.logger.log(
            `\n┌──────────────────────────────────────────────────────────────┐\n`,
            { type: 'info' },
          );
          this.deps.logger.log(
            `│  ${modelShortName}${iterationSuffix}\n`,
            { type: 'info' },
          );
          const effectiveThinking = model.thinking || (isReasoningModel(model.model, model.provider) ? getDefaultThinkingLevel(model.provider) : undefined);
          const thinkingStatus = effectiveThinking ? ` │ Thinking: ${effectiveThinking}${!model.thinking ? ' (default)' : ''}` : '';
          this.deps.logger.log(
            `│  Provider: ${model.provider} │ Model: ${model.model}${thinkingStatus}\n`,
            { type: 'info' },
          );
          this.deps.logger.log(
            `└──────────────────────────────────────────────────────────────┘\n`,
            { type: 'info' },
          );
        }

        // Save tools, prompts, and resources snapshots per iteration per model
        const iterationDir = this.deps.ablationManager.getIterationDir(runDir, model, getRunIter(iteration));
        mkdirSync(iterationDir, { recursive: true });

        // Tools snapshot (constant across phases but saved per iteration for uniformity)
        this.deps.ablationManager.saveToolsSnapshot(iterationDir, this.deps.client.getServersInfo());

        // Prompts snapshot with resolved content for referenced ones
        const promptRefSources = [
          ablation.systemPrompt,
          ...ablation.phases.flatMap(p => [
            p.systemPrompt,
            p.userPrompt,
            ...p.commands,
            ...(p.onStart ?? []),
            ...(p.onEnd ?? []),
          ]),
        ].filter((s): s is string => typeof s === 'string');

        const usesPrompts = promptRefSources.some(s => s.trim().startsWith('@insert-prompt:'));
        if (usesPrompts) {
          const allPrompts = this.deps.client.listPrompts().map(p => ({
            server: p.server,
            prompt: {
              name: p.prompt.name,
              description: p.prompt.description,
              arguments: p.prompt.arguments,
            },
          }));

          const resolvedContent: Record<string, string> = {};
          const seen = new Set<string>();
          for (const src of promptRefSources) {
            const trimmed = src.trim();
            if (!trimmed.startsWith('@insert-prompt:')) continue;
            const nameArg = trimmed.slice('@insert-prompt:'.length).split(/[\s(]/)[0].trim();
            if (seen.has(nameArg)) continue;
            seen.add(nameArg);
            try {
              const resolved = await this.resolvePromptReference(trimmed, resolvedArguments);
              resolvedContent[nameArg] = resolved;
            } catch {
              // Skip prompts that fail to resolve
            }
          }

          this.deps.ablationManager.savePromptsSnapshot(iterationDir, allPrompts, resolvedContent);
        }

        for (const phase of ablation.phases) {
          if (shouldBreak || modelAborted) break;

          // Skip disabled phases
          if (phase.enabled === false) {
            this.deps.logger.log(`\n  ⤳ Skipping disabled phase: ${phase.name}\n`, { type: 'info' });
            this.emitResult(run, { phase: phase.name, model, status: 'skipped' });
            continue;
          }

          // Apply per-phase tool filter (merged top-level + phase-level)
          const phaseToolFilter = this.deps.ablationManager.getToolFilterForPhase(ablation, phase.name);
          if (phaseToolFilter) {
            this.deps.client.applyAblationToolFilter(
              tools => this.deps.ablationManager.applyToolFilter(tools, phaseToolFilter),
            );
            const filteredCount = this.deps.client.getTools().length;
            this.deps.logger.log(`  Tool filter active: ${filteredCount} tool(s) available for this phase\n`, { type: 'info' });
          }

          // Check for abort (Ctrl+A or Ctrl+C)
          if (this.control.isAbortRequested()) {
            this.deps.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
            this.deps.client.restoreAblationToolFilter();
            shouldBreak = true;
            break;
          }

          // Reset IPC call counter at start of each phase
          const phaseIpcServer = this.deps.client.getOrchestratorIPCServer();
          if (phaseIpcServer) {
            phaseIpcServer.resetIpcCallCount();
          }

          // Conditional context clearing between phases (not for first enabled phase)
          const isFirstEnabledPhase = ablation.phases.find(p => p.enabled !== false) === phase;
          if (!isFirstEnabledPhase && !ablation.dryRun) {
            if (ablation.settings.clearContextBetweenPhases !== false) {
              this.deps.client.clearContext();
            }
          }

          const phaseDir = this.deps.ablationManager.createPhaseDirectory(
            runDir,
            model,
            phase.name,
            getRunIter(iteration),
          );

          scenarioNumber++;
          const phaseIndex = ablation.phases.indexOf(phase) + 1;

          this.deps.logger.log(
            `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
            { type: 'info' },
          );
          if (ablation.dryRun) {
            this.deps.logger.log(
              `  SCENARIO ${scenarioNumber}/${totalScenarios}: ${phase.name} (dry run)${iterationSuffix}\n`,
              { type: 'info' },
            );
          } else {
            this.deps.logger.log(
              `  PHASE ${phaseIndex}/${ablation.phases.length}: ${phase.name}\n`,
              { type: 'info' },
            );
          }
          this.deps.logger.log(
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
            { type: 'info' },
          );

          const result: AblationRunResult = {
            phase: phase.name,
            model,
            status: 'running',
          };
          if (hasMultipleIterations) {
            result.run = iteration;
          }
          this.observer.on({ type: 'phase-start', phase: phase.name, model: `${model.provider}/${model.model}`, runIndex: run.results.length + 1, totalRuns: this.totalRuns });

          const startTime = Date.now();

          // Substitute argument placeholders in all command arrays for this phase
          const sub = (cmds: string[]) =>
            resolvedArguments ? this.deps.ablationManager.substituteArguments(cmds, resolvedArguments) : cmds;
          const phaseCommands = sub(phase.commands);
          const phaseOnStart = phase.onStart ? sub(phase.onStart) : undefined;
          const phaseOnEnd = phase.onEnd ? sub(phase.onEnd) : undefined;

          try {
            let aborted = false;
            let abortCurrentModel = false;
            let phaseCompletedViaSignal = false;
            let restartPhase = false;
            let escalateRequested = false;

            // Outer loop: re-entered when user chooses "restart phase"
            // eslint-disable-next-line no-constant-condition
            while (true) {
            restartPhase = false;

            // Log phase-start event to chat history
            this.deps.client.getChatHistoryManager().addPhaseEvent('phase-start', phase.name);

            // Set system prompt for this phase
            // With persistent context: phase prompt appends to master (master framing persists)
            // With clear context: phase prompt replaces master (fresh start each phase)
            const masterPrompt = ablation.systemPrompt ?? null;
            const phasePrompt = phase.systemPrompt ?? null;
            const persistentContext = ablation.settings.clearContextBetweenPhases === false;

            if (persistentContext) {
              // Persistent context: master is set once (first phase), phase prompts append
              if (isFirstEnabledPhase && masterPrompt !== null) {
                const resolvedMaster = await this.resolvePromptReference(masterPrompt, resolvedArguments);
                this.deps.client.setSystemPrompt(resolvedMaster);
                this.deps.logger.log(`  System prompt (master): ${resolvedMaster.slice(0, 80)}${resolvedMaster.length > 80 ? '...' : ''}\n`, { type: 'info' });
              }
              if (phasePrompt !== null) {
                const resolvedPhase = await this.resolvePromptReference(phasePrompt, resolvedArguments);
                const existing = this.deps.client.getSystemPrompt();
                if (existing) {
                  this.deps.client.setSystemPrompt(existing + '\n\n' + resolvedPhase);
                } else {
                  this.deps.client.setSystemPrompt(resolvedPhase);
                }
                this.deps.logger.log(`  System prompt (phase): ${resolvedPhase.slice(0, 80)}${resolvedPhase.length > 80 ? '...' : ''}\n`, { type: 'info' });
              }
            } else {
              // Clear context: phase override > master > null
              const effectivePrompt = phasePrompt ?? masterPrompt ?? null;
              if (effectivePrompt !== null) {
                const resolvedPrompt = await this.resolvePromptReference(effectivePrompt, resolvedArguments);
                this.deps.client.setSystemPrompt(resolvedPrompt);
                this.deps.logger.log(`  System prompt: ${resolvedPrompt.slice(0, 80)}${resolvedPrompt.length > 80 ? '...' : ''}\n`, { type: 'info' });
              } else {
                this.deps.client.setSystemPrompt(null);
              }
            }

            // Inject userPrompt as user message at phase start (if defined)
            // This becomes the first user message the model sees for this phase
            if (phase.userPrompt) {
              const resolvedUserPrompt = await this.resolvePromptReference(phase.userPrompt, resolvedArguments);
              const userMsg: Message = {
                role: 'user',
                content: resolvedUserPrompt,
              };
              this.deps.client.getMessages().push(userMsg);
              this.deps.client.getChatHistoryManager().addUserMessage(resolvedUserPrompt);
              this.deps.logger.log(`  User prompt: ${resolvedUserPrompt.slice(0, 80)}${resolvedUserPrompt.length > 80 ? '...' : ''}\n`, { type: 'info' });
            }

            // Execute onStart lifecycle hooks
            if (phaseOnStart && phaseOnStart.length > 0) {
              this.deps.logger.log(`  ⤷ Phase onStart hooks...\n`, { type: 'info' });
              for (const startCmd of phaseOnStart) {
                if (this.control.isAbortRequested()) {
                  this.deps.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
                  aborted = true;
                  shouldBreak = true;
                  break;
                }

                this.deps.logger.log(`    ↳ ${startCmd}\n`, { type: 'info' });
                const hookStartTime = Date.now();
                const hookResult = await this.executeAblationCommand(
                  startCmd,
                  ablation.settings.maxIterations,
                  ablation.dryRun || false,
                  ablation,
                  phase.name,
                  iterationDir,
                );

                // Log onStart tool execution to chat history
                if (hookResult.toolExecResult) {
                  const chatHist = this.deps.client.getChatHistoryManager();
                  chatHist.addHookToolExecution(
                    hookResult.toolExecResult.toolName,
                    hookResult.toolExecResult.args,
                    hookResult.toolExecResult.displayText || '',
                    { type: 'on-start', action: 'tool-exec' },
                  );
                }

              }
            }

            // Pre-stage attachment commands before executing sending commands.
            // This ensures @insert-attachment: and @clear-attachments are processed
            // before @insert-prompt: or raw queries, regardless of YAML ordering.
            const isStagingCommand = (cmd: string) => {
              const t = cmd.trim().toLowerCase();
              return t.startsWith('@insert-attachment:') || t === '@clear-attachments';
            };
            const stagedIndices = new Set<number>();
            const totalStaging = phaseCommands.filter(cmd => isStagingCommand(cmd)).length;
            let stageIdx = 0;
            for (let i = 0; i < phaseCommands.length; i++) {
              if (isStagingCommand(phaseCommands[i])) {
                stageIdx++;
                this.deps.logger.log(
                  `  [pre-stage ${stageIdx}/${totalStaging}] Executing: ${phaseCommands[i]}\n`,
                  { type: 'info' },
                );
                await this.executeAblationCommand(
                  phaseCommands[i],
                  ablation.settings.maxIterations,
                  ablation.dryRun || false,
                  ablation,
                  phase.name,
                  iterationDir,
                );
                stagedIndices.add(i);
              }
            }

            // Execute remaining (non-staged) commands for this phase
            const remainingCount = phaseCommands.length - stagedIndices.size;
            let remainingIdx = 0;
            const executedCommands: { index: number; command: string }[] = [];
            for (let i = 0; i < phaseCommands.length && !aborted; i++) {
              if (stagedIndices.has(i)) continue; // Already pre-staged
              remainingIdx++;

              // Reset interrupt flag before each command so Ctrl+A works reliably.
              // Without this, a Ctrl+A that was consumed by cancellationCheck but
              // never handled by a pause loop leaves _abortRequested=true, and the
              // keyboard monitor's guard (!_abortRequested) blocks all subsequent Ctrl+A.
              this.control.resetInterrupt();

              // Check for abort before each command
              if (this.control.isAbortRequested()) {
                this.deps.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
                aborted = true;
                shouldBreak = true;
                break;
              }

              const command = phaseCommands[i];
              this.deps.logger.log(
                `  [${remainingIdx}/${remainingCount}] Executing: ${command}\n`,
                { type: 'info' },
              );

              // Handle @wait:<seconds> command
              const waitMatch = command.trim().match(/^@wait:(\d+(?:\.\d+)?)$/);
              if (waitMatch) {
                const waitSeconds = parseFloat(waitMatch[1]);
                this.deps.logger.log(`    Waiting ${waitSeconds}s...\n`, { type: 'info' });
                await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
                this.deps.logger.log(`    Done waiting.\n`, { type: 'info' });
                continue;
              }

              // Execute before-hooks (only for @tool-exec/@tool commands)
              const trimmedCmd = command.trim();
              if (trimmedCmd.startsWith('@tool:') || trimmedCmd.startsWith('@tool-exec:')) {
                const parsed = parseDirectToolCall(trimmedCmd);
                if (parsed) {
                  const hooks = this.deps.ablationManager.getHooksForPhase(ablation, phase.name);
                  for (const hook of hooks) {
                    if (hook.before === parsed.toolName) {
                      if (this.control.isAbortRequested()) break;
                      if (!hook.run) continue;

                      const hookCmd = resolvedArguments
                        ? this.deps.ablationManager.substituteArguments([hook.run], resolvedArguments)[0]
                        : hook.run;
                      this.deps.logger.log(`  ↳ Before hook: executing ${hookCmd}\n`, { type: 'info' });
                      const hookStartTime = Date.now();
                      const hookResult = await this.executeAblationCommand(
                        hookCmd,
                        ablation.settings.maxIterations,
                        ablation.dryRun || false,
                        ablation,
                        phase.name,
                        iterationDir,
                      );

                    }
                  }
                }
              }

              const cmdStartTime = Date.now();
              const cmdResult = await this.executeAblationCommand(
                command,
                ablation.settings.maxIterations,
                ablation.dryRun || false,
                ablation,
                phase.name,
                iterationDir,
              );

              // Track executed commands for rewind picker
              executedCommands.push({ index: i, command });

              // Dry-run pause: after each tool-exec, check for Ctrl+A interrupt
              if (ablation.dryRun && this.control.isInterruptRequested() && !this.control.isAbortRequested()) {
                this.control.resetInterrupt();
                const choice = await this.promptDryRunPause(command, executedCommands);

                if (choice === 'cancel') {
                  aborted = true;
                  shouldBreak = true;
                  break;
                } else if (choice === 'restart-phase') {
                  this.deps.logger.log(`  ↻ Restarting phase "${phase.name}" from onStart...\n`, { type: 'warning' });
                  restartPhase = true;
                  break;
                } else if (typeof choice === 'object' && 'rewindTo' in choice) {
                  const target = choice.rewindTo;
                  // Recalculate remainingIdx for the target position
                  remainingIdx = 0;
                  for (let j = 0; j < target; j++) {
                    if (!stagedIndices.has(j)) remainingIdx++;
                  }
                  // Trim executedCommands to only entries before the target
                  const trimIdx = executedCommands.findIndex(e => e.index >= target);
                  if (trimIdx >= 0) executedCommands.length = trimIdx;
                  i = target - 1; // Will become target after for-loop increment
                  this.deps.logger.log(`  ↺ Rewinding to command ${target + 1}...\n`, { type: 'warning' });
                  continue;
                }
                // 'resume' → continue to next command
              }

              // Phase completed via @complete-phase (from agent-driven prompt or direct command)
              if (cmdResult.phaseComplete) {
                this.deps.logger.log(`  ✓ Phase "${phase.name}" completed via signal\n`, { type: 'success' });
                phaseCompletedViaSignal = true;
                break;
              }

              // Abort run signaled (from agent-driven hook via HookManager)
              if (cmdResult.abortRun) {
                abortCurrentModel = true;
                break;
              }

              // Escalation requested via @escalate (from direct command or agent-driven hook)
              if (cmdResult.escalate) {
                escalateRequested = true;
                break;
              }

              // Model switch requested via @switch (swap model, keep context)
              if (cmdResult.switchModel) {
                const currentIdx = ablation.models.findIndex(m => m.provider === model.provider && m.model === model.model);
                const nextIdx = currentIdx + 1;
                if (nextIdx < ablation.models.length) {
                  const nextModel = ablation.models[nextIdx];
                  const nextModelKey = `${nextModel.provider}/${nextModel.model}`;
                  this.deps.logger.log(`  ⇄ Switching model: ${modelKey} → ${nextModelKey} (keeping context)\n`, { type: 'warning' });
                  try {
                    const provider = this.createProviderInstance(nextModel.provider);
                    await this.deps.client.switchModel(provider, nextModel.model);
                  } catch (error: any) {
                    this.deps.logger.log(`  ✗ Model switch failed: ${error.message} — falling back to escalation\n`, { type: 'error' });
                    escalateRequested = true;
                    break;
                  }
                } else {
                  this.deps.logger.log(`  ✗ No next model for @switch — all models exhausted\n`, { type: 'error' });
                  escalateRequested = true;
                  break;
                }
              }

              // Execute after-hooks (only for @tool-exec/@tool commands, no recursion)
              if (cmdResult.toolExecResult) {
                const hooks = this.deps.ablationManager.getHooksForPhase(ablation, phase.name);
                for (const hook of hooks) {
                  if (hook.after === cmdResult.toolExecResult.toolName) {
                    // Check conditions if present — skip hook if doesn't match
                    if (hook.whenInput && !matchesWhenInputCondition(hook.whenInput, cmdResult.toolExecResult.args)) {
                      continue;
                    }
                    if (hook.whenOutput && !matchesWhenOutputCondition(hook.whenOutput, cmdResult.toolExecResult.displayText)) {
                      continue;
                    }
                    // Check for abort before hook
                    if (this.control.isAbortRequested()) break;
                    if (!hook.run) continue;

                    const hookCmd = resolvedArguments
                      ? this.deps.ablationManager.substituteArguments([hook.run], resolvedArguments)[0]
                      : hook.run;
                    this.deps.logger.log(`  ↳ Hook: executing ${hookCmd}\n`, { type: 'info' });
                    const hookStartTime = Date.now();
                    const hookResult = await this.executeAblationCommand(
                      hookCmd,
                      ablation.settings.maxIterations,
                      ablation.dryRun || false,
                      ablation,
                      phase.name,
                      iterationDir,
                    );

                    // Inject hookPrompt as client prompt after hook execution
                    // Only for context-injecting hooks (@tool:, @insert-prompt:) — not @tool-exec:
                    if (hook.prompt && !hookCmd.trim().startsWith('@tool-exec:')) {
                      const resolvedPrompt = resolvedArguments
                        ? this.deps.ablationManager.substituteArguments([hook.prompt], resolvedArguments)[0]
                        : hook.prompt;
                      this.deps.client.injectClientPrompt(resolvedPrompt, `hook: after ${hook.after}`);
                      this.deps.logger.log(`  ↳ Hook prompt injected\n`, { type: 'info' });
                    }

                    // @abort hook — skip remaining phases for this model
                    if (hookResult.abortRun) {
                      abortCurrentModel = true;
                      break;
                    }

                    // @complete-phase hook — advance to next phase
                    if (hookResult.phaseComplete) {
                      break;
                    }

                    // @escalate hook — escalate to next model for this phase
                    if (hookResult.escalate) {
                      escalateRequested = true;
                      break;
                    }

                    // @switch hook — swap model, keep context
                    if (hookResult.switchModel) {
                      const curIdx = ablation.models.findIndex(m => m.provider === model.provider && m.model === model.model);
                      const nextIdx = curIdx + 1;
                      if (nextIdx < ablation.models.length) {
                        const nextModel = ablation.models[nextIdx];
                        const nextModelKey = `${nextModel.provider}/${nextModel.model}`;
                        this.deps.logger.log(`  ⇄ Hook switch: ${modelKey} → ${nextModelKey} (keeping context)\n`, { type: 'warning' });
                        try {
                          const provider = this.createProviderInstance(nextModel.provider);
                          await this.deps.client.switchModel(provider, nextModel.model);
                        } catch (error: any) {
                          this.deps.logger.log(`  ✗ Model switch failed: ${error.message}\n`, { type: 'error' });
                          escalateRequested = true;
                        }
                      } else {
                        this.deps.logger.log(`  ✗ No next model for @switch\n`, { type: 'error' });
                        escalateRequested = true;
                      }
                      break;
                    }

                  }
                }
              }

              // If @abort was triggered by an after-hook, break out of the command loop
              if (abortCurrentModel) break;

              // If @escalate was triggered by an after-hook, break out of the command loop
              if (escalateRequested) break;

              // Check for abort after each command
              if (this.control.isAbortRequested()) {
                this.deps.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
                aborted = true;
                shouldBreak = true;
                break;
              }
            }

            // If restart-phase was requested, loop back to re-run onStart + commands
            if (restartPhase) continue;

            // Normal exit from the restart loop
            break;
            } // end while(true) restart-phase loop

            // Execute onEnd lifecycle hooks (only if not aborted)
            if (!aborted && phaseOnEnd && phaseOnEnd.length > 0) {
              this.deps.logger.log(`  ⤷ Phase onEnd hooks...\n`, { type: 'info' });
              for (const endCmd of phaseOnEnd) {
                if (this.control.isAbortRequested()) {
                  this.deps.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
                  aborted = true;
                  shouldBreak = true;
                  break;
                }

                this.deps.logger.log(`    ↳ ${endCmd}\n`, { type: 'info' });
                const hookStartTime = Date.now();
                const hookResult = await this.executeAblationCommand(
                  endCmd,
                  ablation.settings.maxIterations,
                  ablation.dryRun || false,
                  ablation,
                  phase.name,
                  iterationDir,
                );

                // Log onEnd tool execution to chat history
                if (hookResult.toolExecResult) {
                  const chatHist = this.deps.client.getChatHistoryManager();
                  chatHist.addHookToolExecution(
                    hookResult.toolExecResult.toolName,
                    hookResult.toolExecResult.args,
                    hookResult.toolExecResult.displayText || '',
                    { type: 'after', action: 'tool-exec' },
                  );
                }

              }
            }

            if (aborted) {
              // Stop any active video recording so the file is finalized before capture
              await this.deps.client.cleanupVideoRecording();
              this.deps.client.getChatHistoryManager().addPhaseEvent('phase-abort', phase.name);

              result.status = 'aborted';
              result.duration = Date.now() - startTime;
              result.durationFormatted = formatDuration(result.duration);

              // Capture token usage before breaking out (agent still consumed tokens)
              if (!ablation.dryRun) {
                const tokenUsage = this.deps.client.getTokenUsage();
                result.tokens = tokenUsage.current;
              }

              // Capture any outputs produced before abort (for diagnostics)
              this.deps.ablationManager.captureRunOutputs(runDir, phase.name, model, getRunIter(iteration));
              if (ablation.settings.resetOutputsBetweenPhases?.length) {
                this.deps.ablationManager.resetOutputSubdirs(ablation.settings.resetOutputsBetweenPhases);
              }

              // Save chat history on abort so it's preserved in the run directory
              if (ablation.settings.clearContextBetweenPhases !== false) {
                this.savePhaseChatHistory(
                  `Ablation run (aborted): ${phase.name} with ${model.provider}/${model.model}`,
                  runDir, phase.name, phaseDir, model, result, hasMultipleIterations, iteration,
                );
              } else {
                // Continuous context: session is saved after all phases, but logs must be copied per-phase
                this.deps.client.getServerLogManager().copyLogsToDir(phaseDir);
              }

              this.emitResult(run, result);
              break;
            }

            // @abort triggered by hook — skip remaining phases for this model
            if (abortCurrentModel) {
              await this.deps.client.cleanupVideoRecording();

              result.status = 'aborted';
              result.duration = Date.now() - startTime;
              result.durationFormatted = formatDuration(result.duration);

              // Capture token usage before breaking out (agent still consumed tokens)
              if (!ablation.dryRun) {
                const tokenUsage = this.deps.client.getTokenUsage();
                result.tokens = tokenUsage.current;
              }

              // Capture any outputs produced before @abort (for diagnostics)
              this.deps.ablationManager.captureRunOutputs(runDir, phase.name, model, getRunIter(iteration));
              if (ablation.settings.resetOutputsBetweenPhases?.length) {
                this.deps.ablationManager.resetOutputSubdirs(ablation.settings.resetOutputsBetweenPhases);
              }

              // Save chat history on @abort so it's preserved in the run directory
              if (ablation.settings.clearContextBetweenPhases !== false) {
                this.savePhaseChatHistory(
                  `Ablation run (@abort): ${phase.name} with ${model.provider}/${model.model}`,
                  runDir, phase.name, phaseDir, model, result, hasMultipleIterations, iteration,
                );
              } else {
                // Continuous context: session is saved after all phases, but logs must be copied per-phase
                this.deps.client.getServerLogManager().copyLogsToDir(phaseDir);
              }

              this.deps.logger.log(
                `\n  ⚠️ Skipping remaining phases for ${modelKey} due to @abort\n`,
                { type: 'warning' },
              );

              modelAborted = true;
              this.emitResult(run, result);
              break; // break phase loop, continue to next model
            }

            // @escalate triggered — record as escalated and let outer loop handle
            if (escalateRequested) {
              await this.deps.client.cleanupVideoRecording();

              result.status = 'escalated';
              result.duration = Date.now() - startTime;
              result.durationFormatted = formatDuration(result.duration);

              if (!ablation.dryRun) {
                const tokenUsage = this.deps.client.getTokenUsage();
                result.tokens = tokenUsage.current;
              }

              if (ablation.settings.clearContextBetweenPhases !== false) {
                this.savePhaseChatHistory(
                  `Ablation run (@escalate): ${phase.name} with ${model.provider}/${model.model}`,
                  runDir, phase.name, phaseDir, model, result, hasMultipleIterations, iteration,
                );
              } else {
                // Continuous context: session is saved after all phases, but logs must be copied per-phase
                this.deps.client.getServerLogManager().copyLogsToDir(phaseDir);
              }

              this.deps.logger.log(
                `\n  ⤴ Escalating phase "${phase.name}" to next model\n`,
                { type: 'warning' },
              );

              this.emitResult(run, result);
              break; // break phase loop — escalation handled by outer logic
            }

            // Get token usage (skip in dry run - no model means no tokens)
            if (!ablation.dryRun) {
              const tokenUsage = this.deps.client.getTokenUsage();
              result.tokens = tokenUsage.current;
            }

            result.status = 'completed';
            result.duration = Date.now() - startTime;
            result.durationFormatted = formatDuration(result.duration);

            // Log phase-complete if not already logged by a signal (@complete-phase or agent-stopped)
            if (!phaseCompletedViaSignal) {
              this.deps.client.getChatHistoryManager().addPhaseEvent('phase-complete', phase.name, { after: 'commands-exhausted' });
            }

            // Stop any active video recording so the file is finalized before capture
            await this.deps.client.cleanupVideoRecording();

            // Save chat history and copy to phase directory
            // When context persists across phases, defer saving until all phases complete
            if (ablation.settings.clearContextBetweenPhases !== false) {
              this.savePhaseChatHistory(
                `Ablation run: ${phase.name} with ${model.provider}/${model.model}`,
                runDir, phase.name, phaseDir, model, result, hasMultipleIterations, iteration,
              );
            } else {
              // Continuous context: session is saved after all phases, but logs must be copied per-phase
              this.deps.client.getServerLogManager().copyLogsToDir(phaseDir);
            }

            this.deps.logger.log(
              `\n  ✓ Scenario complete │ Duration: ${formatDuration(result.duration)}${result.tokens !== undefined ? ` │ Tokens: ${result.tokens}` : ''}\n`,
              { type: 'success' },
            );
          } catch (error: any) {
            result.status = 'failed';
            result.error = error.message;
            // Preserve HTTP status code for transient error classification (503, 429, etc.)
            if (typeof error.status === 'number') {
              result.errorStatus = error.status;
            }
            result.duration = Date.now() - startTime;
            result.durationFormatted = formatDuration(result.duration);

            // Capture token usage on failure (agent still consumed tokens)
            if (!ablation.dryRun) {
              try {
                const tokenUsage = this.deps.client.getTokenUsage();
                result.tokens = tokenUsage.current;
              } catch { /* ignore if token tracking unavailable */ }
            }

            // Stop any active video recording so the file is finalized before capture
            await this.deps.client.cleanupVideoRecording();

            // Save chat history on error so it's preserved in the run directory
            if (ablation.settings.clearContextBetweenPhases !== false) {
              this.savePhaseChatHistory(
                `Ablation run (failed): ${phase.name} with ${model.provider}/${model.model}`,
                runDir, phase.name, phaseDir, model, result, hasMultipleIterations, iteration,
              );
            } else {
              // Continuous context: session is saved after all phases, but logs must be copied per-phase
              this.deps.client.getServerLogManager().copyLogsToDir(phaseDir);
            }

            this.deps.logger.log(`\n  ✗ Scenario failed: ${error.message}\n`, {
              type: 'error',
            });
          }

          this.emitResult(run, result);

          // Restore tool list after phase filter
          this.deps.client.restoreAblationToolFilter();

          // Capture outputs produced during this phase (even on failure, for diagnostics)
          this.deps.ablationManager.captureRunOutputs(runDir, phase.name, model, getRunIter(iteration));
          if (ablation.settings.resetOutputsBetweenPhases?.length) {
            this.deps.ablationManager.resetOutputSubdirs(ablation.settings.resetOutputsBetweenPhases);
          }

          // On failure: skip remaining phases for this model
          if (result.status === 'failed') {
            modelAborted = true;
            this.deps.logger.log(
              `\n  ⚠️ Skipping remaining phases for ${modelKey} due to error: ${result.error}\n`,
              { type: 'warning' },
            );
            break; // break phase loop, continue to next model
          }
        }

        // When context persists across phases, save the cumulative chat after all phases
        if (!ablation.dryRun && ablation.settings.clearContextBetweenPhases === false) {
          const chatHistoryManager = this.deps.client.getChatHistoryManager();
          const chatMetadata = chatHistoryManager.endSession(
            `Ablation run: all phases with ${model.provider}/${model.model}`,
          );

          if (chatMetadata) {
            // Save cumulative chat to model-level directory: {modelDir}/(run-{N}/)
            const modelDir = this.deps.ablationManager.getModelDirName(model);
            const modelChatDir = hasMultipleIterations
              ? join(runDir, modelDir, `run-${iteration}`)
              : join(runDir, modelDir);
            mkdirSync(modelChatDir, { recursive: true });
            const destJsonPath = join(modelChatDir, 'chat.json');
            const destMdPath = join(modelChatDir, 'chat.md');

            try {
              if (existsSync(chatMetadata.filePath)) {
                cpSync(chatMetadata.filePath, destJsonPath);
              }
              if (existsSync(chatMetadata.mdFilePath)) {
                cpSync(chatMetadata.mdFilePath, destMdPath);
              }
            } catch (copyError) {
              this.deps.logger.log(`  Warning: Failed to copy cumulative chat files: ${copyError}\n`, { type: 'warning' });
            }

            // Copy cumulative server logs to model-level directory
            this.deps.client.getServerLogManager().copyLogsToDir(modelChatDir);
          }
        }
      }

    }
    } // end else (non-escalation)
    } finally {
      // Resume client-side hooks
      hookManager.resume();

      // Stop any active video recordings while still in raw mode (prevents SIGINT
      // propagation to recording processes during async cleanup)
      await this.deps.client.cleanupVideoRecording();

      // Stop keyboard monitor - always runs even if aborted/errored
      this.host.stopKeyboardMonitor();

      // Disable abort mode - Ctrl+C will exit normally again
      this.control.setAbortMode(false);

      // Restore original abort callback (keyboard monitor only, for normal CLI mode)
      this.deps.client.setAbortRequestedCallback(() => this.control.isInterruptRequested());

      // Restore CLI's iteration-limit callback (pause-and-ask behavior)
      this.host.restoreIterationLimitCallback();
    }

    // Clean up system prompt so it doesn't leak into regular chat
    this.deps.client.setSystemPrompt(null);

    // Finalize run
    run.completedAt = new Date().toISOString();
    run.totalDuration = Date.now() - totalStartTime;
    run.totalDurationFormatted = formatDuration(run.totalDuration);
    run.totalTokens = run.results.reduce((sum, r) => sum + (r.tokens || 0), 0);

    // Save results
    this.deps.ablationManager.saveRunResults(runDir, run);

    // Display summary
    const completeLine = `ABLATION COMPLETE: ${ablation.name}`;
    const completeWidth = Math.max(completeLine.length, 59);
    this.deps.logger.log(
      `\n┌──${'─'.repeat(completeWidth)}──┐\n`,
      { type: 'info' },
    );
    this.deps.logger.log(
      `│  ${completeLine.padEnd(completeWidth)}  │\n`,
      { type: 'info' },
    );
    this.deps.logger.log(
      `└──${'─'.repeat(completeWidth)}──┘\n`,
      { type: 'info' },
    );

    this.displayFinalResults(run, ablation);
    this.deps.logger.log(`\n  Outputs saved to:\n`, { type: 'info' });
    this.deps.logger.log(`    ${runDir}\n`, { type: 'info' });

    // Restore original outputs folder from stash
    this.deps.logger.log('\n  Restoring original outputs folder...\n', {
      type: 'info',
    });
    this.deps.ablationManager.unstashOutputs(runDir);

    return shouldBreak;
  }

  // ───────── moved from AblationCLI.runEscalationLoop (Slice 3 Pass A) ─────────
  private async runEscalationLoop(
    ablation: AblationDefinition,
    run: AblationRun,
    runDir: string,
    resolvedArguments: Record<string, string> | undefined,
    iterations: number,
    hasMultipleIterations: boolean,
    getShouldBreak: () => boolean,
    setShouldBreak: (v: boolean) => void,
  ): Promise<void> {
    const getRunIter = (iter: number) => hasMultipleIterations ? iter : undefined;
    const models = ablation.models;

    for (let iteration = 1; iteration <= iterations; iteration++) {
      if (getShouldBreak()) break;

      if (hasMultipleIterations) {
        const iterLine = `ITERATION ${iteration}/${iterations}`;
        const iterWidth = Math.max(iterLine.length, 59);
        this.deps.logger.log(`\n╔══${'═'.repeat(iterWidth)}══╗\n`, { type: 'info' });
        this.deps.logger.log(`║  ${iterLine.padEnd(iterWidth)}  ║\n`, { type: 'info' });
        this.deps.logger.log(`╚══${'═'.repeat(iterWidth)}══╝\n`, { type: 'info' });
      }

      // Track successful attempt dirs for output restoration across phases
      const successfulPhaseOutputs = new Map<string, string>();
      let runAborted = false;

      for (const phase of ablation.phases) {
        if (getShouldBreak() || runAborted) break;

        // Skip disabled phases
        if (phase.enabled === false) {
          this.deps.logger.log(`\n  ⤳ Skipping disabled phase: ${phase.name}\n`, { type: 'info' });
          this.emitResult(run, { phase: phase.name, model: models[0], status: 'skipped' });
          continue;
        }

        let phaseCompleted = false;

        for (let attemptIndex = 0; attemptIndex < models.length; attemptIndex++) {
          if (getShouldBreak()) break;

          const model = models[attemptIndex];
          const attempt = attemptIndex + 1;
          const modelKey = `${model.provider}/${model.model}`;

          // Check for user abort (before model switch — no session needed for the check itself)
          if (this.control.isAbortRequested()) {
            this.deps.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
            setShouldBreak(true);
            break;
          }

          // Switch to this model
          try {
            const provider = this.createProviderInstance(model.provider);
            await this.deps.client.switchProviderAndModel(provider, model.model);
          } catch (error: any) {
            this.deps.logger.log(
              `\n  ✗ Skipping ${modelKey}: failed to initialize — ${error.message}\n`,
              { type: 'error' },
            );
            this.emitResult(run, { phase: phase.name, model, status: 'skipped', attempt, error: error.message });
            continue; // try next model
          }

          // Apply thinking config
          if (model.thinking === 'off') {
            // Do nothing
          } else if (model.thinking) {
            this.deps.preferencesManager.setThinkingLevel(model.provider, model.thinking);
          } else {
            const defaultLevel = isReasoningModel(model.model, model.provider)
              ? getDefaultThinkingLevel(model.provider)
              : undefined;
            if (defaultLevel) {
              this.deps.preferencesManager.setThinkingLevel(model.provider, defaultLevel);
            }
          }

          // Clear context for fresh attempt (starts a new session)
          this.deps.client.clearContext();

          // Log abort event now that a session is active (Ctrl+C may have been pressed during model switch)
          if (this.control.isAbortRequested()) {
            this.deps.client.getChatHistoryManager().addUserInteractionEvent('abort', 'ctrl-c');
            this.deps.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
            setShouldBreak(true);
            break;
          }

          // Restore outputs from prior successful phases
          this.deps.ablationManager.restoreOutputsFromPriorPhases(successfulPhaseOutputs);

          // Reset IPC call counter
          const phaseIpcServer = this.deps.client.getOrchestratorIPCServer();
          if (phaseIpcServer) {
            phaseIpcServer.resetIpcCallCount();
          }

          // Create attempt directory
          const attemptDir = this.deps.ablationManager.createEscalationAttemptDir(
            runDir, phase.name, attempt, model, getRunIter(iteration),
          );

          // Save snapshots to attempt dir
          this.deps.ablationManager.saveToolsSnapshot(attemptDir, this.deps.client.getServersInfo());

          // Apply per-phase tool filter
          const phaseToolFilter = this.deps.ablationManager.getToolFilterForPhase(ablation, phase.name);
          if (phaseToolFilter) {
            this.deps.client.applyAblationToolFilter(
              tools => this.deps.ablationManager.applyToolFilter(tools, phaseToolFilter),
            );
          }

          // Display header
          const thinkingInfo = model.thinking || (isReasoningModel(model.model, model.provider) ? getDefaultThinkingLevel(model.provider) : undefined);
          const thinkingStatus = thinkingInfo ? ` │ Thinking: ${thinkingInfo}` : '';
          const phaseIndex = ablation.phases.filter(p => p.enabled !== false).indexOf(phase) + 1;
          const totalPhases = ablation.phases.filter(p => p.enabled !== false).length;

          this.deps.logger.log(
            `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
            { type: 'info' },
          );
          this.deps.logger.log(
            `  PHASE ${phaseIndex}/${totalPhases}: ${phase.name}\n`,
            { type: 'info' },
          );
          this.deps.logger.log(
            `  Attempt ${attempt}/${models.length}: ${modelKey}${thinkingStatus}\n`,
            { type: 'info' },
          );
          this.deps.logger.log(
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
            { type: 'info' },
          );

          const result: AblationRunResult = {
            phase: phase.name,
            model,
            attempt,
            status: 'running',
          };
          if (hasMultipleIterations) {
            result.run = iteration;
          }
          this.observer.on({ type: 'phase-start', phase: phase.name, model: `${model.provider}/${model.model}`, runIndex: run.results.length + 1, totalRuns: this.totalRuns });

          const startTime = Date.now();

          // Substitute argument placeholders
          const sub = (cmds: string[]) =>
            resolvedArguments ? this.deps.ablationManager.substituteArguments(cmds, resolvedArguments) : cmds;
          const phaseCommands = sub(phase.commands);
          const phaseOnStart = phase.onStart ? sub(phase.onStart) : undefined;
          const phaseOnEnd = phase.onEnd ? sub(phase.onEnd) : undefined;

          try {
            let aborted = false;
            let abortCurrentRun = false;
            let phaseCompletedViaSignal = false;
            let escalateRequested = false;

            // Log phase-start event
            this.deps.client.getChatHistoryManager().addPhaseEvent('phase-start', phase.name);

            // Set system prompt
            const masterPrompt = ablation.systemPrompt ?? null;
            const phasePrompt = phase.systemPrompt ?? null;
            const effectivePrompt = phasePrompt ?? masterPrompt ?? null;
            if (effectivePrompt !== null) {
              const resolvedPrompt = await this.resolvePromptReference(effectivePrompt, resolvedArguments);
              this.deps.client.setSystemPrompt(resolvedPrompt);
            } else {
              this.deps.client.setSystemPrompt(null);
            }

            // Inject userPrompt
            if (phase.userPrompt) {
              const resolvedUserPrompt = await this.resolvePromptReference(phase.userPrompt, resolvedArguments);
              this.deps.client.getMessages().push({ role: 'user', content: resolvedUserPrompt });
              this.deps.client.getChatHistoryManager().addUserMessage(resolvedUserPrompt);
            }

            // Execute onStart hooks
            if (phaseOnStart && phaseOnStart.length > 0) {
              this.deps.logger.log(`  ⤷ Phase onStart hooks...\n`, { type: 'info' });
              for (const startCmd of phaseOnStart) {
                if (this.control.isAbortRequested()) {
                  aborted = true;
                  setShouldBreak(true);
                  break;
                }
                this.deps.logger.log(`    ↳ ${startCmd}\n`, { type: 'info' });
                const hookResult = await this.executeAblationCommand(
                  startCmd, ablation.settings.maxIterations, false, ablation, phase.name, attemptDir,
                );
                if (hookResult.toolExecResult) {
                  this.deps.client.getChatHistoryManager().addHookToolExecution(
                    hookResult.toolExecResult.toolName,
                    hookResult.toolExecResult.args,
                    hookResult.toolExecResult.displayText || '',
                    { type: 'on-start', action: 'tool-exec' },
                  );
                }
              }
            }

            if (!aborted) {
              // Pre-stage attachments
              const isStagingCommand = (cmd: string) => {
                const t = cmd.trim().toLowerCase();
                return t.startsWith('@insert-attachment:') || t === '@clear-attachments';
              };
              const stagedIndices = new Set<number>();
              for (let i = 0; i < phaseCommands.length; i++) {
                if (isStagingCommand(phaseCommands[i])) {
                  await this.executeAblationCommand(
                    phaseCommands[i], ablation.settings.maxIterations, false, ablation, phase.name, attemptDir,
                  );
                  stagedIndices.add(i);
                }
              }

              // Execute remaining commands
              for (let i = 0; i < phaseCommands.length && !aborted; i++) {
                if (stagedIndices.has(i)) continue;

                this.control.resetInterrupt();

                if (this.control.isAbortRequested()) {
                  aborted = true;
                  setShouldBreak(true);
                  break;
                }

                const command = phaseCommands[i];
                this.deps.logger.log(`  [${i + 1}/${phaseCommands.length}] Executing: ${command}\n`, { type: 'info' });

                // Handle @wait
                const waitMatch = command.trim().match(/^@wait:(\d+(?:\.\d+)?)$/);
                if (waitMatch) {
                  const waitSeconds = parseFloat(waitMatch[1]);
                  this.deps.logger.log(`    Waiting ${waitSeconds}s...\n`, { type: 'info' });
                  await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
                  continue;
                }

                // Execute before-hooks for @tool-exec/@tool commands
                const trimmedCmd = command.trim();
                if (trimmedCmd.startsWith('@tool:') || trimmedCmd.startsWith('@tool-exec:')) {
                  const parsed = parseDirectToolCall(trimmedCmd);
                  if (parsed) {
                    const hooks = this.deps.ablationManager.getHooksForPhase(ablation, phase.name);
                    for (const hook of hooks) {
                      if (hook.before === parsed.toolName) {
                        if (this.control.isAbortRequested()) break;
                        if (!hook.run) continue;
                        const hookCmd = resolvedArguments
                          ? this.deps.ablationManager.substituteArguments([hook.run], resolvedArguments)[0]
                          : hook.run;
                        this.deps.logger.log(`  ↳ Before hook: executing ${hookCmd}\n`, { type: 'info' });
                        await this.executeAblationCommand(
                          hookCmd, ablation.settings.maxIterations, false, ablation, phase.name, attemptDir,
                        );
                      }
                    }
                  }
                }

                const cmdResult = await this.executeAblationCommand(
                  command, ablation.settings.maxIterations, false, ablation, phase.name, attemptDir,
                );

                // Check signals
                if (cmdResult.phaseComplete) {
                  phaseCompletedViaSignal = true;
                  break;
                }
                if (cmdResult.escalate) {
                  escalateRequested = true;
                  break;
                }
                if (cmdResult.abortRun) {
                  abortCurrentRun = true;
                  break;
                }

                // Execute after-hooks
                if (cmdResult.toolExecResult) {
                  const hooks = this.deps.ablationManager.getHooksForPhase(ablation, phase.name);
                  for (const hook of hooks) {
                    if (hook.after === cmdResult.toolExecResult.toolName) {
                      if (hook.whenInput && !matchesWhenInputCondition(hook.whenInput, cmdResult.toolExecResult.args)) continue;
                      if (hook.whenOutput && !matchesWhenOutputCondition(hook.whenOutput, cmdResult.toolExecResult.displayText)) continue;
                      if (this.control.isAbortRequested()) break;
                      if (!hook.run) continue;

                      const hookCmd = resolvedArguments
                        ? this.deps.ablationManager.substituteArguments([hook.run], resolvedArguments)[0]
                        : hook.run;
                      this.deps.logger.log(`  ↳ Hook: executing ${hookCmd}\n`, { type: 'info' });
                      const hookResult = await this.executeAblationCommand(
                        hookCmd, ablation.settings.maxIterations, false, ablation, phase.name, attemptDir,
                      );

                      if (hook.prompt && !hookCmd.trim().startsWith('@tool-exec:')) {
                        const resolvedHookPrompt = resolvedArguments
                          ? this.deps.ablationManager.substituteArguments([hook.prompt], resolvedArguments)[0]
                          : hook.prompt;
                        this.deps.client.injectClientPrompt(resolvedHookPrompt, `hook: after ${hook.after}`);
                      }

                      if (hookResult.abortRun) { abortCurrentRun = true; break; }
                      if (hookResult.phaseComplete) { break; }
                      if (hookResult.escalate) { escalateRequested = true; break; }
                    }
                  }
                }

                if (abortCurrentRun || escalateRequested) break;

                if (this.control.isAbortRequested()) {
                  aborted = true;
                  setShouldBreak(true);
                  break;
                }
              }
            }

            // Execute onEnd hooks (only if not aborted/escalated)
            if (!aborted && !escalateRequested && !abortCurrentRun && phaseOnEnd && phaseOnEnd.length > 0) {
              this.deps.logger.log(`  ⤷ Phase onEnd hooks...\n`, { type: 'info' });
              for (const endCmd of phaseOnEnd) {
                if (this.control.isAbortRequested()) break;
                this.deps.logger.log(`    ↳ ${endCmd}\n`, { type: 'info' });
                await this.executeAblationCommand(
                  endCmd, ablation.settings.maxIterations, false, ablation, phase.name, attemptDir,
                );
              }
            }

            // Determine result
            await this.deps.client.cleanupVideoRecording();
            result.duration = Date.now() - startTime;
            result.durationFormatted = formatDuration(result.duration);

            if (!ablation.dryRun) {
              const tokenUsage = this.deps.client.getTokenUsage();
              result.tokens = tokenUsage.current;
            }

            if (aborted) {
              result.status = 'aborted';
              this.deps.client.getChatHistoryManager().addPhaseEvent('phase-abort', phase.name);
            } else if (abortCurrentRun) {
              result.status = 'aborted';
              runAborted = true;
            } else if (escalateRequested) {
              result.status = 'escalated';
              this.deps.client.getChatHistoryManager().addPhaseEvent('phase-escalate', phase.name, { after: `escalation-attempt-${attempt}` });
            } else if (phaseCompletedViaSignal) {
              result.status = 'completed';
              this.deps.logger.log(`  ✓ Phase "${phase.name}" completed (attempt ${attempt})\n`, { type: 'success' });
            } else {
              // Commands exhausted without signal — treat as completed
              result.status = 'completed';
              this.deps.client.getChatHistoryManager().addPhaseEvent('phase-complete', phase.name, { after: 'commands-exhausted' });
            }

            // Save chat history to attempt dir
            this.savePhaseChatHistory(
              `Ablation run (escalation): ${phase.name} with ${modelKey} (attempt ${attempt})`,
              runDir, phase.name, attemptDir, model, result, hasMultipleIterations, iteration,
            );

          } catch (error: any) {
            result.status = 'failed';
            result.error = error.message;
            // Preserve HTTP status code for transient error classification (503, 429, etc.)
            if (typeof error.status === 'number') {
              result.errorStatus = error.status;
            }
            result.duration = Date.now() - startTime;
            result.durationFormatted = formatDuration(result.duration);

            if (!ablation.dryRun) {
              try {
                const tokenUsage = this.deps.client.getTokenUsage();
                result.tokens = tokenUsage.current;
              } catch { /* ignore */ }
            }

            await this.deps.client.cleanupVideoRecording();

            this.savePhaseChatHistory(
              `Ablation run (failed): ${phase.name} with ${modelKey} (attempt ${attempt})`,
              runDir, phase.name, attemptDir, model, result, hasMultipleIterations, iteration,
            );

            this.deps.logger.log(`\n  ✗ Attempt failed: ${error.message}\n`, { type: 'error' });
            // Treat exception as implicit escalation
          }

          // Capture outputs to attempt dir
          this.deps.ablationManager.captureEscalationOutputs(attemptDir);

          // Restore tool filter
          this.deps.client.restoreAblationToolFilter();

          this.emitResult(run, result);

          // Handle result
          if (result.status === 'completed') {
            successfulPhaseOutputs.set(phase.name, attemptDir);
            phaseCompleted = true;
            // Clear outputs for next phase
            this.deps.ablationManager.clearOutputs();
            break; // next phase
          }

          if (result.status === 'aborted' || runAborted) {
            runAborted = true;
            break; // abort entire run
          }

          // escalated or failed — try next model
          this.deps.logger.log(
            `  ⤴ Phase "${phase.name}" escalating from ${modelKey} (attempt ${attempt}/${models.length})\n`,
            { type: 'warning' },
          );
          this.deps.ablationManager.clearOutputs();
        } // end model attempts loop

        // Check if phase was never completed (models exhausted)
        if (!phaseCompleted && !runAborted && !getShouldBreak()) {
          this.deps.logger.log(
            `\n  ✗ All models exhausted for phase "${phase.name}" — aborting run\n`,
            { type: 'error' },
          );
          runAborted = true;
        }

        if (runAborted) break;
      } // end phase loop
    } // end iteration loop
  }

  // ───────── moved from AblationCLI.executeAblationCommand (Slice 3 Pass A) ─────────
  private async executeAblationCommand(
    command: string,
    maxIterations: number,
    dryRun: boolean = false,
    ablation?: AblationDefinition,
    phaseName?: string,
    iterationDir?: string,
  ): Promise<AblationCommandResult> {
    const trimmedCommand = command.trim();

    // Handle @complete-phase — signal that the current phase is done
    if (trimmedCommand === '@complete-phase' || trimmedCommand.startsWith('@complete-phase:')) {
      const label = trimmedCommand.includes(':') ? trimmedCommand.slice('@complete-phase:'.length) : phaseName || 'current';
      this.deps.logger.log(`  ✓ @complete-phase: advancing past phase "${label}"\n`, { type: 'info' });
      return { phaseComplete: true };
    }

    // Handle @abort — signal to skip remaining phases for the current model
    if (trimmedCommand === '@abort') {
      this.deps.logger.log(`  ⚠️ @abort: skipping remaining phases for current model\n`, { type: 'warning' });
      return { abortRun: true };
    }

    // Handle @escalate — signal to escalate to the next model in the chain
    if (trimmedCommand === '@escalate') {
      this.deps.logger.log(`  ⤴ @escalate: escalating to next model for current phase\n`, { type: 'warning' });
      return { escalate: true };
    }

    // Handle @switch — swap to next model but keep context (for log correction)
    if (trimmedCommand === '@switch') {
      this.deps.logger.log(`  ⇄ @switch: switching to next model (keeping context)\n`, { type: 'warning' });
      return { switchModel: true };
    }

    // Handle @wait:<seconds> — pause execution
    const waitMatch = trimmedCommand.match(/^@wait:(\d+(?:\.\d+)?)$/);
    if (waitMatch) {
      const waitSeconds = parseFloat(waitMatch[1]);
      this.deps.logger.log(`    Waiting ${waitSeconds}s...\n`, { type: 'info' });
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      this.deps.logger.log(`    Done waiting.\n`, { type: 'info' });
      return {};
    }

    // Handle direct tool calls (@tool: or @tool-exec:)
    if (trimmedCommand.startsWith('@tool:') || trimmedCommand.startsWith('@tool-exec:')) {
      const parsed = parseDirectToolCall(trimmedCommand);
      if (!parsed) {
        throw new Error(`Invalid tool call syntax: ${trimmedCommand}`);
      }

      this.deps.logger.log(`    Executing tool: ${parsed.toolName}\n`, { type: 'info' });

      try {
        const result = await this.deps.client.executeMCPTool(
          parsed.toolName,
          parsed.args as Record<string, unknown>,
        );

        // Log the result
        if (result.displayText) {
          // Truncate long results for display
          const displayText = result.displayText.length > 500
            ? result.displayText.substring(0, 500) + '...'
            : result.displayText;
          this.deps.logger.log(`    Tool result: ${displayText}\n`, { type: 'info' });
        }

        // If injectResult is true, inject the tool result into conversation context
        if (parsed.injectResult && result.contentBlocks && result.contentBlocks.length > 0) {
          // Create a synthetic tool use/result pair to inject into conversation
          await this.deps.client.injectToolResult(parsed.toolName, parsed.args, result);
          this.deps.logger.log(`    Result injected into conversation context\n`, { type: 'info' });
        }

        return {
          toolExecResult: {
            toolName: parsed.toolName,
            args: parsed.args,
            displayText: result.displayText,
            success: true,
          },
        };
      } catch (error: any) {
        this.deps.logger.log(`    Tool execution failed: ${error.message}\n`, { type: 'error' });
        throw Object.assign(error, {
          _toolExecResult: {
            toolName: parsed.toolName,
            args: parsed.args,
            success: false,
            error: error.message,
          },
        });
      }
    }

    // Handle @shell: commands - run CLI commands in system environment
    if (trimmedCommand.startsWith('@shell:')) {
      const shellCommand = trimmedCommand.slice('@shell:'.length).trim();
      if (!shellCommand) {
        throw new Error('Empty shell command. Usage: @shell:<command>');
      }

      this.deps.logger.log(`    Executing shell: ${shellCommand}\n`, { type: 'info' });

      try {
        const output = execSync(shellCommand, {
          encoding: 'utf-8',
          timeout: 300_000, // 5 minute timeout
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const displayText = output.trim();
        if (displayText) {
          const truncated = displayText.length > 500
            ? displayText.substring(0, 500) + '...'
            : displayText;
          this.deps.logger.log(`    Shell output: ${truncated}\n`, { type: 'info' });
        }

        return {
          toolExecResult: {
            toolName: '@shell',
            args: { command: shellCommand },
            displayText: displayText || undefined,
            success: true,
          },
        };
      } catch (error: any) {
        // execSync throws on non-zero exit codes; capture stderr + stdout
        const stderr = error.stderr?.toString().trim() || '';
        const stdout = error.stdout?.toString().trim() || '';
        const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');
        const errorMessage = combinedOutput || error.message;

        this.deps.logger.log(`    Shell command failed: ${errorMessage}\n`, { type: 'error' });
        throw Object.assign(new Error(errorMessage), {
          _toolExecResult: {
            toolName: '@shell',
            args: { command: shellCommand },
            success: false,
            error: errorMessage,
          },
        });
      }
    }

    // Handle @insert-resource:<server__resourceName> — read resource and inject as context
    // Supports: server__name, server__name(arg='val'), server__name {"arg":"val"}
    if (trimmedCommand.startsWith('@insert-resource:')) {
      const suffix = trimmedCommand.slice('@insert-resource:'.length).trim();
      if (!suffix) {
        throw new Error('Usage: @insert-resource:server__resourceName or @insert-resource:server__resourceName(arg=val)');
      }

      let nameArg: string;
      let resourceArgs: Record<string, string> | undefined;

      const pythonMatch = suffix.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*\((.*)\)\s*$/);
      const jsonMatch = suffix.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s+(\{.*\})\s*$/);
      const simpleMatch = suffix.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*$/);

      if (pythonMatch) {
        nameArg = pythonMatch[1];
        const argsStr = pythonMatch[2].trim();
        if (argsStr) {
          resourceArgs = parsePythonArgs(argsStr) as Record<string, string>;
        }
      } else if (jsonMatch) {
        nameArg = jsonMatch[1];
        try {
          resourceArgs = JSON.parse(jsonMatch[2]);
        } catch {
          throw new Error(`Invalid JSON arguments in @insert-resource: ${jsonMatch[2]}`);
        }
      } else if (simpleMatch) {
        nameArg = simpleMatch[1];
      } else {
        nameArg = suffix.split(/[\s(]/)[0];
      }

      if (dryRun) {
        this.deps.logger.log(`    ⚠ Skipping @insert-resource in dry run (no model): ${nameArg}\n`, { type: 'warning' });
        return {};
      }

      let resolved = this.findResourceOrTemplate(nameArg, resourceArgs);

      if (!resolved) {
        // Stale reference — prompt user to select a replacement from concrete resources
        const allResources = this.deps.client.listResources();
        const rl = this.host.getReadline();
        const resourceMgr = this.deps.client.getResourceManager();
        const enabledResources = resourceMgr.filterResources(allResources);
        if (!rl || enabledResources.length === 0) {
          throw new Error(`Resource not found: ${nameArg} (no resources available or no readline)`);
        }

        this.deps.logger.log(`\n  ⚠ Stale resource reference: "${nameArg}" — select a replacement:\n`, { type: 'warning' });
        for (let i = 0; i < enabledResources.length; i++) {
          const r = enabledResources[i];
          this.deps.logger.log(`    ${i + 1}. [${r.server}] ${r.resource.name} (${r.resource.uri})\n`, { type: 'info' });
        }

        const selection = (await rl.question('  Select resource number: ')).trim();
        const selectedIdx = parseInt(selection) - 1;

        if (isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= enabledResources.length) {
          throw new Error(`Invalid resource selection: ${selection}`);
        }

        const selected = enabledResources[selectedIdx];
        resolved = { server: selected.server, uri: selected.resource.uri };
        const newKey = `${selected.server}__${selected.resource.name}`;

        if (ablation && phaseName) {
          const phase = ablation.phases.find(p => p.name === phaseName);
          if (phase) {
            const cmdIdx = phase.commands.indexOf(trimmedCommand);
            if (cmdIdx !== -1) {
              phase.commands[cmdIdx] = `@insert-resource:${newKey}`;
              this.deps.ablationManager.save(ablation);
              this.deps.logger.log(`  ✓ Updated ablation YAML: ${nameArg} → ${newKey}\n`, { type: 'success' });
            }
          }
        }
      }

      // Read the resource content
      const result = await this.deps.client.readResource(resolved.server, resolved.uri);
      const descLine = resolved.description ? `\n${resolved.description}\n` : '\n';

      for (const content of result.contents) {
        let contentText = '';
        if ('text' in content && content.text) {
          contentText = `[Resource: ${content.uri}]${descLine}\`\`\`\n${content.text}\n\`\`\``;
        } else if ('blob' in content && content.blob) {
          contentText = `[Resource: ${content.uri}]${descLine}[Binary data, ${(content as any).blob.length} bytes base64]`;
        } else {
          contentText = `[Resource: ${content.uri}]${descLine}[Empty resource]`;
        }

        this.deps.client.injectClientPrompt(contentText, `resource: ${nameArg}`);

        // Preview resource content in CLI
        if ('text' in content && content.text) {
          const preview = content.text.length > 500
            ? content.text.substring(0, 500) + '...'
            : content.text;
          this.deps.logger.log(`    ${preview}\n`, { type: 'info' });
        } else if ('blob' in content && content.blob) {
          this.deps.logger.log(`    [Binary data, ${(content as any).blob.length} bytes base64]\n`, { type: 'info' });
        }
      }

      // Record the injection to the iteration-level resources.yaml
      if (iterationDir && phaseName) {
        const contentParts: string[] = [];
        for (const content of result.contents) {
          if ('text' in content && content.text) {
            contentParts.push(content.text);
          } else if ('blob' in content && content.blob) {
            contentParts.push(`[Binary data, ${(content as any).blob.length} bytes base64]`);
          }
        }
        this.deps.ablationManager.appendResourceInjection(
          iterationDir,
          phaseName,
          nameArg,
          resolved.uri,
          contentParts.join('\n'),
          resourceArgs,
        );
      }

      this.deps.logger.log(`  ✓ Injected resource "${nameArg}" (${result.contents.length} content block(s)) into context\n`, { type: 'success' });
      return {};
    }

    // Handle @insert-prompt:<server__promptName> — fetch prompt and run agent session
    if (trimmedCommand.startsWith('@insert-prompt:')) {
      const suffix = trimmedCommand.slice('@insert-prompt:'.length).trim();
      if (!suffix) {
        throw new Error('Usage: @insert-prompt:server__promptName or @insert-prompt:server__promptName(arg=val)');
      }

      // Parse prompt name and optional arguments
      // Supports: name, name(arg='val'), name {"arg":"val"}
      let nameArg: string;
      let promptArgs: Record<string, string> | undefined;

      const pythonMatch = suffix.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*\((.*)\)\s*$/);
      const jsonMatch = suffix.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s+(\{.*\})\s*$/);
      const simpleMatch = suffix.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*$/);

      if (pythonMatch) {
        nameArg = pythonMatch[1];
        const argsStr = pythonMatch[2].trim();
        if (argsStr) {
          promptArgs = parsePythonArgs(argsStr) as Record<string, string>;
        }
      } else if (jsonMatch) {
        nameArg = jsonMatch[1];
        try {
          promptArgs = JSON.parse(jsonMatch[2]);
        } catch {
          throw new Error(`Invalid JSON arguments in @insert-prompt: ${jsonMatch[2]}`);
        }
      } else if (simpleMatch) {
        nameArg = simpleMatch[1];
      } else {
        // Fallback: treat entire suffix as prompt name (may fail lookup, handled below)
        nameArg = suffix.split(/[\s(]/)[0];
      }

      if (dryRun) {
        this.deps.logger.log(`    ⚠ Skipping @insert-prompt in dry run (no model): ${nameArg}\n`, { type: 'warning' });
        return {};
      }

      const prompts = this.deps.client.listPrompts();
      const promptMgr = this.deps.client.getPromptManager();
      const enabledPrompts = promptMgr.filterPrompts(prompts);
      let promptInfo = prompts.find(p => `${p.server}__${p.prompt.name}` === nameArg);

      // Stale reference — ask user to pick replacement
      if (!promptInfo) {
        const rl = this.host.getReadline();
        if (!rl || enabledPrompts.length === 0) {
          throw new Error(`Prompt not found: ${nameArg} (no prompts available or no readline)`);
        }

        this.deps.logger.log(`\n  ⚠ Stale prompt reference: "${nameArg}" — select a replacement:\n`, { type: 'warning' });
        await this.showPromptListForPreview();

        const selection = (await rl.question('  Select prompt number: ')).trim();
        const selectedIdx = parseInt(selection) - 1;

        if (isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= enabledPrompts.length) {
          throw new Error(`Invalid prompt selection: ${selection}`);
        }

        promptInfo = enabledPrompts[selectedIdx];
        const newPromptKey = `${promptInfo.server}__${promptInfo.prompt.name}`;

        // Update the ablation YAML to replace the stale command
        if (ablation && phaseName) {
          const phase = ablation.phases.find(p => p.name === phaseName);
          if (phase) {
            const cmdIdx = phase.commands.indexOf(trimmedCommand);
            if (cmdIdx !== -1) {
              phase.commands[cmdIdx] = promptArgs
                ? `@insert-prompt:${newPromptKey} ${JSON.stringify(promptArgs)}`
                : `@insert-prompt:${newPromptKey}`;
              this.deps.ablationManager.save(ablation);
              this.deps.logger.log(`  ✓ Updated ablation YAML: ${nameArg} → ${newPromptKey}\n`, { type: 'success' });
            }
          }
        }
      }

      const promptResult = await this.deps.client.getPrompt(
        promptInfo.server,
        promptInfo.prompt.name,
        promptArgs,
      );
      if (promptResult?.messages) {
        // For agent-driven ablation phases: load phase hooks so @complete-phase works
        const hookMgr = this.deps.client.getHookManager();
        let ablHooksLoaded = false;
        if (ablation && phaseName) {
          const phaseHooks = this.deps.ablationManager.getHooksForPhase(ablation, phaseName);
          if (phaseHooks.length > 0) {
            hookMgr.loadAblationHooks(phaseHooks);
            hookMgr.setCurrentPhaseName(phaseName);
            hookMgr.resetPhaseComplete();
            hookMgr.resetAbortRun();
            ablHooksLoaded = true;
          }
        }

        try {
          // Include any pending attachments with the first prompt message
          const promptAttachments = this.host.getPendingAttachments();
          let attachmentsConsumed = false;

          for (const msg of promptResult.messages) {
            if (msg.content.type === 'text') {
              const cancellationCheck = () => hookMgr.isPhaseCompleteRequested() || hookMgr.isAbortRunRequested() || hookMgr.hasPendingInjection() || hookMgr.hasPendingDirectives() || this.control.isAbortRequested() || this.control.isInterruptRequested();

              // Resume loop: after pause+resume, re-invoke processQuery so the agent can continue
              let isFirstAttempt = true;
              let continueAfterPause = false;

              do {
                // Reset interrupt flag so Ctrl+A works reliably on each iteration.
                // Same rationale as the command loop reset — prevents stale flag from
                // blocking the keyboard monitor's Ctrl+A guard.
                if (!isFirstAttempt) this.control.resetInterrupt();

                const queryText = isFirstAttempt ? msg.content.text : 'Continue from where you left off.';
                const attachments = (isFirstAttempt && !attachmentsConsumed && promptAttachments.length > 0)
                  ? promptAttachments : undefined;

                // Log user prompt to chat history (ablation path doesn't go through cli-client)
                this.deps.client.getChatHistoryManager().addUserMessage(queryText,
                  attachments?.map(a => ({ fileName: a.fileName, ext: a.ext, mediaType: a.mediaType })));

                await this.deps.client.processQuery(queryText, false, attachments, cancellationCheck);

                if (isFirstAttempt && !attachmentsConsumed && promptAttachments.length > 0) {
                  attachmentsConsumed = true;
                  this.host.setPendingAttachments([]);
                }
                isFirstAttempt = false;
                continueAfterPause = false;

                // Handle soft interrupt (Ctrl+A): let user send messages or run commands
                // Loop stays active until explicit resume (Enter) or abort (Ctrl+C)
                // Skip if phase is already complete — @complete-phase takes priority over interrupt
                if (this.control.isInterruptRequested() && !this.control.isAbortRequested()
                    && !hookMgr.isPhaseCompleteRequested() && !hookMgr.isAbortRunRequested()) {
                  this.control.resetInterrupt();
                  // Log pause event to chat history
                  this.deps.client.getChatHistoryManager().addUserInteractionEvent('pause', 'ctrl-a');
                  this.host.stopKeyboardMonitor();

                  if (this.host.getReadline()) {
                    this.deps.logger.log('\n  ⏸ Agent paused. Type a message, /command, or press Enter to resume. (/help for commands)\n', { type: 'warning' });

                    let paused = true;
                    while (paused && !this.control.isAbortRequested()
                        && !hookMgr.isPhaseCompleteRequested() && !hookMgr.isAbortRunRequested()) {
                      // Re-fetch readline each iteration — stopKeyboardMonitor() recreates it
                      const rl = this.host.getReadline()!;
                      const userInput = (await rl.question('  You: ')).trim();

                      // Check for exit — trigger graceful abort (same as Ctrl+C)
                      if (this.isExitCommand(userInput)) {
                        this.deps.client.getChatHistoryManager().addUserInteractionEvent('abort', 'exit-command');
                        this.deps.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
                        process.emit('SIGINT', 'SIGINT');
                        paused = false;
                        break;
                      }

                      const stopCond = () => hookMgr.isPhaseCompleteRequested() || hookMgr.isAbortRunRequested() || hookMgr.hasPendingInjection() || hookMgr.hasPendingDirectives() || this.control.isAbortRequested() || this.control.isInterruptRequested();

                      // Re-enable keyboard monitor during processQuery so Ctrl+A works,
                      // then stop it again so readline can prompt the next input.
                      this.host.startKeyboardMonitor();
                      const result = await this.handlePauseInput(userInput, stopCond);
                      this.control.resetInterrupt();
                      this.host.stopKeyboardMonitor();

                      if (result === 'resume') {
                        this.deps.client.getChatHistoryManager().addUserInteractionEvent('resume', 'user-input');
                        continueAfterPause = true;
                        paused = false;
                      }
                      // 'handled' → stay in pause loop, prompt again
                    }
                  }

                  this.host.startKeyboardMonitor();
                }
              } while (continueAfterPause
                && !hookMgr.isPhaseCompleteRequested()
                && !hookMgr.isAbortRunRequested()
                && !this.control.isAbortRequested());

              // Stop processing further messages if phase complete or aborted
              if (hookMgr.isPhaseCompleteRequested() || hookMgr.isAbortRunRequested() || this.control.isAbortRequested()) break;
            }
          }
        } finally {
          if (ablHooksLoaded) hookMgr.clearAblationHooks();
        }

        if (hookMgr.isAbortRunRequested()) {
          hookMgr.resetAbortRun();
          return { abortRun: true };
        }

        if (hookMgr.isPhaseCompleteRequested()) {
          hookMgr.resetPhaseComplete();
          return { phaseComplete: true };
        }

        if (hookMgr.isEscalateRequested()) {
          hookMgr.resetEscalate();
          return { escalate: true };
        }
        if (hookMgr.isSwitchModelRequested()) {
          hookMgr.resetSwitchModel();
          return { switchModel: true };
        }

        // Consume pending directives from hooks (attachment/prompt injections)
        const pendingResult = await this.consumePendingHookDirectives(hookMgr, maxIterations, ablation, phaseName, iterationDir);
        if (pendingResult) return pendingResult;

        // Agent stopped responding without @complete-phase or @abort.
        // Check if signal_phase_complete(success) was already called with requires_response: false
        // but @complete-phase hook didn't fire (can happen with batched tool calls).
        if (ablation && phaseName && this.deps.client.getChatHistoryManager().hasRecentSuccessfulPhaseSignal()) {
          this.deps.logger.log(`  ℹ Phase "${phaseName}": signal_phase_complete(success) already accepted — completing phase\n`, { type: 'info' });
          this.deps.client.getChatHistoryManager().addPhaseEvent('phase-complete', phaseName, { after: 'signal-fallback' });
          return { phaseComplete: true };
        }

        // Nudge it once — if it still doesn't signal, abort.
        if (ablation && phaseName && !this.control.isAbortRequested()) {
          const nudgeMsg = this.deps.client.lastQueryHitIterationLimit()
            ? `You stopped without signaling phase completion. Call signal_phase_complete with status "success" if the phase objectives were met, or status "failure" if they were not. Do not continue working — just signal.`
            : `You stopped without signaling phase completion. Call signal_phase_complete with status "success" if the phase objectives were met, if not continue finishing the objective. If you are not able to complete the objective signal failure.`;
          this.deps.logger.log(`  ℹ Phase "${phaseName}": nudging agent to signal phase completion\n`, { type: 'info' });
          this.deps.client.getChatHistoryManager().addUserMessage(nudgeMsg);
          const nudgeCancel = () => hookMgr.isPhaseCompleteRequested() || hookMgr.isAbortRunRequested() || this.control.isAbortRequested();
          await this.deps.client.processQuery(nudgeMsg, false, undefined, nudgeCancel);

          // Check if the nudge worked
          if (hookMgr.isPhaseCompleteRequested()) {
            hookMgr.resetPhaseComplete();
            return { phaseComplete: true };
          }
          if (hookMgr.isAbortRunRequested()) {
            hookMgr.resetAbortRun();
            return { abortRun: true };
          }
          if (hookMgr.isEscalateRequested()) {
            hookMgr.resetEscalate();
            return { escalate: true };
        }
        if (hookMgr.isSwitchModelRequested()) {
          hookMgr.resetSwitchModel();
          return { switchModel: true };
          }
          // Fallback: check if signal_phase_complete(success) was called during nudge
          // but @complete-phase hook didn't fire (batched tool calls)
          if (this.deps.client.getChatHistoryManager().hasRecentSuccessfulPhaseSignal()) {
            this.deps.logger.log(`  ℹ Phase "${phaseName}": signal_phase_complete(success) accepted after nudge — completing phase\n`, { type: 'info' });
            this.deps.client.getChatHistoryManager().addPhaseEvent('phase-complete', phaseName, { after: 'signal-fallback-post-nudge' });
            return { phaseComplete: true };
          }
          // Nudge didn't work — escalate if escalation enabled, otherwise abort
          if (ablation?.escalation) {
            this.deps.logger.log(`  ⤴ Phase "${phaseName}": agent did not signal after nudge — escalating to next model\n`, { type: 'warning' });
            this.deps.client.getChatHistoryManager().addPhaseEvent('phase-escalate', phaseName, { after: 'agent-stopped' });
            return { escalate: true };
          }
          this.deps.logger.log(`  ⚠ Phase "${phaseName}": agent still did not signal after nudge — aborting remaining phases\n`, { type: 'warning' });
          this.deps.client.getChatHistoryManager().addPhaseEvent('phase-abort', phaseName, { after: 'agent-stopped' });
          return { abortRun: true };
        }
      }
      return {};
    }

    // Handle @insert-attachment:<filename|index> — queue attachment for next query
    if (trimmedCommand.startsWith('@insert-attachment:')) {
      const argValue = trimmedCommand.slice('@insert-attachment:'.length).trim();
      if (!argValue) {
        throw new Error('Usage: @insert-attachment:filename or @insert-attachment:1');
      }

      if (dryRun) {
        this.deps.logger.log(`    ⚠ Skipping @insert-attachment in dry run (no model): ${argValue}\n`, { type: 'warning' });
        return {};
      }

      const attachments = this.deps.attachmentManager.listAttachments();
      let attachment;

      const attachmentIndex = parseInt(argValue);
      if (!isNaN(attachmentIndex) && String(attachmentIndex) === argValue) {
        // It's an index (1-based)
        const idx = attachmentIndex - 1;
        if (idx < 0 || idx >= attachments.length) {
          throw new Error(`Invalid attachment index: ${argValue}`);
        }
        attachment = attachments[idx];
      } else {
        // It's a filename
        attachment = attachments.find((a) => a.fileName === argValue);
        if (!attachment) {
          throw new Error(`Attachment not found: ${argValue}`);
        }
      }

      const pendingAttachments = this.host.getPendingAttachments();
      pendingAttachments.push(attachment);
      this.host.setPendingAttachments(pendingAttachments);
      return {};
    }

    // Handle @clear-attachments — clear pending attachment queue
    if (trimmedCommand === '@clear-attachments') {
      this.host.setPendingAttachments([]);
      return {};
    }

    // Handle unknown slash commands (warn but continue)
    if (trimmedCommand.startsWith('/')) {
      this.deps.logger.log(`  Warning: Unknown command "${trimmedCommand}", skipping\n`, {
        type: 'warning',
      });
    } else if (trimmedCommand.startsWith('@')) {
      // Unknown @ directive
      this.deps.logger.log(`  Warning: Unknown directive "${trimmedCommand}", skipping\n`, {
        type: 'warning',
      });
    } else {
      // Regular query - send to model
      if (dryRun) {
        this.deps.logger.log(`    ⚠ Skipping query in dry run (no model): ${trimmedCommand}\n`, { type: 'warning' });
        return {};
      }

      // For agent-driven ablation phases: load phase hooks into HookManager
      // so they fire during processQuery's tool calls
      const hookManager = this.deps.client.getHookManager();
      let ablationHooksLoaded = false;
      if (ablation && phaseName) {
        const phaseHooks = this.deps.ablationManager.getHooksForPhase(ablation, phaseName);
        if (phaseHooks.length > 0) {
          hookManager.loadAblationHooks(phaseHooks);
          hookManager.setCurrentPhaseName(phaseName);
          hookManager.resetPhaseComplete();
          hookManager.resetAbortRun();
          ablationHooksLoaded = true;
        }
      }

      const pendingAttachments = this.host.getPendingAttachments();
      try {
        // Resume loop: after pause+resume, re-invoke processQuery so the agent can continue
        let isFirstAttempt = true;
        let continueAfterPause = false;
        const cancellationCheck = () => hookManager.isPhaseCompleteRequested() || hookManager.isAbortRunRequested() || hookManager.hasPendingInjection() || hookManager.hasPendingDirectives() || this.control.isAbortRequested() || this.control.isInterruptRequested();

        do {
          // Reset interrupt flag so Ctrl+A works reliably on each iteration.
          // Same rationale as the command loop reset — prevents stale flag from
          // blocking the keyboard monitor's Ctrl+A guard.
          if (!isFirstAttempt) this.control.resetInterrupt();

          const query = isFirstAttempt ? trimmedCommand : 'Continue from where you left off.';
          const atts = isFirstAttempt
            ? (pendingAttachments.length > 0 ? pendingAttachments : undefined)
            : undefined;

          // Log user prompt to chat history (ablation path doesn't go through cli-client)
          this.deps.client.getChatHistoryManager().addUserMessage(query,
            atts?.map(a => ({ fileName: a.fileName, ext: a.ext, mediaType: a.mediaType })));

          await this.deps.client.processQuery(query, false, atts, cancellationCheck);
          isFirstAttempt = false;
          continueAfterPause = false;

          // Handle soft interrupt (Ctrl+A): let user send messages or run commands
          // Stay in raw mode to prevent Ctrl+C from sending OS SIGINT to child processes
          // Loop stays active until explicit resume (Enter) or abort (Ctrl+C)
          // Skip if phase/abort already signaled — those take priority over interrupt
          if (this.control.isInterruptRequested() && !this.control.isAbortRequested()
              && !hookManager.isPhaseCompleteRequested() && !hookManager.isAbortRunRequested()) {
            this.control.resetInterrupt();
            this.deps.client.getChatHistoryManager().addUserInteractionEvent('pause', 'ctrl-a');
            this.deps.logger.log('\n  ⏸ Agent paused. Type a message, /command, or press Enter to resume. (/help for commands)\n', { type: 'warning' });

            let paused = true;
            while (paused && !this.control.isAbortRequested()
                && !hookManager.isPhaseCompleteRequested() && !hookManager.isAbortRunRequested()) {
              const userInput = await this.host.collectInput('  You: ');

              // null means Ctrl+C was pressed — treat as abort
              if (userInput === null) {
                paused = false;
                break;
              }

              // Check for exit — trigger graceful abort (same as Ctrl+C)
              if (this.isExitCommand(userInput)) {
                this.deps.client.getChatHistoryManager().addUserInteractionEvent('abort', 'exit-command');
                this.deps.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
                process.emit('SIGINT', 'SIGINT');
                paused = false;
                break;
              }

              const stopCond = () => hookManager.isPhaseCompleteRequested() || hookManager.isAbortRunRequested() || hookManager.hasPendingInjection() || hookManager.hasPendingDirectives() || this.control.isAbortRequested() || this.control.isInterruptRequested();
              const result = await this.handlePauseInput(userInput, stopCond);
              // Reset interrupt flag so the next iteration's processQuery doesn't exit immediately
              this.control.resetInterrupt();
              if (result === 'resume') {
                this.deps.client.getChatHistoryManager().addUserInteractionEvent('resume', 'user-input');
                continueAfterPause = true;
                paused = false;
              }
              // 'handled' → stay in pause loop, prompt again
            }
          }
        } while (continueAfterPause
          && !hookManager.isPhaseCompleteRequested()
          && !hookManager.isAbortRunRequested()
          && !this.control.isAbortRequested());
      } finally {
        // Cleanup: remove temporary ablation hooks
        if (ablationHooksLoaded) {
          hookManager.clearAblationHooks();
        }
      }
      // Clear attachments after use
      this.host.setPendingAttachments([]);

      // Check if abort run was signaled during processQuery
      if (hookManager.isAbortRunRequested()) {
        hookManager.resetAbortRun();
        return { abortRun: true };
      }

      // Check if phase completion was signaled during processQuery
      if (hookManager.isPhaseCompleteRequested()) {
        hookManager.resetPhaseComplete();
        return { phaseComplete: true };
      }

      if (hookManager.isEscalateRequested()) {
        hookManager.resetEscalate();
        return { escalate: true };
      }
      if (hookManager.isSwitchModelRequested()) {
        hookManager.resetSwitchModel();
        return { switchModel: true };
      }

      // Consume pending directives from hooks (attachment/prompt injections)
      const pendingResult = await this.consumePendingHookDirectives(hookManager, maxIterations, ablation, phaseName, iterationDir);
      if (pendingResult) return pendingResult;

      // Agent stopped responding without @complete-phase or @abort.
      // Check if signal_phase_complete(success) was already called with requires_response: false
      // but @complete-phase hook didn't fire (can happen with batched tool calls).
      if (ablation && phaseName && this.deps.client.getChatHistoryManager().hasRecentSuccessfulPhaseSignal()) {
        this.deps.logger.log(`  ℹ Phase "${phaseName}": signal_phase_complete(success) already accepted — completing phase\n`, { type: 'info' });
        this.deps.client.getChatHistoryManager().addPhaseEvent('phase-complete', phaseName, { after: 'signal-fallback' });
        return { phaseComplete: true };
      }

      // Nudge it once — if it still doesn't signal, abort.
      if (ablation && phaseName && !this.control.isAbortRequested()) {
        const nudgeMsg = this.deps.client.lastQueryHitIterationLimit()
          ? `You stopped without signaling phase completion. Call signal_phase_complete with status "success" if the phase objectives were met, or status "failure" if they were not. Do not continue working — just signal.`
          : `You stopped without signaling phase completion. Call signal_phase_complete with status "success" if the phase objectives were met, if not continue finishing the objective. If you are not able to complete the objective signal failure.`;
        this.deps.logger.log(`  ℹ Phase "${phaseName}": nudging agent to signal phase completion\n`, { type: 'info' });
        this.deps.client.getChatHistoryManager().addUserMessage(nudgeMsg);
        const nudgeCancel = () => hookManager.isPhaseCompleteRequested() || hookManager.isAbortRunRequested() || this.control.isAbortRequested();
        await this.deps.client.processQuery(nudgeMsg, false, undefined, nudgeCancel);

        // Check if the nudge worked
        if (hookManager.isPhaseCompleteRequested()) {
          hookManager.resetPhaseComplete();
          return { phaseComplete: true };
        }
        if (hookManager.isAbortRunRequested()) {
          hookManager.resetAbortRun();
          return { abortRun: true };
        }
        if (hookManager.isEscalateRequested()) {
          hookManager.resetEscalate();
          return { escalate: true };
        }
        if (hookManager.isSwitchModelRequested()) {
          hookManager.resetSwitchModel();
          return { switchModel: true };
        }
        // Fallback: check if signal_phase_complete(success) was called during nudge
        // but @complete-phase hook didn't fire (batched tool calls)
        if (this.deps.client.getChatHistoryManager().hasRecentSuccessfulPhaseSignal()) {
          this.deps.logger.log(`  ℹ Phase "${phaseName}": signal_phase_complete(success) accepted after nudge — completing phase\n`, { type: 'info' });
          this.deps.client.getChatHistoryManager().addPhaseEvent('phase-complete', phaseName, { after: 'signal-fallback-post-nudge' });
          return { phaseComplete: true };
        }
        // Nudge didn't work — escalate if escalation enabled, otherwise abort
        if (ablation?.escalation) {
          this.deps.logger.log(`  ⤴ Phase "${phaseName}": agent did not signal after nudge — escalating to next model\n`, { type: 'warning' });
          this.deps.client.getChatHistoryManager().addPhaseEvent('phase-escalate', phaseName, { after: 'agent-stopped' });
          return { escalate: true };
        }
        this.deps.logger.log(`  ⚠ Phase "${phaseName}": agent still did not signal after nudge — aborting remaining phases\n`, { type: 'warning' });
        this.deps.client.getChatHistoryManager().addPhaseEvent('phase-abort', phaseName, { after: 'agent-stopped' });
        return { abortRun: true };
      }
    }

    return {};
  }

  // ───────── moved from AblationCLI.consumePendingHookDirectives (Slice 3 Pass A) ─────────
  private async consumePendingHookDirectives(
    hookMgr: HookManager,
    maxIterations: number,
    ablation?: AblationDefinition,
    phaseName?: string,
    iterationDir?: string,
  ): Promise<AblationCommandResult | null> {
    if (!hookMgr.hasPendingDirectives()) return null;

    // Process @clear-attachments first
    if (hookMgr.isPendingClearAttachments()) {
      this.host.setPendingAttachments([]);
      hookMgr.resetPendingClearAttachments();
      this.deps.logger.log(`    Hook: cleared pending attachments\n`, { type: 'info' });
    }

    // Process @insert-attachment: directives
    const pendingAttachments = hookMgr.getPendingAttachmentInsertions();
    if (pendingAttachments.length > 0) {
      hookMgr.resetPendingAttachmentInsertions();
      for (const cmd of pendingAttachments) {
        this.deps.logger.log(`    Hook: executing ${cmd}\n`, { type: 'info' });
        await this.executeAblationCommand(cmd, maxIterations, false, ablation, phaseName, iterationDir);
      }
    }

    // Process pending client prompt from hook/gate prompt: field
    const pendingClientPrompt = hookMgr.getPendingClientPrompt();
    if (pendingClientPrompt) {
      hookMgr.resetPendingClientPrompt();
      this.deps.client.injectClientPrompt(pendingClientPrompt.text, pendingClientPrompt.source);
      this.deps.logger.log(`    Hook: client prompt injected (${pendingClientPrompt.source})\n`, { type: 'info' });
    }

    // Process @insert-prompt: directive (spawns a new agent session)
    const pendingPrompt = hookMgr.getPendingPromptInsertion();
    if (pendingPrompt) {
      hookMgr.resetPendingPromptInsertion();
      this.deps.logger.log(`    Hook: executing ${pendingPrompt}\n`, { type: 'info' });
      return await this.executeAblationCommand(pendingPrompt, maxIterations, false, ablation, phaseName, iterationDir);
    }

    return null;
  }

  // ───────── moved from AblationCLI.savePhaseChatHistory (Slice 3 Pass A) ─────────
  private savePhaseChatHistory(
    endReason: string,
    runDir: string,
    phaseName: string,
    phaseDir: string,
    model: AblationModel,
    result: AblationRunResult,
    hasMultipleIterations: boolean,
    iteration: number,
  ): void {
    const chatHistoryManager = this.deps.client.getChatHistoryManager();
    const serverLogs = this.deps.client.getServerLogManager().getServerLogsMapping();
    if (serverLogs) {
      chatHistoryManager.setServerLogs(serverLogs);
    }
    const chatMetadata = chatHistoryManager.endSession(endReason);

    if (chatMetadata) {
      // Compute relative chat path from runDir to phaseDir
      // Escalation mode: phaseDir = {runDir}/{phase}/(run-{I}--)?attempt-N--{model}/
      // Normal mode:     phaseDir = {runDir}/{model}/(run-N/){phase}/
      const relativeChatPath = phaseDir.startsWith(runDir)
        ? phaseDir.slice(runDir.length + 1) + '/chat.json'
        : (() => {
            const modelDir = this.deps.ablationManager.getModelDirName(model);
            const phaseSanitized = sanitizeFolderName(phaseName);
            const runPrefix = hasMultipleIterations ? `run-${iteration}/` : '';
            return `${modelDir}/${runPrefix}${phaseSanitized}/chat.json`;
          })();
      const destJsonPath = join(phaseDir, 'chat.json');
      const destMdPath = join(phaseDir, 'chat.md');

      try {
        if (existsSync(chatMetadata.filePath)) cpSync(chatMetadata.filePath, destJsonPath);
        if (existsSync(chatMetadata.mdFilePath)) cpSync(chatMetadata.mdFilePath, destMdPath);
        result.chatFile = relativeChatPath;

        // Copy server logs to phase directory
        const serverLogManager = this.deps.client.getServerLogManager();
        serverLogManager.copyLogsToDir(phaseDir);
      } catch (copyError) {
        this.deps.logger.log(`  Warning: Failed to copy chat files to run directory: ${copyError}\n`, { type: 'warning' });
        result.chatFile = chatMetadata.filePath;
      }
    }
  }

  // ───────── moved from AblationCLI.resolvePromptReference (Slice 3 Pass A) ─────────
  private async resolvePromptReference(
    value: string,
    resolvedArguments?: Record<string, string>,
  ): Promise<string> {
    // Substitute argument placeholders first
    let resolved = value;
    if (resolvedArguments) {
      resolved = this.deps.ablationManager.substituteArguments([resolved], resolvedArguments)[0];
    }

    const trimmed = resolved.trim();

    // Handle @insert-resource: references
    if (trimmed.startsWith('@insert-resource:')) {
      return this.resolveResourceReference(trimmed);
    }

    if (!trimmed.startsWith('@insert-prompt:')) {
      return resolved;
    }

    // Parse the @insert-prompt: reference and fetch the prompt content
    const suffix = trimmed.slice('@insert-prompt:'.length).trim();
    if (!suffix) {
      throw new Error('Empty @insert-prompt: reference in systemPrompt/userPrompt');
    }

    // Parse prompt name and optional arguments (same logic as executeAblationCommand)
    let nameArg: string;
    let promptArgs: Record<string, string> | undefined;

    const pythonMatch = suffix.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*\((.*)\)\s*$/);
    const jsonMatch = suffix.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s+(\{.*\})\s*$/);
    const simpleMatch = suffix.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*$/);

    if (pythonMatch) {
      nameArg = pythonMatch[1];
      const argsStr = pythonMatch[2].trim();
      if (argsStr) {
        promptArgs = parsePythonArgs(argsStr) as Record<string, string>;
      }
    } else if (jsonMatch) {
      nameArg = jsonMatch[1];
      try {
        promptArgs = JSON.parse(jsonMatch[2]);
      } catch {
        throw new Error(`Invalid JSON arguments in @insert-prompt: ${jsonMatch[2]}`);
      }
    } else if (simpleMatch) {
      nameArg = simpleMatch[1];
    } else {
      nameArg = suffix.split(/[\s(]/)[0];
    }

    const prompts = this.deps.client.listPrompts();
    const promptInfo = prompts.find(p => `${p.server}__${p.prompt.name}` === nameArg);
    if (!promptInfo) {
      throw new Error(`Prompt not found: ${nameArg}`);
    }

    const promptResult = await this.deps.client.getPrompt(
      promptInfo.server,
      promptInfo.prompt.name,
      promptArgs,
    );

    if (!promptResult?.messages?.length) {
      throw new Error(`Prompt returned no messages: ${nameArg}`);
    }

    // Concatenate all text content from prompt messages
    return promptResult.messages
      .map((m: any) => {
        if (typeof m.content === 'string') return m.content;
        if (m.content?.type === 'text') return m.content.text;
        if (Array.isArray(m.content)) {
          return m.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  // ───────── moved from AblationCLI.resolveResourceReference (Slice 3 Pass A) ─────────
  private async resolveResourceReference(reference: string): Promise<string> {
    const suffix = reference.slice('@insert-resource:'.length).trim();
    if (!suffix) {
      throw new Error('Empty @insert-resource: reference in systemPrompt/userPrompt');
    }

    let nameArg: string;
    let resourceArgs: Record<string, string> | undefined;

    const pythonMatch = suffix.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*\((.*)\)\s*$/);
    const jsonMatch = suffix.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s+(\{.*\})\s*$/);

    if (pythonMatch) {
      nameArg = pythonMatch[1];
      const argsStr = pythonMatch[2].trim();
      if (argsStr) {
        resourceArgs = parsePythonArgs(argsStr) as Record<string, string>;
      }
    } else if (jsonMatch) {
      nameArg = jsonMatch[1];
      try {
        resourceArgs = JSON.parse(jsonMatch[2]);
      } catch {
        throw new Error(`Invalid JSON arguments in @insert-resource: ${jsonMatch[2]}`);
      }
    } else {
      nameArg = suffix.split(/[\s(]/)[0];
    }

    const resolved = this.findResourceOrTemplate(nameArg, resourceArgs);

    if (!resolved) {
      throw new Error(`Resource not found: ${nameArg}`);
    }

    const result = await this.deps.client.readResource(resolved.server, resolved.uri);

    const parts: string[] = [];
    if (resolved.description) {
      parts.push(resolved.description);
    }
    for (const content of result.contents) {
      if ('text' in content && content.text) {
        parts.push(content.text);
      } else if ('blob' in content && content.blob) {
        parts.push(`[Binary data, ${(content as any).blob.length} bytes base64]`);
      }
    }

    if (parts.length === 0) {
      throw new Error(`Resource returned no text content: ${nameArg}`);
    }

    return parts.join('\n');
  }

  // ───────── moved from AblationCLI.findResourceOrTemplate (Slice 3 Pass A) ─────────
  private findResourceOrTemplate(nameArg: string, args?: Record<string, string>): { server: string; uri: string; description?: string } | null {
    // Search concrete resources first
    const allResources = this.deps.client.listResources();
    let match = allResources.find(r => `${r.server}__${r.resource.name}` === nameArg);
    if (match) return { server: match.server, uri: match.resource.uri, description: match.resource.description };

    match = allResources.find(r => r.resource.uri === nameArg);
    if (match) return { server: match.server, uri: match.resource.uri, description: match.resource.description };

    // Search resource templates — match by server__name key or uriTemplate
    const allTemplates = this.deps.client.listResourceTemplates();
    let tmatch = allTemplates.find(t => `${t.server}__${t.template.name}` === nameArg);
    if (tmatch) {
      let uri = tmatch.template.uriTemplate;
      if (args) {
        for (const [key, value] of Object.entries(args)) {
          uri = uri.replace(`{${key}}`, value);
        }
      }
      return { server: tmatch.server, uri, description: tmatch.template.description };
    }

    tmatch = allTemplates.find(t => t.template.uriTemplate === nameArg);
    if (tmatch) return { server: tmatch.server, uri: tmatch.template.uriTemplate, description: tmatch.template.description };

    return null;
  }

  // ───────── moved from AblationCLI.createProviderInstance (Slice 3 Pass A) ─────────
  private createProviderInstance(providerName: string): ModelProvider {
    const provider = createProvider(providerName);
    if (!provider) {
      const available = PROVIDERS.map(p => p.name).join(', ');
      throw new Error(`Unknown provider: ${providerName}. Available: ${available}`);
    }
    return provider;
  }

  // ───────── moved from AblationCLI.displayFinalResults (Slice 3 Pass A) ─────────
  private displayFinalResults(run: AblationRun, ablation: AblationDefinition): void {
    const hasMultipleIterations = (ablation.runs ?? 1) > 1;
    const isDryRun = ablation.dryRun;
    const showTokens = !isDryRun;

    // Group results by model key
    const modelGroups = new Map<string, { model: AblationModel; results: AblationRunResult[] }>();
    for (const r of run.results) {
      const key = `${r.model.provider}/${r.model.model}`;
      if (!modelGroups.has(key)) {
        modelGroups.set(key, { model: r.model, results: [] });
      }
      modelGroups.get(key)!.results.push(r);
    }

    let totalPassedIterations = 0;
    let totalIterations = 0;

    for (const [, { model, results }] of modelGroups) {
      const modelDisplayName = isDryRun ? 'dry-run' : model.model;
      const providerSuffix = isDryRun ? '' : ` (${model.provider})`;

      if (hasMultipleIterations) {
        // Multi-iteration: show model header, then per-iteration tables
        this.deps.logger.log(`\n  ${modelDisplayName}${providerSuffix}\n`, { type: 'info' });
        this.deps.logger.log(`  ${'─'.repeat(modelDisplayName.length + providerSuffix.length)}\n`, { type: 'info' });

        // Group by iteration
        const iterGroups = new Map<number, AblationRunResult[]>();
        for (const r of results) {
          const iter = r.run ?? 1;
          if (!iterGroups.has(iter)) {
            iterGroups.set(iter, []);
          }
          iterGroups.get(iter)!.push(r);
        }

        let modelPassedIterations = 0;
        const modelTotalIterations = iterGroups.size;
        let modelDuration = 0;
        let modelTokens = 0;

        for (const [iter, iterResults] of iterGroups) {
          const completedPhases = iterResults.filter(r => r.status === 'completed').length;
          const totalPhases = iterResults.length;
          const iterDuration = iterResults.reduce((sum, r) => sum + (r.duration || 0), 0);
          const iterPassed = completedPhases === totalPhases;

          if (iterPassed) modelPassedIterations++;
          modelDuration += iterDuration;
          modelTokens += iterResults.reduce((sum, r) => sum + (r.tokens || 0), 0);

          this.deps.logger.log(`\n  Iteration ${iter} — ${completedPhases}/${totalPhases} phases │ ${formatDuration(iterDuration)}\n`, { type: 'info' });
          this.renderPhaseTable(iterResults, showTokens);
        }

        totalPassedIterations += modelPassedIterations;
        totalIterations += modelTotalIterations;

        const tokenSuffix = showTokens ? ` │ ${this.formatTokenCount(modelTokens)} tokens` : '';
        this.deps.logger.log(`\n  Model total: ${modelPassedIterations}/${modelTotalIterations} iterations passed │ ${formatDuration(modelDuration)}${tokenSuffix}\n`, { type: 'info' });
      } else {
        // Single iteration: model header with inline stats, then one table
        const completedPhases = results.filter(r => r.status === 'completed').length;
        const totalPhases = results.length;
        const modelDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);
        const iterPassed = completedPhases === totalPhases;

        if (iterPassed) totalPassedIterations++;
        totalIterations++;

        const tokenSuffix = showTokens ? ` │ ${this.formatTokenCount(results.reduce((sum, r) => sum + (r.tokens || 0), 0))} tokens` : '';
        this.deps.logger.log(`\n  ${modelDisplayName}${providerSuffix} — ${completedPhases}/${totalPhases} phases │ ${formatDuration(modelDuration)}${tokenSuffix}\n`, { type: 'info' });
        this.renderPhaseTable(results, showTokens);
      }
    }

    // Grand total
    const totalLabel = hasMultipleIterations ? 'iterations' : 'models';
    const tokenSuffix = showTokens && run.totalTokens ? ` │ ${this.formatTokenCount(run.totalTokens)} tokens` : '';
    this.deps.logger.log(`\n  Total: ${totalPassedIterations}/${totalIterations} ${totalLabel} passed │ ${formatDuration(run.totalDuration || 0)}${tokenSuffix}\n`, { type: 'info' });
  }

  // ───────── moved from AblationCLI.renderPhaseTable (Slice 3 Pass A) ─────────
  private renderPhaseTable(results: AblationRunResult[], showTokens: boolean): void {
    const statusSymbol = (status: string): string => {
      switch (status) {
        case 'completed': return '✓';
        case 'failed': return '✗';
        case 'skipped': return '⊘';
        case 'aborted': return '!';
        case 'escalated': return '⤴';
        default: return '?';
      }
    };

    // Compute column widths
    const phaseColWidth = Math.max(14, ...results.map(r => r.phase.length + 2));
    const hasAttempts = results.some(r => r.attempt);
    const statusColWidth = hasAttempts ? 18 : 8;
    const durationColWidth = 10;
    const tokenColWidth = 12;

    // Build header
    let headerCells = `│ ${'Phase'.padEnd(phaseColWidth - 2)} │ ${'Status'.padEnd(statusColWidth - 2)} │ ${'Duration'.padEnd(durationColWidth - 2)} │`;
    let topBorder = `┌${'─'.repeat(phaseColWidth)}┬${'─'.repeat(statusColWidth)}┬${'─'.repeat(durationColWidth)}┬`;
    let midBorder = `├${'─'.repeat(phaseColWidth)}┼${'─'.repeat(statusColWidth)}┼${'─'.repeat(durationColWidth)}┼`;
    let botBorder = `└${'─'.repeat(phaseColWidth)}┴${'─'.repeat(statusColWidth)}┴${'─'.repeat(durationColWidth)}┴`;

    if (showTokens) {
      headerCells += ` ${'Tokens'.padEnd(tokenColWidth - 2)} │`;
      topBorder += `${'─'.repeat(tokenColWidth)}┐`;
      midBorder += `${'─'.repeat(tokenColWidth)}┤`;
      botBorder += `${'─'.repeat(tokenColWidth)}┘`;
    } else {
      // Close the last column
      headerCells = headerCells.slice(0, -1) + '│';
      topBorder = topBorder.slice(0, -1) + '┐';
      midBorder = midBorder.slice(0, -1) + '┤';
      botBorder = botBorder.slice(0, -1) + '┘';
    }

    this.deps.logger.log(`  ${topBorder}\n`, { type: 'info' });
    this.deps.logger.log(`  ${headerCells}\n`, { type: 'info' });
    this.deps.logger.log(`  ${midBorder}\n`, { type: 'info' });

    for (const r of results) {
      const symbol = statusSymbol(r.status);
      const attemptInfo = r.attempt ? ` (attempt ${r.attempt})` : '';
      const duration = r.duration ? formatDuration(r.duration) : '—';
      let row = `│ ${r.phase.padEnd(phaseColWidth - 2)} │ ${(symbol + attemptInfo).padEnd(statusColWidth - 2)} │ ${duration.padEnd(durationColWidth - 2)} │`;
      if (showTokens) {
        const tokens = this.formatTokenCount(r.tokens);
        row += ` ${tokens.padEnd(tokenColWidth - 2)} │`;
      }
      this.deps.logger.log(`  ${row}\n`, { type: 'info' });
    }

    this.deps.logger.log(`  ${botBorder}\n`, { type: 'info' });

    // Show errors below the table
    const errors = results.filter(r => r.error && (r.status === 'failed' || r.status === 'aborted'));
    for (const r of errors) {
      this.deps.logger.log(`    Error: ${r.phase} — ${r.error}\n`, { type: 'warning' });
    }
  }

  // ───────── moved from AblationCLI.formatTokenCount (Slice 3 Pass A) ─────────
  private formatTokenCount(tokens: number | undefined): string {
    if (tokens === undefined || tokens === 0) return '—';
    return tokens.toLocaleString();
  }

  // ───────── moved from AblationCLI.showPromptListForPreview (Slice 3 Pass A) ─────────
  private async showPromptListForPreview(): Promise<void> {
    const allPrompts = this.deps.client.listPrompts();
    const promptManager = this.deps.client.getPromptManager();
    const enabledPrompts = promptManager.filterPrompts(allPrompts);

    if (enabledPrompts.length === 0) {
      this.deps.logger.log('\n    No enabled prompts available.\n', {
        type: 'warning',
      });
      return;
    }

    // Group prompts by server
    const promptsByServer = new Map<string, typeof enabledPrompts>();
    for (const promptData of enabledPrompts) {
      if (!promptsByServer.has(promptData.server)) {
        promptsByServer.set(promptData.server, []);
      }
      promptsByServer.get(promptData.server)!.push(promptData);
    }

    const sortedServers = Array.from(promptsByServer.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    this.deps.logger.log('\n    📝 Available Prompts:\n', { type: 'info' });

    let promptIndex = 1;
    for (const [serverName, serverPrompts] of sortedServers) {
      this.deps.logger.log(`\n    [${serverName}]:\n`, { type: 'info' });

      for (const promptData of serverPrompts) {
        const prompt = promptData.prompt;
        const argsInfo =
          prompt.arguments && prompt.arguments.length > 0
            ? ` (${prompt.arguments.length} arg${prompt.arguments.length > 1 ? 's' : ''})`
            : '';
        this.deps.logger.log(
          `      ${promptIndex}. ${prompt.name}${argsInfo}\n`,
          { type: 'info' },
        );
        if (prompt.description) {
          this.deps.logger.log(`         ${prompt.description}\n`, { type: 'info' });
        }
        promptIndex++;
      }
    }

    this.deps.logger.log(
      `\n    Enter prompt number(s) as next input (e.g., "3" or "1,3,5")\n`,
      { type: 'info' },
    );
  }

  // ───────── moved from AblationCLI.handlePauseInput (Slice 3 Pass A) ─────────
  private async handlePauseInput(
    input: string,
    stopCondition: () => boolean,
  ): Promise<'resume' | 'abort' | 'handled'> {
    const trimmed = input.trim();
    if (!trimmed) return 'resume';

    // Exit during active run → graceful abort (callers also check, this is a safety net)
    if (this.isExitCommand(trimmed)) {
      this.deps.client.getChatHistoryManager().addUserInteractionEvent('abort', 'exit-command');
      process.emit('SIGINT', 'SIGINT');
      return 'abort';
    }

    // Route slash commands through the main CLI's full command handler
    if (trimmed.startsWith('/')) {
      const handled = await this.host.routeSlashCommand(trimmed);
      if (!handled) {
        const cmd = trimmed.split(/\s+/)[0];
        this.deps.logger.log(`  Unknown command: ${cmd}\n`, { type: 'warning' });
        this.deps.logger.log('  Type /help for available commands.\n', { type: 'info' });
      }
      return 'handled';
    }

    // Regular text — log user message and send to the agent
    this.deps.client.getChatHistoryManager().addUserMessage(trimmed, undefined, true);
    await this.deps.client.processQuery(trimmed, false, undefined, stopCondition);
    return 'handled';
  }

  // ───────── moved from AblationCLI.promptDryRunPause (Slice 3 Pass A) ─────────
  private async promptDryRunPause(
    command: string,
    executedCommands: { index: number; command: string }[],
  ): Promise<'resume' | 'cancel' | 'restart-phase' | { rewindTo: number }> {
    this.deps.logger.log(`\n  ⏸ Paused after: ${command}\n`, { type: 'warning' });
    this.deps.logger.log('  [Enter] resume | [c]ancel | [r]ewind | [s] restart phase\n', { type: 'info' });
    const input = await this.host.collectInput('  Choice: ');
    if (input === null || input.trim().toLowerCase() === 'c') return 'cancel';
    if (input.trim().toLowerCase() === 's') return 'restart-phase';
    if (input.trim().toLowerCase() === 'r') {
      if (executedCommands.length < 1) {
        this.deps.logger.log('  Nothing to rewind to.\n', { type: 'warning' });
        return 'resume';
      }
      const picked = await this.promptRewindPicker(executedCommands);
      if (picked === null) return 'resume'; // User cancelled the picker
      return { rewindTo: picked };
    }
    return 'resume';
  }

  // ───────── moved from AblationCLI.promptRewindPicker (Slice 3 Pass A) ─────────
  private async promptRewindPicker(
    executedCommands: { index: number; command: string }[],
  ): Promise<number | null> {
    // Stop keyboard monitor so we own raw stdin
    this.host.stopKeyboardMonitor();

    const stdin = process.stdin;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    // Remove any existing data listeners
    const existingListeners = stdin.listeners('data').slice();
    stdin.removeAllListeners('data');

    let selectedIndex = executedCommands.length - 1; // Start at most recent
    this.renderRewindList(executedCommands, selectedIndex);

    const result = await new Promise<number | null>((resolve) => {
      let escapeBuffer = '';
      let escapeTimeout: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (escapeTimeout) { clearTimeout(escapeTimeout); escapeTimeout = null; }
        escapeBuffer = '';
        stdin.removeListener('data', keyHandler);
      };

      const keyHandler = (key: string) => {
        // Arrow keys as complete sequences
        if (key === '\x1B[A') {
          if (escapeTimeout) clearTimeout(escapeTimeout);
          escapeBuffer = '';
          if (selectedIndex > 0) { selectedIndex--; this.renderRewindList(executedCommands, selectedIndex); }
          return;
        }
        if (key === '\x1B[B') {
          if (escapeTimeout) clearTimeout(escapeTimeout);
          escapeBuffer = '';
          if (selectedIndex < executedCommands.length - 1) { selectedIndex++; this.renderRewindList(executedCommands, selectedIndex); }
          return;
        }

        // Escape sequence buffering (byte-by-byte)
        if (escapeBuffer.length > 0) {
          escapeBuffer += key;
          if (escapeTimeout) clearTimeout(escapeTimeout);
          if (escapeBuffer === '\x1B[A') {
            escapeBuffer = '';
            if (selectedIndex > 0) { selectedIndex--; this.renderRewindList(executedCommands, selectedIndex); }
            return;
          }
          if (escapeBuffer === '\x1B[B') {
            escapeBuffer = '';
            if (selectedIndex < executedCommands.length - 1) { selectedIndex++; this.renderRewindList(executedCommands, selectedIndex); }
            return;
          }
          if (escapeBuffer.length >= 3) escapeBuffer = '';
          return;
        }

        // Start of escape sequence
        if (key === '\x1B') {
          escapeBuffer = '\x1B';
          escapeTimeout = setTimeout(() => { escapeBuffer = ''; cleanup(); resolve(null); }, 50);
          return;
        }

        // Enter — select
        if (key === '\r' || key === '\n') { cleanup(); resolve(executedCommands[selectedIndex].index); return; }
        // q — cancel
        if (key === 'q') { cleanup(); resolve(null); return; }
        // Ctrl+C
        if (key === '\x03') { cleanup(); process.emit('SIGINT', 'SIGINT'); return; }
      };

      stdin.on('data', keyHandler);
    });

    // Restore terminal state
    if (stdin.setRawMode) stdin.setRawMode(false);
    // Restore previous listeners
    for (const listener of existingListeners) {
      stdin.on('data', listener as (...args: any[]) => void);
    }
    // Restart keyboard monitor
    this.host.startKeyboardMonitor();

    // Clear rewind UI
    process.stdout.write('\x1B[2J\x1B[H');
    return result;
  }

  // ───────── moved from AblationCLI.renderRewindList (Slice 3 Pass A) ─────────
  private renderRewindList(
    commands: { index: number; command: string }[],
    selectedIndex: number,
  ): void {
    process.stdout.write('\x1B[2J\x1B[H');

    console.log(
      chalk.bold.yellow('Rewind') + chalk.dim(' - Select a command to rewind to'),
    );
    console.log(chalk.dim('  Up/Down: navigate  |  Enter: rewind here  |  q/Esc: cancel'));
    console.log();

    const windowSize = AblationRunner.REWIND_VISIBLE_WINDOW;
    const windowStart = Math.max(0, Math.min(
      selectedIndex - Math.floor(windowSize / 2),
      commands.length - windowSize,
    ));
    const windowEnd = Math.min(commands.length, windowStart + windowSize);

    if (windowStart > 0) {
      console.log(chalk.dim(`  ... ${windowStart} more above`));
    }

    for (let i = windowStart; i < windowEnd; i++) {
      const entry = commands[i];
      const stepNum = `${i + 1}`;
      const cmdPreview = entry.command.length > 80
        ? entry.command.substring(0, 77) + '...'
        : entry.command;

      if (i === selectedIndex) {
        console.log(chalk.bgCyan.black.bold(`> [${stepNum}] ${cmdPreview}`));
      } else {
        console.log(`  ${chalk.dim(`[${stepNum}]`)} ${chalk.cyan(cmdPreview)}`);
      }
    }

    if (windowEnd < commands.length) {
      console.log(chalk.dim(`  ... ${commands.length - windowEnd} more below`));
    }

    console.log();
    console.log(chalk.dim(`[${selectedIndex + 1}/${commands.length}]`));
  }

  // ───────── moved from AblationCLI.askForceStopPrompt (Slice 3 Pass A) ─────────
  private async askForceStopPrompt(toolName: string, elapsedSeconds: number, abortSignal?: AbortSignal): Promise<boolean> {
    if (abortSignal?.aborted) {
      return false;
    }

    const serverName = toolName.includes('__') ? toolName.split('__')[0] : 'the server';
    console.log(`\nTool "${toolName}" has been running for ${elapsedSeconds} seconds after abort.`);
    console.log(`⚠️  Force stopping will kill and restart "${serverName}" server.`);
    console.log('Do you want to force stop this tool call? (y/n, Enter to skip)');

    const response = await new Promise<string | null>((resolve) => {
      let resolved = false;

      const onAbort = () => {
        if (!resolved) {
          resolved = true;
          process.stdout.write('\r\x1b[K');
          console.log('(Tool completed, prompt dismissed)');
          resolve('');
        }
      };

      if (abortSignal) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      this.host.collectInput('> ').then((answer) => {
        if (!resolved) {
          resolved = true;
          if (abortSignal) {
            abortSignal.removeEventListener('abort', onAbort);
          }
          resolve(answer);
        }
      });
    });

    const answer = (response ?? '').trim().toLowerCase();
    // Headless force-stop policy (GPT review finding #1): if collectInput is unavailable
    // (web/headless host) AND the run was already aborted by the user, force-stop the tool
    // rather than wait indefinitely on a prompt no one will ever answer.
    const headlessAbort = response === null && this.control.isAbortRequested();
    const shouldStop = answer === 'y' || answer === 'yes' || headlessAbort;

    if (shouldStop) {
      this.deps.logger.log(`\nForce stopping tool call and restarting "${serverName}" server...\n`, { type: 'warning' });
    } else if (answer === '') {
      // User pressed Enter without input, Ctrl+C, or tool completed
    } else {
      this.deps.logger.log('\nContinuing to wait for tool result...\n', { type: 'info' });
    }

    return shouldStop;
  }

  // ───────── moved from AblationCLI.isExitCommand (Slice 3 Pass A) ─────────
  private isExitCommand(input: string): boolean {
    const trimmed = input.trim().toLowerCase();
    return trimmed === 'exit' || trimmed === '/exit';
  }
}

// Re-exported for adapters that need to reference the run-result shape.
export type { AblationDefinition, AblationRun, AblationCommandResult };
