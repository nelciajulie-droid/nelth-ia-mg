import type { Route, Ctx } from '../http';
import { db } from '@/lib/db';
import type { FileRow } from '@/lib/retrieval/process';
import {
  getDocumentRow,
  listDocumentRows,
  documentFromRow,
  summarizeDocumentRow,
  saveDocument,
  renameDocumentFile,
} from '@/lib/documents/core/document-store';
import { createDocumentRevision, applyDocumentPatch, docTypeLabel } from '@/lib/documents/core/document-engine';
import { validateDocument } from '@/lib/documents/core/markdown-to-doc';
import { TEMPLATES } from '@/lib/documents/templates';
import { exportDocument, isExportFormat, EXPORT_FORMATS, exportFilename } from '@/lib/documents/export/export-manager';
import { improveDocument } from '@/lib/documents/editing/ai-improve';
import { deleteChunksForCollection as deleteFileCollectionChunks } from '@/lib/retrieval/embeddings';

/**
 * /api/v1/documents — the premium document-generation API.
 *
 * A document IS a file row (data.document = SDR) produced by the chat
 * pipeline (```document blocks). This router adds the workspace surface:
 *
 *   GET    /                      list the user's documents (?chat_id=)
 *   GET    /templates             template catalog (picker)
 *   GET    /:id                   full document (SDR + revisions + summary)
 *   PATCH  /:id                   edits: title / template / blocks / sheets / slides
 *   POST   /:id/improve           AI edit from a natural-language instruction
 *   GET    /:id/export?format=    real file bytes (pdf docx xlsx pptx csv md txt html)
 *   DELETE /:id                   delete the document (file cascade)
 */

const MAX_BODY_CHARS = 1_500_000; // ~1.5MB of JSON payload ceiling

async function ownedRow(ctx: Ctx): Promise<FileRow | null> {
  const row = await getDocumentRow(ctx.params.id);
  if (!row) return null;
  const user = ctx.user!;
  if (row.user_id !== user.id && user.role !== 'admin') return null;
  return row;
}

function notFound(ctx: Ctx): Response {
  return ctx.error(404, 'Document not found');
}

