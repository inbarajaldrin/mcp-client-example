import { Logger } from '../logger.js';
import { AbstractHandler } from './base-handler.js';

/**
 * Callback type for cleanup operations when signals are received.
 */
export type CleanupCallback = () => Promise<void>;

/**
 * Handles process signals (SIGINT, SIGTERM) and uncaught exceptions
 * for graceful shutdown.
 */
export class SignalHandler extends AbstractHandler {
  private cleanupCallback: CleanupCallback;
  private isShuttingDown: boolean = false;
  private boundSignalHandler: () => Promise<void>;
  private boundExceptionHandler: (error: Error) => Promise<void>;

  /** When true, SIGINT sets abortRequested instead of exiting */
  private _abortMode: boolean = false;
  /** Flag indicating abort was requested via SIGINT in abort mode */
  private _abortRequested: boolean = false;

  constructor(logger: Logger, cleanupCallback: CleanupCallback) {
    super(logger);
    this.cleanupCallback = cleanupCallback;
    this.boundSignalHandler = this.handleSignal.bind(this);
    this.boundExceptionHandler = this.handleException.bind(this);
  }

  /** Enable abort mode - SIGINT will set abort flag instead of exiting */
  setAbortMode(enabled: boolean): void {
    this._abortMode = enabled;
    if (enabled) {
      this._abortRequested = false;
    }
  }

  /** Check if abort was requested (only meaningful in abort mode) */
  get abortRequested(): boolean {
    return this._abortRequested;
  }

  /** Reset abort requested flag */
  resetAbort(): void {
    this._abortRequested = false;
  }

  /**
   * Set up signal listeners for SIGINT, SIGTERM, and uncaughtException.
   */
  setup(): void {
    process.on('SIGINT', this.boundSignalHandler);
    process.on('SIGTERM', this.boundSignalHandler);
    process.on('uncaughtException', this.boundExceptionHandler);
  }

  /**
   * Remove signal listeners.
   */
  cleanup(): void {
    process.off('SIGINT', this.boundSignalHandler);
    process.off('SIGTERM', this.boundSignalHandler);
    process.off('uncaughtException', this.boundExceptionHandler);
  }

  /**
   * Handle SIGINT and SIGTERM signals.
   */
  private async handleSignal(): Promise<void> {
    // In abort mode, just set the flag and return (don't exit)
    if (this._abortMode) {
      if (!this._abortRequested) {
        this._abortRequested = true;
        this.logger.log('\n⚠️  Abort requested (Ctrl+C) - stopping after current command...\n', { type: 'warning' });
      }
      return;
    }

    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    this.logger.log('\n\nShutting down gracefully...\n', { type: 'info' });

    try {
      await this.cleanupCallback();
    } catch (error) {
      this.logger.log(`Error during cleanup: ${error}\n`, { type: 'error' });
    }

    process.exit(0);
  }

  /**
   * Handle uncaught exceptions.
   */
  private async handleException(error: Error): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.logger.log(`\nUncaught exception: ${error}\n`, { type: 'error' });
    await this.handleSignal();
  }
}
