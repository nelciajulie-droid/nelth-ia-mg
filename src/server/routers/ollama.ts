import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import type { ApiUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { env, ERROR_MESSAGES } from '@/lib/constants';
import { configGet, configSet } from '@/lib/config';
import { hasAccessGrant } from '@/lib/access-control';
import { createHash } from 'node:crypto';
import { promises as fsp, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';

/**
 * Port of open_webui/routers/ollama.py (v0.12.5) — mounted at /ollama.
 *
 * Connection storage (TS-native, see @/lib/connections):
 *   config table key 'ollama.api.configs' → { [connKey]: { url, prefix_id?, key?, ... } }
 * plus the env default connection (OLLAMA_API_BASE_URL).
 *
 * Prefix convention: `${prefix_id}/${model}` (matches @/lib/connections
 * resolveConnection; Python used a '.' separator — see report).
 */

// ---------------------------------------------------------------------------
// Constants (env.py / ollama.py)
// ---------------------------------------------------------------------------

const MODEL_LIST_TIMEOUT_MS = 10_000; // AIOHTTP_CLIENT_TIMEOUT_MODEL_LIST
const CLIENT_TIMEOUT_MS = 300_000; // AIOHTTP_CLIENT_TIMEOUT
const STREAM_TIMEOUT_MS = 300_000;
const FILE_STREAM_CHUNK_SIZE = 1024 * 1024; // AIOHTTP_FILE_STREAM_CHUNK_SIZE

const BYPASS_MODEL_ACCESS_CONTROL = (process.env.BYPASS_MODEL_ACCESS_CONTROL ?? 'False').toLowerCase() === 'true';

const OLLAMA_API_DISABLED = 'The Ollama API is disabled. Please enable it to use this feature.';

/** ollama.py error strings (v0.12.5 constants.py values not present in @/lib/constants). */
const ERR = {
  SERVER_CONNECTION_ERROR: 'Nelth-AI: Server Connection Error',
  OLLAMA_NOT_FOUND: 'WebUI could not connect to Ollama',
  MODEL_NOT_FOUND: (name = '') => `Model '${name}' was not found`,
};

const UPLOAD_DIR = path.join(env.DATA_DIR, 'uploads');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function safeJson(s: string | null): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Deep model_dump(exclude_none=True) equivalent. */
function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripNulls) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out as unknown as T;
  }
  return value;
}

const STRIP_PROXY_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'server', 'date']);

function passthroughHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    if (!STRIP_PROXY_HEADERS.has(name.toLowerCase())) out[name] = value;
  });
  return out;
}

function retryHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const ra = res.headers.get('retry-after');
  if (ra !== null) out['retry-after'] = ra;
  const ram = res.headers.get('retry-after-ms');
  if (ram !== null) out['retry-after-ms'] = ram;
  return out;
}

/** Port of utils/headers.py get_headers_and_cookies (core subset). */
function upstreamHeaders(url: string, key: string | null | undefined, cfg: Record<string, any> = {}): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const authType = cfg.auth_type ?? 'bearer';
  if (authType === 'bearer' && key) headers.authorization = `Bearer ${key}`;
  return headers;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<any | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runtime config / connections
// ---------------------------------------------------------------------------

async function ollamaEnabled(): Promise<boolean> {
  return Boolean(await configGet<boolean | null>('ollama.enable', env.ENABLE_OLLAMA_API));
}

type ApiConfig = Record<string, any>;

type OllamaConn = {
  idx: number;
  key: string;
  url: string;
  apiKey: string;
  prefixId: string | null;
  enable: boolean;
  modelIds: string[];
  tags: string[];
  connectionType: string;
  config: ApiConfig;
};

function makeConn(idx: number, key: string, url: string, cfg: ApiConfig): OllamaConn {
  return {
    idx,
    key,
    url,
    apiKey: String(cfg.key ?? ''),
    prefixId: cfg.prefix_id ?? null,
    enable: cfg.enable !== false,
    modelIds: Array.isArray(cfg.model_ids) ? cfg.model_ids.map(String) : [],
    tags: Array.isArray(cfg.tags) ? cfg.tags : [],
    connectionType: cfg.connection_type ?? 'local',
    config: cfg,
  };
}

/** Detailed connection list (index-stable) — superset of @/lib/connections getOllamaConnections. */
async function getOllamaConnectionsDetailed(): Promise<OllamaConn[]> {
  const configs = await configGet<Record<string, ApiConfig> | null>('ollama.api.configs', null);
  const conns: OllamaConn[] = [];
  let idx = 0;
  if (configs && typeof configs === 'object') {
    for (const [key, cfg] of Object.entries(configs)) {
      if (!cfg || typeof cfg !== 'object' || !cfg.url) continue;
      conns.push(makeConn(idx++, key, String(cfg.url).replace(/\/+$/, ''), cfg));
    }
  }
  // env default connection (mirrors @/lib/connections — always present)
  conns.push(makeConn(idx++, 'default', env.OLLAMA_API_BASE_URL.replace(/\/+$/, ''), {}));
  return conns;
}

async function getConnection(urlIdx: number): Promise<OllamaConn> {
  const conns = await getOllamaConnectionsDetailed();
  const conn = conns[urlIdx];
  if (!conn) throw new HttpError(404, 'Connection not found');
  return conn;
}

// ---------------------------------------------------------------------------
// Model access control (utils/access_control.py check_model_access)
// ---------------------------------------------------------------------------

type ModelRow = { id: string; user_id: string | null; base_model_id: string | null; params: string | null };

async function getModelRow(id: string | null | undefined): Promise<ModelRow | null> {
  if (!id) return null;
  try {
    return await db.model.findUnique({ where: { id } });
  } catch {
    return null;
  }
}

async function checkModelAccess(user: ApiUser, row: ModelRow | null, bypass = BYPASS_MODEL_ACCESS_CONTROL): Promise<void> {
  if (bypass) return;
  if (user.role === 'admin') return;
  // PUBLIC-APP MODE: a model with no DB row carries no access restriction —
  // every member can use it (shared catalog, chatgpt-like).
  if (!row) return;
  if (row.user_id === user.id) return;
  if (await hasAccessGrant(user.id, 'model', row.id, 'read')) return;
  throw new HttpError(403, 'Model not found');
}

/** get_filtered_models — keep models the user can read. Models without a DB
 *  row are unrestricted (public, see PUBLIC-APP MODE); models with a row are
 *  owner/read-grant gated. */
