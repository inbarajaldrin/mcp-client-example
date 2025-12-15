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
} from '../model-provider.js';

// Tool Executor Type - function that executes tools on your system
export type ToolExecutor = (
  toolName: string,
  toolInput: Record<string, any>,
) => Promise<string>;

// OpenAI model context window limits (in tokens)
const OPENAI_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5': 200000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-4-32k': 32768,
  'gpt-3.5-turbo': 16385,
  'gpt-3.5-turbo-16k': 16385,
  'o1-preview': 200000,
  'o1-mini': 128000,
};

// OpenAI does not support PDFs through the vision API
// PDFs are not supported by OpenAI models

// OpenAI Token Counter Implementation
export class OpenAITokenCounter implements TokenCounter {
  private encoder: any;
  private maxTokens: number;
  private modelName: string;
  private config: SummarizationConfig;

  constructor(
    modelName: string = 'gpt-5',
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

    const tiktokenModel = modelName.startsWith('gpt-5')
      ? 'gpt-4'
      : modelName.startsWith('gpt-4')
        ? 'gpt-4'
        : modelName.startsWith('gpt-3.5')
          ? 'gpt-3.5-turbo'
          : modelName.startsWith('o1')
            ? 'gpt-4'
            : 'gpt-4';
    this.encoder = encoding_for_model(tiktokenModel);

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

// OpenAI Provider Implementation
export class OpenAIProvider implements ModelProvider {
  private openaiClient: OpenAI;
  // Dynamic cache of context windows discovered from API only
  private contextWindowCache: Map<string, number> = new Map();

  constructor() {
    this.openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  getProviderName(): string {
    return 'openai';
  }

  getDefaultModel(): string {
    return 'gpt-5';
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
    
    if (!contextWindow) {
      throw new Error(
        `Context window for model "${model}" not available from API. Please ensure the model exists and is accessible.`
      );
    }
    
    return new OpenAITokenCounter(model, config, contextWindow);
  }

  /**
   * Ensure model information is fetched from API
   */
  private async ensureModelInfo(model: string): Promise<void> {
    try {
      // Fetch all models to populate cache
      await this.listAvailableModels();
    } catch (error) {
      // If listAvailableModels fails, try to get model info directly
      // This might not work if API doesn't provide context window
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
    // Use the helper method that properly handles content_blocks (attachments)
    let openaiMessages = this.convertToOpenAIMessages(messages, model);
    
    // Now handle tool-specific conversions for ongoing conversations
    openaiMessages = openaiMessages.map((msg: any) => {
      // For assistant messages with tool_calls, ensure proper format
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: 'assistant' as const,
          content: msg.content || null,
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

    const stream = await this.openaiClient.chat.completions.create({
      model: model,
      messages: openaiMessages,
      max_completion_tokens: maxTokens,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      stream: true,
      stream_options: { include_usage: true },  // Include token usage in final chunk
    });

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
          yield {
            type: 'token_usage',
            input_tokens: chunk.usage.prompt_tokens,
            output_tokens: chunk.usage.completion_tokens,
          } as MessageStreamEvent;
        }

        yield {
          type: 'message_stop',
        } as MessageStreamEvent;
      }
    }
  }

  /**
   * NEW: Agentic loop with tool use support for OpenAI
   * 
   * This method implements the full agentic loop:
   * 1. Send message to OpenAI (non-streaming)
   * 2. Check if OpenAI returned tool_calls
   * 3. Execute tools via toolExecutor callback
   * 4. Send tool results back to OpenAI
   * 5. Repeat until no more tool_calls
   * 
   * Based on official docs:
   * https://platform.openai.com/docs/guides/function-calling
   */
  async *createMessageStreamWithToolUse(
    messages: Message[],
    model: string,
    tools: Tool[],
    maxTokens: number,
    toolExecutor: ToolExecutor,
    maxIterations: number = 10,
  ): AsyncIterable<MessageStreamEvent | { type: 'tool_use_complete'; toolName: string; result: string }> {
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

    while (iterations < maxIterations) {
      iterations++;

      // Step 1: Stream request to OpenAI
      const stream = await this.openaiClient.chat.completions.create({
        model: model,
        messages: this.convertToOpenAIMessages(conversationMessages, model),
        max_completion_tokens: maxTokens,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        stream: true,  // ✅ KEY: Enable streaming
        stream_options: { include_usage: true },  // ✅ KEY: Include token usage in final chunk
      });

      // Track tool calls as they stream in
      const toolCallTracker = new Map<number, { name?: string; id?: string; arguments: string }>();
      let messageStarted = false;
      let assistantContent = '';
      let finalUsage: { prompt_tokens: number; completion_tokens: number } | null = null;

      // Stream events to user while collecting response
      for await (const chunk of stream) {
        // Capture usage information from stream chunks FIRST (OpenAI provides this in final chunks, possibly without choices)
        if (chunk.usage) {
          finalUsage = {
            prompt_tokens: chunk.usage.prompt_tokens || 0,
            completion_tokens: chunk.usage.completion_tokens || 0,
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

      // Create response object for compatibility with rest of code
      // Use actual usage from stream if available, otherwise zeros
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
              // Handle both function and custom tool call types
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

      // Yield token usage from response (OpenAI provides exact counts in final chunk when stream_options.include_usage is true)
      // Always yield if we have usage data - use finalUsage from stream or fallback to response.usage
      const usageToYield = finalUsage || response.usage;
      if (usageToYield) {
        yield {
          type: 'token_usage',
          input_tokens: usageToYield.prompt_tokens || 0,
          output_tokens: usageToYield.completion_tokens || 0,
        } as MessageStreamEvent;
      }

      // Step 2: Check for tool calls
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        // No tool calls → Done! Yield message_stop and exit
        yield {
          type: 'message_stop',
        } as MessageStreamEvent;
        break;
      }

      // Step 3: Tools were called - close current message before executing tools
      yield {
        type: 'message_stop',
      } as MessageStreamEvent;

      // Step 4: Execute tools
      const toolResults: Array<{
        tool_call_id: string;
        role: 'tool';
        name: string;
        content: string;
      }> = [];

      for (const toolCall of assistantMessage.tool_calls) {
        try {
          // Handle both function and custom tool call types
          const functionCall = 'function' in toolCall ? toolCall.function : null;
          if (!functionCall) {
            throw new Error('Tool call does not have function property');
          }

          // Parse arguments from JSON string
          const toolInput = JSON.parse(functionCall.arguments);
          const result = await toolExecutor(functionCall.name, toolInput);

          // Yield the result so caller can see what happened
          yield {
            type: 'tool_use_complete',
            toolName: functionCall.name,
            result: result,
          };

          // Collect result for sending back to OpenAI
          toolResults.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            name: functionCall.name,
            content: result,
          });
        } catch (error) {
          // Handle both function and custom tool call types for error message
          const functionCall = 'function' in toolCall ? toolCall.function : null;
          const toolName = functionCall?.name || 'unknown';
          
          // If tool execution fails, send error back to OpenAI
          toolResults.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            name: toolName,
            content: `Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // Step 5: Add tool results to conversation
      // This is critical - tool results must be added so the model can see them
      for (const toolResult of toolResults) {
        conversationMessages.push({
          role: 'tool',
          tool_call_id: toolResult.tool_call_id,
          content: toolResult.content,
        });
      }

      // Step 6: Loop continues - the next iteration will:
      // - Make another API call with tool results in conversationMessages
      // - The model will see the tool outputs and provide the final response
      // - This response will be yielded in the next iteration (Step 1)
    }
  }

  /**
   * Check if a model supports PDFs
   * OpenAI does not support PDFs - always returns false
   */
  private modelSupportsPDFs(model: string): boolean {
    return false; // OpenAI does not support PDFs
  }

  /**
   * Helper: Convert generic Message[] to OpenAI API format
   * OPTION 2: Properly handles document (PDF) blocks with official conversion
   */
  private convertToOpenAIMessages(messages: Message[], model?: string): any[] {
    return messages.map((msg) => {
      // Handle user messages with content_blocks (for attachments)
      if (msg.role === 'user' && msg.content_blocks && Array.isArray(msg.content_blocks)) {
        // Convert content blocks to OpenAI format
        const openaiContent = msg.content_blocks.map((block: any) => {
          // Handle document (PDF) blocks
          // OpenAI does not support PDFs - return error message
          if (block.type === 'document') {
            console.warn('Warning: OpenAI does not support PDF attachments. Converting to text representation.');
            return {
              type: 'text' as const,
              text: `[PDF File: document.pdf]\n⚠️  PDF attachments are not supported by OpenAI. Please use Claude provider for PDF support, or convert the PDF to images/text before attaching.`,
            };
          }

          // Existing: Handle image blocks
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

          // Existing: Handle text blocks
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
      
      // Handle user messages (standard text)
      if (msg.role === 'user') {
        return {
          role: 'user' as const,
          content: msg.content || '',
        };
      }

      // Handle tool role messages - content must be a string (not null)
      if (msg.role === 'tool' && msg.tool_call_id) {
        return {
          role: 'tool' as const,
          tool_call_id: msg.tool_call_id,
          content: msg.content || '', // Tool messages require string content
        };
      }

      // Handle assistant messages with tool_calls
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: 'assistant' as const,
          content: msg.content || null,
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
        content: msg.content || null,
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

    const response = await this.openaiClient.chat.completions.create({
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
   * Get token counts from OpenAI response metadata
   * Returns exact token counts from API response
   * Includes all input and output tokens
   * Included in every API response
   * 
   * Based on official docs: https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them
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
   * List available models from OpenAI API
   * Fetches models dynamically from the API
   */
  async listAvailableModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.openaiClient.models.list();
      
      // Filter to only chat completion models and map to ModelInfo
      const chatModels = response.data
        .filter((model) => {
          // Only include models that support chat completions
          // OpenAI models typically have 'gpt-' prefix or 'o1-' prefix
          const id = model.id.toLowerCase();
          return (
            id.startsWith('gpt-') ||
            id.startsWith('o1-') ||
            id.includes('chat')
          );
        })
        .map((model) => {
          const modelId = model.id;
          
          // Check if OpenAI API response includes context window information
          // Note: OpenAI's models.list() doesn't directly provide context window
          // We would need to query model details or use a separate endpoint
          // For now, we'll check if it's in the model object
          let contextWindow: number | undefined = undefined;
          
          // Check if model object has context_window or similar field
          if ('context_window' in model && typeof (model as any).context_window === 'number') {
            contextWindow = (model as any).context_window;
            this.contextWindowCache.set(modelId, contextWindow);
          } else if ('max_context_length' in model && typeof (model as any).max_context_length === 'number') {
            contextWindow = (model as any).max_context_length;
            this.contextWindowCache.set(modelId, contextWindow);
          }
          // If API doesn't provide context window, we don't set it
          // User will need to provide it or it will error when getContextWindow is called
          
          let description = '';
          let capabilities: string[] = ['text', 'tools'];
          
          if (modelId.startsWith('gpt-4o')) {
            description = 'Optimized GPT-4 model with vision support';
            capabilities.push('vision');
          } else if (modelId.startsWith('gpt-4')) {
            description = 'GPT-4 model with advanced capabilities';
            if (modelId.includes('turbo')) {
              capabilities.push('vision');
            }
          } else if (modelId.startsWith('gpt-3.5')) {
            description = 'Fast and efficient GPT-3.5 model';
          } else if (modelId.startsWith('o1')) {
            description = 'Reasoning model optimized for complex problem-solving';
          } else if (modelId.startsWith('gpt-5')) {
            description = 'Latest GPT-5 model with extended context';
            capabilities.push('vision');
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
          // GPT-5 > GPT-4 > GPT-3.5, o1 > o1-mini
          const aPriority = getModelPriority(a.id);
          const bPriority = getModelPriority(b.id);
          if (aPriority !== bPriority) {
            return bPriority - aPriority;
          }
          return b.id.localeCompare(a.id);
        });

      return chatModels;
    } catch (error) {
      // No fallback - throw error if API call fails
      throw new Error(
        `Failed to fetch models from OpenAI API: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Helper function to get model priority for sorting
 * Higher number = higher priority (shown first)
 */
function getModelPriority(modelId: string): number {
  if (modelId.startsWith('gpt-5')) return 100;
  if (modelId.startsWith('o1')) return 90;
  if (modelId.startsWith('gpt-4o')) return 80;
  if (modelId.startsWith('gpt-4')) return 70;
  if (modelId.startsWith('gpt-3.5')) return 60;
  return 50;
}