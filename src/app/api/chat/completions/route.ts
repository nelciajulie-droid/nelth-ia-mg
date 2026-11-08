export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Long-lived SSE stream — Vercel serverless: allow the full 60s Hobby window.
export const maxDuration = 60;

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { handleChatCompletions } from '@/server/root-handlers';

export async function POST(req: NextRequest) {
  const ctx = await buildCtx(req as unknown as Request, 'chat/completions', {});
  return handleChatCompletions(ctx);
}
