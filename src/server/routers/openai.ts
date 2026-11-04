import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import type { ApiUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { env, ERROR_MESSAGES } from '@/lib/constants';
import { configGet, configSet } from '@/lib/config';
import { hasAccessGrant, hasPermission } from '@/lib/access-control';
import { resolveConnection } from '@/lib/connections';

/**
 * Port of open_webui/routers/openai.py (v0.12.5) — mounted at /openai.
 *
 * Connection storage (TS-native, see @/lib/connections):
 *   config table key 'openai.api.configs' → { [connKey]: { base_url, api_key, prefix_id?, ... } }
 * plus the env default connection (OPENAI_API_BASE_URL / OPENAI_API_KEY).
 *
 * Prefix convention: `${prefix_id}/${model_id}` (matches @/lib/connections
 * resolveConnection; Python used a '.' separator — see report).
 */

// ---------------------------------------------------------------------------
// Constants (env.py / openai.py)
// ---------------------------------------------------------------------------

const MODEL_LIST_TIMEOUT_MS = 10_000; // AIOHTTP_CLIENT_TIMEOUT_MODEL_LIST
const CLIENT_TIMEOUT_MS = 300_000; // AIOHTTP_CLIENT_TIMEOUT
const STREAM_TIMEOUT_MS = 300_000;

const UNSUPPORTED_OPENAI_MODEL_KEYWORDS = ['babbage', 'dall-e', 'davinci', 'embedding', 'tts', 'whisper'];

const BYPASS_MODEL_ACCESS_CONTROL = (process.env.BYPASS_MODEL_ACCESS_CONTROL ?? 'False').toLowerCase() === 'true';

/** openai.py local error strings (v0.12.5 constants.py values not present in @/lib/constants). */
const ERR = {
  SERVER_CONNECTION_ERROR: 'Nelth-AI: Server Connection Error',
  OPENAI_NOT_FOUND: 'OpenAI API was not found',
  OLLAMA_NOT_FOUND: 'WebUI could not connect to Ollama',
  MODEL_NOT_FOUND: (name = '') => `Model '${name}' was not found`,
};

const ANTHROPIC_VERSION = '2023-06-01';

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

function isAnthropicUrl(url: string): boolean {
  return url.includes('api.anthropic.com');
}

/** Port of utils/headers.py get_headers_and_cookies (core subset). */
function upstreamHeaders(url: string, key: string, cfg: Record<string, any> = {}): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (url.includes('openrouter.ai')) {
    // LICENSE covers this Open WebUI upstream metadata identifier.
    headers['HTTP-Referer'] = 'https://openwebui.com/';
    headers['X-Title'] = 'Nelth-AI';
  }
  const authType = cfg.auth_type ?? 'bearer';
  if (authType === 'bearer' && key) headers.authorization = `Bearer ${key}`;
  return headers;
}

/**
 * Upstream response passthrough — port of the JSON/PlainText/SSE handling used
 * across openai.py proxies. Streaming bodies are passed through verbatim.
 */
async function proxyResponse(res: Response): Promise<Response> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    if (res.status >= 400) {
      // SSE-typed error: read the body and return a proper error response.
      const body = await res.text();
      try {
        return jsonResponse(JSON.parse(body), res.status, retryHeaders(res));
      } catch {
        return jsonResponse(
          { error: { message: body, code: res.status } },
          res.status,
          retryHeaders(res)
        );
      }
    }
    return new Response(res.body, { status: res.status, headers: passthroughHeaders(res) });
  }
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status >= 400) {
    if (data && typeof data === 'object') return jsonResponse(data, res.status, retryHeaders(res));
    return new Response(text, { status: res.status, headers: { 'content-type': 'text/plain', ...retryHeaders(res) } });
  }
  // FastAPI JSON-encodes bare strings returned from handlers.
  if (typeof data === 'string') return jsonResponse(data);
  return jsonResponse(data ?? null);
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

async function openAiEnabled(): Promise<boolean> {
  return Boolean(await configGet<boolean | null>('openai.enable', env.ENABLE_OPENAI_API));
}

type ApiConfig = Record<string, any>;

type OpenAiConn = {
  idx: number;
  key: string;
  baseUrl: string;
  apiKey: string;
  prefixId: string | null;
  enable: boolean;
  modelIds: string[];
  tags: string[];
  connectionType: string;
  provider: string;
  config: ApiConfig;
};

function makeConn(idx: number, key: string, baseUrl: string, apiKey: string, cfg: ApiConfig): OpenAiConn {
  return {
    idx,
    key,
    baseUrl,
    apiKey,
    prefixId: cfg.prefix_id ?? null,
    enable: cfg.enable !== false,
    modelIds: Array.isArray(cfg.model_ids) ? cfg.model_ids.map(String) : [],
    tags: Array.isArray(cfg.tags) ? cfg.tags : [],
    connectionType: cfg.connection_type ?? 'external',
    provider: cfg.provider ?? '',
    config: cfg,
  };
}