async function filterModelsForUser(models: any[], user: ApiUser): Promise<any[]> {
  const ids = models.map((m) => String(m?.model ?? m?.id ?? '')).filter(Boolean);
  if (!ids.length) return [];
  let rows: ModelRow[] = [];
  try {
    rows = await db.model.findMany({ where: { id: { in: ids } } });
  } catch {
    return [];
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: any[] = [];
  for (const m of models) {
    const row = byId.get(String(m?.model ?? m?.id));
    if (!row) {
      out.push(m); // no DB row → no restriction → public
      continue;
    }
    if (row.user_id === user.id || (await hasAccessGrant(user.id, 'model', row.id, 'read'))) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payload transforms (utils/payload.py subset)
// ---------------------------------------------------------------------------

const OPEN_WEBUI_PARAMS = new Set([
  'stream_response',
  'stream_delta_chunk_size',
  'function_calling',
  'reasoning_tags',
  'compact_token_threshold',
  'system',
  'note_id',
  'tool_approval_mode',
  'model_controls',
]);

function removeOpenWebuiParams(params: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(params)) {
    if (OPEN_WEBUI_PARAMS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function parseMaybeJson(value: any): any {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function deepMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function mergeCustomParams(params: Record<string, any>): Record<string, any> {
  const customParams = params.custom_params;
  delete params.custom_params;
  if (customParams && typeof customParams === 'object') {
    const parsed: Record<string, any> = {};
    for (const [k, v] of Object.entries(customParams)) parsed[k] = parseMaybeJson(v);
    return deepMerge(params, parsed);
  }
  return params;
}

/** apply_model_params_to_body_openai — merges workspace model params into the request body. */
function applyModelParamsToBodyOpenai(params: Record<string, any>, formData: Record<string, any>): Record<string, any> {
  const p = mergeCustomParams(removeOpenWebuiParams(params ?? {}));
  const casters: Record<string, (v: any) => any> = {
    temperature: Number,
    top_p: Number,
    min_p: Number,
    max_tokens: Number,
    frequency_penalty: Number,
    presence_penalty: Number,
    reasoning_effort: String,
    seed: (v) => v,
    stop: (v) => v,
    logit_bias: (v) => v,
    response_format: (v) => v,
  };
  for (const [key, value] of Object.entries(p)) {
    if (value === null || value === undefined) continue;
    if (key in formData) continue;
    const cast = casters[key];
    formData[key] = cast ? cast(value) : value;
  }
  return formData;
}

const OLLAMA_ROOT_PARAMS = ['format', 'keep_alive', 'think'];

/** apply_model_params_to_body_ollama — OpenAI-ish params become Ollama `options`. */
function applyModelParamsToBodyOllama(params: Record<string, any>, formData: Record<string, any>): Record<string, any> {
  let p = mergeCustomParams(removeOpenWebuiParams(params ?? {}));
  if (p.max_tokens !== undefined && p.max_tokens !== null) {
    p.num_predict = p.max_tokens;
    delete p.max_tokens;
  }
  for (const key of OLLAMA_ROOT_PARAMS) {
    if (p[key] !== undefined && p[key] !== null) {
      formData[key] = parseMaybeJson(p[key]);
      delete p[key];
    }
  }
  const options = { ...((formData.options as Record<string, any>) ?? {}) };
  for (const [key, value] of Object.entries(p)) {
    if (value === null || value === undefined) continue;
    if (key in options) continue;
    options[key] = value;
  }
  formData.options = options;
  return formData;
}

/** apply_system_prompt_to_body (simplified variable rendering). */
function applySystemPromptToBody(
  system: unknown,
  formData: Record<string, any>,
  metadata: Record<string, any> | null,
  user: ApiUser
): Record<string, any> {
  if (!system || typeof system !== 'string') return formData;
  let content = system;
  const variables: Record<string, any> = { ...(metadata?.variables ?? {}) };
  if (user) variables['{{USER_NAME}}'] = user.name;
  for (const [k, v] of Object.entries(variables)) {
    content = content.split(k).join(String(v ?? ''));
  }
  const messages = Array.isArray(formData.messages) ? [...formData.messages] : [];
  if (messages.length && messages[0]?.role === 'system') {
    messages[0] = { ...messages[0], content };
  } else {
    messages.unshift({ role: 'system', content });
  }
  formData.messages = messages;
  return formData;
}

// ---------------------------------------------------------------------------
// Model aggregation (get_all_models / merge_models_lists / get_ollama_loaded_models)
// ---------------------------------------------------------------------------

const MODELS_CACHE_TTL_MS = Math.max(0, Number(process.env.MODELS_CACHE_TTL ?? '1') || 1) * 1000;
let allModelsCache: { at: number; data: any[] } | null = null;

function clearModelsCache(): void {
  allModelsCache = null;
}

function mergeModelsLists(modelLists: (any[] | null)[]): any[] {
  const merged: Record<string, any> = {};
  modelLists.forEach((entries, idx) => {
    if (!entries) return;
    for (const entry of entries) {
      const modelId = entry?.model;
      if (modelId === null || modelId === undefined) continue;
      const key = String(modelId);
      if (!(key in merged)) {
        merged[key] = { ...entry, urls: [idx] };
      } else {
        merged[key].urls.push(idx);
      }
    }
  });
  return Object.values(merged);
}

function applyPrefix(value: string, prefixId: string | null): string {
  return prefixId ? `${prefixId}/${value}` : value;
}

/** GET /api/ps aggregation — models currently loaded across all backends. */
async function getLoadedModels(skipIdxs?: Set<number>): Promise<{ models: any[] }> {
  if (!(await ollamaEnabled())) return { models: [] };
  const conns = await getOllamaConnectionsDetailed();
  const responses = await Promise.all(
    conns.map((conn) => {
      if (skipIdxs?.has(conn.idx)) return Promise.resolve(null);
      if (!conn.enable) return Promise.resolve(null);
      return fetchJson(`${conn.url}/api/ps`, upstreamHeaders(conn.url, conn.apiKey, conn.config));
    })
  );
  responses.forEach((response, idx) => {
    if (!response) return;
    const conn = conns[idx];
    if (conn.prefixId) {
      for (const m of response?.models ?? []) {
        m.model = applyPrefix(String(m.model ?? ''), conn.prefixId);
      }
    }
  });
  return { models: mergeModelsLists(responses.map((r) => (r && Array.isArray(r.models) ? r.models : null))) };
}

async function getAllOllamaModels(): Promise<{ models: any[] }> {
  if (allModelsCache && Date.now() - allModelsCache.at < MODELS_CACHE_TTL_MS) {
    return { models: allModelsCache.data };
  }
  if (!(await ollamaEnabled())) {
    allModelsCache = { at: Date.now(), data: [] };
    return { models: [] };
  }
  const conns = await getOllamaConnectionsDetailed();

  // Fan-out tag requests to every enabled backend.
  const responses = await Promise.all(
    conns.map((conn) => {
      if (!conn.enable) return Promise.resolve(null);
      return fetchJson(`${conn.url}/api/tags`, upstreamHeaders(conn.url, conn.apiKey, conn.config));
    })
  );

  // Track which backends failed so we can skip them for /api/ps.
  const failedIdxs = new Set<number>();

  // Post-process each response: prefix_id, tags, model filtering, connection_type.
  responses.forEach((response, idx) => {
    if (!response) {
      failedIdxs.add(idx);
      return;
    }
    const conn = conns[idx];
    if (conn.modelIds.length && Array.isArray(response.models)) {
      response.models = response.models.filter((m: any) => conn.modelIds.includes(String(m?.model)));
    }
    for (const m of response?.models ?? []) {
      if (conn.prefixId) {
        m.model = applyPrefix(String(m.model ?? ''), conn.prefixId);
        if (m.name) m.name = applyPrefix(String(m.name), conn.prefixId);
      }
      if (conn.tags.length) m.tags = conn.tags;
      if (conn.connectionType) m.connection_type = conn.connectionType;
    }
  });

  const models = mergeModelsLists(responses.map((r) => (r && Array.isArray(r.models) ? r.models : null)));

  // Annotate with expiry info from loaded-model state (best effort).
  try {
    const loaded = await getLoadedModels(failedIdxs);
    const expiresMap = new Map<string, number>();
    for (const m of loaded.models) {
      if (m?.expires_at) {
        const ts = Date.parse(String(m.expires_at));
        if (!Number.isNaN(ts)) expiresMap.set(String(m.model), Math.floor(ts / 1000));
      }
    }
    for (const m of models) {
      const expiresAt = expiresMap.get(String(m.model));
      if (expiresAt !== undefined) m.expires_at = expiresAt;
    }
  } catch {
    /* best effort */
  }

  allModelsCache = { at: Date.now(), data: models };
  return { models };
}

// ---------------------------------------------------------------------------
// Request routing helpers (get_ollama_url / validate_ollama_backend_idx)
// ---------------------------------------------------------------------------

function stripProviderModelPrefix(model: string, prefixId: string | null | undefined): string {
  if (prefixId && model.startsWith(`${prefixId}/`)) return model.slice(prefixId.length + 1);
  return model;
}

async function validateBackendIdx(model: string, urlIdx: number | null, user: ApiUser | null): Promise<void> {
  if (urlIdx === null || urlIdx === undefined) return;
  if (!user || user.role === 'admin') return;
  const { models } = await getAllOllamaModels();
  const entry = models.find((m) => String(m?.model) === model);
  if (!entry || !(entry.urls ?? []).includes(urlIdx)) {
    throw new HttpError(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
  }
}

async function getOllamaUrl(
  model: string,
  urlIdx: number | null,
  user: ApiUser | null
): Promise<{ url: string; urlIdx: number; conn: OllamaConn }> {
  await validateBackendIdx(model, urlIdx, user);
  let idx = urlIdx;
  if (idx === null || idx === undefined) {
    const { models } = await getAllOllamaModels();
    const entry = models.find((m) => String(m?.model) === model);
    if (!entry || !(entry.urls ?? []).length) throw new HttpError(400, ERR.MODEL_NOT_FOUND(model));
    const urls: number[] = entry.urls;
    idx = urls[Math.floor(Math.random() * urls.length)];
  }
  const conn = await getConnection(idx);
  return { url: conn.url, urlIdx: idx, conn };
}

// ---------------------------------------------------------------------------
// send_request — the core proxy helper
// ---------------------------------------------------------------------------

async function sendRequest(
  url: string,
  method: string,
  opts: {
    payload?: string | null;
    key?: string | null;
    stream?: boolean;
    contentType?: string | null;
    config?: ApiConfig;
  } = {}
): Promise<Response> {
  const headers = upstreamHeaders(url, opts.key, opts.config ?? {});
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.payload ?? undefined,
      signal: AbortSignal.timeout(opts.stream ? STREAM_TIMEOUT_MS : CLIENT_TIMEOUT_MS),
    });
  } catch (e) {
    throw new HttpError(500, `Ollama: ${e instanceof Error ? e.message : e}`);
  }

  if (!res.ok) {
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const detail = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
      void retryHeaders(res); // retry-after headers cannot travel through HttpError (dispatcher limitation)
      throw new HttpError(res.status, detail);
    }
    throw new HttpError(res.status, ERR.SERVER_CONNECTION_ERROR);
  }

  if (opts.stream) {
    const responseHeaders = passthroughHeaders(res);
    if (opts.contentType) responseHeaders['content-type'] = opts.contentType;
    return new Response(res.body, { status: res.status, headers: responseHeaders });
  }

  const text = await res.text();
  try {
    return jsonResponse(text ? JSON.parse(text) : null);
  } catch {
    return jsonResponse(null);
  }
}

// ---------------------------------------------------------------------------
// Version comparison (GET /api/version)
// ---------------------------------------------------------------------------

function versionKey(v: unknown): number[] {
  const cleaned = String(v ?? '').replace(/^v/, '').replace(/-.*$/, '');
  return cleaned.split('.').map((part) => {
    const n = parseInt(part, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Blob download / upload (models/download, models/upload)
// ---------------------------------------------------------------------------

function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(generator: AsyncGenerator<string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of generator) controller.enqueue(encoder.encode(event));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        try {
          controller.enqueue(encoder.encode(sseEvent({ error: message })));
        } catch {
          /* controller closed */
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

function parseHuggingFaceUrl(hfUrl: string): string | null {
  try {
    const parts = new URL(hfUrl).pathname.split('/');
    return parts[parts.length - 1] || null;
  } catch {
    return null;
  }
}

async function postBlob(ollamaUrl: string, hashed: string, filePath: string, headers: Record<string, string>): Promise<void> {
  const blobSize = (await fsp.stat(filePath)).size;
  const init = {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(blobSize) },
    body: Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>,
    duplex: 'half',
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
  };
  const res = await fetch(`${ollamaUrl}/api/blobs/sha256:${hashed}`, init as unknown as RequestInit);
  if (!res.ok) throw new Error('Ollama: Could not create blob, Please try again.');
}

async function createModelFromBlob(
  ollamaUrl: string,
  fileName: string,
  hashed: string,
  headers: Record<string, string>
): Promise<void> {
  const model = fileName.replace(/\.[^.]+$/, '');
  const res = await fetch(`${ollamaUrl}/api/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, files: { [fileName]: `sha256:${hashed}` }, stream: false }),
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Failed to create model in Ollama. ${await res.text()}`);
}

/** Stream a model file download from fileUrl, then push the blob to Ollama. */
async function* downloadFileStream(
  ollamaUrl: string,
  fileUrl: string,
  filePath: string,
  fileName: string,
  ollamaHeaders: Record<string, string>
): AsyncGenerator<string> {
  let currentSize = 0;
  try {
    currentSize = (await fsp.stat(filePath)).size;
  } catch {
    currentSize = 0;
  }
  const headers: Record<string, string> = {};
  if (currentSize > 0) headers.range = `bytes=${currentSize}-`;

  const res = await fetch(fileUrl, { headers, signal: AbortSignal.timeout(600_000) });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP Error: ${res.status}`);
  if (!res.body) throw new Error('Empty download response body');

  const totalSize = Number(res.headers.get('content-length') ?? 0) + currentSize;
  const hash = createHash('sha256');

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const fileHandle = await fsp.open(filePath, 'a');
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await fileHandle.write(value);
      hash.update(value);
      currentSize += value.byteLength;
      const progressTotal = totalSize || currentSize;
      const progress = Math.round((currentSize / progressTotal) * 10000) / 100;
      yield sseEvent({ progress, completed: currentSize, total: totalSize });
    }
  } finally {
    await fileHandle.close();
  }

  const hashed = hash.digest('hex');
  await postBlob(ollamaUrl, hashed, filePath, ollamaHeaders);
  await fsp.unlink(filePath).catch(() => {});
  await createModelFromBlob(ollamaUrl, fileName, hashed, ollamaHeaders);
  yield sseEvent({ done: true, blob: `sha256:${hashed}`, name: fileName, model_created: fileName.replace(/\.[^.]+$/, '') });
}

// ---------------------------------------------------------------------------
// Config endpoints
// ---------------------------------------------------------------------------

async function getOllamaConfig(): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  const enable = await configGet<boolean | null>('ollama.enable', null);
  if (enable !== null) values.ENABLE_OLLAMA_API = enable;
  const configs = await configGet<Record<string, ApiConfig> | null>('ollama.api.configs', null);
  if (configs && typeof configs === 'object') {
    const baseUrls: string[] = [];
    const apiConfigs: Record<string, any> = {};
    for (const [key, cfg] of Object.entries(configs)) {
      if (!cfg || typeof cfg !== 'object' || !cfg.url) continue;
      baseUrls.push(String(cfg.url));
      const { url, ...rest } = cfg;
      apiConfigs[key] = rest;
    }
    values.OLLAMA_BASE_URLS = baseUrls;
    values.OLLAMA_API_CONFIGS = apiConfigs;
  }
  return values;
}

async function persistOllamaConfig(enable: boolean | null, configs: Record<string, ApiConfig>): Promise<void> {
  await configSet('ollama.enable', enable);
  await configSet('ollama.api.configs', configs);
  clearModelsCache();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ------------------------------------------------------------------
  // GET /ollama/ — health-check
  // ------------------------------------------------------------------
  {
    method: 'GET',
    path: '',
    auth: 'none',
    handler: async () => jsonResponse({ status: true }),
  },

  // ------------------------------------------------------------------
  // POST /ollama/verify — admin: verify an Ollama backend
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'verify',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<any>();
      const url = String(form?.url ?? '').replace(/\/+$/, '');
      const key = form?.key ? String(form.key) : '';
      const cfg = form?.config && typeof form.config === 'object' ? form.config : {};
      if (!url) ctx.error(422, 'Field required (url)');
      try {
        const res = await fetch(`${url}/api/version`, {
          headers: upstreamHeaders(url, key, cfg),
          signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
        });
        if (res.status !== 200) {
          let detail = `HTTP Error: ${res.status}`;
          try {
            const parsed = await res.json();
            if (parsed?.error !== undefined) {
              detail = `External Error: ${typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)}`;
            }
          } catch {
            /* keep default */
          }
          throw new Error(detail);
        }
        return ctx.json(await res.json());
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(500, `Unexpected error: ${e instanceof Error ? e.message : e}`);
      }
    },
  },

  // ------------------------------------------------------------------
  // GET /ollama/config — admin: current connection configuration
  // ------------------------------------------------------------------
  {
    method: 'GET',
    path: 'config',
    auth: 'admin',
    handler: async (ctx: Ctx) => ctx.json(await getOllamaConfig()),
  },

  // ------------------------------------------------------------------
  // POST /ollama/config/update — admin: update connections
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'config/update',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<any>();
      const enable = form?.ENABLE_OLLAMA_API ?? null;

      // TS-native dict-of-connections body: { configs: { key: { url, prefix_id?, key? } } }
      if (form?.configs && typeof form.configs === 'object' && !Array.isArray(form.configs)) {
        const cleaned: Record<string, ApiConfig> = {};
        for (const [key, cfg] of Object.entries(form.configs as Record<string, any>)) {
          if (!cfg || typeof cfg !== 'object' || !cfg.url) continue;
          cleaned[key] = cfg;
        }
        await persistOllamaConfig(enable, cleaned);
        return ctx.json({ ENABLE_OLLAMA_API: enable, OLLAMA_API_CONFIGS: cleaned });
      }

      const baseUrls: string[] = Array.isArray(form?.OLLAMA_BASE_URLS) ? form.OLLAMA_BASE_URLS.map(String) : [];
      if (!Array.isArray(form?.OLLAMA_BASE_URLS)) {
        ctx.error(422, 'Field required (OLLAMA_BASE_URLS)');
      }
      const validKeys = new Set(baseUrls.map((_, i) => String(i)));
      const apiConfigs: Record<string, any> = {};
      for (const [key, value] of Object.entries(form?.OLLAMA_API_CONFIGS ?? {})) {
        if (validKeys.has(key)) apiConfigs[key] = value;
      }
      const merged: Record<string, ApiConfig> = {};
      baseUrls.forEach((baseUrl, i) => {
        merged[String(i)] = { ...(apiConfigs[String(i)] ?? {}), url: baseUrl };
      });
      await persistOllamaConfig(enable, merged);

      return ctx.json({
        ENABLE_OLLAMA_API: enable,
        OLLAMA_BASE_URLS: baseUrls,
        OLLAMA_API_CONFIGS: apiConfigs,
      });
    },
  },

  // ------------------------------------------------------------------
  // GET /ollama/api/tags[/{url_idx}] — model tags across backends
  // ------------------------------------------------------------------
  {
    method: 'GET',
    path: 'api/tags',
    auth: 'user',
    handler: async (ctx: Ctx) => handleTags(ctx, null),
  },
  {
    method: 'GET',
    path: 'api/tags/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleTags(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // GET /ollama/api/ps — admin: models currently loaded in memory
  // ------------------------------------------------------------------
  {
    method: 'GET',
    path: 'api/ps',
    auth: 'admin',
    handler: async (ctx: Ctx) => ctx.json(await getLoadedModels()),
  },

  // ------------------------------------------------------------------
  // GET /ollama/api/version[/{url_idx}] — lowest version across backends
  // ------------------------------------------------------------------
  {
    method: 'GET',
    path: 'api/version',
    auth: 'user',
    handler: async (ctx: Ctx) => handleVersion(ctx, null),
  },
  {
    method: 'GET',
    path: 'api/version/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleVersion(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // POST /ollama/api/unload — admin: unload a model from every backend
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'api/unload',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<any>();
      let model = form?.model ?? form?.name;
      if (model === null || model === undefined || String(model) === '') {
        throw new HttpError(400, 'Missing name of the model to unload.');
      }
      model = String(model);

      const { models } = await getAllOllamaModels();
      const entry = models.find((m) => String(m?.model) === model);
      if (!entry) throw new HttpError(400, ERR.MODEL_NOT_FOUND(model));
      const urlIndices: number[] = entry.urls ?? [];
      const conns = await getOllamaConnectionsDetailed();

      const errors: any[] = [];
      for (const idx of urlIndices) {
        const conn = conns[idx];
        if (!conn) continue;
        let actualModel = model;
        if (conn.prefixId && actualModel.startsWith(`${conn.prefixId}/`)) {
          actualModel = actualModel.slice(conn.prefixId.length + 1);
        }
        const payload = { model: actualModel, keep_alive: 0, prompt: '' };
        try {
          const res = await sendRequest(`${conn.url}/api/generate`, 'POST', {
            payload: JSON.stringify(payload),
            key: conn.apiKey,
            config: conn.config,
          });
          void res;
        } catch (e) {
          errors.push({
            url_idx: idx,
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      clearModelsCache();

      if (errors.length > 0) {
        throw new HttpError(500, `Failed to unload model on ${errors.length} nodes: ${JSON.stringify(errors)}`);
      }
      return ctx.json({ status: true });
    },
  },

  // ------------------------------------------------------------------
  // POST /ollama/api/pull[/{url_idx}] — admin: pull a model (streamed)
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'api/pull',
    auth: 'admin',
    handler: async (ctx: Ctx) => handlePull(ctx, 0),
  },
  {
    method: 'POST',
    path: 'api/pull/:urlIdx',
    auth: 'admin',
    handler: async (ctx: Ctx) => handlePull(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // DELETE /ollama/api/push[/{url_idx}] — admin: push a model (streamed)
  // ------------------------------------------------------------------
  {
    method: 'DELETE',
    path: 'api/push',
    auth: 'admin',
    handler: async (ctx: Ctx) => handlePush(ctx, null),
  },
  {
    method: 'DELETE',
    path: 'api/push/:urlIdx',
    auth: 'admin',
    handler: async (ctx: Ctx) => handlePush(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // POST /ollama/api/create[/{url_idx}] — admin: create a model (streamed)
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'api/create',
    auth: 'admin',
    handler: async (ctx: Ctx) => handleCreate(ctx, 0),
  },
  {
    method: 'POST',
    path: 'api/create/:urlIdx',
    auth: 'admin',
    handler: async (ctx: Ctx) => handleCreate(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // POST /ollama/api/copy[/{url_idx}] — admin: duplicate a model
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'api/copy',
    auth: 'admin',
    handler: async (ctx: Ctx) => handleCopy(ctx, null),
  },
  {
    method: 'POST',
    path: 'api/copy/:urlIdx',
    auth: 'admin',
    handler: async (ctx: Ctx) => handleCopy(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // DELETE /ollama/api/delete[/{url_idx}] — admin: remove a model
  // ------------------------------------------------------------------
  {
    method: 'DELETE',
    path: 'api/delete',
    auth: 'admin',
    handler: async (ctx: Ctx) => handleDelete(ctx, null),
  },
  {
    method: 'DELETE',
    path: 'api/delete/:urlIdx',
    auth: 'admin',
    handler: async (ctx: Ctx) => handleDelete(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // POST /ollama/api/show — model metadata
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'api/show',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
      const user = ctx.user!;
      const raw = await ctx.body<any>();
      const payload = stripNulls(raw ?? {});
      payload.model = payload.model ?? payload.name;
      const model = String(payload.model ?? '');

      await checkModelAccess(user, await getModelRow(model));

      const { models } = await getAllOllamaModels();
      const entry = models.find((m) => String(m?.model) === model);
      if (!entry || !(entry.urls ?? []).length) throw new HttpError(400, ERR.MODEL_NOT_FOUND(model));

      const urls: number[] = entry.urls;
      const urlIdx = urls[Math.floor(Math.random() * urls.length)];
      const conn = await getConnection(urlIdx);

      return sendRequest(`${conn.url}/api/show`, 'POST', {
        payload: JSON.stringify(payload),
        key: conn.apiKey,
        config: conn.config,
      });
    },
  },

  // ------------------------------------------------------------------
  // POST /ollama/api/embed[/{url_idx}] — batch embeddings
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'api/embed',
    auth: 'user',
    handler: async (ctx: Ctx) => handleEmbed(ctx, 'embed', ctx.params.urlIdx ? Number(ctx.params.urlIdx) : null),
  },
  {
    method: 'POST',
    path: 'api/embed/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleEmbed(ctx, 'embed', Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // POST /ollama/api/embeddings[/{url_idx}] — legacy single-prompt embeddings
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'api/embeddings',
    auth: 'user',
    handler: async (ctx: Ctx) => handleEmbed(ctx, 'embeddings', ctx.params.urlIdx ? Number(ctx.params.urlIdx) : null),
  },
  {
    method: 'POST',
    path: 'api/embeddings/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleEmbed(ctx, 'embeddings', Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // POST /ollama/api/generate[/{url_idx}] — text completion (always streamed)
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'api/generate',
    auth: 'user',
    handler: async (ctx: Ctx) => handleGenerate(ctx, null),
  },
  {
    method: 'POST',
    path: 'api/generate/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleGenerate(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // POST /ollama/api/chat[/{url_idx}] — chat completion (NDJSON stream)
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'api/chat',
    auth: 'user',
    handler: async (ctx: Ctx) => handleChat(ctx, null),
  },
  {
    method: 'POST',
    path: 'api/chat/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleChat(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // OpenAI-compatible proxies under /ollama/v1/*
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'v1/completions',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1Completions(ctx, null),
  },
  {
    method: 'POST',
    path: 'v1/completions/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1Completions(ctx, Number(ctx.params.urlIdx)),
  },
  {
    method: 'POST',
    path: 'v1/embeddings',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1Embeddings(ctx, null),
  },
  {
    method: 'POST',
    path: 'v1/embeddings/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1Embeddings(ctx, Number(ctx.params.urlIdx)),
  },
  {
    method: 'POST',
    path: 'v1/chat/completions',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1ChatCompletions(ctx, null),
  },
  {
    method: 'POST',
    path: 'v1/chat/completions/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1ChatCompletions(ctx, Number(ctx.params.urlIdx)),
  },
  {
    method: 'POST',
    path: 'v1/messages',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1Messages(ctx, null),
  },
  {
    method: 'POST',
    path: 'v1/messages/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1Messages(ctx, Number(ctx.params.urlIdx)),
  },
  {
    method: 'POST',
    path: 'v1/responses',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1Responses(ctx, null),
  },
  {
    method: 'POST',
    path: 'v1/responses/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1Responses(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // GET /ollama/v1/models[/{url_idx}] — OpenAI-shaped model list
  // ------------------------------------------------------------------
  {
    method: 'GET',
    path: 'v1/models',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1Models(ctx, null),
  },
  {
    method: 'GET',
    path: 'v1/models/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => handleV1Models(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // POST /ollama/models/download[/{url_idx}] — admin: GGUF from HF/GitHub
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'models/download',
    auth: 'admin',
    handler: async (ctx: Ctx) => handleModelDownload(ctx, 0),
  },
  {
    method: 'POST',
    path: 'models/download/:urlIdx',
    auth: 'admin',
    handler: async (ctx: Ctx) => handleModelDownload(ctx, Number(ctx.params.urlIdx)),
  },

  // ------------------------------------------------------------------
  // POST /ollama/models/upload[/{url_idx}] — admin: upload a model file
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'models/upload',
    auth: 'admin',
    handler: async (ctx: Ctx) => handleModelUpload(ctx, 0),
  },
  {
    method: 'POST',
    path: 'models/upload/:urlIdx',
    auth: 'admin',
    handler: async (ctx: Ctx) => handleModelUpload(ctx, Number(ctx.params.urlIdx)),
  },
];

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

async function handleTags(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  const user = ctx.user!;
  if (urlIdx !== null && user.role !== 'admin') throw new HttpError(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);

  let result: { models: any[] };
  if (urlIdx === null) {
    result = await getAllOllamaModels();
  } else {
    const conn = await getConnection(urlIdx);
    const res = await sendRequest(`${conn.url}/api/tags`, 'GET', {
      key: conn.apiKey,
      config: conn.config,
    });
    const parsed = await res.json().catch(() => null);
    result = { models: Array.isArray(parsed?.models) ? parsed.models : [] };
  }

  if (user.role === 'user' && !BYPASS_MODEL_ACCESS_CONTROL) {
    result.models = await filterModelsForUser(result.models, user);
  }
  return ctx.json(result);
}

async function handleVersion(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  const user = ctx.user!;
  if (urlIdx !== null && user.role !== 'admin') throw new HttpError(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
  if (!(await ollamaEnabled())) return ctx.json({ version: false });

  if (urlIdx !== null) {
    const conn = await getConnection(urlIdx);
    return sendRequest(`${conn.url}/api/version`, 'GET', { key: conn.apiKey, config: conn.config });
  }

  // Fan-out to every enabled backend and return the lowest version.
  const conns = await getOllamaConnectionsDetailed();
  const raw = await Promise.all(
    conns
      .filter((conn) => conn.enable)
      .map((conn) => fetchJson(`${conn.url}/api/version`, upstreamHeaders(conn.url, conn.apiKey, conn.config)))
  );
  const valid = raw.filter((r): r is Record<string, any> => r !== null && typeof r.version === 'string');
  if (!valid.length) {
    // No reachable Ollama backend: answer 200 {"version": false} instead of
    // the Python 500 — the compiled frontend's getOllamaVersion runs
    // `if (!res.ok) throw await res.json()` on every non-OK body, and any
    // HTML error page (dev-mode recompile window) then surfaces as
    // "Unexpected token '<' ... is not valid JSON". `version: false` is the
    // frontend's own "Ollama absent" signal (identical to the disabled path).
    return ctx.json({ version: false });
  }

  const lowest = valid.reduce((min, cur) =>
    compareVersions(versionKey(cur.version), versionKey(min.version)) < 0 ? cur : min
  );
  return ctx.json({ version: lowest.version });
}

async function handlePull(ctx: Ctx, urlIdx: number): Promise<Response> {
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
  const raw = await ctx.body<any>();
  const form = stripNulls<Record<string, any>>(raw ?? {});
  if (form.model === undefined && form.name !== undefined) form.model = form.name;
  form.insecure = true; // Admins may pull from any registry
  const conn = await getConnection(urlIdx);
  return sendRequest(`${conn.url}/api/pull`, 'POST', {
    payload: JSON.stringify(form),
    key: conn.apiKey,
    stream: true,
    config: conn.config,
  });
}

async function handlePush(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
  const raw = await ctx.body<any>();
  const form = stripNulls<Record<string, any>>(raw ?? {});
  if (typeof form.model !== 'string' || !form.model) ctx.error(422, 'Field required (model)');

  let idx = urlIdx;
  if (idx === null) {
    const { models } = await getAllOllamaModels();
    const entry = models.find((m) => String(m?.model) === form.model);
    if (!entry || !(entry.urls ?? []).length) throw new HttpError(400, ERR.MODEL_NOT_FOUND(form.model));
    idx = Number(entry.urls[0]);
  }
  const conn = await getConnection(idx);
  return sendRequest(`${conn.url}/api/push`, 'DELETE', {
    payload: JSON.stringify(form),
    key: conn.apiKey,
    stream: true,
    config: conn.config,
  });
}

async function handleCreate(ctx: Ctx, urlIdx: number): Promise<Response> {
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
  const raw = await ctx.body<any>();
  const form = stripNulls<Record<string, any>>(raw ?? {});
  const conn = await getConnection(urlIdx);
  return sendRequest(`${conn.url}/api/create`, 'POST', {
    payload: JSON.stringify(form),
    key: conn.apiKey,
    stream: true,
    config: conn.config,
  });
}

async function handleCopy(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
  const raw = await ctx.body<any>();
  const form = stripNulls<Record<string, any>>(raw ?? {});
  if (typeof form.source !== 'string' || !form.source) ctx.error(422, 'Field required (source)');
  if (typeof form.destination !== 'string' || !form.destination) ctx.error(422, 'Field required (destination)');

  let idx = urlIdx;
  if (idx === null) {
    const { models } = await getAllOllamaModels();
    const entry = models.find((m) => String(m?.model) === form.source);
    if (!entry || !(entry.urls ?? []).length) throw new HttpError(400, ERR.MODEL_NOT_FOUND(form.source));
    idx = Number(entry.urls[0]);
  }
  const conn = await getConnection(idx);
  await sendRequest(`${conn.url}/api/copy`, 'POST', {
    payload: JSON.stringify(form),
    key: conn.apiKey,
    config: conn.config,
  });
  return ctx.json(true);
}

async function handleDelete(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
  const raw = await ctx.body<any>();
  const payload = stripNulls<Record<string, any>>(raw ?? {});
  payload.model = payload.model ?? payload.name;
  const model = String(payload.model ?? '');
  if (!model) ctx.error(422, 'Field required (model)');

  let idx = urlIdx;
  if (idx === null) {
    const { models } = await getAllOllamaModels();
    const entry = models.find((m) => String(m?.model) === model);
    if (!entry || !(entry.urls ?? []).length) throw new HttpError(400, ERR.MODEL_NOT_FOUND(model));
    idx = Number(entry.urls[0]);
  }
  const conn = await getConnection(idx);
  await sendRequest(`${conn.url}/api/delete`, 'DELETE', {
    payload: JSON.stringify(payload),
    key: conn.apiKey,
    config: conn.config,
  });
  return ctx.json(true);
}

async function handleEmbed(ctx: Ctx, endpoint: 'embed' | 'embeddings', urlIdx: number | null): Promise<Response> {
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
  const user = ctx.user!;
  const raw = await ctx.body<any>();
  if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string') {
    ctx.error(422, 'Field required (model)');
  }
  const form = stripNulls<Record<string, any>>(raw);
  if (endpoint === 'embed' && (form.input === undefined || form.input === null)) {
    ctx.error(422, 'Field required (input)');
  }
  if (endpoint === 'embeddings' && typeof form.prompt !== 'string') {
    ctx.error(422, 'Field required (prompt)');
  }

  await checkModelAccess(user, await getModelRow(form.model));
  await validateBackendIdx(String(form.model), urlIdx, user);

  let idx = urlIdx;
  if (idx === null) {
    const { models } = await getAllOllamaModels();
    const entry = models.find((m) => String(m?.model) === form.model);
    if (!entry || !(entry.urls ?? []).length) throw new HttpError(400, ERR.MODEL_NOT_FOUND(form.model));
    const urls: number[] = entry.urls;
    idx = urls[Math.floor(Math.random() * urls.length)];
  }
  const conn = await getConnection(idx);
  form.model = stripProviderModelPrefix(String(form.model), conn.prefixId);

  return sendRequest(`${conn.url}/api/${endpoint}`, 'POST', {
    payload: JSON.stringify(form),
    key: conn.apiKey,
    config: conn.config,
  });
}

async function handleGenerate(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
  const user = ctx.user!;
  const raw = await ctx.body<any>();
  if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string') {
    ctx.error(422, 'Field required (model)');
  }
  const metadata = raw.metadata ?? null;
  const form = stripNulls<Record<string, any>>(raw);
  delete form.metadata;

  await checkModelAccess(user, await getModelRow(form.model));
  await validateBackendIdx(String(form.model), urlIdx, user);

  let idx = urlIdx;
  if (idx === null) {
    const { models } = await getAllOllamaModels();
    const entry = models.find((m) => String(m?.model) === form.model);
    if (!entry || !(entry.urls ?? []).length) throw new HttpError(400, ERR.MODEL_NOT_FOUND(form.model));
    const urls: number[] = entry.urls;
    idx = urls[Math.floor(Math.random() * urls.length)];
  }
  const conn = await getConnection(idx);
  form.model = stripProviderModelPrefix(String(form.model), conn.prefixId);

  return sendRequest(`${conn.url}/api/generate`, 'POST', {
    payload: JSON.stringify(form),
    key: conn.apiKey,
    stream: true, // Ollama /api/generate always streams NDJSON
    config: conn.config,
  });
}

async function handleChat(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
  const user = ctx.user!;
  const raw = await ctx.body<any>();
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Invalid payload');
  const metadata = raw.metadata ?? null;

  // GenerateChatCompletionForm validation
  if (typeof raw.model !== 'string') throw new HttpError(400, 'Field required (model)');
  if (!Array.isArray(raw.messages)) throw new HttpError(400, 'Field required (messages)');
  for (const message of raw.messages) {
    if (!message || typeof message !== 'object' || typeof message.role !== 'string') {
      throw new HttpError(400, 'Field required (role)');
    }
    if ((message.content === null || message.content === undefined) && !message.tool_calls) {
      throw new HttpError(400, "At least one of 'content' or 'tool_calls' must be provided");
    }
  }
  if (raw.stream === undefined) raw.stream = true; // pydantic default
  const payload = stripNulls<Record<string, any>>(raw);
  delete payload.metadata;
  const stream = Boolean(payload.stream ?? false);

  const modelId = String(payload.model);
  const row = await getModelRow(modelId);
  if (row) {
    if (row.base_model_id) payload.model = row.base_model_id;
    const params = safeJson(row.params);
    if (params && typeof params === 'object' && Object.keys(params).length) {
      const { system, ...rest } = params as Record<string, any>;
      applyModelParamsToBodyOllama(rest, payload);
      applySystemPromptToBody(system, payload, metadata, user);
    }
    await checkModelAccess(user, row);
  } else {
    await checkModelAccess(user, null);
  }

  const { url, conn } = await getOllamaUrl(String(payload.model), urlIdx, user);
  payload.model = stripProviderModelPrefix(String(payload.model), conn.prefixId);

  return sendRequest(`${url}/api/chat`, 'POST', {
    payload: JSON.stringify(payload),
    key: conn.apiKey,
    stream,
    contentType: 'application/x-ndjson',
    config: conn.config,
  });
}

async function handleV1Completions(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  const user = ctx.user!;
  const raw = await ctx.body<any>();
  if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string') {
    throw new HttpError(400, 'Field required (model)');
  }
  if (typeof raw.prompt !== 'string') throw new HttpError(400, 'Field required (prompt)');
  const metadata = raw.metadata ?? null;
  const payload = stripNulls<Record<string, any>>(raw);
  delete payload.metadata;

  const modelId = String(payload.model);
  const row = await getModelRow(modelId);
  if (row) {
    if (row.base_model_id) payload.model = row.base_model_id;
    const params = safeJson(row.params);
    if (params && typeof params === 'object' && Object.keys(params).length) {
      applyModelParamsToBodyOpenai(params as Record<string, any>, payload);
    }
    await checkModelAccess(user, row, false);
  } else {
    await checkModelAccess(user, null, false);
  }

  const { url, conn } = await getOllamaUrl(String(payload.model), urlIdx, user);
  payload.model = stripProviderModelPrefix(String(payload.model), conn.prefixId);

  return sendRequest(`${url}/v1/completions`, 'POST', {
    payload: JSON.stringify(payload),
    key: conn.apiKey,
    stream: Boolean(payload.stream ?? false),
    config: conn.config,
  });
}

async function handleV1Embeddings(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
  const user = ctx.user!;
  const raw = await ctx.body<any>();
  if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string') {
    throw new HttpError(400, 'Field required (model)');
  }
  if (raw.input === undefined || raw.input === null) throw new HttpError(400, 'Field required (input)');
  const metadata = raw.metadata ?? null;
  const payload = stripNulls<Record<string, any>>(raw);
  delete payload.metadata;

  const modelId = String(payload.model);
  const row = await getModelRow(modelId);
  if (row) {
    if (row.base_model_id) payload.model = row.base_model_id;
    await checkModelAccess(user, row, false);
  } else {
    await checkModelAccess(user, null, false);
  }

  const { url, conn } = await getOllamaUrl(String(payload.model), urlIdx, user);
  payload.model = stripProviderModelPrefix(String(payload.model), conn.prefixId);

  return sendRequest(`${url}/v1/embeddings`, 'POST', {
    payload: JSON.stringify(payload),
    key: conn.apiKey,
    config: conn.config,
  });
}

async function handleV1ChatCompletions(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  const user = ctx.user!;
  const raw = await ctx.body<any>();
  if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string') {
    throw new HttpError(400, 'Field required (model)');
  }
  if (!Array.isArray(raw.messages)) throw new HttpError(400, 'Field required (messages)');
  const metadata = raw.metadata ?? null;
  const payload = stripNulls<Record<string, any>>(raw);
  delete payload.metadata;

  const modelId = String(payload.model);
  const row = await getModelRow(modelId);
  if (row) {
    if (row.base_model_id) payload.model = row.base_model_id;
    const params = safeJson(row.params);
    if (params && typeof params === 'object' && Object.keys(params).length) {
      const { system, ...rest } = params as Record<string, any>;
      applyModelParamsToBodyOpenai(rest, payload);
      applySystemPromptToBody(system, payload, metadata, user);
    }
    await checkModelAccess(user, row, false);
  } else {
    await checkModelAccess(user, null, false);
  }

  const { url, conn } = await getOllamaUrl(String(payload.model), urlIdx, user);
  payload.model = stripProviderModelPrefix(String(payload.model), conn.prefixId);

  return sendRequest(`${url}/v1/chat/completions`, 'POST', {
    payload: JSON.stringify(payload),
    key: conn.apiKey,
    stream: Boolean(payload.stream ?? false),
    config: conn.config,
  });
}

async function handleV1Messages(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
  const user = ctx.user!;
  const raw = await ctx.body<any>();
  const payload: Record<string, any> = { ...(raw ?? {}) };
  const modelId = String(payload.model ?? '');

  const row = await getModelRow(modelId);
  if (row) {
    if (row.base_model_id) payload.model = row.base_model_id;
    await checkModelAccess(user, row, false);
  } else {
    await checkModelAccess(user, null, false);
  }

  const { url, conn } = await getOllamaUrl(String(payload.model ?? ''), urlIdx, user);
  payload.model = stripProviderModelPrefix(String(payload.model ?? ''), conn.prefixId);

  const stream = Boolean(payload.stream ?? false);
  return sendRequest(`${url}/v1/messages`, 'POST', {
    payload: JSON.stringify(payload),
    key: conn.apiKey,
    stream,
    contentType: stream ? 'text/event-stream' : null,
    config: conn.config,
  });
}

async function handleV1Responses(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  if (!(await ollamaEnabled())) throw new HttpError(503, OLLAMA_API_DISABLED);
  const user = ctx.user!;
  const raw = await ctx.body<any>();
  if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string') {
    ctx.error(422, 'Field required (model)');
  }
  const payload: Record<string, any> = { ...raw };

  const modelId = String(payload.model);
  const row = await getModelRow(modelId);
  if (row) {
    if (row.base_model_id) payload.model = row.base_model_id;
    await checkModelAccess(user, row, false);
  } else {
    await checkModelAccess(user, null, false);
  }

  const { url, conn } = await getOllamaUrl(String(payload.model), urlIdx, user);
  payload.model = stripProviderModelPrefix(String(payload.model), conn.prefixId);

  const stream = Boolean(payload.stream ?? false);
  return sendRequest(`${url}/v1/responses`, 'POST', {
    payload: JSON.stringify(payload),
    key: conn.apiKey,
    stream,
    contentType: stream ? 'text/event-stream' : null,
    config: conn.config,
  });
}

async function handleV1Models(ctx: Ctx, urlIdx: number | null): Promise<Response> {
  const user = ctx.user!;
  if (urlIdx !== null && user.role !== 'admin') throw new HttpError(401, ERROR_MESSAGES.ACCESS_PROHIBITED);

  let rawModels: any[];
  if (urlIdx === null) {
    rawModels = (await getAllOllamaModels()).models;
  } else {
    const conn = await getConnection(urlIdx);
    const res = await sendRequest(`${conn.url}/api/tags`, 'GET', { key: conn.apiKey, config: conn.config });
    const parsed = await res.json().catch(() => null);
    rawModels = Array.isArray(parsed?.models) ? parsed.models : [];
  }

  const nowTs = Math.floor(Date.now() / 1000);
  let models = rawModels.map((m) => ({
    id: String(m?.model ?? ''),
    object: 'model',
    created: nowTs,
    owned_by: 'openai',
  }));

  if (user.role === 'user' && !BYPASS_MODEL_ACCESS_CONTROL) {
    models = await filterModelsForUser(models, user);
  }
  return ctx.json({ data: models, object: 'list' });
}

async function handleModelDownload(ctx: Ctx, urlIdx: number): Promise<Response> {
  const form = await ctx.body<any>();
  const fileUrl = String(form?.url ?? '');
  const allowedHosts = ['https://huggingface.co/', 'https://github.com/'];
  if (!allowedHosts.some((host) => fileUrl.startsWith(host))) {
    throw new HttpError(400, 'Invalid file_url. Only URLs from allowed hosts are permitted.');
  }

  const conn = await getConnection(urlIdx);
  const fileName = parseHuggingFaceUrl(fileUrl);
  if (!fileName) return ctx.json(null);

  const headers = upstreamHeaders(conn.url, conn.apiKey, conn.config);
  const filePath = path.join(UPLOAD_DIR, fileName);
  return sseResponse(downloadFileStream(conn.url, fileUrl, filePath, fileName, headers));
}

async function handleModelUpload(ctx: Ctx, urlIdx: number): Promise<Response> {
  const conn = await getConnection(urlIdx);
  const headers = upstreamHeaders(conn.url, conn.apiKey, conn.config);

  let file: File | null = null;
  try {
    const formData = await ctx.req.formData();
    const value = formData.get('file');
    if (value && typeof value !== 'string') file = value as File;
  } catch {
    file = null;
  }
  if (!file) ctx.error(422, 'Field required (file)');

  const fileName = path.basename(file.name || 'model.bin');
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  const filePath = path.join(UPLOAD_DIR, fileName);
  await fsp.writeFile(filePath, Buffer.from(await file.arrayBuffer()));
  const totalSize = (await fsp.stat(filePath)).size;

  async function* fileProcessStream(): AsyncGenerator<string> {
    try {
      // Stage 1: hash the file and emit SSE progress while reading it back.
      const hash = createHash('sha256');
      let bytesRead = 0;
      const stream = createReadStream(filePath, { highWaterMark: FILE_STREAM_CHUNK_SIZE });
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        hash.update(buf);
        bytesRead += buf.byteLength;
        const progress = Math.round((bytesRead / (totalSize || 1)) * 10000) / 100;
        yield sseEvent({ progress, total: totalSize, completed: bytesRead });
      }
      const fileHash = hash.digest('hex');

      // Stage 2: push the blob to Ollama.
      await postBlob(conn.url, fileHash, filePath, headers);
      await fsp.unlink(filePath).catch(() => {});

      // Stage 3: create the model.
      const model = fileName.replace(/\.[^.]+$/, '');
      const createRes = await fetch(`${conn.url}/api/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, files: { [fileName]: `sha256:${fileHash}` }, stream: false }),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
      if (!createRes.ok) throw new Error(`Failed to create model in Ollama. ${await createRes.text()}`);
      yield sseEvent({ done: true, blob: `sha256:${fileHash}`, name: fileName, model_created: model });
    } catch (e) {
      yield sseEvent({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  return sseResponse(fileProcessStream());
}
