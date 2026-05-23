// Verify: does our OpenAI Responses reasoning echo-back actually preserve
// cached reasoning state across turns?
//
// Method: run 3 turns of a continuing conversation. In each turn, measure
// the reasoning_tokens reported in the token_usage event. If echo-back works,
// turn 2 and 3 should pay materially less reasoning than turn 1 (the model
// continues from cached state instead of re-deriving).
//
// Usage:
//   set -a && source .env && set +a && npx tsx scripts/test-openai-reasoning-echo.ts

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(import.meta.dirname || '.', '..', '.env') });

import { initModelsDevCache } from '../src/utils/models-dev.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import type { Message } from '../src/model-provider.js';

async function main() {
  await initModelsDevCache();

  const provider = new OpenAIProvider();
  const model = 'gpt-5-mini';
  provider.setThinkingConfig({ enabled: true, model, level: 'medium' } as any);

  const dummyToolExecutor = async () => ({
    displayText: '', contentBlocks: [{ type: 'text' as const, text: '' }], hasImages: false,
  });

  // Continuing conversation. Each turn builds on prior context.
  // CRITICAL: we manually accumulate the assistant message after each turn
  // (with content_blocks) — agenticLoopResponses copies its input, so the
  // outer caller is responsible for preserving cross-turn state. This
  // mirrors how index.ts uses the provider (see src/index.ts around line 3366+).
  const turns = [
    'I have a list of numbers: [3, 7, 2, 8, 5]. What is their sum?',
    'Now multiply that sum by 2.',
    'Finally, subtract 10 from the result.',
  ];

  const conversation: Message[] = [];
  const reasoningPerTurn: number[] = [];
  const itemsEchoedIn: number[] = [];

  for (const [i, userMsg] of turns.entries()) {
    conversation.push({ role: 'user', content: userMsg });

    // Inspect what reasoning items are in the input we're about to send
    const reasoningItemsInInput = conversation
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => (m as any).content_blocks || [])
      .filter((b: any) => b?.type === 'reasoning').length;
    itemsEchoedIn.push(reasoningItemsInInput);

    console.log(`\n${'='.repeat(60)}\nTurn ${i + 1}: "${userMsg}"`);
    console.log('='.repeat(60));
    console.log(`Reasoning items in input:  ${reasoningItemsInInput}`);

    let thinkingPreview = '';
    let textOut = '';
    let reasoningTokens = 0;

    // We need access to the assistant message + reasoning items that agenticLoopResponses
    // accumulated internally. Instead of using the full agentic loop, use streamResponsesAPI
    // directly with a collector so we can inspect (and persist) the reasoning items ourselves.
    const collector = {
      content: '',
      toolCalls: [] as Array<{ id: string; name: string; arguments: string }>,
      reasoningItems: [] as any[],
    };
    const stream = (provider as any).streamResponsesAPI(conversation, model, [], 16000, undefined, collector);
    for await (const ev of stream as any) {
      if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'thinking_delta') thinkingPreview += ev.delta.thinking;
        else if (ev.delta?.type === 'text_delta') textOut += ev.delta.text;
      } else if (ev.type === 'token_usage') {
        reasoningTokens = ev.reasoning_tokens || 0;
      }
    }

    // Persist assistant message with reasoning items for next turn
    conversation.push({
      role: 'assistant',
      content: collector.content,
      ...(collector.reasoningItems.length > 0 && { content_blocks: collector.reasoningItems }),
    } as Message);

    reasoningPerTurn.push(reasoningTokens);
    console.log(`Thinking preview:          "${thinkingPreview.slice(0, 100).replace(/\n/g, ' ')}${thinkingPreview.length > 100 ? '...' : ''}"`);
    console.log(`Answer:                    "${textOut.trim()}"`);
    console.log(`Reasoning tokens:          ${reasoningTokens}`);
    console.log(`Reasoning items captured:  ${collector.reasoningItems.length}`);
  }

  console.log(`\n${'='.repeat(60)}\nSUMMARY — reasoning tokens per turn\n${'='.repeat(60)}`);
  const table = reasoningPerTurn.map((rt, i) => `  Turn ${i + 1}: ${rt}`).join('\n');
  console.log(table);

  const sum = reasoningPerTurn.reduce((a, b) => a + b, 0);
  const avg = sum / reasoningPerTurn.length;
  const turn1 = reasoningPerTurn[0];
  const restAvg = reasoningPerTurn.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, reasoningPerTurn.length - 1);
  console.log(`\nTotal:           ${sum}`);
  console.log(`Avg per turn:    ${avg.toFixed(0)}`);
  console.log(`Turn 1:          ${turn1}`);
  console.log(`Avg turns 2-${turns.length}:    ${restAvg.toFixed(0)}`);
  console.log(`Ratio (rest/T1): ${(restAvg / turn1).toFixed(2)}x`);

  console.log(`\nReasoning items in input per turn: [${itemsEchoedIn.join(', ')}]`);
  console.log(`  (turn 1 should be 0; turns 2+ should be > 0 if echo-back is wired correctly)\n`);

  console.log(`Interpretation:`);
  console.log(`  - "Reasoning items in input" growing across turns → echo-back is wired.`);
  console.log(`  - Reasoning tokens per turn often grows simply because the problem grows.`);
  console.log(`    The real win is that prior reasoning is REUSED, not that token count drops.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
