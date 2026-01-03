import { GoogleGenAI } from '@google/genai';
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

// Gemini model context window limits (in tokens)
const GEMINI_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gemini-2.5-flash': 1000000,
  'gemini-2.5-pro': 2000000,
  'gemini-2.0-flash': 1000000,
  'gemini-1.5-flash': 1000000,
  'gemini-1.5-pro': 2000000,
  'gemini-robotics-er-1.5-preview': 1049000,
};

// Gemini Token Counter Implementation
export class GeminiTokenCounter implements TokenCounter {
  private encoder: any;
  private maxTokens: number;
  private modelName: string;
  private config: SummarizationConfig;

  constructor(
    modelName: string = 'gemini-2.5-flash',
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

    // Gemini uses tiktoken for tokenization (cl100k_base encoding like GPT-4)
    this.encoder = encoding_for_model('gpt-4'); // gpt-4 uses cl100k_base

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
      percentage,
      suggestion,
    };
  }

  shouldSummarize(currentTokens: number): boolean {
    if (!this.config.enabled) return false;
    const percentage = (currentTokens / this.maxTokens) * 100;
    return percentage >= this.config.threshold;
  }

  getContextWindow(): number {
    return this.maxTokens;
  }

  getModelName(): string {
    return this.modelName;
  }

  getConfig(): SummarizationConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<SummarizationConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// Gemini Provider Implementation
export class GeminiProvider implements ModelProvider {
  private geminiClient: GoogleGenAI;
  // Dynamic cache of context windows discovered from API only
  private contextWindowCache: Map<string, number> = new Map();

  constructor() {
    this.geminiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
  }

  getProviderName(): string {
    return 'gemini';
  }

  getDefaultModel(): string {
    return 'gemini-2.5-flash';
  }

  getToolType(): any {
    return Object;
  }

