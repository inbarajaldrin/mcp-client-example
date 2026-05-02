# Codebase Concerns

**Analysis Date:** 2026-05-02

## Tech Debt

### Summary Creation System Broken Across Chat History

**Issue:** The summary field is consistently passed `endReason` (e.g., "stop", "tool_use", "max_tokens") instead of an actual summary. All summary-related fields are commented out in the interface and every display location.

**Files:**
- `src/managers/chat-history-manager.ts`: Lines 46 (interface), 768 (saveCurrentSession), 826-842 (generateMarkdownChat calls), 889-893 (endSession), 957 (generateMarkdownChat signature), 1333-1334 (search), 1373 (restore)
- `src/cli/chat-history-cli.ts`: Lines 354, 393, 434, 1197 (all "TODO: Fix summary creation logic")

**Impact:** Chat history metadata lacks actual summaries; search is disabled for summaries; chat restore cannot display meaningful summaries; all chat display skips summary section.

**Fix approach:** Implement actual summary generation (e.g., call LLM to generate 1-2 sentence summary at chat end, or extract from final assistant message). Update ChatMetadata interface to have proper summary field. Wire through to all display locations. Enable search on summary once data exists.

---

### Hard-Exit Not Enforced on Invalid MCP Config

**Issue:** When an ablation specifies a custom MCP config path that is invalid, missing, or fails to load, the system logs a warning but silently falls through to the default config. This changes run semantics without explicit user consent and without failing the run.

**Files:**
- `src/cli/ablation-cli.ts`: Lines 3930-3955 (TODO comment and fallback logic)

**Impact:** Ablation runs may execute against unexpected configurations. Researchers might think they're testing with a specific server setup when they're actually using the default. Hard to diagnose during post-hoc analysis.

**Fix approach:** On MCP config validation failure, throw hard error and refuse to start the run. Require user to fix the path or explicitly accept default. Add pre-flight validation at ablation definition time.

---

### Inconsistent Provider Token Tracking

**Issue:** Token parsing logic differs across providers. OpenAI uses `prompt_tokens_details.cached_tokens` for cache hits, but the architecture has scripts documenting confusion about field names (see `scripts/analyze-openai-cache.ts` header comment).

**Files:**
- `src/providers/openai.ts`: Lines 328, 338, 438, 533, 544, 693 (prompt_tokens_details parsing)
- `scripts/analyze-openai-cache.ts`: Lines 1-2 (reference documenting this exact issue)

**Impact:** Cache token accounting may be inconsistent across providers. Cost calculations could be incorrect if field names are misread or API responses change format.

**Fix approach:** Extract common token tracking interface. Add per-provider unit tests for token parsing. Validate against actual API responses. Document the mapping from each provider's API response schema to internal token fields.

---

### Ablation-CLI is God Object (7,897 lines)

**Issue:** `src/cli/ablation-cli.ts` is a single 7,897-line class concentrating:
- Run execution state machine (handleAblationRun)
- Pause/resume logic with user interaction
- Phase iteration and tool filtering
- Hook execution (@complete-phase, @escalate, @wait, @switch, @abort, @tool)
- Log copying and snapshot management
- Batch queue management (advanceBatchQueue)
- Chat restoration and escalation modes
- Interactive tool building (buildToolCallInteractively)
- Dry-run mode, iteration limits, tool states persistence

**Files:**
- `src/cli/ablation-cli.ts`: 33 try-catch blocks, ~50+ methods

**Impact:** High cognitive load. Changes to one feature (e.g., hook execution) risk breaking another (e.g., pause-resume). Hard to test any single feature in isolation. Difficult to onboard contributors.

**Fix approach:** Break into smaller modules:
- AblationRunExecutor (main run loop, state machine)
- AblationPauseManager (pause/resume/iteration logic)
- AblationHookExecutor (all hook types: @complete-phase, @escalate, @wait, @switch, etc.)
- AblationSnapshotManager (snapshot and log copying)
- AblationBatchQueue (batch queue management)

Each module should have clear entry points and dependencies. Share state via a RunContext object.

---

## Known Bugs & Fragile Patterns

### Frequent Fix Commits Indicate Recurring Issues

**Pattern:** The git log shows high-frequency "Fix" commits (at least 30 in recent history) clustering around:

1. **Hook Lifecycle & Context Preservation** (commits dd5a070, e1e7a69, a43db06)
   - Hook timing issues (deferred hooks, pause loop breaks)
   - Model switching losing context
   - Files: `src/managers/hook-manager.ts`
   
2. **Ablation Restore & Escalation** (commits ee171d4, a8af1c5, 9031258, bb4d75f)
   - Chat file relative paths in summary.json
   - Escalation mode run overwrites
   - Files: `src/cli/ablation-cli.ts`, `src/managers/ablation-manager.ts`

