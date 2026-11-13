import { $ } from 'bun';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Nelth-IA Voice — build du bundle autonome (JS + CSS).
 *
 *   JS : bun build src/voice-app/main.tsx → public/static/voice/main.js
 *   CSS: post-processed plain CSS (scoped .vv-* classes only — no Tailwind
 *        utilities are emitted, so the host SPA cascade stays untouched;
 *        the @import "tailwindcss" line is stripped).
 *
 * Les artefacts sont committés — aucun prérequis de build au déploiement.
 */

console.log('[voice] building JS bundle…');
await Bun.build({
  entrypoints: ['src/voice-app/main.tsx'],
  outdir: 'public/static/voice',
  target: 'browser',
  minify: true,
  naming: '[name].[ext]',
});
console.log('[voice] main.js ✓');

console.log('[voice] building CSS…');
{
  const raw = readFileSync('src/voice-app/app.css', 'utf8');
  // Drop the tailwind import — the stylesheet is hand-scoped (.vv-*), so
  // the host cascade never sees competing utilities (see build-images.ts
  // history for why an unscoped bundle breaks the SPA geometry).
  const css = raw.replace('@import "tailwindcss";', '').trim() + '\n';
  writeFileSync('public/static/voice/app.css', css);
}
console.log('[voice] app.css ✓');
