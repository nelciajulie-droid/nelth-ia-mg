import type { ApiUser } from '@/lib/auth';

/**
 * ChatGPT-style document generation for Nelth-AI (TS-port extension).
 *
 * The model is told (via CAPABILITY_SYSTEM_PROMPT) that it CAN create real
 * downloadable documents. It emits them as fenced blocks:
 *
 *   ````document filename="CV.docx"
 *   # Jane Doe — Curriculum Vitae
 *   ...
 *   ````
 *
 * This module extracts those blocks from a completed assistant message,
 * converts the inner Markdown/HTML into the requested file format
 * (pdf / docx / xlsx / html / md / txt / csv / json), persists it through the
 * standard files pipeline and returns the attachment shape the ORIGINAL
 * frontend renders as a downloadable file card on the assistant message
 * (`message.files`, type 'file' — see ResponseMessage.svelte / FileItem.svelte).
 *
 * It also sanitizes "invented download links": LLMs sometimes answer a file
 * request with a fabricated URL (e.g. https://www.nelth-ai.com/export/excel/
 * ....xlsx) instead of emitting a document block. Such domains do not exist
 * (DNS NXDOMAIN for the user) — sanitizeInventedDownloadLinks() strips them.
 */

// ---------------------------------------------------------------------------
// Capability system prompt (injected into every chat completion)
// ---------------------------------------------------------------------------

export const CAPABILITY_SYSTEM_PROMPT = `You are running on Nelth-AI, a platform that CAN generate real downloadable files for the user — but ONLY when the user EXPLICITLY asks for one.

DOCUMENT CREATION CAPABILITY — ONLY ON EXPLICIT REQUEST:
Create a real downloadable file ONLY when the user's message explicitly asks for a file, a download, an export, an attachment, or names a concrete file format. Examples that qualify: "génère un fichier PDF", "fais-moi un Word téléchargeable", "exporte un Excel", "crée un fichier .html", "je veux le fichier", "make a downloadable PDF", "export as CSV".
When the user does NOT explicitly ask for a file/download/export/format — for example "crée une landing page", "écris le code HTML", "fais-moi un CV", "donne-moi le tableau", "refais la version en HTML complet", "ok merci" — answer NORMALLY in the conversation: regular fenced code blocks (\`\`\`html, \`\`\`css, \`\`\`js, Markdown tables…) fully visible in the chat bubble. Do NOT emit a document block, do NOT mention or promise a downloadable file, do NOT attach anything — the code/text stays inline and the user can copy it.

When the user DOES explicitly ask for a file, you MUST generate the actual file (never say you cannot create files, that the user must copy/paste, or that you cannot make a PDF/Word/Excel). Use a fenced code block with the language tag "document" and a filename attribute:

\`\`\`document filename="cv-jane-doe.pdf"
# Jane Doe
## Développeuse Full-Stack
- **Expérience:** 8 ans
...
\`\`\`

Rules for the document block:
- The language tag of the block MUST be exactly "document" (never "xlsx", "pdf", "excel", "word"…). Example: \u0060\u0060\u0060document filename="courses.xlsx"\n…table content…\n\u0060\u0060\u0060
- filename extension selects the format: .pdf, .docx, .xlsx, .html, .md, .txt, .csv, .json
- The block content must be well-structured Markdown for .pdf/.docx/.txt (headings with #/##, bullets with -, bold with **, plain paragraphs), raw HTML only for .html, CSV rows for .csv, valid JSON for .json
- For .xlsx (Excel): give ONE Markdown table per sheet, each preceded by a "## Sheet name" heading (e.g. "## Liste des dessins" then the table). Tables use | pipes | with a --- separator row under the header. Plain CSV content is also accepted for a single-sheet workbook
- The document must be COMPLETE and immediately usable — a full CV with all sections filled with plausible content, a full letter, a full report — never a template with placeholders like [Your Name] unless the user did not give any information to fill them
- One block per file; you may generate several blocks for several files
- Write the document in the user's language (French → French document)
- Add a one-sentence confirmation before or after the block (e.g. "Voici ton CV au format PDF, prêt à télécharger.")

DOWNLOAD LINKS — ABSOLUTE BAN:
You CANNOT publish, host or link files at any URL. You have no website, no domain, no file server.
- NEVER write a download link: no [Télécharger](...), no [Download](...), no bare https://… URL for a file
- NEVER invent or mention a domain like nelth-ai.com, or a path like /export/excel/… — those addresses do not exist and give the user a DNS error
- The platform AUTOMATICALLY turns your \u0060\u0060\u0060document block into a real downloadable file card attached to your message. Just emit the block and say the file is ready — the download button appears by itself

IMAGE GENERATION CAPABILITY:
If the user asks you to create/generate an image, picture, logo or illustration, say that they can use the image generation toggle in the message input (the image icon) to generate real images.

WEB SEARCH CAPABILITY:
If the user asks about current information, say that they can enable web search with the globe toggle in the message input.`;