3. **Token Tracking & Cost Calculation** (commits 9eb6de1, 3c723e9, 00eaf67)
   - OpenAI cache token field name confusion
   - Duplicate Anthropic message pushes
   - Provider-specific token usage field differences
   - Files: `src/providers/*.ts` (especially openai.ts, anthropic.ts)

4. **Tool Execution & MCP Server Issues** (commits e72ac68, 5bd83a0, c5ef73e, eb4f2de)
   - Tool states being cleared on server reconnection
   - Tool result images not visible to some providers
   - Tool argument coercion edge cases
   - Files: `src/core/tool-executor.ts`, `src/providers/*.ts`

5. **Ctrl+C and Signal Handling** (commits e1e7a69, ff8d840, 270f9f6, 6e5384a)
   - Ctrl+C killing servers during abort
   - Soft abort not interrupting IPC tool calls
   - Abort mode only working once
   - Files: `src/cli/ablation-cli.ts`, `src/managers/hook-manager.ts`

**Impact:** Indicates underlying architectural brittleness. New features or edge cases continue to break existing functionality.

**Fix approach:** 
- Add regression tests for each fixed issue
- Document state machine invariants (what must be true before/after each operation)
- Refactor large files (ablation-cli.ts especially) to reduce interdependencies
- Add pre-commit hook to validate test coverage for "fix" commits

---

### Gemini Provider Type Coercion Issues

**Issue:** Multiple fixes for Gemini returning wrong types for enum/integer fields (commits 5a3de57 "Fix Gemini provider returning string values for integer enum args", then revert 9f9ce1e, then re-apply 5a3de57). Indicates inconsistent or unreliable API behavior.

**Files:**
- `src/providers/google.ts`: Type coercion logic
- `src/core/tool-executor.ts`: Lines 104-134 (coerceToolArgs function now handles string→int)

**Impact:** Gemini requests may be rejected by MCP servers due to type mismatches. Difficult to diagnose because error message comes from the server, not from the provider.

**Fix approach:** Add explicit pre-request validation: before sending tool call to server, validate all arguments against the tool schema. Log mismatches clearly. Add provider-specific test cases for enum/integer arguments.

---

### OpenAI Reasoning Text Not Available in Streaming

**Issue:** OpenAI's Chat Completions streaming API does not expose reasoning text in streaming deltas, only final full message.

**Files:**
- `src/providers/openai.ts`: Lines 355, 559 (TODO comments)

**Impact:** Reasoning tokens are counted but thinking content cannot be shown to user during streaming. Only available in final non-streamed response.

**Fix approach:** For o1/o3 models, buffer the message until complete (no streaming) to capture thinking text. Alternatively, stream deltas but fetch reasoning from non-streaming completion endpoint separately.

---

## Security Considerations

### No Input Sanitization for MCP Server Tool Arguments

**Issue:** Tool arguments received from LLM are coerced for type matching (string→int, etc.) but not validated against JSON schema constraints beyond simple type checking. No bounds checking, pattern validation, or enum enforcement visible in `coerceToolArgs` at `src/core/tool-executor.ts:104-134`.

**Files:**
- `src/core/tool-executor.ts`: Lines 104-134 (coerceToolArgs - only type coercion, no schema validation)
- `src/core/tool-executor.ts`: Line 390, 434 (usage of coerceToolArgs before sending to MCP)

**Impact:** If LLM sends tool arguments that fail schema validation (e.g., string longer than maxLength, number outside minimum/maximum range, enum value not in allowed list), the client sends them anyway. Depending on the MCP server, this could cause crashes, unexpected behavior, or security issues.

**Fix approach:** Add JSON Schema validation using a library like `ajv` or `zod`. Validate all tool arguments against the tool's input_schema before sending to MCP server. Reject invalid arguments and ask LLM to correct them.

---

### Credential Leakage Risk in Log Capture

**Issue:** The codebase captures extensive logs in `src/managers/server-log-manager.ts` and ablation snapshots. No explicit scrubbing of environment variables (API keys, tokens) or sensitive configuration values from logs.

**Files:**
- `src/managers/server-log-manager.ts`: Captures server stdout/stderr
- `src/index.ts`: Lines 73, 390 (CONFIG_DIR references where config is stored)
- Multiple places where server environment is built and logged

**Impact:** If an MCP server (especially external tools or orchestrator servers) logs environment variables or credentials to stdout/stderr, they will be captured in ablation runs and persisted to disk in `.mcp-client-data/ablations/runs/*/server-logs/`.

**Fix approach:** 
- Add log scrubber that redacts common credential patterns (OPENAI_API_KEY=sk-..., etc.)
- Document which environment variables are safe vs. sensitive
- Store sensitive config in a separate, unlogged config section
- Add warning on ablation run start if any sensitive env vars are set

---

## Performance Bottlenecks

