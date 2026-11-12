import type { DocumentDoc, DocBlock } from '../core/document-schema';
import { buildPreview } from './preview-model';
import { resolveTemplate, cssFonts, type DocumentTemplate } from '../templates';

/**
 * DOCUMENT ARTIFACT — the code-preview artifact block (v4 — fit + zoom + pages).
 *
 * The compiled SPA owns a premium artifact system: an ```html fenced block
 * inside an assistant message becomes a sandboxed iframe preview in the
 * right-hand Artifacts panel (Preview button on the code block, version
 * navigation, full screen, native HTML download). This module renders the
 * SAME SDR the exports use into that self-contained html body — and now the
 * MODIFICATION TOOLS live INSIDE the artifact itself (no separate workshop):
 *
 *   • true A4 paper pages (template margins/typography/palette, running
 *     footer « title — N / total ») — the same pagination model the PDF uses
 *   • 16:9 slide cards for presentations, sheet tables for spreadsheets
 *   • fit-to-width scaling that tracks the panel size (ResizeObserver) so the
 *     document renders correctly at ANY panel width — narrow included — plus
 *     ZOOM controls (− % +) and a live page indicator (n / N) that follows
 *     scrolling (the tools the workshop used to carry, now in the preview)
 *   • « Modifier » toggles an edit mode IN the preview: every text surface
 *     becomes editable (paragraphs, headings, list items, table cells, quote
 *     authors, callouts, code, slide titles/bullets/notes, sheet cells),
 *     structure controls add/remove blocks, rows, items and slides
 *   • « Enregistrer » → postMessage → documents bridge PATCHes the SDR
 *     (the sandbox's opaque origin cannot call the API itself)
 *   • « ✨ IA » → natural-language instruction → bridge POSTs /improve →
 *     the artifact re-renders itself from the updated SDR
 *   • the embedded SDR is only the bootstrap: opening/editing refreshes the
 *     document from the server so the preview always shows the saved truth
 *   • a slim floating toolbar (Télécharger → PDF/DOCX/XLSX/PPTX/CSV/MD/TXT,
 *     zoom, pages, Modifier) performs multi-format downloads through the
 *     same postMessage bridge
 *
 * Everything is escaped; the output never contains a ``` run (it would close
 * the host fence early — runs are broken with a zero-width word joiner) nor
 * `</script>` (escaped as &lt;/script&gt; inside text nodes). The host script
 * itself uses string concatenation only (no template literals) so a stray
 * backtick run can never appear.
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

function renderBlock(blk: DocBlock, tpl: DocumentTemplate, bi: number): string {
  const base = tpl.typography.size;
  const lead = tpl.typography.leading;
  switch (blk.t) {
    case 'heading': {
      const size = headingFontSize(blk.level, tpl);
      const cls = blk.level === 1 ? 'ndoc-h1' : blk.level === 2 ? 'ndoc-h2' : blk.level === 3 ? 'ndoc-h3' : 'ndoc-h4';
      const style =
        `font-size:${size.toFixed(2)}pt;font-weight:${blk.level <= 3 ? 700 : 600};` +
        `margin:${blk.level <= 2 ? 10 : 6}pt 0 ${blk.level === 1 ? 14 : blk.level === 2 ? 8 : 6}pt;`;
      return `<div class="${cls} ndoc-heading" data-ndoc-block data-ndoc-bi="${bi}" data-ndoc-ed="text" style="${style}">${inlineMd(blk.text)}</div>`;
    }
    case 'para':
      return `<p class="ndoc-p" data-ndoc-block data-ndoc-bi="${bi}" data-ndoc-ed="text" style="font-size:${base}pt;line-height:${(1.42 * lead).toFixed(3)};margin:0 0 ${(7 * lead).toFixed(1)}pt;">${inlineMd(blk.text)}</p>`;
    case 'list': {
      const tag = blk.style === 'number' ? 'ol' : 'ul';
      const marker = blk.style === 'check' ? '☑' : blk.style === 'number' ? '' : '•';
      const items = blk.items
        .map(
          (it, j) =>
            `<li style="margin:0 0 ${(3.5 * lead).toFixed(1)}pt;padding-left:${10 + it.level * 14}pt;">` +
            (marker ? `<span class="ndoc-li-mk" aria-hidden="true">${marker}</span>` : '') +
            `<span data-ndoc-ed="li" data-ndoc-j="${j}">${inlineMd(it.text)}</span></li>`
        )
        .join('');
      return `<${tag} class="ndoc-list" data-ndoc-block data-ndoc-bi="${bi}" style="font-size:${base}pt;line-height:${(1.4 * lead).toFixed(3)};margin:0 0 ${(6 * lead).toFixed(1)}pt;padding:0;list-style:${blk.style === 'number' ? 'decimal' : 'none'};">${items}</${tag}>`;
    }
    case 'table': {
      const cols = Math.max(1, blk.header.length);
      const head = blk.header
        .map((c, ci) => `<th data-ndoc-ed="hcell" data-ndoc-c="${ci}">${inlineMd(c)}</th>`)
        .join('');
      const rows = blk.rows
        .map(
          (row, ri) =>
            '<tr>' +
            Array.from({ length: cols }, (_, c) => `<td data-ndoc-ed="cell" data-ndoc-r="${ri}" data-ndoc-c="${c}">${inlineMd(String(row[c] ?? ''))}</td>`).join('') +
            '</tr>'
        )
        .join('');
      return (
        `<div class="ndoc-tbl-wrap" data-ndoc-block data-ndoc-bi="${bi}" style="margin:0 0 ${(10 * lead).toFixed(1)}pt;">` +
        `<table class="ndoc-tbl" style="font-size:${(base - 1).toFixed(2)}pt;">` +
        `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` +
        (blk.caption ? `<div class="ndoc-tbl-cap" data-ndoc-ed="caption">${inlineMd(blk.caption)}</div>` : '') +
        '</div>'
      );
    }
    case 'quote':
      return (
        `<blockquote class="ndoc-quote" data-ndoc-block data-ndoc-bi="${bi}">` +
        `<p data-ndoc-ed="text">${inlineMd(blk.text)}</p>` +
        (blk.author ? `<footer data-ndoc-ed="author">— ${inlineMd(blk.author)}</footer>` : '') +
        '</blockquote>'
      );
    case 'callout':
      return (
        `<div class="ndoc-callout ndoc-callout--${blk.variant}" data-ndoc-block data-ndoc-bi="${bi}">` +
        `<span class="ndoc-callout-ico" aria-hidden="true">${CALLOUT_ICON[blk.variant] ?? 'i'}</span>` +
        `<div>${blk.title ? `<div class="ndoc-callout-tt" data-ndoc-ed="ctitle">${inlineMd(blk.title)}</div>` : ''}` +
        `<div data-ndoc-ed="text">${inlineMd(blk.text)}</div></div></div>`
      );
    case 'code':
      return (
        `<pre class="ndoc-code" data-ndoc-block data-ndoc-bi="${bi}">${blk.lang ? `<span class="ndoc-code-lang">${esc(blk.lang)}</span>` : ''}` +
        `<code data-ndoc-ed="codetext">${esc(blk.text)}</code></pre>`
      );
    case 'divider':
      return '<hr class="ndoc-hr" data-ndoc-block data-ndoc-bi="-1" />';
    case 'pagebreak':
      return '';
    case 'image':
      return (
        `<figure class="ndoc-fig" data-ndoc-block data-ndoc-bi="${bi}">` +
        `<img src="${esc(blk.url)}" alt="${esc(blk.alt ?? 'Illustration')}" loading="lazy" />` +
        (blk.alt ? `<figcaption data-ndoc-ed="text">${inlineMd(blk.alt)}</figcaption>` : '') +
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
  // Global SDR block index — editing maps DOM → SDR through it.
  const indexOf = new Map<DocBlock, number>();
  doc.blocks.forEach((b, i) => indexOf.set(b, i));
  const pages = preview.pages
    .map((page) => {
      const blocks = page.blocks.map((p) => renderBlock(p.block, tpl, indexOf.get(p.block) ?? -1)).join('');
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
  void tpl;
  const slides = doc.slides ?? [];
  const cards = slides
    .map((s, i) => {
      const big = s.layout === 'title' || s.layout === 'section';
      const bullets = s.bullets.length
        ? `<ul class="ndoc-sli-ul">${s.bullets
            .map((b, j) => `<li><span class="ndoc-li-mk" aria-hidden="true">•</span><span data-ndoc-ed="sbullet" data-ndoc-j="${j}">${inlineMd(b)}</span></li>`)
            .join('')}</ul>`
        : '';
      return (
        `<section class="ndoc-sli${big ? ' ndoc-sli--big' : ''}" data-ndoc-sli data-ndoc-si="${i}" aria-label="Diapositive ${i + 1}">` +
        `<div class="ndoc-sli-rail" aria-hidden="true"></div>` +
        `<div class="ndoc-sli-body" style="font-family:${esc(fonts.heading)};">` +
        `<div class="ndoc-sli-tt" data-ndoc-ed="stitle">${s.title ? inlineMd(s.title) : '<span class="ndoc-sli-ph">Diapositive</span>'}</div>` +
        bullets +
        (s.layout === 'closing' ? '<div class="ndoc-sli-close">Merci</div>' : '') +
        `</div><div class="ndoc-sli-num">${i + 1}</div>` +
        (s.notes ? `<div class="ndoc-sli-notes"><span>Notes</span><p data-ndoc-ed="snotes">${inlineMd(s.notes)}</p></div>` : '') +
        '</section>'
      );
    })
    .join('');
  return cards || '<p class="ndoc-empty">Aucune diapositive.</p>';
}

function sheetsHtml(doc: DocumentDoc, tpl: DocumentTemplate): string {
  const sheets = doc.sheets ?? [];
  const base = tpl.typography.size;
  const cards = sheets
    .map((sheet, si) => {
      const cols = Math.max(1, sheet.header.length);
      const head = sheet.header
        .map((c, ci) => `<th data-ndoc-ed="shh" data-ndoc-c="${ci}">${inlineMd(c)}</th>`)
        .join('');
      const rows = sheet.rows
        .map(
          (row, ri) =>
            '<tr>' +
            Array.from({ length: cols }, (_, c) => `<td data-ndoc-ed="shcell" data-ndoc-r="${ri}" data-ndoc-c="${c}">${inlineMd(String(row[c] ?? ''))}</td>`).join('') +
            '</tr>'
        )
        .join('');
      return (
        `<section class="ndoc-sheet" data-ndoc-sheet data-ndoc-shi="${si}">` +
        `<header class="ndoc-sheet-hd"><span class="ndoc-sheet-name" data-ndoc-ed="shname">${inlineMd(sheet.name)}</span>` +
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
/* width:max-content keeps the pages' layout box at their natural width even
   when .ndoc-fit is shrunk by the scaler — WITHOUT it the flex column shrinks
   to the panel width and center-overflowing pages get clipped on the LEFT
   after transform-origin:top-left scaling (the "cut off document" bug). */