/** Detailed connection list (index-stable) — superset of @/lib/connections getOpenAiConnections. */
async function getOpenAiConnectionsDetailed(): Promise<OpenAiConn[]> {
  const configs = await configGet<Record<string, ApiConfig> | null>('openai.api.configs', null);
  const conns: OpenAiConn[] = [];
  let idx = 0;
  if (configs && typeof configs === 'object') {
    for (const [key, cfg] of Object.entries(configs)) {
      if (!cfg || typeof cfg !== 'object' || !cfg.base_url) continue;
      conns.push(
        makeConn(idx++, key, String(cfg.base_url).replace(/\/+$/, ''), String(cfg.api_key ?? ''), cfg)
      );
    }
  }
  // env default connection (mirrors @/lib/connections)
  conns.push(
    makeConn(idx++, 'default', env.OPENAI_API_BASE_URL.replace(/\/+$/, ''), env.OPENAI_API_KEY, {})
  );
  return conns;
}

async function getConnection(urlIdx: number): Promise<OpenAiConn> {
  const conns = await getOpenAiConnectionsDetailed();
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
async function filterModelsForUser(data: any[], user: ApiUser): Promise<any[]> {
  const ids = data.map((m) => String(m?.id ?? '')).filter(Boolean);
  if (!ids.length) return [];
  let rows: ModelRow[] = [];
  try {
    rows = await db.model.findMany({ where: { id: { in: ids } } });
  } catch {
    return [];
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: any[] = [];
  for (const m of data) {
    const row = byId.get(String(m?.id));
    if (!row) {
      out.push(m); // no DB row → no restriction → public
      continue;
    }
    if (row.user_id === user.id || (await hasAccessGrant(user.id, 'model', row.id, 'read'))) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payload transforms (utils/payload.py subset + openai.py helpers)
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

/** apply_model_params_to_body_openai — merges workspace model params into the request body. */
function applyModelParamsToBodyOpenai(params: Record<string, any>, formData: Record<string, any>): Record<string, any> {
  let p = removeOpenWebuiParams(params ?? {});
  const customParams = p.custom_params;
  delete p.custom_params;
  if (customParams && typeof customParams === 'object') {
    const parsed: Record<string, any> = {};
    for (const [k, v] of Object.entries(customParams)) parsed[k] = parseMaybeJson(v);
    p = deepMerge(p, parsed);
  }
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

function isOpenAiNewModel(model: string): boolean {
  const modelLower = model.toLowerCase().replace(/^(?:[a-z-]+\.)?openai\./, '');
  if (/^o\d+/.test(modelLower)) return true;
  const m = modelLower.match(/^gpt-(\d+)/);
  if (!m) return false;
  return parseInt(m[1], 10) >= 5;
}

/** openai_reasoning_model_handler — reasoning model specific parameters. */
function openaiReasoningModelHandler(payload: Record<string, any>): Record<string, any> {
  if (payload.max_tokens !== undefined && payload.max_tokens !== null) {
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
  }
  const messages = payload.messages;
  if (Array.isArray(messages) && messages.length && messages[0]?.role === 'system') {
    const modelLower = String(payload.model ?? '').toLowerCase();
    if (modelLower.startsWith('o1-mini') || modelLower.startsWith('o1-preview')) {
      messages[0].role = 'user';
    } else {
      messages[0].role = 'developer';
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Anthropic model listing (utils/anthropic.py get_anthropic_models)
// ---------------------------------------------------------------------------

async function getAnthropicModels(url: string, key: string): Promise<any | null> {
  const allModels: any[] = [];
  let afterId: string | null = null;
  try {
    for (;;) {
      const params = new URLSearchParams({ limit: '1000' });
      if (afterId) params.set('after_id', afterId);
      const res = await fetch(`${url}/models?${params.toString()}`, {
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
        signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
      });
      if (res.status !== 200) {
        let errorDetail = `HTTP Error: ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) errorDetail = `External Error: ${typeof j.error === 'string' ? j.error : JSON.stringify(j.error)}`;
        } catch {
          /* keep default */
        }
        return { object: 'list', data: [], error: errorDetail };
      }
      const data = await res.json();
      for (const model of data?.data ?? []) {
        allModels.push({
          id: model?.id,
          object: 'model',
          created: 0,
          owned_by: 'anthropic',
          name: model?.display_name ?? model?.id,
        });
      }
      if (!data?.has_more) break;
      afterId = data?.last_id ?? null;
      if (!afterId) break;
    }
  } catch {
    return null;
  }
  return { object: 'list', data: allModels };
}

// ---------------------------------------------------------------------------
// Provider model loaded state (llama.cpp / lmstudio)
// ---------------------------------------------------------------------------

const LLAMACPP_LOADED_STATES = new Set(['loaded', 'sleeping']);
const LLAMACPP_UNLOADED_STATES = new Set(['loading', 'unloaded']);

function getProviderModelLoadedState(model: any, provider: string, manualModelIds = false): boolean | null {
  if (provider === 'lmstudio') {
    if (model?.loaded_instances) return true;
    const state = model?.state;
    if (state === 'loaded') return true;
    if (state === 'not-loaded') return false;
    return null;
  }
  if (provider !== 'llama.cpp') return null;
  const status = model?.status;
  if (status && typeof status === 'object') {
    const value = status.value;
    if (LLAMACPP_LOADED_STATES.has(value)) return true;
    if (LLAMACPP_UNLOADED_STATES.has(value)) return false;
  }
  if (!manualModelIds && !('status' in (model ?? {}))) return true;
  return null;
}

// ---------------------------------------------------------------------------
// get_all_models — merged model list across connections
// ---------------------------------------------------------------------------

const MODELS_CACHE_TTL_MS = Math.max(0, Number(process.env.MODELS_CACHE_TTL ?? '1') || 1) * 1000;
let allModelsCache: { at: number; data: any[] } | null = null;

function clearModelsCache(): void {
  allModelsCache = null;
}

function applyPrefix(value: string, prefixId: string | null): string {
  return prefixId ? `${prefixId}/${value}` : value;
}

async function fetchConnectionModels(conn: OpenAiConn): Promise<any | null> {
  if (isAnthropicUrl(conn.baseUrl)) {
    const result = await getAnthropicModels(conn.baseUrl, conn.apiKey);
    if (result && !result.error) return result;
    return null;
  }
  return fetchJson(`${conn.baseUrl}/models`, upstreamHeaders(conn.baseUrl, conn.apiKey, conn.config));
}

async function getAllModels(): Promise<any[]> {
  if (allModelsCache && Date.now() - allModelsCache.at < MODELS_CACHE_TTL_MS) {
    return allModelsCache.data;
  }
  if (!(await openAiEnabled())) {
    allModelsCache = { at: Date.now(), data: [] };
    return [];
  }
  const conns = await getOpenAiConnectionsDetailed();

  // Fan-out model listing requests (manual model_ids short-circuit the request).
  const responses = await Promise.all(
    conns.map((conn) => {
      if (!conn.enable) return Promise.resolve(null);
      if (conn.modelIds.length) {
        return Promise.resolve({
          object: 'list',
          data: conn.modelIds.map((modelId) => ({
            id: modelId,
            name: modelId,
            owned_by: 'openai',
            openai: { id: modelId },
            urlIdx: conn.idx,
          })),
        });
      }
      return fetchConnectionModels(conn);
    })
  );

  // Post-process each response: prefix_id, tags, connection_type, provider.
  const processedLists: (any[] | null)[] = responses.map((response, idx) => {
    if (!response) return null;
    const conn = conns[idx];
    let modelList: any[] = Array.isArray(response) ? response : (response.data ?? []);
    if (!Array.isArray(modelList)) modelList = [];
    for (const model of modelList) {
      if (!model || typeof model !== 'object') continue;
      if ('name' in model && model.name === null) delete model.name;
      const rawId = String(model.id ?? model.name ?? '');
      if (conn.prefixId) {
        model.id = applyPrefix(rawId, conn.prefixId);
        if (model.name) model.name = applyPrefix(String(model.name), conn.prefixId);
      }
      if (conn.tags.length) model.tags = conn.tags;
      if (conn.connectionType) model.connection_type = conn.connectionType;
      if (conn.provider) model.provider = conn.provider;
    }
    return modelList;
  });

  // Merge with de-duplication (first connection wins).
  const merged: Record<string, any> = {};
  processedLists.forEach((modelList, idx) => {
    if (!modelList) return;
    const conn = conns[idx];
    let hostname = '';
    try {
      hostname = new URL(conn.baseUrl).hostname;
    } catch {
      hostname = '';
    }
    const manualModelIds = conn.modelIds.length > 0;
    for (const model of modelList) {
      const modelId = String(model?.id ?? model?.name ?? '');
      if (!modelId) continue;
      if (hostname === 'api.openai.com' && UNSUPPORTED_OPENAI_MODEL_KEYWORDS.some((k) => modelId.includes(k))) {
        continue;
      }
      if (modelId in merged) continue;
      const provider = String(model?.provider ?? '');
      const entry: Record<string, any> = {
        ...model,
        name: model?.name ?? modelId,
        owned_by: 'openai',
        openai: model,
        connection_type: model?.connection_type ?? 'external',
        provider,
        urlIdx: idx,
      };
      const loaded = getProviderModelLoadedState(model, provider, manualModelIds);
      if (loaded !== null && loaded !== undefined) entry.loaded = loaded;
      merged[modelId] = entry;
    }
  });

  const data = Object.values(merged);
  allModelsCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------------------
// Model management endpoints (llama.cpp / lmstudio)
// ---------------------------------------------------------------------------

const MODEL_MANAGEMENT_ENDPOINTS: Record<string, Record<string, string>> = {
  'llama.cpp': {
    list: '/models',
    download: '/models',
    delete: '/models',
    load: '/models/load',
    unload: '/models/unload',
    sse: '/models/sse',
  },
  lmstudio: {
    list: '/api/v1/models',
    download: '/api/v1/models/download',
    download_status: '/api/v1/models/download/status/{job_id}',
    load: '/api/v1/models/load',
    unload: '/api/v1/models/unload',
  },
};

function getModelManagementRootUrl(url: string, provider: string): string {
  let rootUrl = url.replace(/\/+$/, '');
  if (provider === 'llama.cpp' || provider === 'lmstudio') {
    for (const suffix of ['/api/v1', '/api/v0', '/v1']) {
      if (rootUrl.endsWith(suffix)) {
        rootUrl = rootUrl.slice(0, rootUrl.length - suffix.length);
        break;
      }
    }
  }
  return rootUrl;
}

function stripProviderModelPrefix(model: string, prefixId: string | null | undefined): string {
  if (prefixId && model.startsWith(`${prefixId}/`)) return model.slice(prefixId.length + 1);
  return model;
}

async function getModelManagementConnection(urlIdx: number): Promise<{ conn: OpenAiConn; rootUrl: string; provider: string }> {
  if (!(await openAiEnabled())) throw new HttpError(503, 'OpenAI API is disabled');
  const conn = await getConnection(urlIdx);
  const provider = String(conn.config.provider ?? '');
  if (!(provider in MODEL_MANAGEMENT_ENDPOINTS)) {
    throw new HttpError(400, `Provider "${provider || 'default'}" does not support model management`);
  }
  return { conn, rootUrl: getModelManagementRootUrl(conn.baseUrl, provider), provider };
}

function getModelManagementPath(provider: string, operation: string, pathParams: Record<string, string> = {}): string {
  const table = MODEL_MANAGEMENT_ENDPOINTS[provider];
  const template = table?.[operation];
  if (!template) throw new HttpError(400, `Provider "${provider}" does not support ${operation}`);
  return template.replace(/\{(\w+)\}/g, (_, key) => pathParams[key] ?? '');
}

async function sendModelManagementRequest(
  urlIdx: number,
  operation: string,
  opts: {
    method?: string;
    payload?: Record<string, any> | null;
    query?: Record<string, string>;
    pathParams?: Record<string, string>;
    stream?: boolean;
  } = {}
): Promise<Response> {
  const { conn, rootUrl, provider } = await getModelManagementConnection(urlIdx);
  const path = getModelManagementPath(provider, operation, opts.pathParams ?? {});
  let payload = opts.payload ?? null;
  if (provider === 'lmstudio' && operation === 'unload' && payload) {
    payload = { instance_id: payload.instance_id ?? payload.model };
  }

  const url = new URL(`${rootUrl}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: opts.method ?? 'GET',
      headers: upstreamHeaders(rootUrl, conn.apiKey, conn.config),
      body: payload !== null ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(opts.stream ? STREAM_TIMEOUT_MS : CLIENT_TIMEOUT_MS),
    });
  } catch (e) {
    throw new HttpError(500, e instanceof Error ? e.message : ERR.SERVER_CONNECTION_ERROR);
  }

  if (!res.ok) {
    const text = await res.text();
    let error: unknown = text;
    try {
      error = JSON.parse(text);
    } catch {
      /* keep text */
    }
    throw new HttpError(
      res.status,
      typeof error === 'string' ? error : JSON.stringify(error)
    );
  }

  if (opts.stream) {
    return new Response(res.body, { status: res.status, headers: passthroughHeaders(res) });
  }
  const text = await res.text();
  try {
    return jsonResponse(text ? JSON.parse(text) : null);
  } catch {
    return jsonResponse({ success: true });
  }
}

// ---------------------------------------------------------------------------
// Config endpoints
// ---------------------------------------------------------------------------

async function getOpenAiConfig(): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  const enable = await configGet<boolean | null>('openai.enable', null);
  if (enable !== null) values.ENABLE_OPENAI_API = enable;
  const configs = await configGet<Record<string, ApiConfig> | null>('openai.api.configs', null);
  if (configs && typeof configs === 'object') {
    const baseUrls: string[] = [];
    const apiKeys: string[] = [];
    const apiConfigs: Record<string, any> = {};
    for (const [key, cfg] of Object.entries(configs)) {
      if (!cfg || typeof cfg !== 'object' || !cfg.base_url) continue;
      baseUrls.push(String(cfg.base_url));
      apiKeys.push(String(cfg.api_key ?? ''));
      const { base_url, api_key, ...rest } = cfg;
      apiConfigs[key] = rest;
    }
    values.OPENAI_API_BASE_URLS = baseUrls;
    values.OPENAI_API_KEYS = apiKeys;
    values.OPENAI_API_CONFIGS = apiConfigs;
  }
  return values;
}

async function persistOpenAiConfig(enable: boolean | null, configs: Record<string, ApiConfig>): Promise<void> {
  await configSet('openai.enable', enable);
  await configSet('openai.api.configs', configs);
  clearModelsCache();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ------------------------------------------------------------------
  // GET /openai/config — admin: current connection configuration
  // ------------------------------------------------------------------
  {
    method: 'GET',
    path: 'config',
    auth: 'admin',
    handler: async (ctx: Ctx) => ctx.json(await getOpenAiConfig()),
  },

  // ------------------------------------------------------------------
  // POST /openai/config/update — admin: update connections
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'config/update',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<any>();
      const enable = form?.ENABLE_OPENAI_API ?? null;

      // TS-native dict-of-connections body: { configs: { key: { base_url, api_key, prefix_id? } } }
      if (form?.configs && typeof form.configs === 'object' && !Array.isArray(form.configs)) {
        const cleaned: Record<string, ApiConfig> = {};
        for (const [key, cfg] of Object.entries(form.configs as Record<string, any>)) {
          if (!cfg || typeof cfg !== 'object' || !cfg.base_url) continue;
          cleaned[key] = cfg;
        }
        await persistOpenAiConfig(enable, cleaned);
        return ctx.json({ ENABLE_OPENAI_API: enable, OPENAI_API_CONFIGS: cleaned });
      }

      const baseUrls: string[] = Array.isArray(form?.OPENAI_API_BASE_URLS)
        ? form.OPENAI_API_BASE_URLS.map(String)
        : [];
      if (!Array.isArray(form?.OPENAI_API_BASE_URLS)) {
        ctx.error(422, 'Field required (OPENAI_API_BASE_URLS)');
      }
      let apiKeys: string[] = Array.isArray(form?.OPENAI_API_KEYS) ? form.OPENAI_API_KEYS.map(String) : [];

      // Pad / truncate the key list to match the url list.
      if (apiKeys.length > baseUrls.length) apiKeys = apiKeys.slice(0, baseUrls.length);
      else while (apiKeys.length < baseUrls.length) apiKeys.push('');

      const validKeys = new Set(baseUrls.map((_, i) => String(i)));
      const apiConfigs: Record<string, any> = {};
      for (const [key, value] of Object.entries(form?.OPENAI_API_CONFIGS ?? {})) {
        if (validKeys.has(key)) apiConfigs[key] = value;
      }

      const merged: Record<string, ApiConfig> = {};
      baseUrls.forEach((baseUrl, i) => {
        const extra = apiConfigs[String(i)] ?? {};
        merged[String(i)] = { ...extra, base_url: baseUrl, api_key: apiKeys[i] };
      });
      await persistOpenAiConfig(enable, merged);

      return ctx.json({
        ENABLE_OPENAI_API: enable,
        OPENAI_API_BASE_URLS: baseUrls,
        OPENAI_API_KEYS: apiKeys,
        OPENAI_API_CONFIGS: apiConfigs,
      });
    },
  },

  // ------------------------------------------------------------------
  // POST /openai/audio/speech — TTS proxy to the api.openai.com connection
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'audio/speech',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const user = ctx.user!;
      if (user.role !== 'admin') {
        const perms = await configGet<Record<string, any> | null>('user.permissions', null);
        if (!(await hasPermission(user.id, 'chat.tts', perms))) {
          throw new HttpError(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      }

      const conns = await getOpenAiConnectionsDetailed();
      const conn = conns.find((c) => c.baseUrl === 'https://api.openai.com/v1');
      if (!conn) throw new HttpError(401, ERR.OPENAI_NOT_FOUND);

      const raw = await ctx.rawBody();
      const headers: Record<string, string> = {
        'content-type': ctx.req.headers.get('content-type') ?? 'application/json',
      };
      if (conn.apiKey) headers.authorization = `Bearer ${conn.apiKey}`;

      let res: Response;
      try {
        res = await fetch(`${conn.baseUrl}/audio/speech`, {
          method: 'POST',
          headers,
          body: raw,
          signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
        });
      } catch {
        throw new HttpError(500, ERR.SERVER_CONNECTION_ERROR);
      }

      if (!res.ok) {
        const text = await res.text();
        let detail = `External: ${text}`;
        try {
          const parsed = JSON.parse(text);
          if (parsed?.error !== undefined) {
            detail = `External: ${typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)}`;
          }
        } catch {
          /* keep default */
        }
        throw new HttpError(res.status, detail);
      }

      return new Response(res.body, {
        status: 200,
        headers: passthroughHeaders(res),
      });
    },
  },

  // ------------------------------------------------------------------
  // GET /openai/models — merged model list across all connections
  // ------------------------------------------------------------------
  {
    method: 'GET',
    path: 'models',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const user = ctx.user!;
      if (!(await openAiEnabled())) throw new HttpError(503, 'OpenAI API is disabled');

      let models: Record<string, any> = { data: await getAllModels() };

      if (user.role === 'user' && !BYPASS_MODEL_ACCESS_CONTROL) {
        models.data = await filterModelsForUser(models.data, user);
      }
      return ctx.json(models);
    },
  },

  // ------------------------------------------------------------------
  // GET /openai/models/{url_idx} — models from a single connection (admin)
  // ------------------------------------------------------------------
  {
    method: 'GET',
    path: 'models/:urlIdx',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const user = ctx.user!;
      if (user.role !== 'admin') throw new HttpError(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      if (!(await openAiEnabled())) throw new HttpError(503, 'OpenAI API is disabled');

      const urlIdx = Number(ctx.params.urlIdx);
      if (!Number.isInteger(urlIdx) || urlIdx < 0) throw new HttpError(404, 'Connection not found');
      const conn = await getConnection(urlIdx);

      let models: Record<string, any>;
      try {
        if (conn.config.azure || conn.provider === 'azure') {
          models = { data: conn.modelIds ?? [], object: 'list' };
        } else if (isAnthropicUrl(conn.baseUrl)) {
          const result = await getAnthropicModels(conn.baseUrl, conn.apiKey);
          if (result === null) throw new Error('Failed to connect to Anthropic API');
          models = result;
        } else {
          const res = await fetch(`${conn.baseUrl}/models`, {
            headers: upstreamHeaders(conn.baseUrl, conn.apiKey, conn.config),
            signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
          });
          if (res.status !== 200) {
            let errorDetail = `HTTP Error: ${res.status}`;
            try {
              const parsed = await res.json();
              if (parsed?.error !== undefined) {
                errorDetail = `External Error: ${typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)}`;
              }
            } catch {
              /* keep default */
            }
            throw new Error(errorDetail);
          }
          const responseData = await res.json();
          if (conn.baseUrl.includes('api.openai.com')) {
            responseData.data = (responseData?.data ?? []).filter(
              (m: any) => !UNSUPPORTED_OPENAI_MODEL_KEYWORDS.some((k) => String(m?.id ?? '').includes(k))
            );
          }
          models = responseData;
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(500, `Unexpected error: ${e instanceof Error ? e.message : e}`);
      }

      // (Python applies the user-role filter here too, but the url_idx branch is
      // admin-only — the filter can never trigger, mirroring the reference.)
      return ctx.json(models);
    },
  },

  // ------------------------------------------------------------------
  // Provider model management (llama.cpp / lmstudio)
  // ------------------------------------------------------------------
  {
    method: 'GET',
    path: 'models/:urlIdx/catalog',
    auth: 'admin',
    handler: async (ctx: Ctx) => sendModelManagementRequest(Number(ctx.params.urlIdx), 'list'),
  },
  {
    method: 'POST',
    path: 'models/:urlIdx/download',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const urlIdx = Number(ctx.params.urlIdx);
      const { conn } = await getModelManagementConnection(urlIdx);
      const form = await ctx.body<any>();
      const payload: Record<string, any> = { ...(form ?? {}) };
      for (const key of Object.keys(payload)) {
        if (payload[key] === null || payload[key] === undefined) delete payload[key];
      }
      payload.model = stripProviderModelPrefix(String(payload.model ?? ''), conn.prefixId);
      const result = await sendModelManagementRequest(urlIdx, 'download', { method: 'POST', payload });
      clearModelsCache();
      return result;
    },
  },
  {
    method: 'GET',
    path: 'models/:urlIdx/download/status/:jobId',
    auth: 'admin',
    handler: async (ctx: Ctx) =>
      sendModelManagementRequest(Number(ctx.params.urlIdx), 'download_status', {
        pathParams: { job_id: ctx.params.jobId },
      }),
  },
  {
    method: 'POST',
    path: 'models/:urlIdx/load',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const urlIdx = Number(ctx.params.urlIdx);
      const { conn } = await getModelManagementConnection(urlIdx);
      const form = await ctx.body<any>();
      const payload: Record<string, any> = { ...(form ?? {}) };
      for (const key of Object.keys(payload)) {
        if (payload[key] === null || payload[key] === undefined) delete payload[key];
      }
      payload.model = stripProviderModelPrefix(String(payload.model ?? ''), conn.prefixId);
      const result = await sendModelManagementRequest(urlIdx, 'load', { method: 'POST', payload });
      clearModelsCache();
      return result;
    },
  },
  {
    method: 'POST',
    path: 'models/:urlIdx/unload',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const urlIdx = Number(ctx.params.urlIdx);
      const { conn } = await getModelManagementConnection(urlIdx);
      const form = await ctx.body<any>();
      const payload: Record<string, any> = { ...(form ?? {}) };
      for (const key of Object.keys(payload)) {
        if (payload[key] === null || payload[key] === undefined) delete payload[key];
      }
      payload.model = stripProviderModelPrefix(String(payload.model ?? ''), conn.prefixId);
      const result = await sendModelManagementRequest(urlIdx, 'unload', { method: 'POST', payload });
      clearModelsCache();
      return result;
    },
  },
  {
    method: 'GET',
    path: 'models/:urlIdx/sse',
    auth: 'admin',
    handler: async (ctx: Ctx) =>
      sendModelManagementRequest(Number(ctx.params.urlIdx), 'sse', { stream: true }),
  },
  {
    method: 'DELETE',
    path: 'models/:urlIdx',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const urlIdx = Number(ctx.params.urlIdx);
      const { conn } = await getModelManagementConnection(urlIdx);
      const model = ctx.query.get('model') ?? '';
      const actualModel = stripProviderModelPrefix(model, conn.prefixId);
      const result = await sendModelManagementRequest(urlIdx, 'delete', {
        method: 'DELETE',
        query: { model: actualModel },
      });
      clearModelsCache();
      return result;
    },
  },

  // ------------------------------------------------------------------
  // POST /openai/verify — verify an OpenAI-compatible connection
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'verify',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const form = await ctx.body<any>();
      const url = String(form?.url ?? '').replace(/\/+$/, '');
      const key = String(form?.key ?? '');
      const cfg = form?.config && typeof form.config === 'object' ? form.config : {};
      if (!url) ctx.error(422, 'Field required (url)');

      try {
        if (cfg.azure || cfg.provider === 'azure') {
          const headers: Record<string, string> = {};
          const authType = cfg.auth_type ?? 'bearer';
          if (authType !== 'azure_ad' && authType !== 'microsoft_entra_id') headers['api-key'] = key;
          const isAzureV1 = /\/openai\/v1(?:\/|$)/.test(url);
          let verifyUrl: string;
          if (isAzureV1) {
            verifyUrl = `${url}/models`;
          } else {
            const apiVersion = String(cfg.api_version ?? '') || '2023-03-15-preview';
            verifyUrl = `${url}/openai/models?api-version=${apiVersion}`;
          }
          const res = await fetch(verifyUrl, {
            headers,
            signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
          });
          return verifyPassthrough(res);
        }
        if (isAnthropicUrl(url)) {
          const result = await getAnthropicModels(url, key);
          if (result === null) throw new HttpError(500, ERR.SERVER_CONNECTION_ERROR);
          if (result.error) throw new HttpError(500, String(result.error));
          return ctx.json(result);
        }
        const res = await fetch(`${url}/models`, {
          headers: upstreamHeaders(url, key, cfg),
          signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
        });
        return verifyPassthrough(res);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(500, ERR.SERVER_CONNECTION_ERROR);
      }
    },
  },

  // ------------------------------------------------------------------
  // POST /openai/chat/completions — the key proxy
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'chat/completions',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const user = ctx.user!;
      if (!(await openAiEnabled())) throw new HttpError(503, 'OpenAI API is disabled');

      const form = await ctx.body<Record<string, any>>();
      if (!form || typeof form !== 'object' || typeof form.model !== 'string') {
        ctx.error(400, 'Invalid payload: model is required');
      }
      const payload: Record<string, any> = { ...form };
      const metadata = payload.metadata ?? null;
      delete payload.metadata;

      const modelId = form.model as string;

      // Check workspace model info and override the payload.
      const row = await getModelRow(modelId);
      if (row) {
        if (row.base_model_id) payload.model = row.base_model_id;
        const params = safeJson(row.params);
        if (params && typeof params === 'object' && Object.keys(params).length) {
          const { system, ...rest } = params as Record<string, any>;
          applyModelParamsToBodyOpenai(rest, payload);
          applySystemPromptToBody(system, payload, metadata, user);
        }
        await checkModelAccess(user, row);
      } else {
        await checkModelAccess(user, null);
      }

      // Route to the right connection.
      const route = await resolveConnection(String(payload.model ?? modelId));
      if (!route) throw new HttpError(404, ERR.MODEL_NOT_FOUND());
      payload.model = route.model;

      // Reasoning model handling / legacy max_tokens conversion.
      if (isOpenAiNewModel(String(payload.model))) {
        openaiReasoningModelHandler(payload);
      } else if (!route.baseUrl.includes('api.openai.com')) {
        if (payload.max_completion_tokens !== undefined && payload.max_completion_tokens !== null) {
          payload.max_tokens = payload.max_completion_tokens;
          delete payload.max_completion_tokens;
        }
      }
      if (
        payload.max_tokens !== undefined &&
        payload.max_tokens !== null &&
        payload.max_completion_tokens !== undefined &&
        payload.max_completion_tokens !== null
      ) {
        delete payload.max_tokens;
      }

      if (typeof payload.logit_bias === 'string') {
        try {
          payload.logit_bias = JSON.parse(payload.logit_bias);
        } catch {
          /* keep as-is */
        }
      }

      // Chat Completions does not support images in tool content.
      if (Array.isArray(payload.messages)) {
        for (const message of payload.messages) {
          if (message?.role === 'tool' && Array.isArray(message.content)) {
            message.content = message.content
              .filter((part: any) => part?.type === 'input_text' || part?.type === 'text')
              .map((part: any) => String(part?.text ?? ''))
              .join('');
          }
        }
      }

      const isStreamingRequest = Boolean(payload.stream);
      if (!isStreamingRequest) delete payload.stream_options;

      const requestUrl =
        route.type === 'openai'
          ? `${route.baseUrl}/chat/completions`
          : `${route.baseUrl}/v1/chat/completions`;
      const headers = upstreamHeaders(requestUrl, route.apiKey);

      let res: Response;
      try {
        res = await fetch(requestUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(isStreamingRequest ? STREAM_TIMEOUT_MS : CLIENT_TIMEOUT_MS),
        });
      } catch {
        throw new HttpError(500, ERR.SERVER_CONNECTION_ERROR);
      }
      return proxyResponse(res);
    },
  },

  // ------------------------------------------------------------------
  // POST /openai/embeddings — embeddings proxy (Python: internal helper)
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'embeddings',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const user = ctx.user!;
      if (!(await openAiEnabled())) throw new HttpError(503, 'OpenAI API is disabled');

      const form = await ctx.body<Record<string, any>>();
      if (!form || typeof form !== 'object' || typeof form.model !== 'string') {
        ctx.error(400, 'Invalid payload: model is required');
      }
      const payload: Record<string, any> = { ...form };

      const route = await resolveConnection(String(payload.model));
      if (!route) throw new HttpError(404, ERR.MODEL_NOT_FOUND());
      payload.model = route.model;

      const requestUrl =
        route.type === 'openai' ? `${route.baseUrl}/embeddings` : `${route.baseUrl}/v1/embeddings`;
      const headers = upstreamHeaders(requestUrl, route.apiKey);

      let res: Response;
      try {
        res = await fetch(requestUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
        });
      } catch {
        throw new HttpError(500, ERR.SERVER_CONNECTION_ERROR);
      }
      return proxyResponse(res);
    },
  },

  // ------------------------------------------------------------------
  // POST /openai/responses — Responses API proxy
  // ------------------------------------------------------------------
  {
    method: 'POST',
    path: 'responses',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const user = ctx.user!;
      const form = await ctx.body<Record<string, any>>();
      if (!form || typeof form !== 'object' || typeof form.model !== 'string') {
        ctx.error(422, 'Field required (model)');
      }
      const payload: Record<string, any> = { ...form };
      const isStreamingRequest = Boolean(payload.stream);

      const modelId = form.model as string;
      await checkModelAccess(user, await getModelRow(modelId));

      const route = await resolveConnection(modelId);
      if (!route) throw new HttpError(404, ERR.MODEL_NOT_FOUND());
      payload.model = route.model;

      const requestUrl = route.type === 'openai' ? `${route.baseUrl}/responses` : `${route.baseUrl}/v1/responses`;
      const headers = upstreamHeaders(requestUrl, route.apiKey);

      let res: Response;
      try {
        res = await fetch(requestUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(isStreamingRequest ? STREAM_TIMEOUT_MS : CLIENT_TIMEOUT_MS),
        });
      } catch {
        throw new HttpError(500, ERR.SERVER_CONNECTION_ERROR);
      }
      return proxyResponse(res);
    },
  },
];

/** Shared verify passthrough (JSONResponse / PlainTextResponse parity). */
async function verifyPassthrough(res: Response): Promise<Response> {
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status !== 200) {
    if (data && typeof data === 'object') return jsonResponse(data, res.status);
    return new Response(text, { status: res.status, headers: { 'content-type': 'text/plain' } });
  }
  if (typeof data === 'string') return jsonResponse(data);
  return jsonResponse(data ?? null);
}
