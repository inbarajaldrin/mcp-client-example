/**
 * Ollama Provider for MCP Client
 * 
 * This provider implementation was inspired by and references the excellent
 * mcp-client-for-ollama project by jonigl:
 * https://github.com/jonigl/mcp-client-for-ollama
 */

import { Ollama } from 'ollama';
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

// Provider metadata - exported for use by CLI
export const PROVIDER_INFO = {
  name: 'ollama',
  label: 'Ollama (Local LLMs)',
  defaultModel: 'llama3.2:3b',
  models: ['llama3.2:3b', 'llama3.1:8b', 'mistral:7b'],
};

// Default Ollama host
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.2:3b';

// Default max context window to prevent OOM errors
// Can be overridden with OLLAMA_MAX_CONTEXT environment variable
// Set to 0 or 'unlimited' to use model's full capacity
const DEFAULT_MAX_CONTEXT = 16384; // 16K tokens - conservative default to avoid OOM with larger models

// Ollama-specific metrics (nanoseconds for durations)
export interface OllamaMetrics {
  totalDuration?: number;      // nanoseconds
  loadDuration?: number;       // nanoseconds
  evalDuration?: number;       // nanoseconds
  promptEvalDuration?: number; // nanoseconds
  evalCount?: number;          // output tokens
  promptEvalCount?: number;    // input tokens
  evalRate?: number;           // tokens/second
  promptEvalRate?: number;     // tokens/second
}

import type { ToolExecutionResult } from '../core/tool-executor.js';

// Tool Executor Type - function that executes tools on your system
// Returns ToolExecutionResult with display text and content blocks (including images)
export type ToolExecutor = (
  toolName: string,
  toolInput: Record<string, any>,
) => Promise<ToolExecutionResult>;

// Ollama Token Counter Implementation
export class OllamaTokenCounter implements TokenCounter {
  private maxTokens: number;
  private modelName: string;
  private config: SummarizationConfig;
  private currentTokenCount: number = 0;

  constructor(
    modelName: string,
    config: Partial<SummarizationConfig> = {},
    contextWindow: number = 4096,
  ) {
    this.modelName = modelName;
    this.maxTokens = contextWindow;

    this.config = {
      threshold: 80, // Default: summarize at 80% of context window
      recentMessagesToKeep: 10, // Default: keep last 10 messages
      enabled: true,
      ...config,
    };
  }

  // Ollama doesn't provide a token counting API, so we estimate
  // Average English word is ~4 characters, average token is ~4 characters
  countTokens(text: string): number {
    // Simple estimation: ~4 characters per token (rough approximation)
    return Math.ceil(text.length / 4);
  }

  countMessageTokens(message: { role: string; content: string }): number {
    const roleTokens = this.countTokens(message.role);
    const contentTokens = this.countTokens(message.content);
    // Add overhead for message structure (approximately 4 tokens)
    return roleTokens + contentTokens + 4;
  }

  // Update token count from Ollama's actual metrics
  updateFromMetrics(evalCount: number, promptEvalCount: number): void {
    this.currentTokenCount = evalCount + promptEvalCount;
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
    if (contextWindow) {
      this.maxTokens = contextWindow;
    }
  }

  getConfig(): SummarizationConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<SummarizationConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// Ollama Provider Implementation
export class OllamaProvider implements ModelProvider {
  private ollamaClient: Ollama;
  private contextWindowCache: Map<string, number> = new Map();
  private modelCapabilitiesCache: Map<string, string[]> = new Map();
  private host: string;
  private maxContextWindow: number;

  constructor(host?: string) {
    this.host = host || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST;
    this.ollamaClient = new Ollama({ host: this.host });
    
    // Parse max context window from environment or use default
    const maxCtxEnv = process.env.OLLAMA_MAX_CONTEXT;
    if (maxCtxEnv === 'unlimited' || maxCtxEnv === '0') {
      this.maxContextWindow = Infinity;
    } else if (maxCtxEnv && !isNaN(parseInt(maxCtxEnv))) {
      this.maxContextWindow = parseInt(maxCtxEnv);
    } else {
      this.maxContextWindow = DEFAULT_MAX_CONTEXT;
    }
  }

