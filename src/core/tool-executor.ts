/**
 * Tool execution for MCP Client.
 * Routes tool calls to appropriate MCP servers.
 */

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../logger.js';
import type { PreferencesManager } from '../managers/preferences-manager.js';
import type { HookManager } from '../managers/hook-manager.js';
import { formatToolCall, formatJSON } from '../utils/formatting.js';

/**
 * Content block types from MCP tool results.
 * Images are base64 encoded with mimeType.
 */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  data: string; // base64 encoded
  mimeType: string;
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

/**
 * Result from tool execution containing both display text and full content.
 */
export interface ToolExecutionResult {
  /** Text to display in CLI (images shown as placeholders) */
  displayText: string;
  /** Full content blocks including images for LLM */
  contentBlocks: ContentBlock[];
  /** Whether this result contains images */
  hasImages: boolean;
}

/**
 * Represents a connection to an MCP server.
 */
interface ServerConnection {
  name: string;
  client: {
    request: (
      request: { method: string; params: any },
      schema: any,
      options?: { timeout?: number }
    ) => Promise<any>;
  };
  tools: Array<{ name: string }>;
}

/**
 * Callbacks for MCPToolExecutor to interact with parent component.
 */
export interface MCPToolExecutorCallbacks {
  /** Get servers map */
  getServers: () => Map<string, ServerConnection>;
  /** Get preferences manager */
  getPreferencesManager: () => PreferencesManager | undefined;
  /**
   * Check if abort has been requested by the user.
   * The force stop timer only starts AFTER abort is requested.
   */
  isAbortRequested?: () => boolean;
  /**
   * Ask user if they want to force stop a long-running tool call.
   * Returns true if user wants to force stop, false to continue waiting.
   * If not provided, no force stop prompt will be shown.
   * @param toolName - Name of the tool that's running
   * @param elapsedSeconds - How long since abort was requested
   * @param abortSignal - Signal that fires when the tool completes (prompt should dismiss)
   */
  askForceStop?: (toolName: string, elapsedSeconds: number, abortSignal?: AbortSignal) => Promise<boolean>;
  /**
   * Request human-in-the-loop approval before executing a tool.
   * Returns 'execute' to proceed, or rejection with optional message.
   */
  requestToolApproval?: (toolName: string, toolInput: Record<string, any>) => Promise<'execute' | { decision: 'reject'; message?: string }>;
  /**
   * Kill and restart an MCP server to forcefully stop its running operations.
   * This kills the server process (and its child processes) then reconnects.
   * @param serverName - Name of the server to restart
   */
  killAndRestartServer?: (serverName: string) => Promise<void>;
  /** Get hook manager for client-side hooks (fires during regular chat) */
  getHookManager?: () => HookManager | undefined;
  /** Cancel any pending elicitation (auto-declines dangling prompts) */
  cancelPendingElicitation?: () => void;
}

/** Force stop timeout in seconds */
const FORCE_STOP_TIMEOUT_SECONDS = 15;

/**
 * Executes tools via MCP servers.
 */
export class MCPToolExecutor {
  private logger: Logger;
  private callbacks: MCPToolExecutorCallbacks;
  private forceStopPromptActive: boolean = false; // Mutex to prevent multiple concurrent prompts

  constructor(logger: Logger, callbacks: MCPToolExecutorCallbacks) {
    this.logger = logger;
    this.callbacks = callbacks;
  }

