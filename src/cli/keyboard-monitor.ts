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
  /** Get completer function for tab autocomplete (optional) */
  getCompleter?: () => ((line: string) => [string[], string]) | undefined;
}

/**
 * Monitors keyboard input for Ctrl+A to abort current query.
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
   * Start monitoring keyboard input for Ctrl+A to abort current query.
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
    // NOTE: Do NOT reset _abortRequested here. Callers that need a clean state
    // (e.g., chat_loop, ablation start) explicitly reset it before calling start().
    // Other callers (elicitation callbacks, HIL approval) temporarily stop/start
    // the monitor mid-execution and need the abort flag preserved.

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

      // Ctrl+A ('\x01') triggers soft abort only if not already aborted
      // This is a SOFT abort - lets current tool call complete, then stops
      // Does NOT abort IPC server immediately (that would kill running tools)
      if (key === '\x01' && !this._abortRequested) {
        this.logger.log(
          '\n' +
            chalk.bold.yellow(
              '⏸ Interrupt requested (Ctrl+A) - will finish current response then pause...',
            ) +
            '\n',
          { type: 'warning' },
        );
        this._abortRequested = true;

        // NOTE: We intentionally do NOT call ipcServer.setAborted(true) here
        // The soft abort lets the current tool call complete gracefully
        // Force-stop (the "y" button) is what triggers IPC server abort

        // Notify parent
        this.callbacks.onAbort();
        return;
      }

      // Handle Ctrl+C (exit) - emit SIGINT since raw mode prevents normal signal
      if (key === '\x03') {
        process.emit('SIGINT', 'SIGINT');
        return;
      }

      // Handle backspace (delete last character from buffer)
      if (key === '\x7f' || key === '\b') {
        if (this._pendingInput.length > 0) {
          this._pendingInput = this._pendingInput.slice(0, -1);
        }
        return;
      }

      // Handle Escape - clear pending input buffer so user can start fresh
      if (key === '\x1b') {
        this._pendingInput = '';
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

        // Get completer if available to preserve tab autocomplete
        const completer = this.callbacks.getCompleter?.();
        const newRl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          ...(completer && { completer }),
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

  /**
   * Collect a line of input from the user while staying in raw mode.
   * This prevents Ctrl+C from sending a real SIGINT to child processes.
   * Ctrl+C is handled as a JS-level event (same as during monitoring).
   *
   * Must be called while the keyboard monitor is active (raw mode on).
   * Temporarily replaces the key handler to echo characters and collect input.
   */
  collectInput(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this._isMonitoring || !process.stdin.isTTY) {
        resolve(null);
        return;
      }

      // Write prompt
      process.stdout.write(prompt);

      let buffer = '';

      // Temporarily pause normal monitoring and install input handler
      const stdin = process.stdin;

      // Remove existing listeners temporarily
      const existingListeners = stdin.listeners('data').slice();
      stdin.removeAllListeners('data');

      const inputHandler = (key: string) => {
        // Ctrl+C — emit JS SIGINT (stays in raw mode, no OS signal)
        if (key === '\x03') {
          process.stdout.write('\n');
          process.emit('SIGINT', 'SIGINT');
          // Restore listeners and resolve null to signal abort
          stdin.removeListener('data', inputHandler);
          for (const listener of existingListeners) {
            stdin.on('data', listener as (...args: any[]) => void);
          }
          resolve(null);
          return;
        }

        // Enter — submit input
        if (key === '\r' || key === '\n') {
          process.stdout.write('\n');
          stdin.removeListener('data', inputHandler);
          for (const listener of existingListeners) {
            stdin.on('data', listener as (...args: any[]) => void);
          }
          resolve(buffer);
          return;
        }

        // Backspace
        if (key === '\x7f' || key === '\b') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            // Erase character on screen: move back, write space, move back
            process.stdout.write('\b \b');
          }
          return;
        }

        // Escape — clear buffer
        if (key === '\x1b') {
          // Clear displayed text
          while (buffer.length > 0) {
            process.stdout.write('\b \b');
            buffer = buffer.slice(0, -1);
          }
          return;
        }

        // Ignore other control characters
        if (key.charCodeAt(0) < 32) {
          return;
        }

        // Printable character — echo and buffer
        buffer += key;
        process.stdout.write(key);
      };

      stdin.on('data', inputHandler);
    });
  }
}
