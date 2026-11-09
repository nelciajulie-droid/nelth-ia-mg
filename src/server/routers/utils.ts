import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import crypto from 'crypto';
import { configGet } from '@/lib/config';
import { ERROR_MESSAGES } from '@/lib/constants';

/**
 * Port of open_webui/routers/utils.py (/api/v1/utils).
 *
 * Deviations:
 *  • `black` (Python code formatter) has no JS equivalent — /code/format
 *    returns the code unchanged (Python's `NothingChanged` path).
 *  • /code/execute supports the `jupyter` engine only (same as Python);
 *    `pyodide` (the default engine) is rejected exactly like any other
 *    unsupported engine.
 */

const envStr = (key: string, def: string) => process.env[key] ?? def;
const envInt = (key: string, def: number) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
};

const ENABLE_ADMIN_EXPORT = (process.env.ENABLE_ADMIN_EXPORT ?? 'True').toLowerCase() === 'true';

// Error strings not present in lib/constants.ts (Python v0.12.5 constants.py)
const FEATURE_DISABLED = (name = ''): string => `${name} is disabled`;
const DEFAULT_ERROR = (msg = ''): string =>
  msg ? `[ERROR: ${String(msg)}]` : 'Something went wrong :/';
const DB_NOT_SQLITE = 'This feature is only available with SQLite databases.';

/** Python: get_verified_user — role must be user/admin. */
function requireVerifiedUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new HttpError(401, 'Not authenticated');
  if (!['user', 'admin'].includes(user.role)) {
    throw new HttpError(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
  }
  return user;
}

// ---------------------------------------------------------------------------
// GET /gravatar — utils/misc.get_gravatar_url
// ---------------------------------------------------------------------------

