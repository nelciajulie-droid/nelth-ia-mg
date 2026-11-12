import { $ } from 'bun';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Nelth-AI Documents — build du bundle autonome (JS + CSS).
 *
 *   JS : bun build src/documents-app/main.tsx → public/static/documents/main.js
 *   CSS: @tailwindcss/cli v4 → public/static/documents/app.css
 *        puis POST-PROCESS « scoping » (même approche que build-images.ts —
 *        voir le commentaire scoping ci-dessous).
 *
 * Les artefacts sont committés (même approche que loader.js) : aucun
 * prérequis de build au déploiement Vercel.
 */

console.log('[documents] building JS bundle…');
await Bun.build({
  entrypoints: ['src/documents-app/main.tsx'],
  outdir: 'public/static/documents',
  target: 'browser',
  minify: true,
  naming: '[name].[ext]',
});
console.log('[documents] main.js ✓');

console.log('[documents] building CSS…');
await $`./node_modules/.bin/tailwindcss -i src/documents-app/app.css -o public/static/documents/app.css --minify`;
console.log('[documents] app.css ✓');

// ---------------------------------------------------------------------------
// SCOPING — cloisonnement du CSS du bundle à sa zone de montage.
//
// Même protection que le bundle Images (voir scripts/build-images.ts) : le
// SPA hôte maintient la géométrie du shell via une cascade fragile — les
// utilitaires génériques du bundle (chargés plus tard, même layer, même
// spécificité) prendraient le dessus sur les variantes md: de l'hôte. Chaque
// règle des layers à classes génériques (utilities / components) est donc
// préfixée par la zone de montage — #nelth-documents-overlay — pour qu'elle
// ne puisse plus JAMAIS matcher un élément du shell hôte. Les layers
// preflight/thème restent globaux. `:root` du fichier source reste lui aussi
// global (jetons --docs-* — espace de noms propre).
// ---------------------------------------------------------------------------

const OVERLAY_SCOPE = '#nelth-documents-overlay';
const SCOPED_LAYERS = new Set(['utilities', 'components']);

/** Un guillemet/une apostrophe est-il PROTÉGÉ par un (nombre impair de) backslash(s) ? */
function isEscapedAt(s: string, j: number): boolean {
  let backslashes = 0;
  let k = j - 1;
  while (k >= 0 && s[k] === '\\') {
    backslashes++;
    k--;
  }
  return backslashes % 2 === 1;
}

/** Découpe un bloc CSS en sélecteurs/composants au niveau supérieur. */
function splitTopLevel(block: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (isEscapedAt(block, i)) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        parts.push(block.slice(start, i + 1));
        start = i + 1;
      }
    }
  }
  if (start < block.length) {
    const tail = block.slice(start).trim();
    if (tail) parts.push(tail);
  }
  return parts.filter(Boolean);
}

/** Préfixe les sélecteurs d'une règle par le scope (l'élément scopé lui-même inclus). */
function scopeSelector(selector: string, scope: string): string {
  return selector
    .split(',')
    .map((sel) => {
      const s = sel.trim();
      if (!s) return s;
      // @-rules internes (media/print…) : les règles internes sont re-scopées
      // par l'appelant ; le préambule reste tel quel.
      if (s.startsWith('@')) return s;
      if (s === ':root' || s.startsWith('html') || s.startsWith('body')) {
        return s === ':root' || s === 'html' || s === 'body' ? s : `${scope} ${s}`;
      }
      if (s === '&') return scope;
      return `${scope} ${s}`;
    })
    .filter(Boolean)
    .join(', ');
}

/** Scoping récursif d'un bloc (règles @media incluses). */
function scopeBlock(block: string, scope: string): string {
  const m = block.match(/^(@[^{;]+)([\s\S]*)$/);
  if (m && /^@(media|supports|container)/.test(m[1])) {
    return m[1] + scopeInner(m[2], scope);
  }
  if (m && /^@(keyframes|font-face|property|layer)/.test(m[1])) {
    return block; // globaux par nature
  }
  const idx = block.indexOf('{');
  if (idx === -1) return block;
  const selector = block.slice(0, idx).trim();
  const body = block.slice(idx);
  return `${scopeSelector(selector, scope)} ${body}`;
}

function scopeInner(inner: string, scope: string): string {
  return splitTopLevel(inner.replace(/^\{/, '').replace(/\}$/, '')).reduce((acc, part) => {
    return acc + scopeBlock(part, scope);
  }, '{') + '}';
}

function scopeLayerContents(layerName: string, contents: string, scope: string): string {
  return `@layer ${layerName}${scopeInner(contents, scope)}`;
}

// --- Parsing minimaliste du CSS compilé (structure Tailwind v4) ---
const css = readFileSync('public/static/documents/app.css', 'utf8');
let out = '';
let i = 0;
while (i < css.length) {
  // Layer statement : @layer utilities { … }
  const layerMatch = /^@layer\s+([a-z-]+)\s*\{/i.exec(css.slice(i));
  if (layerMatch) {
    const name = layerMatch[1];
    // Trouver l'accolade fermante du layer (comptage de profondeur).
    let depth = 0;
    let j = i + layerMatch[0].length - 1;
    let end = -1;
    for (; j < css.length; j++) {
      const ch = css[j];
      if (isEscapedAt(css, j)) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) {
      out += css.slice(i);
      break;
    }
    const contents = css.slice(i + layerMatch[0].length, end);
    out += SCOPED_LAYERS.has(name)
      ? scopeLayerContents(name, contents, OVERLAY_SCOPE)
      : css.slice(i, end + 1);
    i = end + 1;
    continue;
  }
  // Règle hors layer.
  // NB : recherche à partir de i + 1 (comme build-images.ts) — sinon un
  // STATEMENT de layer nu (« @layer components; » émis par Tailwind v4
  // minifié) se retrouve lui-même comme prochain candidat : chunk vide,
  // i n'avance plus → boucle infinie.
  const nextLayer = css.indexOf('@layer', i + 1);
  const stop = nextLayer === -1 ? css.length : nextLayer;
  const chunk = css.slice(i, stop);
  const parts = splitTopLevel(chunk);
  for (const part of parts) {
    const idx = part.indexOf('{');
    const head = idx === -1 ? part : part.slice(0, idx);
    const isStatement = /^@(import|charset|custom-variant|theme|plugin|config|tailwind)/i.test(head.trim());
    if (isStatement || !head.trim()) out += part;
    else {
      // Les règles @media hors layer (dark custom-variant déjà inline par TW4).
      out += scopeBlock(part, OVERLAY_SCOPE);
    }
  }
  i = stop;
}

writeFileSync('public/static/documents/app.css', out);
console.log('[documents] CSS scoped to', OVERLAY_SCOPE, '✓');
