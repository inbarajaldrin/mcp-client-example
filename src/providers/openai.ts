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

// OpenAI Token Counter Implementation
export class OpenAITokenCounter implements TokenCounter {
  private encoder: any;
  private maxTokens: number;
  private modelName: string;
  private config: SummarizationConfig;

  constructor(
    modelName: string = 'gpt-5',
    config: Partial<SummarizationConfig> = {},
  ) {
    this.modelName = modelName;
    this.maxTokens =
      OPENAI_MODEL_CONTEXT_WINDOWS[modelName] ||
      OPENAI_MODEL_CONTEXT_WINDOWS['gpt-5'] ||
      200000;

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

  updateModel(modelName: string): void {
    this.modelName = modelName;
    this.maxTokens =
      OPENAI_MODEL_CONTEXT_WINDOWS[modelName] ||
      OPENAI_MODEL_CONTEXT_WINDOWS['gpt-5'] ||
      200000;
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
    return (
      OPENAI_MODEL_CONTEXT_WINDOWS[model] ||
      OPENAI_MODEL_CONTEXT_WINDOWS['gpt-5'] ||
      200000
    );
  }

  getToolType(): any {
    return undefined;
  }

  createTokenCounter(
    model: string,
    config?: Partial<SummarizationConfig>,
  ): TokenCounter {
    return new OpenAITokenCounter(model, config);
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
    const openaiMessages = messages.map((msg) => {
      // Handle tool role messages (OpenAI-specific)
      if (msg.role === 'tool' && msg.tool_call_id) {
        return {
          role: 'tool' as const,
          tool_call_id: msg.tool_call_id,
          content: msg.content,
        };
      }
      // Handle assistant messages with tool_calls (OpenAI-specific)
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
      return {
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      };
    });

    const stream = await this.openaiClient.chat.completions.create({
      model: model,
      messages: openaiMessages,
      max_completion_tokens: maxTokens,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      stream: true,
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

      // Step 1: Send request to OpenAI (non-streaming for tool loop)
      const response = await this.openaiClient.chat.completions.create({
        model: model,
        messages: this.convertToOpenAIMessages(conversationMessages),
        max_completion_tokens: maxTokens,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
      });

      // Convert OpenAI response to normalized format for streaming
      const assistantMessage = response.choices[0].message;

      // Yield message_start event
      yield {
        type: 'message_start',
      } as MessageStreamEvent;

      // Yield text content if present
      if (assistantMessage.content) {
        yield {
          type: 'content_block_start',
          content_block: {
            type: 'text',
          },
        } as MessageStreamEvent;

        yield {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: assistantMessage.content,
          },
        } as MessageStreamEvent;
      }

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

      // Yield token usage from response (OpenAI provides exact counts)
      if (response.usage) {
        yield {
          type: 'token_usage',
          input_tokens: response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens,
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
   * Helper: Convert generic Message[] to OpenAI API format
   */
  private convertToOpenAIMessages(messages: Message[]): any[] {
    return messages.map((msg) => {
      // Handle user messages
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
    const openaiMessages = messages.map((msg) => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content,
    }));

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
}