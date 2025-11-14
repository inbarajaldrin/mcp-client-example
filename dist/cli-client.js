import readline from 'readline/promises';
import { MCPClient } from './index.js';
import { consoleStyles, Logger } from './logger.js';
const EXIT_COMMAND = 'exit';
export class MCPClientCLI {
    rl = null;
    client;
    logger;
    isShuttingDown = false;
    constructor(serverConfig) {
        this.client = new MCPClient(serverConfig);
        this.logger = new Logger({ mode: 'verbose' });
        // Set up signal handlers for graceful shutdown
        this.setupSignalHandlers();
    }
    setupSignalHandlers() {
        const cleanup = async () => {
            if (this.isShuttingDown) {
                return;
            }
            this.isShuttingDown = true;
            this.logger.log('\n\nShutting down gracefully...\n', { type: 'info' });
            try {
                // Close readline first
                if (this.rl) {
                    this.rl.close();
                    this.rl = null;
                }
                // Close MCP client connection
                await this.client.stop();
            }
            catch (error) {
                // Ignore errors during cleanup
            }
            process.exit(0);
        };
        // Handle SIGINT (Ctrl+C)
        process.on('SIGINT', () => {
            void cleanup();
        });
        // Handle SIGTERM
        process.on('SIGTERM', () => {
            void cleanup();
        });
    }
    async start() {
        try {
            this.logger.log(consoleStyles.separator + '\n', { type: 'info' });
            this.logger.log('🤖 Interactive Claude CLI\n', { type: 'info' });
            this.logger.log(`Type your queries or "${EXIT_COMMAND}" to exit\n`, {
                type: 'info',
            });
            this.logger.log(consoleStyles.separator + '\n', { type: 'info' });
            // Wait for MCP client to fully connect before creating readline
            await this.client.start();
            // Create readline interface after MCP connection is established
            this.rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            await this.chat_loop();
        }
        catch (error) {
            if (!this.isShuttingDown) {
                this.logger.log('Failed to initialize tools: ' + error + '\n', {
                    type: 'error',
                });
            }
        }
        finally {
            await this.cleanup();
        }
    }
    async cleanup() {
        if (this.isShuttingDown) {
            return;
        }
        this.isShuttingDown = true;
        try {
            if (this.rl) {
                this.rl.close();
                this.rl = null;
            }
            await this.client.stop();
        }
        catch (error) {
            // Ignore errors during cleanup
        }
    }
    async chat_loop() {
        if (!this.rl) {
            throw new Error('Readline interface not initialized');
        }
        while (true) {
            try {
                if (this.isShuttingDown) {
                    break;
                }
                const query = (await this.rl.question(consoleStyles.prompt)).trim();
                if (this.isShuttingDown) {
                    break;
                }
                if (query.toLowerCase() === EXIT_COMMAND) {
                    this.logger.log('\nGoodbye! 👋\n', { type: 'warning' });
                    break;
                }
                await this.client.processQuery(query);
                this.logger.log('\n' + consoleStyles.separator + '\n');
            }
            catch (error) {
                // Check if readline was closed (happens during shutdown)
                if (error?.code === 'ERR_USE_AFTER_CLOSE' || this.isShuttingDown) {
                    break;
                }
                this.logger.log('\nError: ' + error + '\n', { type: 'error' });
            }
        }
    }
}
