/**
 * LOCAL VERIFICATION HARNESS (sandbox only — no test code lands in src/).
 *
 * 1. SDR → buildArtifactHtml: marker, fence safety, pages/slides/sheets modes.
 * 2. Full chat pipeline check happens over HTTP (see the bash chain).
 */
import { markdownToDocument } from '@/lib/documents/core/document-engine';
import { buildArtifactHtml } from '@/lib/documents/preview/artifact-html';
import { DocumentDocSchema } from '@/lib/documents/core/document-schema';

const REPORT_MD = `# Rapport d'activité — Studio Gamma

## Introduction

Ce **rapport trimestriel** présente les résultats de l'agence *Studio Gamma* sur le premier semestre. Il couvre les activités commerciales, la production et les perspectives.

## Chiffres clés

| Indicateur | T1 | T2 |
| --- | --- | --- |
| Chiffre d'affaires | 128 500 € | 152 300 € |
| Nouveaux clients | 9 | 14 |
| Marge nette | 21 % | 24 % |

### Analyse

La croissance est portée par le pôle **vidéo** et l'arrivée de deux comptes majeurs.

> Le second semestre s'annonce au-dessus des objectifs initiaux. — Direction

- Renforcer l'équipe production
- Lancer l'offre formation
- [!NOTE] Point d'attention : la trésorerie reste sensible aux délais de paiement.

\`\`\`js
console.log("exemple de bloc de code avec \`backticks\`");
\`\`\`

## Conclusion

Le cap est bon, la trajectoire confirmée sur l'ensemble des indicateurs suivis ce semestre.

## Détail des opérations

La production a livré quarante-deux projets sur le semestre, avec une moyenne de quatre-vingt-dix jours de délai entre la commande et la livraison finale. Les équipes ont été renforcées de trois recrutements ciblés : un chef de projet senior, un motion designer et un développeur full-stack. L'outillage interne a progressé avec la mise en place d'un pipeline de revue systématique des livrables, réduisant de moitié les allers-retours clients.

La satisfaction client mesurée en fin de projet atteint 4,6 sur 5, en progression de 0,3 point par rapport au semestre précédent. Le taux de recommandation s'établit à 78 % des clients interrogés, et le carnet de commandes couvre déjà l'équivalent de 60 % de l'objectif annuel.

## Perspectives

Le second semestre sera consacré à la consolidation : industrialisation des offres récurrentes, montée en compétence de l'équipe et ouverture d'un pôle formation attendu pour septembre. Les investissements resteront contenus, autofinancés par l'activité courante.`;

const DECK_MD = `# Lancement produit — Aurora

## Vision

- Une suite **unifiée**
- Trois modules clés

## Marché

- PME en croissance
- Équipes marketing

## Conclusion

- Dispo Q3
- Beta privée dès juin`;

const SHEET_MD = `# Budget prévisionnel 2026

## Postes

| Poste | Montant | Part |
| --- | --- | --- |
| Salaires | 240000 | 60% |
| Marketing | 60000 | 15% |`;

function assert(cond: boolean, label: string) {
  if (!cond) {
    console.error('✗ FAIL:', label);
    process.exit(1);
  }
  console.log('✓', label);
}

// ---- 1. paper artifact -------------------------------------------------------
const reportDoc = markdownToDocument(REPORT_MD, { filename: 'rapport.docx', ext: 'docx', modern: false });
const report = buildArtifactHtml(reportDoc, { documentId: 'doc-test-1' })!;
assert(report.includes('<!--nelth-doc-artifact:doc-test-1-->'), 'paper: marker present');
assert(!/(^|\n)\s*```/.test(report.replace(/`\u2060`/g, '')), 'paper: no raw fence-closing run');
assert(report.includes('class="ndoc-pg"'), 'paper: A4 pages rendered');
assert(report.includes('data-fmt="pdf"') && report.includes('data-fmt="pptx"'), 'paper: toolbar formats');
assert(report.includes('data-ndoc-edit'), 'paper: edit button');
assert(report.includes('ndoc-tbl'), 'paper: table rendered');
assert(report.includes('ndoc-callout'), 'paper: callout rendered');
assert(report.includes('ndoc-quote'), 'paper: quote rendered');
assert(report.includes('ndoc-code'), 'paper: code block rendered');
assert(!report.includes('<html') && !report.includes('<!DOCTYPE'), 'paper: body-only (host wraps it)');
assert(report.includes('window.__NDOC_ID__'), 'paper: host script id');
const pages = (report.match(/class="ndoc-pg"/g) || []).length;
assert(pages >= 2, `paper: multi-page (${pages} pages)`);

// ---- 2. slides artifact ------------------------------------------------------
const deckDoc = markdownToDocument(DECK_MD, { filename: 'lancement.pptx', ext: 'pptx', modern: true });
const deck = buildArtifactHtml(deckDoc, { documentId: 'doc-test-2' })!;
assert(deck.includes('data-ndoc-mode="slides"'), 'slides: mode flag');
assert((deck.match(/class="ndoc-sli"/g) || []).length >= 3, 'slides: 16:9 cards');
assert(deck.includes('ndoc-sli-notes') || !deckDoc.slides?.some((s) => s.notes), 'slides: notes passthrough');

// ---- 3. sheets artifact ------------------------------------------------------
const sheetDoc = markdownToDocument(SHEET_MD, { filename: 'budget.xlsx', ext: 'xlsx', modern: false });
const sheet = buildArtifactHtml(sheetDoc, { documentId: 'doc-test-3' })!;
assert(sheet.includes('data-ndoc-mode="sheets"'), 'sheets: mode flag');
assert(sheet.includes('class="ndoc-sheet"'), 'sheets: sheet cards');

// ---- 4. SDR round-trip survives ---------------------------------------------
const reParsed = DocumentDocSchema.safeParse(JSON.parse(JSON.stringify(reportDoc)));
assert(reParsed.success, 'schema round-trip');

// ---- 5. oversize guard -------------------------------------------------------
const huge = markdownToDocument(
  '# Gros\n\n' + Array.from({ length: 2600 }, (_, i) => `Paragraphe numéro ${i} avec du contenu suffisamment long pour peser dans le rendu final de l'artefact html complet.`).join('\n\n'),
  { filename: 'gros.docx', ext: 'docx' }
);
const hugeArtifact = buildArtifactHtml(huge, { documentId: 'doc-test-4' });
assert(hugeArtifact === null, 'oversize guard returns null');

await Bun.write('/tmp/artifact-sample.html', report);
console.log('\nALL ARTIFACT HARNESS CHECKS PASSED — sample: /tmp/artifact-sample.html');
process.exit(0);
