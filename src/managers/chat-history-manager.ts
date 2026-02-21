import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync, renameSync, readdirSync, statSync, copyFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../logger.js';
import type { Message } from '../model-provider.js';
import { getModelInfo } from '../utils/models-dev.js';
import { sanitizeFolderName } from '../utils/path-utils.js';
import { directoryHasFiles, copyDirectoryRecursive, moveDirectoryRecursive } from '../utils/file-ops.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Chat storage directory structure:
// .mcp-client-data/chats/
//   ├── YYYY-MM-DD/
//   │   ├── chat-HHMMSS-{sessionId}.json (full history)
//   │   └── chat-HHMMSS-{sessionId}.md (human-readable)
//   └── index.json (metadata of all chats)

const CHATS_DIR = join(__dirname, '../..', '.mcp-client-data', 'chats');
const INDEX_FILE = join(CHATS_DIR, 'index.json');
const ATTACHMENTS_DIR = join(__dirname, '../..', '.mcp-client-data', 'attachments');
const OUTPUTS_DIR = join(__dirname, '../..', '.mcp-client-data', 'outputs');

export interface ChatMetadata {
  sessionId: string;
  startTime: string; // ISO timestamp
  endTime?: string; // ISO timestamp
  duration?: number; // milliseconds
  messageCount: number;
  toolUseCount: number;
  ipcCallCount?: number; // IPC calls made automatically (optional for backward compatibility)
  model: string;
  servers: string[];
  tags?: string[];
  // TODO: Fix summary creation logic - currently it's being set to end reason instead of actual chat summary
  // summary?: string;
  name?: string;
  filePath: string;
  mdFilePath: string;
}

export interface ChatSession {
  sessionId: string;
  startTime: string;
  endTime?: string;
  model: string;
  servers: string[];
  tools?: Array<{
    name: string;
    description: string;
    input_schema?: {
      type: 'object';
      properties?: Record<string, any>;
      required?: string[];
    };
  }>;
  messages: Array<{
    timestamp: string;
    role: 'user' | 'assistant' | 'tool' | 'client';
    content: string;
    // For assistant messages with tool_use blocks (preserves full structure for restore)
    content_blocks?: Array<{ type: string; [key: string]: any }>;
    // For tool result messages (preserves tool_use_id for proper pairing on restore)
    tool_use_id?: string;
    attachments?: Array<{
      fileName: string;
      ext: string;
      mediaType: string;
    }>;
    toolName?: string;
    toolInput?: Record<string, any>;
    toolOutput?: string;
    toolInputTime?: string; // ISO timestamp when tool input was sent
    toolOutputTime?: string; // ISO timestamp when tool output was received
    orchestratorMode?: boolean; // Track if tool was called in orchestrator mode
    isIPCCall?: boolean; // Track if this was an IPC call (automatic, not by agent)
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
    // Ollama-specific metrics (optional, for local LLM providers)
    ollamaMetrics?: {
      totalDuration?: number;      // nanoseconds
      loadDuration?: number;       // nanoseconds
      evalDuration?: number;       // nanoseconds
      promptEvalDuration?: number; // nanoseconds
      evalCount?: number;          // output tokens (also stored in outputTokens)
      promptEvalCount?: number;    // input tokens (also stored in inputTokens)
      evalRate?: number;           // tokens/second
      promptEvalRate?: number;     // tokens/second
    };
  }>;
  metadata: {
    cumulativeTokens?: number; // Total tokens billed across all API calls (input + output summed)
    peakContextTokens?: number; // Maximum context size reached (input + output after each API call)
    messageCount: number;
    toolUseCount: number; // Tool calls made by agent (excludes IPC calls)
    ipcCallCount: number; // IPC calls made automatically
    totalCost?: number; // Total estimated cost in USD for the session
  };
}

