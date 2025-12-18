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

// Cost Report API Types
export interface CostReportParams {
  starting_at: string; // RFC 3339 timestamp (required)
  ending_at?: string; // RFC 3339 timestamp (optional)
  bucket_width?: '1d'; // Time granularity (optional)
  group_by?: Array<'workspace_id' | 'description'>; // Group by options (optional)
  limit?: number; // Max number of time buckets (optional)
  page?: string; // Pagination token (optional)
}

export interface CostReportResult {
  amount: string; // Cost amount in lowest currency units (e.g. cents) as decimal string
  context_window?: string | null; // Input context window: "0-200k" or "200k-1M"
  cost_type?: string | null; // Type of cost: "tokens", "web_search", "code_execution"
  currency: string; // Currency code (currently always "USD")
  description?: string | null; // Description of the cost item
  model?: string | null; // Model name used
  service_tier?: string | null; // Service tier: "standard", "batch", "priority"
  token_type?: string | null; // Token type: "uncached_input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation.ephemeral_1h_input_tokens", "cache_creation.ephemeral_5m_input_tokens"
  workspace_id?: string | null; // Workspace ID
}

export interface CostReportData {
  ending_at: string; // End of time bucket (exclusive) in RFC 3339 format
  results: CostReportResult[]; // List of cost items for this time bucket
  starting_at: string; // Start of time bucket (inclusive) in RFC 3339 format
}

