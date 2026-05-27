# Slice 3 — Pass A execution runbook (AblationRunner extraction)

Status: planned + GPT-reviewed (verdict sound-with-changes) + fully dependency-mapped.
Foundation committed: `2628448` (src/ablation-runner.ts — the seam contract, compiles, inert).
Live engine (src/cli/ablation-cli.ts) is UNTOUCHED and working. The switch happens only after the
runner compiles standalone and is verified — strangler-fig migration (copy → switch → verify → delete).

## Goal
Both the CLI and the web (`POST /ablations/:name/run`) call ONE engine (AblationRunner), killing the
divergent inline web loop that silently skips @escalate/@switch. Then run.start/run.abort/run.status
agent actions reflect a single engine. Verification: a real ablation run on a4500 confirms escalation +
abort behave identically on both surfaces.

## Seam (already in src/ablation-runner.ts)
- RunControl: isAbortRequested, isInterruptRequested, resetAbort, resetInterrupt, setAbortMode
- RunObserver.on(RunEvent): run-start|phase-start|command|result|escalate|switch-model|phase-complete|
  abort|continuation|progress|done|error
- RunHost (transitional): startKeyboardMonitor, stopKeyboardMonitor, collectInput, getHILManager,
  restoreIterationLimitCallback, getPendingAttachments, setPendingAttachments
- RunDeps: client, logger, ablationManager, preferencesManager, attachmentManager
- AblationRunner.run(ablation, resolvedArguments, {control, observer, host?}): Promise<boolean>

## Engine methods to move (brace-match, do NOT line-slice — methods are interleaved)
- executeAblationCommand   def @1760  (handles @complete-phase/@escalate/@switch/@abort/@tool/@shell/@wait + regular)
- runEscalationLoop        def @3464  (model cascade)
- runSingleAblation        def @3919  (ends ~5023; handleAblationDelete starts 5024 — STOP before it)

## Helper disposition (from call-site analysis)
ENGINE-ONLY → move into AblationRunner:
- savePhaseChatHistory @221      (calls only in runEscalationLoop/runSingleAblation: 3837,3861,4744,4779,4812,4851,4887)
- consumePendingHookDirectives @2564 (calls 2260,2498 in executeAblationCommand)
- displayFinalResults @3222      (call 5008 in runSingleAblation) → calls renderPhaseTable → formatTokenCount
- renderPhaseTable @3155, formatTokenCount @3147  (display sub-tree; per GPT classify by side-effect —
  ideally emit observer events, but moving verbatim w/ injected logger is acceptable for Pass A)
- displayAblationMatrix @3089    (verify it is engine-called; else leave in CLI)
- isExitCommand @482, checkExitCommand @491  (pure predicates)

SHARED (engine + staying CLI wrappers) → DUPLICATE into runner for Pass A; dedupe into a shared module in cleanup:
- createProviderInstance @1563   (engine 3520,4086,4566,4646 + wrapper 3012)
- resolvePromptReference @1577   (engine 3637,3645,4198,4323,4328,4341,4352 + other CLI 6069,6210)
- resolveResourceReference @1700 (sub-helper of resolvePromptReference, call 1591)
- findResourceOrTemplate @1668   (calls 1729 in resolveResourceReference, 1947 in executeAblationCommand)

