export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { dispatchOauth } from '@/server/registry';

type Params = { params: Promise<{ path?: string[] }> };

async function handler(req: NextRequest, _params: Params) {
  return dispatchOauth(req as unknown as Request);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
