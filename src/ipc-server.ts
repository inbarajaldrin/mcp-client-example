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
  private ipcCallCount: number = 0;
  private maxIpcCalls: number = 100;
  private onIpcLimitReached?: (count: number, max: number) => Promise<number | null>;

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
      res.json({ status: 'ok', ipcCallCount: this.ipcCallCount, maxIpcCalls: this.maxIpcCalls, timestamp: new Date().toISOString() });
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

      // Enforce tool-states.yaml: reject calls to blocked tools
      const toolManager = this.client.getToolManager();
      if (!toolManager.isToolEnabled(prefixedToolName)) {
        return res.status(403).json({
          success: false,
          error: `Tool "${prefixedToolName}" is disabled by tool-states policy`,
          blocked: true
        });
      }

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

        // Check IPC call limit
        if (this.ipcCallCount >= this.maxIpcCalls) {
          if (this.onIpcLimitReached) {
            const newLimit = await this.onIpcLimitReached(this.ipcCallCount, this.maxIpcCalls);
            if (newLimit !== null) {
              this.maxIpcCalls = newLimit;
            } else {
              return res.status(429).json({
                success: false,
                error: `Exhausted available IPC call limit (${this.ipcCallCount}/${this.maxIpcCalls}). No further IPC tool calls allowed this session.`,
                exhausted: true,
              });
            }
          } else {
            return res.status(429).json({
              success: false,
              error: `Exhausted available IPC call limit (${this.ipcCallCount}/${this.maxIpcCalls}). No further IPC tool calls allowed this session.`,
              exhausted: true,
            });
          }
        }

        this.ipcCallCount++;

        // Emit event before executing the tool
        this.emit('toolCallStart', {
          toolName: prefixedToolName,
          args: args,
        } as IPCToolCallEvent);

        // Route to the executeMCPTool method (same as what the LLM uses)
        // The tool name format is "server-name__tool-name"
        // Pass fromIPC=true to skip duplicate logging (IPC listener already logs this)
        const toolResult = await this.client.executeMCPTool(
          prefixedToolName,
          args,
          true  // fromIPC
        );

        // Extract displayText from the ToolExecutionResult and parse if JSON
        let parsedResult: any = toolResult.displayText;
        try {
          // Strip ANSI color codes before parsing (formatJSON adds these)
          // Pattern matches: \x1b[...m or \u001b[...m (e.g., \x1b[34m for blue)
          const cleanedResult = toolResult.displayText
            .replace(/\x1b\[[0-9;]*m/g, '')
            .replace(/\u001b\[[0-9;]*m/g, '');
          parsedResult = JSON.parse(cleanedResult);
        } catch {
          // Not valid JSON, keep as string
          parsedResult = toolResult.displayText;
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

    // Tool discovery endpoint - returns enabled tools from all servers.
    // Filters through tool-states.yaml so the orchestrator's unified_api
    // only generates callable functions for tools the user has enabled.
    this.app.get('/list_tools', async (req: Request, res: Response) => {
      try {
        const servers: Map<string, any> = (this.client as any).servers || new Map();
        const toolManager = this.client.getToolManager();
        const toolsByServer: Record<string, any[]> = {};
        let totalTools = 0;

        for (const [serverName, connection] of servers.entries()) {
          const serverTools = (connection as any).tools || [];
          if (serverTools.length === 0) continue;

          // Filter to only enabled tools per tool-states.yaml
          const enabledTools = serverTools
            .filter((tool: any) => toolManager.isToolEnabled(tool.name))
            .map((tool: any) => {
              const toolName = tool.name.replace(`${serverName}__`, '');
              return {
                name: toolName,
                description: tool.description,
                input_schema: tool.input_schema,
              };
            });

          if (enabledTools.length > 0) {
            toolsByServer[serverName] = enabledTools;
            totalTools += enabledTools.length;
          }
        }

        res.json({
          success: true,
          servers: toolsByServer,
          total_servers: Object.keys(toolsByServer).length,
          total_tools: totalTools,
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

  setMaxIpcCalls(max: number): void {
    this.maxIpcCalls = max;
  }

  getIpcCallCount(): number {
    return this.ipcCallCount;
  }

  resetIpcCallCount(): void {
    this.ipcCallCount = 0;
  }

  setOnIpcLimitReached(cb: ((count: number, max: number) => Promise<number | null>) | undefined): void {
    this.onIpcLimitReached = cb;
  }
}
