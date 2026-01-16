/**
 * Token management and automatic summarization for MCP Client.
 */

import type { Logger } from '../logger.js';
import type { ModelProvider, TokenCounter, Message } from '../model-provider.js';

/**
 * Callbacks for TokenManager to interact with parent component.
 */
export interface TokenManagerCallbacks {
  /** Get current messages array */
  getMessages: () => Message[];
  /** Set messages array (for summarization) */
  setMessages: (messages: Message[]) => void;
  /** Get current token count */
  getCurrentTokenCount: () => number;
  /** Set current token count */
  setCurrentTokenCount: (count: number) => void;
  /** Get model provider */
  getModelProvider: () => ModelProvider;
  /** Get current model name */
  getModel: () => string;
}

/**
 * Manages token counting and automatic summarization.
 */
export class TokenManager {
  private tokenCounter: TokenCounter | null = null;
  private logger: Logger;
  private callbacks: TokenManagerCallbacks;

  constructor(logger: Logger, callbacks: TokenManagerCallbacks) {
    this.logger = logger;
    this.callbacks = callbacks;
  }

  /**
   * Ensure token counter is initialized.
   */
  async ensureTokenCounter(): Promise<void> {
    if (!this.tokenCounter) {
      const modelProvider = this.callbacks.getModelProvider();
      const model = this.callbacks.getModel();
      this.tokenCounter = await modelProvider.createTokenCounter(model, undefined);
    }
  }

  /**
   * Reinitialize token counter (e.g., when model changes).
   */
  async reinitializeTokenCounter(): Promise<void> {
    const modelProvider = this.callbacks.getModelProvider();
    const model = this.callbacks.getModel();
    this.tokenCounter = await modelProvider.createTokenCounter(model, undefined);
  }

  /**
   * Check if summarization should be triggered.
   */
  shouldSummarize(): boolean {
    if (!this.tokenCounter) {
      throw new Error('Token counter not initialized. Please call start() first.');
    }
    return this.tokenCounter.shouldSummarize(this.callbacks.getCurrentTokenCount());
  }

  /**
   * Get current token usage status.
   */
  getTokenUsage() {
    if (!this.tokenCounter) {
      throw new Error('Token counter not initialized. Please call start() first.');
    }
    return this.tokenCounter.getUsage(this.callbacks.getCurrentTokenCount());
  }

  /**
   * Get the token counter instance.
   */
  getTokenCounter(): TokenCounter | null {
    return this.tokenCounter;
  }

  /**
   * Manually trigger summarization (for testing).
   */
  async manualSummarize(): Promise<void> {
    await this.ensureTokenCounter();
    await this.autoSummarize();
  }

  /**
   * Set test mode with lower threshold for easier testing.
   */
  async setTestMode(enabled: boolean = true, testThreshold: number = 5): Promise<void> {
    await this.ensureTokenCounter();
    if (enabled) {
      this.tokenCounter!.updateConfig({
        threshold: testThreshold,
        enabled: true,
      });
      this.logger.log(
        `\nTest mode enabled: Summarization will trigger at ${testThreshold}% (${Math.round(this.tokenCounter!.getContextWindow() * testThreshold / 100)} tokens)\n`,
        { type: 'info' },
      );
    } else {
      this.tokenCounter!.updateConfig({
        threshold: 80,
      });
      this.logger.log('\nTest mode disabled: Summarization threshold reset to 80%\n', {
        type: 'info',
      });
    }
  }

  /**
   * Automatically summarize conversation when context window is approaching limit.
   */
  async autoSummarize(): Promise<void> {
    await this.ensureTokenCounter();
    if (!this.tokenCounter!.getConfig().enabled) {
      return;
    }

    const config = this.tokenCounter!.getConfig();
    const recentCount = config.recentMessagesToKeep;
    const messages = this.callbacks.getMessages();

    // Need at least recentCount + 1 messages to summarize
    if (messages.length <= recentCount) {
      return;
    }

    const currentTokenCount = this.callbacks.getCurrentTokenCount();
    this.logger.log(
      `\n⚠️ Context window approaching limit (${this.tokenCounter!.getUsage(currentTokenCount).percentage}% used). Summarizing conversation...\n`,
      { type: 'warning' },
    );

    try {
      // Keep recent messages
      const recentMessages = messages.slice(-recentCount);
      const oldMessages = messages.slice(0, -recentCount);

      // Create summarization prompt
      const messagesToSummarize = oldMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const modelProvider = this.callbacks.getModelProvider();
      const model = this.callbacks.getModel();

      // Call API to summarize
      const summaryMessages: Message[] = [
        ...messagesToSummarize,
        {
          role: 'user',
          content:
            'Summarize the above conversation concisely, preserving key decisions, context, important information, and any tool usage patterns. Focus on what was accomplished and what context is needed to continue the conversation.',
        },
      ];

      // Use provider's createMessage if available, otherwise use stream
      let summaryText: string;
      if ((modelProvider as any).createMessage) {
        const summaryResponse = await (modelProvider as any).createMessage(
          summaryMessages,
          model,
          2000,
        );
        summaryText =
          summaryResponse.content[0]?.type === 'text'
            ? summaryResponse.content[0].text
            : JSON.stringify(summaryResponse.content);
      } else {
        // Fallback: use streaming and collect text
        let collectedText = '';
        const summaryStream = modelProvider.createMessageStream(
          summaryMessages,
          model,
          [],
          2000,
        );
        for await (const chunk of summaryStream) {
          if (chunk.type === 'content_block_delta' && (chunk as any).delta?.type === 'text_delta') {
            collectedText += (chunk as any).delta.text;
          }
        }
        summaryText = collectedText || 'Summary unavailable';
      }

      // Recalculate token count
      let oldTokenCount = 0;
      for (const msg of oldMessages) {
        oldTokenCount += this.tokenCounter!.countMessageTokens(msg);
      }

      // Count summary message
      const summaryMessage: Message = {
        role: 'user',
        content: `[Previous conversation summary: ${summaryText}]`,
      };
      const summaryTokenCount = this.tokenCounter!.countMessageTokens(summaryMessage);

      // Update messages and token count
      this.callbacks.setMessages([summaryMessage, ...recentMessages]);
      this.callbacks.setCurrentTokenCount(currentTokenCount - oldTokenCount + summaryTokenCount);

      this.logger.log(
        `✓ Conversation summarized. Context reduced from ${oldMessages.length} to 1 summary message. Token usage: ${this.tokenCounter!.getUsage(this.callbacks.getCurrentTokenCount()).percentage}%\n`,
        { type: 'info' },
      );
    } catch (error) {
      this.logger.log(
        `Failed to summarize conversation: ${error}\n`,
        { type: 'error' },
      );
      // Continue without summarization - let API handle the limit
    }
  }
}
