/**
 * Local verification: PREMIUM DOCUMENT QUALITY PASS.
 *
 *   bun scripts/_test-doc-quality.ts
 *
 * 1. Deterministic gate tests (no LLM) — validateEnhancedContent must reject
 *    too-short / refusal / heading-less / shallow replies and accept a
 *    genuinely richer rewrite (the pass can never degrade a draft).
 * 2. LIVE pass against the real Kilo gateway (.env key): a thin skeleton
 *    draft (what the standard free model emits inline) is rewritten by the
 *    strong reasoning model with the senior-writer prompt.
 * 3. Rendering sanity — the enhanced markdown goes through
 *    buildDocumentBytes (PDF) to prove the libraries render the richer
 *    content (answers "is the problem in our library?" — it is not).
 */

import {
  enhanceDocumentBlocks,
  validateEnhancedContent,
} from '../src/lib/documents/editing/document-quality';

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------------------
// 1. Deterministic gates
// ---------------------------------------------------------------------------
console.log('\n[1] validation gates (deterministic)');

const draft = `# Jean Mukendi — Développeur Full-Stack\n## Profil\n- 5 ans d'expérience\n## Expériences\n- Freelance (2021-2024): développement web\n- Agence KinDigital (2019-2021): développeur\n## Formation\n- Licence informatique\n## Compétences\n- JavaScript, Python`;

check('rejects too-short reply', validateEnhancedContent(draft, 'court', 'pdf').ok === false);
check(
  'rejects refusal marker',
  validateEnhancedContent(draft, "# Titre\n\nI cannot create this document, sorry.".repeat(30), 'pdf').ok === false
);
check(
  'rejects heading-less reply',
  validateEnhancedContent(draft, 'Un paragraphe sans aucun titre. '.repeat(40), 'pdf').ok === false
);
check(
  'rejects shallow rewrite (depth gate)',
  validateEnhancedContent(draft, `# Titre\n\n${'Paragraphe moyen. '.repeat(12)}`, 'pdf').ok === false
);
const rich = [
  '# Jean Mukendi — Développeur Full-Stack Senior',
  '',
  'Développeur full-stack senior avec 8 ans d’expérience (React/Node) sur des projets fintech à fort trafic — 2,3 M d’utilisateurs actifs, +38 % de conversion après refonte.',
  '',
  '## Expériences professionnelles',
  ...Array.from({ length: 8 }, (_, i) => `- Réalisation quantifiée ${i + 1} : migration de module, +12 % de performance, 4 mois, budget 45 000 $.`),
  '',
  '## Compétences',
  '| Domaine | Outils |',
  '| --- | --- |',
  '| Front | React, Next.js, TypeScript |',
  '| Back | Node.js, PostgreSQL |',
  '',
  '## Langues',
  '- Français (natif), Anglais (professionnel)',
].join('\n');
check('accepts genuinely richer rewrite', validateEnhancedContent(draft, rich, 'pdf').ok === true);
check('skips csv/json formats by extension', validateEnhancedContent(draft, draft, 'csv').reason === undefined ? false : true);

if (failures) {
  console.error(`\nGATE TESTS FAILED (${failures}) — aborting before the live pass.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. LIVE quality pass (real gateway)
// ---------------------------------------------------------------------------
console.log('\n[2] LIVE pass — thin drafts → senior-writer rewrite (real gateway)');

const t0 = Date.now();
const { blocks: enhanced, stats } = await enhanceDocumentBlocks(
  [
    {
      filename: 'cv-jean-mukendi.pdf',
      content: draft,
    },
    {
      filename: 'budget-projet.xlsx',
      content: `# Budget projet site web\n## Budget\n| Poste | Coût |\n| --- | --- |\n| Design | 500 |\n| Développement | 1500 |`,
    },
  ],
  {
    userRequest:
      "Fais-moi un CV professionnel en PDF pour un poste de développeur full-stack senior à Kinshasa, et un fichier Excel avec le budget du projet de refonte du site web de mon agence.",
    budgetMs: 150_000,
  }
);

console.log(`\n  pass finished in ${Math.round((Date.now() - t0) / 1000)}s`);
for (const s of stats) {
  console.log(
    `  ${s.applied ? 'APPLIED' : 'KEPT   '} ${s.filename} — ${s.draftChars} → ${s.finalChars} chars (${s.reason ?? `${s.ms}ms`})`
  );
}

const cv = enhanced.find((b) => b.filename.endsWith('.pdf'))!;
const xlsx = enhanced.find((b) => b.filename.endsWith('.xlsx'))!;

console.log('\n----- enhanced CV (first 900 chars) -----');
console.log(cv.content.slice(0, 900));
console.log('----- enhanced XLSX (first 500 chars) -----');
console.log(xlsx.content.slice(0, 500));

check('CV rewrite applied', cv.content !== draft && cv.content.length > draft.length * 1.5);
check('CV has quantified content (digits)', /\d+\s?(%|ans|mois|€|FC|\+)/.test(cv.content));
check('CV has table(s) or sub-sections', /\|.*---|###\s/.test(cv.content));
check('XLSX rewrite keeps sheet grammar', /^##\s+\S/m.test(xlsx.content) && /\|/.test(xlsx.content));

// ---------------------------------------------------------------------------
// 3. Rendering sanity — the LIBRARIES render the richer content (the "is the
//    problem our library?" answer: no — pdf-lib happily lays it out).
// ---------------------------------------------------------------------------
console.log('\n[3] rendering sanity — enhanced content through buildDocumentBytes (PDF)');
const { buildDocumentBytes } = await import('../src/lib/document-generation');
const { bytes, contentType } = await buildDocumentBytes({
  filename: 'cv-jean-mukendi.pdf',
  content: cv.content,
  design: 'classique',
});
check(
  `PDF renders (${(bytes.length / 1024).toFixed(1)} KB, ${contentType})`,
  bytes.length > 5_000 && bytes.subarray(0, 4).toString() === '%PDF'
);

console.log(failures ? `\nFAILURES: ${failures}` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
