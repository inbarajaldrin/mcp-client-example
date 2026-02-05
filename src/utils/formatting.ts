/**
 * Formatting utilities for tool calls and JSON output.
 */

import chalk from 'chalk';
import { consoleStyles } from '../logger.js';

/**
 * Toggle for compact formatting mode.
 * When true: keeps nested objects/arrays on single lines to reduce vertical space
 * When false: fully expands all objects/arrays with indentation (verbose mode)
 */
export let COMPACT_FORMAT = true;

/**
 * Set the formatting mode.
 * @param compact - true for compact mode, false for verbose mode
 */
export function setCompactFormat(compact: boolean): void {
  COMPACT_FORMAT = compact;
}

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
  // In compact mode, nested values stay on one line; in verbose mode, everything expands
  const formatValue = (value: any, indent: string = '', depth: number = 0): string => {
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
      // In compact mode at depth > 0, keep arrays inline
      if (COMPACT_FORMAT && depth > 0) {
        return JSON.stringify(value);
      }
      const items = value.map((item, i) =>
        indent + '  ' + formatValue(item, indent + '  ', depth + 1) + (i < value.length - 1 ? ',' : '')
      );
      return '[\n' + items.join('\n') + '\n' + indent + ']';
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 0) return '{}';
      // In compact mode at depth > 0, keep objects inline
      if (COMPACT_FORMAT && depth > 0) {
        return JSON.stringify(value);
      }
      const formatted = entries.map(([key, val], i) => {
        const formattedVal = formatValue(val, indent + '  ', depth + 1);
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

/**
 * Format a value as compact JSON string.
 * In compact mode:
 *   - Top-level keys get their own lines
 *   - Array values: expand with one item per line (items stay inline)
 *   - Object/primitive values: stay inline
 * In verbose mode: equivalent to JSON.stringify(value, null, 2).
 *
 * @param value - The value to format
 * @returns Formatted JSON string
 */
export function formatCompactJSON(value: any): string {
  if (!COMPACT_FORMAT) {
    return JSON.stringify(value, null, 2);
  }

  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    // For top-level arrays, put each item on its own line but keep items inline
    const items = value.map((item, i) => {
      const comma = i < value.length - 1 ? ',' : '';
      return '  ' + JSON.stringify(item) + comma;
    });
    return '[\n' + items.join('\n') + '\n]';
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    // For top-level objects, put each key on its own line
    // Arrays get expanded (one item per line), other values stay inline
    const lines = entries.map(([key, val], i) => {
      const comma = i < entries.length - 1 ? ',' : '';

      if (Array.isArray(val)) {
        if (val.length === 0) {
          return '  ' + JSON.stringify(key) + ': []' + comma;
        }
        // Expand array: one item per line
        const items = val.map((item, j) => {
          const itemComma = j < val.length - 1 ? ',' : '';
          return '    ' + JSON.stringify(item) + itemComma;
        });
        return '  ' + JSON.stringify(key) + ': [\n' + items.join('\n') + '\n  ]' + comma;
      }

      // Non-array values stay inline
      return '  ' + JSON.stringify(key) + ': ' + JSON.stringify(val) + comma;
    });
    return '{\n' + lines.join('\n') + '\n}';
  }

  return JSON.stringify(value);
}
