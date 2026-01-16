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

  constructor(logger: Logger, cleanupCallback: CleanupCallback) {
    super(logger);
    this.cleanupCallback = cleanupCallback;
    this.boundSignalHandler = this.handleSignal.bind(this);
    this.boundExceptionHandler = this.handleException.bind(this);
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
