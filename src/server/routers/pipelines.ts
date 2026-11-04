import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { env } from '@/lib/constants';
import { configGet } from '@/lib/config';

/**
 * Port of open_webui/routers/pipelines.py (v0.12.5) — /api/v1/pipelines/*.
 *
 * Every endpoint proxies to a configured OpenAI-compatible connection
 * (openai.api_base_urls / openai.api_keys, falling back to the TS port's
 * openai.api.configs dict and the env default connection). All endpoints are
 * admin-only. Upstream failures map to 404 'Pipeline not found' (or the
 * upstream status + detail when the body carries one).
 */

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

type Conn = { url: string; key: string };

/** Python get_openai_connection — config 'openai.api_base_urls'/'openai.api_keys'. */
async function getOpenAiConnections(): Promise<Conn[]> {
  const baseUrls = await configGet<string[] | null>('openai.api_base_urls', null);
  const apiKeys = await configGet<string[] | null>('openai.api_keys', null);

  if (Array.isArray(baseUrls) && baseUrls.length) {
    const keys = Array.isArray(apiKeys) ? apiKeys : [];
    return baseUrls.map((url, i) => ({ url: url.replace(/\/$/, ''), key: keys[i] ?? '' }));
  }

  // TS openai router storage: openai.api.configs dict (index-stable).
  const configs = await configGet<Record<string, any> | null>('openai.api.configs', null);
  if (configs && typeof configs === 'object') {
    const conns: Conn[] = [];
    for (const cfg of Object.values(configs)) {
      if (!cfg || typeof cfg !== 'object' || !cfg.base_url) continue;
      conns.push({ url: String(cfg.base_url).replace(/\/$/, ''), key: String(cfg.api_key ?? '') });
    }
    if (conns.length) return conns;
  }

  // env default connection
  return [{ url: env.OPENAI_API_BASE_URL.replace(/\/$/, ''), key: env.OPENAI_API_KEY }];
}

async function getOpenAiConnection(urlIdx: number | null): Promise<Conn> {
  if (urlIdx === null || urlIdx === undefined || Number.isNaN(Number(urlIdx))) {
    // Python: base_urls[None] raises TypeError → generic 404 'Pipeline not found'
    err(404, 'Pipeline not found');
  }
  const conns = await getOpenAiConnectionList();
  const conn = conns[Number(urlIdx)];
  if (!conn) err(404, 'Pipeline not found');
  return conn;
}

async function getOpenAiConnectionList(): Promise<Conn[]> {
  return getOpenAiConnections();
}

/** Shared proxy error mapping (pipelines.py raise pattern). */
async function proxyError(res: Response | null): Promise<never> {
  let detail: string | null = null;
  if (res !== null) {
    try {
      const body = await res.clone().json();
      if (body && typeof body === 'object' && 'detail' in body) detail = String((body as any).detail);
    } catch {
      /* no detail */
    }
    err(res.status, detail ?? 'Pipeline not found');
  }
  err(404, 'Pipeline not found');
}

async function authHeaders(conn: Conn): Promise<Record<string, string>> {
  return conn.key ? { authorization: `Bearer ${conn.key}` } : {};
}

