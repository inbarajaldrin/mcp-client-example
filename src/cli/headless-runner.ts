import { readFileSync } from 'fs';
import { MCPClient } from '../index.js';
import { consoleStyles, Logger } from '../logger.js';
import type { HumanInTheLoopManager } from '../managers/hil-manager.js';
import type { PreferencesManager } from '../managers/preferences-manager.js';
import type { AblationCLI } from './ablation-cli.js';

export interface HeadlessContext {
  client: MCPClient;
  logger: Logger;
  hilManager: HumanInTheLoopManager;
  preferencesManager: PreferencesManager;
  ablationCLI: AblationCLI;
  routeSlashCommand: (cmd: string) => Promise<boolean>;
}

export async function runHeadless(scriptPath: string, ctx: HeadlessContext): Promise<void> {
  let scriptContent: string;
  try {
    scriptContent = readFileSync(scriptPath, 'utf-8');
  } catch (error) {
    console.error(`Failed to read headless script: ${scriptPath}: ${error}`);
    process.exit(1);
  }

  const lines = scriptContent
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  if (lines.length === 0) {
    console.error('Headless script is empty (no commands after filtering comments).');
    process.exit(1);
  }

  // Disable HIL for headless mode (same pattern as ablation runs)
  ctx.hilManager.setEnabled(false);
  ctx.hilManager.setApproveAllMode(true);
  ctx.preferencesManager.setHILEnabled(false);
  ctx.preferencesManager.setApproveAll(true);

  ctx.logger.log(`[headless] Running ${lines.length} command(s) from ${scriptPath}\n`, { type: 'info' });

  let commandsRun = 0;

  for (const line of lines) {
    commandsRun++;
    ctx.logger.log(`\n[headless ${commandsRun}/${lines.length}] ${line}\n`, { type: 'info' });

    try {
      if (line.startsWith('/')) {
        // Slash command — route through the shared handler first
        const handled = await ctx.routeSlashCommand(line);
        if (!handled) {
          // Session-level commands that chat_loop handles directly
          const lowerLine = line.toLowerCase();
          if (lowerLine === '/ablation-run' || lowerLine.startsWith('/ablation-run ')) {
            await ctx.ablationCLI.handleAblationRun();
          } else if (lowerLine === '/clear' || lowerLine === '/clear-context') {
            ctx.client.clearContext();
            ctx.logger.log('Context cleared.\n', { type: 'success' });
          } else {
            ctx.logger.log(`[headless] Unhandled command: ${line}\n`, { type: 'warning' });
          }
        }
      } else {
        // Regular message — process through the model
        const systemPrompt = await (ctx.client as any).prepareAndLogSystemPrompt();
        const finalQuery = systemPrompt ? `${systemPrompt}\n\nUser: ${line}` : line;

        // Log user message to chat history (same as chat_loop does)
        ctx.client.getChatHistoryManager().addUserMessage(line);

        ctx.hilManager.resetSession();
        await ctx.client.processQuery(finalQuery, false);
        ctx.logger.log('\n' + consoleStyles.separator + '\n');
      }
    } catch (error) {
      ctx.logger.log(`[headless] Error processing "${line}": ${error}\n`, { type: 'error' });
    }
  }

  // Build JSON summary from session data
  const session = ctx.client.getChatHistoryManager().getCurrentSession();
  const metadata = session?.metadata;
  const tokenCallbacks = session?.tokenUsagePerCallback || [];

  // Aggregate token breakdown across all callbacks
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  for (const cb of tokenCallbacks) {
    totalInput += cb.regularInputTokens || 0;
    totalOutput += cb.outputTokens || 0;
    totalCacheRead += cb.cacheReadTokens || 0;
    totalCacheWrite += cb.cacheCreationTokens || 0;
  }

  const summary = {
    commands: commandsRun,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
    },
    cost: metadata?.totalCost || 0,
    messages: metadata?.messageCount || 0,
  };

  // Print JSON summary with markers for easy parsing
  console.log('\n--- HEADLESS_SUMMARY_START ---');
  console.log(JSON.stringify(summary, null, 2));
  console.log('--- HEADLESS_SUMMARY_END ---');

  // Clean shutdown
  ctx.client.getChatHistoryManager().endSession('Headless script completed');
  await ctx.client.stop();
  process.exit(0);
}
