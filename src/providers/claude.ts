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
  ) {
    this.modelName = modelName;
    this.maxTokens =
      CLAUDE_MODEL_CONTEXT_WINDOWS[modelName] ||
      CLAUDE_MODEL_CONTEXT_WINDOWS['claude-haiku-4-5-20251001'] ||
      200000;

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