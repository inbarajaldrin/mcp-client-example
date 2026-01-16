/**
 * Keyboard monitoring for abort detection during agent execution.
 */

import readline from 'readline/promises';
import chalk from 'chalk';
import { Logger } from '../logger.js';

/**
 * Callbacks for keyboard monitor to interact with parent component.
 */
export interface KeyboardMonitorCallbacks {
  /** Called when abort is requested */
  onAbort: () => void;
  /** Get current readline interface */
  getReadline: () => readline.Interface | null;
  /** Set readline interface (used when recreating after raw mode) */
  setReadline: (rl: readline.Interface | null) => void;
  /** Get IPC server to signal abort */
  getIPCServer: () => { setAborted: (value: boolean) => void } | null;
}

/**
 * Monitors keyboard input for 'a' key to abort current query.
 * Handles raw mode switching and readline management.
 */
export class KeyboardMonitor {
  private logger: Logger;
  private callbacks: KeyboardMonitorCallbacks;
  private cleanupHandler: (() => void) | null = null;
  private _isMonitoring = false;
  private _abortRequested = false;
  private _pendingInput = '';

  constructor(logger: Logger, callbacks: KeyboardMonitorCallbacks) {
    this.logger = logger;
    this.callbacks = callbacks;
  }

  /**
   * Whether keyboard monitoring is currently active.
   */
  get isMonitoring(): boolean {
    return this._isMonitoring;
  }

  /**
   * Whether abort has been requested.
   */
  get abortRequested(): boolean {
    return this._abortRequested;
  }

  /**
   * Set abort requested state.
   */
  set abortRequested(value: boolean) {
    this._abortRequested = value;
  }

  /**
   * Get any pending input buffered during monitoring.
   */
  get pendingInput(): string {
    return this._pendingInput;
  }

  /**
   * Clear pending input buffer.
   */
  clearPendingInput(): void {
    this._pendingInput = '';
  }

  /**
   * Start monitoring keyboard input for 'a' key to abort current query.
   */
  start(): void {
    if (!process.stdin.isTTY) {
      return;
    }

    // Always clean up any existing monitoring before starting fresh
    if (this._isMonitoring) {
      this.stop();
    }

    this._isMonitoring = true;
    this._abortRequested = false;

    // Pause readline to allow raw mode
    const rl = this.callbacks.getReadline();
    if (rl) {
      rl.pause();
    }

    const stdin = process.stdin;

    // Enable raw mode to read individual key presses
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding('utf8');

    // Listen for key presses
    const keyHandler = (key: string) => {
      if (!this._isMonitoring) {
        return;
      }

      // Handle special keys
      const keyLower = key.toLowerCase();

      // 'a' triggers abort only if not already aborted
      if (keyLower === 'a' && !this._abortRequested) {
        this.logger.log(
          '\n' +
            chalk.bold.red(
              '🛑 Abort requested - will finish current response then stop...',
            ) +
            '\n',
          { type: 'error' },
        );
        this._abortRequested = true;

        // Also abort IPC server if it's running
        const ipcServer = this.callbacks.getIPCServer();
        if (ipcServer) {
          ipcServer.setAborted(true);
        }

        // Notify parent
        this.callbacks.onAbort();
        return;
      }

      // Handle Ctrl+C (exit)
      if (key === '\x03') {
        return;
      }

      // Handle backspace (delete last character from buffer)
      if (key === '\x7f' || key === '\b') {
        if (this._pendingInput.length > 0) {
          this._pendingInput = this._pendingInput.slice(0, -1);
        }
        return;
      }

      // Ignore Enter and other control characters
      if (key === '\r' || key === '\n' || key.charCodeAt(0) < 32) {
        return;
      }

      // Buffer printable characters for next prompt
      this._pendingInput += key;
    };

    stdin.on('data', keyHandler);

    // Store cleanup function
    this.cleanupHandler = () => {
      if (!this._isMonitoring) {
        return;
      }

      this._isMonitoring = false;
      stdin.removeListener('data', keyHandler);

      // Restore normal mode
      if (stdin.setRawMode) {
        stdin.setRawMode(false);
      }

      // Flush stdin buffer to prevent raw mode input from interfering with readline
      // Note: User input is already captured in pendingInput by the keyHandler
      if (stdin.readable) {
        let chunk;
        while ((chunk = stdin.read()) !== null) {
          // Discard - already captured in pendingInput
        }
      }

      // Close and recreate readline interface to ensure clean terminal state
      // This prevents double-echo issues after restoring from raw mode
      const currentRl = this.callbacks.getReadline();
      if (currentRl) {
        // Preserve history before recreating readline
        const savedHistory = [...(currentRl as any).history];

        currentRl.close();
        const newRl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        // Set the new readline interface
        this.callbacks.setReadline(newRl);

        // Restore history after recreating readline
        if (savedHistory.length > 0) {
          (newRl as any).history = savedHistory;
        }
      }
    };
  }

  /**
   * Stop keyboard monitoring and restore terminal settings.
   */
  stop(): void {
    if (this.cleanupHandler) {
      this.cleanupHandler();
      this.cleanupHandler = null;
    }
    this._isMonitoring = false;
  }
}
