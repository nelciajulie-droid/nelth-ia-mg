export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
