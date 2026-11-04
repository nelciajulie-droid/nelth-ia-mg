export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { handleChatCompletions } from '@/server/root-handlers';

export async function POST(req: NextRequest) {
  const ctx = await buildCtx(req as unknown as Request, 'chat/completions', {});
  return handleChatCompletions(ctx);
}
