// Reference: regression test for thinking/reasoning display across providers
// Usage: npx tsx scripts/test-thinking.ts [provider] [model] [level]
//   provider: anthropic | openai | google | xai  (default: all reasoning-capable)
//   model:    override model name                 (default: provider default)
//   level:    provider-specific level             (default: provider default)
//
// Provider defaults:
//   anthropic  → claude-sonnet-4-5-20250514  level: small  (budget_tokens: 5000)
//   openai     → gpt-5-mini                  level: low    (reasoning_effort)
//   google     → gemini-2.5-flash            level: dynamic (model chooses)
//   xai        → grok-3-mini-fast            level: low    (reasoning_effort)
//
// Examples:
//   npx tsx scripts/test-thinking.ts                          # test all providers
//   npx tsx scripts/test-thinking.ts anthropic                # test anthropic only
//   npx tsx scripts/test-thinking.ts anthropic claude-haiku-4-5-20251001 large
//   npx tsx scripts/test-thinking.ts google gemini-2.5-flash generous

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(import.meta.dirname || '.', '..', '.env') });

import { initModelsDevCache } from '../src/utils/models-dev.js';
import { isReasoningModel } from '../src/utils/model-capabilities.js';

const PROVIDER_DEFAULTS: Record<string, { model: string; level: string }> = {
  anthropic: { model: 'claude-sonnet-4-5-20250514', level: 'small' },
  openai:    { model: 'gpt-5-mini',                 level: 'low' },
  google:    { model: 'gemini-2.5-flash',            level: 'dynamic' },
  xai:       { model: 'grok-3-mini-fast',            level: 'low' },
};

async function createProvider(providerName: string): Promise<any> {
  switch (providerName) {
    case 'anthropic': {
      const { AnthropicProvider } = await import('../src/providers/anthropic.js');
      return new AnthropicProvider();
    }
    case 'openai': {
      const { OpenAIProvider } = await import('../src/providers/openai.js');
      return new OpenAIProvider();
    }
    case 'google': {
      const { GeminiProvider } = await import('../src/providers/google.js');
      return new GeminiProvider();
    }
    case 'xai': {
      const { GrokProvider } = await import('../src/providers/xai.js');
      return new GrokProvider();
    }
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}

async function testProvider(providerName: string, model: string, level: string) {
  const reasoning = isReasoningModel(model, providerName);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Provider:    ${providerName}`);
  console.log(`  Model:       ${model}`);
  console.log(`  Level:       ${level}`);
  console.log(`  isReasoning: ${reasoning}`);
  console.log('='.repeat(60));

  const provider = await createProvider(providerName);
  provider.setThinkingConfig({ enabled: true, model, level });

  const messages = [{ role: 'user', content: 'What is 2+2? Answer in one word.' }];

  let hasThinking = false;
  let hasText = false;
  let thinkingContent = '';
  let textContent = '';
  let eventTypes: string[] = [];

  // Use createMessageStreamWithToolUse (the CLI path) if available, else createMessageStream
  const dummyToolExecutor = async (_name: string, _input: any) => ({
    displayText: '', contentBlocks: [{ type: 'text', text: '' }], hasImages: false,
  });

  // Anthropic requires budget_tokens < max_tokens; use 32000 to cover 'large' (25000)
  const maxTokens = 32000;

  try {
    const useToolUse = !!provider.createMessageStreamWithToolUse;
    console.log(`  Using: ${useToolUse ? 'createMessageStreamWithToolUse' : 'createMessageStream'}`);
    const stream = useToolUse
      ? provider.createMessageStreamWithToolUse(messages, model, [], maxTokens, dummyToolExecutor, 1)
      : provider.createMessageStream(messages, model, [], maxTokens);
    for await (const event of stream) {
      const tag = event.type + (event.delta?.type ? `:${event.delta.type}` : '');
      if (!eventTypes.includes(tag)) eventTypes.push(tag);

      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'thinking_delta') {
          hasThinking = true;
          thinkingContent += event.delta.thinking;
        } else if (event.delta?.type === 'text_delta') {
          hasText = true;
          textContent += event.delta.text;
        }
      }
    }

    console.log(`\n  Event types seen: ${eventTypes.join(', ')}`);
    console.log(`  Thinking received: ${hasThinking ? 'YES ✓' : 'NO ✗'}`);
    if (hasThinking) {
      const preview = thinkingContent.replace(/\n/g, ' ').slice(0, 120);
      console.log(`  Thinking preview:  "${preview}${thinkingContent.length > 120 ? '...' : ''}"`);
      console.log(`  Thinking length:   ${thinkingContent.length} chars`);
    }
    console.log(`  Text received:     ${hasText ? 'YES ✓' : 'NO ✗'}`);
    if (hasText) {
      console.log(`  Text content:      "${textContent.trim()}"`);
    }
    console.log(`\n  RESULT: ${hasThinking ? '✓ PASS — thinking content displayed' : '✗ FAIL — no thinking content received'}`);
    return hasThinking;
  } catch (err: any) {
    const errMsg = err.message?.slice(0, 300) || String(err);
    console.log(`\n  Error: ${errMsg}`);

    // Detect thinking-related errors (same patterns as the fallback in index.ts)
    const msg = (err.message || '').toLowerCase();
    const patterns = ['budget_tokens', 'thinking', 'reasoning', 'extended_thinking', 'thinkingbudget', 'includethoughts'];
    const triggers = ['not supported', 'invalid_request', 'invalid', 'unsupported', 'unknown'];
    const isThinkingErr = patterns.some(p => msg.includes(p)) && triggers.some(t => msg.includes(t));

    if (isThinkingErr) {
      console.log(`\n  RESULT: ⚠ EXPECTED — thinking error detected (fallback would auto-disable and retry in CLI)`);
      return 'fallback';
    } else {
      console.log(`\n  RESULT: ✗ UNEXPECTED ERROR`);
      return false;
    }
  }
}

async function main() {
  // Initialize models-dev cache so isReasoningModel() works correctly
  await initModelsDevCache();

  const [, , argProvider, argModel, argLevel] = process.argv;

  // Determine which providers to test
  const providers = argProvider
    ? [argProvider]
    : Object.keys(PROVIDER_DEFAULTS);

  const results: Record<string, any> = {};

  for (const prov of providers) {
    const defaults = PROVIDER_DEFAULTS[prov];
    if (!defaults) {
      console.log(`\nSkipping ${prov}: no defaults configured`);
      continue;
    }
    const model = argModel || defaults.model;
    const level = argLevel || defaults.level;
    results[`${prov}/${model}`] = await testProvider(prov, model, level);
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('  SUMMARY');
  console.log('='.repeat(60));
  for (const [key, result] of Object.entries(results)) {
    const icon = result === true ? '✓' : result === 'fallback' ? '⚠' : '✗';
    const label = result === true ? 'PASS' : result === 'fallback' ? 'FALLBACK OK' : 'FAIL';
    console.log(`  ${icon} ${key}: ${label}`);
  }
}

main().catch(console.error);
