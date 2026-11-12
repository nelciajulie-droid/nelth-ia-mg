/**
 * RUNTIME smoke test of the artifact html inside happy-dom:
 * mount → boot → edit → collect → save → rails → repagination.
 */
import { Window } from 'happy-dom';
import { markdownToDocument } from '@/lib/documents/core/document-engine';
import { buildArtifactHtml } from '@/lib/documents/preview/artifact-html';

const MD = `# Rapport test

Intro **gras** et *italique*.

## Tableau

| A | B |
| --- | --- |
| 1 | 2 |

- item un
- item deux

> Citation. — Auteur

\`\`\`js
let x = 1;
\`\`\`

## Fin

Conclusion ici.
`;

function mount(html: string) {
  const window = new Window({ url: 'https://artifact.test/' });
  const document = window.document;
  document.head.innerHTML = '<meta charset="utf-8">';
  const bodyOnly = html.replace(/^<!--[\s\S]*?-->/, '');
  const hm = bodyOnly.match(/<script>window\.__NDOC_ID__[\s\S]*?<\/script>/);
  if (!hm) throw new Error('head script missing');
  const headJs = hm[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
  const rest = bodyOnly.replace(hm[0], '');
  document.body.innerHTML = rest;
  // run head script (sets window.__NDOC_*__)
  new Function('window', headJs)(window);
  // run host script
  const hostMatch = rest.match(/<script>\s*\(function\(\)\{[\s\S]*?\}\)\(\);\s*<\/script>/);
  if (!hostMatch) throw new Error('host script missing');
  const hostJs = hostMatch[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
  const posted: any[] = [];
  (window as any).postMessage = (msg: any) => { posted.push(msg); };
  new Function('window', 'document', 'parent', hostJs)(window, document, window);
  const reply = (msg: any) => {
    (window as any).dispatchEvent(new (window as any).MessageEvent('message', { data: msg }));
  };
  return { window, document, posted, reply };
}

const doc = markdownToDocument(MD, { filename: 't.pdf', ext: 'pdf' });
const html = buildArtifactHtml(doc, { documentId: 'doc-1' })!;

const t = mount(html);
await new Promise((r) => setTimeout(r, 60));
const { document, posted, reply } = t;
const root = document.querySelector('.ndoc-root')!;

console.log('root mounted:', !!root);
console.log('pages rendered:', document.querySelectorAll('.ndoc-pg').length);
console.log('blocks rendered:', document.querySelectorAll('[data-ndoc-block]').length);
console.log('brand:', document.querySelector('[data-ndoc-brand]')?.textContent);

// --- fetch flow
t.window.dispatchEvent(new (t.window as any).MessageEvent('message', { data: { nelthDocCommand: { docId: 'doc-1', action: 'open' } } }));
await new Promise((r) => setTimeout(r, 20));
console.log('fetch requested:', posted.some((p) => p.nelthDocArtifact?.action === 'fetch'));
const sdrFresh = JSON.parse(JSON.stringify(doc));
sdrFresh.blocks[1].text = 'Nouveau texte intro depuis le serveur';
reply({ nelthDocFetched: { for: 'doc-1', ok: true, document: sdrFresh } });
await new Promise((r) => setTimeout(r, 30));
console.log('re-rendered from server:', document.body.textContent!.includes('Nouveau texte intro'));

// --- edit command (needs the fetch reply with thenEdit)
t.window.dispatchEvent(new (t.window as any).MessageEvent('message', { data: { nelthDocCommand: { docId: 'doc-1', action: 'edit' } } }));
reply({ nelthDocFetched: { for: 'doc-1', ok: true, document: sdrFresh, thenEdit: true } });
await new Promise((r) => setTimeout(r, 30));
console.log('edit mode ON:', root.classList.contains('ndoc-editing'));
console.log('editable count:', document.querySelectorAll('[contenteditable="true"]').length);
console.log('rails count:', document.querySelectorAll('.ndoc-rail').length);

// --- mutate paragraph
const para = document.querySelector('[data-ndoc-bi="1"][data-ndoc-ed="text"]')!;
para.innerHTML = 'Texte <strong>édité</strong> à la main';
para.dispatchEvent(new (t.window as any).Event('input', { bubbles: true }));
console.log('dirty dot shown:', !document.querySelector('[data-ndoc-dirty]')!.classList.contains('ndoc-x'));

// --- save
const saveBtn = document.querySelector('[data-ndoc-save]')!;
saveBtn.dispatchEvent(new (t.window as any).Event('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 20));
const saveMsg = posted.find((p) => p.nelthDocArtifact?.action === 'save');
console.log('save posted:', !!saveMsg);
if (saveMsg) {
  const saved = saveMsg.nelthDocArtifact.document;
  console.log('md roundtrip:', saved.blocks[1].text === 'Texte **édité** à la main', '→', JSON.stringify(saved.blocks[1].text));
  console.log('blocks preserved:', saved.blocks.length === doc.blocks.length);
}
reply({ nelthDocSaved: { for: 'doc-1', ok: true, saved_at: 123, document: sdrFresh } });
await new Promise((r) => setTimeout(r, 20));
console.log('edit mode exited:', !root.classList.contains('ndoc-editing'));
console.log('toast visible:', !document.querySelector('[data-ndoc-toast]')!.classList.contains('ndoc-x'));

// --- rails: add paragraph after block 0
t.window.dispatchEvent(new (t.window as any).MessageEvent('message', { data: { nelthDocCommand: { docId: 'doc-1', action: 'edit' } } }));
reply({ nelthDocFetched: { for: 'doc-1', ok: true, document: sdrFresh, thenEdit: true } });
await new Promise((r) => setTimeout(r, 30));
posted.length = 0;
const railBtn = document.querySelector('[data-ndoc-bi="0"] .ndoc-rail [data-ndoc-r="addp"]');
railBtn!.dispatchEvent(new (t.window as any).Event('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 30));
console.log('para added:', document.querySelectorAll('[data-ndoc-bi]').length === doc.blocks.length + 1);
document.querySelector('[data-ndoc-save]')!.dispatchEvent(new (t.window as any).Event('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 20));
const save2 = posted.find((p) => p.nelthDocArtifact?.action === 'save');
console.log('save after add:', !!save2, 'blocks:', save2?.nelthDocArtifact.document.blocks.length);

// --- long doc repagination
const long = markdownToDocument(Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nParagraphe ${i} — Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum.`).join('\n\n'), { filename: 'long.pdf', ext: 'pdf' });
const longHtml = buildArtifactHtml(long, { documentId: 'long-1' })!;
const t2 = mount(longHtml);
await new Promise((r) => setTimeout(r, 120));
console.log('long doc pages:', t2.document.querySelectorAll('.ndoc-pg').length, 'blocks:', long.blocks.length);
console.log('first page num:', t2.document.querySelector('.ndoc-pg-num')?.textContent);
console.log('ALL DONE');
