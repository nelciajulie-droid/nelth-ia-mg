import { getCurrentUser, ApiUser } from '@/lib/auth';

/**
 * FastAPI-like request context + routing primitives for the Next.js catch-all
 * API dispatcher. All router modules (src/server/routers/*.ts) export
 * `routes: Route[]` and are matched by src/server/registry.ts.
 */

export class HttpError extends Error {
  constructor(
    public status: number,
    public detail: string | unknown[]
  ) {
    super(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
}

export type Ctx = {
  req: Request;
  method: string;
  /** e.g. "signin" | "chats/abc" (already stripped of the mount prefix) */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  user: ApiUser | null;
  body: <T = any>() => Promise<T>;
  rawBody: () => Promise<ArrayBuffer>;
  /** FastAPI-style JSON response. */
  json: (data: unknown, status?: number) => Response;
  /** FastAPI-style error {"detail": "..."} — throws HttpError (caught by the dispatcher). */
  error: (status: number, detail: string | unknown[]) => never;
  /** Extract bearer token used for auth. */
  token: string | null;
};

export type Route = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Path relative to the router prefix, supports ":param" segments, e.g. ":id/messages". */
  path: string;
  /** auth='user' → 401 when unauthenticated; 'admin' → additionally 403 for non-admins; 'optional' resolves user when present. */
  auth?: 'user' | 'admin' | 'optional' | 'none';
  handler: (ctx: Ctx) => Promise<Response> | Response;
};

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function errorResponse(status: number, detail: string | unknown[]): Response {
  return jsonResponse({ detail }, status);
}

/** FastAPI HTTPException parity for 422 validation errors. */
export function validationError(detail: string): never {
  throw new HttpError(422, detail);
}

/** FastAPI Query(int) parity — non-integer query values produce the exact
 *  pydantic 422 body: {detail:[{type:'int_parsing',loc:['query',name],…}]}. */
export function queryIntStrict(query: URLSearchParams, name: string): number | null {
  const raw = query.get(name);
  if (raw === null || raw === '') return null;
  if (!/^-?\d+$/.test(raw)) {
    throw new HttpError(422, [
      {
        type: 'int_parsing',
        loc: ['query', name],
        msg: 'Input should be a valid integer, unable to parse string as an integer',
        input: raw,
      },
    ]);
  }
  return parseInt(raw, 10);
}

let cachedBody: ArrayBuffer | null = null;
let cachedJson: any;

export async function buildCtx(req: Request, path: string, params: Record<string, string>): Promise<Ctx> {
  cachedBody = null;
  cachedJson = undefined;
  const url = new URL(req.url);
  const user = await getCurrentUser(req);

  const ctx: Ctx = {
    req,
    method: req.method.toUpperCase(),
    path,
    params,
    query: url.searchParams,
    user,
    token: req.headers.get('authorization')?.split(' ')[1] ?? null,
    body: async <T = any>() => {
      if (cachedJson === undefined) {
        if (!cachedBody) cachedBody = await req.arrayBuffer();
        const text = new TextDecoder().decode(cachedBody);
        cachedJson = text ? JSON.parse(text) : {};
      }
      return cachedJson as T;
    },
    rawBody: async () => {
      if (!cachedBody) cachedBody = await req.arrayBuffer();
      return cachedBody;
    },
    json: jsonResponse,
    error: (status, detail) => {
      throw new HttpError(status, detail);
    },
  };
  return ctx;
}

/** Match a route table against (method, pathSegments). */
export function matchRoute(
  routes: Route[],
  method: string,
  segments: string[]
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const routeSegs = route.path.split('/').filter(Boolean);
    if (routeSegs.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < routeSegs.length; i++) {
      const rs = routeSegs[i];
      if (rs.startsWith(':')) {
        params[rs.slice(1)] = decodeURIComponent(segments[i]);
      } else if (rs !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/** Auth gate equivalent to FastAPI dependencies. */
export function applyAuth(route: Route, user: ApiUser | null): void {
  const level = route.auth ?? 'user';
  if (level === 'none' || level === 'optional') return;
  if (!user) throw new HttpError(401, 'Not authenticated');
  if (level === 'admin' && user.role !== 'admin') {
    throw new HttpError(
      403,
      'You do not have permission to access this resource. Please contact your administrator for assistance.'
    );
  }
}