.ndoc-doc{display:flex;flex-direction:column;align-items:center;gap:22px;transform-origin:top left}
.ndoc-root[data-ndoc-mode="paper"] .ndoc-doc,.ndoc-root[data-ndoc-mode="slides"] .ndoc-doc{width:max-content}

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
.ndoc-sli{position:relative;width:720px;aspect-ratio:16/9;background:var(--tint);border-radius:12px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.10),0 12px 32px rgba(16,24,40,.13)}
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

/* — barre d'outils (zoom + pages + vues + état édition + IA) — */
.ndoc-bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:40;
  display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:center;max-width:calc(100% - 24px);
  padding:6px;border-radius:14px;background:rgba(24,26,25,.86);backdrop-filter:blur(10px);
  box-shadow:0 8px 28px rgba(0,0,0,.35);font-family:var(--fd)}
.ndoc-bar-brand{display:flex;align-items:center;gap:7px;padding:0 10px 0 8px;color:#e8ebea;font-size:11.5px;font-weight:600;letter-spacing:.01em;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.ndoc-bar-brand svg{flex-shrink:0}
.ndoc-bar-sep{width:1px;height:18px;background:rgba(255,255,255,.18);margin:0 4px}
/* zoom (− % +) — l'outil du studio, dans l'aperçu du code */
.ndoc-zoom{display:flex;align-items:center;gap:1px}
.ndoc-root[data-ndoc-mode="sheets"] .ndoc-zoom{display:none}
.ndoc-zbtn{appearance:none;border:0;border-radius:8px;min-width:26px;height:26px;padding:0 6px;cursor:pointer;
  background:transparent;color:#d9dddb;font-family:inherit;font-size:15px;font-weight:700;line-height:1}
.ndoc-zbtn:hover{background:rgba(255,255,255,.14);color:#fff}
.ndoc-zbtn:focus-visible{outline:2px solid #6ee7d7;outline-offset:1px}
.ndoc-zval{min-width:46px;text-align:center;font-size:11px;font-weight:700;color:#e8ebea;font-variant-numeric:tabular-nums;white-space:nowrap}
.ndoc-pages{font-size:11px;font-weight:700;color:#b8bebc;font-variant-numeric:tabular-nums;padding:0 5px;white-space:nowrap}
/* indicateur de page — suit le défilement */
.ndoc-fmt{appearance:none;border:0;border-radius:9px;padding:6px 9px;background:transparent;color:#d9dddb;
  font-family:inherit;font-size:11px;font-weight:700;letter-spacing:.05em;cursor:pointer;transition:background .15s ease,color .15s ease;text-transform:uppercase;text-align:left}
.ndoc-fmt:hover{background:rgba(255,255,255,.14);color:#fff}
.ndoc-fmt:focus-visible{outline:2px solid #6ee7d7;outline-offset:1px}
.ndoc-fmt[data-busy="1"]{opacity:.45;pointer-events:none}
.ndoc-dl{appearance:none;border:0;border-radius:9px;padding:6px 11px;cursor:pointer;
  background:transparent;color:#d9dddb;font-family:inherit;font-size:11.5px;font-weight:700;letter-spacing:.02em;
  display:flex;align-items:center;gap:6px;white-space:nowrap;transition:background .15s ease,color .15s ease}
.ndoc-dl:hover{background:rgba(255,255,255,.14);color:#fff}
.ndoc-dl:focus-visible{outline:2px solid #6ee7d7;outline-offset:1px}
.ndoc-edit{appearance:none;border:0;border-radius:9px;padding:6px 13px;cursor:pointer;
  background:var(--a);color:#fff;font-family:inherit;font-size:11.5px;font-weight:700;letter-spacing:.02em;
  transition:filter .15s ease;display:flex;align-items:center;gap:6px;white-space:nowrap}
.ndoc-edit:hover{filter:brightness(1.12)}
.ndoc-edit:focus-visible{outline:2px solid #fff;outline-offset:1px}
.ndoc-edit svg{width:12px;height:12px}
.ndoc-cancel{appearance:none;border:1px solid rgba(255,255,255,.25);border-radius:9px;padding:6px 11px;cursor:pointer;
  background:transparent;color:#d9dddb;font-family:inherit;font-size:11.5px;font-weight:600;white-space:nowrap}
.ndoc-cancel:hover{background:rgba(255,255,255,.12);color:#fff}
.ndoc-save{appearance:none;border:0;border-radius:9px;padding:6px 13px;cursor:pointer;
  background:#0F6B61;color:#fff;font-family:inherit;font-size:11.5px;font-weight:700;letter-spacing:.02em;
  display:flex;align-items:center;gap:6px;white-space:nowrap}
.ndoc-save:hover{filter:brightness(1.15)}
.ndoc-save[data-busy="1"]{opacity:.55;pointer-events:none}
.ndoc-ia{appearance:none;border:0;border-radius:9px;padding:6px 11px;cursor:pointer;
  background:linear-gradient(135deg,#7C3AED,#0F6B61);color:#fff;font-family:inherit;font-size:11.5px;font-weight:700;white-space:nowrap}
.ndoc-ia:hover{filter:brightness(1.12)}
.ndoc-dirty{width:8px;height:8px;border-radius:99px;background:#f59e0b;margin-left:2px;flex-shrink:0}
.ndoc-x{display:none}
/* popup des formats de téléchargement (s'ouvre au-dessus de la barre) */
.ndoc-fmts{position:fixed;right:14px;bottom:64px;z-index:41;display:flex;flex-direction:column;gap:2px;min-width:132px;
  padding:6px;border-radius:14px;background:rgba(24,26,25,.92);backdrop-filter:blur(10px);
  box-shadow:0 12px 34px rgba(0,0,0,.4);font-family:var(--fd)}
.ndoc-fmts.ndoc-x{display:none}

/* — panneau IA (instruction naturelle) — */
.ndoc-iap{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:41;display:flex;gap:6px;align-items:center;
  width:min(520px,calc(100% - 24px));padding:8px;border-radius:14px;background:rgba(24,26,25,.92);backdrop-filter:blur(10px);
  box-shadow:0 12px 34px rgba(0,0,0,.4);font-family:var(--fd)}
.ndoc-iap.ndoc-x{display:none}
.ndoc-iap input{flex:1;min-width:0;appearance:none;border:1px solid rgba(255,255,255,.18);border-radius:9px;background:rgba(255,255,255,.06);
  color:#fff;font-family:inherit;font-size:12.5px;padding:7px 11px;outline:none}
.ndoc-iap input:focus{border-color:#7C3AED}
.ndoc-iap input::placeholder{color:#9aa19e}
.ndoc-iap-run{appearance:none;border:0;border-radius:9px;padding:7px 13px;cursor:pointer;background:linear-gradient(135deg,#7C3AED,#0F6B61);
  color:#fff;font-family:inherit;font-size:12px;font-weight:700;white-space:nowrap}
.ndoc-iap-run[data-busy="1"]{opacity:.55;pointer-events:none}
.ndoc-iap-x{appearance:none;border:0;border-radius:9px;padding:7px 9px;cursor:pointer;background:transparent;color:#b8bebc;font-size:13px}
.ndoc-iap-x:hover{background:rgba(255,255,255,.12);color:#fff}

/* — toast (état des opérations) — */
.ndoc-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:42;display:flex;align-items:center;gap:8px;
  padding:8px 14px;border-radius:12px;background:rgba(24,26,25,.92);color:#e8ebea;font-family:var(--fd);font-size:12.5px;font-weight:600;
  box-shadow:0 12px 34px rgba(0,0,0,.4);max-width:calc(100% - 24px)}
.ndoc-toast.ndoc-x{display:none}
.ndoc-toast .ndoc-spin{width:14px;height:14px;border-radius:99px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;
  animation:ndoc-rotate .8s linear infinite;flex-shrink:0}
@keyframes ndoc-rotate{to{transform:rotate(360deg)}}

/* — mode édition : surfaces éditables + rails structure — */
.ndoc-root .ndoc-x{display:none}
.ndoc-editing [data-ndoc-ed]{border-radius:3px}
.ndoc-editing [data-ndoc-ed]:hover{background:rgba(127,127,127,.10);box-shadow:0 0 0 1px rgba(127,127,127,.28) inset}
.ndoc-editing [data-ndoc-ed]:focus{outline:none;background:rgba(127,127,127,.14);box-shadow:0 0 0 2px var(--a) inset}
.ndoc-editing [data-ndoc-ed]:empty:before{content:'…';color:var(--muted);opacity:.7}
.ndoc-editing [data-ndoc-block]{position:relative}
.ndoc-rail{display:none;position:absolute;top:-8px;right:2px;z-index:6;gap:3px;padding:2px;border-radius:8px;
  background:rgba(24,26,25,.85);box-shadow:0 3px 12px rgba(0,0,0,.3)}
.ndoc-editing [data-ndoc-block]:hover>.ndoc-rail,.ndoc-editing [data-ndoc-block]:focus-within>.ndoc-rail{display:flex}
.ndoc-editing [data-ndoc-sli]>.ndoc-rail,.ndoc-editing [data-ndoc-sli]:focus-within>.ndoc-rail{display:flex;top:8px;right:8px}
.ndoc-rail button{appearance:none;border:0;border-radius:6px;padding:3px 8px;cursor:pointer;background:transparent;color:#d9dddb;
  font-family:var(--fd);font-size:11px;font-weight:700;line-height:1;white-space:nowrap}
.ndoc-rail button:hover{background:rgba(255,255,255,.16);color:#fff}
.ndoc-rail button[data-ndoc-r="del"]:hover{background:#b91c1c;color:#fff}

/* — print (le téléchargement html natif de l'artefact) — */
@media print{
  .ndoc-root{background:#fff;padding:0}
  .ndoc-fit{width:auto}
  .ndoc-doc{gap:0;transform:none!important;width:auto!important}
  .ndoc-bar,.ndoc-iap,.ndoc-toast,.ndoc-rail,.ndoc-fmts{display:none!important}
  .ndoc-pg{width:auto;height:auto;min-height:auto;box-shadow:none;border-radius:0;break-after:page}
  .ndoc-pg:last-of-type{break-after:auto}
  .ndoc-pg-body{height:auto;overflow:visible}
  .ndoc-sli,.ndoc-sheet{box-shadow:none;break-inside:avoid;margin:0 auto 16px}
  .ndoc-editing [data-ndoc-ed]{background:none!important;box-shadow:none!important}
  @page{size:A4;margin:0}
}
/* Panneau étroit (side panel du SPA) : barre compacte sur UNE ligne —
   la marque puis l'indicateur de pages se replient d'abord ; le bas de
   page garde assez d'air pour que la barre (1-2 rangées enroulées) ne
   recouvre jamais le texte du document. */
@media (max-width:560px){
  .ndoc-root{padding:14px 6px 150px}
  .ndoc-bar-brand{display:none}
  .ndoc-dl span{display:none}
  .ndoc-dl{padding:6px 9px}
}
@media (max-width:420px){.ndoc-pages{display:none}.ndoc-bar-sep{margin:0 2px}}
@media (prefers-reduced-motion:reduce){.ndoc-root *,.ndoc-bar,.ndoc-iap,.ndoc-toast{transition:none!important}}
@media (prefers-reduced-motion:reduce){.ndoc-toast .ndoc-spin{animation:none}}
</style>`;
}

// ---------------------------------------------------------------------------
// Host script — editing studio, renderer, fit-to-width, pagination
// ---------------------------------------------------------------------------

const HOST_SCRIPT = `<script>
(function(){
  var DOC_ID = window.__NDOC_ID__;
  var MODE = window.__NDOC_MODE__;
  var TPL = window.__NDOC_TPL__ || {};
  var SDR = window.__NDOC_SDR__ || null;
  var seq = 0;
  var editing = false;
  var dirty = false;
  var busy = false;
  var snapshotSdr = null;
  var lastOpenCmd = 0;
  // zoom de l'aperçu (1 = ajusté à la largeur du panneau) — l'outil du studio
  var zoom = 1;
  var ZOOM_MIN = 0.5, ZOOM_MAX = 3, ZOOM_STEP = 0.25;

  function $(sel, root){ return (root || document).querySelector(sel); }
  function $$(sel, root){ return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // ------------------------------------------------------------ postMessage
  function post(msg){
    try { parent.postMessage(msg, '*'); } catch(e){}
  }
  function send(action, extra){
    var m = { nelthDocArtifact: Object.assign({ docId: DOC_ID, action: action }, extra || {}) };
    post(m);
  }

  // Images locales protégées (401 sans Bearer) : l'origine opaque ne peut pas
  // s'authentifier → le pont les relit en data-URL et répond par postMessage.
  var relaySeq = 0;
  var relayMap = {};
  document.addEventListener('error', function(e){
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || img.dataset.ndocRelay) return;
    var url = img.getAttribute('src') || '';
    if (!url || !/^\\//.test(url)) return;
    img.dataset.ndocRelay = '1';
    var rseq = ++relaySeq;
    relayMap[rseq] = img;
    send('image', { url: url, seq: rseq });
  }, true);

  window.addEventListener('message', function(e){
    var d = e.data;
    if (!d) return;
    if (d.nelthDocArtifactImage){
      var img = relayMap[d.nelthDocArtifactImage.seq];
      if (img && d.nelthDocArtifactImage.dataUrl) img.src = d.nelthDocArtifactImage.dataUrl;
      delete relayMap[d.nelthDocArtifactImage.seq];
      return;
    }
    var cmd = d.nelthDocCommand;
    if (cmd && cmd.docId === DOC_ID){
      if (cmd.action === 'open'){
        if (Date.now() - lastOpenCmd < 6000) return;
        lastOpenCmd = Date.now();
        refreshFromServer(false);
      }
      else if (cmd.action === 'edit'){ lastOpenCmd = 0; refreshFromServer(true); }
      return;
    }
    if (d.nelthDocSaved && d.nelthDocSaved.for === DOC_ID) onSaved(d.nelthDocSaved);
    if (d.nelthDocImproved && d.nelthDocImproved.for === DOC_ID) onImproved(d.nelthDocImproved);
    if (d.nelthDocFetched && d.nelthDocFetched.for === DOC_ID) onFetched(d.nelthDocFetched);
  });

  // ---------------------------------------------------------- md ↔ html mini
  function escText(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function imd(text){
    var out = escText(text);
    out = out.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\\s(«])\\*([^*\\n]+)\\*(?!\\*)/g, '$1<em>$2</em>');
    return out;
  }
  /** contentEditable html → markdown-lite (strong/em/code reconvertis). */
  function mdFromNode(node){
    var out = '';
    for (var i = 0; i < node.childNodes.length; i++){
      var n = node.childNodes[i];
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1){
        var tag = n.tagName.toLowerCase();
        if (tag === 'br') out += '\\n';
        else if (tag === 'strong' || tag === 'b') out += '**' + mdFromNode(n) + '**';
        else if (tag === 'em' || tag === 'i') out += '*' + mdFromNode(n) + '*';
        else if (tag === 'code') out += '\\u0060' + mdFromNode(n) + '\\u0060';
        else out += mdFromNode(n);
      }
    }
    return out;
  }
  function mdOf(el){ return (el ? mdFromNode(el) : '').replace(/\\u00a0/g,' '); }

  // ---------------------------------------------------------- mini renderer
  function hfs(level){ var b = TPL.base || 10.5; var s = TPL.headingScale || [1.6,1.28,1.1]; return b * (level===1?2:level===2?s[0]:level===3?s[1]:s[2]); }
  function blockHtml(blk, bi){
    var b = TPL.base || 10.5, lead = TPL.leading || 1;
    if (!blk) return '';
    switch (blk.t){
      case 'heading': {
        var cls = blk.level===1?'ndoc-h1':blk.level===2?'ndoc-h2':blk.level===3?'ndoc-h3':'ndoc-h4';
        var sz = hfs(blk.level).toFixed(2);
        var mt = (blk.level<=2?10:6), mb = (blk.level===1?14:blk.level===2?8:6);
        return '<div class="'+cls+' ndoc-heading" data-ndoc-block data-ndoc-bi="'+bi+'" data-ndoc-ed="text" style="font-size:'+sz+'pt;font-weight:'+(blk.level<=3?700:600)+';margin:'+mt+'pt 0 '+mb+'pt;">'+imd(blk.text)+'</div>';
      }
      case 'para':
        return '<p class="ndoc-p" data-ndoc-block data-ndoc-bi="'+bi+'" data-ndoc-ed="text" style="font-size:'+b+'pt;line-height:'+(1.42*lead).toFixed(3)+';margin:0 0 '+(7*lead).toFixed(1)+'pt;">'+imd(blk.text)+'</p>';
      case 'list': {
        var tag = blk.style==='number' ? 'ol' : 'ul';
        var mk = blk.style==='check' ? '☑' : (blk.style==='number' ? '' : '•');
        var items = '';
        for (var j = 0; j < blk.items.length; j++){
          var it = blk.items[j];
          items += '<li style="margin:0 0 '+(3.5*lead).toFixed(1)+'pt;padding-left:'+(10+it.level*14)+'pt;">'
            + (mk ? '<span class="ndoc-li-mk" aria-hidden="true">'+mk+'</span>' : '')
            + '<span data-ndoc-ed="li" data-ndoc-j="'+j+'">'+imd(it.text)+'</span></li>';
        }
        return '<'+tag+' class="ndoc-list" data-ndoc-block data-ndoc-bi="'+bi+'" style="font-size:'+b+'pt;line-height:'+(1.4*lead).toFixed(3)+';margin:0 0 '+(6*lead).toFixed(1)+'pt;padding:0;list-style:'+(blk.style==='number'?'decimal':'none')+';">'+items+'</'+tag+'>';
      }
      case 'table': {
        var cols = Math.max(1, blk.header.length);
        var head = '';
        for (var c = 0; c < cols; c++) head += '<th data-ndoc-ed="hcell" data-ndoc-c="'+c+'">'+imd(blk.header[c] == null ? '' : blk.header[c])+'</th>';
        var rows = '';
        for (var r = 0; r < blk.rows.length; r++){
          rows += '<tr>';
          for (var c2 = 0; c2 < cols; c2++) rows += '<td data-ndoc-ed="cell" data-ndoc-r="'+r+'" data-ndoc-c="'+c2+'">'+imd(blk.rows[r][c2] == null ? '' : String(blk.rows[r][c2]))+'</td>';
          rows += '</tr>';
        }
        return '<div class="ndoc-tbl-wrap" data-ndoc-block data-ndoc-bi="'+bi+'" style="margin:0 0 '+(10*lead).toFixed(1)+'pt;"><table class="ndoc-tbl" style="font-size:'+(b-1).toFixed(2)+'pt;"><thead><tr>'+head+'</tr></thead><tbody>'+rows+'</tbody></table>'
          + (blk.caption ? '<div class="ndoc-tbl-cap" data-ndoc-ed="caption">'+imd(blk.caption)+'</div>' : '') + '</div>';
      }
      case 'quote':
        return '<blockquote class="ndoc-quote" data-ndoc-block data-ndoc-bi="'+bi+'"><p data-ndoc-ed="text">'+imd(blk.text)+'</p>'
          + (blk.author ? '<footer data-ndoc-ed="author">— '+imd(blk.author)+'</footer>' : '') + '</blockquote>';
      case 'callout': {
        var ico = { info:'i', warning:'!', success:'✓', danger:'✕' }[blk.variant] || 'i';
        return '<div class="ndoc-callout ndoc-callout--'+(blk.variant||'info')+'" data-ndoc-block data-ndoc-bi="'+bi+'"><span class="ndoc-callout-ico" aria-hidden="true">'+ico+'</span><div>'
          + (blk.title ? '<div class="ndoc-callout-tt" data-ndoc-ed="ctitle">'+imd(blk.title)+'</div>' : '')
          + '<div data-ndoc-ed="text">'+imd(blk.text)+'</div></div></div>';
      }
      case 'code':
        return '<pre class="ndoc-code" data-ndoc-block data-ndoc-bi="'+bi+'">'+(blk.lang?'<span class="ndoc-code-lang">'+escText(blk.lang)+'</span>':'')+'<code data-ndoc-ed="codetext">'+escText(blk.text)+'</code></pre>';
      case 'divider':
        return '<hr class="ndoc-hr" data-ndoc-block data-ndoc-bi="-1" />';
      case 'pagebreak':
        return '';
      case 'image':
        return '<figure class="ndoc-fig" data-ndoc-block data-ndoc-bi="'+bi+'"><img src="'+escText(blk.url)+'" alt="'+escText(blk.alt||'Illustration')+'" loading="lazy" />'
          + (blk.alt ? '<figcaption data-ndoc-ed="text">'+imd(blk.alt)+'</figcaption>' : '') + '</figure>';
    }
    return '';
  }

  function paperBody(sdr){
    var m = TPL.margins || { top:66, side:56, bottom:62 };
    var html = '';
    var pageOpen = false;
    function openPage(){
      if (pageOpen) html += '</div><footer class="ndoc-pg-foot" style="left:'+m.side+'pt;right:'+m.side+'pt;bottom:'+(m.bottom*0.38).toFixed(1)+'pt;"><span class="ndoc-pg-title">'+escText(sdr.title||'')+'</span><span class="ndoc-pg-num"></span></footer></section>';
      html += '<section class="ndoc-pg" data-ndoc-pg><div class="ndoc-pg-body" style="padding:'+m.top+'pt '+m.side+'pt '+m.bottom+'pt;">';
      pageOpen = true;
    }
    openPage();
    for (var i = 0; i < (sdr.blocks ? sdr.blocks.length : 0); i++){
      var blk = sdr.blocks[i];
      if (blk && blk.t === 'pagebreak'){ openPage(); continue; }
      html += blockHtml(blk, i);
    }
    if (pageOpen) html += '</div><footer class="ndoc-pg-foot" style="left:'+m.side+'pt;right:'+m.side+'pt;bottom:'+(m.bottom*0.38).toFixed(1)+'pt;"><span class="ndoc-pg-title">'+escText(sdr.title||'')+'</span><span class="ndoc-pg-num"></span></footer></section>';
    return html;
  }

  function slidesBody(sdr){
    var out = '';
    var slides = sdr.slides || [];
    if (!slides.length) return '<p class="ndoc-empty">Aucune diapositive.</p>';
    for (var i = 0; i < slides.length; i++){
      var s = slides[i];
      var big = s.layout === 'title' || s.layout === 'section';
      var bullets = '';
      for (var j = 0; j < (s.bullets || []).length; j++){
        bullets += '<li><span class="ndoc-li-mk" aria-hidden="true">•</span><span data-ndoc-ed="sbullet" data-ndoc-j="'+j+'">'+imd(s.bullets[j])+'</span></li>';
      }
      out += '<section class="ndoc-sli'+(big?' ndoc-sli--big':'')+'" data-ndoc-sli data-ndoc-si="'+i+'" aria-label="Diapositive '+(i+1)+'">'
        + '<div class="ndoc-sli-rail" aria-hidden="true"></div>'
        + '<div class="ndoc-sli-body" style="font-family:var(--fh);"><div class="ndoc-sli-tt" data-ndoc-ed="stitle">'+(s.title ? imd(s.title) : '<span class="ndoc-sli-ph">Diapositive</span>')+'</div>'
        + (bullets ? '<ul class="ndoc-sli-ul">'+bullets+'</ul>' : '')
        + (s.layout === 'closing' ? '<div class="ndoc-sli-close">Merci</div>' : '')
        + '</div><div class="ndoc-sli-num">'+(i+1)+'</div>'
        + (s.notes ? '<div class="ndoc-sli-notes"><span>Notes</span><p data-ndoc-ed="snotes">'+imd(s.notes)+'</p></div>' : '')
        + '</section>';
    }
    return out;
  }

  function sheetsBody(sdr){
    var out = '';
    var sheets = sdr.sheets || [];
    if (!sheets.length) return '<p class="ndoc-empty">Feuille vide.</p>';
    var b = TPL.base || 10.5;
    for (var si = 0; si < sheets.length; si++){
      var sheet = sheets[si];
      var cols = Math.max(1, sheet.header.length);
      var head = '';
      for (var c = 0; c < cols; c++) head += '<th data-ndoc-ed="shh" data-ndoc-c="'+c+'">'+imd(sheet.header[c] == null ? '' : sheet.header[c])+'</th>';
      var rows = '';
      for (var r = 0; r < sheet.rows.length; r++){
        rows += '<tr>';
        for (var c2 = 0; c2 < cols; c2++) rows += '<td data-ndoc-ed="shcell" data-ndoc-r="'+r+'" data-ndoc-c="'+c2+'">'+imd(sheet.rows[r][c2] == null ? '' : String(sheet.rows[r][c2]))+'</td>';
        rows += '</tr>';
      }
      out += '<section class="ndoc-sheet" data-ndoc-sheet data-ndoc-shi="'+si+'"><header class="ndoc-sheet-hd">'
        + '<span class="ndoc-sheet-name" data-ndoc-ed="shname">'+imd(sheet.name)+'</span>'
        + '<span class="ndoc-sheet-meta">'+sheet.rows.length+' ligne'+(sheet.rows.length>1?'s':'')+' · '+cols+' colonne'+(cols>1?'s':'')+'</span></header>'
        + '<div class="ndoc-sheet-scroll"><table class="ndoc-tbl" style="font-size:'+(b-1).toFixed(2)+'pt;"><thead><tr>'+head+'</tr></thead><tbody>'+rows+'</tbody></table></div></section>';
    }
    return out;
  }

  /** Re-rendère intégralement le document depuis le SDR (après IA/save/fetch). */
  function renderDoc(sdr){
    SDR = sdr;
    var docEl = $('.ndoc-doc');
    if (!docEl) return;
    docEl.innerHTML = MODE === 'slides' ? slidesBody(SDR) : MODE === 'sheets' ? sheetsBody(SDR) : paperBody(SDR);
    boot();
    if (editing) wireEdit();
    updateBrand();
  }
  function updateBrand(){
    var b = $('[data-ndoc-brand]');
    if (b && SDR && SDR.title != null) b.textContent = SDR.title;
    var t = $('.ndoc-bar-brand');
    if (t) t.setAttribute('title', (SDR && SDR.title) || '');
  }

  // ---------------------------------------------------------- pagination
  function ensureNext(pg){
    var next = pg.nextElementSibling;
    if (next && next.hasAttribute && next.hasAttribute('data-ndoc-pg')) return next;
    next = document.createElement('section');
    next.className = 'ndoc-pg';
    next.setAttribute('data-ndoc-pg','');
    var body = pg.querySelector('.ndoc-pg-body');
    var nb = document.createElement('div');
    nb.className = 'ndoc-pg-body';
    if (body) nb.setAttribute('style', body.getAttribute('style') || '');
    var foot = document.createElement('footer');
    foot.className = 'ndoc-pg-foot';
    var oldFoot = pg.querySelector('.ndoc-pg-foot');
    if (oldFoot) foot.setAttribute('style', oldFoot.getAttribute('style') || '');
    var ls = document.createElement('span');
    ls.className = 'ndoc-pg-title';
    var oldTitle = pg.querySelector('.ndoc-pg-title');
    if (oldTitle) ls.textContent = oldTitle.textContent;
    var ns = document.createElement('span');
    ns.className = 'ndoc-pg-num';
    foot.appendChild(ls); foot.appendChild(ns);
    next.appendChild(nb); next.appendChild(foot);
    pg.parentNode.insertBefore(next, pg.nextSibling);
    return next;
  }
  function repaginate(){
    if (MODE !== 'paper') return;
    var i = 0, guard = 0;
    while (guard++ < 600){
      var pages = $$('.ndoc-pg');
      if (i >= pages.length) break;
      var body = pages[i].querySelector('.ndoc-pg-body');
      if (!body){ i++; continue; }
      if (body.scrollHeight <= body.clientHeight + 1){ i++; continue; }
      var blocks = body.querySelectorAll(':scope > [data-ndoc-block]');
      if (!blocks.length) blocks = body.querySelectorAll('[data-ndoc-block]');
      if (blocks.length <= 1){ i++; continue; }
      var last = blocks[blocks.length - 1];
      var next = ensureNext(pages[i]);
      var nb = next.querySelector('.ndoc-pg-body');
      if (nb) nb.insertBefore(last, nb.firstChild);
    }
    renumber();
  }
  function renumber(){
    var pages = $$('.ndoc-pg');
    for (var i = 0; i < pages.length; i++){
      var num = pages[i].querySelector('.ndoc-pg-num');
      if (num) num.textContent = (i + 1) + ' / ' + pages.length;
    }
  }

  // ---------------------------------------------------------- mise à l'échelle
  var rootEl, fitEl, docEl;
  function rescale(){
    rootEl = rootEl || $('.ndoc-root');
    fitEl = fitEl || $('.ndoc-fit');
    docEl = docEl || $('.ndoc-doc');
    if (!rootEl || !fitEl || !docEl) return;
    if (MODE === 'sheets'){ fitEl.style.width = ''; fitEl.style.height = ''; docEl.style.transform = ''; return; }
    var pad = 32;
    try {
      var cs = getComputedStyle(rootEl);
      pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    } catch(e){}
    var avail = Math.max(160, rootEl.clientWidth - pad - 2);
    var natural = docEl.scrollWidth || (MODE === 'slides' ? 720 : 794);
    var fitScale = Math.min(1, avail / natural);
    var s = fitScale * zoom;
    docEl.style.transformOrigin = 'top left';
    docEl.style.transform = Math.abs(s - 1) < 0.001 ? '' : 'scale(' + s + ')';
    fitEl.style.width = Math.round(natural * s) + 'px';
    fitEl.style.height = Math.round(docEl.offsetHeight * s) + 'px';
    var zv = $('[data-ndoc-zoomval]');
    if (zv) zv.textContent = Math.round(zoom * 100) + ' %';
  }

  // -------------------------------------------------- zoom + pages (studio)
  function setZoom(z){
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 20) / 20));
    rescale();
    updatePages();
  }
  /** Page la plus visible → indicateur « n / N » (suit le défilement). */
  function updatePages(){
    var el = $('[data-ndoc-pages]');
    if (!el) return;
    if (MODE !== 'paper'){ el.textContent = ''; el.classList.add('ndoc-x'); return; }
    el.classList.remove('ndoc-x');
    var pages = $$('.ndoc-pg');
    if (!pages.length){ el.textContent = ''; return; }
    var mid = window.innerHeight / 2, best = 0, bd = Infinity;
    for (var i = 0; i < pages.length; i++){
      var r = pages[i].getBoundingClientRect();
      var d = Math.abs(r.top + r.height / 2 - mid);
      if (d < bd){ bd = d; best = i; }
    }
    el.textContent = (best + 1) + ' / ' + pages.length;
  }
  var pageTick = false;
  window.addEventListener('scroll', function(){
    if (pageTick) return;
    pageTick = true;
    requestAnimationFrame(function(){ pageTick = false; updatePages(); });
  }, true);

  // ---------------------------------------------------------- édition
  function clone(o){ return JSON.parse(JSON.stringify(o)); }

  function collect(){
    if (!SDR) return null;
    var d = clone(SDR);
    if (MODE === 'slides'){
      $$('[data-ndoc-sli]').forEach(function(sec){
        var si = parseInt(sec.getAttribute('data-ndoc-si'), 10);
        var s = d.slides && d.slides[si];
        if (!s) return;
        var tt = sec.querySelector('[data-ndoc-ed="stitle"]');
        if (tt) s.title = mdOf(tt).trim();
        $$('[data-ndoc-ed="sbullet"]', sec).forEach(function(el){
          var j = parseInt(el.getAttribute('data-ndoc-j'), 10);
          if (s.bullets && s.bullets[j] != null) s.bullets[j] = mdOf(el).trim() || ' ';
        });
        var nt = sec.querySelector('[data-ndoc-ed="snotes"]');
        if (nt && s.notes != null) s.notes = mdOf(nt).trim();
      });
      return d;
    }
    if (MODE === 'sheets'){
      $$('[data-ndoc-sheet]').forEach(function(sec){
        var shi = parseInt(sec.getAttribute('data-ndoc-shi'), 10);
        var sh = d.sheets && d.sheets[shi];
        if (!sh) return;
        var nm = sec.querySelector('[data-ndoc-ed="shname"]');
        if (nm) sh.name = mdOf(nm).trim() || sh.name;
        $$('[data-ndoc-ed="shh"]', sec).forEach(function(el){
          var c = parseInt(el.getAttribute('data-ndoc-c'), 10);
          if (sh.header && sh.header[c] != null) sh.header[c] = mdOf(el).trim() || ' ';
        });
        $$('[data-ndoc-ed="shcell"]', sec).forEach(function(el){
          var r = parseInt(el.getAttribute('data-ndoc-r'), 10);
          var c = parseInt(el.getAttribute('data-ndoc-c'), 10);
          if (sh.rows && sh.rows[r] && sh.rows[r][c] != null) sh.rows[r][c] = mdOf(el).trim();
        });
      });
      return d;
    }
    $$('[data-ndoc-bi]').forEach(function(el){
      var bi = parseInt(el.getAttribute('data-ndoc-bi'), 10);
      var blk = d.blocks && d.blocks[bi];
      if (!blk) return;
      var t = el.getAttribute('data-ndoc-ed');
      if (t === 'text' && blk.t !== 'image') blk.text = mdOf(el).trim() || ' ';
      else if (t === 'codetext' && blk.t === 'code') blk.text = (el.textContent || '').trim() || ' ';
      $$('[data-ndoc-ed]', el).forEach(function(sub){
        var st = sub.getAttribute('data-ndoc-ed');
        var j = sub.getAttribute('data-ndoc-j');
        var r = sub.getAttribute('data-ndoc-r');
        var c = sub.getAttribute('data-ndoc-c');
        if (st === 'li' && blk.items && j != null) blk.items[+j].text = mdOf(sub).trim() || ' ';
        else if (st === 'hcell' && blk.header && c != null) blk.header[+c] = mdOf(sub).trim() || ' ';
        else if (st === 'cell' && blk.rows && r != null && c != null && blk.rows[+r]) blk.rows[+r][+c] = mdOf(sub).trim();
        else if (st === 'caption' && blk.t === 'table') blk.caption = mdOf(sub).trim();
        else if (st === 'author' && blk.t === 'quote') blk.author = mdOf(sub).replace(/^\\s*—\\s*/, '').trim();
        else if (st === 'ctitle' && blk.t === 'callout') blk.title = mdOf(sub).trim();
      });
      if (blk.t === 'quote'){
        var p = el.querySelector('p[data-ndoc-ed="text"]');
        if (p) blk.text = mdOf(p).trim() || ' ';
      }
      if (blk.t === 'callout'){
        var tx = el.querySelector('[data-ndoc-ed="text"]');
        if (tx) blk.text = mdOf(tx).trim() || ' ';
      }
      if (blk.t === 'image'){
        var cap = el.querySelector('figcaption[data-ndoc-ed="text"]');
        if (cap) blk.alt = mdOf(cap).trim();
      }
    });
    return d;
  }

  function setDirty(v){
    dirty = v;
    var el = $('[data-ndoc-dirty]');
    if (el) el.classList.toggle('ndoc-x', !v);
  }

  function wireEdit(){
    $$('.ndoc-rail').forEach(function(r){ r.remove(); });
    if (MODE === 'slides'){
      $$('[data-ndoc-sli]').forEach(function(sec){
        if (sec.querySelector(':scope > .ndoc-rail')) return;
        sec.insertAdjacentHTML('afterbegin', railHtml('slide'));
      });
    } else if (MODE !== 'sheets') {
      $$('[data-ndoc-bi]').forEach(function(el){
        if (el.querySelector(':scope > .ndoc-rail')) return;
        el.insertAdjacentHTML('afterbegin', railHtml(el.tagName === 'OL' || el.tagName === 'UL' ? 'list' : el.querySelector('.ndoc-tbl') ? 'table' : 'block'));
      });
    }
    $$('[data-ndoc-ed]').forEach(function(el){
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('spellcheck', 'false');
    });
  }
  function unwireEdit(){
    $$('[data-ndoc-ed]').forEach(function(el){
      el.removeAttribute('contenteditable');
      el.removeAttribute('spellcheck');
    });
    $$('.ndoc-rail').forEach(function(r){ r.remove(); });
  }
  function railHtml(kind){
    var b = '';
    if (kind === 'list') b += '<button type="button" data-ndoc-r="additem" title="Ajouter un élément">＋ élément</button>';
    if (kind === 'table') b += '<button type="button" data-ndoc-r="addrow" title="Ajouter une ligne">＋ ligne</button>'
      + '<button type="button" data-ndoc-r="delrow" title="Supprimer la dernière ligne">－ ligne</button>';
    if (kind === 'slide') b += '<button type="button" data-ndoc-r="addslide" title="Ajouter une diapositive">＋ diapo</button>';
    b += '<button type="button" data-ndoc-r="addp" title="Ajouter un paragraphe">＋ ¶</button>'
      + '<button type="button" data-ndoc-r="del" title="Supprimer">✕</button>';
    return '<span class="ndoc-rail" role="toolbar" aria-label="Modifier ce bloc">' + b + '</span>';
  }

  function mutate(fn){
    if (!SDR) return;
    var d = collect() || clone(SDR);
    if (!fn(d)) return;
    renderDoc(d);
    setDirty(true);
  }

  function railAction(act, host){
    if (!SDR) return;
    if (act === 'addp' || act === 'additem' || act === 'addrow' || act === 'delrow' || act === 'del' || act === 'addslide'){
      mutate(function(d){
        if (MODE === 'slides'){
          var si = parseInt(host.closest('[data-ndoc-sli]').getAttribute('data-ndoc-si'), 10);
          if (!d.slides || d.slides[si] == null) return false;
          if (act === 'addslide'){
            d.slides.splice(si + 1, 0, { title: ' ', bullets: [' '], layout: 'content' });
          } else if (act === 'addp'){
            d.slides[si].bullets = (d.slides[si].bullets || []).concat([' ']);
          } else if (act === 'del'){
            if (d.slides.length <= 1) return false;
            d.slides.splice(si, 1);
          }
          return true;
        }
        var el = host.closest('[data-ndoc-bi]');
        if (!el) return false;
        var bi = parseInt(el.getAttribute('data-ndoc-bi'), 10);
        var blk = d.blocks && d.blocks[bi];
        if (!blk) return false;
        if (act === 'addp'){
          d.blocks.splice(bi + 1, 0, { t: 'para', text: ' ' });
          return true;
        }
        if (blk.t === 'list'){
          if (act === 'additem'){ blk.items.push({ text: ' ', level: 0 }); return true; }
        } else if (blk.t === 'table'){
          if (act === 'addrow'){ blk.rows.push(new Array(Math.max(1, blk.header.length)).fill(' ')); return true; }
          if (act === 'delrow' && blk.rows.length){ blk.rows.pop(); return true; }
        }
        if (act === 'del' && d.blocks.length > 1){ d.blocks.splice(bi, 1); return true; }
        return false;
      });
    }
  }

  function enterEditMode(){
    if (editing || !SDR) return;
    editing = true;
    snapshotSdr = clone(SDR);
    wireEdit();
    document.body.classList.add('ndoc-editing');
    var root = $('.ndoc-root');
    if (root) root.classList.add('ndoc-editing');
    setDirty(false);
    syncBar();
    toast(null);
  }
  function exitEditMode(keepToast){
    if (!editing) return;
    editing = false;
    unwireEdit();
    document.body.classList.remove('ndoc-editing');
    var root = $('.ndoc-root');
    if (root) root.classList.remove('ndoc-editing');
    setDirty(false);
    syncBar();
    if (!keepToast) toast(null);
    closeIa();
  }

  function syncBar(){
    var b = $('.ndoc-bar');
    if (!b) return;
    $$('[data-ndoc-viewctl]', b).forEach(function(el){ el.classList.toggle('ndoc-x', editing); });
    $$('[data-ndoc-editctl]', b).forEach(function(el){ el.classList.toggle('ndoc-x', !editing); });
  }

  // ---------------------------------------------------------- save / improve
  var pendingImprove = null;
  function onSaved(r){
    busy = false;
    clearSaveTimeout();
    var btn = $('[data-ndoc-save]');
    if (btn) btn.removeAttribute('data-busy');
    if (r.ok && pendingImprove){
      // sauvegarde préalable silencieuse avant l'amélioration IA
      SDR = r.document || SDR;
      snapshotSdr = clone(SDR);
      setDirty(false);
      var ins = pendingImprove;
      pendingImprove = null;
      improve(ins);
      return;
    }
    if (r.ok){
      SDR = r.document || SDR;
      snapshotSdr = clone(SDR);
      setDirty(false);
      exitEditMode(true);
      toast('Enregistré ✓', 2200);
      updateBrand();
    } else {
      pendingImprove = null;
      toast("Échec de l'enregistrement" + (r.error ? ' — ' + r.error : ''), 3200);
    }
  }
  function onImproved(r){
    busy = false;
    clearSaveTimeout();
    var btn = $('[data-ndoc-iarun]');
    if (btn) btn.removeAttribute('data-busy');
    closeIa();
    if (r.ok && r.document){
      renderDoc(r.document);
      snapshotSdr = clone(SDR);
      setDirty(false);
      if (!editing) toast('Document amélioré ✓', 2400);
      else { exitEditMode(true); toast('Document amélioré ✓', 2400); }
    } else {
      toast("L'amélioration a échoué" + (r.error ? ' — ' + r.error : ''), 3200);
    }
  }
  function onFetched(r){
    if (r.ok && r.document){
      renderDoc(r.document);
      snapshotSdr = clone(SDR);
      setDirty(false);
      if (r.thenEdit){ exitEditMode(true); enterEditMode(); toast(null); }
      else toast(null);
    } else if (r.thenEdit){
      enterEditMode();
      toast('Ouverture de la version locale…', 2200);
    } else {
      toast(null);
    }
  }

  var saveTimeout = null;
  function save(silent){
    if (busy) return;
    var d = collect();
    if (!d) return;
    busy = true;
    var btn = $('[data-ndoc-save]');
    if (btn && !silent) btn.setAttribute('data-busy', '1');
    if (!silent) toast('Enregistrement…', 0, true);
    var myseq = ++seq;
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(function(){
      if (busy){ busy = false; var b2 = $('[data-ndoc-save]'); if (b2) b2.removeAttribute('data-busy'); toast("Pas de réponse du serveur — réessayez", 3200); }
    }, 25000);
    send('save', { document: d, seq: myseq });
  }
  function clearSaveTimeout(){
    if (saveTimeout){ clearTimeout(saveTimeout); saveTimeout = null; }
  }

  function improve(instruction){
    if (busy) return;
    busy = true;
    var btn = $('[data-ndoc-iarun]');
    if (btn) btn.setAttribute('data-busy', '1');
    toast("L'IA retravaille le document…", 0, true);
    send('improve', { instruction: instruction, seq: ++seq });
  }

  function refreshFromServer(thenEdit){
    send('fetch', { seq: ++seq, thenEdit: !!thenEdit });
    toast('Chargement…', 0, true);
  }

  // ---------------------------------------------------------- toast / IA
  var toastTimer = null;
  function toast(msg, duration, spin){
    var el = $('[data-ndoc-toast]');
    if (!el) return;
    if (toastTimer){ clearTimeout(toastTimer); toastTimer = null; }
    if (!msg){ el.classList.add('ndoc-x'); el.innerHTML = ''; return; }
    el.classList.remove('ndoc-x');
    el.innerHTML = (spin ? '<span class="ndoc-spin" aria-hidden="true"></span>' : '') + '<span></span>';
    el.lastChild.textContent = msg;
    if (duration) toastTimer = setTimeout(function(){ el.classList.add('ndoc-x'); }, duration);
  }
  function openIa(){
    closeIa();
    var p = document.createElement('div');
    p.className = 'ndoc-iap';
    p.setAttribute('data-ndoc-iap', '');
    p.setAttribute('role', 'group');
    p.setAttribute('aria-label', 'Amélioration par IA');
    p.innerHTML = '<input type="text" placeholder="Instruction pour l' + '’IA — ex : « raccourcir la conclusion, ton plus formel »">'
      + '<button type="button" class="ndoc-iap-run" data-ndoc-iarun>Améliorer</button>'
      + '<button type="button" class="ndoc-iap-x" data-ndoc-iax aria-label="Fermer">✕</button>';
    document.body.appendChild(p);
    var input = p.querySelector('input');
    setTimeout(function(){ try { input.focus(); } catch(e){} }, 30);
    input.addEventListener('keydown', function(e){
      if (e.key === 'Enter'){ runIa(); }
      if (e.key === 'Escape'){ closeIa(); }
    });
    p.querySelector('[data-ndoc-iarun]').addEventListener('click', runIa);
    p.querySelector('[data-ndoc-iax]').addEventListener('click', closeIa);
  }
  function closeIa(){
    var p = $('[data-ndoc-iap]');
    if (p) p.remove();
  }
  function runIa(){
    var p = $('[data-ndoc-iap]');
    if (!p) return;
    var input = p.querySelector('input');
    var instruction = (input && input.value || '').trim();
    if (!instruction){ try { input && input.focus(); } catch(e){} return; }
    // sauvegarde d'abord les retouches locales, PUIS l'IA retravaille la
    // version enregistrée (onSaved enchaîne sur improve) — jamais l'inverse.
    if (dirty){
      var d = collect();
      if (d){
        pendingImprove = instruction;
        toast('Enregistrement…', 0, true);
        saveQuiet(d);
        return;
      }
    }
    improve(instruction);
  }
  function saveQuiet(d){
    if (busy) { pendingImprove = null; return; }
    busy = true;
    var myseq = ++seq;
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(function(){
      if (busy){ busy = false; pendingImprove = null; toast("Pas de réponse du serveur — réessayez", 3200); }
    }, 25000);
    send('save', { document: d, seq: myseq });
  }

  // ---------------------------------------------------------- barre d'outils
  function toggleFormats(force){
    var p = $('[data-ndoc-fmts]');
    if (!p) return;
    var show = force == null ? p.classList.contains('ndoc-x') : force;
    p.classList.toggle('ndoc-x', !show);
  }
  document.addEventListener('click', function(e){
    var b = e.target.closest && e.target.closest('button');
    if (!b) {
      // clic hors du popup des formats → le referme
      var fp = $('[data-ndoc-fmts]');
      if (fp && !fp.classList.contains('ndoc-x') && !(e.target.closest && e.target.closest('[data-ndoc-fmts], [data-ndoc-dl]'))) toggleFormats(false);
      return;
    }
    if (b.hasAttribute('data-fmt')){
      b.setAttribute('data-busy', '1');
      setTimeout(function(){ b.removeAttribute('data-busy'); }, 4000);
      send('download', { format: b.getAttribute('data-fmt') });
      toggleFormats(false);
      return;
    }
    if (b.hasAttribute('data-zoom-out')){ setZoom(zoom - ZOOM_STEP); return; }
    if (b.hasAttribute('data-zoom-in')){ setZoom(zoom + ZOOM_STEP); return; }
    if (b.hasAttribute('data-ndoc-dl')){ toggleFormats(); return; }
    if (b.hasAttribute('data-ndoc-edit')){
      if (!editing) refreshFromServer(true);
      return;
    }
    if (b.hasAttribute('data-ndoc-save')){ save(); return; }
    if (b.hasAttribute('data-ndoc-cancel')){
      if (dirty && snapshotSdr != null){ renderDoc(clone(snapshotSdr)); }
      exitEditMode();
      return;
    }
    if (b.hasAttribute('data-ndoc-ia')){ openIa(); return; }
  });
  document.addEventListener('click', function(e){
    var r = e.target.closest && e.target.closest('[data-ndoc-r]');
    if (r) railAction(r.getAttribute('data-ndoc-r'), r);
  });
  document.addEventListener('input', function(){
    if (editing && !busy) setDirty(true);
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape'){
      if (editing && !busy){ exitEditMode(); }
      toggleFormats(false);
      closeIa();
    }
  });

  // ---------------------------------------------------------- boot
  function boot(){
    repaginate();
    rescale();
    renumber();
    updatePages();
  }
  function start(){
    boot();
    syncBar();
    if (window.ResizeObserver && $('.ndoc-root')){
      try { new ResizeObserver(function(){ rescale(); }).observe($('.ndoc-root')); } catch(e){}
    }
    window.addEventListener('resize', function(){ rescale(); });
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(function(){ rescale(); });
    window.addEventListener('load', function(){ rescale(); });
    // les images relais (data-URL) arrivent plus tard → recale au load de chaque image
    document.addEventListener('load', function(e){ if (e.target && e.target.tagName === 'IMG') rescale(); }, true);
    updateBrand();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
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
 * document renders to more than ARTIFACT_MAX_HTML bytes (the chat card still
 * carries it — only the inline artifact is skipped).
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

  const DL_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

  const bar =
    `<nav class="ndoc-bar" aria-label="Actions du document">` +
    `<span class="ndoc-bar-brand" title="${esc(doc.title)}">${N_MARK}<span data-ndoc-brand>${esc(doc.title)}</span></span>` +
    `<span class="ndoc-bar-sep" aria-hidden="true"></span>` +
    // — zoom (− % +) : l'outil du studio, dans l'aperçu du code —
    `<span class="ndoc-zoom" role="group" aria-label="Zoom de l'aperçu">` +
    `<button type="button" class="ndoc-zbtn" data-zoom-out title="Réduire (zoom −25 %)">−</button>` +
    `<span class="ndoc-zval" data-ndoc-zoomval aria-live="polite">100 %</span>` +
    `<button type="button" class="ndoc-zbtn" data-zoom-in title="Agrandir (zoom +25 %)">+</button>` +
    `</span>` +
    // — page courante (suit le défilement) —
    `<span class="ndoc-pages ndoc-x" data-ndoc-pages aria-live="polite"></span>` +
    `<span class="ndoc-bar-sep" aria-hidden="true"></span>` +
    // — téléchargement multi-formats (popup) —
    `<button type="button" class="ndoc-dl" data-ndoc-dl title="Télécharger — PDF, DOCX, XLSX, PPTX, CSV, MD, TXT" aria-haspopup="menu">${DL_ICON}<span>Télécharger</span></button>` +
    `<span class="ndoc-bar-sep" aria-hidden="true"></span>` +
    // — vue —
    `<button type="button" class="ndoc-edit" data-ndoc-edit data-ndoc-viewctl title="Modifier dans l'aperçu">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>` +
    `<span>Modifier</span></button>` +
    // — édition —
    `<button type="button" class="ndoc-cancel ndoc-x" data-ndoc-cancel data-ndoc-editctl title="Annuler les modifications">Annuler</button>` +
    `<button type="button" class="ndoc-save ndoc-x" data-ndoc-save data-ndoc-editctl title="Enregistrer le document">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>` +
    `<span>Enregistrer</span></button>` +
    `<button type="button" class="ndoc-ia ndoc-x" data-ndoc-ia data-ndoc-editctl title="Améliorer avec l'IA">✨ IA</button>` +
    `<span class="ndoc-dirty ndoc-x" data-ndoc-dirty title="Modifications non enregistrées" aria-hidden="true"></span>` +
    `</nav>` +
    // popup des formats (s'ouvre au-dessus de la barre, à droite)
    `<div class="ndoc-fmts ndoc-x" data-ndoc-fmts role="menu" aria-label="Formats de téléchargement">${fmtButtons}</div>` +
    `<div class="ndoc-toast ndoc-x" data-ndoc-toast role="status" aria-live="polite"></div>`;

  const tplParams = {
    base: tpl.typography.size,
    leading: tpl.typography.leading,
    headingScale: tpl.typography.headingScale,
    margins: {
      top: tpl.page.top,
      side: tpl.page.side,
      bottom: tpl.page.bottom,
    },
  };

  const head =
    `<!--nelth-doc-artifact:${esc(opts.documentId)}-->` +
    `<script>window.__NDOC_ID__=${jsStr(opts.documentId)};window.__NDOC_MODE__=${jsStr(mode)};` +
    `window.__NDOC_TPL__=${jsStr(JSON.stringify(tplParams))};` +
    `window.__NDOC_SDR__=${jsStr(JSON.stringify(doc))};` +
    `<\/script>`;

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
