/**
 * Document loaders — port of open_webui/retrieval/loaders/ (simplified for the
 * serverless TS runtime).
 *
 * Supported formats (parity subset):
 *   - text/code/markdown/rst/xml  → plain decode (with latin-1 fallback)
 *   - html / xhtml                → cheerio text extraction (+ title metadata)
 *   - pdf                          → pdf-parse v2 (`PDFParse`)
 *   - csv                          → CSVLoaderWithSummary port ("key: value" rows)
 *   - json                         → pretty-printed JSON text
 *
 * Documented deviations from the Python loader stack:
 *   - docx/doc/ppt/xls/epub/rst-unstructured/others fall back to the plain
 *     text loader (Python's final `else` branch also falls back to TextLoader,
 *     but its dedicated Docx/Pptx/Excel loaders are not available here).
 *   - no external extraction engines (Tika/Docling/Marker/Mineru/Mistral OCR/
 *     Document Intelligence) — `rag.content_extraction_engine` is surfaced in
 *     config parity but ignored.
 *   - ftfy fix_text post-processing is approximated by stripping replacement
 *     characters.
 */

import { load as loadCheerio } from 'cheerio';

export type LoaderDocument = {
  page_content: string;
  metadata: Record<string, any>;
};

/** Extensions treated as plain text (port of loaders/main.py known_source_ext). */
export const KNOWN_SOURCE_EXT: ReadonlySet<string> = new Set([
  'go', 'py', 'java', 'sh', 'bat', 'ps1', 'cmd', 'js', 'ts', 'css', 'cpp', 'hpp', 'h',
  'c', 'cs', 'ino', 'sql', 'log', 'ini', 'pl', 'pm', 'r', 'dart', 'dockerfile', 'env',
  'php', 'hs', 'hsc', 'lua', 'nginxconf', 'conf', 'm', 'mm', 'plsql', 'perl', 'rb',
  'rs', 'db2', 'scala', 'bash', 'swift', 'vue', 'svelte', 'ex', 'exs', 'erl', 'tsx',
  'jsx', 'hs', 'lhs', 'json', 'yaml', 'yml', 'toml', 'svg',
]);

const TEXT_FILE_EXTS = new Set(['txt', 'md', 'markdown', 'rst', 'xml']);

/** Port of Loader._is_text_file: extension whitelist or text/* (non-html) mime. */
export function isTextFile(fileExt: string, fileContentType?: string | null): boolean {
  if (KNOWN_SOURCE_EXT.has(fileExt)) return true;
  if (fileContentType && fileContentType.includes('text/') && !fileContentType.includes('html')) {
    return true;
  }
  return false;
}

/** Decode bytes as UTF-8 with a latin-1 fallback (port of _detect_text_encoding). */
export function decodeTextBytes(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text;
  } catch {
    // latin-1 accepts every byte 0x00-0xFF (python fallback parity)
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return new TextDecoder('latin1').decode(bytes);
    }
  }
}

/** Approximation of ftfy.fix_text (strip replacement chars / control junk). */
function fixText(text: string): string {
  if (!text) return text;
  if (!text.includes('\uFFFD')) return text;
  return text.replace(/\uFFFD/g, '');
}

/** Extract text + title from an HTML document (port of HTMLLoader w/ BeautifulSoup). */
export function extractHtmlText(html: string): { text: string; title: string } {
  const $ = loadCheerio(html);
  const title = $('title').first().text() ?? '';
  // Drop non-content subtrees BEFORE .text() — noscript templates (Google Tag
  // Manager & co.) otherwise leak their raw markup into the page text.
  $('script, style, noscript, template, svg, iframe').remove();
  let text = $('body').text() ?? '';
  if (typeof text !== 'string') text = String(text);
  // Defense in depth: strip any residual tags / HTML comments.
  text = text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<\/?[a-z][^>]*>/gi, ' ');
  return { text: fixText(text), title };
}

