/**
 * CLI operations for chat history management.
 */

import readline from 'readline/promises';
import { ChatHistoryManager } from '../managers/chat-history-manager.js';
import { Logger } from '../logger.js';

/**
 * Callbacks for ChatHistoryCLI to interact with parent component.
 */
export interface ChatHistoryCLICallbacks {
  /** Get current readline interface */
  getReadline: () => readline.Interface | null;
  /** Get messages array to modify for restoreChat */
  getMessages: () => any[];
  /** Get token counter for restoreChat (may be null if not initialized) */
  getTokenCounter: () => { countMessageTokens: (msg: any) => number } | null;
  /** Get current token count */
  getCurrentTokenCount: () => number;
  /** Set current token count */
  setCurrentTokenCount: (count: number) => void;
  /** Get current provider name for format conversion */
  getProviderName: () => string;
  /** Get attachment manager for restoring attachment content blocks */
  getAttachmentManager: () => {
    getAttachmentInfo(fileName: string): { path: string; fileName: string; ext: string; mediaType: string } | null;
    createContentBlocks(attachments: Array<{ path: string; fileName: string; ext: string; mediaType: string }>, text?: string): Array<{ type: string; [key: string]: any }>;
  } | null;
}

/**
 * Handles CLI operations for chat history list, search, restore, export, rename, and clear.
 */
export class ChatHistoryCLI {
  private historyManager: ChatHistoryManager;
  private logger: Logger;
  private callbacks: ChatHistoryCLICallbacks;

  constructor(
    historyManager: ChatHistoryManager,
    logger: Logger,
    callbacks: ChatHistoryCLICallbacks,
  ) {
    this.historyManager = historyManager;
    this.logger = logger;
    this.callbacks = callbacks;
  }

  /**
   * Check if an attachment media type is supported by the given provider.
   * Text-based and image types are supported by all providers.
   * PDFs are only supported by Anthropic.
   */
  private isAttachmentSupportedByProvider(mediaType: string, providerName: string): boolean {
    // Text-based types → all providers
    if (mediaType.startsWith('text/') ||
        mediaType === 'application/json' ||
        mediaType === 'application/xml' ||
        mediaType === 'application/javascript' ||
        mediaType === 'application/typescript') {
      return true;
    }

    // Images → all providers
    if (mediaType.startsWith('image/')) {
      return true;
    }

    // PDFs → only anthropic
    if (mediaType === 'application/pdf') {
      return providerName === 'anthropic';
    }

    // Unknown → allow (let provider handle it)
    return true;
  }

  /**
   * Convert messages from canonical (Anthropic) format to provider-specific format.
   * This enables cross-provider chat history restore.
   */
  private convertMessagesForProvider(messages: any[], providerName: string): any[] {
    switch (providerName) {
      case 'openai':
        return this.convertToOpenAIFormat(messages);
      case 'gemini':
        return this.convertToGeminiFormat(messages);
      case 'ollama':
        return this.convertToOllamaFormat(messages);
      case 'anthropic':
        return this.convertToAnthropicFormat(messages);
      default:
        return messages;
    }
  }

  /**
   * Convert messages to Anthropic format.
   *
   * The canonical storage format is close to Anthropic, but may contain extra fields
   * that Anthropic's strict API rejects (e.g., tool_name in tool_results).
   * Also converts non-Anthropic content_blocks (e.g., Gemini's function_call) to tool_use.
   */
  private convertToAnthropicFormat(messages: any[]): any[] {
    const result: any[] = [];

    for (const msg of messages) {
      // Clean tool_results: Anthropic rejects extra fields like tool_name
      if (msg.role === 'user' && msg.tool_results && Array.isArray(msg.tool_results) && msg.tool_results.length > 0) {
        result.push({
          role: 'user',
          content: msg.content || '',
          tool_results: msg.tool_results.map((tr: any) => ({
            type: 'tool_result',
            tool_use_id: tr.tool_use_id,
            content: tr.content,
            // Explicitly omit tool_name — Anthropic rejects it
          })),
        });
        continue;
      }

      // Convert assistant content_blocks: ensure all tool call blocks use Anthropic's tool_use format
      if (msg.role === 'assistant' && msg.content_blocks && msg.content_blocks.length > 0) {
        const convertedBlocks = msg.content_blocks.map((block: any) => {
          // Convert Gemini's function_call to Anthropic's tool_use
          if (block.type === 'function_call') {
            return {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.args || {},
            };
          }
          return block;
        });
        result.push({
          role: 'assistant',
          content: msg.content,
          content_blocks: convertedBlocks,
        });
        continue;
      }

      // Pass through other messages unchanged
      result.push(msg);
    }

    return result;
  }

