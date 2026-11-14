import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Nelth-IA Vocal — build du bundle autonome (JS + CSS).
 *
 *   JS : bun build src/vocal-app/main.tsx → public/static/vocal/main.js
 *        (react + react-dom + @untemps/react-vocal + @untemps/vocal inlined)
 *   CSS: hand-scoped plain CSS (nvl-* classes only) copied as-is.
 *
 * Les artefacts sont committés — aucun prérequis de build au déploiement.
 */

console.log('[vocal] building JS bundle…');
await Bun.build({
  entrypoints: ['src/vocal-app/main.tsx'],
  outdir: 'public/static/vocal',
  target: 'browser',
  minify: true,
  naming: '[name].[ext]',
});
console.log('[vocal] main.js ✓');

console.log('[vocal] building CSS…');
{
  const raw = readFileSync('src/vocal-app/app.css', 'utf8');
  writeFileSync('public/static/vocal/app.css', raw.trim() + '\n');
}
console.log('[vocal] app.css ✓');
