// Generic Model Provider Abstraction
// This file defines the interface that all model providers must implement
// Supports LLMs, VLMs, and other AI model types

export interface Message {
  role: 'user' | 'assistant';
  content: string;
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

// Abstract ModelProvider interface
// Supports LLMs, VLMs, and other AI model types
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
  createTokenCounter(
    model: string,
    config?: Partial<SummarizationConfig>,
  ): TokenCounter;

  // Get context window size for a model
  getContextWindow(model: string): number;
}

