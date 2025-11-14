import chalk from 'chalk';
export const consoleStyles = {
    prompt: chalk.green('You: '),
    assistant: chalk.blue('Claude: '),
    tool: {
        name: chalk.cyan.bold,
        args: chalk.yellow,
        bracket: chalk.dim,
    },
    error: chalk.red,
    info: chalk.blue,
    success: chalk.green,
    warning: chalk.yellow,
    separator: chalk.gray('─'.repeat(50)),
    default: chalk,
};
export class Logger {
    mode = 'verbose';
    constructor({ mode }) {
        this.mode = mode;
    }
    log(message, options) {
        if (this.mode === 'none')
            return;
        if (this.mode === 'error' && options?.type !== 'error')
            return;
        process.stdout.write(consoleStyles[options?.type ?? 'default'](message));
    }
}
