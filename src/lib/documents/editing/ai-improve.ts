import type { DocumentDoc } from '../core/document-schema';
import { DocumentDocSchema } from '../core/document-schema';
import { documentToMarkdown, markdownToDocument } from '../core/markdown-to-doc';
import { resolveTemplate } from '../templates';

/**
 * AI document editing — natural-language instructions applied to the SDR.
 *
 *   "Rends ce rapport plus professionnel"
 *   "Raccourcis l'introduction"
 *   "Ajoute une section analyse financière"
 *   "Traduis le document en anglais"
 *   "Ajoute une table des matières"
 *
 * The LLM receives the CURRENT document as markdown (with the document
 * grammar) + the instruction and returns the FULL edited document. The
 * reply is re-parsed to blocks and validated — a malformed answer is
 * rejected (the workspace keeps the intact current version).
 *
 * Small edits (text tweaks, renames, table cells) are done client-side on
 * the SDR; this engine is for semantic rewrites only.
 */

const IMPROVE_SYSTEM_PROMPT = `You are Nelth-AI's senior document editor. You receive ONE document in Nelth document markdown and ONE edit instruction from the user. You return the COMPLETE edited document.

RULES:
- Return ONLY the document content — no commentary, no code fences, no explanations before or after.
- Apply the instruction faithfully and surgically: do not rewrite or drop sections the instruction did not mention.
- Keep the document's language UNLESS the instruction asks to change it.
- Keep the Markdown structure: # for the document title, ## for sections, ### for sub-sections, pipe tables with a --- separator row, - bullets, **bold** for key facts.
- Never output placeholders like [Your Name] or "à compléter".
- When asked to make the document more professional/modern, upgrade the WRITING (precise, dense, quantified) — the visual design is handled by the platform, not by you.
- When asked to add a table of contents, insert it right after the title as a bullet list of the section names.
- Tables stay tables, lists stay lists — preserve the data, edit the content.`;

export type ImproveResult = {
  doc: DocumentDoc;
  note: string;
};

/** Run one AI edit on the document. Throws on gateway/parse failure. */
export async function improveDocument(
  doc: DocumentDoc,
  instruction: string,
  opts?: { filename?: string; timeoutMs?: number }
): Promise<ImproveResult> {
  const clean = instruction.trim().slice(0, 2_000);
  if (!clean) throw new Error('Empty instruction');

  const tpl = resolveTemplate(doc.template, doc.docType);
  const md = documentToMarkdown(doc);
  const filename = opts?.filename ?? `${doc.title.toLowerCase().replace(/\s+/g, '-')}.pdf`;

  const { kiloChatCompletion } = await import('@/lib/kilo-llm');
  const data: any = await kiloChatCompletion({
    messages: [
      { role: 'system', content: IMPROVE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `INSTRUCTION: ${clean}\n\n--- DOCUMENT (${doc.language}, template ${tpl.id}) ---\n\n${md}`,
      },
    ],
    temperature: 0.4,
    max_tokens: 32_000,
    timeoutMs: opts?.timeoutMs ?? 120_000,
  });

  let reply = String(data?.choices?.[0]?.message?.content ?? '').trim();
  if (!reply) throw new Error('The model returned an empty edit');
  // Strip an accidental ```document fence wrapper (models sometimes re-fence).
  reply = reply
    .replace(/^```(?:document|markdown|md)?[^\n]*\n/i, '')
    .replace(/\n```[ \t]*$/i, '')
    .trim();
  if (reply.length < 40) throw new Error('The edit was too short to be a document');

  const ext = filename.split('.').pop()?.toLowerCase() ?? 'pdf';
  const updated = markdownToDocument(reply, {
    filename,
    ext: doc.docType === 'presentation' ? 'pptx' : doc.docType === 'spreadsheet' ? 'xlsx' : ext,
    template: doc.template, // keep the chosen template unless asked otherwise
  });

  // Preserve identity: the WORKSPACE title is the source of truth (the user
  // may have renamed after creation — an improve must never revert it) —
  // EXCEPT when the edit itself rewrote the document's H1 (translation, new
  // title): then the edited H1 wins. The chosen template always sticks.
  const oldH1 = doc.blocks.find((b) => b.t === 'heading' && b.level === 1)?.text;
  const newH1 = updated.blocks.find((b) => b.t === 'heading' && b.level === 1)?.text;
  const h1WasRewritten = !!newH1 && newH1 !== oldH1;
  const merged = DocumentDocSchema.parse({
    ...updated,
    title: h1WasRewritten ? updated.title : doc.title,
    language: updated.language || doc.language,
    template: doc.template,
    createdAt: doc.createdAt,
    updatedAt: Math.floor(Date.now() / 1000),
  });

  return { doc: merged, note: clean };
}
