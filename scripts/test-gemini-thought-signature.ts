// Verify: does Gemini put `thoughtSignature` on thinking parts (not just function_call parts)?
// If yes, google.ts:810-823 is silently losing reasoning state on text-only turns.
// If no (signatures only on function_call parts), current code is correct.
//
// Usage:
//   set -a && source .env && set +a && npx tsx scripts/test-gemini-thought-signature.ts

import { GoogleGenAI } from '@google/genai';

async function main() {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });

  // Run a thinking-only turn (no tools). Use a question that should trigger reasoning.
  const stream = await client.models.generateContentStream({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: 'What is the square root of 144? Think step by step, then give the answer.' }] }],
    config: {
      thinkingConfig: {
        includeThoughts: true,
      },
    },
  });

  const allParts: any[] = [];
  for await (const chunk of stream) {
    if (chunk.candidates && chunk.candidates[0]?.content?.parts) {
      for (const part of chunk.candidates[0].content.parts) {
        allParts.push(part);
      }
    }
  }

  console.log(`Total parts seen across stream: ${allParts.length}`);
  console.log('');

  let thinkingPartsCount = 0;
  let thinkingPartsWithSig = 0;
  let textPartsCount = 0;
  let textPartsWithSig = 0;
  let fnCallParts = 0;
  let fnCallPartsWithSig = 0;

  for (const [i, part] of allParts.entries()) {
    const isThought = !!(part as any).thought;
    const hasText = typeof part.text === 'string';
    const hasFnCall = !!part.functionCall;
    const sig = (part as any).thoughtSignature;

    if (isThought) {
      thinkingPartsCount++;
      if (sig) thinkingPartsWithSig++;
    } else if (hasText) {
      textPartsCount++;
      if (sig) textPartsWithSig++;
    } else if (hasFnCall) {
      fnCallParts++;
      if (sig) fnCallPartsWithSig++;
    }

    // Print the first few of each kind for inspection
    if (i < 4 || sig) {
      const summary = isThought ? 'THINKING' : hasFnCall ? 'FN_CALL' : hasText ? 'TEXT' : 'OTHER';
      const preview = (part.text || '').slice(0, 60).replace(/\n/g, ' ');
      const sigInfo = sig ? `signature=${String(sig).slice(0, 20)}...(${String(sig).length} chars)` : 'NO signature';
      console.log(`Part ${i}: [${summary}] ${sigInfo} text="${preview}${preview.length === 60 ? '...' : ''}"`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Thinking parts:  ${thinkingPartsCount} total, ${thinkingPartsWithSig} with signature`);
  console.log(`Text parts:      ${textPartsCount} total, ${textPartsWithSig} with signature`);
  console.log(`FnCall parts:    ${fnCallParts} total, ${fnCallPartsWithSig} with signature`);
  console.log('');

  if (thinkingPartsWithSig > 0) {
    console.log('VERDICT: ✗ Reading B — Gemini puts signatures on thinking parts too.');
    console.log('  google.ts:810-823 is losing reasoning state on text-only turns. Fix needed.');
  } else if (textPartsWithSig > 0) {
    console.log('VERDICT: ⚠ Hybrid — signatures appear on plain text parts (not specifically thinking).');
    console.log('  google.ts likely needs to preserve signatures on assistant text blocks too.');
  } else {
    console.log('VERDICT: ✓ Reading A — Signatures only on function_call parts (or none in this turn).');
    console.log('  Current google.ts behavior is correct for this test case.');
    console.log('  Note: caveat — this single turn may not exercise all Gemini behaviors.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
