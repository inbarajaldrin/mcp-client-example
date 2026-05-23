// Verify whether Anthropic SDK 0.98's partial JSON parser still corrupts
// scientific-notation numbers in tool call arguments (e.g. 1e-6 → 16).
//
// Workaround at src/providers/anthropic.ts:541-549 (`rawToolInputJsonBuffers`)
// was added because SDK 0.32.x's partialParse couldn't handle exponents.
// If this test shows SDK-parsed args match the raw stream, workaround is obsolete.
//
// Usage:
//   set -a && source .env && set +a && npx tsx scripts/test-anthropic-scientific-json.ts

import { Anthropic } from '@anthropic-ai/sdk';

async function main() {
  const client = new Anthropic();

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: [{
      name: 'record_measurement',
      description: 'Record a scientific measurement with a small floating-point value.',
      input_schema: {
        type: 'object',
        properties: {
          tiny_value: {
            type: 'number',
            description: 'A very small floating-point number in scientific notation (e.g. 1e-6, 2.5e-9).',
          },
          unit: { type: 'string', description: 'Unit of measurement' },
        },
        required: ['tiny_value', 'unit'],
      },
    }],
    messages: [{
      role: 'user',
      content: 'Record a measurement of exactly 1.5e-7 meters using the record_measurement tool. Use scientific notation in your tool call. Be precise.',
    }],
  });

  // Accumulate raw JSON deltas (mirrors anthropic.ts:541-549)
  const rawByIdx: Record<number, string> = {};
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'input_json_delta') {
      rawByIdx[chunk.index] = (rawByIdx[chunk.index] || '') + chunk.delta.partial_json;
    }
  }

  const final = await stream.finalMessage();

  console.log('Content blocks:');
  let toolUseFound = false;
  for (const [i, block] of final.content.entries()) {
    if (block.type === 'tool_use') {
      toolUseFound = true;
      const raw = rawByIdx[i] || '<no raw captured>';
      console.log(`\nBlock ${i} (tool_use):`);
      console.log(`  Tool name:      ${block.name}`);
      console.log(`  SDK-parsed:     ${JSON.stringify(block.input)}`);
      console.log(`  Raw stream:     ${raw}`);

      // Try to parse the raw and compare
      try {
        const rawParsed = JSON.parse(raw);
        const sdkVal = (block.input as any)?.tiny_value;
        const rawVal = rawParsed?.tiny_value;
        const match = sdkVal === rawVal;
        console.log(`  SDK tiny_value: ${sdkVal} (typeof ${typeof sdkVal})`);
        console.log(`  Raw tiny_value: ${rawVal} (typeof ${typeof rawVal})`);
        console.log(`  Match:          ${match ? '✓' : '✗'}`);
        console.log('\n' + '='.repeat(60));
        console.log(`VERDICT: ${match ? '✓ SDK preserves scientific notation → workaround can be DELETED' : '✗ SDK corrupts scientific notation → workaround STILL NEEDED'}`);
      } catch (e) {
        console.log(`  Raw JSON parse failed: ${(e as Error).message}`);
        console.log('\nVERDICT: ✗ Cannot compare (raw JSON unparseable)');
      }
    }
  }

  if (!toolUseFound) {
    console.log('\n⚠ Model did not call the tool. Run again or rephrase prompt.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
