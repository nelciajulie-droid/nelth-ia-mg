export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// The /api/v1/imagine worker (next/server after()) runs its whole generation
// batch inside this invocation after the response — give it the full 300s
// platform window (vercel.json parity) instead of relying on the glob alone.
export const maxDuration = 300;

import { NextRequest } from 'next/server';
import { dispatch } from '@/server/registry';

type Params = { params: Promise<{ path?: string[] }> };

async function handler(req: NextRequest, { params }: Params) {
  const { path } = await params;
  return dispatch(req as unknown as Request, path ?? [], 'v1');
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
