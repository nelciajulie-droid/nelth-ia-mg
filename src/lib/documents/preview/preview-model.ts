import type { DocumentDoc, DocBlock } from '../core/document-schema';
import { resolveTemplate, type DocumentTemplate } from '../templates';

/**
 * Preview model — SDR + template → paginated pages for the workspace.
 *
 * The SAME estimation rules the PDF converter applies (A4, template margins,
 * font-size scale, table row heights, keep-with-next headings) so the live
 * preview's page breaks track the exported PDF. Pure TypeScript, no DOM —
 * shared by the React workspace bundle (client) and any server-side preview.
 */

export const A4_W = 595.28; // pt
export const A4_H = 841.89; // pt

/** One block placed with its estimated print height (pt). */
export type PlacedBlock = {
  block: DocBlock;
  /** Estimated height on the page, pt. */
  height: number;
};

export type PreviewPage = {
  index: number; // 1-based
  blocks: PlacedBlock[];
  /** True when the page starts with a forced page break. */
  forcedBreak: boolean;
};

export type DocumentPreview = {
  pages: PreviewPage[];
  template: DocumentTemplate;
  pageWidth: number;
  pageHeight: number;
  margins: { top: number; bottom: number; side: number };
  headingIds: Array<{ id: string; level: number; text: string; page: number }>;
};

/** Average glyph width as a fraction of the font size (heuristic per family). */
const CHAR_W = { sans: 0.5, serif: 0.52 } as const;

/** Strip markdown inline markers for measurement (rendered width only). */
function visibleLength(text: string): number {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .length;
}

function wrapLines(text: string, fontSize: number, widthPt: number, family: 'sans' | 'serif'): number {
  const charsPerLine = Math.max(8, Math.floor(widthPt / (fontSize * CHAR_W[family])));
  const paragraphs = text.split('\n');
  let lines = 0;
  for (const p of paragraphs) {
    const len = visibleLength(p);
    lines += Math.max(1, Math.ceil(len / charsPerLine));
  }
  return lines;
}

/** Estimate a block's print height (pt) under the template. */
function blockHeight(blk: DocBlock, tpl: DocumentTemplate, contentW: number): number {
  const fam = tpl.typography.family;
  const base = tpl.typography.size;
  const [s2, s3, s4] = tpl.typography.headingScale;
  const scale = tpl.typography.leading;
  switch (blk.t) {
    case 'heading': {
      const size = base * (blk.level === 1 ? 2.0 : blk.level === 2 ? s2 : blk.level === 3 ? s3 : s4);
      const lines = wrapLines(blk.text, size, contentW, fam);
      // Space before/after mirrors the PDF rhythm (≈0.35em + 0.5em).
      return lines * size * 1.25 * scale + (blk.level <= 2 ? 14 : 8) + (blk.level === 1 ? 16 : 6);
    }
    case 'para':
      return wrapLines(blk.text, base, contentW, fam) * base * 1.42 * scale + 7;
    case 'list': {
      let h = 0;
      for (const item of blk.items) {
        const indent = item.level * 16;
        h += wrapLines(item.text, base, Math.max(60, contentW - 14 - indent), fam) * base * 1.4 * scale + 3.5;
      }
      return h + 6;
    }
    case 'table': {
      // Header + rows; each row wraps by its longest cell against the column
      // share — cells measure ~ (contentW / nCols) wide.
      const nCols = Math.max(1, blk.header.length);
      const colW = contentW / nCols;
      const headerH = 24;
      let rowsH = 0;
      for (const row of blk.rows.slice(0, 200)) {
        let rowLines = 1;
        for (const cell of row) rowLines = Math.max(rowLines, wrapLines(cell, base - 1, colW, fam));
        rowsH += rowLines * (base - 1) * 1.45 + 8;
      }
      return headerH + rowsH + (blk.caption ? 16 : 0) + 10;
    }
    case 'quote':
      return wrapLines(blk.text, base, contentW - 28, fam) * base * 1.4 * scale + (blk.author ? 16 : 0) + 14;
    case 'callout':
      return (
        wrapLines(blk.text, base, contentW - 32, fam) * base * 1.4 * scale +
        (blk.title ? 20 : 0) +
        20
      );
    case 'code': {
      const codeLines = blk.text.split('\n').length;
      return codeLines * (base - 1.5) * 1.35 + 18;
    }
    case 'divider':
      return 18;
    case 'pagebreak':
      return 0;
    case 'image':
      return 180; // fixed-ish preview height (exports scale to width)
  }
}

