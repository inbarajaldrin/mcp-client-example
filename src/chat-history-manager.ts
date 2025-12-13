import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync, renameSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from './logger.js';
import type { Message } from './model-provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Chat storage directory structure:
// .mcp-client-data/chats/
//   ├── YYYY-MM-DD/
//   │   ├── chat-HHMMSS-{sessionId}.json (full history)
//   │   └── chat-HHMMSS-{sessionId}.md (human-readable)
//   └── index.json (metadata of all chats)

const CHATS_DIR = join(__dirname, '..', '.mcp-client-data', 'chats');
const INDEX_FILE = join(CHATS_DIR, 'index.json');

export interface ChatMetadata {
  sessionId: string;
  startTime: string; // ISO timestamp
  endTime?: string; // ISO timestamp
  duration?: number; // milliseconds
  messageCount: number;
  toolUseCount: number;
  model: string;
  servers: string[];
  tags?: string[];
  summary?: string;
  filePath: string;
  mdFilePath: string;
}

export interface ChatSession {
  sessionId: string;
  startTime: string;
  endTime?: string;
  model: string;
  servers: string[];
  messages: Array<{
    timestamp: string;
    role: 'user' | 'assistant' | 'tool' | 'client';
    content: string;
    attachments?: Array<{
      fileName: string;
      ext: string;
      mediaType: string;
    }>;
    toolName?: string;
    toolInput?: Record<string, any>;
    toolOutput?: string;
  }>;
  metadata: {
    totalTokens?: number;
    messageCount: number;
    toolUseCount: number;
  };
}