/** Extract plain text from PDF bytes via pdf-parse v2. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const mod = (await import('pdf-parse')) as any;
  const PDFParse = (mod.PDFParse ?? mod.default) as typeof import('pdf-parse').PDFParse;
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    return fixText(result.text ?? '');
  } finally {
    try {
      await parser.destroy();
    } catch {
      /* ignore teardown errors */
    }
  }
}

/** Minimal RFC4180 CSV parser (handles quoted fields with commas/newlines/quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, ''); // strip BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // ignore unless followed by \n (handled below)
      if (src[i + 1] === '\n') continue;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Port of CSVLoaderWithSummary: one Document per row, "key: value" lines. */
function loadCsv(filename: string, bytes: Uint8Array, source: string): LoaderDocument[] {
  const text = decodeTextBytes(bytes);
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = (rows[0] ?? []).map((h) => h);
  const docs: LoaderDocument[] = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    if (!row || row.every((c) => c === '')) continue;
    const fields: string[] = [];
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c] ?? String(c);
      const value = row[c] ?? '';
      fields.push(`${key}: ${typeof value === 'string' ? value.trim() : value}`);
    }
    docs.push({
      page_content: fields.join('\n'),
      metadata: { source, row: index - 1 },
    });
  }
  if (process.env.ENABLE_RAG_CSV_SUMMARY?.toLowerCase() === 'true') {
    const dataRows = Math.max(rows.length - 1, 0);
    const maxColumns = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const summary = `Table: ${rows.length} rows incl. header; ${dataRows} data rows; ${maxColumns} columns: ${headers.join(', ')}.`;
    docs.unshift({ page_content: summary, metadata: { source, row: -1 } });
  }
  return docs;
}

/** Pretty-print JSON bytes (JSONLoader parity: single document). */
function loadJson(bytes: Uint8Array, source: string): LoaderDocument[] {
  const text = decodeTextBytes(bytes);
  try {
    const parsed = JSON.parse(text);
    return [
      {
        page_content: fixText(JSON.stringify(parsed, null, 2)),
        metadata: { source },
      },
    ];
  } catch {
    return [{ page_content: fixText(text), metadata: { source } }];
  }
}

/**
 * Load a document from raw bytes — port of Loader.load(filename, content_type, path).
 * `source` mirrors the python `metadata.source` (the stored file path).
 */
export async function loadDocuments(
  filename: string,
  fileContentType: string | null | undefined,
  bytes: Uint8Array,
  source?: string
): Promise<LoaderDocument[]> {
  const fileExt = (filename.split('.').pop() ?? '').toLowerCase();
  const metaSource = source ?? filename;
  const contentType = fileContentType ?? '';

  if (fileExt === 'pdf' || contentType === 'application/pdf') {
    const text = await extractPdfText(bytes);
    return [{ page_content: text, metadata: { source: metaSource } }];
  }

  if (fileExt === 'csv' || contentType === 'text/csv') {
    return loadCsv(filename, bytes, metaSource);
  }

  if (
    fileExt === 'htm' ||
    fileExt === 'html' ||
    contentType.includes('text/html') ||
    contentType === 'application/xhtml+xml'
  ) {
    const html = decodeTextBytes(bytes);
    const { text, title } = extractHtmlText(html);
    return [{ page_content: text, metadata: { source: metaSource, title } }];
  }

  if (fileExt === 'json' || contentType === 'application/json') {
    return loadJson(bytes, metaSource);
  }

  // Everything else (txt / md / rst / xml / code / unknown) → plain text loader,
  // matching the python fallback chain.
  const text = fixText(decodeTextBytes(bytes));
  return [{ page_content: text, metadata: { source: metaSource } }];
}

/** True when the byte stream looks like text (null-byte heuristic, files.py parity). */
export function bytesLookLikeText(bytes: Uint8Array, chunkSize = 8192): boolean {
  const chunk = bytes.subarray(0, chunkSize);
  if (chunk.length === 0) return false;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === 0) return false;
  }
  return true;
}
