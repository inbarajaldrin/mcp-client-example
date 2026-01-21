/**
 * Tool execution for MCP Client.
 * Routes tool calls to appropriate MCP servers.
 */

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../logger.js';
import type { PreferencesManager } from '../managers/preferences-manager.js';
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
}

/** Force stop timeout in seconds */
const FORCE_STOP_TIMEOUT_SECONDS = 10;

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
   */
  private async withForceStopPrompt<T>(
    toolName: string,
    toolPromise: Promise<T>,
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

          // Check if we've waited long enough after abort
          if (elapsedSecondsAfterAbort >= FORCE_STOP_TIMEOUT_SECONDS) {
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
    const servers = this.callbacks.getServers();
    const preferencesManager = this.callbacks.getPreferencesManager();

    // Extract server name and actual tool name from prefixed name
    // Format: "server-name__tool-name"
    const [serverName, actualToolName] = toolName.includes('__')
      ? toolName.split('__', 2)
      : [null, toolName];

    // Log the tool call BEFORE execution (skip if called from IPC - already logged by IPC listener)
    if (!fromIPC) {
      this.logger.log(formatToolCall(toolName, toolInput) + '\n');
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
        // Wrap with force stop prompt (asks user after 30 seconds if they want to abort)
        toolResult = await this.withForceStopPrompt(toolName, toolPromise);
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
            // Wrap with force stop prompt (asks user after 30 seconds if they want to abort)
            toolResult = await this.withForceStopPrompt(toolName, toolPromise);
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

      return {
        displayText,
        contentBlocks,
        hasImages,
      };
    } catch (toolError) {
      const errorMessage = `Error executing tool "${toolName}": ${
        toolError instanceof Error ? toolError.message : String(toolError)
      }`;

      this.logger.log(`\n⚠️ ${errorMessage}\n`, { type: 'error' });

      // Check if this is a force stop error (user aborted)
      const isForceStop =
        toolError instanceof Error &&
        toolError.message.includes('force stopped by user');

      if (isForceStop) {
        // For force stop, return an error message to the agent instead of throwing
        // This allows the agent to continue with other tasks
        const forceStopMessage = `Tool execution was force stopped by the user. The tool "${toolName}" was taking too long and the user chose to abort. You should continue with other tasks or try a different approach.`;
        this.logger.log(
          `\nReturning force stop error to agent (context preserved)\n`,
          { type: 'warning' },
        );
        const errorText = JSON.stringify({
          error: 'force_stopped',
          message: forceStopMessage,
          details: errorMessage,
        });
        return {
          displayText: formatJSON(errorText),
          contentBlocks: [{ type: 'text', text: errorText }],
          hasImages: false,
        };
      }

      // Check if this is a timeout error
      const isTimeout =
        toolError instanceof Error &&
        (toolError.message.includes('timeout') ||
          toolError.message.includes('timed out') ||
          toolError.message.includes('ETIMEDOUT'));

      if (isTimeout) {
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
