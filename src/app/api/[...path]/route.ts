export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';

/**
 * FastAPI parity: any unmatched /api/* path returns {"detail":"Not Found"}
 * (JSON, not an HTML page). Static routes (/api/config, /api/models, ...) and
 * the /api/v1 catch-all take precedence over this route in Next.js routing.
 */

type Params = { params: Promise<{ path?: string[] }> };

async function handler(_req: NextRequest, _params: Params) {
  return Response.json({ detail: 'Not Found' }, { status: 404 });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
