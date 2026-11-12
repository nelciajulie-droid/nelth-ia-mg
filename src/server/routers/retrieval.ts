import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { DEFAULT_USER_PERMISSIONS, ERROR_MESSAGES } from '@/lib/constants';
import { configGet, configSet, invalidateConfigCache } from '@/lib/config';
import type { ApiUser } from '@/lib/auth';
import { hasPermission } from '@/lib/access-control';
import { generateEmbeddings } from '@/lib/retrieval/embeddings';
import { extractHtmlText } from '@/lib/retrieval/loaders';
import { uploadFileHandler } from './files';
import {
  RAG_ERRORS,
  calculateSha256String,
  fileMetadataResponse,
  filterFileMetadata,
  getFileById,
  hasCollection,
  hasDuplicateContent,
  processFile,
  queryCollection,
  queryDoc,
  queryKnowledgeSources,
  ragEmbeddingModel,
  safeJson,
  sanitizeTextForDb,
  saveDocsToVectorDb,
  validateCollectionAccess,
  type ChunkDocument,
  type FileModel,
} from '@/lib/retrieval/process';

/**
 * /api/v1/retrieval — port of open_webui/routers/retrieval.py (v0.12.5).
 *
 * Documented deviations:
 *   - hybrid search + reranking fall back to plain vector search (no local
 *     reranker models in the serverless runtime); the config surface
 *     (rag.enable_hybrid_search, rag.reranking_*) is preserved.
 *   - web search engine providers are not ported; /process/web/search keeps
 *     the python gating behavior (403 while web.search.enable is false, 400
 *     WEB_SEARCH_ERROR when no engine is usable).
 *   - /process/url + /process/web fetch over plain fetch() with a basic SSRF
 *     guard (private-range / loopback hostnames rejected) instead of the
 *     aiohttp ssrf-safe session.
 *   - 'token' / 'token_transformers' text splitters use the character
 *     splitter (no tiktoken runtime).
 *   - /reset/uploads clears the base64 payloads stored in file.data (there
 *     is no UPLOAD_DIR on serverless).
 */

const WEB_SEARCH_ERROR = 'Something went wrong while searching the web.';

// ---------------------------------------------------------------------------
// Config surface (RETRIEVAL_CONFIG_KEYS port — response-relevant subset)
// ---------------------------------------------------------------------------

const RETRIEVAL_CONFIG_KEYS: Record<string, string> = {
  RAG_TEMPLATE: 'rag.template',
  TOP_K: 'rag.top_k',
  BYPASS_EMBEDDING_AND_RETRIEVAL: 'rag.bypass_embedding_and_retrieval',
  RAG_FULL_CONTEXT: 'rag.full_context',
  ENABLE_RAG_HYBRID_SEARCH: 'rag.enable_hybrid_search',
  ENABLE_RAG_HYBRID_SEARCH_ENRICHED_TEXTS: 'rag.enable_hybrid_search_enriched_texts',
  TOP_K_RERANKER: 'rag.top_k_reranker',
  RELEVANCE_THRESHOLD: 'rag.relevance_threshold',
  HYBRID_BM25_WEIGHT: 'rag.hybrid_bm25_weight',
  CONTENT_EXTRACTION_ENGINE: 'rag.content_extraction_engine',
  CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES: 'rag.content_extraction.supported_media_mime_types',
  PDF_EXTRACT_IMAGES: 'rag.pdf_extract_images',
  PDF_LOADER_MODE: 'rag.pdf_loader_mode',
  RAG_RERANKING_MODEL: 'rag.reranking_model',
  RAG_RERANKING_ENGINE: 'rag.reranking_engine',
  RAG_RERANKING_BATCH_SIZE: 'rag.reranking_batch_size',
  RAG_EXTERNAL_RERANKER_URL: 'rag.external_reranker_url',
  RAG_EXTERNAL_RERANKER_API_KEY: 'rag.external_reranker_api_key',
  RAG_EXTERNAL_RERANKER_TIMEOUT: 'rag.external_reranker_timeout',
  TEXT_SPLITTER: 'rag.text_splitter',
  RAG_TOKENIZER_MODEL: 'rag.tokenizer_model',
  ENABLE_MARKDOWN_HEADER_TEXT_SPLITTER: 'rag.enable_markdown_header_text_splitter',
  CHUNK_SIZE: 'rag.chunk_size',
  CHUNK_MIN_SIZE_TARGET: 'rag.chunk_min_size_target',
  CHUNK_OVERLAP: 'rag.chunk_overlap',
  FILE_MAX_SIZE: 'rag.file.max_size',
  FILE_MAX_COUNT: 'rag.file.max_count',
  FILE_IMAGE_COMPRESSION_WIDTH: 'file.image_compression_width',
  FILE_IMAGE_COMPRESSION_HEIGHT: 'file.image_compression_height',
  ALLOWED_FILE_EXTENSIONS: 'rag.file.allowed_extensions',
  ENABLE_GOOGLE_DRIVE_INTEGRATION: 'google_drive.enable',
  ENABLE_ONEDRIVE_INTEGRATION: 'onedrive.enable',
};