async function proxyJson(
  conn: Conn,
  path: string,
  init: RequestInit,
  okStatus = 200
): Promise<Response> {
  let res: Response | null = null;
  try {
    res = await fetch(`${conn.url}/${path.replace(/^\//, '')}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(await authHeaders(conn)) },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) await proxyError(res);
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: okStatus,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return proxyError(res);
  }
}

export const routes: Route[] = [
  // ------------------- GET /list (admin) -------------------
  {
    method: 'GET',
    path: 'list',
    auth: 'admin',
    handler: async (ctx) => {
      const conns = await getOpenAiConnections();
      const data: Array<{ url: string; idx: number }> = [];
      await Promise.all(
        conns.map(async (conn, idx) => {
          try {
            const res = await fetch(`${conn.url}/models`, {
              headers: await authHeaders(conn),
              signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return;
            const body = await res.json();
            if (body && typeof body === 'object' && 'pipelines' in body) {
              data.push({ url: conn.url, idx });
            }
          } catch {
            // connection down → skip
          }
        })
      );
      data.sort((a, b) => a.idx - b.idx);
      return ctx.json({ data });
    },
  },

  // ------------------- POST /upload (admin) -------------------
  {
    method: 'POST',
    path: 'upload',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.req.formData().catch(() => null);
      if (!form) err(422, 'Field required (urlIdx)');
      const urlIdxRaw = form!.get('urlIdx');
      const fileField = form!.get('file');
      const urlIdx = urlIdxRaw !== null ? parseInt(String(urlIdxRaw), 10) : NaN;
      if (!Number.isFinite(urlIdx)) err(422, 'Field required (urlIdx)');
      if (!(fileField instanceof File)) err(422, 'Field required (file)');

      const filename = (fileField.name ?? '').split(/[\\/]/).pop() ?? '';
      if (!(filename && filename.endsWith('.py'))) {
        err(400, 'Only Python (.py) files are allowed.');
      }

      const conn = await getOpenAiConnection(urlIdx);
      const fd = new FormData();
      fd.set('file', fileField, filename);

      let res: Response | null = null;
      try {
        res = await fetch(`${conn.url}/pipelines/upload`, {
          method: 'POST',
          headers: await authHeaders(conn),
          body: fd,
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) await proxyError(res);
        const data = await res.json();
        return ctx.json({ ...data });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return proxyError(res);
      }
    },
  },

  // ------------------- POST /add (admin) -------------------
  {
    method: 'POST',
    path: 'add',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, any>>();
      if (!form?.url) err(422, 'Field required (url)');
      if (form?.urlIdx === undefined || form?.urlIdx === null) err(422, 'Field required (urlIdx)');
      const conn = await getOpenAiConnection(parseInt(String(form.urlIdx), 10));
      return proxyJson(conn, 'pipelines/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: form.url }),
      });
    },
  },

  // ------------------- DELETE /delete (admin) -------------------
  {
    method: 'DELETE',
    path: 'delete',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, any>>();
      if (!form?.id) err(422, 'Field required (id)');
      if (form?.urlIdx === undefined || form?.urlIdx === null) err(422, 'Field required (urlIdx)');
      const conn = await getOpenAiConnection(parseInt(String(form.urlIdx), 10));
      return proxyJson(conn, 'pipelines/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: form.id }),
      });
    },
  },

  // ------------------- GET / (admin) -------------------
  {
    method: 'GET',
    path: '',
    auth: 'admin',
    handler: async (ctx) => {
      const urlIdxRaw = ctx.query.get('urlIdx');
      if (urlIdxRaw === null) err(404, 'Pipeline not found'); // Python: base_urls[None] → 404
      const conn = await getOpenAiConnection(parseInt(urlIdxRaw, 10));
      return proxyJson(conn, 'pipelines', { method: 'GET' });
    },
  },

  // ------------------- GET /{pipeline_id}/valves (admin) -------------------
  {
    method: 'GET',
    path: ':pipeline_id/valves',
    auth: 'admin',
    handler: async (ctx) => {
      const urlIdxRaw = ctx.query.get('urlIdx');
      if (urlIdxRaw === null) err(404, 'Pipeline not found');
      const conn = await getOpenAiConnection(parseInt(urlIdxRaw, 10));
      return proxyJson(conn, `${ctx.params.pipeline_id}/valves`, { method: 'GET' });
    },
  },

  // ------------------- GET /{pipeline_id}/valves/spec (admin) -------------------
  {
    method: 'GET',
    path: ':pipeline_id/valves/spec',
    auth: 'admin',
    handler: async (ctx) => {
      const urlIdxRaw = ctx.query.get('urlIdx');
      if (urlIdxRaw === null) err(404, 'Pipeline not found');
      const conn = await getOpenAiConnection(parseInt(urlIdxRaw, 10));
      return proxyJson(conn, `${ctx.params.pipeline_id}/valves/spec`, { method: 'GET' });
    },
  },

  // ------------------- POST /{pipeline_id}/valves/update (admin) -------------------
  {
    method: 'POST',
    path: ':pipeline_id/valves/update',
    auth: 'admin',
    handler: async (ctx) => {
      const urlIdxRaw = ctx.query.get('urlIdx');
      if (urlIdxRaw === null) err(404, 'Pipeline not found');
      const conn = await getOpenAiConnection(parseInt(urlIdxRaw, 10));
      const form = await ctx.body<Record<string, any>>();
      return proxyJson(conn, `${ctx.params.pipeline_id}/valves/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(form ?? {}) }),
      });
    },
  },
];
