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
  tokenUsagePerCallback?: Array<{
    timestamp: string;
    inputTokens: number; // Total input tokens (regular + cache creation + cache read)
    outputTokens: number;
    totalTokens: number;
    regularInputTokens?: number; // Regular input tokens only (full price)
    cacheCreationTokens?: number; // Cache creation input tokens (full price)
    cacheReadTokens?: number; // Cache read tokens (90% discount)
    estimatedCost?: number; // Estimated cost in USD for this callback
  }>;
  metadata: {
    totalTokens?: number;
    messageCount: number;
    toolUseCount: number;
    totalCost?: number; // Total estimated cost in USD for the session
  };
}

// Model pricing (per million tokens in USD)
// Model pricing per million tokens (USD)
// Sources: 
// - Anthropic: https://www.anthropic.com/pricing (updated December 2025)
// - OpenAI: https://platform.openai.com/docs/models (updated December 2025)
// Note: Pricing may vary by context window size (e.g., >200K tokens for Sonnet 4.5)
// Cache pricing: Anthropic uses 10% of input price (90% discount), OpenAI varies by model
const MODEL_PRICING: Record<string, { input: number; output: number; inputLongContext?: number; outputLongContext?: number; cachedInput?: number }> = {
  // ========== Anthropic Claude Models ==========
  // Claude 4.5 Opus
  'claude-opus-4-5-20251101': { input: 5.00, output: 25.00, cachedInput: 0.50 }, // 10% discount
  'claude-4-5-opus': { input: 5.00, output: 25.00, cachedInput: 0.50 },
  
  // Claude Sonnet 4.5 (standard: 0-200K tokens, long context: >200K tokens)
  'claude-sonnet-4-5-20251101': { input: 3.00, output: 15.00, inputLongContext: 6.00, outputLongContext: 22.50, cachedInput: 0.30 },
  'claude-3-7-sonnet-latest': { input: 3.00, output: 15.00, inputLongContext: 6.00, outputLongContext: 22.50, cachedInput: 0.30 },
  'claude-3-7-sonnet-20250219': { input: 3.00, output: 15.00, inputLongContext: 6.00, outputLongContext: 22.50, cachedInput: 0.30 },
  
  // Claude 3.5 Sonnet
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00, cachedInput: 0.30 },
  'claude-3-5-sonnet-20240620': { input: 3.00, output: 15.00, cachedInput: 0.30 },
  'claude-3-5-sonnet-latest': { input: 3.00, output: 15.00, cachedInput: 0.30 },
  
  // Claude 3.5 Haiku
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00, cachedInput: 0.08 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, cachedInput: 0.08 },
  'claude-3-5-haiku-latest': { input: 0.80, output: 4.00, cachedInput: 0.08 },
  
  // Claude 3 Opus (legacy)
  'claude-3-opus-20240229': { input: 15.00, output: 75.00, cachedInput: 1.50 },
  
  // Claude 3 Sonnet (legacy)
  'claude-3-sonnet-20240229': { input: 3.00, output: 15.00, cachedInput: 0.30 },
  
  // Claude 3 Haiku (legacy)
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25, cachedInput: 0.025 },
  
  // ========== OpenAI Models ==========
  // GPT-5 and GPT-5-Codex
  'gpt-5': { input: 1.25, output: 10.00, cachedInput: 0.125 }, // 10% discount
  'gpt-5-chat-latest': { input: 1.25, output: 10.00, cachedInput: 0.125 },
  'gpt-5-codex': { input: 1.25, output: 10.00, cachedInput: 0.125 },
  
  // GPT-5 Mini
  'gpt-5-mini': { input: 0.25, output: 2.00, cachedInput: 0.025 }, // 10% discount
  'gpt-5-mini-latest': { input: 0.25, output: 2.00, cachedInput: 0.025 },
  
  // ChatGPT-4o
  'chatgpt-4o-latest': { input: 5.00, output: 15.00 },
  
  // GPT-4o
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-2024-08-06': { input: 2.50, output: 10.00 },
  'gpt-4o-2024-05-13': { input: 2.50, output: 10.00 },
  
  // GPT-4o mini
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.60 },
  
  // GPT-4o mini Realtime
  'gpt-4o-mini-realtime-preview': { input: 0.60, output: 2.40, cachedInput: 0.30 }, // 50% discount
  
  // GPT-4 Turbo
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4-turbo-2024-04-09': { input: 10.00, output: 30.00 },
  
  // GPT-4 (legacy)
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-4-32k': { input: 60.00, output: 120.00 },
  
  // o1 series (reasoning models)
  'o1-preview': { input: 15.00, output: 60.00, cachedInput: 7.50 }, // 50% discount
  'o1-mini': { input: 3.00, output: 12.00, cachedInput: 1.50 }, // 50% discount
  'o1-pro': { input: 15.00, output: 60.00, cachedInput: 7.50 },
  'o3': { input: 15.00, output: 60.00, cachedInput: 7.50 },
  
  // GPT-3.5 Turbo
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'gpt-3.5-turbo-16k': { input: 0.50, output: 1.50 },
};

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
   * Calculate estimated cost for a callback
   * Uses Context7-sourced pricing data (updated December 2025)
   * Supports long context pricing for models like Sonnet 4.5 (>200K tokens)
   */
  private calculateCost(
    model: string,
    regularInputTokens: number,
    cacheCreationTokens: number,
    cacheReadTokens: number,
    outputTokens: number,
    totalInputTokens?: number // Total input tokens to determine if long context pricing applies
  ): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) {
      // Unknown model, return 0
      return 0;
    }

    // Determine if long context pricing applies (>200K tokens for Sonnet 4.5)
    const useLongContextPricing = totalInputTokens && totalInputTokens > 200_000 && 
                                   pricing.inputLongContext && pricing.outputLongContext;
    
    const inputPrice = useLongContextPricing ? pricing.inputLongContext! : pricing.input;
    const outputPrice = useLongContextPricing ? pricing.outputLongContext! : pricing.output;

    // Cost calculation:
    // - Regular input: full price (or long context price if applicable)
    // - Cache creation: full price (same as regular input)
    // - Cache read: uses cachedInput price if available, otherwise falls back to 10% of input price
    //   - Anthropic: 10% of input price (90% discount)
    //   - OpenAI: varies by model (o1 series: 50%, GPT-5: 10%, GPT-4o mini Realtime: 50%)
    // - Output: full output price (or long context price if applicable)
    const inputCost = (regularInputTokens / 1_000_000) * inputPrice;
    const cacheCreationCost = (cacheCreationTokens / 1_000_000) * inputPrice;
    const cachedInputPrice = pricing.cachedInput || pricing.input * 0.1; // Default to 10% if not specified
    const cacheReadCost = (cacheReadTokens / 1_000_000) * cachedInputPrice;
    const outputCost = (outputTokens / 1_000_000) * outputPrice;

    return inputCost + cacheCreationCost + cacheReadCost + outputCost;
  }

  /**
   * Log token usage per callback from agent
   */
  addTokenUsagePerCallback(
    inputTokens: number,
    outputTokens: number,
    totalTokens: number,
    regularInputTokens?: number,
    cacheCreationTokens?: number,
    cacheReadTokens?: number
  ): void {
    if (!this.currentSession) return;

    if (!this.currentSession.tokenUsagePerCallback) {
      this.currentSession.tokenUsagePerCallback = [];
    }

    // Calculate estimated cost for this callback
    let estimatedCost: number | undefined;
    if (regularInputTokens !== undefined || cacheCreationTokens !== undefined || cacheReadTokens !== undefined) {
      // Calculate total input tokens for long context pricing detection
      const totalInputTokens = (regularInputTokens || 0) + (cacheCreationTokens || 0) + (cacheReadTokens || 0);
      
      estimatedCost = this.calculateCost(
        this.currentSession.model,
        regularInputTokens || 0,
        cacheCreationTokens || 0,
        cacheReadTokens || 0,
        outputTokens,
        totalInputTokens > 0 ? totalInputTokens : inputTokens // Use totalInputTokens if available, otherwise fall back to inputTokens
      );

      // Update total cost
      if (!this.currentSession.metadata.totalCost) {
        this.currentSession.metadata.totalCost = 0;
      }
      this.currentSession.metadata.totalCost += estimatedCost;
    }

    this.currentSession.tokenUsagePerCallback.push({
      timestamp: new Date().toISOString(),
      inputTokens,
      outputTokens,
      totalTokens,
      regularInputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      estimatedCost,
    });
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

    // Display total estimated cost
    if (session.metadata.totalCost !== undefined && session.metadata.totalCost > 0) {
      md += `**Estimated Cost:** $${session.metadata.totalCost.toFixed(6)}\n`;
    }

    if (summary) {
      md += `\n**Summary:** ${summary}\n`;
    }

    md += '\n---\n\n';

    // Messages
    md += '## Conversation\n\n';

    // Track token usage index to display after each assistant message
    let tokenUsageIndex = 0;

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

        // Display token usage for this callback if available
        if (session.tokenUsagePerCallback && tokenUsageIndex < session.tokenUsagePerCallback.length) {
          const tokenUsage = session.tokenUsagePerCallback[tokenUsageIndex];
          const tokenTime = new Date(tokenUsage.timestamp).toLocaleTimeString();
          md += `**Token Usage (Callback ${tokenUsageIndex + 1}, ${tokenTime}):** `;
          md += `Input: ${tokenUsage.inputTokens.toLocaleString()}, Output: ${tokenUsage.outputTokens.toLocaleString()}`;

          // Add cache breakdown if available
          if (tokenUsage.regularInputTokens !== undefined || tokenUsage.cacheCreationTokens !== undefined || tokenUsage.cacheReadTokens !== undefined) {
            const regular = tokenUsage.regularInputTokens || 0;
            const cacheCreation = tokenUsage.cacheCreationTokens || 0;
            const cacheRead = tokenUsage.cacheReadTokens || 0;
            if (regular > 0 || cacheCreation > 0 || cacheRead > 0) {
              md += `, Breakdown: ${regular.toLocaleString()} regular + ${cacheCreation.toLocaleString()} cache-write + ${cacheRead.toLocaleString()} cache-read`;
            }
          }

          // Add estimated cost if available
          if (tokenUsage.estimatedCost !== undefined && tokenUsage.estimatedCost > 0) {
            md += `, Cost: $${tokenUsage.estimatedCost.toFixed(6)}`;
          }

          md += `\n\n`;
          tokenUsageIndex++;
        }
      } else if (msg.role === 'tool') {
        md += `### Tool: ${msg.toolName} (${time})\n\n`;
        md += `**Input:**\n\`\`\`json\n${JSON.stringify(msg.toolInput, null, 2)}\n\`\`\`\n\n`;
        md += `**Output:**\n\`\`\`\n${msg.toolOutput}\n\`\`\`\n\n`;
      }
    }

    // Display any remaining token usage entries that weren't displayed after assistant messages
    // This happens when the final token usage is logged after all messages are complete
    if (session.tokenUsagePerCallback && tokenUsageIndex < session.tokenUsagePerCallback.length) {
      while (tokenUsageIndex < session.tokenUsagePerCallback.length) {
        const tokenUsage = session.tokenUsagePerCallback[tokenUsageIndex];
        const tokenTime = new Date(tokenUsage.timestamp).toLocaleTimeString();
        md += `**Token Usage (Callback ${tokenUsageIndex + 1}, ${tokenTime}):** `;
        md += `Input: ${tokenUsage.inputTokens.toLocaleString()}, Output: ${tokenUsage.outputTokens.toLocaleString()}`;

        // Add cache breakdown if available
        if (tokenUsage.regularInputTokens !== undefined || tokenUsage.cacheCreationTokens !== undefined || tokenUsage.cacheReadTokens !== undefined) {
          const regular = tokenUsage.regularInputTokens || 0;
          const cacheCreation = tokenUsage.cacheCreationTokens || 0;
          const cacheRead = tokenUsage.cacheReadTokens || 0;
          if (regular > 0 || cacheCreation > 0 || cacheRead > 0) {
            md += `, Breakdown: ${regular.toLocaleString()} regular + ${cacheCreation.toLocaleString()} cache-write + ${cacheRead.toLocaleString()} cache-read`;
          }
        }

        // Add estimated cost if available
        if (tokenUsage.estimatedCost !== undefined && tokenUsage.estimatedCost > 0) {
          md += `, Cost: $${tokenUsage.estimatedCost.toFixed(6)}`;
        }

        md += `\n\n`;
        tokenUsageIndex++;
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