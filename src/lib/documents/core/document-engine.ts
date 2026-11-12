import type { DocumentDoc, DocumentRevision, DocBlock, DocSheet, DocSlide } from './document-schema';
import { DocumentDocSchema } from './document-schema';
import { markdownToDocument, documentToMarkdown, validateDocument } from './markdown-to-doc';
import { resolveTemplate, getTemplate, isTemplateId, TEMPLATES, TEMPLATE_IDS } from '../templates';

/**
 * Document engine — the orchestration entrypoint of the documents module.
 *
 *   markdown ──markdownToDocument──▶ SDR (validated)
 *   SDR ──export manager──▶ PDF / DOCX / XLSX / PPTX / CSV / MD / TXT / HTML bytes
 *   SDR + template ──preview model──▶ paginated preview pages (workspace)
 *   SDR ◀──editing API / AI improve── workspace
 *
 * Persistence rides the File pipeline (file.data.document + file.data.revisions)
 * — see document-store.ts.
 */

export { markdownToDocument, documentToMarkdown, validateDocument };
export { resolveTemplate, getTemplate, isTemplateId, TEMPLATES, TEMPLATE_IDS };

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/** Capped revision history (the workspace undo server-side). */
export const MAX_REVISIONS = 25;

/** Append a revision to the stack (newest last), capped. */
export function createDocumentRevision(
  existing: DocumentRevision[] | null | undefined,
  revision: DocumentRevision
): DocumentRevision[] {
  const stack = Array.isArray(existing) ? [...existing] : [];
  stack.push({ ...revision, at: revision.at || Math.floor(Date.now() / 1000) });
  return stack.slice(-MAX_REVISIONS);
}

// ---------------------------------------------------------------------------
// Doc mutations (the editing API's primitives — small edits NEVER rebuild
// the whole document)
// ---------------------------------------------------------------------------

export type DocumentPatch = {
  title?: string;
  template?: string;
  language?: string;
  blocks?: DocBlock[];
  sheets?: DocSheet[];
  slides?: DocSlide[];
};

/** Apply a patch immutably; returns a NEW validated doc (null when invalid). */
export function applyDocumentPatch(doc: DocumentDoc, patch: DocumentPatch): DocumentDoc | null {
  const next = {
    ...doc,
    ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 300) || doc.title } : {}),
    ...(patch.template !== undefined && isTemplateId(patch.template) ? { template: patch.template } : {}),
    ...(patch.language !== undefined && /^[a-z]{2,8}$/i.test(patch.language) ? { language: patch.language.toLowerCase() } : {}),
    ...(patch.blocks !== undefined ? { blocks: patch.blocks } : {}),
    ...(patch.sheets !== undefined ? { sheets: patch.sheets } : {}),
    ...(patch.slides !== undefined ? { slides: patch.slides } : {}),
    updatedAt: Math.floor(Date.now() / 1000),
  };
  const validated = DocumentDocSchema.safeParse(next);
  return validated.success ? validated.data : null;
}

// ---------------------------------------------------------------------------
// Document summary (API list / SSE envelopes — the preview rides separately)
// ---------------------------------------------------------------------------

export type DocumentSummary = {
  id: string;
  file_id: string;
  title: string;
  docType: string;
  template: string;
  language: string;
  format: string;
  filename: string;
  url: string;
  size: number;
  updated_at: number;
  created_at: number;
  chat_id: string | null;
  message_id: string | null;
  blockCount: number;
  sheetCount: number;
  slideCount: number;
};

/** Human label for a doc type (workspace badge). */
export function docTypeLabel(docType: string): string {
  const labels: Record<string, string> = {
    report: 'Rapport',
    cv: 'CV',
    invoice: 'Facture',
    proposal: 'Proposition',
    letter: 'Lettre',
    presentation: 'Présentation',
    spreadsheet: 'Tableur',
    plan: 'Plan',
    contract: 'Contrat',
    research: 'Étude',
    other: 'Document',
  };
  return labels[docType] ?? 'Document';
}
