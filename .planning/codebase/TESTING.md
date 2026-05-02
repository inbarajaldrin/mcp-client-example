# Testing Patterns

**Analysis Date:** 2026-05-02

## Test Framework

**Runner:**
- No test framework detected in main project
- No Jest, Vitest, or other test runner configured
- No `*.test.ts`, `*.spec.ts`, or `__tests__/` directories found in `src/`

**Test Dependencies:**
- No testing libraries in `package.json` (no jest, vitest, mocha, chai)
- Build tools present: TypeScript, tsc-watch, Vite (for web frontend)

**Run Commands:**
```bash
npm run build              # Compile TypeScript only
npm run watch             # Watch mode with tsc-watch
npm run format            # Format with Prettier
```

No dedicated test commands available.

## Integration Tests & Probes

**Manual Integration Probes:**
The codebase includes ad-hoc integration test scripts in `scripts/` directory (not formal unit tests):

- `scripts/test-thinking.ts` - Tests thinking/reasoning model behavior
- `scripts/test-provider-cache.ts` - Tests Anthropic prompt caching
- `scripts/analyze-openai-cache.ts` - Analyzes OpenAI token caching
- `scripts/analyze-ablation-cost.ts` - Analyzes ablation experiment costs

These are **not unit tests**: they are one-off integration probes run manually to validate specific features. They are not:
- Automated in CI/CD
- Part of the test suite
- Included in build/verify pipeline
- Run on every change

**Purpose:**
- Ad-hoc validation of specific provider features
- Cost/performance analysis
- Debug/experimentation with model behavior

## Test File Organization

**Location:** Not applicable - no formal tests present

**What exists:**
- Standalone script files in `scripts/` for manual testing
- Example: `scripts/test-provider-cache.ts` is 200+ lines of manual test code
- Scripts import from main codebase and run specific scenarios

**No organized test structure:**
- No `test/` directory
- No `__tests__/` directory
- No test configuration files (jest.config.js, vitest.config.ts)

## Code Organization for Testability

While no formal tests exist, the codebase is structured for potential testability:

**Provider Abstraction:**
- All LLM providers implement `ModelProvider` interface (`src/model-provider.ts`)
- Each provider (`anthropic.ts`, `openai.ts`, etc.) encapsulates provider-specific logic
- Easy to mock via interface
- Example: `export interface ModelProvider { createMessageStream(...): AsyncIterable<MessageStreamEvent> }`

**Dependency Injection:**
- Classes accept dependencies in constructor: `constructor(logger?: Logger, statesFile?: string)`
- Managers receive Logger for easy mocking/testing
- Example: `ChatHistoryManager(logger?: Logger, chatsDir?: string)`

**Manager Pattern:**
- Business logic isolated in manager classes (`src/managers/`)
- Each manager handles one domain (chat, tools, preferences, tokens)
- Pure functions for utilities (`src/utils/`)

**Service Locator Pattern:**
- MCPClient provides access to managers via getter methods
- Easy to inject mocks in tests if tests existed

## Test Coverage

**Requirements:** None enforced

**Status:**
- **0% test coverage** - No automated tests or coverage measurement
- **No CI/CD testing** - Build only compiles TypeScript
- **High risk areas untested:**
  - Provider implementations (5 providers × 1000+ lines each)
  - Tool execution logic (`src/core/tool-executor.ts`)
  - Chat history persistence and restoration
  - Complex CLI state management (`src/cli/ablation-cli.ts` is 7897 lines)
  - Token counting and summarization logic
  - Hook and handler lifecycle

**Implications:**
- Regressions only caught through manual testing
- Provider API changes may break undetected until runtime
- Complex workflows (ablation runs, chat restoration) vulnerable to state corruption

## Manual Testing Approach

Since no automated tests exist, verification relies on:

1. **Manual invocation:** Run CLI commands and verify output
   ```bash
   npm run start  # Run the MCP client CLI
   ```

2. **Integration scripts:** Run ad-hoc validation scripts
   ```bash
   npx ts-node scripts/test-provider-cache.ts
   npx ts-node scripts/test-thinking.ts
   ```

3. **Visual inspection:** Review output in CLI or logs
   - Chat history in `.mcp-client-data/chats/`
   - Server logs in `.mcp-client-data/chats/YYYY-MM-DD/chat-*/server-logs/`

4. **Reference-repos validation:** Projects in `reference-repos/` include test configs (vitest, jest)
   - `reference-repos/multi-llm-ts/vitest.config.mjs` - Has testing setup
   - `reference-repos/mcp-client-chatbot/.eslintrc.json` - Has linting setup
   - Main project does not follow these patterns

## Testing Gaps & Recommendations

**Critical untested areas:**

| Area | File | Risk | Suggested Test Type |
|------|------|------|---------------------|
| Provider implementations | `src/providers/*.ts` | High - 5 different SDK integrations, easy to break on API changes | Unit tests for each provider |
| Tool execution logic | `src/core/tool-executor.ts` | High - Routes tool calls, handles arguments, manages server connections | Integration tests with mock MCP servers |
| Chat history I/O | `src/managers/chat-history-manager.ts` | High - Persistence layer, data corruption possible | Unit tests for save/load/restore |
| Token counting | `src/core/token-manager.ts` | Medium - Calculations affect cost estimates and context limits | Unit tests with known test vectors |
| Ablation orchestration | `src/cli/ablation-cli.ts` | High - 7897 lines, complex state machine, hard to debug | Integration tests for run workflows |
| CLI state machine | `src/cli-client.ts` | High - 1000+ lines, handles user input, mode switching | E2E tests with TTY simulation |

**TypeScript Strictness:**
- `"strict": true` in tsconfig.json enforces type safety at compile time
- This provides some safety without tests, but runtime behavior still unchecked

---

*Testing analysis: 2026-05-02*