  /**
   * Wraps a promise with a force stop timeout mechanism.
   * The timer only starts AFTER the user presses abort.
   * After FORCE_STOP_TIMEOUT_SECONDS from abort, prompts the user if they want to force stop.
   * If user approves, rejects the promise. Otherwise, continues waiting.
   *
   * @param toolName - Name of the tool for error messages
   * @param toolPromise - The promise to wrap
   * @param autoStopOnAbort - If true, automatically stop when abort is detected (no prompt).
   *                          Used for IPC child tools where the parent orchestrator handles prompting.
   */
  private async withForceStopPrompt<T>(
    toolName: string,
    toolPromise: Promise<T>,
    autoStopOnAbort: boolean = false,
  ): Promise<T> {
    const askForceStop = this.callbacks.askForceStop;
    const isAbortRequested = this.callbacks.isAbortRequested;
    if (!askForceStop || !isAbortRequested) {
      // No callbacks provided, just return the original promise
      return toolPromise;
    }

    return new Promise<T>((resolve, reject) => {
      let isCompleted = false;
      let abortDetected = false;
      let elapsedSecondsAfterAbort = 0;

      // AbortController to signal the prompt to dismiss when tool completes
      const promptAbortController = new AbortController();

      // Handle tool completion
      toolPromise
        .then((result) => {
          if (!isCompleted) {
            isCompleted = true;
            promptAbortController.abort(); // Dismiss any active prompt
            resolve(result);
          }
        })
        .catch((error) => {
          if (!isCompleted) {
            isCompleted = true;
            promptAbortController.abort(); // Dismiss any active prompt
            reject(error);
          }
        });

      // Poll for abort being requested, then start the force stop timer
      const pollInterval = 500; // Check every 500ms for abort

      const checkAbortAndTimeout = async () => {
        if (isCompleted) return;

        // Check if abort was requested
        if (!abortDetected && isAbortRequested()) {
          abortDetected = true;
          elapsedSecondsAfterAbort = 0;
          // Abort detected, now start the countdown
        }

        if (abortDetected) {
          elapsedSecondsAfterAbort += pollInterval / 1000;

          // For IPC child tools: auto-stop immediately when abort is detected
          // and the parent orchestrator's force-stop prompt has been answered (mutex released)
          // This ensures child tools stop when the user force-stops the orchestrator
          if (autoStopOnAbort && elapsedSecondsAfterAbort >= FORCE_STOP_TIMEOUT_SECONDS) {
            // Wait for any active prompt (the orchestrator's) to complete
            if (this.forceStopPromptActive) {
              setTimeout(checkAbortAndTimeout, pollInterval);
              return;
            }
            // Auto-stop without prompting - parent orchestrator was force-stopped
            if (!isCompleted) {
              isCompleted = true;
              reject(new Error(`Tool "${toolName}" stopped - parent operation was cancelled`));
              return;
            }
          }

          // For regular tools: show prompt after timeout
          if (!autoStopOnAbort && elapsedSecondsAfterAbort >= FORCE_STOP_TIMEOUT_SECONDS) {
            // Skip if another prompt is already showing (mutex)
            if (this.forceStopPromptActive) {
              // Don't reset timer, just wait for the other prompt to finish
              setTimeout(checkAbortAndTimeout, pollInterval);
              return;
            }

            try {
              this.forceStopPromptActive = true;
              const shouldForceStop = await askForceStop(toolName, Math.floor(elapsedSecondsAfterAbort), promptAbortController.signal);
              this.forceStopPromptActive = false;

              if (shouldForceStop && !isCompleted) {
                isCompleted = true;

                // Kill and restart the server to forcefully stop its running operations
                // Extract server name from tool name (format: "server-name__tool-name")
                const serverName = toolName.includes('__') ? toolName.split('__')[0] : null;
                if (serverName && this.callbacks.killAndRestartServer) {
                  this.logger.log(`\n⚠️ Killing and restarting "${serverName}" server to stop operation...\n`, { type: 'warning' });
                  try {
                    await this.callbacks.killAndRestartServer(serverName);
                    this.logger.log(`✓ Server "${serverName}" restarted successfully\n`, { type: 'info' });
                  } catch (restartError) {
                    this.logger.log(`⚠️ Failed to restart server: ${restartError}\n`, { type: 'error' });
                  }
                }

                reject(new Error(`Tool "${toolName}" force stopped by user after ${Math.floor(elapsedSecondsAfterAbort)} seconds`));
                return;
              } else if (!isCompleted) {
                // User chose to continue waiting, reset the timer
                elapsedSecondsAfterAbort = 0;
              }
            } catch (promptError) {
              this.forceStopPromptActive = false;
              // If prompting fails, reset the timer and continue
              if (!isCompleted) {
                elapsedSecondsAfterAbort = 0;
              }
            }
          }
        }

        // Continue polling
        if (!isCompleted) {
          setTimeout(checkAbortAndTimeout, pollInterval);
        }
      };

      // Start polling for abort
      setTimeout(checkAbortAndTimeout, pollInterval);
    });
  }