// ---------------------------------------------------------------------------
// Block extraction
// ---------------------------------------------------------------------------

export type DocumentBlock = {
  filename: string;
  content: string;
};

const FENCE_RE = /^```([a-zA-Z0-9_-]+)?(?:[ \t]+([^\n]*))?[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

/** Tags that ALWAYS denote a document block (never legitimate code fences). */
const ALWAYS_DOC_TAGS = new Set(['document', 'pdf', 'docx', 'xlsx', 'xls', 'excel']);
/** Tags that denote a document block ONLY when they carry a filename
 *  attribute — they are also legitimate code-fence languages. */
const DOC_TAGS_WITH_FILENAME = new Set(['html', 'md', 'txt', 'csv', 'json']);

// ---------------------------------------------------------------------------
// Explicit file-request detection (user intent gate)
// ---------------------------------------------------------------------------

/** The user EXPLICITLY asked for a file/download/export this turn.
 *\n *  Policy: document blocks are turned into real downloadable files ONLY on
 *  explicit request. Without one of these signals the model's output stays
 *  fully INLINE in the conversation (normal code blocks the user can copy) —
 *  no file card, no attachment, no "📎 …" marker.
 *
 *  Matches FR + EN: fichier, télécharge…, export…, download…, pièce jointe,
 *  attachment, "au format", pdf/docx/xlsx/csv/excel (formats are
 *  unambiguous product names), "un/le Word", "Word doc", extensions
 *  .pdf/.doc(x)/.xls(x)/.csv/.json typed by the user.
 *  Deliberately NOT matched: bare "document"/"doc", ".html", ".md" — too
 *  generic ("rédige un document", "une page .html" are content requests). */
export const FILE_REQUEST_RE = new RegExp(
  [
    String.raw`\bfichiers?\b`,
    String.raw`\bt[ée]l[ée]charg\w*\b`,
    String.raw`\bexport\w*\b`,
    String.raw`\bdownload\w*\b`,
    String.raw`\bpi[èe]ces?[- ]jointes?\b`,
    String.raw`\battachments?\b`,
    String.raw`\bau format\b`,
    String.raw`\ben format\b`,
    String.raw`\bpdf\b`,
    String.raw`\bdocx\b`,
    String.raw`\bxlsx\b`,
    String.raw`\bexcel\b`,
    String.raw`\bcsv\b`,
    String.raw`\b(?:un|le|du|des|mes?|ton|notre|votre)\s+word\b`,
    String.raw`\bword\s+(?:doc|document)s?\b`,
    String.raw`\bdocuments?\s+(?:word|pdf|excel|xlsx)\b`,
    String.raw`\.(?:pdf|docx?|xlsx?|csv|json)\b`,
  ].join('|'),
  'i'
);

/** Fenced-code language used to keep a document block INLINE when the user
 *  did not ask for a file (extract=false): the "```document …" fence is
 *  re-tagged as a plain code fence so the chat renders a normal block. */
const INLINE_TAG_BY_EXT: Record<string, string> = {
  html: 'html',
  md: 'markdown',
  txt: 'text',
  csv: 'csv',
  json: 'json',
  // pdf/docx/xlsx sources are Markdown — render them as such.
  pdf: 'markdown',
  docx: 'markdown',
  xlsx: 'markdown',
  xls: 'markdown',
  excel: 'markdown',
  document: 'markdown',
};

