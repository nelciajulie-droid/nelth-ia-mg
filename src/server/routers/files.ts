import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { ERROR_MESSAGES } from '@/lib/constants';
import { configGet } from '@/lib/config';
import type { ApiUser } from '@/lib/auth';
import { hasAccessGrant } from '@/lib/access-control';
import { bytesLookLikeText } from '@/lib/retrieval/loaders';
import { deleteChunksForCollection as deleteFileCollectionChunks } from '@/lib/retrieval/embeddings';
import {
  RAG_ERRORS,
  calculateSha256Buffer,
  deleteChunksForFileInCollection,
  fileBytes,
  fileModelResponse,
  getFileById,
  hasAccessToFile,
  indexFile,
  rowToFileModel,
  safeJson,
  stripFileBytes,
  type FileModel,
  type FileRow,
} from '@/lib/retrieval/process';

/**
 * /api/v1/files — port of open_webui/routers/files.py (v0.12.5).
 *
 * Serverless adaptations (documented deviations):
 *   - file bytes are stored base64 in `file.data.content_base64` (no disk);
 *     `file.path` keeps the python-compatible `{id}_{filename}` virtual value.
 *   - uploads process inline (no BackgroundTasks) — the status lifecycle
 *     (pending → processing → completed/failed) is preserved.
 *   - STT transcription for audio uploads is not wired (audio router out of
 *     scope); audio files are processed through the standard text loader.
 *   - `content_base64` is stripped from JSON list/search responses (bytes are
 *     served by GET /{id}/content instead).
 *   - event publishing (publish_event) is not ported.
 */

const PAGE_SIZE = 50;

const BYPASS_ADMIN_ACCESS_CONTROL = (
  process.env.BYPASS_ADMIN_ACCESS_CONTROL ??
  process.env.ENABLE_ADMIN_WORKSPACE_CONTENT_ACCESS ??
  'True'
).toLowerCase() === 'true';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merge fields into the file's `data` JSON column (extracted text, base64…). */
export async function updateFileData(id: string, patch: Record<string, any>): Promise<FileModel | null> {
  const row = (await db.file.findUnique({ where: { id } })) as FileRow | null;
  if (!row) return null;
  const data = safeJson(row.data) ?? {};
  const updated = (await db.file.update({
    where: { id },
    data: { data: JSON.stringify({ ...data, ...patch }), updated_at: Math.floor(Date.now() / 1000) },
  })) as FileRow;
  return rowToFileModel(updated);
}

async function updateFileName(id: string, name: string): Promise<FileModel | null> {
  const row = (await db.file.findUnique({ where: { id } })) as FileRow | null;
  if (!row) return null;
  const meta = safeJson(row.meta) ?? {};
  const updated = (await db.file.update({
    where: { id },
    data: {
      filename: name,
      meta: JSON.stringify({ ...meta, name }),
      updated_at: Math.floor(Date.now() / 1000),
    },
  })) as FileRow;
  return rowToFileModel(updated);
}

async function getKnowledgesByFileId(fileId: string) {
  const kbFiles = await db.knowledgeFile.findMany({ where: { file_id: fileId } });
  if (kbFiles.length === 0) return [];
  return db.knowledge.findMany({ where: { id: { in: kbFiles.map((k) => k.knowledge_id) } } });
}

