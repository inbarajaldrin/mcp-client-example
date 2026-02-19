// Reference: Extracted from src/cli/ablation-cli.ts for shared use by HookManager and AblationCLI

/**
 * Result of parsing a direct tool call command
 */
export interface ParsedToolCall {
  toolName: string;
  args: Record<string, unknown>;
  injectResult: boolean;  // Whether to inject result into conversation context
}

/**
 * Parse a direct tool call command in either format:
 * - JSON: `@tool:server__tool_name {"arg": "value"}`
 * - Python-like: `@tool:server__tool_name(arg='value', num=42)`
 *
 * @param command The command string starting with @tool: or @tool-exec:
 * @returns Parsed tool call or null if invalid
 */
export function parseDirectToolCall(command: string): ParsedToolCall | null {
  // Determine if this is @tool: (inject result) or @tool-exec: (no injection)
  let injectResult = true;
  let rest: string;

  if (command.startsWith('@tool-exec:')) {
    injectResult = false;
    rest = command.slice('@tool-exec:'.length).trim();
  } else if (command.startsWith('@tool:')) {
    injectResult = true;
    rest = command.slice('@tool:'.length).trim();
  } else {
    return null;
  }

  // Try Python-like syntax first: tool_name(arg=val, ...) or tool_name()
  const pythonMatch = rest.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*\((.*)\)\s*$/);
  if (pythonMatch) {
    const toolName = pythonMatch[1];
    const argsStr = pythonMatch[2].trim();
    const args = argsStr ? parsePythonArgs(argsStr) : {};
    return { toolName, args, injectResult };
  }

  // Try JSON syntax: tool_name {"arg": "value"} or tool_name {}
  const jsonMatch = rest.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*(\{.*\})?\s*$/);
  if (jsonMatch) {
    const toolName = jsonMatch[1];
    const jsonStr = jsonMatch[2] || '{}';
    try {
      const args = JSON.parse(jsonStr);
      return { toolName, args, injectResult };
    } catch {
      return null;
    }
  }

  // Simple tool name with no args: tool_name
  const simpleMatch = rest.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*$/);
  if (simpleMatch) {
    return { toolName: simpleMatch[1], args: {}, injectResult };
  }

  return null;
}

/**
 * Parse Python-like function arguments: arg='value', num=42, flag=true
 * Handles: strings (single/double quotes), numbers, booleans, null
 */
export function parsePythonArgs(argsStr: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  // State machine to parse arguments
  let i = 0;
  while (i < argsStr.length) {
    // Skip whitespace and commas
    while (i < argsStr.length && (argsStr[i] === ' ' || argsStr[i] === ',' || argsStr[i] === '\t')) {
      i++;
    }
    if (i >= argsStr.length) break;

    // Parse key
    const keyStart = i;
    while (i < argsStr.length && argsStr[i] !== '=' && argsStr[i] !== ' ') {
      i++;
    }
    const key = argsStr.slice(keyStart, i).trim();
    if (!key) break;

    // Skip to '='
    while (i < argsStr.length && argsStr[i] === ' ') i++;
    if (argsStr[i] !== '=') break;
    i++; // Skip '='
    while (i < argsStr.length && argsStr[i] === ' ') i++;

    // Parse value
    let value: unknown;

    if (argsStr[i] === "'" || argsStr[i] === '"') {
      // String value
      const quote = argsStr[i];
      i++;
      const valueStart = i;
      while (i < argsStr.length && argsStr[i] !== quote) {
        if (argsStr[i] === '\\' && i + 1 < argsStr.length) i++; // Skip escaped char
        i++;
      }
      value = argsStr.slice(valueStart, i).replace(/\\(.)/g, '$1');
      i++; // Skip closing quote
    } else {
      // Non-string value (number, boolean, null)
      const valueStart = i;
      while (i < argsStr.length && argsStr[i] !== ',' && argsStr[i] !== ')') {
        i++;
      }
      const rawValue = argsStr.slice(valueStart, i).trim();

      // Parse type
      if (rawValue === 'true' || rawValue === 'True') {
        value = true;
      } else if (rawValue === 'false' || rawValue === 'False') {
        value = false;
      } else if (rawValue === 'null' || rawValue === 'None') {
        value = null;
      } else if (!isNaN(Number(rawValue))) {
        value = Number(rawValue);
      } else {
        // Treat as unquoted string
        value = rawValue;
      }
    }

    args[key] = value;
  }

  return args;
}

/**
 * Check if a tool result matches a `when` condition from a post-tool hook.
 * Matches against displayText (tool result) first. If that fails or is empty,
 * falls back to toolInput — useful when the tool returns {} but the meaningful
 * data (phase, status, action) is in the input arguments.
 */
export function matchesWhenCondition(
  when: Record<string, unknown>,
  displayText: string | undefined,
  toolInput?: Record<string, unknown>,
): boolean {
  const tryMatch = (obj: Record<string, unknown>): boolean => {
    if (typeof obj !== 'object' || obj === null) return false;
    for (const [key, value] of Object.entries(when)) {
      if (obj[key] !== value) return false;
    }
    return true;
  };

  // First try matching against tool result (displayText)
  if (displayText) {
    try {
      const clean = displayText.replace(/\u001b\[[0-9;]*m/g, '');
      const parsed = JSON.parse(clean);
      if (tryMatch(parsed as Record<string, unknown>)) return true;
    } catch {
      // Not valid JSON, continue to fallback
    }
  }

  // Fall back to tool input when result is empty or doesn't match
  if (toolInput && Object.keys(toolInput).length > 0 && tryMatch(toolInput)) {
    return true;
  }

  return false;
}