  /**
   * Execute a tool via MCP servers.
   * This is the callback that the provider calls when the LLM wants to use a tool.
   *
   * @param toolName - The prefixed tool name (server-name__tool-name)
   * @param toolInput - The arguments to pass to the tool
   * @param fromIPC - Whether this call came from IPC (skip logging if true)
   * @returns The tool result with display text and full content blocks
   */
  async executeMCPTool(
    toolName: string,
    toolInput: Record<string, any>,
    fromIPC: boolean = false,
  ): Promise<ToolExecutionResult> {
    // Check if abort was requested before executing tool
    // This prevents tool execution after shutdown has started
    if (this.callbacks.isAbortRequested?.()) {
      return {
        displayText: '[Tool execution cancelled - abort requested]',
        contentBlocks: [{ type: 'text', text: '[Tool execution cancelled - abort requested]' }],
        hasImages: false,
      };
    }

    const servers = this.callbacks.getServers();
    const preferencesManager = this.callbacks.getPreferencesManager();

    // Check if session is still active (servers not empty)
    if (!servers || servers.size === 0) {
      return {
        displayText: '[Tool execution failed - no active session]',
        contentBlocks: [{ type: 'text', text: '[Tool execution failed - no active session]' }],
        hasImages: false,
      };
    }

    // Extract server name and actual tool name from prefixed name
    // Format: "server-name__tool-name"
    const [serverName, actualToolName] = toolName.includes('__')
      ? toolName.split('__', 2)
      : [null, toolName];

    // Log the tool call BEFORE execution (skip if called from IPC - already logged by IPC listener)
    if (!fromIPC) {
      this.logger.log(formatToolCall(toolName, toolInput) + '\n');
    }

    // Human-in-the-loop approval check
    if (!fromIPC && this.callbacks.requestToolApproval) {
      const decision = await this.callbacks.requestToolApproval(toolName, toolInput);
      if (decision !== 'execute') {
        // Tool was rejected
        const baseMessage = 'Tool call rejected by user';
        const fullMessage = decision.message
          ? `${baseMessage}: ${decision.message}`
          : baseMessage;
        return {
          displayText: `[${fullMessage}]`,
          contentBlocks: [{ type: 'text', text: `[${fullMessage}]` }],
          hasImages: false,
        };
      }
    }

    // Execute before-hooks (client-side hooks that fire before tool execution)
    const hookManager = this.callbacks.getHookManager?.();
    if (hookManager && !hookManager.isExecuting()) {
      await hookManager.executeBeforeHooks(toolName, (name, args) =>
        this.executeMCPTool(name, args, true),
      );
    }

    let toolResult;

    try {
      if (serverName && servers.has(serverName)) {
        // Route to the specific server
        const connection = servers.get(serverName)!;
        const toolPromise = connection.client.request(
          {
            method: 'tools/call',
            params: {
              name: actualToolName,
              arguments: toolInput,
            },
          },
          CallToolResultSchema,
          {
            // Use preference timeout (convert seconds to milliseconds)
            // -1 means unlimited, use a very large value (1 hour) instead of undefined
            // to ensure long-running tools don't timeout unexpectedly
            timeout: (() => {
              const timeoutSeconds = preferencesManager?.getMCPTimeout() ?? 60;
              return timeoutSeconds === -1 ? 3600000 : timeoutSeconds * 1000;
            })(),
          },
        );
        // Wrap with force stop prompt (asks user after timeout if they want to abort)
        // Always ask for user approval before stopping - even for IPC calls
        toolResult = await this.withForceStopPrompt(toolName, toolPromise, false);
      } else {
        // Fallback: try to find the tool in any server (backward compatibility)
        let found = false;
        for (const [, connection] of servers.entries()) {
          const tool = connection.tools.find(
            (t) => t.name === toolName || t.name.endsWith(`__${toolName}`),
          );
          if (tool) {
            const actualName = tool.name.includes('__')
              ? tool.name.split('__')[1]
              : tool.name;
            const toolPromise = connection.client.request(
              {
                method: 'tools/call',
                params: {
                  name: actualName,
                  arguments: toolInput,
                },
              },
              CallToolResultSchema,
              {
                // Use preference timeout (convert seconds to milliseconds)
                // -1 means unlimited, use a very large value (1 hour) instead of undefined
                // to ensure long-running tools don't timeout unexpectedly
                timeout: (() => {
                  const timeoutSeconds = preferencesManager?.getMCPTimeout() ?? 60;
                  return timeoutSeconds === -1 ? 3600000 : timeoutSeconds * 1000;
                })(),
              },
            );
            // Wrap with force stop prompt (asks user after timeout if they want to abort)
            // Always ask for user approval before stopping - even for IPC calls
            toolResult = await this.withForceStopPrompt(toolName, toolPromise, false);
            found = true;
            break;
          }
        }
        if (!found || !toolResult) {
          throw new Error(`Tool "${toolName}" not found in any server`);
        }
      }

      // Extract all content blocks from MCP response (text and images)
      const contentBlocks: ContentBlock[] = [];
      const displayParts: string[] = [];
      let hasImages = false;

      for (const block of toolResult.content) {
        if (block.type === 'text') {
          contentBlocks.push({ type: 'text', text: block.text });
          displayParts.push(block.text);
        } else if (block.type === 'image') {
          hasImages = true;
          // Preserve full image data for LLM
          contentBlocks.push({
            type: 'image',
            data: block.data,
            mimeType: block.mimeType || 'image/jpeg',
          });
          // Show placeholder in CLI instead of base64
          displayParts.push(`[Image: ${block.mimeType || 'image/jpeg'}]`);
        }
      }

      // Build display text for CLI
      const textContent = displayParts.join('\n');
      let displayText: string;
      try {
        const parsed = JSON.parse(textContent);
        displayText = formatJSON(JSON.stringify(parsed));
      } catch {
        displayText = formatJSON(JSON.stringify([textContent]));
      }

      const result: ToolExecutionResult = { displayText, contentBlocks, hasImages };

      // Execute immediate after-hooks inline (@tool-exec: and special commands)
      const hookMgr = this.callbacks.getHookManager?.();
      if (hookMgr && !hookMgr.isExecuting()) {
        await hookMgr.executeImmediateAfterHooks(
          toolName,
          { ...result, toolInput },
          (name, args) => this.executeMCPTool(name, args, true),
        );
      }

      return result;
    } catch (toolError) {
      // Check if this is a force stop error (user aborted) - handle first before logging
      const isForceStop =
        toolError instanceof Error &&
        toolError.message.includes('force stopped by user');

      if (isForceStop) {
        // Cancel any pending elicitation from this tool before stopping
        this.callbacks.cancelPendingElicitation?.();
        // For force stop, throw an error to stop the agent completely
        // This gives control back to the user instead of letting the agent continue
        const forceStopMessage = `Tool execution was force stopped by the user. The tool "${toolName}" was taking too long and the user chose to abort.`;
        throw new Error(forceStopMessage);
      }

      const errorMessage = `Error executing tool "${toolName}": ${
        toolError instanceof Error ? toolError.message : String(toolError)
      }`;

      this.logger.log(`\n⚠️ ${errorMessage}\n`, { type: 'error' });

      // Check if this is a timeout error
      const isTimeout =
        toolError instanceof Error &&
        (toolError.message.includes('timeout') ||
          toolError.message.includes('timed out') ||
          toolError.message.includes('ETIMEDOUT'));

      if (isTimeout) {
        // Cancel any pending elicitation that was waiting for user input
        this.callbacks.cancelPendingElicitation?.();
        // For timeout errors, return an error message to the agent instead of throwing
        // This allows the agent to see partial results and handle the error gracefully
        const timeoutMessage = `Tool execution timed out. The tool "${toolName}" did not complete within the configured timeout period. Previous tool results are still available. You can try again with different parameters or continue with other tasks.`;
        this.logger.log(
          `\n⚠️ Returning timeout error to agent (context preserved)\n`,
          { type: 'warning' },
        );
        const errorText = JSON.stringify({
          error: 'timeout',
          message: timeoutMessage,
          details: errorMessage,
        });
        return {
          displayText: formatJSON(errorText),
          contentBlocks: [{ type: 'text', text: errorText }],
          hasImages: false,
        };
      }

      // For other errors, throw to maintain existing behavior
      throw new Error(errorMessage);
    }
  }
}