export class ChatHistoryManager {
  private currentSession: ChatSession | null = null;
  private logger: Logger;
  private sessionStartTime: Date | null = null;
  private index: Map<string, ChatMetadata> = new Map();
  private toolUseCount: number = 0;
  private providerName: string | undefined;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.initializeChatDirectory();
    this.loadIndex();
  }

  setProviderName(name: string): void {
    this.providerName = name;
  }

  getCurrentSession(): ChatSession | null {
    return this.currentSession;
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
  startSession(model: string, servers: string[], tools?: Array<{ name: string; description: string; input_schema?: { type: 'object'; properties?: Record<string, any>; required?: string[] } }>, resumeSessionId?: string): string {
    const sessionId = resumeSessionId || this.generateSessionId();
    const now = new Date();

    this.currentSession = {
      sessionId,
      startTime: now.toISOString(),
      model,
      servers,
      tools: tools?.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
      messages: [],
      metadata: {
        messageCount: 0,
        toolUseCount: 0,
        ipcCallCount: 0,
      },
    };

    this.sessionStartTime = now;
    this.toolUseCount = 0;

    if (!resumeSessionId) {
      this.logger.log(`Started chat session: ${sessionId}\n`, { type: 'info' });
    }
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
  addAssistantMessage(content: string, contentBlocks?: Array<{ type: string; [key: string]: any }>): void {
    if (!this.currentSession) {
      this.logger.log('No active session. Call startSession() first.\n', {
        type: 'warning',
      });
      return;
    }

    const message: any = {
      timestamp: new Date().toISOString(),
      role: 'assistant',
      content,
    };

    // Preserve content_blocks if present (for tool_use blocks)
    if (contentBlocks && contentBlocks.length > 0) {
      message.content_blocks = contentBlocks;
    }

    this.currentSession.messages.push(message);
    this.currentSession.metadata.messageCount++;
  }

  /**
   * Add a tool execution to current session
   */
  addToolExecution(
    toolName: string,
    toolInput: Record<string, any>,
    toolOutput: string,
    orchestratorMode: boolean = false,
    isIPCCall: boolean = false,
    toolInputTime?: string, // Optional ISO timestamp when tool input was sent
    toolUseId?: string, // Optional tool_use_id for pairing with assistant's tool_use block
  ): void {
    if (!this.currentSession) {
      this.logger.log('No active session. Call startSession() first.\n', {
        type: 'warning',
      });
      return;
    }

    const toolOutputTime = new Date().toISOString();
    const timestamp = toolInputTime || toolOutputTime; // Use input time if available, otherwise output time

    const message: any = {
      timestamp,
      role: 'tool',
      content: toolOutput,
      toolName,
      toolInput,
      toolOutput,
      toolInputTime: toolInputTime || toolOutputTime, // If not provided, use output time as fallback
      toolOutputTime,
      orchestratorMode,
      isIPCCall,
    };

    // Store tool_use_id if provided (needed for proper restore)
    if (toolUseId) {
      message.tool_use_id = toolUseId;
    }

    this.currentSession.messages.push(message);

    this.currentSession.metadata.messageCount++;

    // IPC calls are counted separately from agent tool calls
    if (isIPCCall) {
      this.currentSession.metadata.ipcCallCount++;
    } else {
      this.currentSession.metadata.toolUseCount++;
      this.toolUseCount++;
    }
  }

  /**
   * Get user message indices from current session for rewind functionality.
   * Returns an array of { index, content, timestamp } for each user message.
   */
  getUserTurns(): Array<{ index: number; content: string; timestamp: string }> {
    if (!this.currentSession) return [];
    return this.currentSession.messages
      .map((msg, idx) => ({ index: idx, role: msg.role, content: msg.content, timestamp: msg.timestamp }))
      .filter(msg => msg.role === 'user')
      .map(msg => ({ index: msg.index, content: msg.content, timestamp: msg.timestamp }));
  }

  /**
   * Truncate session messages to rewind to a specific point.
   * Removes all messages from the given index onward and recalculates metadata.
   */
  rewindToIndex(messageIndex: number): void {
    if (!this.currentSession) return;

    this.currentSession.messages = this.currentSession.messages.slice(0, messageIndex);

    // Recalculate metadata from remaining messages
    const remaining = this.currentSession.messages;
    this.currentSession.metadata.messageCount = remaining.length;
    this.currentSession.metadata.toolUseCount = remaining.filter(
      m => m.role === 'tool' && m.isIPCCall !== true
    ).length;
    this.currentSession.metadata.ipcCallCount = remaining.filter(
      m => m.role === 'tool' && m.isIPCCall === true
    ).length;
    this.toolUseCount = this.currentSession.metadata.toolUseCount;

    // Trim tokenUsagePerCallback if it has more entries than remaining assistant messages
    if (this.currentSession.tokenUsagePerCallback) {
      const assistantCount = remaining.filter(m => m.role === 'assistant').length;
      if (this.currentSession.tokenUsagePerCallback.length > assistantCount) {
        this.currentSession.tokenUsagePerCallback = this.currentSession.tokenUsagePerCallback.slice(0, assistantCount);
      }
    }
  }

  /**
   * Get replayable tool calls from current session (excludes IPC calls).
   * Returns most recent first.
   */
  getReplayableToolCalls(): Array<{
    toolName: string;
    toolInput: Record<string, any>;
    toolOutput: string;
    timestamp: string;
    orchestratorMode: boolean;
  }> {
    if (!this.currentSession) return [];
    return this.currentSession.messages
      .filter(msg => msg.role === 'tool' && msg.isIPCCall !== true)
      .map(msg => ({
        toolName: msg.toolName!,
        toolInput: msg.toolInput!,
        toolOutput: msg.toolOutput || '',
        timestamp: msg.timestamp,
        orchestratorMode: msg.orchestratorMode || false,
      }))
      .reverse();
  }

  /**
   * Set total token count for session
   */
  setTokenCount(tokens: number): void {
    if (!this.currentSession) return;
    this.currentSession.metadata.cumulativeTokens = tokens;
  }

  /**
   * Calculate estimated cost using models.dev pricing data.
   * Supports: regular input, cache read/write, output, long context (>200k) tiers.
   * Prices are per 1 million tokens.
   */
  private calculateCost(
    model: string,
    regularInputTokens: number,
    cacheCreationTokens: number,
    cacheReadTokens: number,
    outputTokens: number,
    totalInputTokens?: number
  ): number {
    const info = getModelInfo(model, this.providerName);
    if (!info?.cost) return 0;

    // Select pricing tier: >200k context gets different rates
    const totalInput = totalInputTokens || (regularInputTokens + cacheCreationTokens + cacheReadTokens);
    const cost = (info.cost.context_over_200k && totalInput > 200_000)
      ? info.cost.context_over_200k : info.cost;

    const inputCost = (regularInputTokens / 1_000_000) * cost.input;
    const cacheWriteCost = (cacheCreationTokens / 1_000_000) * (cost.cache_write ?? cost.input);
    const cacheReadCost = (cacheReadTokens / 1_000_000) * (cost.cache_read ?? cost.input * 0.1);
    const outputCost = (outputTokens / 1_000_000) * cost.output;
    // TODO: Use cost.reasoning for separate reasoning token pricing when reasoning token
    // counts are tracked separately from output tokens. Currently reasoning tokens are
    // included in outputTokens by all providers.

    return inputCost + cacheWriteCost + cacheReadCost + outputCost;
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
    cacheReadTokens?: number,
    ollamaMetrics?: {
      totalDuration?: number;
      loadDuration?: number;
      evalDuration?: number;
      promptEvalDuration?: number;
      evalCount?: number;
      promptEvalCount?: number;
      evalRate?: number;
      promptEvalRate?: number;
    }
  ): void {
    if (!this.currentSession) return;

    if (!this.currentSession.tokenUsagePerCallback) {
      this.currentSession.tokenUsagePerCallback = [];
    }

    // Calculate estimated cost for this callback (skip for Ollama - no cost for local LLMs)
    let estimatedCost: number | undefined;
    if (!ollamaMetrics && (regularInputTokens !== undefined || cacheCreationTokens !== undefined || cacheReadTokens !== undefined)) {
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

    // Update cumulative tokens (total billed across all API calls)
    if (!this.currentSession.metadata.cumulativeTokens) {
      this.currentSession.metadata.cumulativeTokens = 0;
    }
    this.currentSession.metadata.cumulativeTokens += totalTokens;

    // Update peak context tokens (max context size reached after any API call)
    const contextAfterCall = inputTokens + outputTokens;
    if (!this.currentSession.metadata.peakContextTokens || contextAfterCall > this.currentSession.metadata.peakContextTokens) {
      this.currentSession.metadata.peakContextTokens = contextAfterCall;
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
      ollamaMetrics,
    });
  }

  /**
   * Save current session to disk without ending it
   * Used when exporting or renaming an active session
   */
  private saveCurrentSession(summary?: string): ChatMetadata | null {
    if (!this.currentSession || !this.sessionStartTime) {
      return null;
    }

    // Don't save if no messages were sent (empty session)
    if (this.currentSession.messages.length === 0) {
      return null;
    }

    // Don't save if no actual API calls were made during this session
    // (e.g., only added attachments, used tool replay, or restored chat without new interaction)
    if (!this.currentSession.tokenUsagePerCallback || this.currentSession.tokenUsagePerCallback.length === 0) {
      this.logger.log('Chat not saved: no API calls were made during this session\n', { type: 'info' });
      return null;
    }

    // Check if already saved (exists in index)
    if (this.index.has(this.currentSession.sessionId)) {
      return this.index.get(this.currentSession.sessionId)!;
    }

    const endTime = new Date();
    const duration = endTime.getTime() - this.sessionStartTime.getTime();

    // Create a copy of the session for saving (don't modify the current one)
    const sessionToSave = { ...this.currentSession };
    sessionToSave.endTime = endTime.toISOString();

    // Create directory for today's date (using local time)
    const year = endTime.getFullYear();
    const month = String(endTime.getMonth() + 1).padStart(2, '0');
    const day = String(endTime.getDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`; // YYYY-MM-DD in local time
    const dateDir = join(CHATS_DIR, today);

    try {
      if (!existsSync(dateDir)) {
        mkdirSync(dateDir, { recursive: true });
      }

      // Generate file paths (using local time)
      const hours = String(endTime.getHours()).padStart(2, '0');
      const minutes = String(endTime.getMinutes()).padStart(2, '0');
      const seconds = String(endTime.getSeconds()).padStart(2, '0');
      const timestamp = `${hours}${minutes}${seconds}`; // HHMMSS in local time
      const baseName = `chat-${timestamp}-${sessionToSave.sessionId}`;
      const jsonPath = join(dateDir, `${baseName}.json`);
      const mdPath = join(dateDir, `${baseName}.md`);

      // Save JSON format (machine-readable, for analysis/replay)
      writeFileSync(jsonPath, JSON.stringify(sessionToSave, null, 2));

      // Save Markdown format (human-readable)
      // TODO: Fix summary creation logic - summary parameter should be actual chat summary, not end reason
      const mdContent = this.generateMarkdownChat(sessionToSave); // summary);
      writeFileSync(mdPath, mdContent);

      // Create metadata
      const metadata: ChatMetadata = {
        sessionId: sessionToSave.sessionId,
        startTime: sessionToSave.startTime,
        endTime: sessionToSave.endTime,
        duration,
        messageCount: sessionToSave.metadata.messageCount,
        toolUseCount: sessionToSave.metadata.toolUseCount,
        ipcCallCount: sessionToSave.metadata.ipcCallCount,
        model: sessionToSave.model,
        servers: sessionToSave.servers,
        // TODO: Fix summary creation logic - currently summary is end reason, not actual chat summary
        // summary,
        filePath: jsonPath,
        mdFilePath: mdPath,
      };

      // Update index
      this.index.set(sessionToSave.sessionId, metadata);
      this.saveIndex();

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
   * End current session and save to disk
   * TODO: Fix summary creation logic - summary parameter is being used as end reason, should be actual chat summary
   */
  endSession(summary?: string): ChatMetadata | null {
    // TODO: Fix summary creation logic - don't pass end reason as summary
    const metadata = this.saveCurrentSession(summary);

    if (metadata) {
      this.logger.log(
        `Chat saved: ${metadata.sessionId}\n`,
        { type: 'success' },
      );
    }

    // Clear session after saving
    this.currentSession = null;
    this.sessionStartTime = null;

    return metadata;
  }

  /**
   * Discard the current session without saving
   * Used when clearing context to start a fresh session
   */
  discardSession(): void {
    if (this.currentSession) {
      this.logger.log(`Discarded chat session: ${this.currentSession.sessionId}\n`, { type: 'info' });
    }
    this.currentSession = null;
    this.sessionStartTime = null;
    this.toolUseCount = 0;
  }

  /**
   * Pause the current session without saving to disk.
   * Returns the session state so it can be resumed later.
   */
  pauseSession(): { session: ChatSession; startTime: Date; toolUseCount: number } | null {
    if (!this.currentSession || !this.sessionStartTime) {
      return null;
    }

    const state = {
      session: this.currentSession,
      startTime: this.sessionStartTime,
      toolUseCount: this.toolUseCount,
    };

    // Clear without saving
    this.currentSession = null;
    this.sessionStartTime = null;
    this.toolUseCount = 0;

    return state;
  }

  /**
   * Resume a previously paused session.
   * Restores the full session state including all messages and metadata.
   */
  resumeSession(state: { session: ChatSession; startTime: Date; toolUseCount: number }): void {
    this.currentSession = state.session;
    this.sessionStartTime = state.startTime;
    this.toolUseCount = state.toolUseCount;
  }

  /**
   * Generate human-readable markdown from chat session
   * TODO: Fix summary creation logic - add summary display when summary is properly implemented
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
    md += `**Tool Calls (Agent):** ${session.metadata.toolUseCount}\n`;
    if (session.metadata.ipcCallCount > 0) {
      md += `**IPC Calls (Automatic):** ${session.metadata.ipcCallCount}\n`;
    }

    // Display peak context (max conversation size)
    if (session.metadata.peakContextTokens !== undefined && session.metadata.peakContextTokens > 0) {
      md += `**Peak Context:** ${session.metadata.peakContextTokens.toLocaleString()} tokens\n`;
    }

    // Display cumulative tokens (total billed)
    if (session.metadata.cumulativeTokens !== undefined && session.metadata.cumulativeTokens > 0) {
      md += `**Cumulative Tokens:** ${session.metadata.cumulativeTokens.toLocaleString()}\n`;
    }

    // Display total estimated cost
    if (session.metadata.totalCost !== undefined && session.metadata.totalCost > 0) {
      md += `**Estimated Cost:** $${session.metadata.totalCost.toFixed(6)}\n`;
    }

    md += '\n---\n\n';
    
    // Display available tools list
    if (session.tools && session.tools.length > 0) {
      md += '## Available Tools\n\n';
      // Group tools by server (tools have format: server__toolname)
      const toolsByServer = new Map<string, string[]>();
      for (const tool of session.tools) {
        const parts = tool.name.split('__');
        if (parts.length === 2) {
          const [server, toolName] = parts;
          if (!toolsByServer.has(server)) {
            toolsByServer.set(server, []);
          }
          toolsByServer.get(server)!.push(toolName);
        } else {
          // Tool without server prefix
          if (!toolsByServer.has('default')) {
            toolsByServer.set('default', []);
          }
          toolsByServer.get('default')!.push(tool.name);
        }
      }
      
      for (const [server, toolNames] of Array.from(toolsByServer.entries()).sort()) {
        md += `### ${server}\n\n`;
        for (const toolName of toolNames.sort()) {
          md += `- \`${toolName}\`\n`;
        }
        md += '\n';
      }
      md += '---\n\n';
    }

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

          // Add Ollama metrics if available
          if (tokenUsage.ollamaMetrics) {
            const om = tokenUsage.ollamaMetrics;
            md += `\n  - **Ollama Metrics:**`;
            if (om.totalDuration) {
              md += ` Total: ${(om.totalDuration / 1_000_000_000).toFixed(3)}s`;
            }
            if (om.loadDuration) {
              md += `, Load: ${(om.loadDuration / 1_000_000).toFixed(2)}ms`;
            }
            if (om.promptEvalDuration) {
              md += `, Prompt Eval: ${(om.promptEvalDuration / 1_000_000).toFixed(2)}ms`;
            }
            if (om.evalDuration) {
              md += `, Eval: ${(om.evalDuration / 1_000_000_000).toFixed(3)}s`;
            }
            if (om.promptEvalRate || om.evalRate) {
              md += `\n  - **Throughput:**`;
              if (om.promptEvalRate) {
                md += ` Prompt: ${om.promptEvalRate.toFixed(2)} tokens/s`;
              }
              if (om.evalRate) {
                md += `, Generation: ${om.evalRate.toFixed(2)} tokens/s`;
              }
            }
          }

          md += `\n\n`;
          tokenUsageIndex++;
        }
      } else if (msg.role === 'tool') {
        // Determine the mode indicator
        let modeIndicator = '';
        if (msg.isIPCCall) {
          modeIndicator = ' *IPC Tool Call*';
        } else if (msg.orchestratorMode) {
          modeIndicator = ' *Orchestrator Mode*';
        }
        
        // Display timestamps for input and output separately
        const inputTime = msg.toolInputTime 
          ? new Date(msg.toolInputTime).toLocaleTimeString()
          : time;
        const outputTime = msg.toolOutputTime 
          ? new Date(msg.toolOutputTime).toLocaleTimeString()
          : time;
        
        md += `### Tool: ${msg.toolName}${modeIndicator}\n\n`;
        md += `**Input (${inputTime}):**\n\`\`\`json\n${JSON.stringify(msg.toolInput, null, 2)}\n\`\`\`\n\n`;
        
        // Try to parse output as JSON for consistent formatting
        const toolOutput = msg.toolOutput || '';
        let outputFormatted = toolOutput;
        let outputLang = '';
        try {
          // Strip ANSI color codes before parsing
          const cleanOutput = toolOutput.replace(/\u001b\[[0-9;]*m/g, '');
          const parsed = JSON.parse(cleanOutput);
          outputFormatted = JSON.stringify(parsed, null, 2);
          outputLang = 'json';
        } catch {
          // Not JSON, use as-is
          outputFormatted = toolOutput;
          outputLang = '';
        }
        
        md += `**Output (${outputTime}):**\n\`\`\`${outputLang ? ' ' + outputLang : ''}\n${outputFormatted}\n\`\`\`\n\n`;
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

        // Add Ollama metrics if available
        if (tokenUsage.ollamaMetrics) {
          const om = tokenUsage.ollamaMetrics;
          md += `\n  - **Ollama Metrics:**`;
          if (om.totalDuration) {
            md += ` Total: ${(om.totalDuration / 1_000_000_000).toFixed(3)}s`;
          }
          if (om.loadDuration) {
            md += `, Load: ${(om.loadDuration / 1_000_000).toFixed(2)}ms`;
          }
          if (om.promptEvalDuration) {
            md += `, Prompt Eval: ${(om.promptEvalDuration / 1_000_000).toFixed(2)}ms`;
          }
          if (om.evalDuration) {
            md += `, Eval: ${(om.evalDuration / 1_000_000_000).toFixed(3)}s`;
          }
          if (om.promptEvalRate || om.evalRate) {
            md += `\n  - **Throughput:**`;
            if (om.promptEvalRate) {
              md += ` Prompt: ${om.promptEvalRate.toFixed(2)} tokens/s`;
            }
            if (om.evalRate) {
              md += `, Generation: ${om.evalRate.toFixed(2)} tokens/s`;
            }
          }
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
        // TODO: Fix summary creation logic - re-enable summary search when summary is properly implemented
        // chat.summary?.includes(keyword) ||
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
    // TODO: Fix summary creation logic - re-enable summary when summary is properly implemented
    return this.generateMarkdownChat(chat); // metadata?.summary);
  }

  /**
   * Export chat to a folder with attachments and outputs
   * Works exactly like renameChat - moves the existing JSON and MD files to the folder
   * If the session is the current active session and hasn't been saved yet, saves it first
   * @param sessionId - The session ID to export
   * @param folderName - The name for the export folder
   * @param parentFolderName - Optional parent folder name
   * @param copyAttachments - If true, copy attachments; if false, move them; if null, skip (default: true)
   * @param copyOutputs - If true, copy outputs; if false, move them; if null, skip (default: false)
   * @returns true if successful, false otherwise
   */
  exportChat(
    sessionId: string,
    folderName: string,
    parentFolderName?: string,
    copyAttachments: boolean | null = true,
    copyOutputs: boolean | null = false
  ): boolean {
    // Check if session exists in index
    let metadata = this.index.get(sessionId);
    
    // If session not found, check if it's the current active session
    if (!metadata) {
      if (this.currentSession && this.currentSession.sessionId === sessionId) {
        // Save the current session first before exporting (without ending it)
        const savedMetadata = this.saveCurrentSession('Chat exported');
        if (!savedMetadata) {
          this.logger.log('Failed to save current session before export\n', { type: 'error' });
          return false;
        }
        metadata = savedMetadata;
        // Now the session is in the index, proceed with rename
      } else {
        // Session not found and not the current session
        this.logger.log(`Chat session not found: ${sessionId}\n`, {
          type: 'warning',
        });
        return false;
      }
    }
    
    // Export works exactly like rename - just move the files to a folder
    return this.renameChat(sessionId, folderName, parentFolderName, copyAttachments, copyOutputs);
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
   * Extract attachment file names from a chat session
   * @param chatFilePath - Path to the chat JSON file
   * @returns Array of unique attachment file names
   */
  private getAttachmentsFromChat(chatFilePath: string): string[] {
    if (!existsSync(chatFilePath)) {
      return [];
    }

    try {
      const chatContent = readFileSync(chatFilePath, 'utf-8');
      const chatSession: ChatSession = JSON.parse(chatContent);
      
      const attachmentFileNames = new Set<string>();
      
      // Extract attachment fileNames from all messages
      for (const message of chatSession.messages) {
        if (message.attachments && message.attachments.length > 0) {
          for (const attachment of message.attachments) {
            if (attachment.fileName) {
              attachmentFileNames.add(attachment.fileName);
            }
          }
        }
      }
      
      return Array.from(attachmentFileNames);
    } catch (error) {
      this.logger.log(`Failed to extract attachments from chat: ${error}\n`, {
        type: 'warning',
      });
      return [];
    }
  }

  /**
   * Move or copy attachments referenced in a chat to the chat's folder
   * @param chatFilePath - Path to the chat JSON file
   * @param targetDir - The target directory for the chat
   * @param copy - If true, copy attachments; if false, move them
   */
  private moveAttachmentsToChatFolder(chatFilePath: string, targetDir: string, copy: boolean | null = true): void {
    // If copy is null, skip moving attachments
    if (copy === null) {
      return;
    }
    
    const attachmentFileNames = this.getAttachmentsFromChat(chatFilePath);
    
    if (attachmentFileNames.length === 0) {
      return; // No attachments to move
    }

    // Create attachments subdirectory in the target folder
    const attachmentsSubdir = join(targetDir, 'attachments');
    if (!existsSync(attachmentsSubdir)) {
      mkdirSync(attachmentsSubdir, { recursive: true });
    }

    let movedCount = 0;
    for (const fileName of attachmentFileNames) {
      const sourcePath = join(ATTACHMENTS_DIR, fileName);
      const destPath = join(attachmentsSubdir, fileName);
      
      if (existsSync(sourcePath)) {
        try {
          // Check if destination already exists (might have been moved already)
          if (!existsSync(destPath)) {
            if (copy) {
              copyFileSync(sourcePath, destPath);
            } else {
              renameSync(sourcePath, destPath);
            }
            movedCount++;
          }
        } catch (error) {
          const action = copy ? 'copy' : 'move';
          this.logger.log(`Failed to ${action} attachment ${fileName}: ${error}\n`, {
            type: 'warning',
          });
        }
      }
    }

    if (movedCount > 0) {
      const action = copy ? 'Copied' : 'Moved';
      this.logger.log(`${action} ${movedCount} attachment(s) to chat folder\n`, {
        type: 'info',
      });
    }
  }

  /**
   * Move or copy outputs to the chat's folder
   * @param targetDir - The target directory for the chat
   * @param copy - If true, copy outputs; if false, move them; if null, skip
   */
  private moveOutputsToChatFolder(targetDir: string, copy: boolean | null = false): void {
    // If copy is null, skip moving outputs
    if (copy === null) {
      return;
    }
    
    if (!existsSync(OUTPUTS_DIR)) {
      return; // No outputs directory
    }

    try {
      const outputItems = readdirSync(OUTPUTS_DIR);
      
      if (outputItems.length === 0) {
        return; // No outputs to move
      }

      // First, collect items that need to be moved (files or directories with files)
      const itemsToMove: Array<{ sourcePath: string; destPath: string; isFile: boolean }> = [];
      
      for (const item of outputItems) {
        const sourcePath = join(OUTPUTS_DIR, item);
        
        try {
          const stats = statSync(sourcePath);
          
          if (stats.isFile()) {
            // File - always move
            itemsToMove.push({
              sourcePath,
              destPath: join(targetDir, 'outputs', item),
              isFile: true
            });
          } else if (stats.isDirectory()) {
            // Only include directory if it contains files
            if (directoryHasFiles(sourcePath)) {
              itemsToMove.push({
                sourcePath,
                destPath: join(targetDir, 'outputs', item),
                isFile: false
              });
            }
            // Skip empty directories
          }
        } catch (error) {
          // Skip items that can't be accessed
          continue;
        }
      }

      // Only create outputs subdirectory if there are items to move
      if (itemsToMove.length === 0) {
        return; // Nothing to move, don't create empty directory
      }

      // Create outputs subdirectory in the target folder
      const outputsSubdir = join(targetDir, 'outputs');
      if (!existsSync(outputsSubdir)) {
        mkdirSync(outputsSubdir, { recursive: true });
      }

      let movedCount = 0;
      for (const item of itemsToMove) {
        try {
          if (item.isFile) {
            // Move or copy file
            if (!existsSync(item.destPath)) {
              if (copy) {
                copyFileSync(item.sourcePath, item.destPath);
              } else {
                renameSync(item.sourcePath, item.destPath);
              }
              movedCount++;
            }
          } else {
            // Move or copy directory recursively
            if (!existsSync(item.destPath)) {
              if (copy) {
                copyDirectoryRecursive(item.sourcePath, item.destPath);
              } else {
                moveDirectoryRecursive(item.sourcePath, item.destPath);
              }
              movedCount++;
            }
          }
        } catch (error) {
          const action = copy ? 'copy' : 'move';
          this.logger.log(`Failed to ${action} output ${basename(item.sourcePath)}: ${error}\n`, {
            type: 'warning',
          });
        }
      }

      if (movedCount > 0) {
        const action = copy ? 'Copied' : 'Moved';
        this.logger.log(`${action} ${movedCount} output item(s) to chat folder\n`, {
          type: 'info',
        });
      }
    } catch (error) {
      this.logger.log(`Failed to move outputs: ${error}\n`, {
        type: 'warning',
      });
    }
  }

  /**
   * Calculate and create target directory for chat operations
   * @param folderName - The folder name
   * @param parentFolderName - Optional parent folder name
   * @returns The target directory path, or null if invalid
   */
  private getTargetDirectory(folderName: string, parentFolderName?: string): string | null {
    const sanitizedName = sanitizeFolderName(folderName);
    
    if (!sanitizedName) {
      this.logger.log('Invalid folder name provided\n', { type: 'error' });
      return null;
    }

    let targetDir: string;
    if (parentFolderName) {
      const sanitizedParentName = sanitizeFolderName(parentFolderName);
      
      if (!sanitizedParentName) {
        this.logger.log('Invalid parent folder name provided\n', { type: 'error' });
        return null;
      }
      
      // Create folder path: chats/{parentFolder}/{sanitizedName}/
      targetDir = join(CHATS_DIR, sanitizedParentName, sanitizedName);
    } else {
      // Create folder path: chats/{sanitizedName}/
      targetDir = join(CHATS_DIR, sanitizedName);
    }
    
    // Create folder if it doesn't exist
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    return targetDir;
  }

  /**
   * Rename chat session files
   * @param sessionId - The session ID to rename
   * @param newName - The new name for the chat (will be used as folder name)
   * @param folderName - Optional parent folder name to move the chat to (within chats directory)
   * @param copyAttachments - If true, copy attachments; if false, move them; if null, skip (default: true)
   * @param copyOutputs - If true, copy outputs; if false, move them; if null, skip (default: false)
   */
  renameChat(sessionId: string, newName: string, folderName?: string, copyAttachments: boolean | null = true, copyOutputs: boolean | null = false): boolean {
    const metadata = this.index.get(sessionId);
    if (!metadata) {
      this.logger.log(`Chat session not found: ${sessionId}\n`, {
        type: 'warning',
      });
      return false;
    }

    try {
      // Get target directory using shared helper
      const targetDir = this.getTargetDirectory(newName, folderName);
      if (!targetDir) {
        return false;
      }

      // Get original filenames (keep them as-is, just move to new folder)
      const oldJsonPath = metadata.filePath;
      const oldMdPath = metadata.mdFilePath;
      
      // Extract just the filename from the original path
      const jsonFileName = basename(oldJsonPath);
      const mdFileName = basename(oldMdPath);
      
      // New paths: move files to the new folder, keeping original filenames
      const newJsonPath = join(targetDir, jsonFileName);
      const newMdPath = join(targetDir, mdFileName);

      // Move attachments and outputs to the new folder (before moving chat files)
      // Use oldJsonPath since we haven't moved the file yet
      this.moveAttachmentsToChatFolder(oldJsonPath, targetDir, copyAttachments);
      this.moveOutputsToChatFolder(targetDir, copyOutputs);

      // Move files if they exist and paths are different
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
   * Set a display name for a chat session (stored in index metadata only)
   */
  setChatName(sessionId: string, name: string): boolean {
    const metadata = this.index.get(sessionId);
    if (!metadata) return false;

    metadata.name = name.trim() || undefined;
    this.saveIndex();
    return true;
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
    // Format: YYYYMMDD-HHMMSS-random (using local time)
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const date = `${year}${month}${day}`;
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const time = `${hours}${minutes}${seconds}`;
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