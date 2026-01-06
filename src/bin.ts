#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { MCPClientCLI } from './cli-client.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import readline from 'readline';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { OllamaProvider } from './providers/ollama.js';
import { GeminiProvider } from './providers/gemini.js';
import type { ModelProvider, ModelInfo } from './model-provider.js';

// Load .env file from mcp-client directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({
  path: resolve(__dirname, '..', '.env'),
});

interface ServerConfig {
  command: string;
  args: string[];
  disabled?: boolean;
  env?: Record<string, string>;
}

interface ClientConfig {
  servers: Record<string, ServerConfig>;
  defaultServer?: string;
  toolStates?: Record<string, boolean>;
}

interface AnthropicDesktopConfig {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      disabled?: boolean;
      timeout?: number;
      type?: string;
      env?: Record<string, string>;
    }
  >;
}

const CONFIG_DIR = join(__dirname, '..', '.mcp-client-data');
const CONFIG_FILE = join(CONFIG_DIR, 'preferences.json');

// Try to find local mcp_config.json in mcp-client directory
const LOCAL_CONFIG_FILE = join(__dirname, '..', 'mcp_config.json');

/**
 * Merges custom environment variables with default safe environment variables.
 * This ensures that when custom env vars are provided, essential variables like PATH, HOME, etc.
 * are still available to the spawned process.
 * Also adds MCP_CLIENT_OUTPUT_DIR pointing to .mcp-client-data/outputs
 */
function mergeEnvironment(customEnv?: Record<string, string>): Record<string, string> {
  // Default safe environment variables (matching SDK's DEFAULT_INHERITED_ENV_VARS)
  const defaultEnvVars = process.platform === 'win32'
    ? ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE']
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

  // Start with default environment
  const mergedEnv: Record<string, string> = {};
  for (const key of defaultEnvVars) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith('()')) {
      mergedEnv[key] = value;
    }
  }

  // Add MCP_CLIENT_OUTPUT_DIR pointing to .mcp-client-data/outputs
  const outputsDir = join(CONFIG_DIR, 'outputs');
  // Ensure outputs directory exists
  if (!existsSync(outputsDir)) {
    mkdirSync(outputsDir, { recursive: true });
  }
  mergedEnv['MCP_CLIENT_OUTPUT_DIR'] = outputsDir;

  // Override with custom environment variables
  if (customEnv) {
    Object.assign(mergedEnv, customEnv);
  }

  return mergedEnv;
}

function getDefaultConfig(): ClientConfig {
  return {
    servers: {},
  };
}

function loadConfig(): ClientConfig {
  // First, try to load from local mcp_config.json (Anthropic Desktop format)
  if (existsSync(LOCAL_CONFIG_FILE)) {
    try {
      const content = readFileSync(LOCAL_CONFIG_FILE, 'utf-8');
      const anthropicConfig: AnthropicDesktopConfig = JSON.parse(content);

      if (anthropicConfig.mcpServers) {
        // Convert Anthropic Desktop format to our format
        const servers: Record<string, ServerConfig> = {};
        for (const [name, server] of Object.entries(anthropicConfig.mcpServers)) {
          // Skip disabled servers
          if (server.disabled) {
            continue;
          }
          servers[name] = {
            command: server.command,
            args: server.args || [],
            env: mergeEnvironment(server.env),
          };
        }

        // Set first enabled server as default if none exists
        const enabledServers = Object.keys(servers);
        return {
          servers,
          defaultServer: enabledServers.length > 0 ? enabledServers[0] : undefined,
        };
      }
    } catch (error) {
      console.error('Error reading local config file:', error);
    }
  }

  // Fall back to user config file
  if (existsSync(CONFIG_FILE)) {
    try {
      const content = readFileSync(CONFIG_FILE, 'utf-8');
      const config = JSON.parse(content);

      // Check if it's Anthropic Desktop format
      if (config.mcpServers) {
        const servers: Record<string, ServerConfig> = {};
        const anthropicConfig = config as AnthropicDesktopConfig;
        for (const [name, server] of Object.entries(anthropicConfig.mcpServers)) {
          if (server.disabled) {
            continue;
          }
          servers[name] = {
            command: server.command,
            args: server.args || [],
            env: mergeEnvironment(server.env),
          };
        }
        const enabledServers = Object.keys(servers);
        return {
          servers,
          defaultServer: enabledServers.length > 0 ? enabledServers[0] : undefined,
        };
      }

      // Otherwise, assume it's our format
      return config;
    } catch (error) {
      console.error('Error reading config file, using defaults:', error);
    }
  }

  return getDefaultConfig();
}

