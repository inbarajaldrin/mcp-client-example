// Reference: ablation run logging feature — server stderr capture
import { createWriteStream, mkdirSync, existsSync, readdirSync, copyFileSync, renameSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import type { Stream } from 'stream';
import type { WriteStream } from 'fs';
import { Logger } from '../logger.js';
import { sanitizeFolderName } from '../utils/path-utils.js';

interface ServerLogEntry {
  stream: WriteStream;
  logPath: string;
}

export class ServerLogManager {
  private captures: Map<string, ServerLogEntry> = new Map();
  // Track all servers that have ever been captured (survives stopAll)
  private knownServers: Set<string> = new Set();
  private logDir: string | null = null;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Set the active log directory for the current session.
   * Called when a chat session starts and the session directory is known.
   */
  setLogDir(logDir: string): void {
    this.logDir = logDir;
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Get the current log directory path.
   */
  getLogDir(): string | null {
    return this.logDir;
  }

  /**
   * Start capturing stderr from a server process.
   * Lines are timestamped, written to a log file, and teed to the terminal.
   * Accepts Stream (MCP SDK type) or Readable.
   */
  startCapture(serverName: string, stderrStream: Stream | Readable): void {
    if (!this.logDir) {
      // No session directory yet — just inherit to terminal
      return;
    }

    // Stop any existing capture for this server (e.g., reconnect)
    this.stopCapture(serverName);

    const sanitizedName = sanitizeFolderName(serverName);
    const logPath = join(this.logDir, `${sanitizedName}.log`);
    const fileStream = createWriteStream(logPath, { flags: 'a' });

    // MCP SDK returns PassThrough (extends Readable) typed as Stream.
    // createInterface requires Readable, so cast safely.
    const readable = stderrStream as Readable;
    const rl = createInterface({ input: readable, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      const timestamped = `${new Date().toISOString()} ${line}\n`;
      fileStream.write(timestamped);
      // Tee to terminal (stderr) so the user still sees server output live
      process.stderr.write(line + '\n');
    });

    rl.on('close', () => {
      fileStream.end();
    });

    this.captures.set(serverName, { stream: fileStream, logPath });
    this.knownServers.add(serverName);
  }

  /**
   * Stop capturing stderr for a server.
   */
  stopCapture(serverName: string): void {
    const entry = this.captures.get(serverName);
    if (entry) {
      entry.stream.end();
      this.captures.delete(serverName);
    }
  }

  /**
   * Stop all captures and close all log files.
   */
  stopAll(): void {
    for (const [name] of this.captures) {
      this.stopCapture(name);
    }
  }

  /**
   * Copy all current server log files to a destination directory.
   * Used to snapshot logs into ablation phase directories.
   */
  copyLogsToDir(destDir: string): number {
    if (!this.logDir || !existsSync(this.logDir)) return 0;

    const logFiles = readdirSync(this.logDir).filter(f => f.endsWith('.log'));
    if (logFiles.length === 0) return 0;

    const destLogsDir = join(destDir, 'server-logs');
    if (!existsSync(destLogsDir)) {
      mkdirSync(destLogsDir, { recursive: true });
    }

    let copied = 0;
    for (const file of logFiles) {
      try {
        copyFileSync(join(this.logDir, file), join(destLogsDir, file));
        copied++;
      } catch (err) {
        this.logger.log(`Failed to copy server log ${file}: ${err}\n`, { type: 'warning' });
      }
    }
    return copied;
  }

  /**
   * Move all server log files to a new directory.
   * Used by saveCurrentSession() to relocate logs from the staging dir
   * to the final session folder (whose name is only known at save time).
   */
  moveLogsToDir(destDir: string): void {
    if (!this.logDir || !existsSync(this.logDir)) return;

    const logFiles = readdirSync(this.logDir).filter(f => f.endsWith('.log'));
    if (logFiles.length === 0) return;

    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    for (const file of logFiles) {
      try {
        renameSync(join(this.logDir, file), join(destDir, file));
      } catch (err) {
        // If rename fails (cross-device), fall back to copy
        try {
          copyFileSync(join(this.logDir, file), join(destDir, file));
        } catch (copyErr) {
          this.logger.log(`Failed to move server log ${file}: ${copyErr}\n`, { type: 'warning' });
        }
      }
    }

    // Update logDir to the new location so future writes go there
    this.logDir = destDir;
  }

  /**
   * Get a mapping of server names to their log file relative paths.
   * Uses knownServers (not captures) so it works after stopAll().
   * Used for the `serverLogs` field in chat.json.
   */
  getServerLogsMapping(): Record<string, string> | undefined {
    if (this.knownServers.size === 0) return undefined;
    const mapping: Record<string, string> = {};
    for (const name of this.knownServers) {
      const sanitizedName = sanitizeFolderName(name);
      mapping[name] = `server-logs/${sanitizedName}.log`;
    }
    return Object.keys(mapping).length > 0 ? mapping : undefined;
  }
}
