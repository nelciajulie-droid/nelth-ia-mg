import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import crypto from 'crypto';
import { configGet, configSet } from '@/lib/config';
import { env } from '@/lib/constants';
import { decodeToken, getSecretKey } from '@/lib/auth';
import { configGetAll, configGetNamespace } from '@/lib/models/workspace';
import { updateMfaConfig } from '@/lib/models/auths';

/**
 * /api/v1/configs — port of open_webui/routers/configs.py (v0.12.5).
 *
 * Documented deviations:
 *  - publish_event / EVENTS are not ported (no event bus in the TS runtime).
 *  - POST /tool_servers does not refresh an in-memory app.state.TOOL_SERVERS
 *    cache (routers read the config table directly); OAuth client manager
 *    add/remove for MCP tool servers is skipped (no OAuth client manager).
 *  - POST /oauth/clients/register: dynamic registration follows RFC 7591 with
 *    plain fetch; encrypt_data uses AES-256-GCM keyed by HKDF(WEBUI_SECRET_KEY)
 *    instead of Python Fernet (blob format differs — not cross-compatible).
 *  - POST /tool_servers/verify: MCP servers cannot be dialed (no MCP client
 *    runtime) → 400 'Failed to create MCP client'; OAuth 2.1 discovery is
 *    fetched and validated structurally.
 *  - YAML tool-server specs are not parsed (JSON only).
 */

const ENABLE_TOOL_SERVERS = (process.env.ENABLE_TOOL_SERVERS ?? 'True').toLowerCase() === 'true';
const CLIENT_TIMEOUT_MS = Number(process.env.AIOHTTP_CLIENT_TIMEOUT ?? 300) * 1000;

const CONNECTIONS_CONFIG_KEYS: Record<string, string> = {
  ENABLE_DIRECT_CONNECTIONS: 'direct.enable',
  ENABLE_DIRECT_INTEGRATIONS: 'direct.integrations.enable',
  ENABLE_BASE_MODELS_CACHE: 'models.base_models_cache',
};

const CODE_EXECUTION_CONFIG_KEYS: Record<string, string> = {
  ENABLE_CODE_EXECUTION: 'code_execution.enable',
  CODE_EXECUTION_ENGINE: 'code_execution.engine',
  CODE_EXECUTION_JUPYTER_URL: 'code_execution.jupyter.url',
  CODE_EXECUTION_JUPYTER_AUTH: 'code_execution.jupyter.auth',
  CODE_EXECUTION_JUPYTER_AUTH_TOKEN: 'code_execution.jupyter.auth_token',
  CODE_EXECUTION_JUPYTER_AUTH_PASSWORD: 'code_execution.jupyter.auth_password',
  CODE_EXECUTION_JUPYTER_TIMEOUT: 'code_execution.jupyter.timeout',
  ENABLE_CODE_INTERPRETER: 'code_interpreter.enable',
  CODE_INTERPRETER_ENGINE: 'code_interpreter.engine',
  CODE_INTERPRETER_PROMPT_TEMPLATE: 'code_interpreter.prompt_template',
  CODE_INTERPRETER_JUPYTER_URL: 'code_interpreter.jupyter.url',
  CODE_INTERPRETER_JUPYTER_AUTH: 'code_interpreter.jupyter.auth',
  CODE_INTERPRETER_JUPYTER_AUTH_TOKEN: 'code_interpreter.jupyter.auth_token',
  CODE_INTERPRETER_JUPYTER_AUTH_PASSWORD: 'code_interpreter.jupyter.auth_password',
  CODE_INTERPRETER_JUPYTER_TIMEOUT: 'code_interpreter.jupyter.timeout',
};

const MODELS_CONFIG_KEYS: Record<string, string> = {
  DEFAULT_MODELS: 'ui.default_models',
  DEFAULT_PINNED_MODELS: 'ui.default_pinned_models',
  MODEL_ORDER_LIST: 'ui.model_order_list',
  DEFAULT_MODEL_METADATA: 'models.default_metadata',
  DEFAULT_MODEL_PARAMS: 'models.default_params',
};