export interface CostReportResponse {
  data: CostReportData[]; // List of cost data buckets
  has_more: boolean; // Indicates if there are more results
  next_page?: string | null; // Token for next page
}

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

    // while (iterations < maxIterations) { // Max iterations check disabled - run indefinitely
    while (true) {
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
      // Enable prompt caching for tools to save tokens on repeated tool definitions
      const toolsWithCache = anthropicTools.map((tool, index) => ({
        ...tool,
        // Add cache control to the last tool (marks all tools for caching)
        ...(index === anthropicTools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
      }));

      const stream = this.anthropicClient.messages.stream({
        model: model,
        max_tokens: maxTokens,
        tools: toolsWithCache as any,
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

      // Yield token usage from Anthropic API response if available
      // Anthropic provides usage information in the response object
      // Total input tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
      if (response.usage) {
        const usage = response.usage as any; // Type assertion for cache fields that may not be in SDK types yet
        const inputTokens = usage.input_tokens || 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || 0;
        const totalInputTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
        const outputTokens = usage.output_tokens || 0;
        
        yield {
          type: 'token_usage',
          input_tokens: totalInputTokens, // Total input tokens including cache
          output_tokens: outputTokens,
          // Include breakdown for detailed tracking
          input_tokens_breakdown: {
            input_tokens: inputTokens,
            cache_creation_input_tokens: cacheCreationTokens,
            cache_read_input_tokens: cacheReadTokens,
          },
        } as MessageStreamEvent;
      }

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

    // Check if we exited due to max iterations
    // if (iterations >= maxIterations) {
    //   yield {
    //     type: 'max_iterations_reached',
    //     iterations: iterations,
    //     maxIterations: maxIterations,
    //   } as any;
    // }
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

  /**
   * Get cost report from Anthropic API
   * Retrieves detailed cost breakdowns per model, token type, and cache usage
   * 
   * Requires Admin API key (not regular API key)
   * Based on: https://platform.claude.com/docs/en/api/admin/cost_report/retrieve
   * 
   * @param params - Cost report query parameters
   * @returns Cost report response with detailed breakdowns
   */
  async getCostReport(params: CostReportParams): Promise<CostReportResponse> {
    const apiKey = process.env.ANTHROPIC_ADMIN_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_ADMIN_API_KEY or ANTHROPIC_API_KEY environment variable is not set');
    }

    // Build query parameters
    const queryParams = new URLSearchParams();
    queryParams.append('starting_at', params.starting_at);
    
    if (params.ending_at) {
      queryParams.append('ending_at', params.ending_at);
    }
    
    if (params.bucket_width) {
      queryParams.append('bucket_width', params.bucket_width);
    }
    
    if (params.group_by && params.group_by.length > 0) {
      params.group_by.forEach(group => {
        queryParams.append('group_by[]', group);
      });
    }
    
    if (params.limit !== undefined) {
      queryParams.append('limit', params.limit.toString());
    }
    
    if (params.page) {
      queryParams.append('page', params.page);
    }

    try {
      const response = await fetch(
        `https://api.anthropic.com/v1/organizations/cost_report?${queryParams.toString()}`,
        {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to fetch cost report: ${response.status} ${response.statusText}. ${errorText}`
        );
      }

      const data = await response.json() as CostReportResponse;
      return data;
    } catch (error) {
      throw new Error(
        `Failed to fetch cost report from Anthropic API: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get all cost report pages (handles pagination automatically)
   * 
   * @param params - Cost report query parameters (page will be ignored, handled internally)
   * @returns All cost report data across all pages
   */
  async getAllCostReportPages(params: Omit<CostReportParams, 'page'>): Promise<CostReportData[]> {
    const allData: CostReportData[] = [];
    let currentPage: string | null | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await this.getCostReport({
        ...params,
        page: currentPage || undefined,
      });

      allData.push(...response.data);
      hasMore = response.has_more;
      currentPage = response.next_page || null;

      // Safety check to prevent infinite loops
      if (hasMore && !currentPage) {
        console.warn('API indicates more results but no next_page token provided');
        break;
      }
    }

    return allData;
  }

  /**
   * Calculate estimated cost per token for a model based on cost report data
   * 
   * @param costReportData - Cost report data from getCostReport or getAllCostReportPages
   * @param model - Model name to get pricing for
   * @param tokenType - Token type to get pricing for (optional, defaults to uncached_input_tokens)
   * @returns Estimated cost per token in USD, or null if no data found
   */
  calculateCostPerToken(
    costReportData: CostReportData[],
    model: string,
    tokenType: string = 'uncached_input_tokens'
  ): { costPerToken: number; currency: string } | null {
    // Flatten all results from all time buckets
    const allResults = costReportData.flatMap(bucket => bucket.results);

    // Find matching results for the specified model and token type
    const matchingResults = allResults.filter(
      result => result.model === model && result.token_type === tokenType
    );

    if (matchingResults.length === 0) {
      return null;
    }

    // Calculate average cost per token
    // Note: The API returns amounts in lowest currency units (cents for USD)
    // We need to track token counts separately or estimate from the cost report
    // Since the cost report doesn't include token counts, we can only return the cost amounts
    // For actual per-token pricing, you'd need to divide by token counts from usage data
    
    // For now, return the average amount per result
    // In practice, you'd want to correlate this with actual token usage from usage reports
    const totalAmount = matchingResults.reduce((sum, result) => {
      return sum + parseFloat(result.amount);
    }, 0);

    const averageAmount = totalAmount / matchingResults.length;
    
    // Convert from cents to dollars if currency is USD
    const currency = matchingResults[0]?.currency || 'USD';
    const costPerToken = currency === 'USD' ? averageAmount / 100 : averageAmount;

    return {
      costPerToken,
      currency,
    };
  }

  /**
   * Get cost breakdown by model from cost report data
   * 
   * @param costReportData - Cost report data from getCostReport or getAllCostReportPages
   * @returns Map of model names to their cost breakdowns by token type
   */
  getCostBreakdownByModel(
    costReportData: CostReportData[]
  ): Map<string, Map<string, { amount: number; currency: string; count: number }>> {
    const breakdown = new Map<string, Map<string, { amount: number; currency: string; count: number }>>();

    // Flatten all results from all time buckets
    const allResults = costReportData.flatMap(bucket => bucket.results);

    for (const result of allResults) {
      if (!result.model || !result.token_type) {
        continue;
      }

      if (!breakdown.has(result.model)) {
        breakdown.set(result.model, new Map());
      }

      const modelBreakdown = breakdown.get(result.model)!;
      const tokenType = result.token_type;

      if (!modelBreakdown.has(tokenType)) {
        modelBreakdown.set(tokenType, {
          amount: 0,
          currency: result.currency,
          count: 0,
        });
      }

      const tokenTypeData = modelBreakdown.get(tokenType)!;
      const amountInCents = parseFloat(result.amount);
      tokenTypeData.amount += amountInCents;
      tokenTypeData.count += 1;
    }

    return breakdown;
  }
}

// Export Anthropic-specific Tool type for backward compatibility
export type { AnthropicTool as Tool };