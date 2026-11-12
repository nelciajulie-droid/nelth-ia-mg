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
 * request with a fabricated URL (e.g. https://www.nelth-ia.com/export/excel/
 * ....xlsx) instead of emitting a document block. Such domains do not exist
 * (DNS NXDOMAIN for the user) — sanitizeInventedDownloadLinks() strips them.
 *
 * ---------------------------------------------------------------------------
 * PROFESSIONAL DESIGN SYSTEM (v2 — "why do the docs look beginner-ish?")
 * ---------------------------------------------------------------------------
 * The first version rendered Markdown as flat plain text (Helvetica lines,
 * no tables, no pagination, gray Word defaults). Every converter now emits
 * senior-grade documents:
 *
 *   • PDF  — typography hierarchy, deep-teal accent bars under titles,
 *            hairline section rules, inline **bold** runs, real bordered
 *            tables (tinted header + zebra rows + header repeated across
 *            page breaks), hanging bullets/numbered lists, accent quote
 *            bars, footers with "Page i / N" + date + document title,
 *            slim brand rule at the top of every page.
 *   • DOCX — Word heading styles (Calibri), Title treatment with accent
 *            underline, real Word tables (tinted header row, zebra stripes,
 *            percentage column widths), numbered lists (native numbering),
 *            accented quote blocks, centered "Page i / N" footer.
 *   • XLSX — ExcelJS styled workbook: white-on-teal bold header row, zebra
 *            stripes, hairline cell borders, frozen header row, autofilter,
 *            content-aware column widths, numeric cells auto-typed with
 *            thousands separators (SheetJS fallback if ExcelJS is missing).
 *   • HTML — print-ready A4 stylesheet (page card, accent headings, styled
 *            tables, blockquotes, @media print rules).
 *
 * The Markdown parser was upgraded accordingly: pipe tables, numbered lists
 * and nested list levels are all first-class citizens now.
 *
 * ---------------------------------------------------------------------------
 * ULTRA-MODERN DESIGN (v3 — "j'aime qu'il sache générer document ultra moderne")
 * ---------------------------------------------------------------------------
 * v2 shipped ONE professional look (deep-teal editorial). v3 adds a second
 * design engine — "moderne" — a bold contemporary visual language applied
 * to every converter when the user asks for a modern/stylish/designer look:
 *
 *   • Selection is belt-and-suspenders (same philosophy as the GIF/SEARCH
 *     filets): the MODEL picks the style via a fence attribute
 *     (```document filename="cv.pdf" design="moderne") AND a deterministic
 *     keyword filet (MODERN_DESIGN_RE on the RAW user text, gated by an
 *     explicit file request) forces moderne even if a weak free model
 *     forgets the attribute. The classifier never has veto power over an
 *     explicit user command.
 *   • PDF     — full-bleed violet→fuchsia gradient banner on every page,
 *              magazine-style date pill above the title, gradient title
 *              underline, violet section chips, white-on-violet table
 *              headers with fuchsia rule, violet bullet markers.
 *   • DOCX    — violet-700 headings, tinted h2 bands, fuchsia title rule,
 *              white-on-violet table headers, light-violet zebra.
 *   • XLSX    — solid violet header (white bold), fuchsia bottom rule,
 *              alternating violet/fuchsia sheet tabs, light-violet zebra.
 *   • HTML    — gradient hero (kicker pill + big title + edition line),
 *              Inter font, section chips, rounded gradient-bordered tables,
 *              tinted blockquotes, gradient hairlines; markdown bodies are
 *              converted to real HTML (mdToBasicHtml) instead of raw text.
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
- filename extension selects the format: .pdf, .docx, .xlsx, .pptx, .html, .md, .txt, .csv, .json
- The block content must be well-structured Markdown for .pdf/.docx/.txt (headings with #/##, bullets with -, bold with **, plain paragraphs), raw HTML only for .html, CSV rows for .csv, valid JSON for .json
- For .xlsx (Excel): give ONE Markdown table per sheet, each preceded by a "## Sheet name" heading (e.g. "## Liste des dessins" then the table). Tables use | pipes | with a --- separator row under the header. Plain CSV content is also accepted for a single-sheet workbook. Cells starting with = become real Excel formulas
- For .pptx (PowerPoint): structure the deck as \u0060# Deck title\u0060 then ONE \u0060## Slide title\u0060 heading PER SLIDE, each followed by 3-6 SHORT bullet lines (- one idea per line, max ~12 words). NEVER put the whole deck on one slide — one section = one slide. You may add \u0060> notes:\u0060 speaker notes under a slide
- One block per file; you may generate several blocks for several files
- Write the document in the user's language (French → French document)
- Add a one-sentence confirmation before or after the block (e.g. "Voici ton CV au format PDF, prêt à télécharger.")

QUALITY STANDARD — EXPERT-LEVEL DOCUMENTS (the file is the deliverable, make it worth downloading):
- Write at SENIOR PROFESSIONAL level, never beginner-level: dense, concrete, specific content — real numbers, dates, amounts, durations, measurable results — never vague filler ("divers", "plusieurs", "etc." as sole content) and never one-word bullets.
- Structure every document like a professional deliverable: one clear title (#), a short intro, then ## sections; end reports with a conclusion. Use ### for sub-sections when useful.
- Use Markdown tables (| Colonne | Colonne | with a --- separator row) for ANY comparative, enumerable or numeric data — the platform renders them as styled professional tables with colored headers in PDF/DOCX and as formatted Excel sheets.
- Use **bold** for key facts, figures and job titles inside paragraphs — the platform renders real typographic emphasis.
- Content must be COMPLETE and substantial: a CV = profile summary + every role with quantified achievements + education + skills + languages; a report = executive summary + developed sections + KPI table + conclusion; a letter = full body with proper salutation and formule de politesse; a budget/plan = full table + notes. Aim for a document that would fill 1–3 pages, not a thin skeleton.
- Never leave placeholders like [Your Name] or "à compléter" unless the user gave strictly zero information.
- In French, follow French typographic conventions (guillemets « », espaces avant ! ? : ;).

DESIGN STYLES — the platform has a full TEMPLATE system for your documents:
- The platform auto-picks a professional template per document type (corporate for reports, professional-cv for CVs, financial for invoices, academic for research…).
- If the user asks for a modern / ultra-modern / stylish / designer / creative look ("ultra moderne", "moderne", "stylé", "design", "élégant", "soigné", "créatif", "modern", "stylish"), add the attribute design="moderne" to the document fence: \u0060\u0060\u0060document filename="cv.pdf" design="moderne"\n…content…\n\u0060\u0060\u0060 — the platform then renders an ULTRA-MODERN design (gradient hero banner, vivid accents, magazine-style layout).
- You may also pin an explicit template with template="…" (corporate, minimalist, modern, academic, executive, creative, financial, professional-cv, business-proposal, invoice) when the user names a style exactly ("style académique" → template="academic", "design épuré/minimaliste" → template="minimalist").
- The QUALITY STANDARD above applies IDENTICALLY to every template — never write less or thinner content because of the style choice.

DOWNLOAD LINKS — ABSOLUTE BAN:
You CANNOT publish, host or link files at any URL. You have no website, no domain, no file server.
- NEVER write a download link: no [Télécharger](...), no [Download](...), no bare https://… URL for a file
- NEVER invent or mention a domain like nelth-ai.com, or a path like /export/excel/… — those addresses do not exist and give the user a DNS error
- The platform AUTOMATICALLY turns your \u0060\u0060\u0060document block into a real downloadable file card attached to your message. Just emit the block and say the file is ready — the download button appears by itself

IMAGE / VIDEO / GIF GENERATION — AUTOMATIC, NEVER REFUSE:
This platform generates real images, GIFs and videos AUTOMATICALLY: a request like "dessine-moi un chat", "génère un logo", "fais un GIF de…", "crée une vidéo" launches the generation by itself and attaches the result to your reply. You never need to explain any button.
- NEVER say or imply that you or the platform cannot generate images, GIFs or videos. NEVER suggest an external tool, a copy/paste, a URL to open, or a designer instead.
- NEVER invent or describe interface elements (upload icons, image toggles, globe buttons, menus) — you cannot see the interface, and invented instructions send the user hunting for buttons that don't exist.
- If the user asks for an image/GIF/video and no media was attached to your previous reply, apologize briefly and invite them to phrase it as a direct request (e.g. "dessine-moi un chat qui court") — the platform then generates it. A short invitation is fine; a refusal is NOT.

WEB SEARCH — AUTOMATIC:
The platform also searches the web automatically when a question needs fresh facts. If the user points out stale or incorrect information, invite them to simply ask the question again so the automatic search re-runs — never claim the platform cannot browse the web.`;

// ---------------------------------------------------------------------------
// Block extraction
// ---------------------------------------------------------------------------

export type DocumentBlock = {
  filename: string;
  content: string;
  /** Visual design engine. Defaults to 'classique' (professional deep-teal).
   *  'moderne' = ultra-modern violet/fuchsia design system. */
  design?: DocumentDesign;
  /** Document template id (documents engine) — when set, its palette +
   *  typography drive every converter (design keeps driving the LAYOUT
   *  engine). Overrides the design look-and-feel colors. */
  template?: string;
};

export type DocumentDesign = 'classique' | 'moderne';

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
 *
 *  Policy: document blocks are turned into real downloadable files ONLY on
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
    String.raw`\bpptx\b`,
    String.raw`\bpowerpoints?\b`,
    String.raw`\bexcels?\b`,
    String.raw`\bpr[ée]sentations?\b`,
    String.raw`\bexcel\b`,
    String.raw`\bcsv\b`,
    String.raw`\b(?:un|le|du|des|mes?|ton|notre|votre)\s+word\b`,
    String.raw`\bword\s+(?:doc|document)s?\b`,
    String.raw`\bdocuments?\s+(?:word|pdf|excel|xlsx|pptx)\b`,
    String.raw`\.(?:pdf|docx?|xlsx?|pptx?|csv|json)\b`,
  ].join('|'),
  'i'
);