const SUBAGENTS_CONFIG_KEYS: Record<string, string> = {
  ENABLE_SUBAGENTS: 'subagents.enable',
  SUBAGENTS_BACKGROUND_ENABLED: 'subagents.background_enabled',
  SUBAGENTS_MAX_CONCURRENT: 'subagents.max_concurrent',
  SUBAGENTS_MAX_ASYNC: 'subagents.max_async',
  SUBAGENTS_MAX_ITERATIONS: 'subagents.max_iterations',
  SUBAGENTS_MAX_OUTPUT: 'subagents.max_output',
  SUBAGENTS_SYSTEM_PROMPT: 'subagents.system_prompt',
};

/** Env-default map for the config keys above (Python Config.DEFAULTS). */
const ENV_DEFAULTS: Record<string, unknown> = {
  'direct.enable': envBool('ENABLE_DIRECT_CONNECTIONS', 'False'),
  'direct.integrations.enable': envBool('ENABLE_DIRECT_INTEGRATIONS', 'False'),
  'models.base_models_cache': envBool('ENABLE_BASE_MODELS_CACHE', 'False'),
  'code_execution.enable': envBool('ENABLE_CODE_EXECUTION', 'True'),
  'code_execution.engine': process.env.CODE_EXECUTION_ENGINE || 'pyodide',
  'code_execution.jupyter.url': process.env.CODE_EXECUTION_JUPYTER_URL || '',
  'code_execution.jupyter.auth': process.env.CODE_EXECUTION_JUPYTER_AUTH || '',
  'code_execution.jupyter.auth_token': process.env.CODE_EXECUTION_JUPYTER_AUTH_TOKEN || '',
  'code_execution.jupyter.auth_password': process.env.CODE_EXECUTION_JUPYTER_AUTH_PASSWORD || '',
  'code_execution.jupyter.timeout': Number(process.env.CODE_EXECUTION_JUPYTER_TIMEOUT || 60),
  'code_interpreter.enable': envBool('ENABLE_CODE_INTERPRETER', 'True'),
  'code_interpreter.engine': process.env.CODE_INTERPRETER_ENGINE || 'pyodide',
  'code_interpreter.prompt_template': process.env.CODE_INTERPRETER_PROMPT_TEMPLATE || '',
  'code_interpreter.jupyter.url': process.env.CODE_INTERPRETER_JUPYTER_URL || '',
  'code_interpreter.jupyter.auth': process.env.CODE_INTERPRETER_JUPYTER_AUTH || '',
  'code_interpreter.jupyter.auth_token': process.env.CODE_INTERPRETER_JUPYTER_AUTH_TOKEN || '',
  'code_interpreter.jupyter.auth_password': process.env.CODE_INTERPRETER_JUPYTER_AUTH_PASSWORD || '',
  'code_interpreter.jupyter.timeout': Number(
    process.env.CODE_INTERPRETER_JUPYTER_TIMEOUT || process.env.CODE_EXECUTION_JUPYTER_TIMEOUT || 60
  ),
  'ui.default_models': env.DEFAULT_MODELS,
  'ui.default_pinned_models': env.DEFAULT_PINNED_MODELS,
  'ui.model_order_list': safeJsonArray(process.env.MODEL_ORDER_LIST),
  'models.default_metadata': safeJsonObject(process.env.DEFAULT_MODEL_METADATA),
  'models.default_params': safeJsonObject(process.env.DEFAULT_MODEL_PARAMS),
  'subagents.enable': envBool('ENABLE_SUBAGENTS', 'False'),
  'subagents.background_enabled': envBool('SUBAGENTS_BACKGROUND_ENABLED', 'False'),
  'subagents.max_concurrent': Number(process.env.SUBAGENTS_MAX_CONCURRENT || 20),
  'subagents.max_async': Number(process.env.SUBAGENTS_MAX_ASYNC || 20),
  'subagents.max_iterations': Number(process.env.SUBAGENTS_MAX_ITERATIONS || 30),
  'subagents.max_output': Number(process.env.SUBAGENTS_MAX_OUTPUT || 30000),
  'subagents.system_prompt': process.env.SUBAGENTS_SYSTEM_PROMPT || '',
};

