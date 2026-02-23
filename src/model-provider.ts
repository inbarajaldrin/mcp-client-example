// Generic Model Provider Abstraction
// This file defines the interface that all model providers must implement
// Supports LLMs, VLMs, and other AI model types

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string; // Accumulated thinking/reasoning content from model
  tool_call_id?: string; // For OpenAI tool result messages
  tool_name?: string; // For Ollama tool result messages
  tool_calls?: ToolCall[]; // For assistant messages that contain tool calls (OpenAI-specific)
  tool_results?: Array<{ // For Anthropic tool result messages
    type: 'tool_result';
    tool_use_id: string;
    tool_name?: string; // Optional tool name for Gemini compatibility
    content: string | Array<{ type: string; [key: string]: any }>; // String or content blocks (for images)
  }>;
  // For Anthropic: store raw content blocks to preserve tool_use blocks
  content_blocks?: Array<{ type: string; [key: string]: any }>;
}

// Generic Tool interface (provider-agnostic)
export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
  };
}

// Token usage information
export interface TokenUsage {
  current: number;
  limit: number;
  percentage: number;
  suggestion: 'continue' | 'warn' | 'break';
}

// Summarization configuration
export interface SummarizationConfig {
  threshold: number; // Percentage (0-100) at which to trigger summarization
  recentMessagesToKeep: number; // Number of recent messages to preserve
  enabled: boolean; // Whether auto-summarization is enabled
}

// Generic stream event types
export interface MessageStreamEvent {
  type: string;
  [key: string]: any;
}

// Abstract TokenCounter interface
export interface TokenCounter {
  countTokens(text: string): number;
  countMessageTokens(message: { role: string; content: string }): number;
  getUsage(currentTokens: number): TokenUsage;
  shouldSummarize(currentTokens: number): boolean;
  getContextWindow(): number;
  getModelName(): string;
  getConfig(): SummarizationConfig;
  updateConfig(config: Partial<SummarizationConfig>): void;
}

// Thinking/reasoning configuration passed to providers
export interface ThinkingConfig {
  enabled: boolean;
  model: string;
  level?: string; // Thinking level: 'small'|'medium'|'large' for Anthropic budget_tokens,
                  // 'low'|'medium'|'high' for OpenAI/xAI reasoning_effort
}

// Thinking content block from model responses (Anthropic extended thinking)
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;      // Thinking/reasoning text (summary for Claude 4 models)
  signature?: string;    // Encrypted full thinking content (for multi-turn verification)
}

// Redacted thinking block (when content is filtered)
export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;          // Encrypted redacted content
}

// Model information returned by listAvailableModels
export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  capabilities?: string[];
  reasoning?: boolean; // Whether model supports thinking/reasoning
}

// Abstract ModelProvider interface
// Supports LLMs, VLMs, and other AI model types
// TODO: Add system prompt support to the interface and all provider implementations.
//   Currently only Anthropic has a `system` param (in createMessageStreamWithToolUse) but it's
//   never called with a value. All providers' APIs support system prompts:
//     - Anthropic: `system` param (top-level, separate from messages)
//     - OpenAI/xAI: `system` role message (prepended to messages array)
//     - Google Gemini: `systemInstruction` param (top-level)
//     - Ollama: `system` role message (prepended to messages array)
//   Research shows system prompts improve rule-following for OpenAI/xAI/Google/Ollama,
//   but Claude actually prioritizes user messages over system prompts.
//   For ablation phases with clearContextBetweenPhases=false, system prompt should be
//   replaced (not stacked) on each phase. Consider adding a `systemPrompt` field to the
//   ablation definition schema and threading it through processQuery -> provider calls.
export interface ModelProvider {
  // Create a streaming message completion
  createMessageStream(
    messages: Message[],
    model: string,
    tools: Tool[],
    maxTokens: number,
  ): AsyncIterable<MessageStreamEvent>;

  // Get the Tool type for this provider (for type compatibility)
  getToolType(): any;

  // Get default model name
  getDefaultModel(): string;

  // Get provider identifier
  getProviderName(): string;

  // Create a token counter for the given model
  // Must be async to fetch context window from API
  createTokenCounter(
    model: string,
    config?: Partial<SummarizationConfig>,
  ): Promise<TokenCounter>;

  // Get context window size for a model
  getContextWindow(model: string): number;

  // List available models from the provider API
  listAvailableModels(): Promise<ModelInfo[]>;

  // Set thinking/reasoning configuration for subsequent API calls
  setThinkingConfig?(config: ThinkingConfig): void;

  // Unload a model from memory (e.g., Ollama keep_alive: 0)
  unloadModel?(model: string): Promise<void>;
}

