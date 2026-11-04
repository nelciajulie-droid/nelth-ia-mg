export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { handleGetModels } from '@/server/root-handlers';

export async function GET(req: NextRequest) {
  const ctx = await buildCtx(req as unknown as Request, 'models', {});
  return handleGetModels(ctx);
}