/** Parse the filename attribute from an info string: filename="CV.pdf" */
function parseFilename(info: string): string {
  const m = info.match(/filename\s*=\s*["']([^"']+)["']/i);
  if (m) return m[1].trim();
  const bare = info.trim().replace(/^["']|["']$/g, '');
  if (bare && /\.[a-z0-9]{1,6}$/i.test(bare)) return bare;
  return '';
}

function filenameAttr(info: string): string | null {
  const m = info.match(/filename\s*=\s*["']([^"']+)["']/i);
  return m ? m[1].trim() : null;
}

/** Extract document blocks. Accepted shapes (models do not always follow the
 *  ```document instructions — some emit ```xlsx / ```pdf instead):
 *   ```document filename="CV.pdf"      → always a document
 *   ```xlsx filename="Courses.xlsx"    → always a document
 *   ```xlsx                            → document (fallback name document.xlsx)
 *   ```json filename="data.json"      → document (filename required: json is
 *                                        also a legit code-fence language)
 *   ```json / ```js / ```python …      → left untouched (regular code block)
 * Returns the blocks + the content with the blocks replaced by compact
 * markers (the chat bubble shows the marker; the real document rides the
 * message as a file card).
 *
 *  opts.extract (default true): set false when the user did NOT explicitly
 *  ask for a file — document-shaped fences are then kept INLINE, re-tagged
 *  as plain code fences (```html, ```markdown…), so nothing becomes a file
 *  card unless requested. See FILE_REQUEST_RE for the intent gate. */
export function extractDocumentBlocks(
  content: string,
  opts?: { extract?: boolean }
): {
  blocks: DocumentBlock[];
  stripped: string;
} {
  const extract = opts?.extract !== false;
  const blocks: DocumentBlock[] = [];
  const replacements: { start: number; end: number; text: string }[] = [];
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(content)) !== null) {
    const tag = (match[1] ?? '').toLowerCase();
    const info = match[2] ?? '';
    const body = (match[3] ?? '').trim();
    if (!body) continue;
    const attr = filenameAttr(info);
    let filename = '';
    if (tag === 'document') {
      filename = attr ?? parseFilename(info) ?? '';
      if (!filename) filename = 'document.txt';
    } else if (ALWAYS_DOC_TAGS.has(tag)) {
      filename = attr ?? `document.${tag === 'excel' ? 'xlsx' : tag}`;
    } else if (DOC_TAGS_WITH_FILENAME.has(tag) && attr) {
      filename = attr;
    }
    if (!filename) continue; // regular code fence — leave it alone
    if (extract) {
      blocks.push({ filename, content: body });
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        text: `📎 **${filename}** — fichier généré, prêt à télécharger ci-dessus.`,
      });
    } else {
      // No explicit user request: keep the block INLINE as a normal code
      // fence (drop the document tag + filename attribute) so the user can
      // read/copy the content right in the conversation.
      const ext = (filename.split('.').pop() || '').toLowerCase();
      const inlineTag = INLINE_TAG_BY_EXT[ext] ?? 'markdown';
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        text: '```' + inlineTag + '\n' + body + '\n```',
      });
    }
  }
  let stripped = content;
  if (replacements.length) {
    // Splice the markers in (back-to-front offsets are recorded ascending,
    // so walk forward once) and collapse >2 consecutive blank lines.
    let out = '';
    let cursor = 0;
    for (const r of replacements) {
      out += stripped.slice(cursor, r.start) + r.text;
      cursor = r.end;
    }
    out += stripped.slice(cursor);
    stripped = out.replace(/\n{3,}/g, '\n\n').trim();
  }
  // Safety net for the models that ignore the block format: strip fabricated
  // download URLs (nelth-ai.com / /export/… → DNS NXDOMAIN for the user).
  stripped = sanitizeInventedDownloadLinks(stripped);
  return { blocks, stripped };
}

// ---------------------------------------------------------------------------
// Invented download links (LLM hallucination guard)
// ---------------------------------------------------------------------------

/** Markdown/bare links that point at addresses this platform does not serve.
 *  The app exposes files ONLY through /api/v1/files/{id}/content (relative).
 *  Anything else claiming to be a platform download URL is hallucinated —
 *  most notably any *.nelth-ai.com host (unregistered domain → user gets
 *  DNS_PROBE_FINISHED_NXDOMAIN) and /export/<format>/ paths (no such route). */
