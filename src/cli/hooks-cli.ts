// Reference: Follows patterns from src/cli/tool-cli.ts

/**
 * CLI operations for client-side hook management.
 */

import readline from 'readline/promises';
import { MCPClient } from '../index.js';
import { Logger } from '../logger.js';
import type { HookManager, ClientHook } from '../managers/hook-manager.js';

/**
 * Handles CLI operations for hook listing, adding, removing, enabling, and disabling.
 */
export class HooksCLI {
  private client: MCPClient;
  private logger: Logger;
  private getReadline: () => readline.Interface | null;

  constructor(
    client: MCPClient,
    logger: Logger,
    getReadline: () => readline.Interface | null,
  ) {
    this.client = client;
    this.logger = logger;
    this.getReadline = getReadline;
  }

  private getHookManager(): HookManager {
    return this.client.getHookManager();
  }

  /**
   * List all configured hooks with their status.
   */
  async handleHooksList(): Promise<void> {
    const hooks = this.getHookManager().listHooks();

    if (hooks.length === 0) {
      this.logger.log('\nNo hooks configured. Use /hooks-add to create one.\n\n');
      return;
    }

    this.logger.log('\nClient Hooks:\n');
    for (const hook of hooks) {
      const status = hook.enabled ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const trigger = hook.before ? `before: ${hook.before}` : `after: ${hook.after}`;
      const whenInputStr = hook.whenInput ? ` whenInput: ${JSON.stringify(hook.whenInput)}` : '';
      const whenOutputStr = hook.whenOutput ? ` whenOutput: ${JSON.stringify(hook.whenOutput)}` : '';
      const desc = hook.description ? ` — ${hook.description}` : '';
      this.logger.log(`  ${status} [${hook.id}] ${trigger}${whenInputStr}${whenOutputStr}\n`);
      this.logger.log(`    → ${hook.run}${desc}\n`);
    }
    this.logger.log('\n');
  }

  /**
   * Interactive wizard to add a new hook.
   */
  async handleHooksAdd(): Promise<void> {
    const rl = this.getReadline();
    if (!rl) {
      this.logger.log('No readline interface available.\n', { type: 'error' });
      return;
    }

    try {
      // Trigger type
      const triggerType = await rl.question('Trigger type (after/before) [after]: ');
      const type = triggerType.trim().toLowerCase() === 'before' ? 'before' : 'after';

      // Tool name
      const toolName = await rl.question('Tool name to trigger on (e.g. ros-mcp-server__signal_phase_complete): ');
      if (!toolName.trim()) {
        this.logger.log('Tool name is required.\n', { type: 'warning' });
        return;
      }

      // Condition (optional)
      let whenInput: Record<string, unknown> | undefined;
      let whenOutput: Record<string, unknown> | undefined;
      if (type === 'after') {
        const condType = (await rl.question('Add condition? (1=output, 2=input, Enter=none): ')).trim().toLowerCase();
        if (condType === '1' || condType === 'output') {
          const jsonStr = await rl.question('whenOutput JSON (e.g. {"status":"success"}): ');
          if (jsonStr.trim()) {
            try { whenOutput = JSON.parse(jsonStr.trim()); } catch {
              this.logger.log('Invalid JSON. Skipping.\n', { type: 'warning' });
            }
          }
        } else if (condType === '2' || condType === 'input') {
          const jsonStr = await rl.question('whenInput JSON (e.g. {"phase":1}): ');
          if (jsonStr.trim()) {
            try { whenInput = JSON.parse(jsonStr.trim()); } catch {
              this.logger.log('Invalid JSON. Skipping.\n', { type: 'warning' });
            }
          }
        }
      }

      // Run command
      const run = await rl.question('Run command (e.g. @tool-exec:isaac-sim__randomize_object_poses()): ');
      if (!run.trim()) {
        this.logger.log('Run command is required.\n', { type: 'warning' });
        return;
      }

      // Description (optional)
      const description = await rl.question('Description (optional, press Enter to skip): ');

      const hookDef: Omit<ClientHook, 'id'> = {
        run: run.trim(),
        enabled: true,
        ...(type === 'after' ? { after: toolName.trim() } : { before: toolName.trim() }),
        ...(whenInput && { whenInput }),
        ...(whenOutput && { whenOutput }),
        ...(description.trim() && { description: description.trim() }),
      };

      const newHook = this.getHookManager().addHook(hookDef);
      this.logger.log(`\nHook added: [${newHook.id}]\n\n`);
    } catch (error) {
      // Readline closed or user cancelled
    }
  }

  /**
   * Remove a hook by ID (or prefix match).
   */
  async handleHooksRemove(args: string): Promise<void> {
    const id = args.trim();
    if (!id) {
      this.logger.log('Usage: /hooks-remove <id>\n', { type: 'warning' });
      return;
    }

    const success = this.getHookManager().removeHook(id);
    if (success) {
      this.logger.log(`Hook removed: ${id}\n`);
    } else {
      this.logger.log(`Hook not found: ${id}\n`, { type: 'warning' });
    }
  }

  /**
   * Enable a hook by ID.
   */
  async handleHooksEnable(args: string): Promise<void> {
    const id = args.trim();
    if (!id) {
      this.logger.log('Usage: /hooks-enable <id>\n', { type: 'warning' });
      return;
    }

    const success = this.getHookManager().enableHook(id);
    if (success) {
      this.logger.log(`Hook enabled: ${id}\n`);
    } else {
      this.logger.log(`Hook not found: ${id}\n`, { type: 'warning' });
    }
  }

  /**
   * Disable a hook by ID.
   */
  async handleHooksDisable(args: string): Promise<void> {
    const id = args.trim();
    if (!id) {
      this.logger.log('Usage: /hooks-disable <id>\n', { type: 'warning' });
      return;
    }

    const success = this.getHookManager().disableHook(id);
    if (success) {
      this.logger.log(`Hook disabled: ${id}\n`);
    } else {
      this.logger.log(`Hook not found: ${id}\n`, { type: 'warning' });
    }
  }

  /**
   * Reload hooks from disk.
   */
  async handleHooksReload(): Promise<void> {
    this.getHookManager().loadHooks();
    const count = this.getHookManager().listHooks().length;
    this.logger.log(`Hooks reloaded: ${count} hook(s) loaded.\n`);
  }
}
