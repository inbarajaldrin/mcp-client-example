// Provider registry — single source of truth for available LLM providers and the
// name -> instance factory. Extracted out of bin.ts into a leaf module so core code
// (e.g. agent-actions.ts) can resolve providers by name without importing the bin
// entry point, which would create an import cycle. bin.ts re-exports these for
// backward compatibility (the web API imports them from '../bin.js').

import { AnthropicProvider, PROVIDER_INFO as ANTHROPIC } from './providers/anthropic.js';
import { OpenAIProvider, PROVIDER_INFO as OPENAI } from './providers/openai.js';
import { OllamaProvider, PROVIDER_INFO as OLLAMA } from './providers/ollama.js';
import { GeminiProvider, PROVIDER_INFO as GOOGLE } from './providers/google.js';
import { GrokProvider, PROVIDER_INFO as XAI } from './providers/xai.js';
import type { ModelProvider } from './model-provider.js';

// Assembled from individual provider exports - single source of truth
export const PROVIDERS = [ANTHROPIC, OPENAI, GOOGLE, XAI, OLLAMA];

// Create provider instance by name - used by the web API, CLI, and agent actions.
export function createProvider(providerName: string): ModelProvider | undefined {
  switch (providerName.toLowerCase()) {
    case 'anthropic':
      return new AnthropicProvider();
    case 'openai':
      return new OpenAIProvider();
    case 'google':
      return new GeminiProvider();
    case 'xai':
      return new GrokProvider();
    case 'ollama':
      return new OllamaProvider(process.env.OLLAMA_HOST);
    default:
      return undefined;
  }
}
