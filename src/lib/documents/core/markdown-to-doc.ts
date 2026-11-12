import { z } from 'zod';
import {
  DocumentDocSchema,
  DOC_TYPES,
  type DocBlock,
  type DocSheet,
  type DocSlide,
  type DocType,
  type DocumentDoc,
} from './document-schema';
import { defaultTemplateForType } from '../templates';

/**
 * Markdown → SDR conversion.
 *
 * A dedicated parser (NOT markdownToLines — that one strips inline emphasis
 * for the flat PDF pipeline; the SDR KEEPS **bold** / *italic* / `code`
 * inside block text so every renderer applies real typographic emphasis).
 *
 * Extra structures recognized over plain prose documents:
 *   • `> [!INFO|WARNING|SUCCESS|DANGER] Title` GitHub-style callouts
 *   • ``` fenced code blocks (kept as code blocks)
 *   • spreadsheet docs: `## Sheet name` + pipe table (or raw CSV) → sheets
 *   • presentation docs: `#`/`##` sections → slides with bullets
 */

// ---------------------------------------------------------------------------
// Inline hygiene
// ---------------------------------------------------------------------------

/** Images inside text are hoisted as image blocks by the parser; links stay
 *  as `label (url)` inline text so nothing is silently lost. */
function stripMdLinks(s: string): string {
  return s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparator = (line: string) =>
  /^\s*\|?[\s:-]*-[-\s:|]*\|\s*$/.test(line) && line.includes('-');

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

function listLevel(indent: string): number {
  const n = Math.floor((indent.replace(/\t/g, '  ').length || 0) / 2);
  return Math.max(0, Math.min(2, n));
}

/** Heading level from a `####` match, clamped to 1..4. */
function headingLevel(hash: string): 1 | 2 | 3 | 4 {
  return Math.min(4, Math.max(1, hash.length)) as 1 | 2 | 3 | 4;
}

// ---------------------------------------------------------------------------
// Blocks parsing (prose documents)
// ---------------------------------------------------------------------------

export function markdownToBlocks(md: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const raw = md.replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  let para: string[] = [];
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ t: 'para', text: stripMdLinks(para.join(' ').trim()) });
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      const text = quote.join(' ').trim();
      const callout = text.match(/^\[!(INFO|WARNING|SUCCESS|DANGER|TIP|NOTE|CAUTION|IMPORTANT)\]\s*(.*)$/i);
      if (callout) {
        const raw2 = callout[1].toUpperCase();
        const variant =
          raw2 === 'WARNING' || raw2 === 'CAUTION'
            ? 'warning'
            : raw2 === 'SUCCESS'
              ? 'success'
              : raw2 === 'DANGER'
                ? 'danger'
                : 'info';
        // First line: [!TAG] Title — remaining quote lines are the body.
        const firstLine = callout[2].trim();
        const rest = quote.slice(1).join(' ').trim();
        const title = firstLine || undefined;
        const body = rest || firstLine;
        blocks.push({ t: 'callout', variant, title, text: body || ' ' });
      } else {
        blocks.push({ t: 'quote', text: stripMdLinks(text) });
      }
      quote = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    if (!line.trim()) {
      flushPara();
      flushQuote();
      continue;
    }

    // Fenced code block — kept verbatim (its own renderer in every format).
    const fence = line.match(/^```[ \t]*([a-zA-Z0-9_-]*)[ \t]*$/);
    if (fence && line.trim().startsWith('```')) {
      flushPara();
      flushQuote();
      const lang = fence[1] || undefined;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^```[ \t]*$/.test(lines[j].replace(/\s+$/, ''))) break;
        body.push(lines[j]);
      }
      if (body.length) blocks.push({ t: 'code', text: body.join('\n'), lang });
      i = j; // drop the closing fence (or run off the end)
      continue;
    }

    // Headings — text may carry inline md.
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      flushQuote();
      blocks.push({ t: 'heading', level: headingLevel(h[1]), text: stripMdLinks(h[2].trim()) });
      continue;
    }

    // Divider.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      flushQuote();
      blocks.push({ t: 'divider' });
      continue;
    }

    // Blockquote / callout run.
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      flushPara();
      quote.push(q[1].trim());
      continue;
    }
    flushQuote();

    // Table run.
    if (isTableRow(line) && !isTableSeparator(line)) {
      flushPara();
      const cells = splitTableRow(line);
      const next = (lines[i + 1] ?? '').trim();
      const hasHeader = isTableSeparator(next);
      const header = hasHeader ? cells : cells.map((_c, idx) => `Colonne ${idx + 1}`);
      const rows: string[][] = [];
      let j = hasHeader ? i + 2 : i + 1;
      for (; j < lines.length; j++) {
        const rl = lines[j].replace(/\s+$/, '');
        if (!isTableRow(rl)) break;
        if (isTableSeparator(rl)) continue;
        rows.push(splitTableRow(rl));
      }
      blocks.push({ t: 'table', header, rows });
      i = j - 1;
      continue;
    }

    // Images on their own line → image blocks (inline images in paragraphs
    // are rare in generated documents; hoisting keeps the paragraph clean).
    const img = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      flushPara();
      blocks.push({ t: 'image', url: img[2], alt: img[1] || undefined });
      continue;
    }

    // Numbered list run.
    const n = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (n && listLevel(n[1]) <= 1) {
      flushPara();
      const items: { text: string; level: number }[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const nl = lines[j].replace(/\s+$/, '');
        const nm = nl.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
        if (!nm) {
          // Continuation line of the last item (soft-wrap in the source).
          if (/^\s+\S/.test(nl) && items.length) {
            items[items.length - 1].text += ' ' + stripMdLinks(nl.trim());
            continue;
          }
          break;
        }
        items.push({ text: stripMdLinks(nm[3].trim()), level: listLevel(nm[1]) });
      }
      blocks.push({ t: 'list', style: 'number', items });
      i = j - 1;
      continue;
    }

    // Bullet / checkbox list run.
    const b = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (b) {
      flushPara();
      const items: { text: string; level: number }[] = [];
      let check = false;
      let j = i;
      for (; j < lines.length; j++) {
        const bl = lines[j].replace(/\s+$/, '');
        const bm = bl.match(/^(\s*)[-*+]\s+(.*)$/);
        if (!bm) {
          if (/^\s+\S/.test(bl) && items.length) {
            items[items.length - 1].text += ' ' + stripMdLinks(bl.trim());
            continue;
          }
          break;
        }
        let text = bm[2];
        const cb = text.match(/^\[( |x|X)\]\s+(.*)$/);
        if (cb) {
          check = true;
          text = (cb[1].toLowerCase() === 'x' ? '☑ ' : '☐ ') + cb[2];
        }
        items.push({ text: stripMdLinks(text.trim()), level: listLevel(bm[1]) });
      }
      blocks.push({ t: 'list', style: check ? 'check' : 'bullet', items });
      i = j - 1;
      continue;
    }

    para.push(line.trim());
  }
  flushPara();
  flushQuote();

  // Callouts parsed with a title but empty text — pull the following para?
  // The parser emitted them in order; an empty callout is dropped instead.
  return blocks.filter(
    (blk) => !(blk.t === 'callout' && !blk.text && !blk.title) && !(blk.t === 'para' && !blk.text)
  );
}

// ---------------------------------------------------------------------------
// Spreadsheet parsing (XLSX / CSV documents)
// ---------------------------------------------------------------------------

export function parseDocSheets(md: string): DocSheet[] {
  const sheets: DocSheet[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let current: { name: string; header: string[]; rows: string[][] } | null = null;

  const flush = () => {
    if (current && (current.header.length || current.rows.length)) sheets.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) {
      flush();
      current = { name: h[1].trim().slice(0, 31) || 'Feuille', header: [], rows: [] };
      continue;
    }
    if (isTableRow(line) && !isTableSeparator(line)) {
      if (!current) current = { name: 'Feuille 1', header: [], rows: [] };
      const cells = splitTableRow(line);
      const next = (lines[i + 1] ?? '').trim();
      if (isTableSeparator(next) && !current.header.length && !current.rows.length) {
        current.header = cells;
        i++;
        continue;
      }
      current.rows.push(cells);
      continue;
    }
    // Non-table, non-heading lines (intro sentences, totals) are skipped —
    // the sheets carry the data.
  }
  flush();

  // Raw CSV (no pipes at all) → one sheet.
  if (!sheets.length && md.includes(',') && !md.includes('|')) {
    const rows = md
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(',').map((c) => c.trim()));
    if (rows.length) sheets.push({ name: 'Feuille 1', header: rows[0], rows: rows.slice(1) });
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// Presentation parsing (PPTX documents)
// ---------------------------------------------------------------------------

export function parseDocSlides(md: string): DocSlide[] {
  const slides: DocSlide[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let current: { title: string; bullets: string[] } | null = null;

  const flush = () => {
    if (current && (current.title || current.bullets.length)) {
      slides.push({ title: current.title, bullets: current.bullets, layout: 'content' });
    }
    current = null;
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = headingLevel(h[1]);
      // `#` (level 1) = the deck title slide; `##`+ = one slide per section.
      if (level <= 2) {
        flush();
        current = { title: h[2].trim(), bullets: [] };
        continue;
      }
      // Deeper headings become bold-ish bullets inside the current slide.
      if (current) current.bullets.push('**' + h[2].trim() + '**');
      continue;
    }
    const b = t.match(/^(\s*)[-*+]\s+(.*)$/);
    if (b && current) {
      current.bullets.push(stripMdLinks(b[2].trim()));
      continue;
    }
    // Plain paragraph inside a section → one bullet per sentence-ish line.
    if (current) current.bullets.push(stripMdLinks(t));
  }
  flush();

  // Mark first/closing slides for layout variety.
  if (slides.length) {
    slides[0] = { ...slides[0], layout: 'title' };
    const last = slides[slides.length - 1];
    if (last && last.layout === 'content' && /merci|thank|conclusion/i.test(last.title)) {
      slides[slides.length - 1] = { ...last, layout: 'closing' };
    }
  }
  return slides;
}

