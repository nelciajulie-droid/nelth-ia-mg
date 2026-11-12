/**
 * Premium document QUALITY PASS — "why aren't our documents as good as
 * ChatGPT's?" (TS-port extension).
 *
 * DIAGNOSIS (the question this module answers): the rendering libraries
 * (pdf-lib / docx / ExcelJS / PptxGenJS) faithfully render whatever they are
 * given — the design system is already senior-grade (typography hierarchy,
 * accent rules, real tables, pagination, gradient heroes). The quality gap
 * lives UPSTREAM: the document CONTENT is written inline, in one shot, by the
 * CHAT model — frequently the standard free model (16B active params) — while
 * it is also busy answering the user. The result is a thin skeleton: 200
 * vague words, no tables, one-line sections.
 *
 * ChatGPT-grade documents come from a DEDICATED writing pass: a strong model
 * + a document-specialist prompt + the full user request as context. That is
 * exactly what this module adds to the generation pipeline:
 *
 *   chat model draft (```document block)
 *          │
 *          ▼
 *   enhanceDocumentBlocks()  ── strong reasoning model (55B active) with the
 *   SENIOR_DOCUMENT_WRITER    │  senior-writer prompt below
 *          │                  │  per-format playbooks (CV / rapport / facture
 *          │                  │  / lettre / xlsx / pptx)
 *          ▼                  │  validation gates (refusal, structure, depth)
 *   enhanced content ─────────┘  (falls back to the draft on ANY failure —
 *          │                    the pass can never make a document WORSE)
 *          ▼
 *   buildDocumentBytes() → PDF / DOCX / XLSX / PPTX (unchanged renderers)
 *
 * Guarantees:
 *   • NON-REGRESSIVE — every gate failure keeps the original draft; the pass
 *     only replaces content that is materially richer and structurally valid.
 *   • TIME-BOXED — a total budget (default 150s) is shared by the blocks
 *     (concurrent, staggered — a multi-file turn costs the slowest pass); the
 *     caller (v12-flow) additionally skips the pass when the request already
 *     consumed most of the serverless budget (Vercel kill protection for
 *     persistAssistant).
 *   • FORMAT-AWARE — csv/json/html blocks are skipped (data formats a rewrite
 *     could corrupt); xlsx/pptx blocks get their own sheet/slide playbooks so
 *     the output matches the exact grammar parseDocSheets/parseDocSlides eat.
 */

// Structural stand-in for DocumentBlock (avoids a type-level import cycle
// with lib/document-generation — structural typing passes the real thing).
export type QualityBlock = {
  filename: string;
  content: string;
  design?: string;
  template?: string;
};

// ---------------------------------------------------------------------------
// The senior-writer prompt (the core of the quality fix)
// ---------------------------------------------------------------------------

