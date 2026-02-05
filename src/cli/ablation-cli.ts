/**
 * CLI operations for ablation study management.
 */

import readline from 'readline/promises';
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
} from '../managers/ablation-manager.js';

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

// ==================== Tool Call Parsing ====================

/**
 * Result of parsing a direct tool call command
 */
interface ParsedToolCall {
  toolName: string;
  args: Record<string, unknown>;
  injectResult: boolean;  // Whether to inject result into conversation context
}

/**
 * Parse a direct tool call command in either format:
 * - JSON: `@tool:server__tool_name {"arg": "value"}`
 * - Python-like: `@tool:server__tool_name(arg='value', num=42)`
 *
 * @param command The command string starting with @tool: or @tool-exec:
 * @returns Parsed tool call or null if invalid
 */
function parseDirectToolCall(command: string): ParsedToolCall | null {
  // Determine if this is @tool: (inject result) or @tool-exec: (no injection)
  let injectResult = true;
  let rest: string;

  if (command.startsWith('@tool-exec:')) {
    injectResult = false;
    rest = command.slice('@tool-exec:'.length).trim();
  } else if (command.startsWith('@tool:')) {
    injectResult = true;
    rest = command.slice('@tool:'.length).trim();
  } else {
    return null;
  }

  // Try Python-like syntax first: tool_name(arg=val, ...) or tool_name()
  const pythonMatch = rest.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*\((.*)\)\s*$/);
  if (pythonMatch) {
    const toolName = pythonMatch[1];
    const argsStr = pythonMatch[2].trim();
    const args = argsStr ? parsePythonArgs(argsStr) : {};
    return { toolName, args, injectResult };
  }

  // Try JSON syntax: tool_name {"arg": "value"} or tool_name {}
  const jsonMatch = rest.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*(\{.*\})?\s*$/);
  if (jsonMatch) {
    const toolName = jsonMatch[1];
    const jsonStr = jsonMatch[2] || '{}';
    try {
      const args = JSON.parse(jsonStr);
      return { toolName, args, injectResult };
    } catch {
      return null;
    }
  }

  // Simple tool name with no args: tool_name
  const simpleMatch = rest.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*$/);
  if (simpleMatch) {
    return { toolName: simpleMatch[1], args: {}, injectResult };
  }

  return null;
}

/**
 * Parse Python-like function arguments: arg='value', num=42, flag=true
 * Handles: strings (single/double quotes), numbers, booleans, null
 */