INTERACTIVE → redesign to host/observer, do NOT move verbatim:
- handlePauseInput @273          → host.collectInput-driven; headless web policy = no-op/skip
- promptDryRunPause @310         → host.collectInput; headless = no-op
- askForceStopPrompt @3408       → host hook; headless = deterministic default (return false / don't force-stop)
- showPromptListForPreview @7440, showAttachmentListForPreview @7497 → host/observer; headless = skip

WRAPPER-ONLY → stays in CLI: loadChatCostData @5089 (call 5280 in selectRunPaginated), handleAblationRun @2613,
resolveAblationArguments @3311, parseAblationSelection @3050, handleAblationDelete @5024.

## Rewrite rules (mechanical, applied to moved code)
- this.callbacks.{isAbortRequested,isInterruptRequested,resetAbort,resetInterrupt,setAbortMode} → this.control.*
- this.callbacks.{startKeyboardMonitor,stopKeyboardMonitor,collectInput,getHILManager,
  restoreIterationLimitCallback,getPendingAttachments,setPendingAttachments} → this.host.* (NORMALIZED, see below)
- this.callbacks.getReadline → removed; interrupt input via this.host.collectInput
- this.{logger,client,ablationManager,preferencesManager,attachmentManager} → this.deps.*
- this.callbacks.setPendingContinuation() → this.observer.on({type:'continuation'})  ← THE ONE THING (see risks)
- Add observer.on(...) at run boundaries, layered on top of existing logger calls.

## GPT risk mitigations (BAKE IN)
1. CONTINUATION (highest): the CLI's RunObserver must, on {type:'continuation'}, re-invoke the SAME outer-loop
   continuation sink the old setPendingContinuation() triggered. Verify a batch scenario advances exactly once.
2. HEADLESS POLICY: normalize host at run() entry with explicit defaults — collectInput→null means SKIP not spin;
   HIL-required → fail-fast not wait; @wait → time/event-based not input-blocking; pause/dry-run-pause → no-op.
3. shouldBreak: keep runner-LOCAL. At boundaries: shouldStop = localShouldBreak || control.isAbortRequested()
   || control.isInterruptRequested(). Reset only the state you consumed.
4. Classify display helpers by SIDE EFFECT (terminal output → observer/host), not dependency list.
5. Normalize host with concrete defaults; log/emit when an unsupported headless behavior is requested.
6. Observer event ordering: emit AFTER state mutation for "happened" events, BEFORE for "intent".
7. Web parity: compare the RESOLVED run plan (args, prefs, model cascade, attachments, phase selection) web-vs-CLI
   BEFORE execution, not just outputs after.

## Sub-step ordering (keeps tsc green at every step; GPT-corrected)
1. ablation-runner.ts: add imports (join, mkdirSync, existsSync, execSync, cpSync from fs/path/child_process;
   AblationRun/AblationRunResult types; Message; any others tsc flags) + instance fields control/observer/host(normalized)
   + run() sets fields then delegates to the moved runSingleAblation.
2. Copy engine-only + shared(duplicated) helpers into AblationRunner; interactive helpers → host/observer calls.
3. Copy the 3 engine methods into AblationRunner; apply rewrite rules.
4. tsc --noEmit until the runner compiles WITH the old CLI engine still present (duplicate, not switched).  ← CHECKPOINT
5. AblationCLI.runSingleAblation → thin wrapper: build keyboard control + console observer (+ continuation adapter,
   risk #1) + real host, RunDeps, `return new AblationRunner(deps).run(...)`.
6. tsc; CLI ablation real-run verification on a4500.  ← CHECKPOINT
7. Web POST /ablations/:name/run → flag control + SSE observer + headless host; DELETE inline loop.
8. tsc; web ablation real-run verification.  ← CHECKPOINT
9. Delete the old CLI engine methods (executeAblationCommand/runEscalationLoop/runSingleAblation) — both surfaces proven.
10. Register run.start/run.abort/run.status agent actions (separate checkpoint; backed by the runner + a run-state
    field in AgentRegistry.viewState: run.study/phase/model/index/lastGateVerdict/lastError).
11. CLEANUP (optional, → Pass B): dedupe duplicated shared helpers into a shared module; retire RunHost toward the
    pure ~6-field seam.

## Verification checklist (real run, a4500)
- [ ] CLI: multi-model phase that fails escalates to next model (@escalate fires).
- [ ] Web: SAME study escalates identically (the divergence is gone).
- [ ] Abort works on both (CLI Ctrl+C; web POST /ablations/cancel).
- [ ] Batch continuation advances exactly once on CLI (risk #1).
- [ ] chat.json + run-output shapes identical to pre-refactor.
- [ ] Resolved run plan identical web-vs-CLI before execution (risk #7).
