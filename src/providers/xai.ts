import OpenAI from 'openai';
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
  ThinkingConfig,
} from '../model-provider.js';

import type { ToolExecutionResult } from '../core/tool-executor.js';

// Tool Executor Type - function that executes tools on your system
// Returns ToolExecutionResult with display text and content blocks (including images)
export type ToolExecutor = (
  toolName: string,
  toolInput: Record<string, any>,
) => Promise<ToolExecutionResult>;

// Provider metadata - exported for use by CLI
export const PROVIDER_INFO = {
  name: 'xai',
  label: 'xAI (Grok)',
  defaultModel: 'grok-4-fast',
  models: ['grok-4-fast', 'grok-4'],
};

// Grok model context window limits (in tokens)
// Based on xAI documentation: https://docs.x.ai/docs/models
const GROK_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'grok-4': 131072,
  'grok-4-fast': 2000000,
};

// Grok Token Counter Implementation
export class GrokTokenCounter implements TokenCounter {
  private encoder: any;
  private maxTokens: number;
  private modelName: string;
  private config: SummarizationConfig;

  constructor(
    modelName: string = 'grok-4',
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

    // Use GPT-4 tokenizer as a reasonable approximation for Grok models
    this.encoder = encoding_for_model('gpt-4');

    this.config = {
      threshold: 80,
      recentMessagesToKeep: 10,
      enabled: true,
      ...config,
    };
  }

  countTokens(text: string): number {
    const tokens = this.encoder.encode(text);
    return tokens.length;
  }

