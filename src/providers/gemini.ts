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

import type { ToolExecutionResult, ContentBlock } from '../core/tool-executor.js';

// Tool Executor Type - function that executes tools on your system
// Returns ToolExecutionResult with display text and content blocks (including images)
export type ToolExecutor = (
  toolName: string,
  toolInput: Record<string, any>,
) => Promise<ToolExecutionResult>;

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
  // Set skipImagesInFunctionResponses to true to disable images in tool results
  // (for models that don't support multimodal function responses)
  private convertMessagesToGeminiFormat(
    messages: Message[],
    skipImagesInFunctionResponses: boolean = false,
  ): any[] {
    const contents: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        // Tool results in Gemini are sent as function_response parts in user messages
        // Build functionResponse object with optional multimodal parts
        const functionResponse: any = {
          name: msg.tool_name || 'unknown',
          response: {
            content: msg.content,
          },
        };

        // Add multimodal parts (images) if content_blocks exist and not skipped
        if (
          !skipImagesInFunctionResponses &&
          msg.content_blocks &&
          Array.isArray(msg.content_blocks)
        ) {
          const parts: any[] = [];

          for (const block of msg.content_blocks) {
            if (block.type === 'image') {
              // Convert image block to Gemini inlineData format
              parts.push({
                inlineData: {
                  mimeType: block.mimeType || 'image/jpeg',
                  data: block.data,
                },
              });
            }
            // Text blocks are already in response.content, skip here
          }

          // Only add parts if we have multimodal content (images)
          if (parts.length > 0) {
            functionResponse.parts = parts;
          }
        }

        const lastContent = contents[contents.length - 1];
        if (lastContent && lastContent.role === 'user') {
          // Append to existing user message
          lastContent.parts.push({ functionResponse });
        } else {
          // Create new user message with function response
          contents.push({
            role: 'user',
            parts: [{ functionResponse }],
          });
        }
      } else if (msg.role === 'assistant') {
        // Check if message contains tool calls (stored in content_blocks)
        const parts: any[] = [];
        
        if (msg.content_blocks && msg.content_blocks.length > 0) {
          // Use raw content blocks if available (preserves function calls)
          for (const block of msg.content_blocks) {
            if (block.type === 'function_call') {
              // Build part with functionCall
              const part: any = {
                functionCall: {
                  name: block.name,
                  args: block.args || {},
                },
              };
              // Include thought signature if present (required for Gemini 3 models, e.g. gemini-3-pro)
              if (block.thoughtSignature) {
                part.thoughtSignature = block.thoughtSignature;
              }
              parts.push(part);
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
        // Handle user messages with content_blocks (for attachments like images)
        const parts: any[] = [];
        
        if (msg.content_blocks && Array.isArray(msg.content_blocks)) {
          // Process content blocks (images, text, etc.)
          for (const block of msg.content_blocks) {
            if (block.type === 'image') {
              // Convert image block to Gemini inlineData format
              // User message images use source.data and source.media_type
              const imageData = (block as any).source?.data || (block as any).data;
              const mimeType = (block as any).source?.media_type || (block as any).mimeType || 'image/jpeg';
              
              if (imageData) {
                parts.push({
                  inlineData: {
                    mimeType,
                    data: imageData,
                  },
                });
              }
            } else if (block.type === 'text' && (block as any).text) {
              // Text blocks
              parts.push({ text: (block as any).text });
            }
            // Note: document blocks (PDFs) are not supported by Gemini API
            // They would need to be converted to images or text first
          }
        }
        
        // If no content blocks or no parts were added, use the text content
        if (parts.length === 0 && msg.content) {
          parts.push({ text: msg.content });
        }
        
        // Only add if we have parts
        if (parts.length > 0) {
          contents.push({
            role: 'user',
            parts,
          });
        }
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
    // Track if this model doesn't support multimodal function responses
    let skipImagesInFunctionResponses = false;

    while (true) {
      // Check for cancellation
      if (cancellationCheck && cancellationCheck()) {
        if (!hasPendingToolResults) {
          break;
        }
      }

      iterations++;

      // Convert messages, optionally skipping images in function responses
      const contents = this.convertMessagesToGeminiFormat(
        conversationMessages,
        skipImagesInFunctionResponses,
      );

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

      // Try to make the API call, with fallback for multimodal errors
      let stream;
      try {
        stream = await this.geminiClient.models.generateContentStream(generateConfig);
      } catch (error: any) {
        // Check if this is a multimodal function response not supported error
        const errorMessage = error?.message || String(error);
        if (
          errorMessage.includes('Multimodal function responses are not supported') &&
          !skipImagesInFunctionResponses
        ) {
          // This model doesn't support images in function responses
          // Retry without images
          skipImagesInFunctionResponses = true;

          // Yield a client info event so the CLI can display it with proper styling
          yield {
            type: 'client_info',
            message: `Model ${model} does not support multimodal function responses. Retrying without images.`,
            provider: 'gemini',
          } as MessageStreamEvent;

          // Re-convert messages without images and retry
          const contentsWithoutImages = this.convertMessagesToGeminiFormat(
            conversationMessages,
            true, // skip images
          );
          generateConfig.contents = contentsWithoutImages;
          stream = await this.geminiClient.models.generateContentStream(generateConfig);
        } else {
          // Re-throw other errors
          throw error;
        }
      }

      // Track function calls and content (including thought signatures - required for Gemini 3, optional for 2.5)
      const functionCalls: Array<{
        name: string;
        args: any;
        id: string;
        thoughtSignature?: string;
      }> = [];
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
                // Capture thought signature (required for Gemini 3, optional for 2.5)
                // The signature is at the part level, not inside functionCall
                const thoughtSignature = (part as any).thoughtSignature;
                functionCalls.push({
                  name: part.functionCall.name || 'unknown',
                  args: part.functionCall.args || {},
                  id: callId,
                  thoughtSignature: thoughtSignature,
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
          // Preserve thought signature (required for Gemini 3, optional for 2.5)
          thoughtSignature: call.thoughtSignature,
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
      const toolResults: Array<{
        name: string;
        content: string;
        contentBlocks: ContentBlock[];
        hasImages: boolean;
      }> = [];
      for (const call of functionCalls) {
        // Check for cancellation before executing each tool
        // This prevents queued tools from executing after abort is requested
        if (cancellationCheck && cancellationCheck()) {
          const cancelledResult = '[Tool execution cancelled by user]';
          // Yield cancelled tool event so client can track it
          yield {
            type: 'tool_use_complete',
            toolName: call.name,
            toolInput: call.args,
            result: cancelledResult,
            hasImages: false,
          };
          toolResults.push({
            name: call.name,
            content: cancelledResult,
            contentBlocks: [{ type: 'text', text: cancelledResult }],
            hasImages: false,
          });
          continue;
        }

        try {
          const result = await toolExecutor(call.name, call.args);

          // Extract text content for structured response
          const textContent = result.contentBlocks
            .filter((b) => b.type === 'text')
            .map((b) => (b as { type: 'text'; text: string }).text)
            .join('\n');

          // Store full content blocks for multimodal response
          toolResults.push({
            name: call.name,
            content: textContent,
            contentBlocks: result.contentBlocks,
            hasImages: result.hasImages,
          });

          // Notify about tool completion (use displayText for CLI)
          yield {
            type: 'tool_use_complete',
            toolName: call.name,
            toolInput: call.args,
            result: result.displayText,
            hasImages: result.hasImages,
          };
        } catch (error: any) {
          const errorResult = `Error executing tool ${call.name}: ${error.message}`;
          toolResults.push({
            name: call.name,
            content: errorResult,
            contentBlocks: [{ type: 'text', text: errorResult }],
            hasImages: false,
          });

          yield {
            type: 'tool_use_complete',
            toolName: call.name,
            toolInput: call.args,
            result: errorResult,
          };
        }
      }

      // Step 4: Add tool results to conversation (preserve content_blocks for images)
      for (const result of toolResults) {
        conversationMessages.push({
          role: 'tool',
          content: result.content,
          tool_name: result.name,
          content_blocks: result.contentBlocks,
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