function saveConfig(config: ClientConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function listServers(config: ClientConfig): void {
  const servers = Object.keys(config.servers);
  if (servers.length === 0) {
    console.log('No enabled servers found.');
    console.log('Check your mcp_config.json file.');
    return;
  }

  console.log('\nAvailable servers:');
  servers.forEach((name) => {
    const server = config.servers[name];
    const isDefault = config.defaultServer === name ? ' (default)' : '';
    console.log(`  ${name}${isDefault}`);
    console.log(`    Command: ${server.command}`);
    console.log(`    Args: ${server.args.join(' ')}`);
  });
  console.log();
  console.log('Note: Disabled servers are automatically filtered out.');
  console.log();
}

async function listModels(provider: ModelProvider): Promise<void> {
  try {
    console.log(`\nFetching available models from ${provider.getProviderName()}...\n`);
    let models: ModelInfo[];
    try {
      models = await provider.listAvailableModels();
    } catch (error: any) {
      // Handle case where model discovery isn't supported (e.g., Anthropic)
      if (error.message && error.message.includes('does not provide')) {
        console.error(`\n${error.message}\n`);
        console.log('To use a specific model, provide it with --model=<model-id>');
        console.log('Example: --model=claude-3-5-sonnet-20241022\n');
        return;
      }
      throw error;
    }
    
    if (models.length === 0) {
      console.log('No models found.');
      return;
    }

    console.log(`Available models (${models.length}):\n`);
    let defaultModel: string | null = null;
    try {
      defaultModel = provider.getDefaultModel();
    } catch {
      // No default model available
    }
    
    models.forEach((model, index) => {
      const isDefault = defaultModel && model.id === defaultModel ? ' (default)' : '';
      console.log(`  ${index + 1}. ${model.id}${isDefault}`);
      if (model.description) {
        console.log(`     ${model.description}`);
      }
      if (model.contextWindow) {
        const contextWindowK = Math.round(model.contextWindow / 1000);
        console.log(`     Context window: ${contextWindowK}K tokens`);
      }
      if (model.capabilities && model.capabilities.length > 0) {
        console.log(`     Capabilities: ${model.capabilities.join(', ')}`);
      }
      console.log();
    });
    
    console.log('Usage:');
    console.log(`  --model=<model-id> to use a specific model`);
    console.log(`  --select-model for interactive model selection\n`);
  } catch (error) {
    console.error('Failed to list models:', error);
    process.exit(1);
  }
}

async function selectProvider(): Promise<ModelProvider> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, resolve);
    });
  };

  try {
    const providers = [
      { name: 'anthropic', label: 'Anthropic (Claude)', defaultModel: 'claude-haiku-4-5-20251001' },
      { name: 'openai', label: 'OpenAI (GPT)', defaultModel: 'gpt-5-mini' },
      { name: 'gemini', label: 'Google Gemini', defaultModel: 'gemini-2.5-flash' },
      { name: 'ollama', label: 'Ollama (Local LLMs)', defaultModel: 'llama3.2:3b' },
    ];

    console.log('\nAvailable providers:\n');
    providers.forEach((provider, index) => {
      console.log(`  ${index + 1}. ${provider.label}`);
      console.log(`     Default model: ${provider.defaultModel}`);
      console.log();
    });

    while (true) {
      const answer = await question('Select a provider (1-4): ');
      const trimmed = answer.trim();
      
      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= providers.length) {
        const selectedProviderName = providers[num - 1].name;
        rl.close();
        const provider = createProvider(selectedProviderName);
        if (!provider) {
          throw new Error(`Failed to create provider: ${selectedProviderName}`);
        }
        return provider;
      }
      
      console.log(`Invalid selection. Please enter a number between 1 and ${providers.length}.`);
    }
  } catch (error) {
    rl.close();
    throw error;
  }
}

