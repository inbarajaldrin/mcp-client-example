import { Anthropic } from '@anthropic-ai/sdk';
import { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/index.mjs';
import { Stream } from '@anthropic-ai/sdk/streaming.mjs';
import { encoding_for_model } from 'tiktoken';
import type {
  ModelProvider,
  TokenCounter,
  Tool,
  Message,
  TokenUsage,
  SummarizationConfig,
  MessageStreamEvent,
  ModelInfo,
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

// Tool Executor Type - function that executes tools on your system
export type ToolExecutor = (
  toolName: string,
  toolInput: Record<string, any>,
) => Promise<string>;

// Claude Token Counter Implementation
export class ClaudeTokenCounter implements TokenCounter {
  private encoder: any;
  private maxTokens: number;
  private modelName: string;
  private config: SummarizationConfig;

  constructor(
    modelName: string = 'claude-haiku-4-5-20251001',
    config: Partial<SummarizationConfig> = {},
    contextWindow?: number,
  ) {
    this.modelName = modelName;
    // Only use provided context window - no fallback
    if (!contextWindow) {
      throw new Error(
        `Context window is required for model "${modelName}". Please ensure listAvailableModels() has been called first.`
      );
    }
    this.maxTokens = contextWindow;

    // Claude models use cl100k_base encoding (same as GPT-4)
    // Use cl100k_base encoding for Claude models via gpt-4 model
    this.encoder = encoding_for_model('gpt-4'); // gpt-4 uses cl100k_base, compatible with Claude

    this.config = {
      threshold: 80, // Default: summarize at 80% of context window
      recentMessagesToKeep: 10, // Default: keep last 10 messages
      enabled: true,
      ...config,
    };
  }

  countTokens(text: string): number {
    const tokens = this.encoder.encode(text);
    return tokens.length;
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

  updateModel(modelName: string, contextWindow?: number): void {
    this.modelName = modelName;
    // Only use provided context window - no fallback
    if (!contextWindow) {
      throw new Error(
        `Context window is required for model "${modelName}". Please ensure listAvailableModels() has been called first.`
      );
    }
    this.maxTokens = contextWindow;
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
  // Dynamic cache of context windows discovered from API only
  private contextWindowCache: Map<string, number> = new Map();

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
    // Only use API-provided context windows from cache
    if (this.contextWindowCache.has(model)) {
      return this.contextWindowCache.get(model)!;
    }
    
    // No fallback - context window must be fetched from API first
    throw new Error(
      `Context window for model "${model}" not available. Please call listAvailableModels() first to fetch model information from the API.`
    );
  }

  /**
   * List available models from Anthropic API
   * Note: Anthropic doesn't have a public models list endpoint
   * We need to query model capabilities or use model info endpoints
   */
  async listAvailableModels(): Promise<ModelInfo[]> {
    try {
      // Since Anthropic doesn't have a models.list() endpoint,
      // we need to try alternative approaches to get model information
      // For now, we'll attempt to get model info by making a test API call
      // or querying available models through other means
      
      // Try to get model information by querying the API
      // This is a workaround since Anthropic doesn't expose a models endpoint
      const knownModels = [
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-5-20251001',
        'claude-opus-4-5-20251001',
        'claude-3-5-sonnet-20241022',
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
      ];

      const models: ModelInfo[] = [];
      
      // For each known model, try to get context window from API
      // We can do this by checking model capabilities or making a test call
      for (const modelId of knownModels) {
        try {
          // Try to get context window by checking model metadata
          // Anthropic API might provide this in error messages or model info
          // For now, we'll need to query it differently
          
          // Since we can't directly query context window, we'll need to
          // rely on the API response or documentation
          // This is a limitation of Anthropic's API
          
          let description = '';
          if (modelId.includes('haiku')) {
            description = 'Fast and efficient model for quick responses';
          } else if (modelId.includes('sonnet')) {
            description = 'Balanced model with strong performance';
          } else if (modelId.includes('opus')) {
            description = 'Most capable model for complex tasks';
          }

          // Note: Without a models endpoint, we can't get context window from API
          // The context window would need to be provided separately or
          // we'd need to make a test API call to determine it
          models.push({
            id: modelId,
            name: modelId,
            description,
            contextWindow: undefined, // API doesn't provide this
            capabilities: ['text', 'vision', 'tools', 'pdf'],
          });
        } catch (error) {
          // Skip models that fail
          continue;
        }
      }

      // Sort by model family and version (newer first)
      return models.sort((a, b) => {
        // Extract version for sorting (assuming format like 20251001)
        const aVersion = a.id.split('-').pop() || '';
        const bVersion = b.id.split('-').pop() || '';
        return bVersion.localeCompare(aVersion);
      });
    } catch (error) {
      // No fallback - throw error if we can't get model information
      throw new Error(
        `Failed to fetch models from Anthropic API: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getToolType(): any {
    // Return a dummy value - this method is for type compatibility only
    // The actual Tool type is handled at compile time
    return undefined;
  }

  async createTokenCounter(
    model: string,
    config?: Partial<SummarizationConfig>,
  ): Promise<TokenCounter> {
    // Ensure we have context window - fetch from API if not cached
    let contextWindow = this.contextWindowCache.get(model);
    if (!contextWindow) {
      // Try to fetch model info from API
      await this.ensureModelInfo(model);
      contextWindow = this.contextWindowCache.get(model);
    }
    
    if (!contextWindow) {
      throw new Error(
        `Context window for model "${model}" not available from API. Please ensure the model exists and is accessible.`
      );
    }
    
    return new ClaudeTokenCounter(model, config, contextWindow);
  }

  /**
   * Ensure model information is fetched from API
   */
  private async ensureModelInfo(model: string): Promise<void> {
    try {
      // Fetch all models to populate cache
      await this.listAvailableModels();
    } catch (error) {
      // If listAvailableModels fails, we can't get context window
      throw new Error(
        `Failed to fetch model information from API: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
    // Claude doesn't support 'tool' role or tool_calls in messages
    // - Convert tool messages to user messages
    // - Filter out assistant messages with only tool_calls (no content) - Claude doesn't store these
    const anthropicMessages = messages
      .filter((msg) => {
        // Skip assistant messages that only have tool_calls but no content
        // Claude handles tool calls via stream, not in message history
        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0 && !msg.content) {
          return false;
        }
        return true;
      })
      .map((msg) => ({
        role: (msg.role === 'tool' ? 'user' : msg.role) as 'user' | 'assistant',
        content: msg.content || '',
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

  /**
   * NEW: Agent loop with tool use support
   * 
   * This method implements the full agentic loop:
   * 1. Send message to Claude
   * 2. Check if Claude wants to use tools (stop_reason === 'tool_use')
   * 3. Execute tools via toolExecutor callback
   * 4. Send tool results back to Claude
   * 5. Repeat until Claude is done (stop_reason === 'end_turn')
   * 
   * Based on official docs:
   * https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use
   */
  async *createMessageStreamWithToolUse(
    messages: Message[],
    model: string,
    tools: Tool[],
    maxTokens: number,
    toolExecutor: ToolExecutor,
    maxIterations: number = 10,
  ): AsyncIterable<MessageStreamEvent | { type: 'tool_use_complete'; toolName: string; result: string }> {
    const anthropicTools: AnthropicTool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));

    let conversationMessages = [...messages];
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      // Step 1: Stream request to Claude (using .stream() for real-time response)
      const stream = this.anthropicClient.messages.stream({
        model: model,
        max_tokens: maxTokens,
        tools: anthropicTools,
        messages: this.convertToAnthropicMessages(conversationMessages),
      });

      // Stream events to user (they see text in real-time)
      for await (const chunk of stream) {
        yield chunk as MessageStreamEvent;
      }

      // Get the final complete message
      const response = await stream.finalMessage();

      // Step 2: Add Claude's response to conversation
      // Store full content blocks to preserve tool_use blocks for tool_result references
      conversationMessages.push({
        role: 'assistant',
        content: this.extractTextContent(response.content),
        tool_calls: this.extractToolCalls(response.content),
        content_blocks: response.content, // Preserve full content array with tool_use blocks
      });

      // Step 3: Check stop reason
      if (response.stop_reason === 'end_turn') {
        // Claude is done, no more tool calls needed
        break;
      }

      if (response.stop_reason === 'tool_use') {
        // Step 4: Extract tool calls
        const toolUseBlocks = response.content.filter(
          (block: any) => block.type === 'tool_use',
        );

        if (toolUseBlocks.length === 0) {
          // No actual tool uses found, break to avoid infinite loop
          break;
        }

        // Step 5: Execute tools and collect results
        const toolResults: Array<{
          type: 'tool_result';
          tool_use_id: string;
          content: string;
        }> = [];

        for (const toolUseBlock of toolUseBlocks) {
          if (toolUseBlock.type !== 'tool_use') continue;

          try {
            // Execute the tool
            const toolInput = toolUseBlock.input as Record<string, any>;
            const result = await toolExecutor(toolUseBlock.name, toolInput);

            // Yield the result so caller can see what happened
            yield {
              type: 'tool_use_complete',
              toolName: toolUseBlock.name,
              result: result,
            };

            // Collect result for sending back to Claude
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseBlock.id,
              content: result,
            });
          } catch (error) {
            // If tool execution fails, send error back to Claude
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseBlock.id,
              content: `Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        // Step 6: Send tool results back to Claude in the next iteration
        conversationMessages.push({
          role: 'user',
          content: '',
          tool_results: toolResults,
        });

        // Loop continues - go back to step 1 with tool results in context
      } else {
        // Unexpected stop reason, break
        break;
      }
    }
  }

  /**
   * Helper: Extract text content from Claude's response
   */
  private extractTextContent(content: any[]): string {
    return content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  /**
   * Helper: Extract tool calls from Claude's response
   */
  private extractToolCalls(content: any[]): any[] {
    return content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        name: block.name,
        input: block.input,
      }));
  }

  /**
   * Helper: Convert generic Message[] to Anthropic API format
   * OPTION 2: Properly handles document (PDF) blocks
   */
  private convertToAnthropicMessages(messages: Message[]): Array<{
    role: 'user' | 'assistant';
    content: any;
  }> {
    return messages.map((msg) => {
      // Handle messages with tool results
      if (msg.tool_results && msg.tool_results.length > 0) {
        return {
          role: 'user' as const,
          content: msg.tool_results,
        };
      }

      // Handle user messages with content_blocks (for attachments)
      if (msg.role === 'user' && msg.content_blocks && Array.isArray(msg.content_blocks)) {
        // OPTION 2: Convert content blocks - properly handles documents
        const anthropicContent = msg.content_blocks.map((block: any) => {
          // NEW: Handle document (PDF) blocks - Claude native support
          if (block.type === 'document') {
            return {
              type: 'document',
              source: block.source,  // Claude supports base64 natively
            };
          }

          // Existing: Handle image blocks
          if (block.type === 'image') {
            return {
              type: 'image',
              source: block.source,
            };
          }

          // Existing: Handle text blocks
          if (block.type === 'text') {
            return {
              type: 'text',
              text: block.text,
            };
          }

          // Fallback for unknown types
          return block;
        });

        return {
          role: 'user' as const,
          content: anthropicContent,
        };
      }

      // Handle assistant messages with content_blocks (preserves tool_use blocks)
      if (msg.role === 'assistant' && msg.content_blocks && Array.isArray(msg.content_blocks)) {
        return {
          role: 'assistant' as const,
          content: msg.content_blocks,
        };
      }

      // Standard text messages
      return {
        role: (msg.role === 'tool' ? 'user' : msg.role) as 'user' | 'assistant',
        content: msg.content || '',
      };
    });
  }

  // Helper method to create a non-streaming message (for summarization)
  async createMessage(
    messages: Message[],
    model: string,
    maxTokens: number,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    // Convert generic Message[] to Anthropic format
    // Claude doesn't support 'tool' role or tool_calls in messages
    // - Convert tool messages to user messages
    // - Filter out assistant messages with only tool_calls (no content) - Claude doesn't store these
    const anthropicMessages = messages
      .filter((msg) => {
        // Skip assistant messages that only have tool_calls but no content
        // Claude handles tool calls via stream, not in message history
        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0 && !msg.content) {
          return false;
        }
        return true;
      })
      .map((msg) => ({
        role: (msg.role === 'tool' ? 'user' : msg.role) as 'user' | 'assistant',
        content: msg.content || '',
      }));

    const response = await this.anthropicClient.messages.create({
      messages: anthropicMessages,
      model: model,
      max_tokens: maxTokens,
      stream: false,
    });

    return response as any;
  }

  /**
   * Count tokens using official Anthropic Token Counting API
   * Returns exact token count from Anthropic API
   * Includes tools, images, PDFs, system prompts
   * Token counting is free, subject to rate limits
   * 
   * Based on official docs: https://docs.anthropic.com/claude/reference/count-tokens
   * Note: Uses beta API with token-counting-2024-11-01 header
   */
  async countTokensOfficial(
    messages: Message[],
    model: string,
    tools: Tool[],
    system?: string,
  ): Promise<number> {
    // Convert messages to Anthropic format (same as convertToAnthropicMessages)
    const anthropicMessages = messages
      .filter((msg) => {
        if (msg.role === 'assistant' && msg.tool_calls && !msg.content) {
          return false;
        }
        return true;
      })
      .map((msg) => {
        // Handle messages with tool results
        if (msg.tool_results && msg.tool_results.length > 0) {
          return {
            role: 'user' as const,
            content: msg.tool_results,
          };
        }

        // Handle user messages with content_blocks (for attachments)
        if (msg.role === 'user' && msg.content_blocks && Array.isArray(msg.content_blocks)) {
          return {
            role: 'user' as const,
            content: msg.content_blocks,
          };
        }

        // Handle assistant messages with content_blocks (preserves tool_use blocks)
        if (msg.role === 'assistant' && msg.content_blocks && Array.isArray(msg.content_blocks)) {
          return {
            role: 'assistant' as const,
            content: msg.content_blocks,
          };
        }

        // Standard text messages
        return {
          role: (msg.role === 'tool' ? 'user' : msg.role) as 'user' | 'assistant',
          content: msg.content || '',
        };
      });

    // Convert tools to Anthropic format
    const anthropicTools: AnthropicTool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));

    // Call official token counting API using beta method
    // The beta.messages.countTokens() method requires the beta header
    const response = await (this.anthropicClient as any).beta.messages.countTokens(
      {
        model: model,
        messages: anthropicMessages,
        ...(anthropicTools.length > 0 && { tools: anthropicTools }),
        ...(system && { system }),
      },
      {
        headers: {
          'anthropic-beta': 'token-counting-2024-11-01',
        },
      }
    );

    return response.input_tokens;
  }
}

// Export Claude-specific Tool type for backward compatibility
export type { AnthropicTool as Tool };