  getProviderName(): string {
    return 'ollama';
  }

  getDefaultModel(): string {
    return DEFAULT_MODEL;
  }

  /**
   * Get context window for a model, capped at maxContextWindow to prevent OOM.
   * Returns the model's actual context window or the configured max, whichever is smaller.
   * 
   * The max can be configured via OLLAMA_MAX_CONTEXT environment variable:
   * - Set to a number (e.g., "32768" for 32K)
   * - Set to "unlimited" or "0" to use model's full capacity
   * - Default: 32K tokens (safe for most systems)
   */
  getContextWindow(model: string): number {
    // Return cached value if available
    if (this.contextWindowCache.has(model)) {
      const cached = this.contextWindowCache.get(model)!;
      
      // Cap at maxContextWindow to prevent OOM errors
      // Unless maxContextWindow is Infinity (unlimited mode)
      const contextWindow = this.maxContextWindow === Infinity 
        ? cached 
        : Math.min(cached, this.maxContextWindow);
      
      // ALWAYS set num_ctx to ensure tools fit in context
      // Ollama's default (2048) is too small when we have many tools
      return contextWindow;
    }
    // If we don't know the context window, use a safe default that fits tools
    // Don't rely on Ollama's default (2048) which is too small
    return 8192; // 8K is reasonable when we don't know the model's capacity
  }

  getToolType(): any {
    return undefined;
  }