const INVENTED_URL_RE =
  /\[([^\]]*)\]\((https?:\/\/[^)]*\bnelth-ai\.[a-z]+[^)]*)\)|\[([^\]]*)\]\((https?:\/\/[^)]*\/export\/(?:excel|word|pdf|docx|xlsx|csv|json|file)s?\/[^)]*)\)|(https?:\/\/[^\s)"']*\bnelth-ai\.[a-z]+[^\s)"']*)/gi;

/** Replace hallucinated download links with their visible label (or a short
 *  placeholder for bare URLs) so the user never clicks a dead NXDOMAIN link. */
export function sanitizeInventedDownloadLinks(content: string): string {
  if (!content) return content;
  if (!/nelth-ai\.[a-z]+|\/export\//i.test(content)) return content;
  return content.replace(INVENTED_URL_RE, (_full, label1, _u1, label2, _u2, bare) => {
    // Keep the visible label only (no added bold — the surrounding text often
    // already wraps the link in **…**, and nested bold renders as garbage).
    const label = (label1 || label2 || '').trim();
    if (label) return label;
    return bare ? '' : '';
  });
}

// ---------------------------------------------------------------------------
// Markdown → structured lines (shared by the pdf and docx converters)
// ---------------------------------------------------------------------------

type LineKind =
  | { kind: 'h1' | 'h2' | 'h3' | 'h4'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'para'; text: string };

/** Strip inline markdown emphasis but keep the visible characters. */
function stripInline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

/** Convert markdown-ish text (or simple HTML) into typed lines. */
export function markdownToLines(md: string): LineKind[] {
  // HTML input (model ignored the markdown rule) → best-effort conversion.
  if (/^\s*<(html|div|body|section|article|main)\b/i.test(md) || /<\/(p|h1|h2|h3|li|table)\s*>/i.test(md)) {
    return htmlToLines(md);
  }
  const out: LineKind[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      out.push({ kind: 'para', text: stripInline(para.join(' ')).trim() });
      para = [];
    }
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      const level = (h[1].length - 1) as 0 | 1 | 2 | 3;
      out.push({ kind: (['h1', 'h2', 'h3', 'h4'] as const)[level], text: stripInline(h[2]).trim() });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push({ kind: 'hr' });
      continue;
    }
    const b = line.match(/^\s*[-*+]\s+(.*)$/);
    if (b) {
      flush();
      out.push({ kind: 'bullet', text: stripInline(b[1]).trim() });
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      flush();
      out.push({ kind: 'quote', text: stripInline(q[1]).trim() });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out;
}

/** Very small HTML → lines converter (headings, paragraphs, list items,
 *  table rows, bold text). Enough for model-emitted simple documents. */
function htmlToLines(html: string): LineKind[] {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h1|h2|h3|h4|li|tr|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h1[^>]*>/gi, '# ')
    .replace(/<h2[^>]*>/gi, '## ')
    .replace(/<h3[^>]*>/gi, '### ')
    .replace(/<h4[^>]*>/gi, '#### ')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<td[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
  return markdownToLines(text);
}

// ---------------------------------------------------------------------------
// PDF converter (pdf-lib, standard fonts — Latin-1 safe)
// ---------------------------------------------------------------------------

async function markdownToPdfBytes(md: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const PAGE_W = 595.28; // A4
  const PAGE_H = 841.89;
  const MARGIN = 56;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  const styles = {
    h1: { font: bold, size: 20, before: 14, after: 6 },
    h2: { font: bold, size: 15, before: 12, after: 5 },
    h3: { font: bold, size: 12.5, before: 10, after: 4 },
    h4: { font: bold, size: 11, before: 8, after: 3 },
    para: { font, size: 10.5, before: 0, after: 7 },
    bullet: { font, size: 10.5, before: 0, after: 3 },
    quote: { font: italic, size: 10.5, before: 2, after: 6 },
  } as const;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  /** Latin-1 transliteration so standard fonts never break on accents. */
  const latin = (s: string): string =>
    s
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u00A0/g, ' ')
      .replace(/\u2022/g, '-')
      .replace(/[^\u0000-\u00FF]/g, (ch) => {
        // Common French/other letters already in Latin-1 pass through; the
        // rest becomes a visible fallback rather than a broken glyph.
        const map: Record<string, string> = {
          '\u0153': 'oe',
          '\u0152': 'OE',
          '\u2019': "'",
          '\u20AC': 'EUR',
          '\u2192': '->',
          '\u2713': 'v',
          '\u2714': 'v',
          '\u2611': '[x]',
          '\u25A0': '*',
          '\u25CF': '*',
        };
        return map[ch] ?? '?';
      });

  const writeLine = (
    text: string,
    style: { font: any; size: number; before: number; after: number },
    indent = 0,
    bullet = false
  ) => {
    const clean = latin(text);
    const words = clean.split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const lineHeight = style.size * 1.35;
    const availW = CONTENT_W - indent;
    const bulletPrefix = bullet ? '- ' : '';
    let line = bulletPrefix;
    const flushLine = () => {
      y -= lineHeight;
      if (y < MARGIN) {
        newPage();
        y = PAGE_H - MARGIN - lineHeight;
      }
      page.drawText(line, { x: MARGIN + indent, y, size: style.size, font: style.font, color: rgb(0.1, 0.1, 0.12) });
      line = '';
    };
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : `${bulletPrefix}${w}`;
      const width = style.font.widthOfTextAtSize(candidate, style.size);
      if (width > availW && line) {
        flushLine();
        line = w;
      } else {
        line = candidate;
      }
    }
    if (line) flushLine();
    y -= style.after;
  };

  for (const item of markdownToLines(md)) {
    switch (item.kind) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
        writeLine(item.text, styles[item.kind]);
        break;
      case 'bullet':
        writeLine(item.text, styles.bullet, 14, true);
        break;
      case 'quote':
        writeLine(`" ${item.text}`, styles.quote, 10);
        break;
      case 'hr':
        y -= 6;
        if (y < MARGIN) newPage();
        page.drawLine({
          start: { x: MARGIN, y },
          end: { x: PAGE_W - MARGIN, y },
          thickness: 0.7,
          color: rgb(0.75, 0.75, 0.78),
        });
        y -= 8;
        break;
      case 'para':
        writeLine(item.text, styles.para);
        break;
    }
  }

  return doc.save();
}

