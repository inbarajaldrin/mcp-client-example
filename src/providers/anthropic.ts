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

// No hardcoded model context windows - all context windows must be fetched from API

// Tool Executor Type - function that executes tools on your system
export type ToolExecutor = (
  toolName: string,
  toolInput: Record<string, any>,
) => Promise<string>;

// Anthropic Token Counter Implementation
export class AnthropicTokenCounter implements TokenCounter {
  private encoder: any;
  private maxTokens: number;
  private modelName: string;
  private config: SummarizationConfig;

  constructor(
    modelName: string,
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

    // Anthropic models use cl100k_base encoding (same as GPT-4)
    // Use cl100k_base encoding for Anthropic models via gpt-4 model
    this.encoder = encoding_for_model('gpt-4'); // gpt-4 uses cl100k_base, compatible with Anthropic

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

// Anthropic Provider Implementation
export class AnthropicProvider implements ModelProvider {
  private anthropicClient: Anthropic;
  // Dynamic cache of context windows discovered from API only
  private contextWindowCache: Map<string, number> = new Map();

  constructor() {
    this.anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  getProviderName(): string {
    return 'anthropic';
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
   * Validate if a model exists by making a lightweight API call
   * Uses the token counting API which is free and lightweight
   */
  private async validateModel(modelId: string): Promise<{ exists: boolean; contextWindow?: number }> {
    try {
      // Use token counting API to validate model exists
      // This is free and lightweight
      const response = await (this.anthropicClient as any).beta.messages.countTokens(
        {
          model: modelId,
          messages: [{ role: 'user', content: 'test' }],
        },
        {
          headers: {
            'anthropic-beta': 'token-counting-2024-11-01',
          },
        }
      );
      
      // If we get here, model exists
      // Context window is typically 200K for Anthropic models, but we can't get it from API
      // We'll need to infer it or use a default
      return { exists: true, contextWindow: 200000 }; // Default Anthropic context window
    } catch (error: any) {
      // Check if error is about model not found
      if (error?.status === 404 || error?.message?.includes('not_found') || error?.message?.includes('model')) {
        return { exists: false };
      }
      // Other errors might indicate model exists but request was invalid
      // Re-throw to let caller handle
      throw error;
    }
  }

  /**
   * List available models from Anthropic API
   * Uses the official Models API: GET /v1/models
   * See: https://docs.anthropic.com/claude/reference/list-models
   */
  async listAvailableModels(): Promise<ModelInfo[]> {
    try {
      // Try using the Anthropic SDK's models.list() method if available
      // This is the preferred method for newer SDK versions
      if ((this.anthropicClient as any).models && (this.anthropicClient as any).models.list) {
        const response = await (this.anthropicClient as any).models.list();
        
        // Transform Anthropic's response to our ModelInfo format
        const models: ModelInfo[] = response.data.map((model: any) => ({
          id: model.id,
          name: model.display_name || model.id,
          description: `Released: ${model.created_at}`,
          contextWindow: 200000, // Default context window for Anthropic models
          capabilities: ['text', 'vision', 'tools'], // All Anthropic models support these
        }));

        return models;
      } else {
        // Fallback to direct API fetch if SDK method isn't available
        return await this.listAvailableModelsViaFetch();
      }
    } catch (error: any) {
      // If SDK method fails, try direct fetch as fallback
      if ((error?.message || '').includes('not found') || (error?.message || '').includes('undefined')) {
        return await this.listAvailableModelsViaFetch();
      }
      throw error;
    }
  }

  /**
   * Fallback method: List models via direct API fetch
   * Uses the standard REST API if SDK method isn't available
   * See: https://docs.anthropic.com/claude/reference/list-models
   */
  private async listAvailableModelsViaFetch(): Promise<ModelInfo[]> {
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is not set');
      }

      const response = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as any;
      
      // Transform API response to ModelInfo format
      const models: ModelInfo[] = (data.data || []).map((model: any) => ({
        id: model.id,
        name: model.display_name || model.id,
        description: `Released: ${model.created_at}`,
          contextWindow: 200000, // Default context window for Anthropic models
        capabilities: ['text', 'vision', 'tools'],
      }));

      return models;
    } catch (error) {
      throw new Error(
        `Failed to fetch available models from Anthropic API: ${error instanceof Error ? error.message : String(error)}`
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
    
    return new AnthropicTokenCounter(model, config, contextWindow);
  }

  /**
   * Ensure model information is fetched from API
   * Validates the model exists and caches its context window
   */
  private async ensureModelInfo(model: string): Promise<void> {
    // Check if already cached
    if (this.contextWindowCache.has(model)) {
      return;
    }

    try {
      // Validate model exists and get context window
      const validation = await this.validateModel(model);
      if (!validation.exists) {
        throw new Error(`Model "${model}" not found. Please check the model name and try again.`);
      }
      
      // Cache the context window
      if (validation.contextWindow) {
        this.contextWindowCache.set(model, validation.contextWindow);
      } else {
        // If we can't get context window from API, use default
        // This shouldn't happen, but handle it gracefully
        throw new Error(`Could not determine context window for model "${model}" from API.`);
      }
    } catch (error) {
      // Re-throw with more context
      if (error instanceof Error && error.message.includes('not found')) {
        throw error;
      }
      throw new Error(
        `Failed to validate model "${model}" from API: ${error instanceof Error ? error.message : String(error)}`
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
    // Anthropic doesn't support 'tool' role or tool_calls in messages
    // - Convert tool messages to user messages
    // - Filter out assistant messages with only tool_calls (no content) - Anthropic doesn't store these
    const anthropicMessages = messages
      .filter((msg) => {
        // Skip assistant messages that only have tool_calls but no content
        // Anthropic handles tool calls via stream, not in message history
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
   * 1. Send message to Anthropic
   * 2. Check if Anthropic wants to use tools (stop_reason === 'tool_use')
   * 3. Execute tools via toolExecutor callback
   * 4. Send tool results back to Anthropic
   * 5. Repeat until Anthropic is done (stop_reason === 'end_turn')
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
    cancellationCheck?: () => boolean,
  ): AsyncIterable<MessageStreamEvent | { type: 'tool_use_complete'; toolName: string; result: string }> {
    const anthropicTools: AnthropicTool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));

    let conversationMessages = [...messages];
    let iterations = 0;
    let hasPendingToolResults = false; // Track if we have tool results that need to be sent

    while (iterations < maxIterations) {
      // Check for cancellation at start of each iteration (after previous one completed)
      // If we have pending tool results, do ONE MORE iteration to send them to the agent
      if (cancellationCheck && cancellationCheck()) {
        if (!hasPendingToolResults) {
          // No pending results, safe to break immediately
          break;
        }
        // We have pending tool results - continue this iteration to send them
        // After this iteration completes, we'll break regardless
      }

      iterations++;

      // Step 1: Stream request to Anthropic (using .stream() for real-time response)
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

      // Step 2: Add Anthropic's response to conversation
      // Store full content blocks to preserve tool_use blocks for tool_result references
      conversationMessages.push({
        role: 'assistant',
        content: this.extractTextContent(response.content),
        tool_calls: this.extractToolCalls(response.content),
        content_blocks: response.content, // Preserve full content array with tool_use blocks
      });

      // If we just sent pending tool results and are cancelled, break now
      if (hasPendingToolResults && cancellationCheck && cancellationCheck()) {
        // We've sent the tool results to the agent and got a response
        // Now we can safely break
        break;
      }

      // Reset the flag - if there were pending results, they've now been sent
      hasPendingToolResults = false;

      // Step 3: Check stop reason
      if (response.stop_reason === 'end_turn') {
        // Anthropic is done, no more tool calls needed
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
              toolUseId: toolUseBlock.id,
              result: result,
            };

            // Collect result for sending back to Anthropic
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseBlock.id,
              content: result,
            });
          } catch (error) {
            // If tool execution fails, send error back to Anthropic
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseBlock.id,
              content: `Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        // Step 6: Send tool results back to Anthropic in the next iteration
        conversationMessages.push({
          role: 'user',
          content: '',
          tool_results: toolResults,
        });

        // Mark that we have pending tool results to send
        // Even if cancelled, we need one more iteration to send these to the agent
        hasPendingToolResults = true;

        // Loop continues - go back to step 1 with tool results in context
      } else {
        // Unexpected stop reason, break
        break;
      }
    }
  }

  /**
   * Helper: Extract text content from Anthropic's response
   */
  private extractTextContent(content: any[]): string {
    return content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  /**
   * Helper: Extract tool calls from Anthropic's response
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
          // NEW: Handle document (PDF) blocks - Anthropic native support
          if (block.type === 'document') {
            return {
              type: 'document',
              source: block.source,  // Anthropic supports base64 natively
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
    // Anthropic doesn't support 'tool' role or tool_calls in messages
    // - Convert tool messages to user messages
    // - Filter out assistant messages with only tool_calls (no content) - Anthropic doesn't store these
    const anthropicMessages = messages
      .filter((msg) => {
        // Skip assistant messages that only have tool_calls but no content
        // Anthropic handles tool calls via stream, not in message history
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

// Export Anthropic-specific Tool type for backward compatibility
export type { AnthropicTool as Tool };