function parsePythonArgs(argsStr: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  // State machine to parse arguments
  let i = 0;
  while (i < argsStr.length) {
    // Skip whitespace and commas
    while (i < argsStr.length && (argsStr[i] === ' ' || argsStr[i] === ',' || argsStr[i] === '\t')) {
      i++;
    }
    if (i >= argsStr.length) break;

    // Parse key
    const keyStart = i;
    while (i < argsStr.length && argsStr[i] !== '=' && argsStr[i] !== ' ') {
      i++;
    }
    const key = argsStr.slice(keyStart, i).trim();
    if (!key) break;

    // Skip to '='
    while (i < argsStr.length && argsStr[i] === ' ') i++;
    if (argsStr[i] !== '=') break;
    i++; // Skip '='
    while (i < argsStr.length && argsStr[i] === ' ') i++;

    // Parse value
    let value: unknown;

    if (argsStr[i] === "'" || argsStr[i] === '"') {
      // String value
      const quote = argsStr[i];
      i++;
      const valueStart = i;
      while (i < argsStr.length && argsStr[i] !== quote) {
        if (argsStr[i] === '\\' && i + 1 < argsStr.length) i++; // Skip escaped char
        i++;
      }
      value = argsStr.slice(valueStart, i).replace(/\\(.)/g, '$1');
      i++; // Skip closing quote
    } else {
      // Non-string value (number, boolean, null)
      const valueStart = i;
      while (i < argsStr.length && argsStr[i] !== ',' && argsStr[i] !== ')') {
        i++;
      }
      const rawValue = argsStr.slice(valueStart, i).trim();

      // Parse type
      if (rawValue === 'true' || rawValue === 'True') {
        value = true;
      } else if (rawValue === 'false' || rawValue === 'False') {
        value = false;
      } else if (rawValue === 'null' || rawValue === 'None') {
        value = null;
      } else if (!isNaN(Number(rawValue))) {
        value = Number(rawValue);
      } else {
        // Treat as unquoted string
        value = rawValue;
      }
    }

    args[key] = value;
  }

  return args;
}
import { AttachmentManager, type AttachmentInfo } from '../managers/attachment-manager.js';
import { PreferencesManager } from '../managers/preferences-manager.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OllamaProvider } from '../providers/ollama.js';
import { GrokProvider } from '../providers/grok.js';
import type { ModelInfo, ModelProvider as IModelProvider } from '../model-provider.js';
import type { ModelProvider } from '../model-provider.js';
import type { ToolCLI } from './tool-cli.js';
import type { PromptCLI } from './prompt-cli.js';
import type { AttachmentCLI } from './attachment-cli.js';

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

    // Step 2: Define Phases
    this.logger.log('\nStep 2: Define Phases (command sequences)\n', {
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
          } else if (input.startsWith('@tool:') || input.startsWith('@tool-exec:')) {
            // Validate tool call syntax during creation
            const parsed = parseDirectToolCall(input);
            if (parsed) {
              const injectInfo = parsed.injectResult ? ' (result will be injected into context)' : ' (execute only, no context injection)';
              this.logger.log(`    ℹ️  Tool call: ${parsed.toolName}${injectInfo}\n`, { type: 'info' });
            } else {
              this.logger.log(`    ⚠️  Warning: Invalid tool call syntax\n`, { type: 'warning' });
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

    // Step 3: Select Models
    this.logger.log('\nStep 3: Select Models (multi-select)\n', {
      type: 'info',
    });
    const models: AblationModel[] = [];

    const providers = [
      {
        name: 'anthropic',
        label: 'Anthropic (Claude)',
        models: [
          'claude-haiku-4-5-20251001',
          'claude-sonnet-4-20250514',
          'claude-opus-4-20250514',
        ],
      },
      {
        name: 'openai',
        label: 'OpenAI (GPT)',
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-mini'],
      },
      {
        name: 'gemini',
        label: 'Google Gemini',
        models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
      },
      {
        name: 'ollama',
        label: 'Ollama (Local)',
        models: ['llama3.2:3b', 'llama3.1:8b', 'mistral:7b'],
      },
    ];

    this.logger.log('  Available providers:\n', { type: 'info' });
    for (let i = 0; i < providers.length; i++) {
      this.logger.log(`    ${i + 1}. ${providers[i].label}\n`, { type: 'info' });
    }

    const providerSelection = (
      await rl.question('\n  Select providers (e.g., 1,2 or 1-3): ')
    ).trim();
    const selectedProviderIndices = this.parseSelection(
      providerSelection,
      providers.length,
    );

    for (const providerIdx of selectedProviderIndices) {
      const provider = providers[providerIdx - 1];
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
              models.push({
                provider: provider.name,
                model: discoveredModels[idx - 1].id,
              });
            }
          }
        } else if (modelIdx === provider.models.length + 1) {
          // Custom model
          const customModel = (
            await rl.question('  Enter custom model name: ')
          ).trim();
          if (customModel) {
            models.push({ provider: provider.name, model: customModel });
          }
        } else {
          models.push({
            provider: provider.name,
            model: provider.models[modelIdx - 1],
          });
        }
      }
    }

    if (models.length === 0) {
      this.logger.log('\n✗ At least one model is required.\n', {
        type: 'error',
      });
      return;
    }

    // Step 4: Settings
    this.logger.log('\nStep 4: Settings\n', { type: 'info' });

    const defaultMaxIterations = this.preferencesManager.getMaxIterations();
    const maxIterationsStr = (
      await rl.question(
        `  Max iterations per run (default ${defaultMaxIterations}): `,
      )
    ).trim();
    const maxIterations = maxIterationsStr
      ? parseInt(maxIterationsStr) || defaultMaxIterations
      : defaultMaxIterations;

    // Create the ablation
    try {
      const ablation = this.ablationManager.create({
        name,
        description,
        phases,
        models,
        settings: {
          maxIterations,
        },
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
        this.logger.log(`    • ${model.provider}/${model.model}\n`, {
          type: 'info',
        });
      }
      this.logger.log(
        `\n  Total runs: ${this.ablationManager.getTotalRuns(ablation)} (${ablation.phases.length} phases × ${ablation.models.length} models)\n`,
        { type: 'info' },
      );

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
      this.logger.log(
        `     └─ ${ablation.phases.length} phases × ${ablation.models.length} models = ${totalRuns} runs │ ${providers.join(', ')} │ Created: ${createdDate}\n`,
        { type: 'info' },
      );
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
      this.logger.log(`\n  Editing: ${ablation.name}\n`, { type: 'info' });
      this.logger.log('\n  What do you want to edit?\n', { type: 'info' });
      this.logger.log('    1. Add phase\n', { type: 'info' });
      this.logger.log('    2. Edit phase\n', { type: 'info' });
      this.logger.log('    3. Remove phase\n', { type: 'info' });
      this.logger.log('    4. Add models\n', { type: 'info' });
      this.logger.log('    5. Remove models\n', { type: 'info' });
      this.logger.log('    6. Edit settings\n', { type: 'info' });
      this.logger.log('    7. Edit description\n', { type: 'info' });
      this.logger.log('    8. Done\n', { type: 'info' });

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
        case '8': // Done
        case 'q':
          const updated = this.ablationManager.load(ablation.name);
          if (updated) {
            this.logger.log(`\n  Updated ablation:\n`, { type: 'info' });
            this.logger.log(
              `  Phases: ${updated.phases.length}, Models: ${updated.models.length}, Total runs: ${this.ablationManager.getTotalRuns(updated)}\n`,
              { type: 'info' },
            );
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
    switch (providerName.toLowerCase()) {
      case 'anthropic':
        return new AnthropicProvider();
      case 'openai':
        return new OpenAIProvider();
      case 'gemini':
        return new GeminiProvider();
      case 'ollama':
        return new OllamaProvider(process.env.OLLAMA_HOST);
      case 'grok':
        return new GrokProvider();
      default:
        throw new Error(`Unknown provider: ${providerName}`);
    }
  }

  /**
   * Execute a command during ablation run
   * Handles slash commands, direct tool calls (@tool:), and regular queries to the model
   */
  private async executeAblationCommand(
    command: string,
    maxIterations: number,
  ): Promise<void> {
    const trimmedCommand = command.trim();

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
      } catch (error: any) {
        this.logger.log(`    Tool execution failed: ${error.message}\n`, { type: 'error' });
        throw error;
      }

      return;
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
            for (const msg of promptResult.messages) {
              if (msg.content.type === 'text') {
                // Process the prompt text as a query
                await this.client.processQuery(
                  msg.content.text,
                  false,
                  undefined,
                  () => false,
                );
              }
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
      const pendingAttachments = this.callbacks.getPendingAttachments();
      await this.client.processQuery(
        trimmedCommand,
        false,
        pendingAttachments.length > 0 ? pendingAttachments : undefined,
        () => false,
      );
      // Clear attachments after use
      this.callbacks.setPendingAttachments([]);
    }
  }

  /**
   * Handle /ablation-run command - Run an ablation study
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
      const totalRuns = this.ablationManager.getTotalRuns(ablation);
      this.logger.log(`  ${i + 1}. ${ablation.name} (${totalRuns} runs)\n`, {
        type: 'info',
      });
    }

    const selection = (
      await rl.question('\nSelect ablation to run (or "q" to cancel): ')
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
    const totalRuns = this.ablationManager.getTotalRuns(ablation);

    // Display run details
    this.logger.log(
      `\n┌─────────────────────────────────────────────────────────────┐\n`,
      { type: 'info' },
    );
    this.logger.log(
      `│  ABLATION: ${ablation.name.padEnd(48)}│\n`,
      { type: 'info' },
    );
    if (ablation.description) {
      this.logger.log(
        `│  ${ablation.description.substring(0, 57).padEnd(58)}│\n`,
        { type: 'info' },
      );
    }
    this.logger.log(
      `└─────────────────────────────────────────────────────────────┘\n`,
      { type: 'info' },
    );

    this.logger.log(
      `\n  Matrix: ${ablation.phases.length} phases × ${ablation.models.length} models = ${totalRuns} runs\n`,
      { type: 'info' },
    );

    // Display matrix header
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

    const confirm = (await rl.question('\nStart ablation? (Y/n): '))
      .trim()
      .toLowerCase();
    if (confirm === 'n' || confirm === 'no') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    // Save original provider/model and chat state to restore after ablation
    const originalProviderName = this.client.getProviderName();
    const originalModel = this.client.getModel();
    const savedState = this.client.saveState();
    this.logger.log('\n  Original chat saved. Starting ablation...\n', {
      type: 'info',
    });

    // Create run directory
    const { runDir, timestamp } = this.ablationManager.createRunDirectory(
      ablation.name,
    );

    // Copy attachments to run directory (same for all runs)
    this.ablationManager.copyAttachmentsToRun(runDir, ablation);

    // Snapshot current outputs folder to ensure each run starts with the same state
    this.logger.log('  Snapshotting outputs folder...\n', { type: 'info' });
    this.ablationManager.snapshotOutputs(runDir);

    // Initialize run results
    const run: AblationRun = {
      ablationName: ablation.name,
      startedAt: new Date().toISOString(),
      results: [],
    };

    let runNumber = 0;
    const totalStartTime = Date.now();
    let shouldBreak = false;

    // Execute each phase × model combination
    for (const phase of ablation.phases) {
      if (shouldBreak) break;
      const phaseDir = this.ablationManager.createPhaseDirectory(
        runDir,
        phase.name,
      );

      for (const model of ablation.models) {
        if (shouldBreak) break;
        runNumber++;
        const modelShortName = this.ablationManager.getModelShortName(model);

        this.logger.log(
          `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
          { type: 'info' },
        );
        this.logger.log(
          `  RUN ${runNumber}/${totalRuns}: ${phase.name} + ${modelShortName}\n`,
          { type: 'info' },
        );
        this.logger.log(
          `  Provider: ${model.provider} │ Model: ${model.model}\n`,
          { type: 'info' },
        );
        this.logger.log(
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
          { type: 'info' },
        );

        // Restore outputs from snapshot before each run
        this.ablationManager.restoreOutputsFromSnapshot(runDir);

        const result: AblationRunResult = {
          phase: phase.name,
          model,
          status: 'running',
        };

        const startTime = Date.now();

        try {
          // Create provider instance and switch to this model
          const provider = this.createProviderInstance(model.provider);
          await this.client.switchProviderAndModel(provider, model.model);

          // Execute commands for this phase
          for (let i = 0; i < phase.commands.length; i++) {
            const command = phase.commands[i];
            this.logger.log(
              `  [${i + 1}/${phase.commands.length}] Executing: ${command}\n`,
              { type: 'info' },
            );
            await this.executeAblationCommand(
              command,
              ablation.settings.maxIterations,
            );
          }

          // Get token usage
          const tokenUsage = this.client.getTokenUsage();
          result.tokens = tokenUsage.current;

          result.status = 'completed';
          result.duration = Date.now() - startTime;
          result.chatFile = `chats/${phase.name}/${this.ablationManager.getChatFileName(model)}`;

          // Capture outputs written during this run
          const capturedCount = this.ablationManager.captureRunOutputs(
            runDir,
            phase.name,
            model,
          );
          if (capturedCount > 0) {
            this.logger.log(`  📁 Captured ${capturedCount} output files\n`, {
              type: 'info',
            });
          }

          // Save chat history to phase directory
          const chatHistoryManager = this.client.getChatHistoryManager();
          chatHistoryManager.endSession(
            `Ablation run: ${phase.name} with ${model.provider}/${model.model}`,
          );

          this.logger.log(
            `\n  ✓ Scenario complete │ Duration: ${(result.duration / 1000).toFixed(1)}s │ Tokens: ${result.tokens}\n`,
            { type: 'success' },
          );
        } catch (error: any) {
          result.status = 'failed';
          result.error = error.message;
          result.duration = Date.now() - startTime;

          // Still capture any outputs that were written before failure
          const capturedCount = this.ablationManager.captureRunOutputs(
            runDir,
            phase.name,
            model,
          );
          if (capturedCount > 0) {
            this.logger.log(
              `  📁 Captured ${capturedCount} output files before failure\n`,
              { type: 'info' },
            );
          }

          this.logger.log(`\n  ✗ Scenario failed: ${error.message}\n`, {
            type: 'error',
          });
        }

        run.results.push(result);

        // Always stop on error
        if (result.status === 'failed') {
          this.logger.log(
            `\nAblation stopped due to error: ${result.error}\n`,
            { type: 'error' },
          );
          this.logger.log('Partial results saved.\n', { type: 'warning' });
          shouldBreak = true;
        }
      }
    }

    // Finalize run
    run.completedAt = new Date().toISOString();
    run.totalDuration = Date.now() - totalStartTime;
    run.totalTokens = run.results.reduce((sum, r) => sum + (r.tokens || 0), 0);

    // Save results
    this.ablationManager.saveRunResults(runDir, run);

    // Display summary
    this.logger.log(
      `\n┌─────────────────────────────────────────────────────────────┐\n`,
      { type: 'info' },
    );
    this.logger.log(
      `│  ABLATION COMPLETE: ${ablation.name.padEnd(38)}│\n`,
      { type: 'info' },
    );
    this.logger.log(
      `└─────────────────────────────────────────────────────────────┘\n`,
      { type: 'info' },
    );

    this.logger.log(`\n  Results:\n`, { type: 'info' });
    const completedRuns = run.results.filter(
      (r) => r.status === 'completed',
    ).length;
    const failedRuns = run.results.filter((r) => r.status === 'failed').length;
    this.logger.log(`    Completed: ${completedRuns}/${totalRuns}\n`, {
      type: 'info',
    });
    if (failedRuns > 0) {
      this.logger.log(`    Failed: ${failedRuns}\n`, { type: 'warning' });
    }
    this.logger.log(
      `    Total time: ${(run.totalDuration / 1000).toFixed(1)}s\n`,
      { type: 'info' },
    );
    this.logger.log(`\n  Outputs saved to:\n`, { type: 'info' });
    this.logger.log(`    ${runDir}\n`, { type: 'info' });

    // Restore original outputs folder state
    this.logger.log('\n  Restoring original outputs folder...\n', {
      type: 'info',
    });
    this.ablationManager.cleanupOutputsSnapshot(runDir, true);

    // Restore original provider/model and chat state
    this.logger.log('  Restoring original session...\n', { type: 'info' });
    const originalProvider = this.createProviderInstance(originalProviderName);
    await this.client.restoreState(savedState, originalProvider, originalModel);
    this.logger.log(
      `  ✓ Restored to ${originalProviderName}/${originalModel}\n`,
      { type: 'success' },
    );
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
        ? `${(run.totalDuration / 1000).toFixed(1)}s`
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
      `  Total Duration: ${run.totalDuration ? (run.totalDuration / 1000).toFixed(1) + 's' : 'N/A'}\n`,
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
        ? `${(result.duration / 1000).toFixed(1)}s`
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

  private async handleAddModels(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const providers = [
      {
        name: 'anthropic',
        label: 'Anthropic',
        models: [
          'claude-haiku-4-5-20251001',
          'claude-sonnet-4-20250514',
          'claude-opus-4-20250514',
        ],
      },
      {
        name: 'openai',
        label: 'OpenAI',
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-mini'],
      },
      {
        name: 'gemini',
        label: 'Gemini',
        models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      },
      {
        name: 'ollama',
        label: 'Ollama',
        models: ['llama3.2:3b', 'llama3.1:8b'],
      },
    ];

    this.logger.log('\n  Select provider:\n', { type: 'info' });
    for (let i = 0; i < providers.length; i++) {
      this.logger.log(`    ${i + 1}. ${providers[i].label}\n`, { type: 'info' });
    }

    const providerSelection = (
      await rl.question('\n  Select provider: ')
    ).trim();
    const providerIndex = parseInt(providerSelection) - 1;

    if (
      isNaN(providerIndex) ||
      providerIndex < 0 ||
      providerIndex >= providers.length
    ) {
      this.logger.log('\n✗ Invalid selection.\n', { type: 'error' });
      return;
    }

    const provider = providers[providerIndex];
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
          modelsToAdd.push({ provider: provider.name, model: customModel });
        }
      } else {
        modelsToAdd.push({
          provider: provider.name,
          model: provider.models[idx - 1],
        });
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

  private async handleEditSettings(ablationName: string): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) return;

    const ablation = this.ablationManager.load(ablationName);
    if (!ablation) return;

    this.logger.log('\n  Current settings:\n', { type: 'info' });
    this.logger.log(`    Max iterations: ${ablation.settings.maxIterations}\n`, {
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

    this.ablationManager.update(ablationName, { settings: newSettings });
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

      let provider: IModelProvider;
      switch (providerName.toLowerCase()) {
        case 'anthropic':
          provider = new AnthropicProvider();
          break;
        case 'openai':
          provider = new OpenAIProvider();
          break;
        case 'gemini':
          provider = new GeminiProvider();
          break;
        case 'ollama':
          provider = new OllamaProvider(process.env.OLLAMA_HOST);
          break;
        case 'grok':
          provider = new GrokProvider();
          break;
        default:
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
