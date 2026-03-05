// Reference: https://models.dev
// Model reasoning/thinking capability detection.
// Each provider has its own thinking mechanism — models.dev provides the reasoning flag.
// Thinking levels and budgets are our own config (not from models.dev).

import { getModelInfo } from './models-dev.js';

export interface ThinkingSupport {
  supportsThinking: boolean;
}

// Provider-specific thinking level options
export type OpenAIThinkingLevel = 'none' | 'low' | 'medium' | 'high';
export type AnthropicThinkingLevel = 'adaptive' | 'small' | 'medium' | 'large';
export type GeminiThinkingLevel = 'minimal' | 'dynamic' | 'generous';
export type OllamaThinkingLevel = 'on';
export type ThinkingLevel = OpenAIThinkingLevel | AnthropicThinkingLevel | GeminiThinkingLevel | OllamaThinkingLevel;

// Anthropic budget tokens mapping (adaptive has no fixed budget — model decides)
export const ANTHROPIC_BUDGET_TOKENS: Partial<Record<AnthropicThinkingLevel, number>> = {
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

/**
 * Check if a model supports thinking/reasoning using models.dev data.
 */
export function getModelThinkingSupport(modelId: string, providerName?: string): ThinkingSupport {
  const info = getModelInfo(modelId, providerName);
  if (info && typeof info.reasoning === 'boolean') {
    return { supportsThinking: info.reasoning };
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
        { value: 'none', label: 'None (no reasoning)' },
        { value: 'low', label: 'Low (minimal reasoning)' },
        { value: 'medium', label: 'Medium (balanced) [default]' },
        { value: 'high', label: 'High (maximum reasoning)' },
      ];
    case 'xai':
      // Only grok-3-mini supports reasoning_effort (low/high)
      // grok-4 and grok-4-fast-reasoning have built-in reasoning that can't be controlled
      return [
        { value: 'low', label: 'Low (minimal thinking, faster) [default]' },
        { value: 'high', label: 'High (maximum thinking)' },
      ];
    case 'anthropic':
      return [
        { value: 'adaptive', label: 'Adaptive (model decides) [default]' },
        { value: 'small', label: 'Small (~5K budget tokens)' },
        { value: 'medium', label: 'Medium (~10K budget tokens)' },
        { value: 'large', label: 'Large (~25K budget tokens)' },
      ];
    case 'google':
      return [
        { value: 'minimal', label: 'Minimal (128 token budget)' },
        { value: 'dynamic', label: 'Dynamic (model chooses) [default]' },
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

/**
 * Get the default thinking level for a provider.
 * Used as fallback when thinking is enabled without an explicit level.
 */
export function getDefaultThinkingLevel(providerName: string): ThinkingLevel | undefined {
  switch (providerName) {
    case 'anthropic': return 'adaptive';
    case 'openai': return 'medium';
    case 'google': return 'dynamic';
    case 'xai': return 'low';
    case 'ollama': return 'on';
    default: return undefined;
  }
}