export const SENIOR_DOCUMENT_WRITER_PROMPT = `You are Nelth-AI's PREMIUM DOCUMENT WRITER — a senior professional writer with 15+ years of experience producing board-level reports, CVs, proposals, invoices, letters, pitch decks and spreadsheets for executives, clients and recruiters. Your documents read like they were written by a top-tier consultant, never by a chatbot.

You receive: (1) the USER'S REQUEST verbatim, (2) a DRAFT document written quickly by a chat model (a skeleton), (3) the TARGET FILENAME whose extension sets the format. Your job: produce the FINAL document the user will download — the draft's facts, rewritten and EXPANDED to full professional depth. The file is the deliverable: make it worth downloading.

OUTPUT — return ONLY the final document in Nelth document markdown:
- No commentary, no greetings, no "Here is", no code fences, no explanation before or after. The output STARTS with the document's first line.
- # = document title · ## = sections · ### = sub-sections · - = bullets · **bold** = key facts and figures · pipe tables (| A | B | header + | --- | --- | separator row) for ANY enumerable, comparative or numeric data.
- Write the document in the SAME LANGUAGE as the draft (French draft → French document, with French typography: « » guillemets, espace before ! ? : ;).

QUALITY BAR — every point is non-negotiable:
1. DEPTH AND DENSITY — develop every section with concrete substance. Text documents target 900–1800 words (a full 1–3 page deliverable). A thin skeleton draft MUST be expanded; a rich draft must be preserved and polished, never hollowed out.
2. SPECIFICITY — real numbers, dates, amounts, percentages, durations, team sizes, budgets, measurable results. NEVER vague filler ("divers", "plusieurs", "etc." as sole content) and NEVER one-word bullets. When the draft lacks specifics, write realistic, coherent specifics consistent with the seniority, industry and currency of the context.
3. PROFESSIONAL STRUCTURE — title, a 2–4 sentence intro under it, ## sections in a logical order, ### sub-sections when a section is rich, and a conclusion / recommendations section for reports and proposals.
4. TABLES — ANY comparative, enumerable, numeric or line-item content goes into a pipe table: budgets, KPIs, timelines, roadmaps, skills matrices, line items, comparisons. The platform renders them as styled professional tables.
5. FIDELITY — keep EVERY fact, name, date, amount, company, requirement and constraint present in the user request or the draft. Never contradict them, never drop them.
6. COMPLETENESS — no placeholders ([...], TBD, "à compléter", [Your Name]), no meta-text, no mention of this rewrite, no "Generated by" signature.

FORMAT PLAYBOOKS:
- Reports, études, mémoires (.pdf/.docx/.txt/.md): ## Synthèse exécutive (dense bullets + key numbers) → ## Contexte → developed sections (### where useful) → at least one data table → ## Risques or ## Prochaines étapes → ## Conclusion.
- CV: # Name — Job Title · ## Profil (3–5 dense lines with years of experience and domains) · ## Expériences professionnelles (one ### per role: period — company — title, then 3–5 quantified achievements) · ## Formation · ## Compétences (pipe table: domaine | compétences | niveau) · ## Langues (table).
- Formal letters: objet line, salutation, 3–5 developed paragraphs (context, argumentation, request), proper formule de politesse, signature block.
- Invoices / devis: ## line items pipe table (description | quantité | prix unitaire | total) with a TOTAL row, then ## Conditions de paiement (deadline, VAT, late fees) — amounts formatted consistently (e.g. € or FC).
- Spreadsheets (.xlsx/.xls): ONE "## Sheet name" heading PER sheet, each followed by exactly ONE complete pipe table (header row + --- row + 8–25 realistic data rows). Build 2–4 sheets when the request implies them (e.g. Synthèse + Détail + Budget). Derived values as Excel formulas in the cell (=SUM(B2:B10), =C2*D2). NO prose outside the sheet headings.
- Presentations (.pptx/.ppt): "# Deck title" first (the title slide), then ONE "## Slide title" PER SLIDE followed by 3–6 SHORT bullets (max ~12 words each, one idea per line), 8–12 slides total, ending with a Conclusion slide. Optional speaker notes as "> notes: …" under a slide. NEVER one giant slide, never prose paragraphs on a slide.`;

// ---------------------------------------------------------------------------
// Validation gates (a failed pass must NEVER degrade the draft)
// ---------------------------------------------------------------------------

/** Extensions the pass rewrites. csv/json are DATA formats (a rewrite could
 *  corrupt them); raw .html is code the chat model authored deliberately. */
const ENHANCEABLE_EXTS = new Set(['pdf', 'docx', 'txt', 'md', 'xlsx', 'xls', 'pptx', 'ppt']);

/** Refusal / meta markers — a reply carrying one is rejected wholesale. */
const REFUSAL_RE =
  /\b(i cannot|i can't|je ne peux pas|unable to (create|generate|write)|as an ai|i'm sorry|désolé,? je ne)\b/i;

