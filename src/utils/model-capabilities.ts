// Reference: https://github.com/paradite/llm-info
// Model reasoning/thinking capability detection.
// Each provider has its own thinking mechanism — this map tracks which models support it.
// llm-info's reasoning flag is used as a supplementary signal, not the sole source.

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

// Canonical map of models that support thinking/reasoning.
// Each provider implements thinking differently:
//   OpenAI: reasoning_effort param (low/medium/high)
//   Anthropic: thinking: { type: 'enabled', budget_tokens } — extended thinking
//   Google: thinkingConfig: { thinkingBudget } — thinking budget
//   xAI: reasoning_effort on grok-3-mini only; grok-4 has built-in reasoning (no API control)
//   Ollama: think: true flag
const REASONING_MODELS: Record<string, boolean> = {
  // OpenAI — reasoning_effort supported on all these
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
  // Anthropic — extended thinking via budget_tokens
  'claude-sonnet-4': true,
  'claude-opus-4': true,
  'claude-haiku-4-5': true,
  'claude-sonnet-4-5': true,
  'claude-opus-4-5': true,
  // Google — thinkingConfig budget
  'gemini-2.5-pro': true,
  'gemini-2.5-flash': true,
  'gemini-3-pro': true,
  // xAI — grok-4 has built-in reasoning, grok-3-mini supports reasoning_effort
  'grok-3-mini': true,
  'grok-4': true,
};

/**
 * Check if a model supports thinking/reasoning.
 * Checks our canonical map first (exact then prefix), then llm-info as supplementary.
 */
export function getModelThinkingSupport(modelId: string, _providerName?: string): ThinkingSupport {
  // 1. Exact match in our map
  if (modelId in REASONING_MODELS) {
    return { supportsThinking: REASONING_MODELS[modelId] };
  }

  // 2. Prefix match on our map (longest key first to avoid false positives)
  const sortedModels = Object.entries(REASONING_MODELS)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [key, value] of sortedModels) {
    if (modelId.startsWith(key)) {
      return { supportsThinking: value };
    }
  }

  // 3. Supplementary: check llm-info for models we don't explicitly track
  const info = (ModelInfoMap as Record<string, any>)[modelId];
  if (info && typeof info.reasoning === 'boolean') {
    return { supportsThinking: info.reasoning };
  }

  // 4. Prefix match in llm-info (longest key first)
  const sortedEntries = Object.entries(ModelInfoMap as Record<string, any>)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [key, value] of sortedEntries) {
    if (modelId.startsWith(key) && typeof value.reasoning === 'boolean') {
      return { supportsThinking: value.reasoning };
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
      // Only grok-3-mini supports reasoning_effort (low/high)
      // grok-4 and grok-4-fast-reasoning have built-in reasoning that can't be controlled
      return [
        { value: 'low', label: 'Low (minimal thinking, faster)' },
        { value: 'high', label: 'High (maximum thinking)' },
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