const WEB_CONFIG_KEYS: Record<string, string> = {
  ENABLE_WEB_SEARCH: 'web.search.enable',
  ENABLE_WEB_SEARCH_CONFIRMATION: 'web.search.confirmation.enable',
  WEB_SEARCH_CONFIRMATION_CONTENT: 'web.search.confirmation.content',
  WEB_SEARCH_ENGINE: 'web.search.engine',
  WEB_SEARCH_TRUST_ENV: 'web.search.trust_env',
  WEB_SEARCH_RESULT_COUNT: 'web.search.result_count',
  WEB_SEARCH_CONCURRENT_REQUESTS: 'web.search.concurrent_requests',
  WEB_FETCH_MAX_CONTENT_LENGTH: 'web.fetch.max_content_length',
  WEB_LOADER_CONCURRENT_REQUESTS: 'web.loader.concurrent_requests',
  WEB_SEARCH_DOMAIN_FILTER_LIST: 'web.search.domain.filter_list',
  BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL: 'web.search.bypass_embedding_and_retrieval',
  BYPASS_WEB_SEARCH_WEB_LOADER: 'web.search.bypass_web_loader',
  OLLAMA_CLOUD_WEB_SEARCH_API_KEY: 'web.search.ollama_cloud_api_key',
  SEARXNG_QUERY_URL: 'web.search.searxng_query_url',
  SEARXNG_LANGUAGE: 'web.search.searxng_language',
  OPENSERP_BASE_URL: 'web.search.openserp_base_url',
  YACY_QUERY_URL: 'web.search.yacy_query_url',
  YACY_USERNAME: 'web.search.yacy_username',
  YACY_PASSWORD: 'web.search.yacy_password',
  GOOGLE_PSE_API_KEY: 'web.search.google_pse_api_key',
  GOOGLE_PSE_ENGINE_ID: 'web.search.google_pse_engine_id',
  BRAVE_SEARCH_API_KEY: 'web.search.brave_search_api_key',
  KAGI_SEARCH_API_KEY: 'web.search.kagi_search_api_key',
  MOJEEK_SEARCH_API_KEY: 'web.search.mojeek_search_api_key',
  BOCHA_SEARCH_API_KEY: 'web.search.bocha_search_api_key',
  SERPSTACK_API_KEY: 'web.search.serpstack_api_key',
  SERPER_API_KEY: 'web.search.serper_api_key',
  SERPHOUSE_API_KEY: 'web.search.serphouse_api_key',
  SERPLY_API_KEY: 'web.search.serply_api_key',
  TAVILY_API_KEY: 'web.search.tavily_api_key',
  SEARCHAPI_API_KEY: 'web.search.searchapi_api_key',
  SERPAPI_API_KEY: 'web.search.serpapi_api_key',
  JINA_API_KEY: 'web.search.jina_api_key',
  BING_SEARCH_V7_ENDPOINT: 'web.search.bing_search_v7_endpoint',
  BING_SEARCH_V7_SUBSCRIPTION_KEY: 'web.search.bing_search_v7_subscription_key',
  EXA_API_KEY: 'web.search.exa_api_key',
  PERPLEXITY_API_KEY: 'web.search.perplexity_api_key',
  WEB_LOADER_ENGINE: 'web.loader.engine',
  WEB_LOADER_TIMEOUT: 'web.loader.timeout',
  ENABLE_WEB_LOADER_SSL_VERIFICATION: 'web.loader.ssl_verification',
  EXTERNAL_WEB_SEARCH_URL: 'web.search.external_web_search_url',
  EXTERNAL_WEB_SEARCH_API_KEY: 'web.search.external_web_search_api_key',
  EXTERNAL_WEB_LOADER_URL: 'web.loader.external_web_loader_url',
  EXTERNAL_WEB_LOADER_API_KEY: 'web.loader.external_web_loader_api_key',
  YOUTUBE_LOADER_LANGUAGE: 'rag.youtube_loader_language',
  YOUTUBE_LOADER_PROXY_URL: 'rag.youtube_loader_proxy_url',
};

