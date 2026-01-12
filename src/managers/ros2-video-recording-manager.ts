import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_FILE = join(__dirname, '../..', 'mcp_config.json');

interface ServerConfig {
  command: string;
  args: string[];
  disabled?: boolean;
  timeout?: number;
  type?: string;
  env?: Record<string, string>;
}

interface MCPConfig {
  mcpServers: Record<string, ServerConfig>;
}

type ServerConnection = {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: any[];
  prompts: any[];
};

/**
 * ROS2VideoRecordingManager
 *
 * Manages video recording state for the ROS2 video recorder MCP server.
 * Ensures that recordings are stopped gracefully when the session ends
 * to prevent orphaned recording processes.
 */
export class ROS2VideoRecordingManager {
  private serverConfig: StdioServerParameters | null = null;
  private serverConnection: ServerConnection | null = null;
  private isConfigDisabled: boolean = false;
  private logger: Logger;
  private serverName: string = 'ros2-video-recorder';
  private isRecording: boolean = false;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger({ mode: 'verbose' });
    this.loadConfig();
  }

  /**
   * Load server configuration from mcp_config.json
   */
  loadConfig(): void {
    try {
      if (!existsSync(CONFIG_FILE)) {
        this.serverConfig = null;
        return;
      }

      const content = readFileSync(CONFIG_FILE, 'utf-8');
      const config: MCPConfig = JSON.parse(content);

      if (config.mcpServers && config.mcpServers[this.serverName]) {
        const serverConfig = config.mcpServers[this.serverName];

        this.isConfigDisabled = serverConfig.disabled || false;

        this.serverConfig = {
          command: serverConfig.command,
          args: serverConfig.args || [],
          env: serverConfig.env,
        };
      } else {
        this.serverConfig = null;
        this.isConfigDisabled = false;
      }
    } catch (error) {
      this.logger.log(
        `Failed to load ros2-video-recorder config: ${error}\n`,
        { type: 'warning' },
      );
      this.serverConfig = null;
    }
  }

  /**
   * Check if server is configured
   */
  isConfigured(): boolean {
    return this.serverConfig !== null;
  }

  /**
   * Get the server name
   */
  getServerName(): string {
    return this.serverName;
  }

  /**
   * Get the server connection
   */
  getConnection(): ServerConnection | null {
    return this.serverConnection;
  }

  /**
   * Set the server connection (used when server is already connected via MCPClient)
   */
  setConnection(connection: ServerConnection): void {
    this.serverConnection = connection;
  }

  /**
   * Mark recording as started
   */
  setRecordingStarted(): void {
    this.isRecording = true;
  }

  /**
   * Mark recording as stopped
   */
  setRecordingStopped(): void {
    this.isRecording = false;
  }

  /**
   * Check if we believe recording is in progress
   * Note: This is a local state tracker, use checkRecordingStatus() for actual server status
   */
  isRecordingInProgress(): boolean {
    return this.isRecording;
  }

  /**
   * Check recording status from the server
   */
  async checkRecordingStatus(): Promise<{ isRecording: boolean; statusText: string }> {
    if (!this.serverConnection) {
      return { isRecording: false, statusText: 'No server connection' };
    }

    try {
      const result = await this.serverConnection.client.request(
        {
          method: 'tools/call',
          params: {
            name: 'get_recording_status',
            arguments: {},
          },
        },
        CallToolResultSchema,
      );

      const content = result.content[0];
      if (content && content.type === 'text') {
        const statusText = content.text;
        // Check if status indicates active recording
        const isRecording = statusText.toLowerCase().includes('recording') &&
                           !statusText.toLowerCase().includes('no active') &&
                           !statusText.toLowerCase().includes('not recording');

        // Update local state
        this.isRecording = isRecording;

        return { isRecording, statusText };
      }

      return { isRecording: false, statusText: 'Unable to parse status' };
    } catch (error) {
      this.logger.log(
        `Failed to check recording status: ${error}\n`,
        { type: 'warning' },
      );
      return { isRecording: false, statusText: `Error: ${error}` };
    }
  }

  /**
   * Stop all active recordings
   * This is called during cleanup to ensure recordings are stopped gracefully
   */
  async stopAllRecordings(): Promise<string> {
    if (!this.serverConnection) {
      return 'No server connection';
    }

    try {
      // First check if there's actually anything recording
      const status = await this.checkRecordingStatus();
      if (!status.isRecording) {
        this.isRecording = false;
        return 'No active recordings to stop';
      }

      this.logger.log('Stopping active video recording(s)...\n', { type: 'info' });

      const result = await this.serverConnection.client.request(
        {
          method: 'tools/call',
          params: {
            name: 'stop_recording',
            arguments: {}, // No camera_topic means stop all
          },
        },
        CallToolResultSchema,
      );

      this.isRecording = false;

      const content = result.content[0];
      if (content && content.type === 'text') {
        this.logger.log(`✓ Video recording stopped: ${content.text}\n`, { type: 'info' });
        return content.text;
      }

      return 'Recording stopped';
    } catch (error) {
      this.logger.log(
        `Failed to stop recording: ${error}\n`,
        { type: 'warning' },
      );
      return `Error stopping recording: ${error}`;
    }
  }

  /**
   * Cleanup method - stops any active recordings
   * Called during session end/shutdown
   */
  async cleanup(): Promise<void> {
    if (!this.serverConnection) {
      return;
    }

    try {
      // Check and stop any active recordings
      const status = await this.checkRecordingStatus();
      if (status.isRecording) {
        await this.stopAllRecordings();
      }
    } catch (error) {
      // Ignore errors during cleanup - the server might already be gone
      this.logger.log(
        `Error during video recording cleanup (may be expected): ${error}\n`,
        { type: 'warning' },
      );
    }

    this.serverConnection = null;
    this.isRecording = false;
  }
}