async function selectModel(provider: ModelProvider): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, resolve);
    });
  };

  try {
    console.log(`\nFetching available models from ${provider.getProviderName()}...\n`);
    let models: ModelInfo[];
    try {
      models = await provider.listAvailableModels();
    } catch (error: any) {
      // Handle case where model discovery isn't supported (e.g., Anthropic)
      if (error.message && error.message.includes('does not provide')) {
        console.error(`\n${error.message}\n`);
        console.log('To use a specific model, provide it with --model=<model-id>');
        console.log('Example: --model=claude-3-5-sonnet-20241022\n');
        rl.close();
        process.exit(1);
      }
      throw error;
    }
    
    if (models.length === 0) {
      console.log('No models found.');
      rl.close();
      process.exit(1);
    }

    let defaultModel: string | null = null;
    try {
      defaultModel = provider.getDefaultModel();
    } catch {
      // No default model available
    }
    
    console.log(`Available models (${models.length}):\n`);
    models.forEach((model, index) => {
      const isDefault = defaultModel && model.id === defaultModel ? ' (default)' : '';
      console.log(`  ${index + 1}. ${model.id}${isDefault}`);
      if (model.description) {
        console.log(`     ${model.description}`);
      }
      if (model.contextWindow) {
        const contextWindowK = Math.round(model.contextWindow / 1000);
        console.log(`     Context window: ${contextWindowK}K tokens`);
      }
      if (model.capabilities && model.capabilities.length > 0) {
        console.log(`     Capabilities: ${model.capabilities.join(', ')}`);
      }
      console.log();
    });

    while (true) {
      const defaultModelText = defaultModel || 'none';
      const answer = await question(`Select a model (1-${models.length})${defaultModelText !== 'none' ? ` or press Enter for default [${defaultModelText}]` : ''}: `);
      const trimmed = answer.trim();
      
      if (!trimmed) {
        // User pressed Enter, use default
        if (defaultModelText === 'none' || !defaultModel) {
          console.error('\nError: No default model available. Please select a model by number.');
          continue;
        }
        rl.close();
        return defaultModel;
      }

      const selection = parseInt(trimmed, 10);
      if (selection >= 1 && selection <= models.length) {
        const selectedModel = models[selection - 1];
        console.log(`\n✓ Selected model: ${selectedModel.id}\n`);
        rl.close();
        return selectedModel.id;
      }

      console.log(`\nInvalid selection. Please enter a number between 1 and ${models.length}.\n`);
    }
  } catch (error) {
    console.error('Failed to select model:', error);
    rl.close();
    process.exit(1);
  }
}

// Check for required environment variables based on provider
function checkRequiredEnvVars(provider?: string) {
  const providerName = provider?.toLowerCase() || 'anthropic';
  
  if (providerName === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      console.error(
        '\x1b[31mError: OPENAI_API_KEY environment variable is required for OpenAI provider\x1b[0m',
      );
      console.error('Please set it before running the CLI:');
      console.error('  export OPENAI_API_KEY=your_key_here');
      process.exit(1);
    }
  } else if (providerName === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        '\x1b[31mError: ANTHROPIC_API_KEY environment variable is required for Anthropic provider\x1b[0m',
      );
      console.error('Please set it before running the CLI:');
      console.error('  export ANTHROPIC_API_KEY=your_key_here');
      process.exit(1);
    }
  } else if (providerName === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      console.error(
        '\x1b[31mError: GEMINI_API_KEY environment variable is required for Gemini provider\x1b[0m',
      );
      console.error('Please set it before running the CLI:');
      console.error('  export GEMINI_API_KEY=your_key_here');
      process.exit(1);
    }
  } else if (providerName === 'ollama') {
    // Ollama doesn't require an API key - it's local
    // We'll check if the server is running later
  } else {
    console.error(`Error: Unknown provider "${providerName}". Available: anthropic, openai, gemini, ollama`);
    process.exit(1);
  }
}