/** Ultra-modern design request, in the user's OWN words (FR + EN).
 *
 *  Belt-and-suspenders filet — mirrors the GIF/SEARCH command philosophy:
 *  when the user asks for a FILE *and* uses design language, the design is
 *  forced to "moderne" even if the model forgets the design="moderne"
 *  attribute. Always gated by an explicit file request in v12-flow, so
 *  "l'art moderne" in a casual chat never flips anything. Edges use
 *  Unicode-letter lookarounds (NOT \b — \b doesn't fire around accented
 *  characters, so "stylé"/"élégant"/"soigné" would slip through). */
export const MODERN_DESIGN_RE = new RegExp(
  [
    String.raw`(?<![\p{L}])ultra\s*-?\s*moder(?:ne|n)s?(?![\p{L}])`,
    String.raw`(?<![\p{L}])tr[èe]s\s+moder(?:ne|n)s?(?![\p{L}])`,
    String.raw`(?<![\p{L}])moder(?:ne|n)s?(?![\p{L}])`,
    String.raw`(?<![\p{L}])styl[ée]e?s?(?![\p{L}])`,
    String.raw`(?<![\p{L}])designs?(?![\p{L}])`,
    String.raw`(?<![\p{L}])[ée]l[ée]gants?(?![\p{L}])`,
    String.raw`(?<![\p{L}])elegants?(?![\p{L}])`,
    String.raw`(?<![\p{L}])raffin[ée]s?(?![\p{L}])`,
    String.raw`(?<![\p{L}])soign[ée]s?(?![\p{L}])`,
    String.raw`(?<![\p{L}])graphiques?(?![\p{L}])`,
    String.raw`(?<![\p{L}])cr[ée]atifs?(?![\p{L}])`,
    String.raw`(?<![\p{L}])creatives?(?![\p{L}])`,
    String.raw`(?<![\p{L}])next\s*[- ]?level(?![\p{L}])`,
    String.raw`(?<![\p{L}])pro\s+design(?![\p{L}])`,
  ].join('|'),
  'iu'
);

/** Normalize a design="…" fence attribute value to a DocumentDesign. */
function parseDesignAttr(value: string | null): DocumentDesign | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  return /moder|ultra|design|styl|cr[ée]at|creatif|futur|tendance/i.test(v) ? 'moderne' : undefined;
}

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
 *  card unless requested. See FILE_REQUEST_RE for the intent gate.
 *  opts.modern (default false): force the ultra-modern design engine on every
 *  extracted block — the deterministic filet for "ultra moderne" requests.
 *  A design="moderne" attribute on the fence always wins regardless. */