export const routes: Route[] = [
  // ---- List documents ----
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const chatId = ctx.query.get('chat_id');
      const limitRaw = parseInt(ctx.query.get('limit') ?? '60', 10) || 60;
      const rows = await listDocumentRows(ctx.user!.id, {
        chatId: chatId || null,
        limit: Math.min(Math.max(limitRaw, 1), 200),
      });
      const items = rows
        .map((row) => summarizeDocumentRow(row))
        .filter((s): s is NonNullable<typeof s> => !!s)
        .map((s) => ({ ...s, typeLabel: docTypeLabel(s.docType) }));
      return ctx.json({ items, total: items.length });
    },
  },

  // ---- Template catalog ----
  {
    method: 'GET',
    path: 'templates',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      return ctx.json({
        templates: TEMPLATES.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          layout: t.layout,
          family: t.typography.family,
          bestFor: t.bestFor,
          palette: t.palette,
        })),
        formats: EXPORT_FORMATS,
      });
    },
  },

  // ---- Document detail ----
  {
    method: 'GET',
    path: ':id',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const row = await ownedRow(ctx);
      if (!row) return notFound(ctx);
      const parsed = documentFromRow(row);
      if (!parsed) return notFound(ctx);
      const summary = summarizeDocumentRow(row);
      // Revisions newest-first, capped payload (content excluded).
      const revisions = [...parsed.revisions].reverse().slice(0, 25).map((rev, idx) => ({
        seq: parsed.revisions.length - idx,
        at: rev.at,
        by: rev.by,
        note: rev.note ?? null,
        title: rev.title ?? null,
      }));
      return ctx.json({
        ...summary,
        typeLabel: docTypeLabel(summary!.docType),
        document: parsed.doc,
        revisions,
        exportFormats: EXPORT_FORMATS,
      });
    },
  },

  // ---- Update document (workspace autosave / edits) ----
  {
    method: 'PATCH',
    path: ':id',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const row = await ownedRow(ctx);
      if (!row) return notFound(ctx);
      const parsed = documentFromRow(row);
      if (!parsed) return notFound(ctx);
      const raw = await ctx.req.text();
      if (raw.length > MAX_BODY_CHARS) return ctx.error(413, 'Payload too large');
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return ctx.error(400, 'Invalid JSON body');
      }

      // Full SDR update (blocks/sheets/slides edits) or field patches.
      let nextDoc = parsed.doc;
      if (body?.document && typeof body.document === 'object') {
        const validated = validateDocument({
          ...parsed.doc,
          ...body.document,
          v: 1,
          createdAt: parsed.doc.createdAt,
          updatedAt: Math.floor(Date.now() / 1000),
        });
        if (!validated) return ctx.error(422, 'Invalid document payload');
        nextDoc = validated;
      }
      const patched = applyDocumentPatch(nextDoc, {
        title: typeof body?.title === 'string' ? body.title : undefined,
        template: typeof body?.template === 'string' ? body.template : undefined,
        language: typeof body?.language === 'string' ? body.language : undefined,
      });
      if (!patched) return ctx.error(422, 'Invalid document patch');
      nextDoc = patched;

      const revision = createDocumentRevision(parsed.revisions, {
        by: 'human',
        note: typeof body?.note === 'string' ? body.note.slice(0, 200) : undefined,
        title: nextDoc.title,
        blocks: nextDoc.blocks,
        sheets: nextDoc.sheets,
        slides: nextDoc.slides,
      });
      const ok = await saveDocument(row.id, nextDoc, revision);
      if (!ok) return ctx.error(500, 'Failed to save the document');

      // Title rename → keep the file card name in sync (same extension).
      if (typeof body?.rename_file === 'boolean' ? body.rename_file : true) {
        if (nextDoc.title !== parsed.doc.title) {
          const ext = (row.filename ?? 'document.pdf').split('.').pop() ?? 'pdf';
          await renameDocumentFile(row.id, `${nextDoc.title}.${ext}`);
        }
      }

      const fresh = await getDocumentRow(row.id);
      const summary = fresh ? summarizeDocumentRow(fresh) : null;
      return ctx.json({
        ...summary,
        typeLabel: summary ? docTypeLabel(summary.docType) : null,
        document: nextDoc,
        saved_at: nextDoc.updatedAt,
      });
    },
  },

  // ---- AI improve ----
  {
    method: 'POST',
    path: ':id/improve',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const row = await ownedRow(ctx);
      if (!row) return notFound(ctx);
      const parsed = documentFromRow(row);
      if (!parsed) return notFound(ctx);
      const body = await ctx.body<{ instruction?: string }>().catch(() => null);
      const instruction = typeof body?.instruction === 'string' ? body.instruction : '';
      if (!instruction.trim()) return ctx.error(422, 'An instruction is required');

      let result;
      try {
        result = await improveDocument(parsed.doc, instruction, {
          filename: row.filename ?? undefined,
        });
      } catch (e) {
        console.error('[documents] improve failed', e);
        return ctx.error(502, e instanceof Error ? e.message : 'The edit failed');
      }

      const revision = createDocumentRevision(parsed.revisions, {
        by: 'ai',
        note: instruction.slice(0, 200),
        title: result.doc.title,
        blocks: result.doc.blocks,
        sheets: result.doc.sheets,
        slides: result.doc.slides,
      });
      await saveDocument(row.id, result.doc, revision);

      const fresh = await getDocumentRow(row.id);
      const summary = fresh ? summarizeDocumentRow(fresh) : null;
      return ctx.json({
        ...summary,
        typeLabel: summary ? docTypeLabel(summary.docType) : null,
        document: result.doc,
        note: `Modifié : ${result.note}`,
      });
    },
  },

  // ---- Export (real file bytes) ----
  {
    method: 'GET',
    path: ':id/export',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const row = await ownedRow(ctx);
      if (!row) return notFound(ctx);
      const parsed = documentFromRow(row);
      if (!parsed) return notFound(ctx);
      const format = (ctx.query.get('format') ?? '').toLowerCase();
      if (!isExportFormat(format)) {
        return ctx.error(422, `Unsupported format — use one of: ${EXPORT_FORMATS.join(', ')}`);
      }
      try {
        const download = ctx.query.get('download') !== 'false';
        const result = await exportDocument(parsed.doc, format, {
          filename: exportFilename(parsed.doc, format),
        });
        const headers: Record<string, string> = {
          'content-type': result.contentType,
          'cache-control': 'no-store',
        };
        if (download) {
          const encoded = encodeURIComponent(result.filename);
          headers['content-disposition'] = `attachment; filename="${result.filename.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encoded}`;
        }
        return new Response(new Uint8Array(result.bytes), { headers });
      } catch (e) {
        console.error('[documents] export failed', e);
        return ctx.error(500, e instanceof Error ? e.message : 'Export failed');
      }
    },
  },

  // ---- Delete ----
  {
    method: 'DELETE',
    path: ':id',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const row = await ownedRow(ctx);
      if (!row) return notFound(ctx);
      try {
        await db.file.delete({ where: { id: row.id } });
        await deleteFileCollectionChunks(`file-${row.id}`);
      } catch (e) {
        console.error('[documents] delete failed', e);
        return ctx.error(400, 'Error deleting document');
      }
      return ctx.json({ message: 'Document deleted successfully' });
    },
  },
];