  /**
   * Convert messages to OpenAI format.
   *
   * Key differences from Anthropic format:
   * - Tool results use 'tool' role with tool_call_id (not user role with tool_results array)
   * - Assistant tool calls use tool_calls array with JSON string arguments
   */
  private convertToOpenAIFormat(messages: any[]): any[] {
    const result: any[] = [];

    for (const msg of messages) {
      // Convert user messages with tool_results to separate tool role messages
      if (msg.role === 'user' && msg.tool_results && Array.isArray(msg.tool_results) && msg.tool_results.length > 0) {
        for (const tr of msg.tool_results) {
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          });
        }
        continue;
      }

      // Convert assistant messages with content_blocks containing tool_use
      if (msg.role === 'assistant' && msg.content_blocks && msg.content_blocks.length > 0) {
        const toolUseBlocks = msg.content_blocks.filter((b: any) => b.type === 'tool_use');

        if (toolUseBlocks.length > 0) {
          result.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: toolUseBlocks.map((block: any) => ({
              id: block.id,
              name: block.name,
              arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
            })),
          });
          continue;
        }
      }

      // Pass through other messages unchanged
      result.push({
        role: msg.role,
        content: msg.content || '',
        ...(msg.content_blocks && { content_blocks: msg.content_blocks }),
      });
    }

    return result;
  }

  /**
   * Convert messages to Gemini format.
   *
   * Key differences from Anthropic format:
   * - Uses 'model' role instead of 'assistant'
   * - Tool calls use function_call format with args object
   * - Tool results use functionResponse in user messages with tool_name
   */
  private convertToGeminiFormat(messages: any[]): any[] {
    const result: any[] = [];

    for (const msg of messages) {
      // Convert user messages with tool_results - Gemini expects tool_name
      if (msg.role === 'user' && msg.tool_results && Array.isArray(msg.tool_results) && msg.tool_results.length > 0) {
        // For Gemini, we keep the structure but ensure tool_name is present
        result.push({
          role: 'user',
          content: msg.content || '',
          tool_results: msg.tool_results.map((tr: any) => ({
            type: 'tool_result',
            tool_use_id: tr.tool_use_id,
            tool_name: tr.tool_name || 'unknown', // Gemini uses name-based matching
            content: tr.content,
          })),
        });
        continue;
      }

      // Convert assistant messages with content_blocks containing tool_use to function_call format
      if (msg.role === 'assistant' && msg.content_blocks && msg.content_blocks.length > 0) {
        const newContentBlocks: any[] = [];

        for (const block of msg.content_blocks) {
          if (block.type === 'tool_use') {
            // Convert tool_use to function_call format for Gemini
            newContentBlocks.push({
              type: 'function_call',
              name: block.name,
              args: block.input || {},
              id: block.id,
            });
          } else if (block.type === 'text') {
            newContentBlocks.push(block);
          }
        }

        result.push({
          role: 'assistant', // Will be converted to 'model' by Gemini provider
          content: msg.content || '',
          content_blocks: newContentBlocks,
        });
        continue;
      }

      // Pass through other messages unchanged
      result.push({
        role: msg.role,
        content: msg.content || '',
        ...(msg.content_blocks && { content_blocks: msg.content_blocks }),
      });
    }

    return result;
  }

  /**
   * Convert messages to Ollama format.
   *
   * Key differences from Anthropic format:
   * - Tool results use 'tool' role with tool_name (not tool_call_id)
   * - Tool calls use tool_calls array with arguments as object (not JSON string)
   */
  private convertToOllamaFormat(messages: any[]): any[] {
    const result: any[] = [];

    for (const msg of messages) {
      // Convert user messages with tool_results to separate tool role messages
      if (msg.role === 'user' && msg.tool_results && Array.isArray(msg.tool_results) && msg.tool_results.length > 0) {
        for (const tr of msg.tool_results) {
          result.push({
            role: 'tool',
            tool_name: tr.tool_name || 'unknown', // Ollama uses tool_name, not tool_call_id
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          });
        }
        continue;
      }

      // Convert assistant messages with content_blocks containing tool_use
      if (msg.role === 'assistant' && msg.content_blocks && msg.content_blocks.length > 0) {
        const toolUseBlocks = msg.content_blocks.filter((b: any) => b.type === 'tool_use');

        if (toolUseBlocks.length > 0) {
          result.push({
            role: 'assistant',
            content: msg.content || '',
            tool_calls: toolUseBlocks.map((block: any) => {
              let args: any = {};
              if (typeof block.input === 'string' && block.input.trim()) {
                try { args = JSON.parse(block.input); } catch { args = {}; }
              } else if (typeof block.input === 'object') {
                args = block.input || {};
              }
              return {
                id: block.id,
                name: block.name,
                // Ollama expects arguments as object, not JSON string
                arguments: args,
              };
            }),
          });
          continue;
        }
      }

      // Pass through other messages unchanged
      result.push({
        role: msg.role,
        content: msg.content || '',
        ...(msg.content_blocks && { content_blocks: msg.content_blocks }),
      });
    }

    return result;
  }

  /**
   * Display list of recent chat sessions.
   */
  async displayChatList(): Promise<void> {
    const chats = this.historyManager.getAllChats();

    this.logger.log('\n📚 Recent chat sessions:\n', { type: 'info' });

    if (chats.length === 0) {
      this.logger.log('  No chat sessions found.\n', { type: 'info' });
      return;
    }

    for (const chat of chats.slice(0, 10)) {
      const duration = chat.duration
        ? `${Math.round(chat.duration / 1000)}s`
        : '∞';
      const date = new Date(chat.startTime).toLocaleString();
      this.logger.log(
        `  ${chat.sessionId} | ${date} | ${chat.messageCount} messages | ${duration}\n`,
        { type: 'info' },
      );
      // TODO: Fix summary creation logic - re-enable summary display when summary is properly implemented
      // if (chat.summary) {
      //   this.logger.log(`    → ${chat.summary}\n`, { type: 'info' });
      // }
      if (chat.tags && chat.tags.length > 0) {
        this.logger.log(`    Tags: ${chat.tags.join(', ')}\n`, { type: 'info' });
      }
    }

    if (chats.length > 10) {
      this.logger.log(`\n  ... and ${chats.length - 10} more sessions\n`, {
        type: 'info',
      });
    }
  }

  /**
   * Search chats by keyword.
   */
  async searchChats(keyword: string): Promise<void> {
    const results = this.historyManager.searchChats(keyword);

    this.logger.log(`\n📍 Found ${results.length} matching chat(s):\n`, {
      type: 'info',
    });

    if (results.length === 0) {
      this.logger.log('  No chats found matching your search.\n', {
        type: 'info',
      });
      return;
    }

    for (const chat of results) {
      const date = new Date(chat.startTime).toLocaleString();
      this.logger.log(
        `  ${chat.sessionId} | ${date} | ${chat.messageCount} messages\n`,
        { type: 'info' },
      );
      // TODO: Fix summary creation logic - re-enable summary display when summary is properly implemented
      // if (chat.summary) {
      //   this.logger.log(`    → ${chat.summary}\n`, { type: 'info' });
      // }
    }
  }

  /**
   * Restore a previous chat session as context.
   */
  async restoreChat(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const chats = this.historyManager.getAllChats();

    if (chats.length === 0) {
      this.logger.log('\nNo chat sessions available to restore.\n', {
        type: 'warning',
      });
      return;
    }

    const path = await import('path');
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const pageSize = 10;
    let offset = 0;

    while (true) {
      const endIndex = Math.min(offset + pageSize, chats.length);
      const pageChats = chats.slice(offset, endIndex);

      this.logger.log('\n📖 Select a chat to restore as context:\n', {
        type: 'info',
      });

      for (let i = 0; i < pageChats.length; i++) {
        const chat = pageChats[i];
        const date = new Date(chat.startTime).toLocaleString();
        // TODO: Fix summary creation logic - re-enable summary display when summary is properly implemented
        // const summary = chat.summary ? ` - ${chat.summary}` : '';
        const summary = '';

        // Extract short session ID (last part after last hyphen)
        const shortSessionId = chat.sessionId.split('-').pop() || chat.sessionId;

        // Extract folder name from filePath
        const chatDir = path.basename(path.dirname(chat.filePath));
        // If folder is a date folder (YYYY-MM-DD), consider it as root
        const folderName = datePattern.test(chatDir) ? 'root' : chatDir;
        const folderDisplay =
          folderName !== 'root' ? ` | Folder: ${folderName}` : '';

        // Display number relative to current page (1-10)
        const displayNumber = i + 1;
        this.logger.log(
          `  ${displayNumber}. ${shortSessionId} | ${date} | ${chat.messageCount} messages${folderDisplay}${summary}\n`,
          { type: 'info' },
        );
      }

      // Show pagination info
      const pageInfo = `\nPage ${Math.floor(offset / pageSize) + 1} of ${Math.ceil(chats.length / pageSize)} (Showing ${offset + 1}-${endIndex} of ${chats.length})\n`;
      this.logger.log(pageInfo, { type: 'info' });

      // Build navigation prompt
      let prompt = '\nEnter number to select, ';
      if (offset + pageSize < chats.length) {
        prompt += '"n" for next page, ';
      }
      if (offset > 0) {
        prompt += '"p" for previous page, ';
      }
      prompt += 'or "q" to cancel: ';

      const selection = (await rl.question(prompt)).trim().toLowerCase();

      if (selection === 'q' || selection === 'quit') {
        this.logger.log('\nCancelled.\n', { type: 'info' });
        return;
      }

      // Handle pagination
      if (selection === 'n' || selection === 'next') {
        if (offset + pageSize < chats.length) {
          offset += pageSize;
          continue;
        } else {
          this.logger.log('\nAlready on the last page.\n', { type: 'warning' });
          continue;
        }
      }

      if (
        selection === 'p' ||
        selection === 'prev' ||
        selection === 'previous'
      ) {
        if (offset > 0) {
          offset = Math.max(0, offset - pageSize);
          continue;
        } else {
          this.logger.log('\nAlready on the first page.\n', { type: 'warning' });
          continue;
        }
      }

      // Handle number selection
      const index = parseInt(selection) - 1;
      if (isNaN(index) || index < 0 || index >= pageChats.length) {
        this.logger.log(
          '\nInvalid selection. Please enter a valid number, "n", "p", or "q".\n',
          { type: 'error' },
        );
        continue;
      }

      // Get the actual chat from the full list using the offset
      const selectedChat = chats[offset + index];
      const fullChat = this.historyManager.loadChat(selectedChat.sessionId);

      if (!fullChat) {
        this.logger.log('\nFailed to load chat session.\n', { type: 'error' });
        return;
      }

      // Load messages into current conversation context
      const messages = this.callbacks.getMessages();
      const newMessages: any[] = [];
      let restoredCount = 0;

      // Build a map of tool_use_id -> assistant message index for proper ordering
      // This handles cases where tool messages appear before their assistant message in saved order
      // Check both content_blocks (canonical/Anthropic) and tool_calls (OpenAI/Gemini/Ollama) formats
      const toolUseIdToAssistantIndex = new Map<string, number>();
      for (let i = 0; i < fullChat.messages.length; i++) {
        const msg = fullChat.messages[i];
        if (msg.role === 'assistant') {
          // Check content_blocks for tool_use entries (canonical/Anthropic format)
          if (msg.content_blocks) {
            for (const block of msg.content_blocks) {
              if ((block.type === 'tool_use' || block.type === 'function_call') && block.id) {
                toolUseIdToAssistantIndex.set(block.id, i);
              }
            }
          }
          // Also check tool_calls (OpenAI/Gemini/Ollama format, may exist in older saved chats)
          if ((msg as any).tool_calls) {
            for (const tc of (msg as any).tool_calls) {
              if (tc.id) {
                toolUseIdToAssistantIndex.set(tc.id, i);
              }
            }
          }
        }
      }

      // Collect tool results by their matching assistant message index
      const toolResultsByAssistantIndex = new Map<number, Array<{ tool_use_id: string; tool_name: string; content: string }>>();

      for (const msg of fullChat.messages) {
        if (msg.role === 'tool' && msg.tool_use_id && msg.toolName && msg.toolOutput !== undefined) {
          const assistantIndex = toolUseIdToAssistantIndex.get(msg.tool_use_id);
          if (assistantIndex !== undefined) {
            if (!toolResultsByAssistantIndex.has(assistantIndex)) {
              toolResultsByAssistantIndex.set(assistantIndex, []);
            }
            toolResultsByAssistantIndex.get(assistantIndex)!.push({
              tool_use_id: msg.tool_use_id,
              tool_name: msg.toolName,
              content: msg.toolOutput,
            });
          }
          // Skip orphaned tool results - they don't have matching tool_use blocks

          // Save to history manager regardless
          this.historyManager.addToolExecution(
            msg.toolName,
            msg.toolInput || {},
            msg.toolOutput,
            msg.orchestratorMode || false,
            msg.isIPCCall || false,
            msg.toolInputTime,
            msg.tool_use_id,
          );
          restoredCount++;
        }
      }

      // Build set of matched tool_use_ids (those with content_blocks in an assistant message)
      const matchedToolUseIds = new Set<string>(toolUseIdToAssistantIndex.keys());

      // Now restore messages in proper order
      // Collect consecutive orphaned tool results to batch them into a single context message
      let pendingOrphanedToolResults: Array<{ toolName: string; toolInput: any; toolOutput: string }> = [];

      const flushOrphanedToolResults = () => {
        if (pendingOrphanedToolResults.length === 0) return;

        // Format orphaned tool results as a text-based context message
        // so the model can see the tool execution history even without content_blocks
        const lines: string[] = ['[Restored Tool Execution Context]'];
        for (const tr of pendingOrphanedToolResults) {
          lines.push(`\nTool: ${tr.toolName}`);
          if (tr.toolInput && Object.keys(tr.toolInput).length > 0) {
            lines.push(`Input: ${JSON.stringify(tr.toolInput)}`);
          }
          lines.push(`Output: ${tr.toolOutput}`);
        }

        newMessages.push({
          role: 'user',
          content: lines.join('\n'),
        });

        pendingOrphanedToolResults = [];
      };

      for (let i = 0; i < fullChat.messages.length; i++) {
        const msg = fullChat.messages[i];

        if (msg.role === 'user') {
          // Flush any pending orphaned tool results before a user message
          flushOrphanedToolResults();

          const messageObj: any = {
            role: msg.role,
            content: msg.content,
          };

          // Restore attachment content blocks if this message had attachments
          if (msg.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
            const attachmentManager = this.callbacks.getAttachmentManager();
            if (attachmentManager) {
              const providerName = this.callbacks.getProviderName();
              const foundAttachments: Array<{ path: string; fileName: string; ext: string; mediaType: string }> = [];
              const missingAttachments: string[] = [];
              const unsupportedAttachments: Array<{ fileName: string; mediaType: string }> = [];

              for (const att of msg.attachments) {
                const info = attachmentManager.getAttachmentInfo(att.fileName);
                if (!info) {
                  missingAttachments.push(att.fileName);
                } else if (!this.isAttachmentSupportedByProvider(info.mediaType, providerName)) {
                  unsupportedAttachments.push({ fileName: info.fileName, mediaType: info.mediaType });
                } else {
                  foundAttachments.push(info);
                }
              }

              // Create content blocks from found attachments
              if (foundAttachments.length > 0) {
                try {
                  const contentBlocks = attachmentManager.createContentBlocks(foundAttachments);
                  if (contentBlocks.length > 0) {
                    messageObj.content_blocks = contentBlocks;
                  }
                } catch (error) {
                  this.logger.log(
                    `  ⚠ Failed to create content blocks for attachments: ${error}\n`,
                    { type: 'warning' },
                  );
                }
              }

              // Log warnings for missing attachments
              if (missingAttachments.length > 0) {
                this.logger.log(
                  `  ⚠ Missing attachment file(s): ${missingAttachments.join(', ')}\n`,
                  { type: 'warning' },
                );
              }

              // Log warnings for unsupported attachments
              if (unsupportedAttachments.length > 0) {
                const details = unsupportedAttachments
                  .map(a => `${a.fileName} (${a.mediaType})`)
                  .join(', ');
                this.logger.log(
                  `  ⚠ Unsupported by ${providerName}: ${details}\n`,
                  { type: 'warning' },
                );
              }
            }
          }

          newMessages.push(messageObj);
          this.historyManager.addUserMessage(msg.content, msg.attachments);
          restoredCount++;
        } else if (msg.role === 'assistant') {
          // Flush any pending orphaned tool results before an assistant message
          flushOrphanedToolResults();

          // Restore assistant message with content_blocks if present
          const messageObj: any = {
            role: 'assistant',
            content: msg.content,
          };

          // Preserve content_blocks with tool_use blocks for proper model context
          // But handle dangling tool_use blocks (session ended before tool returned)
          if (msg.content_blocks && msg.content_blocks.length > 0) {
            const matchingToolResults = toolResultsByAssistantIndex.get(i);
            const hasMatchingResults = matchingToolResults && matchingToolResults.length > 0;

            if (hasMatchingResults) {
              // All tool_use blocks have matching results - keep content_blocks as-is
              messageObj.content_blocks = msg.content_blocks;
            } else {
              // Check if any tool_use blocks lack results (dangling)
              const toolUseBlocks = msg.content_blocks.filter(
                (b: any) => b.type === 'tool_use' || b.type === 'function_call'
              );
              const nonToolBlocks = msg.content_blocks.filter(
                (b: any) => b.type !== 'tool_use' && b.type !== 'function_call'
              );

              if (toolUseBlocks.length > 0) {
                // Strip dangling tool_use blocks - session was interrupted before tool returned
                // Keep only text blocks to avoid provider API errors
                if (nonToolBlocks.length > 0) {
                  messageObj.content_blocks = nonToolBlocks;
                }
                // If no non-tool blocks remain, omit content_blocks entirely
              } else {
                // No tool_use blocks - preserve content_blocks (e.g., text blocks)
                messageObj.content_blocks = msg.content_blocks;
              }
            }
          }

          newMessages.push(messageObj);
          this.historyManager.addAssistantMessage(msg.content, msg.content_blocks);
          restoredCount++;

          // Add tool results that belong to this assistant message (AFTER the assistant message)
          const matchingToolResults = toolResultsByAssistantIndex.get(i);
          if (matchingToolResults && matchingToolResults.length > 0) {
            const toolResultsMessage = {
              role: 'user',
              content: '',
              tool_results: matchingToolResults.map(tr => ({
                type: 'tool_result',
                tool_use_id: tr.tool_use_id,
                tool_name: tr.tool_name, // Include tool name for Gemini compatibility
                content: tr.content,
              })),
            };
            newMessages.push(toolResultsMessage);
          }
        } else if (msg.role === 'tool' && msg.tool_use_id && !matchedToolUseIds.has(msg.tool_use_id)) {
          // Orphaned tool result - no matching content_blocks in any assistant message
          // (common with orchestrator IPC calls or Gemini sessions)
          // Collect and batch into a text context message
          pendingOrphanedToolResults.push({
            toolName: msg.toolName || 'unknown',
            toolInput: msg.toolInput || {},
            toolOutput: msg.toolOutput || '',
          });
        }
        // Matched tool messages are handled via toolResultsByAssistantIndex above
      }

      // Flush any remaining orphaned tool results at the end
      flushOrphanedToolResults();

      // Convert messages to provider-specific format before adding to context
      const providerName = this.callbacks.getProviderName();
      const convertedMessages = this.convertMessagesForProvider(newMessages, providerName);
      this.logger.log(
        `  (Converted ${newMessages.length} messages to ${providerName} format)\n`,
        { type: 'info' },
      );

      // Prepend restored messages to current conversation (for the model context)
      messages.unshift(...convertedMessages);

      // Update token count (approximate)
      const tokenCounter = this.callbacks.getTokenCounter();
      if (tokenCounter) {
        let currentTokenCount = this.callbacks.getCurrentTokenCount();
        for (const msg of newMessages) {
          currentTokenCount += tokenCounter.countMessageTokens(msg);
        }
        this.callbacks.setCurrentTokenCount(currentTokenCount);
      }

      this.logger.log(
        `\n✓ Restored ${restoredCount} messages from chat session ${selectedChat.sessionId}\n`,
        { type: 'success' },
      );
      break; // Exit the pagination loop after successful selection
    }
  }

  /**
   * Shared function to handle parent folder selection UI.
   * Returns the selected parent folder name, or undefined if none selected.
   */
  private async selectParentFolder(): Promise<string | undefined> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const moveToFolder = (
      await rl.question('\nMove to a parent folder? (y/n, default: n): ')
    )
      .trim()
      .toLowerCase();

    if (moveToFolder !== 'y' && moveToFolder !== 'yes') {
      return undefined;
    }

    // Get existing folders
    const allFolders = this.historyManager.getExistingFolders();

    // Filter out folders with date names (YYYY-MM-DD format)
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const existingFolders = allFolders.filter(
      (folder: string) => !datePattern.test(folder),
    );

    if (existingFolders.length > 0) {
      this.logger.log('\n📁 Existing parent folders:\n', { type: 'info' });
      existingFolders.forEach((folder: string, i: number) => {
        this.logger.log(`  ${i + 1}. ${folder}`, { type: 'info' });
      });
      this.logger.log(`  ${existingFolders.length + 1}. Create new parent folder\n`, {
        type: 'info',
      });

      const folderChoice = (
        await rl.question('Select folder number (or enter new folder name): ')
      ).trim();

      // Check if it's a number
      const folderIndex = parseInt(folderChoice) - 1;
      if (
        !isNaN(folderIndex) &&
        folderIndex >= 0 &&
        folderIndex < existingFolders.length
      ) {
        // Selected existing folder
        const selectedFolder = existingFolders[folderIndex];
        this.logger.log(`\nSelected parent folder: ${selectedFolder}\n`, {
          type: 'info',
        });
        return selectedFolder;
      } else if (
        !isNaN(folderIndex) &&
        folderIndex === existingFolders.length
      ) {
        // User wants to create new folder
        const newFolderName = (
          await rl.question('Enter new parent folder name: ')
        ).trim();
        if (newFolderName) {
          return newFolderName;
        } else {
          this.logger.log(
            '\nFolder name cannot be empty. Will be in root chats directory.\n',
            { type: 'warning' },
          );
          return undefined;
        }
      } else {
        // User entered a folder name directly
        return folderChoice;
      }
    } else {
      // No existing folders (excluding date folders), just ask for folder name
      const folderInput = (
        await rl.question(
          "Enter parent folder name (will be created if it doesn't exist): ",
        )
      ).trim();
      if (folderInput) {
        return folderInput;
      } else {
        this.logger.log(
          '\nFolder name cannot be empty. Will be in root chats directory.\n',
          { type: 'warning' },
        );
        return undefined;
      }
    }
  }

  /**
   * Export the current chat session to a named folder.
   */
  async exportChat(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const currentSessionId = this.historyManager.getCurrentSessionId();

    if (!currentSessionId) {
      this.logger.log('\nNo active chat session to export.\n', {
        type: 'warning',
      });
      return;
    }

    // Get current session metadata to show info
    const currentChat = this.historyManager
      .getAllChats()
      .find((chat) => chat.sessionId === currentSessionId);
    if (currentChat) {
      const path = await import('path');
      const currentFileName = path.basename(currentChat.filePath);
      const currentDir =
        path.basename(path.dirname(currentChat.filePath)) || 'root';
      this.logger.log(
        `\nCurrent filename: ${currentFileName}\nCurrent folder: ${currentDir}\n`,
        { type: 'info' },
      );
    }

    const folderName = (
      await rl.question(
        '\nEnter name for the export folder (will create a folder with this name): ',
      )
    ).trim();

    if (!folderName) {
      this.logger.log('\nName cannot be empty.\n', { type: 'error' });
      return;
    }

    // Ask if user wants to move to a parent folder (using shared function)
    const parentFolderName = await this.selectParentFolder();

    // Automatically copy attachments that are part of this chat
    const copyAttachments: boolean = true;

    // Ask user about outputs
    const outputsAction = (
      await rl.question('\nOutputs: Copy, Move, or Skip? (c/m/s, default: s): ')
    )
      .trim()
      .toLowerCase();
    let copyOutputs: boolean | null = null;
    if (
      !outputsAction ||
      outputsAction === 's' ||
      outputsAction === 'skip' ||
      outputsAction === 'n' ||
      outputsAction === 'none'
    ) {
      copyOutputs = null; // Skip (default)
    } else {
      copyOutputs = outputsAction === 'c' || outputsAction === 'copy';
    }

    const success = this.historyManager.exportChat(
      currentSessionId,
      folderName,
      parentFolderName,
      copyAttachments,
      copyOutputs,
    );

    if (success) {
      const sanitizedName = folderName
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');
      const locationMsg = parentFolderName
        ? ` in "${parentFolderName}/${sanitizedName}/"`
        : ` in "${sanitizedName}/"`;
      this.logger.log(`\n✓ Chat exported to folder${locationMsg}\n`, {
        type: 'success',
      });
    } else {
      this.logger.log(`\n✗ Failed to export chat to folder.\n`, {
        type: 'error',
      });
    }
  }

  /**
   * Rename/move a chat session to a named folder.
   */
  async renameChat(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const chats = this.historyManager.getAllChats();

    if (chats.length === 0) {
      this.logger.log('\nNo chat sessions available to rename.\n', {
        type: 'warning',
      });
      return;
    }

    const path = await import('path');
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const pageSize = 10;
    let offset = 0;

    while (true) {
      const endIndex = Math.min(offset + pageSize, chats.length);
      const pageChats = chats.slice(offset, endIndex);

      this.logger.log('\n📝 Select a chat to rename:\n', { type: 'info' });

      for (let i = 0; i < pageChats.length; i++) {
        const chat = pageChats[i];
        const date = new Date(chat.startTime).toLocaleString();

        // Extract short session ID (last part after last hyphen)
        const shortSessionId = chat.sessionId.split('-').pop() || chat.sessionId;

        // Extract folder name from filePath
        const chatDir = path.basename(path.dirname(chat.filePath));
        // If folder is a date folder (YYYY-MM-DD), consider it as root
        const folderName = datePattern.test(chatDir) ? 'root' : chatDir;
        const folderDisplay =
          folderName !== 'root' ? ` | Folder: ${folderName}` : '';

        this.logger.log(
          `  ${i + 1}. ${shortSessionId} | ${date} | ${chat.messageCount} messages${folderDisplay}\n`,
          { type: 'info' },
        );
      }

      // Show pagination info
      const pageInfo = `\nPage ${Math.floor(offset / pageSize) + 1} of ${Math.ceil(chats.length / pageSize)} (Showing ${offset + 1}-${endIndex} of ${chats.length})\n`;
      this.logger.log(pageInfo, { type: 'info' });

      // Build navigation prompt
      let prompt = '\nEnter number to select, ';
      if (offset + pageSize < chats.length) {
        prompt += '"n" for next page, ';
      }
      if (offset > 0) {
        prompt += '"p" for previous page, ';
      }
      prompt += 'or "q" to cancel: ';

      const selection = (await rl.question(prompt)).trim().toLowerCase();

      if (selection === 'q' || selection === 'quit') {
        this.logger.log('\nCancelled.\n', { type: 'info' });
        return;
      }

      // Handle pagination
      if (selection === 'n' || selection === 'next') {
        if (offset + pageSize < chats.length) {
          offset += pageSize;
          continue;
        } else {
          this.logger.log('\nAlready on the last page.\n', { type: 'warning' });
          continue;
        }
      }

      if (
        selection === 'p' ||
        selection === 'prev' ||
        selection === 'previous'
      ) {
        if (offset > 0) {
          offset = Math.max(0, offset - pageSize);
          continue;
        } else {
          this.logger.log('\nAlready on the first page.\n', { type: 'warning' });
          continue;
        }
      }

      // Handle number selection
      const index = parseInt(selection) - 1;
      if (isNaN(index) || index < 0 || index >= pageChats.length) {
        this.logger.log(
          '\nInvalid selection. Please enter a valid number, "n", "p", or "q".\n',
          { type: 'error' },
        );
        continue;
      }

      // Get the actual chat from the full list using the offset
      const selectedChat = chats[offset + index];
      const currentFileName = path.basename(selectedChat.filePath);
      const currentDir =
        path.basename(path.dirname(selectedChat.filePath)) || 'root';

      this.logger.log(
        `\nCurrent filename: ${currentFileName}\nCurrent folder: ${currentDir}\n`,
        { type: 'info' },
      );

      const newName = (
        await rl.question(
          '\nEnter name for the chat (will create a folder with this name): ',
        )
      ).trim();

      if (!newName) {
        this.logger.log('\nName cannot be empty.\n', { type: 'error' });
        return;
      }

      // Ask if user wants to move to a parent folder (using shared function)
      const folderName = await this.selectParentFolder();

      // Automatically copy attachments that are part of this chat
      const copyAttachments: boolean = true;

      // Ask user about outputs
      const outputsAction = (
        await rl.question('\nOutputs: Copy, Move, or Skip? (c/m/s, default: s): ')
      )
        .trim()
        .toLowerCase();
      let copyOutputs: boolean | null = null;
      if (
        !outputsAction ||
        outputsAction === 's' ||
        outputsAction === 'skip' ||
        outputsAction === 'n' ||
        outputsAction === 'none'
      ) {
        copyOutputs = null; // Skip (default)
      } else {
        copyOutputs = outputsAction === 'c' || outputsAction === 'copy';
      }

      const updated = this.historyManager.renameChat(
        selectedChat.sessionId,
        newName,
        folderName,
        copyAttachments,
        copyOutputs,
      );

      if (updated) {
        const sanitizedName = newName
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9-]/g, '');
        const locationMsg = folderName
          ? ` in "${folderName}/${sanitizedName}/"`
          : ` in "${sanitizedName}/"`;
        this.logger.log(
          `\n✓ Chat ${selectedChat.sessionId} moved to folder${locationMsg}\n`,
          { type: 'success' },
        );
      } else {
        this.logger.log(
          `\n✗ Failed to rename chat ${selectedChat.sessionId}.\n`,
          { type: 'error' },
        );
      }
      break; // Exit the pagination loop after successful selection
    }
  }

  /**
   * Delete a chat session or all chats.
   */
  async clearChat(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const chats = this.historyManager.getAllChats();

    if (chats.length === 0) {
      this.logger.log('\nNo chat sessions available to clear.\n', {
        type: 'warning',
      });
      return;
    }

    this.logger.log('\n🗑️  Select a chat to delete:\n', { type: 'info' });
    this.logger.log(`  0. Delete ALL chats (${chats.length} total)\n`, {
      type: 'warning',
    });

    for (let i = 0; i < Math.min(chats.length, 20); i++) {
      const chat = chats[i];
      const date = new Date(chat.startTime).toLocaleString();
      // TODO: Fix summary creation logic - re-enable summary display when summary is properly implemented
      // const summary = chat.summary ? ` - ${chat.summary}` : '';
      const summary = '';
      this.logger.log(
        `  ${i + 1}. ${chat.sessionId} | ${date} | ${chat.messageCount} messages${summary}\n`,
        { type: 'info' },
      );
    }

    const selection = await rl.question('\nEnter number (or "q" to cancel): ');

    if (
      selection.toLowerCase() === 'q' ||
      selection.toLowerCase() === 'quit'
    ) {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    // Handle "delete all" option
    if (selection === '0') {
      const confirm = (
        await rl.question(
          `\n⚠️  Are you sure you want to delete ALL ${chats.length} chat(s)? This cannot be undone! (yes/no): `,
        )
      )
        .trim()
        .toLowerCase();

      if (confirm !== 'yes' && confirm !== 'y') {
        this.logger.log('\nCancelled.\n', { type: 'info' });
        return;
      }

      const deletedCount = this.historyManager.deleteAllChats();

      if (deletedCount > 0) {
        this.logger.log(
          `\n✓ Successfully deleted ${deletedCount} chat(s).\n`,
          { type: 'success' },
        );
      } else {
        this.logger.log(`\n✗ Failed to delete chats.\n`, { type: 'error' });
      }
      return;
    }

    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= Math.min(chats.length, 20)) {
      this.logger.log('\nInvalid selection.\n', { type: 'error' });
      return;
    }

    const selectedChat = chats[index];

    const confirm = (
      await rl.question(
        `\nAre you sure you want to delete chat ${selectedChat.sessionId}? (yes/no): `,
      )
    )
      .trim()
      .toLowerCase();

    if (confirm !== 'yes' && confirm !== 'y') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const deleted = this.historyManager.deleteChat(selectedChat.sessionId);

    if (deleted) {
      this.logger.log(
        `\n✓ Chat ${selectedChat.sessionId} deleted successfully.\n`,
        { type: 'success' },
      );
    } else {
      this.logger.log(
        `\n✗ Failed to delete chat ${selectedChat.sessionId}.\n`,
        { type: 'error' },
      );
    }
  }
}
