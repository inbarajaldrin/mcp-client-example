import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, cpSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../logger.js';
import * as yaml from 'yaml';
import { sanitizeFolderName } from '../utils/path-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ABLATIONS_DIR = join(__dirname, '../..', '.mcp-client-data', 'ablations');
const DEFINITIONS_DIR = join(ABLATIONS_DIR, 'definitions');
const RUNS_DIR = join(ABLATIONS_DIR, 'runs');
const OUTPUTS_DIR = join(__dirname, '../..', '.mcp-client-data', 'outputs');
const ATTACHMENTS_DIR = join(__dirname, '../..', '.mcp-client-data', 'attachments');

// ==================== Types ====================

export interface AblationModel {
  provider: string;
  model: string;
  thinking?: string;  // Provider-specific thinking level. Absent = thinking off.
}

export interface ConditionalGate {
  run: string;                           // Tool-exec to evaluate as gate condition
  whenOutput: Record<string, unknown>;   // Condition on gate tool result
  onPass: string[];                      // Commands if gate passes
  onFail: string[];                      // Commands if gate fails
  prompt?: string;                       // Client prompt injected after gate commands execute
}

export interface PostToolHook {
  after?: string;    // Full tool name to match AFTER execution (e.g. "ros-mcp-server__verify_assembly")
  before?: string;   // Full tool name to match BEFORE execution (only for @tool-exec/@tool commands)
  whenInput?: Record<string, unknown>;   // Match against tool input arguments only
  whenOutput?: Record<string, unknown>;  // Match against tool output JSON only
  run?: string;      // Command to execute (ignored when gate is present; either run or gate required)
  gate?: ConditionalGate;  // Conditional gate: evaluate tool, branch on result
  prompt?: string;   // Client prompt injected after hook execution (as system role on supported providers)
}

export type AblationArgumentType = 'string' | 'attachment';

export interface AblationArgument {
  name: string;                   // Used in {{name}} placeholders
  description?: string;           // Shown to user during collection
  type: AblationArgumentType;     // 'string' = text input, 'attachment' = file picker
  required?: boolean;             // Default: true
  default?: string;               // Fallback value for optional args
}

export interface AblationToolFilter {
  allow?: string[];   // Glob patterns — only matching tools are visible (whitelist)
  deny?: string[];    // Glob patterns — matching tools are hidden (deny wins over allow)
}

export interface AblationPhase {
  name: string;
  enabled?: boolean;        // Default true; set false to skip this phase
  commands: string[];
  hooks?: PostToolHook[];   // Post-tool hooks for this phase only (in addition to top-level)
  onStart?: string[];       // Commands to run before phase commands
  onEnd?: string[];         // Commands to run after phase commands
  systemPrompt?: string;    // Per-phase system prompt override (replaces master for this phase)
  userPrompt?: string;      // User prompt injected as user message at phase start
  tools?: AblationToolFilter;  // Per-phase tool filter (merged with top-level)
}

export interface AblationSettings {
  maxIterations: number;      // Max agent iterations per run
  mcpTimeout?: number;        // MCP tool timeout in seconds (overrides system setting during ablation)
  maxIpcCalls?: number;       // Max IPC calls per phase (overrides system setting during ablation)
  mcpConfigPath?: string;     // Optional path to custom MCP config file
  clearContextBetweenPhases?: boolean; // Default true; when false, conversation carries over between phases
  resetOutputsBetweenPhases?: string[]; // Output subdirs cleared between phases (e.g. ['screenshots'])
}

export interface AblationDefinition {
  name: string;
  description: string;
  created: string;
  updated?: string;
  dryRun?: boolean;        // When true, skip model switching - execute tool calls directly
  runs?: number;           // Number of times to repeat the full ablation (default 1)
  arguments?: AblationArgument[];  // Dynamic placeholders resolved at runtime
  phases: AblationPhase[];
  models: AblationModel[];
  settings: AblationSettings;
  hooks?: PostToolHook[];  // Post-tool hooks applied to all phases
  tools?: AblationToolFilter;  // Top-level tool filter — applies to all phases
  systemPrompt?: string;   // Master system prompt — all phases inherit unless overridden
  escalation?: boolean;  // When true, models are an ordered escalation chain (not parallel)
}

export interface AblationRunResult {
  phase: string;
  model: AblationModel;
  run?: number;           // Only populated when runs > 1
  attempt?: number;       // Escalation attempt number (1-based), only set when escalation: true
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'aborted' | 'escalated';
  tokens?: number;
  duration?: number; // milliseconds
  durationFormatted?: string; // human-readable (e.g. "4m 5s")
  chatFile?: string;
  error?: string;
  errorStatus?: number;
}

export interface AblationRun {
  ablationName: string;
  startedAt: string;
  completedAt?: string;
  resolvedArguments?: Record<string, string>;  // Argument values used for this run
  results: AblationRunResult[];
  totalTokens?: number;
  totalDuration?: number;
  totalDurationFormatted?: string; // human-readable (e.g. "1h 23m 45s")
}

export interface AblationCommandResult {
  toolExecResult?: {
    toolName: string;
    args: Record<string, unknown>;
    displayText?: string;
    success: boolean;
    error?: string;
  };
  /** When true, signals that remaining phases for the current model should be skipped */
  abortRun?: boolean;
  /** When true, signals that the current phase is complete and should advance to the next */
  phaseComplete?: boolean;
  /** When true, signals escalation to the next model in the chain for the current phase */
  escalate?: boolean;
}

// ==================== Manager ====================