function envBool(key: string, def: string): boolean {
  return (process.env[key] ?? def).toLowerCase() === 'true';
}

function safeJsonArray(raw: string | undefined): unknown[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function safeJsonObject(raw: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(raw ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Python get_config_values — table value or env default, keys present only when resolvable. */
async function getConfigValues(keyMap: Record<string, string>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [field, storageKey] of Object.entries(keyMap)) {
    const fallback = storageKey in ENV_DEFAULTS ? ENV_DEFAULTS[storageKey] : undefined;
    const value = await configGet<unknown>(storageKey, fallback);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/** Python config_updates — map API field names onto storage keys. */
function configUpdates(data: Record<string, unknown>, keyMap: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(data ?? {})) {
    if (field in keyMap) out[keyMap[field]] = value;
  }
  return out;
}

async function upsertConfig(updates: Record<string, unknown>): Promise<void> {
  for (const [key, value] of Object.entries(updates)) {
    await configSet(key, value);
  }
}

// ---------------------------------------------------------------------------
// OAuth client info encryption (encrypt_data port — AES-256-GCM, see header)
// ---------------------------------------------------------------------------

function encryptData(data: Record<string, unknown>): string {
  const key = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(getSecretKey(), 'utf-8'),
      Buffer.alloc(0),
      Buffer.from('open-webui/oauth-encryption/v1', 'utf-8'),
      32
    )
  );
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Tool / terminal server helpers
// ---------------------------------------------------------------------------

/** Python utils/tools.get_tool_server_url. */
function getToolServerUrl(url: string | null | undefined, path: string): string {
  if (path.includes('://')) return path;
  const base = (url ?? '').replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return base + suffix;
}

function bearerAuthHeader(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new HttpError(res.status, safeJsonDetail(body, res.status));
  }
  return res.json();
}

function safeJsonDetail(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'detail' in parsed) return String((parsed as any).detail);
    return text;
  } catch {
    return text || `HTTP ${status}`;
  }
}

