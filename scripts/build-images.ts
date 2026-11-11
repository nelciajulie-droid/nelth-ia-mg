import { $ } from 'bun';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Nelth-IA Images — build du bundle autonome (JS + CSS).
 *
 *   JS : bun build src/images-app/main.tsx → public/static/images/main.js
 *   CSS: @tailwindcss/cli v4 → public/static/images/app.css
 *        puis POST-PROCESS « scoping » (voir scopeLayer ci-dessous).
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

// ---------------------------------------------------------------------------
// SCOPING — cloisonnement du CSS du bundle à sa zone de montage.
//
// HISTORIQUE (bug « sidebar recouvre l'espace central ») : l'app SPA hôte
// (Open WebUI compilé) maintient la géométrie du shell par une cascade
// fragile — la colonne centrale porte `md:max-w-[calc(100%-var(--sidebar-
// width))]` DANS `@layer utilities`. Notre bundle Images émettait lui aussi
// des utilitaires génériques dans SON `@layer utilities` : chargé plus tard,
// il fusionnait dans le MÊME layer et ses copies (`.max-w-full`, `.md:…`)
// prenaient le dessus sur les variantes md: de l'hôte (même spécificité,
// ordre ultérieur) → la colonne passait pleine largeur SOUS le tiroir
// `fixed z-50` → 245 px d'espace de travail recouverts.
//
// FIX racine : chaque règle des layers à classes génériques (utilities /
// components) est préfixée par la zone de montage du bundle —
// `#nelth-images-overlay` — pour qu'elle ne puisse plus JAMAIS matcher un
// élément du shell hôte. Les layers de préflight/thème (contenu identique
// aux tokens par défaut du Tailwind de l'hôte) restent globaux.
//
// `:root` du fichier source reste lui aussi global (jetons --images-* —
// espaces de noms propres, aucun conflit de nom avec l'hôte).
// ---------------------------------------------------------------------------

const OVERLAY_SCOPE = '#nelth-images-overlay';
const SCOPED_LAYERS = new Set(['utilities', 'components']);

/** Un guillemet/une apostrophe est-il PROTÉGÉ par un (nombre impair de) backslash(s) ? */
function isEscapedAt(s: string, j: number): boolean {
  let backslashes = 0;
  let k = j - 1;
  while (k >= 0 && s[k] === '\\') {
    backslashes++;
    k--;
  }
  return (backslashes & 1) === 1;
}

/** Coupe un sélecteur (liste) au niveau supérieur — parenthèses/chaînes respectées. */
function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (quote) {
      current += c;
      if (c === quote && !isEscapedAt(list, i)) quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && !isEscapedAt(list, i)) {
      quote = c;
      current += c;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Préfixe chaque sélecteur d'une liste par la zone de montage du bundle. */
function scopeSelectorList(prelude: string): string {
  const scoped = splitSelectorList(prelude).map((sel) => {
    if (sel.startsWith(OVERLAY_SCOPE)) return sel; // idempotent
    return `${OVERLAY_SCOPE} ${sel}`;
  });
  return scoped.join(',');
}

/**
 * Marche le CSS minifié à la recherche des blocs `@layer <name>{…}` de
 * premier niveau ; à l'intérieur des layers ciblés, préfixe les sélecteurs
 * de toutes les règles de style (y compris imbriquées dans des
 * @media/@supports/@container). Les at-rules structurels (@keyframes,
 * @font-face, @property…) sont recopiés tels quels.
 */
function scopeLayerRules(css: string): string {
  let out = '';
  let i = 0;

  const findLayerBlock = () => {
    const m = /^@layer\s+([a-z-]+)\s*\{/.exec(css.slice(i));
    if (!m) return null;
    return {
      name: m[1],
      headerEnd: i + m[0].length,
      // fin du bloc (appariement des accolades)
      blockEnd: matchBraces(css, i + m[0].length - 1),
    };
  };
  const matchBraces = (s: string, openIdx: number): number => {
    let depth = 0;
    let quote: string | null = null;
    for (let j = openIdx; j < s.length; j++) {
      const c = s[j];
      if (quote) {
        // Les guillemets PROTÉGÉS (impair de backslashes) ne ferment pas la
        // chaîne — ex. les sélecteurs à variante arbitraire de Tailwind
        // (`.\[\&_\.recharts-dot\[stroke\=\'\#fff\'\]…`) contiennent des
        // apostrophes échappées qui doivent être ignorées.
        if (c === quote && !isEscapedAt(s, j)) quote = null;
        continue;
      }
      if ((c === '"' || c === "'") && !isEscapedAt(s, j)) {
        quote = c;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return j; // indice de l'accolade fermante
      }
    }
    return s.length - 1;
  };

  while (i < css.length) {
    const layer = findLayerBlock();
    if (layer) {
      const body = css.slice(layer.headerEnd, layer.blockEnd);
      if (SCOPED_LAYERS.has(layer.name)) {
        out += `@layer ${layer.name}{` + scopeInner(body) + '}';
      } else {
        out += `@layer ${layer.name}{` + body + '}';
      }
      i = layer.blockEnd + 1;
      continue;
    }
    // recopie jusqu'au prochain candidat @layer de premier niveau
    const next = css.indexOf('@layer', i + 1);
    const stop = next === -1 ? css.length : next;
    out += css.slice(i, stop);
    i = stop;
  }
  return out;

  /** Préfixe les règles de style d'un corps de bloc (récursif sur les at-rules). */
  function scopeInner(body: string): string {
    let result = '';
    let j = 0;
    while (j < body.length) {
      const open = body.indexOf('{', j);
      if (open === -1) {
        result += body.slice(j);
        break;
      }
      const prelude = body.slice(j, open).trim();
      const close = matchBraces(body, open);
      const inner = body.slice(open + 1, close);
      if (prelude.startsWith('@keyframes') || prelude.startsWith('@font-face') || prelude.startsWith('@property')) {
        // structurel : recopier tel quel (les sélecteurs internes « from/to/% »
        // ne doivent surtout pas être préfixés).
        result += prelude + '{' + inner + '}';
      } else if (
        prelude.startsWith('@media') ||
        prelude.startsWith('@supports') ||
        prelude.startsWith('@container') ||
        prelude.startsWith('@layer')
      ) {
        // at-rule conteneur : conserver l'en-tête, recurser sur le corps.
        result += prelude + '{' + scopeInner(inner) + '}';
      } else if (prelude) {
        // règle de style : préfixer la liste de sélecteurs.
        result += scopeSelectorList(prelude) + '{' + inner + '}';
      } else {
        result += '{' + inner + '}';
      }
      j = close + 1;
    }
    return result;
  }
}

console.log('[images] scoping utilities/components layers to the overlay…');
{
  const cssPath = 'public/static/images/app.css';
  const raw = readFileSync(cssPath, 'utf8');
  const before = raw.length;
  const scoped = scopeLayerRules(raw);
  writeFileSync(cssPath, scoped);
  const layersScoped = [...scoped.matchAll(/@layer\s+([a-z-]+)\{/g)].map((m) => m[1]);
  console.log(
    `[images] scoped ✓ (${before} → ${scoped.length} bytes; layers: ${layersScoped.join(', ')})`
  );
}
