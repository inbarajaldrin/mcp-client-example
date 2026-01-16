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
  /** Get token counter for restoreChat */
  getTokenCounter: () => { countMessageTokens: (msg: any) => number };
  /** Get current token count */
  getCurrentTokenCount: () => number;
  /** Set current token count */
  setCurrentTokenCount: (count: number) => void;
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

      // Restore messages in reverse order (oldest first) so they appear in correct order when prepended
      for (const msg of fullChat.messages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          const messageObj = {
            role: msg.role,
            content: msg.content,
          };
          newMessages.push(messageObj);

          // Also add to ChatHistoryManager so they're saved with the current session
          if (msg.role === 'user') {
            this.historyManager.addUserMessage(msg.content);
          } else if (msg.role === 'assistant') {
            this.historyManager.addAssistantMessage(msg.content);
          }
          restoredCount++;
        } else if (msg.role === 'tool') {
          // Also restore tool executions
          if (
            msg.toolName &&
            msg.toolInput !== undefined &&
            msg.toolOutput !== undefined
          ) {
            this.historyManager.addToolExecution(
              msg.toolName,
              msg.toolInput,
              msg.toolOutput,
              msg.orchestratorMode || false,
              msg.isIPCCall || false,
              msg.toolInputTime, // Preserve original input time if available
            );
            restoredCount++;
          }
        }
      }

      // Prepend restored messages to current conversation (for the model context)
      messages.unshift(...newMessages);

      // Update token count (approximate)
      const tokenCounter = this.callbacks.getTokenCounter();
      let currentTokenCount = this.callbacks.getCurrentTokenCount();
      for (const msg of newMessages) {
        currentTokenCount += tokenCounter.countMessageTokens(msg);
      }
      this.callbacks.setCurrentTokenCount(currentTokenCount);

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

    // Ask user about attachments
    const attachmentsAction = (
      await rl.question('\nAttachments: Copy, Move, or Skip? (c/m/s, default: s): ')
    )
      .trim()
      .toLowerCase();
    let copyAttachments: boolean | null = null;
    if (
      !attachmentsAction ||
      attachmentsAction === 's' ||
      attachmentsAction === 'skip' ||
      attachmentsAction === 'n' ||
      attachmentsAction === 'none'
    ) {
      copyAttachments = null; // Skip (default)
    } else {
      copyAttachments =
        attachmentsAction !== 'm' && attachmentsAction !== 'move';
    }

    // Ask user about outputs
    const outputsAction = (
      await rl.question('Outputs: Copy, Move, or Skip? (c/m/s, default: s): ')
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

      // Ask user about attachments
      const attachmentsAction = (
        await rl.question(
          '\nAttachments: Copy, Move, or Skip? (c/m/s, default: s): ',
        )
      )
        .trim()
        .toLowerCase();
      let copyAttachments: boolean | null = null;
      if (
        !attachmentsAction ||
        attachmentsAction === 's' ||
        attachmentsAction === 'skip' ||
        attachmentsAction === 'n' ||
        attachmentsAction === 'none'
      ) {
        copyAttachments = null; // Skip (default)
      } else {
        copyAttachments =
          attachmentsAction !== 'm' && attachmentsAction !== 'move';
      }

      // Ask user about outputs
      const outputsAction = (
        await rl.question('Outputs: Copy, Move, or Skip? (c/m/s, default: s): ')
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