/** FileModelResponse with the heavy base64 payload stripped. */
function responseFile(file: FileModel, includeContent = true): Record<string, any> {
  const base = fileModelResponse(file);
  const stripped = stripFileBytes(base);
  if (!includeContent && stripped.data && typeof stripped.data === 'object') {
    const data = { ...(stripped.data as Record<string, any>) };
    delete data['content'];
    return { ...stripped, data };
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// Upload pipeline (files.py upload_file_handler + process_uploaded_file)
// ---------------------------------------------------------------------------

export type UploadedFile = {
  bytes: Buffer;
  filename: string;
  contentType: string | null;
};

/** Port of upload_file_handler — used by POST / and /retrieval/process/url. */
export async function uploadFileHandler(
  user: ApiUser,
  file: UploadedFile,
  metadata: Record<string, any>,
  process = true
): Promise<Record<string, any>> {
  const unsanitizedFilename = file.filename ?? 'file';
  const filename = unsanitizedFilename.split(/[\\/]/).pop() ?? unsanitizedFilename;
  const fileExtension = (filename.includes('.') ? filename.split('.').pop() ?? '' : '').toLowerCase();

  if (process) {
    const allowedExtensions = await configGet<string[]>('rag.file.allowed_extensions', []);
    const allowed = (allowedExtensions ?? []).filter((e) => e);
    if (allowed.length > 0 && !allowed.includes(fileExtension)) {
      throw new HttpError(400, `File type ${fileExtension} is not allowed`);
    }
  }

  const id = crypto.randomUUID();
  const name = filename;
  const storedFilename = `${id}_${filename}`;
  const contents = file.bytes;

  const maxSize = await configGet<number | null>('rag.file.max_size', null);
  if (maxSize && contents.length > Number(maxSize) * 1024 * 1024) {
    throw new HttpError(413, RAG_ERRORS.FILE_TOO_LARGE(`${maxSize} MB`));
  }

  const fileHash =
    (typeof metadata['file_hash'] === 'string' && metadata['file_hash']) ||
    calculateSha256Buffer(new Uint8Array(contents));

  const now = Math.floor(Date.now() / 1000);
  const row = (await db.file.create({
    data: {
      id,
      user_id: user.id,
      hash: null,
      filename: name,
      path: storedFilename,
      data: JSON.stringify(process ? { status: 'pending' } : {}),
      meta: JSON.stringify({
        name,
        content_type: file.contentType,
        size: contents.length,
        file_hash: fileHash,
        data: metadata,
      }),
      created_at: now,
      updated_at: now,
    },
  })) as FileRow;
  let fileItem = rowToFileModel(row);

  // keep raw bytes on the row (serverless storage)
  fileItem = (
    await updateFileData(id, { content_base64: contents.toString('base64') })
  ) ?? fileItem;

  if ('channel_id' in metadata && metadata['channel_id']) {
    const channel = await db.channel.findFirst({
      where: { id: String(metadata['channel_id']), user_id: user.id },
    });
    if (channel) {
      await db.channelFile.create({
        data: {
          id: crypto.randomUUID(),
          user_id: user.id,
          channel_id: channel.id,
          file_id: fileItem.id,
          created_at: now,
          updated_at: now,
        },
      });
    }
  }

  if (process) {
    // no BackgroundTasks in the serverless runtime — process inline but keep
    // the status lifecycle; failures mark the file failed without failing the
    // upload response (python background-task parity).
    try {
      await processUploadedFile(user, fileItem, metadata);
    } catch {
      /* status already set to failed */
    }
  }

  return { status: true, ...responseFile(await getFileById(id) ?? fileItem) };
}

/** Port of process_uploaded_file (inline). */
async function processUploadedFile(
  user: ApiUser,
  fileItem: FileModel,
  fileMetadata: Record<string, any>
): Promise<void> {
  try {
    await updateFileData(fileItem.id, { status: 'processing' });
    let contentType = (fileItem.meta?.['content_type'] as string | null) ?? null;
    const bytes = fileBytes(fileItem) ?? Buffer.alloc(0);

    // Detect mis-labeled text files (e.g. .ts → video/mp2t)
    if (contentType && (contentType.startsWith('image/') || contentType.startsWith('video/'))) {
      if (bytes.length > 0 && bytesLookLikeText(new Uint8Array(bytes))) {
        contentType = 'text/plain';
      }
    }

    const sttSupported = await configGet<string[]>('audio.stt.supported_content_types', []);
    /** Audio types to transcribe-and-index (Python honors the configured
     *  STT list; unconfigured, the TS port transcribes every audio/* type
     *  through the built-in engine — see src/lib/audio-zai.ts). */
    const audioIndexable = (ct: string | null): boolean => {
      if (!ct) return false;
      const list = (sttSupported ?? []).filter(Boolean);
      if (list.length) return list.includes(ct);
      return ct.startsWith('audio/');
    };
    const extractionEngine = await configGet<string>('rag.content_extraction_engine', '');
    const supportedMimeTypes = await configGet<string[] | null>(
      'rag.content_extraction.supported_media_mime_types',
      null
    );

    const mediaSupportedForExtraction = (() => {
      if (supportedMimeTypes === null || supportedMimeTypes === undefined) {
        return extractionEngine === 'external';
      }
      const list = Array.isArray(supportedMimeTypes)
        ? supportedMimeTypes
        : String(supportedMimeTypes).split(',').map((s) => s.trim());
      const supported = list.filter(Boolean);
      if (supported.length === 0) return false;
      return Boolean(extractionEngine) && supported.includes(contentType ?? '');
    })();

    if (audioIndexable(contentType)) {
      // STT-supported audio → transcribe with the built-in engine, then index
      // the transcript (Python: transcribes then indexes when the type is
      // STT-supported; failures mark the file failed without failing the
      // upload response).
      const { sttZaiTranscribe } = await import('@/lib/audio-zai');
      const transcript = await sttZaiTranscribe({ bytes });
      if (transcript.trim()) {
        await indexFile(user, { file_id: fileItem.id, content: transcript });
      }
    } else if (
      contentType &&
      (contentType.startsWith('image/') || contentType.startsWith('video/')) &&
      !mediaSupportedForExtraction
    ) {
      if (contentType.startsWith('video/')) {
        // videos stored as-is for downstream multimodal processing
      } else {
        throw new Error(`File type ${contentType} is not supported for processing`);
      }
    } else {
      await indexFile(user, { file_id: fileItem.id });
    }

    // Auto-link to knowledge collection when uploaded from one (#24807)
    const knowledgeId = fileMetadata['knowledge_id'];
    if (knowledgeId) {
      const knowledge = await db.knowledge.findUnique({ where: { id: String(knowledgeId) } });
      const canWrite =
        Boolean(knowledge) &&
        (knowledge!.user_id === user.id ||
          user.role === 'admin' ||
          (await hasAccessGrant(user.id, 'knowledge', knowledge!.id, 'write')));
      if (!canWrite) {
        throw new Error(
          `Refusing to auto-link file ${fileItem.id} to knowledge ${knowledgeId}: user ${user.id} lacks write access`
        );
      }
      let directoryId: string | null = fileMetadata['directory_id'] ?? null;
      if (directoryId) {
        const directory = await db.knowledgeDirectory.findUnique({ where: { id: directoryId } });
        if (!directory || directory.knowledge_id !== knowledgeId) directoryId = null;
      }
      await indexFile(user, { file_id: fileItem.id, collection_name: String(knowledgeId) });
      const now = Math.floor(Date.now() / 1000);
      const existing = await db.knowledgeFile.findFirst({
        where: { knowledge_id: String(knowledgeId), file_id: fileItem.id },
      });
      if (!existing) {
        await db.knowledgeFile.create({
          data: {
            id: crypto.randomUUID(),
            knowledge_id: String(knowledgeId),
            file_id: fileItem.id,
            directory_id: directoryId ?? null,
            user_id: user.id,
            created_at: now,
            updated_at: now,
          },
        });
      }
    }

    await updateFileData(fileItem.id, { status: 'completed', error: null });
  } catch (e) {
    const message = e instanceof HttpError ? e.detail : e instanceof Error ? e.message : String(e);
    await updateFileData(fileItem.id, { status: 'failed', error: message });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ---- Upload File ----
  {
    method: 'POST',
    path: '',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const form = await ctx.req.formData().catch(() => null);
      if (!form) return ctx.error(400, 'Error uploading file');
      const fileField = form.get('file');
      if (!(fileField instanceof File)) {
        return ctx.error(400, 'Error uploading file');
      }
      let metadata: Record<string, any> = {};
      const metadataField = form.get('metadata');
      if (typeof metadataField === 'string' && metadataField) {
        try {
          metadata = JSON.parse(metadataField);
        } catch {
          return ctx.error(400, 'Invalid metadata format');
        }
      }
      const processParam = ctx.query.get('process');
      const process = processParam === null ? true : processParam !== 'false';
      // process_in_background is accepted for compatibility; processing is
      // always inline in the serverless runtime.
      const bytes = Buffer.from(await fileField.arrayBuffer());
      const user = ctx.user!;
      const result = await uploadFileHandler(
        user,
        { bytes, filename: fileField.name, contentType: fileField.type || null },
        metadata,
        process
      );
      return ctx.json(result);
    },
  },

  // ---- List Files ----
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const page = Math.max(parseInt(ctx.query.get('page') ?? '1', 10) || 1, 1);
      const content = (ctx.query.get('content') ?? 'true') !== 'false';
      const skip = (page - 1) * PAGE_SIZE;
      const user = ctx.user!;
      const userId =
        user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL ? null : user.id;

      const where = userId ? { user_id: userId } : undefined;
      const total = await db.file.count({ where: { ...(userId ? { user_id: userId } : {}) } });
      const rows = (await db.file.findMany({
        where,
        orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
        skip,
        take: PAGE_SIZE,
      })) as FileRow[];
      return ctx.json({
        items: rows.map((r) => responseFile(rowToFileModel(r), content)),
        total,
      });
    },
  },

  // ---- Search Files ----
  {
    method: 'GET',
    path: 'search',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const filename = ctx.query.get('filename');
      if (!filename) return ctx.error(422, 'Filename is required');
      return searchFiles(ctx, filename, true);
    },
  },
  {
    method: 'GET',
    path: 'user/search',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const filename = ctx.query.get('filename') ?? '*';
      return searchFiles(ctx, filename, false);
    },
  },

  // ---- Count Files ----
  {
    method: 'GET',
    path: 'count',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const user = ctx.user!;
      const userId =
        user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL ? null : user.id;
      return ctx.json(await db.file.count(userId ? { where: { user_id: userId } } : undefined));
    },
  },
  {
    method: 'GET',
    path: 'user/count',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      return ctx.json(await db.file.count({ where: { user_id: ctx.user!.id } }));
    },
  },

  // ---- Delete All Files (admin) ----
  {
    method: 'DELETE',
    path: 'all',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const result = await db.file.deleteMany({});
      try {
        await db.chunk.deleteMany({});
        await db.channelFile.deleteMany({});
        await db.chatFile.deleteMany({});
      } catch (e) {
        console.error('Error deleting files', e);
        return ctx.error(400, 'Error deleting files');
      }
      if (result) {
        return ctx.json({ message: 'All files deleted successfully' });
      }
      return ctx.error(400, 'Error deleting files');
    },
  },

  // ---- Get File By Id ----
  {
    method: 'GET',
    path: ':id',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const file = await getFileById(ctx.params.id);
      if (!file) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      const user = ctx.user!;
      if (file.user_id === user.id || user.role === 'admin' || (await hasAccessToFile(file.id, 'read', user))) {
        // FileModel dump (includes path); base64 payload stripped
        return ctx.json(stripFileBytes(file as any));
      }
      return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // ---- File process status ----
  {
    method: 'GET',
    path: ':id/process/status',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const file = await getFileById(id);
      if (!file) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      const user = ctx.user!;
      if (!(file.user_id === user.id || user.role === 'admin' || (await hasAccessToFile(id, 'read', user)))) {
        return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      }
      const stream = (ctx.query.get('stream') ?? 'false') === 'true';
      if (!stream) {
        return ctx.json({ status: file.data?.['status'] ?? 'pending' });
      }
      // SSE stream (serverless-capped at 10 minutes)
      const MAX_ITERATIONS = 600;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < MAX_ITERATIONS; i++) {
            const item = await getFileById(id);
            if (item) {
              const status = item.data?.['status'];
              if (status) {
                const event: Record<string, any> = { status };
                if (status === 'failed') event['error'] = item.data?.['error'] ?? null;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                if (status === 'completed' || status === 'failed') break;
              } else {
                break; // legacy
              }
            } else {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: 'not_found' })}\n\n`));
              break;
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
          controller.close();
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      });
    },
  },

  // ---- Get File Data Content ----
  {
    method: 'GET',
    path: ':id/data/content',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const file = await getFileById(ctx.params.id);
      if (!file) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      const user = ctx.user!;
      if (file.user_id === user.id || user.role === 'admin' || (await hasAccessToFile(file.id, 'read', user))) {
        return ctx.json({ content: (file.data?.['content'] as string) ?? '' });
      }
      return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // ---- Update File Data Content ----
  {
    method: 'POST',
    path: ':id/data/content/update',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const form = await ctx.body<{ content?: string }>();
      const file = await getFileById(id);
      if (!file) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      const user = ctx.user!;
      if (!(file.user_id === user.id || user.role === 'admin' || (await hasAccessToFile(id, 'write', user)))) {
        return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      }
      const content = (form?.content ?? '').trim();
      if (!content) return ctx.error(400, RAG_ERRORS.EMPTY_CONTENT);

      const maxSize = await configGet<number | null>('rag.file.max_size', null);
      if (maxSize && Buffer.byteLength(form?.content ?? '', 'utf-8') > Number(maxSize) * 1024 * 1024) {
        return ctx.error(413, RAG_ERRORS.FILE_TOO_LARGE(`${maxSize} MB`));
      }

      try {
        await indexFile(user, { file_id: id, content: form?.content ?? '' });
      } catch (e) {
        console.error(`Error processing file: ${id}`, e);
        return ctx.error(500, 'Failed to process indexed text. Your changes were not fully indexed.');
      }

      // Propagate the content change to all knowledge collections referencing
      // this file (#20558): capture old vectors, re-add from file-{id}, delete old.
      const knowledges = await getKnowledgesByFileId(id);
      const failedCollections: string[] = [];
      for (const knowledge of knowledges) {
        try {
          const oldRows = await db.chunk.findMany({
            where: { collection_name: knowledge.id, file_id: id },
            select: { id: true },
          });
          await indexFile(user, { file_id: id, collection_name: knowledge.id });
          if (oldRows.length > 0) {
            await db.chunk.deleteMany({ where: { id: { in: oldRows.map((r) => r.id) } } });
          }
        } catch (e) {
          console.warn(`Failed to update knowledge ${knowledge.id} after content change for file ${id}: ${e}`);
          failedCollections.push(knowledge.id);
        }
      }

      if (failedCollections.length > 0) {
        return ctx.error(
          500,
          'Indexed text was saved, but some knowledge collections could not be reindexed. Retry saving to complete indexing.'
        );
      }
      const updated = await getFileById(id);
      return ctx.json({ content: (updated?.data?.['content'] as string) ?? '' });
    },
  },

  // ---- Get File Content (bytes) ----
  {
    method: 'GET',
    path: ':id/content',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const file = await getFileById(ctx.params.id);
      if (!file) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      const user = ctx.user!;
      if (!(file.user_id === user.id || user.role === 'admin' || (await hasAccessToFile(file.id, 'read', user)))) {
        return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      }
      const bytes = fileBytes(file);
      if (!bytes) {
        if (!file.path) return ctx.error(404, 'Original file is unavailable.');
        return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      }
      const attachment = (ctx.query.get('attachment') ?? 'false') === 'true';
      let contentType = (file.meta?.['content_type'] as string | null) ?? null;
      const filename = (file.meta?.['name'] as string) ?? file.filename ?? 'file';
      const encoded = encodeURIComponent(filename);
      let disposition: string;
      if (attachment) {
        disposition = `attachment; filename*=UTF-8''${encoded}`;
      } else if (contentType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
        disposition = `inline; filename*=UTF-8''${encoded}`;
        contentType = 'application/pdf';
      } else if (contentType !== 'text/plain') {
        disposition = `attachment; filename*=UTF-8''${encoded}`;
      } else {
        disposition = `inline; filename*=UTF-8''${encoded}`;
      }
      return new Response(new Uint8Array(bytes), {
        headers: {
          'content-type': contentType ?? 'application/octet-stream',
          'content-disposition': disposition,
        },
      });
    },
  },

  // ---- Get HTML file content ----
  // PUBLIC-APP MODE: any member's HTML artifacts are served (read-gated).
  // There is no admin role anymore, so the former admin-owner restriction
  // would leave this feature dead for every account.
  {
    method: 'GET',
    path: ':id/content/html',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const file = await getFileById(ctx.params.id);
      if (!file) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      const user = ctx.user!;
      if (!(file.user_id === user.id || user.role === 'admin' || (await hasAccessToFile(file.id, 'read', user)))) {
        return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      }
      const bytes = fileBytes(file);
      if (!bytes) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      const contentType = (file.meta?.['content_type'] as string | null) ?? 'text/html';
      return new Response(new Uint8Array(bytes), {
        headers: { 'content-type': contentType },
      });
    },
  },

  // ---- Get File Content by name (download; .txt fallback) ----
  {
    method: 'GET',
    path: ':id/content/:file_name',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const file = await getFileById(ctx.params.id);
      if (!file) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      const user = ctx.user!;
      if (!(file.user_id === user.id || user.role === 'admin' || (await hasAccessToFile(file.id, 'read', user)))) {
        return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      }
      const filename = (file.meta?.['name'] as string) ?? file.filename ?? 'file';
      const encoded = encodeURIComponent(filename);
      const disposition = `attachment; filename*=UTF-8''${encoded}`;
      const bytes = fileBytes(file);
      if (bytes) {
        return new Response(new Uint8Array(bytes), {
          headers: { 'content-disposition': disposition },
        });
      }
      // Legacy fallback: preserve indexed text as the download
      const fileContent = (file.data?.['content'] as string) ?? '';
      return new Response(fileContent, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': disposition,
        },
      });
    },
  },

  // ---- Rename File ----
  {
    method: 'POST',
    path: ':id/rename',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const form = await ctx.body<{ filename?: string }>();
      const file = await getFileById(id);
      if (!file) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      const user = ctx.user!;
      if (!(file.user_id === user.id || user.role === 'admin' || (await hasAccessToFile(id, 'write', user)))) {
        return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      }
      const filename = form?.filename;
      if (!filename) return ctx.error(422, 'Filename is required');
      const result = await updateFileName(id, filename);
      if (result) {
        return ctx.json(responseFile(result));
      }
      return ctx.error(400, 'Error renaming file');
    },
  },

  // ---- Delete File ----
  {
    method: 'DELETE',
    path: ':id',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const file = await getFileById(id);
      if (!file) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      const user = ctx.user!;
      if (!(file.user_id === user.id || user.role === 'admin' || (await hasAccessToFile(id, 'write', user)))) {
        return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      }

      // Clean up KB associations and embeddings before deleting
      const knowledges = await getKnowledgesByFileId(id);
      for (const knowledge of knowledges) {
        await db.knowledgeFile.deleteMany({ where: { knowledge_id: knowledge.id, file_id: id } });
        try {
          await deleteChunksForFileInCollection(knowledge.id, id);
        } catch (e) {
          console.debug(`KB embedding cleanup for ${knowledge.id}: ${e}`);
        }
      }

      try {
        await db.file.delete({ where: { id } });
        await deleteFileCollectionChunks(`file-${id}`);
      } catch (e) {
        console.error('Error deleting files', e);
        return ctx.error(400, 'Error deleting files');
      }
      return ctx.json({ message: 'File deleted successfully' });
    },
  },
];

// ---------------------------------------------------------------------------
// Shared search implementation (files.py _search_files)
// ---------------------------------------------------------------------------

async function searchFiles(ctx: Ctx, filename: string, adminBypass: boolean): Promise<Response> {
  const content = (ctx.query.get('content') ?? 'true') !== 'false';
  const skip = Math.max(parseInt(ctx.query.get('skip') ?? '0', 10) || 0, 0);
  const limit = Math.min(Math.max(parseInt(ctx.query.get('limit') ?? '100', 10) || 100, 1), 1000);
  const user = ctx.user!;
  const userId = adminBypass
    ? user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL
      ? null
      : user.id
    : user.id;

  // glob pattern match (files.py _glob_to_like_pattern): SQLite LIKE
  // wildcards are applied in JS (Prisma `contains` has no glob support).
  let regex: RegExp | null = null;
  if (filename !== '*' && filename !== '') {
    const escaped = filename.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    regex = new RegExp(`^${escaped}$`, 'i');
  }

  const allRows = (await db.file.findMany({
    where: userId ? { user_id: userId } : {},
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
  })) as FileRow[];
  const rows = (regex ? allRows.filter((r) => regex!.test(r.filename ?? '')) : allRows).slice(
    skip,
    skip + limit
  );

  const userRoute = ctx.path === 'user/search';
  if (rows.length === 0 && !userRoute) {
    return ctx.error(404, 'No files found matching the pattern.');
  }
  return ctx.json(rows.map((r) => responseFile(rowToFileModel(r), content)));
}
