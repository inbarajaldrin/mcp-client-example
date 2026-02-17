import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, statSync, cpSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../logger.js';
import * as yaml from 'yaml';
import { sanitizeFolderName } from '../utils/path-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ABLATIONS_DIR = join(__dirname, '../..', '.mcp-client-data', 'ablations');
const RUNS_DIR = join(ABLATIONS_DIR, 'runs');
const OUTPUTS_DIR = join(__dirname, '../..', '.mcp-client-data', 'outputs');
const ATTACHMENTS_DIR = join(__dirname, '../..', '.mcp-client-data', 'attachments');

// ==================== Types ====================

export interface AblationModel {
  provider: string;
  model: string;
}

export interface PostToolHook {
  after?: string;    // Full tool name to match AFTER execution (e.g. "ros-mcp-server__verify_assembly")
  before?: string;   // Full tool name to match BEFORE execution (only for @tool-exec/@tool commands)
  when?: Record<string, unknown>;  // Optional: only fire if tool result JSON contains these key/value pairs
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
  logFile?: string;       // Path to tool-exec log (dry run only)
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

export interface ToolExecLogEntry {
  commandIndex: number;
  command: string;
  toolName: string;
  args: Record<string, unknown>;
  timestamp: string;
  duration: number;        // milliseconds
  durationFormatted: string;
  success: boolean;
  displayText?: string;
  error?: string;
  isHook?: boolean;        // True if this entry was triggered by a post-tool hook
  triggeredBy?: string;    // Tool name that triggered this hook
}

export interface AblationCommandResult {
  toolExecResult?: {
    toolName: string;
    args: Record<string, unknown>;
    displayText?: string;
    success: boolean;
    error?: string;
  };
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
    return join(ABLATIONS_DIR, `${sanitizeFolderName(name)}.yaml`);
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

    if (!existsSync(ABLATIONS_DIR)) {
      return ablations;
    }

