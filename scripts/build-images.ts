import { $ } from 'bun';

/**
 * Nelth-IA Images — build du bundle autonome (JS + CSS).
 *
 *   JS : bun build src/images-app/main.tsx → public/static/images/main.js
 *   CSS: @tailwindcss/cli v4 → public/static/images/app.css
 *
 * Les artefacts sont committés (même approche que loader.js) : aucun
 * prérequis de build au déploiement Vercel.
 */

console.log('[images] building JS bundle…');
await Bun.build({
  entrypoints: ['src/images-app/main.tsx'],
  outdir: 'public/static/images',
  target: 'browser',
  minify: true,
  naming: '[name].[ext]',
});
console.log('[images] main.js ✓');

console.log('[images] building CSS…');
await $`./node_modules/.bin/tailwindcss -i src/images-app/app.css -o public/static/images/app.css --minify`;
console.log('[images] app.css ✓');
