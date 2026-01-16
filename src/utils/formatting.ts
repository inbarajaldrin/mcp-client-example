/**
 * Formatting utilities for tool calls and JSON output.
 */

import chalk from 'chalk';
import { consoleStyles } from '../logger.js';

/**
 * Format a tool call for display in the console.
 *
 * @param toolName - The name of the tool being called
 * @param args - The arguments being passed to the tool
 * @param fromIPC - Whether the call is from IPC (uses different colors)
 * @returns Formatted string for display
 */
export function formatToolCall(toolName: string, args: any, fromIPC: boolean = false): string {
  // Custom formatter that handles multiline strings nicely
  const formatValue = (value: any, indent: string = ''): string => {
    if (typeof value === 'string' && value.includes('\n')) {
      // Multiline string - display with actual newlines
      const lines = value.split('\n');
      const isCode = lines.some(line =>
        line.trim().match(/^(import|from|def|class|if|for|while|#|print|return|const|let|var|function)/)
      );
      if (isCode) {
        // Format as code block
        return '```\n' + value + '\n```';
      }
      // Format with triple quotes
      return '"""\n' + value + '\n"""';
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      const items = value.map((item, i) =>
        indent + '  ' + formatValue(item, indent + '  ') + (i < value.length - 1 ? ',' : '')
      );
      return '[\n' + items.join('\n') + '\n' + indent + ']';
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 0) return '{}';
      const formatted = entries.map(([key, val], i) => {
        const formattedVal = formatValue(val, indent + '  ');
        return indent + '  ' + JSON.stringify(key) + ': ' + formattedVal + (i < entries.length - 1 ? ',' : '');
      });
      return '{\n' + formatted.join('\n') + '\n' + indent + '}';
    }
    return JSON.stringify(value);
  };

  const formattedArgs = formatValue(args);

  // If formatted args starts with '{', put the bracket on a new line
  let argsDisplay = formattedArgs;
  if (formattedArgs.startsWith('{')) {
    argsDisplay = '\n' + formattedArgs;
  }

  // Use different colors for IPC calls:
  // - IPC calls (automatic tool calls from orchestrator) → magenta/pink
  // - mcp-tools-orchestrator tools (agent writing script) → normal colors
  // - Direct LLM tool calls → normal colors
  const isOrchestratorTool = toolName.startsWith('mcp-tools-orchestrator__');
  const isIPCCall = fromIPC && !isOrchestratorTool;
  const toolStyle = isIPCCall ? consoleStyles.orchestratorTool : consoleStyles.tool;

  return (
    '\n' +
    toolStyle.bracket('[') +
    toolStyle.name(toolName) +
    toolStyle.bracket(']') +
    toolStyle.args(argsDisplay) +
    '\n'
  );
}

/**
 * Format JSON with syntax highlighting for console output.
 *
 * @param json - The JSON string to format
 * @returns Formatted JSON string with chalk colors
 */
export function formatJSON(json: string): string {
  return json
    .replace(/"([^"]+)":/g, chalk.blue('"$1":'))
    .replace(/: "([^"]+)"/g, ': ' + chalk.green('"$1"'));
}