    try {
      const files = readdirSync(ABLATIONS_DIR);

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
   * Get total number of runs for an ablation (phases × models × runs)
   */
  getTotalRuns(ablation: AblationDefinition): number {
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
    const dateFolder = ts.substring(0, 10); // YYYY-MM-DD
    return join(RUNS_DIR, dateFolder, sanitizeFolderName(ablationName), ts);
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
    const chatsDir = join(runDir, 'chats');

    mkdirSync(runDir, { recursive: true });
    mkdirSync(chatsDir, { recursive: true });

    return { runDir, timestamp };
  }

  /**
   * Create phase directory within a run
   * When runIteration is provided (runs > 1), creates chats/run-{N}/{phase}/
   */
  createPhaseDirectory(runDir: string, phaseName: string, runIteration?: number): string {
    const basePath = runIteration !== undefined
      ? join(runDir, 'chats', `run-${runIteration}`, sanitizeFolderName(phaseName))
      : join(runDir, 'chats', sanitizeFolderName(phaseName));
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

      // Scan date folders (YYYY-MM-DD) under runs/
      const dateFolders = readdirSync(RUNS_DIR);
      for (const dateFolder of dateFolders) {
        const ablationDir = join(RUNS_DIR, dateFolder, sanitizeFolderName(ablationName));
        if (!existsSync(ablationDir) || !statSync(ablationDir).isDirectory()) continue;

        const timestampFolders = readdirSync(ablationDir);
        for (const tsFolder of timestampFolders) {
          const folderPath = join(ablationDir, tsFolder);
          if (!statSync(folderPath).isDirectory()) continue;

          const run = this.loadRunResults(folderPath);
          if (run) {
            runs.push({ timestamp: tsFolder, run });
          }
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
   * Get chat file name for a run
   */
  getChatFileName(model: AblationModel): string {
    return `${sanitizeFolderName(model.model)}.json`;
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
   * Get the snapshot directory path within the outputs folder
   */
  private getSnapshotDir(runDir: string): string {
    return join(runDir, 'outputs', '_initial');
  }

  /**
   * Snapshot the current outputs folder to preserve initial state
   * Called once before ablation starts
   */
  snapshotOutputs(runDir: string): boolean {
    const snapshotDir = this.getSnapshotDir(runDir);

    try {
      // Create snapshot directory
      mkdirSync(snapshotDir, { recursive: true });

      if (!existsSync(OUTPUTS_DIR)) {
        // No outputs folder exists, create empty snapshot marker
        writeFileSync(join(snapshotDir, '.empty'), '', 'utf-8');
        return true;
      }

      const items = readdirSync(OUTPUTS_DIR);
      if (items.length === 0) {
        // Outputs folder is empty, create empty snapshot marker
        writeFileSync(join(snapshotDir, '.empty'), '', 'utf-8');
        return true;
      }

      // Copy all contents from outputs to snapshot
      cpSync(OUTPUTS_DIR, snapshotDir, { recursive: true });
      this.logger.log(`  Outputs snapshot saved (${items.length} items)\n`, { type: 'info' });
      return true;
    } catch (error) {
      this.logger.log(`Failed to snapshot outputs: ${error}\n`, { type: 'error' });
      return false;
    }
  }

  /**
   * Restore outputs folder from snapshot
   * Called before each ablation run to ensure consistent starting state
   */
  restoreOutputsFromSnapshot(runDir: string): boolean {
    const snapshotDir = this.getSnapshotDir(runDir);

    try {
      if (!existsSync(snapshotDir)) {
        this.logger.log(`No outputs snapshot found\n`, { type: 'warning' });
        return false;
      }

      // Clear current outputs folder
      if (existsSync(OUTPUTS_DIR)) {
        rmSync(OUTPUTS_DIR, { recursive: true, force: true });
      }

      // Check if snapshot was empty
      const emptyMarker = join(snapshotDir, '.empty');
      if (existsSync(emptyMarker)) {
        // Original outputs was empty, just create empty folder
        mkdirSync(OUTPUTS_DIR, { recursive: true });
        return true;
      }

      // Restore from snapshot
      mkdirSync(OUTPUTS_DIR, { recursive: true });
      cpSync(snapshotDir, OUTPUTS_DIR, { recursive: true });
      return true;
    } catch (error) {
      this.logger.log(`Failed to restore outputs from snapshot: ${error}\n`, { type: 'error' });
      return false;
    }
  }

  /**
   * Capture outputs written during a run and save to run results
   * Identifies new/modified files by comparing against snapshot
   * When runIteration is provided (runs > 1), saves to outputs/run-{N}/{phase}/{model}/
   */
  captureRunOutputs(runDir: string, phaseName: string, model: AblationModel, runIteration?: number): number {
    const snapshotDir = this.getSnapshotDir(runDir);
    const outputsBase = runIteration !== undefined
      ? join(runDir, 'outputs', `run-${runIteration}`, sanitizeFolderName(phaseName), sanitizeFolderName(model.model))
      : join(runDir, 'outputs', sanitizeFolderName(phaseName), sanitizeFolderName(model.model));
    const runOutputsDir = outputsBase;

    try {
      if (!existsSync(OUTPUTS_DIR)) {
        return 0; // No outputs folder, nothing to capture
      }

      const currentItems = this.getDirectoryContents(OUTPUTS_DIR);
      const snapshotItems = existsSync(snapshotDir) && !existsSync(join(snapshotDir, '.empty'))
        ? this.getDirectoryContents(snapshotDir)
        : new Map<string, { size: number }>();

      // Find new or modified items
      // NOTE: We only compare by path existence and file size, NOT mtime.
      // cpSync does not preserve mtimes, so restored files get new mtimes
      // that would incorrectly appear as "modified" when compared to snapshot.
      const newItems: string[] = [];
      for (const [relativePath, stats] of currentItems) {
        const snapshotStats = snapshotItems.get(relativePath);
        if (!snapshotStats || stats.size !== snapshotStats.size) {
          newItems.push(relativePath);
        }
      }

      if (newItems.length === 0) {
        return 0; // No new outputs to capture
      }

      // Create run outputs directory
      mkdirSync(runOutputsDir, { recursive: true });

      // Copy new/modified files to run outputs
      for (const relativePath of newItems) {
        const sourcePath = join(OUTPUTS_DIR, relativePath);
        const destPath = join(runOutputsDir, relativePath);

        // Ensure parent directory exists
        mkdirSync(dirname(destPath), { recursive: true });
        cpSync(sourcePath, destPath);
      }

      return newItems.length;
    } catch (error) {
      this.logger.log(`Failed to capture run outputs: ${error}\n`, { type: 'error' });
      return 0;
    }
  }

  /**
   * Get all files in a directory recursively with their sizes
   * Returns a map of relative paths to {size} (directories are traversed but not included)
   */
  private getDirectoryContents(dir: string, basePath: string = ''): Map<string, { size: number }> {
    const contents = new Map<string, { size: number }>();

    try {
      const items = readdirSync(dir);
      for (const item of items) {
        const fullPath = join(dir, item);
        const relativePath = basePath ? join(basePath, item) : item;
        const stats = statSync(fullPath);

        if (stats.isDirectory()) {
          // Recursively get contents of subdirectories (skip directory entries themselves)
          const subContents = this.getDirectoryContents(fullPath, relativePath);
          for (const [subPath, subStats] of subContents) {
            contents.set(subPath, subStats);
          }
        } else {
          contents.set(relativePath, {
            size: stats.size
          });
        }
      }
    } catch (error) {
      // Ignore errors, return what we have
    }

    return contents;
  }

  /**
   * Clean up after ablation completes
   * Restores the original outputs state from the _initial snapshot
   */
  cleanupOutputsSnapshot(runDir: string, restoreOriginal: boolean = true): void {
    const snapshotDir = this.getSnapshotDir(runDir);

    try {
      if (restoreOriginal && existsSync(snapshotDir)) {
        // Restore original outputs state
        if (existsSync(OUTPUTS_DIR)) {
          rmSync(OUTPUTS_DIR, { recursive: true, force: true });
        }

        const emptyMarker = join(snapshotDir, '.empty');
        if (!existsSync(emptyMarker)) {
          mkdirSync(OUTPUTS_DIR, { recursive: true });
          cpSync(snapshotDir, OUTPUTS_DIR, { recursive: true });
        } else {
          // Original was empty, just create empty folder
          mkdirSync(OUTPUTS_DIR, { recursive: true });
        }
      }

      // Remove the _initial snapshot from the run directory — it was only needed during the run
      if (existsSync(snapshotDir)) {
        rmSync(snapshotDir, { recursive: true, force: true });
      }

      // Remove any empty directories left in the run folder
      this.removeEmptyDirs(runDir);
    } catch (error) {
      this.logger.log(`Failed to cleanup outputs snapshot: ${error}\n`, { type: 'error' });
    }
  }

  /**
   * Recursively remove empty directories within a path.
   * Walks bottom-up so nested empty dirs are cleaned first.
   */
  private removeEmptyDirs(dir: string): void {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;

    for (const item of readdirSync(dir)) {
      const fullPath = join(dir, item);
      if (statSync(fullPath).isDirectory()) {
        this.removeEmptyDirs(fullPath);
      }
    }

    // After cleaning children, remove this dir if now empty (but never the run root)
    if (readdirSync(dir).length === 0) {
      rmdirSync(dir);
    }
  }

  /**
   * Capture all outputs produced during an entire iteration.
   * Identifies new/modified files by comparing against the initial snapshot.
   * When runIteration is provided (runs > 1), saves to outputs/run-{N}/
   * Otherwise saves to outputs/
   */
  captureIterationOutputs(runDir: string, runIteration?: number): number {
    const snapshotDir = this.getSnapshotDir(runDir);
    const runOutputsDir = runIteration !== undefined
      ? join(runDir, 'outputs', `run-${runIteration}`)
      : join(runDir, 'outputs');

    try {
      if (!existsSync(OUTPUTS_DIR)) {
        return 0;
      }

      const currentItems = this.getDirectoryContents(OUTPUTS_DIR);
      const snapshotItems = existsSync(snapshotDir) && !existsSync(join(snapshotDir, '.empty'))
        ? this.getDirectoryContents(snapshotDir)
        : new Map<string, { size: number }>();

      // Find new or modified items (compare by path existence and file size)
      const newItems: string[] = [];
      for (const [relativePath, stats] of currentItems) {
        const snapshotStats = snapshotItems.get(relativePath);
        if (!snapshotStats || stats.size !== snapshotStats.size) {
          newItems.push(relativePath);
        }
      }

      if (newItems.length === 0) {
        return 0;
      }

      mkdirSync(runOutputsDir, { recursive: true });

      for (const relativePath of newItems) {
        const sourcePath = join(OUTPUTS_DIR, relativePath);
        const destPath = join(runOutputsDir, relativePath);
        mkdirSync(dirname(destPath), { recursive: true });
        cpSync(sourcePath, destPath);
      }

      return newItems.length;
    } catch (error) {
      this.logger.log(`Failed to capture iteration outputs: ${error}\n`, { type: 'error' });
      return 0;
    }
  }

  /**
   * Get the outputs directory for a specific run result
   */
  getRunOutputsDir(runDir: string, phaseName: string, model: AblationModel, runIteration?: number): string {
    if (runIteration !== undefined) {
      return join(runDir, 'outputs', `run-${runIteration}`, sanitizeFolderName(phaseName), sanitizeFolderName(model.model));
    }
    return join(runDir, 'outputs', sanitizeFolderName(phaseName), sanitizeFolderName(model.model));
  }

  // ==================== Tool Execution Logs ====================

  /**
   * Create logs directory for a phase within a run.
   * When runIteration is provided (runs > 1), creates logs/run-{N}/{phase}/
   * Otherwise creates logs/{phase}/
   */
  createLogsDirectory(runDir: string, phaseName: string, runIteration?: number): string {
    const logsDir = runIteration !== undefined
      ? join(runDir, 'logs', `run-${runIteration}`, sanitizeFolderName(phaseName))
      : join(runDir, 'logs', sanitizeFolderName(phaseName));
    mkdirSync(logsDir, { recursive: true });
    return logsDir;
  }

  /**
   * Save tool execution log entries as both JSON and Markdown.
   * @returns The relative path to the log file (for storing in AblationRunResult)
   */
  saveToolExecLog(runDir: string, logsDir: string, entries: ToolExecLogEntry[], phaseName: string): string {
    const jsonPath = join(logsDir, 'tool-exec-log.json');
    const mdPath = join(logsDir, 'tool-exec-log.md');

    writeFileSync(jsonPath, JSON.stringify(entries, null, 2), 'utf-8');
    writeFileSync(mdPath, this.formatToolExecLogAsMarkdown(entries, phaseName), 'utf-8');

    // Return relative path from runDir
    const relativePath = logsDir.replace(runDir + '/', '');
    return `${relativePath}/tool-exec-log.json`;
  }

  /**
   * Format tool execution log entries as a human-readable Markdown report.
   * Follows the same style as chat log markdown (generateMarkdownChat).
   */
  private formatToolExecLogAsMarkdown(entries: ToolExecLogEntry[], phaseName: string): string {
    let md = `# Tool Execution Log\n\n`;

    // Header metadata (same style as chat logs)
    md += `**Phase:** ${phaseName}\n`;
    md += `**Generated:** ${new Date().toISOString()}\n`;
    const hookCount = entries.filter(e => e.isHook).length;
    const commandCount = entries.length - hookCount;
    md += `**Total Commands:** ${commandCount}\n`;
    if (hookCount > 0) {
      md += `**Hook Executions:** ${hookCount}\n`;
    }

    const successCount = entries.filter(e => e.success).length;
    const failCount = entries.length - successCount;
    md += `**Succeeded:** ${successCount}\n`;
    if (failCount > 0) {
      md += `**Failed:** ${failCount}\n`;
    }

    // Total duration
    const totalDuration = entries.reduce((sum, e) => sum + e.duration, 0);
    md += `**Total Duration:** ${this.formatDuration(totalDuration)}\n`;

    md += '\n---\n\n';

    // Tool calls (same style as chat log tool messages)
    md += '## Execution Log\n\n';

    for (const entry of entries) {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const statusIndicator = entry.success ? '' : ' *Failed*';

      if (entry.isHook) {
        md += `### Hook → Tool: ${entry.toolName}${statusIndicator}\n\n`;
        md += `Triggered by: \`${entry.triggeredBy}\` | Duration: ${entry.durationFormatted}\n\n`;
      } else {
        md += `### Tool: ${entry.toolName}${statusIndicator}\n\n`;
        md += `Command ${entry.commandIndex + 1}: \`${entry.command}\` | Duration: ${entry.durationFormatted}\n\n`;
      }

      // Input (same format as chat logs)
      md += `**Input (${time}):**\n\`\`\`json\n${JSON.stringify(entry.args, null, 2)}\n\`\`\`\n\n`;

      // Output or error (same format as chat logs)
      if (entry.error) {
        const endTime = new Date(new Date(entry.timestamp).getTime() + entry.duration).toLocaleTimeString();
        md += `**Error (${endTime}):**\n\`\`\`\n${entry.error}\n\`\`\`\n\n`;
      } else if (entry.displayText) {
        const endTime = new Date(new Date(entry.timestamp).getTime() + entry.duration).toLocaleTimeString();

        // Try to parse output as JSON for consistent formatting (same as chat logs)
        let outputFormatted = entry.displayText;
        let outputLang = '';
        try {
          const cleanOutput = entry.displayText.replace(/\u001b\[[0-9;]*m/g, '');
          const parsed = JSON.parse(cleanOutput);
          outputFormatted = JSON.stringify(parsed, null, 2);
          outputLang = 'json';
        } catch {
          // Not JSON, use as-is
        }

        md += `**Output (${endTime}):**\n\`\`\`${outputLang ? ' ' + outputLang : ''}\n${outputFormatted}\n\`\`\`\n\n`;
      }
    }

    return md;
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
