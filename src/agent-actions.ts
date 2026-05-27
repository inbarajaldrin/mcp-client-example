// Core agent automation actions — registered once per MCPClient into AgentRegistry.shared.
//
// Each action wraps an EXISTING core capability (the same methods the web routes and CLI
// commands already call), so the web /agent/* surface and the CLI /agent-do command stay at
// parity by construction: there is exactly one place an action is defined, and both surfaces
// invoke it through AgentRegistry.invokeAction().
//
// Run-lifecycle actions (run.start / run.abort / run.status) are registered separately by the
// shared AblationRunner (see slice 3) so they reflect a single run engine across surfaces.

import { AgentRegistry } from './managers/agent-registry.js';
import { createProvider, PROVIDERS } from './provider-registry.js';
import type { MCPClient } from './index.js'; // type-only: erased at runtime, no import cycle

export function registerCoreAgentActions(client: MCPClient): void {
  const reg = AgentRegistry.shared;

  reg.registerAction({
    id: 'status.get',
    description: 'Live status snapshot: provider, model, token usage, cost, orchestrator/todo state, and the viewState views map.',
    handler: () => client.getStatusSnapshot(),
  });

  reg.registerAction({
    id: 'providers.list',
    description: 'List available LLM providers.',
    handler: () => PROVIDERS.map((p) => ({ name: p.name, displayName: p.label || p.name })),
  });

  reg.registerAction({
    id: 'models.list',
    description: 'List available models for a provider.',
    params: [{ name: 'provider', type: 'string', required: true, description: 'Provider name (anthropic/openai/google/xai/ollama)' }],
    handler: async (p) => {
      const provider = createProvider(String(p.provider));
      if (!provider) throw new Error(`Unknown provider: ${p.provider}`);
      return await provider.listAvailableModels();
    },
  });

  reg.registerAction({
    id: 'model.select',
    description: 'Switch the active provider and model. By default preserves context; pass clearContext=true to reset.',
    params: [
      { name: 'provider', type: 'string', required: true },
      { name: 'model', type: 'string', required: true },
      { name: 'clearContext', type: 'boolean', required: false },
    ],
    handler: async (p) => {
      const provider = createProvider(String(p.provider));
      if (!provider) throw new Error(`Unknown provider: ${p.provider}`);
      if (p.clearContext) await client.switchProviderAndModel(provider, String(p.model));
      else await client.switchModel(provider, String(p.model));
      return { provider: p.provider, model: p.model };
    },
  });

  reg.registerAction({
    id: 'orchestrator.enable',
    description: 'Enable orchestrator mode (expose only mcp-tools-orchestrator tools).',
    handler: async () => {
      await client.enableOrchestratorMode();
      return { enabled: client.isOrchestratorModeEnabled() };
    },
  });

  reg.registerAction({
    id: 'orchestrator.disable',
    description: 'Disable orchestrator mode (restore all tools).',
    handler: async () => {
      await client.disableOrchestratorMode();
      return { enabled: client.isOrchestratorModeEnabled() };
    },
  });

  reg.registerAction({
    id: 'todo.disable',
    description: 'Disable todo mode.',
    handler: async () => {
      await client.disableTodoMode();
      return { enabled: client.isTodoModeEnabled() };
    },
  });

  reg.registerAction({
    id: 'servers.refresh',
    description: 'Reconnect to all MCP servers (picks up config changes).',
    handler: async () => {
      await client.refreshServers();
      return { servers: AgentRegistry.shared.getViewState('servers.connected') ?? null };
    },
  });

  reg.registerAction({
    id: 'servers.refresh-one',
    description: 'Reconnect to a single MCP server by name.',
    params: [{ name: 'name', type: 'string', required: true }],
    handler: async (p) => {
      await client.refreshServer(String(p.name));
      return { ok: true, name: p.name };
    },
  });

  reg.registerAction({
    id: 'chat.clear',
    description: 'Clear the current conversation context.',
    handler: () => {
      client.clearContext();
      return { ok: true };
    },
  });

  reg.registerAction({
    id: 'chat.restore',
    description: 'Restore a prior chat session into the live conversation by sessionId.',
    params: [{ name: 'sessionId', type: 'string', required: true }],
    handler: (p) => ({ ok: client.restoreChat(String(p.sessionId)) }),
  });
}
