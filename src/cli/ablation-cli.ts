/**
 * CLI operations for ablation study management.
 */

import readline from 'readline/promises';
import { cpSync, existsSync, mkdirSync } from 'fs';
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

import { parseDirectToolCall, matchesWhenInputCondition, matchesWhenOutputCondition } from '../utils/hook-utils.js';
import type { ParsedToolCall } from '../utils/hook-utils.js';
import { AttachmentManager, type AttachmentInfo } from '../managers/attachment-manager.js';
import { PreferencesManager } from '../managers/preferences-manager.js';
import { createProvider, PROVIDERS } from '../bin.js';
import type { ModelInfo, ModelProvider as IModelProvider } from '../model-provider.js';
import type { ModelProvider } from '../model-provider.js';
import type { ToolCLI } from './tool-cli.js';
import type { PromptCLI } from './prompt-cli.js';
import type { AttachmentCLI } from './attachment-cli.js';
import { isReasoningModel, getThinkingLevelsForProvider } from '../utils/model-capabilities.js';

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
   * Save chat history to the global chats directory and copy files into the run's phase directory.
   * Called on every exit path (success, failure, abort) so chat is always preserved.
   * In dry runs, the chat contains hook tool executions and phase events (no LLM messages).
   * When context persists across phases, the caller defers until all phases complete.
   */
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
    const chatHistoryManager = this.client.getChatHistoryManager();
    const chatMetadata = chatHistoryManager.endSession(endReason);

    if (chatMetadata) {
      const modelDir = this.ablationManager.getModelDirName(model);
      const phaseSanitized = sanitizeFolderName(phaseName);
      const runPrefix = hasMultipleIterations ? `run-${iteration}/` : '';
      const relativeChatPath = `${modelDir}/${runPrefix}${phaseSanitized}/chat.json`;
      const destJsonPath = join(phaseDir, 'chat.json');
      const destMdPath = join(phaseDir, 'chat.md');

      try {
        if (existsSync(chatMetadata.filePath)) cpSync(chatMetadata.filePath, destJsonPath);
        if (existsSync(chatMetadata.mdFilePath)) cpSync(chatMetadata.mdFilePath, destMdPath);
        result.chatFile = relativeChatPath;
      } catch (copyError) {
        this.logger.log(`  Warning: Failed to copy chat files to run directory: ${copyError}\n`, { type: 'warning' });
        result.chatFile = chatMetadata.filePath;
      }
    }
  }

  /**
   * Handle user input during an ablation pause (Ctrl+A).
   * Routes slash commands through the main CLI's handler; sends everything else to processQuery.
   * Returns 'resume' if the user entered empty input, 'handled' if a command was processed.
   */
  private async handlePauseInput(
    input: string,
    stopCondition: () => boolean,
  ): Promise<'resume' | 'abort' | 'handled'> {
    const trimmed = input.trim();
    if (!trimmed) return 'resume';

    // Route slash commands through the main CLI's full command handler
    if (trimmed.startsWith('/')) {
      const handled = await this.callbacks.routeSlashCommand(trimmed);
      if (!handled) {
        const cmd = trimmed.split(/\s+/)[0];
        this.logger.log(`  Unknown command: ${cmd}\n`, { type: 'warning' });
        this.logger.log('  Type /help for available commands.\n', { type: 'info' });
      }
      return 'handled';
    }

    // Regular text — send to the agent
    await this.client.processQuery(trimmed, false, undefined, stopCondition);
    return 'handled';
  }

  /**
   * Prompt the user during a dry-run pause (Ctrl+A after a @tool-exec).
   * Returns 'retry' to re-run the same command, 'resume' to continue, or 'cancel' to skip remaining.
   */
  private async promptDryRunPause(command: string): Promise<'retry' | 'resume' | 'cancel'> {
    this.logger.log(`\n  ⏸ Paused after: ${command}\n`, { type: 'warning' });
    this.logger.log('  [r]etry | [Enter] resume | [c]ancel\n', { type: 'info' });
    const input = await this.callbacks.collectInput('  Choice: ');
    if (input === null || input.trim().toLowerCase() === 'c') return 'cancel';
    if (input.trim().toLowerCase() === 'r') return 'retry';
    return 'resume';
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

          // Check if this is /add-prompt and the selected prompt has arguments
          if (pendingCommand.toLowerCase() === '/add-prompt') {
            const promptArgs = await this.collectPromptArgumentsForAblation(input);
            if (promptArgs) {
              fullCommand = `${fullCommand} ${JSON.stringify(promptArgs)}`;
            }
          }

          // Check if this is /attachment-insert - resolve index to filename for consistent matching
          if (pendingCommand.toLowerCase() === '/attachment-insert') {
            const attachmentIndex = parseInt(input) - 1;
            const attachments = this.attachmentManager.listAttachments();
            if (
              attachmentIndex >= 0 &&
              attachmentIndex < attachments.length
            ) {
              const attachment = attachments[attachmentIndex];
              fullCommand = `/attachment-insert ${attachment.fileName}`;
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

      phases.push({ name: phaseName, commands });

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
      await rl.question('\nSelect ablation to edit (or "q" to cancel): ')
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

      const choice = (await rl.question('\n  Select option: ')).trim();

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
   * Execute a command during ablation run
   * Handles slash commands, direct tool calls (@tool:), and regular queries to the model
   */
  private async executeAblationCommand(
    command: string,
    maxIterations: number,
    dryRun: boolean = false,
    ablation?: AblationDefinition,
    phaseName?: string,
  ): Promise<AblationCommandResult> {
    const trimmedCommand = command.trim();

    // Handle @complete-phase — signal that the current phase is done
    if (trimmedCommand === '@complete-phase' || trimmedCommand.startsWith('@complete-phase:')) {
      const label = trimmedCommand.includes(':') ? trimmedCommand.slice('@complete-phase:'.length) : phaseName || 'current';
      this.logger.log(`  ✓ @complete-phase: advancing past phase "${label}"\n`, { type: 'info' });
      return { phaseComplete: true };
    }

    // Handle @abort — signal to skip remaining phases for the current model
    if (trimmedCommand === '@abort') {
      this.logger.log(`  ⚠️ @abort: skipping remaining phases for current model\n`, { type: 'warning' });
      return { abortRun: true };
    }

    // Handle @wait:<seconds> — pause execution
    const waitMatch = trimmedCommand.match(/^@wait:(\d+(?:\.\d+)?)$/);
    if (waitMatch) {
      const waitSeconds = parseFloat(waitMatch[1]);
      this.logger.log(`    Waiting ${waitSeconds}s...\n`, { type: 'info' });
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      this.logger.log(`    Done waiting.\n`, { type: 'info' });
      return {};
    }

    // Handle direct tool calls (@tool: or @tool-exec:)
    if (trimmedCommand.startsWith('@tool:') || trimmedCommand.startsWith('@tool-exec:')) {
      const parsed = parseDirectToolCall(trimmedCommand);
      if (!parsed) {
        throw new Error(`Invalid tool call syntax: ${trimmedCommand}`);
      }

      this.logger.log(`    Executing tool: ${parsed.toolName}\n`, { type: 'info' });

      try {
        const result = await this.client.executeMCPTool(
          parsed.toolName,
          parsed.args as Record<string, unknown>,
        );

        // Log the result
        if (result.displayText) {
          // Truncate long results for display
          const displayText = result.displayText.length > 500
            ? result.displayText.substring(0, 500) + '...'
            : result.displayText;
          this.logger.log(`    Tool result: ${displayText}\n`, { type: 'info' });
        }

        // If injectResult is true, inject the tool result into conversation context
        if (parsed.injectResult && result.contentBlocks && result.contentBlocks.length > 0) {
          // Create a synthetic tool use/result pair to inject into conversation
          await this.client.injectToolResult(parsed.toolName, parsed.args, result);
          this.logger.log(`    Result injected into conversation context\n`, { type: 'info' });
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
        this.logger.log(`    Tool execution failed: ${error.message}\n`, { type: 'error' });
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

      this.logger.log(`    Executing shell: ${shellCommand}\n`, { type: 'info' });

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
          this.logger.log(`    Shell output: ${truncated}\n`, { type: 'info' });
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

        this.logger.log(`    Shell command failed: ${errorMessage}\n`, { type: 'error' });
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

    // Handle slash commands
    if (trimmedCommand.startsWith('/')) {
      // Parse the command
      const parts = trimmedCommand.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      switch (cmd) {
        case '/add-prompt': {
          // /add-prompt <index> [{"arg":"value"}]
          if (args.length === 0) {
            throw new Error('Usage: /add-prompt <index>');
          }
          const promptIndex = parseInt(args[0]) - 1;
          const prompts = this.client.listPrompts();
          if (promptIndex < 0 || promptIndex >= prompts.length) {
            throw new Error(`Invalid prompt index: ${args[0]}`);
          }
          const promptInfo = prompts[promptIndex];

          // Check for JSON arguments (remaining args joined)
          let promptArgs: Record<string, string> | undefined;
          if (args.length > 1) {
            const jsonStr = args.slice(1).join(' ');
            try {
              promptArgs = JSON.parse(jsonStr);
            } catch {
              // Not JSON, ignore
            }
          }

          const promptResult = await this.client.getPrompt(
            promptInfo.server,
            promptInfo.prompt.name,
            promptArgs,
          );
          if (promptResult?.messages) {
            // For agent-driven ablation phases: load phase hooks so @complete-phase works
            const hookMgr = this.client.getHookManager();
            let ablHooksLoaded = false;
            if (ablation && phaseName) {
              const phaseHooks = this.ablationManager.getHooksForPhase(ablation, phaseName);
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
              const promptAttachments = this.callbacks.getPendingAttachments();
              let attachmentsConsumed = false;

              for (const msg of promptResult.messages) {
                if (msg.content.type === 'text') {
                  const cancellationCheck = () => hookMgr.isPhaseCompleteRequested() || hookMgr.hasPendingInjection() || this.callbacks.isAbortRequested() || this.callbacks.isInterruptRequested();

                  // Resume loop: after pause+resume, re-invoke processQuery so the agent can continue
                  let isFirstAttempt = true;
                  let continueAfterPause = false;

                  do {
                    const queryText = isFirstAttempt ? msg.content.text : 'Continue from where you left off.';
                    const attachments = (isFirstAttempt && !attachmentsConsumed && promptAttachments.length > 0)
                      ? promptAttachments : undefined;

                    // Log user prompt to chat history (ablation path doesn't go through cli-client)
                    this.client.getChatHistoryManager().addUserMessage(queryText,
                      attachments?.map(a => ({ fileName: a.fileName, ext: a.ext, mediaType: a.mediaType })));

                    await this.client.processQuery(queryText, false, attachments, cancellationCheck);

                    if (isFirstAttempt && !attachmentsConsumed && promptAttachments.length > 0) {
                      attachmentsConsumed = true;
                      this.callbacks.setPendingAttachments([]);
                    }
                    isFirstAttempt = false;
                    continueAfterPause = false;

                    // Handle soft interrupt (Ctrl+A): let user send messages or run commands
                    // Loop stays active until explicit resume (Enter) or abort (Ctrl+C)
                    // Skip if phase is already complete — @complete-phase takes priority over interrupt
                    if (this.callbacks.isInterruptRequested() && !this.callbacks.isAbortRequested()
                        && !hookMgr.isPhaseCompleteRequested()) {
                      this.callbacks.resetInterrupt();
                      this.callbacks.stopKeyboardMonitor();

                      if (this.callbacks.getReadline()) {
                        this.logger.log('\n  ⏸ Agent paused. Type a message, /command, or press Enter to resume. (/help for commands)\n', { type: 'warning' });

                        let paused = true;
                        while (paused && !this.callbacks.isAbortRequested()
                            && !hookMgr.isPhaseCompleteRequested()) {
                          // Re-fetch readline each iteration — stopKeyboardMonitor() recreates it
                          const rl = this.callbacks.getReadline()!;
                          const userInput = (await rl.question('  You: ')).trim();

                          const stopCond = () => hookMgr.isPhaseCompleteRequested() || this.callbacks.isAbortRequested() || this.callbacks.isInterruptRequested();

                          // Re-enable keyboard monitor during processQuery so Ctrl+A works,
                          // then stop it again so readline can prompt the next input.
                          this.callbacks.startKeyboardMonitor();
                          const result = await this.handlePauseInput(userInput, stopCond);
                          this.callbacks.resetInterrupt();
                          this.callbacks.stopKeyboardMonitor();

                          if (result === 'resume') {
                            continueAfterPause = true;
                            paused = false;
                          }
                          // 'handled' → stay in pause loop, prompt again
                        }
                      }

                      this.callbacks.startKeyboardMonitor();
                    }
                  } while (continueAfterPause
                    && !hookMgr.isPhaseCompleteRequested()
                    && !this.callbacks.isAbortRequested());

                  // Stop processing further messages if phase complete or aborted
                  if (hookMgr.isPhaseCompleteRequested() || this.callbacks.isAbortRequested()) break;
                }
              }
            } finally {
              if (ablHooksLoaded) hookMgr.clearAblationHooks();
            }

            if (hookMgr.isPhaseCompleteRequested()) {
              hookMgr.resetPhaseComplete();
              return { phaseComplete: true };
            }

            // Agent stopped responding during ablation without @complete-phase or @abort
            // — treat as implicit phase completion so the run continues to the next phase/model
            if (ablation && phaseName && !this.callbacks.isAbortRequested()) {
              this.logger.log(`  ℹ Phase "${phaseName}": agent stopped without @complete-phase — treating as complete\n`, { type: 'info' });
              this.client.getChatHistoryManager().addPhaseEvent('phase-abort', phaseName, { after: 'agent-stopped' });
              return { phaseComplete: true };
            }
          }
          break;
        }
        case '/add-attachment': {
          // /add-attachment <index|filename>
          if (args.length === 0) {
            throw new Error('Usage: /add-attachment <index|filename>');
          }
          const attachments = this.attachmentManager.listAttachments();
          let attachment;

          // Check if arg is a number (index) or filename
          const argValue = args.join(' '); // Handle filenames with spaces
          const attachmentIndex = parseInt(args[0]);

          if (!isNaN(attachmentIndex) && String(attachmentIndex) === args[0]) {
            // It's an index (1-based)
            const idx = attachmentIndex - 1;
            if (idx < 0 || idx >= attachments.length) {
              throw new Error(`Invalid attachment index: ${args[0]}`);
            }
            attachment = attachments[idx];
          } else {
            // It's a filename - find by name
            attachment = attachments.find((a) => a.fileName === argValue);
            if (!attachment) {
              throw new Error(`Attachment not found: ${argValue}`);
            }
          }

          const pendingAttachments = this.callbacks.getPendingAttachments();
          pendingAttachments.push(attachment);
          this.callbacks.setPendingAttachments(pendingAttachments);
          break;
        }
        case '/attachment-insert': {
          // /attachment-insert <index|filename>
          if (args.length === 0) {
            throw new Error('Usage: /attachment-insert <index|filename>');
          }
          const attachments = this.attachmentManager.listAttachments();
          let attachment;

          // Check if arg is a number (index) or filename
          const argValue = args.join(' '); // Handle filenames with spaces
          const attachmentIndex = parseInt(args[0]);

          if (!isNaN(attachmentIndex) && String(attachmentIndex) === args[0]) {
            // It's an index (1-based)
            const idx = attachmentIndex - 1;
            if (idx < 0 || idx >= attachments.length) {
              throw new Error(`Invalid attachment index: ${args[0]}`);
            }
            attachment = attachments[idx];
          } else {
            // It's a filename - find by name
            attachment = attachments.find((a) => a.fileName === argValue);
            if (!attachment) {
              throw new Error(`Attachment not found: ${argValue}`);
            }
          }

          const pendingAttachments = this.callbacks.getPendingAttachments();
          pendingAttachments.push(attachment);
          this.callbacks.setPendingAttachments(pendingAttachments);
          break;
        }
        case '/clear-attachments':
          this.callbacks.setPendingAttachments([]);
          break;
        default:
          // Unknown slash command - log warning but continue
          this.logger.log(`  Warning: Unknown command "${cmd}", skipping\n`, {
            type: 'warning',
          });
      }
    } else {
      // Regular query - send to model
      if (dryRun) {
        this.logger.log(`    ⚠ Skipping query in dry run (no model): ${trimmedCommand}\n`, { type: 'warning' });
        return {};
      }

      // For agent-driven ablation phases: load phase hooks into HookManager
      // so they fire during processQuery's tool calls
      const hookManager = this.client.getHookManager();
      let ablationHooksLoaded = false;
      if (ablation && phaseName) {
        const phaseHooks = this.ablationManager.getHooksForPhase(ablation, phaseName);
        if (phaseHooks.length > 0) {
          hookManager.loadAblationHooks(phaseHooks);
          hookManager.setCurrentPhaseName(phaseName);
          hookManager.resetPhaseComplete();
          hookManager.resetAbortRun();
          ablationHooksLoaded = true;
        }
      }

      const pendingAttachments = this.callbacks.getPendingAttachments();
      try {
        // Resume loop: after pause+resume, re-invoke processQuery so the agent can continue
        let isFirstAttempt = true;
        let continueAfterPause = false;
        const cancellationCheck = () => hookManager.isPhaseCompleteRequested() || hookManager.isAbortRunRequested() || hookManager.hasPendingInjection() || this.callbacks.isAbortRequested() || this.callbacks.isInterruptRequested();

        do {
          const query = isFirstAttempt ? trimmedCommand : 'Continue from where you left off.';
          const atts = isFirstAttempt
            ? (pendingAttachments.length > 0 ? pendingAttachments : undefined)
            : undefined;

          // Log user prompt to chat history (ablation path doesn't go through cli-client)
          this.client.getChatHistoryManager().addUserMessage(query,
            atts?.map(a => ({ fileName: a.fileName, ext: a.ext, mediaType: a.mediaType })));

          await this.client.processQuery(query, false, atts, cancellationCheck);
          isFirstAttempt = false;
          continueAfterPause = false;

          // Handle soft interrupt (Ctrl+A): let user send messages or run commands
          // Stay in raw mode to prevent Ctrl+C from sending OS SIGINT to child processes
          // Loop stays active until explicit resume (Enter) or abort (Ctrl+C)
          // Skip if phase/abort already signaled — those take priority over interrupt
          if (this.callbacks.isInterruptRequested() && !this.callbacks.isAbortRequested()
              && !hookManager.isPhaseCompleteRequested() && !hookManager.isAbortRunRequested()) {
            this.callbacks.resetInterrupt();
            this.logger.log('\n  ⏸ Agent paused. Type a message, /command, or press Enter to resume. (/help for commands)\n', { type: 'warning' });

            let paused = true;
            while (paused && !this.callbacks.isAbortRequested()
                && !hookManager.isPhaseCompleteRequested() && !hookManager.isAbortRunRequested()) {
              const userInput = await this.callbacks.collectInput('  You: ');

              // null means Ctrl+C was pressed — treat as abort
              if (userInput === null) {
                paused = false;
                break;
              }

              const stopCond = () => hookManager.isPhaseCompleteRequested() || hookManager.isAbortRunRequested() || this.callbacks.isAbortRequested() || this.callbacks.isInterruptRequested();
              const result = await this.handlePauseInput(userInput, stopCond);
              // Reset interrupt flag so the next iteration's processQuery doesn't exit immediately
              this.callbacks.resetInterrupt();
              if (result === 'resume') {
                continueAfterPause = true;
                paused = false;
              }
              // 'handled' → stay in pause loop, prompt again
            }
          }
        } while (continueAfterPause
          && !hookManager.isPhaseCompleteRequested()
          && !hookManager.isAbortRunRequested()
          && !this.callbacks.isAbortRequested());
      } finally {
        // Cleanup: remove temporary ablation hooks
        if (ablationHooksLoaded) {
          hookManager.clearAblationHooks();
        }
      }
      // Clear attachments after use
      this.callbacks.setPendingAttachments([]);

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

      // Agent stopped responding during ablation without @complete-phase or @abort
      // — treat as implicit phase completion so the run continues to the next phase/model
      if (ablation && phaseName && !this.callbacks.isAbortRequested()) {
        this.logger.log(`  ℹ Phase "${phaseName}": agent stopped without @complete-phase — treating as complete\n`, { type: 'info' });
        this.client.getChatHistoryManager().addPhaseEvent('phase-abort', phaseName, { after: 'agent-stopped' });
        return { phaseComplete: true };
      }
    }

    return {};
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
      const runsLabel = iterations > 1 ? `, ${iterations} runs` : '';
      this.logger.log(`  ${i + 1}. ${ablation.name} (${phaseCount} phase${phaseCount !== 1 ? 's' : ''}${runsLabel})\n`, {
        type: 'info',
      });
    }

    let selectedAblations: AblationDefinition[] = [];
    while (selectedAblations.length === 0) {
      const selection = (
        await rl.question('\nSelect ablation(s) to run (e.g. 1, 1,3, 1-3, all, or "q" to cancel): ')
      ).trim();

      if (selection.toLowerCase() === 'q') {
        this.logger.log('\nCancelled.\n', { type: 'info' });
        return;
      }

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
        const runsLabel = iterations > 1 ? `, ${iterations} runs` : '';
        this.logger.log(`    - ${a.name} (${phaseCount} phase${phaseCount !== 1 ? 's' : ''}${runsLabel})\n`, { type: 'info' });
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

      const iterationsMultiplier = (ablation.runs ?? 1) > 1 ? ` × ${ablation.runs} iterations` : '';
      if (ablation.dryRun) {
        this.logger.log(
          `\n  Dry Run: ${ablation.phases.length} phases${iterationsMultiplier} = ${totalRuns} run${totalRuns > 1 ? 's' : ''} (no model)\n`,
          { type: 'info' },
        );
      } else {
        this.logger.log(
          `\n  Matrix: ${ablation.phases.length} phase${ablation.phases.length > 1 ? 's' : ''} × ${ablation.models.length} model${ablation.models.length > 1 ? 's' : ''}${iterationsMultiplier} = ${totalRuns} run${totalRuns > 1 ? 's' : ''}\n`,
          { type: 'info' },
        );
      }

      if (ablation.settings.mcpConfigPath) {
        this.logger.log(`  MCP Config: ${ablation.settings.mcpConfigPath}\n`, { type: 'info' });
      }
      if (ablation.settings.clearContextBetweenPhases === false) {
        this.logger.log(`  Context: Persistent across phases (not cleared between phases)\n`, { type: 'info' });
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

    // Save original provider/model, thinking, and chat state to restore after all ablations
    const originalProviderName = this.client.getProviderName();
    const originalModel = this.client.getModel();
    const originalThinkingEnabled = this.preferencesManager.getThinkingEnabled();
    const originalThinkingLevel = this.preferencesManager.getThinkingLevel();
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
    this.preferencesManager.setThinkingEnabled(originalThinkingEnabled);
    this.preferencesManager.setThinkingLevel(originalThinkingLevel);
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
          `  │ ${phase.name.padEnd(19).substring(0, 19)} │ ${'pending'.padEnd(12)}│\n`,
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
  private async runSingleAblation(ablation: AblationDefinition, resolvedArguments?: Record<string, string>): Promise<boolean> {
    const totalRuns = this.ablationManager.getTotalRuns(ablation);
    const totalScenarios = this.ablationManager.getTotalScenarios(ablation);

    // All servers (including disabled) are connected at startup.
    // Only refresh if this ablation uses a custom MCP config path.
    const defaultMcpConfigPath = this.ablationManager.getDefaultMcpConfigPath();
    const effectiveConfigPath = (ablation.settings.mcpConfigPath && ablation.settings.mcpConfigPath !== defaultMcpConfigPath)
      ? ablation.settings.mcpConfigPath
      : defaultMcpConfigPath;

    if (effectiveConfigPath !== defaultMcpConfigPath) {
      if (this.lastAblationMcpConfigPath !== effectiveConfigPath) {
        const resolvedPath = this.ablationManager.resolveMcpConfigPath(ablation);
        if (resolvedPath) {
          const validation = this.ablationManager.validateMcpConfigPath(ablation.settings.mcpConfigPath!);
          if (validation.valid) {
            this.logger.log(`  Loading custom MCP config: ${ablation.settings.mcpConfigPath}\n`, { type: 'info' });
            if (!this.client.reloadConfigFromPath(resolvedPath)) {
              this.logger.log(`  ⚠ Failed to load custom MCP config, using default\n`, { type: 'warning' });
            }
          } else {
            this.logger.log(`  ⚠ Invalid MCP config: ${validation.error}\n`, { type: 'warning' });
          }
        }

        this.logger.log(`  Connecting servers for custom config...\n`, { type: 'info' });
        await this.client.refreshServers();
        this.lastAblationMcpConfigPath = effectiveConfigPath;
        this.logger.log(`  ✓ Servers connected\n`, { type: 'success' });
      } else {
        this.logger.log(`  Servers already connected for this config, skipping refresh\n`, { type: 'info' });
      }
    }

    // Create run directory
    const { runDir, timestamp } = this.ablationManager.createRunDirectory(
      ablation.name,
    );

    // Save a frozen copy of the ablation definition for provenance
    this.ablationManager.saveDefinitionSnapshot(runDir, ablation);

    // Save a snapshot of all available tools and their descriptions (constant for the whole ablation)
    this.ablationManager.saveToolsSnapshot(runDir, this.client.getServersInfo());

    // Save a snapshot of all available prompts (only if any phase uses /add-prompt)
    const usesPrompts = ablation.phases.some(p =>
      p.commands.some(c => c.trim().toLowerCase().startsWith('/add-prompt')),
    );
    if (usesPrompts) {
      const allPrompts = this.client.listPrompts().map(p => ({
        server: p.server,
        prompt: {
          name: p.prompt.name,
          description: p.prompt.description,
          arguments: p.prompt.arguments,
        },
      }));
      this.ablationManager.savePromptsSnapshot(runDir, allPrompts);
    }

    // Copy attachments to run directory (same for all runs)
    // Pass resolved arguments so dynamically-named attachments are detected
    this.ablationManager.copyAttachmentsToRun(runDir, ablation, resolvedArguments);

    // Stash current outputs so each model run starts with a clean folder
    this.logger.log('  Stashing outputs folder...\n', { type: 'info' });
    this.ablationManager.stashOutputs(runDir);

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
    this.callbacks.setAbortMode(true);

    // Reset abort/interrupt state and start keyboard monitor for Ctrl+A support
    this.callbacks.resetAbort();
    this.callbacks.resetInterrupt();
    this.callbacks.startKeyboardMonitor();

    // Suspend client-side hooks during ablation runs (ablation manages its own hooks)
    const hookManager = this.client.getHookManager();
    hookManager.suspend();

    try {
    // Determine models to iterate over
    // In dry run mode, use a single placeholder model (no model switching needed)
    const dryRunModel: AblationModel = { provider: 'none', model: 'dry-run' };
    const modelsToRun = ablation.dryRun ? [dryRunModel] : ablation.models;
    const iterations = ablation.runs ?? 1;
    const hasMultipleIterations = iterations > 1;
    // runIteration passed to directory helpers: undefined when iterations=1 (preserves old paths)
    const getRunIter = (iter: number) => hasMultipleIterations ? iter : undefined;

    // Execute: iteration > model > phase
    for (let iteration = 1; iteration <= iterations; iteration++) {
      if (shouldBreak) break;

      if (hasMultipleIterations) {
        const iterLine = `ITERATION ${iteration}/${iterations}`;
        const iterWidth = Math.max(iterLine.length, 59);
        this.logger.log(
          `\n╔══${'═'.repeat(iterWidth)}══╗\n`,
          { type: 'info' },
        );
        this.logger.log(
          `║  ${iterLine.padEnd(iterWidth)}  ║\n`,
          { type: 'info' },
        );
        this.logger.log(
          `╚══${'═'.repeat(iterWidth)}══╝\n`,
          { type: 'info' },
        );
      }

      for (const model of modelsToRun) {
        if (shouldBreak) break;

        // Check for abort (Ctrl+A or Ctrl+C)
        if (this.callbacks.isAbortRequested()) {
          this.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
          shouldBreak = true;
          break;
        }

        const modelKey = `${model.provider}/${model.model}`;

        // Clear outputs per model (each model starts with clean outputs)
        this.ablationManager.clearOutputs();

        // Create provider instance and switch to this model once (skip in dry run)
        if (!ablation.dryRun) {
          const provider = this.createProviderInstance(model.provider);
          await this.client.switchProviderAndModel(provider, model.model);

          // Apply per-model thinking config (off by default unless specified)
          if (model.thinking) {
            this.preferencesManager.setThinkingEnabled(true);
            this.preferencesManager.setThinkingLevel(model.thinking);
          } else {
            this.preferencesManager.setThinkingEnabled(false);
            this.preferencesManager.setThinkingLevel(undefined);
          }
        }

        let modelAborted = false;
        runNumber++;

        // Display run-level header (one run = one model through all phases)
        const modelShortName = ablation.dryRun ? 'dry-run' : this.ablationManager.getModelShortName(model);
        const iterationSuffix = hasMultipleIterations ? ` (iteration ${iteration}/${iterations})` : '';

        if (!ablation.dryRun) {
          this.logger.log(
            `\n┌──────────────────────────────────────────────────────────────┐\n`,
            { type: 'info' },
          );
          this.logger.log(
            `│  RUN ${runNumber}/${totalRuns}: ${modelShortName}${iterationSuffix}\n`,
            { type: 'info' },
          );
          const thinkingStatus = model.thinking ? ` │ Thinking: ${model.thinking}` : '';
          this.logger.log(
            `│  Provider: ${model.provider} │ Model: ${model.model}${thinkingStatus}\n`,
            { type: 'info' },
          );
          this.logger.log(
            `└──────────────────────────────────────────────────────────────┘\n`,
            { type: 'info' },
          );
        }

        for (const phase of ablation.phases) {
          if (shouldBreak || modelAborted) break;

          // Check for abort (Ctrl+A or Ctrl+C)
          if (this.callbacks.isAbortRequested()) {
            this.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
            shouldBreak = true;
            break;
          }

          // Conditional context clearing between phases (not for first phase)
          const isFirstPhase = phase === ablation.phases[0];
          if (!isFirstPhase && !ablation.dryRun) {
            if (ablation.settings.clearContextBetweenPhases !== false) {
              this.client.clearContext();
            }
          }

          const phaseDir = this.ablationManager.createPhaseDirectory(
            runDir,
            model,
            phase.name,
            getRunIter(iteration),
          );

          scenarioNumber++;
          const phaseIndex = ablation.phases.indexOf(phase) + 1;

          this.logger.log(
            `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
            { type: 'info' },
          );
          if (ablation.dryRun) {
            this.logger.log(
              `  SCENARIO ${scenarioNumber}/${totalScenarios}: ${phase.name} (dry run)${iterationSuffix}\n`,
              { type: 'info' },
            );
          } else {
            this.logger.log(
              `  PHASE ${phaseIndex}/${ablation.phases.length}: ${phase.name}\n`,
              { type: 'info' },
            );
          }
          this.logger.log(
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

          const startTime = Date.now();

          // Substitute argument placeholders in all command arrays for this phase
          const sub = (cmds: string[]) =>
            resolvedArguments ? this.ablationManager.substituteArguments(cmds, resolvedArguments) : cmds;
          const phaseCommands = sub(phase.commands);
          const phaseOnStart = phase.onStart ? sub(phase.onStart) : undefined;
          const phaseOnEnd = phase.onEnd ? sub(phase.onEnd) : undefined;

          try {
            // Log phase-start event to chat history
            this.client.getChatHistoryManager().addPhaseEvent('phase-start', phase.name);

            // Execute onStart lifecycle hooks
            let aborted = false;
            let abortCurrentModel = false;
            if (phaseOnStart && phaseOnStart.length > 0) {
              this.logger.log(`  ⤷ Phase onStart hooks...\n`, { type: 'info' });
              for (const startCmd of phaseOnStart) {
                if (this.callbacks.isAbortRequested()) {
                  this.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
                  aborted = true;
                  shouldBreak = true;
                  break;
                }

                this.logger.log(`    ↳ ${startCmd}\n`, { type: 'info' });
                const hookStartTime = Date.now();
                const hookResult = await this.executeAblationCommand(
                  startCmd,
                  ablation.settings.maxIterations,
                  ablation.dryRun || false,
                  ablation,
                  phase.name,
                );

                // Log onStart tool execution to chat history
                if (hookResult.toolExecResult) {
                  const chatHist = this.client.getChatHistoryManager();
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
            // This ensures /attachment-insert and /add-attachment are processed
            // before /add-prompt or raw queries, regardless of YAML ordering.
            const stagingCommands = new Set(['/attachment-insert', '/add-attachment', '/clear-attachments']);
            const stagedIndices = new Set<number>();
            // Count total staging commands first for numbering
            const totalStaging = phaseCommands.filter((cmd) => {
              const t = cmd.trim();
              const s = t.startsWith('/') ? t.split(/\s+/)[0].toLowerCase() : null;
              return s && stagingCommands.has(s);
            }).length;
            let stageIdx = 0;
            for (let i = 0; i < phaseCommands.length; i++) {
              const trimmed = phaseCommands[i].trim();
              const slashCmd = trimmed.startsWith('/') ? trimmed.split(/\s+/)[0].toLowerCase() : null;
              if (slashCmd && stagingCommands.has(slashCmd)) {
                stageIdx++;
                this.logger.log(
                  `  [pre-stage ${stageIdx}/${totalStaging}] Executing: ${phaseCommands[i]}\n`,
                  { type: 'info' },
                );
                await this.executeAblationCommand(
                  phaseCommands[i],
                  ablation.settings.maxIterations,
                  ablation.dryRun || false,
                  ablation,
                  phase.name,
                );
                stagedIndices.add(i);
              }
            }

            // Execute remaining (non-staged) commands for this phase
            const remainingCount = phaseCommands.length - stagedIndices.size;
            let remainingIdx = 0;
            let phaseCompletedViaSignal = false;
            for (let i = 0; i < phaseCommands.length && !aborted; i++) {
              if (stagedIndices.has(i)) continue; // Already pre-staged
              remainingIdx++;

              // Check for abort before each command
              if (this.callbacks.isAbortRequested()) {
                this.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
                aborted = true;
                shouldBreak = true;
                break;
              }

              const command = phaseCommands[i];
              this.logger.log(
                `  [${remainingIdx}/${remainingCount}] Executing: ${command}\n`,
                { type: 'info' },
              );

              // Handle @wait:<seconds> command
              const waitMatch = command.trim().match(/^@wait:(\d+(?:\.\d+)?)$/);
              if (waitMatch) {
                const waitSeconds = parseFloat(waitMatch[1]);
                this.logger.log(`    Waiting ${waitSeconds}s...\n`, { type: 'info' });
                await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
                this.logger.log(`    Done waiting.\n`, { type: 'info' });
                continue;
              }

              // Execute before-hooks (only for @tool-exec/@tool commands)
              const trimmedCmd = command.trim();
              if (trimmedCmd.startsWith('@tool:') || trimmedCmd.startsWith('@tool-exec:')) {
                const parsed = parseDirectToolCall(trimmedCmd);
                if (parsed) {
                  const hooks = this.ablationManager.getHooksForPhase(ablation, phase.name);
                  for (const hook of hooks) {
                    if (hook.before === parsed.toolName) {
                      if (this.callbacks.isAbortRequested()) break;

                      const hookCmd = resolvedArguments
                        ? this.ablationManager.substituteArguments([hook.run], resolvedArguments)[0]
                        : hook.run;
                      this.logger.log(`  ↳ Before hook: executing ${hookCmd}\n`, { type: 'info' });
                      const hookStartTime = Date.now();
                      const hookResult = await this.executeAblationCommand(
                        hookCmd,
                        ablation.settings.maxIterations,
                        ablation.dryRun || false,
                        ablation,
                        phase.name,
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
              );

              // Dry-run pause: after each tool-exec, check for Ctrl+A interrupt
              if (ablation.dryRun && this.callbacks.isInterruptRequested() && !this.callbacks.isAbortRequested()) {
                this.callbacks.resetInterrupt();
                const choice = await this.promptDryRunPause(command);
                if (choice === 'retry') {
                  i--; // Decrement so the for-loop re-runs this command
                  continue;
                } else if (choice === 'cancel') {
                  aborted = true;
                  shouldBreak = true;
                  break;
                }
                // 'resume' → continue to next command
              }

              // Phase completed via @complete-phase (from agent-driven prompt or direct command)
              if (cmdResult.phaseComplete) {
                this.logger.log(`  ✓ Phase "${phase.name}" completed via signal\n`, { type: 'success' });
                phaseCompletedViaSignal = true;
                break;
              }

              // Abort run signaled (from agent-driven hook via HookManager)
              if (cmdResult.abortRun) {
                abortCurrentModel = true;
                break;
              }

              // Execute after-hooks (only for @tool-exec/@tool commands, no recursion)
              if (cmdResult.toolExecResult) {
                const hooks = this.ablationManager.getHooksForPhase(ablation, phase.name);
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
                    if (this.callbacks.isAbortRequested()) break;

                    const hookCmd = resolvedArguments
                      ? this.ablationManager.substituteArguments([hook.run], resolvedArguments)[0]
                      : hook.run;
                    this.logger.log(`  ↳ Hook: executing ${hookCmd}\n`, { type: 'info' });
                    const hookStartTime = Date.now();
                    const hookResult = await this.executeAblationCommand(
                      hookCmd,
                      ablation.settings.maxIterations,
                      ablation.dryRun || false,
                      ablation,
                      phase.name,
                    );

                    // @abort hook — skip remaining phases for this model
                    if (hookResult.abortRun) {
                      abortCurrentModel = true;
                      break;
                    }

                    // @complete-phase hook — advance to next phase
                    if (hookResult.phaseComplete) {
                      break;
                    }

                  }
                }
              }

              // If @abort was triggered by an after-hook, break out of the command loop
              if (abortCurrentModel) break;

              // Check for abort after each command
              if (this.callbacks.isAbortRequested()) {
                this.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
                aborted = true;
                shouldBreak = true;
                break;
              }
            }

            // Execute onEnd lifecycle hooks (only if not aborted)
            if (!aborted && phaseOnEnd && phaseOnEnd.length > 0) {
              this.logger.log(`  ⤷ Phase onEnd hooks...\n`, { type: 'info' });
              for (const endCmd of phaseOnEnd) {
                if (this.callbacks.isAbortRequested()) {
                  this.logger.log('\n⚠️  Ablation aborted by user.\n', { type: 'warning' });
                  aborted = true;
                  shouldBreak = true;
                  break;
                }

                this.logger.log(`    ↳ ${endCmd}\n`, { type: 'info' });
                const hookStartTime = Date.now();
                const hookResult = await this.executeAblationCommand(
                  endCmd,
                  ablation.settings.maxIterations,
                  ablation.dryRun || false,
                  ablation,
                  phase.name,
                );

                // Log onEnd tool execution to chat history
                if (hookResult.toolExecResult) {
                  const chatHist = this.client.getChatHistoryManager();
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
              await this.client.cleanupVideoRecording();
              this.client.getChatHistoryManager().addPhaseEvent('phase-abort', phase.name);

              result.status = 'aborted';
              result.duration = Date.now() - startTime;
              result.durationFormatted = formatDuration(result.duration);

              // Capture any outputs produced before abort (for diagnostics)
              this.ablationManager.captureRunOutputs(runDir, phase.name, model, getRunIter(iteration));

              // Save chat history on abort so it's preserved in the run directory
              if (ablation.settings.clearContextBetweenPhases !== false) {
                this.savePhaseChatHistory(
                  `Ablation run (aborted): ${phase.name} with ${model.provider}/${model.model}`,
                  runDir, phase.name, phaseDir, model, result, hasMultipleIterations, iteration,
                );
              }

              run.results.push(result);
              break;
            }

            // @abort triggered by hook — skip remaining phases for this model
            if (abortCurrentModel) {
              await this.client.cleanupVideoRecording();

              result.status = 'aborted';
              result.duration = Date.now() - startTime;
              result.durationFormatted = formatDuration(result.duration);

              // Capture any outputs produced before @abort (for diagnostics)
              this.ablationManager.captureRunOutputs(runDir, phase.name, model, getRunIter(iteration));

              // Save chat history on @abort so it's preserved in the run directory
              if (ablation.settings.clearContextBetweenPhases !== false) {
                this.savePhaseChatHistory(
                  `Ablation run (@abort): ${phase.name} with ${model.provider}/${model.model}`,
                  runDir, phase.name, phaseDir, model, result, hasMultipleIterations, iteration,
                );
              }

              this.logger.log(
                `\n  ⚠️ Skipping remaining phases for ${modelKey} due to @abort\n`,
                { type: 'warning' },
              );

              modelAborted = true;
              run.results.push(result);
              break; // break phase loop, continue to next model
            }

            // Get token usage (skip in dry run - no model means no tokens)
            if (!ablation.dryRun) {
              const tokenUsage = this.client.getTokenUsage();
              result.tokens = tokenUsage.current;
            }

            result.status = 'completed';
            result.duration = Date.now() - startTime;
            result.durationFormatted = formatDuration(result.duration);

            // Log phase-complete if not already logged by a signal (@complete-phase or agent-stopped)
            if (!phaseCompletedViaSignal) {
              this.client.getChatHistoryManager().addPhaseEvent('phase-complete', phase.name, { after: 'commands-exhausted' });
            }

            // Stop any active video recording so the file is finalized before capture
            await this.client.cleanupVideoRecording();

            // Save chat history and copy to phase directory
            // When context persists across phases, defer saving until all phases complete
            if (ablation.settings.clearContextBetweenPhases !== false) {
              this.savePhaseChatHistory(
                `Ablation run: ${phase.name} with ${model.provider}/${model.model}`,
                runDir, phase.name, phaseDir, model, result, hasMultipleIterations, iteration,
              );
            }

            this.logger.log(
              `\n  ✓ Scenario complete │ Duration: ${formatDuration(result.duration)}${result.tokens !== undefined ? ` │ Tokens: ${result.tokens}` : ''}\n`,
              { type: 'success' },
            );
          } catch (error: any) {
            result.status = 'failed';
            result.error = error.message;
            result.duration = Date.now() - startTime;
            result.durationFormatted = formatDuration(result.duration);

            // Stop any active video recording so the file is finalized before capture
            await this.client.cleanupVideoRecording();

            // Save chat history on error so it's preserved in the run directory
            if (ablation.settings.clearContextBetweenPhases !== false) {
              this.savePhaseChatHistory(
                `Ablation run (failed): ${phase.name} with ${model.provider}/${model.model}`,
                runDir, phase.name, phaseDir, model, result, hasMultipleIterations, iteration,
              );
            }

            this.logger.log(`\n  ✗ Scenario failed: ${error.message}\n`, {
              type: 'error',
            });
          }

          run.results.push(result);

          // Capture outputs produced during this phase (even on failure, for diagnostics)
          this.ablationManager.captureRunOutputs(runDir, phase.name, model, getRunIter(iteration));

          // On failure: skip remaining phases for this model
          if (result.status === 'failed') {
            modelAborted = true;
            this.logger.log(
              `\n  ⚠️ Skipping remaining phases for ${modelKey} due to error: ${result.error}\n`,
              { type: 'warning' },
            );
            break; // break phase loop, continue to next model
          }
        }

        // When context persists across phases, save the cumulative chat after all phases
        if (!ablation.dryRun && ablation.settings.clearContextBetweenPhases === false) {
          const chatHistoryManager = this.client.getChatHistoryManager();
          const chatMetadata = chatHistoryManager.endSession(
            `Ablation run: all phases with ${model.provider}/${model.model}`,
          );

          if (chatMetadata) {
            // Save cumulative chat to model-level directory: {modelDir}/(run-{N}/)
            const modelDir = this.ablationManager.getModelDirName(model);
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
              this.logger.log(`  Warning: Failed to copy cumulative chat files: ${copyError}\n`, { type: 'warning' });
            }
          }
        }
      }

    }
    } finally {
      // Resume client-side hooks
      hookManager.resume();

      // Stop keyboard monitor - always runs even if aborted/errored
      this.callbacks.stopKeyboardMonitor();

      // Disable abort mode - Ctrl+C will exit normally again
      this.callbacks.setAbortMode(false);

      // Stop any active video recordings (prevents orphaned recording processes on abort)
      await this.client.cleanupVideoRecording();
    }

    // Finalize run
    run.completedAt = new Date().toISOString();
    run.totalDuration = Date.now() - totalStartTime;
    run.totalDurationFormatted = formatDuration(run.totalDuration);
    run.totalTokens = run.results.reduce((sum, r) => sum + (r.tokens || 0), 0);

    // Save results
    this.ablationManager.saveRunResults(runDir, run);

    // Display summary
    const completeLine = `ABLATION COMPLETE: ${ablation.name}`;
    const completeWidth = Math.max(completeLine.length, 59);
    this.logger.log(
      `\n┌──${'─'.repeat(completeWidth)}──┐\n`,
      { type: 'info' },
    );
    this.logger.log(
      `│  ${completeLine.padEnd(completeWidth)}  │\n`,
      { type: 'info' },
    );
    this.logger.log(
      `└──${'─'.repeat(completeWidth)}──┘\n`,
      { type: 'info' },
    );

    this.logger.log(`\n  Results:\n`, { type: 'info' });
    const completedScenarios = run.results.filter(
      (r) => r.status === 'completed',
    ).length;
    const failedScenarios = run.results.filter((r) => r.status === 'failed').length;
    const abortedScenarios = run.results.filter((r) => r.status === 'aborted').length;
    this.logger.log(`    Scenarios: ${completedScenarios}/${totalScenarios} completed\n`, {
      type: 'info',
    });
    if (failedScenarios > 0) {
      this.logger.log(`    Failed: ${failedScenarios}\n`, { type: 'warning' });
    }
    if (abortedScenarios > 0) {
      this.logger.log(`    Aborted: ${abortedScenarios}\n`, { type: 'warning' });
    }
    this.logger.log(
      `    Total time: ${formatDuration(run.totalDuration)}\n`,
      { type: 'info' },
    );
    this.logger.log(`\n  Outputs saved to:\n`, { type: 'info' });
    this.logger.log(`    ${runDir}\n`, { type: 'info' });

    // Restore original outputs folder from stash
    this.logger.log('\n  Restoring original outputs folder...\n', {
      type: 'info',
    });
    this.ablationManager.unstashOutputs(runDir);

    return shouldBreak;
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
      await rl.question('\nSelect ablation (or "q" to cancel): ')
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
   * Handle /ablation-results command - View past ablation run results
   */
  async handleAblationResults(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const ablations = this.ablationManager.list();

    if (ablations.length === 0) {
      this.logger.log('\n📊 No ablation studies found.\n', { type: 'warning' });
      return;
    }

    this.logger.log('\n📊 Select ablation to view results:\n', { type: 'info' });

    for (let i = 0; i < ablations.length; i++) {
      const ablation = ablations[i];
      const runs = this.ablationManager.listRuns(ablation.name);
      this.logger.log(
        `  ${i + 1}. ${ablation.name} (${runs.length} past runs)\n`,
        { type: 'info' },
      );
    }

    const selection = (
      await rl.question('\nSelect ablation (or "q" to cancel): ')
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
    const runs = this.ablationManager.listRuns(ablation.name);

    if (runs.length === 0) {
      this.logger.log(`\n📊 No runs found for "${ablation.name}".\n`, {
        type: 'warning',
      });
      this.logger.log('Use /ablation-run to run this ablation study.\n', {
        type: 'info',
      });
      return;
    }

    this.logger.log(`\n📊 Runs for "${ablation.name}":\n`, { type: 'info' });

    for (let i = 0; i < runs.length; i++) {
      const { timestamp, run } = runs[i];
      const completedCount = run.results.filter(
        (r) => r.status === 'completed',
      ).length;
      const totalCount = run.results.length;
      const duration = run.totalDuration
        ? formatDuration(run.totalDuration)
        : 'N/A';

      this.logger.log(`  ${i + 1}. ${timestamp}\n`, { type: 'info' });
      this.logger.log(
        `     └─ ${completedCount}/${totalCount} completed │ Duration: ${duration}\n`,
        { type: 'info' },
      );
    }

    const runSelection = (
      await rl.question('\nSelect run to view details (or "q" to cancel): ')
    ).trim();

    if (runSelection.toLowerCase() === 'q') {
      return;
    }

    const runIndex = parseInt(runSelection) - 1;
    if (isNaN(runIndex) || runIndex < 0 || runIndex >= runs.length) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const { run } = runs[runIndex];

    // Display detailed results
    this.logger.log(
      `\n┌─────────────────────────────────────────────────────────────┐\n`,
      { type: 'info' },
    );
    this.logger.log(
      `│  RUN RESULTS                                                │\n`,
      { type: 'info' },
    );
    this.logger.log(
      `└─────────────────────────────────────────────────────────────┘\n`,
      { type: 'info' },
    );

    this.logger.log(`\n  Started: ${run.startedAt}\n`, { type: 'info' });
    this.logger.log(`  Completed: ${run.completedAt || 'N/A'}\n`, {
      type: 'info',
    });
    this.logger.log(
      `  Total Duration: ${run.totalDuration ? formatDuration(run.totalDuration) : 'N/A'}\n`,
      { type: 'info' },
    );

    this.logger.log(`\n  Individual Results:\n`, { type: 'info' });

    for (const result of run.results) {
      const status =
        result.status === 'completed'
          ? '✓'
          : result.status === 'failed'
            ? '✗'
            : '○';
      const duration = result.duration
        ? formatDuration(result.duration)
        : 'N/A';
      const modelShort = this.ablationManager.getModelShortName(result.model);

      this.logger.log(
        `    ${status} ${result.phase} + ${modelShort} │ ${duration}\n`,
        { type: result.status === 'failed' ? 'error' : 'info' },
      );

      if (result.error) {
        this.logger.log(`      Error: ${result.error}\n`, { type: 'error' });
      }
    }
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
      this.ablationManager.addPhase(ablationName, { name: phaseName, commands });
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
      this.logger.log(`    Select thinking level:\n`, { type: 'info' });
      for (let i = 0; i < levels.length; i++) {
        this.logger.log(`      ${i + 1}. ${levels[i].label}\n`, { type: 'info' });
      }

      const answer = (await rl.question('    Enter selection: ')).trim();
      const selection = parseInt(answer, 10);
      if (selection >= 1 && selection <= levels.length) {
        model.thinking = levels[selection - 1].value;
        this.logger.log(`    ✓ Thinking: ${levels[selection - 1].value}\n`, { type: 'success' });
      } else {
        this.logger.log('    Invalid selection. Thinking disabled for this model.\n', { type: 'warning' });
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

    const answer = (await rl.question('\n  Enter selection: ')).trim();
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
   * Returns true for commands like /add-prompt, /add-attachment that need a selection
   */
  private commandNeedsArgument(command: string): boolean {
    const lowerCommand = command.toLowerCase().trim();

    // Commands that need an index/argument
    const commandsNeedingArgs = [
      '/add-prompt',
      '/add-attachment',
      '/attachment-insert',
    ];

    // Check if the command is one that needs an argument AND doesn't already have one
    for (const cmd of commandsNeedingArgs) {
      if (lowerCommand === cmd) {
        // Command without argument
        return true;
      }
      if (lowerCommand.startsWith(cmd + ' ')) {
        // Command already has an argument
        return false;
      }
    }

    return false;
  }

  /**
   * Execute a command in preview mode during ablation creation
   * Shows the command output so user can see what inputs are expected
   */
  private async executeAblationPreviewCommand(command: string): Promise<void> {
    const lowerCommand = command.toLowerCase();

    try {
      // Handle read-only/display commands that help user understand what to input
      if (lowerCommand === '/add-prompt') {
        await this.showPromptListForPreview();
      } else if (
        lowerCommand === '/prompts' ||
        lowerCommand === '/prompts-list'
      ) {
        await this.callbacks.getPromptCLI().displayPromptsList();
      } else if (lowerCommand === '/attachment-list') {
        await this.callbacks.getAttachmentCLI().handleAttachmentListCommand();
      } else if (lowerCommand === '/attachment-insert') {
        await this.showAttachmentListForPreview();
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