### Ablation Run Loop May Block on Long Tool Execution

**Issue:** During ablation runs, tool execution calls are awaited sequentially (commit 79493b6 adds force-stop logic). If a tool call takes 30+ seconds, the entire ablation is blocked. Commit e1e7a69 had to add Ctrl+C abort path, indicating users hit this frequently.

**Files:**
- `src/cli/ablation-cli.ts`: Lines ~2613-5024 (handleAblationRun main loop)
- `src/core/tool-executor.ts`: Force-stop timeout at line 137 (15 seconds)

**Impact:** Slow or hung MCP tools will block iteration. Abort requires user to notice and press Ctrl+C; no automatic timeout.

**Fix approach:** Add configurable timeout for individual tool calls (separate from FORCE_STOP_TIMEOUT_SECONDS). On timeout, automatically kill and restart the server. Log timeout as an error in the ablation results. Make this configurable per-ablation phase.

---

## Fragile Areas

### Ablation State Persistence & Restoration

**Files:**
- `src/managers/ablation-manager.ts`: Lines ~1187-1223 (clearOutputs, resetOutputSubdirs)
- `src/cli/ablation-cli.ts`: Line ~5550 (handleAblationRestore)

**Why fragile:**
- Multiple commits for fixing restore (ee171d4, a8af1c5, bb4d75f)
- Relative vs. absolute paths in chat.json causing failures
- Phase-level enabled flags and output clearing between phases
- Continuation mode and batch queue state

**Safe modification:**
1. Add comprehensive snapshot validation before restore (check all required files exist)
2. Use absolute paths consistently in metadata
3. Add dry-run mode for restore (show what would be restored without modifying state)
4. Test restore against corrupted snapshots (missing files, partial writes)

**Test coverage:**
- No unit tests for restore logic
- No tests for partial failure scenarios
- No tests for concurrent ablation runs (could corrupt shared state)

---

### Hook System Lifecycle & Timing

**Files:**
- `src/managers/hook-manager.ts`: 794 lines
- Multiple commits fixing hook issues: dd5a070, e1e7a69, a43db06

**Why fragile:**
- Deferred hooks (@wait) can execute at unexpected times
- Hook execution can happen during pause, which changes context
- Model switching (@switch) inside a hook loses conversation context
- @complete-phase can trigger from within a when-input hook, causing early phase termination
- Commit e2dff0e adds "signal fallback check after nudge for batched tool calls" — indicates timing issue with batched tool execution and signals

