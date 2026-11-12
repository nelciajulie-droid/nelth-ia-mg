import type { DocumentDoc, DocBlock, DocSlide, DocSheet } from '../core/document-schema';
import { buildPreview } from './preview-model';
import { resolveTemplate, cssFonts, type DocumentTemplate } from '../templates';

/**
 * DOCUMENT ARTIFACT — the code-preview artifact block.
 *
 * The compiled SPA already owns a premium artifact system: an ```html fenced
 * block inside an assistant message becomes a sandboxed iframe preview in the
 * right-hand Artifacts panel (Preview button on the code block, version
 * navigation, full screen, native HTML download). This module renders the
 * SAME SDR the exports use into a self-contained html BODY (style + dom +
 * script — no <html>/<head> wrapper: the artifact host injects its own), so a
 * generated document opens EXACTLY where code previews open, with the
 * document elements ADDED on top:
 *
 *   • true A4 paper pages (template margins/typography/palette, running
 *     footer « title — N / total ») — the same pagination model the PDF uses
 *   • 16:9 slide cards for presentations, sheet tables for spreadsheets
 *   • a slim floating toolbar (PDF/DOCX/XLSX/PPTX/CSV/MD/TXT + « Modifier »)
 *     that talks to the host page through postMessage — the sandbox
 *     (`allow-scripts allow-downloads allow-forms`, opaque origin) cannot
 *     call the API itself, the documents bridge performs the authenticated
 *     download / opens the editor workspace.
 *
 * Everything is escaped; the output never contains a ``` run (it would close
 * the host fence early — runs are broken with a zero-width word joiner) nor
 * `</script>` (escaped as &lt;/script&gt; inside text nodes).
 */

// ---------------------------------------------------------------------------
// Escaping + inline markdown
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline markdown (**bold**, *italic*, `code`) → html. Text is escaped. */
function inlineMd(text: string): string {
  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(«])\*([^*\n]+)\*(?![*])/g, '$1<em>$2</em>');
  return out;
}

/** Break any ``` run so it can never close the host fence. */
function fenceSafe(html: string): string {
  return html.replace(/`{3,}/g, (run) => '`\u2060' + run.slice(1));
}

/** JS string literal, hardened against `</script>` and line separators. */
function jsStr(s: string): string {
  return JSON.stringify(s)
    .replace(/</g, '\\u003c')
    .replace(/\u2028|\u2029/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));
}

// ---------------------------------------------------------------------------
// Block → html (class-based styling, template palette in CSS variables)
// ---------------------------------------------------------------------------

function headingFontSize(level: number, tpl: DocumentTemplate): number {
  const base = tpl.typography.size;
  const [s2, s3, s4] = tpl.typography.headingScale;
  return base * (level === 1 ? 2.0 : level === 2 ? s2 : level === 3 ? s3 : s4);
}

const CALLOUT_ICON: Record<string, string> = {
  info: 'i',
  warning: '!',
  success: '✓',
  danger: '✕',
};