// ---------------------------------------------------------------------------
// XLSX converter (SheetJS — one sheet per Markdown table)
// ---------------------------------------------------------------------------

/** Split a table row "| a | b |" into trimmed cells (bold markers removed). */
function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim().replace(/\*\*([^*]*)\*\*/g, '$1').trim());
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparator = (line: string) => /^\s*\|?[\s:-]*-[-\s:|]*\|\s*$/.test(line) && line.includes('-');

function sheetNameFromHeading(heading: string | null, index: number): string {
  if (!heading) return `Feuille ${index + 1}`;
  const cleaned = heading
    .replace(/^#+\s*/, '')
    .replace(/["'*`]/g, '')
    .replace(/[\\/:\[\]?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || `Feuille ${index + 1}`;
}

async function markdownToXlsxBytes(md: string): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();

  const lines = md.split(/\r?\n/);
  type Sheet = { name: string | null; rows: string[][] };
  const sheets: Sheet[] = [];
  let current: Sheet | null = null;
  let lastHeading: string | null = null;
  let sawTable = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (isTableRow(line)) {
      if (isTableSeparator(line)) continue; // separator row consumed
      if (!current) {
        current = { name: lastHeading, rows: [] };
        sheets.push(current);
      }
      current.rows.push(splitTableRow(line));
      sawTable = true;
    } else {
      if (current && current.rows.length) current = null;
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) lastHeading = h[1];
    }
  }

  if (!sawTable) {
    // No Markdown tables — accept raw CSV or fall back to one cell per line.
    const text = md.trim();
    let ws;
    if (text.includes(',') && !/^\s*</.test(text)) {
      ws = XLSX.utils.csv_to_sheet(text);
    } else {
      ws = XLSX.utils.aoa_to_sheet(
        text
          .split(/\r?\n/)
          .map((l) => [l])
          .filter((r) => r[0].trim().length)
      );
    }
    XLSX.utils.book_append_sheet(wb, ws, 'Feuille 1');
  } else {
    const used = new Set<string>();
    sheets.forEach((sheet, i) => {
      if (!sheet.rows.length) return;
      let name = sheetNameFromHeading(sheet.name, i);
      if (used.has(name)) name = `${name.slice(0, 28)} (${i + 1})`;
      used.add(name);
      const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
      // Column widths from content length (Excel "wch" characters).
      const widths: number[] = [];
      for (const row of sheet.rows) {
        row.forEach((cell, c) => {
          widths[c] = Math.max(widths[c] ?? 8, Math.min(52, cell.length + 2));
        });
      }
      ws['!cols'] = widths.map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    });
  }

  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return new Uint8Array(out as unknown as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// DOCX converter (docx package)
// ---------------------------------------------------------------------------

async function markdownToDocxBytes(md: string): Promise<Uint8Array> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await import('docx');

  const runsFromInline = (text: string, base: Record<string, any>): any[] => {
    // Split on **bold** and *italic* segments to keep real emphasis.
    const runs: any[] = [];
    const re = /(\*\*[^*]+\*\*|(?<!\*)\*[^*]+\*(?!\*)|`[^`]+`)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) runs.push(new TextRun({ ...base, text: text.slice(last, m.index) }));
      const token = m[0];
      if (token.startsWith('**')) {
        runs.push(new TextRun({ ...base, text: token.slice(2, -2), bold: true }));
      } else if (token.startsWith('`')) {
        runs.push(new TextRun({ ...base, text: token.slice(1, -1), font: 'Courier New' }));
      } else {
        runs.push(new TextRun({ ...base, text: token.slice(1, -1), italics: true }));
      }
      last = m.index + token.length;
    }
    if (last < text.length) runs.push(new TextRun({ ...base, text: text.slice(last) }));
    return runs.length ? runs : [new TextRun({ ...base, text: '' })];
  };

  const children: any[] = [];
  const lines = markdownToLines(md);
  // Group consecutive bullets into real DOCX bullet lists.
  let bulletBuffer: string[] = [];
  const flushBullets = () => {
    for (const b of bulletBuffer) {
      children.push(
        new Paragraph({
          children: runsFromInline(b, { size: 22 }),
          bullet: { level: 0 },
          spacing: { after: 60 },
        })
      );
    }
    bulletBuffer = [];
  };
  for (const item of lines) {
    switch (item.kind) {
      case 'h1':
        flushBullets();
        children.push(new Paragraph({ children: runsFromInline(item.text, { size: 44, bold: true, color: '1F2937' }), heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } }));
        break;
      case 'h2':
        flushBullets();
        children.push(new Paragraph({ children: runsFromInline(item.text, { size: 32, bold: true, color: '1F2937' }), heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }));
        break;
      case 'h3':
        flushBullets();
        children.push(new Paragraph({ children: runsFromInline(item.text, { size: 26, bold: true, color: '374151' }), heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 80 } }));
        break;
      case 'h4':
        flushBullets();
        children.push(new Paragraph({ children: runsFromInline(item.text, { size: 23, bold: true }), spacing: { before: 120, after: 60 } }));
        break;
      case 'bullet':
        bulletBuffer.push(item.text);
        break;
      case 'quote':
        flushBullets();
        children.push(new Paragraph({ children: runsFromInline(item.text, { size: 22, italics: true, color: '4B5563' }), indent: { left: 360 }, spacing: { before: 60, after: 120 }, border: { left: { style: 'single', size: 6, color: '9CA3AF', space: 8 } } }));
        break;
      case 'hr':
        flushBullets();
        children.push(new Paragraph({ text: '', border: { bottom: { style: 'single', size: 6, color: '9CA3AF', space: 1 } }, spacing: { before: 120, after: 120 } }));
        break;
      case 'para':
        flushBullets();
        children.push(new Paragraph({ children: runsFromInline(item.text, { size: 22 }), alignment: AlignmentType.LEFT, spacing: { after: 140 } }));
        break;
    }
  }
  flushBullets();

  const document = new Document({
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } },
      },
    },
    sections: [{ children }],
  });
  const buffer = await Packer.toBuffer(document);
  return new Uint8Array(buffer as unknown as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// File assembly + persistence
// ---------------------------------------------------------------------------

export type GeneratedDocumentFile = {
  type: 'file';
  id: string;
  url: string;
  name: string;
  size: number;
  content_type: string;
};

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
};

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned || 'document.txt';
}

