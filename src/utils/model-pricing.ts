/**
 * Model pricing data for LLM cost calculations.
 *
 * NOTE: This file is a FALLBACK. The primary pricing source is @pydantic/genai-prices,
 * a community-maintained package with up-to-date pricing for 700+ models across 29 providers.
 * This hardcoded data is only used when the package doesn't have pricing for a model.
 *
 * Prices are in USD per 1 million tokens.
 *
 * Sources:
 * - Anthropic: https://www.anthropic.com/pricing (updated January 2026)
 * - OpenAI: https://platform.openai.com/docs/models (updated January 2026)
 * - Google Gemini: https://ai.google.dev/gemini-api/docs/pricing (updated January 2026)
 * - xAI Grok: https://docs.x.ai/docs/models (updated February 2026)
 *
 * Note: Pricing may vary by context window size (e.g., >200K tokens for Sonnet 4.5, >128K for Gemini 1.5)
 * Cache pricing: Anthropic uses 10% of input price (90% discount), OpenAI varies by model
 */

export interface ModelPricing {
  input: number;
  output: number;
  inputLongContext?: number;
  outputLongContext?: number;
  cachedInput?: number;
  longContextThreshold?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ========== Anthropic Claude Models ==========
  // Claude 4.5 Opus
  'claude-opus-4-5-20251101': { input: 5.00, output: 25.00, cachedInput: 0.50 }, // 10% discount
  'claude-4-5-opus': { input: 5.00, output: 25.00, cachedInput: 0.50 },

  // Claude Sonnet 4.5 (standard: 0-200K tokens, long context: >200K tokens)
  'claude-sonnet-4-5-20251101': { input: 3.00, output: 15.00, inputLongContext: 6.00, outputLongContext: 22.50, cachedInput: 0.30 },
  'claude-3-7-sonnet-latest': { input: 3.00, output: 15.00, inputLongContext: 6.00, outputLongContext: 22.50, cachedInput: 0.30 },
  'claude-3-7-sonnet-20250219': { input: 3.00, output: 15.00, inputLongContext: 6.00, outputLongContext: 22.50, cachedInput: 0.30 },

  // Claude 3.5 Sonnet
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00, cachedInput: 0.30 },
  'claude-3-5-sonnet-20240620': { input: 3.00, output: 15.00, cachedInput: 0.30 },
  'claude-3-5-sonnet-latest': { input: 3.00, output: 15.00, cachedInput: 0.30 },

  // Claude Haiku 4.5 (updated January 2026)
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, cachedInput: 0.10 },
  'claude-3-5-haiku-20241022': { input: 1.00, output: 5.00, cachedInput: 0.10 },
  'claude-3-5-haiku-latest': { input: 1.00, output: 5.00, cachedInput: 0.10 },

  // Claude 3 Opus (legacy)
  'claude-3-opus-20240229': { input: 15.00, output: 75.00, cachedInput: 1.50 },

  // Claude 3 Sonnet (legacy)
  'claude-3-sonnet-20240229': { input: 3.00, output: 15.00, cachedInput: 0.30 },

  // Claude 3 Haiku (legacy)
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25, cachedInput: 0.025 },

  // ========== OpenAI Models ==========
  // GPT-5 and GPT-5-Codex
  'gpt-5': { input: 1.25, output: 10.00, cachedInput: 0.125 }, // 10% discount
  'gpt-5-chat-latest': { input: 1.25, output: 10.00, cachedInput: 0.125 },
  'gpt-5-codex': { input: 1.25, output: 10.00, cachedInput: 0.125 },

  // GPT-5 Mini
  'gpt-5-mini': { input: 0.25, output: 2.00, cachedInput: 0.025 }, // 10% discount
  'gpt-5-mini-latest': { input: 0.25, output: 2.00, cachedInput: 0.025 },

  // ChatGPT-4o
  'chatgpt-4o-latest': { input: 5.00, output: 15.00 },

  // GPT-4o
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-2024-08-06': { input: 2.50, output: 10.00 },
  'gpt-4o-2024-05-13': { input: 2.50, output: 10.00 },

  // GPT-4o mini (added cached input pricing January 2026)
  'gpt-4o-mini': { input: 0.15, output: 0.60, cachedInput: 0.075 }, // 50% discount
  'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.60, cachedInput: 0.075 },

  // GPT-4o mini Realtime
  'gpt-4o-mini-realtime-preview': { input: 0.60, output: 2.40, cachedInput: 0.30 }, // 50% discount

  // GPT-4 Turbo
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4-turbo-2024-04-09': { input: 10.00, output: 30.00 },

  // GPT-4 (legacy)
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-4-32k': { input: 60.00, output: 120.00 },

  // o1 series (reasoning models)
  'o1-preview': { input: 15.00, output: 60.00, cachedInput: 7.50 }, // 50% discount
  'o1-mini': { input: 3.00, output: 12.00, cachedInput: 1.50 }, // 50% discount
  'o1-pro': { input: 15.00, output: 60.00, cachedInput: 7.50 },

  // o3 series (updated January 2026 - significantly cheaper than o1)
  'o3': { input: 2.00, output: 8.00, cachedInput: 0.50 }, // 25% discount on cache
  'o3-mini': { input: 1.10, output: 4.40, cachedInput: 0.275 },

  // GPT-3.5 Turbo
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'gpt-3.5-turbo-16k': { input: 0.50, output: 1.50 },

  // ========== Google Gemini Models ==========
  // Gemini 2.5 Pro (standard: 0-200K tokens, long context: >200K tokens)
  'gemini-2.5-pro': { input: 1.25, output: 10.00, inputLongContext: 2.50, outputLongContext: 15.00, cachedInput: 0.125, longContextThreshold: 200_000 },

  // Gemini 2.5 Flash (flat pricing, no tiered pricing)
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },

  // Gemini 2.0 Flash (flat pricing, no tiered pricing)
  'gemini-2.0-flash': { input: 0.10, output: 0.40, cachedInput: 0.025 },

  // Gemini 1.5 Pro (standard: 0-128K tokens, long context: >128K tokens)
  'gemini-1.5-pro': { input: 1.25, output: 5.00, inputLongContext: 2.50, outputLongContext: 10.00, cachedInput: 0.625, longContextThreshold: 128_000 },

  // Gemini 1.5 Flash (standard: 0-128K tokens, long context: >128K tokens)
  'gemini-1.5-flash': { input: 0.075, output: 0.30, inputLongContext: 0.15, outputLongContext: 0.60, longContextThreshold: 128_000 },

  // Gemini Robotics ER 1.5 Preview (flat pricing, no tiered pricing)
  'gemini-robotics-er-1.5-preview': { input: 0.30, output: 2.50 },

  // ========== xAI Grok Models ==========
  // Grok 4
  'grok-4': { input: 3.00, output: 15.00, cachedInput: 0.75 },

  // Grok 4 Fast (2M context)
  'grok-4-fast': { input: 0.20, output: 0.50, cachedInput: 0.05 },
};
