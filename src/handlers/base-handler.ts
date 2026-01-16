import { Logger } from '../logger.js';

/**
 * Base interface for all handlers in the application.
 * Handlers are responsible for handling specific types of events or requests.
 */
export interface BaseHandler {
  /**
   * Initialize the handler and set up any necessary listeners or state.
   */
  setup(): void;

  /**
   * Clean up any resources and remove listeners.
   */
  cleanup(): void;
}

/**
 * Base class providing common functionality for handlers.
 */
export abstract class AbstractHandler implements BaseHandler {
  protected logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  abstract setup(): void;
  abstract cleanup(): void;
}