function renderBlock(blk: DocBlock, tpl: DocumentTemplate): string {
  const base = tpl.typography.size;
  const lead = tpl.typography.leading;
  switch (blk.t) {
    case 'heading': {
      const size = headingFontSize(blk.level, tpl);
      const cls = blk.level === 1 ? 'ndoc-h1' : blk.level === 2 ? 'ndoc-h2' : blk.level === 3 ? 'ndoc-h3' : 'ndoc-h4';
      const style =
        `font-size:${size.toFixed(2)}pt;font-weight:${blk.level <= 3 ? 700 : 600};` +
        `margin:${blk.level <= 2 ? 10 : 6}pt 0 ${blk.level === 1 ? 14 : blk.level === 2 ? 8 : 6}pt;`;
      return `<div class="${cls} ndoc-heading" data-ndoc-block style="${style}">${inlineMd(blk.text)}</div>`;
    }
    case 'para':
      return `<p class="ndoc-p" data-ndoc-block style="font-size:${base}pt;line-height:${(1.42 * lead).toFixed(3)};margin:0 0 ${(7 * lead).toFixed(1)}pt;">${inlineMd(blk.text)}</p>`;
    case 'list': {
      const tag = blk.style === 'number' ? 'ol' : 'ul';
      const marker = blk.style === 'check' ? '☑' : blk.style === 'number' ? '' : '•';
      const items = blk.items
        .map(
          (it) =>
            `<li style="margin:0 0 ${(3.5 * lead).toFixed(1)}pt;padding-left:${10 + it.level * 14}pt;">` +
            (marker ? `<span class="ndoc-li-mk" aria-hidden="true">${marker}</span>` : '') +
            `<span>${inlineMd(it.text)}</span></li>`
        )
        .join('');
      return `<${tag} class="ndoc-list" data-ndoc-block style="font-size:${base}pt;line-height:${(1.4 * lead).toFixed(3)};margin:0 0 ${(6 * lead).toFixed(1)}pt;padding:0;list-style:${blk.style === 'number' ? 'decimal' : 'none'};">${items}</${tag}>`;
    }
    case 'table': {
      const cols = Math.max(1, blk.header.length);
      const head = blk.header.map((c) => `<th>${inlineMd(c)}</th>`).join('');
      const rows = blk.rows
        .map((row) => {
          const cells = Array.from({ length: cols }, (_, c) => `<td>${inlineMd(String(row[c] ?? ''))}</td>`).join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');
      return (
        `<div class="ndoc-tbl-wrap" data-ndoc-block style="margin:0 0 ${(10 * lead).toFixed(1)}pt;">` +
        `<table class="ndoc-tbl" style="font-size:${(base - 1).toFixed(2)}pt;">` +
        `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` +
        (blk.caption ? `<div class="ndoc-tbl-cap">${inlineMd(blk.caption)}</div>` : '') +
        '</div>'
      );
    }
    case 'quote':
      return (
        `<blockquote class="ndoc-quote" data-ndoc-block>` +
        `<p>${inlineMd(blk.text)}</p>` +
        (blk.author ? `<footer>— ${inlineMd(blk.author)}</footer>` : '') +
        '</blockquote>'
      );
    case 'callout':
      return (
        `<div class="ndoc-callout ndoc-callout--${blk.variant}" data-ndoc-block>` +
        `<span class="ndoc-callout-ico" aria-hidden="true">${CALLOUT_ICON[blk.variant] ?? 'i'}</span>` +
        `<div>${blk.title ? `<div class="ndoc-callout-tt">${inlineMd(blk.title)}</div>` : ''}` +
        `<div>${inlineMd(blk.text)}</div></div></div>`
      );
    case 'code':
      return (
        `<pre class="ndoc-code" data-ndoc-block>${blk.lang ? `<span class="ndoc-code-lang">${esc(blk.lang)}</span>` : ''}` +
        `<code>${esc(blk.text)}</code></pre>`
      );
    case 'divider':
      return '<hr class="ndoc-hr" data-ndoc-block />';
    case 'pagebreak':
      return '';
    case 'image':
      return (
        `<figure class="ndoc-fig" data-ndoc-block>` +
        `<img src="${esc(blk.url)}" alt="${esc(blk.alt ?? 'Illustration')}" loading="lazy" />` +
        (blk.alt ? `<figcaption>${inlineMd(blk.alt)}</figcaption>` : '') +
        '</figure>'
      );
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Paper / slides / sheets renderers
// ---------------------------------------------------------------------------

function paperHtml(doc: DocumentDoc, tpl: DocumentTemplate): string {
  const preview = buildPreview(doc);
  const m = preview.margins;
  const pages = preview.pages
    .map((page) => {
      const blocks = page.blocks.map((p) => renderBlock(p.block, tpl)).join('');
      return (
        `<section class="ndoc-pg" data-ndoc-pg>` +
        `<div class="ndoc-pg-body" style="padding:${m.top}pt ${m.side}pt ${m.bottom}pt;">${blocks}</div>` +
        `<footer class="ndoc-pg-foot" style="left:${m.side}pt;right:${m.side}pt;bottom:${(m.bottom * 0.38).toFixed(1)}pt;">` +
        `<span class="ndoc-pg-title">${esc(doc.title)}</span>` +
        `<span class="ndoc-pg-num"></span>` +
        '</footer></section>'
      );
    })
    .join('');
  return pages || '<section class="ndoc-pg" data-ndoc-pg><div class="ndoc-pg-body"></div><footer class="ndoc-pg-foot"><span class="ndoc-pg-title"></span><span class="ndoc-pg-num"></span></footer></section>';
}

function slidesHtml(doc: DocumentDoc, tpl: DocumentTemplate, fonts: ReturnType<typeof cssFonts>): string {
  const slides: DocSlide[] = doc.slides ?? [];
  const cards = slides
    .map((s, i) => {
      const big = s.layout === 'title' || s.layout === 'section';
      const bullets = s.bullets.length
        ? `<ul class="ndoc-sli-ul">${s.bullets.map((b) => `<li><span class="ndoc-li-mk" aria-hidden="true">•</span><span>${inlineMd(b)}</span></li>`).join('')}</ul>`
        : '';
      return (
        `<section class="ndoc-sli${big ? ' ndoc-sli--big' : ''}" data-ndoc-sli aria-label="Diapositive ${i + 1}">` +
        `<div class="ndoc-sli-rail" aria-hidden="true"></div>` +
        `<div class="ndoc-sli-body" style="font-family:${esc(fonts.heading)};">` +
        `<div class="ndoc-sli-tt">${s.title ? inlineMd(s.title) : '<span class="ndoc-sli-ph">Diapositive</span>'}</div>` +
        bullets +
        (s.layout === 'closing' ? '<div class="ndoc-sli-close">Merci</div>' : '') +
        `</div><div class="ndoc-sli-num">${i + 1}</div>` +
        (s.notes ? `<div class="ndoc-sli-notes"><span>Notes</span><p>${inlineMd(s.notes)}</p></div>` : '') +
        '</section>'
      );
    })
    .join('');
  return cards || '<p class="ndoc-empty">Aucune diapositive.</p>';
}

function sheetsHtml(doc: DocumentDoc, tpl: DocumentTemplate): string {
  const sheets: DocSheet[] = doc.sheets ?? [];
  const base = tpl.typography.size;
  const cards = sheets
    .map((sheet) => {
      const cols = Math.max(1, sheet.header.length);
      const head = sheet.header.map((c) => `<th>${inlineMd(c)}</th>`).join('');
      const rows = sheet.rows
        .map((row) => {
          const cells = Array.from({ length: cols }, (_, c) => `<td>${inlineMd(String(row[c] ?? ''))}</td>`).join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');
      return (
        `<section class="ndoc-sheet" data-ndoc-sheet>` +
        `<header class="ndoc-sheet-hd"><span class="ndoc-sheet-name">${inlineMd(sheet.name)}</span>` +
        `<span class="ndoc-sheet-meta">${sheet.rows.length} ligne${sheet.rows.length > 1 ? 's' : ''} · ${cols} colonne${cols > 1 ? 's' : ''}</span></header>` +
        `<div class="ndoc-sheet-scroll"><table class="ndoc-tbl" style="font-size:${(base - 1).toFixed(2)}pt;"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>` +
        '</section>'
      );
    })
    .join('');
  return cards || '<p class="ndoc-empty">Feuille vide.</p>';
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function stylesHtml(tpl: DocumentTemplate, fonts: ReturnType<typeof cssFonts>, mode: 'paper' | 'slides' | 'sheets'): string {
  const p = tpl.palette;
  return `<style>
.ndoc-root{--a:#${p.accent};--a2:#${p.accent2};--ad:#${p.accentDark};--tint:#${p.tint};--ink:#${p.ink};
  --body:#${p.body};--muted:#${p.muted};--zebra:#${p.zebra};--hair:#${p.hairline};
  --fd:'${fonts.body.replace(/'/g, "\\'")}';--fh:'${fonts.heading.replace(/'/g, "\\'")}';
  margin:0;background:#e9eae8;padding:24px 16px 96px;}
.ndoc-root *{box-sizing:border-box}
.ndoc-fit{margin:0 auto;width:fit-content}
.ndoc-doc{display:flex;flex-direction:column;align-items:center;gap:22px;transform-origin:top center}

/* — pages — */
.ndoc-pg{position:relative;width:595.28pt;height:841.89pt;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.10),0 12px 32px rgba(16,24,40,.13);border-radius:2px;overflow:hidden}
.ndoc-pg-body{position:relative;height:100%;font-family:var(--fd);color:var(--ink);overflow:hidden}
.ndoc-pg-foot{position:absolute;display:flex;justify-content:space-between;gap:12pt;font-size:8pt;color:var(--muted);letter-spacing:.02em}
.ndoc-pg-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:78%}
.ndoc-pg-num{flex-shrink:0;font-variant-numeric:tabular-nums}

/* — blocks — */
.ndoc-h1{font-family:var(--fh);color:var(--a)}
.ndoc-h2{font-family:var(--fh);color:var(--ad);border-bottom:.75pt solid var(--hair);padding-bottom:3.5pt}
.ndoc-h3{font-family:var(--fh);color:var(--ink)}
.ndoc-h4{font-family:var(--fh);color:var(--ink)}
.ndoc-p{text-align:justify;hyphens:auto;overflow-wrap:break-word}
.ndoc-list{overflow-wrap:break-word}
.ndoc-li-mk{color:var(--a);margin-right:6pt;font-weight:600}
.ndoc-tbl-wrap{break-inside:avoid}
.ndoc-tbl{width:100%;border-collapse:collapse;table-layout:fixed}
.ndoc-tbl th{background:var(--a);color:#fff;font-weight:700;text-align:left;padding:5pt 7pt;border:.75pt solid var(--a)}
.ndoc-tbl td{padding:4.5pt 7pt;border:.75pt solid var(--hair);color:var(--ink);vertical-align:top;overflow-wrap:break-word}
.ndoc-tbl tbody tr:nth-child(odd) td{background:var(--zebra)}
.ndoc-tbl-cap{font-size:8.5pt;color:var(--muted);margin-top:3pt;text-align:right}
.ndoc-quote{margin:6pt 0 10pt;padding:4pt 14pt;border-left:3pt solid var(--a);color:var(--muted);font-style:italic}
.ndoc-quote p{margin:0;text-align:left}
.ndoc-quote footer{margin-top:2pt;font-size:9pt;font-style:normal;letter-spacing:.02em}
.ndoc-callout{display:flex;gap:9pt;margin:6pt 0 10pt;padding:8pt 12pt;border-radius:6pt;background:var(--tint);border-left:3pt solid var(--a);color:var(--ink)}
.ndoc-callout-ico{flex-shrink:0;width:15pt;height:15pt;border-radius:99px;background:var(--a);color:#fff;font-size:9pt;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1pt;font-style:normal}
.ndoc-callout-tt{font-weight:700;margin-bottom:1.5pt}
.ndoc-callout--warning{border-left-color:#B45309}.ndoc-callout--warning .ndoc-callout-ico{background:#B45309}
.ndoc-callout--success{border-left-color:#15803D}.ndoc-callout--success .ndoc-callout-ico{background:#15803D}
.ndoc-callout--danger{border-left-color:#B91C1C}.ndoc-callout--danger .ndoc-callout-ico{background:#B91C1C}
.ndoc-code{position:relative;margin:6pt 0 10pt;padding:10pt 12pt;background:#16211f;color:#dbe4e2;border-radius:6pt;
  font-family:'Cascadia Code',Consolas,'Courier New',monospace;font-size:9pt;line-height:1.45;overflow:auto;white-space:pre}
.ndoc-code-lang{position:absolute;top:4pt;right:7pt;font-size:7pt;text-transform:uppercase;letter-spacing:.08em;color:#7da79f}
.ndoc-hr{border:0;border-top:.75pt solid var(--hair);margin:12pt 0}
.ndoc-fig{margin:6pt 0 10pt;text-align:center}
.ndoc-fig img{max-width:100%;border-radius:4pt;border:.75pt solid var(--hair)}
.ndoc-fig figcaption{font-size:8.5pt;color:var(--muted);margin-top:3pt}
.ndoc-empty{font-family:var(--fd);color:var(--muted);text-align:center;padding:40px 0;margin:0}

/* — slides — */
.ndoc-sli{position:relative;width:720px;max-width:100%;aspect-ratio:16/9;background:var(--tint);border-radius:12px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.10),0 12px 32px rgba(16,24,40,.13)}
.ndoc-sli-rail{position:absolute;inset:0 auto 0 0;width:7px;background:var(--a)}
.ndoc-sli-body{position:relative;height:100%;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:34px 44px 34px 50px}
.ndoc-sli-tt{font-size:26pt;font-weight:700;color:var(--ink);line-height:1.12}
.ndoc-sli--big .ndoc-sli-tt{font-size:34pt}
.ndoc-sli-ph{color:var(--muted)}
.ndoc-sli-ul{margin:0;padding:0;list-style:none;font-size:13.5pt;color:var(--body);display:flex;flex-direction:column;gap:10px}
.ndoc-sli-close{position:absolute;right:44px;bottom:26px;font-size:11pt;color:var(--muted);letter-spacing:.14em;text-transform:uppercase}
.ndoc-sli-num{position:absolute;left:16px;bottom:12px;font-size:9pt;color:var(--muted);font-variant-numeric:tabular-nums}
.ndoc-sli-notes{display:flex;gap:8px;margin-top:8px;padding:0 4px;font-family:var(--fd)}
.ndoc-sli-notes span{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);flex-shrink:0;padding-top:1px}
.ndoc-sli-notes p{margin:0;font-size:12px;line-height:1.45;color:var(--muted)}

/* — sheets — */
.ndoc-sheet{width:min(880px,100%);background:#fff;border-radius:10px;box-shadow:0 1px 2px rgba(16,24,40,.10),0 12px 32px rgba(16,24,40,.13);overflow:hidden}
.ndoc-sheet-hd{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 16px 10px;border-bottom:1px solid var(--hair)}
.ndoc-sheet-name{font-family:var(--fh);font-size:14pt;font-weight:700;color:var(--ad)}
.ndoc-sheet-meta{font-size:9.5pt;color:var(--muted)}
.ndoc-sheet-scroll{overflow:auto;max-height:420px}
.ndoc-sheet-scroll .ndoc-tbl th{position:sticky;top:0;z-index:1}

/* — barre d'outils (éléments ajoutés : téléchargements + atelier) — */
.ndoc-bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:40;
  display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:center;max-width:calc(100% - 24px);
  padding:6px;border-radius:14px;background:rgba(24,26,25,.86);backdrop-filter:blur(10px);
  box-shadow:0 8px 28px rgba(0,0,0,.35);font-family:var(--fd)}
.ndoc-bar-brand{display:flex;align-items:center;gap:7px;padding:0 10px 0 8px;color:#e8ebea;font-size:11.5px;font-weight:600;letter-spacing:.01em;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.ndoc-bar-brand svg{flex-shrink:0}
.ndoc-bar-sep{width:1px;height:18px;background:rgba(255,255,255,.18);margin:0 4px}
.ndoc-fmt{appearance:none;border:0;border-radius:9px;padding:6px 9px;background:transparent;color:#d9dddb;
  font-family:inherit;font-size:11px;font-weight:700;letter-spacing:.05em;cursor:pointer;transition:background .15s ease,color .15s ease;text-transform:uppercase}
.ndoc-fmt:hover{background:rgba(255,255,255,.14);color:#fff}
.ndoc-fmt:focus-visible{outline:2px solid #6ee7d7;outline-offset:1px}
.ndoc-fmt[data-busy="1"]{opacity:.45;pointer-events:none}
.ndoc-edit{appearance:none;border:0;border-radius:9px;padding:6px 13px;cursor:pointer;
  background:var(--a);color:#fff;font-family:inherit;font-size:11.5px;font-weight:700;letter-spacing:.02em;
  transition:filter .15s ease;display:flex;align-items:center;gap:6px;white-space:nowrap}
.ndoc-edit:hover{filter:brightness(1.12)}
.ndoc-edit:focus-visible{outline:2px solid #fff;outline-offset:1px}
.ndoc-edit svg{width:12px;height:12px}
@media (prefers-reduced-motion:reduce){.ndoc-root *,.ndoc-bar{transition:none!important}}

/* — print (le téléchargement html natif de l'artefact) — */
@media print{
  .ndoc-root{background:#fff;padding:0}
  .ndoc-fit{width:auto}
  .ndoc-doc{gap:0}
  .ndoc-bar{display:none}
  .ndoc-pg{width:auto;height:auto;min-height:auto;box-shadow:none;border-radius:0;break-after:page}
  .ndoc-pg:last-of-type{break-after:auto}
  .ndoc-pg-body{height:auto;overflow:visible}
  .ndoc-sli,.ndoc-sheet{box-shadow:none;break-inside:avoid;margin:0 auto 16px}
  @page{size:A4;margin:0}
}
</style>`;
}

// ---------------------------------------------------------------------------
// Host script — fit-to-width, pagination refinement, toolbar postMessage
// ---------------------------------------------------------------------------

const HOST_SCRIPT = `<script>
(function(){
  var DOC_ID = window.__NDOC_ID__;
  var mode = window.__NDOC_MODE__;
  function send(action, format, btn){
    if (btn){ btn.setAttribute('data-busy','1'); setTimeout(function(){ btn.removeAttribute('data-busy'); }, 4000); }
    try { parent.postMessage({ nelthDocArtifact: { docId: DOC_ID, action: action, format: format || null } }, '*'); } catch(e){}
  }
  // Toolbar — downloads + atelier (les éléments ajoutés à l'artefact).
  var bar = document.querySelector('.ndoc-bar');
  if (bar){
    bar.addEventListener('click', function(e){
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-fmt')) send('download', b.getAttribute('data-fmt'), b);
      else if (b.hasAttribute('data-ndoc-edit')) send('edit', null, b);
    });
  }
  // Images locales protégées (401 sans Bearer) : l'origine opaque ne peut pas
  // s'authentifier → le pont les relit en data-URL et répond par postMessage.
  var relaySeq = 0;
  var relayMap = {};
  document.addEventListener('error', function(e){
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || img.dataset.ndocRelay) return;
    var url = img.getAttribute('src') || '';
    if (!url || !/^\\//.test(url)) return; // relatives same-origin uniquement
    img.dataset.ndocRelay = '1';
    var seq = ++relaySeq;
    relayMap[seq] = img;
    try { parent.postMessage({ nelthDocArtifact: { docId: DOC_ID, action: 'image', url: url, seq: seq } }, '*'); } catch(err){}
  }, true);
  window.addEventListener('message', function(e){
    var d = e.data && e.data.nelthDocArtifactImage;
    if (!d || !relayMap[d.seq]) return;
    var img = relayMap[d.seq];
    if (d.dataUrl) img.src = d.dataUrl;
    delete relayMap[d.seq];
  });
  // Ajuste la largeur du papier au conteneur (mise à l'échelle homothétique).
  var root = document.querySelector('.ndoc-root');
  var fit = document.querySelector('.ndoc-fit');
  var doc = document.querySelector('.ndoc-doc');
  function rescale(){
    if (!root || !fit || !doc) return;
    if (mode === 'paper'){
      var avail = root.clientWidth - 8;
      var natural = doc.scrollWidth || 794;
      var s = Math.min(1, avail / natural);
      if (s < 0.999){
        doc.style.transformOrigin = 'top left';
        doc.style.transform = 'scale(' + s + ')';
        fit.style.width = Math.round(natural * s) + 'px';
        fit.style.height = Math.round(doc.offsetHeight * s) + 'px';
      } else {
        doc.style.transform = '';
        fit.style.width = '';
        fit.style.height = '';
      }
    } else {
      fit.style.width = '';
      fit.style.height = '';
    }
  }
  // Renumérote les pages « N / total ».
  function renumber(){
    var pages = document.querySelectorAll('.ndoc-pg');
    var total = pages.length;
    for (var i = 0; i < pages.length; i++){
      var num = pages[i].querySelector('.ndoc-pg-num');
      if (num) num.textContent = (i + 1) + ' / ' + total;
    }
  }
  // Raffine la pagination : un bloc qui déborde glisse sur la page suivante.
  function repaginate(){
    if (mode !== 'paper') return;
    var guard = 0;
    var moved = true;
    while (moved && guard < 6){
      moved = false; guard++;
      var pages = document.querySelectorAll('.ndoc-pg');
      for (var i = 0; i < pages.length && !moved; i++){
        var body = pages[i].querySelector('.ndoc-pg-body');
        if (!body) continue;
        var blocks = body.querySelectorAll('[data-ndoc-block]');
        if (!blocks.length) continue;
        if (body.scrollHeight <= body.clientHeight + 1) continue;
        // retire les derniers blocs jusqu'à rentrer (min. 1 bloc conservé)
        var stash = [];
        for (var k = blocks.length - 1; k >= 1; k--){
          stash.unshift(blocks[k]);
          blocks[k].parentNode.removeChild(blocks[k]);
          if (body.scrollHeight <= body.clientHeight + 1) break;
        }
        // page suivante (créée si besoin) — même gabarit
        var next = pages[i + 1];
        if (!next){
          next = document.createElement('section');
          next.className = 'ndoc-pg';
          next.setAttribute('data-ndoc-pg','');
          var nb = document.createElement('div');
          nb.className = 'ndoc-pg-body';
          nb.setAttribute('style', body.getAttribute('style') || '');
          var foot = document.createElement('footer');
          foot.className = 'ndoc-pg-foot';
          var ls = document.createElement('span');
          ls.className = 'ndoc-pg-title';
          var oldTitle = pages[i].querySelector('.ndoc-pg-title');
          if (oldTitle) ls.textContent = oldTitle.textContent;
          var ns = document.createElement('span');
          ns.className = 'ndoc-pg-num';
          foot.appendChild(ls); foot.appendChild(ns);
          var oldFoot = pages[i].querySelector('.ndoc-pg-foot');
          if (oldFoot) foot.setAttribute('style', oldFoot.getAttribute('style') || '');
          next.appendChild(nb); next.appendChild(foot);
          pages[i].parentNode.insertBefore(next, pages[i].nextSibling);
        }
        var nbody = next.querySelector('.ndoc-pg-body');
        if (nbody) for (var j = 0; j < stash.length; j++) nbody.insertBefore(stash[j], nbody.firstChild);
        moved = true;
      }
    }
    renumber();
  }
  function boot(){
    repaginate();
    rescale();
    renumber();
    // les images relais (data-URL) arrivent plus tard → recale au load.
    window.addEventListener('load', function(){ rescale(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.addEventListener('resize', function(){ rescale(); });
})();
<\/script>`;

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

export type ArtifactOptions = {
  /** Documents-engine id (file row id) — the toolbar addresses exports with it. */
  documentId: string;
};

export const ARTIFACT_MAX_HTML = 150_000;

const N_MARK =
  '<svg viewBox="0 0 497 502" width="13" height="13" fill="none" aria-hidden="true"><path d="M380 85.5c-.8.7-6.9 5.3-13.5 10-33.7 24.3-107.8 79.8-108.2 81.1-.4 1.1 14.6 9.6 47.7 27.1l18.5 9.8.3 40.5c.1 22.2-.1 40.7-.6 41.2-.4.4-6.6-2.8-13.7-7.1-39.9-24-52.5-31.2-53.5-30.6-.6.4-1 11.8-1 33.4 0 32.7 0 32.8 2.3 34.8 2.5 2.4 6.9 5.1 21.7 13.8 5.8 3.4 17.6 10.5 26.3 15.8 19.9 12.2 23.9 14.3 31.5 15.8 14.7 3.1 33-5.4 40.9-18.8 5.5-9.4 5.3-4.5 5.3-141.6 0-132.7.1-129.4-4-125.2m-225.9 45c-12.4 3.5-20.9 10.6-26.4 22.3l-3.2 6.7-.1 128.8c-.2 113.3 0 128.8 1.3 128.3 1.8-.7 16.9-11.6 33.6-24.1 6.5-5 21.7-16.1 33.6-24.8 40.9-29.8 57.1-41.9 57.1-42.8 0-1.4-5.4-4.5-34.5-19.9-14.8-7.9-28-14.9-29.1-15.6-2-1.2-2.2-2.3-2.9-27.3-.8-29.7.1-56.1 1.9-56.1.7 0 4.5 2.1 8.6 4.7 19.8 12.5 56.6 34.1 57.2 33.7.5-.3.8-15.5.8-33.9v-33.3l-3-2.6c-4.7-3.9-66.6-40.6-72-42.7-6.9-2.6-16.4-3.2-22.9-1.4" fill="#fff"/></svg>';

const FORMATS: Array<{ id: string; label: string }> = [
  { id: 'pdf', label: 'PDF' },
  { id: 'docx', label: 'DOCX' },
  { id: 'xlsx', label: 'XLSX' },
  { id: 'pptx', label: 'PPTX' },
  { id: 'csv', label: 'CSV' },
  { id: 'md', label: 'MD' },
  { id: 'txt', label: 'TXT' },
];

/**
 * Build the ```html artifact body for a document. Returns null when the
 * document renders to more than ARTIFACT_MAX_HTML bytes (the chat card +
 * workspace still carry it — only the inline artifact is skipped).
 */
export function buildArtifactHtml(doc: DocumentDoc, opts: ArtifactOptions): string | null {
  const tpl = resolveTemplate(doc.template, doc.docType);
  const fonts = cssFonts(tpl);
  const mode: 'paper' | 'slides' | 'sheets' =
    doc.docType === 'presentation' && doc.slides?.length
      ? 'slides'
      : doc.docType === 'spreadsheet' && doc.sheets?.length
        ? 'sheets'
        : 'paper';

  const body =
    mode === 'slides'
      ? slidesHtml(doc, tpl, fonts)
      : mode === 'sheets'
        ? sheetsHtml(doc, tpl)
        : paperHtml(doc, tpl);

  const fmtButtons = FORMATS.map(
    (f) => `<button type="button" class="ndoc-fmt" data-fmt="${f.id}" title="Télécharger en ${f.label}">${f.label}</button>`
  ).join('');

  const bar =
    `<nav class="ndoc-bar" aria-label="Actions du document">` +
    `<span class="ndoc-bar-brand" title="${esc(doc.title)}">${N_MARK}<span>${esc(doc.title)}</span></span>` +
    `<span class="ndoc-bar-sep" aria-hidden="true"></span>` +
    fmtButtons +
    `<span class="ndoc-bar-sep" aria-hidden="true"></span>` +
    `<button type="button" class="ndoc-edit" data-ndoc-edit title="Modifier dans l'atelier">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>` +
    `<span>Modifier</span></button>` +
    `</nav>`;

  const head =
    `<!--nelth-doc-artifact:${esc(opts.documentId)}-->` +
    `<script>window.__NDOC_ID__=${jsStr(opts.documentId)};window.__NDOC_MODE__=${jsStr(mode)};<\/script>`;

  const html =
    head +
    stylesHtml(tpl, fonts, mode) +
    `<div class="ndoc-root" data-ndoc-root data-ndoc-mode="${mode}">` +
    `<div class="ndoc-fit"><div class="ndoc-doc">${body}</div></div>` +
    bar +
    `</div>` +
    HOST_SCRIPT;

  if (html.length > ARTIFACT_MAX_HTML) return null;
  return fenceSafe(html);
}
