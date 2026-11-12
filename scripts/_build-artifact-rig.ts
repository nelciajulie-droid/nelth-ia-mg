/** Build a standalone debug rig: the artifact html inside a 390px iframe (allow-same-origin for inspection). */
import { markdownToDocument } from '@/lib/documents/core/document-engine';
import { buildArtifactHtml } from '@/lib/documents/preview/artifact-html';
import { writeFileSync } from 'node:fs';

const MD = `# Rapport d'activité — Studio Gamma

## Introduction

Ce **rapport trimestriel** présente les résultats de l'agence *Studio Gamma* sur le premier semestre.

## Chiffres clés

| Indicateur | T1 | T2 |
| --- | --- | --- |
| Chiffre d'affaires | 128 500 € | 152 300 € |
| Nouveaux clients | 9 | 14 |

## Conclusion

Le cap est bon, la trajectoire confirmée sur l'ensemble des indicateurs.
`;

const doc = markdownToDocument(MD, { filename: 'rig.pdf', ext: 'pdf' });
const body = buildArtifactHtml(doc, { documentId: 'rig-doc-1' })!;

// The SPA wraps the artifact body in this exact shell:
const artifactPage =
  '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<style>body{background-color: white;}</style></head><body>' +
  body +
  '</body></html>';

const escaped = artifactPage.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const rig = `<!doctype html><html><head><meta charset="utf-8"><title>Rig</title></head>
<body style="margin:0;background:#888">
<iframe id="art" sandbox="allow-scripts allow-same-origin allow-downloads allow-forms"
  srcdoc="${escaped}" style="width:390px;height:844px;border:0;display:block"></iframe>
<script>
window.rigLog = [];
window.addEventListener('message', function(e){
  window.rigLog.push(JSON.stringify(e.data).slice(0,120));
  var p = e.data && e.data.nelthDocArtifact;
  if (!p) return;
  if (p.action === 'fetch') {
    setTimeout(function(){ e.source.postMessage({nelthDocFetched:{for:p.docId, ok:false, thenEdit:!!p.thenEdit}}, '*'); }, 50);
  }
});
</script></body></html>`;
writeFileSync('/tmp/rig.html', rig);
writeFileSync('/tmp/artifact-page.html', artifactPage);
console.log('rig written — artifact page bytes:', artifactPage.length);
