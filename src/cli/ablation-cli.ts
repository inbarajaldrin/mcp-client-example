/**
 * CLI operations for ablation study management.
 */

import readline from 'readline/promises';
import chalk from 'chalk';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCPClient } from '../index.js';
import { Logger } from '../logger.js';
import {
  AblationManager,
  type AblationDefinition,
  type AblationPhase,
  type AblationModel,
  type AblationRun,
  type AblationRunResult,
  type AblationCommandResult,
  type PostToolHook,
  type AblationArgument,
  type AblationArgumentType,
} from '../managers/ablation-manager.js';
import { sanitizeFolderName } from '../utils/path-utils.js';
import type { Message } from '../model-provider.js';

// ==================== Tool Schema Types ====================

interface ToolWithSchema {
  name: string;
  server: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
  };
}

// ==================== Tool Call Parsing (shared utilities) ====================

import { parseDirectToolCall, parsePythonArgs, matchesWhenInputCondition, matchesWhenOutputCondition } from '../utils/hook-utils.js';
import type { ParsedToolCall } from '../utils/hook-utils.js';
import { AttachmentManager, type AttachmentInfo } from '../managers/attachment-manager.js';
import { AblationRunner, type RunControl, type RunObserver, type RunHost } from '../ablation-runner.js';
import type { HookManager } from '../managers/hook-manager.js';
import { PreferencesManager } from '../managers/preferences-manager.js';
import { createProvider, PROVIDERS } from '../bin.js';
import type { ModelInfo, ModelProvider as IModelProvider } from '../model-provider.js';
import type { ModelProvider } from '../model-provider.js';
import type { ToolCLI } from './tool-cli.js';
import type { PromptCLI } from './prompt-cli.js';
import type { AttachmentCLI } from './attachment-cli.js';
import { isReasoningModel, getThinkingLevelsForProvider, getDefaultThinkingLevel } from '../utils/model-capabilities.js';

/**
 * Format milliseconds as human-readable duration (e.g. "4m 5s", "1h 23m 45s")
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Callbacks for AblationCLI to interact with parent component.
 */
export interface AblationCLICallbacks {
  /** Get current readline interface */
  getReadline: () => readline.Interface | null;
  /** Get pending attachments */
  getPendingAttachments: () => AttachmentInfo[];
  /** Set pending attachments */
  setPendingAttachments: (attachments: AttachmentInfo[]) => void;
  /** Get ToolCLI instance */
  getToolCLI: () => ToolCLI;
  /** Get PromptCLI instance */
  getPromptCLI: () => PromptCLI;
  /** Get AttachmentCLI instance */
  getAttachmentCLI: () => AttachmentCLI;
  /** Display help */
  displayHelp: () => void;
  /** Display settings */
  displaySettings: () => Promise<void>;
  /** Check if hard abort was requested (Ctrl+C in abort mode) */
  isAbortRequested: () => boolean;
  /** Check if soft interrupt was requested (Ctrl+A — pause for user input) */
  isInterruptRequested: () => boolean;
  /** Reset abort state (Ctrl+C flag) */
  resetAbort: () => void;
  /** Reset interrupt state (Ctrl+A flag) */
  resetInterrupt: () => void;
  /** Enable abort mode (Ctrl+C sets flag instead of exiting) */
  setAbortMode: (enabled: boolean) => void;
  /** Start keyboard monitor to capture Ctrl+A for interrupt */
  startKeyboardMonitor: () => void;
  /** Stop keyboard monitor */
  stopKeyboardMonitor: () => void;
  /** Collect a line of input while staying in raw mode (prevents SIGINT to children) */
  collectInput: (prompt: string) => Promise<string | null>;
  /** Get HIL manager */
  getHILManager: () => any; // HumanInTheLoopManager
  /** Route a slash command through the main CLI's full command handler.
   * Returns true if the command was handled, false if unrecognized. */
  routeSlashCommand: (command: string) => Promise<boolean>;
  /** Get ChatHistoryCLI instance for restoring chat from ablation runs */
  getChatHistoryCLI: () => import('./chat-history-cli.js').ChatHistoryCLI;
  /** Restore the CLI's iteration-limit callback on the MCPClient (cleared during ablation) */
  restoreIterationLimitCallback: () => void;
  /** Signal the main chat loop to auto-continue (trigger agent without user input) */
  setPendingContinuation: () => void;
}

/**
 * Handles CLI operations for ablation study creation, editing, running, and results.
 */
export class AblationCLI {
  private client: MCPClient;
  private logger: Logger;
  private ablationManager: AblationManager;
  private attachmentManager: AttachmentManager;
  private preferencesManager: PreferencesManager;
  private callbacks: AblationCLICallbacks;
  private lastAblationMcpConfigPath: string | null = null;
  private continuationPhaseDir: string | null = null;
  private continuationRunDir: string | null = null;
  private pendingBatchQueue: Array<{
    runDir: string;
    phaseDir: string;
    phaseName: string;
    model: import('../managers/ablation-manager.js').AblationModel;
    run?: number;
    mode: 'continue' | 'interact';
  }> = [];

  getContinuationPhaseDir(): string | null {
    return this.continuationPhaseDir;
  }

  /**
   * Finalize a continuation: save chat + outputs to a new timestamped
   * subdirectory under the phase dir. Original run data is never touched.
   * Then unstash the user's original outputs and clear continuation state.
   * Returns the continuation directory path, or null on failure.
   */
  finalizeContinuation(): string | null {
    const phaseDir = this.continuationPhaseDir;
    const runDir = this.continuationRunDir;
    if (!phaseDir) return null;

    // Create a unique continuation directory: phaseDir/continuation-<timestamp>
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const contDir = join(phaseDir, `continuation-${ts}`);
    mkdirSync(contDir, { recursive: true });

    // Save chat into the continuation directory
    const chatJsonPath = join(contDir, 'chat.json');
    const chatMdPath = join(contDir, 'chat.md');
    const saved = this.client.getChatHistoryManager().snapshotToFile(chatJsonPath, chatMdPath);
    if (saved) {
      this.logger.log(`  Chat saved to ${contDir}/chat.json\n`, { type: 'info' });
    }

    // Capture continuation outputs
    try {
      const outputsDir = this.ablationManager.getOutputsDir();
      if (existsSync(outputsDir)) {
        cpSync(outputsDir, contDir, { recursive: true });
        this.logger.log(`  Outputs captured to ${contDir}\n`, { type: 'info' });
      }
    } catch (err) {
      this.logger.log(`  Warning: failed to capture outputs: ${err}\n`, { type: 'warning' });
    }

    // Unstash original outputs
    if (runDir) {
      this.ablationManager.unstashOutputs(runDir);
      this.logger.log('  Original outputs restored from stash.\n', { type: 'info' });
    }

    // Clear chat context
    this.client.clearContext();
    this.logger.log('  Chat context cleared (original session ended).\n', { type: 'info' });

    this.continuationPhaseDir = null;
    this.continuationRunDir = null;
    return contDir;
  }

  constructor(
    client: MCPClient,
    logger: Logger,
    ablationManager: AblationManager,
    attachmentManager: AttachmentManager,
    preferencesManager: PreferencesManager,
    callbacks: AblationCLICallbacks,
  ) {
    this.client = client;
    this.logger = logger;
    this.ablationManager = ablationManager;
    this.attachmentManager = attachmentManager;
    this.preferencesManager = preferencesManager;
    this.callbacks = callbacks;
  }





  /**
   * Check if input is an exit/quit command.
   */
  private isExitCommand(input: string): boolean {
    const trimmed = input.trim().toLowerCase();
    return trimmed === 'exit' || trimmed === '/exit';
  }

  /**
   * Check if user input is an exit command and exit the process if so.
   * Used at selection prompts (not during active runs — those use isExitCommand + abort).
   */
  private checkExitCommand(input: string): void {
    if (this.isExitCommand(input)) {
      this.logger.log('\nGoodbye!\n', { type: 'warning' });
      process.exit(0);
    }
  }

