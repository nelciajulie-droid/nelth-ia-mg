export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { dispatchPrefixed } from '@/server/registry';

type Params = { params: Promise<{ path?: string[] }> };

async function handler(req: NextRequest, _params: Params) {
  return dispatchPrefixed(req as unknown as Request, 'openai');
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
