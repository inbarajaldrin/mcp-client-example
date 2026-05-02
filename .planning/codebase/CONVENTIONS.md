# Coding Conventions

**Analysis Date:** 2026-05-02

## Naming Patterns

**Files:**
- Lower kebab-case with hyphens: `chat-history-cli.ts`, `token-manager.ts`, `tool-replay-cli.ts`
- Manager files: `*-manager.ts` (e.g., `ablation-manager.ts`, `preferences-manager.ts`)
- Provider implementations: `*-provider.ts` (e.g., `anthropic-provider.ts`, `openai-provider.ts`)
- Handlers: `*-handler.ts` (e.g., `elicitation-handler.ts`, `signal-handler.ts`)
- CLI modules: `*-cli.ts` (e.g., `ablation-cli.ts`, `chat-history-cli.ts`)
- Utilities: `*-utils.ts` or plain descriptive names (e.g., `mime-types.ts`, `formatting.ts`)

**Functions:**
- camelCase for all function names and exported functions
- Example: `formatToolCall()`, `listAvailableModels()`, `setCompactFormat()`
- Private/internal functions also camelCase: `stripAnsi()`, `mergeEnvironment()`
- Action verbs at start: `get`, `set`, `create`, `load`, `save`, `parse`, `format`, `count`, `enable`, `disable`, `toggle`, `list`

**Variables:**
- camelCase for all local and module-level variables
- Private class properties use camelCase with `private` modifier
- Example: `const CONFIG_DIR`, `private logger: Logger`, `private toolStates: Record<string, boolean>`
- Constants in UPPER_SNAKE_CASE when module-scoped or fully immutable config values
- Example: `const CHATS_DIR`, `const CONFIG_DIR`, `const PROVIDERS`

**Types:**
- PascalCase for interfaces: `ModelProvider`, `TokenCounter`, `ChatSession`, `Message`, `Tool`
- PascalCase for type aliases: `LoggingMode`, `ToolCall`, `TokenUsage`, `WebStreamEvent`
- Generic/union types use PascalCase: `SummarizationConfig`, `ThinkingBlock`, `MessageStreamEvent`
- Exported types include explicit `export` keyword: `export interface Tool`, `export type Message`

**Classes:**
- PascalCase: `Logger`, `MCPClient`, `ToolManager`, `AnthropicTokenCounter`, `OpenAIProvider`, `MCPClientCLI`
- Manager classes: `*Manager` suffix (e.g., `ChatHistoryManager`, `TokenManager`, `AblationManager`)
- Provider classes: `*Provider` suffix (e.g., `AnthropicProvider`, `OpenAIProvider`)
- Counter classes: `*TokenCounter` (e.g., `AnthropicTokenCounter`, `OpenAITokenCounter`)

## Code Style

**Formatting:**
- Prettier configured as dev dependency (`prettier: ^3.4.1`)
- Run via `npm run format` to format entire codebase
- No `.prettierrc` file present; uses Prettier defaults
- Consistent spacing and indentation enforced through formatting

**Linting:**
- No `.eslintrc` or linting config detected in main project
- TypeScript strict mode enabled (`"strict": true` in tsconfig.json)
- Reference projects in `reference-repos/` have ESLint configs but not applied to main codebase

**Semicolons:**
- Present throughout codebase (mandatory style)
- All statements end with semicolons: `const x = 5;`, `return value;`

**Quotes:**
- Single quotes consistently used for string literals
- Example: `'user'`, `'anthropic'`, `import { Client } from '@modelcontextprotocol/sdk/client/index.js'`
- Template literals (backticks) used for interpolation and multi-line strings

## Import Organization

**Order:**
1. Node.js built-in imports (fs, path, readline)
2. External package imports from npm/dependencies (@anthropic-ai/sdk, chalk, dotenv)
3. SDK/protocol imports (@modelcontextprotocol/sdk/...)
4. Internal relative imports (./index.js, ../model-provider.js, ../managers/...)
5. Type imports using `import type { ... } from '...'` for type-only imports

**Path Aliases:**
- No path aliases configured in tsconfig.json
- All imports use relative paths: `./`, `../`, `../../`
- Example: `import { Logger } from '../logger.js'`, `import { MCPClient } from './index.js'`

**Import Style:**
- Named imports preferred: `import { Tool, Message } from '../model-provider.js'`
- Default imports used when exporting single class/function: `import chalk from 'chalk'`
- Type imports separated: `import type { ModelProvider } from '../model-provider.js'`
- Curly braces across multiple lines for long imports

## Error Handling

**Patterns:**
- Try-catch blocks for synchronous operations: `try { ... } catch (error) { ... }`
- Example in `src/managers/tool-manager.ts`:
  ```typescript
  try {
    const content = readFileSync(this.statesFile, 'utf-8');
    const states = yaml.parse(content);
  } catch (error) {
    this.logger.log(`Failed to load tool-states.yaml: ${error}\n`, { type: 'warning' });
  }
  ```
- Errors thrown as `Error` or `new Error(message)` with descriptive strings
- Example: `throw new Error('Context window is required for model...')`
- No custom error types or Result<T, E> pattern observed; standard exception handling only
- Promise rejections caught in async functions or via `.catch()` handlers