// Create provider instance based on provider name
function createProvider(providerName?: string): ModelProvider | undefined {
  if (!providerName) {
    return undefined; // Will default to Anthropic
  }
  
  const name = providerName.toLowerCase();
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider();
    case 'openai':
      return new OpenAIProvider();
    case 'gemini':
      return new GeminiProvider();
    case 'ollama':
      // Use OLLAMA_HOST env var or default to localhost:11434
      return new OllamaProvider(process.env.OLLAMA_HOST);
    default:
      console.error(`Error: Unknown provider "${providerName}". Available: anthropic, openai, gemini, ollama`);
      process.exit(1);
  }
}

// Check if Ollama server is running (async helper)
async function checkOllamaServer(provider: ModelProvider): Promise<void> {
  if (provider.getProviderName() === 'ollama') {
    const ollamaProvider = provider as OllamaProvider;
    const isRunning = await ollamaProvider.isServerRunning();
    if (!isRunning) {
      const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
      console.error('\x1b[31mError: Ollama server is not running\x1b[0m');
      console.error(`\nCannot connect to Ollama at ${host}`);
      console.error('\nTo start Ollama, run:');
      console.error('  ollama serve');
      console.error('\nTo use a different host, set the OLLAMA_HOST environment variable:');
      console.error('  export OLLAMA_HOST=http://localhost:11434');
      process.exit(1);
    }
  }
}

// Check if Ollama model supports thinking mode and prompt user
async function checkOllamaThinkingMode(provider: ModelProvider, model: string): Promise<boolean> {
  if (provider.getProviderName() !== 'ollama') {
    return false;
  }
  
  const ollamaProvider = provider as OllamaProvider;
  const supportsThinking = await ollamaProvider.supportsThinkingMode(model);
  
  if (!supportsThinking) {
    return false;
  }
  
  // Prompt user to enable thinking mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve) => {
    console.log(`\n✨ Model "${model}" supports thinking mode.`);
    rl.question('Enable thinking mode? (y/n) [n]: ', (answer) => {
      rl.close();
      const enabled = answer.trim().toLowerCase() === 'y';
      if (enabled) {
        console.log('Thinking mode enabled.\n');
      }
      resolve(enabled);
    });
  });
}