/** Build the file bytes for one document block. */
async function buildDocumentBytes(block: DocumentBlock): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
  const filename = sanitizeFilename(block.filename);
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'pdf':
      return { bytes: Buffer.from(await markdownToPdfBytes(block.content)), contentType: CONTENT_TYPES.pdf, filename };
    case 'docx':
      return { bytes: Buffer.from(await markdownToDocxBytes(block.content)), contentType: CONTENT_TYPES.docx, filename };
    case 'xlsx':
    case 'xls':
      return { bytes: Buffer.from(await markdownToXlsxBytes(block.content)), contentType: CONTENT_TYPES.xlsx, filename: filename.replace(/\.xls$/i, '.xlsx') };
    case 'html': {
      let body = block.content;
      if (!/<html[\s>]/i.test(body)) {
        body = `<!DOCTYPE html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<style>body{font-family:Georgia,serif;max-width:780px;margin:40px auto;padding:0 24px;line-height:1.55;color:#1f2937}h1,h2,h3{color:#111827}h1{border-bottom:2px solid #e5e7eb;padding-bottom:8px}</style>\n</head>\n<body>\n${body}\n</body>\n</html>`;
      }
      return { bytes: Buffer.from(body, 'utf-8'), contentType: CONTENT_TYPES.html, filename };
    }
    case 'md':
      return { bytes: Buffer.from(block.content, 'utf-8'), contentType: CONTENT_TYPES.md, filename };
    case 'csv':
      return { bytes: Buffer.from(block.content, 'utf-8'), contentType: CONTENT_TYPES.csv, filename };
    case 'json': {
      let pretty = block.content;
      try {
        pretty = JSON.stringify(JSON.parse(block.content), null, 2);
      } catch {
        /* keep raw */
      }
      return { bytes: Buffer.from(pretty, 'utf-8'), contentType: CONTENT_TYPES.json, filename };
    }
    case 'txt':
    default:
      return { bytes: Buffer.from(block.content, 'utf-8'), contentType: CONTENT_TYPES.txt, filename: filename.includes('.') ? filename : `${filename}.txt` };
  }
}

