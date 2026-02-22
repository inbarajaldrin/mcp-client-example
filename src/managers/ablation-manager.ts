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

export interface PostToolHook {
  after?: string;    // Full tool name to match AFTER execution (e.g. "ros-mcp-server__verify_assembly")
  before?: string;   // Full tool name to match BEFORE execution (only for @tool-exec/@tool commands)
  whenInput?: Record<string, unknown>;   // Match against tool input arguments only
  whenOutput?: Record<string, unknown>;  // Match against tool output JSON only
  run: string;       // Command to execute (e.g. "@tool-exec:ros2-video-recorder__capture_camera_image(...)")
}

export type AblationArgumentType = 'string' | 'attachment';

export interface AblationArgument {
  name: string;                   // Used in {{name}} placeholders
  description?: string;           // Shown to user during collection
  type: AblationArgumentType;     // 'string' = text input, 'attachment' = file picker
  required?: boolean;             // Default: true
  default?: string;               // Fallback value for optional args
}

export interface AblationPhase {
  name: string;
  commands: string[];
  hooks?: PostToolHook[];   // Post-tool hooks for this phase only (in addition to top-level)
  onStart?: string[];       // Commands to run before phase commands
  onEnd?: string[];         // Commands to run after phase commands
}

export interface AblationSettings {
  maxIterations: number;      // Max agent iterations per run
  mcpConfigPath?: string;     // Optional path to custom MCP config file
  clearContextBetweenPhases?: boolean; // Default true; when false, conversation carries over between phases
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
}

export interface AblationRunResult {
  phase: string;
  model: AblationModel;
  run?: number;           // Only populated when runs > 1
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'aborted';
  tokens?: number;
  duration?: number; // milliseconds
  durationFormatted?: string; // human-readable (e.g. "4m 5s")
  chatFile?: string;
  error?: string;
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
   * Get total number of scenarios (phases × models × iterations).
   * A "scenario" = one phase executed by one model in one iteration.
   */
  getTotalScenarios(ablation: AblationDefinition): number {
    const iterations = ablation.runs ?? 1;
    if (ablation.dryRun) {
      return ablation.phases.length * iterations;
    }
    return ablation.phases.length * ablation.models.length * iterations;
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
  saveToolsSnapshot(runDir: string, serversInfo: Array<{ name: string; tools: Array<{ name: string; description: string }> }>): void {
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
  savePromptsSnapshot(runDir: string, prompts: Array<{ server: string; prompt: { name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> } }>): void {
    try {
      const snapshotPath = join(runDir, 'prompts.yaml');
      // Group prompts by server
      const grouped: Record<string, Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>> = {};
      for (const entry of prompts) {
        if (!grouped[entry.server]) grouped[entry.server] = [];
        grouped[entry.server].push(entry.prompt);
      }
      const yamlContent = yaml.stringify({ servers: grouped });
      writeFileSync(snapshotPath, yamlContent, 'utf-8');
    } catch (error) {
      this.logger.log(`Failed to save prompts snapshot: ${error}\n`, { type: 'error' });
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
          scanCommands([hook.run]);
        }
      }
    }
    if (ablation.hooks) {
      for (const hook of ablation.hooks) {
        scanCommands([hook.run]);
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
   * Only copies attachments that are used in /attachment-insert commands in the ablation
   */
  copyAttachmentsToRun(runDir: string, ablation: AblationDefinition, resolvedArguments?: Record<string, string>): number {
    const runAttachmentsDir = join(runDir, 'attachments');

    try {
      if (!existsSync(ATTACHMENTS_DIR)) {
        return 0; // No attachments folder
      }

      // Parse commands to find /attachment-insert references (by filename)
      // Substitute placeholders first so dynamic attachment names are resolved
      const referencedFiles = new Set<string>();
      for (const phase of ablation.phases) {
        const commands = resolvedArguments
          ? this.substituteArguments(phase.commands, resolvedArguments)
          : phase.commands;
        for (const command of commands) {
          // Match /attachment-insert followed by filename
          const match = command.match(/^\/attachment-insert\s+(.+)$/i);
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