  /**
   * Handle /ablation-create command - Interactive wizard to create ablation study
   */
  async handleAblationCreate(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    this.logger.log(
      '\n┌─────────────────────────────────────────────────────────────┐\n',
      { type: 'info' },
    );
    this.logger.log(
      '│  ABLATION STUDY CREATOR                                     │\n',
      { type: 'info' },
    );
    this.logger.log(
      '└─────────────────────────────────────────────────────────────┘\n',
      { type: 'info' },
    );

    // Step 1: Basic Info
    this.logger.log('\nStep 1: Basic Info\n', { type: 'info' });

    const name = (await rl.question('  Ablation name: ')).trim();
    if (!name) {
      this.logger.log('\n✗ Ablation name is required.\n', { type: 'error' });
      return;
    }

    // Check if already exists
    const existing = this.ablationManager.load(name);
    if (existing) {
      this.logger.log(
        `\n✗ Ablation "${name}" already exists. Use /ablation-edit to modify it.\n`,
        { type: 'error' },
      );
      return;
    }

    const description = (
      await rl.question('  Description (optional): ')
    ).trim();

    // Step 2: Select Models (with retry loop)
    const models: AblationModel[] = [];

    while (models.length === 0) {
      this.logger.log('\nStep 2: Select Models (multi-select)\n', {
        type: 'info',
      });

      this.logger.log('  Available providers:\n', { type: 'info' });
      for (let i = 0; i < PROVIDERS.length; i++) {
        this.logger.log(`    ${i + 1}. ${PROVIDERS[i].label}\n`, { type: 'info' });
      }

      const providerSelection = (
        await rl.question('\n  Select providers (e.g., 1,2 or 1-3): ')
      ).trim();
      const selectedProviderIndices = this.parseSelection(
        providerSelection,
        PROVIDERS.length,
      );

      if (selectedProviderIndices.length === 0) {
        this.logger.log('\n✗ Invalid selection. Please try again.\n', {
          type: 'error',
        });
        continue;
      }

      for (const providerIdx of selectedProviderIndices) {
        const provider = PROVIDERS[providerIdx - 1];
        this.logger.log(`\n  Select ${provider.label} models:\n`, {
          type: 'info',
        });

        for (let i = 0; i < provider.models.length; i++) {
          this.logger.log(`    ${i + 1}. ${provider.models[i]}\n`, {
            type: 'info',
          });
        }
        this.logger.log(`    ${provider.models.length + 1}. Enter custom model name\n`, {
          type: 'info',
        });
        this.logger.log(`    ${provider.models.length + 2}. Discover models from API\n`, {
          type: 'info',
        });

        const modelSelection = (
          await rl.question('\n  Select models (e.g., 1,2 or 1-3): ')
        ).trim();
        const selectedModelIndices = this.parseSelection(
          modelSelection,
          provider.models.length + 2,
        );

        for (const modelIdx of selectedModelIndices) {
          if (modelIdx === provider.models.length + 2) {
            // Discover from API
            const discoveredModels = await this.discoverModelsFromAPI(
              provider.name,
            );
            if (discoveredModels.length > 0) {
              this.logger.log(
                `\n  Discovered ${discoveredModels.length} models from ${provider.label}:\n`,
                { type: 'info' },
              );
              for (let i = 0; i < discoveredModels.length; i++) {
                const m = discoveredModels[i];
                const contextInfo = m.contextWindow
                  ? ` (${Math.round(m.contextWindow / 1000)}K)`
                  : '';
                this.logger.log(`    ${i + 1}. ${m.id}${contextInfo}\n`, {
                  type: 'info',
                });
              }
              const discoverSelection = (
                await rl.question(
                  '\n  Select discovered models (e.g., 1,2 or 1-3): ',
                )
              ).trim();
              const discoverIndices = this.parseSelection(
                discoverSelection,
                discoveredModels.length,
              );
              for (const idx of discoverIndices) {
                const m: AblationModel = {
                  provider: provider.name,
                  model: discoveredModels[idx - 1].id,
                };
                models.push(m);
                await this.promptForThinking(m);
              }
            }
          } else if (modelIdx === provider.models.length + 1) {
            // Custom model
            const customModel = (
              await rl.question('  Enter custom model name: ')
            ).trim();
            if (customModel) {
              const m: AblationModel = { provider: provider.name, model: customModel };
              models.push(m);
              await this.promptForThinking(m);
            }
          } else {
            const m: AblationModel = {
              provider: provider.name,
              model: provider.models[modelIdx - 1],
            };
            models.push(m);
            await this.promptForThinking(m);
          }
        }
      }

      if (models.length === 0) {
        this.logger.log('\n✗ At least one model is required. Please try again.\n', {
          type: 'error',
        });
      }
    }

    // Step 3: Settings
    this.logger.log('\nStep 3: Settings\n', { type: 'info' });

    // MCP Config Path
    this.logger.log('  MCP config file for this ablation.\n', { type: 'info' });
    this.logger.log('  Supports relative paths (from project root) or absolute paths.\n', { type: 'info' });
    this.logger.log('  Leave empty to use the default.\n', { type: 'info' });

    const defaultMcpConfigPath = this.ablationManager.getDefaultMcpConfigPath();
    let mcpConfigPath: string = defaultMcpConfigPath;
    const mcpConfigInput = (
      await rl.question(`  MCP config path (default: ${defaultMcpConfigPath}): `)
    ).trim();

    if (mcpConfigInput) {
      const validation = this.ablationManager.validateMcpConfigPath(mcpConfigInput);
      if (validation.valid) {
        mcpConfigPath = mcpConfigInput;
        this.logger.log(`  ✓ Valid MCP config: ${mcpConfigInput}\n`, { type: 'success' });
      } else {
        this.logger.log(`  ⚠ Warning: ${validation.error}\n`, { type: 'warning' });
        const useAnyway = (
          await rl.question('  Use this path anyway? (y/N): ')
        ).trim().toLowerCase();
        if (useAnyway === 'y' || useAnyway === 'yes') {
          mcpConfigPath = mcpConfigInput;
        } else {
          this.logger.log(`  Using default: ${defaultMcpConfigPath}\n`, { type: 'info' });
        }
      }
    } else {
      this.logger.log(`  ✓ Using default: ${defaultMcpConfigPath}\n`, { type: 'info' });
    }

    // Max Iterations
    this.logger.log('\n  Max iterations controls how many agent turns the model can take\n', { type: 'info' });
    this.logger.log('  per phase run. Use -1 for unlimited, or a positive number to cap it.\n', { type: 'info' });
    const defaultMaxIterations = this.preferencesManager.getMaxIterations();
    const maxIterationsStr = (
      await rl.question(
        `  Max iterations per run (default ${defaultMaxIterations}): `,
      )
    ).trim();
    const maxIterations = maxIterationsStr
      ? parseInt(maxIterationsStr) || defaultMaxIterations
      : defaultMaxIterations;

    // MCP Timeout
    const defaultMcpTimeout = this.preferencesManager.getMCPTimeout();
    const mcpTimeoutStr = (
      await rl.question(
        `  MCP tool timeout in seconds (default ${defaultMcpTimeout}, Enter to use system default): `,
      )
    ).trim();
    const mcpTimeout = mcpTimeoutStr ? parseInt(mcpTimeoutStr) || undefined : undefined;

    // Max IPC Calls
    const defaultMaxIpcCalls = this.preferencesManager.getMaxIpcCalls();
    const maxIpcCallsStr = (
      await rl.question(
        `  Max IPC calls per phase (default ${defaultMaxIpcCalls}, Enter to use system default): `,
      )
    ).trim();
    const maxIpcCalls = maxIpcCallsStr ? parseInt(maxIpcCallsStr) || undefined : undefined;

    const runsStr = (
      await rl.question('  Number of repeat runs (default 1): ')
    ).trim();
    const runs = runsStr ? parseInt(runsStr) || 1 : 1;

    this.logger.log('\n  When disabled, conversation history carries over between phases\n', { type: 'info' });
    this.logger.log('  for the same model (one continuous chat instead of per-phase chats).\n', { type: 'info' });
    const clearCtxStr = (
      await rl.question('  Clear context between phases? (Y/n, default yes): ')
    ).trim().toLowerCase();
    const clearContextBetweenPhases = (clearCtxStr === 'n' || clearCtxStr === 'no') ? false : undefined;

    // Step 4: Define Phases
    this.logger.log('\nStep 4: Define Phases (command sequences)\n', {
      type: 'info',
    });
    const phases: AblationPhase[] = [];

    while (true) {
      this.logger.log(
        `\n── Phase ${phases.length + 1} ──────────────────────────────────────────────\n`,
        { type: 'info' },
      );

      const phaseName = (await rl.question('  Phase name: ')).trim();
      if (!phaseName) {
        if (phases.length === 0) {
          this.logger.log('\n✗ At least one phase is required.\n', {
            type: 'error',
          });
          continue;
        }
        break;
      }

      // Check for duplicate phase name
      if (phases.some((p) => p.name === phaseName)) {
        this.logger.log(
          '\n✗ Phase name already exists. Please use a unique name.\n',
          { type: 'error' },
        );
        continue;
      }

      this.logger.log('  Enter commands (empty line to finish):\n', {
        type: 'info',
      });
      this.logger.log(
        '  Commands starting with "/" will execute to show their output.\n',
        { type: 'info' },
      );
      this.logger.log(
        '  Type "@tool" for interactive tool builder (guided wizard).\n',
        { type: 'info' },
      );
      this.logger.log(
        '  Or directly: @tool:server__tool(arg=\'value\', num=42)\n',
        { type: 'info' },
      );
      this.logger.log(
        '  Use @tool-exec for execution without context injection.\n',
        { type: 'info' },
      );
      this.logger.log(
        '  Use @shell:<command> to run a CLI command in the system shell.\n',
        { type: 'info' },
      );
      this.logger.log('  Type "done" to finish the phase.\n', { type: 'info' });
      const commands: string[] = [];
      let pendingCommand: string | null = null; // Track commands waiting for an argument

      while (true) {
        const input = (await rl.question('    > ')).trim();

        if (!input || input.toLowerCase() === 'done') {
          // If there's a pending command without argument, warn the user
          if (pendingCommand) {
            this.logger.log(
              `    ⚠ Warning: "${pendingCommand}" was not recorded (missing argument)\n`,
              { type: 'warning' },
            );
            pendingCommand = null;
          }
          break;
        }

        // Check if there's a pending command waiting for an argument
        if (pendingCommand) {
          // Combine the pending command with this input as the argument
          let fullCommand = `${pendingCommand} ${input}`;

          // Check if this is @insert-prompt: - resolve index to server__promptName for consistent matching
          if (pendingCommand.toLowerCase().startsWith('@insert-prompt')) {
            const promptIndex = parseInt(input) - 1;
            const allPrompts = this.client.listPrompts();
            const promptMgr = this.client.getPromptManager();
            const enabledPrompts = promptMgr.filterPrompts(allPrompts);

            if (promptIndex >= 0 && promptIndex < enabledPrompts.length) {
              const promptInfo = enabledPrompts[promptIndex];
              const promptKey = `${promptInfo.server}__${promptInfo.prompt.name}`;
              fullCommand = `@insert-prompt:${promptKey}`;

              // Collect arguments if the prompt has any
              const promptArgs = await this.collectPromptArgumentsForAblation(input);
              if (promptArgs) {
                fullCommand = `@insert-prompt:${promptKey} ${JSON.stringify(promptArgs)}`;
              }
            } else {
              this.logger.log(
                `    ✗ Invalid prompt index: ${input}\n`,
                { type: 'error' },
              );
              pendingCommand = null;
              continue;
            }
          }

          // Check if this is @insert-resource: - resolve index to server__resourceName for consistent matching
          if (pendingCommand.toLowerCase().startsWith('@insert-resource')) {
            const resourceIndex = parseInt(input) - 1;
            const allResources = this.client.listResources();
            const resourceMgr = this.client.getResourceManager();
            const enabledResources = resourceMgr.filterResources(allResources);

            if (resourceIndex >= 0 && resourceIndex < enabledResources.length) {
              const resourceInfo = enabledResources[resourceIndex];
              const resourceKey = `${resourceInfo.server}__${resourceInfo.resource.name}`;
              fullCommand = `@insert-resource:${resourceKey}`;
            } else {
              this.logger.log(
                `    ✗ Invalid resource index: ${input}\n`,
                { type: 'error' },
              );
              pendingCommand = null;
              continue;
            }
          }

          // Check if this is @insert-attachment: - resolve index to filename for consistent matching
          if (pendingCommand.toLowerCase().startsWith('@insert-attachment')) {
            const attachmentIndex = parseInt(input) - 1;
            const attachments = this.attachmentManager.listAttachments();
            if (
              attachmentIndex >= 0 &&
              attachmentIndex < attachments.length
            ) {
              const attachment = attachments[attachmentIndex];
              fullCommand = `@insert-attachment:${attachment.fileName}`;
            } else {
              this.logger.log(
                `    ✗ Invalid attachment index: ${input}\n`,
                { type: 'error' },
              );
              pendingCommand = null;
              continue;
            }
          }

          commands.push(fullCommand);
          this.logger.log(`    ✓ Recorded: ${fullCommand}\n`, {
            type: 'success',
          });
          pendingCommand = null;
          continue;
        }

        // Check if this is a command that needs an argument
        const needsArgument = this.commandNeedsArgument(input);

        if (needsArgument) {
          // Show preview and wait for argument
          pendingCommand = input;
          await this.executeAblationPreviewCommand(input);
          this.logger.log(`    ↳ Enter selection for ${input}:\n`, {
            type: 'info',
          });
        } else {
          // Check for bare @tool or @tool-exec (interactive wizard trigger)
          if (input === '@tool' || input === '@tool-exec') {
            const injectResult = input === '@tool';
            const generatedCommand = await this.buildToolCallInteractively(injectResult);
            if (generatedCommand) {
              commands.push(generatedCommand);
              this.logger.log(`\n    ✓ Recorded: ${generatedCommand}\n`, { type: 'success' });
            } else {
              this.logger.log('    ✗ Tool builder cancelled.\n', { type: 'warning' });
            }
            continue;
          }

          // Record the input directly
          commands.push(input);
          this.logger.log(`    ✓ Recorded: ${input}\n`, { type: 'success' });

          // If it's a command, execute it to show the output
          if (input.startsWith('/')) {
            await this.executeAblationPreviewCommand(input);
          } else if (input.match(/^@wait:\d+(?:\.\d+)?$/)) {
            const seconds = parseFloat(input.slice('@wait:'.length));
            this.logger.log(`    ℹ️  Wait: ${seconds}s pause before next command\n`, { type: 'info' });
          } else if (input.startsWith('@tool:') || input.startsWith('@tool-exec:')) {
            // Validate tool call syntax during creation
            const parsed = parseDirectToolCall(input);
            if (parsed) {
              const injectInfo = parsed.injectResult ? ' (result will be injected into context)' : ' (execute only, no context injection)';
              this.logger.log(`    ℹ️  Tool call: ${parsed.toolName}${injectInfo}\n`, { type: 'info' });
            } else {
              this.logger.log(`    ⚠️  Warning: Invalid tool call syntax\n`, { type: 'warning' });
            }
          } else if (input.startsWith('@shell:')) {
            const shellCmd = input.slice('@shell:'.length).trim();
            if (shellCmd) {
              this.logger.log(`    ℹ️  Shell command: ${shellCmd}\n`, { type: 'info' });
            } else {
              this.logger.log(`    ⚠️  Warning: Empty shell command\n`, { type: 'warning' });
            }
          }
        }
      }

      if (commands.length === 0) {
        this.logger.log('\n✗ At least one command is required for a phase.\n', {
          type: 'error',
        });
        continue;
      }

      // Show recorded commands
      this.logger.log(`\n  Recorded ${commands.length} command(s):\n`, {
        type: 'info',
      });
      for (let i = 0; i < commands.length; i++) {
        this.logger.log(`    ${i + 1}. ${commands[i]}\n`, { type: 'info' });
      }

      phases.push({ name: phaseName, enabled: true, commands });

      const addAnother = (
        await rl.question('\n  Add another phase? (Y/n): ')
      )
        .trim()
        .toLowerCase();
      if (addAnother === 'n' || addAnother === 'no') {
        break;
      }
    }

    // Step 5: Dynamic Arguments (auto-detected from {{placeholders}})
    const tempAblation: AblationDefinition = {
      name: '', description: '', created: '', phases, models: [], settings: { maxIterations: 0 },
    };
    const detectedPlaceholders = this.ablationManager.extractPlaceholders(tempAblation);
    const ablationArguments: AblationArgument[] = [];

    if (detectedPlaceholders.length > 0) {
      this.logger.log('\nStep 5: Dynamic Arguments\n', { type: 'info' });
      this.logger.log(`  Detected {{placeholders}} in commands: ${detectedPlaceholders.map(p => `{{${p}}}`).join(', ')}\n`, { type: 'info' });
      this.logger.log('  Define how each placeholder should be resolved at runtime.\n', { type: 'info' });

      for (const name of detectedPlaceholders) {
        this.logger.log(`\n  Argument: {{${name}}}\n`, { type: 'info' });

        const argDescription = (
          await rl.question('    Description (optional): ')
        ).trim();

        this.logger.log('    Type:\n', { type: 'info' });
        this.logger.log('      1. string - Text input\n', { type: 'info' });
        this.logger.log('      2. attachment - File picker\n', { type: 'info' });
        const typeChoice = (
          await rl.question('    Select type (1): ')
        ).trim();
        const argType: AblationArgumentType = typeChoice === '2' ? 'attachment' : 'string';

        const requiredInput = (
          await rl.question('    Required? (Y/n): ')
        ).trim().toLowerCase();
        const argRequired = requiredInput !== 'n' && requiredInput !== 'no';

        let argDefault: string | undefined;
        if (!argRequired) {
          argDefault = (
            await rl.question('    Default value (optional): ')
          ).trim() || undefined;
        }

        const arg: AblationArgument = { name, type: argType };
        if (argDescription) arg.description = argDescription;
        if (!argRequired) arg.required = false;
        if (argDefault) arg.default = argDefault;

        ablationArguments.push(arg);
        this.logger.log(`    ✓ Defined: {{${name}}} (${argType}${argRequired ? ', required' : ''}${argDefault ? `, default: ${argDefault}` : ''})\n`, { type: 'success' });
      }
    } else {
      const defineArgs = (
        await rl.question('\nStep 5: Define dynamic arguments? (y/N): ')
      ).trim().toLowerCase();

      if (defineArgs === 'y' || defineArgs === 'yes') {
        this.logger.log('  Use {{name}} syntax in commands to reference these arguments.\n', { type: 'info' });
        while (true) {
          const argName = (
            await rl.question('\n  Argument name (empty to finish): ')
          ).trim();
          if (!argName) break;

          const argDescription = (
            await rl.question('    Description (optional): ')
          ).trim();

          this.logger.log('    Type:\n', { type: 'info' });
          this.logger.log('      1. string - Text input\n', { type: 'info' });
          this.logger.log('      2. attachment - File picker\n', { type: 'info' });
          const typeChoice = (
            await rl.question('    Select type (1): ')
          ).trim();
          const argType: AblationArgumentType = typeChoice === '2' ? 'attachment' : 'string';

          const requiredInput = (
            await rl.question('    Required? (Y/n): ')
          ).trim().toLowerCase();
          const argRequired = requiredInput !== 'n' && requiredInput !== 'no';

          let argDefault: string | undefined;
          if (!argRequired) {
            argDefault = (
              await rl.question('    Default value (optional): ')
            ).trim() || undefined;
          }

          const arg: AblationArgument = { name: argName, type: argType };
          if (argDescription) arg.description = argDescription;
          if (!argRequired) arg.required = false;
          if (argDefault) arg.default = argDefault;

          ablationArguments.push(arg);
          this.logger.log(`    ✓ Defined: {{${argName}}} (${argType}${argRequired ? ', required' : ''}${argDefault ? `, default: ${argDefault}` : ''})\n`, { type: 'success' });
        }
      }
    }

    // Validate arguments against commands
    if (ablationArguments.length > 0) {
      tempAblation.arguments = ablationArguments;
      const warnings = this.ablationManager.validateArguments(tempAblation);
      for (const warning of warnings) {
        this.logger.log(`  ⚠ ${warning}\n`, { type: 'warning' });
      }
    }

    // Step 6: Tool Hooks (optional)
    this.logger.log('\nStep 6: Tool Hooks (optional)\n', { type: 'info' });
    this.logger.log('  Automatically run a command before or after a specific tool call.\n', { type: 'info' });

    const topLevelHooks: PostToolHook[] = [];
    const phaseHooksMap = new Map<string, PostToolHook[]>();

    const addHooks = (
      await rl.question('  Add tool hooks? (y/N): ')
    ).trim().toLowerCase();

    if (addHooks === 'y' || addHooks === 'yes') {
      while (true) {
        this.logger.log('  Timing:\n', { type: 'info' });
        this.logger.log('    1. After (run after tool completes)\n', { type: 'info' });
        this.logger.log('    2. Before (run before tool executes)\n', { type: 'info' });
        const timingStr = (await rl.question('  Select timing: ')).trim();
        const isBefore = timingStr === '2';

        const toolName = (
          await rl.question('  Tool name to watch (e.g. ros-mcp-server__verify_assembly): ')
        ).trim();
        if (!toolName) break;

        const runCmd = (
          await rl.question(`  Command to run ${isBefore ? 'before' : 'after'} (e.g. @tool-exec:server__tool(arg='val')): `)
        ).trim();
        if (!runCmd) break;

        const newHook: PostToolHook = isBefore
          ? { before: toolName, run: runCmd }
          : { after: toolName, run: runCmd };

        // Ask for optional condition (after-hooks only)
        if (!isBefore) {
          const condType = (
            await rl.question('  Add condition? (1=output, 2=input, N=none): ')
          ).trim().toLowerCase();
          if (condType === '1' || condType === 'output') {
            const whenOutput: Record<string, unknown> = {};
            this.logger.log('  Enter key=value pairs for tool output (empty key to finish):\n', { type: 'info' });
            while (true) {
              const key = (await rl.question('    Key: ')).trim();
              if (!key) break;
              const rawValue = (await rl.question('    Value: ')).trim();
              let value: unknown = rawValue;
              if (rawValue === 'true') value = true;
              else if (rawValue === 'false') value = false;
              else if (rawValue !== '' && !isNaN(Number(rawValue))) value = Number(rawValue);
              whenOutput[key] = value;
            }
            if (Object.keys(whenOutput).length > 0) {
              newHook.whenOutput = whenOutput;
            }
          } else if (condType === '2' || condType === 'input') {
            const whenInput: Record<string, unknown> = {};
            this.logger.log('  Enter key=value pairs for tool input (empty key to finish):\n', { type: 'info' });
            while (true) {
              const key = (await rl.question('    Key: ')).trim();
              if (!key) break;
              const rawValue = (await rl.question('    Value: ')).trim();
              let value: unknown = rawValue;
              if (rawValue === 'true') value = true;
              else if (rawValue === 'false') value = false;
              else if (rawValue !== '' && !isNaN(Number(rawValue))) value = Number(rawValue);
              whenInput[key] = value;
            }
            if (Object.keys(whenInput).length > 0) {
              newHook.whenInput = whenInput;
            }
          }
        }

        // Ask where to apply
        this.logger.log('  Apply to:\n', { type: 'info' });
        this.logger.log('    1. All phases\n', { type: 'info' });
        for (let i = 0; i < phases.length; i++) {
          this.logger.log(`    ${i + 2}. Phase: ${phases[i].name}\n`, { type: 'info' });
        }

        const scopeStr = (
          await rl.question('  Select scope: ')
        ).trim();
        const scopeIdx = parseInt(scopeStr);

        const trigger = isBefore ? `before ${toolName}` : `after ${toolName}`;
        if (scopeIdx === 1) {
          topLevelHooks.push(newHook);
          this.logger.log(`  ✓ Hook added (all phases): ${trigger}\n`, { type: 'success' });
        } else if (scopeIdx >= 2 && scopeIdx <= phases.length + 1) {
          const targetPhase = phases[scopeIdx - 2].name;
          const existing = phaseHooksMap.get(targetPhase) || [];
          existing.push(newHook);
          phaseHooksMap.set(targetPhase, existing);
          this.logger.log(`  ✓ Hook added (phase: ${targetPhase}): ${trigger}\n`, { type: 'success' });
        } else {
          this.logger.log('  ✗ Invalid selection, skipping hook.\n', { type: 'error' });
          continue;
        }

        const addMore = (
          await rl.question('  Add another hook? (y/N): ')
        ).trim().toLowerCase();
        if (addMore !== 'y' && addMore !== 'yes') break;
      }
    }

    // Apply phase-level hooks to phase objects
    for (const phase of phases) {
      const phaseHooks = phaseHooksMap.get(phase.name);
      if (phaseHooks && phaseHooks.length > 0) {
        phase.hooks = phaseHooks;
      }
    }

    // Step 7: Phase Lifecycle Hooks (optional)
    this.logger.log('\nStep 7: Phase Lifecycle Hooks (optional)\n', { type: 'info' });
    this.logger.log('  Run commands at the start/end of each phase (e.g., capture camera image).\n', { type: 'info' });

    const addLifecycle = (
      await rl.question('  Add phase lifecycle hooks (onStart/onEnd)? (y/N): ')
    ).trim().toLowerCase();

    if (addLifecycle === 'y' || addLifecycle === 'yes') {
      for (const phase of phases) {
        this.logger.log(`\n  Phase: ${phase.name}\n`, { type: 'info' });

        // onStart hooks
        const addOnStart = (
          await rl.question('    Add onStart commands? (y/N): ')
        ).trim().toLowerCase();

        if (addOnStart === 'y' || addOnStart === 'yes') {
          const onStartCmds: string[] = [];
          while (true) {
            const cmd = (
              await rl.question('    onStart command (empty to finish): ')
            ).trim();
            if (!cmd) break;
            onStartCmds.push(cmd);
            this.logger.log(`    ✓ Added onStart: ${cmd}\n`, { type: 'success' });
          }
          if (onStartCmds.length > 0) {
            phase.onStart = onStartCmds;
          }
        }

        // onEnd hooks
        const addOnEnd = (
          await rl.question('    Add onEnd commands? (y/N): ')
        ).trim().toLowerCase();

        if (addOnEnd === 'y' || addOnEnd === 'yes') {
          const onEndCmds: string[] = [];
          while (true) {
            const cmd = (
              await rl.question('    onEnd command (empty to finish): ')
            ).trim();
            if (!cmd) break;
            onEndCmds.push(cmd);
            this.logger.log(`    ✓ Added onEnd: ${cmd}\n`, { type: 'success' });
          }
          if (onEndCmds.length > 0) {
            phase.onEnd = onEndCmds;
          }
        }
      }
    }

    // Create the ablation
    try {
      const ablation = this.ablationManager.create({
        name,
        description,
        phases,
        models,
        settings: {
          mcpConfigPath,
          maxIterations,
          ...(mcpTimeout !== undefined ? { mcpTimeout } : {}),
          ...(maxIpcCalls !== undefined ? { maxIpcCalls } : {}),
          ...(clearContextBetweenPhases === false ? { clearContextBetweenPhases: false } : {}),
        },
        ...(runs > 1 ? { runs } : {}),
        ...(ablationArguments.length > 0 ? { arguments: ablationArguments } : {}),
        ...(topLevelHooks.length > 0 ? { hooks: topLevelHooks } : {}),
      });

      // Display summary
      this.logger.log(
        '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n',
        { type: 'info' },
      );
      this.logger.log('\n  ABLATION SUMMARY: ' + ablation.name + '\n', {
        type: 'info',
      });
      this.logger.log(`\n  Phases: ${ablation.phases.length}\n`, {
        type: 'info',
      });
      for (const phase of ablation.phases) {
        this.logger.log(
          `    • ${phase.name} (${phase.commands.length} commands)\n`,
          { type: 'info' },
        );
      }
      this.logger.log(`\n  Models: ${ablation.models.length}\n`, {
        type: 'info',
      });
      for (const model of ablation.models) {
        const thinkingInfo = model.thinking ? ` [thinking: ${model.thinking}]` : '';
        this.logger.log(`    • ${model.provider}/${model.model}${thinkingInfo}\n`, {
          type: 'info',
        });
      }
      const createIterInfo = (ablation.runs ?? 1) > 1 ? ` × ${ablation.runs} iterations` : '';
      this.logger.log(
        `\n  Runs: ${this.ablationManager.getTotalRuns(ablation)} (${ablation.models.length} model${ablation.models.length > 1 ? 's' : ''}${createIterInfo}), ${ablation.phases.length} phase${ablation.phases.length > 1 ? 's' : ''} each\n`,
        { type: 'info' },
      );

      if (ablation.settings.mcpConfigPath) {
        this.logger.log(`\n  MCP Config: ${ablation.settings.mcpConfigPath}\n`, { type: 'info' });
      }

      // Show arguments summary
      if (ablation.arguments && ablation.arguments.length > 0) {
        this.logger.log(`\n  Arguments: ${ablation.arguments.length}\n`, { type: 'info' });
        for (const arg of ablation.arguments) {
          const required = arg.required !== false ? 'required' : 'optional';
          const defaultStr = arg.default ? `, default: ${arg.default}` : '';
          this.logger.log(`    • {{${arg.name}}} (${arg.type}, ${required}${defaultStr})${arg.description ? ` - ${arg.description}` : ''}\n`, { type: 'info' });
        }
      }

      // Show hooks summary
      const totalHooks = (ablation.hooks?.length ?? 0)
        + ablation.phases.reduce((sum, p) => sum + (p.hooks?.length ?? 0), 0);
      if (totalHooks > 0) {
        this.logger.log(`\n  Tool hooks: ${totalHooks}\n`, { type: 'info' });
        for (const hook of (ablation.hooks ?? [])) {
          const trigger = hook.before ? `before ${hook.before}` : `after ${hook.after}`;
          const whenInputStr = hook.whenInput ? ` whenInput ${JSON.stringify(hook.whenInput)}` : '';
          const whenOutputStr = hook.whenOutput ? ` whenOutput ${JSON.stringify(hook.whenOutput)}` : '';
          this.logger.log(`    • [all phases] ${trigger}${whenInputStr}${whenOutputStr} → ${hook.run}\n`, { type: 'info' });
        }
        for (const phase of ablation.phases) {
          for (const hook of (phase.hooks ?? [])) {
            const trigger = hook.before ? `before ${hook.before}` : `after ${hook.after}`;
            const whenInputStr = hook.whenInput ? ` whenInput ${JSON.stringify(hook.whenInput)}` : '';
            const whenOutputStr = hook.whenOutput ? ` whenOutput ${JSON.stringify(hook.whenOutput)}` : '';
            this.logger.log(`    • [${phase.name}] ${trigger}${whenInputStr}${whenOutputStr} → ${hook.run}\n`, { type: 'info' });
          }
        }
      }

      // Show lifecycle hooks summary
      const totalOnStart = ablation.phases.reduce((sum, p) => sum + (p.onStart?.length ?? 0), 0);
      const totalOnEnd = ablation.phases.reduce((sum, p) => sum + (p.onEnd?.length ?? 0), 0);
      if (totalOnStart > 0 || totalOnEnd > 0) {
        this.logger.log(`\n  Lifecycle hooks: ${totalOnStart} onStart, ${totalOnEnd} onEnd\n`, { type: 'info' });
        for (const phase of ablation.phases) {
          for (const cmd of (phase.onStart ?? [])) {
            this.logger.log(`    • [${phase.name}] onStart → ${cmd}\n`, { type: 'info' });
          }
          for (const cmd of (phase.onEnd ?? [])) {
            this.logger.log(`    • [${phase.name}] onEnd → ${cmd}\n`, { type: 'info' });
          }
        }
      }

      this.logger.log(
        `\n✓ Saved to .mcp-client-data/ablations/${ablation.name}.yaml\n`,
        { type: 'success' },
      );
    } catch (error) {
      this.logger.log(`\n✗ Failed to create ablation: ${error}\n`, {
        type: 'error',
      });
    }
  }

  /**
   * Handle /ablation-list command - List all ablation studies
   */
  async handleAblationList(): Promise<void> {
    const ablations = this.ablationManager.list();

    if (ablations.length === 0) {
      this.logger.log('\n📊 No ablation studies found.\n', { type: 'warning' });
      this.logger.log('Use /ablation-create to create a new ablation study.\n', {
        type: 'info',
      });
      return;
    }

    this.logger.log(
      '\n┌─────────────────────────────────────────────────────────────┐\n',
      { type: 'info' },
    );
    this.logger.log(
      '│  SAVED ABLATION STUDIES                                     │\n',
      { type: 'info' },
    );
    this.logger.log(
      '└─────────────────────────────────────────────────────────────┘\n',
      { type: 'info' },
    );

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      const providers = this.ablationManager.getProviders(ablation);
      const createdDate = new Date(ablation.created).toLocaleDateString();
      const totalRuns = this.ablationManager.getTotalRuns(ablation);

      this.logger.log(`\n  ${i + 1}. ${ablation.name}\n`, { type: 'info' });
      if (ablation.description) {
        this.logger.log(`     ${ablation.description}\n`, { type: 'info' });
      }
      const runsInfo = (ablation.runs ?? 1) > 1 ? ` × ${ablation.runs} iterations` : '';
      const argsCount = ablation.arguments?.length ?? 0;
      const argsInfo = argsCount > 0 ? ` │ ${argsCount} arg${argsCount > 1 ? 's' : ''}` : '';
      let infoLine = `     └─ ${ablation.phases.length} phase${ablation.phases.length > 1 ? 's' : ''} × ${ablation.models.length} model${ablation.models.length > 1 ? 's' : ''}${runsInfo} = ${totalRuns} run${totalRuns > 1 ? 's' : ''}${argsInfo} │ ${providers.join(', ')} │ Created: ${createdDate}`;
      if (ablation.settings.mcpConfigPath) {
        infoLine += ` │ MCP: ${ablation.settings.mcpConfigPath}`;
      }
      this.logger.log(`${infoLine}\n`, { type: 'info' });
    }