**Logger Integration:**
- All error/warning logging goes through `this.logger.log(message, { type: 'error' | 'warning' })`
- Never uses console directly for errors; Logger class enforces centralized logging
- Logger respects verbosity mode ('verbose', 'error', 'none')

## Logging

**Framework:** Custom `Logger` class at `src/logger.ts`

**Patterns:**
- All modules inject Logger via constructor: `constructor(logger?: Logger)`
- Logger mode controlled via options: `{ mode: 'verbose' | 'error' | 'none' }`
- Logging method: `logger.log(message, options)`
- Options parameter: `{ type?: 'info' | 'error' | 'success' | 'warning' }`
- Example: `this.logger.log('Tool execution failed', { type: 'error' })`
- Uses `chalk` for colored console output via `consoleStyles` object
- Console styles defined in `src/logger.ts` (e.g., `consoleStyles.prompt`, `consoleStyles.tool`)

**When to Log:**
- Use 'info' or 'success' for normal operational messages
- Use 'warning' for recoverable issues (e.g., config fallback, missing non-critical file)
- Use 'error' for failure states that halt operation
- No debug/trace logging observed; verbose mode is binary

## Comments

**When to Comment:**
- Explain *why*, not *what* (code is readable; logic rationale isn't)
- Document non-obvious design decisions and edge cases
- Example: `// Only use provided context window - no fallback` in token counter constructor
- Mark known limitations: `// TODO: Fix summary creation logic...`
- Describe file purpose at top with JSDoc-style comment

**JSDoc/TSDoc:**
- Used extensively on public classes and methods
- Format: `/** Description here */` above function/class
- Example in `src/core/tool-executor.ts`:
  ```typescript
  /**
   * Tool execution for MCP Client.
   * Routes tool calls to appropriate MCP servers.
   */
  ```
- Parameter descriptions: `@param name - Description`
- Return type descriptions: `@returns Type or description`
- No formal JSDoc tag validation observed

**Comment Density:**
- Moderate density: ~1 comment per 15-20 lines of code
- Inline comments used for non-obvious logic branches
- Example: `// Default: don't force stop` next to `return Promise.resolve(false)`

## Function Design

**Size:**
- Functions are generally short to medium (10-50 lines typical)
- Complex functions (100+ lines) observed in CLI handlers and providers for orchestration logic
- Example: `AblationCLI.run()` is 7897 lines but split across multiple internal methods
- Each discrete operation (load, save, execute) kept separate

**Parameters:**
- Accept options object for optional parameters: `constructor(logger?: Logger, statesFile?: string)`
- Callbacks passed as function types: `type ToolExecutor = (toolName: string, toolInput: Record<string, any>) => Promise<ToolExecutionResult>`
- Use of default parameters: `private mode: LoggingMode = 'verbose'`
- No rest parameters (`...args`) observed; explicit parameter lists preferred

**Return Values:**
- Functions return Promise<T> when asynchronous
- Example: `async start(): Promise<void>`
- Void functions for side-effect operations (logging, saving state)
- Nullable returns indicated in return type: `return null` when no result
- Methods chain calls where applicable: `.catch(error => { ... })`

## Module Design

**Exports:**
- Named exports preferred for functions and classes: `export class Logger`, `export function formatToolCall()`
- Type exports separate: `export type LoggerOptions = { mode: LoggingMode }`
- Default export used rarely; named exports dominate

**Barrel Files:**
- No barrel files (`index.ts` with re-exports) observed in most directories
- Each module imports directly from source file
- Example: `import { Logger } from '../logger.js'` not `from '../logger/index.js'`
- Exception: Web frontend may use barrel files (not inspected in detail)

**Module Responsibilities:**
- Single responsibility: `logger.ts` handles logging, `token-manager.ts` handles tokens, etc.
- Managers centralize domain logic (tools, chat, preferences, ablations)
- Providers abstract LLM implementations (Anthropic, OpenAI, Google, etc.)
- CLI modules wrap user-facing operations with input/output handling
- Core modules contain shared cross-cutting code (tool execution, token management)

**Class Structure:**
- Private instance variables for state: `private toolStates: Record<string, boolean>`
- Public constructor for dependency injection (logger, options)
- Public methods for external API; private methods for internal logic
- Example pattern in `src/managers/tool-manager.ts`:
  ```typescript
  export class ToolManager {
    private toolStates: Record<string, boolean> = {};
    private logger: Logger;
    
    constructor(logger?: Logger, statesFile?: string) { ... }
    
    loadState(): void { ... }
    private saveState(): void { ... }
    isToolEnabled(toolName: string): boolean { ... }
  }
  ```

## Async/Await

**Patterns:**
- Widespread use of `async/await` for Promise handling
- All async methods declared with `async` keyword: `async start()`, `async processQuery()`
- Error handling via try-catch in async functions
- Callbacks return Promise types explicitly: `async (request: ElicitRequest) => { ... }`
- No callback/promise chain mixing; prefer async-await throughout

**Promise Usage:**
- `Promise.resolve()` used for synchronous operations returned as Promise
- Example: `return Promise.resolve(false)` when no async work needed
- `new Promise(resolve => ...)` for timer callbacks: `await new Promise(resolve => setTimeout(resolve, 200))`

---

*Convention analysis: 2026-05-02*
