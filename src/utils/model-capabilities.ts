// Reference: https://github.com/paradite/llm-info
// Model reasoning/thinking capability detection using llm-info package.
// Mirrors the pattern of model-pricing.ts — third-party data with hardcoded fallback.

import { ModelInfoMap } from 'llm-info';

export interface ThinkingSupport {
  supportsThinking: boolean;
}

// Provider-specific thinking level options
export type OpenAIThinkingLevel = 'low' | 'medium' | 'high';
export type AnthropicThinkingLevel = 'small' | 'medium' | 'large';
export type GeminiThinkingLevel = 'minimal' | 'dynamic' | 'generous';
export type OllamaThinkingLevel = 'on';
export type ThinkingLevel = OpenAIThinkingLevel | AnthropicThinkingLevel | GeminiThinkingLevel | OllamaThinkingLevel;

// Anthropic budget tokens mapping
export const ANTHROPIC_BUDGET_TOKENS: Record<AnthropicThinkingLevel, number> = {
  small: 5000,
  medium: 10000,
  large: 25000,
};

// Gemini budget tokens mapping
// Pro can't disable thinking, minimum is 128
// Flash can go as low as 0 (disabled)
export const GEMINI_BUDGET_TOKENS: Record<GeminiThinkingLevel, number | undefined> = {
  minimal: 128,    // Minimum for Pro, conservative for Flash
  dynamic: undefined, // Omit — let Gemini choose dynamically (default)
  generous: 24576,
};

// Fallback map for models not in llm-info
const REASONING_FALLBACK: Record<string, boolean> = {
  // OpenAI
  'o1-preview': true,
  'o1': true,
  'o1-mini': true,
  'o3': true,
  'o3-mini': true,
  'o4-mini': true,
  'gpt-5': true,
  'gpt-5-mini': true,
  'gpt-5-nano': true,
  'gpt-5-codex': true,
  // Google
  'gemini-2.5-pro': true,
  'gemini-2.5-flash': true,
  // xAI
  'grok-4': true,
};

/**
 * Check if a model supports thinking/reasoning.
 * Uses llm-info package as the primary source, with hardcoded fallback.
 */
export function getModelThinkingSupport(modelId: string, _providerName?: string): ThinkingSupport {
  // 1. Try exact match in llm-info
  const info = (ModelInfoMap as Record<string, any>)[modelId];
  if (info && typeof info.reasoning === 'boolean') {
    return { supportsThinking: info.reasoning };
  }

  // 2. Try prefix match in llm-info (e.g. "gpt-5-chat-latest" → "gpt-5")
  for (const [key, value] of Object.entries(ModelInfoMap as Record<string, any>)) {
    if (modelId.startsWith(key) && typeof value.reasoning === 'boolean') {
      return { supportsThinking: value.reasoning };
    }
  }

  // 3. Hardcoded fallback
  if (modelId in REASONING_FALLBACK) {
    return { supportsThinking: REASONING_FALLBACK[modelId] };
  }

  // 4. Prefix match on fallback
  for (const [key, value] of Object.entries(REASONING_FALLBACK)) {
    if (modelId.startsWith(key)) {
      return { supportsThinking: value };
    }
  }

  return { supportsThinking: false };
}

/**
 * Boolean convenience helper.
 */
export function isReasoningModel(modelId: string, providerName?: string): boolean {
  return getModelThinkingSupport(modelId, providerName).supportsThinking;
}

/**
 * Get the available thinking levels for a provider.
 */
export function getThinkingLevelsForProvider(providerName: string): { value: ThinkingLevel; label: string }[] {
  switch (providerName) {
    case 'openai':
      return [
        { value: 'low', label: 'Low (minimal reasoning, cheapest)' },
        { value: 'medium', label: 'Medium (balanced)' },
        { value: 'high', label: 'High (maximum reasoning)' },
      ];
    case 'xai':
      return [
        { value: 'low', label: 'Low (minimal reasoning, cheapest)' },
        { value: 'medium', label: 'Medium (balanced)' },
        { value: 'high', label: 'High (maximum reasoning)' },
      ];
    case 'anthropic':
      return [
        { value: 'small', label: 'Small (~5K budget tokens)' },
        { value: 'medium', label: 'Medium (~10K budget tokens)' },
        { value: 'large', label: 'Large (~25K budget tokens)' },
      ];
    case 'google':
      return [
        { value: 'minimal', label: 'Minimal (128 token budget)' },
        { value: 'dynamic', label: 'Dynamic (model chooses)' },
        { value: 'generous', label: 'Generous (~24K token budget)' },
      ];
    case 'ollama':
      return [
        { value: 'on', label: 'On (enable thinking tags)' },
      ];
    default:
      return [];
  }
}