function getGravatarUrl(email: string): string {
  const address = String(email).trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(address).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?d=mp`;
}

// ---------------------------------------------------------------------------
// POST /code/execute — utils/code_interpreter.execute_code_jupyter
// ---------------------------------------------------------------------------

type JupyterResult = { stdout: string; stderr: string; result: string };

async function executeCodeJupyter(
  baseUrl: string,
  code: string,
  token: string | null,
  password: string | null,
  timeout: number
): Promise<JupyterResult> {
  const result: JupyterResult = { stdout: '', stderr: '', result: '' };
  let base = baseUrl;
  if (!base.endsWith('/')) base += '/';

  const params = new URLSearchParams();
  if (token) params.set('token', token);

  let cookieHeader = '';
  const extraHeaders: Record<string, string> = {};

  try {
    // password authentication
    if (password && !token) {
      const loginUrl = `${base}login`;
      const loginResp = await fetch(loginUrl, { redirect: 'manual' });
      if (!loginResp.ok) throw new Error(`login failed: ${loginResp.status}`);
      const setCookie = loginResp.headers.get('set-cookie') ?? '';
      const xsrf = /_xsrf=([^;]+)/.exec(setCookie)?.[1];
      if (!xsrf) throw new Error('_xsrf token not found');
      cookieHeader = `_xsrf=${xsrf}`;
      extraHeaders['X-XSRFToken'] = xsrf;
      const authResp = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: cookieHeader,
          'X-XSRFToken': xsrf,
        },
        body: new URLSearchParams({ _xsrf: xsrf, password }).toString(),
        redirect: 'manual',
      });
      const authCookie = authResp.headers.get('set-cookie') ?? '';
      const parts: string[] = [];
      for (const chunk of [cookieHeader, authCookie]) {
        if (chunk) for (const pair of chunk.split(/,(?=[^;]+=)/)) {
          const kv = pair.split(';')[0].trim();
          if (kv && !parts.includes(kv)) parts.push(kv);
        }
      }
      cookieHeader = parts.join('; ');
    }

    // start kernel
    const kernelUrl = `${base}api/kernels${params.toString() ? `?${params.toString()}` : ''}`;
    const kernelResp = await fetch(kernelUrl, {
      method: 'POST',
      headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), ...extraHeaders },
    });
    if (!kernelResp.ok) throw new Error(`kernel init failed: ${kernelResp.status}`);
    const kernel = (await kernelResp.json()) as { id: string };
    const kernelId = kernel.id;

    try {
      const wsBase = base.replace(/^http/, 'ws');
      const wsQuery = params.toString() ? `?${params.toString()}` : '';
      const wsUrl = `${wsBase}api/kernels/${kernelId}/channels${wsQuery}`;
      await executeInJupyter(wsUrl, wsQuery, cookieHeader, extraHeaders, code, timeout, result);
    } finally {
      // close kernel (best effort, mirrors __aexit__)
      await fetch(`${base}api/kernels/${kernelId}${params.toString() ? `?${params.toString()}` : ''}`, {
        method: 'DELETE',
        headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), ...extraHeaders },
      }).catch(() => undefined);
    }
  } catch (err) {
    result.stderr = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return result;
}

async function executeInJupyter(
  wsUrl: string,
  _wsQuery: string,
  cookieHeader: string,
  extraHeaders: Record<string, string>,
  code: string,
  timeout: number,
  result: JupyterResult
): Promise<void> {
  const wsHeaders: Record<string, string> = { ...extraHeaders };
  if (cookieHeader) wsHeaders['Cookie'] = cookieHeader;

  // Bun's WebSocket accepts { headers } as the 2nd constructor argument; Node's
  // undici implementation does not (falls back to a header-less connection).
  const WS: any = WebSocket;
  let ws: WebSocket;
  try {
    ws = new WS(wsUrl, Object.keys(wsHeaders).length ? { headers: wsHeaders } : undefined) as WebSocket;
  } catch {
    ws = new WebSocket(wsUrl);
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('websocket connection failed'));
  });

  const msgId = crypto.randomUUID().replace(/-/g, '');
  ws.send(
    JSON.stringify({
      header: {
        msg_id: msgId,
        msg_type: 'execute_request',
        username: 'user',
        session: crypto.randomUUID().replace(/-/g, ''),
        date: '',
        version: '5.3',
      },
      parent_header: {},
      metadata: {},
      content: {
        code,
        silent: false,
        store_history: true,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      },
      channel: 'shell',
    })
  );

  let stdout = '';
  let stderr = '';
  const out: string[] = [];

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve();
    };
    const timer = setTimeout(() => {
      stderr += '\nExecution timed out.';
      finish();
    }, timeout * 1000);

    ws.onmessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (message?.parent_header?.msg_id !== msgId) return;
        const msgType = message.msg_type as string;
        const content = message.content ?? {};
        if (msgType === 'stream') {
          if (content.name === 'stdout') stdout += content.text ?? '';
          else if (content.name === 'stderr') stderr += content.text ?? '';
        } else if (msgType === 'execute_result' || msgType === 'display_data') {
          const data = content.data ?? {};
          if ('image/png' in data) out.push(`data:image/png;base64,${data['image/png']}`);
          else if ('text/plain' in data) out.push(String(data['text/plain']));
        } else if (msgType === 'error') {
          stderr += Array.isArray(content.traceback) ? content.traceback.join('\n') : '';
        } else if (msgType === 'status' && content.execution_state === 'idle') {
          finish();
        }
      } catch {
        /* skip malformed frame */
      }
    };
    ws.onclose = () => finish();
    ws.onerror = () => {
      if (!settled) {
        stderr += '\nExecution failed.';
        finish();
      }
    };
  });

  result.stdout = stdout.trim();
  result.stderr = stderr.trim();
  result.result = out.length ? out.join('\n').trim() : '';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /favicon?domain=example.com — public same-origin favicon proxy
// ---------------------------------------------------------------------------
// Citation pills and the sources panel display favicons. Loading them
// directly from a third-party icon service (google s2 / duckduckgo) breaks
// on client networks that block those hosts — the icons silently vanish.
// Serving them through the app itself makes the images same-origin (they
// traverse the exact same gateway/proxy as every other asset) so the
// favicons render for every user, on every network.
//
// Public (auth: 'none'): <img> tags cannot carry an Authorization header.
// Only hostnames are accepted — no scheme, path, or userinfo — so the
// endpoint cannot be abused as an open URL proxy.

const FAVICON_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FAVICON_MAX_ENTRIES = 1000;

const faviconCache = new Map<string, { body: ArrayBuffer; type: string; expires: number }>();

/** 1×1 transparent PNG — served only when both icon upstreams are unreachable. */
const FAVICON_FALLBACK_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  )
);

async function fetchFavicon(domain: string): Promise<{ body: ArrayBuffer; type: string }> {
  const upstreams = [
    `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(domain)}`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
  ];
  for (const url of upstreams) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
      });
      if (!res.ok) continue;
      const type = res.headers.get('content-type') ?? '';
      if (!type.startsWith('image/')) continue;
      const body = await res.arrayBuffer();
      if (body.byteLength === 0) continue;
      return { body, type };
    } catch {
      // try the next upstream
    }
  }
  return { body: FAVICON_FALLBACK_PNG.slice().buffer, type: 'image/png' };
}

async function faviconResponse(domain: string): Promise<Response> {
  const now = Date.now();
  const hit = faviconCache.get(domain);
  if (hit && hit.expires > now) {
    return new Response(hit.body, {
      headers: { 'content-type': hit.type, 'cache-control': 'public, max-age=86400' },
    });
  }
  const { body, type } = await fetchFavicon(domain);
  faviconCache.set(domain, { body, type, expires: now + FAVICON_TTL_MS });
  // Bound the cache: drop the ~200 oldest entries once it grows too large.
  if (faviconCache.size > FAVICON_MAX_ENTRIES) {
    for (const key of [...faviconCache.keys()].slice(0, 200)) faviconCache.delete(key);
  }
  return new Response(body, {
    headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' },
  });
}

// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // GET /favicon?domain=example.com — public, cached, same-origin icon proxy
  {
    method: 'GET',
    path: 'favicon',
    auth: 'none',
    handler: async (ctx) => {
      let domain = (ctx.query.get('domain') ?? '').trim().toLowerCase();
      // The compiled citation templates pass the merged source name — a FULL
      // URL ("https://example.com/article") — as the domain parameter.
      // Extract the hostname so those callers resolve the right icon too.
      if (domain.includes('://') || domain.includes('/')) {
        try {
          domain = new URL(/^https?:\/\//.test(domain) ? domain : `https://${domain.split('/')[0]}`).hostname;
        } catch {
          // fall through to validation below (fails cleanly with 422)
        }
      }
      domain = domain.replace(/^www\./, '');
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
        throw new HttpError(422, "Invalid 'domain'");
      }
      return faviconResponse(domain);
    },
  },

  // GET /gravatar
  {
    method: 'GET',
    path: 'gravatar',
    auth: 'user',
    handler: async (ctx) => {
      requireVerifiedUser(ctx);
      const email = ctx.query.get('email');
      if (email === null) throw new HttpError(422, "Field required: 'email'");
      return ctx.json(getGravatarUrl(email));
    },
  },

  // POST /code/format
  {
    method: 'POST',
    path: 'code/format',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<{ code?: string }>();
      // black.format_str is unavailable in the JS runtime — the code is
      // returned unchanged (Python's NothingChanged branch).
      return ctx.json({ code: form.code ?? '' });
    },
  },

  // POST /code/execute
  {
    method: 'POST',
    path: 'code/execute',
    auth: 'user',
    handler: async (ctx) => {
      requireVerifiedUser(ctx);
      const form = await ctx.body<{ code?: string }>();

      if (!(await configGet<boolean>('code_execution.enable', envBoolDefault('ENABLE_CODE_EXECUTION', 'True')))) {
        throw new HttpError(403, FEATURE_DISABLED('Code execution'));
      }

      const engine = await configGet<string>('code_execution.engine', envStr('CODE_EXECUTION_ENGINE', 'pyodide'));
      if (engine === 'jupyter') {
        const auth = await configGet<string>('code_execution.jupyter.auth', envStr('CODE_EXECUTION_JUPYTER_AUTH', ''));
        const output = await executeCodeJupyter(
          await configGet<string>('code_execution.jupyter.url', envStr('CODE_EXECUTION_JUPYTER_URL', '')),
          form.code ?? '',
          auth === 'token'
            ? await configGet<string>('code_execution.jupyter.auth_token', envStr('CODE_EXECUTION_JUPYTER_AUTH_TOKEN', ''))
            : null,
          auth === 'password'
            ? await configGet<string>(
                'code_execution.jupyter.auth_password',
                envStr('CODE_EXECUTION_JUPYTER_AUTH_PASSWORD', '')
              )
            : null,
          await configGet<number>('code_execution.jupyter.timeout', envInt('CODE_EXECUTION_JUPYTER_TIMEOUT', 60))
        );
        return ctx.json(output);
      }
      throw new HttpError(400, DEFAULT_ERROR('Code execution engine not supported'));
    },
  },

  // GET /db/download
  {
    method: 'GET',
    path: 'db/download',
    auth: 'admin',
    handler: async () => {
      if (!ENABLE_ADMIN_EXPORT) {
        throw new HttpError(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      // SQLite-only export (Python parity). Nelth-AI runs exclusively on the
      // hosted Supabase Postgres — there is no local .db file to stream, so
      // the endpoint answers the same clean 400 the Python app returns on
      // Postgres deployments. (Supabase users export via the dashboard:
      // Database → Backups / pg_dump.)
      throw new HttpError(400, DB_NOT_SQLITE);
    },
  },
];

function envBoolDefault(key: string, def: string): boolean {
  return (process.env[key] ?? def).toLowerCase() === 'true';
}