/** Discovery document candidates (utils/oauth.get_discovery_urls port). */
function getDiscoveryUrls(oauthServerUrl: string): string[] {
  const base = oauthServerUrl.replace(/\/$/, '');
  let root = base;
  try {
    const u = new URL(base);
    // well-known is anchored at the origin for RFC 8414; also try the path root
    root = `${u.protocol}//${u.host}`;
  } catch {
    /* keep base */
  }
  return [
    `${base}/.well-known/oauth-authorization-server`,
    `${root}/.well-known/oauth-authorization-server`,
    `${root}/.well-known/openid-configuration`,
  ];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const routes: Route[] = [
  // POST /import — import a full config snapshot (admin)
  {
    method: 'POST',
    path: 'import',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<{ config?: Record<string, unknown> }>();
      const config = form.config ?? {};
      const claims = ctx.token ? decodeToken(ctx.token) : null;
      const humanAdminSession = claims !== null && String(claims.typ ?? 'session') === 'session';
      await updateMfaConfig(humanAdminSession, config);
      return ctx.json(await configGetAll());
    },
  },

  // GET /export (admin)
  {
    method: 'GET',
    path: 'export',
    auth: 'admin',
    handler: async (ctx) => ctx.json(await configGetAll()),
  },

  // GET /namespace/:namespace (admin)
  {
    method: 'GET',
    path: 'namespace/:namespace',
    auth: 'admin',
    handler: async (ctx) => ctx.json(await configGetNamespace(ctx.params.namespace)),
  },

  // POST /interface/visibility (admin)
  {
    method: 'POST',
    path: 'interface/visibility',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<{ visibility?: Record<string, boolean> }>();
      const visibility = form.visibility ?? {};
      await upsertConfig({ 'ui.visibility': visibility });
      return ctx.json({ visibility });
    },
  },

  // GET /connections (admin)
  {
    method: 'GET',
    path: 'connections',
    auth: 'admin',
    handler: async (ctx) => ctx.json(await getConfigValues(CONNECTIONS_CONFIG_KEYS)),
  },

  // POST /connections (admin)
  {
    method: 'POST',
    path: 'connections',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, unknown>>();
      await upsertConfig(configUpdates(form, CONNECTIONS_CONFIG_KEYS));
      return ctx.json(await getConfigValues(CONNECTIONS_CONFIG_KEYS));
    },
  },

  // POST /oauth/clients/register (admin)
  {
    method: 'POST',
    path: 'oauth/clients/register',
    auth: 'admin',
    handler: async (ctx) => {
      if (!ENABLE_TOOL_SERVERS) return ctx.error(403, 'Tool servers are disabled');
      const form = await ctx.body<{
        url?: string;
        client_id?: string;
        client_name?: string | null;
        client_secret?: string | null;
        oauth_server_url?: string | null;
        oauth_scope?: string | null;
      }>();
      const type = ctx.query.get('type');
      try {
        const clientId = String(form.client_id ?? '');
        const oauthClientId = type ? `${type}:${clientId}` : clientId;
        const oauthServerUrl = form.oauth_server_url || form.url || '';
        let clientInfo: Record<string, unknown>;
        if (form.client_secret) {
          // Static credentials (utils/oauth.get_oauth_client_info_with_static_credentials)
          clientInfo = {
            client_id: clientId,
            client_secret: form.client_secret,
            client_name: form.client_name ?? clientId,
            redirect_uris: [],
            scope: form.oauth_scope ?? '',
          };
        } else {
          // Dynamic registration (RFC 7591)
          let registrationEndpoint: string | null = null;
          for (const discoveryUrl of getDiscoveryUrls(oauthServerUrl)) {
            try {
              const metadata = (await fetchJson(discoveryUrl, {})) as Record<string, any>;
              if (metadata && typeof metadata === 'object' && typeof metadata.registration_endpoint === 'string') {
                registrationEndpoint = metadata.registration_endpoint;
                break;
              }
            } catch {
              /* try next */
            }
          }
          if (!registrationEndpoint) {
            throw new Error('Failed to fetch OAuth 2.1 discovery document');
          }
          const res = await fetch(registrationEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              client_name: form.client_name ?? oauthClientId,
              client_id: clientId || undefined,
              scope: form.oauth_scope ?? undefined,
            }),
            signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`Registration failed with status ${res.status}`);
          clientInfo = (await res.json()) as Record<string, unknown>;
        }
        return ctx.json({ status: true, oauth_client_info: encryptData(clientInfo) });
      } catch (e) {
        return ctx.error(400, `Failed to register OAuth client: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },

  // GET /tool_servers (admin)
  {
    method: 'GET',
    path: 'tool_servers',
    auth: 'admin',
    handler: async (ctx) => {
      const connections = await configGet<unknown[]>('tool_server.connections', []);
      return ctx.json({ TOOL_SERVER_CONNECTIONS: connections ?? [] });
    },
  },

  // POST /tool_servers (admin)
  {
    method: 'POST',
    path: 'tool_servers',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<{ TOOL_SERVER_CONNECTIONS?: any[] }>();
      const connections = (form.TOOL_SERVER_CONNECTIONS ?? []).map((c) => ({ ...(c ?? {}) }));
      await upsertConfig({ 'tool_server.connections': connections });
      return ctx.json({ TOOL_SERVER_CONNECTIONS: connections });
    },
  },

  // GET /terminal_servers (admin)
  {
    method: 'GET',
    path: 'terminal_servers',
    auth: 'admin',
    handler: async (ctx) => {
      const connections = await configGet<unknown[]>('terminal_server.connections');
      return ctx.json({ TERMINAL_SERVER_CONNECTIONS: connections });
    },
  },

  // POST /terminal_servers (admin)
  {
    method: 'POST',
    path: 'terminal_servers',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<{ TERMINAL_SERVER_CONNECTIONS?: any[] }>();
      const connections = (form.TERMINAL_SERVER_CONNECTIONS ?? []).map((c) => ({ ...(c ?? {}) }));
      await upsertConfig({ 'terminal_server.connections': connections });
      return ctx.json({ TERMINAL_SERVER_CONNECTIONS: connections });
    },
  },

  // POST /terminal_servers/verify (admin) — orchestrator/terminal detection proxy
  {
    method: 'POST',
    path: 'terminal_servers/verify',
    auth: 'admin',
    handler: async (ctx) => {
      if (!ENABLE_TOOL_SERVERS) return ctx.error(403, 'Tool servers are disabled');
      const form = await ctx.body<{ url?: string; auth_type?: string | null; key?: string | null }>();
      const baseUrl = (form.url ?? '').replace(/\/$/, '');
      if (!baseUrl) return ctx.error(400, 'Terminal server URL is required');
      const headers: Record<string, string> = {};
      if ((form.auth_type ?? 'bearer') === 'bearer' && form.key) Object.assign(headers, bearerAuthHeader(form.key));
      try {
        // Orchestrators expose a policies API; plain terminals don't.
        try {
          const res = await fetch(`${baseUrl}/api/v1/policies`, {
            headers,
            signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
          });
          if (res.ok) return ctx.json({ status: true, type: 'orchestrator' });
        } catch {
          /* fall through */
        }
        try {
          const res = await fetch(`${baseUrl}/api/config`, {
            headers,
            signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
          });
          if (res.ok) return ctx.json({ status: true, type: 'terminal' });
        } catch {
          /* fall through */
        }
      } catch (e) {
        console.error('Failed to connect to the terminal server', e);
      }
      return ctx.error(400, 'Failed to connect to the terminal server');
    },
  },

  // POST /terminal_servers/policy (admin) — proxy policy read/update
  {
    method: 'POST',
    path: 'terminal_servers/policy',
    auth: 'admin',
    handler: async (ctx) => {
      if (!ENABLE_TOOL_SERVERS) return ctx.error(403, 'Tool servers are disabled');
      const form = await ctx.body<{
        url?: string;
        key?: string | null;
        auth_type?: string | null;
        policy_id?: string;
        policy_data?: Record<string, unknown> | null;
      }>();
      const baseUrl = (form.url ?? '').replace(/\/$/, '');
      if (!baseUrl) return ctx.error(400, 'Terminal server URL is required');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if ((form.auth_type ?? 'bearer') === 'bearer' && form.key) Object.assign(headers, bearerAuthHeader(form.key));
      try {
        const res = await fetch(`${baseUrl}/api/v1/policies/${form.policy_id ?? ''}`, {
          method: form.policy_data == null ? 'GET' : 'PUT',
          headers,
          ...(form.policy_data == null ? {} : { body: JSON.stringify(form.policy_data) }),
          signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
        });
        if (res.ok) return ctx.json(await res.json());
        return ctx.error(res.status, await res.text());
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error('Failed to access policy on terminal server', e);
        return ctx.error(400, 'Failed to access policy on terminal server');
      }
    },
  },

  // POST /terminal_servers/lifecycle (admin) — proxy lifecycle read/update
  {
    method: 'POST',
    path: 'terminal_servers/lifecycle',
    auth: 'admin',
    handler: async (ctx) => {
      if (!ENABLE_TOOL_SERVERS) return ctx.error(403, 'Tool servers are disabled');
      const form = await ctx.body<{
        url?: string;
        key?: string | null;
        auth_type?: string | null;
        policy_id?: string;
        lifecycle_data?: Record<string, unknown> | null;
      }>();
      const baseUrl = (form.url ?? '').replace(/\/$/, '');
      if (!baseUrl) return ctx.error(400, 'Terminal server URL is required');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if ((form.auth_type ?? 'bearer') === 'bearer' && form.key) Object.assign(headers, bearerAuthHeader(form.key));
      try {
        const res = await fetch(`${baseUrl}/api/v1/policies/${form.policy_id ?? ''}/lifecycle`, {
          method: form.lifecycle_data == null ? 'GET' : 'PUT',
          headers,
          ...(form.lifecycle_data == null ? {} : { body: JSON.stringify(form.lifecycle_data) }),
          signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
        });
        if (res.ok) return ctx.json(await res.json());
        return ctx.error(res.status, await res.text());
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error('Failed to access lifecycle on terminal server', e);
        return ctx.error(400, 'Failed to access lifecycle on terminal server');
      }
    },
  },

  // POST /terminal_servers/refresh (admin) — proxy terminal refresh
  {
    method: 'POST',
    path: 'terminal_servers/refresh',
    auth: 'admin',
    handler: async (ctx) => {
      if (!ENABLE_TOOL_SERVERS) return ctx.error(403, 'Tool servers are disabled');
      const form = await ctx.body<{
        url?: string;
        key?: string | null;
        auth_type?: string | null;
        user_id?: string | null;
        policy_id?: string | null;
        only_idle?: boolean;
        reset?: boolean;
      }>();
      const baseUrl = (form.url ?? '').replace(/\/$/, '');
      if (!baseUrl) return ctx.error(400, 'Terminal server URL is required');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if ((form.auth_type ?? 'bearer') === 'bearer' && form.key) Object.assign(headers, bearerAuthHeader(form.key));
      const body: Record<string, unknown> = {
        only_idle: form.only_idle ?? true,
        reset: form.reset ?? false,
      };
      if (form.user_id) body.user_id = form.user_id;
      if (form.policy_id) body.policy_id = form.policy_id;
      try {
        const res = await fetch(`${baseUrl}/api/v1/terminals/refresh`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
        });
        if (res.ok) return ctx.json(await res.json());
        return ctx.error(res.status, await res.text());
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error('Failed to refresh terminals', e);
        return ctx.error(400, 'Failed to refresh terminals');
      }
    },
  },

  // POST /tool_servers/verify (admin)
  {
    method: 'POST',
    path: 'tool_servers/verify',
    auth: 'admin',
    handler: async (ctx) => {
      if (!ENABLE_TOOL_SERVERS) return ctx.error(403, 'Tool servers are disabled');
      const form = await ctx.body<{
        url?: string;
        path?: string;
        type?: string | null;
        auth_type?: string | null;
        forward_cookies?: boolean;
        headers?: Record<string, string> | string | null;
        key?: string | null;
        config?: Record<string, unknown> | null;
        info?: Record<string, any> | null;
      }>();
      try {
        if ((form.type ?? 'openapi') === 'mcp') {
          if ((form.auth_type ?? 'none') === 'oauth_2.1' || form.auth_type === 'oauth_2.1_static') {
            const oauthServerUrl =
              (form.info && form.info.oauth_server_url ? form.info.oauth_server_url : null) ?? form.url ?? '';
            const discoveryUrls = getDiscoveryUrls(oauthServerUrl);
            for (const discoveryUrl of discoveryUrls) {
              try {
                const metadata = (await fetchJson(discoveryUrl, {})) as Record<string, any>;
                if (metadata && typeof metadata === 'object' && 'issuer' in metadata) {
                  return ctx.json({ status: true, oauth_server_metadata: metadata });
                }
              } catch {
                /* try next */
              }
            }
            return ctx.error(400, `Failed to fetch OAuth 2.1 discovery document from ${discoveryUrls.join(',')}`);
          }
          // No MCP client runtime in the TS port
          return ctx.error(400, 'Failed to create MCP client');
        }
        // openapi
        const headers: Record<string, string> = {};
        if ((form.auth_type ?? 'none') === 'bearer' && form.key) Object.assign(headers, bearerAuthHeader(form.key));
        else if ((form.auth_type ?? 'none') === 'session' && ctx.token) Object.assign(headers, bearerAuthHeader(ctx.token));
        const url = getToolServerUrl(form.url, form.path ?? 'openapi.json');
        return ctx.json(await fetchJson(url, headers));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error('Failed to connect to the tool server', e);
        return ctx.error(400, 'Failed to connect to the tool server');
      }
    },
  },

  // GET /code_execution (admin)
  {
    method: 'GET',
    path: 'code_execution',
    auth: 'admin',
    handler: async (ctx) => ctx.json(await getConfigValues(CODE_EXECUTION_CONFIG_KEYS)),
  },

  // POST /code_execution (admin)
  {
    method: 'POST',
    path: 'code_execution',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, unknown>>();
      await upsertConfig(configUpdates(form, CODE_EXECUTION_CONFIG_KEYS));
      return ctx.json(await getConfigValues(CODE_EXECUTION_CONFIG_KEYS));
    },
  },

  // GET /models/defaults (verified user)
  {
    method: 'GET',
    path: 'models/defaults',
    auth: 'user',
    handler: async (ctx) => {
      const metadata = await configGet<unknown>('models.default_metadata', ENV_DEFAULTS['models.default_metadata']);
      return ctx.json({ DEFAULT_MODEL_METADATA: metadata });
    },
  },

  // GET /models (admin)
  {
    method: 'GET',
    path: 'models',
    auth: 'admin',
    handler: async (ctx) => ctx.json(await getConfigValues(MODELS_CONFIG_KEYS)),
  },

  // POST /models (admin)
  {
    method: 'POST',
    path: 'models',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, unknown>>();
      await upsertConfig(configUpdates(form, MODELS_CONFIG_KEYS));
      return ctx.json(await getConfigValues(MODELS_CONFIG_KEYS));
    },
  },

  // GET /subagents (admin)
  {
    method: 'GET',
    path: 'subagents',
    auth: 'admin',
    handler: async (ctx) => ctx.json(await getConfigValues(SUBAGENTS_CONFIG_KEYS)),
  },

  // POST /subagents (admin)
  {
    method: 'POST',
    path: 'subagents',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, unknown>>();
      await upsertConfig(configUpdates(form, SUBAGENTS_CONFIG_KEYS));
      return ctx.json(await getConfigValues(SUBAGENTS_CONFIG_KEYS));
    },
  },

  // POST /suggestions (admin)
  {
    method: 'POST',
    path: 'suggestions',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<{ suggestions?: any[] | null; i18n?: Record<string, any> | null }>();
      await upsertConfig({
        'ui.prompt_suggestions': form.suggestions ?? null,
        'ui.prompt_suggestions_i18n': form.i18n ?? {},
      });
      const suggestions = await configGet<unknown>('ui.prompt_suggestions');
      const suggestionsI18n = await configGet<unknown>('ui.prompt_suggestions_i18n');
      return ctx.json({ suggestions, i18n: suggestionsI18n });
    },
  },

  // POST /banners (admin)
  {
    method: 'POST',
    path: 'banners',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<{ banners?: any[] }>();
      await upsertConfig({ 'ui.banners': form.banners ?? [] });
      const banners = await configGet<unknown[]>('ui.banners');
      return ctx.json(banners ?? []);
    },
  },

  // GET /banners (verified user)
  {
    method: 'GET',
    path: 'banners',
    auth: 'user',
    handler: async (ctx) => {
      const banners = await configGet<unknown[]>('ui.banners', []);
      return ctx.json(banners ?? []);
    },
  },
];
