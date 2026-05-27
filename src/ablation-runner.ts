// AblationRunner — the surface-agnostic ablation run engine.
//
// This is Slice 3 of the agent-automation work: the experiment loop (phase x model cascade
// with @escalate/@switch recovery) used to live as private methods on the readline-centric
// AblationCLI class, reachable only through a 26-field callback interface. The web server
// could not satisfy that interface, so it re-implemented the loop inline and DIVERGED
// (its copy silently skipped @escalate/@switch). This module is the single engine both the
// CLI and the web call, so the divergence becomes structurally impossible.
//
// The seam is inverted relative to the old AblationCLICallbacks: instead of the engine
// reaching OUT to drive the terminal (readline, keyboard monitor, slash routing), the engine
// EMITS structured RunEvents that a surface renders/persists, and only pulls on a small
// RunControl (abort/interrupt). See the architecture review (2026-05-27) for the depth rationale.
//
// Pass A (this commit): relocate the loop here; route the residual CLI-only callbacks through
// an optional RunHost (CLI supplies real impls; web supplies headless defaults). Pass B will
// retire RunHost entirely, leaving the pure ~6-field seam.

import type { MCPClient } from './index.js';
import type { Logger } from './logger.js';
import type {
  AblationManager,
  AblationDefinition,
  AblationRun,
  AblationCommandResult,
} from './managers/ablation-manager.js';
import type { PreferencesManager } from './managers/preferences-manager.js';
import type { AttachmentManager, AttachmentInfo } from './managers/attachment-manager.js';

/**
 * Run control — surface -> engine. The dominant slice of the old 26-field interface
 * (isAbortRequested alone was used 34x in the loop). Both surfaces implement these:
 * the CLI backs them with its keyboard monitor; the web backs them with a request flag.
 */
export interface RunControl {
  /** Hard stop requested (CLI: Ctrl+C in abort mode; web: POST /ablations/cancel). */
  isAbortRequested(): boolean;
  /** Soft pause requested (CLI: Ctrl+A). Web has no interactive pause, so returns false. */
  isInterruptRequested(): boolean;
  resetAbort(): void;
  resetInterrupt(): void;
  /** CLI toggles whether Ctrl+C sets the abort flag vs exits; web is a no-op. */
  setAbortMode(enabled: boolean): void;
}

/**
 * Structured run events — engine -> surface. Rendered by the CLI (console), streamed by the
 * web (SSE), and mirrored into AgentRegistry.viewState (run.phase / run.lastGateVerdict /
 * run.progress / run.lastError) for remote observability of data-collection runs.
 */
export type RunEvent =
  | { type: 'run-start'; ablation: string; totalRuns: number; totalScenarios: number }
  | { type: 'phase-start'; phase: string; model: string; runIndex: number; totalRuns: number }
  | { type: 'command'; command: string; phase?: string }
  | { type: 'result'; result: AblationCommandResult; phase?: string }
  | { type: 'escalate'; fromModel: string; toModel: string; phase: string }
  | { type: 'switch-model'; fromModel: string; toModel: string; phase: string }
  | { type: 'phase-complete'; phase: string; model: string }
  | { type: 'abort'; reason: string }
  | { type: 'continuation' } // engine asks the surface to auto-continue the next batch item
  | { type: 'progress'; message: string }
  | { type: 'done'; success: boolean }
  | { type: 'error'; error: string };

export interface RunObserver {
  on(event: RunEvent): void;
}

/**
 * RunHost — TRANSITIONAL (Pass A). The residual leakage callbacks the loop still calls
 * directly (~17 call sites: interrupt-input collection, keyboard monitor, HIL, attachment
 * carry-over, iteration-limit restore). The CLI provides real implementations; the web
 * provides headless defaults (no keyboard, no interactive pause, auto-approve HIL per its
 * own policy). Pass B moves this behavior fully into the CLI adapter and deletes RunHost,
 * leaving RunControl + RunObserver as the pure seam.
 */
export interface RunHost {
  startKeyboardMonitor?(): void;
  stopKeyboardMonitor?(): void;
  /** Collect a line of input during a soft-interrupt pause; returns null if unavailable. */
  collectInput?(prompt: string): Promise<string | null>;
  /** Human-in-the-loop manager for tool approval, or null for headless auto-policy. */
  getHILManager?(): unknown | null;
  /** Restore the surface's iteration-limit callback on the client after a run. */
  restoreIterationLimitCallback?(): void;
  /** Attachment carry-over across phases (CLI lets users attach mid-run; web: empty). */
  getPendingAttachments?(): AttachmentInfo[];
  setPendingAttachments?(attachments: AttachmentInfo[]): void;
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
  constructor(private readonly deps: RunDeps) {}

  /**
   * Execute a full ablation study (every model x phase, with escalation). Returns true on
   * successful completion, false if aborted. Behavior is identical regardless of surface —
   * that identity is the whole point of this module.
   *
   * Pass A fills this in by relocating runSingleAblation / executeAblationCommand /
   * runEscalationLoop from AblationCLI, with this.callbacks.<x> rewritten to opts.control.<x>
   * / opts.observer.on(...) / opts.host?.<x>(), and this.<collaborator> -> this.deps.<x>.
   */
  async run(
    _ablation: AblationDefinition,
    _resolvedArguments: Record<string, string> | undefined,
    _opts: RunOptions,
  ): Promise<boolean> {
    throw new Error('AblationRunner.run not yet implemented (Pass A pending)');
  }
}

// Re-exported for adapters that need to reference the run-result shape.
export type { AblationDefinition, AblationRun, AblationCommandResult };
