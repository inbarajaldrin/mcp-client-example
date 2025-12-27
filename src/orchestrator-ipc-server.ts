/**
 * Orchestrator IPC Server - Enables mcp-tools-orchestrator to route tool calls through client connections
 *
 * This HTTP server exposes the client's MCP server connections to mcp-tools-orchestrator,
 * avoiding duplicate server processes. mcp-tools-orchestrator calls tools via this IPC
 * instead of creating its own connections.
 */

import express, { Request, Response } from 'express';
import { Server } from 'http';
import { EventEmitter } from 'events';
import { MCPClient } from './index.js';
import { Logger } from './logger.js';

export interface IPCToolCallEvent {
  toolName: string;
  args: Record<string, any>;
  result?: any;
  error?: string;
}

export class OrchestratorIPCServer extends EventEmitter {
  private app: express.Application;
  private server: Server | null = null;
  private port: number = 0;
  private client: MCPClient;
  private logger: Logger;
  private aborted: boolean = false;

  constructor(client: MCPClient, logger: Logger) {
    super();
    this.client = client;
    this.logger = logger;
    this.app = express();
    this.app.use(express.json({ limit: '50mb' })); // Allow large payloads for code execution

    this.setupRoutes();
  }

  private setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Tool routing endpoint - called by mcp-tools-orchestrator's unified_api.py
    this.app.post('/call_tool', async (req: Request, res: Response) => {
      // Check if aborted before processing
      if (this.aborted) {
        // Return clear abort message
        // The client-side code will add context explaining these are aborts, not failures
        return res.status(500).json({
          success: false,
          error: '[ABORTED] User cancelled operation',
          status: 'aborted',
          aborted: true
        });
      }

      const { server, tool, arguments: toolArgs } = req.body;

      if (!server || !tool) {
        return res.status(400).json({
          error: 'Missing required fields: server, tool'
        });
      }

      const prefixedToolName = `${server}__${tool}`;
      const args = toolArgs || {};

      try {
        // Check again before emitting (abort could happen between checks)
        if (this.aborted) {
          return res.status(500).json({
            success: false,
            error: '[ABORTED] User cancelled operation',
            status: 'aborted',
            aborted: true
          });
        }

        // Emit event before executing the tool
        this.emit('toolCallStart', {
          toolName: prefixedToolName,
          args: args,
        } as IPCToolCallEvent);

        // Route to the executeMCPTool method (same as what the LLM uses)
        // The tool name format is "server-name__tool-name"
        // Pass fromIPC=true to skip duplicate logging (IPC listener already logs this)
        const result = await (this.client as any).executeMCPTool(
          prefixedToolName,
          args,
          true  // fromIPC
        );

        // Parse result if it's a JSON string (for mcp-tools-orchestrator to get proper objects)
        let parsedResult = result;
        if (typeof result === 'string') {
          try {
            // Strip ANSI color codes before parsing (formatJSON adds these)
            // Pattern matches: \x1b[...m or \u001b[...m (e.g., \x1b[34m for blue)
            const cleanedResult = result
              .replace(/\x1b\[[0-9;]*m/g, '')
              .replace(/\u001b\[[0-9;]*m/g, '');
            parsedResult = JSON.parse(cleanedResult);
          } catch {
            // Not valid JSON, keep as string
            parsedResult = result;
          }
        }

        // Emit event after successful execution
        this.emit('toolCallEnd', {
          toolName: prefixedToolName,
          args: args,
          result: parsedResult,
        } as IPCToolCallEvent);

        res.json({
          success: true,
          result: parsedResult
        });
      } catch (error) {
        this.logger.log(
          `IPC tool call failed (${prefixedToolName}): ${error}\n`,
          { type: 'error' }
        );

        // Emit event for failed execution
        this.emit('toolCallEnd', {
          toolName: prefixedToolName,
          args: args,
          error: error instanceof Error ? error.message : String(error),
        } as IPCToolCallEvent);

        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    // Tool discovery endpoint - returns all available tools from all servers
    this.app.get('/list_tools', async (req: Request, res: Response) => {
      try {
        // Get tools from client's tool manager
        const tools = (this.client as any).tools || [];

        // Group by server
        const toolsByServer: Record<string, any[]> = {};
        for (const tool of tools) {
          // Extract server name from prefixed tool name (format: "server__tool")
          const match = tool.name.match(/^(.+?)__(.+)$/);
          if (match) {
            const [, serverName, toolName] = match;
            if (!toolsByServer[serverName]) {
              toolsByServer[serverName] = [];
            }
            toolsByServer[serverName].push({
              name: toolName,
              description: tool.description,
              input_schema: tool.input_schema,
            });
          }
        }

        res.json({
          success: true,
          servers: toolsByServer,
          total_servers: Object.keys(toolsByServer).length,
          total_tools: tools.length,
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * Start the IPC server on a random available port
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      // Use port 0 to get a random available port
      this.server = this.app.listen(0, 'localhost', () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          this.logger.log(
            `Orchestrator IPC server listening on http://localhost:${this.port}\n`,
            { type: 'info' }
          );
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Stop the IPC server
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((error) => {
          if (error) {
            reject(error);
          } else {
            this.logger.log('Orchestrator IPC server stopped\n', { type: 'info' });
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the IPC server URL
   */
  getUrl(): string {
    return `http://localhost:${this.port}`;
  }

  /**
   * Get the IPC server port
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Set abort flag to stop processing IPC tool calls
   */
  setAborted(aborted: boolean): void {
    this.aborted = aborted;
    if (aborted) {
      this.logger.log('IPC server marked as aborted - will reject new tool calls\n', { type: 'warning' });
    }
  }

  /**
   * Check if server is aborted
   */
  isAborted(): boolean {
    return this.aborted;
  }
}