export class ChatHistoryManager {
  private currentSession: ChatSession | null = null;
  private logger: Logger;
  private sessionStartTime: Date | null = null;
  private index: Map<string, ChatMetadata> = new Map();
  private toolUseCount: number = 0;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.initializeChatDirectory();
    this.loadIndex();
  }

  /**
   * Initialize chat directory structure
   */
  private initializeChatDirectory(): void {
    try {
      if (!existsSync(CHATS_DIR)) {
        mkdirSync(CHATS_DIR, { recursive: true });
        this.logger.log(`Created chat history directory: ${CHATS_DIR}\n`, {
          type: 'info',
        });
      }
    } catch (error) {
      this.logger.log(
        `Failed to create chat directory: ${error}\n`,
        { type: 'error' },
      );
    }
  }

  /**
   * Load existing chat index
   */
  private loadIndex(): void {
    try {
      if (existsSync(INDEX_FILE)) {
        const content = readFileSync(INDEX_FILE, 'utf-8');
        const indexData = JSON.parse(content);
        if (Array.isArray(indexData)) {
          for (const item of indexData) {
            this.index.set(item.sessionId, item);
          }
        }
      }
    } catch (error) {
      this.logger.log(
        `Failed to load chat index: ${error}\n`,
        { type: 'warning' },
      );
    }
  }

  /**
   * Save index to disk
   */
  private saveIndex(): void {
    try {
      const indexArray = Array.from(this.index.values());
      writeFileSync(INDEX_FILE, JSON.stringify(indexArray, null, 2));
    } catch (error) {
      this.logger.log(
        `Failed to save chat index: ${error}\n`,
        { type: 'error' },
      );
    }
  }

  /**
   * Start a new chat session
   */
  startSession(model: string, servers: string[]): string {
    const sessionId = this.generateSessionId();
    const now = new Date();

    this.currentSession = {
      sessionId,
      startTime: now.toISOString(),
      model,
      servers,
      messages: [],
      metadata: {
        messageCount: 0,
        toolUseCount: 0,
      },
    };

    this.sessionStartTime = now;
    this.toolUseCount = 0;

    this.logger.log(`Started chat session: ${sessionId}\n`, { type: 'info' });
    return sessionId;
  }

  /**
   * Add a user message to current session
   */
  addUserMessage(content: string, attachments?: Array<{ fileName: string; ext: string; mediaType: string }>): void {
    if (!this.currentSession) {
      this.logger.log('No active session. Call startSession() first.\n', {
        type: 'warning',
      });
      return;
    }

    this.currentSession.messages.push({
      timestamp: new Date().toISOString(),
      role: 'user',
      content,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    });

    this.currentSession.metadata.messageCount++;
  }

  /**
   * Add a client message to current session (for automatic client-generated messages)
   */
  addClientMessage(content: string): void {
    if (!this.currentSession) {
      this.logger.log('No active session. Call startSession() first.\n', {
        type: 'warning',
      });
      return;
    }

    this.currentSession.messages.push({
      timestamp: new Date().toISOString(),
      role: 'client',
      content,
    });

    this.currentSession.metadata.messageCount++;
  }

  /**
   * Add an assistant message to current session
   */
  addAssistantMessage(content: string): void {
    if (!this.currentSession) {
      this.logger.log('No active session. Call startSession() first.\n', {
        type: 'warning',
      });
      return;
    }

    this.currentSession.messages.push({
      timestamp: new Date().toISOString(),
      role: 'assistant',
      content,
    });

    this.currentSession.metadata.messageCount++;
  }

  /**
   * Add a tool execution to current session
   */
  addToolExecution(
    toolName: string,
    toolInput: Record<string, any>,
    toolOutput: string,
  ): void {
    if (!this.currentSession) {
      this.logger.log('No active session. Call startSession() first.\n', {
        type: 'warning',
      });
      return;
    }

    this.currentSession.messages.push({
      timestamp: new Date().toISOString(),
      role: 'tool',
      content: toolOutput,
      toolName,
      toolInput,
      toolOutput,
    });

    this.currentSession.metadata.messageCount++;
    this.currentSession.metadata.toolUseCount++;
    this.toolUseCount++;
  }

  /**
   * Set total token count for session
   */
  setTokenCount(tokens: number): void {
    if (!this.currentSession) return;
    this.currentSession.metadata.totalTokens = tokens;
  }

  /**
   * End current session and save to disk
   */
  endSession(summary?: string): ChatMetadata | null {
    if (!this.currentSession || !this.sessionStartTime) {
      return null;
    }

    // Don't save if no messages were sent (empty session)
    if (this.currentSession.messages.length === 0) {
      this.currentSession = null;
      this.sessionStartTime = null;
      return null;
    }

    const endTime = new Date();
    const duration = endTime.getTime() - this.sessionStartTime.getTime();

    this.currentSession.endTime = endTime.toISOString();

    // Create directory for today's date
    const today = endTime.toISOString().split('T')[0]; // YYYY-MM-DD
    const dateDir = join(CHATS_DIR, today);

    try {
      if (!existsSync(dateDir)) {
        mkdirSync(dateDir, { recursive: true });
      }

      // Generate file paths
      const timestamp = endTime.toISOString().split('T')[1].split('.')[0].replace(/:/g, '');
      const baseName = `chat-${timestamp}-${this.currentSession.sessionId}`;
      const jsonPath = join(dateDir, `${baseName}.json`);
      const mdPath = join(dateDir, `${baseName}.md`);

      // Save JSON format (machine-readable, for analysis/replay)
      writeFileSync(jsonPath, JSON.stringify(this.currentSession, null, 2));

      // Save Markdown format (human-readable)
      const mdContent = this.generateMarkdownChat(this.currentSession, summary);
      writeFileSync(mdPath, mdContent);

      // Create metadata
      const metadata: ChatMetadata = {
        sessionId: this.currentSession.sessionId,
        startTime: this.currentSession.startTime,
        endTime: this.currentSession.endTime,
        duration,
        messageCount: this.currentSession.metadata.messageCount,
        toolUseCount: this.currentSession.metadata.toolUseCount,
        model: this.currentSession.model,
        servers: this.currentSession.servers,
        summary,
        filePath: jsonPath,
        mdFilePath: mdPath,
      };

      // Update index
      this.index.set(this.currentSession.sessionId, metadata);
      this.saveIndex();

      this.logger.log(
        `Chat saved\n`,
        { type: 'success' },
      );

      this.currentSession = null;
      this.sessionStartTime = null;

      return metadata;
    } catch (error) {
      this.logger.log(
        `Failed to save chat session: ${error}\n`,
        { type: 'error' },
      );
      return null;
    }
  }

  /**
   * Generate human-readable markdown from chat session
   */
  private generateMarkdownChat(session: ChatSession, summary?: string): string {
    let md = '# Chat Session\n\n';

    // Header
    md += `**Session ID:** ${session.sessionId}\n`;
    md += `**Start Time:** ${session.startTime}\n`;
    md += `**End Time:** ${session.endTime || 'Ongoing'}\n`;
    md += `**Model:** ${session.model}\n`;
    md += `**Servers:** ${session.servers.join(', ')}\n`;
    md += `**Messages:** ${session.metadata.messageCount}\n`;
    md += `**Tool Calls:** ${session.metadata.toolUseCount}\n`;

    if (session.metadata.totalTokens) {
      md += `**Tokens Used:** ${session.metadata.totalTokens}\n`;
    }

    if (summary) {
      md += `\n**Summary:** ${summary}\n`;
    }

    md += '\n---\n\n';

    // Messages
    md += '## Conversation\n\n';

    for (const msg of session.messages) {
      const time = new Date(msg.timestamp).toLocaleTimeString();

      if (msg.role === 'user') {
        md += `### You (${time})\n\n`;
        if (msg.attachments && msg.attachments.length > 0) {
          md += `**Attachments:**\n`;
          for (const att of msg.attachments) {
            md += `- ${att.fileName} (${att.mediaType})\n`;
          }
          md += `\n`;
        }
        md += `${msg.content}\n\n`;
      } else if (msg.role === 'client') {
        md += `### Client (${time})\n\n${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        md += `### Assistant (${time})\n\n${msg.content}\n\n`;
      } else if (msg.role === 'tool') {
        md += `### Tool: ${msg.toolName} (${time})\n\n`;
        md += `**Input:**\n\`\`\`json\n${JSON.stringify(msg.toolInput, null, 2)}\n\`\`\`\n\n`;
        md += `**Output:**\n\`\`\`\n${msg.toolOutput}\n\`\`\`\n\n`;
      }
    }

    return md;
  }

  /**
   * Get all chat sessions
   */
  getAllChats(): ChatMetadata[] {
    return Array.from(this.index.values()).sort((a, b) => {
      const timeA = new Date(a.startTime).getTime();
      const timeB = new Date(b.startTime).getTime();
      return timeB - timeA; // Newest first
    });
  }

  /**
   * Get chats from a specific date
   */
  getChatsByDate(date: string): ChatMetadata[] {
    // date format: YYYY-MM-DD
    return this.getAllChats().filter((chat) => {
      const chatDate = chat.startTime.split('T')[0];
      return chatDate === date;
    });
  }

  /**
   * Get chats by tag
   */
  getChatsByTag(tag: string): ChatMetadata[] {
    return this.getAllChats().filter((chat) => chat.tags?.includes(tag));
  }

  /**
   * Load full chat session from disk
   */
  loadChat(sessionId: string): ChatSession | null {
    try {
      const metadata = this.index.get(sessionId);
      if (!metadata) {
        this.logger.log(`Chat session not found: ${sessionId}\n`, {
          type: 'warning',
        });
        return null;
      }

      const content = readFileSync(metadata.filePath, 'utf-8');
      return JSON.parse(content) as ChatSession;
    } catch (error) {
      this.logger.log(
        `Failed to load chat session: ${error}\n`,
        { type: 'error' },
      );
      return null;
    }
  }

  /**
   * Search chats by keyword
   */
  searchChats(keyword: string): ChatMetadata[] {
    const results: ChatMetadata[] = [];

    for (const chat of this.getAllChats()) {
      // Search in metadata
      if (
        chat.sessionId.includes(keyword) ||
        chat.summary?.includes(keyword) ||
        chat.model.includes(keyword)
      ) {
        results.push(chat);
        continue;
      }

      // Search in messages
      const fullChat = this.loadChat(chat.sessionId);
      if (fullChat) {
        for (const msg of fullChat.messages) {
          if (msg.content.includes(keyword) || msg.toolName?.includes(keyword)) {
            results.push(chat);
            break;
          }
        }
      }
    }

    return results;
  }

  /**
   * Export chat as JSON
   */
  exportChatAsJson(sessionId: string): string | null {
    const chat = this.loadChat(sessionId);
    if (!chat) return null;
    return JSON.stringify(chat, null, 2);
  }

  /**
   * Export chat as Markdown
   */
  exportChatAsMarkdown(sessionId: string): string | null {
    const chat = this.loadChat(sessionId);
    if (!chat) return null;

    const metadata = this.index.get(sessionId);
    return this.generateMarkdownChat(chat, metadata?.summary);
  }

  /**
   * Delete a chat session
   */
  deleteChat(sessionId: string): boolean {
    try {
      const metadata = this.index.get(sessionId);
      if (!metadata) return false;

      // Delete files
      if (existsSync(metadata.filePath)) {
        unlinkSync(metadata.filePath);
      }
      if (existsSync(metadata.mdFilePath)) {
        unlinkSync(metadata.mdFilePath);
      }

      // Remove from index
      this.index.delete(sessionId);
      this.saveIndex();

      return true;
    } catch (error) {
      this.logger.log(`Failed to delete chat: ${error}\n`, { type: 'error' });
      return false;
    }
  }

  /**
   * Delete all chat sessions
   */
  deleteAllChats(): number {
    const chats = this.getAllChats();
    let deletedCount = 0;
    let failedCount = 0;

    for (const chat of chats) {
      if (this.deleteChat(chat.sessionId)) {
        deletedCount++;
      } else {
        failedCount++;
      }
    }

    if (failedCount > 0) {
      this.logger.log(
        `Warning: Failed to delete ${failedCount} chat(s)\n`,
        { type: 'warning' },
      );
    }

    return deletedCount;
  }

  /**
   * Add tag to chat session
   */
  addTag(sessionId: string, tag: string): void {
    const metadata = this.index.get(sessionId);
    if (!metadata) return;

    if (!metadata.tags) {
      metadata.tags = [];
    }

    if (!metadata.tags.includes(tag)) {
      metadata.tags.push(tag);
      this.saveIndex();
    }
  }

  /**
   * Get list of existing folders in the chats directory
   */
  getExistingFolders(): string[] {
    try {
      if (!existsSync(CHATS_DIR)) {
        return [];
      }

      const items = readdirSync(CHATS_DIR);
      const folders: string[] = [];

      for (const item of items) {
        // Skip index.json and other files
        if (item === 'index.json') {
          continue;
        }

        const itemPath = join(CHATS_DIR, item);
        try {
          const stats = statSync(itemPath);
          if (stats.isDirectory()) {
            folders.push(item);
          }
        } catch {
          // Skip items we can't access
          continue;
        }
      }

      // Sort folders alphabetically
      folders.sort();
      return folders;
    } catch (error) {
      this.logger.log(`Failed to list folders: ${error}\n`, {
        type: 'warning',
      });
      return [];
    }
  }

  /**
   * Rename chat session files
   * @param sessionId - The session ID to rename
   * @param newName - The new name for the chat
   * @param folderName - Optional folder name to move the chat to (within chats directory)
   */
  renameChat(sessionId: string, newName: string, folderName?: string): boolean {
    const metadata = this.index.get(sessionId);
    if (!metadata) {
      this.logger.log(`Chat session not found: ${sessionId}\n`, {
        type: 'warning',
      });
      return false;
    }

    try {
      // Sanitize name for filename (remove special chars, replace spaces with hyphens)
      const sanitizedName = newName
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with single
        .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

      if (!sanitizedName) {
        this.logger.log('Invalid name provided\n', { type: 'error' });
        return false;
      }

      // Determine target directory
      let targetDir: string;
      if (folderName) {
        // Sanitize folder name
        const sanitizedFolderName = folderName
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
          .replace(/\s+/g, '-') // Replace spaces with hyphens
          .replace(/-+/g, '-') // Replace multiple hyphens with single
          .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
        
        if (!sanitizedFolderName) {
          this.logger.log('Invalid folder name provided\n', { type: 'error' });
          return false;
        }
        
        // Create folder path within chats directory
        targetDir = join(CHATS_DIR, sanitizedFolderName);
        
        // Create folder if it doesn't exist
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true });
        }
      } else {
        // Use existing directory
        targetDir = dirname(metadata.filePath);
      }

      // Generate new filenames using last part of sessionId and name
      const oldJsonPath = metadata.filePath;
      const oldMdPath = metadata.mdFilePath;
      
      // Extract last part of sessionId (e.g., "s46w4z" from "20251212-214813-s46w4z")
      const sessionIdParts = sessionId.split('-');
      const sessionIdShort = sessionIdParts[sessionIdParts.length - 1];
      
      // Use short sessionId and name as filename: chat-{shortSessionId}-{name}.json
      const newJsonPath = join(targetDir, `chat-${sessionIdShort}-${sanitizedName}.json`);
      const newMdPath = join(targetDir, `chat-${sessionIdShort}-${sanitizedName}.md`);

      // Move/rename files if they exist and paths are different
      if (existsSync(oldJsonPath) && oldJsonPath !== newJsonPath) {
        renameSync(oldJsonPath, newJsonPath);
      }
      if (existsSync(oldMdPath) && oldMdPath !== newMdPath) {
        renameSync(oldMdPath, newMdPath);
      }

      // Update metadata file paths
      metadata.filePath = newJsonPath;
      metadata.mdFilePath = newMdPath;
      this.saveIndex();

      return true;
    } catch (error) {
      this.logger.log(`Failed to rename chat files: ${error}\n`, {
        type: 'error',
      });
      return false;
    }
  }

  /**
   * Generate statistics
   */
  getStatistics(): {
    totalChats: number;
    totalMessages: number;
    totalToolUses: number;
    averageMessagesPerChat: number;
    averageToolUsesPerChat: number;
    mostUsedModel: string | null;
    mostUsedServers: string[];
  } {
    const chats = this.getAllChats();

    if (chats.length === 0) {
      return {
        totalChats: 0,
        totalMessages: 0,
        totalToolUses: 0,
        averageMessagesPerChat: 0,
        averageToolUsesPerChat: 0,
        mostUsedModel: null,
        mostUsedServers: [],
      };
    }

    const totalMessages = chats.reduce((sum, chat) => sum + chat.messageCount, 0);
    const totalToolUses = chats.reduce((sum, chat) => sum + chat.toolUseCount, 0);

    // Find most used model
    const modelCounts = new Map<string, number>();
    for (const chat of chats) {
      modelCounts.set(chat.model, (modelCounts.get(chat.model) || 0) + 1);
    }
    const mostUsedModel =
      Array.from(modelCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ||
      null;

    // Find most used servers
    const serverCounts = new Map<string, number>();
    for (const chat of chats) {
      for (const server of chat.servers) {
        serverCounts.set(server, (serverCounts.get(server) || 0) + 1);
      }
    }
    const mostUsedServers = Array.from(serverCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([server]) => server);

    return {
      totalChats: chats.length,
      totalMessages,
      totalToolUses,
      averageMessagesPerChat: Math.round(totalMessages / chats.length),
      averageToolUsesPerChat: Math.round(totalToolUses / chats.length),
      mostUsedModel,
      mostUsedServers,
    };
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    // Format: YYYYMMDD-HHMMSS-random
    const now = new Date();
    const date = now.toISOString().split('T')[0].replace(/-/g, '');
    const time = now.toISOString().split('T')[1].split('.')[0].replace(/:/g, '');
    const random = Math.random().toString(36).substring(2, 8);
    return `${date}-${time}-${random}`;
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSession?.sessionId || null;
  }

  /**
   * Check if session is active
   */
  isSessionActive(): boolean {
    return this.currentSession !== null;
  }
}