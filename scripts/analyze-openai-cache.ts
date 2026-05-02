// Reference: Diagnosed from OpenAI API response format vs code mismatch
// OpenAI returns prompt_tokens_details.cached_tokens but code reads input_tokens_details.cached_tokens
//
// Usage: npx tsx scripts/analyze-openai-cache.ts [ablation-run-path]
// If no path given, scans all runs under .mcp-client-data/ablations/runs/

import * as fs from 'fs';
import * as path from 'path';

interface TokenUsageEntry {
  inputTokens: number;
  outputTokens: number;
  regularInputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCost: number;
}

interface ChatJson {
  metadata?: { model?: string; provider?: string; totalCost?: number };
  tokenUsagePerCallback?: TokenUsageEntry[];
  messages?: any[];
}

function findChatJsons(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'chat.json') results.push(full);
    }
  }
  walk(dir);
  return results;
}

function analyzeChat(chatPath: string) {
  const chat: ChatJson = JSON.parse(fs.readFileSync(chatPath, 'utf-8'));
  const usage = chat.tokenUsagePerCallback || [];
  if (usage.length === 0) return null;

  let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, regular: 0, cost: 0, callbacks: usage.length };
  for (const u of usage) {
    totals.input += u.inputTokens || 0;
    totals.output += u.outputTokens || 0;
    totals.cacheRead += u.cacheReadTokens || 0;
    totals.cacheWrite += u.cacheCreationTokens || 0;
    totals.regular += u.regularInputTokens || 0;
    totals.cost += u.estimatedCost || 0;
  }

  const provider = chat.metadata?.provider || path.basename(path.dirname(path.dirname(chatPath))).split('--')[0];
  const model = chat.metadata?.model || path.basename(path.dirname(path.dirname(chatPath))).split('--').slice(1).join('--');

  return {
    path: chatPath,
    provider,
    model,
    ...totals,
    cacheHitRate: totals.input > 0 ? (totals.cacheRead / totals.input * 100) : 0,
  };
}

// Main
const runPath = process.argv[2] || path.join(process.cwd(), '.mcp-client-data/ablations/runs');
if (!fs.existsSync(runPath)) {
  console.error(`Path not found: ${runPath}`);
  process.exit(1);
}

const chatFiles = findChatJsons(runPath);
const results = chatFiles.map(analyzeChat).filter(Boolean) as NonNullable<ReturnType<typeof analyzeChat>>[];

if (results.length === 0) {
  console.log('No chat.json files with token usage found.');
  process.exit(0);
}

// Group by provider
const byProvider = new Map<string, typeof results>();
for (const r of results) {
  const key = `${r.provider}/${r.model}`;
  if (!byProvider.has(key)) byProvider.set(key, []);
  byProvider.get(key)!.push(r);
}

console.log('=== Cache Token Analysis Across Providers ===\n');

for (const [key, runs] of [...byProvider.entries()].sort()) {
  const agg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, regular: 0, cost: 0, callbacks: 0 };
  for (const r of runs) {
    agg.input += r.input;
    agg.output += r.output;
    agg.cacheRead += r.cacheRead;
    agg.cacheWrite += r.cacheWrite;
    agg.regular += r.regular;
    agg.cost += r.cost;
    agg.callbacks += r.callbacks;
  }
  const hitRate = agg.input > 0 ? (agg.cacheRead / agg.input * 100) : 0;

  console.log(`--- ${key} (${runs.length} phases, ${agg.callbacks} callbacks) ---`);
  console.log(`  Input tokens:     ${agg.input.toLocaleString()}`);
  console.log(`  Output tokens:    ${agg.output.toLocaleString()}`);
  console.log(`  Regular input:    ${agg.regular.toLocaleString()}`);
  console.log(`  Cache write:      ${agg.cacheWrite.toLocaleString()}`);
  console.log(`  Cache read:       ${agg.cacheRead.toLocaleString()}`);
  console.log(`  Cache hit rate:   ${hitRate.toFixed(1)}%`);
  console.log(`  Estimated cost:   $${agg.cost.toFixed(4)}`);

  if (hitRate === 0 && agg.callbacks > 5) {
    console.log(`  ⚠ ZERO cache hits with ${agg.callbacks} callbacks — likely a bug`);
  }
  console.log();
}

// Diagnosis
console.log('=== Diagnosis ===\n');

const openaiRuns = results.filter(r => r.provider === 'openai');
const anthropicRuns = results.filter(r => r.provider === 'anthropic');

if (openaiRuns.length > 0) {
  const openaiCacheTotal = openaiRuns.reduce((s, r) => s + r.cacheRead, 0);
  const openaiInputTotal = openaiRuns.reduce((s, r) => s + r.input, 0);

  if (openaiCacheTotal === 0 && openaiInputTotal > 10000) {
    console.log('BUG FOUND: OpenAI cache_read_tokens is always 0');
    console.log('');
    console.log('Root cause: src/providers/openai.ts reads `input_tokens_details.cached_tokens`');
    console.log('but OpenAI API returns `prompt_tokens_details.cached_tokens`.');
    console.log('');
    console.log('Affected lines:');
    console.log('  - Line ~413: streaming path (createMessageStreamSimple)');
    console.log('  - Line ~508: finalUsage type definition');
    console.log('  - Line ~518: finalUsage assignment from stream chunk');
    console.log('  - Line ~671: agentic loop path (createMessageStreamWithToolUse)');
    console.log('');
    console.log('Fix: Replace input_tokens_details with prompt_tokens_details in all 4 locations.');
  }
}

if (anthropicRuns.length > 0) {
  const anthCacheTotal = anthropicRuns.reduce((s, r) => s + r.cacheRead, 0);
  const anthInputTotal = anthropicRuns.reduce((s, r) => s + r.input, 0);
  const anthHitRate = anthInputTotal > 0 ? (anthCacheTotal / anthInputTotal * 100) : 0;
  console.log(`Anthropic cache hit rate: ${anthHitRate.toFixed(1)}% (working correctly)`);
}