    this.logger.log('\n', { type: 'info' });
  }

  /**
   * Handle /ablation-edit command - Edit an existing ablation study
   */
  async handleAblationEdit(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const ablations = this.ablationManager.list();

    if (ablations.length === 0) {
      this.logger.log('\n📊 No ablation studies found to edit.\n', {
        type: 'warning',
      });
      return;
    }

    // Display ablations for selection
    this.logger.log(
      '\n┌─────────────────────────────────────────────────────────────┐\n',
      { type: 'info' },
    );
    this.logger.log(
      '│  EDIT ABLATION STUDY                                        │\n',
      { type: 'info' },
    );
    this.logger.log(
      '└─────────────────────────────────────────────────────────────┘\n',
      { type: 'info' },
    );

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      this.logger.log(
        `  ${i + 1}. ${ablation.name} (${ablation.phases.length} phases, ${ablation.models.length} models)\n`,
        { type: 'info' },
      );
    }

    const selection = (
      await rl.question('\nSelect ablation to edit (or "q" to cancel, "exit" to quit): ')
    ).trim();

    this.checkExitCommand(selection);
    if (selection.toLowerCase() === 'q') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= ablations.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const ablation = ablations[index];

    // Edit menu loop
    while (true) {
      // Reload ablation to show current state
      const currentAblation = this.ablationManager.load(ablation.name);
      if (!currentAblation) {
        this.logger.log('\n✗ Ablation not found.\n', { type: 'error' });
        return;
      }

      this.logger.log(`\n  Editing: ${ablation.name}\n`, { type: 'info' });
      if (currentAblation.settings.mcpConfigPath) {
        this.logger.log(`  MCP Config: ${currentAblation.settings.mcpConfigPath}\n`, { type: 'info' });
      }
      if (currentAblation.arguments && currentAblation.arguments.length > 0) {
        this.logger.log(`  Arguments: ${currentAblation.arguments.length} (${currentAblation.arguments.map(a => `{{${a.name}}}`).join(', ')})\n`, { type: 'info' });
      }
      this.logger.log('\n  What do you want to edit?\n', { type: 'info' });
      this.logger.log('    1. Add phase\n', { type: 'info' });
      this.logger.log('    2. Edit phase\n', { type: 'info' });
      this.logger.log('    3. Remove phase\n', { type: 'info' });
      this.logger.log('    4. Add models\n', { type: 'info' });
      this.logger.log('    5. Remove models\n', { type: 'info' });
      this.logger.log('    6. Edit settings\n', { type: 'info' });
      this.logger.log('    7. Edit description\n', { type: 'info' });
      this.logger.log('    8. Edit MCP config path\n', { type: 'info' });
      this.logger.log('    9. Edit hooks\n', { type: 'info' });
      this.logger.log('   10. Edit arguments\n', { type: 'info' });
      this.logger.log('   11. Edit model thinking\n', { type: 'info' });
      this.logger.log('   12. Done\n', { type: 'info' });

      const choice = (await rl.question('\n  Select option (or "exit" to quit): ')).trim();
      this.checkExitCommand(choice);

      switch (choice) {
        case '1': // Add phase
          await this.handleAddPhase(ablation.name);
          break;
        case '2': // Edit phase
          await this.handleEditPhase(ablation.name);
          break;
        case '3': // Remove phase
          await this.handleRemovePhase(ablation.name);
          break;
        case '4': // Add models
          await this.handleAddModels(ablation.name);
          break;
        case '5': // Remove models
          await this.handleRemoveModels(ablation.name);
          break;
        case '6': // Edit settings
          await this.handleEditSettings(ablation.name);
          break;
        case '7': // Edit description
          await this.handleEditDescription(ablation.name);
          break;
        case '8': // Edit MCP config path
          await this.handleEditMcpConfigPath(ablation.name);
          break;
        case '9': // Edit hooks
          await this.handleEditHooks(ablation.name);
          break;
        case '10': // Edit arguments
          await this.handleEditArguments(ablation.name);
          break;
        case '11': // Edit model thinking
          await this.handleEditModelThinking(ablation.name);
          break;
        case '12': // Done
        case 'q':
        case 'exit':
        case '/exit':
          const updated = this.ablationManager.load(ablation.name);
          if (updated) {
            this.logger.log(`\n  Updated ablation:\n`, { type: 'info' });
            const editIterInfo = (updated.runs ?? 1) > 1 ? `, Iterations: ${updated.runs}` : '';
            this.logger.log(
              `  Phases: ${updated.phases.length}, Models: ${updated.models.length}, Runs: ${this.ablationManager.getTotalRuns(updated)}${editIterInfo}\n`,
              { type: 'info' },
            );
            if (updated.settings.mcpConfigPath) {
              this.logger.log(`  MCP Config: ${updated.settings.mcpConfigPath}\n`, { type: 'info' });
            }
          }
          this.logger.log('\n✓ Changes saved.\n', { type: 'success' });
          return;
        default:
          this.logger.log('\n✗ Invalid option.\n', { type: 'error' });
      }
    }
  }

  /**
   * Create a provider instance from a provider name string
   */
  private createProviderInstance(providerName: string): ModelProvider {
    const provider = createProvider(providerName);
    if (!provider) {
      const available = PROVIDERS.map(p => p.name).join(', ');
      throw new Error(`Unknown provider: ${providerName}. Available: ${available}`);
    }
    return provider;
  }

  /**
   * Resolve a prompt or resource reference: if value starts with @insert-prompt: or
   * @insert-resource:, fetch the content. Otherwise return the literal string.
   * Supports argument substitution.
   */
  private async resolvePromptReference(
    value: string,
    resolvedArguments?: Record<string, string>,
  ): Promise<string> {
    // Substitute argument placeholders first
    let resolved = value;
    if (resolvedArguments) {
      resolved = this.ablationManager.substituteArguments([resolved], resolvedArguments)[0];
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

    const prompts = this.client.listPrompts();
    const promptInfo = prompts.find(p => `${p.server}__${p.prompt.name}` === nameArg);
    if (!promptInfo) {
      throw new Error(`Prompt not found: ${nameArg}`);
    }

    const promptResult = await this.client.getPrompt(
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

  /**
   * Look up a resource by server__name key or URI, searching both concrete resources
   * and resource templates. Returns the server name and URI to pass to readResource().
   */
  private findResourceOrTemplate(nameArg: string, args?: Record<string, string>): { server: string; uri: string; description?: string } | null {
    // Search concrete resources first
    const allResources = this.client.listResources();
    let match = allResources.find(r => `${r.server}__${r.resource.name}` === nameArg);
    if (match) return { server: match.server, uri: match.resource.uri, description: match.resource.description };

    match = allResources.find(r => r.resource.uri === nameArg);
    if (match) return { server: match.server, uri: match.resource.uri, description: match.resource.description };

    // Search resource templates — match by server__name key or uriTemplate
    const allTemplates = this.client.listResourceTemplates();
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

  /**
   * Resolve an @insert-resource: reference by reading the resource content.
   * Searches both concrete resources and resource templates.
   */
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

    const result = await this.client.readResource(resolved.server, resolved.uri);

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



  /**
   * Handle /ablation-run command - Run one or more ablation studies
   * Supports multi-select: comma-separated numbers (e.g. "1,3"), ranges (e.g. "1-3"), or "all"
   */
  async handleAblationRun(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const ablations = this.ablationManager.list();

    if (ablations.length === 0) {
      this.logger.log('\n📊 No ablation studies found to run.\n', {
        type: 'warning',
      });
      return;
    }

    // Display ablations for selection
    this.logger.log(
      '\n┌─────────────────────────────────────────────────────────────┐\n',
      { type: 'info' },
    );
    this.logger.log(
      '│  RUN ABLATION STUDY                                         │\n',
      { type: 'info' },
    );
    this.logger.log(
      '└─────────────────────────────────────────────────────────────┘\n',
      { type: 'info' },
    );

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      const phaseCount = ablation.phases.length;
      const iterations = ablation.runs ?? 1;
      const modelsLabel = ablation.dryRun ? '' : `, ${ablation.models.length} model${ablation.models.length !== 1 ? 's' : ''}`;
      const iterLabel = iterations > 1 ? `, ${iterations} iterations` : '';
      this.logger.log(`  ${i + 1}. ${ablation.name} (${phaseCount} phase${phaseCount !== 1 ? 's' : ''}${modelsLabel}${iterLabel})\n`, {
        type: 'info',
      });
    }

    let selectedAblations: AblationDefinition[] = [];
    while (selectedAblations.length === 0) {
      const selection = (
        await rl.question('\nSelect ablation(s) to run (e.g. 1, 1,3, 1-3, all, "q" to cancel, "exit" to quit): ')
      ).trim();

      if (selection.toLowerCase() === 'q') {
        this.logger.log('\nCancelled.\n', { type: 'info' });
        return;
      }
      this.checkExitCommand(selection);

      selectedAblations = this.parseAblationSelection(selection, ablations);
      if (selectedAblations.length === 0) {
        this.logger.log('  ✗ Invalid selection, try again.\n', { type: 'error' });
      }
    }

    // Display summary of all selected ablations
    const totalAblationPhases = selectedAblations.reduce(
      (sum, a) => sum + a.phases.length, 0,
    );
    if (selectedAblations.length > 1) {
      this.logger.log(
        `\n  Selected ${selectedAblations.length} ablation(s) (${totalAblationPhases} total phases):\n`,
        { type: 'info' },
      );
      for (const a of selectedAblations) {
        const phaseCount = a.phases.length;
        const iterations = a.runs ?? 1;
        const modelsLabel = a.dryRun ? '' : `, ${a.models.length} model${a.models.length !== 1 ? 's' : ''}`;
        const iterLabel = iterations > 1 ? `, ${iterations} iterations` : '';
        this.logger.log(`    - ${a.name} (${phaseCount} phase${phaseCount !== 1 ? 's' : ''}${modelsLabel}${iterLabel})\n`, { type: 'info' });
      }
    }

    // Display details for each selected ablation
    for (const ablation of selectedAblations) {
      const totalRuns = this.ablationManager.getTotalRuns(ablation);
      const nameLine = `ABLATION: ${ablation.name}`;
      const innerWidth = Math.max(
        nameLine.length,
        ablation.description ? ablation.description.length : 0,
        59,
      );
      this.logger.log(
        `\n┌──${'─'.repeat(innerWidth)}──┐\n`,
        { type: 'info' },
      );
      this.logger.log(
        `│  ${nameLine.padEnd(innerWidth)}  │\n`,
        { type: 'info' },
      );
      if (ablation.description) {
        this.logger.log(
          `│  ${ablation.description.padEnd(innerWidth)}  │\n`,
          { type: 'info' },
        );
      }
      this.logger.log(
        `└──${'─'.repeat(innerWidth)}──┘\n`,
        { type: 'info' },
      );

      const iterations = ablation.runs ?? 1;
      const totalScenariosDisplay = this.ablationManager.getTotalScenarios(ablation);
      const iterationsMultiplier = iterations > 1 ? `${iterations} iterations × ` : '';
      if (ablation.dryRun) {
        this.logger.log(
          `\n  Dry Run: ${iterationsMultiplier}${ablation.phases.length} phases = ${totalScenariosDisplay} scenario${totalScenariosDisplay !== 1 ? 's' : ''}\n`,
          { type: 'info' },
        );
      } else {
        this.logger.log(
          `\n  Matrix: ${iterationsMultiplier}${ablation.models.length} model${ablation.models.length > 1 ? 's' : ''} × ${ablation.phases.length} phase${ablation.phases.length > 1 ? 's' : ''} = ${totalScenariosDisplay} scenario${totalScenariosDisplay !== 1 ? 's' : ''}\n`,
          { type: 'info' },
        );
      }

      if (ablation.settings.mcpConfigPath) {
        this.logger.log(`  MCP Config: ${ablation.settings.mcpConfigPath}\n`, { type: 'info' });
      }
      if (ablation.settings.clearContextBetweenPhases === false) {
        this.logger.log(`  Context: Persistent across phases (not cleared between phases)\n`, { type: 'info' });
      }
      if (ablation.settings.mcpTimeout !== undefined) {
        this.logger.log(`  MCP Timeout: ${ablation.settings.mcpTimeout}s\n`, { type: 'info' });
      }
      if (ablation.settings.maxIpcCalls !== undefined) {
        this.logger.log(`  Max IPC Calls: ${ablation.settings.maxIpcCalls} per phase\n`, { type: 'info' });
      }

      if (ablation.arguments && ablation.arguments.length > 0) {
        this.logger.log(`  Arguments: ${ablation.arguments.map(a => `{{${a.name}}}`).join(', ')}\n`, { type: 'info' });
      }

      this.displayAblationMatrix(ablation);
    }

    // Resolve dynamic arguments for each ablation that has them
    const resolvedArgsMap = new Map<string, Record<string, string>>();
    for (const ablation of selectedAblations) {
      if (ablation.arguments && ablation.arguments.length > 0) {
        const resolved = await this.resolveAblationArguments(ablation);
        if (resolved === null) {
          this.logger.log('\nCancelled.\n', { type: 'info' });
          return;
        }
        resolvedArgsMap.set(ablation.name, resolved);

        // Display resolved values for confirmation
        if (Object.keys(resolved).length > 0) {
          this.logger.log('\n  Resolved arguments:\n', { type: 'info' });
          for (const [name, value] of Object.entries(resolved)) {
            this.logger.log(`    {{${name}}} = ${value}\n`, { type: 'info' });
          }
        }
      }
    }

    // Pre-flight: resolve any stale @insert-prompt: references before starting
    const allPrompts = this.client.listPrompts();
    const promptMgr = this.client.getPromptManager();
    const enabledPrompts = promptMgr.filterPrompts(allPrompts);

    for (const ablation of selectedAblations) {
      for (const phase of ablation.phases) {
        for (let cmdIdx = 0; cmdIdx < phase.commands.length; cmdIdx++) {
          const cmd = phase.commands[cmdIdx].trim();
          if (!cmd.startsWith('@insert-prompt:')) continue;

          // Extract prompt name (strip optional args)
          const suffix = cmd.slice('@insert-prompt:'.length).trim();
          const promptRef = suffix.split(/[\s(]/)[0];
          if (!promptRef) continue;

          // Check if the reference resolves to a currently available prompt
          const found = allPrompts.find(p => `${p.server}__${p.prompt.name}` === promptRef);
          if (found) continue;

          // Stale reference — ask user to pick a replacement
          if (enabledPrompts.length === 0) {
            this.logger.log(`\n  ⚠ Stale prompt "${promptRef}" in phase "${phase.name}" — no prompts available to resolve\n`, { type: 'error' });
            return;
          }

          this.logger.log(`\n  ⚠ Stale prompt reference "${promptRef}" in phase "${phase.name}" — select a replacement:\n`, { type: 'warning' });
          await this.showPromptListForPreview();

          const selection = (await rl.question('  Select prompt number: ')).trim();
          const selectedIdx = parseInt(selection) - 1;

          if (isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= enabledPrompts.length) {
            this.logger.log(`\n  ✗ Invalid selection. Aborting.\n`, { type: 'error' });
            return;
          }

          const selected = enabledPrompts[selectedIdx];
          const newKey = `${selected.server}__${selected.prompt.name}`;

          // Collect arguments if the selected prompt requires them
          let collectedArgs: string | undefined;
          if (selected.prompt.arguments && selected.prompt.arguments.length > 0) {
            this.logger.log(
              `    Prompt "${selected.prompt.name}" requires ${selected.prompt.arguments.length} argument(s):\n`,
              { type: 'info' },
            );

            const promptArgValues: Record<string, string> = {};
            for (const arg of selected.prompt.arguments) {
              const required = arg.required !== false;
              const optionalText = required ? '' : ' (optional, Enter to skip)';

              this.logger.log(
                `      ${arg.name}${arg.description ? ` - ${arg.description}` : ''}${optionalText}:\n`,
                { type: 'info' },
              );

              const value = (await rl.question('      > ')).trim();

              if (required && !value) {
                this.logger.log(
                  `      ⚠ Required argument "${arg.name}" is empty\n`,
                  { type: 'warning' },
                );
              }

              if (value) {
                promptArgValues[arg.name] = value;
              }
            }

            if (Object.keys(promptArgValues).length > 0) {
              collectedArgs = JSON.stringify(promptArgValues);
            }
          }

          phase.commands[cmdIdx] = collectedArgs
            ? `@insert-prompt:${newKey} ${collectedArgs}`
            : `@insert-prompt:${newKey}`;

          this.ablationManager.save(ablation);
          this.logger.log(`  ✓ Updated: ${promptRef} → ${newKey}\n`, { type: 'success' });
        }
      }
    }

    // Pre-flight: resolve any stale @insert-attachment: references
    const availableAttachments = this.attachmentManager.listAttachments();

    for (const ablation of selectedAblations) {
      for (const phase of ablation.phases) {
        for (let cmdIdx = 0; cmdIdx < phase.commands.length; cmdIdx++) {
          const cmd = phase.commands[cmdIdx].trim();
          if (!cmd.startsWith('@insert-attachment:')) continue;

          const attachRef = cmd.slice('@insert-attachment:'.length).trim();
          if (!attachRef) continue;

          // Check if the reference resolves to a currently available attachment
          const found = availableAttachments.find(a => a.fileName === attachRef);
          if (found) continue;

          // Also skip if it's a numeric index that's in range
          const numIdx = parseInt(attachRef);
          if (!isNaN(numIdx) && String(numIdx) === attachRef && numIdx >= 1 && numIdx <= availableAttachments.length) continue;

          // Stale reference — ask user to pick a replacement
          if (availableAttachments.length === 0) {
            this.logger.log(`\n  ⚠ Stale attachment "${attachRef}" in phase "${phase.name}" — no attachments available to resolve\n`, { type: 'error' });
            return;
          }

          this.logger.log(`\n  ⚠ Stale attachment reference "${attachRef}" in phase "${phase.name}" — select a replacement:\n`, { type: 'warning' });
          await this.showAttachmentListForPreview();

          const selection = (await rl.question('  Select attachment number: ')).trim();
          const selectedIdx = parseInt(selection) - 1;

          if (isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= availableAttachments.length) {
            this.logger.log(`\n  ✗ Invalid selection. Aborting.\n`, { type: 'error' });
            return;
          }

          const selectedAtt = availableAttachments[selectedIdx];
          phase.commands[cmdIdx] = `@insert-attachment:${selectedAtt.fileName}`;

          this.ablationManager.save(ablation);
          this.logger.log(`  ✓ Updated: ${attachRef} → ${selectedAtt.fileName}\n`, { type: 'success' });
        }
      }
    }

    // Pre-flight: validate tool filters against connected tools
    // Use getAllConnectedToolNames() instead of getTools() — the latter returns
    // only agent-visible tools (filtered by enabled state, disabled servers, etc.),
    // which can intermittently exclude tools that ablation deny patterns target.
    for (const ablation of selectedAblations) {
      if (ablation.tools || ablation.phases.some(p => p.tools)) {
        const connectedToolNames = this.client.getAllConnectedToolNames();
        const toolWarnings = this.ablationManager.validateToolFilters(ablation, connectedToolNames);
        if (toolWarnings.length > 0) {
          this.logger.log(`\n⚠ Tool filter issues in "${ablation.name}":\n`, { type: 'warning' });
          for (const warning of toolWarnings) {
            this.logger.log(`  ${warning}\n`, { type: 'warning' });
          }
        }
      }
    }

    const confirm = (await rl.question('\nStart ablation? (Y/n): '))
      .trim()
      .toLowerCase();
    if (confirm === 'n' || confirm === 'no') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    // Check if HIL is enabled and offer to disable for automation
    const hilManager = this.callbacks.getHILManager();
    const originalHILState = hilManager.isEnabled();
    let disabledHILForAblation = false;

    if (originalHILState) {
      const hilDisableAnswer = (await rl.question('\nHuman-in-the-loop is enabled. Disable for ablation automation? (Y/n): '))
        .trim()
        .toLowerCase();
      if (hilDisableAnswer !== 'n' && hilDisableAnswer !== 'no') {
        hilManager.setEnabled(false);
        disabledHILForAblation = true;
        this.logger.log('  Disabled HIL for ablation run\n', { type: 'info' });
      }
    }

    // Save original provider/model, thinking, limits, and chat state to restore after all ablations
    const originalProviderName = this.client.getProviderName();
    const originalModel = this.client.getModel();
    const originalThinkingLevels = { ...this.preferencesManager.getThinkingLevels() };
    const originalMaxIterations = this.preferencesManager.getMaxIterations();
    const originalMcpTimeout = this.preferencesManager.getMCPTimeout();
    const originalMaxIpcCalls = this.preferencesManager.getMaxIpcCalls();
    const savedState = this.client.saveState();
    const hasConversation = savedState.messages.length > 0;
    if (hasConversation) {
      this.logger.log('\n  Original chat saved. Starting ablation...\n', {
        type: 'info',
      });
    }

    // Run each selected ablation
    let batchAborted = false;
    for (let i = 0; i < selectedAblations.length; i++) {
      const ablation = selectedAblations[i];
      if (selectedAblations.length > 1) {
        const batchLine = `BATCH ${i + 1}/${selectedAblations.length}: ${ablation.name}`;
        const batchWidth = Math.max(batchLine.length, 59);
        this.logger.log(
          `\n╔══${'═'.repeat(batchWidth)}══╗\n`,
          { type: 'info' },
        );
        this.logger.log(
          `║  ${batchLine.padEnd(batchWidth)}  ║\n`,
          { type: 'info' },
        );
        this.logger.log(
          `╚══${'═'.repeat(batchWidth)}══╝\n`,
          { type: 'info' },
        );
      }

      const resolvedArgs = resolvedArgsMap.get(ablation.name);
      const aborted = await this.runSingleAblation(ablation, resolvedArgs);
      if (aborted) {
        batchAborted = true;
        break;
      }
    }

    if (selectedAblations.length > 1 && !batchAborted) {
      this.logger.log(
        `\n  ✓ All ${selectedAblations.length} ablation(s) complete\n`,
        { type: 'success' },
      );
    }

    // Restore default MCP config if a custom config is still active
    const defaultMcpConfigPath = this.ablationManager.getDefaultMcpConfigPath();
    if (this.lastAblationMcpConfigPath && this.lastAblationMcpConfigPath !== defaultMcpConfigPath) {
      this.logger.log('  Restoring default MCP config...\n', { type: 'info' });
      if (this.client.reloadConfigFromPath(defaultMcpConfigPath)) {
        await this.client.refreshServers();
        this.logger.log('  ✓ Default MCP servers restored\n', { type: 'success' });
      } else {
        this.logger.log('  ⚠ Failed to restore default MCP config\n', { type: 'warning' });
      }
      this.lastAblationMcpConfigPath = null;
    }

    // Restore original provider/model and chat state
    const originalProvider = this.createProviderInstance(originalProviderName);
    if (hasConversation) {
      this.logger.log('  Restoring original session...\n', { type: 'info' });
    }
    await this.client.restoreState(savedState, originalProvider, originalModel);
    if (hasConversation) {
      this.logger.log(
        `  ✓ Restored to ${originalProviderName}/${originalModel}\n`,
        { type: 'success' },
      );
    }

    // Restore HIL state if we disabled it
    if (disabledHILForAblation) {
      hilManager.setEnabled(originalHILState);
      this.preferencesManager.setHILEnabled(originalHILState);
      this.logger.log('  ✓ Restored human-in-the-loop to original state\n', { type: 'success' });
    }

    // Restore thinking state
    for (const [provider, level] of Object.entries(originalThinkingLevels)) {
      this.preferencesManager.setThinkingLevel(provider, level as string);
    }

    // Restore limit settings
    this.preferencesManager.setMaxIterations(originalMaxIterations);
    this.preferencesManager.setMCPTimeout(originalMcpTimeout);
    this.preferencesManager.setMaxIpcCalls(originalMaxIpcCalls);
    const ipcServer = this.client.getOrchestratorIPCServer();
    if (ipcServer) {
      ipcServer.setMaxIpcCalls(originalMaxIpcCalls);
    }
  }

  /**
   * Parse a selection string into ablation definitions.
   * Supports: single number "1", comma-separated "1,3", ranges "1-3", "all"
   */
  private parseAblationSelection(
    selection: string,
    ablations: AblationDefinition[],
  ): AblationDefinition[] {
    const lower = selection.toLowerCase().trim();
    if (lower === 'all') {
      return [...ablations];
    }

    const indices = new Set<number>();
    const parts = lower.split(',').map(s => s.trim()).filter(Boolean);

    for (const part of parts) {
      const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1]) - 1;
        const end = parseInt(rangeMatch[2]) - 1;
        if (isNaN(start) || isNaN(end) || start < 0 || end >= ablations.length || start > end) {
          return [];
        }
        for (let i = start; i <= end; i++) {
          indices.add(i);
        }
      } else {
        const index = parseInt(part) - 1;
        if (isNaN(index) || index < 0 || index >= ablations.length) {
          return [];
        }
        indices.add(index);
      }
    }

    // Return in sorted order
    return Array.from(indices).sort((a, b) => a - b).map(i => ablations[i]);
  }

  /**
   * Display the phase × model matrix for an ablation
   */
  private displayAblationMatrix(ablation: AblationDefinition): void {
    if (ablation.dryRun) {
      // Simplified display for dry run - just list phases
      this.logger.log('\n  ┌─────────────────────┬─────────────┐\n', { type: 'info' });
      this.logger.log('  │                     │ dry-run     │\n', { type: 'info' });
      this.logger.log('  ├─────────────────────┼─────────────┤\n', { type: 'info' });
      for (const phase of ablation.phases) {
        this.logger.log(
          `  │ ${phase.name.padEnd(19).substring(0, 19)} │ ${'·'.padEnd(12)}│\n`,
          { type: 'info' },
        );
      }
      this.logger.log('  └─────────────────────┴─────────────┘\n', { type: 'info' });
      return;
    }

    const modelHeaders = ablation.models.map((m) =>
      this.ablationManager.getModelShortName(m),
    );
    this.logger.log('\n  ┌─────────────────────', { type: 'info' });
    for (const _ of modelHeaders) {
      this.logger.log('┬─────────────', { type: 'info' });
    }
    this.logger.log('┐\n', { type: 'info' });

    this.logger.log('  │                     ', { type: 'info' });
    for (const header of modelHeaders) {
      this.logger.log(`│ ${header.padEnd(12)}`, { type: 'info' });
    }
    this.logger.log('│\n', { type: 'info' });

    this.logger.log('  ├─────────────────────', { type: 'info' });
    for (const _ of modelHeaders) {
      this.logger.log('┼─────────────', { type: 'info' });
    }
    this.logger.log('┤\n', { type: 'info' });

    for (const phase of ablation.phases) {
      this.logger.log(
        `  │ ${phase.name.padEnd(19).substring(0, 19)} `,
        { type: 'info' },
      );
      for (const _ of ablation.models) {
        this.logger.log(`│ ${'pending'.padEnd(12)}`, { type: 'info' });
      }
      this.logger.log('│\n', { type: 'info' });
    }

    this.logger.log('  └─────────────────────', { type: 'info' });
    for (const _ of modelHeaders) {
      this.logger.log('┴─────────────', { type: 'info' });
    }
    this.logger.log('┘\n', { type: 'info' });
  }




  /**
   * Resolve dynamic arguments for an ablation by prompting the user.
   * For 'string' args: readline prompt with optional default.
   * For 'attachment' args: numbered attachment list, user picks by index.
   * @returns Resolved values, or null if user cancelled.
   */
  private async resolveAblationArguments(
    ablation: AblationDefinition,
  ): Promise<Record<string, string> | null> {
    const rl = this.callbacks.getReadline();
    if (!rl) return null;

    const args = ablation.arguments;
    if (!args || args.length === 0) return {};

    this.logger.log('\n  Resolving dynamic arguments:\n', { type: 'info' });

    const resolved: Record<string, string> = {};

    for (const arg of args) {
      const isRequired = arg.required !== false;
      const desc = arg.description ? ` - ${arg.description}` : '';
      const defaultHint = arg.default ? ` [default: ${arg.default}]` : '';
      const requiredHint = isRequired ? ' (required)' : ' (optional)';

      if (arg.type === 'attachment') {
        // Show attachment list and let user pick
        const attachments = this.attachmentManager.listAttachments();
        if (attachments.length === 0) {
          this.logger.log(`    {{${arg.name}}}${desc}: No attachments available.\n`, { type: 'warning' });
          if (isRequired && !arg.default) {
            this.logger.log('    Cannot continue without required attachment.\n', { type: 'error' });
            return null;
          }
          if (arg.default) {
            resolved[arg.name] = arg.default;
            this.logger.log(`    → Using default: ${arg.default}\n`, { type: 'info' });
          }
          continue;
        }

        this.logger.log(`\n    {{${arg.name}}}${desc}${requiredHint}\n`, { type: 'info' });
        this.logger.log('    Available attachments:\n', { type: 'info' });
        for (let i = 0; i < attachments.length; i++) {
          this.logger.log(`      ${i + 1}. ${attachments[i].fileName}\n`, { type: 'info' });
        }

        const prompt = arg.default
          ? `    Select attachment (1-${attachments.length})${defaultHint}: `
          : `    Select attachment (1-${attachments.length}): `;
        const input = (await rl.question(prompt)).trim();

        if (input.toLowerCase() === 'q') return null;

        if (!input && arg.default) {
          resolved[arg.name] = arg.default;
          this.logger.log(`    → ${arg.default}\n`, { type: 'info' });
        } else {
          const idx = parseInt(input) - 1;
          if (isNaN(idx) || idx < 0 || idx >= attachments.length) {
            if (isRequired && !arg.default) {
              this.logger.log('    ✗ Invalid selection.\n', { type: 'error' });
              return null;
            }
            if (arg.default) {
              resolved[arg.name] = arg.default;
              this.logger.log(`    → Using default: ${arg.default}\n`, { type: 'info' });
            }
          } else {
            resolved[arg.name] = attachments[idx].fileName;
            this.logger.log(`    → ${attachments[idx].fileName}\n`, { type: 'info' });
          }
        }
      } else {
        // type: 'string'
        this.logger.log(`\n    {{${arg.name}}}${desc}${requiredHint}\n`, { type: 'info' });

        const prompt = arg.default
          ? `    Value${defaultHint}: `
          : `    Value: `;
        const input = (await rl.question(prompt)).trim();

        if (input.toLowerCase() === 'q') return null;

        if (!input && arg.default) {
          resolved[arg.name] = arg.default;
          this.logger.log(`    → ${arg.default}\n`, { type: 'info' });
        } else if (!input && isRequired) {
          this.logger.log('    ✗ Required argument cannot be empty.\n', { type: 'error' });
          return null;
        } else {
          resolved[arg.name] = input;
        }
      }
    }

    return resolved;
  }



  /**
   * Run a single ablation study. Handles MCP config, execution, results, and output cleanup.
   * Server connections are reused across calls when the config hasn't changed.
   * @returns true if the user aborted
   */
  // ───────── Slice 3 Pass A: thin wrapper delegating to the shared AblationRunner ─────────
  // The 1101-line engine moved to src/ablation-runner.ts. This builds the CLI-backed
  // control/observer/host adapters and calls the single engine both surfaces share.
  // (Original engine preserved in git history; sibling engine methods become dead code,
  //  removed in Pass A step 9 once the web surface is switched and verified.)
  private ablationRunner: AblationRunner | null = null;
  private getAblationRunner(): AblationRunner {
    if (!this.ablationRunner) {
      this.ablationRunner = new AblationRunner({
        client: this.client,
        logger: this.logger,
        ablationManager: this.ablationManager,
        preferencesManager: this.preferencesManager,
        attachmentManager: this.attachmentManager,
      });
    }
    return this.ablationRunner;
  }

  private async runSingleAblation(ablation: AblationDefinition, resolvedArguments?: Record<string, string>): Promise<boolean> {
    const control: RunControl = {
      isAbortRequested: () => this.callbacks.isAbortRequested(),
      isInterruptRequested: () => this.callbacks.isInterruptRequested(),
      resetAbort: () => this.callbacks.resetAbort(),
      resetInterrupt: () => this.callbacks.resetInterrupt(),
      setAbortMode: (enabled: boolean) => this.callbacks.setAbortMode(enabled),
    };
    const observer: RunObserver = {
      on: (event) => {
        // The engine renders through the injected logger; the CLI observer only needs to
        // re-fire the continuation sink the old outer loop consumed (Pass A risk #1).
        if (event.type === 'continuation') this.callbacks.setPendingContinuation();
      },
    };
    const host: RunHost = {
      startKeyboardMonitor: () => this.callbacks.startKeyboardMonitor(),
      stopKeyboardMonitor: () => this.callbacks.stopKeyboardMonitor(),
      collectInput: (prompt: string) => this.callbacks.collectInput(prompt),
      getReadline: () => this.callbacks.getReadline(),
      routeSlashCommand: (cmd: string) => this.callbacks.routeSlashCommand(cmd),
      restoreIterationLimitCallback: () => this.callbacks.restoreIterationLimitCallback(),
      getPendingAttachments: () => this.callbacks.getPendingAttachments(),
      setPendingAttachments: (a) => this.callbacks.setPendingAttachments(a),
    };
    return this.getAblationRunner().run(ablation, resolvedArguments, { control, observer, host });
  }

  /**
   * Handle /ablation-delete command - Delete an ablation study
   */
  async handleAblationDelete(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const ablations = this.ablationManager.list();

    if (ablations.length === 0) {
      this.logger.log('\n📊 No ablation studies found to delete.\n', {
        type: 'warning',
      });
      return;
    }

    this.logger.log('\n🗑️  Select ablation to delete:\n', { type: 'info' });

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      this.logger.log(`  ${i + 1}. ${ablation.name}\n`, { type: 'info' });
    }

    const selection = (
      await rl.question('\nSelect ablation (or "q" to cancel, "exit" to quit): ')
    ).trim();

    if (selection.toLowerCase() === 'q') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= ablations.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const ablation = ablations[index];

    const confirm = (
      await rl.question(
        `\n⚠️  Delete "${ablation.name}"? This cannot be undone! (yes/no): `,
      )
    )
      .trim()
      .toLowerCase();

    if (confirm !== 'yes' && confirm !== 'y') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    if (this.ablationManager.delete(ablation.name)) {
      this.logger.log(`\n✓ Deleted ablation "${ablation.name}"\n`, {
        type: 'success',
      });
    } else {
      this.logger.log(`\n✗ Failed to delete ablation.\n`, { type: 'error' });
    }
  }

  /**
   * Load cost data from a chat.json file within an ablation run directory.
   * Returns totalCost and tokenUsagePerCallback summary, or null if unavailable.
   */
  private loadChatCostData(runDir: string, result: AblationRunResult): {
    totalCost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    regularInputTokens: number;
    callbackCount: number;
  } | null {
    const chatFile = result.chatFile;
    if (!chatFile) return null;

    const chatPath = join(runDir, chatFile);
    const chatSession = this.ablationManager.loadChatFromFile(chatPath);
    if (!chatSession) return null;

    const totalCost = chatSession.metadata?.totalCost || 0;
    const callbacks = chatSession.tokenUsagePerCallback || [];

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let regularInputTokens = 0;

    for (const cb of callbacks) {
      inputTokens += cb.inputTokens || 0;
      outputTokens += cb.outputTokens || 0;
      cacheReadTokens += cb.cacheReadTokens || 0;
      cacheCreationTokens += cb.cacheCreationTokens || 0;
      regularInputTokens += cb.regularInputTokens || 0;
    }

    return {
      totalCost,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      regularInputTokens,
      callbackCount: callbacks.length,
    };
  }

  /**
   * Handle /ablation-results command - View past ablation run results
   */
  /**
   * Paginated run selection with model info summary.
   * Returns the selected run or null if cancelled.
   */
  private async selectRunPaginated(
    runs: Array<{ timestamp: string; run: AblationRun }>,
    title: string,
  ): Promise<{ timestamp: string; run: AblationRun } | null> {
    const rl = this.callbacks.getReadline();
    if (!rl) return null;

    const pageSize = 10;
    let offset = 0;

    while (true) {
      const page = runs.slice(offset, offset + pageSize);
      this.logger.log(`\n${title} (${offset + 1}-${offset + page.length} of ${runs.length}):\n`, { type: 'info' });

      for (let i = 0; i < page.length; i++) {
        const { timestamp, run } = page[i];
        const completedCount = run.results.filter(r => r.status === 'completed').length;
        const escalatedCount = run.results.filter(r => r.status === 'escalated').length;
        const totalCount = run.results.length;
        const duration = run.totalDuration ? formatDuration(run.totalDuration) : 'N/A';

        // Extract unique model short names and phase names from results
        const modelSet = new Set<string>();
        const phaseSet = new Set<string>();
        for (const result of run.results) {
          modelSet.add(this.ablationManager.getModelShortName(result.model));
          phaseSet.add(result.phase);
        }
        const modelNames = [...modelSet].join(', ');
        const phaseNames = [...phaseSet].join(', ');

        const escalatedSuffix = escalatedCount > 0 ? ` (${escalatedCount} escalated)` : '';
        this.logger.log(`  ${offset + i + 1}. ${timestamp}\n`, { type: 'info' });
        this.logger.log(
          `     └─ ${completedCount}/${totalCount} completed${escalatedSuffix} | ${duration} | ${modelNames}\n`,
          { type: 'info' },
        );
        this.logger.log(
          `        ${phaseNames}\n`,
          { type: 'info' },
        );
      }

      const hasNext = offset + pageSize < runs.length;
      const hasPrev = offset > 0;
      const nav = [hasPrev ? 'p=prev' : '', hasNext ? 'n=next' : '', 'q=cancel'].filter(Boolean).join(', ');

      const answer = (
        await rl.question(`\nSelect run (1-${runs.length}), ${nav}: `)
      ).trim().toLowerCase();

      if (answer === 'q' || !answer) return null;
      if (answer === 'n' && hasNext) { offset += pageSize; continue; }
      if (answer === 'p' && hasPrev) { offset -= pageSize; continue; }

      const num = parseInt(answer, 10);
      if (!isNaN(num) && num >= 1 && num <= runs.length) {
        return runs[num - 1];
      }

      this.logger.log('Invalid selection.\n', { type: 'error' });
    }
  }

  async handleAblationResults(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const ablations = this.ablationManager.list();

    if (ablations.length === 0) {
      this.logger.log('\nNo ablation studies found.\n', { type: 'warning' });
      return;
    }

    this.logger.log('\nSelect ablation to view results:\n', { type: 'info' });

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      const runs = this.ablationManager.listRuns(ablation.name);
      this.logger.log(
        `  ${i + 1}. ${ablation.name} (${runs.length} past runs)\n`,
        { type: 'info' },
      );
    }

    const selection = (
      await rl.question('\nSelect ablation (or "q" to cancel, "exit" to quit): ')
    ).trim();

    this.checkExitCommand(selection);
    if (selection.toLowerCase() === 'q') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= ablations.length) {
      this.logger.log('\nInvalid selection.\n', { type: 'error' });
      return;
    }

    const ablation = ablations[index];
    const runs = this.ablationManager.listRuns(ablation.name);

    if (runs.length === 0) {
      this.logger.log(`\nNo runs found for "${ablation.name}".\n`, {
        type: 'warning',
      });
      this.logger.log('Use /ablation-run to run this ablation study.\n', {
        type: 'info',
      });
      return;
    }

    const selected = await this.selectRunPaginated(runs, `Runs for "${ablation.name}"`);
    if (!selected) return;

    const { timestamp, run } = selected;
    const runDir = this.ablationManager.getRunDirectory(ablation.name, timestamp);

    // Load frozen definition for context mode awareness
    let persistentContext = false;
    const frozenDefPath = join(runDir, 'definition.yaml');
    if (existsSync(frozenDefPath)) {
      try {
        const yaml = await import('yaml');
        const { readFileSync } = await import('fs');
        const defContent = readFileSync(frozenDefPath, 'utf-8');
        const frozenDef = yaml.parse(defContent);
        persistentContext = frozenDef?.settings?.clearContextBetweenPhases === false;
      } catch { /* fallback */ }
    }

    // Load cost data from chat files for each result
    type CostData = NonNullable<ReturnType<typeof this.loadChatCostData>>;
    const costByResult = new Map<AblationRunResult, CostData>();
    for (const result of run.results) {
      const cost = this.loadChatCostData(runDir, result);
      if (cost) costByResult.set(result, cost);
    }

    // ── Header ──
    this.logger.log(
      `\n┌─────────────────────────────────────────────────────────────┐\n`,
      { type: 'info' },
    );
    this.logger.log(
      `│  RUN RESULTS: ${ablation.name.padEnd(44)}│\n`,
      { type: 'info' },
    );
    this.logger.log(
      `└─────────────────────────────────────────────────────────────┘\n`,
      { type: 'info' },
    );

    this.logger.log(`\n  Started:  ${run.startedAt}\n`, { type: 'info' });
    this.logger.log(`  Completed: ${run.completedAt || 'N/A'}\n`, { type: 'info' });
    this.logger.log(
      `  Duration: ${run.totalDuration ? formatDuration(run.totalDuration) : 'N/A'}\n`,
      { type: 'info' },
    );
    if (persistentContext) {
      this.logger.log(`  Context:  Persistent across phases\n`, { type: 'info' });
    }

    // ── Individual Results ──
    this.logger.log(`\n  Individual Results:\n`, { type: 'info' });

    for (const result of run.results) {
      const status = result.status === 'completed' ? '✓'
        : result.status === 'failed' ? '✗'
          : result.status === 'aborted' ? '!'
            : '○';
      const duration = result.duration ? formatDuration(result.duration) : 'N/A';
      const modelShort = this.ablationManager.getModelShortName(result.model);
      const runLabel = result.run !== undefined ? ` (run ${result.run})` : '';

      let line = `    ${status} ${result.phase} + ${modelShort}${runLabel} | ${duration}`;

      // Add token info
      if (result.tokens) {
        line += ` | ${result.tokens.toLocaleString()} tok`;
      }

      // Add cost from chat data
      const cost = costByResult.get(result);
      if (cost && cost.totalCost > 0) {
        line += ` | $${cost.totalCost.toFixed(4)}`;
      }

      this.logger.log(`${line}\n`, { type: result.status === 'failed' ? 'error' : 'info' });

      if (result.error) {
        this.logger.log(`      Error: ${result.error}\n`, { type: 'error' });
      }
    }

    // ── Per-Model Summary ──
    const modelKeys = new Map<string, { model: AblationModel; results: AblationRunResult[] }>();
    for (const result of run.results) {
      const key = `${result.model.provider}--${result.model.model}`;
      if (!modelKeys.has(key)) {
        modelKeys.set(key, { model: result.model, results: [] });
      }
      modelKeys.get(key)!.results.push(result);
    }

    if (modelKeys.size > 0) {
      this.logger.log(`\n  Per-Model Summary:\n`, { type: 'info' });

      for (const [, { model, results }] of modelKeys) {
        const modelShort = this.ablationManager.getModelShortName(model);
        const completedCount = results.filter(r => r.status === 'completed').length;
        const escalatedCount = results.filter(r => r.status === 'escalated').length;
        const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);

        let totalCost = 0;
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        for (const r of results) {
          const c = costByResult.get(r);
          if (c) {
            totalCost += c.totalCost;
            totalInput += c.inputTokens;
            totalOutput += c.outputTokens;
            totalCacheRead += c.cacheReadTokens;
            totalCacheWrite += c.cacheCreationTokens;
          }
        }

        // For persistent context, the last phase's tokens represents the cumulative total
        let tokenDisplay: string;
        if (persistentContext) {
          // Last result's tokens is the cumulative total for the model
          const lastCompleted = [...results].reverse().find(r => r.tokens !== undefined);
          tokenDisplay = lastCompleted?.tokens ? `${lastCompleted.tokens.toLocaleString()} tok (cumulative)` : 'N/A';
        } else {
          const totalTokens = results.reduce((sum, r) => sum + (r.tokens || 0), 0);
          tokenDisplay = totalTokens > 0 ? `${totalTokens.toLocaleString()} tok` : 'N/A';
        }

        const escalatedSuffix = escalatedCount > 0 ? ` (${escalatedCount} escalated)` : '';
        this.logger.log(`    ${modelShort} (${model.provider})\n`, { type: 'info' });
        this.logger.log(`      Phases: ${completedCount}/${results.length} completed${escalatedSuffix}\n`, { type: 'info' });
        this.logger.log(`      Duration: ${formatDuration(totalDuration)}\n`, { type: 'info' });
        this.logger.log(`      Tokens: ${tokenDisplay}\n`, { type: 'info' });

        if (totalCost > 0) {
          this.logger.log(`      Cost: $${totalCost.toFixed(4)}\n`, { type: 'info' });
        }
        if (totalInput > 0 || totalOutput > 0) {
          this.logger.log(
            `      Breakdown: ${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out`,
            { type: 'info' },
          );
          if (totalCacheRead > 0 || totalCacheWrite > 0) {
            this.logger.log(
              ` (${totalCacheRead.toLocaleString()} cache-read, ${totalCacheWrite.toLocaleString()} cache-write)`,
              { type: 'info' },
            );
          }
          this.logger.log('\n', { type: 'info' });
        }
      }
    }

    // ── Per-Phase Summary ──
    const phaseKeys = new Map<string, AblationRunResult[]>();
    for (const result of run.results) {
      const key = result.run !== undefined ? `${result.phase} (run ${result.run})` : result.phase;
      if (!phaseKeys.has(key)) {
        phaseKeys.set(key, []);
      }
      phaseKeys.get(key)!.push(result);
    }

    if (phaseKeys.size > 0) {
      this.logger.log(`\n  Per-Phase Summary:\n`, { type: 'info' });

      // For persistent context, compute per-phase token deltas
      // Group results by model to compute deltas within each model's phase sequence
      const modelPhaseOrder = new Map<string, AblationRunResult[]>();
      for (const result of run.results) {
        const mkey = `${result.model.provider}--${result.model.model}` +
          (result.run !== undefined ? `--run-${result.run}` : '');
        if (!modelPhaseOrder.has(mkey)) {
          modelPhaseOrder.set(mkey, []);
        }
        modelPhaseOrder.get(mkey)!.push(result);
      }

      // Build a map of result -> delta tokens for persistent context
      const tokenDelta = new Map<AblationRunResult, number>();
      if (persistentContext) {
        for (const [, orderedResults] of modelPhaseOrder) {
          let prevTokens = 0;
          for (const r of orderedResults) {
            const current = r.tokens || 0;
            tokenDelta.set(r, current - prevTokens);
            prevTokens = current;
          }
        }
      }

      for (const [phaseName, results] of phaseKeys) {
        const completedCount = results.filter(r => r.status === 'completed').length;
        const escalatedCount = results.filter(r => r.status === 'escalated').length;
        const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);

        let totalCost = 0;
        for (const r of results) {
          const c = costByResult.get(r);
          if (c) totalCost += c.totalCost;
        }

        let tokenDisplay: string;
        if (persistentContext) {
          const totalDelta = results.reduce((sum, r) => sum + (tokenDelta.get(r) || 0), 0);
          tokenDisplay = totalDelta > 0 ? `${totalDelta.toLocaleString()} tok (delta)` : 'N/A';
        } else {
          const totalTokens = results.reduce((sum, r) => sum + (r.tokens || 0), 0);
          tokenDisplay = totalTokens > 0 ? `${totalTokens.toLocaleString()} tok` : 'N/A';
        }

        const modelCount = results.length;
        const modelLabel = modelCount === 1
          ? this.ablationManager.getModelShortName(results[0].model)
          : `${modelCount} models`;

        const escalatedSuffix = escalatedCount > 0 ? ` (${escalatedCount} escalated)` : '';
        this.logger.log(`    ${phaseName} (${modelLabel})\n`, { type: 'info' });
        this.logger.log(`      Status: ${completedCount}/${results.length} completed${escalatedSuffix}\n`, { type: 'info' });
        this.logger.log(`      Duration: ${formatDuration(totalDuration)}\n`, { type: 'info' });
        this.logger.log(`      Tokens: ${tokenDisplay}\n`, { type: 'info' });

        if (totalCost > 0) {
          this.logger.log(`      Cost: $${totalCost.toFixed(4)}\n`, { type: 'info' });
        }
      }
    }

    // ── Per-Run Iteration Summary (when runs > 1) ──
    const hasIterations = run.results.some(r => r.run !== undefined);
    if (hasIterations) {
      const iterationKeys = new Map<number, AblationRunResult[]>();
      for (const result of run.results) {
        const iter = result.run ?? 0;
        if (!iterationKeys.has(iter)) {
          iterationKeys.set(iter, []);
        }
        iterationKeys.get(iter)!.push(result);
      }

      this.logger.log(`\n  Per-Iteration Summary:\n`, { type: 'info' });

      const sortedIters = [...iterationKeys.keys()].sort((a, b) => a - b);
      for (const iter of sortedIters) {
        const results = iterationKeys.get(iter)!;
        const completedCount = results.filter(r => r.status === 'completed').length;
        const escalatedCount = results.filter(r => r.status === 'escalated').length;
        const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);
        const totalTokens = results.reduce((sum, r) => sum + (r.tokens || 0), 0);

        let totalCost = 0;
        for (const r of results) {
          const c = costByResult.get(r);
          if (c) totalCost += c.totalCost;
        }

        const escalatedSuffix = escalatedCount > 0 ? ` (${escalatedCount} escalated)` : '';
        this.logger.log(`    Run ${iter}\n`, { type: 'info' });
        this.logger.log(`      Status: ${completedCount}/${results.length} completed${escalatedSuffix}\n`, { type: 'info' });
        this.logger.log(`      Duration: ${formatDuration(totalDuration)}\n`, { type: 'info' });
        if (totalTokens > 0) {
          this.logger.log(`      Tokens: ${totalTokens.toLocaleString()}\n`, { type: 'info' });
        }
        if (totalCost > 0) {
          this.logger.log(`      Cost: $${totalCost.toFixed(4)}\n`, { type: 'info' });
        }
      }
    }

    // ── Grand Totals ──
    let grandCost = 0;
    for (const [, c] of costByResult) {
      grandCost += c.totalCost;
    }

    if (grandCost > 0 || (run.totalTokens && run.totalTokens > 0)) {
      this.logger.log(`\n  Totals:\n`, { type: 'info' });
      if (run.totalTokens && run.totalTokens > 0) {
        this.logger.log(`    Tokens: ${run.totalTokens.toLocaleString()}\n`, { type: 'info' });
      }
      if (grandCost > 0) {
        this.logger.log(`    Cost: $${grandCost.toFixed(4)}\n`, { type: 'info' });
      }
      this.logger.log(
        `    Duration: ${run.totalDuration ? formatDuration(run.totalDuration) : 'N/A'}\n`,
        { type: 'info' },
      );
    }
  }

  // ==================== Ablation Restore ====================

  async handleAblationRestore(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    // Step 1: Pick ablation definition (filter out those with no runs)
    const allAblations = this.ablationManager.list();
    const ablations = allAblations.filter(a => this.ablationManager.listRuns(a.name).length > 0);

    if (ablations.length === 0) {
      this.logger.log('\nNo ablation definitions with past runs found.\n', { type: 'warning' });
      return;
    }

    this.logger.log('\nSelect ablation to restore from:\n', { type: 'info' });

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      const runs = this.ablationManager.listRuns(ablation.name);
      this.logger.log(
        `  ${i + 1}. ${ablation.name} (${runs.length} past runs)\n`,
        { type: 'info' },
      );
    }

    const ablationSelection = (
      await rl.question('\nSelect ablation (or "q" to cancel, "exit" to quit): ')
    ).trim();

    this.checkExitCommand(ablationSelection);
    if (ablationSelection.toLowerCase() === 'q') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const ablationIndex = parseInt(ablationSelection) - 1;
    if (isNaN(ablationIndex) || ablationIndex < 0 || ablationIndex >= ablations.length) {
      this.logger.log('\nInvalid selection.\n', { type: 'error' });
      return;
    }

    const ablation = ablations[ablationIndex];

    // Step 2: Pick run (paginated with model info)
    const runs = this.ablationManager.listRuns(ablation.name);

    if (runs.length === 0) {
      this.logger.log(`\nNo runs found for "${ablation.name}".\n`, { type: 'warning' });
      return;
    }

    const selected = await this.selectRunPaginated(runs, `Runs for "${ablation.name}"`);
    if (!selected) {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const { timestamp, run } = selected;
    const runDir = this.ablationManager.getRunDirectory(ablation.name, timestamp);

    // Load the frozen definition from the run for clearContextBetweenPhases awareness
    const frozenDefPath = join(runDir, 'definition.yaml');
    let persistentContext = false;
    if (existsSync(frozenDefPath)) {
      try {
        const yaml = await import('yaml');
        const defContent = (await import('fs')).readFileSync(frozenDefPath, 'utf-8');
        const frozenDef = yaml.parse(defContent);
        persistentContext = frozenDef?.settings?.clearContextBetweenPhases === false;
      } catch { /* fallback to false */ }
    }

    // Step 3: Pick model+phase from run results
    // Group results by model
    const modelGroups = new Map<string, AblationRunResult[]>();
    for (const result of run.results) {
      const modelKey = `${result.model.provider}--${result.model.model}`;
      if (!modelGroups.has(modelKey)) {
        modelGroups.set(modelKey, []);
      }
      modelGroups.get(modelKey)!.push(result);
    }

    // If only one model, skip model selection
    const modelKeys = [...modelGroups.keys()];
    let selectedModelKey: string;
    let selectedModelResults: AblationRunResult[];

    if (modelKeys.length === 1) {
      selectedModelKey = modelKeys[0];
      selectedModelResults = modelGroups.get(selectedModelKey)!;
    } else {
      this.logger.log('\nSelect model:\n', { type: 'info' });
      for (let i = 0; i < modelKeys.length; i++) {
        const results = modelGroups.get(modelKeys[i])!;
        const modelShort = this.ablationManager.getModelShortName(results[0].model);
        const completedCount = results.filter(r => r.status === 'completed').length;
        const escalatedCount = results.filter(r => r.status === 'escalated').length;
        const escalatedSuffix = escalatedCount > 0 ? `, ${escalatedCount} escalated` : '';
        this.logger.log(
          `  ${i + 1}. ${modelShort} (${completedCount}/${results.length} phases completed${escalatedSuffix})\n`,
          { type: 'info' },
        );
      }

      const modelSelection = (
        await rl.question('\nSelect model (or "q" to cancel, "exit" to quit): ')
      ).trim();

      this.checkExitCommand(modelSelection);
      if (modelSelection.toLowerCase() === 'q') {
        this.logger.log('\nCancelled.\n', { type: 'info' });
        return;
      }

      const modelIdx = parseInt(modelSelection) - 1;
      if (isNaN(modelIdx) || modelIdx < 0 || modelIdx >= modelKeys.length) {
        this.logger.log('\nInvalid selection.\n', { type: 'error' });
        return;
      }

      selectedModelKey = modelKeys[modelIdx];
      selectedModelResults = modelGroups.get(selectedModelKey)!;
    }

    // Show phase selection
    this.logger.log('\nSelect phase to restore:\n', { type: 'info' });

    for (let i = 0; i < selectedModelResults.length; i++) {
      const result = selectedModelResults[i];
      const status = result.status === 'completed' ? '✓'
        : result.status === 'failed' ? '✗'
          : result.status === 'aborted' ? '!'
            : '○';
      const duration = result.duration ? formatDuration(result.duration) : 'N/A';
      this.logger.log(
        `  ${i + 1}. ${status} ${result.phase} | ${duration}\n`,
        { type: result.status === 'failed' ? 'error' : 'info' },
      );
    }

    if (selectedModelResults.length > 1) {
      this.logger.log(`  (Comma-separated for multiple, e.g. 2,3)\n`, { type: 'info' });
    }

    const phaseSelection = (
      await rl.question('\nSelect phase(s) (comma-separated, e.g. 2,3) (or "q" to cancel, "exit" to quit): ')
    ).trim().toLowerCase();

    this.checkExitCommand(phaseSelection);
    if (phaseSelection === 'q') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    let selectedResults: AblationRunResult[];

    if (phaseSelection === 'a' && selectedModelResults.length > 1) {
      selectedResults = selectedModelResults;
    } else if (phaseSelection.includes(',')) {
      // Comma-separated multi-select
      const indices = phaseSelection.split(',').map(s => parseInt(s.trim()) - 1);
      const invalid = indices.some(i => isNaN(i) || i < 0 || i >= selectedModelResults.length);
      if (invalid) {
        this.logger.log('\nInvalid selection.\n', { type: 'error' });
        return;
      }
      selectedResults = indices.map(i => selectedModelResults[i]);
    } else {
      const phaseIdx = parseInt(phaseSelection) - 1;
      if (isNaN(phaseIdx) || phaseIdx < 0 || phaseIdx >= selectedModelResults.length) {
        this.logger.log('\nInvalid selection.\n', { type: 'error' });
        return;
      }
      selectedResults = [selectedModelResults[phaseIdx]];
    }

    // Step 4: Handle outputs folder — always stash if not empty
    const outputsEmpty = this.ablationManager.isOutputsEmpty();

    if (!outputsEmpty) {
      const stashed = this.ablationManager.stashOutputs(runDir);
      if (!stashed) {
        this.logger.log('\nFailed to stash current outputs. Aborting.\n', { type: 'error' });
        return;
      }
      this.logger.log('  Current outputs stashed.\n', { type: 'info' });
    }

    // Copy outputs from selected phase(s)
    let totalRestored = 0;
    for (const result of selectedResults) {
      const phaseDir = this.ablationManager.getRunOutputsDir(
        runDir,
        result.phase,
        result.model,
        result.run,
        result.chatFile,
      );
      const count = this.ablationManager.restoreRunOutputs(phaseDir);
      totalRestored += count;
      if (count > 0) {
        this.logger.log(`  Restored outputs from "${result.phase}" (${count} items)\n`, { type: 'info' });
      }
    }

    if (totalRestored === 0) {
      this.logger.log('\nNo output files found in the selected phase(s).\n', { type: 'warning' });
    } else {
      this.logger.log(`\n✓ Restored ${totalRestored} output items to outputs folder.\n`, { type: 'success' });
    }

    // Step 5: Check for aborted phases — offer continue/interact before manual chat restore
    const abortedResults = selectedResults.filter(r => r.status === 'aborted');
    if (abortedResults.length > 0) {
      const label = abortedResults.length === 1
        ? 'Phase was aborted.'
        : `${abortedResults.length} aborted phases selected.`;
      const modeAnswer = (
        await rl.question(`\n${label} (c)ontinue from checkpoint, (i)nteract with session, or (n)either? (default: n): `)
      ).trim().toLowerCase();

      if (modeAnswer === 'c' || modeAnswer === 'continue' || modeAnswer === 'i' || modeAnswer === 'interact') {
        const isInteract = modeAnswer === 'i' || modeAnswer === 'interact';

        // Auto-switch to the run's model
        const runModel = abortedResults[0].model;
        await this.autoSwitchModel(runModel);

        // Load and restore chat for the first aborted phase
        const firstResult = abortedResults[0];
        const firstPhaseDir = this.ablationManager.getRunOutputsDir(runDir, firstResult.phase, firstResult.model, firstResult.run, firstResult.chatFile);
        const firstChatPath = join(firstPhaseDir, 'chat.json');
        const chatSession = existsSync(firstChatPath) ? this.ablationManager.loadChatFromFile(firstChatPath) : null;

        if (chatSession && chatSession.messages) {
          const chatHistoryCLI = this.callbacks.getChatHistoryCLI();
          const restoredCount = chatHistoryCLI.restoreFromSession(chatSession);
          this.logger.log(`\n✓ Restored ${restoredCount} messages into conversation context.\n`, { type: 'success' });

          if (isInteract) {
            await this.handleInteractSetup(firstPhaseDir, runDir, firstResult.phase, rl);
          } else {
            await this.handleContinuationSetup(chatSession, firstPhaseDir, runDir, firstResult.phase, rl);
          }

          // Queue remaining aborted phases for batch processing
          if (abortedResults.length > 1) {
            this.pendingBatchQueue = abortedResults.slice(1).map(r => ({
              runDir,
              phaseDir: this.ablationManager.getRunOutputsDir(runDir, r.phase, r.model, r.run, r.chatFile),
              phaseName: r.phase,
              model: r.model,
              run: r.run,
              mode: isInteract ? 'interact' as const : 'continue' as const,
            }));
          }
        } else {
          this.logger.log('\nFailed to load chat session for aborted phase.\n', { type: 'error' });
        }
        return; // Skip manual chat restore flow
      }
    }

    // Step 6: Manual chat restore (for non-aborted phases or "neither" mode)
    // Determine where chat.json lives
    let chatFilePath: string | null = null;

    if (persistentContext) {
      // Single cumulative chat at model level
      const model = selectedResults[0].model;
      const modelDir = this.ablationManager.getModelDirName(model);
      const runIter = selectedResults[0].run;
      const modelChatDir = runIter !== undefined
        ? join(runDir, modelDir, `run-${runIter}`)
        : join(runDir, modelDir);
      const candidatePath = join(modelChatDir, 'chat.json');
      if (existsSync(candidatePath)) {
        chatFilePath = candidatePath;
      }
    } else if (selectedResults.length === 1) {
      // Per-phase chat — use the selected phase
      const result = selectedResults[0];
      const phaseDir = this.ablationManager.getRunOutputsDir(
        runDir,
        result.phase,
        result.model,
        result.run,
        result.chatFile,
      );
      const candidatePath = join(phaseDir, 'chat.json');
      if (existsSync(candidatePath)) {
        chatFilePath = candidatePath;
      }
    } else {
      // Multiple phases — ask which chat to restore
      this.logger.log('\nMultiple phase chats available. Select one to restore:\n', { type: 'info' });
      const chatCandidates: { result: AblationRunResult; path: string }[] = [];
      for (const result of selectedResults) {
        const phaseDir = this.ablationManager.getRunOutputsDir(
          runDir,
          result.phase,
          result.model,
          result.run,
          result.chatFile,
        );
        const candidatePath = join(phaseDir, 'chat.json');
        if (existsSync(candidatePath)) {
          chatCandidates.push({ result, path: candidatePath });
        }
      }

      if (chatCandidates.length === 0) {
        this.logger.log('  No chat files found.\n', { type: 'info' });
      } else {
        for (let i = 0; i < chatCandidates.length; i++) {
          const r = chatCandidates[i].result;
          const status = r.status === 'completed' ? '✓' : r.status === 'escalated' ? '⤴' : '○';
          const model = `${r.model.provider}/${r.model.model}`;
          const attempt = r.attempt ? ` attempt ${r.attempt}` : '';
          const run = r.run ? ` run ${r.run}` : '';
          const dur = r.durationFormatted ? ` │ ${r.durationFormatted}` : '';
          this.logger.log(
            `  ${i + 1}. ${status} ${r.phase}${run}${attempt} │ ${model}${dur}\n`,
            { type: 'info' },
          );
        }
        this.logger.log(`  s. Skip chat restore\n`, { type: 'info' });

        const chatSelection = (
          await rl.question('\nSelect chat to restore (or "s" to skip): ')
        ).trim().toLowerCase();

        if (chatSelection !== 's' && chatSelection !== 'skip') {
          const chatIdx = parseInt(chatSelection) - 1;
          if (!isNaN(chatIdx) && chatIdx >= 0 && chatIdx < chatCandidates.length) {
            chatFilePath = chatCandidates[chatIdx].path;
          }
        }
      }
    }

    if (chatFilePath) {
      const restoreChat = (
        await rl.question('\nAlso restore chat into conversation context? (y/n, default: n): ')
      ).trim().toLowerCase();

      if (restoreChat === 'y' || restoreChat === 'yes') {
        // Auto-switch: check if the run's model differs from current
        const runModel = selectedResults[0].model;
        const currentProviderName = this.client.getProviderName();
        const currentModelId = this.client.getModel();
        const needsSwitch = runModel.provider !== currentProviderName || runModel.model !== currentModelId;

        if (needsSwitch) {
          const runModelShort = this.ablationManager.getModelShortName(runModel);
          const switchAnswer = (
            await rl.question(
              `\nRun used ${runModel.provider}/${runModelShort} (current: ${currentProviderName}/${currentModelId}).\n` +
              `Switch to the run's model before restoring? (y/n, default: n): `
            )
          ).trim().toLowerCase();

          if (switchAnswer === 'y' || switchAnswer === 'yes') {
            const provider = createProvider(runModel.provider);
            if (provider) {
              await this.client.switchProviderAndModel(provider, runModel.model);
            } else {
              this.logger.log(`  Warning: Could not create provider "${runModel.provider}", continuing with current model.\n`, { type: 'warning' });
              this.client.clearContext();
            }
          } else {
            this.client.clearContext();
          }
        } else {
          this.client.clearContext();
        }

        const chatSession = this.ablationManager.loadChatFromFile(chatFilePath);
        if (chatSession && chatSession.messages) {
          const chatHistoryCLI = this.callbacks.getChatHistoryCLI();
          const restoredCount = chatHistoryCLI.restoreFromSession(chatSession);
          this.logger.log(
            `\n✓ Restored ${restoredCount} messages into conversation context.\n`,
            { type: 'success' },
          );
        } else {
          this.logger.log('\nFailed to load chat session from file.\n', { type: 'error' });
        }
      }
    } else if (selectedResults.length === 1 || !persistentContext) {
      // Only mention no chat if we didn't already handle chat selection above
      const phaseDir = this.ablationManager.getRunOutputsDir(
        runDir,
        selectedResults[0].phase,
        selectedResults[0].model,
        selectedResults[0].run,
        selectedResults[0].chatFile,
      );
      if (!existsSync(join(phaseDir, 'chat.json'))) {
        this.logger.log('\n  (No chat file found for this phase — likely a dry run)\n', { type: 'info' });
      }
    }
  }

  // ==================== Ablation Continuation ====================

  /**
   * After restoring an aborted phase chat, rewind to the last save_scene_state checkpoint,
   * physically restore the scene via MCP, inject the result, remove the iteration limit,
   * and auto-trigger the agent to continue.
   */
  private async handleContinuationSetup(
    chatSession: any,
    phaseDir: string,
    runDir: string,
    phaseName: string,
    rl: readline.Interface,
  ): Promise<void> {
    const messages: any[] = chatSession.messages || [];

    // Search backwards for the last save_scene_state tool result (preferred checkpoint),
    // falling back to restore_scene_state if no save is found.
    let checkpointIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'tool' && msg.toolName && msg.toolName.includes('save_scene_state')) {
        checkpointIdx = i;
        break;
      }
    }
    if (checkpointIdx === -1) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'tool' && msg.toolName && msg.toolName.includes('restore_scene_state')) {
          checkpointIdx = i;
          break;
        }
      }
    }

    if (checkpointIdx === -1) {
      this.logger.log(
        '\n  No scene checkpoint found (save_scene_state / restore_scene_state). Cannot auto-rewind.\n',
        { type: 'warning' },
      );
      return;
    }

    const checkpointMsg = messages[checkpointIdx];
    const filename: string | undefined = checkpointMsg.toolInput?.json_file_path;
    this.logger.log(
      `\n  Found checkpoint: ${checkpointMsg.toolName} — ${filename ?? '(no filename)'}\n`,
      { type: 'info' },
    );

    if (!filename) {
      this.logger.log('  Warning: No json_file_path in checkpoint call. Cannot auto-restore scene.\n', { type: 'warning' });
      return;
    }

    // Truncate just before the next assistant message after the checkpoint
    let truncationIdx = messages.length;
    for (let i = checkpointIdx + 1; i < messages.length; i++) {
      if (messages[i].role === 'assistant') {
        truncationIdx = i;
        break;
      }
    }
    const removedCount = messages.length - truncationIdx;
    if (removedCount > 0) {
      this.logger.log(`  Removing ${removedCount} messages after checkpoint.\n`, { type: 'info' });
    }

    // Re-restore from truncated session
    const truncatedSession = { ...chatSession, messages: messages.slice(0, truncationIdx) };
    this.client.clearContext();
    const chatHistoryCLI = this.callbacks.getChatHistoryCLI();
    const rewindCount = chatHistoryCLI.restoreFromSession(truncatedSession);
    this.logger.log(`  Rewound to checkpoint (${rewindCount} messages in context).\n`, { type: 'success' });

    // Physically restore the scene and inject the call+result into context
    const restoreToolName = checkpointMsg.toolName.replace('save_scene_state', 'restore_scene_state');
    const restoreInput = { json_file_path: filename };
    this.logger.log(`  Calling ${restoreToolName} with ${filename}...\n`, { type: 'info' });
    try {
      const restoreResult = await this.client.executeMCPTool(restoreToolName, restoreInput);
      this.client.injectToolResult(restoreToolName, restoreInput as Record<string, unknown>, restoreResult);
      this.logger.log('  Scene restored.\n', { type: 'success' });
    } catch (err) {
      this.logger.log(`  Warning: ${restoreToolName} failed: ${err}\n`, { type: 'warning' });
      this.client.injectToolResult(restoreToolName, restoreInput as Record<string, unknown>, {
        displayText: `Scene restoration attempted (${filename})`,
        contentBlocks: [{ type: 'text', text: `restore_scene_state called with json_file_path=${filename}` }],
      });
    }

    // Restore ablation phase configuration (tool filter, system prompt, hooks)
    const frozenDefPath = join(runDir, 'definition.yaml');
    if (existsSync(frozenDefPath)) {
      const yaml = (await import('yaml')).default;
      const frozenDef = yaml.parse(readFileSync(frozenDefPath, 'utf-8')) as AblationDefinition;
      const phaseDef = frozenDef.phases?.find((p: any) => p.name === phaseName);
      const runMeta = this.ablationManager.loadRunResults(runDir);
      const resolvedArguments = runMeta?.resolvedArguments ?? {};

      // Apply tool filter
      const phaseToolFilter = this.ablationManager.getToolFilterForPhase(frozenDef, phaseName);
      if (phaseToolFilter) {
        this.client.applyAblationToolFilter(
          tools => this.ablationManager.applyToolFilter(tools, phaseToolFilter),
        );
        this.logger.log(`  Tool filter applied (${this.client.getTools().length} tools available).\n`, { type: 'info' });
      }

      // Restore system prompt
      const effectivePrompt = phaseDef?.systemPrompt ?? frozenDef.systemPrompt ?? null;
      if (effectivePrompt !== null) {
        const resolved = await this.resolvePromptReference(effectivePrompt, resolvedArguments ?? {});
        this.client.setSystemPrompt(resolved);
        this.logger.log('  System prompt restored.\n', { type: 'info' });
      } else {
        this.client.setSystemPrompt(null);
      }

      // Load ablation hooks
      const hookManager = this.client.getHookManager();
      hookManager.suspend();
      const phaseHooks = this.ablationManager.getHooksForPhase(frozenDef, phaseName);
      if (phaseHooks.length > 0) {
        hookManager.loadAblationHooks(phaseHooks);
        hookManager.setCurrentPhaseName(phaseName);
        hookManager.resetPhaseComplete();
        this.logger.log(`  ${phaseHooks.length} phase hook(s) loaded.\n`, { type: 'info' });
      }
    }

    // Remove iteration limit for continuation
    this.preferencesManager.setMaxIterations(-1);
    this.callbacks.restoreIterationLimitCallback();
    this.logger.log('  Iteration limit removed (unlimited).\n', { type: 'success' });

    // Store phase dir for /ablation-save-continuation and trigger agent auto-continuation
    this.continuationPhaseDir = phaseDir;
    this.continuationRunDir = runDir;
    this.callbacks.setPendingContinuation();
    this.logger.log(
      `  Agent will continue automatically. Run /ablation-save-continuation when done to save as chat_new.json.\n`,
      { type: 'info' },
    );
  }

  /**
   * Auto-switch to the model used by a run, if different from current.
   */
  private async autoSwitchModel(runModel: import('../managers/ablation-manager.js').AblationModel): Promise<void> {
    const currentProvider = this.client.getProviderName();
    const currentModel = this.client.getModel();
    if (runModel.provider !== currentProvider || runModel.model !== currentModel) {
      const provider = createProvider(runModel.provider);
      if (provider) {
        await this.client.switchProviderAndModel(provider, runModel.model);
        const shortName = this.ablationManager.getModelShortName(runModel);
        this.logger.log(`  Switched to ${runModel.provider}/${shortName}.\n`, { type: 'info' });
      } else {
        this.logger.log(`  Warning: Could not switch to ${runModel.provider}/${runModel.model}.\n`, { type: 'warning' });
        this.client.clearContext();
      }
    } else {
      this.client.clearContext();
    }
  }

  /**
   * Check if there are more batched phases to process.
   * If so, restore outputs + chat for the next one and set it up.
   * Returns true if a next phase was started.
   */
  async advanceBatchQueue(rl: readline.Interface): Promise<boolean> {
    if (this.pendingBatchQueue.length === 0) return false;

    const next = this.pendingBatchQueue.shift()!;
    this.logger.log(`\n── Batch: starting next phase "${next.phaseName}" (${this.pendingBatchQueue.length} remaining) ──\n`, { type: 'info' });

    // Stash current outputs, restore this phase's outputs
    if (!this.ablationManager.isOutputsEmpty()) {
      this.ablationManager.stashOutputs(next.runDir);
    }
    const count = this.ablationManager.restoreRunOutputs(next.phaseDir);
    if (count > 0) {
      this.logger.log(`  Restored ${count} output items.\n`, { type: 'info' });
    }

    // Auto-switch model and load chat
    await this.autoSwitchModel(next.model);
    const chatPath = join(next.phaseDir, 'chat.json');
    if (existsSync(chatPath)) {
      const chatSession = this.ablationManager.loadChatFromFile(chatPath);
      if (chatSession && chatSession.messages) {
        const chatHistoryCLI = this.callbacks.getChatHistoryCLI();
        const restoredCount = chatHistoryCLI.restoreFromSession(chatSession);
        this.logger.log(`  Restored ${restoredCount} messages.\n`, { type: 'info' });

        if (next.mode === 'interact') {
          await this.handleInteractSetup(next.phaseDir, next.runDir, next.phaseName, rl);
        } else {
          await this.handleContinuationSetup(chatSession, next.phaseDir, next.runDir, next.phaseName, rl);
        }
        return true;
      }
    }

    this.logger.log(`  Warning: No chat.json found for "${next.phaseName}", skipping.\n`, { type: 'warning' });
    // Try the next one
    return this.advanceBatchQueue(rl);
  }

  hasPendingBatch(): boolean {
    return this.pendingBatchQueue.length > 0;
  }

  /**
   * Set up interact mode: optionally load ablation hooks, store dirs for
   * finalization, but don't rewind or auto-trigger the agent.
   * The user is dropped into a normal CLI session with the restored chat/outputs.
   */
  private async handleInteractSetup(
    phaseDir: string,
    runDir: string,
    phaseName: string,
    rl: readline.Interface,
  ): Promise<void> {
    // Load frozen definition for hooks/tool filter/system prompt
    const frozenDefPath = join(runDir, 'definition.yaml');
    if (existsSync(frozenDefPath)) {
      const hooksAnswer = (
        await rl.question('  Load ablation hooks for this phase? (y/n, default: n): ')
      ).trim().toLowerCase();
      const loadHooks = hooksAnswer === 'y' || hooksAnswer === 'yes';

      if (loadHooks) {
        const yaml = (await import('yaml')).default;
        const frozenDef = yaml.parse(readFileSync(frozenDefPath, 'utf-8')) as AblationDefinition;
        const phaseDef = frozenDef.phases?.find((p: any) => p.name === phaseName);
        const runMeta = this.ablationManager.loadRunResults(runDir);
        const resolvedArguments = runMeta?.resolvedArguments ?? {};

        // Apply tool filter
        const phaseToolFilter = this.ablationManager.getToolFilterForPhase(frozenDef, phaseName);
        if (phaseToolFilter) {
          this.client.applyAblationToolFilter(
            tools => this.ablationManager.applyToolFilter(tools, phaseToolFilter),
          );
          this.logger.log(`  Tool filter applied (${this.client.getTools().length} tools available).\n`, { type: 'info' });
        }

        // Restore system prompt
        const effectivePrompt = phaseDef?.systemPrompt ?? frozenDef.systemPrompt ?? null;
        if (effectivePrompt !== null) {
          const resolved = await this.resolvePromptReference(effectivePrompt, resolvedArguments);
          this.client.setSystemPrompt(resolved);
          this.logger.log('  System prompt restored.\n', { type: 'info' });
        }

        // Load ablation hooks
        const hookManager = this.client.getHookManager();
        hookManager.suspend();
        const phaseHooks = this.ablationManager.getHooksForPhase(frozenDef, phaseName);
        if (phaseHooks.length > 0) {
          hookManager.loadAblationHooks(phaseHooks);
          hookManager.setCurrentPhaseName(phaseName);
          hookManager.resetPhaseComplete();
          this.logger.log(`  ${phaseHooks.length} phase hook(s) loaded.\n`, { type: 'info' });
        }
      }
    }

    // Store dirs for finalization (save/unstash on exit or /ablation-save-continuation)
    this.continuationPhaseDir = phaseDir;
    this.continuationRunDir = runDir;
    this.logger.log(
      `  Interact mode active. Run /ablation-save-continuation when done.\n`,
      { type: 'info' },
    );
  }

  // ==================== Ablation Edit Helpers ====================

  private async handleAddPhase(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const phaseName = (await rl.question('\n  Phase name: ')).trim();
    if (!phaseName) {
      this.logger.log('\n✗ Phase name required.\n', { type: 'error' });
      return;
    }

    this.logger.log('  Enter commands (empty line to finish):\n', {
      type: 'info',
    });
    const commands: string[] = [];

    while (true) {
      const command = (await rl.question('    > ')).trim();
      if (!command) break;
      commands.push(command);
    }

    if (commands.length === 0) {
      this.logger.log('\n✗ At least one command required.\n', { type: 'error' });
      return;
    }

    try {
      this.ablationManager.addPhase(ablationName, { name: phaseName, enabled: true, commands });
      this.logger.log('\n✓ Phase added.\n', { type: 'success' });
    } catch (error: any) {
      this.logger.log(`\n✗ ${error.message}\n`, { type: 'error' });
    }
  }

  private async handleEditPhase(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation || ablation.phases.length === 0) {
      this.logger.log('\n✗ No phases to edit.\n', { type: 'error' });
      return;
    }

    this.logger.log('\n  Select phase to edit:\n', { type: 'info' });
    for (let i = 0; i < ablation.phases.length; i++) {
      this.logger.log(
        `    ${i + 1}. ${ablation.phases[i].name} (${ablation.phases[i].commands.length} commands)\n`,
        { type: 'info' },
      );
    }

    const selection = (await rl.question('\n  Select phase: ')).trim();
    const index = parseInt(selection) - 1;

    if (isNaN(index) || index < 0 || index >= ablation.phases.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const phase = ablation.phases[index];
    this.logger.log(`\n  Current commands for "${phase.name}":\n`, {
      type: 'info',
    });
    for (let i = 0; i < phase.commands.length; i++) {
      this.logger.log(`    ${i + 1}. ${phase.commands[i]}\n`, { type: 'info' });
    }

    this.logger.log('\n  Enter new commands (empty line to finish):\n', {
      type: 'info',
    });
    const commands: string[] = [];

    while (true) {
      const command = (await rl.question('    > ')).trim();
      if (!command) break;
      commands.push(command);
    }

    if (commands.length === 0) {
      this.logger.log('\n✗ At least one command required. Phase unchanged.\n', {
        type: 'warning',
      });
      return;
    }

    try {
      this.ablationManager.updatePhase(ablationName, phase.name, { commands });
      this.logger.log('\n✓ Phase updated.\n', { type: 'success' });
    } catch (error: any) {
      this.logger.log(`\n✗ ${error.message}\n`, { type: 'error' });
    }
  }

  private async handleRemovePhase(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation || ablation.phases.length === 0) {
      this.logger.log('\n✗ No phases to remove.\n', { type: 'error' });
      return;
    }

    if (ablation.phases.length === 1) {
      this.logger.log('\n✗ Cannot remove the only phase.\n', { type: 'error' });
      return;
    }

    this.logger.log('\n  Select phase to remove:\n', { type: 'info' });
    for (let i = 0; i < ablation.phases.length; i++) {
      this.logger.log(`    ${i + 1}. ${ablation.phases[i].name}\n`, {
        type: 'info',
      });
    }

    const selection = (await rl.question('\n  Select phase: ')).trim();
    const index = parseInt(selection) - 1;

    if (isNaN(index) || index < 0 || index >= ablation.phases.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    try {
      this.ablationManager.removePhase(
        ablationName,
        ablation.phases[index].name,
      );
      this.logger.log('\n✓ Phase removed.\n', { type: 'success' });
    } catch (error: any) {
      this.logger.log(`\n✗ ${error.message}\n`, { type: 'error' });
    }
  }

  /**
   * Prompt user for thinking level for a model, if the model supports reasoning.
   * Mutates the model in-place to set the thinking field.
   * Mirrors the /set-thinking on flow from cli-client.ts.
   */
  private async promptForThinking(model: AblationModel): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    if (!isReasoningModel(model.model, model.provider)) {
      return;
    }

    const levels = getThinkingLevelsForProvider(model.provider);
    if (levels.length === 0) return;

    const enableThinking = (
      await rl.question(`    Enable thinking for ${model.provider}/${model.model}? (y/N): `)
    ).trim().toLowerCase();

    if (enableThinking !== 'y' && enableThinking !== 'yes') {
      return;
    }

    if (levels.length === 1) {
      model.thinking = levels[0].value;
      this.logger.log(`    ✓ Thinking: ${levels[0].value}\n`, { type: 'success' });
    } else {
      const defaultLevel = getDefaultThinkingLevel(model.provider);
      this.logger.log(`    Select thinking level:\n`, { type: 'info' });
      for (let i = 0; i < levels.length; i++) {
        this.logger.log(`      ${i + 1}. ${levels[i].label}\n`, { type: 'info' });
      }

      const answer = (await rl.question('    Enter selection (or Enter for default): ')).trim();
      if (answer === '' && defaultLevel) {
        model.thinking = defaultLevel;
        this.logger.log(`    ✓ Thinking: ${defaultLevel}\n`, { type: 'success' });
      } else {
        const selection = parseInt(answer, 10);
        if (selection >= 1 && selection <= levels.length) {
          model.thinking = levels[selection - 1].value;
          this.logger.log(`    ✓ Thinking: ${levels[selection - 1].value}\n`, { type: 'success' });
        } else {
          this.logger.log('    Invalid selection. Thinking disabled for this model.\n', { type: 'warning' });
        }
      }
    }
  }

  private async handleAddModels(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    this.logger.log('\n  Select provider:\n', { type: 'info' });
    for (let i = 0; i < PROVIDERS.length; i++) {
      this.logger.log(`    ${i + 1}. ${PROVIDERS[i].label}\n`, { type: 'info' });
    }

    const providerSelection = (
      await rl.question('\n  Select provider: ')
    ).trim();
    const providerIndex = parseInt(providerSelection) - 1;

    if (
      isNaN(providerIndex) ||
      providerIndex < 0 ||
      providerIndex >= PROVIDERS.length
    ) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const provider = PROVIDERS[providerIndex];
    this.logger.log(`\n  Select ${provider.label} models:\n`, { type: 'info' });
    for (let i = 0; i < provider.models.length; i++) {
      this.logger.log(`    ${i + 1}. ${provider.models[i]}\n`, { type: 'info' });
    }
    this.logger.log(`    ${provider.models.length + 1}. Custom model\n`, {
      type: 'info',
    });

    const modelSelection = (
      await rl.question('\n  Select models (e.g., 1,2): ')
    ).trim();
    const selectedIndices = this.parseSelection(
      modelSelection,
      provider.models.length + 1,
    );

    const modelsToAdd: AblationModel[] = [];
    for (const idx of selectedIndices) {
      if (idx === provider.models.length + 1) {
        const customModel = (
          await rl.question('  Enter custom model: ')
        ).trim();
        if (customModel) {
          const m: AblationModel = { provider: provider.name, model: customModel };
          await this.promptForThinking(m);
          modelsToAdd.push(m);
        }
      } else {
        const m: AblationModel = {
          provider: provider.name,
          model: provider.models[idx - 1],
        };
        await this.promptForThinking(m);
        modelsToAdd.push(m);
      }
    }

    if (modelsToAdd.length > 0) {
      this.ablationManager.addModels(ablationName, modelsToAdd);
      this.logger.log(`\n✓ Added ${modelsToAdd.length} model(s).\n`, {
        type: 'success',
      });
    }
  }

  private async handleRemoveModels(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation || ablation.models.length === 0) {
      this.logger.log('\n✗ No models to remove.\n', { type: 'error' });
      return;
    }

    if (ablation.models.length === 1) {
      this.logger.log('\n✗ Cannot remove the only model.\n', { type: 'error' });
      return;
    }

    this.logger.log('\n  Select models to remove:\n', { type: 'info' });
    for (let i = 0; i < ablation.models.length; i++) {
      const m = ablation.models[i];
      this.logger.log(`    ${i + 1}. ${m.provider}/${m.model}\n`, {
        type: 'info',
      });
    }

    const selection = (
      await rl.question('\n  Select models (e.g., 1,2): ')
    ).trim();
    const selectedIndices = this.parseSelection(
      selection,
      ablation.models.length,
    );

    const modelsToRemove = selectedIndices.map(
      (idx) => ablation.models[idx - 1],
    );

    if (
      modelsToRemove.length > 0 &&
      modelsToRemove.length < ablation.models.length
    ) {
      this.ablationManager.removeModels(ablationName, modelsToRemove);
      this.logger.log(`\n✓ Removed ${modelsToRemove.length} model(s).\n`, {
        type: 'success',
      });
    } else if (modelsToRemove.length >= ablation.models.length) {
      this.logger.log('\n✗ Cannot remove all models.\n', { type: 'error' });
    }
  }

  private async handleEditModelThinking(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation || ablation.models.length === 0) {
      this.logger.log('\n  No models to configure.\n', { type: 'error' });
      return;
    }

    this.logger.log('\n  Current model thinking configuration:\n', { type: 'info' });
    for (let i = 0; i < ablation.models.length; i++) {
      const m = ablation.models[i];
      const thinkingStatus = m.thinking ? `thinking: ${m.thinking}` : 'thinking: off';
      const supportsThinking = isReasoningModel(m.model, m.provider);
      const supportInfo = supportsThinking ? '' : ' (not a reasoning model)';
      this.logger.log(`    ${i + 1}. ${m.provider}/${m.model} [${thinkingStatus}]${supportInfo}\n`, { type: 'info' });
    }

    const selection = (await rl.question('\n  Select model to configure (or "q" to cancel): ')).trim();
    if (selection.toLowerCase() === 'q') return;

    const idx = parseInt(selection) - 1;
    if (isNaN(idx) || idx < 0 || idx >= ablation.models.length) {
      this.logger.log('\n  Invalid selection.\n', { type: 'error' });
      return;
    }

    const model = ablation.models[idx];

    if (!isReasoningModel(model.model, model.provider)) {
      this.logger.log(`\n  ${model.model} does not support thinking/reasoning.\n`, { type: 'warning' });
      return;
    }

    const levels = getThinkingLevelsForProvider(model.provider);
    if (levels.length === 0) {
      this.logger.log('\n  No thinking levels available for this provider.\n', { type: 'warning' });
      return;
    }

    this.logger.log(`\n  Select thinking level for ${model.provider}/${model.model}:\n`, { type: 'info' });
    this.logger.log(`    0. Off (disable thinking)\n`, { type: 'info' });
    for (let i = 0; i < levels.length; i++) {
      this.logger.log(`    ${i + 1}. ${levels[i].label}\n`, { type: 'info' });
    }

    const defaultLevel = getDefaultThinkingLevel(model.provider);
    const answer = (await rl.question('\n  Enter selection (or Enter for default): ')).trim();

    if (answer === '' && defaultLevel) {
      model.thinking = defaultLevel;
      this.logger.log(`\n  ✓ Thinking set to: ${defaultLevel}\n`, { type: 'success' });
    } else {
      const levelIdx = parseInt(answer, 10);
      if (levelIdx === 0) {
        delete model.thinking;
        this.logger.log('\n  ✓ Thinking disabled for this model.\n', { type: 'success' });
      } else if (levelIdx >= 1 && levelIdx <= levels.length) {
        model.thinking = levels[levelIdx - 1].value;
        this.logger.log(`\n  ✓ Thinking set to: ${model.thinking}\n`, { type: 'success' });
      } else {
        this.logger.log('\n  Invalid selection.\n', { type: 'error' });
        return;
      }
    }

    ablation.updated = new Date().toISOString();
    this.ablationManager.save(ablation);
  }

  private async handleEditSettings(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation) return;

    this.logger.log('\n  Current settings:\n', { type: 'info' });
    this.logger.log(`    Max iterations: ${ablation.settings.maxIterations}\n`, {
      type: 'info',
    });
    this.logger.log(`    MCP timeout: ${ablation.settings.mcpTimeout !== undefined ? `${ablation.settings.mcpTimeout}s` : 'system default'}\n`, {
      type: 'info',
    });
    this.logger.log(`    Max IPC calls: ${ablation.settings.maxIpcCalls !== undefined ? ablation.settings.maxIpcCalls : 'system default'}\n`, {
      type: 'info',
    });
    this.logger.log(`    Repeat runs: ${ablation.runs ?? 1}\n`, {
      type: 'info',
    });
    this.logger.log(`    Clear context between phases: ${ablation.settings.clearContextBetweenPhases !== false ? 'yes' : 'no'}\n`, {
      type: 'info',
    });

    const maxIterStr = (
      await rl.question('\n  Max iterations (Enter to keep): ')
    ).trim();

    const newSettings = { ...ablation.settings };

    if (maxIterStr) {
      const maxIter = parseInt(maxIterStr);
      if (!isNaN(maxIter) && maxIter > 0) newSettings.maxIterations = maxIter;
    }

    const currentTimeout = ablation.settings.mcpTimeout !== undefined ? `${ablation.settings.mcpTimeout}s` : 'system default';
    const mcpTimeoutStr = (
      await rl.question(`  MCP timeout (Enter to keep ${currentTimeout}, 0 to clear): `)
    ).trim();
    if (mcpTimeoutStr) {
      const timeout = parseInt(mcpTimeoutStr);
      if (timeout === 0) {
        delete newSettings.mcpTimeout;
      } else if (!isNaN(timeout) && timeout > 0 && timeout <= 3600) {
        newSettings.mcpTimeout = timeout;
      }
    }

    const currentIpcCalls = ablation.settings.maxIpcCalls !== undefined ? `${ablation.settings.maxIpcCalls}` : 'system default';
    const maxIpcCallsStr = (
      await rl.question(`  Max IPC calls per phase (Enter to keep ${currentIpcCalls}, 0 to clear): `)
    ).trim();
    if (maxIpcCallsStr) {
      const ipcCalls = parseInt(maxIpcCallsStr);
      if (ipcCalls === 0) {
        delete newSettings.maxIpcCalls;
      } else if (!isNaN(ipcCalls) && ipcCalls > 0 && ipcCalls <= 10000) {
        newSettings.maxIpcCalls = ipcCalls;
      }
    }

    const runsStr = (
      await rl.question(`  Repeat runs (Enter to keep ${ablation.runs ?? 1}): `)
    ).trim();

    let newRuns = ablation.runs;
    if (runsStr) {
      const runs = parseInt(runsStr);
      if (!isNaN(runs) && runs > 0) {
        newRuns = runs > 1 ? runs : undefined;
      }
    }

    const clearCtxStr = (
      await rl.question(`  Clear context between phases? (Y/n, Enter to keep): `)
    ).trim().toLowerCase();

    if (clearCtxStr === 'n' || clearCtxStr === 'no') {
      newSettings.clearContextBetweenPhases = false;
    } else if (clearCtxStr === 'y' || clearCtxStr === 'yes') {
      delete newSettings.clearContextBetweenPhases;
    }

    this.ablationManager.update(ablationName, { settings: newSettings, runs: newRuns });
    this.logger.log('\n✓ Settings updated.\n', { type: 'success' });
  }

  private async handleEditDescription(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation) return;

    this.logger.log(
      `\n  Current description: ${ablation.description || '(none)'}\n`,
      { type: 'info' },
    );

    const newDescription = (
      await rl.question('  New description: ')
    ).trim();

    this.ablationManager.update(ablationName, { description: newDescription });
    this.logger.log('\n✓ Description updated.\n', { type: 'success' });
  }

  /**
   * Handler to edit MCP config path for an ablation
   */
  private async handleEditMcpConfigPath(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation) return;

    const defaultMcpConfigPath = this.ablationManager.getDefaultMcpConfigPath();

    this.logger.log(
      `\n  Current MCP config: ${ablation.settings.mcpConfigPath}\n`,
      { type: 'info' },
    );
    this.logger.log('  Enter a path relative to project root or absolute path.\n', { type: 'info' });
    this.logger.log('  Leave empty to use the default.\n', { type: 'info' });

    const newPath = (
      await rl.question(`  New MCP config path (default: ${defaultMcpConfigPath}): `)
    ).trim();

    if (!newPath) {
      // Set to default path
      this.ablationManager.update(ablationName, { settings: { ...ablation.settings, mcpConfigPath: defaultMcpConfigPath } });
      this.logger.log(`\n✓ MCP config set to default: ${defaultMcpConfigPath}\n`, { type: 'success' });
      return;
    }

    // Validate the new path
    const validation = this.ablationManager.validateMcpConfigPath(newPath);
    if (validation.valid) {
      this.ablationManager.update(ablationName, { settings: { ...ablation.settings, mcpConfigPath: newPath } });
      this.logger.log('\n✓ MCP config path updated.\n', { type: 'success' });
    } else {
      this.logger.log(`\n  ⚠ Warning: ${validation.error}\n`, { type: 'warning' });
      const useAnyway = (
        await rl.question('  Use this path anyway? (y/N): ')
      ).trim().toLowerCase();
      if (useAnyway === 'y' || useAnyway === 'yes') {
        this.ablationManager.update(ablationName, { settings: { ...ablation.settings, mcpConfigPath: newPath } });
        this.logger.log('\n✓ MCP config path updated.\n', { type: 'success' });
      } else {
        this.logger.log('\n  MCP config path unchanged.\n', { type: 'info' });
      }
    }
  }

  /**
   * Handler to edit post-tool hooks for an ablation
   */
  private async handleEditHooks(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation) return;

    while (true) {
      // Display current post-tool hooks
      const topHooks = ablation.hooks ?? [];
      const phaseHooks: { phase: string; hook: PostToolHook }[] = [];
      for (const phase of ablation.phases) {
        for (const hook of (phase.hooks ?? [])) {
          phaseHooks.push({ phase: phase.name, hook });
        }
      }

      const allHooks: { label: string; isTopLevel: boolean; phase?: string; index: number }[] = [];

      this.logger.log('\n  Current tool hooks:\n', { type: 'info' });
      if (topHooks.length === 0 && phaseHooks.length === 0) {
        this.logger.log('    (none)\n', { type: 'info' });
      } else {
        let num = 1;
        for (let i = 0; i < topHooks.length; i++) {
          const h = topHooks[i];
          const trigger = h.before ? `before ${h.before}` : `after ${h.after}`;
          const whenInputStr = h.whenInput ? ` whenInput ${JSON.stringify(h.whenInput)}` : '';
          const whenOutputStr = h.whenOutput ? ` whenOutput ${JSON.stringify(h.whenOutput)}` : '';
          this.logger.log(`    ${num}. [all phases] ${trigger}${whenInputStr}${whenOutputStr} → ${h.run}\n`, { type: 'info' });
          allHooks.push({ label: `[all phases] ${trigger}`, isTopLevel: true, index: i });
          num++;
        }
        for (const ph of phaseHooks) {
          const phaseObj = ablation.phases.find(p => p.name === ph.phase);
          const hookIdx = phaseObj?.hooks?.indexOf(ph.hook) ?? 0;
          const trigger = ph.hook.before ? `before ${ph.hook.before}` : `after ${ph.hook.after}`;
          const whenInputStr = ph.hook.whenInput ? ` whenInput ${JSON.stringify(ph.hook.whenInput)}` : '';
          const whenOutputStr = ph.hook.whenOutput ? ` whenOutput ${JSON.stringify(ph.hook.whenOutput)}` : '';
          this.logger.log(`    ${num}. [${ph.phase}] ${trigger}${whenInputStr}${whenOutputStr} → ${ph.hook.run}\n`, { type: 'info' });
          allHooks.push({ label: `[${ph.phase}] ${trigger}`, isTopLevel: false, phase: ph.phase, index: hookIdx });
          num++;
        }
      }

      // Display current lifecycle hooks
      this.logger.log('\n  Current lifecycle hooks:\n', { type: 'info' });
      let hasLifecycleHooks = false;
      for (const phase of ablation.phases) {
        for (const cmd of (phase.onStart ?? [])) {
          this.logger.log(`    [${phase.name}] onStart → ${cmd}\n`, { type: 'info' });
          hasLifecycleHooks = true;
        }
        for (const cmd of (phase.onEnd ?? [])) {
          this.logger.log(`    [${phase.name}] onEnd → ${cmd}\n`, { type: 'info' });
          hasLifecycleHooks = true;
        }
      }
      if (!hasLifecycleHooks) {
        this.logger.log('    (none)\n', { type: 'info' });
      }

      this.logger.log('\n  Options:\n', { type: 'info' });
      this.logger.log('    1. Add tool hook\n', { type: 'info' });
      this.logger.log('    2. Remove tool hook\n', { type: 'info' });
      this.logger.log('    3. Edit lifecycle hooks (onStart/onEnd)\n', { type: 'info' });
      this.logger.log('    4. Done\n', { type: 'info' });

      const choice = (await rl.question('\n  Select option: ')).trim();

      if (choice === '1') {
        // Add tool hook
        this.logger.log('  Timing:\n', { type: 'info' });
        this.logger.log('    1. After (run after tool completes)\n', { type: 'info' });
        this.logger.log('    2. Before (run before tool executes)\n', { type: 'info' });
        const timingStr = (await rl.question('  Select timing: ')).trim();
        const isBefore = timingStr === '2';

        const toolName = (
          await rl.question('  Tool name to watch (e.g. ros-mcp-server__verify_assembly): ')
        ).trim();
        if (!toolName) continue;

        const runCmd = (
          await rl.question(`  Command to run ${isBefore ? 'before' : 'after'} (e.g. @tool-exec:server__tool(arg='val')): `)
        ).trim();
        if (!runCmd) continue;

        const newHook: PostToolHook = isBefore
          ? { before: toolName, run: runCmd }
          : { after: toolName, run: runCmd };

        // Ask for optional condition (after-hooks only)
        if (!isBefore) {
          const condType = (
            await rl.question('  Add condition? (1=output, 2=input, N=none): ')
          ).trim().toLowerCase();
          if (condType === '1' || condType === 'output') {
            const whenOutput: Record<string, unknown> = {};
            this.logger.log('  Enter key=value pairs for tool output (empty key to finish):\n', { type: 'info' });
            while (true) {
              const key = (await rl.question('    Key: ')).trim();
              if (!key) break;
              const rawValue = (await rl.question('    Value: ')).trim();
              let value: unknown = rawValue;
              if (rawValue === 'true') value = true;
              else if (rawValue === 'false') value = false;
              else if (rawValue !== '' && !isNaN(Number(rawValue))) value = Number(rawValue);
              whenOutput[key] = value;
            }
            if (Object.keys(whenOutput).length > 0) {
              newHook.whenOutput = whenOutput;
            }
          } else if (condType === '2' || condType === 'input') {
            const whenInput: Record<string, unknown> = {};
            this.logger.log('  Enter key=value pairs for tool input (empty key to finish):\n', { type: 'info' });
            while (true) {
              const key = (await rl.question('    Key: ')).trim();
              if (!key) break;
              const rawValue = (await rl.question('    Value: ')).trim();
              let value: unknown = rawValue;
              if (rawValue === 'true') value = true;
              else if (rawValue === 'false') value = false;
              else if (rawValue !== '' && !isNaN(Number(rawValue))) value = Number(rawValue);
              whenInput[key] = value;
            }
            if (Object.keys(whenInput).length > 0) {
              newHook.whenInput = whenInput;
            }
          }
        }

        this.logger.log('  Apply to:\n', { type: 'info' });
        this.logger.log('    1. All phases\n', { type: 'info' });
        for (let i = 0; i < ablation.phases.length; i++) {
          this.logger.log(`    ${i + 2}. Phase: ${ablation.phases[i].name}\n`, { type: 'info' });
        }

        const scopeStr = (await rl.question('  Select scope: ')).trim();
        const scopeIdx = parseInt(scopeStr);

        if (scopeIdx === 1) {
          if (!ablation.hooks) ablation.hooks = [];
          ablation.hooks.push(newHook);
          this.ablationManager.update(ablationName, { hooks: ablation.hooks });
          this.logger.log('  ✓ Top-level hook added.\n', { type: 'success' });
        } else if (scopeIdx >= 2 && scopeIdx <= ablation.phases.length + 1) {
          const phase = ablation.phases[scopeIdx - 2];
          if (!phase.hooks) phase.hooks = [];
          phase.hooks.push(newHook);
          this.ablationManager.update(ablationName, { phases: ablation.phases });
          this.logger.log(`  ✓ Hook added to phase: ${phase.name}\n`, { type: 'success' });
        } else {
          this.logger.log('  ✗ Invalid selection.\n', { type: 'error' });
        }
      } else if (choice === '2') {
        // Remove post-tool hook
        if (allHooks.length === 0) {
          this.logger.log('  No hooks to remove.\n', { type: 'info' });
          continue;
        }

        const removeStr = (
          await rl.question('  Enter hook number to remove: ')
        ).trim();
        const removeIdx = parseInt(removeStr) - 1;

        if (removeIdx < 0 || removeIdx >= allHooks.length) {
          this.logger.log('  ✗ Invalid selection.\n', { type: 'error' });
          continue;
        }

        const target = allHooks[removeIdx];
        if (target.isTopLevel) {
          ablation.hooks?.splice(target.index, 1);
          if (ablation.hooks?.length === 0) ablation.hooks = undefined;
          this.ablationManager.update(ablationName, { hooks: ablation.hooks });
        } else {
          const phase = ablation.phases.find(p => p.name === target.phase);
          if (phase?.hooks) {
            phase.hooks.splice(target.index, 1);
            if (phase.hooks.length === 0) phase.hooks = undefined;
            this.ablationManager.update(ablationName, { phases: ablation.phases });
          }
        }
        this.logger.log('  ✓ Hook removed.\n', { type: 'success' });
      } else if (choice === '3') {
        // Edit lifecycle hooks (onStart/onEnd)
        await this.handleEditLifecycleHooks(ablationName, ablation);
      } else if (choice === '4' || choice.toLowerCase() === 'q') {
        return;
      } else {
        this.logger.log('  ✗ Invalid option.\n', { type: 'error' });
      }
    }
  }

  /**
   * Handle editing lifecycle hooks (onStart/onEnd) for phases
   */
  private async handleEditLifecycleHooks(ablationName: string, ablation: AblationDefinition): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    // Select phase
    this.logger.log('\n  Select phase:\n', { type: 'info' });
    for (let i = 0; i < ablation.phases.length; i++) {
      const phase = ablation.phases[i];
      const onStartCount = phase.onStart?.length ?? 0;
      const onEndCount = phase.onEnd?.length ?? 0;
      this.logger.log(`    ${i + 1}. ${phase.name} (${onStartCount} onStart, ${onEndCount} onEnd)\n`, { type: 'info' });
    }

    const phaseStr = (await rl.question('\n  Phase number: ')).trim();
    const phaseIdx = parseInt(phaseStr) - 1;

    if (phaseIdx < 0 || phaseIdx >= ablation.phases.length) {
      this.logger.log('  ✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const phase = ablation.phases[phaseIdx];

    while (true) {
      // Display current lifecycle hooks for this phase
      this.logger.log(`\n  Phase: ${phase.name}\n`, { type: 'info' });
      this.logger.log('  onStart commands:\n', { type: 'info' });
      if (!phase.onStart || phase.onStart.length === 0) {
        this.logger.log('    (none)\n', { type: 'info' });
      } else {
        for (let i = 0; i < phase.onStart.length; i++) {
          this.logger.log(`    ${i + 1}. ${phase.onStart[i]}\n`, { type: 'info' });
        }
      }
      this.logger.log('  onEnd commands:\n', { type: 'info' });
      if (!phase.onEnd || phase.onEnd.length === 0) {
        this.logger.log('    (none)\n', { type: 'info' });
      } else {
        for (let i = 0; i < phase.onEnd.length; i++) {
          this.logger.log(`    ${i + 1}. ${phase.onEnd[i]}\n`, { type: 'info' });
        }
      }

      this.logger.log('\n  Options:\n', { type: 'info' });
      this.logger.log('    1. Add onStart command\n', { type: 'info' });
      this.logger.log('    2. Remove onStart command\n', { type: 'info' });
      this.logger.log('    3. Add onEnd command\n', { type: 'info' });
      this.logger.log('    4. Remove onEnd command\n', { type: 'info' });
      this.logger.log('    5. Back\n', { type: 'info' });

      const choice = (await rl.question('\n  Select option: ')).trim();

      if (choice === '1') {
        // Add onStart command
        const cmd = (await rl.question('  onStart command: ')).trim();
        if (!cmd) continue;
        if (!phase.onStart) phase.onStart = [];
        phase.onStart.push(cmd);
        this.ablationManager.update(ablationName, { phases: ablation.phases });
        this.logger.log('  ✓ onStart command added.\n', { type: 'success' });
      } else if (choice === '2') {
        // Remove onStart command
        if (!phase.onStart || phase.onStart.length === 0) {
          this.logger.log('  No onStart commands to remove.\n', { type: 'info' });
          continue;
        }
        const removeStr = (await rl.question('  Enter command number to remove: ')).trim();
        const removeIdx = parseInt(removeStr) - 1;
        if (removeIdx < 0 || removeIdx >= phase.onStart.length) {
          this.logger.log('  ✗ Invalid selection.\n', { type: 'error' });
          continue;
        }
        phase.onStart.splice(removeIdx, 1);
        if (phase.onStart.length === 0) phase.onStart = undefined;
        this.ablationManager.update(ablationName, { phases: ablation.phases });
        this.logger.log('  ✓ onStart command removed.\n', { type: 'success' });
      } else if (choice === '3') {
        // Add onEnd command
        const cmd = (await rl.question('  onEnd command: ')).trim();
        if (!cmd) continue;
        if (!phase.onEnd) phase.onEnd = [];
        phase.onEnd.push(cmd);
        this.ablationManager.update(ablationName, { phases: ablation.phases });
        this.logger.log('  ✓ onEnd command added.\n', { type: 'success' });
      } else if (choice === '4') {
        // Remove onEnd command
        if (!phase.onEnd || phase.onEnd.length === 0) {
          this.logger.log('  No onEnd commands to remove.\n', { type: 'info' });
          continue;
        }
        const removeStr = (await rl.question('  Enter command number to remove: ')).trim();
        const removeIdx = parseInt(removeStr) - 1;
        if (removeIdx < 0 || removeIdx >= phase.onEnd.length) {
          this.logger.log('  ✗ Invalid selection.\n', { type: 'error' });
          continue;
        }
        phase.onEnd.splice(removeIdx, 1);
        if (phase.onEnd.length === 0) phase.onEnd = undefined;
        this.ablationManager.update(ablationName, { phases: ablation.phases });
        this.logger.log('  ✓ onEnd command removed.\n', { type: 'success' });
      } else if (choice === '5' || choice.toLowerCase() === 'q') {
        return;
      } else {
        this.logger.log('  ✗ Invalid option.\n', { type: 'error' });
      }
    }
  }

  /**
   * Handler to edit dynamic arguments for an ablation
   */
  private async handleEditArguments(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation) return;

    while (true) {
      const args = ablation.arguments ?? [];

      // Display current arguments
      this.logger.log('\n  Current arguments:\n', { type: 'info' });
      if (args.length === 0) {
        this.logger.log('    (none)\n', { type: 'info' });
      } else {
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          const required = arg.required !== false ? 'required' : 'optional';
          const defaultStr = arg.default ? `, default: ${arg.default}` : '';
          this.logger.log(
            `    ${i + 1}. {{${arg.name}}} (${arg.type}, ${required}${defaultStr})${arg.description ? ` - ${arg.description}` : ''}\n`,
            { type: 'info' },
          );
        }
      }

      // Show placeholders found in commands
      const placeholders = this.ablationManager.extractPlaceholders(ablation);
      if (placeholders.length > 0) {
        const undefinedPlaceholders = placeholders.filter(p => !args.some(a => a.name === p));
        if (undefinedPlaceholders.length > 0) {
          this.logger.log(`\n  Undefined placeholders in commands: ${undefinedPlaceholders.map(p => `{{${p}}}`).join(', ')}\n`, { type: 'warning' });
        }
      }

      this.logger.log('\n  Options:\n', { type: 'info' });
      this.logger.log('    1. Add argument\n', { type: 'info' });
      this.logger.log('    2. Edit argument\n', { type: 'info' });
      this.logger.log('    3. Remove argument\n', { type: 'info' });
      this.logger.log('    4. Auto-detect from commands\n', { type: 'info' });
      this.logger.log('    5. Done\n', { type: 'info' });

      const choice = (await rl.question('\n  Select option: ')).trim();

      if (choice === '1') {
        // Add argument
        const argName = (await rl.question('  Argument name: ')).trim();
        if (!argName) continue;

        if (args.some(a => a.name === argName)) {
          this.logger.log(`  ✗ Argument "${argName}" already exists.\n`, { type: 'error' });
          continue;
        }

        const argDescription = (await rl.question('  Description (optional): ')).trim();

        this.logger.log('  Type:\n', { type: 'info' });
        this.logger.log('    1. string - Text input\n', { type: 'info' });
        this.logger.log('    2. attachment - File picker\n', { type: 'info' });
        const typeChoice = (await rl.question('  Select type (1): ')).trim();
        const argType: AblationArgumentType = typeChoice === '2' ? 'attachment' : 'string';

        const requiredInput = (await rl.question('  Required? (Y/n): ')).trim().toLowerCase();
        const argRequired = requiredInput !== 'n' && requiredInput !== 'no';

        let argDefault: string | undefined;
        if (!argRequired) {
          argDefault = (await rl.question('  Default value (optional): ')).trim() || undefined;
        }

        const arg: AblationArgument = { name: argName, type: argType };
        if (argDescription) arg.description = argDescription;
        if (!argRequired) arg.required = false;
        if (argDefault) arg.default = argDefault;

        args.push(arg);
        ablation.arguments = args;
        this.ablationManager.update(ablationName, { arguments: args });
        this.logger.log(`  ✓ Argument {{${argName}}} added.\n`, { type: 'success' });
      } else if (choice === '2') {
        // Edit argument
        if (args.length === 0) {
          this.logger.log('  No arguments to edit.\n', { type: 'info' });
          continue;
        }

        const editStr = (await rl.question('  Argument number to edit: ')).trim();
        const editIdx = parseInt(editStr) - 1;
        if (editIdx < 0 || editIdx >= args.length) {
          this.logger.log('  ✗ Invalid selection.\n', { type: 'error' });
          continue;
        }

        const arg = args[editIdx];
        this.logger.log(`\n  Editing {{${arg.name}}}:\n`, { type: 'info' });

        const newDesc = (await rl.question(`  Description [${arg.description || ''}]: `)).trim();
        if (newDesc) arg.description = newDesc;

        this.logger.log('  Type:\n', { type: 'info' });
        this.logger.log(`    1. string${arg.type === 'string' ? ' (current)' : ''}\n`, { type: 'info' });
        this.logger.log(`    2. attachment${arg.type === 'attachment' ? ' (current)' : ''}\n`, { type: 'info' });
        const newType = (await rl.question('  Select type (enter to keep): ')).trim();
        if (newType === '1') arg.type = 'string';
        else if (newType === '2') arg.type = 'attachment';

        const currentRequired = arg.required !== false;
        const newRequired = (await rl.question(`  Required? (${currentRequired ? 'Y/n' : 'y/N'}): `)).trim().toLowerCase();
        if (newRequired === 'y' || newRequired === 'yes') arg.required = undefined; // default is true
        else if (newRequired === 'n' || newRequired === 'no') arg.required = false;

        if (arg.required === false) {
          const newDefault = (await rl.question(`  Default value [${arg.default || ''}]: `)).trim();
          if (newDefault) arg.default = newDefault;
        } else {
          arg.default = undefined;
        }

        ablation.arguments = args;
        this.ablationManager.update(ablationName, { arguments: args });
        this.logger.log(`  ✓ Argument {{${arg.name}}} updated.\n`, { type: 'success' });
      } else if (choice === '3') {
        // Remove argument
        if (args.length === 0) {
          this.logger.log('  No arguments to remove.\n', { type: 'info' });
          continue;
        }

        const removeStr = (await rl.question('  Argument number to remove: ')).trim();
        const removeIdx = parseInt(removeStr) - 1;
        if (removeIdx < 0 || removeIdx >= args.length) {
          this.logger.log('  ✗ Invalid selection.\n', { type: 'error' });
          continue;
        }

        const removed = args.splice(removeIdx, 1)[0];
        ablation.arguments = args.length > 0 ? args : undefined;
        this.ablationManager.update(ablationName, { arguments: ablation.arguments });
        this.logger.log(`  ✓ Argument {{${removed.name}}} removed.\n`, { type: 'success' });
      } else if (choice === '4') {
        // Auto-detect from commands
        const detected = this.ablationManager.extractPlaceholders(ablation);
        const existing = new Set(args.map(a => a.name));
        const newPlaceholders = detected.filter(p => !existing.has(p));

        if (newPlaceholders.length === 0) {
          this.logger.log('  No new placeholders found in commands.\n', { type: 'info' });
          continue;
        }

        this.logger.log(`  Found ${newPlaceholders.length} new placeholder(s): ${newPlaceholders.map(p => `{{${p}}}`).join(', ')}\n`, { type: 'info' });

        for (const name of newPlaceholders) {
          const addIt = (await rl.question(`  Add {{${name}}} as argument? (Y/n): `)).trim().toLowerCase();
          if (addIt === 'n' || addIt === 'no') continue;

          this.logger.log('  Type:\n', { type: 'info' });
          this.logger.log('    1. string - Text input\n', { type: 'info' });
          this.logger.log('    2. attachment - File picker\n', { type: 'info' });
          const typeChoice = (await rl.question('  Select type (1): ')).trim();
          const argType: AblationArgumentType = typeChoice === '2' ? 'attachment' : 'string';

          const arg: AblationArgument = { name, type: argType };
          args.push(arg);
          this.logger.log(`  ✓ Added {{${name}}} (${argType})\n`, { type: 'success' });
        }

        ablation.arguments = args.length > 0 ? args : undefined;
        this.ablationManager.update(ablationName, { arguments: ablation.arguments });
      } else if (choice === '5' || choice.toLowerCase() === 'q') {
        return;
      } else {
        this.logger.log('  ✗ Invalid option.\n', { type: 'error' });
      }
    }
  }

  /**
   * Parse selection string like "1,2,3" or "1-3" into array of indices
   */
  private parseSelection(selection: string, max: number): number[] {
    const parts = selection.split(',').map((p) => p.trim());
    const indices: number[] = [];

    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map((n) => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end && i <= max; i++) {
            if (i >= 1) indices.push(i);
          }
        }
      } else {
        const num = parseInt(part);
        if (!isNaN(num) && num >= 1 && num <= max) {
          indices.push(num);
        }
      }
    }

    return [...new Set(indices)].sort((a, b) => a - b);
  }

  /**
   * Collect prompt arguments during ablation creation
   * Returns the collected arguments as an object, or null if no arguments needed
   */
  private async collectPromptArgumentsForAblation(
    promptIndexStr: string,
  ): Promise<Record<string, string> | null> {
    const rl = this.callbacks.getReadline();
    if (!rl) return null;

    const promptIndex = parseInt(promptIndexStr) - 1;
    const prompts = this.client.listPrompts();

    if (promptIndex < 0 || promptIndex >= prompts.length) {
      return null;
    }

    const promptInfo = prompts[promptIndex];
    const prompt = promptInfo.prompt;

    // Check if prompt has arguments
    if (!prompt.arguments || prompt.arguments.length === 0) {
      return null;
    }

    this.logger.log(
      `    📝 Prompt "${prompt.name}" requires ${prompt.arguments.length} argument(s):\n`,
      { type: 'info' },
    );

    const args: Record<string, string> = {};

    for (const arg of prompt.arguments) {
      const required = arg.required !== false;
      const optionalText = required ? '' : ' (optional, Enter to skip)';

      this.logger.log(
        `      ${arg.name}${arg.description ? ` - ${arg.description}` : ''}${optionalText}:\n`,
        { type: 'info' },
      );

      const value = (await rl.question('      > ')).trim();

      if (required && !value) {
        this.logger.log(
          `      ⚠ Required argument "${arg.name}" is empty\n`,
          { type: 'warning' },
        );
      }

      if (value) {
        args[arg.name] = value;
      }
    }

    return Object.keys(args).length > 0 ? args : null;
  }

  /**
   * Check if a command needs an argument that should be provided in the next input
   * Returns true for directives like @insert-prompt:, @insert-attachment: that need an argument
   */
  private commandNeedsArgument(command: string): boolean {
    const trimmed = command.trim();

    // @ directives need content after the colon
    const directivesNeedingArgs = [
      '@insert-prompt:',
      '@insert-resource:',
      '@insert-attachment:',
    ];

    for (const prefix of directivesNeedingArgs) {
      if (trimmed.toLowerCase() === prefix.slice(0, -1)) {
        // Bare directive without colon-suffix (e.g., "@insert-prompt")
        return true;
      }
      if (trimmed.toLowerCase().startsWith(prefix) && trimmed.slice(prefix.length).trim() === '') {
        // Directive with colon but nothing after (e.g., "@insert-prompt:")
        return true;
      }
    }

    return false;
  }

  /**
   * Execute a command in preview mode during ablation creation
   * Shows the command output so user can see what inputs are expected
   */
  private async executeAblationPreviewCommand(command: string): Promise<void> {
    const lowerCommand = command.toLowerCase().trim();

    try {
      // Handle @ directive previews
      if (lowerCommand === '@insert-prompt' || lowerCommand === '@insert-prompt:') {
        await this.showPromptListForPreview();
      } else if (lowerCommand === '@insert-resource' || lowerCommand === '@insert-resource:') {
        const allResources = this.client.listResources();
        const resourceMgr = this.client.getResourceManager();
        const enabledResources = resourceMgr.filterResources(allResources);
        if (enabledResources.length === 0) {
          this.logger.log('  No enabled resources available.\n', { type: 'warning' });
        } else {
          this.logger.log('\n  Available Resources:\n', { type: 'info' });
          for (let i = 0; i < enabledResources.length; i++) {
            const r = enabledResources[i];
            this.logger.log(`    ${i + 1}. [${r.server}] ${r.resource.name} (${r.resource.uri})\n`, { type: 'info' });
          }
        }
      } else if (lowerCommand === '@insert-attachment' || lowerCommand === '@insert-attachment:') {
        await this.showAttachmentListForPreview();
      } else if (
        lowerCommand === '/prompts' ||
        lowerCommand === '/prompts-list'
      ) {
        await this.callbacks.getPromptCLI().displayPromptsList();
      } else if (lowerCommand === '/attachment-list') {
        await this.callbacks.getAttachmentCLI().handleAttachmentListCommand();
      } else if (
        lowerCommand === '/tools' ||
        lowerCommand === '/tools-list'
      ) {
        await this.callbacks.getToolCLI().displayToolsList();
      } else if (lowerCommand === '/help') {
        this.callbacks.displayHelp();
      } else if (
        lowerCommand === '/token-status' ||
        lowerCommand === '/tokens'
      ) {
        const usage = this.client.getTokenUsage();
        this.logger.log(
          `\n📊 Token Usage Status:\n` +
            `  Current: ${usage.current} tokens\n` +
            `  Limit: ${usage.limit} tokens\n` +
            `  Usage: ${usage.percentage}%\n`,
          { type: 'info' },
        );
      } else if (lowerCommand === '/settings') {
        await this.callbacks.displaySettings();
      } else {
        // For unrecognized commands, just note it will be executed during the run
        this.logger.log(
          `    ℹ️  Command will be executed during ablation run\n`,
          { type: 'info' },
        );
      }
    } catch (error) {
      this.logger.log(`    ⚠️  Preview error: ${error}\n`, { type: 'warning' });
    }
  }

  /**
   * Show prompt list for preview (without asking for selection)
   */
  private async showPromptListForPreview(): Promise<void> {
    const allPrompts = this.client.listPrompts();
    const promptManager = this.client.getPromptManager();
    const enabledPrompts = promptManager.filterPrompts(allPrompts);

    if (enabledPrompts.length === 0) {
      this.logger.log('\n    No enabled prompts available.\n', {
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

    this.logger.log('\n    📝 Available Prompts:\n', { type: 'info' });

    let promptIndex = 1;
    for (const [serverName, serverPrompts] of sortedServers) {
      this.logger.log(`\n    [${serverName}]:\n`, { type: 'info' });

      for (const promptData of serverPrompts) {
        const prompt = promptData.prompt;
        const argsInfo =
          prompt.arguments && prompt.arguments.length > 0
            ? ` (${prompt.arguments.length} arg${prompt.arguments.length > 1 ? 's' : ''})`
            : '';
        this.logger.log(
          `      ${promptIndex}. ${prompt.name}${argsInfo}\n`,
          { type: 'info' },
        );
        if (prompt.description) {
          this.logger.log(`         ${prompt.description}\n`, { type: 'info' });
        }
        promptIndex++;
      }
    }

    this.logger.log(
      `\n    Enter prompt number(s) as next input (e.g., "3" or "1,3,5")\n`,
      { type: 'info' },
    );
  }

  /**
   * Show attachment list for preview (without asking for selection)
   */
  private async showAttachmentListForPreview(): Promise<void> {
    const attachments = this.attachmentManager.listAttachments();

    if (attachments.length === 0) {
      this.logger.log('\n    📎 No attachments available.\n', {
        type: 'warning',
      });
      return;
    }

    this.logger.log('\n    📎 Available Attachments:\n', { type: 'info' });

    const fs = await import('fs');
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const stats = fs.statSync(att.path);
      const sizeKB = (stats.size / 1024).toFixed(2);
      this.logger.log(
        `      ${i + 1}. ${att.fileName} (${att.mediaType}, ${sizeKB} KB)\n`,
        { type: 'info' },
      );
    }

    this.logger.log(
      `\n    Enter attachment number(s) as next input (e.g., "4" or "1,3")\n`,
      { type: 'info' },
    );
  }

  /**
   * Discover models from provider API
   */
  private async discoverModelsFromAPI(
    providerName: string,
  ): Promise<ModelInfo[]> {
    try {
      this.logger.log(
        `\n    Fetching models from ${providerName} API...\n`,
        { type: 'info' },
      );

      const provider = createProvider(providerName);
      if (!provider) {
        this.logger.log(`    ✗ Unknown provider: ${providerName}\n`, {
          type: 'error',
        });
        return [];
      }

      const models = await provider.listAvailableModels();
      return models;
    } catch (error: any) {
      if (error.message && error.message.includes('does not provide')) {
        this.logger.log(
          `    ⚠️  ${providerName} does not support model discovery.\n`,
          { type: 'warning' },
        );
        this.logger.log(`    Use "Enter custom model name" instead.\n`, {
          type: 'info',
        });
      } else {
        this.logger.log(
          `    ✗ Failed to discover models: ${error.message}\n`,
          { type: 'error' },
        );
      }
      return [];
    }
  }

  // ==================== Interactive Tool Builder ====================

  /**
   * Get all tools from all servers with their full schemas.
   * Includes both enabled and disabled tools for ablation purposes.
   */
  private async getAllToolsWithSchemas(): Promise<ToolWithSchema[]> {
    const tools: ToolWithSchema[] = [];
    const servers = (this.client as any).servers as Map<string, any>;

    for (const [serverName, connection] of servers.entries()) {
      try {
        const toolsResult = await connection.client.request(
          { method: 'tools/list' },
          ListToolsResultSchema,
        );

        for (const tool of toolsResult.tools) {
          tools.push({
            name: tool.name,
            server: serverName,
            description: tool.description || '',
            input_schema: tool.inputSchema as any || { type: 'object', properties: {} },
          });
        }
      } catch (error) {
        // Skip servers that fail
        this.logger.log(`    ⚠ Could not fetch tools from ${serverName}\n`, { type: 'warning' });
      }
    }

    return tools;
  }

  /**
   * Interactive tool builder wizard.
   * Returns the generated @tool: command string or null if cancelled.
   */
  async buildToolCallInteractively(injectResult: boolean = true): Promise<string | null> {
    const rl = this.callbacks.getReadline();
    if (!rl) return null;

    // Get all tools
    const allTools = await this.getAllToolsWithSchemas();
    if (allTools.length === 0) {
      this.logger.log('\n    ✗ No tools available from any server.\n', { type: 'error' });
      return null;
    }

    // Group tools by server
    const toolsByServer = new Map<string, ToolWithSchema[]>();
    for (const tool of allTools) {
      if (!toolsByServer.has(tool.server)) {
        toolsByServer.set(tool.server, []);
      }
      toolsByServer.get(tool.server)!.push(tool);
    }

    // Step 1: Select server
    this.logger.log('\n    📦 Select server:\n', { type: 'info' });
    const serverList = Array.from(toolsByServer.keys()).sort();
    for (let i = 0; i < serverList.length; i++) {
      const serverName = serverList[i];
      const toolCount = toolsByServer.get(serverName)!.length;
      this.logger.log(`      ${i + 1}. ${serverName} (${toolCount} tools)\n`, { type: 'info' });
    }

    const serverInput = (await rl.question('\n    Select server (or "q" to cancel): ')).trim();
    if (serverInput.toLowerCase() === 'q') return null;

    const serverIndex = parseInt(serverInput) - 1;
    if (isNaN(serverIndex) || serverIndex < 0 || serverIndex >= serverList.length) {
      this.logger.log('    ✗ Invalid selection.\n', { type: 'error' });
      return null;
    }

    const selectedServer = serverList[serverIndex];
    const serverTools = toolsByServer.get(selectedServer)!;

    // Step 2: Select tool
    this.logger.log(`\n    🔧 Select tool from ${selectedServer}:\n`, { type: 'info' });
    for (let i = 0; i < serverTools.length; i++) {
      const tool = serverTools[i];
      const desc = tool.description ? ` - ${tool.description.substring(0, 50)}${tool.description.length > 50 ? '...' : ''}` : '';
      this.logger.log(`      ${i + 1}. ${tool.name}${desc}\n`, { type: 'info' });
    }

    const toolInput = (await rl.question('\n    Select tool (or "q" to cancel): ')).trim();
    if (toolInput.toLowerCase() === 'q') return null;

    const toolIndex = parseInt(toolInput) - 1;
    if (isNaN(toolIndex) || toolIndex < 0 || toolIndex >= serverTools.length) {
      this.logger.log('    ✗ Invalid selection.\n', { type: 'error' });
      return null;
    }

    const selectedTool = serverTools[toolIndex];

    // Step 3: Configure parameters
    const args = await this.configureToolParameters(selectedTool);
    if (args === null) return null;

    // Generate the command
    const prefix = injectResult ? '@tool' : '@tool-exec';
    const toolFullName = `${selectedServer}__${selectedTool.name}`;

    // Format args as Python-like syntax for readability
    const argsStr = this.formatArgsAsPython(args);
    const command = argsStr ? `${prefix}:${toolFullName}(${argsStr})` : `${prefix}:${toolFullName}()`;

    return command;
  }

  /**
   * Configure tool parameters interactively.
   * Returns the args object or null if cancelled.
   */
  private async configureToolParameters(tool: ToolWithSchema): Promise<Record<string, any> | null> {
    const rl = this.callbacks.getReadline();
    if (!rl) return null;

    const schema = tool.input_schema;
    const properties = schema.properties || {};
    const required = new Set(schema.required || []);
    const args: Record<string, any> = {};

    const propNames = Object.keys(properties);
    if (propNames.length === 0) {
      this.logger.log(`\n    📝 ${tool.name} has no parameters.\n`, { type: 'info' });
      return args;
    }

    this.logger.log(`\n    📝 Configure ${tool.name}:\n`, { type: 'info' });

    for (const propName of propNames) {
      const prop = properties[propName];
      const isRequired = required.has(propName);
      const hasDefault = 'default' in prop;
      const defaultValue = prop.default;

      // Build prompt
      let typeHint = this.getTypeHint(prop);
      let reqTag = isRequired ? 'required' : 'optional';
      let defaultTag = hasDefault ? `, default: ${JSON.stringify(defaultValue)}` : '';

      this.logger.log(`\n      ${propName} (${reqTag}, ${typeHint}${defaultTag}):\n`, { type: 'info' });

      // Check for anyOf with enum (e.g., control_gripper command: enum | integer)
      const anyOfEnum = prop.anyOf?.find((t: any) => t.enum && Array.isArray(t.enum));
      const anyOfOtherTypes = prop.anyOf?.filter((t: any) => !t.enum && t.type !== 'null').map((t: any) => t.type) || [];

      // Handle enum types specially (including anyOf with enum)
      if (prop.enum && Array.isArray(prop.enum)) {
        const enumValues = prop.enum;
        for (let i = 0; i < enumValues.length; i++) {
          const isDefault = hasDefault && enumValues[i] === defaultValue;
          const marker = isDefault ? ' ← default' : '';
          this.logger.log(`        ${i + 1}. ${enumValues[i]}${marker}\n`, { type: 'info' });
        }

        const enumInput = (await rl.question('      Select (Enter for default, "q" to cancel): ')).trim();
        if (enumInput.toLowerCase() === 'q') return null;

        if (enumInput === '') {
          if (hasDefault) {
            args[propName] = defaultValue;
            this.logger.log(`        → Using default: ${defaultValue}\n`, { type: 'info' });
          } else if (!isRequired) {
            // Skip optional field with no default
            this.logger.log(`        → Skipped\n`, { type: 'info' });
          } else {
            this.logger.log('        ✗ Required field, please select an option.\n', { type: 'error' });
            return null;
          }
        } else {
          const enumIndex = parseInt(enumInput) - 1;
          if (isNaN(enumIndex) || enumIndex < 0 || enumIndex >= enumValues.length) {
            this.logger.log('        ✗ Invalid selection.\n', { type: 'error' });
            return null;
          }
          args[propName] = enumValues[enumIndex];
        }
      } else if (anyOfEnum) {
        // Handle anyOf with enum (e.g., enum | integer)
        const enumValues = anyOfEnum.enum;
        for (let i = 0; i < enumValues.length; i++) {
          const isDefault = hasDefault && enumValues[i] === defaultValue;
          const marker = isDefault ? ' ← default' : '';
          this.logger.log(`        ${i + 1}. ${enumValues[i]}${marker}\n`, { type: 'info' });
        }
        if (anyOfOtherTypes.length > 0) {
          this.logger.log(`        Or enter a value (${anyOfOtherTypes.join(' | ')})\n`, { type: 'info' });
        }

        const input = (await rl.question('      Select or enter value (Enter for default, "q" to cancel): ')).trim();
        if (input.toLowerCase() === 'q') return null;

        if (input === '') {
          if (hasDefault) {
            args[propName] = defaultValue;
            this.logger.log(`        → Using default: ${JSON.stringify(defaultValue)}\n`, { type: 'info' });
          } else if (!isRequired) {
            this.logger.log(`        → Skipped\n`, { type: 'info' });
          } else {
            this.logger.log('        ✗ Required field, please select an option.\n', { type: 'error' });
            return null;
          }
        } else {
          // Check if input is a number selecting from enum
          const enumIndex = parseInt(input) - 1;
          if (!isNaN(enumIndex) && enumIndex >= 0 && enumIndex < enumValues.length) {
            args[propName] = enumValues[enumIndex];
          } else if (anyOfOtherTypes.includes('integer') && /^-?\d+$/.test(input)) {
            // Parse as integer if that's one of the allowed types
            args[propName] = parseInt(input);
          } else if (anyOfOtherTypes.includes('number') && /^-?\d+\.?\d*$/.test(input)) {
            // Parse as number if that's one of the allowed types
            args[propName] = parseFloat(input);
          } else {
            // Use as string value (might be one of the enum values typed directly)
            if (enumValues.includes(input)) {
              args[propName] = input;
            } else {
              args[propName] = input;
            }
          }
        }
      } else {
        // Regular input
        const value = (await rl.question('      > ')).trim();

        if (value === '' || value.toLowerCase() === 'q') {
          if (value.toLowerCase() === 'q') return null;

          if (hasDefault) {
            args[propName] = defaultValue;
            this.logger.log(`        → Using default: ${JSON.stringify(defaultValue)}\n`, { type: 'info' });
          } else if (!isRequired) {
            this.logger.log(`        → Skipped\n`, { type: 'info' });
          } else {
            this.logger.log('        ✗ Required field cannot be empty.\n', { type: 'error' });
            return null;
          }
        } else {
          // Parse value based on type
          args[propName] = this.parseValueByType(value, prop);
        }
      }
    }

    return args;
  }

  /**
   * Get a human-readable type hint from a JSON schema property.
   */
  private getTypeHint(prop: any): string {
    if (prop.enum) {
      return `enum(${prop.enum.join(', ')})`;
    }
    if (prop.anyOf) {
      const types = prop.anyOf
        .map((t: any) => {
          // Handle enum within anyOf
          if (t.enum) {
            return `enum(${t.enum.join(', ')})`;
          }
          return t.type || 'unknown';
        })
        .filter((t: string) => t !== 'null');
      return types.join(' | ') || 'any';
    }
    if (prop.type === 'array') {
      const itemType = prop.items?.type || 'any';
      return `array of ${itemType}`;
    }
    return prop.type || 'any';
  }

  /**
   * Parse a string value into the appropriate type based on schema.
   */
  private parseValueByType(value: string, prop: any): any {
    const type = prop.type || (prop.anyOf ? prop.anyOf.find((t: any) => t.type !== 'null')?.type : 'string');

    switch (type) {
      case 'integer':
        return parseInt(value);
      case 'number':
        return parseFloat(value);
      case 'boolean':
        return value.toLowerCase() === 'true' || value === '1';
      case 'array':
        // Try parsing as JSON, otherwise split by comma
        try {
          return JSON.parse(value);
        } catch {
          return value.split(',').map(v => v.trim());
        }
      case 'object':
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      default:
        return value;
    }
  }

  /**
   * Format args object as Python-like function arguments.
   */
  private formatArgsAsPython(args: Record<string, any>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        parts.push(`${key}='${value}'`);
      } else if (typeof value === 'boolean') {
        parts.push(`${key}=${value ? 'true' : 'false'}`);
      } else if (value === null) {
        parts.push(`${key}=null`);
      } else if (Array.isArray(value)) {
        parts.push(`${key}=${JSON.stringify(value)}`);
      } else {
        parts.push(`${key}=${value}`);
      }
    }
    return parts.join(', ');
  }
}
