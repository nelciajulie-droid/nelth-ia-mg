/**
 * Standalone live test of the generateSdImage retry chain (bun test script).
 * Talks to the REAL Nelthai gateway — no DB, no chat flow.
 *
 *   bun run scripts/test-image-retry.ts
 */
import { generateSdImage } from '../src/lib/image-generation';

async function runCase(label: string, prompt: string) {
  const t0 = Date.now();
  const phases: string[] = [];
  const retries: string[] = [];
  let outcome: string;
  try {
    const img = await generateSdImage(prompt, null, {
      onPhase: (p) => phases.push(p),
      onRetry: (i, t) => retries.push(`${i + 1}/${t}`),
    });
    outcome = `SUCCESS ${img.bytes.length} bytes (${img.contentType})`;
  } catch (e) {
    outcome = `ERROR: ${(e as Error).message.slice(0, 140)}`;
  }
  console.log(`\n=== ${label} — « ${prompt} » ===`);
  console.log(`outcome : ${outcome}`);
  console.log(`phases  : ${phases.join(' → ')}`);
  console.log(`retries : ${retries.join(', ') || '(none)'}`);
  console.log(`elapsed : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// 1. Deterministic short-prompt rejection ("chat" fails bare, enriched passes)
await runCase('short-prompt-retry', 'chat');
// 2. Normal prompt (should succeed on attempt 1)
await runCase('normal-prompt', 'un chat mignon qui joue avec une pelote de laine');
// 3. Deterministically filtered subject → 3 failures → French error
await runCase('filtered-subject', 'logo');