async function main() {
  try {
    const args = parseArgs({
      options: {
        'server': { type: 'string', short: 's' },
        'servers': { type: 'string', multiple: true },
        'all': { type: 'boolean' },
        'list-servers': { type: 'boolean' },
        'list-models': { type: 'boolean' },
        'provider': { type: 'string' },
        'model': { type: 'string' },
        'select-model': { type: 'boolean' },
      },
      allowPositionals: true,
    });

    const config = loadConfig();

    // Handle list-servers command (doesn't need API key)
    if (args.values['list-servers']) {
      listServers(config);
      return;
    }

    // Determine provider early (for env var checks)
    const providerName = args.values['provider'];
    const provider = createProvider(providerName);

    // Handle list-models command (needs API key or Ollama server)
    if (args.values['list-models']) {
      if (!provider) {
        console.error('Error: --provider is required when listing models.');
        console.error('Use --provider=anthropic, --provider=openai, or --provider=ollama');
        process.exit(1);
      }
      checkRequiredEnvVars(providerName);
      await checkOllamaServer(provider);
      await listModels(provider);
      return;
    }

    // Handle select-model flag (needs API key or Ollama server)
    let selectedModel = args.values['model'];
    if (args.values['select-model']) {
      if (!provider) {
        console.error('Error: --provider is required when selecting models.');
        console.error('Use --provider=anthropic, --provider=openai, or --provider=ollama');
        process.exit(1);
      }
      checkRequiredEnvVars(providerName);
      await checkOllamaServer(provider);
      selectedModel = await selectModel(provider);
    }

    // Determine which server(s) to use
    const serversArg = args.values['servers'];
    const allServers = args.values['all'];
    
    // For actual client usage, require API key or Ollama server
    // Skip early check for --all mode when no provider is specified (will prompt for provider)
    if (!(allServers && !provider)) {
      checkRequiredEnvVars(providerName);
      if (provider) {
        await checkOllamaServer(provider);
      }
    }
    const serverName = args.values['server'] || config.defaultServer;

    // Handle multiple servers
    if (serversArg && serversArg.length > 0) {
      // Use multiple specified servers
      const serverConfigs = serversArg.flatMap((name) => {
        const server = config.servers[name];
        if (!server) {
          console.error(`Error: Server "${name}" not found.`);
          console.error('Use --list-servers to see available servers.');
          process.exit(1);
        }
        return [{
          name,
          config: {
            command: server.command,
            args: server.args,
            env: mergeEnvironment(server.env),
          }
        }];
      });

      if (serverConfigs.length === 0) {
        console.error('Error: No valid servers specified.');
        process.exit(1);
      }

      const cli = new MCPClientCLI(serverConfigs, {
        provider,
        model: selectedModel,
      });
      await cli.start();
      return;
    }

    // Handle --all flag: load all servers but only connect enabled ones
    if (allServers) {
      // If no provider is specified, prompt user to select one
      let finalProvider = provider;
      let finalProviderName = providerName;
      
      if (!finalProvider) {
        finalProvider = await selectProvider();
        finalProviderName = finalProvider.getProviderName();
        // Check env vars and Ollama server for the selected provider
        checkRequiredEnvVars(finalProviderName);
        await checkOllamaServer(finalProvider);
      }

      // Load ALL servers from mcp_config.json (including disabled ones for on-demand connection)
      // But only enabled servers will be connected initially
      let allServerConfigs: Array<{ name: string; config: any; disabledInConfig?: boolean }> = [];

      // Try to load from mcp_config.json to get all servers (enabled + disabled)
      if (existsSync(LOCAL_CONFIG_FILE)) {
        try {
          const content = readFileSync(LOCAL_CONFIG_FILE, 'utf-8');
          const anthropicConfig: AnthropicDesktopConfig = JSON.parse(content);

          if (anthropicConfig.mcpServers) {
            // Load ALL servers, marking disabled ones
            allServerConfigs = Object.entries(anthropicConfig.mcpServers).map(([name, server]) => ({
              name,
              config: {
                command: server.command,
                args: server.args || [],
                env: mergeEnvironment(server.env),
              },
              disabledInConfig: server.disabled || false, // Track disabled status
            }));
          }
        } catch (error) {
          console.error('Error reading mcp_config.json for --all:', error);
        }
      }

      // Fallback to enabled servers from config if we couldn't load from file
      if (allServerConfigs.length === 0) {
        allServerConfigs = Object.entries(config.servers).map(([name, server]) => ({
          name,
          config: {
            command: server.command,
            args: server.args,
            env: mergeEnvironment(server.env),
          },
          disabledInConfig: false,
        }));
      }

      if (allServerConfigs.length === 0) {
        console.error('Error: No servers found.');
        console.error('Use --list-servers to see available servers.');
        process.exit(1);
      }

      const cli = new MCPClientCLI(allServerConfigs, {
        provider: finalProvider,
        model: selectedModel,
      });
      await cli.start();
      return;
    }

    // Single server mode
    if (!serverName) {
      console.error('Error: No server specified.');
      console.error(
        'Use --server <name> to use a configured server, --servers <name1> <name2> ... to use multiple servers, or --all to use all enabled servers.',
      );
      console.error('Use --list-servers to see available servers.');
      process.exit(1);
    }

    // Use server from config
    const server = config.servers[serverName];
    if (!server) {
      console.error(`Error: Server "${serverName}" not found.`);
      console.error('Use --list-servers to see available servers.');
      process.exit(1);
    }

    const serverCommand = server.command;
    const serverArgs = server.args;
    const serverEnv = server.env;

    const cli = new MCPClientCLI({
      command: serverCommand,
      args: serverArgs,
      env: mergeEnvironment(serverEnv),
    }, {
      provider,
      model: selectedModel,
    });

    await cli.start();
  } catch (error) {
    console.error('Failed to start CLI:', error);
    process.exit(1);
  }
}

main();