  /**
   * Check if Ollama server is running
   */
  async isServerRunning(): Promise<boolean> {
    try {
      await this.ollamaClient.list();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a model supports thinking mode
   */
  async supportsThinkingMode(model: string): Promise<boolean> {
    try {
      // Check cache first
      if (this.modelCapabilitiesCache.has(model)) {
        const capabilities = this.modelCapabilitiesCache.get(model)!;
        return capabilities.includes('thinking');
      }

      // Fetch model info
      const modelInfo = await this.ollamaClient.show({ model });
      
      // Extract capabilities from model info
      const capabilities: string[] = [];
      if (modelInfo && typeof modelInfo === 'object') {
        // Check for capabilities field
        if ('capabilities' in modelInfo && Array.isArray((modelInfo as any).capabilities)) {
          capabilities.push(...(modelInfo as any).capabilities);
        }
      }
      
      // Cache capabilities
      this.modelCapabilitiesCache.set(model, capabilities);
      
      return capabilities.includes('thinking');
    } catch {
      return false;
    }
  }

  /**
   * Fetch and cache model information
   */
  private async fetchModelInfo(model: string): Promise<void> {
    try {
      const modelInfo = await this.ollamaClient.show({ model });
      
      // Extract context window from model info
      // Ollama API returns context_length directly in the response
      if (modelInfo) {
        let contextWindow = 4096; // Default fallback
        
        // First, try to get context_length directly from the response
        // This is the primary field returned by ollama show
        if ('context_length' in modelInfo && typeof (modelInfo as any).context_length === 'number') {
          contextWindow = (modelInfo as any).context_length;
        }
        // Try model_info field (nested structure)
        else if ('model_info' in modelInfo && typeof (modelInfo as any).model_info === 'object') {
          const info = (modelInfo as any).model_info;
          // Common fields for context length
          if (info['context_length']) {
            contextWindow = info['context_length'];
          } else {
            // Search for architecture-specific context_length fields
            // Different models use different prefixes: llama.context_length, qwen2.context_length, etc.
            const contextLengthKey = Object.keys(info).find(key => key.endsWith('.context_length'));
            if (contextLengthKey && typeof info[contextLengthKey] === 'number') {
              contextWindow = info[contextLengthKey];
            }
          }
        }
        // Fallback: try to extract from modelfile or parameters
        else if ('modelfile' in modelInfo && typeof (modelInfo as any).modelfile === 'string') {
          const modelfile = (modelInfo as any).modelfile;
          // Look for num_ctx parameter
          const ctxMatch = modelfile.match(/num_ctx\s+(\d+)/i);
          if (ctxMatch) {
            contextWindow = parseInt(ctxMatch[1], 10);
          }
        }
        
        this.contextWindowCache.set(model, contextWindow);
        
        // Also cache capabilities
        const capabilities: string[] = [];
        if ('capabilities' in modelInfo && Array.isArray((modelInfo as any).capabilities)) {
          capabilities.push(...(modelInfo as any).capabilities);
        }
        this.modelCapabilitiesCache.set(model, capabilities);
      }
    } catch (error) {
      // Use default if we can't fetch model info
      this.contextWindowCache.set(model, 4096);
    }
  }

  async createTokenCounter(
    model: string,
    config?: Partial<SummarizationConfig>,
  ): Promise<TokenCounter> {
    // Ensure we have context window for this model
    if (!this.contextWindowCache.has(model)) {
      await this.fetchModelInfo(model);
    }
    
    // Use cached value or default to 8192 if not available
    // Use the model's actual context window for accurate token counting
    const cachedWindow = this.contextWindowCache.get(model);
    const contextWindow = cachedWindow || 8192; // Use actual context window, fallback to 8K if unknown
    return new OllamaTokenCounter(model, config, contextWindow);
  }

  /**
   * List available models from Ollama
   */
  async listAvailableModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.ollamaClient.list();
      
      const models: ModelInfo[] = [];
      
      if (response && response.models) {
        for (const model of response.models) {
          // Fetch context window for each model
          if (!this.contextWindowCache.has(model.name)) {
            await this.fetchModelInfo(model.name);
          }
          
          // Get the actual context window that will be used (with cap applied)
          const contextWindow = this.getContextWindow(model.name);
          const capabilities = this.modelCapabilitiesCache.get(model.name) || [];
          
          models.push({
            id: model.name,
            name: model.name,
            description: `Size: ${this.formatBytes(model.size)}`,
            contextWindow,
            capabilities: ['text', 'tools', ...capabilities],
          });
        }
      }
      
      return models;
    } catch (error) {
      throw new Error(
        `Failed to fetch models from Ollama. Is Ollama running at ${this.host}? Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * Convert generic Tool[] to Ollama tool format
   */
  private convertToolsToOllamaFormat(tools: Tool[]): any[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  /**
   * Convert generic Message[] to Ollama message format
   */
  private convertToOllamaMessages(messages: Message[]): any[] {
    return messages.map((msg) => {
      // Handle tool result messages - Ollama expects tool_name, not tool_call_id
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content || '',
          // Ollama uses tool_name to identify which tool the result is for
          ...(msg.tool_name && { tool_name: msg.tool_name }),
        };
      }

      // Handle assistant messages with tool_calls
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              // Ollama expects arguments as an object, not a string
              arguments: typeof tc.arguments === 'string' 
                ? JSON.parse(tc.arguments) 
                : tc.arguments,
            },
          })),
        };
      }

      // Handle user messages with content_blocks (for attachments)
      if (msg.role === 'user' && msg.content_blocks && Array.isArray(msg.content_blocks)) {
        // Ollama supports images via base64
        const images: string[] = [];
        let textContent = '';
        
        for (const block of msg.content_blocks) {
          if (block.type === 'image' && block.source?.data) {
            images.push(block.source.data);
          } else if (block.type === 'text') {
            textContent += block.text || '';
          }
        }
        
        const result: any = {
          role: 'user',
          content: textContent || msg.content || '',
        };
        
        if (images.length > 0) {
          result.images = images;
        }
        
        return result;
      }

      // Standard messages (user or assistant without tool_calls)
      const result: any = {
        role: msg.role,
        content: msg.content || '',
      };
      // Preserve images field (e.g. from tool result image injection)
      if ((msg as any).images) {
        result.images = (msg as any).images;
      }
      return result;
    });
  }

  /**
   * Extract Ollama metrics from a response chunk
   */
  private extractMetrics(chunk: any): OllamaMetrics | null {
    if (!chunk || !chunk.done) {
      return null;
    }

    const metrics: OllamaMetrics = {};

    if (chunk.total_duration !== undefined) {
      metrics.totalDuration = chunk.total_duration;
    }
    if (chunk.load_duration !== undefined) {
      metrics.loadDuration = chunk.load_duration;
    }
    if (chunk.prompt_eval_count !== undefined) {
      metrics.promptEvalCount = chunk.prompt_eval_count;
    }
    if (chunk.prompt_eval_duration !== undefined) {
      metrics.promptEvalDuration = chunk.prompt_eval_duration;
      // Calculate prompt eval rate (tokens/second)
      const promptDuration = metrics.promptEvalDuration;
      if (metrics.promptEvalCount && promptDuration && promptDuration > 0) {
        metrics.promptEvalRate = metrics.promptEvalCount / (promptDuration / 1_000_000_000);
      }
    }
    if (chunk.eval_count !== undefined) {
      metrics.evalCount = chunk.eval_count;
    }
    if (chunk.eval_duration !== undefined) {
      metrics.evalDuration = chunk.eval_duration;
      // Calculate eval rate (tokens/second)
      const evalDuration = metrics.evalDuration;
      if (metrics.evalCount && evalDuration && evalDuration > 0) {
        metrics.evalRate = metrics.evalCount / (evalDuration / 1_000_000_000);
      }
    }

    return Object.keys(metrics).length > 0 ? metrics : null;
  }

  /**
   * Create a streaming message completion
   */
  async *createMessageStream(
    messages: Message[],
    model: string,
    tools: Tool[],
    maxTokens: number,
  ): AsyncIterable<MessageStreamEvent> {
    // Ensure context window is cached for this model
    if (!this.contextWindowCache.has(model)) {
      await this.fetchModelInfo(model);
    }
    
    const ollamaMessages = this.convertToOllamaMessages(messages);
    const ollamaTools = tools.length > 0 ? this.convertToolsToOllamaFormat(tools) : undefined;

    const contextWindow = this.getContextWindow(model);
    const options: any = {
      num_predict: maxTokens,
      num_ctx: contextWindow,
    };

    const stream = await this.ollamaClient.chat({
      model,
      messages: ollamaMessages,
      tools: ollamaTools,
      stream: true,
      options,
    });

    let messageStarted = false;
    const toolCallTracker = new Map<number, { name?: string; id?: string; arguments: string }>();

    for await (const chunk of stream) {
      if (!messageStarted) {
        yield { type: 'message_start' } as MessageStreamEvent;
        messageStarted = true;
      }

      // Handle thinking content
      if (chunk.message?.thinking) {
        yield {
          type: 'content_block_delta',
          delta: {
            type: 'thinking_delta',
            thinking: chunk.message.thinking,
          },
        } as MessageStreamEvent;
      }

      // Handle regular content
      if (chunk.message?.content) {
        yield {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: chunk.message.content,
          },
        } as MessageStreamEvent;
      }

      // Handle tool calls
      if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
        for (let i = 0; i < chunk.message.tool_calls.length; i++) {
          const toolCall = chunk.message.tool_calls[i];
          
          if (!toolCallTracker.has(i)) {
            const toolId = `ollama_tool_${Date.now()}_${i}`;
            toolCallTracker.set(i, { arguments: '', id: toolId });

            // Emit tool use start
            yield {
              type: 'content_block_start',
              content_block: {
                type: 'tool_use',
                name: toolCall.function?.name,
                id: toolId,
              },
            } as MessageStreamEvent;
          }

          const tracker = toolCallTracker.get(i)!;
          if (!tracker.name && toolCall.function?.name) {
            tracker.name = toolCall.function.name;
          }
          
          // Emit tool arguments
          if (toolCall.function?.arguments) {
            const argsStr = typeof toolCall.function.arguments === 'string'
              ? toolCall.function.arguments
              : JSON.stringify(toolCall.function.arguments);
            
            yield {
              type: 'content_block_delta',
              delta: {
                type: 'input_json_delta',
                partial_json: argsStr,
              },
            } as MessageStreamEvent;
          }
        }
      }

      // Handle completion with metrics
      if (chunk.done) {
        const metrics = this.extractMetrics(chunk);
        
        // Determine stop reason
        const hasToolCalls = toolCallTracker.size > 0;
        const stopReason = hasToolCalls ? 'tool_use' : 'end_turn';
        
        yield {
          type: 'message_delta',
          delta: {
            stop_reason: stopReason,
          },
        } as MessageStreamEvent;

        // Emit token usage with Ollama metrics
        if (metrics) {
          yield {
            type: 'token_usage',
            input_tokens: metrics.promptEvalCount || 0,
            output_tokens: metrics.evalCount || 0,
            ollama_metrics: metrics,
          } as MessageStreamEvent;
        }

        yield { type: 'message_stop' } as MessageStreamEvent;
      }
    }
  }

  /**
   * Agentic loop with tool use support
   */
  async *createMessageStreamWithToolUse(
    messages: Message[],
    model: string,
    tools: Tool[],
    maxTokens: number,
    toolExecutor: ToolExecutor,
    maxIterations: number = 10,
    cancellationCheck?: () => boolean,
    thinkingMode: boolean = false,
  ): AsyncIterable<MessageStreamEvent | { type: 'tool_use_complete'; toolName: string; toolInput: Record<string, any>; result: string }> {
    // Ensure context window is cached for this model
    if (!this.contextWindowCache.has(model)) {
      await this.fetchModelInfo(model);
    }
    
    const ollamaTools = tools.length > 0 ? this.convertToolsToOllamaFormat(tools) : undefined;
    
    // Debug: log tool count and context window
    if (process.env.VERBOSE_LOGGING) {
      const ctxWindow = this.getContextWindow(model);
      console.log(`[Ollama] Context window for ${model}: ${ctxWindow ?? 'Ollama default (not set)'}`);
    }
    if (process.env.VERBOSE_LOGGING) {
      console.log(`[Ollama] Sending ${tools.length} tools to model ${model}`);
      // List all tool names
      const toolNames = tools.map(t => t.name);
      console.log(`[Ollama] All tools: ${toolNames.join(', ')}`);
      if (ollamaTools && ollamaTools.length > 0) {
        console.log(`[Ollama] First tool: ${JSON.stringify(ollamaTools[0], null, 2)}`);
      }
    }

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

      // Build chat request
      const contextWindow = this.getContextWindow(model);
      const options: any = {
        num_predict: maxTokens,
      };
      // Only set num_ctx if we need to cap it (following mcp-client-for-ollama pattern)
      if (contextWindow !== undefined) {
        options.num_ctx = contextWindow;
      }

      const chatParams: any = {
        model,
        messages: this.convertToOllamaMessages(conversationMessages),
        tools: ollamaTools,
        stream: true,
        options,
      };

      // Debug: Log actual request to Ollama
      if (process.env.VERBOSE_LOGGING) {
        console.log(`[Ollama] Chat params:`, {
          model,
          messageCount: chatParams.messages.length,
          toolCount: ollamaTools?.length || 0,
          options,
        });
        console.log(`[Ollama] First 5 tool names:`, ollamaTools?.slice(0, 5).map(t => t.function.name));
        console.log(`[Ollama] Last 5 tool names:`, ollamaTools?.slice(-5).map(t => t.function.name));
      }

      // Add thinking mode if supported
      if (thinkingMode) {
        chatParams.think = true;
      }

      // Debug: log request details
      if (process.env.VERBOSE_LOGGING) {
        console.log(`[Ollama] Chat request:`, JSON.stringify({
          model: chatParams.model,
          messageCount: chatParams.messages.length,
          toolCount: chatParams.tools?.length || 0,
        }));
        // Log the last few messages to debug tool result format
        const lastMessages = chatParams.messages.slice(-3);
        console.log(`[Ollama] Last messages:`, JSON.stringify(lastMessages, null, 2));
      }

      let stream;
      try {
        stream = await this.ollamaClient.chat(chatParams);
      } catch (error) {
        console.error(`[Ollama] Error calling chat API:`, error);
        throw error;
      }

      let messageStarted = false;
      let assistantContent = '';
      let thinkingContent = '';
      const toolCalls: Array<{ id: string; name: string; arguments: any }> = [];
      let metrics: OllamaMetrics | null = null;

      // Stream response
      for await (const chunk of stream) {
        // Debug: log first chunk
        if (process.env.VERBOSE_LOGGING && !messageStarted) {
          console.log(`[Ollama] First chunk:`, JSON.stringify(chunk, null, 2).substring(0, 500));
        }
        
        if (!messageStarted) {
          yield { type: 'message_start' } as MessageStreamEvent;
          messageStarted = true;
        }

        // Handle thinking content
        if (chunk.message?.thinking) {
          thinkingContent += chunk.message.thinking;
          yield {
            type: 'content_block_delta',
            delta: {
              type: 'thinking_delta',
              thinking: chunk.message.thinking,
            },
          } as MessageStreamEvent;
        }

        // Handle regular content
        if (chunk.message?.content) {
          assistantContent += chunk.message.content;
          yield {
            type: 'content_block_delta',
            delta: {
              type: 'text_delta',
              text: chunk.message.content,
            },
          } as MessageStreamEvent;
        }

        // Handle tool calls
        if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
          for (let i = 0; i < chunk.message.tool_calls.length; i++) {
            const toolCall = chunk.message.tool_calls[i];
            const toolId = `ollama_tool_${Date.now()}_${i}`;
            
            // Check if we already have this tool call
            if (toolCalls.length <= i) {
              toolCalls.push({
                id: toolId,
                name: toolCall.function?.name || '',
                arguments: toolCall.function?.arguments || {},
              });
              
              yield {
                type: 'content_block_start',
                content_block: {
                  type: 'tool_use',
                  name: toolCall.function?.name,
                  id: toolId,
                },
              } as MessageStreamEvent;
              
              if (toolCall.function?.arguments) {
                const argsStr = typeof toolCall.function.arguments === 'string'
                  ? toolCall.function.arguments
                  : JSON.stringify(toolCall.function.arguments);
                
                yield {
                  type: 'content_block_delta',
                  delta: {
                    type: 'input_json_delta',
                    partial_json: argsStr,
                  },
                } as MessageStreamEvent;
              }
            }
          }
        }

        // Handle completion
        if (chunk.done) {
          metrics = this.extractMetrics(chunk);
          
          const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
          
          yield {
            type: 'message_delta',
            delta: {
              stop_reason: stopReason,
            },
          } as MessageStreamEvent;

          if (metrics) {
            yield {
              type: 'token_usage',
              input_tokens: metrics.promptEvalCount || 0,
              output_tokens: metrics.evalCount || 0,
              ollama_metrics: metrics,
            } as MessageStreamEvent;
          }

          yield { type: 'message_stop' } as MessageStreamEvent;
        }
      }

      // Add assistant message to conversation
      conversationMessages.push({
        role: 'assistant',
        content: assistantContent,
        tool_calls: toolCalls.length > 0 ? toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
        })) : undefined,
      });

      // If cancelled and pending results sent, break
      if (hasPendingToolResults && cancellationCheck && cancellationCheck()) {
        break;
      }

      hasPendingToolResults = false;

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        break;
      }

      // Execute tools
      // Collect image data from tool results to inject as a user message
      const toolImages: string[] = [];
      for (const toolCall of toolCalls) {
        // Check for cancellation before executing each tool
        // This prevents queued tools from executing after abort is requested
        if (cancellationCheck && cancellationCheck()) {
          const cancelMessage = '[Tool execution cancelled by user]';
          const toolInput = typeof toolCall.arguments === 'string'
            ? JSON.parse(toolCall.arguments)
            : toolCall.arguments;
          // Yield cancelled tool event so client can track it in pendingToolResults
          yield {
            type: 'tool_use_complete',
            toolName: toolCall.name,
            toolUseId: toolCall.id,
            toolInput,
            result: cancelMessage,
            hasImages: false,
          };
          conversationMessages.push({
            role: 'tool',
            tool_name: toolCall.name,
            content: cancelMessage,
          });
          continue;
        }

        try {
          const toolInput = typeof toolCall.arguments === 'string'
            ? JSON.parse(toolCall.arguments)
            : toolCall.arguments;

          const result = await toolExecutor(toolCall.name, toolInput);

          // Yield the result so caller can see what happened (use displayText for CLI)
          yield {
            type: 'tool_use_complete',
            toolName: toolCall.name,
            toolUseId: toolCall.id,
            toolInput,
            result: result.displayText,
            hasImages: result.hasImages,
          };

          // Ollama tool messages only support string content, so images go in a
          // follow-up user message (Ollama supports images via the 'images' field)
          const textContent = result.contentBlocks
            .filter((b) => b.type === 'text')
            .map((b) => (b as { type: 'text'; text: string }).text)
            .join('\n');

          // Add tool result to conversation - Ollama uses tool_name, not tool_call_id
          conversationMessages.push({
            role: 'tool',
            tool_name: toolCall.name,
            content: textContent,
          });

          // Collect any image blocks to inject as a user message after tool results
          if (result.hasImages) {
            const imageBlocks = result.contentBlocks.filter((b) => b.type === 'image');
            for (const img of imageBlocks) {
              const imgBlock = img as { type: 'image'; data: string; mimeType: string };
              toolImages.push(imgBlock.data);
            }
          }
        } catch (error) {
          const errorMessage = `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;

          yield {
            type: 'tool_use_complete',
            toolName: toolCall.name,
            toolUseId: toolCall.id,
            toolInput: toolCall.arguments,
            result: errorMessage,
          };

          conversationMessages.push({
            role: 'tool',
            tool_name: toolCall.name,
            content: errorMessage,
          });
        }
      }

      // If any tool results contained images, inject them as a user message
      // Ollama doesn't support images in tool messages, but does support them in user messages
      if (toolImages.length > 0) {
        conversationMessages.push({
          role: 'user',
          content: 'Here are the image(s) returned by the tool(s) above. Please analyze them as part of the tool results.',
          images: toolImages,
        } as any);
      }

      hasPendingToolResults = true;
    }
  }

  /**
   * Create a non-streaming message (for summarization)
   */
  async createMessage(
    messages: Message[],
    model: string,
    maxTokens: number,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    // Ensure context window is cached for this model
    if (!this.contextWindowCache.has(model)) {
      await this.fetchModelInfo(model);
    }
    
    const ollamaMessages = this.convertToOllamaMessages(messages);

    const contextWindow = this.getContextWindow(model);
    const options: any = {
      num_predict: maxTokens,
      num_ctx: contextWindow,
    };

    const response = await this.ollamaClient.chat({
      model,
      messages: ollamaMessages,
      stream: false,
      options,
    });

    return {
      content: [
        {
          type: 'text',
          text: response.message?.content || '',
        },
      ],
    };
  }
}