const CONFIG_DEFAULTS: Record<string, unknown> = {
  'file.image_compression_width': null,
  'file.image_compression_height': null,
  'google_drive.enable': false,
  'onedrive.enable': false,
  'web.search.ollama_cloud_api_key': '',
  'web.search.searxng_query_url': process.env.SEARXNG_QUERY_URL || '',
  'web.search.searxng_language': '',
  'web.search.openserp_base_url': process.env.OPENSERP_BASE_URL || '',
  'web.search.yacy_query_url': process.env.YACY_QUERY_URL || '',
  'web.search.yacy_username': process.env.YACY_USERNAME || '',
  'web.search.yacy_password': process.env.YACY_PASSWORD || '',
  'web.search.google_pse_api_key': process.env.GOOGLE_PSE_API_KEY || '',
  'web.search.google_pse_engine_id': process.env.GOOGLE_PSE_ENGINE_ID || '',
  'web.search.brave_search_api_key': process.env.BRAVE_SEARCH_API_KEY || '',
  'web.search.kagi_search_api_key': process.env.KAGI_SEARCH_API_KEY || '',
  'web.search.mojeek_search_api_key': process.env.MOJEEK_SEARCH_API_KEY || '',
  'web.search.bocha_search_api_key': process.env.BOCHA_SEARCH_API_KEY || '',
  'web.search.serpstack_api_key': process.env.SERPSTACK_API_KEY || '',
  'web.search.serper_api_key': process.env.SERPER_API_KEY || '',
  'web.search.serphouse_api_key': process.env.SERPHOUSE_API_KEY || '',
  'web.search.serply_api_key': process.env.SERPLY_API_KEY || '',
  'web.search.tavily_api_key': process.env.TAVILY_API_KEY || '',
  'web.search.searchapi_api_key': process.env.SEARCHAPI_API_KEY || '',
  'web.search.serpapi_api_key': process.env.SERPAPI_API_KEY || '',
  'web.search.jina_api_key': process.env.JINA_API_KEY || '',
  'web.search.bing_search_v7_endpoint': process.env.BING_SEARCH_V7_ENDPOINT || '',
  'web.search.bing_search_v7_subscription_key': process.env.BING_SEARCH_V7_SUBSCRIPTION_KEY || '',
  'web.search.exa_api_key': process.env.EXA_API_KEY || '',
  'web.search.perplexity_api_key': process.env.PERPLEXITY_API_KEY || '',
  'web.search.external_web_search_url': process.env.EXTERNAL_WEB_SEARCH_URL || '',
  'web.search.external_web_search_api_key': process.env.EXTERNAL_WEB_SEARCH_API_KEY || '',
  'web.loader.external_web_loader_url': process.env.EXTERNAL_WEB_LOADER_URL || '',
  'web.loader.external_web_loader_api_key': process.env.EXTERNAL_WEB_LOADER_API_KEY || '',
  'rag.youtube_loader_language': ['en'],
  'rag.youtube_loader_proxy_url': '',
};

async function configValue(key: string): Promise<any> {
  const defaults = { ...CONFIG_DEFAULTS };
  return configGet(key, defaults[key]);
}

async function ragConfigResponse(): Promise<Record<string, any>> {
  const fields: Record<string, any> = {};
  for (const [field, key] of Object.entries(RETRIEVAL_CONFIG_KEYS)) {
    fields[field] = await configValue(key);
  }
  const web: Record<string, any> = {};
  for (const [field, key] of Object.entries(WEB_CONFIG_KEYS)) {
    web[field] = await configValue(key);
  }
  return { status: true, ...fields, web };
}

// ---------------------------------------------------------------------------
// URL fetching (SSRF-guarded)
// ---------------------------------------------------------------------------

function isYoutubeUrl(url: string): boolean {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(url);
}

function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, ERROR_MESSAGES.INVALID_URL);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, ERROR_MESSAGES.INVALID_URL);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^0\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1' ||
    host === 'fe80::1';
  if (isPrivate) {
    throw new HttpError(400, ERROR_MESSAGES.INVALID_URL);
  }
  return url;
}

type FetchUrlResult =
  | { kind: 'web' }
  | { kind: 'file'; data: Buffer; filename: string; content_type: string };

