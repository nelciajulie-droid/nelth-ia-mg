import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Nelth-IA Voice — build du bundle autonome (JS + CSS).
 *
 *   JS : bun build src/voice-app/main.tsx → public/static/voice/main.js
 *        (react + react-dom + @untemps/react-vocal + @untemps/vocal inlined)
 *   CSS: hand-scoped plain CSS (vv-* classes only) copied as-is.
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
  writeFileSync('public/static/voice/app.css', raw.trim() + '\n');
}
console.log('[voice] app.css ✓');