/** Paginate the document (PDF-mirroring rules). */
export function buildPreview(doc: DocumentDoc, templateOverride?: string): DocumentPreview {
  const tpl = resolveTemplate(templateOverride ?? doc.template, doc.docType);
  const pageW = A4_W;
  const pageH = A4_H;
  const margins = { top: tpl.page.top, bottom: tpl.page.bottom, side: tpl.page.side };
  const contentW = pageW - margins.side * 2;
  const contentH = pageH - margins.top - margins.bottom;

  const pages: PreviewPage[] = [];
  let current: PreviewPage = { index: 1, blocks: [], forcedBreak: false };
  let used = 0;
  const headingIds: Array<{ id: string; level: number; text: string; page: number }> = [];
  let headingSeq = 0;

  const push = (blk: DocBlock, height: number) => {
    if (used + height > contentH && (current.blocks.length > 0 || used > 0)) {
      pages.push(current);
      current = { index: pages.length + 1, blocks: [], forcedBreak: false };
      used = 0;
    }
    current.blocks.push({ block: blk, height });
    used += height;
    if (blk.t === 'heading') {
      headingSeq += 1;
      headingIds.push({
        id: `h-${headingSeq}`,
        level: blk.level,
        text: blk.text,
        page: current.index,
      });
    }
  };

  const blocks =
    doc.docType === 'spreadsheet' && doc.sheets?.length
      ? sheetBlocks(doc)
      : doc.docType === 'presentation' && doc.slides?.length
        ? slideSummaryBlocks(doc)
        : doc.blocks;

  for (const blk of blocks) {
    if (blk.t === 'pagebreak') {
      if (used > 0 || current.blocks.length) {
        pages.push(current);
        current = { index: pages.length + 1, blocks: [], forcedBreak: true };
        used = 0;
      }
      continue;
    }
    const height = blockHeight(blk, tpl, contentW);
    // Oversized single block (huge table) flows on one page regardless.
    push(blk, height);
  }
  if (current.blocks.length) pages.push(current);
  if (!pages.length) pages.push({ index: 1, blocks: [], forcedBreak: false });

  return {
    pages,
    template: tpl,
    pageWidth: pageW,
    pageHeight: pageH,
    margins,
    headingIds,
  };
}

/** Spreadsheet docs preview: one heading + table per sheet. */
function sheetBlocks(doc: DocumentDoc): DocBlock[] {
  const out: DocBlock[] = [];
  for (const sheet of doc.sheets ?? []) {
    out.push({ t: 'heading', level: 2, text: sheet.name });
    out.push({ t: 'table', header: sheet.header, rows: sheet.rows });
  }
  if (!out.length) out.push({ t: 'para', text: 'Feuille vide.' });
  return out;
}

/** Presentation docs preview: a compact outline (slides render separately
 *  as 16:9 cards in the workspace — this keeps the paper preview usable). */
function slideSummaryBlocks(doc: DocumentDoc): DocBlock[] {
  const out: DocBlock[] = [{ t: 'para', text: `Présentation — ${doc.slides?.length ?? 0} diapositives.` }];
  for (const slide of doc.slides ?? []) {
    out.push({ t: 'heading', level: 2, text: slide.title || 'Diapositive' });
    if (slide.bullets.length) out.push({ t: 'list', style: 'bullet', items: slide.bullets.map((text) => ({ text, level: 0 })) });
  }
  return out;
}
