// Run-lifecycle agent actions — run.start / run.abort / run.status.
//
// Registered separately from the core agent actions (agent-actions.ts) because they are backed
// by the shared AblationRunner (Slice 3): the SAME engine the CLI's runSingleAblation wrapper
// and the web POST /ablations/:name/run handler call. Registering here means the agent surface
// (web POST /agent/action, CLI /agent-do) drives ablation runs through that one engine too —
// three surfaces, one run engine, divergence impossible by construction.
//
// run.start is non-blocking: it kicks the run off in the background and returns immediately;
// callers poll run.status (which reads the AgentRegistry viewState sink the run writes to).

import { AgentRegistry } from './managers/agent-registry.js';
import { AblationManager } from './managers/ablation-manager.js';
import { AblationRunner, type RunControl, type RunObserver, type RunHost } from './ablation-runner.js';
import { createProvider } from './provider-registry.js';
import type { MCPClient } from './index.js'; // type-only: erased at runtime, no import cycle

export function registerRunActions(client: MCPClient): void {
  const reg = AgentRegistry.shared;
  const ablationManager = new AblationManager();

  // Persistent runner: preserves lastAblationMcpConfigPath (cross-run server-refresh skip).
  let runner: AblationRunner | null = null;
  const getRunner = (): AblationRunner => {
    if (!runner) {
      runner = new AblationRunner({
        client,
        logger: client.getLogger(),
        ablationManager,
        preferencesManager: client.getPreferencesManager(),
        attachmentManager: client.getAttachmentManager(),
      });
    }
    return runner;
  };

  // Single-run state (one agent-driven ablation at a time, mirroring the web's ablationRunning).
  let running = false;
  let abortFlag = false;
  let activeStudy: string | null = null;

  // Observer mirrors run progress into the viewState sink for run.status / remote observability.
  const observer: RunObserver = {
    on: (event) => {
      switch (event.type) {
        case 'run-start':
          reg.setViewState('run.study', event.ablation);
          reg.setViewState('run.status', 'running');
          reg.setViewState('run.totalScenarios', event.totalScenarios);
          reg.setViewState('run.lastError', undefined); // clear any stale error
          break;
        case 'phase-start':
          reg.setViewState('run.phase', event.phase);
          reg.setViewState('run.model', event.model);
          reg.setViewState('run.index', event.runIndex);
          break;
        case 'result':
          reg.setViewState('run.lastGateVerdict', { phase: event.result.phase, status: event.result.status });
          break;
        case 'error':
          reg.setViewState('run.lastError', event.error);
          reg.setViewState('run.status', 'error');
          break;
        // phase-complete/escalate/switch-model/command/abort/continuation/progress/done
        // are not mirrored individually; done is handled by the run.start promise chain.
      }
    },
  };

  reg.registerAction({
    id: 'run.start',
    description: 'Start an ablation study by name through the shared AblationRunner (the same engine the CLI and web use). Non-blocking by default: returns immediately; poll run.status for progress. Pass wait:true to BLOCK until the run completes and return its final status (used by headless/ssh single-run invocations — replaces the tmux orchestrate_replays.sh loop).',
    params: [
      { name: 'name', type: 'string', required: true, description: 'Ablation study name' },
      { name: 'resolvedArguments', type: 'object', required: false, description: 'Resolved argument values for parameterized studies' },
      { name: 'wait', type: 'boolean', required: false, description: 'Block until the run finishes and return final status (headless single-run path).' },
    ],
    handler: async (p) => {
      if (running) throw new Error(`An ablation is already running: ${activeStudy}`);
      const name = String(p.name);
      const ablation = ablationManager.load(name);
      if (!ablation) throw new Error(`Ablation not found: ${name}`);

      running = true;
      abortFlag = false;
      activeStudy = name;

      const control: RunControl = {
        isAbortRequested: () => abortFlag,
        isInterruptRequested: () => false,
        resetAbort: () => { abortFlag = false; },
        resetInterrupt: () => {},
        setAbortMode: () => {},
      };
      const host: RunHost = {}; // headless: normalizeHost supplies defaults

      // Save chat-model state to restore after the background run (outer-loop responsibility,
      // mirroring the CLI's handleAblationRun and the web handler).
      const originalProviderName = client.getProviderName();
      const originalModel = client.getModel();
      const prefs = client.getPreferencesManager();
      const originalThinkingLevels = { ...prefs.getThinkingLevels() };
      const savedState = client.saveState();

      const resolvedArguments = (p.resolvedArguments as Record<string, string> | undefined) ?? undefined;

      // The run chain always RESOLVES (errors are captured into viewState, not rejected)
      // after state is restored and the running flag cleared.
      const chain = getRunner()
        .run(ablation, resolvedArguments, { control, observer, host })
        .then((aborted) => { reg.setViewState('run.status', aborted ? 'aborted' : 'done'); })
        .catch((err: any) => {
          reg.setViewState('run.status', 'error');
          reg.setViewState('run.lastError', err?.message ?? String(err));
        })
        .finally(async () => {
          try {
            const originalProvider = createProvider(originalProviderName);
            if (originalProvider) await client.restoreState(savedState, originalProvider, originalModel);
            for (const [provider, level] of Object.entries(originalThinkingLevels)) {
              prefs.setThinkingLevel(provider, level as string);
            }
          } catch { /* best effort */ }
          running = false;
          activeStudy = null;
        });

      // wait:true -> block until done and return the final status (headless/ssh path).
      if (p.wait === true || p.wait === 'true') {
        await chain;
        return {
          started: true, study: name, done: true,
          status: reg.getViewState('run.status') ?? 'done',
          lastError: reg.getViewState('run.lastError') ?? null,
        };
      }
      // Fire-and-forget (default): the run proceeds in the background; callers poll run.status.
      void chain;
      return { started: true, study: name };
    },
  });

  reg.registerAction({
    id: 'run.abort',
    description: 'Request abort of the active ablation run. Cooperative — takes effect at the next command boundary.',
    handler: () => {
      if (!running) return { ok: false, error: 'No ablation is currently running' };
      abortFlag = true;
      return { ok: true, study: activeStudy };
    },
  });

  reg.registerAction({
    id: 'run.status',
    description: 'Current ablation run state: running flag, study, status, current phase/model/scenario index, last gate verdict, and last error.',
    handler: () => ({
      running,
      study: reg.getViewState('run.study') ?? null,
      status: reg.getViewState('run.status') ?? 'idle',
      phase: reg.getViewState('run.phase') ?? null,
      model: reg.getViewState('run.model') ?? null,
      index: reg.getViewState('run.index') ?? null,
      totalScenarios: reg.getViewState('run.totalScenarios') ?? null,
      lastGateVerdict: reg.getViewState('run.lastGateVerdict') ?? null,
      lastError: reg.getViewState('run.lastError') ?? null,
    }),
  });
}
