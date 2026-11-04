export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';

/**
 * Reverse proxy /ws/* → socket-service.
 *
 * The ORIGINAL frontend's socket.io client connects same-origin to
 * `/ws/socket.io/?EIO=4&transport=polling` (path hardcoded, frontend untouched).
 * The Next.js app proxies that transport to the co-located socket service, so
 * the entire product is served from a single origin/port — it runs identically
 * behind any reverse proxy (Caddy/nginx/…), on a container platform, or
 * directly on a host. The websocket upgrade attempt fails gracefully through
 * this proxy and socket.io stays on long-polling, which works end-to-end.
 *
 * Override the service location with SOCKET_SERVICE_URL (default
 * http://127.0.0.1:3001) — e.g. when the socket service runs in another
 * container/network.
 */
const UPSTREAM = process.env.SOCKET_SERVICE_URL || 'http://127.0.0.1:3001';

type Params = { params: Promise<{ path?: string[] }> };

async function proxy(req: NextRequest, _params: Params): Promise<Response> {
  const url = new URL(req.url);
  const target = `${UPSTREAM}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  const upstreamHost = (() => {
    try {
      return new URL(UPSTREAM).host;
    } catch {
      return '127.0.0.1:3001';
    }
  })();
  headers.set('host', upstreamHost);
  headers.delete('accept-encoding'); // avoid compressed passthrough issues

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const body = hasBody ? await req.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: body as any,
      redirect: 'manual',
      // long-poll responses take up to ~25s
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return Response.json(
      { detail: 'socket service unavailable' },
      { status: 502 }
    );
  }

  const outHeaders = new Headers();
  for (const name of [
    'content-type',
    'content-length',
    'cache-control',
    'set-cookie',
    'connection',
  ]) {
    const v = upstream.headers.get(name);
    if (v) outHeaders.set(name, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const OPTIONS = proxy;
