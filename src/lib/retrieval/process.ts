/**
 * RAG processing pipeline — port of open_webui/routers/retrieval.py
 * (save_docs_to_vector_db / index_file / process_file / query_doc /
 * query_collection) plus the shared access-control helpers used by the
 * files / knowledge / retrieval routers.
 *
 * Serverless adaptations (documented deviations):
 *   - file bytes live base64-encoded in `file.data.content_base64` (there is
 *     no writable disk); `file.path` keeps the python-compatible virtual
 *     `{id}_{filename}` value.
 *   - the vector store is the Prisma `chunk` table (@/lib/retrieval/embeddings)
 *     instead of ChromaDB.
 *   - hybrid search / reranking are config-parity only (no local reranker
 *     models in the serverless runtime).
 */

import crypto from 'crypto';
import { db } from '@/lib/db';
import { env, ERROR_MESSAGES } from '@/lib/constants';
import { configGet } from '@/lib/config';
import { hasAccessGrant, getUserGroupIds } from '@/lib/access-control';
import type { ApiUser } from '@/lib/auth';
import { HttpError } from '@/server/http';
import {
  generateEmbeddings,
  storeChunks,
  queryChunks,
  deleteChunksForCollection,
} from './embeddings';
import { loadDocuments } from './loaders';
import { splitDocuments, mergeDocsToTargetSize } from './chunking';
import type { ChunkDocument } from './chunking';

export type { ChunkDocument };

// Python constants.py messages not present in the shared ERROR_MESSAGES subset.
export const RAG_ERRORS = {
  EMPTY_CONTENT:
    'The content provided is empty. Please ensure that there is text or data present before proceeding.',
  DUPLICATE_CONTENT: 'Duplicate content detected. Please provide unique content to proceed.',
  FILE_NOT_PROCESSED:
    'Extracted content is not available for this file. Please ensure that the file is processed before proceeding.',
  FILE_TOO_LARGE: (size = '') =>
    `Oops! The file you're trying to upload is too large. Please upload a file that is less than ${size}.`,
} as const;

// ---------------------------------------------------------------------------
// Misc helpers (utils/misc.py parity)
// ---------------------------------------------------------------------------