/** Persist a document block through the files pipeline → file card payload. */
export async function generateDocumentFile(
  user: ApiUser,
  block: DocumentBlock,
  metadata: Record<string, any> = {}
): Promise<GeneratedDocumentFile> {
  const { bytes, contentType, filename } = await buildDocumentBytes(block);
  const { uploadFileHandler, updateFileData } = await import('@/server/routers/files');
  const fileItem = await uploadFileHandler(
    user,
    { bytes, filename, contentType },
    { source: 'document_generation', ...metadata },
    false
  );
  const id = fileItem?.id;
  if (!id) {
    throw new Error(`Failed to save the generated document ${filename}`);
  }
  // Store the document source as the file's extracted text (data.content) —
  // same field RAG processing fills for uploads — so the ORIGINAL frontend
  // file modal's "Content" tab shows text instead of "No content".
  await updateFileData(id, { content: block.content });
  const meta = (fileItem?.meta ?? {}) as Record<string, any>;
  return {
    type: 'file',
    id,
    url: `/api/v1/files/${id}/content`,
    name: meta.name ?? filename,
    size: bytes.length,
    content_type: meta.content_type ?? contentType,
  };
}

/** Generate every document block found in an assistant message. */
export async function generateDocumentFiles(
  user: ApiUser,
  blocks: DocumentBlock[],
  metadata: Record<string, any> = {}
): Promise<GeneratedDocumentFile[]> {
  const files: GeneratedDocumentFile[] = [];
  for (const block of blocks) {
    try {
      files.push(await generateDocumentFile(user, block, metadata));
    } catch (e) {
      console.error('[document-generation] failed to generate', block.filename, e);
    }
  }
  return files;
}
