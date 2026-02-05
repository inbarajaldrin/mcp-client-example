import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, cpSync, rmSync } from 'fs';
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

export interface AblationPhase {
  name: string;
  commands: string[];
}

export interface AblationSettings {
  maxIterations: number;      // Max agent iterations per run
}

export interface AblationDefinition {
  name: string;
  description: string;
  created: string;
  updated?: string;
  phases: AblationPhase[];
  models: AblationModel[];
  settings: AblationSettings;
}

export interface AblationRunResult {
  phase: string;
  model: AblationModel;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'aborted';
  tokens?: number;
  duration?: number; // milliseconds
  chatFile?: string;
  error?: string;
}

export interface AblationRun {
  ablationName: string;
  startedAt: string;
  completedAt?: string;
  results: AblationRunResult[];
  totalTokens?: number;
  totalDuration?: number;
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
   * Save an ablation definition
   */
  save(ablation: AblationDefinition): void {
    const path = this.getAblationPath(ablation.name);
    const yamlContent = yaml.stringify(ablation);
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
   * Get total number of runs for an ablation (phases × models)
   */
  getTotalRuns(ablation: AblationDefinition): number {
    return ablation.phases.length * ablation.models.length;
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
    const chatsDir = join(runDir, 'chats');

    mkdirSync(runDir, { recursive: true });
    mkdirSync(chatsDir, { recursive: true });

    return { runDir, timestamp };
  }

  /**
   * Create phase directory within a run
   */
  createPhaseDirectory(runDir: string, phaseName: string): string {
    const phaseDir = join(runDir, 'chats', sanitizeFolderName(phaseName));
    mkdirSync(phaseDir, { recursive: true });
    return phaseDir;
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
    const ablationRunsDir = join(RUNS_DIR, sanitizeFolderName(ablationName));
    const runs: { timestamp: string; run: AblationRun }[] = [];

    if (!existsSync(ablationRunsDir)) {
      return runs;
    }

    try {
      const folders = readdirSync(ablationRunsDir);

      for (const folder of folders) {
        const folderPath = join(ablationRunsDir, folder);
        const stats = statSync(folderPath);

        if (stats.isDirectory()) {
          const run = this.loadRunResults(folderPath);
          if (run) {
            runs.push({ timestamp: folder, run });
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

  // ==================== Attachments Management ====================

  /**
   * Copy referenced attachments to the run directory
   * Only copies attachments that are used in /attachment-insert commands in the ablation
   */
  copyAttachmentsToRun(runDir: string, ablation: AblationDefinition): number {
    const runAttachmentsDir = join(runDir, 'attachments');

    try {
      if (!existsSync(ATTACHMENTS_DIR)) {
        return 0; // No attachments folder
      }

      // Parse commands to find /attachment-insert references (by filename)
      const referencedFiles = new Set<string>();
      for (const phase of ablation.phases) {
        for (const command of phase.commands) {
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
   */
  captureRunOutputs(runDir: string, phaseName: string, model: AblationModel): number {
    const snapshotDir = this.getSnapshotDir(runDir);
    const runOutputsDir = join(runDir, 'outputs', sanitizeFolderName(phaseName), sanitizeFolderName(model.model));

    try {
      if (!existsSync(OUTPUTS_DIR)) {
        return 0; // No outputs folder, nothing to capture
      }

      const currentItems = this.getDirectoryContents(OUTPUTS_DIR);
      const snapshotItems = existsSync(snapshotDir) && !existsSync(join(snapshotDir, '.empty'))
        ? this.getDirectoryContents(snapshotDir)
        : new Map<string, { size: number; mtime: number }>();

      // Find new or modified items
      const newItems: string[] = [];
      for (const [relativePath, stats] of currentItems) {
        const snapshotStats = snapshotItems.get(relativePath);
        if (!snapshotStats || stats.size !== snapshotStats.size || stats.mtime > snapshotStats.mtime) {
          newItems.push(relativePath);
        }
      }

      if (newItems.length === 0) {
        return 0; // No new outputs to capture
      }

      // Create run outputs directory
      mkdirSync(runOutputsDir, { recursive: true });

      // Copy new/modified items to run outputs
      for (const relativePath of newItems) {
        const sourcePath = join(OUTPUTS_DIR, relativePath);
        const destPath = join(runOutputsDir, relativePath);

        // Ensure parent directory exists
        mkdirSync(dirname(destPath), { recursive: true });

        const stats = statSync(sourcePath);
        if (stats.isDirectory()) {
          cpSync(sourcePath, destPath, { recursive: true });
        } else {
          cpSync(sourcePath, destPath);
        }
      }

      return newItems.length;
    } catch (error) {
      this.logger.log(`Failed to capture run outputs: ${error}\n`, { type: 'error' });
      return 0;
    }
  }

  /**
   * Get all files/folders in a directory with their stats
   * Returns a map of relative paths to {size, mtime}
   */
  private getDirectoryContents(dir: string, basePath: string = ''): Map<string, { size: number; mtime: number }> {
    const contents = new Map<string, { size: number; mtime: number }>();

    try {
      const items = readdirSync(dir);
      for (const item of items) {
        const fullPath = join(dir, item);
        const relativePath = basePath ? join(basePath, item) : item;
        const stats = statSync(fullPath);

        contents.set(relativePath, {
          size: stats.size,
          mtime: stats.mtimeMs
        });

        if (stats.isDirectory()) {
          // Recursively get contents of subdirectories
          const subContents = this.getDirectoryContents(fullPath, relativePath);
          for (const [subPath, subStats] of subContents) {
            contents.set(subPath, subStats);
          }
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
    } catch (error) {
      this.logger.log(`Failed to cleanup outputs snapshot: ${error}\n`, { type: 'error' });
    }
  }

  /**
   * Get the outputs directory for a specific run result
   */
  getRunOutputsDir(runDir: string, phaseName: string, model: AblationModel): string {
    return join(runDir, 'outputs', sanitizeFolderName(phaseName), sanitizeFolderName(model.model));
  }
}