// ---------------------------------------------------------------------------
// Doc type + language inference
// ---------------------------------------------------------------------------

const CV_RE = /\b(curriculum\s+vitae|\bcv\b|exp[ée]rience\s+professionnelle|comp[ée]tences|formations?\b.*\b(vitae|professionnelles))/i;
const INVOICE_RE = /\b(facture|invoice|montant\s+(total|d[ûu]|ht)|tva|num[ée]ro\s+de\s+facture|sub?total)/i;
const PROPOSAL_RE = /\b(proposition\s+(commerciale|de\s+projet)|business\s+proposal|offre\s+(commerciale|de\s+service)|devis\b)/i;
const LETTER_RE = /\b(lettre|objet\s*:|madame,|monsieur,|cordialement|votre\s+(d[ée]vou[ée]|sinc[èe]re)|sinc[èe]rement\s+le\s+)/i;
const PLAN_RE = /\b(plan\s+(d'|de\s+)?(action|projet|business)|roadmap|jalons?\s*:|phases?\s+\d|calendrier)/i;
const CONTRACT_RE = /\b(contrat|article\s+\d|clause\s+\d|les\s+parties\s+(ont|ont\s+conclu)|engagent\s+mutuellement)/i;
const RESEARCH_RE = /\b(m[ée]moire|[ée]tude\s+(de\s+)?cas|recherche|m[ée]thodologie|r[ée]f[ée]rences\s+bibliographiques|bibliographie|abstract)/i;

/** Infer the document type from its content (title + first blocks). */
export function inferDocType(md: string, ext: string): DocType {
  const head = md.slice(0, 6_000);
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return 'spreadsheet';
  if (ext === 'pptx' || ext === 'ppt') return 'presentation';
  const checks: [RegExp, DocType][] = [
    [CV_RE, 'cv'],
    [INVOICE_RE, 'invoice'],
    [PROPOSAL_RE, 'proposal'],
    [CONTRACT_RE, 'contract'],
    [LETTER_RE, 'letter'],
    [PLAN_RE, 'plan'],
    [RESEARCH_RE, 'research'],
  ];
  for (const [re, type] of checks) if (re.test(head)) return type;
  if (/\b(rapport|report|bilan|synth[èe]se|analyse|kpi|indicateurs)\b/i.test(head)) return 'report';
  return 'other';
}

/** Light language detection (French vs English vs other). */
export function inferLanguage(md: string): string {
  const head = md.slice(0, 3_000).toLowerCase();
  const fr = (head.match(/\b(le|la|les|des|une|est|dans|pour|avec|plus|cette|nous|vous|être|aux)\b/g) || []).length;
  const en = (head.match(/\b(the|of|and|to|in|for|with|this|that|will|from|have|are|you|our)\b/g) || []).length;
  if (fr > en * 1.4) return 'fr';
  if (en > fr * 1.4) return 'en';
  return fr >= en ? 'fr' : 'en';
}

// ---------------------------------------------------------------------------
// Full conversion: markdown block → validated DocumentDoc
// ---------------------------------------------------------------------------

/** Title for the SDR: first H1, else the filename stem, else "Document". */
function pickTitle(md: string, filename: string): string {
  const h1 = md.match(/^\s*#\s+(.+)$/m);
  if (h1) return h1[1].trim().slice(0, 300);
  const stem = filename.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
  if (stem) return stem.slice(0, 300);
  return 'Document';
}

export type MarkdownToDocOptions = {
  filename: string;
  ext: string;
  /** Chat-flow design decision ('moderne' → modern template default). */
  modern?: boolean;
  /** Explicit template id (user/editor choice). */
  template?: string;
};

/** Markdown (a ```document block body) → validated SDR. */
export function markdownToDocument(md: string, opts: MarkdownToDocOptions): DocumentDoc {
  const ext = opts.ext.toLowerCase();
  const docType = inferDocType(md, ext);
  const now = Math.floor(Date.now() / 1000);

  // Template resolution: explicit → modern gate → doc-type default.
  let template = opts.template;
  if (!template) {
    if (opts.modern) template = 'modern';
    else template = defaultTemplateForType(docType);
  }

  const base = {
    v: 1 as const,
    title: pickTitle(md, opts.filename),
    docType,
    language: inferLanguage(md),
    template,
    createdAt: now,
    updatedAt: now,
  };

  if (docType === 'spreadsheet') {
    const sheets = parseDocSheets(md);
    return DocumentDocSchema.parse({
      ...base,
      title: pickTitle(md, opts.filename),
      blocks: markdownToBlocks(md).slice(0, 8),
      sheets: sheets.length ? sheets : [{ name: 'Feuille 1', header: ['Contenu'], rows: [] }],
    });
  }

  if (docType === 'presentation') {
    const slides = parseDocSlides(md);
    return DocumentDocSchema.parse({
      ...base,
      blocks: markdownToBlocks(md).slice(0, 8),
      slides: slides.length ? slides : [{ title: base.title, bullets: [], layout: 'title' }],
    });
  }

  return DocumentDocSchema.parse({ ...base, blocks: markdownToBlocks(md) });
}

// ---------------------------------------------------------------------------
// SDR → markdown serializer (exports + AI improve round-trips)
// ---------------------------------------------------------------------------

/** Re-serialize the SDR to clean markdown (used by export generators and the
 *  AI improve prompt — the SAME inline grammar the parsers read). */
export function documentToMarkdown(doc: DocumentDoc): string {
  if (doc.docType === 'spreadsheet' && doc.sheets?.length) {
    const parts: string[] = [];
    for (const sheet of doc.sheets) {
      parts.push(`## ${sheet.name}`);
      const rows = [sheet.header, ...sheet.rows];
      parts.push(rows.map((r) => '| ' + r.join(' | ') + ' |').join('\n'));
      parts.push('');
    }
    return parts.join('\n');
  }
  if (doc.docType === 'presentation' && doc.slides?.length) {
    const parts: string[] = [];
    for (const slide of doc.slides) {
      parts.push(`## ${slide.title || slide.layout}`);
      for (const bullet of slide.bullets) parts.push(`- ${bullet}`);
      if (slide.notes) parts.push(`> ${slide.notes}`);
      parts.push('');
    }
    return parts.join('\n');
  }
  const out: string[] = [];
  for (const blk of doc.blocks) {
    switch (blk.t) {
      case 'heading':
        out.push('#'.repeat(Math.min(4, Math.max(1, blk.level))) + ' ' + blk.text);
        break;
      case 'para':
        out.push(blk.text);
        break;
      case 'list':
        for (const item of blk.items) {
          const mark = blk.style === 'number' ? '1.' : '-';
          out.push('  '.repeat(item.level) + mark + ' ' + item.text);
        }
        break;
      case 'table': {
        const rows = [blk.header, ...blk.rows];
        if (rows.length > 0) {
          out.push('| ' + rows[0].join(' | ') + ' |');
          out.push('|' + rows[0].map(() => ' --- ').join('|') + '|');
          for (const row of rows.slice(1)) out.push('| ' + row.join(' | ') + ' |');
        }
        if (blk.caption) out.push(`*${blk.caption}*`);
        break;
      }
      case 'quote':
        out.push('> ' + blk.text);
        break;
      case 'callout':
        out.push(`> [!${blk.variant.toUpperCase()}] ${blk.title ?? ''}\n> ${blk.text}`);
        break;
      case 'code':
        out.push('```' + (blk.lang ?? '') + '\n' + blk.text + '\n```');
        break;
      case 'divider':
        out.push('---');
        break;
      case 'pagebreak':
        out.push('---');
        break;
      case 'image':
        out.push(`![${blk.alt ?? ''}](${blk.url})`);
        break;
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Validate an arbitrary object as a DocumentDoc (API PATCH payloads). */
export function validateDocument(value: unknown): DocumentDoc | null {
  const parsed = DocumentDocSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Validate/normalize doc type. */
export function normalizeDocType(value: unknown): DocType | null {
  const parsed = z.enum(DOC_TYPES).safeParse(value);
  return parsed.success ? parsed.data : null;
}
