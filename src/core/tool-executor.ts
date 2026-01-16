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
}

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
        toolResult = await connection.client.request(
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
      } else {
        // Fallback: try to find the tool in any server (backward compatibility)
        let found = false;
        for (const [name, connection] of servers.entries()) {
          const tool = connection.tools.find(
            (t) => t.name === toolName || t.name.endsWith(`__${toolName}`),
          );
          if (tool) {
            const actualName = tool.name.includes('__')
              ? tool.name.split('__')[1]
              : tool.name;
            toolResult = await connection.client.request(
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