/** Unwrap an accidental ```document / ```markdown fence around the reply. */
function unwrapFences(reply: string): string {
  let out = reply.trim();
  for (let i = 0; i < 2; i++) {
    const fenced = out.match(/^```[a-zA-Z0-9_-]*[^\n]*\n([\s\S]*?)\n```[ \t]*$/);
    if (fenced) out = fenced[1].trim();
  }
  return out;
}

/** Drop leading meta-chatter before the first heading — the document grammar
 *  always starts with a heading (# title, ## Sheet, ## Slide), so anything
 *  before it is preamble ("Voici votre document :"). */
function stripLeadingChatter(text: string): string {
  const headingIdx = text.search(/^#{1,3}\s+\S/m);
  if (headingIdx > 0) return text.slice(headingIdx).trim();
  return text;
}

export type EnhanceGateResult = { ok: boolean; reason?: string };

/** Validate one enhanced draft against its original. */
export function validateEnhancedContent(
  original: string,
  enhanced: string,
  ext: string
): EnhanceGateResult {
  if (!enhanced || enhanced.length < 400) return { ok: false, reason: 'too short' };
  if (REFUSAL_RE.test(enhanced.slice(0, 600))) return { ok: false, reason: 'refusal marker' };

  // Structure gate per format family.
  if (ext === 'xlsx' || ext === 'xls') {
    if (!/^\s*\|.*\|/m.test(enhanced)) return { ok: false, reason: 'no table rows' };
  } else if (ext === 'pptx' || ext === 'ppt') {
    if (!/^##\s+\S/m.test(enhanced)) return { ok: false, reason: 'no slide headings' };
  } else {
    if (!/^#{1,2}\s+\S/m.test(enhanced)) return { ok: false, reason: 'no document heading' };
  }

  // Depth gate — the rewrite must be materially richer than the draft
  // (chars, robust across table-heavy and text-heavy formats). A condensation
  // of an already-rich draft is allowed down to 0.85×; a thin draft must at
  // least double or clear the professional floor.
  const origLen = original.trim().length;
  const enhLen = enhanced.trim().length;
  const floor = Math.max(1_000, origLen * 2);
  const maintenance = origLen >= 4_000 && enhLen >= origLen * 0.85;
  const growth = enhLen >= floor;
  if (!maintenance && !growth) {
    return { ok: false, reason: `depth gate (draft ${origLen} → ${enhLen} chars)` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export type EnhanceDocumentBlocksOpts = {
  /** The user's raw request text (verbatim) — the writer's primary context. */
  userRequest?: string;
  /** Total time budget for ALL blocks, ms (default 150s, shared sequentially). */
  budgetMs?: number;
  /** Per-call model override (tests). Defaults to the strong reasoning model. */
  model?: string;
  /** Generation temperature (default 0.45 — professional, low-drift). */
  temperature?: number;
};

export type EnhanceStats = {
  filename: string;
  applied: boolean;
  reason?: string;
  draftChars: number;
  finalChars: number;
  ms: number;
};

/** Rewrite every enhanceable block to expert level. NEVER throws — on any
 *  failure the original blocks come back untouched (with stats for logs).
 *  Blocks run CONCURRENTLY (staggered ~700ms to smooth free-gateway burst
 *  limits) sharing one wall-clock budget: a two-file turn costs the SLOWEST
 *  pass, not the sum. A transport failure on one block keeps ITS draft —
 *  the others still get their rewrite. */
export async function enhanceDocumentBlocks(
  blocks: QualityBlock[],
  opts?: EnhanceDocumentBlocksOpts
): Promise<{ blocks: QualityBlock[]; stats: EnhanceStats[] }> {
  if (!blocks.length) return { blocks, stats: [] };

  const budgetMs = Math.max(20_000, opts?.budgetMs ?? 150_000);
  const t0 = Date.now();

  const jobs = blocks.map(async (block, idx): Promise<{ block: QualityBlock; stat: EnhanceStats }> => {
    const ext = (block.filename.split('.').pop() ?? '').toLowerCase();
    const blockStart = Date.now() + idx * 700; // stagger start (rate-limit smoothing)
    if (!ENHANCEABLE_EXTS.has(ext)) {
      return {
        block,
        stat: { filename: block.filename, applied: false, reason: 'format skipped', draftChars: block.content.length, finalChars: block.content.length, ms: 0 },
      };
    }
    try {
      // Shared wall-clock budget → every call gets the full remaining window.
      const timeoutMs = budgetMs - (Date.now() - t0);
      if (timeoutMs < 20_000) {
        return {
          block,
          stat: { filename: block.filename, applied: false, reason: 'budget exhausted', draftChars: block.content.length, finalChars: block.content.length, ms: 0 },
        };
      }
      if (idx > 0) await sleep(Math.min(700 * idx, 1_400));
      const enhanced = await enhanceOneBlock(block, ext, {
        userRequest: opts?.userRequest,
        timeoutMs: Math.max(20_000, timeoutMs - Math.min(700 * idx, 1_400)),
        model: opts?.model,
        temperature: opts?.temperature,
      });
      if (enhanced !== null) {
        return {
          block: { ...block, content: enhanced },
          stat: { filename: block.filename, applied: true, draftChars: block.content.length, finalChars: enhanced.length, ms: Date.now() - blockStart },
        };
      }
      return {
        block,
        stat: { filename: block.filename, applied: false, reason: 'gate rejected', draftChars: block.content.length, finalChars: block.content.length, ms: Date.now() - blockStart },
      };
    } catch (e) {
      // Timeout / gateway error — the draft is served, the turn completes.
      console.error('[document-quality] pass failed for', block.filename, e);
      return {
        block,
        stat: { filename: block.filename, applied: false, reason: 'pass error', draftChars: block.content.length, finalChars: block.content.length, ms: Date.now() - blockStart },
      };
    }
  });

  const results = await Promise.all(jobs);
  return {
    blocks: results.map((r) => r.block),
    stats: results.map((r) => r.stat),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Rewrite ONE block. Returns the enhanced markdown, or null when a gate
 *  rejected the reply (caller keeps the draft). Throws on transport errors. */
async function enhanceOneBlock(
  block: QualityBlock,
  ext: string,
  opts: { userRequest?: string; timeoutMs: number; model?: string; temperature?: number }
): Promise<string | null> {
  const { kiloChatCompletion, KILO_REASONING_MODEL_ID } = await import('@/lib/kilo-llm');

  const userRequest = (opts.userRequest ?? '').trim().slice(0, 4_000);
  const draft = block.content.trim().slice(0, 24_000); // cap prompt weight

  const userMessage = [
    `USER REQUEST:${userRequest ? `\n${userRequest}` : '\n(no explicit request text — infer the intent from the draft)'}`,
    ``,
    `TARGET FILE: ${block.filename} (${ext})`,
    ``,
    `DRAFT DOCUMENT (skeleton to rewrite into the final deliverable):`,
    draft,
  ].join('\n');

  const data: any = await kiloChatCompletion({
    model: opts.model ?? KILO_REASONING_MODEL_ID,
    // Thinking stays OFF for the pass: the 55B-active base already writes
    // senior-grade prose, and reliability (staying inside the serverless
    // budget) beats the marginal planning gain of CoT here.
    thinking: false,
    messages: [
      { role: 'system', content: SENIOR_DOCUMENT_WRITER_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: opts.temperature ?? 0.45,
    max_tokens: 12_000,
    timeoutMs: Math.max(20_000, opts.timeoutMs - 3_000),
  });

  let reply = String(data?.choices?.[0]?.message?.content ?? '').trim();
  if (!reply) return null;
  reply = stripLeadingChatter(unwrapFences(reply));

  const gate = validateEnhancedContent(block.content, reply, ext);
  if (!gate.ok) {
    console.log(`[document-quality] gate rejected ${block.filename}: ${gate.reason}`);
    return null;
  }
  return reply;
}
