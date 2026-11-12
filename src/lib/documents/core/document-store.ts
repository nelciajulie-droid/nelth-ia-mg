import { db } from '@/lib/db';
import type { FileRow } from '@/lib/retrieval/process';
import type { DocumentDoc, DocumentRevision, DocumentSummary } from './document-engine';
import { validateDocument } from './markdown-to-doc';

/**
 * Document store — documents ride the EXISTING File pipeline:
 *
 *   file.data.document  → SDR (validated DocumentDoc JSON)
 *   file.data.revisions → capped revision stack
 *   file.meta.data      → { source: 'document_generation', chat_id, message_id, … }
 *   file bytes          → served by GET /api/v1/files/{id}/content
 *
 * ZERO new tables: production Postgres and sandbox SQLite stay untouched,
 * the file lifecycle (ownership, deletion, downloads) is reused as-is, and
 * a document IS a file row for the native SPA file cards.
 */

const DOC_MARKER = 'document_generation';

function safeJson(raw: string | null | undefined): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Is this file row a generated document? */
export function isDocumentFileRow(row: FileRow): boolean {
  const meta = safeJson(row.meta) ?? {};
  return meta?.data?.source === DOC_MARKER || meta?.source === DOC_MARKER;
}

/** Read the SDR + revisions off a file row. */
export function documentFromRow(row: FileRow): { doc: DocumentDoc; revisions: DocumentRevision[] } | null {
  const data = safeJson(row.data) ?? {};
  const doc = validateDocument(data?.document);
  if (!doc) return null;
  const revisions = Array.isArray(data?.revisions) ? (data.revisions as DocumentRevision[]) : [];
  return { doc, revisions };
}

/** Build the API summary of a document file row. */
export function summarizeDocumentRow(row: FileRow): DocumentSummary | null {
  const parsed = documentFromRow(row);
  if (!parsed) return null;
  const { doc } = parsed;
  const meta = safeJson(row.meta) ?? {};
  const m = meta?.data ?? {};
  const name = meta?.name ?? row.filename ?? 'document';
  const format = (name.split('.').pop() ?? '').toLowerCase();
  const size = typeof meta?.size === 'number' ? meta.size : 0;
  return {
    id: row.id,
    file_id: row.id,
    title: doc.title,
    docType: doc.docType,
    template: doc.template,
    language: doc.language,
    format,
    filename: name,
    url: `/api/v1/files/${row.id}/content`,
    size,
    updated_at: row.updated_at ?? Math.floor(Date.now() / 1000),
    created_at: row.created_at ?? Math.floor(Date.now() / 1000),
    chat_id: typeof m.chat_id === 'string' ? m.chat_id : null,
    message_id: typeof m.message_id === 'string' ? m.message_id : null,
    blockCount: doc.blocks.length,
    sheetCount: doc.sheets?.length ?? 0,
    slideCount: doc.slides?.length ?? 0,
  };
}

/** Fetch one document file row (ownership checked by the caller). */
export async function getDocumentRow(id: string): Promise<FileRow | null> {
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(id)) return null;
  const row = (await db.file.findUnique({ where: { id } })) as FileRow | null;
  if (!row || !isDocumentFileRow(row)) return null;
  return row;
}

/** List the user's generated documents (newest first), optionally by chat.
 *
 *  The file table cannot filter JSON in SQLite — rows are scanned with a JS
 *  filter. Bounded scan (latest 400 rows per user) keeps this fast. */
export async function listDocumentRows(
  userId: string,
  opts?: { chatId?: string | null; limit?: number }
): Promise<FileRow[]> {
  const rows = (await db.file.findMany({
    where: { user_id: userId },
    orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
    take: 400,
  })) as FileRow[];
  const docs = rows.filter(isDocumentFileRow);
  if (opts?.chatId) {
    return docs.filter((row) => {
      const meta = safeJson(row.meta) ?? {};
      return meta?.data?.chat_id === opts.chatId;
    });
  }
  const limit = opts?.limit ?? 100;
  return docs.slice(0, limit);
}

/** Persist an updated SDR + revision onto the row (PATCH / improve). */
export async function saveDocument(
  id: string,
  doc: DocumentDoc,
  revisions: DocumentRevision[]
): Promise<boolean> {
  const row = (await db.file.findUnique({ where: { id } })) as FileRow | null;
  if (!row) return false;
  const data = safeJson(row.data) ?? {};
  const merged = {
    ...data,
    document: doc,
    revisions,
  };
  const now = Math.floor(Date.now() / 1000);
  await db.file.update({
    where: { id },
    data: { data: JSON.stringify(merged), updated_at: now },
  });
  return true;
}

/** Update the document's display filename (rename). */
export async function renameDocumentFile(id: string, name: string): Promise<boolean> {
  const row = (await db.file.findUnique({ where: { id } })) as FileRow | null;
  if (!row) return false;
  const meta = safeJson(row.meta) ?? {};
  const safeName = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  if (!safeName) return false;
  await db.file.update({
    where: { id },
    data: {
      filename: safeName,
      meta: JSON.stringify({ ...meta, name: safeName }),
      updated_at: Math.floor(Date.now() / 1000),
    },
  });
  return true;
}
