import { Anthropic } from '@anthropic-ai/sdk';
import { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/index.mjs';
import { Stream } from '@anthropic-ai/sdk/streaming.mjs';
import { encoding_for_model, get_encoding } from 'tiktoken';
import type {
  ModelProvider,
  TokenCounter,
  Tool,
  Message,
  TokenUsage,
  SummarizationConfig,
  MessageStreamEvent,
} from '../model-provider.js';

// Claude model context window limits (in tokens)
const CLAUDE_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-haiku-4-5-20251001': 200000,
  'claude-sonnet-4-5-20251001': 200000,
  'claude-opus-4-5-20251001': 200000,
  // Add other Claude model variants as needed
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-opus-20240229': 200000,
  'claude-3-sonnet-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
};

// Claude Token Counter Implementation
export class ClaudeTokenCounter implements TokenCounter {
  private encoder: any;
  private maxTokens: number;
  private modelName: string;
  private config: SummarizationConfig;

  constructor(
    modelName: string = 'claude-haiku-4-5-20251001',
    config: Partial<SummarizationConfig> = {},
  ) {
    this.modelName = modelName;
    this.maxTokens =
      CLAUDE_MODEL_CONTEXT_WINDOWS[modelName] ||
      CLAUDE_MODEL_CONTEXT_WINDOWS['claude-haiku-4-5-20251001'] ||
      200000;

    // Claude models use cl100k_base encoding (same as GPT-4)
    try {
      // Use cl100k_base encoding for Claude models via gpt-4 model
      this.encoder = encoding_for_model('gpt-4'); // gpt-4 uses cl100k_base, compatible with Claude
    } catch (error) {
      // Fallback: try to get cl100k_base directly
      try {
        this.encoder = get_encoding('cl100k_base');
      } catch (e) {
        // Last resort fallback - will use character estimation
        this.encoder = null;
      }
    }

    this.config = {
      threshold: 80, // Default: summarize at 80% of context window
      recentMessagesToKeep: 10, // Default: keep last 10 messages
      enabled: true,
      ...config,
    };
  }

  countTokens(text: string): number {
    if (!this.encoder) {
      // Fallback estimation: ~4 characters per token (rough approximation)
      return Math.ceil(text.length / 4);
    }

    try {
      const tokens = this.encoder.encode(text);
      return tokens.length;
    } catch (error) {
      // Fallback to rough estimation if encoding fails
      return Math.ceil(text.length / 4);
    }
  }

  countMessageTokens(message: { role: string; content: string }): number {
    // Count tokens for the message structure
    // Format: role + content + overhead
    const roleTokens = this.countTokens(message.role);
    const contentTokens = this.countTokens(message.content);
    // Add overhead for message structure (approximately 4 tokens)
    return roleTokens + contentTokens + 4;
  }

  getUsage(currentTokens: number): TokenUsage {
    const percentage = (currentTokens / this.maxTokens) * 100;

    let suggestion: 'continue' | 'warn' | 'break';
    if (percentage < 60) {
      suggestion = 'continue';
    } else if (percentage < 80) {
      suggestion = 'warn';
    } else {
      suggestion = 'break';
    }

    return {
      current: currentTokens,
      limit: this.maxTokens,
      percentage: Math.round(percentage * 100) / 100, // Round to 2 decimal places
      suggestion,
    };
  }

  shouldSummarize(currentTokens: number): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const usage = this.getUsage(currentTokens);
    return usage.percentage >= this.config.threshold;
  }

  getContextWindow(): number {
    return this.maxTokens;
  }

  getModelName(): string {
    return this.modelName;
  }

  updateModel(modelName: string): void {
    this.modelName = modelName;
    this.maxTokens =
      CLAUDE_MODEL_CONTEXT_WINDOWS[modelName] ||
      CLAUDE_MODEL_CONTEXT_WINDOWS['claude-haiku-4-5-20251001'] ||
      200000;
  }

  getConfig(): SummarizationConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<SummarizationConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// Claude Provider Implementation
export class ClaudeProvider implements ModelProvider {
  private anthropicClient: Anthropic;

  constructor() {
    this.anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  getProviderName(): string {
    return 'claude';
  }

  getDefaultModel(): string {
    return 'claude-haiku-4-5-20251001';
  }

  getContextWindow(model: string): number {
    return (
      CLAUDE_MODEL_CONTEXT_WINDOWS[model] ||
      CLAUDE_MODEL_CONTEXT_WINDOWS['claude-haiku-4-5-20251001'] ||
      200000
    );
  }

  getToolType(): any {
    // Return a dummy value - this method is for type compatibility only
    // The actual Tool type is handled at compile time
    return undefined;
  }

  createTokenCounter(
    model: string,
    config?: Partial<SummarizationConfig>,
  ): TokenCounter {
    return new ClaudeTokenCounter(model, config);
  }

  async *createMessageStream(
    messages: Message[],
    model: string,
    tools: Tool[],
    maxTokens: number,
  ): AsyncIterable<MessageStreamEvent> {
    // Convert generic Tool[] to Anthropic Tool[]
    const anthropicTools: AnthropicTool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));

    // Convert generic Message[] to Anthropic format
    const anthropicMessages = messages.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

    const stream = await this.anthropicClient.messages.create({
      messages: anthropicMessages,
      model: model,
      max_tokens: maxTokens,
      tools: anthropicTools,
      stream: true,
    });

    // Yield events from Anthropic stream
    for await (const chunk of stream) {
      yield chunk as MessageStreamEvent;
    }
  }

  // Helper method to create a non-streaming message (for summarization)
  async createMessage(
    messages: Message[],
    model: string,
    maxTokens: number,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const anthropicMessages = messages.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

    const response = await this.anthropicClient.messages.create({
      messages: anthropicMessages,
      model: model,
      max_tokens: maxTokens,
      stream: false,
    });

    return response as any;
  }
}

// Export Claude-specific Tool type for backward compatibility
export type { AnthropicTool as Tool };