  countMessageTokens(message: { role: string; content: string }): number {
    const roleTokens = this.countTokens(message.role);
    const contentTokens = this.countTokens(message.content);
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
      percentage: Math.round(percentage * 100) / 100,
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

// Grok Provider Implementation
// Uses OpenAI SDK with xAI base URL (OpenAI-compatible API)
export class GrokProvider implements ModelProvider {
  private client: OpenAI;
  // Dynamic cache of context windows discovered from API only
  private contextWindowCache: Map<string, number> = new Map();
  private thinkingConfig: ThinkingConfig | null = null;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: 'https://api.x.ai/v1',
    });
  }

  setThinkingConfig(config: ThinkingConfig): void {
    this.thinkingConfig = config;
  }

  // xAI only supports reasoning_effort on grok-3-mini (low/high only)
  // grok-4 and grok-4-fast-reasoning have built-in reasoning that can't be controlled
  private resolveReasoningEffort(model: string): string | undefined {
    if (!model.startsWith('grok-3-mini')) return undefined;
    if (!this.thinkingConfig?.enabled) {
      return 'low';
    }
    const level = this.thinkingConfig.level || 'high';
    if (level === 'low' || level === 'high') {
      return level;
    }
    return 'high';
  }

  getProviderName(): string {
    return 'xai';
  }

  getDefaultModel(): string {
    return 'grok-4-fast';
  }

  getContextWindow(model: string): number {
    // First try API-provided context windows from cache
    if (this.contextWindowCache.has(model)) {
      return this.contextWindowCache.get(model)!;
    }

    // Fallback to hardcoded values
    // Check for exact match first, then try prefix matching for versioned models
    let contextWindow = GROK_MODEL_CONTEXT_WINDOWS[model];

    if (!contextWindow) {
      // Try to find a matching base model (e.g., "grok-4-something" -> "grok-4")
      for (const [baseModel, window] of Object.entries(GROK_MODEL_CONTEXT_WINDOWS)) {
        if (model.startsWith(baseModel)) {
          contextWindow = window;
          break;
        }
      }
    }

    // Default to 131072 (128K) if no match found
    contextWindow = contextWindow || 131072;

    // Cache it for future use
    this.contextWindowCache.set(model, contextWindow);
    return contextWindow;
  }

  getToolType(): any {
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

    // If still not available, try to get from hardcoded fallback
    if (!contextWindow) {
      try {
        contextWindow = this.getContextWindow(model);
      } catch {
        throw new Error(
          `Context window for model "${model}" not available from API or fallback. Please ensure the model exists and is accessible.`
        );
      }
    }

    return new GrokTokenCounter(model, config, contextWindow);
  }

  /**
   * Ensure model information is fetched from API
   */
  private async ensureModelInfo(model: string): Promise<void> {
    try {
      // Fetch all models to populate cache
      await this.listAvailableModels();
    } catch (error) {
      // If listAvailableModels fails, use hardcoded fallback
      const contextWindow = this.getContextWindow(model);
      this.contextWindowCache.set(model, contextWindow);
    }
  }

  async *createMessageStream(
    messages: Message[],
    model: string,
    tools: Tool[],
    maxTokens: number,
  ): AsyncIterable<MessageStreamEvent> {
    // Convert generic Tool[] to OpenAI function format
    const openaiTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));

    // Convert generic Message[] to OpenAI format
    let openaiMessages = this.convertToOpenAIMessages(messages, model);

    // Handle tool-specific conversions for ongoing conversations
    openaiMessages = openaiMessages.map((msg: any) => {
      // For assistant messages with tool_calls, ensure proper format
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: 'assistant' as const,
          content: msg.content || '',
          tool_calls: msg.tool_calls.map((tc: any) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        };
      }
      return msg;
    });

    const reasoningEffort = this.resolveReasoningEffort(model);
    const createParams: any = {
      model: model,
      messages: openaiMessages,
      max_completion_tokens: maxTokens,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (reasoningEffort) createParams.reasoning_effort = reasoningEffort;
    const stream: any = await this.client.chat.completions.create(createParams);

    const toolCallTracker = new Map<number, { name?: string; id?: string; arguments: string }>();
    let messageStarted = false;

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (!messageStarted) {
        yield {
          type: 'message_start',
        } as MessageStreamEvent;
        messageStarted = true;
      }

      const delta = choice.delta;

      if (delta.content) {
        yield {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: delta.content,
          },
        } as MessageStreamEvent;
      }

      if (delta.tool_calls && delta.tool_calls.length > 0) {
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index;

          if (!toolCallTracker.has(index)) {
            toolCallTracker.set(index, { arguments: '' });
          }

          const tracker = toolCallTracker.get(index)!;

          if (toolCall.id && !tracker.id) {
            tracker.id = toolCall.id;
          }

          if (toolCall.function?.name) {
            if (!tracker.name) {
              tracker.name = toolCall.function.name;
              yield {
                type: 'content_block_start',
                content_block: {
                  type: 'tool_use',
                  name: toolCall.function.name,
                  id: tracker.id,
                },
              } as MessageStreamEvent;
            }
          }

          if (toolCall.function?.arguments && tracker.name) {
            tracker.arguments += toolCall.function.arguments;
            yield {
              type: 'content_block_delta',
              delta: {
                type: 'input_json_delta',
                partial_json: toolCall.function.arguments,
              },
            } as MessageStreamEvent;
          }
        }
      }

      if (choice.finish_reason) {
        toolCallTracker.clear();

        if (choice.finish_reason === 'tool_calls') {
          yield {
            type: 'message_delta',
            delta: {
              stop_reason: 'tool_use',
            },
          } as MessageStreamEvent;
        } else {
          yield {
            type: 'message_delta',
            delta: {
              stop_reason: choice.finish_reason,
            },
          } as MessageStreamEvent;
        }

        // Yield token usage at the end of stream
        if (chunk.usage) {
          const promptTokens = chunk.usage.prompt_tokens || 0;
          const completionTokens = chunk.usage.completion_tokens || 0;
          const cachedTokens = (chunk.usage as any).prompt_tokens_details?.cached_tokens || 0;
          const regularInputTokens = promptTokens - cachedTokens;

          yield {
            type: 'token_usage',
            input_tokens: promptTokens,
            output_tokens: completionTokens,
            input_tokens_breakdown: {
              input_tokens: regularInputTokens,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: cachedTokens,
            },
          } as MessageStreamEvent;
        }

        yield {
          type: 'message_stop',
        } as MessageStreamEvent;
      }
    }
  }

  /**
   * Agentic loop with tool use support for Grok
   */
  async *createMessageStreamWithToolUse(
    messages: Message[],
    model: string,
    tools: Tool[],
    maxTokens: number,
    toolExecutor: ToolExecutor,
    maxIterations: number = 10,
    cancellationCheck?: () => boolean,
  ): AsyncIterable<MessageStreamEvent | { type: 'tool_use_complete'; toolName: string; toolInput: Record<string, any>; result: string }> {
    // Convert generic Tool[] to OpenAI function format
    const openaiTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));

    let conversationMessages = [...messages];
    let iterations = 0;
    let hasPendingToolResults = false;

    while (true) {
      // Check for cancellation at start of each iteration
      if (cancellationCheck && cancellationCheck()) {
        if (!hasPendingToolResults) {
          break;
        }
      }

      iterations++;

      // Stream request to Grok API
      const reasoningEffort = this.resolveReasoningEffort(model);
      const streamParams: any = {
        model: model,
        messages: this.convertToOpenAIMessages(conversationMessages, model),
        max_completion_tokens: maxTokens,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (reasoningEffort) streamParams.reasoning_effort = reasoningEffort;
      const stream: any = await this.client.chat.completions.create(streamParams);

      // Track tool calls as they stream in
      const toolCallTracker = new Map<number, { name?: string; id?: string; arguments: string }>();
      let messageStarted = false;
      let assistantContent = '';
      let finalUsage: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number };
      } | null = null;

      // Stream events to user while collecting response
      for await (const chunk of stream) {
        // Capture usage information
        if (chunk.usage) {
          finalUsage = {
            prompt_tokens: chunk.usage.prompt_tokens || 0,
            completion_tokens: chunk.usage.completion_tokens || 0,
            prompt_tokens_details: (chunk.usage as any).prompt_tokens_details || undefined,
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (!messageStarted) {
          yield { type: 'message_start' } as MessageStreamEvent;
          messageStarted = true;
        }

        const delta = choice.delta;

        // Text content - stream to user
        if (delta.content) {
          assistantContent += delta.content;
          yield {
            type: 'content_block_delta',
            delta: {
              type: 'text_delta',
              text: delta.content,
            },
          } as MessageStreamEvent;
        }

        // Tool calls - stream to user
        if (delta.tool_calls && delta.tool_calls.length > 0) {
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index;

            if (!toolCallTracker.has(index)) {
              toolCallTracker.set(index, { arguments: '' });
            }

            const tracker = toolCallTracker.get(index)!;

            if (toolCall.id && !tracker.id) {
              tracker.id = toolCall.id;
            }

            if (toolCall.function?.name && !tracker.name) {
              tracker.name = toolCall.function.name;
              yield {
                type: 'content_block_start',
                content_block: {
                  type: 'tool_use',
                  name: toolCall.function.name,
                  id: tracker.id,
                },
              } as MessageStreamEvent;
            }

            if (toolCall.function?.arguments && tracker.name) {
              tracker.arguments += toolCall.function.arguments;
              yield {
                type: 'content_block_delta',
                delta: {
                  type: 'input_json_delta',
                  partial_json: toolCall.function.arguments,
                },
              } as MessageStreamEvent;
            }
          }
        }

        // Finish reason
        if (choice.finish_reason) {
          yield {
            type: 'message_delta',
            delta: {
              stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason,
            },
          } as MessageStreamEvent;

          yield { type: 'message_stop' } as MessageStreamEvent;
        }
      }

      // Build tool calls from tracker
      const toolCalls = Array.from(toolCallTracker.entries())
        .sort(([a], [b]) => a - b)
        .map(([_, tracker]) => ({
          id: tracker.id || `call_${Math.random()}`,
          function: {
            name: tracker.name || '',
            arguments: tracker.arguments,
          },
        }));

      // Create response object for compatibility
      const response = {
        choices: [{
          message: {
            content: assistantContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          }
        }],
        usage: finalUsage || { prompt_tokens: 0, completion_tokens: 0 },
      };

      const assistantMessage = response.choices[0].message;

      // Add assistant message to history
      conversationMessages.push({
        role: 'assistant',
        content: assistantMessage.content || '',
        tool_calls: assistantMessage.tool_calls
          ? assistantMessage.tool_calls.map((tc) => {
              const functionCall = 'function' in tc ? tc.function : null;
              if (!functionCall) {
                throw new Error('Tool call does not have function property');
              }
              return {
                id: tc.id,
                name: functionCall.name,
                arguments: functionCall.arguments,
              };
            })
          : undefined,
      });

      // If we just sent pending tool results and are cancelled, break now
      if (hasPendingToolResults && cancellationCheck && cancellationCheck()) {
        yield {
          type: 'message_stop',
        } as MessageStreamEvent;
        break;
      }

      hasPendingToolResults = false;

      // Yield token usage
      const usageToYield = finalUsage || response.usage;
      if (usageToYield) {
        const promptTokens = usageToYield.prompt_tokens || 0;
        const completionTokens = usageToYield.completion_tokens || 0;
        const cachedTokens = (usageToYield as any).prompt_tokens_details?.cached_tokens || 0;
        const regularInputTokens = promptTokens - cachedTokens;

        yield {
          type: 'token_usage',
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          input_tokens_breakdown: {
            input_tokens: regularInputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: cachedTokens,
          },
        } as MessageStreamEvent;
      }

      // Check for tool calls
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        yield {
          type: 'message_stop',
        } as MessageStreamEvent;
        break;
      }

      // Tools were called - close current message before executing tools
      yield {
        type: 'message_stop',
      } as MessageStreamEvent;

      // Execute tools
      const toolResults: Array<{
        tool_call_id: string;
        role: 'tool';
        name: string;
        content: string;
      }> = [];
      // Collect image parts from tool results to inject as a user message
      const toolImageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];

      for (const toolCall of assistantMessage.tool_calls) {
        // Check for cancellation before executing each tool
        if (cancellationCheck && cancellationCheck()) {
          const functionCall = 'function' in toolCall ? toolCall.function : null;
          const toolName = functionCall?.name || 'unknown';
          const cancelMessage = '[Tool execution cancelled by user]';
          yield {
            type: 'tool_use_complete',
            toolName: toolName,
            toolCallId: toolCall.id,
            toolInput: functionCall?.arguments ? JSON.parse(functionCall.arguments) : {},
            result: cancelMessage,
            hasImages: false,
          };
          toolResults.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            name: toolName,
            content: cancelMessage,
          });
          continue;
        }

        try {
          const functionCall = 'function' in toolCall ? toolCall.function : null;
          if (!functionCall) {
            throw new Error('Tool call does not have function property');
          }

          const toolInput = JSON.parse(functionCall.arguments);
          const result = await toolExecutor(functionCall.name, toolInput);

          yield {
            type: 'tool_use_complete',
            toolName: functionCall.name,
            toolCallId: toolCall.id,
            toolInput: toolInput,
            result: result.displayText,
            hasImages: result.hasImages,
          };

          // Grok tool messages only support string content, so images go in a
          // follow-up user message (Grok supports images in user messages via image_url)
          const textContent = result.contentBlocks
            .filter((b) => b.type === 'text')
            .map((b) => (b as { type: 'text'; text: string }).text)
            .join('\n');
          toolResults.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            name: functionCall.name,
            content: textContent,
          });

          // Collect any image blocks to inject as a user message after tool results
          if (result.hasImages) {
            const imageBlocks = result.contentBlocks.filter((b) => b.type === 'image');
            for (const img of imageBlocks) {
              const imgBlock = img as { type: 'image'; data: string; mimeType: string };
              toolImageParts.push({
                type: 'image_url' as const,
                image_url: {
                  url: `data:${imgBlock.mimeType || 'image/jpeg'};base64,${imgBlock.data}`,
                },
              });
            }
          }
        } catch (error) {
          const functionCall = 'function' in toolCall ? toolCall.function : null;
          const toolName = functionCall?.name || 'unknown';

          toolResults.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            name: toolName,
            content: `Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // Add tool results to conversation
      for (const toolResult of toolResults) {
        conversationMessages.push({
          role: 'tool',
          tool_call_id: toolResult.tool_call_id,
          content: toolResult.content,
        });
      }

      // If any tool results contained images, inject them as a user message
      // Grok doesn't support images in tool messages, but does support them in user messages
      if (toolImageParts.length > 0) {
        conversationMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Here are the image(s) returned by the tool(s) above. Please analyze them as part of the tool results.' },
            ...toolImageParts,
          ],
        } as any);
      }

      hasPendingToolResults = true;
    }
  }

  /**
   * Helper: Convert generic Message[] to OpenAI API format
   */
  private convertToOpenAIMessages(messages: Message[], model?: string): any[] {
    return messages.map((msg) => {
      // Handle user messages with content_blocks (for attachments)
      if (msg.role === 'user' && msg.content_blocks && Array.isArray(msg.content_blocks)) {
        const openaiContent = msg.content_blocks.map((block: any) => {
          // Handle document (PDF) blocks - Grok doesn't support PDFs
          if (block.type === 'document') {
            console.warn('Warning: Grok does not support PDF attachments. Converting to text representation.');
            return {
              type: 'text' as const,
              text: `[PDF File: document.pdf]\n⚠️  PDF attachments are not supported by Grok. Please convert the PDF to images/text before attaching.`,
            };
          }

          // Handle image blocks
          if (block.type === 'image') {
            const mediaType = block.source?.media_type || 'image/png';
            const base64Data = block.source?.data || '';

            if (!base64Data) {
              console.warn('Warning: Image block has no base64 data');
              return {
                type: 'text' as const,
                text: '[Failed to load image]',
              };
            }

            return {
              type: 'image_url' as const,
              image_url: {
                url: `data:${mediaType};base64,${base64Data}`,
              },
            };
          }

          // Handle text blocks
          if (block.type === 'text') {
            return {
              type: 'text' as const,
              text: block.text || '',
            };
          }

          // Fallback for unknown types
          return {
            type: 'text' as const,
            text: JSON.stringify(block),
          };
        });

        return {
          role: 'user' as const,
          content: openaiContent,
        };
      }

      // Handle user messages with tool_results (Anthropic format - from chat restore)
      if (msg.role === 'user' && msg.tool_results && Array.isArray(msg.tool_results) && msg.tool_results.length > 0) {
        const tr = msg.tool_results[0];
        return {
          role: 'tool' as const,
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
        };
      }

      // Handle user messages (standard text)
      if (msg.role === 'user') {
        return {
          role: 'user' as const,
          content: msg.content || '',
        };
      }

      // Handle tool role messages
      if (msg.role === 'tool' && msg.tool_call_id) {
        return {
          role: 'tool' as const,
          tool_call_id: msg.tool_call_id,
          content: msg.content || '',
        };
      }

      // Handle assistant messages with tool_calls
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: 'assistant' as const,
          content: msg.content || '',
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        };
      }

      // Assistant messages without tool_calls
      return {
        role: 'assistant' as const,
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
    const openaiMessages = this.convertToOpenAIMessages(messages, model);

    const response = await this.client.chat.completions.create({
      model: model,
      messages: openaiMessages,
      max_completion_tokens: maxTokens,
    });

    return {
      content: [
        {
          type: 'text',
          text: response.choices[0]?.message?.content || '',
        },
      ],
    };
  }

  /**
   * Get token counts from response metadata
   */
  getTokenCountsFromResponse(response: any): {
    input_tokens: number;
    output_tokens: number;
  } {
    return {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    };
  }

  /**
   * List available models from xAI API
   */
  async listAvailableModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.models.list();

      // Filter to chat completion models and map to ModelInfo
      const chatModels = response.data
        .filter((model) => {
          // Include Grok models
          const id = model.id.toLowerCase();
          return id.startsWith('grok-');
        })
        .map((model) => {
          const modelId = model.id;

          // Check if API response includes context window information
          let contextWindow: number | undefined = undefined;

          if ('context_window' in model && typeof (model as any).context_window === 'number') {
            contextWindow = (model as any).context_window;
            if (contextWindow !== undefined) {
              this.contextWindowCache.set(modelId, contextWindow);
            }
          } else if ('max_context_length' in model && typeof (model as any).max_context_length === 'number') {
            contextWindow = (model as any).max_context_length;
            if (contextWindow !== undefined) {
              this.contextWindowCache.set(modelId, contextWindow);
            }
          }

          // If API doesn't provide context window, use fallback from hardcoded values
          if (contextWindow === undefined) {
            contextWindow = this.getContextWindow(modelId);
            this.contextWindowCache.set(modelId, contextWindow);
          }

          let description = '';
          let capabilities: string[] = ['text', 'tools'];

          if (modelId.includes('4-1')) {
            description = 'Grok 4.1 - Latest multimodal model with 2M context';
            capabilities.push('vision');
          } else if (modelId.includes('grok-4')) {
            description = 'Grok 4 - Advanced model with function calling';
            capabilities.push('vision');
          } else if (modelId.includes('grok-3')) {
            description = 'Grok 3 - Enterprise model for data extraction and coding';
          } else if (modelId.includes('grok-2')) {
            description = 'Grok 2 - Previous generation model';
          }

          if (modelId.includes('fast')) {
            description = description ? `${description} (fast variant)` : 'Fast variant';
          }

          if (modelId.includes('reasoning')) {
            capabilities.push('reasoning');
          }

          return {
            id: modelId,
            name: modelId,
            description,
            contextWindow,
            capabilities,
          };
        })
        .sort((a, b) => {
          // Sort by model family and version (newer first)
          const aPriority = getGrokModelPriority(a.id);
          const bPriority = getGrokModelPriority(b.id);
          if (aPriority !== bPriority) {
            return bPriority - aPriority;
          }
          return b.id.localeCompare(a.id);
        });

      return chatModels;
    } catch (error) {
      // Return hardcoded models as fallback
      console.warn('Failed to fetch models from xAI API, using hardcoded list:', error);
      return Object.entries(GROK_MODEL_CONTEXT_WINDOWS).map(([modelId, contextWindow]) => {
        this.contextWindowCache.set(modelId, contextWindow);

        let description = '';
        let capabilities: string[] = ['text', 'tools'];

        if (modelId.includes('4-1')) {
          description = 'Grok 4.1 - Latest multimodal model with 2M context';
          capabilities.push('vision');
        } else if (modelId.includes('grok-4')) {
          description = 'Grok 4 - Advanced model with function calling';
          capabilities.push('vision');
        } else if (modelId.includes('grok-3')) {
          description = 'Grok 3 - Enterprise model for data extraction and coding';
        } else if (modelId.includes('grok-2')) {
          description = 'Grok 2 - Previous generation model';
        }

        if (modelId.includes('fast')) {
          description = description ? `${description} (fast variant)` : 'Fast variant';
        }

        return {
          id: modelId,
          name: modelId,
          description,
          contextWindow,
          capabilities,
        };
      }).sort((a, b) => {
        const aPriority = getGrokModelPriority(a.id);
        const bPriority = getGrokModelPriority(b.id);
        if (aPriority !== bPriority) {
          return bPriority - aPriority;
        }
        return b.id.localeCompare(a.id);
      });
    }
  }
}

/**
 * Helper function to get model priority for sorting
 * Higher number = higher priority (shown first)
 */
function getGrokModelPriority(modelId: string): number {
  if (modelId.includes('4-1')) return 100;
  if (modelId.includes('grok-4')) return 90;
  if (modelId.includes('grok-3')) return 80;
  if (modelId.includes('grok-2')) return 70;
  return 50;
}