async function fetchUrl(url: string, maxSizeMb: number | string | null): Promise<FetchUrlResult> {
  validateUrl(url);
  const maxBytes = maxSizeMb ? Number(maxSizeMb) * 1024 * 1024 : null;
  const res = await fetch(url, {
    headers: { 'accept-encoding': 'identity', 'user-agent': 'Nelth-AI (https://openwebui.com)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  const baseContentType = contentType.split(';')[0].trim().toLowerCase();
  const contentDisposition = res.headers.get('content-disposition') ?? '';
  const isAttachment = contentDisposition.split(';')[0].trim().toLowerCase() === 'attachment';

  if (!isAttachment && (baseContentType === 'text/html' || baseContentType === 'application/xhtml+xml')) {
    return { kind: 'web' };
  }

  const contentLength = res.headers.get('content-length');
  if (maxBytes && contentLength && Number(contentLength) > maxBytes) {
    throw new HttpError(413, RAG_ERRORS.FILE_TOO_LARGE(`${maxSizeMb} MB`));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) {
    throw new HttpError(413, RAG_ERRORS.FILE_TOO_LARGE(`${maxSizeMb} MB`));
  }

  let filename = '';
  const star = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (star) {
    try {
      filename = decodeURIComponent(star[1]);
    } catch {
      filename = star[1];
    }
  } else if (plain) {
    filename = plain[1];
  }
  if (!filename) {
    filename = new URL(url).pathname.split('/').pop() ?? '';
  }
  filename = filename.split(/[\\/]/).pop() || 'download';

  const resolvedContentType =
    baseContentType ||
    (filename.endsWith('.pdf')
      ? 'application/pdf'
      : filename.endsWith('.html') || filename.endsWith('.htm')
        ? 'text/html'
        : filename.endsWith('.json')
          ? 'application/json'
          : filename.endsWith('.csv')
            ? 'text/csv'
            : 'application/octet-stream');
  if (!filename.includes('.')) {
    filename = `${filename}.bin`;
  }
  return { kind: 'file', data: buf, filename, content_type: resolvedContentType };
}

/** Fetch a URL and return extracted text + docs (get_content_from_url port). */
async function getContentFromUrl(url: string): Promise<{ content: string; docs: ChunkDocument[] }> {
  const result = await fetchUrl(url, null);
  if (result.kind === 'file') {
    const text = sanitizeTextForDb(result.data.toString('utf-8'));
    return {
      content: text,
      docs: [{ page_content: text, metadata: { source: url } }],
    };
  }
  const html = await (await fetch(url, { signal: AbortSignal.timeout(30_000) })).text();
  const { text, title } = extractHtmlText(html);
  return {
    content: text,
    docs: [{ page_content: text, metadata: { source: url, title } }],
  };
}

/** Port of process_web (also used by /process/youtube and /process/url). */
async function processWeb(
  user: ApiUser,
  form: { url: string; collection_name?: string | null },
  process: boolean,
  overwrite: boolean
): Promise<Record<string, any>> {
  let content: string;
  let docs: ChunkDocument[];
  try {
    ({ content, docs } = await getContentFromUrl(form.url));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, `Could not read content from ${form.url}`);
  }

  if (docs.length === 0) {
    throw new HttpError(400, `Could not read content from ${form.url}`);
  }

  if (process) {
    let collectionName = form.collection_name ?? null;
    if (!collectionName) {
      collectionName = calculateSha256String(form.url).slice(0, 63);
    } else {
      await validateCollectionAccess([collectionName], user, 'write');
    }

    const bypass = await configGet<boolean>('web.search.bypass_embedding_and_retrieval', false);
    if (!bypass) {
      await saveDocsToVectorDb(docs, collectionName, { overwrite, add: !overwrite });
    } else {
      collectionName = null;
    }

    return {
      status: true,
      collection_name: collectionName,
      filename: form.url,
      content,
      file: {
        data: { content },
        meta: { name: form.url, source: form.url },
      },
    };
  }
  return { status: true, content };
}

// ---------------------------------------------------------------------------
// process_files_batch (used by knowledge /files/batch/add)
// ---------------------------------------------------------------------------

export type BatchProcessResult = {
  results: Array<{ file_id: string; status: string; error: string | null }>;
  errors: Array<{ file_id: string; status: string; error: string | null }>;
};

export async function processFilesBatch(
  user: ApiUser,
  form: { files: FileModel[]; collection_name: string }
): Promise<BatchProcessResult> {
  const collectionName = form.collection_name;
  if (collectionName) {
    await validateCollectionAccess([collectionName], user, 'write');
  }

  const fileResults: Array<{ file_id: string; status: string; error: string | null }> = [];
  const fileErrors: Array<{ file_id: string; status: string; error: string | null }> = [];
  const allDocs: ChunkDocument[] = [];
  const seenHashes = new Set<string>();
  const prepared: Array<{ fileId: string; hash: string; content: string }> = [];

  for (const file of form.files) {
    try {
      const dbFile = await getFileById(file.id);
      if (!dbFile) {
        fileErrors.push({ file_id: file.id, status: 'failed', error: 'File not found' });
        continue;
      }
      if (dbFile.user_id !== user.id && user.role !== 'admin') {
        fileErrors.push({
          file_id: file.id,
          status: 'failed',
          error: 'Permission denied: not file owner',
        });
        continue;
      }
      const textContent = String(dbFile.data?.['content'] ?? '');
      const hash = calculateSha256String(textContent);
      if (seenHashes.has(hash) || (await hasDuplicateContent(collectionName, hash, dbFile.id))) {
        throw new Error(RAG_ERRORS.DUPLICATE_CONTENT);
      }
      seenHashes.add(hash);

      allDocs.push({
        page_content: textContent.replace(/<br\/>/g, '\n'),
        metadata: {
          ...filterFileMetadata(dbFile.meta),
          name: dbFile.filename,
          created_by: dbFile.user_id,
          file_id: dbFile.id,
          source: dbFile.filename,
          hash,
        },
      });
      prepared.push({ fileId: dbFile.id, hash, content: textContent });
      fileResults.push({ file_id: file.id, status: 'prepared', error: null });
    } catch (e) {
      fileErrors.push({
        file_id: file.id,
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (allDocs.length > 0) {
    try {
      await saveDocsToVectorDb(allDocs, collectionName, { add: true });
      for (const item of prepared) {
        const row = (await db.file.findUnique({ where: { id: item.fileId } })) as any;
        if (row) {
          const data = safeJson(row.data) ?? {};
          await db.file.update({
            where: { id: item.fileId },
            data: {
              hash: item.hash,
              data: JSON.stringify({ ...data, content: item.content }),
              updated_at: Math.floor(Date.now() / 1000),
            },
          });
        }
        const result = fileResults.find((r) => r.file_id === item.fileId);
        if (result) result.status = 'completed';
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const result of fileResults) {
        result.status = 'failed';
        fileErrors.push({ file_id: result.file_id, status: 'failed', error: message });
      }
    }
  }

  return { results: fileResults, errors: fileErrors };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ---- Embedding config ----
  {
    method: 'GET',
    path: 'embedding',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      return ctx.json({
        status: true,
        RAG_EMBEDDING_ENGINE: await configValue('rag.embedding_engine'),
        RAG_EMBEDDING_QUERY_PREFIX: await configValue('rag.embedding_query_prefix'),
        RAG_EMBEDDING_CONTENT_PREFIX: await configValue('rag.embedding_content_prefix'),
        RAG_EMBEDDING_MODEL: await configValue('rag.embedding_model'),
        RAG_EMBEDDING_BATCH_SIZE: await configValue('rag.embedding_batch_size'),
        ENABLE_ASYNC_EMBEDDING: await configValue('rag.enable_async_embedding'),
        RAG_EMBEDDING_CONCURRENT_REQUESTS: await configValue('rag.embedding_concurrent_requests'),
        openai_config: {
          url: await configValue('rag.openai.api_base_url'),
          key: await configValue('rag.openai.api_key'),
        },
        ollama_config: {
          url: await configValue('rag.ollama.base_url'),
          key: await configValue('rag.ollama.api_key'),
        },
        azure_openai_config: {
          url: await configValue('rag.azure_openai.base_url'),
          key: await configValue('rag.azure_openai.api_key'),
          version: await configValue('rag.azure_openai.api_version'),
        },
      });
    },
  },

  // ---- Update embedding config ----
  {
    method: 'POST',
    path: 'embedding/update',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<{
        openai_config?: { url?: string | null; key?: string | null };
        ollama_config?: { url?: string | null; key?: string | null };
        azure_openai_config?: { url?: string | null; key?: string | null; version?: string | null };
        RAG_EMBEDDING_ENGINE?: string;
        RAG_EMBEDDING_QUERY_PREFIX?: string | null;
        RAG_EMBEDDING_CONTENT_PREFIX?: string | null;
        RAG_EMBEDDING_MODEL?: string;
        RAG_EMBEDDING_BATCH_SIZE?: number;
        ENABLE_ASYNC_EMBEDDING?: boolean;
        RAG_EMBEDDING_CONCURRENT_REQUESTS?: number;
      }>();
      if (!form?.RAG_EMBEDDING_MODEL) return ctx.error(422, 'RAG_EMBEDDING_MODEL is required');

      await configSet('rag.embedding_engine', form.RAG_EMBEDDING_ENGINE ?? '');
      await configSet('rag.embedding_query_prefix', form.RAG_EMBEDDING_QUERY_PREFIX ?? '');
      await configSet('rag.embedding_content_prefix', form.RAG_EMBEDDING_CONTENT_PREFIX ?? '');
      await configSet('rag.embedding_model', form.RAG_EMBEDDING_MODEL);
      await configSet('rag.embedding_batch_size', form.RAG_EMBEDDING_BATCH_SIZE ?? 1);
      await configSet('rag.enable_async_embedding', form.ENABLE_ASYNC_EMBEDDING ?? true);
      await configSet('rag.embedding_concurrent_requests', form.RAG_EMBEDDING_CONCURRENT_REQUESTS ?? 0);
      if (form.openai_config) {
        await configSet('rag.openai.api_base_url', form.openai_config.url ?? '');
        await configSet('rag.openai.api_key', form.openai_config.key ?? '');
      }
      if (form.ollama_config) {
        await configSet('rag.ollama.base_url', form.ollama_config.url ?? '');
        await configSet('rag.ollama.api_key', form.ollama_config.key ?? '');
      }
      if (form.azure_openai_config) {
        await configSet('rag.azure_openai.base_url', form.azure_openai_config.url ?? '');
        await configSet('rag.azure_openai.api_key', form.azure_openai_config.key ?? '');
        await configSet('rag.azure_openai.api_version', form.azure_openai_config.version ?? '');
      }
      invalidateConfigCache();
      return ctx.json({
        status: true,
        RAG_EMBEDDING_ENGINE: await configValue('rag.embedding_engine'),
        RAG_EMBEDDING_QUERY_PREFIX: await configValue('rag.embedding_query_prefix'),
        RAG_EMBEDDING_CONTENT_PREFIX: await configValue('rag.embedding_content_prefix'),
        RAG_EMBEDDING_MODEL: await configValue('rag.embedding_model'),
        RAG_EMBEDDING_BATCH_SIZE: await configValue('rag.embedding_batch_size'),
        ENABLE_ASYNC_EMBEDDING: await configValue('rag.enable_async_embedding'),
        RAG_EMBEDDING_CONCURRENT_REQUESTS: await configValue('rag.embedding_concurrent_requests'),
        openai_config: {
          url: await configValue('rag.openai.api_base_url'),
          key: await configValue('rag.openai.api_key'),
        },
        ollama_config: {
          url: await configValue('rag.ollama.base_url'),
          key: await configValue('rag.ollama.api_key'),
        },
        azure_openai_config: {
          url: await configValue('rag.azure_openai.base_url'),
          key: await configValue('rag.azure_openai.api_key'),
          version: await configValue('rag.azure_openai.api_version'),
        },
      });
    },
  },

  // ---- RAG config ----
  {
    method: 'GET',
    path: 'config',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      return ctx.json(await ragConfigResponse());
    },
  },

  // ---- Update RAG config ----
  {
    method: 'POST',
    path: 'config/update',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<Record<string, any>>();
      if (!form || typeof form !== 'object') return ctx.error(422, 'Invalid config');

      const updates: Array<[string, unknown]> = [];
      for (const [field, key] of Object.entries(RETRIEVAL_CONFIG_KEYS)) {
        const value = form[field];
        if (value !== undefined && value !== null) {
          if (['FILE_MAX_SIZE', 'FILE_MAX_COUNT', 'FILE_IMAGE_COMPRESSION_WIDTH', 'FILE_IMAGE_COMPRESSION_HEIGHT'].includes(field) && value === '') {
            updates.push([key, null]);
          } else {
            updates.push([key, value]);
          }
        }
      }
      if (form['RAG_TOKENIZER_MODEL'] !== undefined && form['RAG_TOKENIZER_MODEL'] !== null) {
        updates.push(['rag.tokenizer_model', String(form['RAG_TOKENIZER_MODEL']).trim()]);
      }
      const web = form['web'];
      if (web && typeof web === 'object') {
        for (const [field, key] of Object.entries(WEB_CONFIG_KEYS)) {
          const value = (web as Record<string, any>)[field];
          if (value !== undefined && value !== null) {
            updates.push([key, value]);
          }
        }
      }
      for (const [key, value] of updates) {
        await configSet(key, value);
      }
      invalidateConfigCache();
      return ctx.json(await ragConfigResponse());
    },
  },

  // ---- Process file ----
  {
    method: 'POST',
    path: 'process/file',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<{ file_id?: string; content?: string; collection_name?: string }>();
      if (!form?.file_id) return ctx.error(422, 'file_id is required');
      try {
        const result = await processFile(ctx.user!, {
          file_id: form.file_id,
          content: form.content ?? null,
          collection_name: form.collection_name ?? null,
        });
        return ctx.json(result);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return ctx.error(400, e instanceof Error ? e.message : String(e));
      }
    },
  },

  // ---- Process text ----
  {
    method: 'POST',
    path: 'process/text',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<{ name?: string; content?: string; collection_name?: string }>();
      if (!form?.content) return ctx.error(422, 'content is required');
      const user = ctx.user!;
      let collectionName = form.collection_name ?? null;
      if (collectionName === null) {
        collectionName = calculateSha256String(form.content);
      } else {
        await validateCollectionAccess([collectionName], user, 'write');
      }
      const docs: ChunkDocument[] = [
        {
          page_content: form.content,
          metadata: { name: form.name ?? 'text', created_by: user.id },
        },
      ];
      try {
        const result = await saveDocsToVectorDb(docs, collectionName);
        if (result) {
          return ctx.json({
            status: true,
            collection_name: collectionName,
            content: form.content,
          });
        }
        return ctx.error(500, 'There was an error processing your request.');
      } catch (e) {
        return ctx.error(400, e instanceof Error ? e.message : String(e));
      }
    },
  },

  // ---- Process URL ----
  {
    method: 'POST',
    path: 'process/url',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      // MODE INVITÉ: attaching web pages / files by URL is locked for guests
      // (ChatGPT parity — no attachments for logged-out visitors).
      {
        const { isGuestUser } = await import('@/lib/guests');
        if (isGuestUser(ctx.user)) {
          ctx.error(
            403,
            'L’ajout de pages web est réservé aux comptes gratuits. Créez un compte pour joindre des contenus externes.'
          );
        }
      }
      const form = await ctx.body<{ url?: string; collection_name?: string | null }>();
      if (!form?.url) return ctx.error(422, 'url is required');
      const user = ctx.user!;
      const process = (ctx.query.get('process') ?? 'true') !== 'false';
      try {
        if (isYoutubeUrl(form.url)) {
          const result = await processWeb(user, { url: form.url, collection_name: form.collection_name }, process, true);
          return ctx.json({
            status: true,
            type: 'youtube',
            name: form.url,
            url: form.url,
            collection_name: result['collection_name'] ?? null,
            content: result['content'] ?? null,
          });
        }

        const maxSize = await configGet<number | null>('rag.file.max_size', null);
        let urlResult: FetchUrlResult;
        try {
          urlResult = await fetchUrl(form.url, maxSize);
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(400, `Could not read content from ${form.url}`);
        }

        if (urlResult.kind === 'web') {
          const result = await processWeb(user, { url: form.url, collection_name: form.collection_name }, process, true);
          return ctx.json({
            status: true,
            type: 'web',
            name: form.url,
            url: form.url,
            collection_name: result['collection_name'] ?? null,
            content: result['content'] ?? null,
          });
        }

        const isImage = urlResult.content_type.startsWith('image/');
        const uploaded = await uploadFileHandler(
          user,
          { bytes: urlResult.data, filename: urlResult.filename, contentType: urlResult.content_type },
          { source_url: form.url },
          process && !isImage
        );
        const fileId = uploaded['id'] as string | undefined;
        let fileData: Record<string, any> = uploaded;
        if (fileId) {
          const refreshed = await getFileById(fileId);
          if (refreshed) {
            fileData = {
              ...fileMetadataResponse(refreshed),
              user_id: refreshed.user_id,
              filename: refreshed.filename,
              data: { ...(refreshed.data ?? {}) },
            } as any;
            const { content_base64, ...dataWithoutBytes } = fileData.data as Record<string, any>;
            void content_base64;
            fileData.data = dataWithoutBytes;
          }
        }
        return ctx.json({
          status: true,
          type: isImage ? 'image' : 'file',
          name: urlResult.filename,
          url: form.url,
          collection_name: (fileData['meta'] as any)?.['collection_name'] ?? null,
          file: fileData,
        });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return ctx.error(400, e instanceof Error ? e.message : 'Error processing URL');
      }
    },
  },

  // ---- Process web / youtube ----
  {
    method: 'POST',
    path: 'process/web',
    auth: 'user',
    handler: handleProcessWeb,
  },
  {
    method: 'POST',
    path: 'process/youtube',
    auth: 'user',
    handler: handleProcessWeb,
  },

  // ---- Process web search ----
  {
    method: 'POST',
    path: 'process/web/search',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const user = ctx.user!;
      const form = await ctx.body<{ queries?: string[] }>();
      const queries = form?.queries ?? [];
      const enable = await configGet<boolean>('web.search.enable', false);
      if (!enable) {
        return ctx.error(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }
      const defaultPermissions = await configGet<any>('user.permissions', DEFAULT_USER_PERMISSIONS);
      if (user.role !== 'admin' && !(await hasPermission(user.id, 'features.web_search', defaultPermissions))) {
        return ctx.error(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }
      // Built-in fallback chain (DDG Lite POST → DDG HTML GET → 4get yonderly)
      // — no engine configuration required, matching the python shape:
      // { query, follow-ups, results: [{ title, url, snippet, description }] }
      try {
        const { searchWeb } = await import('@/lib/retrieval/web-search');
        const resultCountRaw = await configGet<number>('web.search.result_count', 3);
        const resultCount = Math.min(10, Math.max(1, Math.floor(Number(resultCountRaw) || 3)));
        const query = queries[0] ?? '';
        if (!query) return ctx.error(400, WEB_SEARCH_ERROR);
        const { results } = await searchWeb(query, resultCount);
        return ctx.json({
          query,
          follow_ups: [],
          results: results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            description: r.snippet,
          })),
        });
      } catch (e) {
        console.error('[retrieval] web search failed', e);
        return ctx.error(400, WEB_SEARCH_ERROR);
      }
    },
  },

  // ---- Query a single collection / document ----
  {
    method: 'POST',
    path: 'query/doc',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<{
        collection_name?: string;
        query?: string;
        k?: number;
        k_reranker?: number;
        r?: number;
        hybrid?: boolean;
        hybrid_bm25_weight?: number;
      }>();
      if (!form?.collection_name || !form?.query) {
        return ctx.error(422, 'collection_name and query are required');
      }
      const user = ctx.user!;
      await validateCollectionAccess([form.collection_name], user, 'read');
      try {
        // hybrid search / reranking unavailable serverless → vector search
        const k = form.k ?? (await configGet<number>('rag.top_k', 3));
        const model = await ragEmbeddingModel();
        const embeddings = await generateEmbeddings(model, [form.query]);
        const result = await queryDoc(form.collection_name, embeddings[0] ?? [], k);
        return ctx.json(result);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return ctx.error(400, e instanceof Error ? e.message : 'Error querying knowledge base');
      }
    },
  },

  // ---- Query multiple collections ----
  {
    method: 'POST',
    path: 'query/collection',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<{
        collection_names?: string[];
        query?: string;
        k?: number;
        k_reranker?: number;
        r?: number;
        hybrid?: boolean;
        hybrid_bm25_weight?: number;
        enable_enriched_texts?: boolean;
      }>();
      if (!form?.collection_names || !form?.query) {
        return ctx.error(422, 'collection_names and query are required');
      }
      const user = ctx.user!;
      await validateCollectionAccess(form.collection_names, user, 'read');
      try {
        const k = form.k ?? (await configGet<number>('rag.top_k', 3));
        const result = await queryCollection(form.collection_names, form.query, k);
        return ctx.json(result);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return ctx.error(400, e instanceof Error ? e.message : 'Error querying knowledge base');
      }
    },
  },

  // ---- RAG query (knowledge_id or collection_names → sources) ----
  {
    method: 'POST',
    path: 'query',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<{
        knowledge_id?: string;
        collection_names?: string[];
        query?: string;
        k?: number;
      }>();
      if (!form?.query) return ctx.error(422, 'query is required');
      const user = ctx.user!;

      let collectionNames: string[] = [];
      const sourceNames: Record<string, string> = {};
      if (form.knowledge_id) {
        const kb = await db.knowledge.findUnique({ where: { id: form.knowledge_id } });
        if (!kb) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
        const defaultPermissions = await configGet<any>('user.permissions', DEFAULT_USER_PERMISSIONS);
        const { hasAccessGrant } = await import('@/lib/access-control');
        const allowed =
          user.role === 'admin' ||
          kb.user_id === user.id ||
          (await hasAccessGrant(user.id, 'knowledge', kb.id, 'read'));
        if (!allowed) return ctx.error(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        collectionNames = [kb.id];
        sourceNames[kb.id] = kb.name ?? kb.id;
      } else if (form.collection_names && form.collection_names.length > 0) {
        collectionNames = form.collection_names;
        await validateCollectionAccess(collectionNames, user, 'read');
      } else {
        return ctx.error(422, 'knowledge_id or collection_names is required');
      }

      try {
        const k = form.k ?? (await configGet<number>('rag.top_k', 3));
        const sources = await queryKnowledgeSources(form.query, collectionNames, k, sourceNames);
        return ctx.json({ status: true, sources, collection_names: collectionNames });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return ctx.error(400, e instanceof Error ? e.message : 'Error querying knowledge base');
      }
    },
  },

  // ---- Delete entries from a collection (admin) ----
  {
    method: 'POST',
    path: 'delete',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<{ collection_name?: string; file_id?: string }>();
      if (!form?.collection_name || !form?.file_id) {
        return ctx.error(422, 'collection_name and file_id are required');
      }
      try {
        if (await hasCollection(form.collection_name)) {
          const file = await getFileById(form.file_id);
          if (!file) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
          if (file.hash === null || file.hash === undefined) {
            return ctx.error(400, 'File has no hash; cannot delete vector entries by hash.');
          }
          // our chunk store keys entries by file_id — the hash filter's
          // closest equivalent (documented deviation)
          await db.chunk.deleteMany({
            where: { collection_name: form.collection_name, file_id: form.file_id },
          });
          return ctx.json({ status: true });
        }
        return ctx.json({ status: false });
      } catch (e) {
        console.error(e);
        return ctx.json({ status: false });
      }
    },
  },

  // ---- Reset vector DB (admin) ----
  {
    method: 'POST',
    path: 'reset/db',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      await db.chunk.deleteMany({});
      // delete all knowledge (python Knowledges.delete_all_knowledge)
      const knowledgeIds = await db.knowledge.findMany({ select: { id: true } });
      for (const kb of knowledgeIds) {
        await db.accessGrant.deleteMany({ where: { resource_type: 'knowledge', resource_id: kb.id } });
      }
      await db.knowledgeFile.deleteMany({});
      await db.knowledgeDirectory.deleteMany({});
      await db.knowledge.deleteMany({});
      return ctx.json(null);
    },
  },

  // ---- Reset uploads (admin) ----
  {
    method: 'POST',
    path: 'reset/uploads',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      // no UPLOAD_DIR on serverless — the raw bytes live in file.data
      const rows = (await db.file.findMany({})) as Array<{ id: string; data: string | null }>;
      for (const row of rows) {
        const data = safeJson(row.data) ?? {};
        if ('content_base64' in data) {
          const { content_base64, ...rest } = data as Record<string, any>;
          void content_base64;
          await db.file.update({
            where: { id: row.id },
            data: { data: JSON.stringify(rest) },
          });
        }
      }
      return ctx.json(true);
    },
  },

  // ---- Batch process files ----
  {
    method: 'POST',
    path: 'process/files/batch',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<{
        files?: Array<{ id: string }>;
        collection_name?: string;
      }>();
      if (!form?.collection_name) return ctx.error(422, 'collection_name is required');
      const user = ctx.user!;
      const files: FileModel[] = [];
      for (const f of form.files ?? []) {
        const file = await getFileById(f.id);
        if (file) files.push(file);
      }
      const result = await processFilesBatch(user, { files, collection_name: form.collection_name });
      return ctx.json(result);
    },
  },
];

// ---------------------------------------------------------------------------
// /process/web handler
// ---------------------------------------------------------------------------

async function handleProcessWeb(ctx: Ctx): Promise<Response> {
  // MODE INVITÉ: web/YouTube attachment processing is locked for guests
  // (ChatGPT parity) — covers POST /process/web and /process/youtube.
  {
    const { isGuestUser } = await import('@/lib/guests');
    if (isGuestUser(ctx.user)) {
      ctx.error(
        403,
        'L’ajout de contenus web est réservé aux comptes gratuits. Créez un compte pour joindre des pages ou des vidéos.'
      );
    }
  }
  const form = await ctx.body<{ url?: string; collection_name?: string | null }>();
  if (!form?.url) return ctx.error(422, 'url is required');
  const user = ctx.user!;
  const process = (ctx.query.get('process') ?? 'true') !== 'false';
  const overwrite = (ctx.query.get('overwrite') ?? 'true') !== 'false';
  try {
    return ctx.json(await processWeb(user, { url: form.url, collection_name: form.collection_name }, process, overwrite));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return ctx.error(400, e instanceof Error ? e.message : 'Error querying knowledge base');
  }
}
