#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { MCPClientCLI } from './cli-client.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import readline from 'readline';
import { ClaudeProvider } from './providers/claude.js';
import { OpenAIProvider } from './providers/openai.js';
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
}

interface ClientConfig {
  servers: Record<string, ServerConfig>;
  defaultServer?: string;
  toolStates?: Record<string, boolean>;
}

interface ClaudeDesktopConfig {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      disabled?: boolean;
      timeout?: number;
      type?: string;
    }
  >;
}

const CONFIG_DIR = join(__dirname, '..', '.mcp-client-data');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

// Try to find local mcp_config.json in mcp-client directory
const LOCAL_CONFIG_FILE = join(__dirname, '..', 'mcp_config.json');

function getDefaultConfig(): ClientConfig {
  return {
    servers: {},
  };
}

function loadConfig(): ClientConfig {
  // First, try to load from local mcp_config.json (Claude Desktop format)
  if (existsSync(LOCAL_CONFIG_FILE)) {
    try {
      const content = readFileSync(LOCAL_CONFIG_FILE, 'utf-8');
      const claudeConfig: ClaudeDesktopConfig = JSON.parse(content);

      if (claudeConfig.mcpServers) {
        // Convert Claude Desktop format to our format
        const servers: Record<string, ServerConfig> = {};
        for (const [name, server] of Object.entries(claudeConfig.mcpServers)) {
          // Skip disabled servers
          if (server.disabled) {
            continue;
          }
          servers[name] = {
            command: server.command,
            args: server.args || [],
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

      // Check if it's Claude Desktop format
      if (config.mcpServers) {
        const servers: Record<string, ServerConfig> = {};
        const claudeConfig = config as ClaudeDesktopConfig;
        for (const [name, server] of Object.entries(claudeConfig.mcpServers)) {
          if (server.disabled) {
            continue;
          }
          servers[name] = {
            command: server.command,
            args: server.args || [],
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
    console.log('Check your mcp_config.json file or use --add-server to add one.');
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
    const models = await provider.listAvailableModels();
    
    if (models.length === 0) {
      console.log('No models found.');
      return;
    }

    console.log(`Available models (${models.length}):\n`);
    models.forEach((model, index) => {
      const isDefault = model.id === provider.getDefaultModel() ? ' (default)' : '';
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
    const models = await provider.listAvailableModels();
    
    if (models.length === 0) {
      console.log('No models found.');
      rl.close();
      process.exit(1);
    }

    console.log(`Available models (${models.length}):\n`);
    models.forEach((model, index) => {
      const isDefault = model.id === provider.getDefaultModel() ? ' (default)' : '';
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
      const answer = await question(`Select a model (1-${models.length}) or press Enter for default [${provider.getDefaultModel()}]: `);
      const trimmed = answer.trim();
      
      if (!trimmed) {
        // User pressed Enter, use default
        rl.close();
        return provider.getDefaultModel();
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
  const providerName = provider?.toLowerCase() || 'claude';
  
  if (providerName === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      console.error(
        '\x1b[31mError: OPENAI_API_KEY environment variable is required for OpenAI provider\x1b[0m',
      );
      console.error('Please set it before running the CLI:');
      console.error('  export OPENAI_API_KEY=your_key_here');
      process.exit(1);
    }
  } else if (providerName === 'claude') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        '\x1b[31mError: ANTHROPIC_API_KEY environment variable is required for Claude provider\x1b[0m',
      );
      console.error('Please set it before running the CLI:');
      console.error('  export ANTHROPIC_API_KEY=your_key_here');
      process.exit(1);
    }
  } else {
    console.error(`Error: Unknown provider "${providerName}". Available: claude, openai`);
    process.exit(1);
  }
}

// Create provider instance based on provider name
function createProvider(providerName?: string): ModelProvider | undefined {
  if (!providerName) {
    return undefined; // Will default to Claude
  }
  
  const name = providerName.toLowerCase();
  switch (name) {
    case 'claude':
      return new ClaudeProvider();
    case 'openai':
      return new OpenAIProvider();
    default:
      console.error(`Error: Unknown provider "${providerName}". Available: claude, openai`);
      process.exit(1);
  }
}

async function main() {
  try {
    const args = parseArgs({
      options: {
        'server-command': { type: 'string' },
        'server-args': { type: 'string' },
        'server': { type: 'string', short: 's' },
        'servers': { type: 'string', multiple: true },
        'all': { type: 'boolean' },
        'list-servers': { type: 'boolean' },
        'list-models': { type: 'boolean' },
        'add-server': { type: 'string' },
        'remove-server': { type: 'string' },
        'set-default': { type: 'string' },
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

    // Handle list-models command (needs API key)
    if (args.values['list-models']) {
      if (!provider) {
        console.error('Error: --provider is required when listing models.');
        console.error('Use --provider=claude or --provider=openai');
        process.exit(1);
      }
      checkRequiredEnvVars(providerName);
      await listModels(provider);
      return;
    }

    // Handle select-model flag (needs API key)
    let selectedModel = args.values['model'];
    if (args.values['select-model']) {
      if (!provider) {
        console.error('Error: --provider is required when selecting models.');
        console.error('Use --provider=claude or --provider=openai');
        process.exit(1);
      }
      checkRequiredEnvVars(providerName);
      selectedModel = await selectModel(provider);
    }

    // Handle add-server, remove-server, set-default (don't need API key)
    if (args.values['add-server'] || args.values['remove-server'] || args.values['set-default']) {
      // These commands don't need API key, continue below
    } else {
      // For actual client usage, require API key
      checkRequiredEnvVars(providerName);
    }

    // Handle add-server command
    if (args.values['add-server']) {
      const serverName = args.values['add-server'];
      const serverCommand = args.values['server-command'];
      const serverArgs = args.values['server-args']?.split(' ') || [];

      if (!serverCommand) {
        console.error(
          'Error: --server-command is required when adding a server',
        );
        process.exit(1);
      }

      config.servers[serverName] = {
        command: serverCommand,
        args: serverArgs,
      };

      // Set as default if it's the first server
      if (!config.defaultServer) {
        config.defaultServer = serverName;
      }

      saveConfig(config);
      console.log(`Server "${serverName}" added successfully.`);
      return;
    }

    // Handle remove-server command
    if (args.values['remove-server']) {
      const serverName = args.values['remove-server'];
      if (!config.servers[serverName]) {
        console.error(`Error: Server "${serverName}" not found.`);
        process.exit(1);
      }

      delete config.servers[serverName];
      if (config.defaultServer === serverName) {
        config.defaultServer = undefined;
      }

      saveConfig(config);
      console.log(`Server "${serverName}" removed successfully.`);
      return;
    }

    // Handle set-default command
    if (args.values['set-default']) {
      const serverName = args.values['set-default'];
      if (!config.servers[serverName]) {
        console.error(`Error: Server "${serverName}" not found.`);
        process.exit(1);
      }

      config.defaultServer = serverName;
      saveConfig(config);
      console.log(`Default server set to "${serverName}".`);
      return;
    }

    // Determine which server(s) to use
    const serversArg = args.values['servers'];
    const allServers = args.values['all'];
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
        return [{ name, config: { command: server.command, args: server.args } }];
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

    // Handle --all flag: use all enabled servers
    if (allServers) {
      const enabledServers = Object.entries(config.servers)
        .filter(([name, server]) => !server.disabled)
        .map(([name, server]) => ({
          name,
          config: { command: server.command, args: server.args },
        }));

      if (enabledServers.length === 0) {
        console.error('Error: No enabled servers found.');
        console.error('Use --list-servers to see available servers.');
        process.exit(1);
      }

      const cli = new MCPClientCLI(enabledServers, {
        provider,
        model: selectedModel,
      });
      await cli.start();
      return;
    }

    // Single server mode (backward compatibility)
    let serverCommand: string | undefined;
    let serverArgs: string[] = [];

    if (serverName) {
      // Use server from config
      const server = config.servers[serverName];
      if (!server) {
        console.error(`Error: Server "${serverName}" not found.`);
        console.error('Use --list-servers to see available servers.');
        process.exit(1);
      }
      serverCommand = server.command;
      serverArgs = server.args;
    } else {
      // Use command-line arguments (backward compatibility)
      serverCommand = args.values['server-command'];
      serverArgs = args.values['server-args']?.split(' ') || [];
    }

    if (!serverCommand) {
      console.error('Error: No server specified.');
      console.error(
        'Use --server <name> to use a configured server, --servers <name1> <name2> ... to use multiple servers, --all to use all enabled servers, or --server-command to specify a server directly.',
      );
      console.error('Use --list-servers to see available servers.');
      process.exit(1);
    }

    const cli = new MCPClientCLI({
      command: serverCommand,
      args: serverArgs,
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
