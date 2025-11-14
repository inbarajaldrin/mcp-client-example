import { Anthropic } from '@anthropic-ai/sdk';
import { StdioClientTransport, } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsResultSchema, CallToolResultSchema, } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import chalk from 'chalk';
import { consoleStyles, Logger } from './logger.js';
export class MCPClient {
    anthropicClient;
    messages = [];
    mcpClient;
    transport;
    tools = [];
    logger;
    constructor({ loggerOptions, ...serverConfig }) {
        this.anthropicClient = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY,
        });
        this.mcpClient = new Client({ name: 'cli-client', version: '1.0.0' }, { capabilities: {} });
        this.transport = new StdioClientTransport(serverConfig);
        this.logger = new Logger(loggerOptions ?? { mode: 'verbose' });
    }
    async start() {
        try {
            // Connect to the transport (this spawns the server process)
            await this.mcpClient.connect(this.transport);
            // Give the server process a moment to fully initialize
            await new Promise(resolve => setTimeout(resolve, 100));
            // Initialize tools after connection is established
            await this.initMCPTools();
        }
        catch (error) {
            this.logger.log('Failed to initialize MCP Client: ' + error + '\n', {
                type: 'error',
            });
            process.exit(1);
        }
    }
    async stop() {
        await this.mcpClient.close();
    }
    async initMCPTools() {
        const toolsResults = await this.mcpClient.request({ method: 'tools/list' }, ListToolsResultSchema);
        // Convert MCP tools to Anthropic format
        // Anthropic only accepts: name, description, input_schema
        // Filter out any other fields like outputSchema, etc.
        this.tools = toolsResults.tools.map(({ inputSchema, name, description }) => ({
            name,
            description,
            input_schema: inputSchema,
        }));
    }
    formatToolCall(toolName, args) {
        return ('\n' +
            consoleStyles.tool.bracket('[') +
            consoleStyles.tool.name(toolName) +
            consoleStyles.tool.bracket('] ') +
            consoleStyles.tool.args(JSON.stringify(args, null, 2)) +
            '\n');
    }
    formatJSON(json) {
        return json
            .replace(/"([^"]+)":/g, chalk.blue('"$1":'))
            .replace(/: "([^"]+)"/g, ': ' + chalk.green('"$1"'));
    }
    async processStream(stream) {
        let currentMessage = '';
        let currentToolName = '';
        let currentToolInputString = '';
        this.logger.log(consoleStyles.assistant);
        for await (const chunk of stream) {
            switch (chunk.type) {
                case 'message_start':
                case 'content_block_stop':
                    continue;
                case 'content_block_start':
                    if (chunk.content_block?.type === 'tool_use') {
                        currentToolName = chunk.content_block.name;
                    }
                    break;
                case 'content_block_delta':
                    if (chunk.delta.type === 'text_delta') {
                        this.logger.log(chunk.delta.text);
                        currentMessage += chunk.delta.text;
                    }
                    else if (chunk.delta.type === 'input_json_delta') {
                        if (currentToolName && chunk.delta.partial_json) {
                            currentToolInputString += chunk.delta.partial_json;
                        }
                    }
                    break;
                case 'message_delta':
                    if (currentMessage) {
                        this.messages.push({
                            role: 'assistant',
                            content: currentMessage,
                        });
                    }
                    if (chunk.delta.stop_reason === 'tool_use') {
                        const toolArgs = currentToolInputString
                            ? JSON.parse(currentToolInputString)
                            : {};
                        this.logger.log(this.formatToolCall(currentToolName, toolArgs) + '\n');
                        const toolResult = await this.mcpClient.request({
                            method: 'tools/call',
                            params: {
                                name: currentToolName,
                                arguments: toolArgs,
                            },
                        }, CallToolResultSchema);
                        const formattedResult = this.formatJSON(JSON.stringify(toolResult.content.flatMap((c) => c.text)));
                        this.messages.push({
                            role: 'user',
                            content: formattedResult,
                        });
                        const nextStream = await this.anthropicClient.messages.create({
                            messages: this.messages,
                            model: 'claude-haiku-4-5-20251001',
                            max_tokens: 8192,
                            tools: this.tools,
                            stream: true,
                        });
                        await this.processStream(nextStream);
                    }
                    break;
                case 'message_stop':
                    break;
                default:
                    this.logger.log(`Unknown event type: ${JSON.stringify(chunk)}\n`, {
                        type: 'warning',
                    });
            }
        }
    }
    async processQuery(query) {
        try {
            this.messages.push({ role: 'user', content: query });
            const stream = await this.anthropicClient.messages.create({
                messages: this.messages,
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 8192,
                tools: this.tools,
                stream: true,
            });
            await this.processStream(stream);
            return this.messages;
        }
        catch (error) {
            this.logger.log('\nError during query processing: ' + error + '\n', {
                type: 'error',
            });
            if (error instanceof Error) {
                this.logger.log(consoleStyles.assistant +
                    'I apologize, but I encountered an error: ' +
                    error.message +
                    '\n');
            }
        }
    }
}