**Safe modification:**
1. Document the hook execution order explicitly
2. Add state validation before each hook execution (e.g., assert we're not in pause mode)
3. Disallow nested hook execution (prevent hook from triggering another hook)
4. Test all hook types in combination with pause/resume

**Test coverage:**
- No unit tests for hook lifecycle
- No tests for hook interaction with pause/resume
- No tests for hook+model-switch combinations

---

### Chat History Restore with Thinking/Reasoning Tokens

**Files:**
- `src/managers/chat-history-manager.ts`: 1,957 lines
- Recent fixes: c5ef73e "Fix thinking/reasoning persistence, error recovery, and multi-turn verification"

**Why fragile:**
- Thinking content must be persisted separately from regular message content
- Providers have different reasoning field names (thinking vs reasoning_text)
- Restoring a chat must properly reconstruct thinking blocks for each message
- Attachment content blocks must also be restored

**Safe modification:**
1. Add dedicated thinking/reasoning block serialization format
2. Test restore with various thinking levels (low, medium, high)
3. Validate that thinking tokens are correctly re-counted on restore

**Test coverage:**
- No specific tests for thinking token persistence
- No tests for attachment restoration

---

## Missing Critical Features

### No Automatic Summary Generation

**Issue:** Chat summaries are not generated. Related to broader summary system breakdown (see Tech Debt section).

**Impact:** Users cannot search chat history by content. Long-running ablations generate hundreds of chats with no way to know what each one tested.

---

## Test Coverage Gaps

### Zero Unit Tests in Main Source

**Files:** None found matching `src/**/*.test.ts` or `src/**/*.spec.ts`

**Untested areas:**
- `src/core/tool-executor.ts`: Tool argument coercion, schema validation, tool execution error handling
- `src/managers/ablation-manager.ts`: State transitions, phase execution, output clearing
- `src/managers/hook-manager.ts`: Hook lifecycle, timing, interaction with pause/resume
- `src/managers/chat-history-manager.ts`: Summary creation, attachment persistence, thinking token handling
- `src/cli/ablation-cli.ts`: Run state machine, tool filtering, batch queue, pause-resume, hook execution
- `src/providers/*.ts`: Token parsing (especially provider-specific fields), cost calculation, message format validation

**Risk:** High-impact bugs in core logic go undetected until production use in ablations.

**Priority:** High. At minimum, add tests for:
1. Tool execution edge cases (type coercion, schema validation, error handling)
2. Ablation state transitions and restore scenarios
3. Hook execution order and timing
4. Token tracking across all providers

---

## Scaling Limits

### Ablation Runs Store Full Chat History in JSON

**Issue:** Each ablation iteration saves full chat.json with all messages, tokens, and metadata. For long-running studies (100+ iterations, 20+ turns per iteration), this becomes storage-heavy.

**Files:**
- `src/managers/chat-history-manager.ts`: saveCurrentSession, all chat persistence
- `.mcp-client-data/ablations/runs/`: Each run accumulates chats

**Current capacity:** No explicit limits. Disk space is the only constraint.

**Scaling path:**
- Implement log rotation or compression for old chats
- Add option to store chat metadata separately from full chat content
- Add archival mode (move old chats to compressed archive)

---

### Large Ablation Definitions Can Exceed Memory

**Issue:** Ablation definitions with many phases, models, and parameter combinations are loaded entirely into memory. No streaming or lazy-loading of phase definitions.

**Files:**
- `src/managers/ablation-manager.ts`: AblationDefinition interface and loading
- `src/cli/ablation-cli.ts`: Ablation enumeration and display (handleAblationList, handleAblationCreate)

**Scaling path:**
- Implement lazy loading of large ablation definitions
- Stream phase enumeration instead of pre-computing all combinations

---

## Dependencies at Risk

### Large JavaScript Bundle in Node Modules

**Issue:** Package lock contains 234 subdirectories of node_modules, likely including test dependencies, reference repos, and unused transitive dependencies.

**Files:**
- `node_modules/` (234 directories)
- `package-lock.json` (158 KB)

**Impact:** Slow installation, large disk footprint, increased security surface.

**Mitigation:** Run `npm prune --production` and audit with `npm audit`. Consider using npm workspaces or monorepo to separate dev dependencies.

---

### Reference Repos Checked Into VCS

**Issue:** `reference-repos/` directory contains full git histories of external projects (mcp-ui, mcp-chat, mcp-client-chatbot, open-mcp-client, multi-llm-ts, models.dev). This increases git clone time and disk usage.

**Files:**
- `reference-repos/`: 12 directories, full source + .git folders

**Impact:** Clone time is slow. Disk space is wasted. Hard to update references without conflicts.

**Mitigation:** Move reference repos to a separate artifact storage or document them in a manifest file with git URLs instead.

---

## Architectural Issues

### Error Recovery is Inconsistent

**Files:**
- `src/index.ts`: Lines 169-171, 282-283, 377-379, 452-455, 544-545, 557, 563, 580-593, 814-815, 859-860, 876-877, 883-936

**Pattern:** Some errors are caught and logged with context, some are re-thrown, some are silently ignored with `.catch(() => {})`.

**Issue:** No consistent strategy:
- MCP server connection errors push to array and continue (line 452-455)
- Config read errors return false and continue (line 815, 860)
- Server kill errors are logged with "process already terminated" message (line 585)
- IPC server startup failure is a warning, not an error (line 379)
- Cleanup errors are silently ignored (line 544-545, 684-685, 876-877)

**Impact:** Hard to reason about failure modes. Some failures are recoverable, others are silent data loss.

**Fix approach:** Define error severity levels:
- CRITICAL: Log and exit immediately (e.g., no servers connected)
- WARNING: Log but continue (e.g., optional service unavailable)
- DEBUG: Only log if verbose mode
Apply consistently across all error handlers.

---

### Hard-Coded Config Path

**Files:**
- `src/index.ts`: Line 73 (`CONFIG_DIR = join(__dirname, '..', '.mcp-client-data')`)

**Impact:** Configuration is always stored relative to the installation directory. Cannot be customized for different deployment environments or shared data stores.

**Fix approach:** Make CONFIG_DIR configurable via environment variable (e.g., `MCP_CLIENT_DATA_DIR`), falling back to `./.mcp-client-data` if not set.

---

## Summary: Priority Order for Resolution

1. **Critical (unblock functionality):**
   - Hard-exit on invalid MCP config (src/cli/ablation-cli.ts:3930)
   - Fix summary system (chat-history-manager, 9 TODOs across files)

2. **High (prevent data loss / incorrect results):**
   - Add JSON schema validation for tool arguments (tool-executor.ts)
   - Fix token tracking consistency across providers
   - Add ablation state restoration validation

3. **Medium (improve reliability):**
   - Break ablation-cli.ts into smaller modules
   - Add unit tests for core logic
   - Implement consistent error handling strategy

4. **Low (optimize, clean up):**
   - Remove reference-repos from VCS
   - Prune node_modules
   - Add log scrubbing for credentials
   - Make CONFIG_DIR configurable

---

*Concerns audit: 2026-05-02*
