import type { DocumentDoc } from '../core/document-schema';
import { documentToMarkdown } from '../core/markdown-to-doc';
import { resolveTemplate } from '../templates';
import { generatePptxBytes } from '../generators/pptx-generator';

/**
 * Export manager — SDR → real file bytes in ANY supported format.
 *
 * Every export renders from the SAME validated SDR with the SAME template:
 * the workspace preview and the downloaded file can never diverge. The
 * battle-tested converters of the chat pipeline (pdf-lib / docx / exceljs)
 * are reused through their markdown interfaces; PPTX/CSV/MD/TXT have
 * dedicated serializers.
 *
 * Formats: pdf · docx · xlsx · pptx · csv · md · txt · html
 */

export const EXPORT_FORMATS = ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'md', 'txt', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: string | null | undefined): value is ExportFormat {
  return !!value && (EXPORT_FORMATS as readonly string[]).includes(value);
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
};

export type ExportResult = {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  format: ExportFormat;
};

/** Build a clean download filename from the doc title + format. */
export function exportFilename(doc: DocumentDoc, format: ExportFormat): string {
  const slug = doc.title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'document'}.${format}`;
}

/** CSV serialization — first sheet (or all sheets concatenated with headers). */
function docToCsv(doc: DocumentDoc): string {
  if (doc.sheets?.length) {
    return doc.sheets
      .map((sheet) => {
        const rows = [sheet.header, ...sheet.rows];
        return rows
          .map((row) =>
            row
              .map((cell) => {
                const c = String(cell ?? '');
                return /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
              })
              .join(',')
          )
          .join('\n');
      })
      .join('\n');
  }
  // Prose document → title,headings,paragraphs rows.
  const rows: string[][] = [['Type', 'Contenu']];
  for (const blk of doc.blocks) {
    if (blk.t === 'heading') rows.push(['Titre', blk.text]);
    else if (blk.t === 'para') rows.push(['Paragraphe', blk.text]);
    else if (blk.t === 'list') for (const item of blk.items) rows.push(['Liste', item.text]);
    else if (blk.t === 'table') {
      for (const row of blk.rows) rows.push([blk.caption ?? 'Tableau', row.join(' | ')]);
    }
  }
  return rows
    .map((row) => row.map((c) => (/["\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
    .join('\n');
}

/** Plain-text serialization (no markdown syntax). */
function docToText(doc: DocumentDoc): string {
  const out: string[] = [doc.title.toUpperCase(), '' , '─'.repeat(Math.min(64, doc.title.length + 4)), ''];
  if (doc.docType === 'spreadsheet' && doc.sheets?.length) {
    for (const sheet of doc.sheets) {
      out.push(`── ${sheet.name}`, '');
      const rows = [sheet.header, ...sheet.rows];
      for (const row of rows) out.push('  ' + row.join('   |   '));
      out.push('');
    }
    return out.join('\n');
  }
  for (const blk of doc.blocks) {
    switch (blk.t) {
      case 'heading':
        out.push(`${'#'.repeat(blk.level)} ${blk.text}`, '');
        break;
      case 'para':
        out.push(blk.text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'), '');
        break;
      case 'list':
        for (const item of blk.items) out.push(`${'  '.repeat(item.level)}• ${item.text}`);
        out.push('');
        break;
      case 'table': {
        const rows = [blk.header, ...blk.rows];
        for (const row of rows) out.push('  ' + row.join('   |   '));
        if (blk.caption) out.push(`  ${blk.caption}`);
        out.push('');
        break;
      }
      case 'quote':
        out.push(`“${blk.text}”${blk.author ? ` — ${blk.author}` : ''}`, '');
        break;
      case 'callout':
        out.push(`[${blk.variant.toUpperCase()}] ${blk.title ?? ''}`.trim(), blk.text, '');
        break;
      case 'code':
        out.push(blk.text, '');
        break;
      case 'divider':
        out.push('──────────', '');
        break;
      case 'pagebreak':
        out.push('\n\n');
        break;
      case 'image':
        out.push(`[image : ${blk.alt ?? blk.url}]`, '');
        break;
    }
  }
  return out.join('\n');
}

/** Export the SDR to real file bytes in the requested format. */
export async function exportDocument(
  doc: DocumentDoc,
  format: ExportFormat,
  opts?: { filename?: string }
): Promise<ExportResult> {
  const tpl = resolveTemplate(doc.template, doc.docType);
  const filename = opts?.filename ?? exportFilename(doc, format);
  const md = documentToMarkdown(doc);

  switch (format) {
    case 'pptx': {
      const bytes = await generatePptxBytes(doc, tpl);
      return { bytes, contentType: CONTENT_TYPES.pptx, filename, format };
    }
    case 'csv': {
      return { bytes: new TextEncoder().encode(docToCsv(doc)), contentType: CONTENT_TYPES.csv, filename, format };
    }
    case 'md': {
      return { bytes: new TextEncoder().encode(md), contentType: CONTENT_TYPES.md, filename, format };
    }
    case 'txt': {
      return { bytes: new TextEncoder().encode(docToText(doc)), contentType: CONTENT_TYPES.txt, filename, format };
    }
    default: {
      // pdf / docx / xlsx / html — the chat-pipeline converters, themed.
      const { buildDocumentBytes } = await import('@/lib/document-generation');
      const result = await buildDocumentBytes({
        filename,
        content: md,
        // Layout engine follows the template: 'bold' templates → modern engine.
        design: tpl.layout === 'bold' ? 'moderne' : 'classique',
        template: tpl.id,
      });
      return {
        bytes: new Uint8Array(result.bytes),
        contentType: result.contentType,
        filename: result.filename,
        format,
      };
    }
  }
}
