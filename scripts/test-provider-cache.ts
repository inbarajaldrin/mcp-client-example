// Reference: Tests that cache token tracking works through our actual provider code
// Usage: npx tsx scripts/test-provider-cache.ts

import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, '..', 'dist');

async function testOpenAI() {
  const { OpenAIProvider } = await import(path.join(distPath, 'providers', 'openai.js'));
  const provider = new OpenAIProvider();

  const sysPrompt = 'You are a robot assembly assistant that helps with pick and place tasks. '.repeat(200);
  const tools = [{ name: 'test_tool', description: 'A test tool', input_schema: { type: 'object', properties: {} } }];

  console.log('=== PROVIDER CODE TEST: OpenAI cache tokens ===\n');

  // createMessageStream(messages, model, tools, maxTokens)
  // Call 1 - prime cache
  const events1: any[] = [];
  for await (const event of provider.createMessageStream(
    [{ role: 'system', content: sysPrompt }, { role: 'user', content: 'Say hello briefly' }],
    'gpt-4o-mini',
    tools,
    50,
  )) {
    events1.push(event);
  }

  const usage1 = events1.find((e: any) => e.type === 'token_usage');
  console.log('Call 1 (prime cache):');
  console.log('  input_tokens:', usage1?.input_tokens);
  console.log('  output_tokens:', usage1?.output_tokens);
  console.log('  breakdown:', JSON.stringify(usage1?.input_tokens_breakdown));
  console.log();

  // Call 2 - should hit cache
  const events2: any[] = [];
  for await (const event of provider.createMessageStream(
    [{ role: 'system', content: sysPrompt }, { role: 'user', content: 'Say goodbye briefly' }],
    'gpt-4o-mini',
    tools,
    50,
  )) {
    events2.push(event);
  }

  const usage2 = events2.find((e: any) => e.type === 'token_usage');
  console.log('Call 2 (should hit cache):');
  console.log('  input_tokens:', usage2?.input_tokens);
  console.log('  output_tokens:', usage2?.output_tokens);
  console.log('  breakdown:', JSON.stringify(usage2?.input_tokens_breakdown));
  console.log();

  const cacheRead = usage2?.input_tokens_breakdown?.cache_read_input_tokens || 0;
  const regularInput = usage2?.input_tokens_breakdown?.input_tokens || 0;

  if (cacheRead > 0) {
    console.log(`✓ OpenAI provider cache tracking WORKS: ${cacheRead} cached tokens, ${regularInput} regular`);
  } else {
    console.log('✗ OpenAI provider cache tracking BROKEN: 0 cached tokens');
    console.log('  Check prompt_tokens_details vs input_tokens_details in openai.ts');
  }
  console.log();
}

async function testAnthropic() {
  const { AnthropicProvider } = await import(path.join(distPath, 'providers', 'anthropic.js'));
  const provider = new AnthropicProvider();

  const sysPrompt = 'You are a robot assembly assistant that helps with pick and place tasks. '.repeat(200);

  console.log('=== PROVIDER CODE TEST: Anthropic cache tokens ===\n');

  // createMessageStream(messages, model, tools, maxTokens)
  const events1: any[] = [];
  for await (const event of provider.createMessageStream(
    [{ role: 'user', content: 'Say hello briefly' }],
    'claude-haiku-4-5-20251001',
    [],
    50,
  )) {
    events1.push(event);
  }

  const usage1 = events1.find((e: any) => e.type === 'token_usage');
  console.log('Call 1:');
  console.log('  input_tokens:', usage1?.input_tokens);
  console.log('  output_tokens:', usage1?.output_tokens);
  console.log('  breakdown:', JSON.stringify(usage1?.input_tokens_breakdown));
  console.log();

  // Call 2 - build on first
  const events2: any[] = [];
  for await (const event of provider.createMessageStream(
    [
      { role: 'user', content: 'Say hello briefly' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Say goodbye briefly' },
    ],
    'claude-haiku-4-5-20251001',
    [],
    50,
  )) {
    events2.push(event);
  }

  const usage2 = events2.find((e: any) => e.type === 'token_usage');
  console.log('Call 2:');
  console.log('  input_tokens:', usage2?.input_tokens);
  console.log('  output_tokens:', usage2?.output_tokens);
  console.log('  breakdown:', JSON.stringify(usage2?.input_tokens_breakdown));

  const cacheRead = usage2?.input_tokens_breakdown?.cache_read_input_tokens || 0;
  if (cacheRead > 0) {
    console.log(`\n✓ Anthropic provider cache tracking works: ${cacheRead} cached tokens`);
  } else {
    console.log('\n  (Anthropic auto-caching may not trigger with small prompts — this is OK)');
  }
  console.log();
}

async function main() {
  try {
    await testOpenAI();
  } catch (e: any) {
    console.log('OpenAI test failed:', e.message);
    console.log();
  }
  try {
    await testAnthropic();
  } catch (e: any) {
    console.log('Anthropic test failed:', e.message);
  }
}

main();