export function extractDocumentBlocks(
  content: string,
  opts?: { extract?: boolean; modern?: boolean }
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
    // Design selection: fence attribute first, deterministic filet second.
    const attrDesign = parseDesignAttr(info.match(/design\s*=\s*["']([^"']+)["']/i)?.[1] ?? null);
    const design: DocumentDesign =
      attrDesign === 'moderne' || opts?.modern === true ? 'moderne' : 'classique';
    // Template selection: an explicit template="…" fence attribute (documents
    // engine — corporate / academic / modern / …). When absent the documents
    // engine infers a type-appropriate template per block.
    const attrTemplate = info.match(/template\s*=\s*["']([a-z0-9-]+)["']/i)?.[1] ?? null;
    if (extract) {
      blocks.push({ filename, content: body, design, ...(attrTemplate ? { template: attrTemplate } : {}) });
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
  | { kind: 'bullet'; text: string; level: number }
  | { kind: 'numitem'; text: string; level: number }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'para'; text: string };

/** Strip inline markdown emphasis but keep the visible characters. */
function stripInline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

/** Indented list level: 0 for flush, 1 for 2-5 leading spaces, 2 beyond. */
function listLevel(indent: string): number {
  const n = Math.floor((indent.replace(/\t/g, '  ').length || 0) / 2);
  return Math.max(0, Math.min(2, n));
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparator = (line: string) => /^\s*\|?[\s:-]*-[-\s:|]*\|\s*$/.test(line) && line.includes('-');

/** Split a table row "| a | b |" into trimmed cells (bold markers removed). */
function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim().replace(/\*\*([^*]*)\*\*/g, '$1').trim());
}

/** Convert markdown-ish text (or simple HTML) into typed lines.
 *  v2: pipe TABLES, numbered lists and nested list levels are parsed. */
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
  const rawLines = md.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
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
    // ---- Pipe table run: consecutive | rows |; a --- separator right under
    // the first row marks it as the header row.
    if (isTableRow(line)) {
      const cells = isTableSeparator(line) ? null : splitTableRow(line);
      if (cells === null) continue; // separator row consumed
      const next = (rawLines[i + 1] ?? '').trim();
      const hasHeader = isTableSeparator(next) && cells.length > 0;
      const header = hasHeader ? cells : [];
      const rows: string[][] = [];
      let j = i;
      // The header row itself (when present) is consumed here; then the
      // separator line is skipped and data rows accumulate.
      if (hasHeader) j = i + 2; // skip header + separator
      for (; j < rawLines.length; j++) {
        const rl = rawLines[j].replace(/\s+$/, '');
        if (!isTableRow(rl)) break;
        if (isTableSeparator(rl)) continue;
        rows.push(splitTableRow(rl));
      }
      flush();
      out.push({ kind: 'table', header, rows });
      i = j - 1;
      continue;
    }
    const n = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (n && listLevel(n[1]) <= 1) {
      flush();
      out.push({ kind: 'numitem', text: stripInline(n[3]).trim(), level: listLevel(n[1]) });
      continue;
    }
    const b = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (b) {
      flush();
      out.push({ kind: 'bullet', text: stripInline(b[2]).trim(), level: listLevel(b[1]) });
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
    .replace(/<\/(p|div|section|article|h1|h2|h3|h4|li|tr|blockquote|table|tbody|thead)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h1[^>]*>/gi, '# ')
    .replace(/<h2[^>]*>/gi, '## ')
    .replace(/<h3[^>]*>/gi, '### ')
    .replace(/<h4[^>]*>/gi, '#### ')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
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
// Markdown → basic semantic HTML (.html documents whose body the model
// wrote as Markdown — never show raw "# …" text in a downloaded web page)
// ---------------------------------------------------------------------------

const escHtml = (s: string) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Inline Markdown → safe HTML (bold / italic / code / links). */
function mdInlineToHtml(s: string): string {
  let out = escHtml(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/(^|[^*\w])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  return out;
}

function mdTableToHtml(header: string[], rows: string[][]): string {
  const nCols = Math.max(1, header.length, ...rows.map((r) => r.length));
  const norm = (cells: string[]) => {
    const out = cells.slice(0, nCols).map((c) => String(c ?? ''));
    while (out.length < nCols) out.push('');
    return out;
  };
  const thead = header.length
    ? `<thead><tr>${norm(header).map((h) => `<th>${mdInlineToHtml(h)}</th>`).join('')}</tr></thead>`
    : '';
  const tbody = rows
    .map((r) => `<tr>${norm(r).map((c) => `<td>${mdInlineToHtml(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table>${thead}<tbody>${tbody}</tbody></table>`;
}

/** Split a table row "| a | b |" into trimmed RAW cells (inline markers
 *  preserved — the HTML renderer converts **bold** itself). */
const splitRawTableRow = (line: string): string[] =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());

/** Markdown → semantic HTML with a RAW line parser (inline markers kept —
 *  markdownToLines strips bold / italic / link markers, which is right for the
 *  PDF/DOCX renderers but would flatten the HTML conversion).
 *  With stripFirstH1 the first "# Heading" becomes the returned title (the
 *  modern hero renders it) and leaves the body; the classique template
 *  keeps the h1 in the body (title for <title> only). */
function mdToBasicHtml(md: string, stripFirstH1 = false): { title: string; html: string } {
  const rawLines = md.split(/\r?\n/);
  const out: string[] = [];
  let title = '';
  let para: string[] = [];
  let bullets: string[] = [];
  let nums: string[] = [];
  const flush = () => {
    if (para.length) {
      out.push(`<p>${mdInlineToHtml(para.join(' ').trim())}</p>`);
      para = [];
    }
    if (bullets.length) {
      out.push(`<ul>${bullets.map((b) => `<li>${mdInlineToHtml(b)}</li>`).join('')}</ul>`);
      bullets = [];
    }
    if (nums.length) {
      out.push(`<ol>${nums.map((n) => `<li>${mdInlineToHtml(n)}</li>`).join('')}</ol>`);
      nums = [];
    }
  };
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].replace(/\s+$/, '');
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      if (level === 1) {
        if (stripFirstH1 && !title && !out.length && !bullets.length && !nums.length && !para.length) {
          title = stripInline(h[2]).trim();
        } else {
          if (!title) title = stripInline(h[2]).trim();
          out.push(`<h1>${mdInlineToHtml(h[2].trim())}</h1>`);
        }
      } else {
        out.push(`<h${level}>${mdInlineToHtml(h[2].trim())}</h${level}>`);
      }
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }
    // Pipe table run (header = row followed by a --- separator).
    if (isTableRow(line)) {
      const cells = isTableSeparator(line) ? null : splitRawTableRow(line);
      if (cells === null) continue;
      const next = (rawLines[i + 1] ?? '').trim();
      const hasHeader = isTableSeparator(next) && cells.length > 0;
      const header = hasHeader ? cells : [];
      const rows: string[][] = [];
      let j = hasHeader ? i + 2 : i;
      for (; j < rawLines.length; j++) {
        const rl = rawLines[j].replace(/\s+$/, '');
        if (!isTableRow(rl)) break;
        if (isTableSeparator(rl)) continue;
        rows.push(splitRawTableRow(rl));
      }
      flush();
      out.push(mdTableToHtml(header, rows));
      i = j - 1;
      continue;
    }
    const n = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (n && listLevel(n[1]) <= 1) {
      flush();
      nums.push(n[3].trim());
      continue;
    }
    const b = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (b && listLevel(b[1]) <= 2) {
      flush();
      bullets.push(b[2].trim());
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      out.push(`<blockquote>${mdInlineToHtml(line.replace(/^>\s?/, '').trim())}</blockquote>`);
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return { title, html: out.join('\n') };
}

// ---------------------------------------------------------------------------
// Design tokens (shared palette across PDF / DOCX / XLSX / HTML)
// ---------------------------------------------------------------------------

/** Deep teal — professional, print-friendly, brand-safe accent (classique). */
const CLASSIC_ACCENT_HEX = '0F6B61';
const CLASSIC_ACCENT_DARK_HEX = '0B4A44';
const CLASSIC_ACCENT_TINT_HEX = 'E8F1EF';
const CLASSIC_INK_HEX = '1F2937';
const CLASSIC_ZEBRA_HEX = 'F4F6F6';
const CLASSIC_HAIRLINE_HEX = 'D6DBDB';

/** Ultra-modern "violet néon" palette (moderne engine).
 *  Violet-600 → fuchsia-600 gradient accents, purple-tinted ink/zebra. */
const MODERN_ACCENT_HEX = '7C3AED';
const MODERN_ACCENT2_HEX = 'C026D3';
const MODERN_ACCENT_DARK_HEX = '6D28D9';
const MODERN_TINT_HEX = 'F4EEFF';
const MODERN_INK_HEX = '1E1B2E';
const MODERN_ZEBRA_HEX = 'F8F5FC';
const MODERN_HAIRLINE_HEX = 'E4DBF5';

/** Full palettes (classic editorial + modern) shared by DOCX/XLSX. The PDF
 *  converter computes its rgb tokens from the same source. */
const CLASSIC_PALETTE = {
  accent: CLASSIC_ACCENT_HEX,
  accent2: CLASSIC_ACCENT_HEX,
  accentDark: CLASSIC_ACCENT_DARK_HEX,
  tint: CLASSIC_ACCENT_TINT_HEX,
  ink: '0F172A',
  body: '334155',
  muted: '64748B',
  zebra: CLASSIC_ZEBRA_HEX,
  hairline: 'D9DEDE',
} as const;
const MODERN_PALETTE = {
  accent: MODERN_ACCENT_HEX,
  accent2: MODERN_ACCENT2_HEX,
  accentDark: MODERN_ACCENT_DARK_HEX,
  tint: MODERN_TINT_HEX,
  ink: '0F172A',
  body: '334155',
  muted: '64748B',
  zebra: MODERN_ZEBRA_HEX,
  hairline: MODERN_HAIRLINE_HEX,
} as const;

/** Template theme — palette + typography override for every converter.
 *  Provided by the documents engine (src/lib/documents): the layout engine
 *  stays keyed on `design` (classique editorial / moderne bold) while the
 *  palette + fonts come from the DOCUMENT TEMPLATE (corporate, academic,
 *  creative…). When absent the converters keep their classic/modern looks. */
export type DocTheme = {
  palette: {
    accent: string;
    accent2: string;
    accentDark: string;
    tint: string;
    ink: string;
    body: string;
    muted: string;
    zebra: string;
    hairline: string;
  };
  /** serif typography (academic / executive / …). */
  serif: boolean;
};

/** Resolve the palette: explicit theme → design default. */
function paletteFor(design: DocumentDesign, theme?: DocTheme) {
  if (theme) return theme.palette;
  return design === 'moderne' ? MODERN_PALETTE : CLASSIC_PALETTE;
}

/** Raw RGB channels (0-1) for the gradient interpolator. */
const VIOLET_CH = { r: 0.486, g: 0.227, b: 0.929 }; // #7C3AED
const FUCHSIA_CH = { r: 0.753, g: 0.149, b: 0.827 }; // #C026D3

function hexToChannels(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

// ---------------------------------------------------------------------------
// PDF converter (pdf-lib, standard fonts — WinAnsi safe)
// ---------------------------------------------------------------------------

/** Inline rich run: bold segments survive into the PDF. */
type RichRun = { text: string; bold: boolean };

/** Split a paragraph into bold/regular runs (** markers). */
function parseInlineBold(s: string): RichRun[] {
  const clean = (t: string) =>
    t
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  const out: RichRun[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ text: clean(s.slice(last, m.index)), bold: false });
    out.push({ text: clean(m[1]), bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: clean(s.slice(last)), bold: false });
  const flat = out.filter((r) => r.text);
  return flat.length ? flat : [{ text: clean(s), bold: false }];
}

async function markdownToPdfBytes(
  md: string,
  filename: string,
  design: DocumentDesign = 'classique',
  theme?: DocTheme
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const modern = design === 'moderne';
  const P = paletteFor(design, theme);
  // Local aliases — every `modern ? MODERN_X : X` in the body below resolves
  // to the THEMED palette when a template drives this call.
  const ACCENT_HEX = P.accent;
  const ACCENT_DARK_HEX = P.accentDark;
  const ACCENT_TINT_HEX = P.tint;
  const INK_HEX = P.ink;
  const ZEBRA_HEX = P.zebra;
  const HAIRLINE_HEX = P.hairline;
  const MODERN_ACCENT_HEX = P.accent;
  const MODERN_ACCENT2_HEX = P.accent2;
  const MODERN_ACCENT_DARK_HEX = P.accentDark;
  const MODERN_TINT_HEX = P.tint;
  const MODERN_INK_HEX = P.ink;
  const MODERN_ZEBRA_HEX = P.zebra;
  const MODERN_HAIRLINE_HEX = P.hairline;
  const doc = await PDFDocument.create();
  const serifFamily = theme?.serif === true;
  const F = serifFamily
    ? {
        regular: await doc.embedFont(StandardFonts.TimesRoman),
        bold: await doc.embedFont(StandardFonts.TimesRomanBold),
        italic: await doc.embedFont(StandardFonts.TimesRomanItalic),
        boldItalic: await doc.embedFont(StandardFonts.TimesRomanBoldItalic),
      }
    : {
        regular: await doc.embedFont(StandardFonts.Helvetica),
        bold: await doc.embedFont(StandardFonts.HelveticaBold),
        italic: await doc.embedFont(StandardFonts.HelveticaOblique),
        boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
      };

  // Design tokens — palette-driven (template theme when present; classic /
  // modern defaults otherwise). The LAYOUT stays keyed on `modern`.
  const CH = (hex: string) => {
    const h = hex.replace('#', '');
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
    };
  };
  const fromHex = (hex: string, k = 0) => {
    const c = CH(hex);
    if (!k) return rgb(c.r, c.g, c.b);
    return rgb(c.r + (1 - c.r) * k, c.g + (1 - c.g) * k, c.b + (1 - c.b) * k);
  };
  const C = {
    ink: fromHex(P.ink),
    body: fromHex(P.body),
    muted: fromHex(P.muted),
    accent: fromHex(P.accent),
    accent2: fromHex(P.accent2),
    accentSoft: fromHex(P.tint),
    zebra: fromHex(P.zebra),
    hairline: fromHex(P.hairline),
    tableBorder: fromHex(P.hairline, 0.25),
  };

  const PAGE_W = 595.28; // A4
  const PAGE_H = 841.89;
  const M_TOP = 66;
  const M_BOT = 62;
  const M_SIDE = 56;
  const CONTENT_W = PAGE_W - M_SIDE * 2;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M_TOP;
  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - M_TOP;
  };

  /** Themed gradient channels (accent → accent2 — violet/fuchsia under the
   *  modern engine, template accent pair under a themed call). */
  const GRAD1 = CH(P.accent);
  const GRAD2 = CH(P.accent2);

  /** Violet→fuchsia gradient band (pdf-lib has no native gradients —
   *  simulated with N interpolated slices, overlap hides the seams). */
  const drawGradientBar = (
    target: typeof page,
    x: number,
    gy: number,
    w: number,
    h: number,
    c1: typeof VIOLET_CH,
    c2: typeof FUCHSIA_CH,
    steps = 26
  ) => {
    const sw = w / steps;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      target.drawRectangle({
        x: x + i * sw,
        y: gy,
        width: sw + 0.5,
        height: h,
        color: rgb(
          c1.r + (c2.r - c1.r) * t,
          c1.g + (c2.g - c1.g) * t,
          c1.b + (c2.b - c1.b) * t
        ),
      });
    }
  };

  /** WinAnsi-safe transliteration. CP1252 already covers accents, œ, €,
   *  smart quotes, dashes, ellipsis and • — only truly exotic glyphs are
   *  mapped/fallback'd, so French text renders with REAL typography.
   *  Emoji/pictographs are STRIPPED (a bare "?" reads like a typo — the
   *  model loves "📧 a@b.com" contact lines), and the hollow bullet ◦ maps
   *  to "-" so nested lists never print "?" (pre-existing v2 wart). */
  const latin = (s: string): string =>
    s
      .replace(/\u00A0/g, ' ')
      .replace(/[\u2192\u21D2]/g, '->')
      .replace(/[\u2713\u2714]/g, 'v')
      .replace(/\u2611/g, '[x]')
      .replace(/[\u25A0\u25CF]/g, '*')
      .replace(/\u25E6/g, '-')
      .replace(
        /[\u{1F000}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u2700-\u27BF]/gu,
        ''
      )
      .replace(/ {2,}/g, ' ')
      .replace(/[^\u0000-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]/g, '?');

  const lines = markdownToLines(md);
  const docTitle = latin(
    (lines.find((l) => l.kind === 'h1') as { text?: string } | undefined)?.text?.trim() ||
      filename.replace(/\.[a-z0-9]+$/i, '') ||
      'Document'
  );

  /** Rich paragraph renderer: word-wrap with mixed bold/regular runs,
   *  hanging prefixes (bullets, numbers), page-break aware. */
  const drawRich = (
    raw: string,
    opts: {
      size: number;
      lineH: number;
      after: number;
      color: typeof C.ink;
      font?: typeof F.regular;
      forceBold?: boolean;
      indent?: number;
      hang?: number;
      prefix?: string;
      prefixColor?: typeof C.ink;
    }
  ) => {
    const runs: RichRun[] = opts.forceBold
      ? [{ text: raw, bold: true }]
      : parseInlineBold(raw);
    const toks: { text: string; bold: boolean }[] = [];
    for (const r of runs) {
      for (const w of r.text.split(/\s+/)) if (w) toks.push({ text: w, bold: r.bold });
    }
    if (!toks.length) return;
    const indent = opts.indent ?? 0;
    const hang = opts.hang ?? 0;
    const maxW = CONTENT_W - indent - hang;
    const base = opts.font ?? F.regular;
    const fontFor = (b: boolean) => {
      if (opts.forceBold || (b && base !== F.italic)) return F.bold;
      if (b && base === F.italic) return F.boldItalic;
      return base;
    };
    // Greedy wrap into lines of tokens.
    const outLines: { text: string; bold: boolean }[][] = [];
    let cur: { text: string; bold: boolean }[] = [];
    let curW = 0;
    for (const t of toks) {
      const tw = fontFor(t.bold).widthOfTextAtSize(latin(t.text), opts.size);
      const sw = fontFor(t.bold).widthOfTextAtSize(' ', opts.size);
      if (cur.length && curW + sw + tw > maxW) {
        outLines.push(cur);
        cur = [];
        curW = 0;
      }
      cur.push(t);
      curW += (cur.length > 1 ? sw : 0) + tw;
    }
    if (cur.length) outLines.push(cur);
    // Draw.
    for (let li = 0; li < outLines.length; li++) {
      y -= opts.lineH;
      if (y < M_BOT) newPage();
      if (li === 0 && opts.prefix) {
        page.drawText(latin(opts.prefix), {
          x: M_SIDE + indent,
          y,
          size: opts.size,
          font: fontFor(false),
          color: opts.prefixColor ?? opts.color,
        });
      }
      let x = M_SIDE + indent + hang;
      for (const t of outLines[li]) {
        const txt = latin(t.text);
        page.drawText(txt, { x, y, size: opts.size, font: fontFor(t.bold), color: opts.color });
        x += fontFor(t.bold).widthOfTextAtSize(txt, opts.size) + fontFor(t.bold).widthOfTextAtSize(' ', opts.size);
      }
    }
    y -= opts.after;
  };

  const ensure = (h: number) => {
    if (y - h < M_BOT) newPage();
  };

  /** Underline bar used under the title / h1s — gradient in moderne. */
  const accentBar = (width: number, height = 2.4) => {
    if (modern) {
      drawGradientBar(page, M_SIDE, y - 2, width, height, GRAD1, GRAD2, 14);
    } else {
      page.drawRectangle({ x: M_SIDE, y: y - 2, width, height, color: C.accent });
    }
    y -= height + 8;
  };

  // ------------------------------------------------------------------ tables
  const drawTable = (tbl: { header: string[]; rows: string[][] }) => {
    const size = 9.5;
    const lineH = 12.5;
    const padV = 5;
    const padH = 7;
    const nCols = Math.max(1, tbl.header.length, ...tbl.rows.map((r) => r.length));
    const norm = (cells: string[]) => {
      const out = cells.slice(0, nCols);
      while (out.length < nCols) out.push('');
      return out;
    };
    const plain = (s: unknown) => stripInline(String(s ?? '')).trim();
    // Column widths: natural max width per column, capped, redistributed.
    const natural: number[] = new Array(nCols).fill(46);
    const consider = (cells: string[]) => {
      norm(cells).forEach((c, i) => {
        const w = F.regular.widthOfTextAtSize(latin(plain(c)).slice(0, 80), size);
        natural[i] = Math.max(natural[i], Math.min(185, w + padH * 2));
      });
    };
    if (tbl.header.length) consider(tbl.header);
    tbl.rows.forEach(consider);
    const total = natural.reduce((a, b) => a + b, 0);
    let widths = natural.map((w) => w);
    if (total > CONTENT_W) {
      const scale = CONTENT_W / total;
      widths = natural.map((w) => Math.max(38, w * scale));
    }
    const sum2 = widths.reduce((a, b) => a + b, 0);
    widths = widths.map((w) => (w / sum2) * CONTENT_W);
    const colX: number[] = [];
    let cx = M_SIDE;
    for (const w of widths) {
      colX.push(cx);
      cx += w;
    }

    const wrapCell = (text: string, colW: number, font: typeof F.regular): string[] => {
      const words = latin(text).split(/\s+/).filter(Boolean);
      if (!words.length) return [''];
      const outs: string[] = [];
      let curLine = '';
      for (const w of words) {
        const cand = curLine ? `${curLine} ${w}` : w;
        if (font.widthOfTextAtSize(cand, size) > colW - padH * 2 && curLine) {
          outs.push(curLine);
          curLine = w;
        } else {
          curLine = cand;
        }
      }
      if (curLine) outs.push(curLine);
      return outs;
    };

    const drawRowBand = (cells: string[], kind: 'header' | 'data', rowIdx: number, redrawHeader = true) => {
      const cellFont = kind === 'header' ? F.bold : F.regular;
      const cellTexts = norm(cells).map(plain);
      const cellLines = cellTexts.map((c, i) => wrapCell(c, widths[i], cellFont));
      const nLines = Math.max(1, ...cellLines.map((l) => l.length));
      const rowH = nLines * lineH + padV * 2;
      if (y - (rowH + 4) < M_BOT) {
        newPage();
        if (kind === 'data' && redrawHeader && tbl.header.length) {
          drawRowBand(tbl.header, 'header', -1, false);
        }
      }
      const rowTop = y;
      // Backgrounds — moderne: solid violet header (white text rides on it).
      if (kind === 'header') {
        page.drawRectangle({
          x: M_SIDE,
          y: rowTop - rowH,
          width: CONTENT_W,
          height: rowH,
          color: modern ? C.accent : C.accentSoft,
        });
      } else if (rowIdx % 2 === 1) {
        page.drawRectangle({ x: M_SIDE, y: rowTop - rowH, width: CONTENT_W, height: rowH, color: C.zebra });
      }
      // Bottom border (fuchsia under the moderne header, accent classique).
      page.drawLine({
        start: { x: M_SIDE, y: rowTop - rowH },
        end: { x: PAGE_W - M_SIDE, y: rowTop - rowH },
        thickness: kind === 'header' ? (modern ? 1.5 : 1.1) : 0.5,
        color: kind === 'header' ? (modern ? C.accent2 : C.accent) : C.tableBorder,
      });
      // Cell separators (verticals).
      for (let i = 1; i < nCols; i++) {
        page.drawLine({
          start: { x: colX[i], y: rowTop },
          end: { x: colX[i], y: rowTop - rowH },
          thickness: 0.4,
          color: C.tableBorder,
        });
      }
      // Text.
      const font = kind === 'header' ? F.bold : F.regular;
      const color = kind === 'header' ? (modern ? rgb(1, 1, 1) : C.ink) : C.body;
      const baseline0 = rowTop - padV - size * 0.85;
      cellLines.forEach((cl, i) => {
        for (let k = 0; k < cl.length; k++) {
          page.drawText(cl[k], {
            x: colX[i] + padH,
            y: baseline0 - k * lineH,
            size,
            font,
            color,
          });
        }
      });
      y = rowTop - rowH;
    };

    ensure(30);
    y -= 6;
    if (tbl.header.length) drawRowBand(tbl.header, 'header', -1, false);
    tbl.rows.forEach((r, ri) => drawRowBand(r, 'data', ri));
    y -= 12;
  };

  // ------------------------------------------------------------------ render
  let sawTitle = false;
  let numCounter = 0;
  for (const item of lines) {
    switch (item.kind) {
      case 'h1': {
        const isTitle = !sawTitle && lines.indexOf(item) === 0;
        sawTitle = true;
        if (isTitle && modern) {
          // Magazine treatment: right-aligned date pill above a big title,
          // full-width violet→fuchsia gradient underline.
          ensure(112);
          const month = latin(
            new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }).toUpperCase()
          );
          const pillFs = 7.5;
          const pillW = F.bold.widthOfTextAtSize(month, pillFs) + 18;
          const pillH = 15;
          const pillX = PAGE_W - M_SIDE - pillW;
          y -= 6;
          page.drawRectangle({ x: pillX, y: y - pillH, width: pillW, height: pillH, color: C.accent });
          page.drawText(month, { x: pillX + 9, y: y - pillH + 4.6, size: pillFs, font: F.bold, color: rgb(1, 1, 1) });
          y -= pillH + 12;
          drawRich(item.text, { size: 24, lineH: 28, after: 4, color: C.ink, forceBold: true });
          drawGradientBar(page, M_SIDE, y - 2, CONTENT_W, 3.4, GRAD1, GRAD2, 32);
          y -= 3.4 + 10;
          break;
        }
        ensure(64);
        drawRich(item.text, {
          size: isTitle ? 23 : 20,
          lineH: isTitle ? 27 : 24,
          after: 4,
          color: C.ink,
          forceBold: true,
        });
        accentBar(isTitle ? 88 : 52);
        break;
      }
      case 'h2':
        if (modern) {
          // Blocky violet chip before the heading — no hairline rules in moderne.
          ensure(48);
          page.drawRectangle({ x: M_SIDE, y: y - 11, width: 8, height: 8, color: C.accent });
          drawRich(item.text, { size: 13, lineH: 17, after: 5, color: C.ink, forceBold: true, indent: 15 });
          y -= 2;
          break;
        }
        ensure(52);
        drawRich(item.text, { size: 14, lineH: 18, after: 3, color: C.ink, forceBold: true });
        y -= 3;
        page.drawLine({
          start: { x: M_SIDE, y },
          end: { x: PAGE_W - M_SIDE, y },
          thickness: 0.5,
          color: C.hairline,
        });
        y -= 9;
        break;
      case 'h3':
        ensure(40);
        drawRich(item.text, {
          size: 11.5,
          lineH: 15,
          after: 3,
          color: modern ? C.accent : rgb(0.22, 0.25, 0.28),
          forceBold: true,
        });
        break;
      case 'h4':
        ensure(36);
        drawRich(item.text, { size: 10.5, lineH: 14, after: 2, color: rgb(0.3, 0.33, 0.36), forceBold: true });
        break;
      case 'bullet':
        drawRich(item.text, {
          size: 10.5,
          lineH: 15,
          after: 3.5,
          color: C.body,
          indent: 6 + item.level * 12,
          hang: 12,
          prefix: item.level === 0 ? '•' : '◦',
          prefixColor: modern ? C.accent : undefined,
        });
        break;
      case 'numitem': {
        numCounter += 1;
        const marker = `${numCounter}.`;
        drawRich(item.text, {
          size: 10.5,
          lineH: 15,
          after: 3.5,
          color: C.body,
          indent: 6,
          hang: 14,
          prefix: marker,
          prefixColor: modern ? C.accent : undefined,
        });
        break;
      }
      case 'quote': {
        ensure(40);
        const yTop = y;
        drawRich(item.text, {
          size: 10.5,
          lineH: 15,
          after: 6,
          color: C.muted,
          font: F.italic,
          indent: 16,
        });
        // Left accent bar next to the quote (fuchsia in moderne).
        const barH = Math.max(14, yTop - y - 4);
        page.drawRectangle({ x: M_SIDE + 2, y: y + 4, width: 1.8, height: barH, color: modern ? C.accent2 : C.accent });
        break;
      }
      case 'hr':
        ensure(20);
        y -= 6;
        page.drawLine({
          start: { x: M_SIDE, y },
          end: { x: PAGE_W - M_SIDE, y },
          thickness: 0.6,
          color: C.hairline,
        });
        y -= 10;
        break;
      case 'table':
        drawTable(item);
        numCounter = 0;
        break;
      case 'para':
        drawRich(item.text, { size: 10.5, lineH: 15.5, after: 8, color: C.body });
        break;
    }
    // Reset the numbered-list counter on any non-numitem line.
    if (item.kind !== 'numitem') numCounter = 0;
  }

  // ------------------------------------------------------------ footer pass
  const pages = doc.getPages();
  const N = pages.length;
  const dateStr = new Date().toLocaleDateString('fr-FR');
  pages.forEach((p, i) => {
    if (modern) {
      // Full-bleed violet→fuchsia gradient banner across the top edge.
      drawGradientBar(p, 0, PAGE_H - 6, PAGE_W, 6, GRAD1, GRAD2, 36);
    } else {
      // Slim brand rule at the top of every page.
      p.drawLine({
        start: { x: M_SIDE, y: PAGE_H - 34 },
        end: { x: PAGE_W - M_SIDE, y: PAGE_H - 34 },
        thickness: 0.75,
        color: C.accent,
      });
    }
    // Footer rule.
    p.drawLine({
      start: { x: M_SIDE, y: M_BOT - 16 },
      end: { x: PAGE_W - M_SIDE, y: M_BOT - 16 },
      thickness: 0.5,
      color: C.hairline,
    });
    // Left: document title (muted, truncated).
    let title = docTitle;
    const maxTitleW = CONTENT_W * 0.62;
    while (title.length > 4 && F.regular.widthOfTextAtSize(title, 8) > maxTitleW) {
      title = title.slice(0, -1);
    }
    if (title !== docTitle) title = `${title}…`.replace(/\.…$/, '…');
    p.drawText(title, { x: M_SIDE, y: M_BOT - 28, size: 8, font: F.regular, color: C.muted });
    // Right: date + page x/N.
    const right = latin(`${dateStr}  ·  Page ${i + 1} / ${N}`);
    const w = F.regular.widthOfTextAtSize(right, 8);
    p.drawText(right, { x: PAGE_W - M_SIDE - w, y: M_BOT - 28, size: 8, font: F.regular, color: C.muted });
  });

  return doc.save();
}

// ---------------------------------------------------------------------------
// XLSX converter — styled via ExcelJS (SheetJS fallback)
// ---------------------------------------------------------------------------

type MdSheet = { name: string; header: string[]; rows: string[][] };

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

/** Split the markdown into sheets (heading + following pipe table). */
function splitMarkdownSheets(md: string): { sheets: MdSheet[]; sawTable: boolean } {
  const lines = md.split(/\r?\n/);
  type RawSheet = { name: string | null; hasHeader: boolean; rows: string[][] };
  const raws: RawSheet[] = [];
  let sawTable = false;
  let lastHeading: string | null = null;
  let current: RawSheet | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (isTableRow(line)) {
      if (isTableSeparator(line)) continue; // separator consumed
      if (!current) {
        const next = (lines[i + 1] ?? '').trim();
        current = { name: lastHeading, hasHeader: isTableSeparator(next), rows: [] };
        raws.push(current);
      }
      current.rows.push(splitTableRow(line));
      sawTable = true;
    } else {
      if (current && current.rows.length) current = null;
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) lastHeading = h[1];
    }
  }
  const out: MdSheet[] = [];
  raws.forEach((s, i) => {
    const rows = s.rows.filter((r) => r.some((c) => c.trim() !== ''));
    if (!rows.length) return;
    const header: string[] = s.hasHeader
      ? rows[0].map((c) => c)
      : rows[0].map((_, ci) => `Colonne ${ci + 1}`);
    const data = s.hasHeader ? rows.slice(1) : rows;
    out.push({ name: sheetNameFromHeading(s.name, i), header, rows: data });
  });
  return { sheets: out, sawTable };
}

/** Minimal CSV parser (quotes + doubled quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        q = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      q = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (ch !== '\r') {
      cur += ch;
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const NUMERIC_CELL_RE = /^-?\d{1,12}(?:[.,]\d{1,4})?$/;

/** Styled workbook via ExcelJS: bold white-on-teal header, zebra rows,
 *  hairline borders, frozen header, autofilter, content-aware widths,
 *  numeric cells auto-typed. moderne: violet header + fuchsia rule/tabs. */
async function markdownToXlsxExcelJS(
  md: string,
  design: DocumentDesign = 'classique',
  theme?: DocTheme
): Promise<Uint8Array> {
  const modern = design === 'moderne';
  // Themed palette — locals shadow the module constants.
  const P = paletteFor(design, theme);
  const ACCENT_HEX = P.accent;
  const ACCENT_DARK_HEX = P.accentDark;
  const HAIRLINE_HEX = P.hairline;
  const ZEBRA_HEX = P.zebra;
  const MODERN_ACCENT_HEX = P.accent;
  const MODERN_ACCENT2_HEX = P.accent2;
  const MODERN_ZEBRA_HEX = P.zebra;
  const MODERN_HAIRLINE_HEX = P.hairline;
  const F_NAME = theme?.serif ? 'Cambria' : 'Calibri';
  const mod: any = await import('exceljs');
  const Workbook = mod?.Workbook ?? mod?.default?.Workbook;
  if (!Workbook) throw new Error('exceljs Workbook unavailable');
  const wb = new Workbook();
  wb.creator = 'Nelth-AI';
  wb.created = new Date();

  let sheets: MdSheet[] = [];
  const text = md.trim();
  if (text.includes(',') && !/^\s*</.test(text) && !text.includes('|')) {
    // Raw CSV → single sheet.
    const rows = parseCsv(text);
    if (rows.length) {
      sheets = [
        {
          name: 'Feuille 1',
          header: rows[0],
          rows: rows.slice(1),
        },
      ];
    }
  } else {
    sheets = splitMarkdownSheets(md).sheets;
  }
  if (!sheets.length) {
    // One cell per line — still styled.
    const rows = text
      .split(/\r?\n/)
      .map((l) => [l.trim()])
      .filter((r) => r[0]);
    sheets = [{ name: 'Feuille 1', header: ['Contenu'], rows }];
  }

  const thin = { style: 'thin' as const, color: { argb: `FF${modern ? MODERN_HAIRLINE_HEX : HAIRLINE_HEX}` } };
  const used = new Set<string>();
  sheets.forEach((sheet, si) => {
    let name = sheet.name || `Feuille ${si + 1}`;
    if (used.has(name)) name = `${name.slice(0, 28)} (${si + 1})`;
    used.add(name);
    const ws = wb.addWorksheet(name, {
      views: [{ state: 'frozen', ySplit: 1 }],
      pageSetup: { paperSize: 9, fitToWidth: 1, orientation: 'landscape' },
    });
    // moderne: alternate violet / fuchsia sheet tabs.
    if (modern) {
      ws.properties.tabColor = { argb: `FF${si % 2 === 0 ? MODERN_ACCENT_HEX : MODERN_ACCENT2_HEX}` };
    }
    const nCols = Math.max(1, sheet.header.length, ...sheet.rows.map((r) => r.length));
    const norm = (r: string[]) => {
      const out = r.slice(0, nCols).map((c) => String(c ?? '').trim());
      while (out.length < nCols) out.push('');
      return out;
    };
    // Content-aware column widths (wch chars).
    const widths: number[] = new Array(nCols).fill(12);
    const consider = (cells: string[]) => {
      norm(cells).forEach((c, i) => {
        widths[i] = Math.max(widths[i], Math.min(58, Math.max(10, c.length + 4)));
      });
    };
    consider(sheet.header);
    sheet.rows.forEach(consider);
    ws.columns = sheet.header.map((h, i) => ({ header: h, key: `c${i}`, width: widths[i] }));

    // Header row styling.
    const hRow = ws.getRow(1);
    hRow.height = modern ? 26 : 22;
    hRow.eachCell({ includeEmpty: true }, (cell: any) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: modern ? 12 : 11, name: F_NAME };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: `FF${modern ? MODERN_ACCENT_HEX : ACCENT_HEX}` },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        ...thin,
        bottom: { style: 'medium', color: { argb: `FF${modern ? MODERN_ACCENT2_HEX : ACCENT_DARK_HEX}` } },
      };
    });

    // Data rows: zebra + borders + numeric typing.
    sheet.rows.forEach((r) => {
      const values = norm(r);
      const row = ws.addRow(values);
      const ri = row.number;
      row.eachCell({ includeEmpty: true }, (cell: any) => {
        const v = typeof cell.value === 'string' ? cell.value.trim() : cell.value;
        if (typeof v === 'string' && v !== '' && NUMERIC_CELL_RE.test(v)) {
          const isDecimal = /[.,]\d/.test(v);
          cell.value = Number(v.replace(',', '.'));
          cell.numFmt = isDecimal ? '#,##0.00' : '#,##0';
        }
        cell.alignment = { vertical: 'middle', wrapText: true };
        cell.border = thin;
        if (ri % 2 === 0) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: `FF${modern ? MODERN_ZEBRA_HEX : ZEBRA_HEX}` },
          };
        }
      });
    });

    if (nCols > 0) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: nCols } };
    }
  });

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as unknown as ArrayBuffer);
}

/** Plain SheetJS fallback (no styling) if ExcelJS fails at runtime. */
async function markdownToXlsxSheetJS(md: string): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const { sheets } = splitMarkdownSheets(md);
  if (!sheets.length) {
    const text = md.trim();
    let ws;
    if (text.includes(',') && !/^\s*</.test(text)) {
      // CSV text → parse through the reader (typed API).
      const wbRaw = XLSX.read(text, { type: 'string' });
      const first = wbRaw.SheetNames[0];
      ws = wbRaw.Sheets[first] ?? XLSX.utils.aoa_to_sheet([['']]);
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
    sheets.forEach((sheet, i) => {
      const rows = [sheet.header, ...sheet.rows];
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const widths: number[] = [];
      for (const row of rows) {
        row.forEach((cell, c) => {
          widths[c] = Math.max(widths[c] ?? 8, Math.min(52, String(cell ?? '').length + 2));
        });
      }
      ws['!cols'] = widths.map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, sheet.name || `Feuille ${i + 1}`);
    });
  }
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return new Uint8Array(out as unknown as ArrayBuffer);
}

async function markdownToXlsxBytes(
  md: string,
  design: DocumentDesign = 'classique',
  theme?: DocTheme
): Promise<Uint8Array> {
  try {
    return await markdownToXlsxExcelJS(md, design, theme);
  } catch (e) {
    console.error('[document-generation] exceljs failed, SheetJS fallback', e);
    return markdownToXlsxSheetJS(md);
  }
}

// ---------------------------------------------------------------------------
// DOCX converter (docx package) — professional Word documents
// ---------------------------------------------------------------------------

async function markdownToDocxBytes(
  md: string,
  design: DocumentDesign = 'classique',
  theme?: DocTheme
): Promise<Uint8Array> {
  const modern = design === 'moderne';
  // Themed palette — locals shadow the module constants so every
  // `modern ? MODERN_X : X` below resolves to the template palette.
  const P = paletteFor(design, theme);
  const ACCENT_HEX = P.accent;
  const ACCENT_DARK_HEX = P.accentDark;
  const ACCENT_TINT_HEX = P.tint;
  const INK_HEX = P.ink;
  const BODY_HEX = P.body;
  const ZEBRA_HEX = P.zebra;
  const HAIRLINE_HEX = P.hairline;
  const MODERN_ACCENT_HEX = P.accent;
  const MODERN_ACCENT2_HEX = P.accent2;
  const MODERN_ACCENT_DARK_HEX = P.accentDark;
  const MODERN_TINT_HEX = P.tint;
  const MODERN_INK_HEX = P.ink;
  const MODERN_ZEBRA_HEX = P.zebra;
  const MODERN_HAIRLINE_HEX = P.hairline;
  // Themed typography — serif templates (academic, executive…) print Cambria.
  const F_BODY = theme?.serif ? 'Cambria' : 'Calibri';
  const F_TITLE = theme?.serif ? 'Cambria' : 'Calibri Light';
  const INK_TITLE = P.ink;
  const INK_STRONG = P.body;
  const ACCENT_QUOTE = P.accent2;
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    Footer,
    PageNumber,
    ShadingType,
    VerticalAlign,
    LevelFormat,
  } = await import('docx');

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

  // ---- Markdown table → styled Word table -------------------------------
  const mdTableToDocx = (header: string[], rows: string[][]): any => {
    const nCols = Math.max(1, header.length, ...rows.map((r) => r.length));
    const norm = (cells: string[]) => {
      const out = cells.slice(0, nCols).map((c) => String(c ?? '').trim());
      while (out.length < nCols) out.push('');
      return out;
    };
    // Percentage column widths from content weight.
    const weights: number[] = new Array(nCols).fill(8);
    const consider = (cells: string[]) => {
      norm(cells).forEach((c, i) => {
        weights[i] = Math.max(weights[i], Math.min(46, c.length + 6));
      });
    };
    consider(header);
    rows.forEach(consider);
    const wSum = weights.reduce((a, b) => a + b, 0);
    const pcts = weights.map((w) => Math.round((w / wSum) * 100));
    // Rounding drift goes to the last column.
    const drift = 100 - pcts.reduce((a, b) => a + b, 0);
    pcts[pcts.length - 1] += drift;

    const hair = { style: BorderStyle.SINGLE, size: 4, color: modern ? MODERN_HAIRLINE_HEX : HAIRLINE_HEX };
    const cellMargins = { top: 80, bottom: 80, left: 140, right: 140 };

    const headerCells = norm(header).map(
      (h, i) =>
        new TableCell({
          width: { size: pcts[i], type: WidthType.PERCENTAGE },
          // moderne: solid violet header with white bold text.
          shading: { type: ShadingType.CLEAR, fill: modern ? MODERN_ACCENT_HEX : ACCENT_TINT_HEX, color: 'auto' },
          verticalAlign: VerticalAlign.CENTER,
          margins: cellMargins,
          borders: { bottom: { style: BorderStyle.SINGLE, size: 12, color: modern ? MODERN_ACCENT2_HEX : ACCENT_HEX } },
          children: [
            new Paragraph({
              children: runsFromInline(h, {
                size: 20,
                bold: true,
                color: modern ? 'FFFFFF' : ACCENT_DARK_HEX,
              }),
              spacing: { after: 0, line: 260 },
            }),
          ],
        })
    );
    const bodyRows = rows.map((r, ri) => {
      const cells = norm(r).map(
        (cell, ci) =>
          new TableCell({
            width: { size: pcts[ci], type: WidthType.PERCENTAGE },
            margins: cellMargins,
            shading: ri % 2 === 1 ? { type: ShadingType.CLEAR, fill: modern ? MODERN_ZEBRA_HEX : ZEBRA_HEX, color: 'auto' } : undefined,
            children: [
              new Paragraph({
                children: runsFromInline(cell, { size: 20, color: INK_HEX }),
                spacing: { after: 0, line: 260 },
              }),
            ],
          })
      );
      return new TableRow({ children: cells });
    });
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: hair,
        bottom: hair,
        left: hair,
        right: hair,
        insideHorizontal: hair,
        insideVertical: hair,
      },
      rows: [new TableRow({ tableHeader: true, children: headerCells }), ...bodyRows],
    });
  };

  const children: any[] = [];
  const lines = markdownToLines(md);
  let sawTitle = false;
  // Group consecutive bullets / numbered items into real lists.
  let bulletBuffer: { text: string; level: number }[] = [];
  let numBuffer: { text: string; level: number }[] = [];
  const flushLists = () => {
    for (const b of bulletBuffer) {
      children.push(
        new Paragraph({
          children: runsFromInline(b.text, { size: 22, color: INK_HEX }),
          bullet: { level: Math.min(2, b.level) },
          spacing: { after: 40 },
        })
      );
    }
    bulletBuffer = [];
    for (const it of numBuffer) {
      children.push(
        new Paragraph({
          children: runsFromInline(it.text, { size: 22, color: INK_HEX }),
          numbering: { reference: 'nelth-num', level: 0 },
          spacing: { after: 40 },
        })
      );
    }
    numBuffer = [];
  };

  for (const item of lines) {
    switch (item.kind) {
      case 'h1': {
        flushLists();
        const isTitle = !sawTitle;
        sawTitle = true;
        children.push(
          new Paragraph({
            heading: isTitle ? HeadingLevel.TITLE : HeadingLevel.HEADING_1,
            children: runsFromInline(item.text, {
              size: isTitle ? (modern ? 56 : 52) : 40,
              bold: true,
              color: modern ? MODERN_INK_HEX : INK_TITLE,
            }),
            spacing: { before: isTitle ? 0 : 320, after: isTitle ? (modern ? 160 : 120) : 140 },
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: isTitle ? (modern ? 24 : 16) : 10,
                color: modern ? MODERN_ACCENT2_HEX : ACCENT_HEX,
                space: 6,
              },
            },
          })
        );
        break;
      }
      case 'h2':
        flushLists();
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: runsFromInline(item.text, {
              size: 30,
              bold: true,
              color: modern ? MODERN_ACCENT_DARK_HEX : INK_TITLE,
            }),
            spacing: { before: 280, after: 120 },
            // moderne: tinted violet band instead of a hairline underline.
            shading: modern ? { type: ShadingType.CLEAR, fill: MODERN_TINT_HEX } : undefined,
            border: modern
              ? undefined
              : { bottom: { style: BorderStyle.SINGLE, size: 4, color: HAIRLINE_HEX, space: 3 } },
          })
        );
        break;
      case 'h3':
        flushLists();
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            children: runsFromInline(item.text, { size: 25, bold: true, color: modern ? MODERN_ACCENT_DARK_HEX : INK_STRONG }),
            spacing: { before: 220, after: 100 },
          })
        );
        break;
      case 'h4':
        flushLists();
        children.push(
          new Paragraph({
            children: runsFromInline(item.text, { size: 23, bold: true, color: modern ? MODERN_ACCENT_DARK_HEX : INK_STRONG }),
            spacing: { before: 180, after: 80 },
          })
        );
        break;
      case 'bullet':
        if (numBuffer.length) flushLists();
        bulletBuffer.push({ text: item.text, level: item.level });
        break;
      case 'numitem':
        if (bulletBuffer.length) flushLists();
        numBuffer.push({ text: item.text, level: item.level });
        break;
      case 'quote':
        flushLists();
        children.push(
          new Paragraph({
            children: runsFromInline(item.text, { size: 22, italics: true, color: '4B5563' }),
            indent: { left: 360 },
            spacing: { before: 60, after: 120 },
            border: { left: { style: BorderStyle.SINGLE, size: modern ? 18 : 12, color: modern ? MODERN_ACCENT2_HEX : ACCENT_QUOTE, space: 8 } },
          })
        );
        break;
      case 'hr':
        flushLists();
        children.push(
          new Paragraph({
            text: '',
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: modern ? MODERN_HAIRLINE_HEX : HAIRLINE_HEX, space: 1 } },
            spacing: { before: 120, after: 120 },
          })
        );
        break;
      case 'table': {
        flushLists();
        children.push(mdTableToDocx(item.header, item.rows));
        // Word merges consecutive tables — always end with a spacer.
        children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
        break;
      }
      case 'para':
        flushLists();
        children.push(
          new Paragraph({
            children: runsFromInline(item.text, { size: 22, color: INK_HEX }),
            alignment: AlignmentType.LEFT,
            spacing: { after: 140, line: 276 },
          })
        );
        break;
    }
  }
  flushLists();

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: HAIRLINE_HEX, space: 4 } },
        children: [
          new TextRun({ text: 'Page ', size: 16, color: '9CA3AF' }),
          new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '9CA3AF' }),
          new TextRun({ text: ' / ', size: 16, color: '9CA3AF' }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '9CA3AF' }),
        ],
      }),
    ],
  });

  const document = new Document({
    creator: 'Nelth-AI',
    styles: {
      default: {
        document: {
          run: { font: F_BODY, size: 22, color: INK_HEX },
          paragraph: { spacing: { line: 276 } },
        },
        title: { run: { font: F_TITLE, size: 52, bold: true, color: INK_TITLE } },
        heading1: { run: { font: F_BODY, size: 40, bold: true, color: INK_TITLE }, paragraph: { spacing: { before: 320, after: 140 } } },
        heading2: { run: { font: F_BODY, size: 30, bold: true, color: INK_TITLE }, paragraph: { spacing: { before: 280, after: 120 } } },
        heading3: { run: { font: F_BODY, size: 25, bold: true, color: INK_STRONG }, paragraph: { spacing: { before: 220, after: 100 } } },
      },
    },
    numbering: {
      config: [
        {
          reference: 'nelth-num',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 360, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1440, bottom: 1440, left: 1300, right: 1300 } },
        },
        footers: { default: footer },
        children,
      },
    ],
  });
  const buffer = await Packer.toBuffer(document);
  return new Uint8Array(buffer as unknown as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// HTML documents — print-ready professional template
// ---------------------------------------------------------------------------

const HTML_DOC_TEMPLATE = (title: string, body: string) => `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<>&]/g, '')}</title>
<style>
:root{--ink:#111827;--muted:#6b7280;--accent:#0f6b61;--accent-dark:#0b4a44;--accent-tint:#e8f1ef;--hair:#e2e6e6}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#eef1f1;color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.page{max-width:860px;margin:32px auto;background:#fff;padding:56px 64px 48px;border-radius:10px;box-shadow:0 1px 2px rgba(16,24,40,.07),0 10px 30px rgba(16,24,40,.08)}
h1{font-size:30px;line-height:1.25;margin:0 0 18px;padding-bottom:14px;border-bottom:3px solid var(--accent);letter-spacing:-.3px}
h2{font-size:20px;margin:34px 0 12px;padding-bottom:7px;border-bottom:1px solid #d9dede;letter-spacing:-.2px}
h3{font-size:16px;margin:24px 0 8px}
h4{font-size:14.5px;margin:18px 0 6px}
p{margin:0 0 12px}
strong{font-weight:650}
ul,ol{padding-left:24px;margin:0 0 12px}
li{margin:0 0 5px}
table{width:100%;border-collapse:collapse;margin:18px 0;font-size:13.5px}
th{background:var(--accent-tint);color:var(--accent-dark);text-align:left;font-weight:650;padding:10px 12px;border:1px solid #d6dbdb;border-bottom:2px solid var(--accent)}
td{padding:9px 12px;border:1px solid var(--hair);vertical-align:top}
tbody tr:nth-child(even) td{background:#f5f7f7}
blockquote{margin:14px 0;padding:4px 18px;border-left:3px solid var(--accent);color:var(--muted);font-style:italic}
code{background:#f1f5f4;border-radius:4px;padding:2px 5px;font-size:.9em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:#0f172a;color:#e2e8f0;padding:16px 18px;border-radius:8px;overflow:auto;font-size:13px}
pre code{background:none;color:inherit;padding:0}
hr{border:none;border-top:1px solid #d9dede;margin:26px 0}
.doc-footer{margin-top:44px;padding-top:12px;border-top:1px solid #d9dede;color:var(--muted);font-size:12px;display:flex;justify-content:space-between}
@media print{body{background:#fff}.page{margin:0;box-shadow:none;border-radius:0;max-width:none;padding:0}.doc-footer{display:none}@page{size:A4;margin:16mm}}
</style>
</head>
<body>
<main class="page">
${body}
<div class="doc-footer"><span>Généré avec Nelth-AI</span><span>${new Date().toLocaleDateString('fr-FR')}</span></div>
</main>
</body>
</html>`;

/** ULTRA-MODERN HTML document (v3 "moderne") — gradient hero with kicker
 *  pill, Inter typography, diamond section chips, gradient table headers,
 *  tinted blockquotes, gradient hairlines; print rules included. */
const HTML_MODERN_DOC_TEMPLATE = (title: string, body: string) => `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title || 'Document')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root{--ink:#17141f;--muted:#6e6478;--v:#7c3aed;--v2:#6d28d9;--f:#c026d3;--tint:#f4eeff;--hair:#e9e2f5}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#f6f3fa;color:var(--ink);font:15.5px/1.7 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
.page{max-width:900px;margin:36px auto 64px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(23,20,31,.13)}
.hero{background:linear-gradient(120deg,#6d28d9 0%,#7c3aed 45%,#c026d3 100%);color:#fff;padding:54px 64px 46px;position:relative;overflow:hidden}
.hero::after{content:"";position:absolute;right:-90px;top:-90px;width:280px;height:280px;border-radius:50%;background:rgba(255,255,255,.09)}
.kicker{display:inline-block;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.38);border-radius:999px;padding:5px 16px;font-size:11.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;margin-bottom:20px}
.hero h1{margin:0;font-size:36px;line-height:1.12;font-weight:800;letter-spacing:-.5px;max-width:640px}
.hero .meta{margin-top:14px;font-size:13px;color:rgba(255,255,255,.88)}
.body{padding:52px 64px 56px}
h2{font-size:21.5px;font-weight:800;letter-spacing:-.2px;margin:40px 0 14px;display:flex;align-items:center;gap:11px}
h2::before{content:"";width:10px;height:10px;border-radius:3.5px;background:linear-gradient(135deg,var(--v),var(--f));flex:none;transform:rotate(45deg)}
h3{font-size:16.5px;font-weight:700;color:var(--v2);margin:28px 0 9px}
h4{font-size:14.5px;font-weight:700;color:var(--v2);margin:20px 0 7px}
h1{font-size:28px;font-weight:800;letter-spacing:-.3px;margin:26px 0 12px}
p{margin:0 0 13px}
strong{font-weight:700}
ul,ol{padding-left:25px;margin:0 0 13px}
li{margin:0 0 6px}
li::marker{color:var(--v);font-weight:600}
table{width:100%;border-collapse:separate;border-spacing:0;margin:22px 0;font-size:13.5px;border-radius:11px;overflow:hidden;box-shadow:0 0 0 1px var(--hair)}
th{background:linear-gradient(120deg,#6d28d9,#9d4edd);color:#fff;text-align:left;font-weight:700;padding:12px 15px}
td{padding:11px 15px;border-top:1px solid var(--hair);vertical-align:top}
tbody tr:nth-child(even) td{background:#faf7fe}
blockquote{margin:18px 0;padding:12px 18px;border-radius:0 11px 11px 0;background:var(--tint);border-left:4px solid var(--f);color:#5b5266;font-style:italic}
code{background:#f1ecfb;color:var(--v2);border-radius:5px;padding:2px 6px;font-size:.9em;font-family:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace}
pre{background:#1b1430;color:#e6e0f5;padding:17px 19px;border-radius:13px;overflow:auto;font-size:13px}
pre code{background:none;color:inherit;padding:0}
hr{border:none;height:2px;background:linear-gradient(90deg,var(--v),var(--f),transparent);margin:30px 0;border-radius:2px}
a{color:var(--v2);text-decoration:underline;text-decoration-color:rgba(124,58,237,.4);text-underline-offset:3px}
.doc-footer{margin-top:52px;padding-top:15px;border-top:1px solid var(--hair);color:var(--muted);font-size:12px;display:flex;justify-content:space-between}
@media print{body{background:#fff}.page{margin:0;border-radius:0;box-shadow:none;max-width:none}.hero{padding:24mm 16mm 12mm}.body{padding:0 16mm 12mm}.doc-footer{display:none}@page{size:A4;margin:0}}
</style>
</head>
<body>
<main class="page">
<header class="hero">
<span class="kicker">Document · Nelth-AI</span>
<h1>${escHtml(title || 'Document')}</h1>
<div class="meta">Édition ${new Date().toLocaleDateString('fr-FR')} · Design ultra moderne · généré par Nelth-AI</div>
</header>
<div class="body">
${body}
<div class="doc-footer"><span>Généré avec Nelth-AI — design ultra moderne</span><span>${new Date().toLocaleDateString('fr-FR')}</span></div>
</div>
</main>
</body>
</html>`;

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
  /** Documents-engine metadata — present when the SDR was persisted (the
   *  workspace uses document_id to open the editor). */
  document_id?: string;
  doc_type?: string;
  template?: string;
  language?: string;
  title?: string;
  /** INTERNAL — never persisted nor emitted: the self-contained ```html
   *  code-preview artifact body for this document. The chat flow appends it
   *  to the assistant message content (the SPA's native artifacts panel
   *  renders it), then strips it from the file payload. */
  artifact_html?: string;
};

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
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

/** Resolve a template id into a converter theme (lazy import avoids a
 *  cycle: templates/index has no imports back into this module). */
async function resolveDocTheme(
  templateId: string | null | undefined,
  _design: DocumentDesign
): Promise<DocTheme | undefined> {
  if (!templateId) return undefined;
  const { getTemplate } = await import('@/lib/documents/templates');
  const tpl = getTemplate(templateId);
  return { palette: tpl.palette, serif: tpl.typography.family === 'serif' };
}

/** Build the file bytes for one document block. Exported for previews and
 *  local verification harnesses. The block's design ("classique" default,
 *  "moderne" ultra-modern) selects the visual engine per format; a template
 *  id (documents engine) recolors + re-styles the same engines. */
export async function buildDocumentBytes(
  block: DocumentBlock
): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
  const filename = sanitizeFilename(block.filename);
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  const design: DocumentDesign = block.design === 'moderne' ? 'moderne' : 'classique';
  const theme = await resolveDocTheme(block.template, design);
  switch (ext) {
    case 'pdf':
      return { bytes: Buffer.from(await markdownToPdfBytes(block.content, filename, design, theme)), contentType: CONTENT_TYPES.pdf, filename };
    case 'docx':
      return { bytes: Buffer.from(await markdownToDocxBytes(block.content, design, theme)), contentType: CONTENT_TYPES.docx, filename };
    case 'xlsx':
    case 'xls':
      return { bytes: Buffer.from(await markdownToXlsxBytes(block.content, design, theme)), contentType: CONTENT_TYPES.xlsx, filename: filename.replace(/\.xls$/i, '.xlsx') };
    case 'pptx':
    case 'ppt': {
      // Presentations: the deck slides (markdown headings/bullets) drive a
      // real PptxGenJS deck — one slide per section, themed by the template.
      const { generatePptxBytes } = await import('@/lib/documents/generators/pptx-generator');
      const { parseDocSlides } = await import('@/lib/documents/core/markdown-to-doc');
      const { getTemplate } = await import('@/lib/documents/templates');
      const tpl = getTemplate(block.template ?? (design === 'moderne' ? 'modern' : 'corporate'));
      const { DocumentDocSchema } = await import('@/lib/documents/core/document-schema');
      const slides = parseDocSlides(block.content);
      const doc = DocumentDocSchema.parse({
        title: block.content.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() ?? filename.replace(/\.pptx?$/i, ''),
        docType: 'presentation',
        template: tpl.id,
        blocks: [],
        slides: slides.length ? slides : [{ title: '', bullets: [], layout: 'title' }],
      });
      return { bytes: Buffer.from(await generatePptxBytes(doc, tpl)), contentType: CONTENT_TYPES.pptx, filename: filename.replace(/\.ppt$/i, '.pptx') };
    }
    case 'html': {
      let body = block.content;
      if (!/<html[\s>]/i.test(body)) {
        const fileTitle = filename.replace(/\.html?$/i, '');
        // Markdown bodies are converted to real semantic HTML so raw "# …"
        // text never shows in the browser; the modern hero takes the first
        // # heading as its title, the classic template keeps it in the body.
        const looksHtml = /<(?:div|section|article|table|p|h[1-6]|ul|ol|header|main|body)\b/i.test(body);
        let inner = body;
        let heroTitle = fileTitle;
        if (!looksHtml) {
          const conv = mdToBasicHtml(body, design === 'moderne');
          inner = conv.html;
          heroTitle = conv.title || fileTitle;
        }
        body =
          design === 'moderne'
            ? HTML_MODERN_DOC_TEMPLATE(heroTitle, inner)
            : HTML_DOC_TEMPLATE(heroTitle, inner);
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

/** Persist a document block through the files pipeline → file card payload.
 *  v3 (documents engine): the block is ALSO converted to a validated SDR
 *  (Structured Document Representation) persisted in file.data.document —
 *  the workspace reads/edits/exports from it — and the payload carries the
 *  document metadata (document_id, docType, template) for the frontend. */
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

  // Documents engine: SDR + revision history riding the SAME file row.
  // Failures are non-fatal — the downloadable file already exists.
  let docMeta: Record<string, any> | null = null;
  let artifact_html: string | null = null;
  try {
    const { markdownToDocument, createDocumentRevision } = await import(
      '@/lib/documents/core/document-engine'
    );
    const ext = (filename.split('.').pop() ?? '').toLowerCase();
    const doc = markdownToDocument(block.content, {
      filename,
      ext,
      modern: block.design === 'moderne',
      template: block.template,
    });
    // A template attribute resolved the template; when the block had none,
    // markdownToDocument picked a type-appropriate default. The template's
    // layout engine should ALSO drive the byte design when it disagrees —
    // but bytes are already built; the workspace re-exports on demand with
    // the resolved template anyway (export manager re-renders every time).
    const revisions = createDocumentRevision(null, {
      by: 'create',
      title: doc.title,
      blocks: doc.blocks,
      sheets: doc.sheets,
      slides: doc.slides,
    });
    await updateFileData(id, { document: doc, revisions });
    // Code-preview artifact: the document rides the SPA's NATIVE artifacts
    // system (```html block in the message → Artifacts panel) instead of a
    // parallel workspace-only preview. The toolbar inside it (downloads +
    // atelier) talks to the documents bridge through postMessage.
    try {
      const { buildArtifactHtml } = await import('@/lib/documents/preview/artifact-html');
      artifact_html = buildArtifactHtml(doc, { documentId: id });
    } catch (e) {
      console.error('[document-generation] artifact html build failed', e);
    }
    docMeta = {
      document_id: id,
      doc_type: doc.docType,
      template: doc.template,
      language: doc.language,
      title: doc.title,
    };
    console.log(
      `[document-generation] SDR created — ${doc.docType}/${doc.template} · ${doc.blocks.length} blocks${doc.sheets?.length ? ` · ${doc.sheets.length} sheets` : ''}${doc.slides?.length ? ` · ${doc.slides.length} slides` : ''}`
    );
  } catch (e) {
    console.error('[document-generation] SDR build failed (file still served)', e);
  }

  const meta = (fileItem?.meta ?? {}) as Record<string, any>;
  return {
    type: 'file',
    id,
    url: `/api/v1/files/${id}/content`,
    name: meta.name ?? filename,
    size: bytes.length,
    content_type: meta.content_type ?? contentType,
    ...(docMeta ?? {}),
    ...(artifact_html ? { artifact_html } : {}),
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
