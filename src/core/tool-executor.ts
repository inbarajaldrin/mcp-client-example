/**
 * Tool execution for MCP Client.
 * Routes tool calls to appropriate MCP servers.
 */

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../logger.js';
import type { PreferencesManager } from '../managers/preferences-manager.js';
import { formatToolCall, formatJSON } from '../utils/formatting.js';

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
   */
  askForceStop?: (toolName: string, elapsedSeconds: number) => Promise<boolean>;
}

/** Force stop timeout in seconds */
const FORCE_STOP_TIMEOUT_SECONDS = 10;

/**
 * Executes tools via MCP servers.
 */
export class MCPToolExecutor {
  private logger: Logger;
  private callbacks: MCPToolExecutorCallbacks;

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

      // Handle tool completion
      toolPromise
        .then((result) => {
          if (!isCompleted) {
            isCompleted = true;
            resolve(result);
          }
        })
        .catch((error) => {
          if (!isCompleted) {
            isCompleted = true;
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
            try {
              const shouldForceStop = await askForceStop(toolName, Math.floor(elapsedSecondsAfterAbort));
              if (shouldForceStop && !isCompleted) {
                isCompleted = true;
                reject(new Error(`Tool "${toolName}" force stopped by user after ${Math.floor(elapsedSecondsAfterAbort)} seconds`));
                return;
              } else if (!isCompleted) {
                // User chose to continue waiting, reset the timer
                elapsedSecondsAfterAbort = 0;
              }
            } catch (promptError) {
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
   * @returns The tool result as a formatted string
   */
  async executeMCPTool(
    toolName: string,
    toolInput: Record<string, any>,
    fromIPC: boolean = false,
  ): Promise<string> {
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

      // Extract text content from MCP response
      const textContent = toolResult.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('');

      // Try to parse if it's JSON, otherwise return as-is
      try {
        const parsed = JSON.parse(textContent);
        return formatJSON(JSON.stringify(parsed));
      } catch {
        // Not JSON, return formatted text
        return formatJSON(JSON.stringify([textContent]));
      }
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
        return formatJSON(
          JSON.stringify([
            {
              error: 'force_stopped',
              message: forceStopMessage,
              details: errorMessage,
            },
          ]),
        );
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
        return formatJSON(
          JSON.stringify([
            {
              error: 'timeout',
              message: timeoutMessage,
              details: errorMessage,
            },
          ]),
        );
      }

      // For other errors, throw to maintain existing behavior
      throw new Error(errorMessage);
    }
  }
}