export class AblationManager {
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.initializeDirectories();
  }

  /**
   * Initialize ablations directory structure
   */
  private initializeDirectories(): void {
    try {
      if (!existsSync(ABLATIONS_DIR)) {
        mkdirSync(ABLATIONS_DIR, { recursive: true });
      }
      if (!existsSync(DEFINITIONS_DIR)) {
        mkdirSync(DEFINITIONS_DIR, { recursive: true });
      }
      if (!existsSync(RUNS_DIR)) {
        mkdirSync(RUNS_DIR, { recursive: true });
      }
    } catch (error) {
      this.logger.log(`Failed to create ablations directory: ${error}\n`, { type: 'error' });
    }
  }

  /**
   * Get path to an ablation definition file
   */
  private getAblationPath(name: string): string {
    return join(DEFINITIONS_DIR, `${sanitizeFolderName(name)}.yaml`);
  }

  /**
   * Create a new ablation study
   */
  create(ablation: Omit<AblationDefinition, 'created'>): AblationDefinition {
    const sanitizedName = sanitizeFolderName(ablation.name);
    const path = this.getAblationPath(sanitizedName);

    if (existsSync(path)) {
      throw new Error(`Ablation "${sanitizedName}" already exists`);
    }

    const fullAblation: AblationDefinition = {
      ...ablation,
      name: sanitizedName,
      created: new Date().toISOString(),
    };

    this.save(fullAblation);
    return fullAblation;
  }

  /**
   * Save an ablation definition.
   * Constructs a canonical field order for clean, consistent YAML output.
   */
  save(ablation: AblationDefinition): void {
    const path = this.getAblationPath(ablation.name);
    const ordered: Record<string, unknown> = {
      name: ablation.name,
      description: ablation.description,
      created: ablation.created,
    };
    if (ablation.updated) ordered.updated = ablation.updated;
    ordered.models = ablation.models;
    if (ablation.dryRun !== undefined) ordered.dryRun = ablation.dryRun;
    if (ablation.runs !== undefined) ordered.runs = ablation.runs;
    if (ablation.arguments && ablation.arguments.length > 0) ordered.arguments = ablation.arguments;
    ordered.settings = ablation.settings;
    if (ablation.tools) ordered.tools = ablation.tools;
    ordered.phases = ablation.phases;
    if (ablation.hooks && ablation.hooks.length > 0) ordered.hooks = ablation.hooks;
    const yamlContent = yaml.stringify(ordered);
    writeFileSync(path, yamlContent, 'utf-8');
  }

  /**
   * Load an ablation definition
   */
  load(name: string): AblationDefinition | null {
    const path = this.getAblationPath(name);

    if (!existsSync(path)) {
      return null;
    }

    try {
      const content = readFileSync(path, 'utf-8');
      return yaml.parse(content) as AblationDefinition;
    } catch (error) {
      this.logger.log(`Failed to load ablation "${name}": ${error}\n`, { type: 'error' });
      return null;
    }
  }

  /**
   * List all ablation definitions
   */
  list(): AblationDefinition[] {
    const ablations: AblationDefinition[] = [];

    if (!existsSync(DEFINITIONS_DIR)) {
      return ablations;
    }

    try {
      const files = readdirSync(DEFINITIONS_DIR);

      for (const file of files) {
        if (file.endsWith('.yaml')) {
          const name = file.replace('.yaml', '');
          const ablation = this.load(name);
          if (ablation) {
            ablations.push(ablation);
          }
        }
      }
    } catch (error) {
      this.logger.log(`Failed to list ablations: ${error}\n`, { type: 'error' });
    }

    // Sort by creation date (newest first)
    return ablations.sort((a, b) =>
      new Date(b.created).getTime() - new Date(a.created).getTime()
    );
  }

  /**
   * Update an ablation definition
   */
  update(name: string, updates: Partial<Omit<AblationDefinition, 'name' | 'created'>>): AblationDefinition | null {
    const ablation = this.load(name);

    if (!ablation) {
      return null;
    }

    const updated: AblationDefinition = {
      ...ablation,
      ...updates,
      name: ablation.name, // Don't allow name change via update
      created: ablation.created, // Preserve creation date
      updated: new Date().toISOString(),
    };

    this.save(updated);
    return updated;
  }

  /**
   * Delete an ablation definition
   */
  delete(name: string): boolean {
    const path = this.getAblationPath(name);

    if (!existsSync(path)) {
      return false;
    }

    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      this.logger.log(`Failed to delete ablation "${name}": ${error}\n`, { type: 'error' });
      return false;
    }
  }

  /**
   * Add a phase to an ablation
   */
  addPhase(name: string, phase: AblationPhase): AblationDefinition | null {
    const ablation = this.load(name);

    if (!ablation) {
      return null;
    }

    // Check for duplicate phase name
    if (ablation.phases.some(p => p.name === phase.name)) {
      throw new Error(`Phase "${phase.name}" already exists`);
    }

    ablation.phases.push(phase);
    ablation.updated = new Date().toISOString();
    this.save(ablation);
    return ablation;
  }

  /**
   * Remove a phase from an ablation
   */
  removePhase(name: string, phaseName: string): AblationDefinition | null {
    const ablation = this.load(name);

    if (!ablation) {
      return null;
    }

    const index = ablation.phases.findIndex(p => p.name === phaseName);
    if (index === -1) {
      throw new Error(`Phase "${phaseName}" not found`);
    }

    ablation.phases.splice(index, 1);
    ablation.updated = new Date().toISOString();
    this.save(ablation);
    return ablation;
  }

  /**
   * Update a phase in an ablation
   */
  updatePhase(name: string, phaseName: string, updates: Partial<AblationPhase>): AblationDefinition | null {
    const ablation = this.load(name);

    if (!ablation) {
      return null;
    }

    const phase = ablation.phases.find(p => p.name === phaseName);
    if (!phase) {
      throw new Error(`Phase "${phaseName}" not found`);
    }

    Object.assign(phase, updates);
    ablation.updated = new Date().toISOString();
    this.save(ablation);
    return ablation;
  }

  /**
   * Add models to an ablation
   */
  addModels(name: string, models: AblationModel[]): AblationDefinition | null {
    const ablation = this.load(name);

    if (!ablation) {
      return null;
    }

    for (const model of models) {
      // Check for duplicates
      const exists = ablation.models.some(
        m => m.provider === model.provider && m.model === model.model
      );
      if (!exists) {
        ablation.models.push(model);
      }
    }

    ablation.updated = new Date().toISOString();
    this.save(ablation);
    return ablation;
  }

  /**
   * Remove models from an ablation
   */
  removeModels(name: string, models: AblationModel[]): AblationDefinition | null {
    const ablation = this.load(name);

    if (!ablation) {
      return null;
    }

    for (const modelToRemove of models) {
      const index = ablation.models.findIndex(
        m => m.provider === modelToRemove.provider && m.model === modelToRemove.model
      );
      if (index !== -1) {
        ablation.models.splice(index, 1);
      }
    }

    ablation.updated = new Date().toISOString();
    this.save(ablation);
    return ablation;
  }

  /**
   * Get merged hooks for a phase (top-level + phase-specific).
   * Phase hooks come after top-level hooks.
   */
  getHooksForPhase(ablation: AblationDefinition, phaseName: string): PostToolHook[] {
    const topLevel = ablation.hooks ?? [];
    const phase = ablation.phases.find(p => p.name === phaseName);
    const phaseLevel = phase?.hooks ?? [];
    return [...topLevel, ...phaseLevel];
  }

  /**
   * Get merged tool filter for a phase.
   * deny = union of top-level and phase deny (additive).
   * allow = intersection if both exist, otherwise whichever is present.
   * deny always wins over allow.
   */
  getToolFilterForPhase(ablation: AblationDefinition, phaseName: string): AblationToolFilter | null {
    const topLevel = ablation.tools;
    const phase = ablation.phases.find(p => p.name === phaseName);
    const phaseLevel = phase?.tools;

    if (!topLevel && !phaseLevel) return null;

    const merged: AblationToolFilter = {};

    // Merge deny: union
    const topDeny = topLevel?.deny ?? [];
    const phaseDeny = phaseLevel?.deny ?? [];
    if (topDeny.length > 0 || phaseDeny.length > 0) {
      merged.deny = [...new Set([...topDeny, ...phaseDeny])];
    }

    // Merge allow: intersection if both, otherwise whichever exists
    const topAllow = topLevel?.allow;
    const phaseAllow = phaseLevel?.allow;
    if (topAllow && phaseAllow) {
      // Phase can only narrow top-level allow, not widen
      merged.allow = phaseAllow.filter(pp =>
        topAllow.some(tp => this.toolGlobMatch(pp, tp) || this.toolGlobMatch(tp, pp))
      );
      // If intersection is empty but both had entries, keep the more specific (phase)
      if (merged.allow.length === 0) merged.allow = phaseAllow;
    } else if (topAllow) {
      merged.allow = [...topAllow];
    } else if (phaseAllow) {
      merged.allow = [...phaseAllow];
    }

    return merged;
  }

  /**
   * Check if a tool name matches a glob pattern.
   * Supports * as wildcard (e.g. "ros-mcp-server__*" matches all tools from that server).
   */
  toolGlobMatch(toolName: string, pattern: string): boolean {
    if (pattern === toolName) return true;
    if (!pattern.includes('*')) return false;
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(toolName);
  }

  /**
   * Filter a list of tools using an AblationToolFilter.
   * Returns only tools that pass both allow and deny checks.
   */
  applyToolFilter<T extends { name: string }>(tools: T[], filter: AblationToolFilter): T[] {
    return tools.filter(tool => {
      // deny takes precedence
      if (filter.deny?.some(pattern => this.toolGlobMatch(tool.name, pattern))) {
        return false;
      }
      // If allow is specified, tool must match at least one pattern
      if (filter.allow && filter.allow.length > 0) {
        return filter.allow.some(pattern => this.toolGlobMatch(tool.name, pattern));
      }
      return true;
    });
  }

  /**
   * Pre-flight validation of tool filters against currently connected tools.
   * Returns warnings for contradictions, empty results, and dead patterns.
   */
  validateToolFilters(ablation: AblationDefinition, connectedToolNames: string[]): string[] {
    const warnings: string[] = [];

    const validateFilter = (filter: AblationToolFilter, context: string) => {
      // Check for dead patterns (match no connected tools)
      for (const pattern of (filter.allow ?? [])) {
        if (!connectedToolNames.some(name => this.toolGlobMatch(name, pattern))) {
          warnings.push(`${context}: allow pattern "${pattern}" matches no connected tools (typo?)`);
        }
      }
      for (const pattern of (filter.deny ?? [])) {
        if (!connectedToolNames.some(name => this.toolGlobMatch(name, pattern))) {
          warnings.push(`${context}: deny pattern "${pattern}" matches no connected tools (typo?)`);
        }
      }

      // Check for contradictions (tool in both allow and deny)
      if (filter.allow && filter.deny) {
        for (const name of connectedToolNames) {
          const allowed = filter.allow.some(p => this.toolGlobMatch(name, p));
          const denied = filter.deny.some(p => this.toolGlobMatch(name, p));
          if (allowed && denied) {
            warnings.push(`${context}: ${name} is in both allow and deny (deny wins)`);
          }
        }
      }

      // Check for empty result
      const surviving = connectedToolNames.filter(name => {
        if (filter.deny?.some(p => this.toolGlobMatch(name, p))) return false;
        if (filter.allow && filter.allow.length > 0) {
          return filter.allow.some(p => this.toolGlobMatch(name, p));
        }
        return true;
      });
      if (surviving.length === 0) {
        warnings.push(`${context}: filter results in 0 available tools — phase would have no tools`);
      }
    };

    // Validate top-level filter
    if (ablation.tools) {
      validateFilter(ablation.tools, 'Top-level');
    }

    // Validate merged filter for each enabled phase
    for (const phase of ablation.phases) {
      if (phase.enabled === false) continue;
      const merged = this.getToolFilterForPhase(ablation, phase.name);
      if (merged) {
        validateFilter(merged, `Phase "${phase.name}"`);
      }
    }

    return warnings;
  }

  /**
   * Get total number of runs for an ablation (models × iterations).
   * A "run" = one model going through all phases once.
   */
  getTotalRuns(ablation: AblationDefinition): number {
    const iterations = ablation.runs ?? 1;
    if (ablation.dryRun) {
      return iterations;
    }
    return ablation.models.length * iterations;
  }

  /**
   * Get total number of scenarios (enabled phases × models × iterations).
   * A "scenario" = one phase executed by one model in one iteration.
   */
  getTotalScenarios(ablation: AblationDefinition): number {
    const iterations = ablation.runs ?? 1;
    const enabledPhases = ablation.phases.filter(p => p.enabled !== false).length;
    if (ablation.dryRun) {
      return enabledPhases * iterations;
    }
    return enabledPhases * ablation.models.length * iterations;
  }

  /**
   * Get run directory for an ablation run
   */
  getRunDirectory(ablationName: string, timestamp?: string): string {
    const ts = timestamp || this.formatTimestamp(new Date());
    return join(RUNS_DIR, sanitizeFolderName(ablationName), ts);
  }

  /**
   * Format timestamp for folder name
   */
  private formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
  }

  /**
   * Create run directory structure
   */
  createRunDirectory(ablationName: string): { runDir: string; timestamp: string } {
    const timestamp = this.formatTimestamp(new Date());
    const runDir = this.getRunDirectory(ablationName, timestamp);

    mkdirSync(runDir, { recursive: true });

    return { runDir, timestamp };
  }

  /**
   * Get the directory name for a model within a run.
   * Format: {provider}--{model} (e.g. "openai--gpt-5-mini")
   * Each part is sanitized separately so the -- separator is preserved.
   */
  getModelDirName(model: AblationModel): string {
    return `${sanitizeFolderName(model.provider)}--${sanitizeFolderName(model.model)}`;
  }

  getOutputsDir(): string {
    return OUTPUTS_DIR;
  }

  /**
   * Get the iteration directory for a model within a run.
   * Structure: {runDir}/{modelDir}/(run-{N}/)
   * This is the parent of phase directories and holds per-iteration snapshots.
   */
  getIterationDir(runDir: string, model: AblationModel, runIteration?: number): string {
    const modelDir = this.getModelDirName(model);
    return runIteration !== undefined
      ? join(runDir, modelDir, `run-${runIteration}`)
      : join(runDir, modelDir);
  }

  /**
   * Create phase directory within a run under the model's directory.
   * Structure: {runDir}/{modelDir}/(run-{N}/){phase}/
   */
  createPhaseDirectory(runDir: string, model: AblationModel, phaseName: string, runIteration?: number): string {
    const modelDir = this.getModelDirName(model);
    const basePath = runIteration !== undefined
      ? join(runDir, modelDir, `run-${runIteration}`, sanitizeFolderName(phaseName))
      : join(runDir, modelDir, sanitizeFolderName(phaseName));
    mkdirSync(basePath, { recursive: true });
    return basePath;
  }

  /**
   * Create escalation attempt directory within a run.
   * Structure (single iteration):  {runDir}/{phase}/attempt-{N}--{provider}--{model}/
   * Structure (multi-iteration):   {runDir}/{phase}/run-{I}--attempt-{N}--{provider}--{model}/
   */
  createEscalationAttemptDir(runDir: string, phaseName: string, attempt: number, model: AblationModel, runIteration?: number): string {
    const phaseDir = sanitizeFolderName(phaseName);
    const modelDir = this.getModelDirName(model);
    const dirName = runIteration !== undefined
      ? `run-${runIteration}--attempt-${attempt}--${modelDir}`
      : `attempt-${attempt}--${modelDir}`;
    const attemptDir = join(runDir, phaseDir, dirName);
    mkdirSync(attemptDir, { recursive: true });
    return attemptDir;
  }

  /**
   * Capture outputs for an escalation attempt.
   * Copies from shared OUTPUTS_DIR to the attempt directory.
   */
  captureEscalationOutputs(attemptDir: string): number {
    try {
      if (!existsSync(OUTPUTS_DIR)) {
        return 0;
      }

      const items = readdirSync(OUTPUTS_DIR);
      if (items.length === 0) {
        return 0;
      }

      mkdirSync(attemptDir, { recursive: true });
      cpSync(OUTPUTS_DIR, attemptDir, { recursive: true });
      return items.length;
    } catch (error) {
      this.logger.log(`Failed to capture escalation outputs: ${error}\n`, { type: 'error' });
      return 0;
    }
  }

  /**
   * Restore outputs from prior successful phases into the shared OUTPUTS_DIR.
   * Used during escalation to give the new model access to prior phases' artifacts.
   * 1. Clears OUTPUTS_DIR
   * 2. Copies outputs from each successful prior phase's attempt dir
   */
  restoreOutputsFromPriorPhases(successfulPhaseOutputs: Map<string, string>): void {
    this.clearOutputs();

    for (const [phaseName, attemptDir] of successfulPhaseOutputs) {
      try {
        if (!existsSync(attemptDir)) continue;

        // Copy all items from the attempt dir's output content into OUTPUTS_DIR
        // The attempt dir IS the outputs capture (captureEscalationOutputs copies OUTPUTS_DIR → attemptDir)
        const items = readdirSync(attemptDir);
        for (const item of items) {
          // Skip non-output files (chat.json, chat.md, tools.yaml, resources.yaml)
          if (['chat.json', 'chat.md', 'tools.yaml', 'resources.yaml', 'prompts.yaml'].includes(item)) continue;
          const src = join(attemptDir, item);
          const dest = join(OUTPUTS_DIR, item);
          try {
            cpSync(src, dest, { recursive: true });
          } catch (copyErr) {
            this.logger.log(`Failed to restore output "${item}" from phase "${phaseName}": ${copyErr}\n`, { type: 'warning' });
          }
        }
      } catch (error) {
        this.logger.log(`Failed to restore outputs from phase "${phaseName}": ${error}\n`, { type: 'warning' });
      }
    }
  }

  /**
   * Save run results
   */
  saveRunResults(runDir: string, run: AblationRun): void {
    const summaryPath = join(runDir, 'summary.json');
    writeFileSync(summaryPath, JSON.stringify(run, null, 2), 'utf-8');
  }

  /**
   * Save a frozen copy of the ablation definition into the run directory for provenance.
   */
  saveDefinitionSnapshot(runDir: string, ablation: AblationDefinition): void {
    try {
      const snapshotPath = join(runDir, 'definition.yaml');
      const yamlContent = yaml.stringify(ablation);
      writeFileSync(snapshotPath, yamlContent, 'utf-8');
    } catch (error) {
      this.logger.log(`Failed to save definition snapshot: ${error}\n`, { type: 'error' });
    }
  }

  /**
   * Save a snapshot of all available tools (grouped by server) into the run directory.
   * This is constant for the whole ablation since tools come from connected MCP servers.
   */
  saveToolsSnapshot(runDir: string, serversInfo: Array<{ name: string; tools: Array<{ name: string; description: string; input_schema?: Record<string, unknown> }> }>): void {
    try {
      const snapshotPath = join(runDir, 'tools.yaml');
      const yamlContent = yaml.stringify({ servers: serversInfo });
      writeFileSync(snapshotPath, yamlContent, 'utf-8');
    } catch (error) {
      this.logger.log(`Failed to save tools snapshot: ${error}\n`, { type: 'error' });
    }
  }

  /**
   * Save a snapshot of all available prompts (grouped by server) into the run directory.
   * This is constant for the whole ablation since prompts come from connected MCP servers.
   */
  savePromptsSnapshot(
    runDir: string,
    prompts: Array<{ server: string; prompt: { name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> } }>,
    resolvedContent?: Record<string, string>,
  ): void {
    try {
      const snapshotPath = join(runDir, 'prompts.yaml');
      // Group prompts by server, attaching resolved content where available
      const grouped: Record<string, Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }>; resolved_content?: string }>> = {};
      for (const entry of prompts) {
        if (!grouped[entry.server]) grouped[entry.server] = [];
        const key = `${entry.server}__${entry.prompt.name}`;
        const promptEntry: { name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }>; resolved_content?: string } = { ...entry.prompt };
        if (resolvedContent?.[key]) {
          promptEntry.resolved_content = resolvedContent[key];
        }
        grouped[entry.server].push(promptEntry);
      }
      const yamlContent = yaml.stringify({ servers: grouped });
      writeFileSync(snapshotPath, yamlContent, 'utf-8');
    } catch (error) {
      this.logger.log(`Failed to save prompts snapshot: ${error}\n`, { type: 'error' });
    }
  }

  /**
   * Save a snapshot of all available resources (grouped by server) into the run directory.
   */
  saveResourcesSnapshot(
    runDir: string,
    resources: Array<{ server: string; resource: { name: string; uri: string; description?: string; mimeType?: string } }>,
    templates: Array<{ server: string; template: { name: string; uriTemplate: string; description?: string; mimeType?: string } }> = [],
    resolvedContent?: Record<string, string>,
  ): void {
    try {
      const snapshotPath = join(runDir, 'resources.yaml');
      const grouped: Record<string, { resources?: Array<{ name: string; uri: string; description?: string; mimeType?: string; resolved_content?: string }>; templates?: Array<{ name: string; uriTemplate: string; description?: string; mimeType?: string; resolved_content?: string }> }> = {};
      for (const entry of resources) {
        if (!grouped[entry.server]) grouped[entry.server] = {};
        if (!grouped[entry.server].resources) grouped[entry.server].resources = [];
        const key = `${entry.server}__${entry.resource.name}`;
        const resourceEntry: { name: string; uri: string; description?: string; mimeType?: string; resolved_content?: string } = { ...entry.resource };
        if (resolvedContent?.[key]) {
          resourceEntry.resolved_content = resolvedContent[key];
        }
        grouped[entry.server].resources!.push(resourceEntry);
      }
      for (const entry of templates) {
        if (!grouped[entry.server]) grouped[entry.server] = {};
        if (!grouped[entry.server].templates) grouped[entry.server].templates = [];
        const key = `${entry.server}__${entry.template.name}`;
        const templateEntry: { name: string; uriTemplate: string; description?: string; mimeType?: string; resolved_content?: string } = { ...entry.template };
        if (resolvedContent?.[key]) {
          templateEntry.resolved_content = resolvedContent[key];
        }
        grouped[entry.server].templates!.push(templateEntry);
      }
      const yamlContent = yaml.stringify({ servers: grouped });
      writeFileSync(snapshotPath, yamlContent, 'utf-8');
    } catch (error) {
      this.logger.log(`Failed to save resources snapshot: ${error}\n`, { type: 'error' });
    }
  }

  /**
   * Append a resource injection record to the iteration-level resources.yaml.
   * Called each time @insert-resource: fires during a phase, capturing the
   * resolved content at that point in time.
   */
  appendResourceInjection(
    iterationDir: string,
    phaseName: string,
    resourceKey: string,
    uri: string,
    content: string,
    args?: Record<string, string>,
  ): void {
    try {
      const snapshotPath = join(iterationDir, 'resources.yaml');
      let data: { injections: Array<Record<string, unknown>> } = { injections: [] };

      if (existsSync(snapshotPath)) {
        const existing = yaml.parse(readFileSync(snapshotPath, 'utf-8'));
        if (existing?.injections && Array.isArray(existing.injections)) {
          data = existing;
        }
      }

      const entry: Record<string, unknown> = {
        resource: resourceKey,
        uri,
        phase: phaseName,
        injected_at: new Date().toISOString(),
        resolved_content: content,
      };
      if (args && Object.keys(args).length > 0) {
        entry.args = args;
      }

      data.injections.push(entry);
      mkdirSync(iterationDir, { recursive: true });
      writeFileSync(snapshotPath, yaml.stringify(data), 'utf-8');
    } catch (error) {
      this.logger.log(`Failed to append resource injection: ${error}\n`, { type: 'error' });
    }
  }

  /**
   * Load run results
   */
  loadRunResults(runDir: string): AblationRun | null {
    const summaryPath = join(runDir, 'summary.json');

    if (!existsSync(summaryPath)) {
      return null;
    }

    try {
      const content = readFileSync(summaryPath, 'utf-8');
      return JSON.parse(content) as AblationRun;
    } catch (error) {
      this.logger.log(`Failed to load run results: ${error}\n`, { type: 'error' });
      return null;
    }
  }

  /**
   * List all runs for an ablation
   */
  listRuns(ablationName: string): { timestamp: string; run: AblationRun }[] {
    const runs: { timestamp: string; run: AblationRun }[] = [];

    try {
      if (!existsSync(RUNS_DIR)) return runs;

      const ablationDir = join(RUNS_DIR, sanitizeFolderName(ablationName));
      if (!existsSync(ablationDir) || !statSync(ablationDir).isDirectory()) return runs;

      const timestampFolders = readdirSync(ablationDir);
      for (const tsFolder of timestampFolders) {
        const folderPath = join(ablationDir, tsFolder);
        if (!statSync(folderPath).isDirectory()) continue;

        const run = this.loadRunResults(folderPath);
        if (run) {
          runs.push({ timestamp: tsFolder, run });
        }
      }
    } catch (error) {
      this.logger.log(`Failed to list runs: ${error}\n`, { type: 'error' });
    }

    // Sort by timestamp (newest first)
    return runs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /**
   * Generate model short name for display
   */
  getModelShortName(model: AblationModel): string {
    // Extract a short name from the full model name
    const modelName = model.model;

    // Common patterns to shorten
    if (modelName.includes('claude')) {
      if (modelName.includes('haiku')) return 'haiku';
      if (modelName.includes('sonnet')) return 'sonnet';
      if (modelName.includes('opus')) return 'opus';
    }
    if (modelName.includes('gpt-4o-mini')) return 'gpt-4o-mini';
    if (modelName.includes('gpt-4o')) return 'gpt-4o';
    if (modelName.includes('gpt-4')) return 'gpt-4';
    if (modelName.includes('gpt-5-mini')) return 'gpt-5-mini';
    if (modelName.includes('gpt-5')) return 'gpt-5';
    if (modelName.includes('gemini-2.5-flash')) return 'gemini-flash';
    if (modelName.includes('gemini-2.5-pro')) return 'gemini-pro';
    if (modelName.includes('gemini')) return 'gemini';

    // For Ollama and others, use the model name directly if short enough
    if (modelName.length <= 15) return modelName;

    // Otherwise truncate
    return modelName.substring(0, 12) + '...';
  }

  /**
   * Get unique providers from an ablation
   */
  getProviders(ablation: AblationDefinition): string[] {
    return [...new Set(ablation.models.map(m => m.provider))];
  }

  /**
   * Get chat file name for a run (always "chat.json" — model is encoded in the parent directory)
   */
  getChatFileName(_model: AblationModel): string {
    return 'chat.json';
  }

  // ==================== Argument Placeholders ====================

  /**
   * Extract all {{name}} placeholders from all phase commands (including hooks and lifecycle commands).
   * Returns unique placeholder names in order of first appearance.
   */
  extractPlaceholders(ablation: AblationDefinition): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    const regex = /\{\{([^}]+)\}\}/g;

    const scanCommands = (commands: string[]) => {
      for (const cmd of commands) {
        let match;
        while ((match = regex.exec(cmd)) !== null) {
          const name = match[1].trim();
          if (!seen.has(name)) {
            seen.add(name);
            ordered.push(name);
          }
        }
      }
    };

    for (const phase of ablation.phases) {
      scanCommands(phase.commands);
      if (phase.onStart) scanCommands(phase.onStart);
      if (phase.onEnd) scanCommands(phase.onEnd);
      if (phase.hooks) {
        for (const hook of phase.hooks) {
          if (hook.run) scanCommands([hook.run]);
          if (hook.gate) {
            scanCommands([hook.gate.run]);
            scanCommands(hook.gate.onPass);
            scanCommands(hook.gate.onFail);
          }
        }
      }
    }
    if (ablation.hooks) {
      for (const hook of ablation.hooks) {
        if (hook.run) scanCommands([hook.run]);
        if (hook.gate) {
          scanCommands([hook.gate.run]);
          scanCommands(hook.gate.onPass);
          scanCommands(hook.gate.onFail);
        }
      }
    }

    return ordered;
  }

  /**
   * Validate argument definitions against placeholders found in commands.
   * Returns warnings for: placeholders without definitions, definitions without placeholders.
   */
  validateArguments(ablation: AblationDefinition): string[] {
    const warnings: string[] = [];
    const placeholders = this.extractPlaceholders(ablation);
    const definedNames = new Set((ablation.arguments ?? []).map(a => a.name));

    for (const name of placeholders) {
      if (!definedNames.has(name)) {
        warnings.push(`Placeholder {{${name}}} has no argument definition`);
      }
    }

    const placeholderSet = new Set(placeholders);
    for (const arg of (ablation.arguments ?? [])) {
      if (!placeholderSet.has(arg.name)) {
        warnings.push(`Argument "${arg.name}" is defined but not used in any command`);
      }
    }

    return warnings;
  }

  /**
   * Replace {{name}} placeholders in command strings with resolved values.
   */
  substituteArguments(commands: string[], values: Record<string, string>): string[] {
    return commands.map(cmd => {
      return cmd.replace(/\{\{([^}]+)\}\}/g, (_match, name: string) => {
        const trimmed = name.trim();
        return values[trimmed] ?? `{{${trimmed}}}`;
      });
    });
  }

  // ==================== Attachments Management ====================

  /**
   * Copy referenced attachments to the run directory
   * Only copies attachments that are used in @insert-attachment: commands in the ablation
   */
  copyAttachmentsToRun(runDir: string, ablation: AblationDefinition, resolvedArguments?: Record<string, string>): number {
    const runAttachmentsDir = join(runDir, 'attachments');

    try {
      if (!existsSync(ATTACHMENTS_DIR)) {
        return 0; // No attachments folder
      }

      // Parse commands (and onStart/onEnd) to find @insert-attachment: references
      // Substitute placeholders first so dynamic attachment names are resolved
      const referencedFiles = new Set<string>();
      for (const phase of ablation.phases) {
        const allCommands = [
          ...phase.commands,
          ...(phase.onStart || []),
          ...(phase.onEnd || []),
        ];
        const commands = resolvedArguments
          ? this.substituteArguments(allCommands, resolvedArguments)
          : allCommands;
        for (const command of commands) {
          const match = command.match(/^@insert-attachment:(.+)$/i);
          if (match) {
            const fileName = match[1].trim();
            referencedFiles.add(fileName);
          }
        }
      }

      if (referencedFiles.size === 0) {
        return 0; // No attachments referenced
      }

      // Create attachments directory in run folder
      mkdirSync(runAttachmentsDir, { recursive: true });

      // Copy only referenced attachments
      let copiedCount = 0;
      for (const fileName of referencedFiles) {
        const sourcePath = join(ATTACHMENTS_DIR, fileName);
        if (existsSync(sourcePath)) {
          const destPath = join(runAttachmentsDir, fileName);
          cpSync(sourcePath, destPath);
          copiedCount++;
        } else {
          this.logger.log(`  Warning: Attachment not found: ${fileName}\n`, { type: 'warning' });
        }
      }

      if (copiedCount > 0) {
        this.logger.log(`  Attachments copied (${copiedCount} referenced files)\n`, { type: 'info' });
      }
      return copiedCount;
    } catch (error) {
      this.logger.log(`Failed to copy attachments: ${error}\n`, { type: 'error' });
      return 0;
    }
  }

  // ==================== Outputs Management ====================

  /**
   * Get the stash directory path for preserving original outputs during an ablation.
   * Stored at the ablations level (not inside the run) since it's a temporary working area.
   */
  private getStashDir(_runDir: string): string {
    return join(ABLATIONS_DIR, '_stashed_outputs');
  }

  /**
   * Stash the current outputs folder to preserve original state.
   * Moves contents out so the outputs folder is empty for the ablation.
   * Called once before the ablation starts.
   */
  stashOutputs(runDir: string): boolean {
    const stashDir = this.getStashDir(runDir);

    try {
      mkdirSync(stashDir, { recursive: true });

      if (!existsSync(OUTPUTS_DIR)) {
        writeFileSync(join(stashDir, '.empty'), '', 'utf-8');
        mkdirSync(OUTPUTS_DIR, { recursive: true });
        return true;
      }

      const items = readdirSync(OUTPUTS_DIR);
      if (items.length === 0) {
        writeFileSync(join(stashDir, '.empty'), '', 'utf-8');
        return true;
      }

      // Move contents into stash, then recreate empty outputs preserving subdirectory structure.
      // MCP servers create subdirectories (screenshots/, videos/, etc.) once at startup
      // and expect them to persist — recreate the skeleton so writes don't silently fail.
      cpSync(OUTPUTS_DIR, stashDir, { recursive: true });
      rmSync(OUTPUTS_DIR, { recursive: true, force: true });
      mkdirSync(OUTPUTS_DIR, { recursive: true });
      for (const item of items) {
        const stashedPath = join(stashDir, item);
        if (existsSync(stashedPath) && statSync(stashedPath).isDirectory()) {
          mkdirSync(join(OUTPUTS_DIR, item), { recursive: true });
        }
      }
      this.logger.log(`  Outputs stashed (${items.length} items)\n`, { type: 'info' });
      return true;
    } catch (error) {
      this.logger.log(`Failed to stash outputs: ${error}\n`, { type: 'error' });
      return false;
    }
  }

  /**
   * Clear the outputs folder between model runs.
   * Preserves the subdirectory structure (screenshots/, videos/, etc.) so that
   * MCP servers can still write to their expected paths. MCP servers create
   * these subdirectories once at startup and expect them to persist.
   */
  clearOutputs(): void {
    try {
      if (existsSync(OUTPUTS_DIR)) {
        for (const item of readdirSync(OUTPUTS_DIR)) {
          const itemPath = join(OUTPUTS_DIR, item);
          if (statSync(itemPath).isDirectory()) {
            // Clear directory contents but preserve the directory itself
            for (const child of readdirSync(itemPath)) {
              rmSync(join(itemPath, child), { recursive: true, force: true });
            }
          } else {
            rmSync(itemPath, { force: true });
          }
        }
      } else {
        mkdirSync(OUTPUTS_DIR, { recursive: true });
      }
    } catch (error) {
      this.logger.log(`Failed to clear outputs: ${error}\n`, { type: 'error' });
    }
  }

  /**
   * Clear specific output subdirectories between phases.
   * Preserves the directories themselves (MCP servers expect them to persist).
   */
  resetOutputSubdirs(subdirs: string[]): void {
    for (const subdir of subdirs) {
      const subdirPath = join(OUTPUTS_DIR, subdir);
      try {
        if (existsSync(subdirPath) && statSync(subdirPath).isDirectory()) {
          for (const child of readdirSync(subdirPath)) {
            rmSync(join(subdirPath, child), { recursive: true, force: true });
          }
        }
      } catch (error) {
        this.logger.log(`Failed to reset output subdir "${subdir}": ${error}\n`, { type: 'error' });
      }
    }
  }

  /**
   * Capture all outputs currently in the outputs folder to the run archive.
   * No diffing needed — since outputs were stashed at the start, everything
   * in the folder was produced by the current run.
   * Saves to {modelDir}/(run-{N}/){phase}/ under the run directory.
   */
  captureRunOutputs(runDir: string, phaseName: string, model: AblationModel, runIteration?: number): number {
    const modelDir = this.getModelDirName(model);
    const phaseDir = runIteration !== undefined
      ? join(runDir, modelDir, `run-${runIteration}`, sanitizeFolderName(phaseName))
      : join(runDir, modelDir, sanitizeFolderName(phaseName));

    try {
      if (!existsSync(OUTPUTS_DIR)) {
        return 0;
      }

      const items = readdirSync(OUTPUTS_DIR);
      if (items.length === 0) {
        return 0;
      }

      mkdirSync(phaseDir, { recursive: true });
      cpSync(OUTPUTS_DIR, phaseDir, { recursive: true });
      return items.length;
    } catch (error) {
      this.logger.log(`Failed to capture run outputs: ${error}\n`, { type: 'error' });
      return 0;
    }
  }

  /**
   * Restore the original outputs from the stash after the ablation completes.
   * Removes the stash directory afterward.
   */
  unstashOutputs(runDir: string): void {
    const stashDir = this.getStashDir(runDir);

    try {
      if (!existsSync(stashDir)) {
        return;
      }

      // Clear whatever the last run left behind
      if (existsSync(OUTPUTS_DIR)) {
        rmSync(OUTPUTS_DIR, { recursive: true, force: true });
      }

      const emptyMarker = join(stashDir, '.empty');
      if (existsSync(emptyMarker)) {
        mkdirSync(OUTPUTS_DIR, { recursive: true });
      } else {
        mkdirSync(OUTPUTS_DIR, { recursive: true });
        cpSync(stashDir, OUTPUTS_DIR, { recursive: true });
      }

      // Remove the stash — no longer needed
      rmSync(stashDir, { recursive: true, force: true });
    } catch (error) {
      this.logger.log(`Failed to unstash outputs: ${error}\n`, { type: 'error' });
    }
  }

  /**
   * Restore outputs from a run's phase directory into the local outputs folder.
   * If the outputs folder is not empty, the caller must handle stashing/overwriting first.
   */
  restoreRunOutputs(phaseDir: string): number {
    try {
      if (!existsSync(phaseDir)) {
        this.logger.log(`Phase directory does not exist: ${phaseDir}\n`, { type: 'error' });
        return 0;
      }

      mkdirSync(OUTPUTS_DIR, { recursive: true });

      // Copy all output subdirectories (logs, screenshots, videos, resources) but skip chat/log files
      const skipFiles = new Set(['chat.json', 'chat.md', 'tool-exec-log.json', 'tool-exec-log.md']);
      const items = readdirSync(phaseDir).filter(item => !skipFiles.has(item));

      if (items.length === 0) {
        return 0;
      }

      for (const item of items) {
        const src = join(phaseDir, item);
        const dest = join(OUTPUTS_DIR, item);
        cpSync(src, dest, { recursive: true });
      }

      return items.length;
    } catch (error) {
      this.logger.log(`Failed to restore run outputs: ${error}\n`, { type: 'error' });
      return 0;
    }
  }

  /**
   * Check if the outputs folder has any content.
   */
  isOutputsEmpty(): boolean {
    if (!existsSync(OUTPUTS_DIR)) return true;
    const items = readdirSync(OUTPUTS_DIR);
    if (items.length === 0) return true;
    // Check if all items are empty directories
    for (const item of items) {
      const itemPath = join(OUTPUTS_DIR, item);
      if (!statSync(itemPath).isDirectory()) return false;
      if (readdirSync(itemPath).length > 0) return false;
    }
    return true;
  }

  /**
   * Load a ChatSession from an arbitrary file path (e.g., from an ablation run directory).
   */
  loadChatFromFile(filePath: string): any | null {
    try {
      if (!existsSync(filePath)) {
        return null;
      }
      const content = readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      this.logger.log(`Failed to load chat from file: ${error}\n`, { type: 'error' });
      return null;
    }
  }

  /**
   * Get the phase directory for a specific run result (contains outputs, chat, logs)
   */
  getRunOutputsDir(runDir: string, phaseName: string, model: AblationModel, runIteration?: number): string {
    const modelDir = this.getModelDirName(model);
    if (runIteration !== undefined) {
      return join(runDir, modelDir, `run-${runIteration}`, sanitizeFolderName(phaseName));
    }
    return join(runDir, modelDir, sanitizeFolderName(phaseName));
  }

  /**
   * Format milliseconds as a human-readable duration string
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
  }

  // ==================== MCP Config Path Methods ====================

  /**
   * Get the project root directory (where mcp_config.json is located)
   */
  private getProjectRoot(): string {
    return join(__dirname, '../..');
  }

  /**
   * Resolve MCP config path from ablation definition
   * Supports absolute paths and paths relative to project root
   * @returns Absolute path to the config file
   */
  resolveMcpConfigPath(ablation: AblationDefinition): string | null {
    if (!ablation.settings.mcpConfigPath) {
      return null;
    }

    const configPath = ablation.settings.mcpConfigPath;

    // If absolute path, use as-is
    if (configPath.startsWith('/')) {
      return configPath;
    }

    // Relative path - resolve from project root
    return join(this.getProjectRoot(), configPath);
  }

  /**
   * Validate that an MCP config path exists and has valid JSON format
   * @param path Optional path to validate. If not provided, returns valid with no error.
   * @returns Object with valid boolean and optional error message
   */
  validateMcpConfigPath(path?: string): { valid: boolean; error?: string } {
    if (!path) {
      return { valid: true };
    }

    // Resolve relative paths
    const absolutePath = path.startsWith('/')
      ? path
      : join(this.getProjectRoot(), path);

    // Check if file exists
    if (!existsSync(absolutePath)) {
      return { valid: false, error: `File not found: ${absolutePath}` };
    }

    // Check if file is valid JSON
    try {
      const content = readFileSync(absolutePath, 'utf-8');
      const config = JSON.parse(content);

      // Verify it has the expected structure
      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        return { valid: false, error: 'Invalid config format: missing mcpServers object' };
      }

      return { valid: true };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { valid: false, error: `Invalid JSON: ${error.message}` };
      }
      return { valid: false, error: `Error reading file: ${error}` };
    }
  }

  /**
   * Get the default MCP config file path
   */
  getDefaultMcpConfigPath(): string {
    return join(this.getProjectRoot(), 'mcp_config.json');
  }
}