  // Convert MCP tool format to Gemini function declaration format
  private convertToolsToGeminiFormat(tools: Tool[]): any {
    if (tools.length === 0) {
      return null;
    }
    
    // Gemini expects tools as an array with a single object containing functionDeclarations
    return [{
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      })),
    }];
  }

  // Convert our generic Message format to Gemini Content format
  private convertMessagesToGeminiFormat(messages: Message[]): any[] {
    const contents: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        // Tool results in Gemini are sent as function_response parts in user messages
        const lastContent = contents[contents.length - 1];
        if (lastContent && lastContent.role === 'user') {
          // Append to existing user message
          lastContent.parts.push({
            functionResponse: {
              name: msg.tool_name || 'unknown',
              response: {
                content: msg.content,
              },
            },
          });
        } else {
          // Create new user message with function response
          contents.push({
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: msg.tool_name || 'unknown',
                  response: {
                    content: msg.content,
                  },
                },
              },
            ],
          });
        }
      } else if (msg.role === 'assistant') {
        // Check if message contains tool calls (stored in content_blocks)
        const parts: any[] = [];
        
        if (msg.content_blocks && msg.content_blocks.length > 0) {
          // Use raw content blocks if available (preserves function calls)
          for (const block of msg.content_blocks) {
            if (block.type === 'function_call') {
              parts.push({
                functionCall: {
                  name: block.name,
                  args: block.args || {},
                },
              });
            } else if (block.type === 'text' && block.text) {
              parts.push({ text: block.text });
            }
          }
        } else if (msg.content) {
          // Regular text content
          parts.push({ text: msg.content });
        }

        if (parts.length > 0) {
          contents.push({
            role: 'model', // Gemini uses 'model' instead of 'assistant'
            parts,
          });
        }
      } else if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return contents;
  }

  // Create streaming message completion
  async *createMessageStream(
    messages: Message[],
    model: string,
    tools: Tool[],
    maxTokens: number,
  ): AsyncIterable<MessageStreamEvent> {
    const contents = this.convertMessagesToGeminiFormat(messages);
    const geminiTools = this.convertToolsToGeminiFormat(tools);

    try {
      const generateConfig: any = {
        model,
        contents,
        config: {
          maxOutputTokens: maxTokens,
          temperature: 0.7,
        },
      };

      // Add tools if provided
      if (geminiTools) {
        generateConfig.config.tools = geminiTools;
        // Enable function calling mode
        generateConfig.config.toolConfig = {
          functionCallingConfig: {
            mode: 'AUTO', // Let Gemini decide when to call functions
          },
        };
      }

      // Use the streaming API - it returns an AsyncGenerator directly
      const stream = await this.geminiClient.models.generateContentStream(generateConfig);

      // Process the stream - the stream IS the AsyncGenerator
      for await (const chunk of stream) {
        // Extract candidates from the chunk
        if (chunk.candidates && chunk.candidates.length > 0) {
          const candidate = chunk.candidates[0];
          
          if (candidate.content && candidate.content.parts) {
            for (const part of candidate.content.parts) {
              if (part.text) {
                // Text content
                yield {
                  type: 'content_block_delta',
                  delta: {
                    type: 'text_delta',
                    text: part.text,
                  },
                };
              } else if (part.functionCall) {
                // Function call
                yield {
                  type: 'content_block_start',
                  content_block: {
                    type: 'function_call',
                    id: `call_${Date.now()}`,
                    name: part.functionCall.name,
                    args: part.functionCall.args,
                  },
                };
              }
            }
          }

          // Handle finish reason
          if (candidate.finishReason) {
            yield {
              type: 'message_stop',
              stop_reason: candidate.finishReason.toLowerCase(),
            };
          }
        }

        // Handle usage metadata
        if (chunk.usageMetadata) {
          yield {
            type: 'usage',
            input_tokens: chunk.usageMetadata.promptTokenCount || 0,
            output_tokens: chunk.usageMetadata.candidatesTokenCount || 0,
          };
        }
      }

      // Signal completion
      yield {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
        },
      };
    } catch (error: any) {
      console.error('Gemini API Error:', error);
      throw new Error(`Gemini API error: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Agentic loop with tool use support
   * 
   * This method:
   * 1. Streams request to Gemini
   * 2. If Gemini calls tools, execute them
   * 3. Add tool results to conversation
   * 4. Stream the next response
   * 5. Repeat until no more tool calls
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
    const geminiTools = this.convertToolsToGeminiFormat(tools);

    let conversationMessages = [...messages];
    let iterations = 0;
    let hasPendingToolResults = false;

    while (true) {
      // Check for cancellation
      if (cancellationCheck && cancellationCheck()) {
        if (!hasPendingToolResults) {
          break;
        }
      }

      iterations++;

      const contents = this.convertMessagesToGeminiFormat(conversationMessages);

      // Step 1: Stream request to Gemini
      const generateConfig: any = {
        model,
        contents,
        config: {
          maxOutputTokens: maxTokens,
          temperature: 0.7,
        },
      };

      if (geminiTools) {
        generateConfig.config.tools = geminiTools;
        // Enable function calling mode
        generateConfig.config.toolConfig = {
          functionCallingConfig: {
            mode: 'AUTO', // Let Gemini decide when to call functions
          },
        };
        
        // Debug: log tool count
        if (process.env.VERBOSE_LOGGING) {
          const toolCount = geminiTools[0]?.functionDeclarations?.length || 0;
          console.log(`[Gemini] Sending ${toolCount} tools to model`);
          if (toolCount > 0) {
            console.log(`[Gemini] First tool: ${JSON.stringify(geminiTools[0].functionDeclarations[0], null, 2)}`);
          }
        }
      }

      const stream = await this.geminiClient.models.generateContentStream(generateConfig);

      // Track function calls and content
      const functionCalls: Array<{ name: string; args: any; id: string }> = [];
      let assistantContent = '';
      let messageStarted = false;
      let finalUsage: { promptTokenCount?: number; candidatesTokenCount?: number } | null = null;

      // Stream events to user while collecting response
      for await (const chunk of stream) {
        // Capture usage information
        if (chunk.usageMetadata) {
          finalUsage = {
            promptTokenCount: chunk.usageMetadata.promptTokenCount || 0,
            candidatesTokenCount: chunk.usageMetadata.candidatesTokenCount || 0,
          };
        }

        if (chunk.candidates && chunk.candidates.length > 0) {
          const candidate = chunk.candidates[0];

          if (candidate.content && candidate.content.parts) {
            for (const part of candidate.content.parts) {
              if (part.text) {
                // Text content - emit message_start before first text
                if (!messageStarted) {
                  yield { type: 'message_start' } as MessageStreamEvent;
                  messageStarted = true;
                }
                assistantContent += part.text;
                yield {
                  type: 'content_block_delta',
                  delta: {
                    type: 'text_delta',
                    text: part.text,
                  },
                } as MessageStreamEvent;
              } else if (part.functionCall) {
                // Function call - emit message_start before first tool use
                if (!messageStarted) {
                  yield { type: 'message_start' } as MessageStreamEvent;
                  messageStarted = true;
                }
                const callId = `call_${Date.now()}_${functionCalls.length}`;
                functionCalls.push({
                  name: part.functionCall.name || 'unknown',
                  args: part.functionCall.args || {},
                  id: callId,
                });
                yield {
                  type: 'content_block_start',
                  content_block: {
                    type: 'tool_use',
                    name: part.functionCall.name,
                    id: callId,
                  },
                } as MessageStreamEvent;
              }
            }
          }

          // Handle finish reason
          if (candidate.finishReason) {
            yield {
              type: 'message_delta',
              delta: {
                stop_reason: candidate.finishReason.toLowerCase(),
              },
            } as MessageStreamEvent;
            yield { type: 'message_stop' } as MessageStreamEvent;
          }
        }
      }

      // Emit token usage
      if (finalUsage) {
        yield {
          type: 'usage',
          input_tokens: finalUsage.promptTokenCount || 0,
          output_tokens: finalUsage.candidatesTokenCount || 0,
        } as MessageStreamEvent;
      }

      // Add assistant message to conversation
      const contentBlocks: any[] = [];
      if (assistantContent) {
        contentBlocks.push({ type: 'text', text: assistantContent });
      }
      for (const call of functionCalls) {
        contentBlocks.push({
          type: 'function_call',
          name: call.name,
          args: call.args,
          id: call.id,
        });
      }

      conversationMessages.push({
        role: 'assistant',
        content: assistantContent || '',
        content_blocks: contentBlocks,
      });

      // If we just sent pending tool results and are cancelled, break now
      if (hasPendingToolResults && cancellationCheck && cancellationCheck()) {
        yield { type: 'message_stop' } as MessageStreamEvent;
        break;
      }

      hasPendingToolResults = false;

      // Step 2: If no function calls, we're done
      if (functionCalls.length === 0) {
        break;
      }

      // Step 3: Execute tools
      const toolResults: Array<{ name: string; content: string }> = [];
      for (const call of functionCalls) {
        try {
          const result = await toolExecutor(call.name, call.args);
          toolResults.push({
            name: call.name,
            content: result,
          });

          // Notify about tool completion
          yield {
            type: 'tool_use_complete',
            toolName: call.name,
            toolInput: call.args,
            result,
          };
        } catch (error: any) {
          const errorResult = `Error executing tool ${call.name}: ${error.message}`;
          toolResults.push({
            name: call.name,
            content: errorResult,
          });

          yield {
            type: 'tool_use_complete',
            toolName: call.name,
            toolInput: call.args,
            result: errorResult,
          };
        }
      }

      // Step 4: Add tool results to conversation
      for (const result of toolResults) {
        conversationMessages.push({
          role: 'tool',
          content: result.content,
          tool_name: result.name,
        });
      }

      hasPendingToolResults = true;

      // Check for cancellation and max iterations
      if (cancellationCheck && cancellationCheck()) {
        // Continue one more time to send results
        continue;
      }

      if (iterations >= maxIterations) {
        console.warn(`Gemini: Max iterations (${maxIterations}) reached`);
        break;
      }
    }
  }

  // Get context window size for a model
  getContextWindow(model: string): number {
    // Check cache first
    if (this.contextWindowCache.has(model)) {
      return this.contextWindowCache.get(model)!;
    }

    // Fallback to hardcoded values
    return GEMINI_MODEL_CONTEXT_WINDOWS[model] || 1000000;
  }

  // Create token counter for a model
  async createTokenCounter(
    model: string,
    config?: Partial<SummarizationConfig>,
  ): Promise<TokenCounter> {
    // Ensure we have context window info
    if (!this.contextWindowCache.has(model)) {
      await this.listAvailableModels();
    }

    const contextWindow = this.getContextWindow(model);
    return new GeminiTokenCounter(model, config, contextWindow);
  }

  // List available models from Gemini API
  async listAvailableModels(): Promise<ModelInfo[]> {
    try {
      const pager = await this.geminiClient.models.list();
      const models: ModelInfo[] = [];

      // Iterate through the pager to get all models
      for await (const model of pager) {
        const modelId = model.name?.replace('models/', '') || '';
        const contextWindow = model.inputTokenLimit || GEMINI_MODEL_CONTEXT_WINDOWS[modelId] || 1000000;

        // Cache the context window
        this.contextWindowCache.set(modelId, contextWindow);

        models.push({
          id: modelId,
          name: model.displayName || modelId,
          description: model.description || '',
          contextWindow,
          capabilities: this.getModelCapabilities(model),
        });
      }

      // If API didn't return models, return hardcoded defaults
      if (models.length === 0) {
        return this.getDefaultModels();
      }

      return models;
    } catch (error: any) {
      console.warn('Failed to fetch Gemini models from API:', error.message);
      // Return hardcoded defaults on error
      return this.getDefaultModels();
    }
  }

  private getModelCapabilities(model: any): string[] {
    const capabilities: string[] = [];
    
    if (model.supportedGenerationMethods) {
      capabilities.push(...model.supportedGenerationMethods);
    }

    return capabilities;
  }

  private getDefaultModels(): ModelInfo[] {
    const models: ModelInfo[] = [];
    
    for (const [id, contextWindow] of Object.entries(GEMINI_MODEL_CONTEXT_WINDOWS)) {
      this.contextWindowCache.set(id, contextWindow);
      models.push({
        id,
        name: id,
        description: `Gemini model: ${id}`,
        contextWindow,
        capabilities: ['generateContent', 'streamGenerateContent'],
      });
    }

    return models;
  }
}