export function calculateSha256String(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

export function calculateSha256Buffer(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Port of sanitize_text_for_db: strip null bytes + UTF-16 surrogates. */
export function sanitizeTextForDb(text: string): string {
  if (typeof text !== 'string') return text;
  if (!text.includes('\x00') && !/[\uD800-\uDFFF]/.test(text)) return text;
  return text.replace(/\x00/g, '').replace(/[\uD800-\uDFFF]/g, '');
}

export function safeJson<T = Record<string, any>>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// RAG config (defaults mirror open_webui/config.py)
// ---------------------------------------------------------------------------

export const DEFAULT_RAG_TEMPLATE = `### Task:
Respond to the user query using the provided context, incorporating inline citations in the format [id] **only when the <source> tag includes an explicit id attribute** (e.g., <source id="1">).

### Guidelines:
- If you don't know the answer, clearly state that.
- If uncertain, ask the user for clarification.
- Respond in the same language as the user's query.
- If the context is unreadable or of poor quality, inform the user and provide the best possible answer.
- If the answer isn't present in the context but you possess the knowledge, explain this to the user and provide the answer using your own understanding.
- **Only include inline citations using [id] (e.g., [1], [2]) when the <source> tag includes an id attribute.**
- Do not cite if the <source> tag does not contain an id attribute.
- Do not use XML tags in your response.
- Ensure citations are concise and directly related to the information provided.

### Example of Citation:
If the user asks about a specific topic and the information is found in a source with a provided id attribute, the response should include the citation like in the following example:
* "According to the study, the proposed method increases efficiency by 20% [1]."

### Output:
Provide a clear and direct response to the user's query, including inline citations in the format [id] only when the <source> tag with id attribute is present in the context.

<context>
{{CONTEXT}}
</context>
`;

export const RAG_CONFIG_DEFAULTS: Record<string, unknown> = {
  // chunking
  'rag.text_splitter': env.RAG_TEXT_SPLITTER,
  'rag.tokenizer_model': '',
  'rag.tiktoken_encoding_name': 'cl100k_base',
  'rag.enable_markdown_header_text_splitter': true,
  'rag.chunk_size': 1000,
  'rag.chunk_min_size_target': 0,
  'rag.chunk_overlap': 100,
  // retrieval
  'rag.top_k': 3,
  'rag.top_k_reranker': 3,
  'rag.relevance_threshold': 0.0,
  'rag.hybrid_bm25_weight': 0.5,
  'rag.enable_hybrid_search': false,
  'rag.enable_hybrid_search_enriched_texts': false,
  'rag.full_context': false,
  'rag.bypass_embedding_and_retrieval': false,
  'rag.template': DEFAULT_RAG_TEMPLATE,
  // embeddings
  'rag.embedding_engine': env.RAG_EMBEDDING_ENGINE,
  'rag.embedding_model': env.RAG_EMBEDDING_MODEL,
  'rag.embedding_batch_size': 1,
  'rag.embedding_query_prefix': null,
  'rag.embedding_content_prefix': null,
  'rag.enable_async_embedding': true,
  'rag.embedding_concurrent_requests': 0,
  'rag.openai.api_base_url': env.RAG_OPENAI_API_BASE_URL || env.OPENAI_API_BASE_URL,
  'rag.openai.api_key': process.env.RAG_OPENAI_API_KEY || env.OPENAI_API_KEY || '',
  'rag.ollama.base_url': env.OLLAMA_API_BASE_URL,
  'rag.ollama.api_key': process.env.RAG_OLLAMA_API_KEY || '',
  'rag.azure_openai.base_url': process.env.RAG_AZURE_OPENAI_BASE_URL || '',
  'rag.azure_openai.api_key': process.env.RAG_AZURE_OPENAI_API_KEY || '',
  'rag.azure_openai.api_version': process.env.RAG_AZURE_OPENAI_API_VERSION || '',
  // reranking (config parity — rerankers unavailable serverless)
  'rag.reranking_engine': '',
  'rag.reranking_model': '',
  'rag.reranking_batch_size': 32,
  'rag.external_reranker_url': '',
  'rag.external_reranker_api_key': '',
  'rag.external_reranker_timeout': '',
  // files
  'rag.file.max_size': process.env.RAG_FILE_MAX_SIZE ? Number(process.env.RAG_FILE_MAX_SIZE) : null,
  'rag.file.max_count': process.env.RAG_FILE_MAX_COUNT ? Number(process.env.RAG_FILE_MAX_COUNT) : null,
  'rag.file.allowed_extensions': (process.env.RAG_ALLOWED_FILE_EXTENSIONS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean),
  // extraction engines (parity only)
  'rag.content_extraction_engine': (process.env.CONTENT_EXTRACTION_ENGINE || '').toLowerCase(),
  'rag.content_extraction.supported_media_mime_types': null,
  'rag.pdf_extract_images': false,
  'rag.pdf_loader_mode': 'page',
  // web search
  'web.search.enable': false,
  'web.search.confirmation.enable': false,
  'web.search.confirmation.content': '',
  'web.search.engine': process.env.WEB_SEARCH_ENGINE || '',
  'web.search.trust_env': true,
  'web.search.result_count': 3,
  'web.search.concurrent_requests': 0,
  'web.search.domain.filter_list': [],
  'web.search.bypass_embedding_and_retrieval': false,
  'web.search.bypass_web_loader': false,
  'web.fetch.max_content_length': 1000,
  'web.loader.engine': '',
  'web.loader.concurrent_requests': 5,
  'web.loader.timeout': 10000,
  'web.loader.ssl_verification': true,
};

export type RagConfig = Record<string, any>;

/** Load a subset of the RAG config with python defaults applied. */
export async function getRagConfig(keys?: string[]): Promise<RagConfig> {
  const wanted = keys ?? Object.keys(RAG_CONFIG_DEFAULTS);
  const out: RagConfig = {};
  for (const key of wanted) {
    out[key] = await configGet(key, RAG_CONFIG_DEFAULTS[key] as any);
  }
  return out;
}

export async function ragEmbeddingModel(): Promise<string> {
  return configGet<string>('rag.embedding_model', env.RAG_EMBEDDING_MODEL);
}

// ---------------------------------------------------------------------------
// File model helpers (models/files.py parity)
// ---------------------------------------------------------------------------

export type FileRow = {
  id: string;
  user_id: string | null;
  hash: string | null;
  filename: string | null;
  path: string | null;
  data: string | null;
  meta: string | null;
  created_at: number | null;
  updated_at: number | null;
};

export type FileModel = {
  id: string;
  user_id: string | null;
  hash: string | null;
  filename: string | null;
  path: string | null;
  data: Record<string, any> | null;
  meta: Record<string, any> | null;
  created_at: number | null;
  updated_at: number | null;
};

export function rowToFileModel(row: FileRow): FileModel {
  return {
    id: row.id,
    user_id: row.user_id,
    hash: row.hash,
    filename: row.filename,
    path: row.path,
    data: safeJson(row.data),
    meta: safeJson(row.meta),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getFileById(id: string): Promise<FileModel | null> {
  const row = (await db.file.findUnique({ where: { id } })) as FileRow | null;
  return row ? rowToFileModel(row) : null;
}

/** FileMeta sanitize: content_type may be a list like ['application/pdf', null]. */
function sanitizeFileMeta(meta: Record<string, any> | null): Record<string, any> | null {
  if (!meta || typeof meta !== 'object') return meta ?? null;
  const out = { ...meta };
  const ct = out['content_type'];
  if (Array.isArray(ct)) {
    out['content_type'] = ct.find((item) => typeof item === 'string') ?? null;
  } else if (ct !== undefined && ct !== null && typeof ct !== 'string') {
    out['content_type'] = null;
  }
  return out;
}

/** FileModelResponse shape (no `path`, ints coerced). */
export function fileModelResponse(model: FileModel): Record<string, any> {
  return {
    id: model.id,
    user_id: model.user_id,
    hash: model.hash,
    filename: model.filename,
    data: model.data,
    meta: sanitizeFileMeta(model.meta),
    created_at: model.created_at ?? 0,
    updated_at: model.updated_at ?? 0,
  };
}

/** FileMetadataResponse shape. */
export function fileMetadataResponse(model: FileModel): Record<string, any> {
  return {
    id: model.id,
    hash: model.hash,
    meta: model.meta,
    created_at: model.created_at ?? 0,
    updated_at: model.updated_at ?? 0,
  };
}

/** Strip the heavy base64 payload from file data for list responses. */
export function stripFileBytes(model: FileModel | Record<string, any>): Record<string, any> {
  const data = (model as any).data;
  if (!data || typeof data !== 'object' || !('content_base64' in data)) return model;
  return { ...model, data: { ...data, content_base64: undefined } };
}

async function updateFileData(id: string, patch: Record<string, any>): Promise<void> {
  const row = (await db.file.findUnique({ where: { id } })) as FileRow | null;
  if (!row) return;
  const data = safeJson(row.data) ?? {};
  await db.file.update({
    where: { id },
    data: { data: JSON.stringify({ ...data, ...patch }), updated_at: Math.floor(Date.now() / 1000) },
  });
}

async function updateFileMeta(id: string, patch: Record<string, any>): Promise<void> {
  const row = (await db.file.findUnique({ where: { id } })) as FileRow | null;
  if (!row) return;
  const meta = safeJson(row.meta) ?? {};
  await db.file.update({
    where: { id },
    data: { meta: JSON.stringify({ ...meta, ...patch }), updated_at: Math.floor(Date.now() / 1000) },
  });
}

export async function updateFileHash(id: string, hash: string | null): Promise<void> {
  await db.file.update({
    where: { id },
    data: { hash, updated_at: Math.floor(Date.now() / 1000) },
  });
}

// ---------------------------------------------------------------------------
// Metadata filtering (retrieval/vector/utils.py filter_metadata parity)
// ---------------------------------------------------------------------------

export function filterMetadata(metadata: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' && !Array.isArray(value)) continue;
    if (typeof value === 'function') continue;
    out[key] = value;
  }
  return out;
}

/** Port of filter_file_metadata: hoists meta.data entries into chunk metadata. */
export function filterFileMetadata(metadata: Record<string, any> | null | undefined): Record<string, any> {
  const meta = { ...(metadata ?? {}) };
  const data = meta['data'];
  delete meta['data'];
  let merged = filterMetadata(meta);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    merged = { ...filterMetadata(data), ...merged };
  }
  return merged;
}

// ---------------------------------------------------------------------------
// File access control (utils/access_control/files.py port)
// ---------------------------------------------------------------------------

/**
 * Port of has_access_to_file — knowledge grants, channel membership and
 * shared chats confer access (read always; write only when the KB owner owns
 * the file). Notes / workspace-model attachment grants are not ported
 * (those routers are out of scope here).
 */
export async function hasAccessToFile(
  fileId: string | null | undefined,
  accessType: 'read' | 'write',
  user: ApiUser
): Promise<boolean> {
  if (!fileId) return false;
  const file = await getFileById(fileId);
  if (!file) return false;
  if (file.user_id === user.id) return true;

  // Knowledge bases containing the file
  const kbRows = await db.knowledgeFile.findMany({ where: { file_id: fileId } });
  const knowledgeIds = kbRows.map((k) => k.knowledge_id);
  if (knowledgeIds.length > 0) {
    const knowledges = await db.knowledge.findMany({ where: { id: { in: knowledgeIds } } });
    const groupIds = await getUserGroupIds(user.id);
    for (const kb of knowledges) {
      const granted =
        kb.user_id === user.id ||
        (await hasAccessGrant(user.id, 'knowledge', kb.id, accessType, groupIds));
      if (granted && (accessType === 'read' || kb.user_id === file.user_id)) {
        return true;
      }
    }
  }

  if (accessType === 'read') {
    // Channels the user is a member of that contain the file
    const channelFiles = await db.channelFile.findMany({ where: { file_id: fileId } });
    if (channelFiles.length > 0) {
      const membership = await db.channelMember.findFirst({
        where: { channel_id: { in: channelFiles.map((c) => c.channel_id) }, user_id: user.id },
      });
      if (membership) return true;
    }

    // Shared chats that contain the file
    const chatFiles = await db.chatFile.findMany({ where: { file_id: fileId } });
    if (chatFiles.length > 0) {
      const shared = await db.chat.findFirst({
        where: { id: { in: chatFiles.map((c) => c.chat_id) }, share_id: { not: null } },
      });
      if (shared) return true;
    }
  }

  return false;
}

const SAFE_COLLECTION_NAME_RE = /^[A-Za-z0-9_-]{1,255}$/;

function resolveCollectionNames(collectionName: string): Set<string> {
  const normalized = collectionName.toLowerCase().replace(/_/g, '-').replace(/^-+|-+$/g, '');
  const names = new Set<string>([normalized]);
  if (/^[0-9]/.test(normalized)) {
    names.add(`c${normalized}`);
  } else if (/^c[0-9]/.test(normalized)) {
    names.add(normalized.slice(1));
  }
  return names;
}

const ENABLE_RETRIEVAL_UNSCOPED_COLLECTIONS =
  (process.env.ENABLE_RETRIEVAL_UNSCOPED_COLLECTIONS || 'false').toLowerCase() === 'true';

async function knowledgeCheckAccess(id: string, userId: string, permission: string): Promise<boolean> {
  const kb = await db.knowledge.findUnique({ where: { id } });
  if (!kb) return false;
  if (kb.user_id === userId) return true;
  return hasAccessGrant(userId, 'knowledge', id, permission);
}

/** Port of has_access_to_collection. */
export async function hasAccessToCollection(
  collectionName: string,
  user: ApiUser,
  accessType: 'read' | 'write'
): Promise<boolean> {
  let hasAuthorizedCollection = false;
  for (const resolved of resolveCollectionNames(collectionName)) {
    if (resolved === 'knowledge-bases') return false;
    let hasAccess: boolean;
    if (resolved.startsWith('file-')) {
      hasAccess = await hasAccessToFile(resolved.slice('file-'.length), accessType, user);
    } else if (resolved.startsWith('user-memory-')) {
      hasAccess = resolved === `user-memory-${user.id}`;
    } else if (resolved.startsWith('web-search-')) {
      hasAccess = resolved.startsWith(`web-search-${user.id}-`);
    } else {
      hasAccess = await knowledgeCheckAccess(resolved, user.id, accessType);
      if (!hasAccess) {
        const kb = await db.knowledge.findUnique({ where: { id: resolved } });
        if (!kb) continue; // unknown name → does not authorize
      }
    }
    if (!hasAccess) return false;
    hasAuthorizedCollection = true;
  }
  return hasAuthorizedCollection || ENABLE_RETRIEVAL_UNSCOPED_COLLECTIONS;
}

/** Port of filter_accessible_collections. */
export async function filterAccessibleCollections(
  collectionNames: Iterable<string>,
  user: ApiUser,
  accessType: 'read' | 'write' = 'read'
): Promise<Set<string>> {
  const requested = new Set(collectionNames);
  const safeNames = new Set([...requested].filter((n) => SAFE_COLLECTION_NAME_RE.test(n)));
  if (user.role === 'admin') return safeNames;
  const validated = new Set<string>();
  for (const name of safeNames) {
    if (await hasAccessToCollection(name, user, accessType)) validated.add(name);
  }
  return validated;
}

/** Port of _validate_collection_access (retrieval.py). */
export async function validateCollectionAccess(
  collectionNames: string[],
  user: ApiUser,
  accessType: 'read' | 'write' = 'read'
): Promise<void> {
  const requested = new Set(collectionNames);
  const allowed = await filterAccessibleCollections(requested, user, accessType);
  const denied = [...requested].filter((n) => !allowed.has(n));
  if (denied.length > 0) {
    throw new HttpError(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
  }
}

// ---------------------------------------------------------------------------
// Vector store operations
// ---------------------------------------------------------------------------

type ChunkRow = {
  id: string;
  collection_name: string;
  knowledge_id: string | null;
  file_id: string | null;
  content: string;
  embedding: string;
  metadata: string;
};

/** Read all chunks of a collection (documents + metadata, no scoring). */
export async function getCollectionChunks(collectionName: string): Promise<ChunkDocument[]> {
  const rows = (await db.chunk.findMany({ where: { collection_name: collectionName } })) as ChunkRow[];
  return rows.map((row) => ({
    page_content: row.content,
    metadata: safeJson(row.metadata) ?? {},
  }));
}

export async function hasCollection(collectionName: string): Promise<boolean> {
  return (await db.chunk.count({ where: { collection_name: collectionName } })) > 0;
}

/** Port of has_duplicate_content — metadata.hash based dedupe check. */
export async function hasDuplicateContent(
  collectionName: string,
  hash: string,
  fileId: string | null
): Promise<boolean> {
  const rows = (await db.chunk.findMany({ where: { collection_name: collectionName } })) as ChunkRow[];
  for (const row of rows) {
    const metadata = safeJson(row.metadata) ?? {};
    if (metadata['hash'] === hash) {
      const existingFileId = metadata['file_id'] ?? null;
      return existingFileId !== fileId;
    }
  }
  return false;
}

export type SaveDocsOptions = {
  metadata?: Record<string, any> | null;
  overwrite?: boolean;
  add?: boolean;
  knowledgeId?: string | null;
  fileId?: string | null;
};

/**
 * Port of save_docs_to_vector_db: split → embed → store.
 * Reranking / hybrid search are not applicable (no reranker serverless).
 */
export async function saveDocsToVectorDb(
  docs: ChunkDocument[],
  collectionName: string,
  options: SaveDocsOptions = {}
): Promise<boolean> {
  const config = await getRagConfig([
    'rag.text_splitter',
    'rag.enable_markdown_header_text_splitter',
    'rag.chunk_size',
    'rag.chunk_overlap',
    'rag.chunk_min_size_target',
    'rag.embedding_engine',
    'rag.embedding_model',
  ]);

  const metadata = options.metadata ?? null;
  if (metadata && 'hash' in metadata) {
    if (await hasDuplicateContent(collectionName, String(metadata['hash']), (metadata['file_id'] as string) ?? null)) {
      throw new Error(RAG_ERRORS.DUPLICATE_CONTENT);
    }
  }

  let chunks: ChunkDocument[] = docs;
  if (config['rag.enable_markdown_header_text_splitter']) {
    chunks = markdownHeaderSplit(docs);
    if (Number(config['rag.chunk_min_size_target']) > 0) {
      chunks = mergeDocsToTargetSize(chunks, {
        chunkSize: Number(config['rag.chunk_size']),
        minSize: Number(config['rag.chunk_min_size_target']),
      });
    }
  }

  const splitter = String(config['rag.text_splitter'] ?? '');
  if (splitter === '' || splitter === 'character' || splitter === 'token' || splitter === 'token_transformers') {
    // token/token_transformers fall back to the character splitter (no
    // tiktoken/transformers runtime) — documented deviation.
    chunks = splitDocuments(chunks, {
      chunkSize: Number(config['rag.chunk_size']),
      chunkOverlap: Number(config['rag.chunk_overlap']),
    });
  } else {
    throw new Error(`Invalid text splitter: ${splitter}`);
  }

  if (chunks.length === 0) {
    throw new Error(RAG_ERRORS.EMPTY_CONTENT);
  }

  const texts = chunks.map((d) => sanitizeTextForDb(d.page_content));
  const metadatas = chunks.map((d) => ({
    ...d.metadata,
    ...(metadata ?? {}),
    embedding_config: {
      engine: config['rag.embedding_engine'],
      model: config['rag.embedding_model'],
    },
  }));

  const exists = await hasCollection(collectionName);
  if (exists) {
    if (options.overwrite) {
      await deleteChunksForCollection(collectionName);
    } else if (!options.add) {
      return true;
    }
  }

  const embeddings = await generateEmbeddings(String(config['rag.embedding_model']), texts.map((t) => t.replace(/\n/g, ' ')));

  const items = texts.map((text, idx) => ({
    id: crypto.randomUUID(),
    text,
    embedding: embeddings[idx] ?? [],
    metadata: metadatas[idx],
  }));

  await storeChunks(
    collectionName,
    items,
    { knowledgeId: options.knowledgeId ?? null, fileId: options.fileId ?? null }
  );
  return true;
}

/** Simplified MarkdownHeaderTextSplitter: split at #..###### lines, keep headers. */
function markdownHeaderSplit(docs: ChunkDocument[]): ChunkDocument[] {
  const out: ChunkDocument[] = [];
  for (const doc of docs) {
    const lines = doc.page_content.split('\n');
    let current: string[] = [];
    let currentHeaders: Record<string, string> = {};
    const flush = () => {
      if (current.length === 0) return;
      const content = current.join('\n');
      if (content.trim().length > 0) {
        out.push({ page_content: content, metadata: { ...doc.metadata, ...currentHeaders } });
      }
      current = [];
    };
    for (const line of lines) {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        flush();
        const level = m[1].length;
        currentHeaders = { ...currentHeaders, [`Header ${level}`]: m[2].trim() };
        current = [line]; // strip_headers=False → keep the header line
      } else {
        current.push(line);
      }
    }
    flush();
  }
  return out;
}

// ---------------------------------------------------------------------------
// process_file / index_file (retrieval.py port)
// ---------------------------------------------------------------------------

export type ProcessFileForm = {
  file_id: string;
  content?: string | null;
  collection_name?: string | null;
};

export type ProcessFileResult = {
  status: boolean;
  collection_name: string | null;
  filename: string;
  content: string;
};

/** Get the raw stored bytes of a file (data.content_base64). */
export function fileBytes(file: FileModel): Buffer | null {
  const b64 = file.data?.['content_base64'];
  if (typeof b64 !== 'string' || b64.length === 0) return null;
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

/**
 * Port of index_file — extract or reuse file content and index it without
 * marking completion (the caller sets data.status afterwards).
 */
export async function indexFile(
  user: ApiUser,
  form: ProcessFileForm
): Promise<ProcessFileResult> {
  const config = await getRagConfig([
    'rag.bypass_embedding_and_retrieval',
    'rag.file.max_size',
  ]);

  let file = await getFileById(form.file_id);
  if (file && file.user_id !== user.id && user.role !== 'admin') {
    if (!(await hasAccessToFile(file.id, 'write', user))) {
      file = null;
    }
  }

  if (!file) {
    throw new HttpError(404, ERROR_MESSAGES.NOT_FOUND);
  }

  let collectionName = form.collection_name ?? null;
  const fileCollectionName = `file-${file.id}`;
  if (collectionName === null) {
    collectionName = fileCollectionName;
  } else {
    await validateCollectionAccess([collectionName], user, 'write');
  }
  const collectionNames = [collectionName];

  const baseMetadata = {
    ...filterFileMetadata(file.meta),
    name: file.filename,
    created_by: file.user_id,
    file_id: file.id,
    source: file.filename,
  };

  try {
    let docs: ChunkDocument[];
    let textContent: string;

    if (form.content) {
      // /files/{file_id}/data/content/update path
      try {
        await deleteChunksForCollection(fileCollectionName);
      } catch {
        /* collection may not exist */
      }
      docs = [
        {
          page_content: form.content.replace(/<br\/>/g, '\n'),
          metadata: { ...baseMetadata },
        },
      ];
      textContent = form.content;
    } else if (form.collection_name) {
      // Knowledge add/update path — reuse file-{id} chunks when present.
      const fileChunks = await getCollectionChunks(fileCollectionName);
      const storedContent = file.data?.['content'];

      if (fileChunks.length > 0) {
        docs = fileChunks.map((chunk) => ({
          page_content: chunk.page_content,
          metadata: chunk.metadata,
        }));
      } else if (storedContent !== undefined && storedContent !== null) {
        docs = [{ page_content: String(storedContent), metadata: { ...baseMetadata } }];
        collectionNames.push(fileCollectionName);
      } else {
        throw new Error(RAG_ERRORS.EMPTY_CONTENT);
      }
      textContent = storedContent ? String(storedContent) : '';
    } else {
      // Upload path — load from stored bytes.
      const bytes = fileBytes(file);
      if (bytes) {
        const contentType = (file.meta?.['content_type'] as string) ?? null;
        const loaded = await loadDocuments(file.filename ?? 'file', contentType, new Uint8Array(bytes), file.path ?? undefined);
        docs = loaded.map((doc) => ({
          page_content: doc.page_content,
          metadata: {
            ...filterFileMetadata(file.meta),
            ...filterMetadata(doc.metadata),
            ...baseMetadata,
          },
        }));
      } else {
        const stored = file.data?.['content'];
        docs = [
          {
            page_content: typeof stored === 'string' ? stored : '',
            metadata: { ...baseMetadata },
          },
        ];
      }
      textContent = docs.map((d) => d.page_content).join(' ');
    }

    await updateFileData(file.id, { content: textContent });
    const hash = calculateSha256String(textContent);

    if (config['rag.bypass_embedding_and_retrieval']) {
      await updateFileHash(file.id, hash);
      return {
        status: true,
        collection_name: null,
        filename: file.filename ?? '',
        content: textContent,
      };
    }

    // knowledge_id for chunk rows: the KB collection when adding to one
    let knowledgeId: string | null = null;
    if (form.collection_name) {
      const kb = await db.knowledge.findUnique({ where: { id: form.collection_name } });
      knowledgeId = kb ? kb.id : null;
    }

    let result = true;
    for (const name of collectionNames) {
      result =
        (await saveDocsToVectorDb(docs, name, {
          metadata: {
            file_id: file.id,
            name: file.filename,
            hash,
          },
          add: Boolean(form.collection_name),
          knowledgeId: form.collection_name ? knowledgeId : null,
          fileId: file.id,
        })) && result;
    }

    if (result) {
      await updateFileMeta(file.id, { collection_name: collectionName });
      await updateFileHash(file.id, hash);
      return {
        status: true,
        collection_name: collectionName,
        filename: file.filename ?? '',
        content: textContent,
      };
    }
    throw new Error('Error saving document to vector database');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await updateFileData(file.id, { status: 'failed', error: message });
    await updateFileHash(file.id, null);
    throw new HttpError(400, message);
  }
}

/** Port of the /retrieval/process/file endpoint: index + mark completed. */
export async function processFile(user: ApiUser, form: ProcessFileForm): Promise<ProcessFileResult> {
  const result = await indexFile(user, form);
  await updateFileData(form.file_id, { status: 'completed', error: null });
  return result;
}

// ---------------------------------------------------------------------------
// Query pipeline (query_doc / query_collection ports)
// ---------------------------------------------------------------------------

export type VectorGetResult = {
  ids: string[][];
  documents: string[][];
  metadatas: Record<string, any>[][];
  distances: number[][];
};

/** Port of query_doc — single collection vector search. */
export async function queryDoc(
  collectionName: string,
  queryEmbedding: number[],
  k: number
): Promise<VectorGetResult> {
  const results = await queryChunks(collectionName, queryEmbedding, k);
  return {
    ids: [results.map((r) => r.id)],
    documents: [results.map((r) => r.text)],
    metadatas: [results.map((r) => r.metadata)],
    distances: [results.map((r) => r.distance)],
  };
}

/**
 * Port of merge_and_sort_query_results. Python keeps the LARGER Chroma
 * "distance" (a similarity score) and sorts descending; our store's distance
 * is `1 - cosine` (smaller = better), so the equivalent keeps the smaller
 * distance and sorts ascending — same ordering semantics, inverted metric.
 */
export function mergeAndSortQueryResults(queryResults: VectorGetResult[], k: number): Omit<VectorGetResult, 'ids'> {
  const combined = new Map<string, { distance: number; document: string; metadata: Record<string, any> }>();
  for (const data of queryResults) {
    if (
      (data.distances ?? []).length === 0 ||
      (data.documents ?? []).length === 0 ||
      (data.metadatas ?? []).length === 0
    ) {
      continue;
    }
    const distances = data.distances[0] ?? [];
    const documents = data.documents[0] ?? [];
    const metadatas = data.metadatas[0] ?? [];
    for (let i = 0; i < documents.length; i++) {
      const distance = distances[i] ?? 0;
      const document = documents[i] ?? '';
      const metadata = metadatas[i] ?? {};
      const docHash = metadata['_chunk_hash'] ?? calculateSha256String(document);
      const existing = combined.get(docHash);
      if (!existing) {
        combined.set(docHash, { distance, document, metadata });
      } else if (distance < existing.distance) {
        combined.set(docHash, { distance, document, metadata });
      }
    }
  }
  const entries = [...combined.values()].sort((a, b) => a.distance - b.distance).slice(0, k);
  return {
    distances: [entries.map((e) => e.distance)],
    documents: [entries.map((e) => e.document)],
    metadatas: [entries.map((e) => e.metadata)],
  };
}

/** Port of query_collection (non-hybrid path). */
export async function queryCollection(
  collectionNames: string[],
  query: string,
  k: number
): Promise<Omit<VectorGetResult, 'ids'>> {
  if (!query) {
    return { distances: [[]], documents: [[]], metadatas: [[]] };
  }
  const model = await ragEmbeddingModel();
  const embeddings = await generateEmbeddings(model, [query]);
  const queryEmbedding = embeddings[0] ?? [];
  const results: VectorGetResult[] = [];
  for (const collectionName of collectionNames) {
    if (!collectionName) continue;
    try {
      const result = await queryDoc(collectionName, queryEmbedding, k);
      results.push(result);
    } catch {
      /* failing collection skipped, python parity */
    }
  }
  return mergeAndSortQueryResults(results, k);
}

/**
 * RAG sources builder — shape used by the chat middleware
 * (get_sources_from_items): one source per collection with
 * {source: {name}, document: [texts], metadata: [...], distances: [...]}.
 */
export type RagSource = {
  source: Record<string, any>;
  document: string[];
  metadata: Record<string, any>[];
  distances?: number[];
};

export async function queryKnowledgeSources(
  query: string,
  collectionNames: string[],
  k: number,
  sourceNames?: Record<string, string>
): Promise<RagSource[]> {
  const sources: RagSource[] = [];
  const seen = new Set<string>();
  for (const collectionName of collectionNames) {
    if (!collectionName || seen.has(collectionName)) continue;
    seen.add(collectionName);
    const merged = await queryCollection([collectionName], query, k);
    const documents = merged.documents[0] ?? [];
    if (documents.length === 0) continue;
    const metadata = merged.metadatas[0] ?? [];
    const distances = merged.distances[0] ?? [];
    // enrich metadata names from file rows (middleware parity)
    const fileIds = new Set<string>();
    for (const m of metadata) {
      if (m && typeof m === 'object' && typeof m['file_id'] === 'string') fileIds.add(m['file_id']);
    }
    const fileNames = new Map<string, string>();
    if (fileIds.size > 0) {
      const rows = (await db.file.findMany({
        where: { id: { in: [...fileIds] } },
        select: { id: true, meta: true },
      })) as Array<{ id: string; meta: string | null }>;
      for (const row of rows) {
        const meta = safeJson(row.meta) ?? {};
        fileNames.set(row.id, String(meta['name'] ?? ''));
      }
    }
    for (const m of metadata) {
      if (!m || typeof m !== 'object') continue;
      const fileName = fileNames.get(m['file_id']);
      if (fileName) {
        if (m['source'] === m['name']) m['source'] = fileName;
        m['name'] = fileName;
      }
    }
    sources.push({
      source: { name: sourceNames?.[collectionName] ?? collectionName, collection_name: collectionName },
      document: documents,
      metadata,
      distances,
    });
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Knowledge base metadata embeddings ('knowledge-bases' collection)
// ---------------------------------------------------------------------------

export const KNOWLEDGE_BASES_COLLECTION = 'knowledge-bases';

/** Port of embed_knowledge_base_metadata. */
export async function embedKnowledgeBaseMetadata(
  knowledgeBaseId: string,
  name: string,
  description: string
): Promise<boolean> {
  try {
    const content = description ? `${name}\n\n${description}` : name;
    const model = await ragEmbeddingModel();
    const embeddings = await generateEmbeddings(model, [content]);
    // upsert: replace any previous chunk for this KB
    await db.chunk.deleteMany({ where: { collection_name: KNOWLEDGE_BASES_COLLECTION, id: knowledgeBaseId } });
    await storeChunks(
      KNOWLEDGE_BASES_COLLECTION,
      [
        {
          id: knowledgeBaseId,
          text: content,
          embedding: embeddings[0] ?? [],
          metadata: { knowledge_base_id: knowledgeBaseId },
        },
      ],
      { knowledgeId: knowledgeBaseId }
    );
    return true;
  } catch {
    return false;
  }
}

/** Port of remove_knowledge_base_metadata_embedding. */
export async function removeKnowledgeBaseMetadataEmbedding(knowledgeBaseId: string): Promise<boolean> {
  try {
    await db.chunk.deleteMany({ where: { collection_name: KNOWLEDGE_BASES_COLLECTION, id: knowledgeBaseId } });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// File deletion helper (knowledge.py delete_file_resource port)
// ---------------------------------------------------------------------------

/** Remove a file's standalone collection, row and bytes. */
export async function deleteFileResource(file: FileModel): Promise<boolean> {
  try {
    await deleteChunksForCollection(`file-${file.id}`);
  } catch {
    /* most likely caused by bypassing embedding processing */
  }
  try {
    await db.file.delete({ where: { id: file.id } });
    return true;
  } catch {
    return false;
  }
}

/** Delete chunks of a file inside one collection (filter={'file_id'} parity). */
export async function deleteChunksForFileInCollection(collectionName: string, fileId: string): Promise<void> {
  await db.chunk.deleteMany({ where: { collection_name: collectionName, file_id: fileId } });
}
