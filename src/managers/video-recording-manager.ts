import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../logger.js';

type ServerConnection = {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: any[];
  prompts: any[];
};

/**
 * Recording-capable server names.
 * Each server must expose: get_recording_status, stop_recording
 */
const RECORDING_SERVERS = ['ros2-video-recorder', 'isaac-sim'];

/**
 * VideoRecordingManager
 *
 * Manages video recording state across multiple MCP servers that support
 * recording (get_recording_status / stop_recording tool interface).
 * Ensures that recordings are stopped gracefully when phases end or the
 * session shuts down, preventing orphaned recording processes.
 */
export class VideoRecordingManager {
  private logger: Logger;
  private serverConnections: Map<string, ServerConnection> = new Map();
  private recordingState: Map<string, boolean> = new Map();

  constructor(logger?: Logger) {
    this.logger = logger || new Logger({ mode: 'verbose' });
  }

  /**
   * Get the list of recording-capable server names
   */
  getServerNames(): string[] {
    return RECORDING_SERVERS;
  }

  /**
   * Set the server connection for a recording-capable server
   */
  setConnection(serverName: string, connection: ServerConnection): void {
    this.serverConnections.set(serverName, connection);
  }

  /**
   * Mark recording as started on a specific server
   */
  setRecordingStarted(serverName?: string): void {
    if (serverName) {
      this.recordingState.set(serverName, true);
    } else {
      // Legacy: set for all known servers
      for (const name of RECORDING_SERVERS) {
        if (this.serverConnections.has(name)) {
          this.recordingState.set(name, true);
        }
      }
    }
  }

  /**
   * Mark recording as stopped on a specific server
   */
  setRecordingStopped(serverName?: string): void {
    if (serverName) {
      this.recordingState.set(serverName, false);
    } else {
      for (const name of RECORDING_SERVERS) {
        this.recordingState.set(name, false);
      }
    }
  }

  /**
   * Check if we believe recording is in progress on any server
   */
  isRecordingInProgress(): boolean {
    for (const [, recording] of this.recordingState) {
      if (recording) return true;
    }
    return false;
  }

  /**
   * Check recording status from a specific server
   */
  private async checkServerRecordingStatus(
    serverName: string,
    connection: ServerConnection,
  ): Promise<{ isRecording: boolean; statusText: string }> {
    try {
      const result = await connection.client.request(
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
        const isRecording = statusText.toLowerCase().includes('recording') &&
                           !statusText.toLowerCase().includes('no active') &&
                           !statusText.toLowerCase().includes('not recording');

        this.recordingState.set(serverName, isRecording);
        return { isRecording, statusText };
      }

      return { isRecording: false, statusText: 'Unable to parse status' };
    } catch (error) {
      return { isRecording: false, statusText: `Error: ${error}` };
    }
  }

  /**
   * Stop recording on a specific server
   */
  private async stopServerRecording(
    serverName: string,
    connection: ServerConnection,
  ): Promise<string> {
    try {
      const status = await this.checkServerRecordingStatus(serverName, connection);
      if (!status.isRecording) {
        this.recordingState.set(serverName, false);
        return 'No active recording';
      }

      this.logger.log(`Stopping active ${serverName} recording...\n`, { type: 'info' });

      const result = await connection.client.request(
        {
          method: 'tools/call',
          params: {
            name: 'stop_recording',
            arguments: {},
          },
        },
        CallToolResultSchema,
      );

      this.recordingState.set(serverName, false);

      const content = result.content[0];
      if (content && content.type === 'text') {
        this.logger.log(`✓ ${serverName} recording stopped: ${content.text}\n`, { type: 'info' });
        return content.text;
      }

      return 'Recording stopped';
    } catch (error) {
      this.logger.log(
        `Failed to stop ${serverName} recording: ${error}\n`,
        { type: 'warning' },
      );
      return `Error stopping recording: ${error}`;
    }
  }

  /**
   * Stop all active recordings across all connected recording-capable servers.
   */
  async stopAllRecordings(): Promise<string> {
    const results: string[] = [];
    for (const [serverName, connection] of this.serverConnections) {
      const result = await this.stopServerRecording(serverName, connection);
      results.push(`${serverName}: ${result}`);
    }
    return results.join('; ');
  }

  /**
   * Cleanup method - stops any active recordings across all servers.
   * Called during session end/shutdown and phase boundaries.
   */
  async cleanup(): Promise<void> {
    for (const [serverName, connection] of this.serverConnections) {
      try {
        const status = await this.checkServerRecordingStatus(serverName, connection);
        if (status.isRecording) {
          await this.stopServerRecording(serverName, connection);
        }
      } catch (error) {
        this.logger.log(
          `Error during ${serverName} recording cleanup (may be expected): ${error}\n`,
          { type: 'warning' },
        );
      }
    }

    this.serverConnections.clear();
    this.recordingState.clear();
  }

  // --- Legacy compatibility ---
  // These methods maintain the old single-server API so existing callers
  // (e.g., ablation-cli.ts) continue to work without changes.

  getServerName(): string {
    return RECORDING_SERVERS[0];
  }

  getConnection(): ServerConnection | null {
    return this.serverConnections.get(RECORDING_SERVERS[0]) || null;
  }

  setConnection_legacy(connection: ServerConnection): void {
    this.serverConnections.set(RECORDING_SERVERS[0], connection);
  }

  async checkRecordingStatus(): Promise<{ isRecording: boolean; statusText: string }> {
    const connection = this.serverConnections.get(RECORDING_SERVERS[0]);
    if (!connection) {
      return { isRecording: false, statusText: 'No server connection' };
    }
    return this.checkServerRecordingStatus(RECORDING_SERVERS[0], connection);
  }
}

// Re-export under old name for backward compatibility
export { VideoRecordingManager as ROS2VideoRecordingManager };
